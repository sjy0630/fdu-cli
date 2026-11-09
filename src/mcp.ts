import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Session } from './core/session';
import { Store } from './core/store';
import { Cache } from './core/cache';
import { autoLogin, FLAGS, OPS, type Ctx, type Op } from './ops';
import { runOp } from './run';

declare const __FDU_VERSION__: string;
const VERSION = typeof __FDU_VERSION__ === 'string' ? __FDU_VERSION__ : '0.0.0-dev';

const LOGIN_NOTE: Record<Op['login'], string> = {
  uis: '需要复旦账号登录（没登录时返回 NEED_LOGIN，请用户在终端运行 `fdu login`，或调用 auth_login）。',
  hole: '需要树洞账号（没登录时返回 NEED_HOLE_LOGIN，请用户在终端运行 `fdu hole login --email ...`）。',
  mail: '需要配置学生邮箱（没配置时返回 NEED_MAIL_SETUP，请用户在终端运行 `fdu mail setup --user ...`）。',
  none: '',
};

/** MCP 里的参数：命令行的布尔开关换成普通布尔值 */
export function mcpShape(op: Op): z.ZodRawShape {
  return Object.fromEntries(Object.entries(op.params)
    .filter(([k]) => !op.mcpOmit?.includes(k))
    .map(([k, v]) => [k, FLAGS.has(v as z.ZodType) ? z.boolean().optional().describe((v as z.ZodType).description ?? '') : v]));
}

/** MCP 里一次调用最多等登录多久（客户端的工具调用一般一分钟左右超时） */
export const MCP_LOGIN_WAIT_MS = (Number(process.env.FDU_MCP_LOGIN_WAIT) || 50) * 1000;

export function toolDescription(op: Op): string {
  return [
    op.summary,
    LOGIN_NOTE[op.login],
    op.sensitive ? '返回的是隐私数据（成绩 / 邮件等）：只用来回答用户本人的问题，不要写进代码仓库、提交信息或发给别人。' : '',
    op.effect === 'local-write' ? '会在本机写文件（不覆盖已有文件）。' : '',
  ].filter(Boolean).join('\n');
}

export function buildServer(session: Session, store: Store): McpServer {
  const server = new McpServer({ name: 'fudan', version: VERSION });
  // 所有调用共用一个登录会话和浏览器：排队一个个来，免得一个调用结束时关掉另一个正在用的浏览器
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const next = queue.then(fn, fn); queue = next.catch(() => undefined); return next; };
  for (const op of OPS) {
    if (op.mcp === false) continue;
    server.registerTool(op.name.replace('.', '_'), {
      description: toolDescription(op),
      inputSchema: mcpShape(op),
      annotations: { readOnlyHint: op.effect === 'read', destructiveHint: false, openWorldHint: true },
    }, async (args: Record<string, unknown>) => {
      const ctx: Ctx = { store, session, log: (m) => process.stderr.write(`${m}\n`), cwd: process.cwd(), now: () => Date.now(), cache: new Cache(store), relogin: (e) => autoLogin(ctx, e), waitMs: MCP_LOGIN_WAIT_MS, mcp: true };
      const result = await serial(async () => { const r = await runOp(op, ctx, args ?? {}); await session.release(); return r; });
      return {
        // 失败但有上次的结果时一并返回，并写明是什么时候的
        content: [{ type: 'text' as const, text: JSON.stringify(result.ok ? result.data : { ...result.error, ...(result.cached ? { cached: result.cached } : {}) }, null, 1) }],
        ...(result.ok ? {} : { isError: true }),
      };
    });
  }
  return server;
}

/** fdu mcp：以 stdio 方式运行 MCP 服务（Claude Code、Codex、Cursor 等都支持） */
export async function serveMcp(opts: { profile?: string; browser?: string } = {}): Promise<void> {
  const store = new Store(opts.profile);
  const session = new Session(store, { browserPath: opts.browser });
  const server = buildServer(session, store);
  const shutdown = async () => { await session.close(); process.exit(0); };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.stdin.on('end', () => void shutdown());
  await server.connect(new StdioServerTransport());
}
