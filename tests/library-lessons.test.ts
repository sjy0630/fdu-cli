import type { Ctx } from '../src/ops';
import { describe, expect, it } from 'vitest';
import { NeedLoginError } from '../src/core/fudan-auth';
import type { CampusReader } from '../src/core/types';
import { findLibraryToken } from '../src/ops';
import { libDate, LIB_API, parseCurrentLoans, parseHistory, parseReader, readLoans } from '../src/services/library-account';
import { parseLessons, readLessons } from '../src/services/jw';

/** 图书馆借阅、全校开课查询（字段名按学校接口，书名、课程、老师都是虚构的） */

const loan = (title: string, due: string, renewed = 0) => ({
  circulationLoanPolicy: { renewalCount: 2, name: '本科生' },
  itemInfo: {
    item: { callNo: 'TP311/123', permanentLibraryName: '理科馆', permanentLocationName: '理科馆三楼借阅区', barcode: '0000000000001', renewCount: renewed },
    instance: { title, author: '某作者（虚构）', callNo: 'TP311/123', ISBN: '978-7-000-00000-0' },
  },
  loanLog: { loanDate: '2026-10-20 10:00:00', dueDate: due, renewalCount: renewed },
});

describe('图书馆借阅', () => {
  it('在借的书：应还日期、还剩几天、是否逾期，按应还日期排序', () => {
    const loans = parseCurrentLoans({ code: 0, data: { list: [loan('算法导论（演示）', '2026-11-20 23:59:59'), loan('线性代数（演示）', '2026-11-05', 1)] } }, '2026-11-08');
    expect(loans.map((l) => l.title)).toEqual(['线性代数（演示）', '算法导论（演示）']);
    expect(loans[0]).toMatchObject({ dueDate: '2026-11-05', daysLeft: -3, overdue: true, renewed: 1, renewMax: 2, location: '理科馆三楼借阅区' });
    expect(loans[1]).toMatchObject({ loanDate: '2026-10-20', dueDate: '2026-11-20', daysLeft: 12, overdue: false });
    expect(libDate('20261120')).toBe('2026-11-20');
  });

  it('读者信息只取借阅相关的数，不返回姓名、证号、邮箱', () => {
    const r = parseReader({ code: 0, data: { name: '张小明', barcode: '22307130001', email: 'x@m.fudan.edu.cn', canLoanTotal: 28, overdueTotal: 1, fees: 0, currentRequestCount: 0, expirationDate: '20300701' } });
    expect(r).toEqual({ canBorrow: 28, overdue: 1, fees: 0, holds: 0, cardExpires: '2030-07-01' });
    expect(JSON.stringify(r)).not.toMatch(/张小明|22307130001|m\.fudan/);
  });

  it('借阅历史', () => {
    const h = parseHistory({ code: 0, data: { total: 23, list: [{ catalogueInstance: { title: '概率论（演示）', author: '某作者' }, loanDate: '2026-03-01', returnDate: null }] } });
    expect(h).toEqual({ total: 23, loans: [{ title: '概率论（演示）', author: '某作者', loanDate: '2026-03-01' }] });
  });

  it('令牌失效时要求重新登录图书馆；只发查询请求', async () => {
    const urls: string[] = [];
    const ok = await readLoans(async (u) => {
      urls.push(u);
      return { status: 200, text: JSON.stringify(u.includes('getReaderInfo') ? { code: 0, data: { canLoanTotal: 30 } } : { code: 0, data: { list: [loan('算法导论（演示）', '2026-11-12')] } }) };
    }, '2026-11-08');
    expect(ok).toMatchObject({ canBorrow: 30, count: 1, dueSoon: 1 });
    expect(urls.every((u) => u.startsWith(LIB_API) && !/renew/i.test(u))).toBe(true);
    await expect(readLoans(async () => ({ status: 401, text: '' }), '2026-11-08')).rejects.toMatchObject({ code: 'NEED_LOGIN', hint: expect.stringContaining('fdu library login') });
    await expect(readLoans(async () => ({ status: 200, text: JSON.stringify({ code: 401, msg: 'token 已过期' }) }), '2026-11-08')).rejects.toMatchObject({ code: 'NEED_LOGIN' });
  });

  it('在浏览器存储里找令牌：字符串或 JSON 里的 access_token', () => {
    expect(findLibraryToken([['theme', 'dark'], ['access_token', 'abcdefghij0123456789abcdefghij']])).toBe('abcdefghij0123456789abcdefghij');
    expect(findLibraryToken([['user-store', JSON.stringify({ state: { auth: { accessToken: 'tok_0123456789abcdefghijklmn' } } })]])).toBe('tok_0123456789abcdefghijklmn');
    expect(findLibraryToken([['lang', 'zh'], ['tokenless', 'x']])).toBeUndefined();
  });
});

describe('全校开课查询', () => {
  const row = { code: 'COMP130004.01', course: { code: 'COMP130004', nameZh: '数据结构（演示）', credits: 3 }, teacherAssignmentList: [{ role: 'MAJOR', person: { nameZh: '张老师' } }, { role: 'ASSIST', person: { nameZh: '张老师' } }],
    scheduleText: { dateTimePlacePersonText: { textZh: '1-16周 星期一 6-7 H2215 张老师\n' } }, openDepartment: { nameZh: '计算机学院' }, limitCount: 120, stdCount: 98,
    examMode: { nameZh: '闭卷' }, teachLang: { nameZh: '中文' }, courseType: { nameZh: '专业必修课' } };

  it('解析：教学班、学分、老师去重、上课时间地点、名额', () => {
    const r = parseLessons(JSON.stringify({ data: [row], _page_: { currentPage: 1, totalPages: 3, totalRows: 45 } }));
    expect(r).toMatchObject({ page: 1, pages: 3, total: 45 });
    expect(r.lessons[0]).toEqual({ code: 'COMP130004.01', course: '数据结构（演示）', courseCode: 'COMP130004', credits: 3, teachers: ['张老师'], schedule: '1-16周 星期一 6-7 H2215 张老师', department: '计算机学院', limit: 120, selected: 98, examMode: '闭卷', language: '中文', courseType: '专业必修课' });
  });

  it('按当前学期和学生编号拼地址，带上关键词和翻页', async () => {
    const urls: string[] = [];
    const semesterPage = `<select id="allSemesters"><option value="527" selected>2026-2027学年1学期</option></select><script>var semesters = JSON.parse('[{"id":527,"name":"2026-2027学年1学期"}]');</script>`;
    const reader: CampusReader = {
      getText: async (url) => {
        urls.push(url);
        if (url.endsWith('/course-table')) return { url, status: 200, text: semesterPage };
        if (url.endsWith('/print-data')) return { url, status: 200, text: JSON.stringify({ studentTableVms: [{ id: 9001, activities: [] }] }) };
        if (url.includes('/lesson-search/')) return { url, status: 200, text: JSON.stringify({ data: [row], _page_: { currentPage: 2, totalPages: 3, totalRows: 45 } }) };
        throw new NeedLoginError('jwfw');
      },
    };
    const r = await readLessons(reader, { keyword: '数据结构', page: 2 });
    const u = new URL(urls.find((x) => x.includes('/lesson-search/'))!);
    expect(u.pathname).toBe('/student/for-std/lesson-search/semester/527/search/9001');
    expect(Object.fromEntries(u.searchParams)).toEqual({ queryPage__: '2,20', courseNameZhLike: '数据结构' });
    expect(r).toMatchObject({ semester: '2026-2027学年1学期', keyword: '数据结构', page: 2 });
  });
});

describe('教学大纲', () => {
  it('网页转纯文本：段落换行，表格单元格用 | 隔开，去掉脚本', async () => {
    const { htmlToText } = await import('../src/services/jw');
    const t = htmlToText('<html><head><title>x</title><script>var a=1</script></head><body><h3>课程目标</h3><p>掌握线性表、树、图。</p><table><tr><th>周次</th><th>内容</th></tr><tr><td>1</td><td>绪论</td></tr></table></body></html>');
    expect(t).toBe('课程目标\n掌握线性表、树、图。\n周次 | 内容\n1 | 绪论');
  });

  it('先问能不能看并附上提示；页面靠脚本加载时用浏览器读', async () => {
    const { readSyllabus } = await import('../src/services/jw');
    const rendered: string[] = [];
    const reader: CampusReader = {
      getText: async (url) => {
        if (url.includes('check-can-info')) return { url, status: 200, text: JSON.stringify({ textZh: '教学大纲由任课教师提供（演示）' }) };
        return { url, status: 200, text: '<html><body><div id="app"></div></body></html>' };
      },
      render: async (url) => { rendered.push(url); return `<div><h3>考核方式</h3><p>${'平时作业 40%，期末考试 60%。'.repeat(10)}</p></div>`; },
    };
    const r = await readSyllabus(reader, '1037803');
    expect(rendered).toEqual(['https://fdjwgl.fudan.edu.cn/student/for-std/lesson-search/teachingSyllabusInfo/1037803']);
    expect(r).toMatchObject({ lessonId: '1037803', notice: '教学大纲由任课教师提供（演示）', available: true });
    expect((r as { text: string }).text.startsWith('考核方式\n平时作业 40%')).toBe(true);
    await expect(readSyllabus(reader, '../x')).rejects.toThrow('数字');
  });

  it('开课查询结果带上教学班 id', () => {
    const r = parseLessons(JSON.stringify({ data: [{ id: 1037803, code: 'X.01', course: { nameZh: '课' } }], _page_: {} }));
    expect(r.lessons[0].id).toBe('1037803');
  });
});

describe('图书馆令牌', () => {
  it('登录时保存的令牌直接带在请求头里；过期或被拒时删掉并要求重新登录', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { Store } = await import('../src/core/store');
    const { findOp } = await import('../src/ops');
    const { runOp } = await import('../src/run');
    process.env.FDU_HOME = mkdtempSync(join(tmpdir(), 'fdu-lib-'));
    const store = new Store();
    store.writeJson('library.json', { token: 'tok-demo-0123456789abcdef' });
    const seen: Record<string, string>[] = [];
    const ctx = {
      store, now: () => Date.parse('2026-11-08T04:00:00Z'), log: () => undefined,
      session: {
        hasState: () => true,
        raw: async (url: string, init: { headers: Record<string, string> }) => {
          seen.push(init.headers);
          const body = url.includes('getReaderInfo') ? { code: 0, data: { canLoanTotal: 30, name: '张小明' } } : { code: 0, data: { list: [] } };
          return { status: 200, url, contentType: 'application/json', text: JSON.stringify(body) };
        },
      },
    } as unknown as Ctx;
    const op = findOp('library.loans')!;
    expect(await runOp(op, ctx, {})).toMatchObject({ ok: true, data: { canBorrow: 30, count: 0 } });
    expect(seen[0].access_token).toBe('tok-demo-0123456789abcdef');
    (ctx.session as unknown as { raw: unknown }).raw = async (url: string) => ({ status: 401, url, contentType: 'application/json', text: '{}' });
    expect(await runOp(op, ctx, {})).toMatchObject({ ok: false, error: { code: 'NEED_LOGIN', hint: expect.stringContaining('fdu library login') } });
    expect(store.readJson('library.json')).toBeNull();
    store.writeJson('library.json', { token: 't', expiresAt: '2026-11-01T00:00:00Z' });
    expect(await runOp(op, ctx, {})).toMatchObject({ ok: false, error: { code: 'NEED_LOGIN' } });
  });
});

describe('教学大纲页面里的数据', () => {
  const u = (t: string) => [...t].map((c) => (c.charCodeAt(0) > 127 ? `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}` : c)).join('');
  const page = `<html><body><h3>大纲详细信息</h3><script>
    $(function () {
      let model =  {'structuredDocument':{'paragraphs':[
        {'titleZh':'${u('课程简介（中文）')}','contentZh':'<p>${u('数据结构是计算机专业的基础课（演示）。')}<\\/p>','contentEn':null},
        {'titleZh':'${u('教学内容与进度安排')}','contentZh':'<table border=\\"1\\"><tr><td><p>${u('第1周')}<\\/p><\\/td><td>${u('线性表')}<\\/td><\\/tr><tr><td>${u('第2周')}<\\/td><td>${u('栈和队列')}<\\/td><\\/tr><\\/table>'},
        {'titleZh':'${u('教材')}','contentZh':''}]},'id':1};
      let course =  {'code':'COMP130004','nameZh':'${u('数据结构（演示）')}','credits':3.0,'totalPeriods':54.0,'preCourses':''};
      let examGradeList = [{'criteria':'${u('期中考试')}','percentage':30.0,'standard':'${u('卷面分')}'},{'criteria':'${u('期末考试：闭卷')}','percentage':70.0,'standard':null}];
      let memberList = [{'name':'${u('王老师（虚构）')}','title':'${u('副教授')}','department':'${u('演示学院')}','teachingContent':'${u('主讲')}','email':'demo@example.com'}];
      let textbookList = [{'author':'${u('某作者')}','date':'2020-01','isbn':'978','name':'${u('数据结构教程（演示）')}','publishingHouse':'${u('演示出版社')}'}];
      let gradeCalcRule = '${u('等级制')}';
    });</script></body></html>`;

  it('只做字面量解析：基本信息、各段正文（表格按行）、考核和权重、教材、教学团队', async () => {
    const { parseSyllabusPage } = await import('../src/services/jw');
    const r = parseSyllabusPage(page)!;
    expect(r.course).toMatchObject({ code: 'COMP130004', name: '数据结构（演示）', credits: 3, hours: 54 });
    expect(r.sections).toEqual([
      { title: '课程简介（中文）', text: '数据结构是计算机专业的基础课（演示）。' },
      { title: '教学内容与进度安排', text: '第1周 | 线性表\n第2周 | 栈和队列' },
    ]);
    expect(r.assessment).toEqual({ items: [{ item: '期中考试', percent: 30, standard: '卷面分' }, { item: '期末考试：闭卷', percent: 70, standard: undefined }], grading: '等级制' });
    expect(r.textbooks).toEqual([{ title: '数据结构教程（演示）', author: '某作者', publisher: '演示出版社', date: '2020-01' }]);
    expect(r.team[0]).toMatchObject({ name: '王老师（虚构）', title: '副教授', duty: '主讲' });
    expect(parseSyllabusPage('<html>没有数据</html>')).toBeUndefined();
  });

  it('字面量解析不执行代码，转义和嵌套都能处理', async () => {
    const { parseJsLiteral } = await import('../src/services/jw');
    expect(parseJsLiteral("x = {'a':'\\u4E2D\\'b\\\"','b':[1,{'c':null}],'d':true};", 0)).toEqual({ a: "中'b\"", b: [1, { c: null }], d: true });
    expect(parseJsLiteral("let l = [{'x':'}'}];", 0)).toEqual([{ x: '}' }]);
  });
});
