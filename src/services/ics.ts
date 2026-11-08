import { createHash } from 'node:crypto';

/**
 * 生成 iCalendar（.ics，RFC 5545）文件：苹果日历、Outlook、Google 日历都能导入。
 * 时间一律写成 UTC（末尾 Z），不依赖时区定义；UID 由内容算出，重复导入同一份课表时日历软件会更新而不是重复添加。
 */
export interface IcsEvent {
  /** 用来算 UID 的稳定标识，如「课|数据结构|2026-11-09|13:30」 */
  key: string;
  summary: string;
  startsAt: string;
  endsAt: string;
  location?: string;
  description?: string;
  url?: string;
  /** 提前多少分钟提醒 */
  alarmMinutes?: number;
  categories?: string[];
}

/** 文字里的反斜杠、分号、逗号、换行要转义 */
export function icsText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** 每行不超过 75 字节（按 UTF-8 计算，不把一个汉字拆开），续行以空格开头 */
export function foldLine(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    const limit = out.length ? 74 : 75;
    if (bytes + n > limit) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function buildIcs(events: IcsEvent[], opts: { name: string; now: number }): string {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//fdu-cli//Fudan campus calendar//ZH', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(opts.name)}`, 'X-WR-TIMEZONE:Asia/Shanghai',
  ];
  const dtstamp = stamp(new Date(opts.now).toISOString());
  for (const e of events) {
    const uid = `${createHash('sha1').update(e.key).digest('hex').slice(0, 20)}@fdu-cli`;
    lines.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${dtstamp}`, `DTSTART:${stamp(e.startsAt)}`, `DTEND:${stamp(e.endsAt)}`, `SUMMARY:${icsText(e.summary)}`);
    if (e.location) lines.push(`LOCATION:${icsText(e.location)}`);
    if (e.description) lines.push(`DESCRIPTION:${icsText(e.description)}`);
    if (e.url && /^https?:\/\//.test(e.url)) lines.push(`URL:${e.url}`);
    if (e.categories?.length) lines.push(`CATEGORIES:${e.categories.map(icsText).join(',')}`);
    if (e.alarmMinutes) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(e.summary)}`, `TRIGGER:-PT${e.alarmMinutes}M`, 'END:VALARM');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
