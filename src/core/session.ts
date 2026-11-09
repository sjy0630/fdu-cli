import { chromium, request, type APIRequestContext, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { FduError } from './errors';
import { isUisLoginUrl, NeedLoginError, type FudanPlatform } from './fudan-auth';
import type { CampusReader } from './types';
import type { Store } from './store';

export type StorageState = Awaited<ReturnType<APIRequestContext['storageState']>>;
export interface RawResponse { status: number; url: string; contentType: string; text: string }
/** retries：GET / HEAD 遇到网络错误或 429 / 5xx 时重试几次（默认 2；POST 等不重试） */
export interface FetchInit { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; retries?: number }

const STATE = 'state.json';
const LOGIN_LOG = 'login.json';
/** 登录记录：最近一次登录 / 导入的时间，以及之前几次登录各保持了多少小时 */
export interface LoginLog { lastLoginAt?: string; via?: string; expiredAt?: string; lastedHours?: number[] }
/**
 * 浏览器标识：后台请求、无界面浏览器、有界面浏览器都用同一个，并且和你的系统一致。
 * 有的系统（如 WebVPN）会把会话和浏览器标识绑在一起，标识对不上就要求重新登录。
 */
export function userAgent(platform: string = process.platform): string {
  const os = platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36`;
}
const UA = userAgent();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 值得重试的网络错误：超时、连接被重置、DNS 暂时解析不了 */
export function transientError(e: unknown): 'timeout' | 'network' | undefined {
  const m = String((e as Error)?.message ?? e);
  if (/timeout|timed out|ETIMEDOUT/i.test(m)) return 'timeout';
  if (/ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|other side closed|net::ERR_/i.test(m)) return 'network';
  return undefined;
}

/**
 * 启动 Chromium 的参数：root 用户（容器、虚拟机里常见）必须关掉沙箱，Linux 上 /dev/shm 常常很小；
 * FDU_CHROMIUM_ARGS 可以再补参数（空格分开）。
 */
export function chromiumArgs(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, uid: number | undefined = process.getuid?.()): string[] {
  const args: string[] = [];
  if (platform === 'linux' && uid === 0) args.push('--no-sandbox');
  if (platform === 'linux') args.push('--disable-dev-shm-usage');
  for (const a of (env.FDU_CHROMIUM_ARGS ?? '').split(/\s+/).filter(Boolean)) if (!args.includes(a)) args.push(a);
  return args;
}

/** 给一个承诺加上超时 */
export async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** 设置了 HTTPS_PROXY / HTTP_PROXY 时走代理（公司 / 实验室网络），NO_PROXY 里的地址直连 */
export function proxyFromEnv(env: NodeJS.ProcessEnv = process.env): { server: string; bypass?: string } | undefined {
  const server = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!server) return undefined;
  const bypass = env.NO_PROXY || env.no_proxy;
  return { server, ...(bypass ? { bypass } : {}) };
}

/**
 * 一个登录会话：复旦统一身份认证登录后的 Cookie，所有校内系统共用。
 *
 * - 普通请求走 Playwright 的请求接口（自动带 Cookie、跟随跳转），不需要打开浏览器；
 * - 有的系统最后一步靠页面脚本跳转（WebVPN、宿舍电量），或者内容靠脚本加载（考试安排、校园卡），
 *   这时在无界面浏览器里打开页面；
 * - 登录时打开有界面的浏览器，由你自己输入账号密码、完成二次验证。程序不读取表单、不保存密码。
 * 两者共用同一份 Cookie，用完写回 state.json（权限 600）。
 */
export class Session {
  private ctx?: APIRequestContext;
  private browser?: Browser;
  private dirty = false;
  /** 这次运行里在浏览器里拿到过 Cookie（登录过程中，还没写到 state.json） */
  private fromBrowser = false;
  /** 浏览器最后停在的地址（排查登录问题用，只取路径） */
  lastUrl = '';
  /** 上次确认 WebVPN 已登录的时间（检查要开浏览器，短时间内不重复查） */
  webvpnAliveAt?: number;
  /** 常驻的无界面浏览器页面：只认真浏览器请求的系统（WebVPN）在这里发请求 */
  private bpage?: { context: BrowserContext; page: Page };

  constructor(private readonly store: Store, private readonly opts: { browserPath?: string; headed?: boolean } = {}) {}

  hasState(): boolean { return !!this.store.readJson<StorageState>(STATE); }

  /**
   * 记下登录时间（login / import），以及发现登录过期的时间：
   * 用来回答「登录能保持多久」——学校没有公开，只能看实际情况。只记时间，不记账号。
   */
  noteLogin(via: 'login' | 'import'): void {
    const prev = this.store.readJson<LoginLog>(LOGIN_LOG) ?? {};
    this.store.writeJson(LOGIN_LOG, { ...prev, lastLoginAt: new Date().toISOString(), via });
  }

  noteExpired(): void {
    const log = this.store.readJson<LoginLog>(LOGIN_LOG);
    if (!log?.lastLoginAt || (log.expiredAt && log.expiredAt >= log.lastLoginAt)) return;
    const hours = Math.round(((Date.now() - Date.parse(log.lastLoginAt)) / 3_600_000) * 10) / 10;
    this.store.writeJson(LOGIN_LOG, { ...log, expiredAt: new Date().toISOString(), lastedHours: [hours, ...(log.lastedHours ?? [])].slice(0, 10) });
  }

  loginLog(): LoginLog | null { return this.store.readJson<LoginLog>(LOGIN_LOG); }

  private async state(): Promise<StorageState | undefined> {
    if (this.ctx) return this.ctx.storageState();
    return this.store.readJson<StorageState>(STATE) ?? undefined;
  }

  private async api(): Promise<APIRequestContext> {
    this.ctx ??= await request.newContext({ storageState: await this.state(), userAgent: UA, timeout: 20_000, proxy: proxyFromEnv() });
    return this.ctx;
  }

  /** 原样请求，不判断是否登录（公开接口、树洞等用） */
  async raw(url: string, init: FetchInit = {}): Promise<RawResponse & { body: Buffer; headers: Record<string, string> }> {
    const ctx = await this.api();
    const method = init.method ?? 'GET';
    // 只有不改变数据的请求才重试；超时本身已经等了很久，最多再试一次
    const idempotent = method === 'GET' || method === 'HEAD';
    let retries = idempotent ? init.retries ?? 2 : 0;
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await ctx.fetch(url, { method, headers: init.headers, data: init.body, maxRedirects: 20, timeout: init.timeoutMs ?? 20_000, failOnStatusCode: false });
      } catch (e) {
        const kind = transientError(e);
        if (kind === 'timeout') retries = Math.min(retries, 1);
        if (!kind || attempt >= retries) throw e;
        await sleep(800 * 2 ** attempt);
        continue;
      }
      if (attempt < retries && [429, 502, 503, 504].includes(res.status())) {
        const after = Number(res.headers()['retry-after']);
        await sleep(Number.isFinite(after) && after > 0 && after <= 10 ? after * 1000 : 800 * 2 ** attempt);
        continue;
      }
      break;
    }
    this.dirty = true;
    const body = await res.body();
    const headers = res.headers();
    return { status: res.status(), url: res.url() || url, contentType: headers['content-type'] ?? '', text: body.toString('utf8'), body, headers };
  }

  /** 校内系统的请求：被带到统一身份认证登录页时抛出 NeedLoginError */
  async fetch(platform: FudanPlatform, url: string, init: FetchInit = {}): Promise<RawResponse & { body: Buffer; headers: Record<string, string> }> {
    // 公开接口的请求也会建立请求上下文，所以不能拿「有上下文」当作「登录过」
    if (!this.hasState() && !this.fromBrowser) throw new NeedLoginError(platform);
    const res = await this.raw(url, init);
    if (isUisLoginUrl(res.url)) throw new NeedLoginError(platform, undefined, { url });
    return res;
  }

  /** 找浏览器：FDU_BROWSER 指定的路径 → 本机 Chrome → Edge → Playwright 自带的 Chromium */
  async launch(headless: boolean): Promise<Browser> {
    const path = this.opts.browserPath ?? process.env.FDU_BROWSER;
    const options = { headless: !(!headless || !!this.opts.headed), args: chromiumArgs() };
    // 依次试：指定的路径 → Chrome → Edge → Playwright 自带的 Chromium；每一种失败的原因都记下来
    const tries: [string, () => Promise<Browser>][] = path
      ? [[`FDU_BROWSER（${path}）`, () => chromium.launch({ ...options, executablePath: path })]]
      : [['Chrome', () => chromium.launch({ ...options, channel: 'chrome' })], ['Edge', () => chromium.launch({ ...options, channel: 'msedge' })], ['Playwright 自带的 Chromium', () => chromium.launch(options)]];
    const failures: string[] = [];
    for (const [name, start] of tries) {
      try { return await start(); } catch (e) {
        failures.push(`${name}：${String((e as Error).message ?? e).replace(/\u001b\[[0-9;]*m/g, '').split('\n').find((l) => l.trim() && !/^browserType\.launch/.test(l.trim()))?.trim().slice(0, 160) ?? '启动失败'}`);
      }
    }
    const missing = failures.every((f) => /Executable doesn't exist|Chromium distribution .* is not found|not found at|ENOENT/i.test(f));
    throw new FduError('NO_BROWSER', `${missing ? '没有找到 Chrome 或 Edge 浏览器' : '浏览器启动失败'}。登录和部分页面需要用浏览器打开。试过：${failures.join('；')}`,
      missing
        ? '安装 Chrome / Edge；或者设置 FDU_BROWSER 为 Chromium 内核浏览器的路径；或者运行 npx playwright install chromium。'
        : '在容器或 root 下运行时已自动加了 --no-sandbox；还需要别的启动参数时用 FDU_CHROMIUM_ARGS 补（空格分开），或用 FDU_BROWSER 换一个浏览器。');
  }

  /** 能不能启动无界面浏览器（fdu doctor 用），返回浏览器名称和版本 */
  async probeBrowser(timeoutMs = 15_000): Promise<string> {
    const launching = this.launch(true);
    // 启动卡住时不让 doctor 一起卡住；超时后启动成功的浏览器也要关掉
    const browser = await withTimeout(launching, timeoutMs, `浏览器 ${timeoutMs / 1000} 秒内没有启动起来`).catch((e) => {
      void launching.then((b) => b.close()).catch(() => undefined);
      throw e;
    });
    try {
      const path = this.opts.browserPath ?? process.env.FDU_BROWSER;
      return `${browser.browserType().name()} ${browser.version()}${path ? `（${path}）` : ''}`;
    } finally { await browser.close().catch(() => undefined); }
  }

  /**
   * 在浏览器里打开页面，直到 done(page) 返回 true；返回最后一次读到的 HTML（含同源 iframe）。
   * 页面停在统一身份认证超过 stuckOnUisMs 时：无界面模式抛出 NeedLoginError，有界面模式继续等你登录。
   */
  async withPage(url: string, done: (page: Page, html: string) => Promise<boolean> | boolean, opts: { headless: boolean; timeoutMs: number; stuckOnUisMs?: number; platform?: FudanPlatform }): Promise<string> {
    // 常驻页面里拿到的 Cookie 先合并回来，再从同一份状态开新窗口
    await this.dropBrowserPage();
    const browser = opts.headless ? (this.browser ??= await this.launch(true)) : await this.launch(false);
    const context = await browser.newContext({ storageState: await this.state(), proxy: proxyFromEnv(), userAgent: UA, viewport: opts.headless ? { width: 1280, height: 900 } : null });
    try {
      const page = await context.newPage();
      // 不允许页面弹出新窗口
      context.on('page', (p) => { if (p !== page) void p.close(); });
      void page.goto(url, { timeout: opts.timeoutMs }).catch(() => undefined);
      const deadline = Date.now() + opts.timeoutMs;
      let html = '';
      let onUisSince = 0;
      while (Date.now() < deadline) {
        await sleep(500);
        if (page.isClosed()) throw new FduError('NEED_LOGIN', '浏览器窗口被关闭了，没有完成登录。', '重新运行 `fdu login`。');
        if (isUisLoginUrl(page.url())) {
          onUisSince ||= Date.now();
          if (opts.headless && Date.now() - onUisSince > (opts.stuckOnUisMs ?? 6000)) throw new NeedLoginError(opts.platform ?? 'elearning', undefined, { url });
          continue;
        }
        onUisSince = 0;
        // 在页面里执行（字符串形式，不依赖 DOM 类型）：整页 HTML 加上同源 iframe 的内容
        html = await page.evaluate(`(() => {
          const parts = [document.documentElement.outerHTML];
          for (const f of document.querySelectorAll('iframe')) { try { if (f.contentDocument) parts.push(f.contentDocument.documentElement.outerHTML); } catch {} }
          return parts.join('\\n');
        })()`).then((v) => String(v ?? '')).catch(() => '');
        this.lastUrl = page.url();
        if (await done(page, html)) break;
      }
      // 浏览器里拿到的新 Cookie 写回会话
      const state = await context.storageState();
      // 旧的请求上下文晚一点再关，避免同时进行的请求被打断
      const old = this.ctx;
      this.ctx = await request.newContext({ storageState: state, userAgent: UA, timeout: 20_000, proxy: proxyFromEnv() });
      if (old) setTimeout(() => { void old.dispose().catch(() => undefined); }, 30_000).unref();
      this.dirty = true;
      this.fromBrowser = true;
      return html;
    } finally {
      await context.close().catch(() => undefined);
      if (!opts.headless) await browser.close().catch(() => undefined);
    }
  }

  /**
   * 打开有界面的浏览器，记录页面发出的数据请求（开发新功能时用，见 fdu dev capture）。
   * 每个请求交给 onResponse 处理（只应保留结构，不保留内容）；用户关掉窗口或超时后结束，Cookie 写回会话。
   */
  async record(url: string, onResponse: (r: { method: string; url: string; status: number; contentType: string; resourceType: string; body: () => Promise<string>; postData?: string; requestHeaders: Record<string, string> }) => Promise<void>, timeoutMs = 600_000): Promise<void> {
    const browser = await this.launch(false);
    const context = await browser.newContext({ storageState: await this.state(), proxy: proxyFromEnv(), userAgent: UA, viewport: null });
    const pending: Promise<void>[] = [];
    context.on('response', (res) => {
      const req = res.request();
      if (!['xhr', 'fetch', 'document'].includes(req.resourceType())) return;
      pending.push(onResponse({
        method: req.method(), url: res.url(), status: res.status(), contentType: res.headers()['content-type'] ?? '', resourceType: req.resourceType(),
        body: () => res.text(), postData: req.postData() ?? undefined, requestHeaders: req.headers(),
      }).catch(() => undefined));
    });
    try {
      const page = await context.newPage();
      void page.goto(url, { timeout: 60_000 }).catch(() => undefined);
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        new Promise<void>((resolve) => { context.on('close', () => resolve()); browser.on('disconnected', () => resolve()); page.on('close', () => resolve()); }),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
      // 清掉计时器，否则窗口关了命令也要等到超时才退出
      clearTimeout(timer);
      await Promise.all(pending);
      if (browser.isConnected()) {
        const state = await context.storageState().catch(() => undefined);
        if (state && (this.hasState() || this.fromBrowser)) {
          const old = this.ctx;
          this.ctx = await request.newContext({ storageState: state, userAgent: UA, timeout: 20_000, proxy: proxyFromEnv() });
          this.dirty = true;
          if (old) setTimeout(() => { void old.dispose().catch(() => undefined); }, 30_000).unref();
        }
      }
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  /** 页面脚本渲染完再读（只读页面内容，不点击、不提交） */
  async render(platform: FudanPlatform, url: string, ready: (html: string, url: string) => boolean, timeoutMs = 25_000): Promise<string> {
    let ok = false;
    const html = await this.withPage(url, (page, h) => (ok = ready(h, page.url())), { headless: true, timeoutMs, platform });
    if (!ok && !html) throw new FduError('UPSTREAM', '页面没有加载出来，请稍后再试。');
    return html;
  }

  /** 校内系统的读取接口（给各服务模块用） */
  reader(platform: FudanPlatform): CampusReader {
    return {
      getText: async (url, init) => {
        const r = await this.fetch(platform, url, init);
        return { url: r.url, status: r.status, text: r.text };
      },
      render: (url, ready) => this.render(platform, url, ready),
    };
  }

  /**
   * 常驻的无界面浏览器页面，停在 origin 下（同源请求才带得上 Cookie）。
   * WebVPN 只认真正的浏览器发出的请求：后台请求带着同样的 Cookie 也会被带回登录页。
   */
  async browserPage(origin: string): Promise<Page> {
    if (!this.bpage) {
      const browser = this.browser ??= await this.launch(true);
      const context = await browser.newContext({ storageState: await this.state(), proxy: proxyFromEnv(), userAgent: UA, viewport: { width: 1280, height: 900 } });
      this.bpage = { context, page: await context.newPage() };
    }
    const { page } = this.bpage;
    let current = '';
    try { current = new URL(page.url()).origin; } catch { /* about:blank */ }
    if (current !== new URL(origin).origin) await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    return page;
  }

  /** 在常驻浏览器页面里发请求（同源），返回和 raw 一样的结果 */
  async browserFetch(url: string, init: FetchInit = {}): Promise<RawResponse> {
    const page = await this.browserPage(new URL(url).origin);
    const run = () => page.evaluate(async ([u, method, headers, body, ms]) => {
      const res = await fetch(u as string, { method: method as string, headers: headers as Record<string, string>, body: (body as string) || undefined, credentials: 'include', redirect: 'follow', signal: AbortSignal.timeout(ms as number) });
      return { status: res.status, url: res.url, contentType: res.headers.get('content-type') ?? '', text: await res.text() };
    }, [url, init.method ?? 'GET', init.headers ?? {}, init.body ?? '', init.timeoutMs ?? 20_000] as const);
    let r: RawResponse | undefined;
    // 页面自己还在跳转（比如 WebVPN 首页的脚本跳转）时请求会被打断：等页面稳定后重试
    for (let attempt = 0; !r; attempt++) {
      try { r = await run(); } catch (e) {
        if (attempt >= 3 || !/Execution context was destroyed|navigat/i.test(String((e as Error).message))) throw e;
        await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => undefined);
        await sleep(300);
      }
    }
    this.dirty = true;
    return r;
  }

  /** 常驻页面里拿到的 Cookie 合并回会话，然后关掉它 */
  private async dropBrowserPage(): Promise<void> {
    const b = this.bpage;
    if (!b) return;
    this.bpage = undefined;
    try {
      const state = await b.context.storageState();
      const old = this.ctx;
      this.ctx = await request.newContext({ storageState: state, userAgent: UA, timeout: 20_000, proxy: proxyFromEnv() });
      this.dirty = true;
      if (old) setTimeout(() => { void old.dispose().catch(() => undefined); }, 30_000).unref();
    } catch { /* 浏览器已经关了 */ }
    await b.context.close().catch(() => undefined);
  }

  /** 只在登录过（已有 state.json，或这次在浏览器里登录了）时写回；只访问公开接口不产生登录状态 */
  async save(): Promise<void> {
    if (!this.ctx || !this.dirty || (!this.hasState() && !this.fromBrowser)) return;
    this.store.writeJson(STATE, await this.ctx.storageState());
    this.dirty = false;
  }

  /** 删除本地登录状态 */
  clear(): boolean {
    this.dirty = false;
    this.fromBrowser = false;
    const old = this.ctx;
    this.ctx = undefined;
    void old?.dispose().catch(() => undefined);
    return this.store.remove(STATE);
  }

  /** 保存 Cookie 并关掉无界面浏览器（MCP 服务每次调用后用，下次需要时再开） */
  async release(): Promise<void> {
    await this.dropBrowserPage();
    await this.save().catch(() => undefined);
    const browser = this.browser;
    this.browser = undefined;
    await browser?.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.dropBrowserPage();
    await this.save().catch(() => undefined);
    await this.ctx?.dispose().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.ctx = undefined;
    this.browser = undefined;
  }
}
