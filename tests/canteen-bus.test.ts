import { describe, expect, it } from 'vitest';
import { filterBus, parseBus, readBus } from '../src/services/bus';
import { parseCanteen, readCanteen } from '../src/services/canteen';
import { NeedLoginError } from '../src/core/fudan-auth';

/** 食堂人数、校车时刻表（返回格式按真实服务，内容虚构） */

const page = (script: string) => `<!doctype html><html><head><script src="/x.js"></script></head><body><div id="chart"></div><script>${script}</script></body></html>`;

describe('食堂人数', () => {
  it('按校区读出食堂名、人数、容量', () => {
    const r = parseCanteen(page(`
      var opts = { colors: ['#123', '#456'] };
      var a0 = ['北区-一楼','南区\\n二楼']; var b0 = ['120','30']; var c0 = ['400','100'];
      var a1 = ['枫林食堂']; var b1 = ['55']; var c1 = ['200'];
      draw(a0, b0, c0);`));
    expect(r.open).toBe(true);
    expect(r.campuses).toEqual([
      { campus: '邯郸', canteens: [
        { name: '北区-一楼', current: 120, capacity: 400, ratio: 0.3 },
        { name: '南区 二楼', current: 30, capacity: 100, ratio: 0.3 },
      ] },
      { campus: '枫林', canteens: [{ name: '枫林食堂', current: 55, capacity: 200, ratio: 0.28 }] },
    ]);
  });

  it('不在用餐时段时如实说明', () => {
    const r = parseCanteen('<html><body><p>仅在 10:30-13:00、16:30-19:00 提供查询</p></body></html>');
    expect(r).toMatchObject({ open: false, campuses: [] });
    expect(r.note).toContain('仅在');
  });

  it('页面改版时报错而不是返回空数据', () => {
    expect(() => parseCanteen('<html><body>维护中</body></html>')).toThrow('页面可能更新了');
  });

  it('后台请求拿不到数据时用浏览器渲染', async () => {
    const rendered: string[] = [];
    const r = await readCanteen({
      getText: async (url) => ({ url, status: 200, text: '<html><body>加载中</body></html>' }),
      render: async (url, ready) => { rendered.push(url); const html = page("['张江食堂'];['8'];['50']"); expect(ready(html, url)).toBe(true); return html; },
    });
    expect(rendered).toHaveLength(1);
    expect(r.campuses[0].canteens[0]).toMatchObject({ name: '张江食堂', current: 8 });
  });
});

const busBody = JSON.stringify({ e: 0, d: { data: [
  { lists: [
    { id: '1', start: '邯郸校区', end: '江湾校区', stime: '7.30', etime: '', arrow: '3', holiday: '0' },
    { id: '2', start: '邯郸', end: '江湾', stime: '12.00', etime: '12.20', arrow: '1', holiday: '0' },
    { id: '3', start: '邯郸', end: '江湾', stime: '', etime: '17.10', arrow: '2', holiday: '0' },
    { id: '4', start: '邯郸', end: '江湾', stime: '', etime: '', arrow: '3', holiday: '0' },
  ] },
  { lists: [{ id: '5', start: '邯郸', end: '枫林', stime: '08.15', etime: '', arrow: '3', holiday: '0' }] },
  { lists: null },
] } });

describe('校车', () => {
  it('解析时刻表：时间补零、反向车次掉头、没有时刻的跳过、按时间排序', () => {
    expect(parseBus(busBody)).toEqual([
      { from: '邯郸', to: '江湾', fromTime: '07:30', toTime: null, bothWays: false },
      { from: '邯郸', to: '枫林', fromTime: '08:15', toTime: null, bothWays: false },
      { from: '邯郸', to: '江湾', fromTime: '12:00', toTime: '12:20', bothWays: true },
      { from: '江湾', to: '邯郸', fromTime: '17:10', toTime: null, bothWays: false },
    ]);
    expect(() => parseBus(JSON.stringify({ e: 1, m: '系统维护' }))).toThrow('系统维护');
  });

  it('按方向筛选，双向车次在反方向也算', () => {
    const trips = parseBus(busBody);
    expect(filterBus(trips, { from: '江湾', to: '邯郸校区' })).toEqual([
      { from: '江湾', to: '邯郸', fromTime: '12:20', toTime: '12:00', bothWays: true },
      { from: '江湾', to: '邯郸', fromTime: '17:10', toTime: null, bothWays: false },
    ]);
    expect(filterBus(trips, { to: '枫林' })).toHaveLength(1);
  });

  it('先走单点登录，再按工作日 / 节假日 POST；登录过期时要求重新登录', async () => {
    const calls: { url: string; body?: string }[] = [];
    await readBus({ getText: async (url, init) => { calls.push({ url, body: init?.body }); return { url, status: 200, text: busBody }; } }, true);
    expect(calls[0].url).toContain('/sso/');
    expect(calls[1]).toEqual({ url: expect.stringContaining('/fudanbus/'), body: 'holiday=1' });
    await expect(readBus({ getText: async (url) => ({ url: 'https://zlapp.fudan.edu.cn/uc/wap/login', status: 200, text: '<html>登录</html>' }) }, false)).rejects.toBeInstanceOf(NeedLoginError);
  });
});
