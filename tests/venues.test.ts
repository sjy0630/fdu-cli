import { describe, expect, it } from 'vitest';
import { BOOKING, bookingReady, listVenues, matchVenues, venueCalendar, type GetJson } from '../src/services/venues';

/** 体育场馆空闲时段（接口字段按预约系统，场馆和场地都是虚构的） */

const ok = (d: unknown) => ({ status: 200, text: JSON.stringify({ e: 'OK', d }) });
const resourceList = ok({ data: [
  { base: { id: 938, name: '北区体育馆-羽毛球（演示）', type: 6 } },
  { base: { id: 940, name: '正大体育馆-羽毛球（演示）', type: 6 } },
  { base: { id: 751, name: '学生活动中心-多功能厅（演示）', type: 9 } },
] });
const calendar = ok({
  time: [{ id: 3800, str_time: '08:00-09:00', start_time: '08:00:00', end_time: '09:00:00' }, { id: 3801, str_time: '09:00-10:00', start_time: '09:00:00', end_time: '10:00:00' }],
  resource: [{ id: 939, name: '1号场地' }, { id: 941, name: '2号场地' }],
  data: {
    '2026-11-11': { 939: { 3800: { num: '0' }, 3801: { num: '1' } }, 941: { 3800: { num: '0' }, 3801: { num: '1' } } },
    '2026-11-10': { 939: { 3800: { num: '1' }, 3801: { num: '0' } }, 941: { 3800: { num: '0' }, 3801: { num: '0' } } },
  },
});

describe('体育场馆', () => {
  const getJson = (map: Record<string, { status: number; text: string }>): GetJson & { urls: string[] } => {
    const urls: string[] = [];
    const f = async (url: string) => { urls.push(url); const k = Object.keys(map).find((x) => url.includes(x)); return k ? map[k] : { status: 404, text: '' }; };
    return Object.assign(f, { urls });
  };

  it('场馆列表；按 id 或多个关键词匹配', async () => {
    const venues = await listVenues(getJson({ 'resource-list': resourceList }));
    expect(venues.map((v) => v.id)).toEqual(['938', '940', '751']);
    expect(matchVenues(venues, '北区 羽毛球').map((v) => v.id)).toEqual(['938']);
    expect(matchVenues(venues, '羽毛球')).toHaveLength(2);
    expect(matchVenues(venues, '751')[0].name).toContain('多功能厅');
    expect(matchVenues(venues, '游泳')).toEqual([]);
  });

  it('空闲时段：每个时段哪些场地有空，按日期排序；查询带上日期范围', async () => {
    const g = getJson({ 'resource/calendar': calendar });
    const days = await venueCalendar(g, '938', '2026-11-10', '2026-11-11');
    expect(days.map((d) => d.date)).toEqual(['2026-11-10', '2026-11-11']);
    expect(days[0].slots).toEqual([
      { time: '08:00-09:00', start: '08:00', end: '09:00', free: ['1号场地'], total: 2 },
      { time: '09:00-10:00', start: '09:00', end: '10:00', free: [], total: 2 },
    ]);
    expect(days[0].freeSlots).toBe(1);
    expect(days[1].slots[1].free).toEqual(['1号场地', '2号场地']);
    const q = new URL(g.urls[0]).searchParams;
    expect(JSON.parse(q.get('date')!)).toEqual({ start_date: '2026-11-10', end_date: '2026-11-11' });
    expect(g.urls[0].startsWith(`${BOOKING}/reservation/site/resource/calendar`)).toBe(true);
  });

  it('活动室类场馆用 status 判断空闲', async () => {
    const room = ok({ time: [{ id: 1, str_time: '08:30-10:30' }], resource: [{ id: 752, name: '多功能厅' }], data: { '2026-11-10': { 752: { 1: { status: 0 } } } } });
    const days = await venueCalendar(getJson({ calendar: room }), '751', '2026-11-10', '2026-11-10');
    expect(days[0].slots[0].free).toEqual(['多功能厅']);
  });

  it('被防爬虫验证拦下（412）、没登录、参数不对时给出明确的错误', async () => {
    await expect(listVenues(getJson({ 'resource-list': { status: 412, text: '<html></html>' } }))).rejects.toMatchObject({ code: 'UPSTREAM', message: expect.stringContaining('拦截') });
    expect(await bookingReady(getJson({ 'resource-list': { status: 200, text: JSON.stringify({ e: 'NOT_LOGIN', m: '请登录' }) } }))).toBe(false);
    expect(await bookingReady(getJson({ 'resource-list': resourceList }))).toBe(true);
    await expect(venueCalendar(getJson({}), '../1', '2026-11-10', '2026-11-10')).rejects.toMatchObject({ code: 'BAD_ARGS' });
  });
});
