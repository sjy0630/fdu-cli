import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { FduError } from '../core/errors';
import { toWebvpnUrl } from './webvpn';

/**
 * 空教室：学校多媒体教室系统的「在线课表」（内网 10.64.130.6，校外经 WebVPN），只读。
 *
 * 页面 day.asp?b=楼&day=日期：每间教室一行（教室号、座位数），后面 14 格对应第一到第十四节；
 * 有课的格子写着课程代码、[课名](老师){人数}，或者「临借」和活动名，空格子就是那一节空着。
 * 只读教室的占用情况，不读页面上的设备状态（话筒、摄像头等）。
 */
export const ROOMS_ORIGIN = 'http://10.64.130.6';

/** 网页上能选的教学楼代码（「请选择」下拉框和首页的楼栋卡片） */
export const BUILDINGS = ['H2', 'H3', 'H4', 'H5', 'H6', 'HGX', 'HQ', 'JA', 'JB', 'F1', 'F2', 'Z2'];

export interface Period { no: number; start: string; end: string }
export interface Occupant {
  kind: 'course' | 'borrow' | 'other';
  /** 课程代码，如 MATH10026.09 */
  code?: string;
  name?: string;
  teacher?: string;
  /** 已选人数 */
  people?: number;
  /** 本 / 研 / 通识 / 临借 / 调 等标签 */
  tags: string[];
  text: string;
}
export interface RoomDay { room: string; capacity?: number; periods: (Occupant | null)[] }
export interface DayPage { date?: string; week?: number; periods: Period[]; rooms: RoomDay[] }

/** 日期 → 页面用的格式（2026-11-6，不补零） */
export function roomsDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${y}-${m}-${d}`;
}

export function dayPageUrl(building: string, day: string, opts: { webvpn?: boolean } = { webvpn: true }): string {
  const url = `${ROOMS_ORIGIN}/day.asp?${new URLSearchParams({ b: building, c: '', p: '', day: roomsDay(day) })}`;
  return opts.webvpn === false ? url : toWebvpnUrl(url);
}

function occupant($: CheerioAPI, td: Cheerio<Element>): Occupant | null {
  const tags = td.find('span.tag').map((_, el) => $(el).text().trim()).get().filter(Boolean);
  const copy = td.clone();
  copy.find('span.tag').remove();
  const text = copy.text().replace(/\s+/g, ' ').trim();
  if (!text && !tags.length) return null;
  const m = /^([A-Z]{2,}[A-Z0-9.]*\d[\w.]*)?\s*\[(.+?)\]\s*(?:\(([^)]*)\))?\s*(?:\{(\d+)人\})?/.exec(text);
  const borrow = tags.includes('临借') || /临借/.test(text);
  if (m && (m[1] || m[2]) && !borrow) {
    return {
      kind: 'course', tags, text,
      ...(m[1] ? { code: m[1] } : {}), name: m[2],
      ...(m[3] ? { teacher: m[3] } : {}), ...(m[4] ? { people: Number(m[4]) } : {}),
    };
  }
  return { kind: borrow ? 'borrow' : 'other', tags, text, ...(borrow ? { name: text.replace(/^临借\s*/, '') } : {}) };
}

/** 解析一栋楼一天的「在线课表」页面 */
export function parseDayPage(html: string): DayPage {
  const $ = load(html);
  const periods: Period[] = [];
  $('td[id^="td0"]').each((_, el) => {
    const id = $(el).attr('id') ?? '';
    const no = Number(id.replace(/^td0*/, ''));
    const cells = $(el).find('table td').map((_i, x) => $(x).text().trim()).get();
    const times = cells.filter((t) => /^\d{1,2}:\d{2}$/.test(t));
    // 表头在页面里出现两次（另有一个固定在顶部的），按节次去重
    if (no >= 1 && no <= 20 && times.length >= 2 && !periods.some((p) => p.no === no)) periods.push({ no, start: times[0].padStart(5, '0'), end: times[1].padStart(5, '0') });
  });
  periods.sort((a, b) => a.no - b.no);
  if (!periods.length) {
    if (/统一身份认证|authCenter|idp\/authn/i.test(html)) throw new FduError('NEED_LOGIN', '空教室系统需要登录。', '运行 `fdu rooms login`，在打开的窗口里登录一次。', { op: 'rooms.login' });
    throw new FduError('FORMAT_CHANGED', '空教室页面的格式和预期不同，学校页面可能更新了。');
  }
  const rooms: RoomDay[] = [];
  $('tr').each((_, tr) => {
    const tds = $(tr).children('td');
    const first = tds.first();
    const link = first.find('a[id^="rt"]').first();
    if (!/^r\d+$/.test(first.attr('id') ?? '') || !link.length) return;
    const room = link.text().trim();
    const cap = Number(tds.eq(1).find('[id^="cap"]').first().text().trim() || tds.eq(1).text().trim().match(/\d+/)?.[0]);
    const cells = tds.slice(2, 2 + periods.length).toArray().map((td) => occupant($, $(td)));
    rooms.push({ room, ...(Number.isFinite(cap) && cap > 0 ? { capacity: cap } : {}), periods: cells });
  });
  const dateText = $('#datetime').attr('value');
  const date = dateText && /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(dateText) ? dateText.split('/').map((x, i) => (i ? x.padStart(2, '0') : x)).join('-') : undefined;
  const weekTitle = $('span[title^="第"][title$="教学周"]').attr('title');
  const week = weekTitle ? Number(/第(\d+)教学周/.exec(weekTitle)?.[1]) : undefined;
  return { ...(date ? { date } : {}), ...(week ? { week } : {}), periods, rooms };
}

/** 第几节到第几节的时间 */
export function periodSpan(periods: Period[], from: number, to: number): string {
  const a = periods.find((p) => p.no === from);
  const b = periods.find((p) => p.no === to);
  return a && b ? `${a.start}-${b.end}` : '';
}

/** 某个时刻（HH:MM）在第几节；课间算下一节，晚于最后一节返回 undefined */
export function periodAt(periods: Period[], hhmm: string): number | undefined {
  return periods.find((p) => hhmm <= p.end)?.no;
}

/** 连续的同一安排合成一块：[{from, to, occupant}] */
export function blocks(room: RoomDay): { from: number; to: number; occupant: Occupant }[] {
  const out: { from: number; to: number; occupant: Occupant }[] = [];
  room.periods.forEach((o, i) => {
    if (!o) return;
    const last = out[out.length - 1];
    if (last && last.to === i && last.occupant.text === o.text) last.to = i + 1;
    else out.push({ from: i + 1, to: i + 1, occupant: o });
  });
  return out;
}

/** 在 from–to 节都空着的教室，按座位从多到少；附上之后第一节有安排的时间 */
export function freeRooms(page: DayPage, from: number, to: number, opts: { minCapacity?: number } = {}) {
  return page.rooms
    .filter((r) => r.periods.slice(from - 1, to).every((o) => !o) && (opts.minCapacity === undefined || (r.capacity ?? 0) >= opts.minCapacity))
    .map((r) => {
      const nextIdx = r.periods.findIndex((o, i) => i >= to && !!o);
      const next = nextIdx >= 0 ? page.periods[nextIdx] : undefined;
      return { room: r.room, capacity: r.capacity, freeUntil: next ? `第 ${next.no} 节（${next.start}）前` : '今天之后都空着' };
    })
    .sort((a, b) => (b.capacity ?? 0) - (a.capacity ?? 0));
}

// ---------------- 给 AI 读的完整报告 ----------------

/** 楼层：去掉楼号前缀后的第一位数字（H2101 → 1 楼） */
export function floorOf(building: string, room: string): number | undefined {
  const rest = room.toUpperCase().startsWith(building.toUpperCase()) ? room.slice(building.length) : room.replace(/^[A-Z]+/i, '');
  const d = /\d/.exec(rest)?.[0];
  return d ? Number(d) : undefined;
}

const range = (periods: Period[], from: number, to: number) => `第${from === to ? from : `${from}–${to}`}节 ${periodSpan(periods, from, to)}`;

/** 这间教室现在的状态：在用（在做什么、到几点）或空着（空到几点） */
export function nowStatus(page: DayPage, room: RoomDay, hhmm: string): { status: 'busy'; what: string; until: string } | { status: 'free'; until: string } | { status: 'closed' } {
  const p = periodAt(page.periods, hhmm);
  if (p === undefined) return { status: 'closed' };
  const inClass = hhmm >= page.periods[p - 1].start;
  const cur = room.periods[p - 1];
  if (cur && inClass) {
    const b = blocks(room).find((x) => x.from <= p && p <= x.to)!;
    return { status: 'busy', what: [cur.code, cur.name ?? cur.text].filter(Boolean).join(' '), until: page.periods[b.to - 1].end };
  }
  const next = room.periods.findIndex((o, i) => i >= p - 1 && !!o);
  return { status: 'free', until: next >= 0 ? page.periods[next].start : '今天结束' };
}

/** 一栋楼一天的完整报告：汇总（按楼层）+ 每间教室的全部安排和空闲时段；nowHm 给出时附上现在的状态 */
export function roomsReport(building: string, page: DayPage, opts: { nowHm?: string; room?: string } = {}) {
  const rooms = page.rooms
    .filter((r) => !opts.room || r.room.toUpperCase() === opts.room.toUpperCase())
    .map((r) => {
      const schedule = blocks(r).map(({ from, to, occupant: o }) => ({
        periods: `${from}-${to}`, time: periodSpan(page.periods, from, to), kind: o.kind,
        ...(o.code ? { code: o.code } : {}), ...(o.name ? { name: o.name } : {}), ...(o.teacher ? { teacher: o.teacher } : {}),
        ...(o.people !== undefined ? { people: o.people } : {}), ...(o.tags.length ? { tags: o.tags } : {}),
        ...(o.kind === 'other' ? { note: o.text } : {}),
      }));
      const free: string[] = [];
      let start = 0;
      r.periods.forEach((o, i) => {
        if (!o && !start) start = i + 1;
        if (start && (o || i === r.periods.length - 1)) { free.push(range(page.periods, start, o ? i : i + 1)); start = 0; }
      });
      return {
        room: r.room, floor: floorOf(building, r.room), seats: r.capacity,
        ...(opts.nowHm ? { now: nowStatus(page, r, opts.nowHm) } : {}),
        schedule, free,
      };
    });
  const floors = new Map<number, { floor: number; rooms: number; seats: number; freeNow: number; busyNow: number }>();
  for (const r of rooms) {
    const f = floors.get(r.floor ?? 0) ?? { floor: r.floor ?? 0, rooms: 0, seats: 0, freeNow: 0, busyNow: 0 };
    f.rooms++; f.seats += r.seats ?? 0;
    if (r.now?.status === 'free') f.freeNow++;
    if (r.now?.status === 'busy') f.busyNow++;
    floors.set(f.floor, f);
  }
  const fl = [...floors.values()].sort((a, b) => a.floor - b.floor);
  return {
    building, date: page.date, week: page.week,
    summary: {
      rooms: rooms.length, seats: fl.reduce((s, f) => s + f.seats, 0),
      ...(opts.nowHm ? { freeNow: fl.reduce((s, f) => s + f.freeNow, 0), busyNow: fl.reduce((s, f) => s + f.busyNow, 0) } : {}),
      floors: opts.nowHm ? fl : fl.map(({ floor, rooms: n, seats }) => ({ floor, rooms: n, seats })),
    },
    rooms,
  };
}
