import { FduError, toFduError, type ErrorCode } from '../core/errors';
import { addDays, dateOfWeek, holidayOn, shanghaiDay, shanghaiTime, sundayOf, week0SundayFor, weekInfo, type WeekInfo } from './calendar';
import type { TimetableView } from './jw';
import type { Exam } from './timetable';

/** 汇总要用到的作业信息（eLearning 作业的一部分字段） */
export interface DueItem { name: string; course?: string; dueAt?: string; done: boolean; htmlUrl?: string }

/** 三类数据分别读取：一类读不到不影响其他两类 */
export interface OverviewDeps {
  timetable(): Promise<TimetableView>;
  assignments(): Promise<DueItem[]>;
  exams(): Promise<Exam[]>;
}

export interface ClassSession { course: string; start: string; end: string; startsAt: string; endsAt: string; location?: string; teachers: string[]; periods: string }
export interface DayPlan extends WeekInfo { classes: ClassSession[] }
export interface SectionError { code: string; message: string; hint?: string }

const DAY = 86_400_000;
const showTime = (iso: string) => new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });

async function settle<T>(f: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: SectionError }> {
  try { return { ok: true, value: await f() }; } catch (e) {
    const err = toFduError(e);
    return { ok: false, error: { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) } };
  }
}

/** 某天的课：按教学周和星期筛选；放假的日子没有课 */
export function classesOn(table: TimetableView, day: string): ClassSession[] {
  const info = weekInfo(day, table.semester);
  if (info.week === undefined || holidayOn(day)) return [];
  const out: ClassSession[] = [];
  for (const c of table.courses) {
    for (const s of c.sessions) {
      if (s.weekday !== info.weekday || !s.weeks.includes(info.week)) continue;
      out.push({ course: c.course, start: s.start, end: s.end, startsAt: shanghaiTime(day, s.start), endsAt: shanghaiTime(day, s.end), location: s.location, teachers: c.teachers, periods: s.periods });
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * 一段日期（含首尾）的概况：每天的课、这段时间里要交的作业、考试。
 * deadlineDays / examDays：作业和考试往后多看几天（「今天」也想知道后天要交什么）。
 */
export async function overview(deps: OverviewDeps, opts: { from: string; to: string; now: number; deadlineDays?: number; examDays?: number }) {
  const [table, due, exams] = await Promise.all([settle(deps.timetable), settle(deps.assignments), settle(deps.exams)]);
  const errors: Record<string, SectionError> = {};
  if (!table.ok) errors.timetable = table.error;
  if (!due.ok) errors.assignments = due.error;
  if (!exams.ok) errors.exams = exams.error;
  // 三类都读不到、原因相同（比如都没登录）时，整体失败，让调用方按错误码处理
  const all = [table, due, exams];
  if (all.every((r) => !r.ok) && new Set(all.map((r) => !r.ok && r.error.code)).size === 1) {
    const first = Object.values(errors)[0];
    throw new FduError(first.code as ErrorCode, first.message, first.hint);
  }

  const days: DayPlan[] = [];
  for (let d = opts.from; d <= opts.to; d = addDays(d, 1)) {
    const info = weekInfo(d, table.ok ? table.value.semester : undefined);
    days.push({ ...info, classes: table.ok ? classesOn(table.value, d) : [] });
  }
  const start = Date.parse(`${opts.from}T00:00:00+08:00`);
  const end = Date.parse(`${opts.to}T00:00:00+08:00`) + DAY;
  const dueEnd = Math.max(end, start + (opts.deadlineDays ?? 0) * DAY);
  const examEnd = Math.max(end, start + (opts.examDays ?? 0) * DAY);
  const pending = due.ok ? due.value.filter((a) => !a.done && a.dueAt) : [];
  return {
    from: opts.from, to: opts.to, days,
    deadlines: pending
      .filter((a) => Date.parse(a.dueAt!) >= Math.min(start, opts.now) && Date.parse(a.dueAt!) < dueEnd)
      .sort((a, b) => a.dueAt!.localeCompare(b.dueAt!))
      .map((a) => ({ ...a, dueAtShanghai: showTime(a.dueAt!) })),
    overdue: pending
      .filter((a) => Date.parse(a.dueAt!) < Math.min(start, opts.now) && Date.parse(a.dueAt!) > opts.now - 14 * DAY)
      .map((a) => ({ ...a, dueAtShanghai: showTime(a.dueAt!) })),
    exams: exams.ok ? exams.value
      .filter((e) => Date.parse(e.startsAt) >= start && Date.parse(e.startsAt) < examEnd)
      .map((e) => ({ ...e, startsAtShanghai: showTime(e.startsAt) })) : [],
    ...(Object.keys(errors).length ? { errors } : {}),
  };
}

/** 「今天」：当天的课，3 天内要交的作业，7 天内的考试 */
export function todayRange(now: number, date?: string) {
  const day = date ?? shanghaiDay(now);
  return { from: day, to: day, deadlineDays: 3, examDays: 7 };
}

/** 「这周」：按校历一周从周日开始 */
export function weekRange(now: number, date?: string) {
  const sunday = sundayOf(date ?? shanghaiDay(now));
  return { from: sunday, to: addDays(sunday, 6) };
}

/** 课表里全部上课时间（导出日历用）：每门课每个教学周每一次课；放假的日子跳过 */
export function allSessions(table: TimetableView): { sessions: (ClassSession & { date: string; week: number })[]; skipped: { date: string; course: string; reason: string }[]; week0Sunday?: string } {
  const w0 = table.semester ? week0SundayFor(table.semester) : undefined;
  if (!w0) return { sessions: [], skipped: [] };
  const sessions: (ClassSession & { date: string; week: number })[] = [];
  const skipped: { date: string; course: string; reason: string }[] = [];
  for (const c of table.courses) {
    for (const s of c.sessions) {
      for (const week of s.weeks) {
        const date = dateOfWeek(w0, week, s.weekday);
        const holiday = holidayOn(date);
        if (holiday) { skipped.push({ date, course: c.course, reason: holiday }); continue; }
        sessions.push({ date, week, course: c.course, start: s.start, end: s.end, startsAt: shanghaiTime(date, s.start), endsAt: shanghaiTime(date, s.end), location: s.location, teachers: c.teachers, periods: s.periods });
      }
    }
  }
  return { sessions: sessions.sort((a, b) => a.startsAt.localeCompare(b.startsAt)), skipped, week0Sunday: w0 };
}
