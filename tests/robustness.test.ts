import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromiumArgs, Session, transientError, withTimeout } from '../src/core/session';
import { Store } from '../src/core/store';
import { mcpShape } from '../src/mcp';
import { findOp, runLoginTask, type Ctx } from '../src/ops';
import { runOp } from '../src/run';
import { NeedLoginError } from '../src/core/fudan-auth';

/** 在容器、root、代理、被 agent 调用这些环境下也能用 */

describe('浏览器启动参数', () => {
  it('Linux 的 root 用户关掉沙箱；Linux 上不用 /dev/shm；FDU_CHROMIUM_ARGS 可以补充', () => {
    expect(chromiumArgs({}, 'linux', 0)).toEqual(['--no-sandbox', '--disable-dev-shm-usage']);
    expect(chromiumArgs({}, 'linux', 1000)).toEqual(['--disable-dev-shm-usage']);
    expect(chromiumArgs({}, 'darwin', 501)).toEqual([]);
    expect(chromiumArgs({ FDU_CHROMIUM_ARGS: '--no-sandbox  --lang=zh-CN' }, 'darwin', 501)).toEqual(['--no-sandbox', '--lang=zh-CN']);
    expect(chromiumArgs({ FDU_CHROMIUM_ARGS: '--no-sandbox' }, 'linux', 0)).toEqual(['--no-sandbox', '--disable-dev-shm-usage']);
  });

  it('超时包装', async () => {
    await expect(withTimeout(new Promise(() => undefined), 20, '太慢了')).rejects.toThrow('太慢了');
    expect(await withTimeout(Promise.resolve(1), 1000, 'x')).toBe(1);
  });
});

describe('请求重试', () => {
  let server: Server;
  let base = '';
  const hits: Record<string, number> = {};
  beforeAll(async () => {
    server = createServer((req, res) => {
      const key = `${req.method} ${req.url}`;
      hits[key] = (hits[key] ?? 0) + 1;
      // 前两次 503，第三次正常
      if (req.url === '/flaky' && hits[key] <= 2) { res.writeHead(503, { 'Retry-After': '0' }); res.end(); return; }
      if (req.url === '/down') { res.writeHead(503); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server.close(); });
  const session = () => { process.env.FDU_HOME = mkdtempSync(join(tmpdir(), 'fdu-')); return new Session(new Store()); };

  it('GET 遇到 503 退避重试，最终拿到结果', async () => {
    const r = await session().raw(`${base}/flaky`);
    expect(r).toMatchObject({ status: 200, text: 'ok' });
    expect(hits['GET /flaky']).toBe(3);
  }, 15_000);

  it('POST 不重试；重试次数用完时返回最后的结果', async () => {
    const s = session();
    expect((await s.raw(`${base}/down`, { method: 'POST' })).status).toBe(503);
    expect(hits['POST /down']).toBe(1);
    expect((await s.raw(`${base}/down`, { retries: 1 })).status).toBe(503);
    expect(hits['GET /down']).toBe(2);
  }, 15_000);

  it('区分值得重试的网络错误', () => {
    expect(transientError(new Error('apiRequestContext.fetch: Timeout 20000ms exceeded.'))).toBe('timeout');
    expect(transientError(new Error('read ECONNRESET'))).toBe('network');
    expect(transientError(new Error('getaddrinfo EAI_AGAIN id.fudan.edu.cn'))).toBe('network');
    expect(transientError(new TypeError('Cannot read properties of undefined'))).toBeUndefined();
  });
});

describe('MCP 里登录不阻塞', () => {
  it('等不到用户时先返回 pending，登录在后台继续；之后再来的调用接着等同一个登录', async () => {
    let finish!: (v: boolean) => void;
    const login = new Promise<boolean>((r) => { finish = r; });
    const ctx = { session: {}, waitMs: 30 } as unknown as Ctx;
    let started = 0;
    expect(await runLoginTask(ctx, () => { started++; return login; })).toBe('pending');
    finish(true);
    expect(await runLoginTask(ctx, () => { started++; return Promise.resolve(false); })).toBe(true);
    expect(started).toBe(1);
  });

  it('查询遇到需要登录、登录还在等用户时，返回说明而不是卡住', async () => {
    const op = { name: 't.read', summary: 'test op', login: 'uis' as const, effect: 'read' as const, params: {}, run: async () => { throw new NeedLoginError('jwfw'); } };
    const r = await runOp(op, { relogin: async () => 'pending' } as unknown as Ctx, {});
    expect(r).toMatchObject({ ok: false, error: { code: 'NEED_LOGIN', message: expect.stringContaining('登录窗口') } });
  });

  it('MCP 里看不到会丢登录状态的 force', () => {
    expect(Object.keys(mcpShape(findOp('auth.login')!))).toEqual(['webvpn', 'url']);
  });
});

describe('错误分类', async () => {
  const { toFduError } = await import('../src/core/errors');
  it('解析出错归为页面改版，不让用户去查网络', () => {
    expect(toFduError(new TypeError("Cannot read properties of undefined (reading 'data')")).code).toBe('FORMAT_CHANGED');
    expect(toFduError(new SyntaxError('Unexpected token < in JSON at position 0')).code).toBe('FORMAT_CHANGED');
    expect(toFduError(new Error('没有在校园卡页面上找到余额，学校页面可能更新了。')).code).toBe('FORMAT_CHANGED');
    expect(toFduError(new Error('没有在校园卡页面上找到余额，学校页面可能更新了。')).hint).toContain('不是网络问题');
  });
  it('网络问题仍是 UPSTREAM（包括 Node fetch 失败的 TypeError）', () => {
    expect(toFduError(new TypeError('fetch failed')).code).toBe('UPSTREAM');
    expect(toFduError(new Error('apiRequestContext.get: Timeout 20000ms exceeded.')).code).toBe('UPSTREAM');
    expect(toFduError(new Error('校车系统：系统维护')).code).toBe('UPSTREAM');
  });
  it('runOp 写上是哪个命令解析出错', async () => {
    const op = { name: 'x.parse', summary: 'test op', login: 'none' as const, effect: 'read' as const, params: {}, run: async () => { throw new TypeError('bad'); } };
    expect(await runOp(op, {} as Ctx, {})).toMatchObject({ ok: false, error: { code: 'FORMAT_CHANGED', message: expect.stringContaining('x.parse') } });
  });
});

describe('缓存有效期', async () => {
  const { Cache } = await import('../src/core/cache');
  const { cacheTtl } = await import('../src/run');
  it('过期的缓存当作没有并删掉；隐私数据和实时数据有效期更短', () => {
    process.env.FDU_HOME = mkdtempSync(join(tmpdir(), 'fdu-'));
    const cache = new Cache(new Store());
    cache.set('jw.grades', {}, { gpa: 3.9 }, 0);
    expect(cache.get('jw.grades', {}, 3_600_000, 1000)).not.toBeNull();
    expect(cache.get('jw.grades', {}, 3_600_000, 3_600_001)).toBeNull();
    expect(cache.get('jw.grades', {}, 3_600_000, 0)).toBeNull();
    expect(cacheTtl(findOp('jw.grades')!)).toBe(24 * 3_600_000);
    expect(cacheTtl(findOp('canteen.crowd')!)).toBe(30 * 60_000);
    expect(cacheTtl(findOp('jw.timetable')!)).toBe(7 * 24 * 3_600_000);
  });
});

describe('doctor 检查登录文件权限', async () => {
  const { runDoctor } = await import('../src/services/doctor');
  it('其他用户能读 mail.json 时提醒', async () => {
    const r = await runDoctor({
      nodeVersion: 'v22.0.0', platform: 'linux', configDir: '/cfg', configDirState: () => ({ writable: true, mode: 0o700 }),
      secretFiles: () => [{ name: 'state.json', mode: 0o600 }, { name: 'mail.json', mode: 0o644 }],
      browser: async () => 'chromium', reach: async (url) => ({ status: 200, url }),
      login: async () => ({ hasState: false, elearning: 'need_login', jwfw: 'need_login', webvpn: false }), treehole: false, mail: true,
    });
    const c = r.checks.find((x) => x.name === '登录文件权限');
    expect(c).toMatchObject({ status: 'warn', detail: expect.stringContaining('mail.json（644）'), fix: expect.stringContaining('chmod 600') });
    expect(c!.detail).not.toContain('state.json');
  });
});
