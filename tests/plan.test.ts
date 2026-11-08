import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Cache, cacheKey } from '../src/core/cache';
import { FduError } from '../src/core/errors';
import { NeedLoginError } from '../src/core/fudan-auth';
import { Store } from '../src/core/store';
import { findOp, type Ctx, type Op } from '../src/ops';
import { exitCode, runOp } from '../src/run';
import { dateOfWeek, shanghaiDay, weekInfo, week0SundayFor } from '../src/services/calendar';
import { runDoctor, type DoctorDeps } from '../src/services/doctor';
import { buildIcs, foldLine, icsText } from '../src/services/ics';
import type { TimetableView } from '../src/services/jw';
import { allSessions, classesOn, overview, todayRange, weekRange, type OverviewDeps } from '../src/services/overview';

/** 今天 / 本周汇总、教学周、日历导出、缓存、doctor（课表、作业、考试都是虚构的） */

const table: TimetableView = {
  kind: 'undergraduate',
  semester: { id: '521', name: '2026-2027学年1学期', startDate: '2026-09-06' },
  courses: [
    { course: '数据结构', teachers: ['张老师'], sessions: [
      { weekday: 1, periods: '6-7', start: '13:30', end: '15:10', location: 'H2215', weeks: Array.from({ length: 16 }, (_, i) => i + 1) },
      { weekday: 4, periods: '3-4', start: '09:55', end: '11:35', location: 'H2215', weeks: [2, 4, 6, 8, 10, 12, 14, 16] },
    ] },
    { course: '体育（羽毛球）', teachers: ['李老师'], sessions: [{ weekday: 7, periods: '1-2', start: '08:00', end: '09:40', location: '正大体育馆', weeks: [10] }] },
  ],
};
const NOW = Date.parse('2026-11-09T02:00:00Z'); // 上海时间 2026-11-09（周一）10:00

describe('校历与教学周', () => {
  it('按校历：周日开始一周，第 0 周是注册周', () => {
    expect(weekInfo('2026-08-30')).toMatchObject({ week: 0, weekday: 7, source: 'calendar', note: expect.stringContaining('注册') });
    expect(weekInfo('2026-09-07')).toMatchObject({ week: 1, weekday: 1, weekdayName: '周一' });
    expect(weekInfo('2026-11-08')).toMatchObject({ week: 10, weekday: 7, weekSunday: '2026-11-08' });
    expect(weekInfo('2026-11-14')).toMatchObject({ week: 10, weekday: 6 });
    expect(weekInfo('2026-10-01')).toMatchObject({ holiday: expect.stringContaining('国庆') });
  });

  it('校历没覆盖的学期按教务系统的开始日期推算；寒暑假没有教学周', () => {
    expect(weekInfo('2027-09-14', { name: '2027-2028学年1学期', startDate: '2027-09-06' })).toMatchObject({ week: 2, source: 'jw' });
    expect(weekInfo('2027-08-01')).toMatchObject({ source: 'none' });
    expect(weekInfo('2027-08-01').week).toBeUndefined();
    expect(week0SundayFor({ name: '2026-2027学年1学期' })).toBe('2026-08-30');
  });

  it('第几周星期几是哪一天；上海时间的日期', () => {
    expect(dateOfWeek('2026-08-30', 10, 1)).toBe('2026-11-09');
    expect(dateOfWeek('2026-08-30', 10, 7)).toBe('2026-11-08');
    expect(shanghaiDay(Date.parse('2026-11-08T17:00:00Z'))).toBe('2026-11-09');
  });
});

describe('今天和这周', () => {
  const deps = (over: Partial<OverviewDeps> = {}): OverviewDeps => ({
    timetable: async () => table,
    assignments: async () => [
      { name: 'Lab 5', course: '数据结构', dueAt: '2026-11-10T15:59:00Z', done: false },
      { name: 'Lab 4', course: '数据结构', dueAt: '2026-11-05T15:59:00Z', done: false },
      { name: 'Lab 3', course: '数据结构', dueAt: '2026-11-10T15:59:00Z', done: true },
      { name: '期末论文', course: '大学写作', dueAt: '2026-12-20T15:59:00Z', done: false },
    ],
    exams: async () => [{ course: '数据结构（期中）', startsAt: '2026-11-12T01:00:00Z', endsAt: '2026-11-12T03:00:00Z', location: 'H3108', timeText: '2026-11-12 09:00~11:00' }],
    ...over,
  });

  it('今天：只列今天的课（按教学周），3 天内的作业，7 天内的考试，过期没交的单独列出', async () => {
    const r = await overview(deps(), { ...todayRange(NOW), now: NOW });
    expect(r.days[0]).toMatchObject({ date: '2026-11-09', week: 10 }); // 11-08（周日）开始第 10 周
    expect(r.days[0].classes.map((c) => `${c.course} ${c.start}`)).toEqual(['数据结构 13:30']);
    expect(r.days[0].classes[0].startsAt).toBe('2026-11-09T05:30:00.000Z');
    expect(r.deadlines.map((d) => d.name)).toEqual(['Lab 5']);
    expect(r.overdue.map((d) => d.name)).toEqual(['Lab 4']);
    expect(r.exams.map((e) => e.course)).toEqual(['数据结构（期中）']);
    expect(r).not.toHaveProperty('errors');
  });

  it('这周：周日到周六，单双周和只上一次的课都排对', async () => {
    const r = await overview(deps(), { ...weekRange(NOW, '2026-11-08'), now: NOW });
    expect(r.days.map((d) => d.date)).toEqual(['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14']);
    expect(r.days[0].classes.map((c) => c.course)).toEqual(['体育（羽毛球）']); // 第 10 周周日
    expect(r.days[4].classes.map((c) => c.course)).toEqual(['数据结构']); // 第 10 周是双周，周四有课
    expect(r.days[1].classes.map((c) => c.course)).toEqual(['数据结构']);
  });

  it('一类数据读不到时其他照常返回；全部因为没登录读不到时整体要求登录', async () => {
    const partial = await overview(deps({ assignments: async () => { throw new NeedLoginError('elearning'); } }), { ...todayRange(NOW), now: NOW });
    expect(partial.errors).toMatchObject({ assignments: { code: 'NEED_LOGIN' } });
    expect(partial.days[0].classes).toHaveLength(1);
    const fail = () => { throw new NeedLoginError('jwfw'); };
    await expect(overview({ timetable: fail, assignments: fail, exams: fail }, { ...todayRange(NOW), now: NOW })).rejects.toMatchObject({ code: 'NEED_LOGIN' });
  });

  it('放假的日子没有课', () => {
    expect(classesOn(table, '2026-10-05')).toEqual([]); // 国庆，周一
    expect(classesOn(table, '2026-10-12')).toHaveLength(1);
  });
});

describe('导出日历', () => {
  it('每次课一条日程，放假跳过；考试和截止时间带提醒', () => {
    const all = allSessions(table);
    expect(all.week0Sunday).toBe('2026-08-30');
    // 数据结构周一 16 次、双周周四 8 次，国庆的 10-05（周一）和 10-01（第 4 周周四）停课；体育 1 次
    expect(all.sessions).toHaveLength(15 + 7 + 1);
    expect(all.skipped.map((x) => x.date).sort()).toEqual(['2026-10-01', '2026-10-05']);
    const ics = buildIcs([
      { key: 'a', summary: '数据结构', startsAt: all.sessions[0].startsAt, endsAt: all.sessions[0].endsAt, location: 'H2215', description: '第 1 周\n张老师' },
      { key: 'b', summary: '考试：线性代数, 期中', startsAt: '2026-11-12T01:00:00.000Z', endsAt: '2026-11-12T03:00:00.000Z', alarmMinutes: 1440 },
    ], { name: '复旦课表', now: NOW });
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).toContain('DTSTART:20260907T053000Z'); // 第 1 周周一 13:30 上海时间
    expect(ics).toContain('SUMMARY:考试：线性代数\\, 期中');
    expect(ics).toContain('DESCRIPTION:第 1 周\\n张老师');
    expect(ics).toContain('TRIGGER:-PT1440M');
    // UID 由内容决定：同一份课表重复导出 UID 不变
    expect(buildIcs([{ key: 'a', summary: 'x', startsAt: '2026-11-12T01:00:00.000Z', endsAt: '2026-11-12T03:00:00.000Z' }], { name: 'n', now: 1 }).match(/UID:(\S+)/)![1])
      .toBe(ics.match(/UID:(\S+)/)![1]);
  });

  it('长行按 75 字节折行，不把汉字拆开；特殊字符转义', () => {
    const line = `SUMMARY:${'复旦'.repeat(40)}`;
    const folded = foldLine(line);
    for (const part of folded.split('\r\n')) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, '')).toBe(line);
    expect(icsText('a;b,c\\d\ne')).toBe('a\\;b\\,c\\\\d\\ne');
  });
});

describe('缓存', () => {
  const ctxWith = (cache: Cache): Ctx => ({ cache, now: () => NOW } as unknown as Ctx);
  const op = (run: () => Promise<unknown>): Op => ({ ...findOp('jw.exams')!, run });

  it('成功后保存；--cached 不联网直接返回上次的结果和时间', async () => {
    process.env.FDU_HOME = mkdtempSync(join(tmpdir(), 'fdu-cache-'));
    const store = new Store();
    const cache = new Cache(store);
    let calls = 0;
    const o = op(async () => { calls++; return [{ course: '数据结构' }]; });
    expect(await runOp(o, ctxWith(cache), { all: 'true' })).toMatchObject({ ok: true });
    const hit = await runOp(o, ctxWith(cache), { all: true }, { cachedOnly: true });
    expect(hit).toMatchObject({ ok: true, data: [{ course: '数据结构' }], cachedAt: new Date(NOW).toISOString() });
    expect(calls).toBe(1);
    const miss = await runOp(o, ctxWith(cache), {}, { cachedOnly: true });
    expect(miss).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    // 缓存文件只有本人能读
    if (process.platform !== 'win32') {
      const file = store.path(`cache/${cacheKey('jw.exams', { all: true })}.json`);
      expect(JSON.parse(readFileSync(file, 'utf8')).op).toBe('jw.exams');
    }
  });

  it('没登录或学校系统出错时，错误里附上上次的结果；参数错误不附', async () => {
    process.env.FDU_HOME = mkdtempSync(join(tmpdir(), 'fdu-cache-'));
    const cache = new Cache(new Store());
    await runOp(op(async () => ['old']), ctxWith(cache), {});
    const r = await runOp(op(async () => { throw new NeedLoginError('jwfw'); }), ctxWith(cache), {});
    expect(r).toMatchObject({ ok: false, error: { code: 'NEED_LOGIN' }, cached: { data: ['old'] } });
    expect(exitCode(r)).toBe(3);
    const bad = await runOp(op(async () => ['x']), ctxWith(cache), { nope: 1 });
    expect(bad).not.toHaveProperty('cached');
    expect(cache.clear()).toBe(1);
  });

  it('隐私和本地操作不缓存：读邮件正文、下载、导出、doctor', () => {
    for (const name of ['mail.read', 'elearning.download', 'calendar.export', 'auth.doctor', 'auth.status']) {
      const o = findOp(name)!;
      expect(o.effect !== 'read' || o.cache === false).toBe(true);
    }
  });
});

describe('fdu doctor', () => {
  const base: DoctorDeps = {
    nodeVersion: 'v22.3.0', platform: 'linux', configDir: '/home/u/.config/fdu-cli/default',
    configDirState: () => ({ writable: true, mode: 0o40700 }),
    browser: async () => 'chromium 140.0',
    reach: async (url) => ({ status: url.includes('fduhole') ? 0 : 200, url }),
    login: async () => ({ hasState: true, elearning: 'ok', jwfw: 'ok', webvpn: false }),
    treehole: false, mail: true,
  };

  it('一切正常时 healthy；可选项给提示不算失败', async () => {
    const r = await runDoctor(base);
    expect(r.healthy).toBe(true);
    expect(r.checks.find((c) => c.name === '网络：树洞')).toMatchObject({ status: 'warn', detail: expect.stringContaining('WebVPN') });
    expect(r.checks.find((c) => c.name === '树洞账号')).toMatchObject({ status: 'warn', fix: expect.stringContaining('fdu hole login') });
  });

  it('Node 太旧、没有浏览器、连不上学校、登录过期：给出修复办法', async () => {
    const r = await runDoctor({
      ...base, nodeVersion: 'v18.19.0', configDirState: () => ({ writable: true, mode: 0o40755 }),
      browser: async () => { throw new FduError('NO_BROWSER', 'not found'); },
      reach: async (url) => {
        if (url.includes('elearning')) throw new Error('apiRequestContext.fetch: getaddrinfo ENOTFOUND');
        return { status: url.includes('fdjwgl') ? 403 : 200, url };
      },
      login: async () => ({ hasState: true, elearning: 'need_login', jwfw: 'ok', webvpn: true }),
      proxy: 'http://user:secret@127.0.0.1:7890',
    });
    expect(r.healthy).toBe(false);
    const by = (n: string) => r.checks.find((c) => c.name === n)!;
    expect(by('Node.js').status).toBe('fail');
    expect(by('配置目录')).toMatchObject({ status: 'warn', fix: expect.stringContaining('chmod 700') });
    expect(by('浏览器')).toMatchObject({ status: 'fail', fix: expect.stringContaining('FDU_BROWSER') });
    expect(by('网络：eLearning')).toMatchObject({ status: 'fail', detail: expect.stringContaining('ENOTFOUND') });
    expect(by('登录：eLearning')).toMatchObject({ status: 'fail', fix: expect.stringContaining('fdu login') });
    expect(by('网络：教务系统')).toMatchObject({ status: 'warn', detail: expect.stringContaining('403') });
    expect(by('网络：eLearning').detail).not.toContain('apiRequestContext');
    // 代理地址里的账号密码不显示
    expect(by('代理').detail).not.toContain('secret');
  });
});
