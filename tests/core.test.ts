import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { main, parseArgs, resolveOpName } from '../src/cli';
import { NeedLoginError } from '../src/core/fudan-auth';
import { proxyFromEnv, Session } from '../src/core/session';
import { Store } from '../src/core/store';
import { buildServer, mcpShape, toolDescription } from '../src/mcp';
import { findOp, OPS, safeTarget, type Ctx } from '../src/ops';
import { exitCode, runOp } from '../src/run';

const tmp = () => mkdtempSync(join(tmpdir(), 'fdu-test-'));
const BROWSER = ['/opt/pw-browsers/chromium', process.env.FDU_BROWSER].find((p) => p && existsSync(p));

// 测试只连本机服务，不走环境里的代理
const saved: Record<string, string | undefined> = {};
beforeAll(() => { for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) { saved[k] = process.env[k]; delete process.env[k]; } });
afterAll(() => { for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v; });

describe('命令行参数', () => {
  it('--key value、--key=value、--flag、简写', () => {
    expect(parseArgs(['jw', 'grades', '--semester', '2026', '--compact', '--days=7'])).toEqual({ positionals: ['jw', 'grades'], flags: { semester: '2026', compact: true, days: '7' } });
    expect(resolveOpName(['login'])).toEqual({ name: 'auth.login', rest: [] });
    expect(resolveOpName(['jw', 'grades'])).toEqual({ name: 'jw.grades', rest: [] });
    expect(resolveOpName(['jw.grades', 'extra'])).toEqual({ name: 'jw.grades', rest: ['extra'] });
  });

  it('输出 JSON；参数错误退出码 2，没登录退出码 3', async () => {
    process.env.FDU_HOME = tmp();
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
    try {
      expect(await main(['services', '--compact'])).toBe(0);
      expect(JSON.parse(out.pop()!).data.length).toBe(OPS.length);
      expect(await main(['describe', 'jw', 'gpa'])).toBe(0);
      expect(JSON.parse(out.pop()!).data.params[0].flag).toBe('--student-number');
      expect(await main(['jw', 'timetable', '--semster', 'x'])).toBe(2);
      expect(JSON.parse(out.pop()!).error.message).toContain('--semster');
      expect(await main(['jw', 'grades'])).toBe(3);
      expect(JSON.parse(out.pop()!).error).toMatchObject({ code: 'NEED_LOGIN', hint: expect.stringContaining('fdu login') });
      expect(await main(['nope'])).toBe(2);
    } finally { spy.mockRestore(); }
  });
});

describe('操作表', () => {
  it('名字唯一，都有说明；隐私数据标了 sensitive', () => {
    expect(new Set(OPS.map((o) => o.name)).size).toBe(OPS.length);
    for (const o of OPS) {
      expect(o.name).toMatch(/^[a-z]+\.[a-z]+$/);
      expect(o.summary.length).toBeGreaterThan(5);
    }
    expect(OPS.filter((o) => o.sensitive).map((o) => o.name).sort()).toEqual(['card.transactions', 'jw.gpa', 'jw.grades', 'jw.program', 'mail.list', 'mail.read']);
  });

  it('需要在终端输入密码的、删除本地状态的不开放给 MCP；其余都能生成参数表', () => {
    const hidden = OPS.filter((o) => o.mcp === false).map((o) => o.name).sort();
    expect(hidden).toEqual(['auth.logout', 'cache.clear', 'hole.login', 'hole.logout', 'mail.forget', 'mail.setup']);
    for (const o of OPS) expect(() => z.toJSONSchema(z.object(mcpShape(o)))).not.toThrow();
    expect(toolDescription(findOp('jw.grades')!)).toContain('隐私');
  });

  it('参数校验：类型转换、开关、不认识的参数', async () => {
    const op = { name: 't.t', summary: 'test op', login: 'none' as const, effect: 'read' as const, params: findOp('elearning.assignments')!.params, run: async (_: Ctx, a: unknown) => a };
    const ctx = {} as Ctx;
    expect(await runOp(op, ctx, { pending: 'true' })).toMatchObject({ ok: true, data: { pending: true } });
    expect(await runOp(op, ctx, { pending: true, course: '数据结构' })).toMatchObject({ ok: true, data: { course: '数据结构', pending: true } });
    const bad = await runOp(op, ctx, { pendng: true });
    expect(bad).toMatchObject({ ok: false, error: { code: 'BAD_ARGS' } });
    expect(exitCode(bad)).toBe(2);
    const days = await runOp({ ...op, params: findOp('elearning.todo')!.params }, ctx, { days: '7' });
    expect(days).toMatchObject({ ok: true, data: { days: 7 } });
  });

  it('MCP：列出工具；出错时 isError 并带上错误码和提示', async () => {
    const store = new Store('mcp-test');
    process.env.FDU_HOME = tmp();
    const session = new Session(new Store());
    const server = buildServer(session, store);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(b);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(OPS.filter((o) => o.mcp !== false).length);
    expect(tools.find((t) => t.name === 'jw_grades')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'elearning_download')?.annotations?.readOnlyHint).toBe(false);
    const r = await client.callTool({ name: 'jw_grades', arguments: {} });
    expect(r.isError).toBe(true);
    expect(JSON.parse((r.content as { text: string }[])[0].text)).toMatchObject({ code: 'NEED_LOGIN' });
    await client.close();
    await session.close();
  });
});

describe('本地文件', () => {
  it('配置目录 700、文件 600；写入是原子的', () => {
    process.env.FDU_HOME = tmp();
    const store = new Store('p1');
    store.writeJson('x.json', { a: 1 });
    expect(store.readJson('x.json')).toEqual({ a: 1 });
    if (process.platform !== 'win32') {
      expect(statSync(store.path('x.json')).mode & 0o777).toBe(0o600);
      expect(statSync(store.dir).mode & 0o777).toBe(0o700);
    }
    expect(() => new Store('../evil')).toThrow();
  });

  it('下载的文件不覆盖已有文件，文件名里的路径被去掉', () => {
    const dir = tmp();
    writeFileSync(join(dir, '第5讲.pdf'), 'old');
    expect(safeTarget(dir, '第5讲.pdf')).toBe(join(dir, '第5讲 (1).pdf'));
    expect(safeTarget(dir, '../../etc/passwd')).toBe(join(dir, 'passwd'));
    expect(safeTarget(dir, 'a:b?.txt')).toBe(join(dir, 'a_b_.txt'));
    expect(safeTarget(dir, '..\\..\\x.pdf')).toBe(join(dir, 'x.pdf'));
    expect(safeTarget(dir, 'CON.txt')).toBe(join(dir, '_CON.txt'));
    expect(safeTarget(dir, 'notes. ')).toBe(join(dir, 'notes'));
  });

  it('代理：HTTPS_PROXY / NO_PROXY', () => {
    expect(proxyFromEnv({})).toBeUndefined();
    expect(proxyFromEnv({ HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost' })).toEqual({ server: 'http://127.0.0.1:7890', bypass: 'localhost' });
  });
});

describe('会话', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/set') { res.writeHead(302, { 'Set-Cookie': 'a=1; Path=/', Location: '/echo' }); res.end(); return; }
      if (req.url === '/echo') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(`cookie=${req.headers.cookie ?? ''}`); return; }
      if (req.url === '/js') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><div id="app">loading</div><script>setTimeout(() => { document.cookie = "b=2; path=/"; document.getElementById("app").innerHTML = "<p>ready</p>"; }, 300);</script></body></html>');
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('跟随跳转并带上 Cookie；只访问过公开接口时不保存登录状态', async () => {
    process.env.FDU_HOME = tmp();
    const store = new Store();
    const s = new Session(store);
    const r = await s.raw(`${base}/set`);
    expect(r.url).toBe(`${base}/echo`);
    expect(r.text).toBe('cookie=a=1');
    await s.close();
    expect(existsSync(store.path('state.json'))).toBe(false);
  });

  it('没有登录状态时，校内系统请求直接要求登录', async () => {
    process.env.FDU_HOME = tmp();
    const s = new Session(new Store());
    await expect(s.fetch('jwfw', `${base}/echo`)).rejects.toBeInstanceOf(NeedLoginError);
    await s.close();
  });

  it('登录过的会话：新 Cookie 写回 state.json（权限 600）', async () => {
    process.env.FDU_HOME = tmp();
    const store = new Store();
    store.writeJson('state.json', { cookies: [], origins: [] });
    const s = new Session(store);
    await s.fetch('jwfw', `${base}/set`);
    await s.close();
    const state = JSON.parse(readFileSync(store.path('state.json'), 'utf8')) as { cookies: { name: string }[] };
    expect(state.cookies.map((c) => c.name)).toContain('a');
  });

  it.skipIf(!BROWSER)('页面靠脚本加载时在无界面浏览器里渲染；浏览器里拿到的 Cookie 后续请求也能用', async () => {
    process.env.FDU_HOME = tmp();
    const store = new Store();
    store.writeJson('state.json', { cookies: [], origins: [] });
    const s = new Session(store, { browserPath: BROWSER });
    const html = await s.render('jwfw', `${base}/js`, (h) => h.includes('<p>ready</p>'), 15_000);
    expect(html).toContain('<p>ready</p>');
    expect((await s.raw(`${base}/echo`)).text).toContain('b=2');
    await s.close();
  }, 30_000);
});

describe('文档', () => {
  it('skills/fdu-cli/reference.md 是最新的（改了命令请运行 npm run docs）', async () => {
    const { referenceMarkdown } = await import('../src/reference');
    // Windows 上签出时换行可能被改成 CRLF，比较内容时忽略换行符差异
    expect(readFileSync(new URL('../skills/fdu-cli/reference.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n')).toBe(referenceMarkdown());
  });
});
