import { createHash } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import type { Store } from './store';

/**
 * 查询结果的本地缓存：每次成功查询后保存一份（权限 600，和登录状态在同一个目录）。
 * - --cached：不联网，直接返回上次的结果；
 * - 联网失败（没登录、学校系统出错）时，错误里附上上次的结果和时间，先凑合用。
 * 退出登录时一起删除；也可以 fdu cache clear。
 */
export interface CacheEntry { op: string; args: Record<string, unknown>; at: string; data: unknown }

const DIR = 'cache';

/** 参数按键名排序后再算，避免参数顺序不同算成两份 */
export function cacheKey(op: string, args: Record<string, unknown>): string {
  const sorted = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha1').update(`${op}\n${JSON.stringify(sorted)}`).digest('hex').slice(0, 24);
}

export class Cache {
  constructor(private readonly store: Store) {}

  get(op: string, args: Record<string, unknown>): CacheEntry | null {
    const e = this.store.readJson<CacheEntry>(`${DIR}/${cacheKey(op, args)}.json`);
    return e && e.op === op ? e : null;
  }

  set(op: string, args: Record<string, unknown>, data: unknown, now = Date.now()): void {
    this.store.writeJson(`${DIR}/${cacheKey(op, args)}.json`, { op, args, at: new Date(now).toISOString(), data } satisfies CacheEntry);
  }

  clear(): number {
    let n = 0;
    try {
      for (const f of readdirSync(this.store.path(DIR))) { if (f.endsWith('.json')) { rmSync(this.store.path(`${DIR}/${f}`), { force: true }); n++; } }
    } catch { /* 还没有缓存 */ }
    return n;
  }
}
