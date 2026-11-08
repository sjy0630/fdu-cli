import { load } from 'cheerio';
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

// ---------------- 全校开课查询 ----------------

const LESSON_SEARCH = 'https://fdjwgl.fudan.edu.cn/student/for-std/lesson-search';

export interface Lesson {
  /** 教学班的内部 id（查教学大纲用） */
  id?: string;
  /** 教学班代码，如 COMP130004.01 */
  code: string;
  course: string;
  courseCode?: string;
  credits?: number;
  teachers: string[];
  /** 上课时间、地点、教师（教务系统原文） */
  schedule?: string;
  department?: string;
  /** 限选人数 / 已选人数 */
  limit?: number;
  selected?: number;
  examMode?: string;
  language?: string;
  courseType?: string;
}

type Named = { nameZh?: unknown } | null | undefined;
const nameOf = (x: Named) => (x && typeof x.nameZh === 'string' && x.nameZh.trim() ? x.nameZh.trim() : undefined);
const numOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function parseLessons(body: string): { lessons: Lesson[]; page: number; pages: number; total: number } {
  let j: { data?: unknown[]; _page_?: { currentPage?: unknown; totalPages?: unknown; totalRows?: unknown } };
  try { j = JSON.parse(body); } catch { throw new TimetableFormatError('全校开课查询返回的格式和预期不同，学校页面可能更新了。'); }
  const rows = (Array.isArray(j.data) ? j.data : []) as Record<string, unknown>[];
  const lessons = rows.map((r): Lesson => {
    const course = (r.course ?? {}) as { code?: unknown; nameZh?: unknown; credits?: unknown };
    const teachers = ((r.teacherAssignmentList ?? []) as { person?: Named }[]).map((t) => nameOf(t.person)).filter((x): x is string => !!x);
    const schedule = ((r.scheduleText as { dateTimePlacePersonText?: { textZh?: unknown } } | undefined)?.dateTimePlacePersonText?.textZh);
    return {
      ...(r.id !== undefined && r.id !== null ? { id: String(r.id) } : {}),
      code: String(r.code ?? ''),
      course: nameOf(course as Named) ?? nameOf(r as Named) ?? '',
      ...(typeof course.code === 'string' ? { courseCode: course.code } : {}),
      ...(numOf(course.credits) !== undefined ? { credits: numOf(course.credits) } : {}),
      teachers: [...new Set(teachers)],
      ...(typeof schedule === 'string' && schedule.trim() ? { schedule: schedule.replace(/\s+/g, ' ').trim() } : {}),
      ...(nameOf(r.openDepartment as Named) ? { department: nameOf(r.openDepartment as Named) } : {}),
      ...(numOf(r.limitCount) !== undefined ? { limit: numOf(r.limitCount) } : {}),
      ...(numOf(r.stdCount) !== undefined ? { selected: numOf(r.stdCount) } : {}),
      ...(nameOf(r.examMode as Named) ? { examMode: nameOf(r.examMode as Named) } : {}),
      ...(nameOf(r.teachLang as Named) ? { language: nameOf(r.teachLang as Named) } : {}),
      ...(nameOf(r.courseType as Named) ? { courseType: nameOf(r.courseType as Named) } : {}),
    };
  });
  const p = j._page_ ?? {};
  return { lessons, page: Number(p.currentPage ?? 1) || 1, pages: Number(p.totalPages ?? 1) || 1, total: Number(p.totalRows ?? lessons.length) || lessons.length };
}

/** 全校开课查询：按课程名搜索某学期开的课（默认当前学期） */
export async function readLessons(reader: CampusReader, opts: { keyword: string; semester?: string; page?: number; size?: number }) {
  const { semesters, currentId } = await readSemesters(reader);
  const want = opts.semester?.trim();
  const semester = want ? semesters.find((s) => s.id === want) ?? semesters.find((s) => s.name.includes(want)) : semesters.find((s) => s.id === currentId) ?? semesters[0];
  if (!semester) throw Object.assign(new Error(`没有找到学期「${want}」，用 fdu jw semesters 查看学期列表。`), { code: 'NOT_FOUND' });
  const { studentId } = await readStudentId(reader);
  const qs = new URLSearchParams({ queryPage__: `${opts.page ?? 1},${opts.size ?? 20}`, courseNameZhLike: opts.keyword });
  const res = await reader.getText(`${LESSON_SEARCH}/semester/${semester.id}/search/${studentId}?${qs}`, { headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' } });
  if (res.status >= 400) throw new Error(`教务系统返回 ${res.status}`);
  return { semester: semester.name, keyword: opts.keyword, ...parseLessons(res.text) };
}

// ---------------- 教学大纲 ----------------

/** 网页 → 纯文本：去掉脚本和样式，段落、表格行换行，单元格之间用「 | 」隔开 */
export function htmlToText(html: string): string {
  const $ = load(html);
  $('script, style, noscript, head, nav, header, footer').remove();
  $('br').replaceWith('\n');
  $('td, th').each((_, el) => { $(el).append(' | '); });
  $('p, div, tr, li, h1, h2, h3, h4, h5, h6, table, section').each((_, el) => { $(el).append('\n'); });
  return $.root().text()
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\| ?(\n|$)/g, '$1')
    .replace(/\n\s*\n+/g, '\n')
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

/**
 * 某个教学班的教学大纲（全校开课查询里「教学大纲」那一页），转成纯文本给 AI 读。
 * 页面内容靠脚本加载时，在无界面浏览器里等加载完再读。
 */
export async function readSyllabus(reader: CampusReader, lessonId: string, maxChars = 30_000) {
  if (!/^\d+$/.test(lessonId)) throw Object.assign(new Error('教学班 id 应该是数字（来自 fdu jw lessons 的 id）。'), { code: 'BAD_ARGS' });
  const xhr = { headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' } };
  // 教务系统先问一下这门课能不能看大纲；返回的提示原样附上
  let notice: string | undefined;
  try {
    const c = await reader.getText(`${LESSON_SEARCH}/check-can-info?id=${lessonId}`, xhr);
    const j = JSON.parse(c.text) as { textZh?: unknown } | null;
    if (j && typeof j.textZh === 'string' && j.textZh.trim()) notice = j.textZh.trim();
  } catch { /* 读不到不影响 */ }
  const url = `${LESSON_SEARCH}/teachingSyllabusInfo/${lessonId}`;
  const page = await reader.getText(url);
  if (page.status >= 400) throw new Error(`教务系统返回 ${page.status}`);
  let text = htmlToText(page.text);
  if (text.length < 120 && reader.render) text = htmlToText(await reader.render(url, (h) => htmlToText(h).length >= 200));
  return {
    lessonId,
    ...(notice ? { notice } : {}),
    available: text.length >= 40,
    ...(text.length > maxChars ? { truncated: true } : {}),
    text: text.slice(0, maxChars),
  };
}
