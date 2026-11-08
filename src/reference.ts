import { OPS } from './ops';
import { describeOp } from './run';
import { GROUPS } from './groups';

const LOGIN: Record<string, string> = { uis: '复旦账号', hole: '树洞账号', mail: '学生邮箱', none: '不用' };

/** 全部命令的参考文档（skills/fdu-cli/reference.md 由它生成，测试会检查是否最新） */
export function referenceMarkdown(): string {
  const lines = [
    '# fdu 命令参考',
    '',
    '> 由 `npm run docs` 根据代码里的操作表生成，不要手改。',
    '',
    '所有命令输出 JSON：成功是 `{"ok":true,"op":...,"data":...}`，失败是 `{"ok":false,"error":{"code","message","hint"}}`。',
    '退出码：0 成功，2 参数错误，3 需要登录或配置（`NEED_LOGIN` / `NEED_HOLE_LOGIN` / `NEED_MAIL_SETUP`），1 其他错误。',
    'MCP 工具名是把命令里的点换成下划线，如 `jw.grades` → `jw_grades`。',
    '简写：`fdu login` / `logout` / `status` / `doctor` / `today` / `week` / `todo`。',
    '只读查询的结果会缓存在本机：加 `--cached` 不联网直接返回上次的结果（带 `cachedAt`）；联网失败时，错误里附上上次的结果 `cached: {at, data}`。',
    '',
  ];
  // 按分组顺序；没有登记分组的命令放在最后
  const ordered = [...GROUPS.map((g) => g.id), ...new Set(OPS.map((o) => o.name.split('.')[0]))].filter((g, i, a) => a.indexOf(g) === i);
  let group = '';
  for (const op of ordered.flatMap((g) => OPS.filter((o) => o.name.startsWith(`${g}.`)))) {
    const d = describeOp(op);
    const g = op.name.split('.')[0];
    if (g !== group) { group = g; const info = GROUPS.find((x) => x.id === g); lines.push(`## ${info?.name ?? g}`, '', ...(info ? [info.desc, ''] : [])); }
    const tags = [`登录：${LOGIN[op.login]}`, op.effect === 'local-write' ? '会写本机文件' : op.effect === 'auth' ? '登录 / 退出' : '只读', op.sensitive ? '**隐私数据**' : '', op.mcp === false ? '仅命令行' : `MCP：\`${d.mcpTool}\``].filter(Boolean);
    lines.push(`### \`${d.command}\``, '', op.summary, '', tags.join(' · '), '');
    if (d.params.length) {
      lines.push('| 参数 | 类型 | 必填 | 说明 |', '|---|---|---|---|');
      for (const p of d.params) lines.push(`| \`${p.flag}\` | ${p.type.replace(/\|/g, " / ")} | ${p.required ? '是' : ''} | ${(p.description ?? '').replace(/\|/g, '\\|')} |`);
      lines.push('');
    }
    if (d.examples.length) lines.push('```bash', ...d.examples, '```', '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
