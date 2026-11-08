import { load } from 'cheerio';
import { redact } from '../core/errors';

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
  /** 协议 + 主机 + 路径，不含查询值；路径里的长数字、编号换成 {id} */
  endpoint: string;
  /** 参数名；加了 --keep-query 时是「参数名: 值」（令牌、长数字已遮掉） */
  query: string[] | Record<string, string>;
  /** 非标准的请求头（只有名字；Authorization 只留认证方式），用来看系统怎么传登录令牌 */
  headers?: Record<string, string>;
  /** 表单或 JSON 请求体里的字段名 */
  bodyFields: string[];
  status: number;
  contentType: string;
  response: Shape | ReturnType<typeof htmlOutline> | string;
}

const FIELD = /^[\w.\[\]-]{1,60}$/;

/** 请求体的字段名；不是表单 / JSON 对象的请求体（比如一段日志）不记内容 */
function fieldsOf(postData?: string): string[] {
  if (!postData) return [];
  try {
    const j = JSON.parse(postData) as unknown;
    if (j && typeof j === 'object' && !Array.isArray(j)) return Object.keys(j).filter((k) => FIELD.test(k));
    return ['<JSON 数组，已省略>'];
  } catch { /* 不是 JSON，按表单处理 */ }
  try {
    const keys = [...new URLSearchParams(postData).keys()];
    return keys.length && keys.every((k) => FIELD.test(k)) ? keys : ['<非表单数据，已省略>'];
  } catch { return ['<非表单数据，已省略>']; }
}

/** 路径里的长数字（学生编号、记录 id）、UUID、长随机串换成 {id} */
export function maskPath(path: string): string {
  return path.split('/').map((seg) => /^\d{4,}$/.test(seg) || /^[0-9a-f-]{20,}$/i.test(seg) || /^[A-Za-z0-9_-]{24,}$/.test(seg) ? '{id}' : seg).join('/');
}

/** 浏览器自己会带的头不记；Authorization 只留认证方式，其余自定义头只留名字 */
const STANDARD = /^(accept|accept-.*|user-agent|referer|origin|cookie|connection|host|content-length|dnt|cache-control|pragma|sec-.*|upgrade-insecure-requests|priority|if-.*|range)$/i;
function headerNames(h?: Record<string, string>): Record<string, string> | undefined {
  if (!h) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (STANDARD.test(k)) continue;
    if (/^content-type$/i.test(k)) { out[k] = v.split(';')[0]; continue; }
    if (/^authorization$/i.test(k)) { out[k] = `${v.split(/\s+/)[0]} ***`; continue; }
    out[k] = '***';
  }
  return Object.keys(out).length ? out : undefined;
}

/** --keep-query：保留查询参数的值，但遮掉令牌和长数字（学号、编号） */
function queryValues(u: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of u.searchParams) {
    const secretName = /token|secret|passw|ticket/i.test(k) || /^(?:.*[_-])?(?:code|sign|signature|auth|key|apikey|session|sessionid|sid|pass)$/i.test(k);
    const masked = secretName ? '***' : redact(v).replace(/\d{8,}/g, '<数字>').slice(0, 60);
    out[k] = masked;
  }
  return out;
}

/** 一次请求 → 去掉内容的结构 */
export async function describeCall(r: { method: string; url: string; status: number; contentType: string; body: () => Promise<string>; postData?: string; requestHeaders?: Record<string, string> }, opts: { keepQuery?: boolean } = {}): Promise<CapturedCall | null> {
  let u: URL;
  try { u = new URL(r.url); } catch { return null; }
  // 静态资源、统计和监控请求不记
  if (/\.(js|css|png|jpe?g|gif|svg|woff2?|ico|map)$/i.test(u.pathname) || /(^|\.)(mon-mp|hm\.baidu|google-analytics|cnzz)\b/i.test(u.hostname)) return null;
  const text = await r.body().catch(() => '');
  let response: CapturedCall['response'] = `${r.contentType.split(';')[0] || '未知类型'}（${text.length} 字节）`;
  const trimmed = text.trim();
  if (/json/.test(r.contentType) || /^[[{]/.test(trimmed)) {
    try { response = shapeOf(JSON.parse(trimmed)); } catch { /* 保留类型说明 */ }
  } else if (/html|xml/.test(r.contentType) || /^</.test(trimmed)) {
    const inner = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(trimmed)?.[1] ?? trimmed;
    response = htmlOutline(inner);
  }
  const headers = headerNames(r.requestHeaders);
  return {
    method: r.method, endpoint: `${u.origin}${maskPath(u.pathname)}`, query: opts.keepQuery ? queryValues(u) : [...new Set(u.searchParams.keys())],
    ...(headers ? { headers } : {}), bodyFields: fieldsOf(r.postData),
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
    else if (Array.isArray(prev.query) && Array.isArray(c.query)) prev.query = [...new Set([...prev.query, ...c.query])];
    else if (!Array.isArray(prev.query) && !Array.isArray(c.query)) prev.query = { ...prev.query, ...c.query };
  }
  return [...map.values()];
}
