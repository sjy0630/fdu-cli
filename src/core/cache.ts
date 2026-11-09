import { createHash } from 'node:crypto';
import { readdirSync, rmSync, statSync } from 'node:fs';
import type { Store } from './store';

/**
 * 查询结果的本地缓存：每次成功查询后保存一份（权限 600，和登录状态在同一个目录）。
 * - --cached：不联网，直接返回上次的结果；
 * - 联网失败（没登录、学校系统出错）时，错误里附上上次的结果和时间，先凑合用。
 * 退出登录时一起删除；也可以 fdu cache clear。
 */
export interface CacheEntry { op: string; args: Record<string, unknown>; at: string; data: unknown }

const DIR = 'cache';
/** 最多留多少份缓存；任何缓存最长留多久（各操作的有效期都不超过这个） */
const MAX_FILES = 200;
const MAX_AGE = 7 * 24 * 3_600_000;

/** 参数按键名排序后再算，避免参数顺序不同算成两份 */
export function cacheKey(op: string, args: Record<string, unknown>): string {
  const sorted = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha1').update(`${op}\n${JSON.stringify(sorted)}`).digest('hex').slice(0, 24);
}

export class Cache {
  constructor(private readonly store: Store) {}

  /** 读缓存；超过 ttlMs 的当作没有，并顺手删掉 */
  get(op: string, args: Record<string, unknown>, ttlMs = MAX_AGE, now = Date.now()): CacheEntry | null {
    const name = `${DIR}/${cacheKey(op, args)}.json`;
    const e = this.store.readJson<CacheEntry>(name);
    if (!e || e.op !== op) return null;
    if (!(now - Date.parse(e.at) <= ttlMs)) { this.store.remove(name); return null; }
    return e;
  }

  set(op: string, args: Record<string, unknown>, data: unknown, now = Date.now()): void {
    this.store.writeJson(`${DIR}/${cacheKey(op, args)}.json`, { op, args, at: new Date(now).toISOString(), data } satisfies CacheEntry);
    this.prune(now);
  }

  /** 删掉超过 7 天的；超过上限时从最旧的删起 */
  prune(now = Date.now()): void {
    let files: { f: string; t: number }[];
    try {
      files = readdirSync(this.store.path(DIR)).filter((f) => f.endsWith('.json')).map((f) => ({ f, t: statSync(this.store.path(`${DIR}/${f}`)).mtimeMs }));
    } catch { return; }
    files.sort((a, b) => b.t - a.t);
    files.forEach(({ f, t }, i) => { if (i >= MAX_FILES || now - t > MAX_AGE) rmSync(this.store.path(`${DIR}/${f}`), { force: true }); });
  }

  clear(): number {
    let n = 0;
    try {
      for (const f of readdirSync(this.store.path(DIR))) { if (f.endsWith('.json')) { rmSync(this.store.path(`${DIR}/${f}`), { force: true }); n++; } }
    } catch { /* 还没有缓存 */ }
    return n;
  }
}
