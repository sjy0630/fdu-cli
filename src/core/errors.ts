import { NeedLoginError } from './fudan-auth';

/** 命令失败的分类：给人看 message，给程序 / 编程助理看 code 和 hint */
export type ErrorCode =
  | 'NEED_LOGIN' // 复旦账号没登录或登录过期：运行 fdu login
  | 'NEED_HOLE_LOGIN' // 树洞没登录：运行 fdu hole login
  | 'NEED_MAIL_SETUP' // 邮箱没配置：运行 fdu mail setup
  | 'NEED_TERMINAL' // 要在终端里输入密码（树洞、邮箱），AI 和脚本不能代替
  | 'NO_BROWSER' // 找不到 Chrome / Edge
  | 'BAD_ARGS'
  | 'NOT_FOUND'
  | 'PERMISSION' // 登录有效，但学校系统不让看这部分
  | 'FORMAT_CHANGED' // 学校页面改版，解析不了
  | 'UPSTREAM' // 学校系统出错、超时、断网
  | 'INTERNAL';

/** 需要登录时，自动登录要运行的登录命令（如教室系统、图书馆这些单独登录的系统） */
export interface Relogin { op: string; args?: Record<string, unknown> }

export class FduError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly hint?: string, public readonly relogin?: Relogin) {
    super(message);
    this.name = 'FduError';
  }
}

/** 错误信息里可能夹带 Cookie、令牌：像「名字=很长的值」和很长的随机串一律遮掉 */
export function redact(s: string): string {
  return s
    .replace(/([\w-]*(?:token|csrf|session|cookie|ticket|auth|key|sid)[\w-]*)=([^;\s"',&]+)/gi, '$1=***')
    .replace(/[A-Za-z0-9%+/_-]{32,}={0,2}/g, '***');
}

const PARSE_HINT = '这不是网络问题。请到 https://github.com/sjy0630/fdu-cli/issues 反馈（附上这条信息）；有账号的话可以运行 `fdu dev capture --url <页面>` 录下接口结构一起发来。';

/** 把各模块抛出的错误统一成 FduError */
export function toFduError(e: unknown): FduError {
  if (e instanceof FduError) return e;
  if (e instanceof NeedLoginError) {
    return e.page
      ? new FduError('NEED_LOGIN', '需要登录复旦统一身份认证，或者这个页面要求二次验证（如微信扫码）。', `运行 \`fdu login --url ${e.page.url}\`，在打开的浏览器里按提示完成，窗口会自动关闭。`)
      : new FduError('NEED_LOGIN', '复旦账号没有登录或登录已过期。', '运行 `fdu login`，在弹出的浏览器里登录复旦统一身份认证。');
  }
  const err = e as { name?: string; message?: string; status?: number };
  // Playwright 的报错后面带一大段调用日志和终端颜色，只留第一行
  const message = redact(String(err?.message ?? e).replace(/\u001b\[[0-9;]*m/g, '').split(/\nCall log:|\n/)[0].replace(/^apiRequestContext\.\w+:\s*/, ''));
  if (err?.name === 'TreeholeLoginError') return new FduError('NEED_HOLE_LOGIN', '需要登录树洞账号。', '运行 `fdu hole login --email 学号@m.fudan.edu.cn`（密码只用来换取令牌，不保存）。');
  if (err?.name === 'TimetableFormatError') return new FduError('FORMAT_CHANGED', message, PARSE_HINT);
  if (err?.status === 403) return new FduError('PERMISSION', message);
  // 网络问题先判断（Node 的 fetch 失败也是 TypeError）
  if (/timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|fetch failed|net::/i.test(message)) {
    return new FduError('UPSTREAM', `连不上学校系统：${message.slice(0, 160)}`, '检查网络；部分系统只允许校园网访问，校外请先连学校 VPN。');
  }
  // 解析学校返回的内容时出错（字段缺失、JSON 不对、页面结构变了）：多半是学校页面改版，不是网络问题
  if (e instanceof TypeError || e instanceof SyntaxError || e instanceof RangeError
    || /格式和预期不同|页面可能更新了|没有找到.*(入口|数据|表格)|Unexpected token|is not valid JSON|JSON\.parse/i.test(message)) {
    return new FduError('FORMAT_CHANGED', `学校系统返回的内容和预期不同（可能是页面改版了）：${message.slice(0, 200)}`, PARSE_HINT);
  }
  return new FduError('UPSTREAM', message.slice(0, 400));
}
