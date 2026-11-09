import { z } from 'zod';
import { FduError, toFduError } from './core/errors';
import type { Op, Ctx } from './ops';

export interface Outcome { ok: true; op: string; data: unknown; /** 来自本地缓存时：上次查询的时间 */ cachedAt?: string }
export interface Failure {
  ok: false; op?: string; error: { code: string; message: string; hint?: string };
  /** 联网失败但本地有上次的结果时附上（at 是上次查询的时间） */
  cached?: { at: string; data: unknown };
}

/** 这个操作的结果要不要缓存：只读的默认缓存，标了 cache: false 的不缓存 */
export const cacheable = (op: Op) => op.effect === 'read' && op.cache !== false;

/** 缓存保留多久：隐私数据（成绩、消费、邮件）24 小时，其他 7 天，实时数据由操作自己设得更短 */
export const cacheTtl = (op: Op) => op.cacheTtl ?? (op.sensitive ? 24 * 3_600_000 : 7 * 24 * 3_600_000);

/** 命令行参数名（kebab-case）→ 参数表里的名字（camelCase） */
export const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
export const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * 校验参数并运行一个操作；任何错误都变成 { ok:false, error }。
 * cachedOnly：不联网，只返回本地缓存（没有缓存时报 NOT_FOUND）。
 */
export async function runOp(op: Op, ctx: Ctx, input: Record<string, unknown>, opts: { cachedOnly?: boolean } = {}): Promise<Outcome | Failure> {
  let args: Record<string, unknown> | undefined;
  try {
    const parsed = z.object(op.params).strict().safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => i.code === 'unrecognized_keys'
        ? `不认识的参数：${i.keys.map((k) => `--${kebab(k)}`).join('、')}`
        : `--${kebab(String(i.path[0] ?? ''))}：${i.message}`);
      throw new FduError('BAD_ARGS', issues.join('；'), `用 \`fdu describe ${op.name}\` 查看参数。`);
    }
    args = parsed.data;
    const useCache = !!ctx.cache && cacheable(op);
    if (opts.cachedOnly) {
      const hit = useCache ? ctx.cache!.get(op.name, args, cacheTtl(op), ctx.now()) : null;
      if (!hit) throw new FduError('NOT_FOUND', useCache ? '本地没有这个查询的缓存（或者已经过期）。' : '这个命令的结果不缓存。', '去掉 --cached 联网查询一次。');
      return { ok: true, op: op.name, data: hit.data, cachedAt: hit.at };
    }
    let data: unknown;
    try {
      data = await op.run(ctx, args);
    } catch (e) {
      // 需要登录：自动弹出浏览器登录（或完成二次验证），成功后重试一次
      if (op.effect === 'auth' || !ctx.relogin) throw e;
      const relogged = await ctx.relogin(e);
      if (relogged === 'pending') throw new FduError('NEED_LOGIN', '已在用户电脑上打开登录窗口，正在等用户完成登录或验证。', '请用户在弹出的窗口里完成（窗口会保持打开），完成后再查询一次即可。');
      if (!relogged) throw e;
      data = await op.run(ctx, args);
    }
    if (useCache) { try { ctx.cache!.set(op.name, args, data, ctx.now()); } catch { /* 缓存写不进去不影响结果 */ } }
    return { ok: true, op: op.name, data };
  } catch (e) {
    const err = toFduError(e);
    const message = err.code === 'FORMAT_CHANGED' && !err.message.includes(op.name) ? `${err.message}（命令 ${op.name}）` : err.message;
    const failure: Failure = { ok: false, op: op.name, error: { code: err.code, message, ...(err.hint ? { hint: err.hint } : {}) } };
    // 没登录、学校系统出错时，附上上次的结果（参数错误等不附）
    if (!opts.cachedOnly && args && ctx.cache && cacheable(op) && (err.code.startsWith('NEED_') || err.code === 'UPSTREAM')) {
      const hit = ctx.cache.get(op.name, args, cacheTtl(op), ctx.now());
      if (hit) failure.cached = { at: hit.at, data: hit.data };
    }
    return failure;
  }
}

/** 退出码：0 成功；2 参数错误；3 需要登录 / 配置；1 其他 */
export function exitCode(r: Outcome | Failure): number {
  if (r.ok) return 0;
  if (r.error.code === 'BAD_ARGS') return 2;
  if (r.error.code.startsWith('NEED_')) return 3;
  return 1;
}

/** 操作的说明（describe 命令和 services 列表用） */
export function describeOp(op: Op) {
  const shape = z.object(op.params);
  const json = z.toJSONSchema(shape, { io: 'input', unrepresentable: 'any' }) as { properties?: Record<string, { description?: string; type?: string; enum?: unknown[] }>; required?: string[] };
  const params = Object.entries(json.properties ?? {}).map(([name, p]) => ({
    flag: `--${kebab(name)}`, name, type: p.enum ? p.enum.join('|') : p.type ?? 'boolean', required: (json.required ?? []).includes(name), description: p.description,
  }));
  return {
    name: op.name, command: `fdu ${op.name.replace('.', ' ')}`, summary: op.summary,
    login: op.login, effect: op.effect, sensitive: !!op.sensitive, cached: cacheable(op), mcpTool: op.mcp === false ? null : op.name.replace('.', '_'),
    params, examples: op.examples ?? [],
  };
}
