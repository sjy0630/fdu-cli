import { describe, expect, it } from 'vitest';
import { parseExamPage, parsePostgradTable, parseSemesterPage, parseUndergradTable, periodTime } from '../src/services/timetable';
import { readExams, readSemesters, readTimetable } from '../src/services/jw';
import type { CampusReader } from '../src/core/types';
import { parseCardBalance, parseLibrary } from '../src/services/campus-life';
import { NeedLoginError } from '../src/core/fudan-auth';

/** 教务系统返回格式的小样例（字段名按学校接口，内容虚构） */
const semesterPage = `<html><body><select id="allSemesters"><option value="501">2025-2026学年2学期</option><option value="521" selected>2026-2027学年1学期</option></select>
<script>var semesters = JSON.parse('[{\\x22id\\x22:521,\\x22name\\x22:\\x222026-2027学年1学期\\x22,\\x22startDate\\x22:\\x222026-08-30\\x22},{\\x22id\\x22:501,\\x22name\\x22:\\x222025-2026学年2学期\\x22,\\x22startDate\\x22:\\x222026-02-15\\x22}]');</script></body></html>`;
const printData = JSON.stringify({ studentTableVms: [{ activities: [
  { courseName: '数据结构', teachers: ['张老师'], room: 'H2215', weekday: 1, startUnit: 6, endUnit: 7, weekIndexes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] },
  { courseName: '数据结构', teachers: ['张老师'], room: 'H2215', weekday: 4, startUnit: 3, endUnit: 4, weekIndexes: [2, 4, 6, 8, 10, 12, 14, 16] },
  { courseName: '体育（羽毛球）', teachers: ['李老师'], room: '正大体育馆', weekday: 3, startUnit: 11, endUnit: 12, weekIndexes: [1, 2, 3] },
  { courseName: '坏数据', weekday: 9, startUnit: 1, endUnit: 2 },
] }] });

describe('课表解析', () => {
  it('本科：学期列表和当前学期', () => {
    const r = parseSemesterPage(semesterPage);
    expect(r.currentId).toBe('521');
    expect(r.semesters[0]).toEqual({ id: '521', name: '2026-2027学年1学期', startDate: '2026-08-30' });
  });

  it('本科：print-data，跳过格式不对的行', () => {
    const rows = parseUndergradTable(printData);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ course: '数据结构', weekday: 4, startPeriod: 3, endPeriod: 4, location: 'H2215', weeks: [2, 4, 6, 8, 10, 12, 14, 16] });
  });

  it('研究生：周次位串，相邻节次合并', () => {
    const body = JSON.stringify({ results: [
      { KCMC: '机器学习', XQ: '2', KSJCDM: '6', JSJCDM: '6', ZCBH: '1111000000000000', JASMC: 'H3108', JSXM: '王老师' },
      { KCMC: '机器学习', XQ: '2', KSJCDM: '7', JSJCDM: '7', ZCBH: '1111000000000000', JASMC: 'H3108', JSXM: '王老师' },
    ] });
    expect(parsePostgradTable(body)).toEqual([{ course: '机器学习', weekday: 2, startPeriod: 6, endPeriod: 7, weeks: [1, 2, 3, 4], teachers: ['王老师'], location: 'H3108' }]);
  });

  it('节次换算成时间', () => {
    expect(periodTime(1, 2)).toEqual({ start: '08:00', end: '09:40' });
    expect(periodTime(6, 7)).toEqual({ start: '13:30', end: '15:10' });
    expect(periodTime(11, 13)).toEqual({ start: '18:30', end: '21:05' });
  });

  it('格式不对时给出能看懂的错误', () => {
    expect(() => parseSemesterPage('<html>登录</html>')).toThrow('课表格式');
    expect(() => parseUndergradTable('{}')).toThrow('课表格式');
  });
});

describe('考试安排', () => {
  it('表格解析', () => {
    const html = `<table><tr><th>课程</th><th>时间</th><th>考场</th></tr>
      <tr><td>1</td><td>数据结构</td><td>COMP130004.01</td><td>2027-01-05 08:30~10:30</td><td>HGX 205</td><td>闭卷</td></tr>
      <tr><td>2</td><td>线性代数</td><td>2027年1月8日</td><td>13:00-15:00</td><td>H3109 教室</td></tr></table>`;
    const exams = parseExamPage(html);
    expect(exams).toHaveLength(2);
    expect(exams[0]).toMatchObject({ course: '数据结构', startsAt: '2027-01-05T00:30:00.000Z', endsAt: '2027-01-05T02:30:00.000Z', location: 'HGX 205' });
    expect(exams[1]).toMatchObject({ course: '线性代数', location: 'H3109 教室' });
  });
});

describe('图书馆和校园卡', () => {
  it('图书馆接口', () => {
    const body = JSON.stringify({ msg: 'SUCCESS', code: '1', data: [{ campusId: '1', campusName: '文科馆', inNum: '452', canInNumb: '748', libraryOpenTime: '8:00~22:00' }, { campusName: '理科馆', inNum: null, canInNumb: '619' }] });
    expect(parseLibrary(body)).toEqual([
      { name: '文科馆', inside: 452, remaining: 748, openTime: '8:00~22:00' },
      { name: '理科馆', inside: null, remaining: 619, openTime: undefined },
    ]);
    expect(() => parseLibrary(JSON.stringify({ code: '0' }))).toThrow('暂时查不到');
  });

  it('校园卡余额', () => {
    expect(parseCardBalance('<div class="custname">某同学</div><div class="payway-box-bottom-item"><p>¥ 1,023.50</p></div>')).toBe(1023.5);
    expect(() => parseCardBalance('<html>登录</html>')).toThrow('余额');
  });
});

describe('教务：课表、学期、考试（fdu-cli）', () => {
  const TABLE = 'https://fdjwgl.fudan.edu.cn/student/for-std/course-table';
  const reader = (pages: Record<string, string>, render?: CampusReader['render']): CampusReader => ({
    getText: async (url) => {
      const text = pages[url.split('?')[0]];
      if (text === undefined) throw new NeedLoginError('jwfw');
      return { url, status: 200, text };
    },
    render,
  });
  const pages = { [TABLE]: semesterPage, [`${TABLE}/semester/521/print-data`]: printData };

  it('当前学期课表：按课程合并上课时间，换算成钟点', async () => {
    const r = await readTimetable(reader(pages));
    expect(r.semester).toMatchObject({ id: '521', name: '2026-2027学年1学期' });
    const ds = r.courses.find((c) => c.course === '数据结构')!;
    expect(ds.teachers).toEqual(['张老师']);
    expect(ds.sessions.map((s) => s.weekday)).toEqual([1, 4]);
    expect(r.courses.find((c) => c.course === '体育（羽毛球）')!.sessions[0]).toMatchObject({ weekday: 3, periods: '11-12', start: '18:30', end: '20:10', location: '正大体育馆' });
  });

  it('按学期名找学期；找不到时说明怎么查', async () => {
    await expect(readTimetable(reader(pages), { semester: '2030' })).rejects.toThrow('fdu jw semesters');
    expect((await readSemesters(reader(pages))).currentId).toBe('521');
  });

  it('第一次停在单点登录跳转页时再读一次；被带到登录页时要求重新登录', async () => {
    let first = true;
    const r = await readTimetable({ getText: async (url) => {
      if (url.endsWith('/course-table') && first) { first = false; return { url, status: 200, text: '<html>正在跳转…</html>' }; }
      return { url, status: 200, text: url.endsWith('/course-table') ? semesterPage : printData };
    } });
    expect(r.courses).toHaveLength(2);
    await expect(readSemesters({ getText: async () => ({ url: 'https://id.fudan.edu.cn/idp/authCenter/authenticate', status: 200, text: '<html>统一身份认证</html>' }) })).rejects.toBeInstanceOf(NeedLoginError);
  });

  it('研究生读研究生选课系统', async () => {
    const r = await readTimetable(reader({ 'https://yjsxk.fudan.edu.cn/yjsxkapp/sys/xsxkappfudan/xsxkCourse/loadKbxx.do': JSON.stringify({ results: [{ KCMC: '机器学习', XQ: 2, KSJCDM: 6, JSJCDM: 7, ZCBH: '11', JASMC: 'H3108' }] }) }), { postgraduate: true });
    expect(r).toMatchObject({ kind: 'postgraduate' });
    expect(r.courses[0]).toMatchObject({ course: '机器学习' });
  });

  it('考试：数据页没内容时用浏览器渲染；一个月前考完的默认不列', async () => {
    const examHtml = `<table><tr><th>课程</th><th>时间</th><th>地点</th></tr>
      <tr><td>数据结构</td><td>2027-01-05 08:30~10:30</td><td>H2215</td></tr>
      <tr><td>线性代数</td><td>2026-06-20 13:00~15:00</td><td>H3109</td></tr></table>`;
    const rendered: string[] = [];
    const r = reader({ ...pages, 'https://fdjwgl.fudan.edu.cn/student/for-std/exam-arrange/info/9001': '<div id="app"></div>', 'https://fdjwgl.fudan.edu.cn/student/for-std/exam-arrange': '<div id="app"></div>' },
      async (url) => { rendered.push(url); return examHtml; });
    const withId = { ...r, getText: async (url: string) => url.endsWith('/print-data') ? { url, status: 200, text: JSON.stringify({ studentTableVms: [{ id: 9001, activities: [] }] }) } : r.getText(url) };
    const exams = await readExams(withId, { now: Date.parse('2026-11-07T00:00:00Z') });
    expect(rendered).toEqual(['https://fdjwgl.fudan.edu.cn/student/for-std/exam-arrange']);
    expect(exams.map((e) => e.course)).toEqual(['数据结构']);
    expect((await readExams(withId, { all: true, now: Date.parse('2026-11-07T00:00:00Z') })).map((e) => e.course)).toEqual(['线性代数', '数据结构']);
  });
});
