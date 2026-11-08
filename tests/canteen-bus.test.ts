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
    // 实际页面结构（非用餐时段）
    const r = parseCanteen('<h1>本功能仅在用餐时段开放</h1><ul><li>6:30-9:30</li><li>10:30-13:30</li><li>16:30-19:30</li></ul>');
    expect(r).toEqual({ open: false, note: '本功能仅在用餐时段开放 6:30-9:30 10:30-13:30 16:30-19:30', campuses: [] });
  });

  it('页面改版时报错而不是返回空数据', () => {
    expect(() => parseCanteen('<html><body>维护中</body></html>')).toThrow('页面可能更新了');
  });

  it('后台请求被带到统一身份认证时，交给浏览器走完单点登录；浏览器也登不上时报需要登录', async () => {
    const toUis = async (): Promise<never> => { throw new NeedLoginError('jwfw'); };
    const r = await readCanteen({ getText: toUis, render: async () => page("['江湾食堂'];['20'];['80']") });
    expect(r.campuses[0]).toMatchObject({ campus: '邯郸', canteens: [{ name: '江湾食堂', current: 20 }] });
    await expect(readCanteen({ getText: toUis, render: async () => { throw new NeedLoginError('jwfw'); } })).rejects.toBeInstanceOf(NeedLoginError);
    await expect(readCanteen({ getText: toUis })).rejects.toBeInstanceOf(NeedLoginError);
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
  it('解析时刻表：每个方向单独一条，时间补零，没有时刻的跳过，按发车时间排序', () => {
    expect(parseBus(busBody)).toEqual([
      { from: '邯郸', to: '江湾', departAt: '07:30' },
      { from: '邯郸', to: '枫林', departAt: '08:15' },
      { from: '邯郸', to: '江湾', departAt: '12:00' },
      { from: '江湾', to: '邯郸', departAt: '12:20' },
      { from: '江湾', to: '邯郸', departAt: '17:10' },
    ]);
    expect(() => parseBus(JSON.stringify({ e: 1, m: '系统维护' }))).toThrow('系统维护');
  });

  it('按出发、到达校区筛选', () => {
    const trips = parseBus(busBody);
    expect(filterBus(trips, { from: '江湾', to: '邯郸校区' }).map((t) => t.departAt)).toEqual(['12:20', '17:10']);
    expect(filterBus(trips, { to: '枫林' })).toHaveLength(1);
  });

  it('先走单点登录，再按工作日 / 节假日 POST；登录过期时要求重新登录', async () => {
    const calls: { url: string; body?: string }[] = [];
    await readBus({ getText: async (url, init) => { calls.push({ url, body: init?.body }); return { url, status: 200, text: busBody }; } }, true);
    expect(calls[0].url).toContain('/sso/');
    expect(calls[1]).toEqual({ url: expect.stringContaining('/fudanbus/'), body: 'holiday=1' });
    await expect(readBus({ getText: async (url) => ({ url: 'https://zlapp.fudan.edu.cn/uc/wap/login', status: 200, text: '<html>登录</html>' }) }, false)).rejects.toBeInstanceOf(NeedLoginError);
  });

  it('后台请求被带到统一身份认证时，用浏览器走完单点登录再读', async () => {
    let session = false;
    const trips = await readBus({
      getText: async (url) => {
        if (url.includes('/sso/')) throw new NeedLoginError('jwfw');
        if (!session) throw new NeedLoginError('jwfw');
        return { url, status: 200, text: busBody };
      },
      render: async (_url, ready) => { session = ready('', 'https://zlapp.fudan.edu.cn/site/home'); return ''; },
    }, false);
    expect(trips).toHaveLength(5);
  });
});
