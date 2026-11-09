import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * 把登录状态从一台电脑带到另一台（比如没有屏幕的虚拟机、服务器）：
 * 在有浏览器的电脑上 fdu login，然后 fdu auth export 得到一段文本；在另一台上 fdu auth import 粘贴进去。
 *
 * 带走的：state.json（统一身份认证、WebVPN 等登录后的 Cookie）、library.json（图书馆令牌）、hole.json（树洞令牌）。
 * 不带走 mail.json：里面有邮箱客户端专用密码，到另一台上重新 fdu mail setup。
 * 这段文本能代表你登录学校系统，和密码一样对待：只在自己的设备之间传，不要发到群里或提交到仓库。
 */
export const TRANSFER_FILES = ['state.json', 'library.json', 'hole.json'] as const;
const PREFIX = 'fdu-session-v1:';

export interface TransferBundle { v: 1; exportedAt: string; files: Record<string, unknown> }

export function packSession(files: Record<string, unknown>, now = Date.now()): string {
  const bundle: TransferBundle = { v: 1, exportedAt: new Date(now).toISOString(), files };
  return PREFIX + gzipSync(Buffer.from(JSON.stringify(bundle))).toString('base64url');
}

export function unpackSession(text: string): TransferBundle {
  const s = text.replace(/\s+/g, '');
  const at = s.indexOf(PREFIX);
  if (at < 0) throw new Error('这不是 fdu auth export 导出的内容（应该以 fdu-session-v1: 开头）。');
  let bundle: TransferBundle;
  try {
    bundle = JSON.parse(gunzipSync(Buffer.from(s.slice(at + PREFIX.length), 'base64url')).toString('utf8'));
  } catch {
    throw new Error('导出的内容不完整（可能复制时少了一截），请重新复制整段。');
  }
  if (bundle?.v !== 1 || typeof bundle.files !== 'object' || !bundle.files) throw new Error('导出的内容版本不对，请两边都更新到最新版 fdu。');
  for (const name of Object.keys(bundle.files)) if (!(TRANSFER_FILES as readonly string[]).includes(name)) delete bundle.files[name];
  return bundle;
}

interface Cookie { name: string; domain: string; expires: number }

/**
 * 各网站登录 Cookie 的到期时间（只看名字和到期时间，不输出值）。
 * expires = -1 的是会话 Cookie：有效期由学校服务器决定（通常是闲置一段时间后失效），看不出具体时间。
 */
export function cookieExpiry(state: unknown, now = Date.now()): { site: string; persistent: { name: string; expiresAt: string; daysLeft: number }[]; sessionOnly: number }[] {
  const cookies = ((state as { cookies?: Cookie[] })?.cookies ?? []).filter((c) => /fudan\.edu\.cn$/.test(c.domain.replace(/^\./, '')));
  const bySite = new Map<string, Cookie[]>();
  for (const c of cookies) {
    const site = c.domain.replace(/^\./, '');
    bySite.set(site, [...(bySite.get(site) ?? []), c]);
  }
  return [...bySite.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([site, list]) => ({
    site,
    persistent: list.filter((c) => c.expires > 0 && c.expires * 1000 > now)
      .map((c) => ({ name: c.name, expiresAt: new Date(c.expires * 1000).toISOString(), daysLeft: Math.round(((c.expires * 1000 - now) / 86_400_000) * 10) / 10 }))
      .sort((a, b) => a.daysLeft - b.daysLeft),
    sessionOnly: list.filter((c) => !(c.expires > 0)).length,
  }));
}

/** 「3 小时前」这类说法 */
export function ago(iso: string | undefined, now = Date.now()): string | undefined {
  if (!iso) return undefined;
  const mins = Math.round((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(mins)) return undefined;
  if (mins < 60) return `${Math.max(mins, 0)} 分钟前`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} 小时前`;
  return `${Math.round(mins / 1440)} 天前`;
}
