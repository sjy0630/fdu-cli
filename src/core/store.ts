import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 本地保存的东西都在一个目录里（默认 ~/.config/fdu-cli/<profile>/，Windows 为 %APPDATA%\fdu-cli\<profile>\）：
 * - state.json：复旦统一身份认证登录后的 Cookie（浏览器会话），不含密码
 * - hole.json：树洞令牌（密码只用来换令牌，不保存）
 * - mail.json：学生邮箱 IMAP 配置和客户端专用密码（明文，仅本用户可读）
 * 目录权限 700、文件权限 600。这些文件能代表你登录学校系统，不要同步到网盘或发给别人。
 */
export function baseDir(): string {
  if (process.env.FDU_HOME) return process.env.FDU_HOME;
  if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'fdu-cli');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'fdu-cli');
}

export class Store {
  readonly dir: string;
  constructor(profile = process.env.FDU_PROFILE || 'default') {
    if (!/^[\w-]{1,40}$/.test(profile)) throw new Error('profile 只能包含字母、数字、下划线和短横线');
    this.dir = join(baseDir(), profile);
  }

  path(name: string): string { return join(this.dir, name); }

  readJson<T>(name: string): T | null {
    const file = this.path(name);
    if (!existsSync(file)) return null;
    try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return null; }
  }

  /** 先写临时文件再改名，写到一半断电也不会留下坏文件 */
  writeJson(name: string, value: unknown): void {
    const file = this.path(name);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try { chmodSync(dirname(file), 0o700); } catch { /* Windows 上忽略 */ }
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
    try { chmodSync(file, 0o600); } catch { /* Windows 上忽略 */ }
  }

  remove(name: string): boolean {
    const file = this.path(name);
    if (!existsSync(file)) return false;
    rmSync(file, { force: true });
    return true;
  }
}
