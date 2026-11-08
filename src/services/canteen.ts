import type { CampusReader } from '../core/types';
import { NeedLoginError } from '../core/fudan-auth';

/**
 * 食堂实时人数（my.fudan.edu.cn 的「食堂情况」，复用统一身份认证会话，只读）。
 * 接口地址和页面结构参考了 DanXi 公开的接口信息，代码独立实现。
 * 页面脚本里按校区依次放着三个数组：食堂名、当前人数、容量；校区顺序为邯郸、枫林、江湾、张江。
 * 不在用餐时段时，页面只显示一句「仅……开放」之类的说明。
 */
export const CANTEEN_URL = 'https://my.fudan.edu.cn/simple_list/stqk';
const CAMPUSES = ['邯郸', '枫林', '江湾', '张江'];

export interface Canteen { name: string; current: number; capacity: number | null; ratio: number | null }
export interface CanteenCrowd { open: boolean; note?: string; campuses: { campus: string; canteens: Canteen[] }[] }

const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/** 脚本里的数组字面量：['a','b'] / ["1","2"] / [1,2] */
function arrays(script: string): unknown[][] {
  const out: unknown[][] = [];
  for (const m of script.matchAll(/\[[^[\]]*\]/g)) {
    try {
      const v = JSON.parse(m[0].replace(/\\n/g, ' ').replace(/'/g, '"'));
      if (Array.isArray(v)) out.push(v);
    } catch { /* 不是数据数组 */ }
  }
  return out;
}

const num = (v: unknown) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

export function parseCanteen(html: string): CanteenCrowd {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  for (const script of scripts) {
    const list = arrays(script);
    // 食堂名是中文，人数和容量是非负整数，三个数组一样长（别的脚本里的数组对不上）
    const count = (x: unknown) => { const n = num(x); return n !== null && Number.isInteger(n) && n >= 0; };
    const isTriple = (i: number) => {
      const [names, cur, max] = list.slice(i, i + 3);
      return i + 2 < list.length && names.length > 0 && names.every((x) => typeof x === 'string' && /[\u4e00-\u9fff]/.test(x))
        && cur.length === names.length && max.length === names.length && cur.every(count) && max.every((x) => x === '' || count(x));
    };
    // 数据数组前面可能还有别的数组：从第一组能对上的位置开始，按三个一组往后读
    const first = list.findIndex((_, i) => isTriple(i));
    if (first < 0) continue;
    const campuses: CanteenCrowd['campuses'] = [];
    for (let i = first, n = 0; isTriple(i); i += 3, n++) {
      const [names, cur, max] = list.slice(i, i + 3);
      campuses.push({
        campus: CAMPUSES[n] ?? `区域 ${n + 1}`,
        canteens: names.map((name, k) => {
          const current = num(cur[k])!, capacity = num(max[k]);
          return { name: String(name).replace(/\s+/g, ' ').trim(), current, capacity, ratio: capacity ? Math.round((current / capacity) * 100) / 100 : null };
        }),
      });
    }
    return { open: true, campuses };
  }
  const note = text(html);
  // 不在用餐时段：页面只有一句说明
  if (/仅/.test(note)) return { open: false, note: note.slice(0, 200), campuses: [] };
  throw new Error('没有在食堂情况页面上找到人数数据，学校页面可能更新了。');
}

export async function readCanteen(reader: CampusReader): Promise<CanteenCrowd> {
  // 停在食堂页面上、能解析出人数或「不在用餐时段」的说明才算加载好（中间跳转页、浏览器的错误页都不算）
  const ready = (html: string, url: string) => {
    try { if (new URL(url).hostname !== new URL(CANTEEN_URL).hostname) return false; parseCanteen(html); return true; } catch { return false; }
  };
  let html = '';
  try {
    const r = await reader.getText(CANTEEN_URL);
    html = r.text;
    if (!ready(html, r.url)) html = '';
  } catch (e) {
    // 单点登录的最后一步靠页面脚本，后台请求会停在统一身份认证；交给浏览器走完
    // （统一身份认证真的过期时，浏览器也会停在登录页，照样报需要登录）
    if (!(e instanceof NeedLoginError) || !reader.render) throw e;
  }
  if (!html && reader.render) {
    let landed = '';
    html = await reader.render(CANTEEN_URL, (h, u) => { landed = u; return ready(h, u); });
    // 浏览器没能停在食堂页面（网络不通、被带到别处）：不拿别的页面当数据
    try { if (new URL(landed).hostname !== new URL(CANTEEN_URL).hostname) throw new Error(); } catch {
      throw new Error('没能打开食堂人数页面，请检查网络后重试。');
    }
  }
  return parseCanteen(html);
}
