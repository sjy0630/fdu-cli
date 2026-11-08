import { createInterface } from 'node:readline';
import { Session } from './core/session';
import { Store } from './core/store';
import { Cache } from './core/cache';
import { serveMcp } from './mcp';
import { findOp, OPS, type Ctx } from './ops';
import { camel, describeOp, exitCode, runOp, type Failure } from './run';

declare const __FDU_VERSION__: string;
const VERSION = typeof __FDU_VERSION__ === 'string' ? __FDU_VERSION__ : '0.0.0-dev';

/** 常用命令的简写 */
const ALIASES: Record<string, string> = {
  login: 'auth.login', logout: 'auth.logout', status: 'auth.status', doctor: 'auth.doctor',
  todo: 'elearning.todo', today: 'overview.today', week: 'overview.week',
};
const GLOBAL = new Set(['compact', 'profile', 'browser', 'headed', 'cached']);

export interface ParsedArgs { positionals: string[]; flags: Record<string, string | true> }

/** --key value、--key=value、--flag；-- 之后都当位置参数 */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; } else flags[key] = true;
    } else if (a === '-h') flags.help = true;
    else if (a === '-v') flags.version = true;
    else positionals.push(a);
  }
  return { positionals, flags };
}

/** 位置参数 → 操作名：login / jw grades / jw.grades */
export function resolveOpName(positionals: string[]): { name?: string; rest: string[] } {
  const [a, b, ...rest] = positionals;
  if (!a) return { rest: [] };
  if (ALIASES[a]) return { name: ALIASES[a], rest: [b, ...rest].filter((x) => x !== undefined) };
  if (a.includes('.')) return { name: a, rest: [b, ...rest].filter((x) => x !== undefined) };
  return { name: b ? `${a}.${b}` : a, rest };
}

function prompt(question: string, opts: { hidden?: boolean } = {}): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: !!process.stdin.isTTY });
    if (opts.hidden && process.stdin.isTTY) {
      process.stderr.write(question);
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => undefined;
      rl.question('', (answer) => { rl.close(); process.stderr.write('\n'); resolve(answer); });
    } else rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

const HELP = `fdu ${VERSION} — 复旦校园服务命令行（输出 JSON）

用法：
  fdu login [--webvpn]            登录复旦统一身份认证（打开浏览器，你自己输入账号密码）
  fdu status                      各系统的登录状态
  fdu doctor                      检查环境、网络和登录，给出修复建议
  fdu today / fdu week            今天 / 这周的课、要交的作业、考试
  fdu <服务> <操作> [--参数 值]    例如 fdu jw timetable、fdu elearning todo --days 7
  fdu services                    列出全部操作
  fdu describe <服务.操作>         查看参数和示例
  fdu mcp                         以 MCP 服务运行（给 Claude Code、Codex 等用）

通用参数：--compact 紧凑输出；--cached 不联网，返回上次查询的结果；--profile 名称 使用另一套登录状态；--browser 路径 指定浏览器
服务：auth、overview（汇总）、calendar（导出日历）、elearning、jw（教务）、card、dorm、library、notices、hole（树洞）、danke（旦克）、mail、cache
`;

async function main(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv);
  const print = (v: unknown) => process.stdout.write(`${JSON.stringify(v, null, flags.compact ? 0 : 2)}\n`);
  if (flags.version) { process.stdout.write(`${VERSION}\n`); return 0; }
  const [first] = positionals;
  if (!first || flags.help && !first || first === 'help') { process.stdout.write(HELP); return 0; }
  const profile = typeof flags.profile === 'string' ? flags.profile : undefined;
  const browser = typeof flags.browser === 'string' ? flags.browser : undefined;
  if (first === 'mcp') { await serveMcp({ profile, browser }); return -1; }
  if (first === 'services') {
    print({ ok: true, data: OPS.map((o) => ({ name: o.name, command: `fdu ${o.name.replace('.', ' ')}`, summary: o.summary, login: o.login, effect: o.effect, sensitive: !!o.sensitive })) });
    return 0;
  }
  if (first === 'describe') {
    const target = positionals[1] ? resolveOpName(positionals.slice(1)).name : undefined;
    const op = target ? findOp(target) : undefined;
    if (!op) { print({ ok: false, error: { code: 'NOT_FOUND', message: `没有这个操作：${positionals.slice(1).join(' ')}`, hint: '用 `fdu services` 查看全部操作。' } }); return 2; }
    print({ ok: true, data: describeOp(op) });
    return 0;
  }
  const { name, rest } = resolveOpName(positionals);
  const op = name ? findOp(name) : undefined;
  if (!op) {
    print({ ok: false, error: { code: 'NOT_FOUND', message: `没有这个命令：${positionals.join(' ')}`, hint: '用 `fdu services` 查看全部操作，或 `fdu --help`。' } } satisfies Failure);
    return 2;
  }
  if (rest.length) {
    print({ ok: false, op: op.name, error: { code: 'BAD_ARGS', message: `多余的参数：${rest.join(' ')}`, hint: `参数要写成 --名字 值，用 \`fdu describe ${op.name}\` 查看。` } } satisfies Failure);
    return 2;
  }
  if (flags.help) { print({ ok: true, data: describeOp(op) }); return 0; }
  const store = new Store(profile);
  const session = new Session(store, { browserPath: browser, headed: flags.headed === true });
  const input = Object.fromEntries(Object.entries(flags).filter(([k]) => !GLOBAL.has(k)).map(([k, v]) => [camel(k), v]));
  const ctx: Ctx = {
    store, session, cwd: process.cwd(), now: () => Date.now(),
    log: (m) => process.stderr.write(`${m}\n`),
    prompt: process.stdin.isTTY ? prompt : undefined,
    cache: new Cache(store),
  };
  try {
    const result = await runOp(op, ctx, input, { cachedOnly: flags.cached === true });
    print(result);
    return exitCode(result);
  } finally {
    await session.close();
  }
}

// 被测试 import 时不运行
const invokedDirectly = process.argv[1] && /(?:^|[\\/])(cli\.(?:ts|js)|fdu)$/.test(process.argv[1]);
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => { if (code >= 0) process.exitCode = code; }, (e) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: String((e as Error)?.message ?? e) } })}\n`);
    process.exitCode = 1;
  });
}

export { main };
