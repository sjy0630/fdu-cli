import { accessSync, constants as fsConstants, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { z } from 'zod';
import { ensureWebvpn, login, platformStatus, sessionAuth, webvpnAlive } from './core/auth';
import type { Cache } from './core/cache';
import { FduError } from './core/errors';
import type { Session } from './core/session';
import type { Store } from './core/store';
import { readProgramCompletion, readSelectedCourses } from './services/academic';
import { readCardBalance, readLibrary } from './services/campus-life';
import { readElectricity } from './services/dorm';
import { CanvasClient, isAssignmentDone, type CanvasCourse } from './services/elearning';
import { readGpaRank, readGrades, readStudentId } from './services/grades';
import { readExams, readSemesters, readTimetable } from './services/jw';
import { LibrarySearch } from './services/library-search';
import { DEFAULT_FUDAN_STUDENT_IMAP, ImapMailClient } from './services/mail';
import { parseNoticeDetail, parseNoticeList } from './services/notice-parse';
import { findNoticeSource, NOTICE_SOURCES } from './services/notice-sources';
import { TreeholeClient, type HoleTokens } from './services/treehole';
import { shanghaiDay, weekInfo } from './services/calendar';
import { allSessions, overview, todayRange, weekRange, type OverviewDeps } from './services/overview';
import { buildIcs, type IcsEvent } from './services/ics';
import { runDoctor } from './services/doctor';
import { proxyFromEnv } from './core/session';

/** 运行一个操作时能用到的东西 */
export interface Ctx {
  store: Store;
  session: Session;
  /** 进度提示，写到 stderr，不混进 JSON 输出 */
  log(msg: string): void;
  /** 在终端里问一句（hidden：输入密码时不回显）；非交互环境（MCP）里不可用 */
  prompt?(question: string, opts?: { hidden?: boolean }): Promise<string>;
  cwd: string;
  now(): number;
  /** 查询结果缓存（没有时不缓存） */
  cache?: Cache;
}

export type Effect = 'read' | 'local-write' | 'auth';

export interface Op {
  /** 形如 jw.grades；命令行写成 fdu jw grades */
  name: string;
  summary: string;
  params: z.ZodRawShape;
  /** 需要哪种登录：uis 复旦统一身份认证；hole 树洞账号；mail 学生邮箱；none 公开接口 */
  login: 'uis' | 'hole' | 'mail' | 'none';
  /** 成绩、邮件等隐私数据：编程助理不要主动转述给别人或写进仓库 */
  sensitive?: boolean;
  /** read 只读；local-write 只写本机文件（下载）；auth 登录 / 退出 */
  effect: Effect;
  /** 需要在终端里输入密码的操作不开放给 MCP */
  mcp?: boolean;
  examples?: string[];
  /** 只读操作默认缓存结果（--cached、失败时附带上次结果）；false 表示不缓存 */
  cache?: boolean;
  run(ctx: Ctx, args: Record<string, unknown>): Promise<unknown>;
}

function op<S extends z.ZodRawShape>(o: Omit<Op, 'params' | 'run'> & { params: S; run(ctx: Ctx, args: z.infer<z.ZodObject<S>>): Promise<unknown> }): Op {
  return o as unknown as Op;
}

/** 命令行里的 --flag / --flag true / --flag false 都能用；MCP 里是普通的布尔参数 */
export const FLAGS = new WeakSet<z.ZodType>();
const flag = (description: string) => {
  const schema = z.preprocess((v) => v === 'true' ? true : v === 'false' ? false : v, z.boolean()).optional().describe(description);
  FLAGS.add(schema);
  return schema;
};
const int = (description: string, min = 1, max = 1000) => z.coerce.number().int().min(min).max(max).optional().describe(description);

const DAY = 86_400_000;
const shanghaiDate = (iso?: string) => iso ? new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : undefined;

// ---------- eLearning ----------
const elearning = (ctx: Ctx) => new CanvasClient(sessionAuth(ctx.session));

/** 课程：id，或课程名 / 课程代码里的关键词 */
async function resolveCourses(ctx: Ctx, query?: string): Promise<CanvasCourse[]> {
  const courses = await elearning(ctx).listCourses();
  if (!query) return courses;
  const q = query.trim().toLowerCase();
  const hit = courses.filter((c) => c.id === q || c.name.toLowerCase().includes(q) || c.courseCode.toLowerCase().includes(q));
  if (!hit.length) throw new FduError('NOT_FOUND', `没有找到课程「${query}」。`, '用 `fdu elearning courses` 查看课程列表，可以传课程 id 或名称关键词。');
  return hit;
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

async function assignmentsOf(ctx: Ctx, courses: CanvasCourse[]) {
  const client = elearning(ctx);
  const lists = await pool(courses, 4, async (c) => (await client.listAssignments(c.id).catch((e) => {
    if ((e as { status?: number }).status === 403) return [];
    throw e;
  })).map((a) => ({ ...a, course: c.name, done: isAssignmentDone(a), dueAtShanghai: shanghaiDate(a.dueAt) })));
  return lists.flat().sort((a, b) => (a.dueAt ?? '9').localeCompare(b.dueAt ?? '9'));
}

/**
 * 文件名里去掉路径和不能用的字符；已存在时加 (1)、(2)，绝不覆盖。
 * 不用 path.basename：Windows 上它会把「a:b」里的「a:」当成盘符丢掉。
 */
export function safeTarget(dir: string, name: string): string {
  const last = name.split(/[\\/]/).pop() ?? '';
  let clean = last.replace(/[:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').replace(/[. ]+$/, '').slice(0, 180) || 'download';
  // Windows 的保留名（CON、NUL、COM1……）不能当文件名
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(clean)) clean = `_${clean}`;
  const ext = extname(clean);
  const stem = clean.slice(0, clean.length - ext.length);
  let target = join(dir, clean);
  for (let i = 1; existsSync(target); i++) target = join(dir, `${stem} (${i})${ext}`);
  return target;
}

// ---------- 树洞、邮箱 ----------
const HOLE = 'hole.json';
const MAIL = 'mail.json';
interface MailConfig { host: string; port: number; user: string; password: string }

function treehole(ctx: Ctx): TreeholeClient {
  return new TreeholeClient({
    fetch: (url, init) => ctx.session.raw(url, init),
    ensureWebvpn: () => ensureWebvpn(ctx.session),
    tokens: {
      get: () => ctx.store.readJson<HoleTokens>(HOLE),
      set: (t) => { if (t) ctx.store.writeJson(HOLE, t); else ctx.store.remove(HOLE); },
    },
    now: ctx.now,
  });
}

function mailClient(ctx: Ctx): ImapMailClient {
  const cfg = ctx.store.readJson<MailConfig>(MAIL);
  if (!cfg?.user || !cfg.password) throw new FduError('NEED_MAIL_SETUP', '还没有配置学生邮箱。', '运行 `fdu mail setup --user 学号@m.fudan.edu.cn`，输入网页邮箱里生成的客户端专用密码。');
  return new ImapMailClient(cfg);
}

/** 汇总和导出日历用的三类数据 */
function overviewDeps(ctx: Ctx): OverviewDeps {
  const reader = ctx.session.reader('jwfw');
  return {
    timetable: () => readTimetable(reader),
    exams: () => readExams(reader, { now: ctx.now() }),
    assignments: async () => (await assignmentsOf(ctx, await resolveCourses(ctx))).map((x) => ({ name: x.name, course: x.course, dueAt: x.dueAt, done: x.done, htmlUrl: x.htmlUrl })),
  };
}

const needPrompt = (ctx: Ctx) => {
  if (!ctx.prompt) throw new FduError('BAD_ARGS', '这个操作需要在终端里输入密码，请直接在终端运行。');
  return ctx.prompt;
};

export const OPS: Op[] = [
  // ======================= 账号 =======================
  op({
    name: 'auth.login', summary: '登录复旦统一身份认证：打开浏览器，你自己输入账号密码、完成二次验证；之后 eLearning、教务、校园卡等共用这个登录。',
    login: 'none', effect: 'auth',
    params: { webvpn: flag('顺便建立 WebVPN 会话（校外访问树洞需要）'), force: flag('丢弃已有登录状态，重新登录') },
    examples: ['fdu login', 'fdu login --webvpn'],
    async run(ctx, a) {
      if (a.force) ctx.session.clear();
      const r = await login(ctx.session, { webvpn: a.webvpn, onWaiting: ctx.log });
      return { loggedIn: true, user: r.elearning.name, jwfw: r.jwfw, webvpn: r.webvpn, stateFile: ctx.store.path('state.json') };
    },
  }),
  op({
    name: 'auth.status', summary: '各系统的登录状态（复旦账号、WebVPN、树洞、学生邮箱）。', login: 'none', effect: 'read', cache: false, params: {},
    async run(ctx) {
      const [elearningStatus, jwfw] = await Promise.all([platformStatus(ctx.session, 'elearning'), platformStatus(ctx.session, 'jwfw')]);
      return {
        uis: { elearning: elearningStatus, jwfw, webvpn: ctx.session.hasState() ? await webvpnAlive(ctx.session) : false },
        treehole: !!ctx.store.readJson<HoleTokens>(HOLE),
        mail: !!ctx.store.readJson<MailConfig>(MAIL)?.user,
        profileDir: ctx.store.dir,
      };
    },
  }),
  op({
    name: 'auth.logout', summary: '删除本机保存的复旦账号登录状态（树洞、邮箱分别用 fdu hole logout、fdu mail forget）。', login: 'none', effect: 'auth', mcp: false, params: {},
    async run(ctx) { return { removed: ctx.session.clear(), cacheCleared: ctx.cache?.clear() ?? 0 }; },
  }),
  op({
    name: 'auth.doctor', summary: '检查运行环境：Node.js、浏览器、配置目录、能不能连上各个学校系统、各账号的登录状态，每项给出修复建议（结果里没有账号和 Cookie，可以直接发给别人帮忙看）。',
    login: 'none', effect: 'read', cache: false, params: {}, examples: ['fdu doctor'],
    async run(ctx) {
      return runDoctor({
        nodeVersion: process.version, platform: process.platform, configDir: ctx.store.dir,
        configDirState: () => {
          try {
            mkdirSync(ctx.store.dir, { recursive: true, mode: 0o700 });
            accessSync(ctx.store.dir, fsConstants.W_OK);
            return { writable: true, mode: statSync(ctx.store.dir).mode };
          } catch { return { writable: false }; }
        },
        browser: () => ctx.session.probeBrowser(),
        reach: async (url) => { const r = await ctx.session.raw(url, { timeoutMs: 10_000 }); return { status: r.status, url: r.url }; },
        login: async () => {
          const hasState = ctx.session.hasState();
          if (!hasState) return { hasState, elearning: 'need_login', jwfw: 'need_login', webvpn: false };
          const [elearningStatus, jwfw, webvpn] = await Promise.all([platformStatus(ctx.session, 'elearning'), platformStatus(ctx.session, 'jwfw'), webvpnAlive(ctx.session)]);
          return { hasState, elearning: elearningStatus, jwfw, webvpn };
        },
        treehole: !!ctx.store.readJson<HoleTokens>(HOLE),
        mail: !!ctx.store.readJson<MailConfig>(MAIL)?.user,
        proxy: proxyFromEnv()?.server,
      });
    },
  }),
  op({
    name: 'cache.clear', summary: '删除本机缓存的查询结果（退出登录时也会自动删除）。', login: 'none', effect: 'local-write', mcp: false, cache: false, params: {},
    async run(ctx) { return { removed: ctx.cache?.clear() ?? 0 }; },
  }),

  // ======================= 汇总 =======================
  op({
    name: 'overview.today', summary: '今天的概况：今天的课（按教学周和放假安排筛好）、3 天内要交还没交的作业、7 天内的考试、过了截止还没交的作业。某一类读不到时其他照常返回，读不到的写在 errors 里。',
    login: 'uis', effect: 'read', params: { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('日期 YYYY-MM-DD，默认今天') },
    examples: ['fdu today', 'fdu today --date 2026-11-09'],
    async run(ctx, a) {
      const r = todayRange(ctx.now(), a.date);
      return overview(overviewDeps(ctx), { ...r, now: ctx.now() });
    },
  }),
  op({
    name: 'overview.week', summary: '这一周（按校历从周日到周六）每天的课、本周要交的作业、本周的考试，以及第几教学周。',
    login: 'uis', effect: 'read', params: { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('这一周里的任意一天，默认今天') },
    examples: ['fdu week', 'fdu week --date 2026-11-16'],
    async run(ctx, a) {
      const r = weekRange(ctx.now(), a.date);
      return overview(overviewDeps(ctx), { ...r, now: ctx.now() });
    },
  }),
  op({
    name: 'calendar.export', summary: '把课表、考试和作业截止时间导出成日历文件（.ics），可以导入苹果日历、Outlook、Google 日历。重复导入同一学期会更新已有日程，不会重复添加。',
    login: 'uis', effect: 'local-write', cache: false,
    params: {
      out: z.string().optional().describe('保存到哪里，默认当前目录的 fudan.ics'),
      include: z.string().regex(/^(timetable|exams|assignments)(,(timetable|exams|assignments))*$/).optional().describe('导出哪些，逗号分隔：timetable,exams,assignments（默认全部）'),
      overwrite: flag('文件已存在时覆盖（默认另存为新文件名）'),
      alarms: flag('考试和作业截止前一天提醒（默认开）'),
    },
    examples: ['fdu calendar export', 'fdu calendar export --include timetable,exams --out ~/Desktop/fudan.ics'],
    async run(ctx, a) {
      const include = new Set((a.include ?? 'timetable,exams,assignments').split(','));
      const alarms = a.alarms ?? true;
      const deps = overviewDeps(ctx);
      const events: IcsEvent[] = [];
      const errors: Record<string, string> = {};
      const counts = { classes: 0, exams: 0, deadlines: 0 };
      let skipped: { date: string; course: string; reason: string }[] = [];
      let semester: string | undefined;
      let firstError: unknown;
      const attempt = async (name: string, f: () => Promise<void>) => {
        try { await f(); } catch (e) { firstError ??= e; errors[name] = (e as Error).message; }
      };
      if (include.has('timetable')) await attempt('timetable', async () => {
        const table = await deps.timetable();
        semester = table.semester?.name;
        const all = allSessions(table);
        if (!all.week0Sunday) throw new FduError('NOT_FOUND', '不知道这个学期从哪天开始，没法排出上课日期。');
        skipped = all.skipped;
        for (const s of all.sessions) {
          events.push({ key: `class|${s.course}|${s.date}|${s.start}`, summary: s.course, startsAt: s.startsAt, endsAt: s.endsAt, location: s.location, description: [`第 ${s.week} 周 · 第 ${s.periods} 节`, s.teachers.join('、')].filter(Boolean).join('\n'), categories: ['课程'] });
        }
        counts.classes = all.sessions.length;
      });
      if (include.has('exams')) await attempt('exams', async () => {
        for (const e of await deps.exams()) {
          events.push({ key: `exam|${e.course}|${e.startsAt}`, summary: `考试：${e.course}`, startsAt: e.startsAt, endsAt: e.endsAt ?? new Date(Date.parse(e.startsAt) + 2 * 3_600_000).toISOString(), location: e.location, description: e.timeText, alarmMinutes: alarms ? 24 * 60 : undefined, categories: ['考试'] });
          counts.exams++;
        }
      });
      if (include.has('assignments')) await attempt('assignments', async () => {
        for (const x of await deps.assignments()) {
          if (x.done || !x.dueAt || Date.parse(x.dueAt) < ctx.now()) continue;
          // 截止时间前 30 分钟的一小段，日历里看得见；提醒放在前一天
          events.push({ key: `due|${x.course}|${x.name}`, summary: `截止：${x.name}${x.course ? `（${x.course}）` : ''}`, startsAt: new Date(Date.parse(x.dueAt) - 30 * 60_000).toISOString(), endsAt: x.dueAt, url: x.htmlUrl, alarmMinutes: alarms ? 24 * 60 : undefined, categories: ['作业'] });
          counts.deadlines++;
        }
      });
      if (!events.length && firstError) throw firstError;
      const target = resolve(ctx.cwd, a.out ?? 'fudan.ics');
      mkdirSync(dirname(target), { recursive: true });
      const path = a.overwrite ? target : safeTarget(dirname(target), basename(target));
      writeFileSync(path, buildIcs(events, { name: semester ? `复旦课表 ${semester}` : '复旦课表', now: ctx.now() }), { mode: 0o644 });
      return { path, events: counts, skippedHolidays: skipped, ...(Object.keys(errors).length ? { errors } : {}) };
    },
  }),

  // ======================= eLearning =======================
  op({
    name: 'elearning.courses', summary: '本学期的 eLearning 课程（id、名称、课程代码、教师）。', login: 'uis', effect: 'read', params: {},
    async run(ctx) { return elearning(ctx).listCourses(); },
  }),
  op({
    name: 'elearning.assignments', summary: '作业列表：截止时间（含上海时间）、是否已提交。不传课程时列出全部课程。', login: 'uis', effect: 'read',
    params: { course: z.string().optional().describe('课程 id 或名称关键词'), pending: flag('只看还没交的') },
    examples: ['fdu elearning assignments --course 数据结构', 'fdu elearning assignments --pending'],
    async run(ctx, a) {
      const list = await assignmentsOf(ctx, await resolveCourses(ctx, a.course));
      return a.pending ? list.filter((x) => !x.done) : list;
    },
  }),
  op({
    name: 'elearning.todo', summary: '接下来几天要交、还没交的作业（跨全部课程，按截止时间排序），以及已经过了截止时间还没交的。', login: 'uis', effect: 'read',
    params: { days: int('往后看几天，默认 14', 1, 120) },
    async run(ctx, a) {
      const now = ctx.now();
      const until = now + (a.days ?? 14) * DAY;
      const list = (await assignmentsOf(ctx, await resolveCourses(ctx))).filter((x) => !x.done && x.dueAt);
      return {
        upcoming: list.filter((x) => Date.parse(x.dueAt!) >= now && Date.parse(x.dueAt!) <= until),
        overdue: list.filter((x) => Date.parse(x.dueAt!) < now && Date.parse(x.dueAt!) > now - 14 * DAY),
      };
    },
  }),
  op({
    name: 'elearning.announcements', summary: '课程公告（默认最近 14 天）。', login: 'uis', effect: 'read',
    params: { course: z.string().optional().describe('课程 id 或名称关键词'), days: int('最近几天，默认 14', 1, 365) },
    async run(ctx, a) {
      const courses = await resolveCourses(ctx, a.course);
      const since = new Date(ctx.now() - (a.days ?? 14) * DAY).toISOString();
      const names = new Map(courses.map((c) => [c.id, c.name]));
      const list = await elearning(ctx).listAnnouncements(courses.map((c) => c.id), since);
      return list.map((x) => ({ ...x, course: names.get(x.courseId), postedAtShanghai: shanghaiDate(x.postedAt) }));
    },
  }),
  op({
    name: 'elearning.files', summary: '某门课的课件和文件（id、文件名、大小、所在文件夹）。', login: 'uis', effect: 'read',
    params: { course: z.string().describe('课程 id 或名称关键词'), search: z.string().optional().describe('文件名关键词') },
    examples: ['fdu elearning files --course 线性代数 --search 第5讲'],
    async run(ctx, a) {
      const [course] = await resolveCourses(ctx, a.course);
      return { course: course.name, files: await elearning(ctx).listFiles(course.id, a.search) };
    },
  }),
  op({
    name: 'elearning.download', summary: '下载一个课程文件到本机（默认当前目录；同名文件不覆盖，自动加序号；单个最大 200 MB）。', login: 'uis', effect: 'local-write',
    params: { file: z.string().describe('文件 id（来自 elearning files）'), out: z.string().optional().describe('保存到哪个文件夹，默认当前目录') },
    async run(ctx, a) {
      const f = await elearning(ctx).downloadFile(a.file);
      const dir = resolve(ctx.cwd, a.out ?? '.');
      mkdirSync(dir, { recursive: true });
      const target = safeTarget(dir, f.name);
      writeFileSync(target, f.data, { flag: 'wx' });
      return { path: target, bytes: f.data.byteLength, contentType: f.contentType };
    },
  }),

  // ======================= 教务 =======================
  op({
    name: 'jw.semesters', summary: '教务系统里的学期列表（id、名称）和当前学期。', login: 'uis', effect: 'read', params: {},
    async run(ctx) { return readSemesters(ctx.session.reader('jwfw')); },
  }),
  op({
    name: 'jw.week', summary: '某天是第几教学周、星期几、是否放假（按学校校历；校历没覆盖到的学期按教务系统的学期开始日期推算）。', login: 'none', effect: 'read', cache: false,
    params: { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('日期 YYYY-MM-DD，默认今天') },
    async run(ctx, a) {
      const day = a.date ?? shanghaiDay(ctx.now());
      let info = weekInfo(day);
      // 内置校历没有这个学期：登录了就用教务系统的学期开始日期推算
      if (info.source === 'none' && ctx.session.hasState()) {
        try {
          const { semesters, currentId } = await readSemesters(ctx.session.reader('jwfw'));
          info = weekInfo(day, semesters.find((x) => x.id === currentId));
        } catch { /* 推算不了就按寒暑假处理 */ }
      }
      return info;
    },
  }),
  op({
    name: 'jw.timetable', summary: '课表：每门课的上课时间（星期、节次、起止时间）、地点、教学周、教师。', login: 'uis', effect: 'read',
    params: { semester: z.string().optional().describe('学期 id 或名称关键词，默认当前学期'), postgraduate: flag('研究生课表（读研究生选课系统）') },
    examples: ['fdu jw timetable', 'fdu jw timetable --semester 2026-2027学年1学期'],
    async run(ctx, a) { return readTimetable(ctx.session.reader('jwfw'), { semester: a.semester, postgraduate: a.postgraduate }); },
  }),
  op({
    name: 'jw.exams', summary: '考试安排（课程、时间、考场），按时间排序。', login: 'uis', effect: 'read',
    params: { all: flag('也列出一个月以前考完的') },
    async run(ctx, a) {
      return (await readExams(ctx.session.reader('jwfw'), { all: a.all, now: ctx.now() })).map((e) => ({ ...e, startsAtShanghai: shanghaiDate(e.startsAt) }));
    },
  }),
  op({
    name: 'jw.grades', summary: '已出的成绩（按学期）和按学分加权的绩点（P/NP 不计）。', login: 'uis', effect: 'read', sensitive: true,
    params: { semester: z.string().optional().describe('只看某个学期（id 或名称关键词）') },
    async run(ctx, a) {
      const { studentId: _id, ...r } = await readGrades(ctx.session.reader('jwfw'));
      if (!a.semester) return r;
      const semesters = r.semesters.filter((s) => s.id === a.semester || s.name.includes(a.semester!));
      return { ...r, semesters };
    },
  }),
  op({
    name: 'jw.gpa', summary: '教务系统里的绩点和本年级本院系排名（只返回你自己的一行和总人数）。', login: 'uis', effect: 'read', sensitive: true,
    params: { studentNumber: z.string().regex(/^\d{8,14}$/).optional().describe('学号，用来在排名表里找到你；不传时尝试从 eLearning 读取') },
    async run(ctx, a) {
      const reader = ctx.session.reader('jwfw');
      const { studentId } = await readStudentId(reader);
      let number = a.studentNumber;
      if (!number) {
        const profile = await ctx.session.raw('https://elearning.fudan.edu.cn/api/v1/users/self/profile', { headers: { Accept: 'application/json' } }).catch(() => undefined);
        try { const p = JSON.parse(profile?.text ?? '{}') as { login_id?: string }; if (/^\d{8,14}$/.test(p.login_id ?? '')) number = p.login_id; } catch { /* 读不到就只返回总人数 */ }
      }
      const rank = await readGpaRank(reader, studentId, number);
      if (!rank) throw new FduError('NOT_FOUND', '教务系统里没有找到绩点排名（可能还没开放）。');
      return { ...rank, note: rank.ranking === undefined ? '没有在排名表里找到你，请用 --student-number 传学号。' : undefined };
    },
  }),
  op({
    name: 'jw.program', summary: '培养方案完成情况：各类别要求学分、已获学分、还差多少。', login: 'uis', effect: 'read', sensitive: true, params: {},
    async run(ctx) {
      const reader = ctx.session.reader('jwfw');
      const { studentId } = await readStudentId(reader);
      return readProgramCompletion(reader, studentId);
    },
  }),
  op({
    name: 'jw.selected', summary: '选课结果：某学期已选上的课、学分和上课时间。', login: 'uis', effect: 'read',
    params: { which: z.string().optional().describe('current 当前学期（默认）、next 下学期，或学期名关键词') },
    async run(ctx, a) { return readSelectedCourses(ctx.session.reader('jwfw'), a.which ?? 'current'); },
  }),

  // ======================= 校园生活 =======================
  op({
    name: 'card.balance', summary: '校园卡余额。', login: 'uis', effect: 'read', params: {},
    async run(ctx) { return { balance: await readCardBalance(ctx.session.reader('jwfw')), at: new Date(ctx.now()).toISOString() }; },
  }),
  op({
    name: 'dorm.electricity', summary: '宿舍剩余电量（度）。', login: 'uis', effect: 'read', params: {},
    async run(ctx) { return readElectricity(ctx.session.reader('jwfw')); },
  }),
  op({
    name: 'library.seats', summary: '各图书馆在馆人数和还能进多少人（公开接口，不用登录）。', login: 'none', effect: 'read', params: {},
    async run(ctx) { return readLibrary(async (url) => { const r = await ctx.session.raw(url, { method: 'POST' }); return { status: r.status, text: r.text }; }); },
  }),
  op({
    name: 'library.search', summary: '复旦图书馆文献检索（论文、图书；返回标题、作者、年份、摘要、DOI、详情页链接）。', login: 'none', effect: 'read',
    params: {
      query: z.string().min(1).describe('检索词'),
      scope: z.enum(['articles', 'all', 'books']).optional().describe('articles 文章（默认）、books 图书期刊、all 全部'),
      field: z.enum(['all', 'title', 'author', 'subject', 'fulltext']).optional(),
      limit: int('返回几条，默认 10', 1, 50),
      yearFrom: z.coerce.number().int().optional(), yearTo: z.coerce.number().int().optional(),
      sort: z.enum(['relevance', 'newest']).optional(),
      peerReviewedOnly: flag('只看同行评审'), fullTextOnly: flag('只看有全文的'),
    },
    examples: ['fdu library search --query "graph neural network molecule" --year-from 2022'],
    async run(ctx, a) {
      const lib = new LibrarySearch(async (url, headers) => { const r = await ctx.session.raw(url, { headers }); return { status: r.status, text: r.text }; });
      return lib.search({ ...a, limit: a.limit ?? 10 });
    },
  }),

  // ======================= 学校通知 =======================
  op({
    name: 'notices.sources', summary: '内置的学校部门和院系官网通知来源（id、名称、网址）。', login: 'none', effect: 'read', cache: false, params: {},
    async run() { return NOTICE_SOURCES; },
  }),
  op({
    name: 'notices.list', summary: '某个部门 / 院系官网最新的通知列表（标题、日期、链接）。', login: 'none', effect: 'read',
    params: { source: z.string().describe('来源 id 或名称，如 jwc、教务处、计算机学院'), limit: int('返回几条，默认 20', 1, 100) },
    examples: ['fdu notices list --source 教务处'],
    async run(ctx, a) {
      const source = NOTICE_SOURCES.find((s) => s.id === a.source) ?? findNoticeSource(a.source);
      if (!source) throw new FduError('NOT_FOUND', `没有找到通知来源「${a.source}」。`, '用 `fdu notices sources` 查看可用来源。');
      const page = await ctx.session.raw(source.url);
      if (page.status >= 400) throw new FduError('UPSTREAM', `${source.name}网站返回 ${page.status}（部分院系网站只允许校园网访问）。`);
      return { source: source.name, url: source.url, notices: parseNoticeList(page.text, page.url).slice(0, a.limit ?? 20) };
    },
  }),
  op({
    name: 'notices.read', summary: '读一条通知的正文、发布日期和附件链接。', login: 'none', effect: 'read',
    params: { url: z.string().url().describe('通知链接（来自 notices list）') },
    async run(ctx, a) {
      if (!/^https?:\/\//.test(a.url)) throw new FduError('BAD_ARGS', '只支持 http / https 链接。');
      const page = await ctx.session.raw(a.url);
      if (page.status >= 400) throw new FduError('UPSTREAM', `网站返回 ${page.status}`);
      const d = parseNoticeDetail(page.text, page.url);
      return { url: page.url, ...d, text: d.text.slice(0, 20_000) };
    },
  }),

  // ======================= 树洞与旦克 =======================
  op({
    name: 'hole.login', summary: '登录树洞（旦挞）账号：密码只用来换取令牌，不保存。校外会自动走 WebVPN（需要先 fdu login）。', login: 'none', effect: 'auth', mcp: false,
    params: { email: z.string().email().describe('树洞账号邮箱，通常是 学号@m.fudan.edu.cn') },
    async run(ctx, a) {
      const password = await needPrompt(ctx)('树洞密码（不会显示，也不会保存）：', { hidden: true });
      await treehole(ctx).login(a.email, password);
      return { loggedIn: true };
    },
  }),
  op({
    name: 'hole.logout', summary: '删除本机保存的树洞令牌。', login: 'none', effect: 'auth', mcp: false, params: {},
    async run(ctx) { return { removed: ctx.store.remove(HOLE) }; },
  }),
  op({
    name: 'hole.search', summary: '在树洞里搜索帖子楼层（匿名同学的个人看法，不是事实）。', login: 'hole', effect: 'read',
    params: { keyword: z.string().min(1), limit: int('返回几条，默认 10', 1, 50), days: int('只看最近几天', 1, 3650), accurate: flag('精确匹配') },
    async run(ctx, a) { return treehole(ctx).searchFloors(a.keyword, { limit: a.limit, withinDays: a.days, accurate: a.accurate }); },
  }),
  op({
    name: 'hole.read', summary: '读一个树洞帖子（洞号）及其楼层。', login: 'hole', effect: 'read',
    params: { id: z.coerce.number().int().positive().describe('洞号'), start: int('从第几楼开始', 0, 100_000), length: int('读几楼，默认 30', 1, 100) },
    async run(ctx, a) { return treehole(ctx).hole(a.id, { start: a.start, length: a.length }); },
  }),
  op({
    name: 'hole.latest', summary: '树洞最新的帖子。', login: 'hole', effect: 'read',
    params: { length: int('几条，默认 10', 1, 50), tag: z.string().optional().describe('标签') },
    async run(ctx, a) { return treehole(ctx).latest({ length: a.length, tag: a.tag }); },
  }),
  op({
    name: 'danke.search', summary: '旦克（课程评价）里搜索课程。', login: 'hole', effect: 'read',
    params: { keyword: z.string().min(1).describe('课程名或课程代码'), limit: int('几条，默认 10', 1, 50) },
    async run(ctx, a) { return treehole(ctx).searchCourses(a.keyword, a.limit); },
  }),
  op({
    name: 'danke.reviews', summary: '某门课在旦克上的评价（评分、作业量、给分、各老师的评价）。', login: 'hole', effect: 'read',
    params: { id: z.coerce.number().int().positive().describe('课程组 id（来自 danke search 的 course_group_id）'), max: int('最多几条评价，默认 12', 1, 50) },
    async run(ctx, a) { return treehole(ctx).courseReviews(a.id, a.max); },
  }),

  // ======================= 学生邮箱 =======================
  op({
    name: 'mail.setup', summary: '配置学生邮箱（IMAP，只读）：需要网页邮箱里生成的客户端专用密码；密码以明文保存在本机配置目录（权限 600）。', login: 'none', effect: 'auth', mcp: false,
    params: { user: z.string().email().describe('邮箱地址'), host: z.string().optional().describe(`IMAP 服务器，默认 ${DEFAULT_FUDAN_STUDENT_IMAP.host}`), port: int('端口，默认 993', 1, 65535) },
    async run(ctx, a) {
      const password = await needPrompt(ctx)('客户端专用密码（不会显示）：', { hidden: true });
      const cfg: MailConfig = { host: a.host ?? DEFAULT_FUDAN_STUDENT_IMAP.host, port: a.port ?? DEFAULT_FUDAN_STUDENT_IMAP.port, user: a.user, password };
      if (!(await new ImapMailClient(cfg).ping())) throw new FduError('NEED_MAIL_SETUP', '连不上邮箱。', '检查邮箱地址、客户端专用密码，并确认网页邮箱已开启 IMAP。');
      ctx.store.writeJson(MAIL, cfg);
      return { configured: true, user: cfg.user, file: ctx.store.path(MAIL) };
    },
  }),
  op({
    name: 'mail.forget', summary: '删除本机保存的邮箱配置和密码。', login: 'none', effect: 'auth', mcp: false, params: {},
    async run(ctx) { return { removed: ctx.store.remove(MAIL) }; },
  }),
  op({
    name: 'mail.list', summary: '收件箱里最近的邮件（发件人、主题、时间、摘要）；只读，不改变已读状态。', login: 'mail', effect: 'read', sensitive: true,
    params: { days: int('最近几天，默认 7', 1, 365), limit: int('最多几封，默认 30', 1, 200), query: z.string().optional().describe('只看发件人或主题里包含这个词的') },
    async run(ctx, a) {
      const list = await mailClient(ctx).fetchSince(new Date(ctx.now() - (a.days ?? 7) * DAY), 500);
      const q = a.query?.toLowerCase();
      return list
        .filter((m) => !q || `${m.from.name ?? ''} ${m.from.address} ${m.subject}`.toLowerCase().includes(q))
        .reverse().slice(0, a.limit ?? 30)
        .map((m) => ({ uid: m.uid, from: m.from, subject: m.subject, date: m.date, dateShanghai: shanghaiDate(m.date), snippet: m.text.replace(/\s+/g, ' ').slice(0, 200) }));
    },
  }),
  op({
    name: 'mail.read', summary: '读一封邮件的正文（按 uid，来自 mail list）。', login: 'mail', effect: 'read', sensitive: true, cache: false,
    params: { uid: z.string().regex(/^\d+$/), days: int('在最近几天里找，默认 30', 1, 365) },
    async run(ctx, a) {
      const m = (await mailClient(ctx).fetchSince(new Date(ctx.now() - (a.days ?? 30) * DAY), 1000)).find((x) => x.uid === a.uid);
      if (!m) throw new FduError('NOT_FOUND', `最近 ${a.days ?? 30} 天里没有找到 uid 为 ${a.uid} 的邮件。`, '用 --days 放宽范围。');
      return m;
    },
  }),
];

export function findOp(name: string): Op | undefined {
  return OPS.find((o) => o.name === name);
}
