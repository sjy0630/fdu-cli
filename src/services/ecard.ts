import { load } from 'cheerio';
import { FduError } from '../core/errors';
import { NeedLoginError } from '../core/fudan-auth';
import type { CampusReader } from '../core/types';

/**
 * 校园卡消费记录（ecard.fudan.edu.cn 的「消费查询」，只读）。
 *
 * 流程：打开查询页拿到防跨站令牌（meta name="_csrf"），再按日期范围逐页查询。
 * 返回的是 XML 包着的 HTML 表格，每行：时间、交易类型、商户 / 地点、金额。
 * 时间有的版本合在一格（「2026.11.07 12:31」），有的拆成日期、时间两格，两种都认。
 */
export const ECARD = 'https://ecard.fudan.edu.cn';
export const CONSUME_INDEX = `${ECARD}/epay/consume/index`;
export const CONSUME_QUERY = `${ECARD}/epay/consume/query`;

export interface CardRecord {
  /** ISO（UTC） */
  time: string;
  /** 交易类型，如「消费」「充值」 */
  type: string;
  merchant: string;
  /** 支出为负，充值、退款为正（元） */
  amount: number;
}

/** 这些类型是钱进卡里 */
const INCOME = /充值|退款|补助|转入|圈存|返还|冲正|撤销/;
const DT = /(\d{4})[.\-/年](\d{1,2})[.\-/月](\d{1,2})日?\s*(?:(\d{1,2}):(\d{2})(?::(\d{2}))?)?/;
const TIME_ONLY = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

const shanghaiIso = (y: string, mo: string, d: string, h = '0', mi = '0', s = '0') =>
  new Date(Date.UTC(+y, +mo - 1, +d, +h - 8, +mi, +s)).toISOString();

export function parseCsrf(html: string): string | undefined {
  return load(html)('meta[name="_csrf"]').attr('content')?.trim() || undefined;
}

/** 查询结果：CDATA 里的 HTML 表格 → 记录；顺带读出总页数（「1/5页」） */
export function parseConsumePage(body: string): { records: CardRecord[]; pages?: number } {
  const inner = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(body)?.[1] ?? body;
  const $ = load(inner);
  const pageText = $.root().text().replace(/\s+/g, '');
  const pages = /\d+\/(\d+)页/.exec(pageText)?.[1];
  const records: CardRecord[] = [];
  $('tr').each((_, tr) => {
    const cells = $(tr).find('td').map((_i, td) => $(td).text().replace(/ /g, ' ').replace(/\s+/g, ' ').trim()).get();
    if (cells.length < 4) return;
    let rest = cells;
    const m = DT.exec(cells[0]);
    if (!m) return;
    const [, y, mo, d] = m;
    let [h, mi, sec] = [m[4] ?? '0', m[5] ?? '0', m[6] ?? '0'];
    // 日期和时间分成两格
    const t = m[4] === undefined ? TIME_ONLY.exec(cells[1]) : null;
    if (t) {
      [h, mi, sec] = [t[1], t[2], t[3] ?? '0'];
      rest = [cells[0], ...cells.slice(2)];
    }
    const type = rest[1] ?? '';
    const merchant = rest[2] ?? '';
    const rawAmount = (rest[3] ?? '').replace(/[,，¥￥元\s]/g, '');
    const num = /[-+]?\d+(?:\.\d+)?/.exec(rawAmount)?.[0];
    if (num === undefined) return;
    const value = Math.abs(Number(num));
    const signed = /^-/.test(num) ? -value : /^\+/.test(num) ? value : INCOME.test(type) ? value : -value;
    records.push({ time: shanghaiIso(y, mo, d, h, mi, sec), type, merchant, amount: Math.round(signed * 100) / 100 });
  });
  return { records, pages: pages ? Number(pages) : undefined };
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (t: number) => { const d = new Date(t + 8 * 3_600_000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };

/**
 * 读一段日期（上海时间，含首尾）的消费记录，新的在前。最多读 maxPages 页（每页 10 条左右）。
 */
export async function readCardRecords(reader: CampusReader, range: { from: string; to: string }, opts: { maxPages?: number } = {}): Promise<{ records: CardRecord[]; truncated: boolean }> {
  let index = await reader.getText(CONSUME_INDEX);
  let csrf = parseCsrf(index.text);
  // 单点登录最后一步靠页面脚本：在无界面浏览器里打开一次，拿到会话后再读
  if (!csrf && reader.render) {
    await reader.render(CONSUME_INDEX, (html) => !!parseCsrf(html));
    index = await reader.getText(CONSUME_INDEX);
    csrf = parseCsrf(index.text);
  }
  if (!csrf) {
    if (/uis\.fudan|id\.fudan|统一身份认证/.test(index.url + index.text.slice(0, 2000))) throw new NeedLoginError('jwfw');
    throw new FduError('FORMAT_CHANGED', '没有在校园卡消费查询页上找到查询入口，学校页面可能更新了。');
  }
  const maxPages = opts.maxPages ?? 30;
  const all: CardRecord[] = [];
  let pages = 1;
  let truncated = false;
  for (let page = 1; page <= pages; page++) {
    if (page > maxPages) { truncated = true; break; }
    const body = new URLSearchParams({
      aaxmlrequest: 'true', pageNo: String(page), tabNo: '1', 'pager.offset': '10', tradename: '',
      starttime: range.from, endtime: range.to, timetype: '1', _tradedirect: 'on', _csrf: csrf,
    }).toString();
    const res = await reader.getText(CONSUME_QUERY, {
      method: 'POST', body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/xml', Origin: ECARD, Referer: CONSUME_INDEX },
    });
    if (res.status >= 400) throw new FduError('UPSTREAM', `校园卡系统返回 ${res.status}`);
    const r = parseConsumePage(res.text);
    if (page === 1 && r.pages) pages = r.pages;
    if (!r.records.length) break;
    all.push(...r.records);
    // 没读到总页数时一页一页往后读，直到读不到
    if (!r.pages && page === pages) pages++;
  }
  // 去重（翻页时边界上的记录可能重复）后按时间倒序
  const seen = new Set<string>();
  const records = all.filter((x) => { const k = `${x.time}|${x.merchant}|${x.amount}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => b.time.localeCompare(a.time));
  return { records, truncated };
}

/** 日期范围：最近 days 天（含今天），或者指定起止 */
export function cardRange(now: number, opts: { days?: number; from?: string; to?: string }): { from: string; to: string } {
  const to = opts.to ?? ymd(now);
  const from = opts.from ?? ymd(Date.parse(`${to}T12:00:00+08:00`) - ((opts.days ?? 7) - 1) * 86_400_000);
  if (from > to) throw new FduError('BAD_ARGS', '开始日期不能晚于结束日期。');
  return { from, to };
}

/** 按餐次分：早餐 5–10 点，午餐 10–15 点，晚餐 15–21 点，其余算夜宵 */
export function mealOf(iso: string): '早餐' | '午餐' | '晚餐' | '夜宵' {
  const h = new Date(Date.parse(iso) + 8 * 3_600_000).getUTCHours();
  return h >= 5 && h < 10 ? '早餐' : h < 15 && h >= 10 ? '午餐' : h >= 15 && h < 21 ? '晚餐' : '夜宵';
}

/** 统计：总支出、充值、按商户、按天、按餐次 */
export function summarize(records: CardRecord[]) {
  const round = (n: number) => Math.round(n * 100) / 100;
  const spend = records.filter((r) => r.amount < 0);
  const byMerchant = new Map<string, { spent: number; count: number }>();
  const byDay = new Map<string, number>();
  const byMeal = new Map<string, { spent: number; count: number }>();
  for (const r of spend) {
    const m = byMerchant.get(r.merchant) ?? { spent: 0, count: 0 };
    m.spent -= r.amount; m.count++;
    byMerchant.set(r.merchant, m);
    const day = ymd(Date.parse(r.time));
    byDay.set(day, (byDay.get(day) ?? 0) - r.amount);
    const meal = mealOf(r.time);
    const e = byMeal.get(meal) ?? { spent: 0, count: 0 };
    e.spent -= r.amount; e.count++;
    byMeal.set(meal, e);
  }
  const spent = round(spend.reduce((s, r) => s - r.amount, 0));
  const days = byDay.size;
  return {
    count: records.length,
    spent,
    toppedUp: round(records.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0)),
    averagePerDay: days ? round(spent / days) : 0,
    byMerchant: [...byMerchant].map(([merchant, v]) => ({ merchant, spent: round(v.spent), count: v.count })).sort((a, b) => b.spent - a.spent).slice(0, 10),
    byMeal: ['早餐', '午餐', '晚餐', '夜宵'].flatMap((meal) => { const v = byMeal.get(meal); return v ? [{ meal, spent: round(v.spent), count: v.count }] : []; }),
    byDay: [...byDay].map(([date, v]) => ({ date, spent: round(v) })).sort((a, b) => a.date.localeCompare(b.date)),
  };
}
