import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ago, cookieExpiry, packSession, unpackSession } from '../src/services/session-transfer';
import { Store } from '../src/core/store';
import { Session } from '../src/core/session';
import { findOp, type Ctx } from '../src/ops';
import { runOp } from '../src/run';

/** 登录状态的导出导入（Cookie 等都是虚构的） */

const NOW = Date.parse('2026-11-09T12:00:00Z');
const state = { cookies: [
  { name: 'CASTGC', value: 'x', domain: 'id.fudan.edu.cn', path: '/', expires: -1 },
  { name: 'remember', value: 'x', domain: '.id.fudan.edu.cn', path: '/', expires: NOW / 1000 + 7 * 86400 },
  { name: 'canvas_session', value: 'x', domain: 'elearning.fudan.edu.cn', path: '/', expires: NOW / 1000 + 86400 / 2 },
  { name: 'old', value: 'x', domain: 'elearning.fudan.edu.cn', path: '/', expires: NOW / 1000 - 10 },
  { name: 'other', value: 'x', domain: 'example.com', path: '/', expires: -1 },
], origins: [] };

describe('打包和解包', () => {
  it('往返不变；复制时多了换行、空格、前后文字也能认', () => {
    const token = packSession({ 'state.json': state, 'hole.json': { access: 'a' } }, NOW);
    expect(token.startsWith('fdu-session-v1:')).toBe(true);
    const wrapped = `这是导出的：\n${token.slice(0, 40)}\n  ${token.slice(40)}\n`;
    const b = unpackSession(wrapped);
    expect(b).toMatchObject({ v: 1, exportedAt: '2026-11-09T12:00:00.000Z' });
    expect(b.files['state.json']).toEqual(state);
  });

  it('只认允许带走的文件（不会借导入写别的文件，比如 mail.json）', () => {
    const b = unpackSession(packSession({ 'state.json': state, 'mail.json': { pass: 'p' }, '../x': 1 }));
    expect(Object.keys(b.files)).toEqual(['state.json']);
  });

  it('不是导出的内容、或者复制少了一截时，给出能看懂的提示', () => {
    expect(() => unpackSession('hello')).toThrow('fdu-session-v1');
    const token = packSession({ 'state.json': state });
    expect(() => unpackSession(token.slice(0, token.length - 20))).toThrow('不完整');
  });
});

describe('Cookie 到期时间', () => {
  it('按网站列出还没过期的持久 Cookie 和剩余天数，会话 Cookie 只计数，不输出值', () => {
    const r = cookieExpiry(state, NOW);
    expect(r).toEqual([
      { site: 'elearning.fudan.edu.cn', persistent: [{ name: 'canvas_session', expiresAt: '2026-11-10T00:00:00.000Z', daysLeft: 0.5 }], sessionOnly: 0 },
      { site: 'id.fudan.edu.cn', persistent: [{ name: 'remember', expiresAt: '2026-11-16T12:00:00.000Z', daysLeft: 7 }], sessionOnly: 1 },
    ]);
    expect(JSON.stringify(r)).not.toContain('"value"');
  });

  it('多久以前', () => {
    expect(ago('2026-11-09T11:30:00Z', NOW)).toBe('30 分钟前');
    expect(ago('2026-11-09T02:00:00Z', NOW)).toBe('10 小时前');
    expect(ago('2026-11-05T12:00:00Z', NOW)).toBe('4 天前');
  });
});

describe('导出命令', () => {
  const setup = () => {
    process.env.FDU_HOME = mkdtempSync(join(tmpdir(), 'fdu-'));
    const store = new Store();
    const ctx = { store, session: new Session(store), cwd: mkdtempSync(join(tmpdir(), 'fdu-out-')), now: () => NOW, log: () => undefined } as unknown as Ctx;
    return { store, ctx };
  };

  it('没登录时提示先登录；登录了就导出，不带邮箱密码', async () => {
    const { store, ctx } = setup();
    expect(await runOp(findOp('auth.export')!, ctx, {})).toMatchObject({ ok: false, error: { code: 'NEED_LOGIN' } });
    store.writeJson('state.json', state);
    store.writeJson('mail.json', { user: 'u', pass: 'p' });
    const r = await runOp(findOp('auth.export')!, ctx, {}) as { ok: true; data: { token: string; includes: string[] } };
    expect(r.data.includes).toEqual(['state.json']);
    expect(Object.keys(unpackSession(r.data.token).files)).toEqual(['state.json']);
  });

  it('--out 写文件（权限 600），已有文件不覆盖', async () => {
    const { store, ctx } = setup();
    store.writeJson('state.json', state);
    const r = await runOp(findOp('auth.export')!, ctx, { out: 'session.txt' }) as { ok: true; data: { file: string } };
    expect(existsSync(r.data.file)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(r.data.file).mode & 0o777).toBe(0o600);
    expect(await runOp(findOp('auth.export')!, ctx, { out: 'session.txt' })).toMatchObject({ ok: false, error: { code: 'BAD_ARGS' } });
  });

  it('导出导入都不开放给 MCP（不让 AI 拿到登录凭证）', () => {
    expect(findOp('auth.export')!.mcp).toBe(false);
    expect(findOp('auth.import')!.mcp).toBe(false);
  });
});

describe('登录记录', () => {
  it('记下登录时间；发现过期时记下这次保持了多久，同一次只记一回', () => {
    process.env.FDU_HOME = mkdtempSync(join(tmpdir(), 'fdu-'));
    const s = new Session(new Store());
    s.noteLogin('import');
    expect(s.loginLog()).toMatchObject({ via: 'import' });
    s.noteExpired();
    s.noteExpired();
    expect(s.loginLog()!.lastedHours).toHaveLength(1);
  });
});
