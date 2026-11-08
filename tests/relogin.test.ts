import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NeedLoginError } from '../src/core/fudan-auth';
import { FduError, toFduError } from '../src/core/errors';
import { autoLogin, findOp, type Ctx, type Op } from '../src/ops';
import { runOp } from '../src/run';

/** 自动登录：命令遇到「需要登录」时登录一次再重试 */

const base = { cwd: '/', now: () => 0, log: () => undefined } as unknown as Ctx;
const op = (run: Op['run']): Op => ({ name: 't.read', summary: 'test op', login: 'uis', effect: 'read', params: {}, run });

describe('runOp 自动登录后重试', () => {
  it('登录成功就重试一次，拿到结果', async () => {
    let calls = 0;
    const seen: unknown[] = [];
    const ctx = { ...base, relogin: async (e: unknown) => { seen.push(e); return true; } } as Ctx;
    const r = await runOp(op(async () => { if (calls++ === 0) throw new NeedLoginError('jwfw', undefined, { url: 'https://my.fudan.edu.cn/x' }); return 'ok'; }), ctx, {});
    expect(r).toMatchObject({ ok: true, data: 'ok' });
    expect(calls).toBe(2);
    expect(seen[0]).toBeInstanceOf(NeedLoginError);
  });

  it('没登录成功、或者重试还是失败，就照常返回需要登录（只重试一次）', async () => {
    let calls = 0;
    const fail = op(async () => { calls++; throw new NeedLoginError('jwfw'); });
    expect(await runOp(fail, { ...base, relogin: async () => false } as Ctx, {})).toMatchObject({ ok: false, error: { code: 'NEED_LOGIN' } });
    expect(calls).toBe(1);
    expect(await runOp(fail, { ...base, relogin: async () => true } as Ctx, {})).toMatchObject({ ok: false, error: { code: 'NEED_LOGIN' } });
    expect(calls).toBe(3);
  });

  it('登录命令本身不自动登录；没有 relogin（如测试、关掉了）时直接返回错误', async () => {
    let asked = 0;
    const authOp: Op = { ...op(async () => { throw new NeedLoginError('jwfw'); }), effect: 'auth' };
    await runOp(authOp, { ...base, relogin: async () => { asked++; return true; } } as Ctx, {});
    expect(asked).toBe(0);
    expect(await runOp(op(async () => { throw new NeedLoginError('jwfw'); }), base, {})).toMatchObject({ ok: false });
  });
});

describe('autoLogin 选择怎么登录', () => {
  const env = process.env.FDU_AUTO_LOGIN;
  beforeEach(() => { process.env.FDU_AUTO_LOGIN = '1'; });
  afterEach(() => { if (env === undefined) delete process.env.FDU_AUTO_LOGIN; else process.env.FDU_AUTO_LOGIN = env; });

  it('单独登录的系统运行它的登录命令；同时来的请求共用一次登录', async () => {
    const rooms = findOp('rooms.login')!;
    const original = rooms.run;
    let runs = 0;
    rooms.run = async () => { runs++; await new Promise((r) => setTimeout(r, 20)); return {}; };
    try {
      const ctx = { ...base, session: {} } as unknown as Ctx;
      const e = new FduError('NEED_LOGIN', '空教室系统需要登录。', 'hint', { op: 'rooms.login' });
      expect(await Promise.all([autoLogin(ctx, e), autoLogin(ctx, e)])).toEqual([true, true]);
      expect(runs).toBe(1);
    } finally { rooms.run = original; }
  });

  it('不是登录问题、或者关掉了自动登录时不处理', async () => {
    const ctx = { ...base, session: {} } as unknown as Ctx;
    expect(await autoLogin(ctx, new FduError('UPSTREAM', '学校系统出错'))).toBe(false);
    expect(await autoLogin(ctx, new FduError('NEED_HOLE_LOGIN', '需要登录树洞'))).toBe(false);
    process.env.FDU_AUTO_LOGIN = '0';
    expect(await autoLogin(ctx, new FduError('NEED_LOGIN', 'x', 'y', { op: 'rooms.login' }))).toBe(false);
  });
});

describe('需要登录的提示', () => {
  it('知道是哪个页面时，提示用 fdu login --url 完成登录或二次验证', () => {
    expect(toFduError(new NeedLoginError('jwfw', undefined, { url: 'https://my.fudan.edu.cn/simple_list/stqk' })).hint).toContain('fdu login --url https://my.fudan.edu.cn/simple_list/stqk');
    expect(toFduError(new NeedLoginError('jwfw')).hint).toContain('`fdu login`');
  });
});
