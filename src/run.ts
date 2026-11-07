import { z } from 'zod';
import { FduError, toFduError } from './core/errors';
import type { Op, Ctx } from './ops';

export interface Outcome { ok: true; op: string; data: unknown }
export interface Failure { ok: false; op?: string; error: { code: string; message: string; hint?: string } }

/** 命令行参数名（kebab-case）→ 参数表里的名字（camelCase） */
export const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
export const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** 校验参数并运行一个操作；任何错误都变成 { ok:false, error } */
export async function runOp(op: Op, ctx: Ctx, input: Record<string, unknown>): Promise<Outcome | Failure> {
  try {
    const parsed = z.object(op.params).strict().safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => i.code === 'unrecognized_keys'
        ? `不认识的参数：${i.keys.map((k) => `--${kebab(k)}`).join('、')}`
        : `--${kebab(String(i.path[0] ?? ''))}：${i.message}`);
      throw new FduError('BAD_ARGS', issues.join('；'), `用 \`fdu describe ${op.name}\` 查看参数。`);
    }
    return { ok: true, op: op.name, data: await op.run(ctx, parsed.data) };
  } catch (e) {
    const err = toFduError(e);
    return { ok: false, op: op.name, error: { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) } };
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
    login: op.login, effect: op.effect, sensitive: !!op.sensitive, mcpTool: op.mcp === false ? null : op.name.replace('.', '_'),
    params, examples: op.examples ?? [],
  };
}
