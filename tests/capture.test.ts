import { describe, expect, it } from 'vitest';
import { dedupe, describeCall, htmlOutline, maskPath, sanitizeHtml, shapeOf } from '../src/services/capture';
import { safeHeaders } from '../src/core/auth';
import { redact } from '../src/core/errors';

/** fdu dev capture：只留接口结构，不留任何具体内容（下面的姓名、学号、金额都是虚构的） */

const SECRETS = ['张小明', '22307130001', '71.49', 'tok-secret', '13800000000', 'H2215'];
const leaks = (x: unknown) => SECRETS.filter((s) => JSON.stringify(x).includes(s));

describe('去掉内容，只留结构', () => {
  it('JSON：字段名和类型；数组只看第一项；日期、数字形式的键收起来', () => {
    const shape = shapeOf({
      code: 0, msg: 'ok', data: { name: '张小明', studentId: '22307130001', balance: 71.49, phone: '13800000000', active: true,
        rooms: [{ room: 'H2215', free: [1, 2] }, { room: 'H3108', free: [] }],
        byDate: { '2026-11-10': { a: 1 }, '2026-11-11': { a: 2 }, '2026-11-12': { a: 3 }, '2026-11-13': { a: 4 } } },
    });
    expect(leaks(shape)).toEqual([]);
    expect(shape).toMatchObject({ code: 'number', data: { name: 'string(3)', studentId: 'string(数字)', balance: 'number', active: 'boolean', rooms: [{ room: 'string(5)', free: ['number', '…共 2 项'] }, '…共 2 项'] } });
    expect((shape as { data: { byDate: Record<string, unknown> } }).data.byDate).toEqual({ '<键为日期或数字>': { a: 'number' }, '…': '共 4 个键' });
  });

  it('网页：只留标题、表格列名、表单字段名，不留格子里的内容和令牌字段', () => {
    const o = htmlOutline(`<html><head><title>空闲教室查询</title></head><body>
      <form action="/room/query?x=1"><input name="building" value="H2"><input name="_csrf" value="tok-secret"><select name="date"></select><input type="password" name="password"></form>
      <table><tr><th>教室</th><th>容量</th></tr><tr><td>H2215</td><td>120</td></tr></table>
      <p>欢迎你，张小明（22307130001）</p></body></html>`);
    expect(o).toEqual({ title: '空闲教室查询', tables: [['教室', '容量']], forms: [{ action: '/room/query', fields: ['building', 'date'] }] });
    expect(leaks(o)).toEqual([]);
  });

  it('请求：地址不带查询值，只留参数名和请求体字段名', async () => {
    const c = await describeCall({
      method: 'POST', url: 'https://example.fudan.edu.cn/api/query?studentId=22307130001&date=2026-11-10', status: 200,
      contentType: 'application/json; charset=utf-8', postData: 'name=%E5%BC%A0%E5%B0%8F%E6%98%8E&_csrf=tok-secret',
      body: async () => JSON.stringify({ total: 1, list: [{ name: '张小明', amount: 71.49 }] }),
    });
    expect(c).toMatchObject({ method: 'POST', endpoint: 'https://example.fudan.edu.cn/api/query', query: ['studentId', 'date'], bodyFields: ['name', '_csrf'], contentType: 'application/json' });
    expect(leaks(c)).toEqual([]);
    expect(await describeCall({ method: 'GET', url: 'https://x.fudan.edu.cn/app.js', status: 200, contentType: 'text/javascript', body: async () => '' })).toBeNull();
  });

  it('XML 包着的网页表格也能认出列名；同一个接口只留一次', async () => {
    const xml = '<?xml version="1.0"?><r><![CDATA[<table><tr><th>时间</th><th>金额</th></tr><tr><td>2026.11.07</td><td>71.49</td></tr></table>]]></r>';
    const c = await describeCall({ method: 'POST', url: 'https://ecard.fudan.edu.cn/q', status: 200, contentType: 'text/xml', body: async () => xml });
    expect(c?.response).toEqual({ title: undefined, tables: [['时间', '金额']], forms: [] });
    const d = dedupe([c!, { ...c!, query: ['page'] }]);
    expect(d).toHaveLength(1);
    expect(d[0].query).toEqual(['page']);
  });
});

describe('第一次实测后补的', () => {
  it('路径里的长数字和编号换成 {id}；不是表单的请求体不记内容', async () => {
    expect(maskPath('/student/for-std/lesson-search/semester/527/search/486752')).toBe('/student/for-std/lesson-search/semester/527/search/{id}');
    expect(maskPath('/item/3f2a9c1e-77aa-4b1c-9d2e-0123456789ab')).toBe('/item/{id}');
    const c = await describeCall({
      method: 'POST', url: 'https://fdjwgl.fudan.edu.cn/student/individual-setting/save-setting', status: 200, contentType: 'application/json',
      postData: '["last-use-menu:null","[{\\"permCode\\":\\"for-std-lesson-search:menu\\",\\"time\\":\\"2026-11-08T05:49:31.943Z\\"}]"]',
      body: async () => '{"success":true}',
    });
    expect(c?.bodyFields).toEqual(['<JSON 数组，已省略>']);
    const log = await describeCall({ method: 'POST', url: 'https://x.fudan.edu.cn/log', status: 200, contentType: 'text/plain', postData: 'c{"type":"common"}\np{"start":1794116941820}', body: async () => '' });
    expect(log?.bodyFields).toEqual(['<非表单数据，已省略>']);
    expect(await describeCall({ method: 'POST', url: 'https://mon-mp.fudan.edu.cn/action?token=abc', status: 200, contentType: 'text/html', body: async () => '' })).toBeNull();
  });

  it('请求头只留名字；Authorization 只留认证方式', async () => {
    const c = await describeCall({
      method: 'GET', url: 'https://fdulspgw.fudan.edu.cn/alsp/open-api/elib5/getReaderCurrentLoan?pageSize=10&pageNo=1', status: 200, contentType: 'application/json',
      requestHeaders: { authorization: 'Bearer tok-secret-123', 'x-access-token': 'tok-secret', accept: 'application/json', cookie: 'a=b', 'content-type': 'application/json;charset=UTF-8' },
      body: async () => '{"code":0}',
    });
    expect(c?.headers).toEqual({ authorization: 'Bearer ***', 'x-access-token': '***', 'content-type': 'application/json' });
    expect(JSON.stringify(c)).not.toContain('tok-secret');
  });

  it('--keep-query 保留参数值，但遮掉令牌和长数字', async () => {
    const c = await describeCall({
      method: 'GET', url: 'https://x.fudan.edu.cn/api/search?queryPage__=1%2C20&studentId=22307130001&access_token=tok-secret&keyword=数据结构', status: 200, contentType: 'application/json',
      body: async () => '{}',
    }, { keepQuery: true });
    expect(c?.query).toEqual({ queryPage__: '1,20', studentId: '<数字>', access_token: '***', keyword: '数据结构' });
    expect(leaks(c)).toEqual([]);
  });

  it('转换响应头：去掉 Set-Cookie，合并后的换行换成逗号；错误信息里的令牌遮掉', () => {
    expect(safeHeaders({ 'set-cookie': '_csrf_token=abc; path=/\nother=1', link: '<a>; rel="next"\n<b>; rel="last"', 'content-type': 'application/json' }))
      .toEqual({ link: '<a>; rel="next", <b>; rel="last"', 'content-type': 'application/json' });
    expect(redact('Headers.append: "_csrf_token=HljbHjieol%2BIGSoxmOi%2Fx2gM8t76idpr; path=/; secure"')).toBe('Headers.append: "_csrf_token=***; path=/; secure"');
    expect(redact('bad value eyJhbGciOiJIUzI1NiJ9abcdefghijklmnopqrstuvwxyz0123')).toBe('bad value ***');
  });
});

describe('--html 保存网页', () => {
  it('遮掉 IP、浏览器标识、隐藏输入框的值、令牌和长数字，课表内容保留', () => {
    const html = `<form><input type="hidden" name="key" value="tok-secret"><input name="b" value="H2"></form>
      <table><tr><td>H2101</td><td colspan="3">MATH10026.09 [微积分A I](张永前){146人}</td></tr></table>
      <div>175.186.248.11</div><div>Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/156.0.0.0 Safari/537.36</div>
      <a href="room2.asp?id=4433&ticket=ST-123456-abcdefghijklmnopqrstuvwxyz0123">x</a><span>22307130001</span>`;
    const out = sanitizeHtml(html);
    expect(out).toContain('MATH10026.09 [微积分A I](张永前){146人}');
    expect(out).toContain('colspan="3"');
    expect(out).toContain('name="b" value="H2"');
    expect(out).not.toMatch(/tok-secret|175\.186|Macintosh|ST-123456|22307130001/);
  });
});
