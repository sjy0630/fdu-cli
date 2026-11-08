import { chromium, request, type APIRequestContext, type Browser, type Page } from 'playwright-core';
import { FduError } from './errors';
import { isUisLoginUrl, NeedLoginError, type FudanPlatform } from './fudan-auth';
import type { CampusReader } from './types';
import type { Store } from './store';

export type StorageState = Awaited<ReturnType<APIRequestContext['storageState']>>;
export interface RawResponse { status: number; url: string; contentType: string; text: string }
export interface FetchInit { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }

const STATE = 'state.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 fdu-cli';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  constructor(private readonly store: Store, private readonly opts: { browserPath?: string; headed?: boolean } = {}) {}

  hasState(): boolean { return !!this.store.readJson<StorageState>(STATE); }

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
    const res = await ctx.fetch(url, {
      method: init.method ?? 'GET', headers: init.headers, data: init.body, maxRedirects: 20,
      timeout: init.timeoutMs ?? 20_000, failOnStatusCode: false,
    });
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
    if (isUisLoginUrl(res.url)) throw new NeedLoginError(platform);
    return res;
  }

  /** 找浏览器：FDU_BROWSER 指定的路径 → 本机 Chrome → Edge → Playwright 自带的 Chromium */
  async launch(headless: boolean): Promise<Browser> {
    const path = this.opts.browserPath ?? process.env.FDU_BROWSER;
    const headed = !headless || !!this.opts.headed;
    if (path) return chromium.launch({ executablePath: path, headless: !headed });
    for (const channel of ['chrome', 'msedge']) {
      try { return await chromium.launch({ channel, headless: !headed }); } catch { /* 没装这个浏览器 */ }
    }
    try { return await chromium.launch({ headless: !headed }); } catch { /* 也没有 Playwright 的 Chromium */ }
    throw new FduError('NO_BROWSER', '没有找到 Chrome 或 Edge 浏览器。登录和部分页面需要用浏览器打开。',
      '安装 Chrome / Edge，或者设置环境变量 FDU_BROWSER 为 Chromium 内核浏览器的可执行文件路径。');
  }

  /** 能不能启动无界面浏览器（fdu doctor 用），返回浏览器名称和版本 */
  async probeBrowser(): Promise<string> {
    const browser = await this.launch(true);
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
    const browser = opts.headless ? (this.browser ??= await this.launch(true)) : await this.launch(false);
    const context = await browser.newContext({ storageState: await this.state(), proxy: proxyFromEnv(), userAgent: opts.headless ? UA : undefined, viewport: opts.headless ? { width: 1280, height: 900 } : null });
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
          if (opts.headless && Date.now() - onUisSince > (opts.stuckOnUisMs ?? 6000)) throw new NeedLoginError(opts.platform ?? 'elearning');
          continue;
        }
        onUisSince = 0;
        // 在页面里执行（字符串形式，不依赖 DOM 类型）：整页 HTML 加上同源 iframe 的内容
        html = await page.evaluate(`(() => {
          const parts = [document.documentElement.outerHTML];
          for (const f of document.querySelectorAll('iframe')) { try { if (f.contentDocument) parts.push(f.contentDocument.documentElement.outerHTML); } catch {} }
          return parts.join('\\n');
        })()`).then((v) => String(v ?? '')).catch(() => '');
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
    await this.save().catch(() => undefined);
    const browser = this.browser;
    this.browser = undefined;
    await browser?.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.save().catch(() => undefined);
    await this.ctx?.dispose().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.ctx = undefined;
    this.browser = undefined;
  }
}
