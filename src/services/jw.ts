import { NeedLoginError } from '../core/fudan-auth';
import type { CampusReader } from '../core/types';
import { readStudentId } from './grades';
import {
  EXAM_URL, POSTGRAD_TABLE_URL, UNDERGRAD_TABLE_URL, parseExamPage, parsePostgradTable, parseSemesterPage, parseUndergradTable,
  periodTime, TimetableFormatError, type Exam, type Semester, type TimetableEntry,
} from './timetable';

/**
 * 教务系统：学期、课表、考试安排（只读）。
 * 本科读 fdjwgl.fudan.edu.cn；研究生课表读研究生选课系统（yjsxk）。
 */

/** 「我的课表」页。刚登录时第一次访问可能停在单点登录的跳转页，读不到学期列表就再读一次 */
export async function readSemesters(reader: CampusReader): Promise<{ semesters: Semester[]; currentId?: string }> {
  for (let attempt = 0; ; attempt++) {
    const page = await reader.getText(UNDERGRAD_TABLE_URL);
    if (page.status >= 400) throw new Error(`教务系统返回 ${page.status}`);
    try {
      return parseSemesterPage(page.text);
    } catch (error) {
      if (/id\.fudan\.edu\.cn|uis\.fudan\.edu\.cn|authserver|统一身份认证/.test(page.url + page.text.slice(0, 3000))) throw new NeedLoginError('jwfw');
      if (attempt >= 1) throw error;
    }
  }
}

export interface TimetableView {
  kind: 'undergraduate' | 'postgraduate';
  semester?: Semester;
  courses: {
    course: string;
    teachers: string[];
    sessions: { weekday: number; periods: string; start: string; end: string; location?: string; weeks: number[] }[];
  }[];
}

const toView = (entries: TimetableEntry[]): TimetableView['courses'] => {
  const byCourse = new Map<string, TimetableView['courses'][number]>();
  for (const e of entries) {
    const c = byCourse.get(e.course) ?? { course: e.course, teachers: [], sessions: [] };
    for (const t of e.teachers) if (!c.teachers.includes(t)) c.teachers.push(t);
    const { start, end } = periodTime(e.startPeriod, e.endPeriod);
    c.sessions.push({ weekday: e.weekday, periods: `${e.startPeriod}-${e.endPeriod}`, start, end, location: e.location, weeks: e.weeks });
    byCourse.set(e.course, c);
  }
  for (const c of byCourse.values()) c.sessions.sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start));
  return [...byCourse.values()];
};

/** 课表。semester：学期 id 或学期名关键词，默认当前学期 */
export async function readTimetable(reader: CampusReader, opts: { semester?: string; postgraduate?: boolean } = {}): Promise<TimetableView> {
  if (opts.postgraduate) {
    const res = await reader.getText(`${POSTGRAD_TABLE_URL}?_=${Date.now()}`);
    if (res.status >= 400) throw new Error(`研究生选课系统返回 ${res.status}`);
    return { kind: 'postgraduate', courses: toView(parsePostgradTable(res.text)) };
  }
  const { semesters, currentId } = await readSemesters(reader);
  const want = opts.semester?.trim();
  const semester = want
    ? semesters.find((s) => s.id === want) ?? semesters.find((s) => s.name.includes(want))
    : semesters.find((s) => s.id === currentId) ?? semesters[0];
  if (!semester) throw want ? Object.assign(new Error(`没有找到学期「${want}」，用 fdu jw semesters 查看学期列表。`), { code: 'NOT_FOUND' }) : new TimetableFormatError();
  const data = await reader.getText(`${UNDERGRAD_TABLE_URL}/semester/${semester.id}/print-data`);
  if (data.status >= 400) throw new Error(`教务系统返回 ${data.status}`);
  return { kind: 'undergraduate', semester, courses: toView(parseUndergradTable(data.text)) };
}

/** 考试安排。默认只列一个月以内及以后的考试；all=true 列出页面上的全部记录 */
export async function readExams(reader: CampusReader, opts: { all?: boolean; now?: number } = {}): Promise<Exam[]> {
  const looksLoaded = (html: string) => /<td[^>]*>[\s\S]*?20\d{2}\s*[-/.年]\s*\d{1,2}/.test(html) || /暂无|没有.*考试|无考试安排/.test(html);
  let studentId: string | undefined;
  try { studentId = (await readStudentId(reader)).studentId; } catch (e) { if (e instanceof NeedLoginError) throw e; }
  let html = (await reader.getText(studentId ? `${EXAM_URL}/info/${studentId}` : EXAM_URL)).text;
  if (studentId && !looksLoaded(html)) html = (await reader.getText(EXAM_URL)).text;
  if (!looksLoaded(html) && reader.render) html = await reader.render(EXAM_URL, looksLoaded);
  const now = opts.now ?? Date.now();
  return parseExamPage(html)
    .filter((e) => opts.all || Date.parse(e.endsAt ?? e.startsAt) > now - 30 * 86_400_000)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}
