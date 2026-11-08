/**
 * 校历与教学周。
 *
 * 依据《复旦大学 2026—2027 学年校历》：
 * - 每周从**周日**开始；第 0 周是报到、注册周，第 1 周起上课；
 * - 每学期 18 个教学周（含考试），第 16 周通识教育课程考试，第 17、18 周停课考试。
 * 校历没写明的（期中、节假日具体安排）按惯例取值，标了 tentative，以学校通知为准。
 *
 * 内置校历覆盖不到的学期，用教务系统里学期的开始日期推算（开始日期所在的周日为第 1 周第一天）。
 */

export interface CalendarSemester {
  name: string;
  /** 第 0 周的周日 */
  week0Sunday: string;
  /** 学期最后一天（第 18 周周六） */
  end: string;
  phases: { weeks: number[]; note: string }[];
  holidays: { from: string; to: string; note: string; tentative?: boolean }[];
}

export const SEMESTERS: CalendarSemester[] = [
  {
    name: '2026-2027学年1学期',
    week0Sunday: '2026-08-30',
    end: '2027-01-09',
    phases: [
      { weeks: [0], note: '报到、入学教育、补考与注册' },
      { weeks: [1, 2], note: '开学初（按惯例为选课调整期）' },
      { weeks: [8, 9], note: '期中（按惯例）' },
      { weeks: [16], note: '通识教育课程考试' },
      { weeks: [17, 18], note: '停课考试周' },
    ],
    holidays: [
      { from: '2026-09-25', to: '2026-09-25', note: '中秋节（以学校通知为准）', tentative: true },
      { from: '2026-10-01', to: '2026-10-07', note: '国庆节（以学校通知为准）', tentative: true },
      { from: '2027-01-01', to: '2027-01-01', note: '元旦（以学校通知为准）', tentative: true },
    ],
  },
  {
    name: '2026-2027学年2学期',
    week0Sunday: '2027-02-14',
    end: '2027-06-26',
    phases: [
      { weeks: [0], note: '补考与注册' },
      { weeks: [1, 2], note: '开学初（按惯例为选课调整期）' },
      { weeks: [8, 9], note: '期中（按惯例）' },
      { weeks: [16], note: '通识教育课程考试' },
      { weeks: [17, 18], note: '停课考试周' },
    ],
    holidays: [
      { from: '2027-04-05', to: '2027-04-05', note: '清明节（以学校通知为准）', tentative: true },
      { from: '2027-05-01', to: '2027-05-05', note: '劳动节（以学校通知为准）', tentative: true },
      { from: '2027-05-14', to: '2027-05-14', note: '校田径运动会，停课一天' },
      { from: '2027-06-09', to: '2027-06-09', note: '端午节（以学校通知为准）', tentative: true },
    ],
  },
];

const DAY = 86_400_000;
const WEEKDAY = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 某个时刻在上海是哪一天（YYYY-MM-DD） */
export function shanghaiDay(t: number | Date = Date.now()): string {
  return new Date(+t + 8 * 3_600_000).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

/** 1 = 周一 … 7 = 周日（和课表的 weekday 一致） */
export function weekdayOf(day: string): number {
  const d = new Date(`${day}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** 这一天所在的周日（一周的第一天） */
export function sundayOf(day: string): string {
  return addDays(day, -(new Date(`${day}T00:00:00Z`).getUTCDay()));
}

/** 上海时间某天某时（HH:MM）→ ISO（UTC） */
export function shanghaiTime(day: string, hhmm: string): string {
  return new Date(Date.parse(`${day}T${hhmm}:00+08:00`)).toISOString();
}

export interface WeekInfo {
  date: string;
  weekday: number;
  weekdayName: string;
  semester?: string;
  /** 教学周（0 = 报到注册周）；寒暑假时没有 */
  week?: number;
  /** 这一周的周日（课表日期按它推算） */
  weekSunday?: string;
  holiday?: string;
  note?: string;
  /** calendar：内置校历；jw：按教务系统的学期开始日期推算；none：寒暑假或不知道 */
  source: 'calendar' | 'jw' | 'none';
}

/** 一个学期的第 0 周周日：内置校历优先，其次教务系统的开始日期 */
export function week0SundayFor(semester: { name?: string; startDate?: string }): string | undefined {
  const known = SEMESTERS.find((s) => semester.name && s.name === semester.name.replace(/\s+/g, ''));
  if (known) return known.week0Sunday;
  if (semester.startDate && /^\d{4}-\d{2}-\d{2}$/.test(semester.startDate)) return addDays(sundayOf(semester.startDate), -7);
  return undefined;
}

/** 某天是第几教学周。jw：教务系统的当前学期（内置校历覆盖不到时用） */
export function weekInfo(day: string, jw?: { name?: string; startDate?: string }): WeekInfo {
  const weekday = weekdayOf(day);
  const base = { date: day, weekday, weekdayName: WEEKDAY[weekday] };
  const known = SEMESTERS.find((s) => day >= s.week0Sunday && day <= s.end);
  if (known) {
    const week = Math.floor((Date.parse(day) - Date.parse(known.week0Sunday)) / DAY / 7);
    const holiday = known.holidays.find((h) => day >= h.from && day <= h.to)?.note;
    const note = known.phases.find((p) => p.weeks.includes(week))?.note;
    return { ...base, semester: known.name, week, weekSunday: sundayOf(day), holiday, note, source: 'calendar' };
  }
  const w0 = jw && week0SundayFor(jw);
  if (w0 && day >= w0) {
    const week = Math.floor((Date.parse(day) - Date.parse(w0)) / DAY / 7);
    if (week <= 20) return { ...base, semester: jw?.name, week, weekSunday: sundayOf(day), source: 'jw' };
  }
  return { ...base, source: 'none' };
}

/** 第几周星期几是哪一天（weekday：1 = 周一 … 7 = 周日；周日是这一周的第一天） */
export function dateOfWeek(week0Sunday: string, week: number, weekday: number): string {
  return addDays(week0Sunday, week * 7 + (weekday % 7));
}

/** 这一天是不是放假（内置校历里的节假日） */
export function holidayOn(day: string): string | undefined {
  for (const s of SEMESTERS) {
    const h = s.holidays.find((x) => day >= x.from && day <= x.to);
    if (h) return h.note;
  }
  return undefined;
}
