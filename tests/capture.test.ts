import { describe, expect, it } from 'vitest';
import { dedupe, describeCall, htmlOutline, shapeOf } from '../src/services/capture';

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
