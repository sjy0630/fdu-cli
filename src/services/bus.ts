import type { CampusReader } from '../core/types';
import { readZlapp } from './dorm';

/**
 * 校车时刻表（zlapp.fudan.edu.cn，只读）。接口地址和字段参考了 DanXi 公开的接口信息，代码独立实现。
 * POST holiday=0（工作日）/ 1（节假日），返回：
 * { e: 0, d: { data: [{ lists: [{ id, start 校区 A, end 校区 B, stime "07.30", etime, arrow 方向, holiday }] }] } }
 * 实测：stime 是从 start 发车的时间，etime 是从 end 发车的时间；双向车次两个都有，单向车次只有一个。
 */
export const BUS_URL = 'https://zlapp.fudan.edu.cn/fudanbus/wap/default/lists';

/** 一个方向的一班车 */
export interface BusTrip { from: string; to: string; departAt: string }

const hhmm = (v: unknown): string | null => {
  const m = /^(\d{1,2})[.:：](\d{2})$/.exec(String(v ?? '').trim());
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
};
const campus = (v: unknown) => String(v ?? '').trim().replace(/校区$/, '');

export function parseBus(body: string): BusTrip[] {
  let data: { e?: unknown; m?: unknown; d?: { data?: unknown } };
  try { data = JSON.parse(body); } catch { throw new Error('校车系统返回的格式和预期不同。'); }
  if (Number(data.e) !== 0 || !Array.isArray(data.d?.data)) throw new Error(typeof data.m === 'string' && data.m ? `校车系统：${data.m}` : '校车系统没有返回时刻表。');
  const trips: BusTrip[] = [];
  for (const route of data.d!.data as { lists?: unknown }[]) {
    if (!Array.isArray(route?.lists)) continue;
    for (const raw of route.lists as Record<string, unknown>[]) {
      const a = campus(raw.start), b = campus(raw.end);
      if (!a || !b) continue;
      const st = hhmm(raw.stime), et = hhmm(raw.etime);
      if (st) trips.push({ from: a, to: b, departAt: st });
      if (et) trips.push({ from: b, to: a, departAt: et });
    }
  }
  const seen = new Set<string>();
  return trips
    .filter((t) => { const k = `${t.from}|${t.to}|${t.departAt}`; return !seen.has(k) && !!seen.add(k); })
    .sort((x, y) => x.departAt.localeCompare(y.departAt) || x.from.localeCompare(y.from));
}

/** 按出发、到达校区筛选 */
export function filterBus(trips: BusTrip[], opts: { from?: string; to?: string }): BusTrip[] {
  const hit = (name: string, q?: string) => !q || name.includes(campus(q));
  return trips.filter((t) => hit(t.from, opts.from) && hit(t.to, opts.to));
}

export async function readBus(reader: CampusReader, holiday: boolean): Promise<BusTrip[]> {
  const text = await readZlapp(reader, BUS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: `holiday=${holiday ? 1 : 0}`,
  });
  return parseBus(text);
}
