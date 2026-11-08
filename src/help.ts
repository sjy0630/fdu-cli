import { GROUPS, groupOf } from './groups';
import { OPS, type Op } from './ops';
import { describeOp } from './run';

/**
 * 给人看的帮助（纯文本）。给程序 / AI 看的 JSON 说明用 fdu describe、fdu services。
 */
const LOGIN: Record<Op['login'], string> = {
  uis: '复旦账号（fdu login）', hole: '树洞账号（fdu hole login）', mail: '学生邮箱（fdu mail setup）', none: '不用登录',
};
const ALIAS: Record<string, string> = { 'auth.login': 'fdu login', 'auth.logout': 'fdu logout', 'auth.status': 'fdu status', 'auth.doctor': 'fdu doctor', 'elearning.todo': 'fdu todo', 'overview.today': 'fdu today', 'overview.week': 'fdu week' };

/** 显示宽度：汉字、全角符号算 2 */
const width = (s: string) => [...s].reduce((n, c) => n + (/[ᄀ-￿]/.test(c) ? 2 : 1), 0);
const pad = (s: string, w: number) => s + ' '.repeat(Math.max(1, w - width(s)));
/** 一行简介：第一句话；太长时在第一个括号或逗号处截断 */
const firstSentence = (s: string) => {
  let t = s.split(/[。：:]/)[0];
  for (const cut of ['（', '，', '、']) {
    if (width(t) <= 46) break;
    const i = t.indexOf(cut);
    if (i >= 4) t = t.slice(0, i);
  }
  return t;
};

const command = (op: Op) => ALIAS[op.name] ?? `fdu ${op.name.replace('.', ' ')}`;

export function helpOverview(version: string): string {
  const lines = [
    `fdu ${version} — 复旦校园服务命令行和 MCP 服务（输出 JSON，给 Claude Code、Codex 等使用）`,
    '',
    '快速开始：',
    '  fdu doctor                 检查环境、网络和登录状态',
    '  fdu login                  登录复旦统一身份认证（打开浏览器，你自己输入账号密码）',
    '  fdu today                  今天的课、快到期的作业、考试',
    '  fdu mcp                    以 MCP 服务运行（接入 Claude Code、Codex 等）',
    '',
    '全部命令：',
  ];
  for (const g of GROUPS) {
    const ops = OPS.filter((o) => o.name.startsWith(`${g.id}.`));
    if (!ops.length) continue;
    lines.push('', `  ${g.name}（fdu help ${g.id}）`);
    for (const o of ops) lines.push(`    ${pad(command(o), 30)}${firstSentence(o.summary)}`);
  }
  lines.push(
    '',
    '通用参数：',
    '  --compact          输出单行 JSON',
    '  --cached           不联网，返回上次查询的结果（只读命令）',
    '  --profile 名称     使用另一套登录状态',
    '  --browser 路径     指定 Chromium 内核浏览器（默认找本机 Chrome / Edge）',
    '',
    '输出：成功 {"ok":true,"data":...}；失败 {"ok":false,"error":{"code","message","hint"}}，照 hint 处理。',
    '退出码：0 成功；2 参数错误；3 需要登录或配置；1 其他错误。',
    '',
    '更多：fdu help <服务>、fdu help <服务> <命令>；给 AI 看的 JSON 说明：fdu describe <服务.命令>、fdu services',
    '文档：https://github.com/sjy0630/fdu-cli',
  );
  return `${lines.join('\n')}\n`;
}

export function helpGroup(id: string): string | undefined {
  const g = groupOf(id);
  const ops = OPS.filter((o) => o.name.startsWith(`${id}.`));
  if (!g || !ops.length) return undefined;
  const lines = [`${g.name}：${g.desc}`, ''];
  for (const o of ops) {
    lines.push(`  ${command(o)}`, `    ${o.summary}`);
    const d = describeOp(o);
    if (d.params.length) lines.push(`    参数：${d.params.map((p) => (p.required ? p.flag : `[${p.flag}]`)).join(' ')}`);
    lines.push('');
  }
  lines.push(`详细说明：fdu help ${id} <命令>`);
  return `${lines.join('\n')}\n`;
}

export function helpOp(op: Op): string {
  const d = describeOp(op);
  const lines = [command(op), '', op.summary, '', `登录：${LOGIN[op.login]}`];
  if (op.sensitive) lines.push('隐私：返回成绩 / 消费 / 借阅 / 邮件等隐私数据，只用来回答你本人的问题');
  if (op.effect === 'local-write') lines.push('会在本机写文件（不覆盖已有文件）');
  lines.push(op.mcp === false ? 'MCP：不提供（需要在终端里操作）' : `MCP 工具：${d.mcpTool}`);
  if (d.params.length) {
    lines.push('', '参数：');
    const w = Math.max(...d.params.map((p) => width(p.flag))) + 2;
    for (const p of d.params) lines.push(`  ${pad(p.flag, w)}${p.required ? '（必填）' : ''}${p.description ?? ''}`);
  }
  if (d.examples.length) lines.push('', '示例：', ...d.examples.map((e) => `  ${e}`));
  return `${lines.join('\n')}\n`;
}
