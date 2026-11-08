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
