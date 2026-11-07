import { describe, expect, it } from 'vitest';
import { parseGpaRank, parseGradeSheet, readGrades, weightedGpa } from '../src/services/grades';
import type { CampusReader } from '../src/core/types';

/** 成绩与绩点（字段名按教务系统接口，内容虚构） */
const semesterPage = `<select id="allSemesters"><option value="501" selected>2025-2026学年2学期</option></select><script>var semesters = JSON.parse('[{"id":501,"name":"2025-2026学年2学期"},{"id":481,"name":"2025-2026学年1学期"}]');</script>`;
const sheet = (map: Record<string, unknown[]>) => JSON.stringify({ semesterId2studentGrades: map });
const row = (name: string, grade: string, gp: number | null, credits: number) => ({ courseName: name, lessonCode: `${name}.01`, gaGrade: grade, gp, credits, courseModuleTypeName: '专业必修' });

describe('解析', () => {
  it('成绩单和加权绩点（P/NP 不计入）', () => {
    const s = parseGradeSheet(sheet({ 501: [row('数学分析', 'A-', 3.7, 5), row('程序设计', 'A', 4, 3), row('形势与政策', 'P', null, 0.5)] }), new Map([['501', '2025-2026学年2学期']]));
    expect(s[0]).toMatchObject({ id: '501', name: '2025-2026学年2学期' });
    expect(s[0].courses[2]).toMatchObject({ course: '形势与政策', grade: 'P', gp: undefined, credits: 0.5 });
    expect(weightedGpa(s[0].courses)).toEqual({ gpa: 3.81, credits: 8.5 });
    expect(() => parseGradeSheet('<html>登录</html>', new Map())).toThrow('成绩格式');
  });

  it('排名只取本人一条和总人数，其他同学的信息不返回', () => {
    const body = JSON.stringify({ data: [
      { code: '25300000001', name: '同学甲', gpa: 3.9, credit: 50, ranking: 1, major: '计算机', department: '计算与智能创新学院', grade: 2025 },
      { code: '25300000002', name: '我', gpa: 3.6, credit: 48, ranking: 23, major: '计算机', department: '计算与智能创新学院', grade: 2025 },
    ] });
    const me = parseGpaRank(body, '25300000002')!;
    expect(me).toEqual({ gpa: 3.6, credits: 48, ranking: 23, total: 2, major: '计算机', department: '计算与智能创新学院', grade: '2025' });
    expect(JSON.stringify(me)).not.toContain('同学甲');
    expect(parseGpaRank(body, undefined)).toEqual({ total: 2 });
  });
});

describe('读取', () => {
  const reader = (pages: Record<string, string>): CampusReader => ({
    getText: async (url) => {
      const key = Object.keys(pages).find((k) => url === k || url.startsWith(`${k}?`));
      if (!key) throw new Error(`unexpected ${url}`);
      return { url, status: 200, text: pages[key] };
    },
  });
  const base = {
    'https://fdjwgl.fudan.edu.cn/student/for-std/course-table': semesterPage,
    'https://fdjwgl.fudan.edu.cn/student/for-std/course-table/semester/501/print-data': JSON.stringify({ studentTableVms: [{ id: 12345, activities: [] }] }),
  };

  it('一次读全部学期', async () => {
    const r = await readGrades(reader({ ...base, 'https://fdjwgl.fudan.edu.cn/student/for-std/grade/sheet/info/12345': sheet({ 501: [row('数学分析', 'A', 4, 5)], 481: [row('线性代数', 'B+', 3.3, 4)] }) }));
    expect(r.studentId).toBe('12345');
    expect(r.semesters.map((s) => s.name)).toEqual(['2025-2026学年2学期', '2025-2026学年1学期']);
    expect(r.gpa).toBe(3.69);
  });

  it('不带学期读不到时，按学期逐个读', async () => {
    const pages: Record<string, string> = { ...base };
    const r = await readGrades({ getText: async (url) => {
      if (url.includes('/grade/sheet/')) {
        const sem = new URL(url).searchParams.get('semester');
        return { url, status: 200, text: sheet(sem === '501' ? { 501: [row('数学分析', 'A', 4, 5)] } : sem === '481' ? { 481: [] } : {}) };
      }
      return { url, status: 200, text: pages[url] };
    } });
    expect(r.semesters).toHaveLength(1);
    expect(r.gpa).toBe(4);
  });
});

