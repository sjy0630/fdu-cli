import type { CampusReader } from '../core/types';
import { readZlapp } from './dorm';

/**
 * 校车时刻表（zlapp.fudan.edu.cn，只读）。接口地址和字段参考了 DanXi 公开的接口信息，代码独立实现。
 * POST holiday=0（工作日）/ 1（节假日），返回：
 * { e: 0, d: { data: [{ lists: [{ id, start 起点校区, end 终点校区, stime 起点一栏的时刻 "07.30", etime 终点一栏的时刻, arrow 方向, holiday }] }] } }
 * arrow：0 未知、1 双向、2 终点 → 起点、3 起点 → 终点。
 */
export const BUS_URL = 'https://zlapp.fudan.edu.cn/fudanbus/wap/default/lists';

export interface BusTrip {
  from: string;
  to: string;
  /** 起点校区一栏的时刻（HH:MM），学校数据里没有时为 null */
  fromTime: string | null;
  /** 终点校区一栏的时刻（HH:MM） */
  toTime: string | null;
  /** 双向车次：两个方向都发车 */
  bothWays: boolean;
}

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
      const start = campus(raw.start), end = campus(raw.end);
      const st = hhmm(raw.stime), et = hhmm(raw.etime);
      if (!start || !end || (!st && !et)) continue;
      const arrow = Number(raw.arrow);
      // 终点 → 起点的车次掉个头，保证 from 是出发的校区
      trips.push(arrow === 2
        ? { from: end, to: start, fromTime: et, toTime: st, bothWays: false }
        : { from: start, to: end, fromTime: st, toTime: et, bothWays: arrow === 1 });
    }
  }
  const key = (t: BusTrip) => t.fromTime ?? t.toTime ?? '';
  return trips.sort((a, b) => key(a).localeCompare(key(b)));
}

/** 按出发、到达校区筛选。双向车次在反方向上也算，并按查询的方向摆正 */
export function filterBus(trips: BusTrip[], opts: { from?: string; to?: string }): BusTrip[] {
  const hit = (name: string, q?: string) => !q || name.includes(campus(q));
  return trips.flatMap((t) => {
    if (hit(t.from, opts.from) && hit(t.to, opts.to)) return [t];
    if (t.bothWays && hit(t.to, opts.from) && hit(t.from, opts.to)) return [{ from: t.to, to: t.from, fromTime: t.toTime, toTime: t.fromTime, bothWays: true }];
    return [];
  });
}

export async function readBus(reader: CampusReader, holiday: boolean): Promise<BusTrip[]> {
  const text = await readZlapp(reader, BUS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: `holiday=${holiday ? 1 : 0}`,
  });
  return parseBus(text);
}
