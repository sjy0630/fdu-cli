import { load } from 'cheerio';

/**
 * fdu dev capture 用：把页面发出的请求整理成「接口结构」，去掉一切具体内容。
 * 只保留：请求方法、地址（不含查询值）、参数名、返回的字段名和类型、网页里表格的列名。
 * 姓名、学号、金额、Cookie、令牌等值一律不保留，结果可以直接发给开发者。
 */
export type Shape = string | { [key: string]: Shape } | Shape[];

const MAX_DEPTH = 6;

/** 数据的结构：对象保留字段名，数组只看第一项，其余值只记类型 */
export function shapeOf(value: unknown, depth = 0): Shape {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length ? [shapeOf(value[0], depth + 1), `…共 ${value.length} 项`] : [];
  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) return 'object';
    const out: Record<string, Shape> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    // 键本身看起来是数据（日期、数字 id）时只保留一个样例键的结构
    if (entries.length > 3 && entries.every(([k]) => /^\d+$|^\d{4}-\d{2}-\d{2}$/.test(k))) {
      return { '<键为日期或数字>': shapeOf(entries[0][1], depth + 1), '…': `共 ${entries.length} 个键` };
    }
    for (const [k, v] of entries.slice(0, 80)) out[k] = shapeOf(v, depth + 1);
    return out;
  }
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return 'string(日期)';
    if (/^-?\d+(\.\d+)?$/.test(value)) return 'string(数字)';
    return `string(${value.length})`;
  }
  return typeof value;
}

/** 网页：标题、表格列名、表单字段名（不含任何格子里的内容） */
export function htmlOutline(html: string): { title?: string; tables: string[][]; forms: { action?: string; fields: string[] }[] } {
  const $ = load(html);
  const tables = $('table').map((_, t) => [$(t).find('th').map((_i, th) => $(th).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean).slice(0, 20)]).get() as string[][];
  const forms = $('form').map((_, f) => ({ action: $(f).attr('action')?.split('?')[0], fields: $(f).find('input[name],select[name],textarea[name]').map((_i, x) => $(x).attr('name')!).get().filter((n) => !/csrf|token|password/i.test(n)) })).get();
  return { title: $('title').first().text().trim() || undefined, tables: tables.filter((t) => t.length), forms };
}

export interface CapturedCall {
  method: string;
  /** 协议 + 主机 + 路径，不含查询值 */
  endpoint: string;
  query: string[];
  /** 表单或 JSON 请求体里的字段名 */
  bodyFields: string[];
  status: number;
  contentType: string;
  response: Shape | ReturnType<typeof htmlOutline> | string;
}

function fieldsOf(postData?: string): string[] {
  if (!postData) return [];
  try {
    const j = JSON.parse(postData) as unknown;
    if (j && typeof j === 'object' && !Array.isArray(j)) return Object.keys(j);
  } catch { /* 不是 JSON，按表单处理 */ }
  try { return [...new URLSearchParams(postData).keys()]; } catch { return []; }
}

/** 一次请求 → 去掉内容的结构 */
export async function describeCall(r: { method: string; url: string; status: number; contentType: string; body: () => Promise<string>; postData?: string }): Promise<CapturedCall | null> {
  let u: URL;
  try { u = new URL(r.url); } catch { return null; }
  // 静态资源和统计脚本不记
  if (/\.(js|css|png|jpe?g|gif|svg|woff2?|ico|map)$/i.test(u.pathname)) return null;
  const text = await r.body().catch(() => '');
  let response: CapturedCall['response'] = `${r.contentType.split(';')[0] || '未知类型'}（${text.length} 字节）`;
  const trimmed = text.trim();
  if (/json/.test(r.contentType) || /^[[{]/.test(trimmed)) {
    try { response = shapeOf(JSON.parse(trimmed)); } catch { /* 保留类型说明 */ }
  } else if (/html|xml/.test(r.contentType) || /^</.test(trimmed)) {
    const inner = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(trimmed)?.[1] ?? trimmed;
    response = htmlOutline(inner);
  }
  return {
    method: r.method, endpoint: `${u.origin}${u.pathname}`, query: [...new Set(u.searchParams.keys())], bodyFields: fieldsOf(r.postData),
    status: r.status, contentType: r.contentType.split(';')[0], response,
  };
}

/** 同一个接口只留第一次（参数名取并集） */
export function dedupe(calls: CapturedCall[]): CapturedCall[] {
  const map = new Map<string, CapturedCall>();
  for (const c of calls) {
    const k = `${c.method} ${c.endpoint}`;
    const prev = map.get(k);
    if (!prev) map.set(k, c);
    else prev.query = [...new Set([...prev.query, ...c.query])];
  }
  return [...map.values()];
}
