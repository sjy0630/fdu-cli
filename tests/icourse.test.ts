import { afterEach, describe, expect, it, vi } from 'vitest';
import { findOp, transcriptText, type Ctx } from '../src/ops';
import { runOp } from '../src/run';
import { clock, ICOURSE, IcourseClient, type IcourseDeps, type RawResponse } from '../src/services/icourse';
import { toWebvpnUrl } from '../src/services/webvpn';

/** iCourse 课程回放（接口字段按真实平台，课程、讲次、文字稿内容都是虚构的） */

const json = (data: unknown, url = ''): RawResponse => ({ status: 200, url, contentType: 'application/json', text: JSON.stringify(data) });
const html = (text: string, url = ''): RawResponse => ({ status: 200, url, contentType: 'text/html', text });

/** 按接口路径返回数据的假 iCourse；loggedIn 控制身份接口 */
function fakeIcourse(opts: { reachable?: boolean; loggedIn?: { value: boolean }; gate?: boolean } = {}) {
  const loggedIn = opts.loggedIn ?? { value: true };
  const calls: string[] = [];
  const routes: Record<string, () => RawResponse> = {
    '/userapi/v1/infosimple': () => json(loggedIn.value ? { code: 0, params: { id: 1 } } : { code: 401, msg: '未登录' }),
    '/portal/courseapi/v3/multi-search/get-course-list': () => json({ code: 0, data: { total: 2, list: [
      { id: 101, title: '数据结构', realname: '张老师', kkxy_name: '计算机学院', term_name: '2026-2027秋' },
      { id: 102, title: '数据结构实验', realname: '李老师', term_name: '2026-2027秋' },
    ] } }),
    '/courseapi/v3/multi-search/get-course-detail': () => json({ code: 0, data: { title: '数据结构', realname: '张老师', sub_list: {
      2026: { 9: { 7: [{ id: 9001, sub_title: '2026-09-07第6-7节', lecturer_name: '张老师', playback_status: 1 }] }, 11: { 2: [{ id: 9010, sub_title: '2026-11-02第6-7节', lecturer_name: '张老师', playback_status: 0 }] } },
    } } }),
    '/courseapi/v3/portal-home-setting/get-sub-info': () => json(opts.gate ? { code: 7001, msg: '视频未到开放时间', data: {} } : { code: 0, data: {} }),
    '/courseapi/v3/web-socket/search-trans-result': () => json({ code: 0, list: [{ all_content: [
      { BeginSec: 0, EndSec: 5, Text: '同学们好，' }, { BeginSec: 5, EndSec: 30, Text: '今天讲二叉树。' },
      { BeginSec: 65, EndSec: 80, Text: '先看遍历。' }, { BeginSec: 80, EndSec: 81, Text: ' ' },
    ] }] }),
  };
  const deps: IcourseDeps = {
    fetch: async (url) => {
      calls.push(url);
      const webvpn = url.startsWith('https://webvpn.fudan.edu.cn/');
      if (!webvpn && !opts.reachable) throw new Error('getaddrinfo ENOTFOUND icourse.fudan.edu.cn');
      for (const [path, handler] of Object.entries(routes)) {
        const target = webvpn ? toWebvpnUrl(`${ICOURSE}${path}`) : `${ICOURSE}${path}`;
        if (url.split('?')[0] === target) return handler();
      }
      return html('<html>404</html>', url);
    },
    ensureWebvpn: vi.fn(async () => undefined),
    openInBrowser: vi.fn(async (_url: string, done: (u: string) => boolean) => { loggedIn.value = true; expect(done('https://icourse.fudan.edu.cn/home')).toBe(true); }),
  };
  return { deps, calls, loggedIn };
}

describe('iCourse 客户端', () => {
  it('校园网内直连；没登录 iCourse 时在无界面浏览器里自动走统一身份认证', async () => {
    const f = fakeIcourse({ reachable: true, loggedIn: { value: false } });
    const r = await new IcourseClient(f.deps).search('数据结构', { term: '30' });
    expect(f.deps.openInBrowser).toHaveBeenCalledWith(expect.stringContaining('/casapi/index.php?r=auth/login'), expect.any(Function));
    expect(f.deps.ensureWebvpn).not.toHaveBeenCalled();
    expect(r.courses.map((c) => c.courseId)).toEqual(['101', '102']);
    expect(r.courses[0]).toMatchObject({ title: '数据结构', teacher: '张老师', department: '计算机学院' });
    expect(f.calls.some((u) => u.includes('tenant=222') && u.includes('title='))).toBe(true);
  });

  it('校外直连不通时走 WebVPN', async () => {
    const f = fakeIcourse({ reachable: false });
    const r = await new IcourseClient(f.deps).lectures('101');
    expect(f.deps.ensureWebvpn).toHaveBeenCalled();
    expect(f.calls.at(-1)).toContain('webvpn.fudan.edu.cn');
    expect(r.lectures).toEqual([
      { lectureId: '9001', title: '2026-09-07第6-7节', date: '2026-09-07', lecturer: '张老师', hasPlayback: true },
      { lectureId: '9010', title: '2026-11-02第6-7节', date: '2026-11-02', lecturer: '张老师', hasPlayback: false },
    ]);
  });

  it('登录不上时要求先 fdu login', async () => {
    const f = fakeIcourse({ reachable: true, loggedIn: { value: false } });
    f.deps.openInBrowser = async () => undefined; // 浏览器里也没登录成功
    await expect(new IcourseClient(f.deps).lectures('101')).rejects.toMatchObject({ code: 'NEED_LOGIN', hint: expect.stringContaining('fdu login') });
  });

  it('文字稿：按时间排序，去掉空段', async () => {
    const f = fakeIcourse({ reachable: true });
    const { segments } = await new IcourseClient(f.deps).transcript('101', '9001');
    expect(segments.map((s) => s.text)).toEqual(['同学们好，', '今天讲二叉树。', '先看遍历。']);
  });

  it('审核期内的回放如实说明还没开放，不去读文字稿', async () => {
    const f = fakeIcourse({ reachable: true, gate: true });
    await expect(new IcourseClient(f.deps).transcript('101', '9010')).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('视频未到开放时间') });
    expect(f.calls.some((u) => u.includes('search-trans-result'))).toBe(false);
  });

  it('课程号、讲次号必须是数字', async () => {
    const f = fakeIcourse({ reachable: true });
    await expect(new IcourseClient(f.deps).lectures('../x')).rejects.toMatchObject({ code: 'BAD_ARGS' });
  });
});

describe('文字稿输出', () => {
  afterEach(() => vi.restoreAllMocks());

  it('每分钟一段，开头标时间', () => {
    expect(clock(65)).toBe('01:05');
    expect(clock(3725)).toBe('1:02:05');
    expect(transcriptText([{ start: 0, end: 5, text: '同学们好，' }, { start: 5, end: 30, text: '今天讲二叉树。' }, { start: 65, end: 80, text: '先看遍历。' }]))
      .toBe('[00:00] 同学们好，今天讲二叉树。\n[01:05] 先看遍历。');
  });

  it('长文字稿分段读取：返回 nextOffset，接着读能拼回全文', async () => {
    const segments = Array.from({ length: 300 }, (_, i) => ({ start: i * 20, end: i * 20 + 19, text: `第${i}句讲解内容。` }));
    vi.spyOn(IcourseClient.prototype, 'transcript').mockResolvedValue({ segments });
    const ctx = { session: { hasState: () => true }, now: () => 0 } as unknown as Ctx;
    const op = findOp('icourse.transcript')!;
    const first = await runOp(op, ctx, { course: '101', lecture: '9001', maxChars: '1000' });
    expect(first).toMatchObject({ ok: true, data: { offset: 0, nextOffset: 1000 } });
    const data = (first as { data: { text: string; totalChars: number } }).data;
    const second = await runOp(op, ctx, { course: '101', lecture: '9001', maxChars: '1000', offset: '1000' });
    expect((second as { data: { text: string } }).data.text.startsWith(transcriptText(segments).slice(1000, 1010))).toBe(true);
    expect(data.text.length).toBe(1000);
    const seg = await runOp(op, ctx, { course: '101', lecture: '9001', format: 'segments', maxChars: '1000' });
    expect(seg).toMatchObject({ ok: true, data: { segments: expect.any(Array), nextOffset: expect.any(Number) } });
  });

  it('没登录复旦账号时直接要求登录', async () => {
    const ctx = { session: { hasState: () => false }, now: () => 0 } as unknown as Ctx;
    expect(await runOp(findOp('icourse.lectures')!, ctx, { course: '101' })).toMatchObject({ ok: false, error: { code: 'NEED_LOGIN' } });
  });
});
