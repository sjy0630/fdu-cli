import { FduError } from '../core/errors';

/**
 * 体育场馆空闲时段（booking.fudan.edu.cn 场馆预约系统，只读，不预约）。
 *
 * - 预约系统前面有一层防爬虫验证，普通的后台请求会被拒绝（412），所以由调用方在浏览器里打开预约页，
 *   再用页面里的请求读数据（和自己打开网页查看一样）。
 * - 只读「哪些时段还有空位」，不读别人的预约信息（姓名等）。
 */
export const BOOKING = 'https://booking.fudan.edu.cn';
/** 体育场馆专题 */
export const SPORTS_TOPIC = 48;
export const SPORTS_PAGE = `${BOOKING}/reservation/fe/site/special/special?id=${SPORTS_TOPIC}`;
export const BOOKING_CAS = `https://id.fudan.edu.cn/authserver/login?service=${encodeURIComponent(`${BOOKING}/reservation/api/login/cas`)}`;

export interface Venue { id: string; name: string }
export interface FreeSlot { time: string; start?: string; end?: string; free: string[]; total: number }
export interface VenueDay { date: string; slots: FreeSlot[]; freeSlots: number }

/** 在预约页里发 GET 请求，返回状态码和正文 */
export type GetJson = (url: string) => Promise<{ status: number; text: string }>;

function body(r: { status: number; text: string }, what: string): { e?: string; m?: string; d?: unknown } {
  if (r.status === 412) throw new FduError('UPSTREAM', '预约系统拦截了这次访问（防爬虫验证没有通过）。', '稍后再试；一直不行的话请直接在浏览器里打开 booking.fudan.edu.cn 查看。');
  let j: { e?: string; m?: string; d?: unknown };
  try { j = JSON.parse(r.text); } catch { throw new FduError('UPSTREAM', `预约系统返回的不是数据（${what}，${r.status}）。`); }
  return j;
}

/** 预约系统是否已登录：场馆列表能读出来就算 */
export async function bookingReady(getJson: GetJson): Promise<boolean> {
  try {
    const j = body(await getJson(`${BOOKING}/reservation/api/topic/resource-list?id=${SPORTS_TOPIC}&pageSize=200`), '场馆列表');
    return j.e === 'OK';
  } catch { return false; }
}

export async function listVenues(getJson: GetJson): Promise<Venue[]> {
  const j = body(await getJson(`${BOOKING}/reservation/api/topic/resource-list?id=${SPORTS_TOPIC}&pageSize=200`), '场馆列表');
  if (j.e !== 'OK') throw new FduError('UPSTREAM', `读取场馆列表失败：${j.m ?? '未知原因'}`);
  const rows = ((j.d as { data?: unknown[] })?.data ?? []) as { base?: { id?: unknown; name?: unknown } }[];
  return rows.flatMap((r) => (r.base?.id !== undefined && r.base?.name ? [{ id: String(r.base.id), name: String(r.base.name) }] : []));
}

/** 场馆：id 或名称关键词（空格分隔多个词都要包含，如「北区 羽毛球」） */
export function matchVenues(venues: Venue[], query: string): Venue[] {
  const q = query.trim();
  const byId = venues.filter((v) => v.id === q);
  if (byId.length) return byId;
  const words = q.split(/\s+/).filter(Boolean);
  return venues.filter((v) => words.every((w) => v.name.includes(w)));
}

/**
 * 某个场馆一段日期内每天的空闲时段。
 * 日历接口：每个子场地（如「1号场地A」）每个时段有剩余名额 num（"0" 表示约满）；活动室类场馆用 status（0 表示空闲）。
 */
export async function venueCalendar(getJson: GetJson, venueId: string, from: string, to: string): Promise<VenueDay[]> {
  if (!/^\d+$/.test(venueId)) throw new FduError('BAD_ARGS', '场馆 id 应该是数字（来自 fdu venue list）。');
  const qs = new URLSearchParams({ id: venueId, collective: '0', date: JSON.stringify({ start_date: from, end_date: to }) });
  const j = body(await getJson(`${BOOKING}/reservation/site/resource/calendar?${qs}`), '场馆日历');
  if (j.e !== 'OK') throw new FduError('UPSTREAM', `读取场馆空闲时段失败：${j.m ?? '未知原因'}`);
  const d = (j.d ?? {}) as { time?: unknown[]; resource?: unknown[]; data?: Record<string, Record<string, Record<string, { num?: unknown; status?: unknown }>>> };
  const times = (d.time ?? []) as { id?: unknown; str_time?: unknown; start_time?: unknown; end_time?: unknown }[];
  const courts = new Map(((d.resource ?? []) as { id?: unknown; name?: unknown }[]).map((r) => [String(r.id), String(r.name ?? r.id)]));
  const days: VenueDay[] = [];
  for (const [date, byCourt] of Object.entries(d.data ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const slots: FreeSlot[] = times.map((t) => {
      const free: string[] = [];
      let total = 0;
      for (const [courtId, byTime] of Object.entries(byCourt ?? {})) {
        const cell = byTime?.[String(t.id)];
        if (!cell) continue;
        total++;
        const isFree = cell.num !== undefined ? Number(cell.num) > 0 : Number(cell.status) === 0;
        if (isFree) free.push(courts.get(courtId) ?? courtId);
      }
      return { time: String(t.str_time ?? ''), ...(t.start_time ? { start: String(t.start_time).slice(0, 5) } : {}), ...(t.end_time ? { end: String(t.end_time).slice(0, 5) } : {}), free, total };
    }).filter((s) => s.total > 0);
    days.push({ date, slots, freeSlots: slots.filter((s) => s.free.length).length });
  }
  return days;
}
