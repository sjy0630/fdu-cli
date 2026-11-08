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
import { filterBus, readBus } from './services/bus';
import { CANTEEN_URL, parseCanteen, readCanteen } from './services/canteen';
import { CanvasClient, isAssignmentDone, type CanvasCourse } from './services/elearning';
import { readGpaRank, readGrades, readStudentId } from './services/grades';
import { readExams, readLessons, readSemesters, readSyllabus, readTimetable } from './services/jw';
import { LibrarySearch } from './services/library-search';
import { OPAC, readHistory, readLoans, type GetJson as LibGetJson } from './services/library-account';
import type { Page } from 'playwright-core';
import { DEFAULT_FUDAN_STUDENT_IMAP, ImapMailClient } from './services/mail';
import { parseNoticeDetail, parseNoticeList } from './services/notice-parse';
import { findNoticeSource, NOTICE_SOURCES } from './services/notice-sources';
import { TreeholeClient, type HoleTokens } from './services/treehole';
import { shanghaiDay, weekInfo } from './services/calendar';
import { allSessions, overview, todayRange, weekRange, type OverviewDeps } from './services/overview';
import { buildIcs, type IcsEvent } from './services/ics';
import { runDoctor } from './services/doctor';
import { clock, IcourseClient, type TranscriptSegment } from './services/icourse';
import { NeedLoginError } from './core/fudan-auth';
import { cardRange, readCardRecords, summarize } from './services/ecard';
import { BOOKING_CAS, bookingReady, listVenues, matchVenues, SPORTS_PAGE, venueCalendar, type GetJson } from './services/venues';
import { addDays } from './services/calendar';
import { BUILDINGS, dayPageUrl, freeRooms, parseDayPage, periodAt, periodSpan, roomsReport, ROOMS_ORIGIN, type DayPage } from './services/rooms';
import { toWebvpnUrl } from './services/webvpn';
import { dedupe, describeCall, sanitizeHtml, type CapturedCall } from './services/capture';
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

/** 经过 WebVPN 的请求在浏览器里发（WebVPN 只认真正的浏览器），其余照常 */
function viaWebvpnAware(ctx: Ctx, url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }) {
  return url.startsWith('https://webvpn.fudan.edu.cn/') ? ctx.session.browserFetch(url, init) : ctx.session.raw(url, init);
}

function treehole(ctx: Ctx): TreeholeClient {
  return new TreeholeClient({
    fetch: (url, init) => viaWebvpnAware(ctx, url, init),
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

/** iCourse 客户端：复用复旦账号登录状态，iCourse 自己的登录在无界面浏览器里自动完成 */
function icourse(ctx: Ctx): IcourseClient {
  if (!ctx.session.hasState()) throw new NeedLoginError('icourse');
  return new IcourseClient({
    fetch: (url, init) => viaWebvpnAware(ctx, url, { timeoutMs: init?.timeoutMs }),
    ensureWebvpn: () => ensureWebvpn(ctx.session),
    openInBrowser: async (url, done) => { await ctx.session.withPage(url, (page) => done(page.url()), { headless: true, timeoutMs: 30_000, platform: 'icourse' }); },
  });
}

/** 文字稿合成段落：每段大约一分钟，开头标时间 */
export function transcriptText(segments: TranscriptSegment[], every = 60): string {
  const paras: string[] = [];
  let start = -Infinity;
  let cur: string[] = [];
  for (const s of segments) {
    if (s.start - start >= every && cur.length) { paras.push(cur.join('')); cur = []; }
    if (!cur.length) { start = s.start; cur.push(`[${clock(s.start)}] `); }
    cur.push(s.text);
  }
  if (cur.length) paras.push(cur.join(''));
  return paras.join('\n');
}

/**
 * 在浏览器里打开场馆预约页，再用页面里的请求读数据（预约系统有防爬虫验证，后台请求会被拒绝）。
 * 预约系统没登录时，走一次它的统一身份认证入口（复用复旦账号登录状态）。
 */
async function withBooking<T>(ctx: Ctx, work: (getJson: GetJson) => Promise<T>): Promise<T> {
  if (!ctx.session.hasState()) throw new NeedLoginError('jwfw');
  let result: { value: T } | undefined;
  let failure: unknown;
  let triedLogin = false;
  await ctx.session.withPage(SPORTS_PAGE, async (page) => {
    if (new URL(page.url()).hostname !== 'booking.fudan.edu.cn') return false;
    const getJson: GetJson = (url) => page.evaluate(async (u: string) => {
      const r = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } });
      return { status: r.status, text: await r.text() };
    }, url);
    try {
      if (!(await bookingReady(getJson))) {
        if (triedLogin) throw new NeedLoginError('jwfw');
        triedLogin = true;
        await page.goto(BOOKING_CAS, { timeout: 30_000 }).catch(() => undefined);
        return false;
      }
      result = { value: await work(getJson) };
    } catch (e) {
      // 页面正在跳转时请求会失败，等下一轮再试
      if (e instanceof Error && /Execution context was destroyed|navigat/i.test(e.message)) return false;
      failure = e;
    }
    return true;
  }, { headless: true, timeoutMs: 60_000, platform: 'jwfw' });
  if (failure) throw failure;
  if (!result) throw new FduError('UPSTREAM', '场馆预约系统没有打开。', '稍后再试；也可以直接在浏览器里打开 booking.fudan.edu.cn 查看。');
  return result.value;
}

/** 图书馆网页应用把令牌存在浏览器里：在本地存储里找名字带 token 的项（值可能是字符串，也可能是 JSON） */
export function findLibraryToken(entries: [string, string][]): string | undefined {
  const plausible = (v: unknown) => typeof v === 'string' && /^[\w.\-]{20,}$/.test(v);
  const dig = (o: unknown, depth = 0): string | undefined => {
    if (!o || typeof o !== 'object' || depth > 4) return undefined;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (/^(access_?token|accessToken|token)$/i.test(k) && plausible(v)) return v as string;
      const inner = dig(v, depth + 1);
      if (inner) return inner;
    }
    return undefined;
  };
  const ranked = [...entries].sort(([a], [b]) => Number(/access/i.test(b)) - Number(/access/i.test(a)));
  for (const [k, v] of ranked) {
    if (!/token/i.test(k) && !/token/i.test(v.slice(0, 200))) continue;
    if (/token/i.test(k) && plausible(v.replace(/^"|"$/g, ''))) return v.replace(/^"|"$/g, '');
    try { const t = dig(JSON.parse(v)); if (t) return t; } catch { /* 不是 JSON */ }
  }
  return undefined;
}

async function storageEntries(page: Page): Promise<[string, string][]> {
  return page.evaluate(`(() => {
    const out = [];
    for (const st of [window.localStorage, window.sessionStorage]) {
      try { for (let i = 0; i < st.length; i++) { const k = st.key(i); out.push([k, st.getItem(k) || '']); } } catch {}
    }
    return out;
  })()`).then((v) => (Array.isArray(v) ? v as [string, string][] : [])).catch(() => []);
}

const LIB_LOGIN_HINT = '运行 `fdu library login`，在打开的图书馆页面里登录一次（之后会记住）。';

const LIB_TOKEN = 'library.json';

/**
 * 读借阅接口：优先用 fdu library login 时保存的令牌直接请求；
 * 没有保存的令牌时，退回在无界面浏览器里打开图书馆页面找令牌。
 */
async function withLibrary<T>(ctx: Ctx, work: (getJson: LibGetJson) => Promise<T>): Promise<T> {
  if (!ctx.session.hasState()) throw new NeedLoginError('jwfw');
  const saved = ctx.store.readJson<{ token?: string; expiresAt?: string }>(LIB_TOKEN);
  if (saved?.token) {
    if (saved.expiresAt && Date.parse(saved.expiresAt) < ctx.now()) {
      ctx.store.remove(LIB_TOKEN);
      throw new FduError('NEED_LOGIN', '图书馆登录已过期。', LIB_LOGIN_HINT);
    }
    const headers = { access_token: saved.token, Accept: 'application/json', Origin: 'https://opac.fudan.edu.cn', Referer: OPAC };
    const getJson: LibGetJson = async (url) => {
      const r = await ctx.session.raw(url, { headers });
      // 被网关拦下（不是数据）时改在浏览器里发
      if (!/json/.test(r.contentType) && r.status !== 401) return ctx.session.browserFetch(url, { headers });
      return r;
    };
    try { return await work(getJson); } catch (e) {
      if (e instanceof FduError && e.code === 'NEED_LOGIN') { ctx.store.remove(LIB_TOKEN); throw new FduError('NEED_LOGIN', '图书馆登录已过期。', LIB_LOGIN_HINT); }
      throw e;
    }
  }
  const started = Date.now();
  let result: { value: T } | undefined;
  let failure: unknown;
  await ctx.session.withPage(OPAC, async (page) => {
    if (new URL(page.url()).hostname !== 'opac.fudan.edu.cn') return false;
    const token = findLibraryToken(await storageEntries(page));
    if (!token) {
      // 网页应用可能还在加载、刷新令牌，等一会儿
      if (Date.now() - started < 10_000) return false;
      failure = new FduError('NEED_LOGIN', '还没有登录图书馆。', LIB_LOGIN_HINT);
      return true;
    }
    const getJson: LibGetJson = (url) => page.evaluate(async ([u, t]: string[]) => {
      const r = await fetch(u, { headers: { access_token: t, Accept: 'application/json' } });
      return { status: r.status, text: await r.text() };
    }, [url, token]);
    try { result = { value: await work(getJson) }; } catch (e) {
      if (e instanceof Error && /Execution context was destroyed|navigat/i.test(e.message)) return false;
      failure = e;
    }
    return true;
  }, { headless: true, timeoutMs: 40_000, platform: 'jwfw' });
  if (failure) throw failure;
  if (!result) throw new FduError('UPSTREAM', '图书馆页面没有打开。', '稍后再试；也可以直接打开 opac.fudan.edu.cn 查看。');
  return result.value;
}

const ROOMS_LOGIN_HINT = '运行 `fdu rooms login`，在打开的窗口里登录一次空教室系统。';

/** 读一栋楼一天的「在线课表」（经 WebVPN，在浏览器里发请求） */
async function roomsDayPage(ctx: Ctx, building: string, day: string): Promise<DayPage> {
  if (!ctx.session.hasState()) throw new NeedLoginError('jwfw');
  await ensureWebvpn(ctx.session);
  const r = await ctx.session.browserFetch(dayPageUrl(building, day), { timeoutMs: 30_000 });
  if (/\/urp\/|authCenter|\/idp\//.test(r.url)) throw new FduError('NEED_LOGIN', '空教室系统需要登录。', ROOMS_LOGIN_HINT);
  if (/webvpn\.fudan\.edu\.cn\/login/.test(r.url)) throw new FduError('NEED_LOGIN', 'WebVPN 登录已过期。', '运行 `fdu login --webvpn`。');
  return parseDayPage(r.text);
}

function buildingList(value: string, max = 6): string[] {
  const list = value.split(/[,，\s]+/).map((b) => b.trim().toUpperCase()).filter(Boolean);
  const bad = list.filter((b) => !BUILDINGS.includes(b));
  if (bad.length) throw new FduError('BAD_ARGS', `不认识的教学楼：${bad.join('、')}。`, `可选：${BUILDINGS.join('、')}（H2 = 二教，HGX = 光华楼）。`);
  if (list.length > max) throw new FduError('BAD_ARGS', `一次最多查 ${max} 栋楼。`);
  return list;
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

const CANTEEN_LOGIN_HINT = '运行 `fdu canteen login`，在打开的浏览器里按提示用微信扫码，看到页面后窗口会自动关闭。验证有效期由学校决定，过期后再运行一次。';

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
    async run(ctx) { ctx.store.remove('library.json'); return { removed: ctx.session.clear(), cacheCleared: ctx.cache?.clear() ?? 0 }; },
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
    name: 'dev.capture', summary: '开发新功能用：打开浏览器（带着复旦账号登录状态），你在里面操作某个学校系统的页面，关掉窗口后把页面用到的接口结构存成文件——只有地址、参数名、返回的字段名和类型、表格列名，不含姓名、学号、金额等任何具体内容，可以直接发给开发者。',
    login: 'none', effect: 'local-write', mcp: false, cache: false,
    params: {
      url: z.string().url().describe('从哪个页面开始，如 https://fdjwgl.fudan.edu.cn/student/home'),
      out: z.string().optional().describe('结果保存到哪里，默认当前目录的 fdu-capture-时间.json'),
      minutes: int('最多录多久（分钟），默认 10', 1, 60),
      keepQuery: flag('保留查询参数的值（如翻页参数的格式；令牌和长数字会遮掉，发出前请自己看一遍）'),
      html: z.string().min(1).optional().describe('另外保存地址里包含这段文字的网页的原始 HTML（如 day.asp），IP、令牌、长数字会遮掉'),
    },
    examples: ['fdu dev capture --url https://fdjwgl.fudan.edu.cn/student/home'],
    async run(ctx, a) {
      const calls: CapturedCall[] = [];
      const pages: { path: string; html: string }[] = [];
      ctx.log('已打开浏览器：请点到要做的功能页面，查询一两次，然后关掉浏览器窗口。');
      await ctx.session.record(a.url, async (r) => {
        if (a.html && /html/.test(r.contentType) && r.status === 200) {
          try {
            const u = new URL(r.url);
            if (`${u.pathname}${u.search}`.includes(a.html) && pages.length < 10) pages.push({ path: u.pathname.split('/').pop() || 'page', html: sanitizeHtml(await r.body()) });
          } catch { /* 读不到就算了 */ }
        }
        const c = await describeCall(r, { keepQuery: a.keepQuery });
        if (c) calls.push(c);
      }, (a.minutes ?? 10) * 60_000);
      const result = dedupe(calls).filter((c) => !/google|baidu|cnzz|analytics/i.test(c.endpoint));
      const stamp = new Date(ctx.now()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const target = resolve(ctx.cwd, a.out ?? `fdu-capture-${stamp}.json`);
      mkdirSync(dirname(target), { recursive: true });
      const path = safeTarget(dirname(target), basename(target));
      writeFileSync(path, JSON.stringify({ startUrl: a.url.split('?')[0], capturedAt: new Date(ctx.now()).toISOString(), calls: result }, null, 2));
      const htmlFiles = pages.map((p, i) => {
        const file = safeTarget(dirname(path), `${basename(path).replace(/\.json$/i, '')}.${i + 1}.${p.path.replace(/[^\w.-]/g, '_')}.html`);
        writeFileSync(file, p.html);
        return file;
      });
      if (a.html && !htmlFiles.length) ctx.log(`没有遇到地址里包含「${a.html}」的网页，没有保存 HTML。`);
      return { path, calls: result.length, ...(htmlFiles.length ? { htmlFiles } : {}), endpoints: result.map((c) => `${c.method} ${c.endpoint}`).slice(0, 50) };
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
    name: 'jw.lessons', summary: '全校开课查询：按课程名搜某学期开的课（教学班代码、学分、任课老师、上课时间地点、限选和已选人数、考试方式），选课时用。',
    login: 'uis', effect: 'read',
    params: {
      keyword: z.string().min(1).describe('课程名（包含即可），如「数据结构」'),
      semester: z.string().optional().describe('学期 id 或名称关键词，默认当前学期'),
      page: int('第几页，默认 1', 1, 500),
      size: int('每页几条，默认 20', 1, 100),
      syllabus: flag('同时读每个教学班的教学大纲（最多前 5 个，较慢）'),
    },
    examples: ['fdu jw lessons --keyword 数据结构', 'fdu jw lessons --keyword 线性代数 --semester 2026-2027学年2学期', 'fdu jw lessons --keyword 数据结构 --syllabus'],
    async run(ctx, a) {
      const reader = ctx.session.reader('jwfw');
      const r = await readLessons(reader, { keyword: a.keyword, semester: a.semester, page: a.page, size: a.size });
      if (!a.syllabus) return r;
      const lessons = [];
      for (const [i, l] of r.lessons.entries()) {
        if (i >= 5 || !l.id) { lessons.push(l); continue; }
        lessons.push({ ...l, syllabus: await readSyllabus(reader, l.id, 8000).catch((e) => ({ error: (e as Error).message })) });
      }
      return { ...r, lessons };
    },
  }),
  op({
    name: 'jw.syllabus', summary: '某个教学班的教学大纲：课程信息、简介、教学目标、每周内容安排、考核方式和权重、教材、教学团队。教学班 id 来自 fdu jw lessons。', login: 'uis', effect: 'read',
    params: { lesson: z.string().regex(/^\d+$/).describe('教学班 id（fdu jw lessons 结果里的 id）'), maxChars: int('最多返回多少字，默认 30000', 1000, 200_000) },
    examples: ['fdu jw syllabus --lesson 1037803'],
    async run(ctx, a) { return readSyllabus(ctx.session.reader('jwfw'), a.lesson, a.maxChars); },
  }),
  op({
    name: 'jw.selected', summary: '选课结果：某学期已选上的课、学分和上课时间。', login: 'uis', effect: 'read',
    params: { which: z.string().optional().describe('current 当前学期（默认）、next 下学期，或学期名关键词') },
    async run(ctx, a) { return readSelectedCourses(ctx.session.reader('jwfw'), a.which ?? 'current'); },
  }),

  // ======================= iCourse 课程回放 =======================
  op({
    name: 'icourse.search', summary: '在 iCourse（课程回放）里按课程名或老师找课程，返回课程号。默认找最新学期。', login: 'uis', effect: 'read',
    params: { keyword: z.string().min(1).describe('课程名或老师名'), term: z.string().regex(/^\d+$/).optional().describe('iCourse 的学期编号（来自 icourse terms），默认最新学期'), limit: int('最多几条，默认 20', 1, 100) },
    examples: ['fdu icourse search --keyword 数据结构'],
    async run(ctx, a) { return icourse(ctx).search(a.keyword, { term: a.term, limit: a.limit }); },
  }),
  op({
    name: 'icourse.terms', summary: 'iCourse 上有课程的学期和对应的学期编号（新的在前）。', login: 'uis', effect: 'read', params: {},
    async run(ctx) { return icourse(ctx).terms(); },
  }),
  op({
    name: 'icourse.lectures', summary: '一门课在 iCourse 上的全部讲次：日期、节次、主讲人、有没有回放，按日期排序。', login: 'uis', effect: 'read',
    params: { course: z.string().regex(/^\d+$/).describe('课程号（来自 icourse search）'), playback: flag('只看有回放的') },
    examples: ['fdu icourse lectures --course 12345 --playback'],
    async run(ctx, a) {
      const r = await icourse(ctx).lectures(a.course);
      return a.playback ? { ...r, lectures: r.lectures.filter((l) => l.hasPlayback) } : r;
    },
  }),
  op({
    name: 'icourse.transcript', summary: '某一讲的课堂文字稿（平台自动转写，带时间），可以用来总结这节课讲了什么。学校审核期内还没开放的回放会如实说明，不绕过。文字稿较长时分段返回。',
    login: 'uis', effect: 'read',
    params: {
      course: z.string().regex(/^\d+$/).describe('课程号'),
      lecture: z.string().regex(/^\d+$/).describe('讲次号（来自 icourse lectures 的 lectureId）'),
      format: z.enum(['text', 'segments']).optional().describe('text 按分钟合成段落（默认）；segments 原始分段（开始、结束秒数）'),
      offset: z.coerce.number().int().min(0).optional().describe('从第几个字开始（分段读取长文字稿用，默认 0）'),
      maxChars: z.coerce.number().int().min(1000).max(200_000).optional().describe('最多返回多少字，默认 30000'),
    },
    examples: ['fdu icourse transcript --course 12345 --lecture 67890', 'fdu icourse transcript --course 12345 --lecture 67890 --offset 30000'],
    async run(ctx, a) {
      const { segments } = await icourse(ctx).transcript(a.course, a.lecture);
      if (!segments.length) return { course: a.course, lecture: a.lecture, empty: true, note: '这一讲没有文字稿（平台没有转写，或者没有声音）。' };
      const max = a.maxChars ?? 30_000;
      const offset = a.offset ?? 0;
      const duration = clock(segments[segments.length - 1].end);
      if (a.format === 'segments') {
        // 按字数切：从 offset 个字之后的分段开始
        let seen = 0;
        let used = 0;
        const out: { start: string; end: string; text: string }[] = [];
        let next: number | undefined;
        for (const s of segments) {
          const len = s.text.length;
          if (seen + len <= offset) { seen += len; continue; }
          if (used + len > max && out.length) { next = seen; break; }
          out.push({ start: clock(s.start), end: clock(s.end), text: s.text });
          used += len;
          seen += len;
        }
        return { course: a.course, lecture: a.lecture, duration, segments: out, ...(next !== undefined ? { nextOffset: next } : {}) };
      }
      const text = transcriptText(segments);
      const part = text.slice(offset, offset + max);
      const nextOffset = offset + max < text.length ? offset + max : undefined;
      return { course: a.course, lecture: a.lecture, duration, totalChars: text.length, offset, text: part, ...(nextOffset !== undefined ? { nextOffset, note: `还有 ${text.length - nextOffset} 字，用 --offset ${nextOffset} 继续读。` } : {}) };
    },
  }),

  // ======================= 校园生活 =======================
  op({
    name: 'card.balance', summary: '校园卡余额。', login: 'uis', effect: 'read', params: {},
    async run(ctx) { return { balance: await readCardBalance(ctx.session.reader('jwfw')), at: new Date(ctx.now()).toISOString() }; },
  }),
  op({
    name: 'card.transactions', summary: '校园卡消费记录（时间、类型、商户、金额；支出为负）和统计：总支出、充值、日均、按商户和餐次。默认最近 7 天。', login: 'uis', effect: 'read', sensitive: true,
    params: {
      days: int('最近几天（含今天），默认 7', 1, 366),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('开始日期 YYYY-MM-DD（和 --days 二选一）'),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('结束日期，默认今天'),
      limit: int('最多返回几条明细，默认 100（统计按全部记录算）', 0, 2000),
      merchant: z.string().optional().describe('只看商户名包含这个词的，如「食堂」「北区」'),
    },
    examples: ['fdu card transactions', 'fdu card transactions --days 30 --limit 0', 'fdu card transactions --from 2026-10-01 --to 2026-10-31'],
    async run(ctx, a) {
      const range = cardRange(ctx.now(), { days: a.days, from: a.from, to: a.to });
      const { records, truncated } = await readCardRecords(ctx.session.reader('jwfw'), range);
      const picked = a.merchant ? records.filter((r) => r.merchant.includes(a.merchant!)) : records;
      const limit = a.limit ?? 100;
      return {
        ...range,
        summary: summarize(picked),
        records: picked.slice(0, limit).map((r) => ({ ...r, timeShanghai: shanghaiDate(r.time) })),
        ...(picked.length > limit ? { note: `只列出最新 ${limit} 条明细，统计按全部 ${picked.length} 条计算；要全部明细用 --limit ${Math.min(2000, picked.length)}。` } : {}),
        ...(truncated ? { truncated: true, note: '记录太多，只读了最近的一部分；缩短日期范围可以读全。' } : {}),
      };
    },
  }),
  op({
    name: 'venue.list', summary: '可以预约的体育场馆（id、名称），如「北区体育馆-羽毛球」。', login: 'uis', effect: 'read', params: {},
    async run(ctx) { return withBooking(ctx, listVenues); },
  }),
  op({
    name: 'venue.free', summary: '体育场馆的空闲时段：每个时段还有哪些场地空着（只看，不预约）。场馆可以写 id 或名称关键词（如「北区 羽毛球」）。', login: 'uis', effect: 'read',
    params: {
      venue: z.string().min(1).describe('场馆 id 或名称关键词，多个词用空格分开'),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('日期 YYYY-MM-DD，默认今天'),
      days: int('连看几天，默认 1', 1, 7),
      all: flag('也列出已经约满的时段'),
    },
    examples: ['fdu venue free --venue "北区 羽毛球"', 'fdu venue free --venue 正大 --date 2026-11-10 --days 3'],
    async run(ctx, a) {
      const from = a.date ?? shanghaiDay(ctx.now());
      const to = addDays(from, (a.days ?? 1) - 1);
      return withBooking(ctx, async (getJson) => {
        const matched = matchVenues(await listVenues(getJson), a.venue);
        if (!matched.length) throw new FduError('NOT_FOUND', `没有找到场馆「${a.venue}」。`, '用 `fdu venue list` 查看场馆名称。');
        if (matched.length > 5) throw new FduError('BAD_ARGS', `「${a.venue}」对应了 ${matched.length} 个场馆，请写得更具体一些：${matched.slice(0, 8).map((v) => v.name).join('、')}……`);
        const out = [];
        for (const v of matched) {
          const days = await venueCalendar(getJson, v.id, from, to);
          out.push({ venue: v.name, id: v.id, days: a.all ? days : days.map((d) => ({ ...d, slots: d.slots.filter((s) => s.free.length) })) });
        }
        return { from, to, venues: out, note: '只是查看空闲情况；预约请到 booking.fudan.edu.cn。' };
      });
    },
  }),
  op({
    name: 'canteen.login', summary: '食堂人数页面要求二次验证（微信扫码）：打开浏览器，按页面提示完成验证，看到食堂人数或开放时段说明后窗口自动关闭。',
    login: 'none', effect: 'auth', mcp: false, params: {},
    async run(ctx) {
      if (!ctx.session.hasState()) throw new NeedLoginError('jwfw');
      ctx.log('已打开食堂人数页面：按提示用微信扫码完成二次验证；看到页面内容后窗口会自动关闭。');
      const loaded = (html: string) => { try { parseCanteen(html); return true; } catch { return false; } };
      let ok = false;
      await ctx.session.withPage(CANTEEN_URL, (_page, html) => (ok = loaded(html)), { headless: false, timeoutMs: 300_000 });
      if (!ok) throw new FduError('NEED_LOGIN', '没有完成二次验证。', CANTEEN_LOGIN_HINT);
      await ctx.session.save();
      return { verified: true };
    },
  }),
  op({
    name: 'canteen.crowd', summary: '各食堂现在的就餐人数和容量（ratio = 人数 / 容量）。不在用餐时段时 open 为 false，并附上学校页面的说明。',
    login: 'uis', effect: 'read',
    params: { campus: z.string().optional().describe('只看某个校区：邯郸、枫林、江湾、张江') },
    examples: ['fdu canteen crowd', 'fdu canteen crowd --campus 邯郸'],
    async run(ctx, a) {
      let r;
      try {
        r = await readCanteen(ctx.session.reader('jwfw'));
      } catch (e) {
        // 统一身份认证还有效却被拦在登录页：这个页面要的是二次验证
        if (e instanceof NeedLoginError && (await platformStatus(ctx.session, 'jwfw')) === 'ok') {
          throw new FduError('NEED_LOGIN', '食堂人数页面要求二次验证（微信扫码）。', CANTEEN_LOGIN_HINT);
        }
        throw e;
      }
      const campuses = a.campus ? r.campuses.filter((c) => c.campus.includes(a.campus!.replace(/校区$/, ''))) : r.campuses;
      return { ...r, campuses, at: new Date(ctx.now()).toISOString() };
    },
  }),
  op({
    name: 'bus.schedule', summary: '校区间校车时刻表：每班车的出发校区、到达校区和发车时间，按发车时间排序。',
    login: 'uis', effect: 'read',
    params: {
      holiday: flag('节假日时刻表（默认工作日）'),
      from: z.string().optional().describe('出发校区：邯郸、江湾、枫林、张江'),
      to: z.string().optional().describe('到达校区'),
    },
    examples: ['fdu bus schedule --from 邯郸 --to 江湾', 'fdu bus schedule --holiday'],
    async run(ctx, a) {
      const trips = filterBus(await readBus(ctx.session.reader('jwfw'), Boolean(a.holiday)), { from: a.from, to: a.to });
      return { holiday: Boolean(a.holiday), trips };
    },
  }),
  op({
    name: 'dorm.electricity', summary: '宿舍剩余电量（度）。', login: 'uis', effect: 'read', params: {},
    async run(ctx) { return readElectricity(ctx.session.reader('jwfw')); },
  }),
  op({
    name: 'library.seats', summary: '各图书馆在馆人数和还能进多少人（公开接口，不用登录）。', login: 'none', effect: 'read', params: {},
    async run(ctx) { return readLibrary(async (url) => { const r = await ctx.session.raw(url, { method: 'POST' }); return { status: r.status, text: r.text }; }); },
  }),
  // ======================= 空教室 =======================
  op({
    name: 'rooms.login', summary: '登录空教室系统（学校多媒体教室的「在线课表」，校外经 WebVPN）：打开窗口，按提示登录，看到课表后窗口自动关闭。',
    login: 'none', effect: 'auth', mcp: false, params: {},
    async run(ctx) {
      if (!ctx.session.hasState()) throw new NeedLoginError('jwfw');
      await ensureWebvpn(ctx.session, { headless: false });
      ctx.log('已打开空教室系统：如果要求登录，请在窗口里登录；看到课表后窗口会自动关闭。');
      let ok = false;
      await ctx.session.withPage(toWebvpnUrl(`${ROOMS_ORIGIN}/day.asp?b=H2`), (_page, html) => (ok = /statusTable_1/.test(html) && /td001/.test(html)), { headless: false, timeoutMs: 300_000 });
      if (!ok) throw new FduError('NEED_LOGIN', '没有完成空教室系统的登录。', ROOMS_LOGIN_HINT);
      await ctx.session.save();
      return { loggedIn: true };
    },
  }),
  op({
    name: 'rooms.free', summary: '空教室：某栋楼某天某几节都空着的教室（按座位从多到少），以及空到什么时候。默认今天、从现在这节起两节。数据来自学校多媒体教室系统的在线课表。',
    login: 'uis', effect: 'read',
    params: {
      building: z.string().min(1).describe(`教学楼代码，多个用逗号分开：${BUILDINGS.join('、')}（H2 = 二教，HGX = 光华楼）`),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('日期 YYYY-MM-DD，默认今天'),
      from: int('从第几节（1–14），默认现在这一节', 1, 14),
      to: int('到第几节（含），默认 from 的下一节', 1, 14),
      minSeats: int('至少多少座位', 1, 1000),
    },
    examples: ['fdu rooms free --building H2', 'fdu rooms free --building H3,H4 --date 2026-11-10 --from 6 --to 8'],
    async run(ctx, a) {
      const today = shanghaiDay(ctx.now());
      const day = a.date ?? today;
      const out = [];
      for (const b of buildingList(a.building)) {
        const page = await roomsDayPage(ctx, b, day);
        const nowHm = new Date(ctx.now() + 8 * 3_600_000).toISOString().slice(11, 16);
        const from = a.from ?? (day === today ? periodAt(page.periods, nowHm) : 1);
        if (from === undefined) { out.push({ building: b, note: '今天的课都上完了（第十四节已过）。' }); continue; }
        const to = Math.min(a.to ?? (a.from === undefined && day !== today ? 14 : from + 1), page.periods.length);
        if (to < from) throw new FduError('BAD_ARGS', '--to 不能小于 --from。');
        const free = freeRooms(page, from, to, { minCapacity: a.minSeats });
        out.push({ building: b, date: page.date ?? day, week: page.week, periods: `第 ${from === to ? from : `${from}–${to}`} 节（${periodSpan(page.periods, from, to)}）`, freeCount: free.length, free });
      }
      return { results: out, note: '「不开放自修」等标注也算占用；临时借用以学校系统为准。' };
    },
  }),
  op({
    name: 'rooms.day', summary: '教室的完整信息（给 AI 判断用）：每栋楼的汇总（按楼层的教室数、座位，查今天时还有现在空着 / 在用几间），每间教室的楼层、座位、全天每段安排（节次、时间、课程代码、课名、老师、人数、临借活动等）、空闲时段；查今天时附上现在的状态（空到几点，或在上什么、到几点）。不指定楼时查全部教学楼（数据较多）。',
    login: 'uis', effect: 'read',
    params: {
      building: z.string().optional().describe(`教学楼代码，多个用逗号分开：${BUILDINGS.join('、')}（H2 = 二教，HGX = 光华楼）；不填查全部`),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('日期 YYYY-MM-DD，默认今天'),
      room: z.string().optional().describe('只看某间教室，如 H2101'),
      brief: flag('简要：不列每节的课程，只给汇总、座位、现在的状态和空闲时段（查很多楼时用）'),
    },
    examples: ['fdu rooms day --building H2', 'fdu rooms day --building H3,HGX --date 2026-11-10', 'fdu rooms day --brief'],
    async run(ctx, a) {
      const today = shanghaiDay(ctx.now());
      const day = a.date ?? today;
      const list = a.building ? buildingList(a.building, 12) : BUILDINGS;
      const nowHm = day === today ? new Date(ctx.now() + 8 * 3_600_000).toISOString().slice(11, 16) : undefined;
      const results = [];
      const errors: Record<string, string> = {};
      let periods: { no: number; start: string; end: string }[] | undefined;
      for (const b of list) {
        try {
          const page = await roomsDayPage(ctx, b, day);
          periods ??= page.periods;
          const report = roomsReport(b, page, { nowHm, room: a.room });
          results.push(a.brief ? { ...report, rooms: report.rooms.map(({ schedule: _s, ...rest }) => rest) } : report);
        } catch (e) {
          // 登录问题直接报，其他问题（某栋楼读不到）记下来继续
          if (e instanceof FduError && e.code.startsWith('NEED_')) throw e;
          errors[b] = (e as Error).message;
        }
      }
      const buildings = a.room ? results.filter((r) => r.rooms.length) : results;
      if (a.room && !buildings.length) throw new FduError('NOT_FOUND', `没有找到教室 ${a.room}。`, '检查教室号，或者用 --building 指定楼。');
      return {
        date: day, ...(nowHm ? { now: nowHm } : {}),
        periods: periods?.map((p) => `第${p.no}节 ${p.start}-${p.end}`),
        buildings,
        ...(Object.keys(errors).length ? { errors } : {}),
        note: '「不开放自修」等标注算占用；临时借用以学校系统为准。',
      };
    },
  }),

  op({
    name: 'library.login', summary: '登录图书馆「我的借阅」：打开图书馆页面，点「登录」（走统一身份认证，已登录复旦账号时一般不用再输密码），看到借阅信息后窗口会自动关闭。',
    login: 'none', effect: 'auth', mcp: false, params: {},
    async run(ctx) {
      let ok = false;
      let token: string | undefined;
      let expiresIn: number | undefined;
      let listening = false;
      ctx.log('已打开图书馆页面：请点右上角「登录」，登录后进入「我的借阅」，看到借阅信息后窗口会自动关闭。');
      await ctx.session.withPage(OPAC, async (page) => {
        if (!listening) {
          listening = true;
          page.on('response', (res) => {
            if (!res.url().includes('fdulspgw.fudan.edu.cn/alsp/open-api/') || res.status() !== 200) return;
            // 登录换令牌的那一步：顺便记下有效期
            if (res.url().includes('/oauth2/getToken')) {
              void res.json().then((j: { data?: { expires_in?: number } }) => { if (typeof j?.data?.expires_in === 'number') expiresIn = j.data.expires_in; }).catch(() => undefined);
            }
            const t = res.request().headers().access_token;
            if (t && res.url().includes('/elib5/')) { token = t; ok = true; }
          });
        }
        return ok;
      }, { headless: false, timeoutMs: 300_000 });
      if (!ok || !token) throw new FduError('NEED_LOGIN', '没有完成图书馆登录。', '重新运行 `fdu library login`，登录后点开「我的借阅」。');
      // 图书馆网页把令牌放在关掉页面就清空的地方，所以这里单独保存（权限 600）
      ctx.store.writeJson(LIB_TOKEN, { token, savedAt: new Date(ctx.now()).toISOString(), ...(expiresIn ? { expiresAt: new Date(ctx.now() + expiresIn * 1000).toISOString() } : {}) });
      await ctx.session.save();
      return { loggedIn: true };
    },
  }),
  op({
    name: 'library.loans', summary: '图书馆在借的书：书名、作者、索书号、馆藏地、借阅日期、应还日期、还剩几天、续借次数；以及还能借几本、逾期几本、欠费。只看，不续借。',
    login: 'uis', effect: 'read', sensitive: true, params: {},
    examples: ['fdu library loans'],
    async run(ctx) { return withLibrary(ctx, (getJson) => readLoans(getJson, shanghaiDay(ctx.now()))); },
  }),
  op({
    name: 'library.history', summary: '图书馆借阅历史（书名、作者、借阅和归还日期），按页读取。', login: 'uis', effect: 'read', sensitive: true,
    params: { page: int('第几页，默认 1', 1, 1000), size: int('每页几条，默认 20', 1, 100) },
    async run(ctx, a) { return withLibrary(ctx, (getJson) => readHistory(getJson, a.page ?? 1, a.size ?? 20)); },
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

  // ======================= 树洞与蛋壳课评 =======================
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
    name: 'danke.search', summary: '在蛋壳课评（danke.fduhole.com，旦挞的课程评价）里搜索课程。', login: 'hole', effect: 'read',
    params: { keyword: z.string().min(1).describe('课程名或课程代码'), limit: int('几条，默认 10', 1, 50) },
    async run(ctx, a) { return treehole(ctx).searchCourses(a.keyword, a.limit); },
  }),
  op({
    name: 'danke.reviews', summary: '某门课在蛋壳课评上的评价（评分、作业量、给分、各老师的评价）。', login: 'hole', effect: 'read',
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
