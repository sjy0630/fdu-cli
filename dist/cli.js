#!/usr/bin/env node

// src/cli.ts
import { createInterface } from "node:readline";

// src/core/session.ts
import { chromium, request } from "playwright-core";

// src/core/fudan-auth.ts
var NeedLoginError = class extends Error {
  constructor(platform, message = "\u590D\u65E6\u8D26\u53F7\u767B\u5F55\u5DF2\u8FC7\u671F\uFF0C\u9700\u8981\u91CD\u65B0\u767B\u5F55") {
    super(message);
    this.platform = platform;
    this.name = "NeedLoginError";
  }
  platform;
};
var PLATFORM_URLS = {
  elearning: { base: "https://elearning.fudan.edu.cn", entry: "https://elearning.fudan.edu.cn/" },
  icourse: { base: "https://icourse.fudan.edu.cn", entry: "https://icourse.fudan.edu.cn/" },
  jwfw: { base: "https://fdjwgl.fudan.edu.cn", entry: "https://fdjwgl.fudan.edu.cn/" }
};
var UIS_HOSTS = ["id.fudan.edu.cn", "uis.fudan.edu.cn"];
async function isPermissionDenied(res) {
  if (res.status !== 401) return false;
  try {
    const body3 = await res.clone().json();
    if (body3?.status === "unauthorized") return true;
    if (body3?.status === "unauthenticated") return false;
    return (body3?.errors ?? []).some((e) => typeof e?.message === "string" && /not authorized to perform/i.test(e.message));
  } catch {
    return false;
  }
}
function isUisLoginUrl(url) {
  try {
    return UIS_HOSTS.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

// src/core/errors.ts
var FduError = class extends Error {
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.name = "FduError";
  }
  code;
  hint;
};
function redact(s) {
  return s.replace(/([\w-]*(?:token|csrf|session|cookie|ticket|auth|key|sid)[\w-]*)=([^;\s"',&]+)/gi, "$1=***").replace(/[A-Za-z0-9%+/_-]{32,}={0,2}/g, "***");
}
function toFduError(e) {
  if (e instanceof FduError) return e;
  if (e instanceof NeedLoginError) return new FduError("NEED_LOGIN", "\u590D\u65E6\u8D26\u53F7\u6CA1\u6709\u767B\u5F55\u6216\u767B\u5F55\u5DF2\u8FC7\u671F\u3002", "\u8FD0\u884C `fdu login`\uFF0C\u5728\u5F39\u51FA\u7684\u6D4F\u89C8\u5668\u91CC\u767B\u5F55\u590D\u65E6\u7EDF\u4E00\u8EAB\u4EFD\u8BA4\u8BC1\u3002");
  const err = e;
  const message = redact(String(err?.message ?? e).replace(/\u001b\[[0-9;]*m/g, "").split(/\nCall log:|\n/)[0].replace(/^apiRequestContext\.\w+:\s*/, ""));
  if (err?.name === "TreeholeLoginError") return new FduError("NEED_HOLE_LOGIN", "\u9700\u8981\u767B\u5F55\u6811\u6D1E\u8D26\u53F7\u3002", "\u8FD0\u884C `fdu hole login --email \u5B66\u53F7@m.fudan.edu.cn`\uFF08\u5BC6\u7801\u53EA\u7528\u6765\u6362\u53D6\u4EE4\u724C\uFF0C\u4E0D\u4FDD\u5B58\uFF09\u3002");
  if (err?.name === "TimetableFormatError") return new FduError("FORMAT_CHANGED", message);
  if (err?.status === 403) return new FduError("PERMISSION", message);
  if (/timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN|net::/i.test(message)) {
    return new FduError("UPSTREAM", `\u8FDE\u4E0D\u4E0A\u5B66\u6821\u7CFB\u7EDF\uFF1A${message.slice(0, 160)}`, "\u68C0\u67E5\u7F51\u7EDC\uFF1B\u90E8\u5206\u7CFB\u7EDF\u53EA\u5141\u8BB8\u6821\u56ED\u7F51\u8BBF\u95EE\uFF0C\u6821\u5916\u8BF7\u5148\u8FDE\u5B66\u6821 VPN\u3002");
  }
  return new FduError("UPSTREAM", message.slice(0, 400));
}

// src/core/session.ts
var STATE = "state.json";
function userAgent(platform = process.platform) {
  const os = platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" : platform === "win32" ? "Windows NT 10.0; Win64; x64" : "X11; Linux x86_64";
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36`;
}
var UA = userAgent();
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function proxyFromEnv(env = process.env) {
  const server = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!server) return void 0;
  const bypass = env.NO_PROXY || env.no_proxy;
  return { server, ...bypass ? { bypass } : {} };
}
var Session = class {
  constructor(store, opts = {}) {
    this.store = store;
    this.opts = opts;
  }
  store;
  opts;
  ctx;
  browser;
  dirty = false;
  /** 这次运行里在浏览器里拿到过 Cookie（登录过程中，还没写到 state.json） */
  fromBrowser = false;
  /** 浏览器最后停在的地址（排查登录问题用，只取路径） */
  lastUrl = "";
  hasState() {
    return !!this.store.readJson(STATE);
  }
  async state() {
    if (this.ctx) return this.ctx.storageState();
    return this.store.readJson(STATE) ?? void 0;
  }
  async api() {
    this.ctx ??= await request.newContext({ storageState: await this.state(), userAgent: UA, timeout: 2e4, proxy: proxyFromEnv() });
    return this.ctx;
  }
  /** 原样请求，不判断是否登录（公开接口、树洞等用） */
  async raw(url, init = {}) {
    const ctx = await this.api();
    const res = await ctx.fetch(url, {
      method: init.method ?? "GET",
      headers: init.headers,
      data: init.body,
      maxRedirects: 20,
      timeout: init.timeoutMs ?? 2e4,
      failOnStatusCode: false
    });
    this.dirty = true;
    const body3 = await res.body();
    const headers = res.headers();
    return { status: res.status(), url: res.url() || url, contentType: headers["content-type"] ?? "", text: body3.toString("utf8"), body: body3, headers };
  }
  /** 校内系统的请求：被带到统一身份认证登录页时抛出 NeedLoginError */
  async fetch(platform, url, init = {}) {
    if (!this.hasState() && !this.fromBrowser) throw new NeedLoginError(platform);
    const res = await this.raw(url, init);
    if (isUisLoginUrl(res.url)) throw new NeedLoginError(platform);
    return res;
  }
  /** 找浏览器：FDU_BROWSER 指定的路径 → 本机 Chrome → Edge → Playwright 自带的 Chromium */
  async launch(headless) {
    const path = this.opts.browserPath ?? process.env.FDU_BROWSER;
    const headed = !headless || !!this.opts.headed;
    if (path) return chromium.launch({ executablePath: path, headless: !headed });
    for (const channel of ["chrome", "msedge"]) {
      try {
        return await chromium.launch({ channel, headless: !headed });
      } catch {
      }
    }
    try {
      return await chromium.launch({ headless: !headed });
    } catch {
    }
    throw new FduError(
      "NO_BROWSER",
      "\u6CA1\u6709\u627E\u5230 Chrome \u6216 Edge \u6D4F\u89C8\u5668\u3002\u767B\u5F55\u548C\u90E8\u5206\u9875\u9762\u9700\u8981\u7528\u6D4F\u89C8\u5668\u6253\u5F00\u3002",
      "\u5B89\u88C5 Chrome / Edge\uFF0C\u6216\u8005\u8BBE\u7F6E\u73AF\u5883\u53D8\u91CF FDU_BROWSER \u4E3A Chromium \u5185\u6838\u6D4F\u89C8\u5668\u7684\u53EF\u6267\u884C\u6587\u4EF6\u8DEF\u5F84\u3002"
    );
  }
  /** 能不能启动无界面浏览器（fdu doctor 用），返回浏览器名称和版本 */
  async probeBrowser() {
    const browser = await this.launch(true);
    try {
      const path = this.opts.browserPath ?? process.env.FDU_BROWSER;
      return `${browser.browserType().name()} ${browser.version()}${path ? `\uFF08${path}\uFF09` : ""}`;
    } finally {
      await browser.close().catch(() => void 0);
    }
  }
  /**
   * 在浏览器里打开页面，直到 done(page) 返回 true；返回最后一次读到的 HTML（含同源 iframe）。
   * 页面停在统一身份认证超过 stuckOnUisMs 时：无界面模式抛出 NeedLoginError，有界面模式继续等你登录。
   */
  async withPage(url, done, opts) {
    const browser = opts.headless ? this.browser ??= await this.launch(true) : await this.launch(false);
    const context = await browser.newContext({ storageState: await this.state(), proxy: proxyFromEnv(), userAgent: UA, viewport: opts.headless ? { width: 1280, height: 900 } : null });
    try {
      const page = await context.newPage();
      context.on("page", (p) => {
        if (p !== page) void p.close();
      });
      void page.goto(url, { timeout: opts.timeoutMs }).catch(() => void 0);
      const deadline = Date.now() + opts.timeoutMs;
      let html = "";
      let onUisSince = 0;
      while (Date.now() < deadline) {
        await sleep(500);
        if (page.isClosed()) throw new FduError("NEED_LOGIN", "\u6D4F\u89C8\u5668\u7A97\u53E3\u88AB\u5173\u95ED\u4E86\uFF0C\u6CA1\u6709\u5B8C\u6210\u767B\u5F55\u3002", "\u91CD\u65B0\u8FD0\u884C `fdu login`\u3002");
        if (isUisLoginUrl(page.url())) {
          onUisSince ||= Date.now();
          if (opts.headless && Date.now() - onUisSince > (opts.stuckOnUisMs ?? 6e3)) throw new NeedLoginError(opts.platform ?? "elearning");
          continue;
        }
        onUisSince = 0;
        html = await page.evaluate(`(() => {
          const parts = [document.documentElement.outerHTML];
          for (const f of document.querySelectorAll('iframe')) { try { if (f.contentDocument) parts.push(f.contentDocument.documentElement.outerHTML); } catch {} }
          return parts.join('\\n');
        })()`).then((v) => String(v ?? "")).catch(() => "");
        this.lastUrl = page.url();
        if (await done(page, html)) break;
      }
      const state = await context.storageState();
      const old = this.ctx;
      this.ctx = await request.newContext({ storageState: state, userAgent: UA, timeout: 2e4, proxy: proxyFromEnv() });
      if (old) setTimeout(() => {
        void old.dispose().catch(() => void 0);
      }, 3e4).unref();
      this.dirty = true;
      this.fromBrowser = true;
      return html;
    } finally {
      await context.close().catch(() => void 0);
      if (!opts.headless) await browser.close().catch(() => void 0);
    }
  }
  /**
   * 打开有界面的浏览器，记录页面发出的数据请求（开发新功能时用，见 fdu dev capture）。
   * 每个请求交给 onResponse 处理（只应保留结构，不保留内容）；用户关掉窗口或超时后结束，Cookie 写回会话。
   */
  async record(url, onResponse, timeoutMs = 6e5) {
    const browser = await this.launch(false);
    const context = await browser.newContext({ storageState: await this.state(), proxy: proxyFromEnv(), userAgent: UA, viewport: null });
    const pending = [];
    context.on("response", (res) => {
      const req = res.request();
      if (!["xhr", "fetch", "document"].includes(req.resourceType())) return;
      pending.push(onResponse({
        method: req.method(),
        url: res.url(),
        status: res.status(),
        contentType: res.headers()["content-type"] ?? "",
        resourceType: req.resourceType(),
        body: () => res.text(),
        postData: req.postData() ?? void 0,
        requestHeaders: req.headers()
      }).catch(() => void 0));
    });
    try {
      const page = await context.newPage();
      void page.goto(url, { timeout: 6e4 }).catch(() => void 0);
      let timer;
      await Promise.race([
        new Promise((resolve2) => {
          context.on("close", () => resolve2());
          browser.on("disconnected", () => resolve2());
          page.on("close", () => resolve2());
        }),
        new Promise((resolve2) => {
          timer = setTimeout(resolve2, timeoutMs);
        })
      ]);
      clearTimeout(timer);
      await Promise.all(pending);
      if (browser.isConnected()) {
        const state = await context.storageState().catch(() => void 0);
        if (state && (this.hasState() || this.fromBrowser)) {
          const old = this.ctx;
          this.ctx = await request.newContext({ storageState: state, userAgent: UA, timeout: 2e4, proxy: proxyFromEnv() });
          this.dirty = true;
          if (old) setTimeout(() => {
            void old.dispose().catch(() => void 0);
          }, 3e4).unref();
        }
      }
    } finally {
      await browser.close().catch(() => void 0);
    }
  }
  /** 页面脚本渲染完再读（只读页面内容，不点击、不提交） */
  async render(platform, url, ready, timeoutMs = 25e3) {
    let ok = false;
    const html = await this.withPage(url, (page, h) => ok = ready(h, page.url()), { headless: true, timeoutMs, platform });
    if (!ok && !html) throw new FduError("UPSTREAM", "\u9875\u9762\u6CA1\u6709\u52A0\u8F7D\u51FA\u6765\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002");
    return html;
  }
  /** 校内系统的读取接口（给各服务模块用） */
  reader(platform) {
    return {
      getText: async (url, init) => {
        const r = await this.fetch(platform, url, init);
        return { url: r.url, status: r.status, text: r.text };
      },
      render: (url, ready) => this.render(platform, url, ready)
    };
  }
  /** 只在登录过（已有 state.json，或这次在浏览器里登录了）时写回；只访问公开接口不产生登录状态 */
  async save() {
    if (!this.ctx || !this.dirty || !this.hasState() && !this.fromBrowser) return;
    this.store.writeJson(STATE, await this.ctx.storageState());
    this.dirty = false;
  }
  /** 删除本地登录状态 */
  clear() {
    this.dirty = false;
    this.fromBrowser = false;
    const old = this.ctx;
    this.ctx = void 0;
    void old?.dispose().catch(() => void 0);
    return this.store.remove(STATE);
  }
  /** 保存 Cookie 并关掉无界面浏览器（MCP 服务每次调用后用，下次需要时再开） */
  async release() {
    await this.save().catch(() => void 0);
    const browser = this.browser;
    this.browser = void 0;
    await browser?.close().catch(() => void 0);
  }
  async close() {
    await this.save().catch(() => void 0);
    await this.ctx?.dispose().catch(() => void 0);
    await this.browser?.close().catch(() => void 0);
    this.ctx = void 0;
    this.browser = void 0;
  }
};

// src/core/store.ts
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
function baseDir() {
  if (process.env.FDU_HOME) return process.env.FDU_HOME;
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "fdu-cli");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "fdu-cli");
}
var Store = class {
  dir;
  constructor(profile = process.env.FDU_PROFILE || "default") {
    if (!/^[\w-]{1,40}$/.test(profile)) throw new Error("profile \u53EA\u80FD\u5305\u542B\u5B57\u6BCD\u3001\u6570\u5B57\u3001\u4E0B\u5212\u7EBF\u548C\u77ED\u6A2A\u7EBF");
    this.dir = join(baseDir(), profile);
  }
  path(name) {
    return join(this.dir, name);
  }
  readJson(name) {
    const file = this.path(name);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }
  /** 先写临时文件再改名，写到一半断电也不会留下坏文件 */
  writeJson(name, value) {
    const file = this.path(name);
    mkdirSync(dirname(file), { recursive: true, mode: 448 });
    try {
      chmodSync(dirname(file), 448);
    } catch {
    }
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 384 });
    renameSync(tmp, file);
    try {
      chmodSync(file, 384);
    } catch {
    }
  }
  remove(name) {
    const file = this.path(name);
    if (!existsSync(file)) return false;
    rmSync(file, { force: true });
    return true;
  }
};

// src/core/cache.ts
import { createHash } from "node:crypto";
import { readdirSync, rmSync as rmSync2 } from "node:fs";
var DIR = "cache";
function cacheKey(op2, args) {
  const sorted = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== void 0).sort(([a], [b]) => a.localeCompare(b)));
  return createHash("sha1").update(`${op2}
${JSON.stringify(sorted)}`).digest("hex").slice(0, 24);
}
var Cache = class {
  constructor(store) {
    this.store = store;
  }
  store;
  get(op2, args) {
    const e = this.store.readJson(`${DIR}/${cacheKey(op2, args)}.json`);
    return e && e.op === op2 ? e : null;
  }
  set(op2, args, data, now = Date.now()) {
    this.store.writeJson(`${DIR}/${cacheKey(op2, args)}.json`, { op: op2, args, at: new Date(now).toISOString(), data });
  }
  clear() {
    let n = 0;
    try {
      for (const f of readdirSync(this.store.path(DIR))) {
        if (f.endsWith(".json")) {
          rmSync2(this.store.path(`${DIR}/${f}`), { force: true });
          n++;
        }
      }
    } catch {
    }
    return n;
  }
};

// src/mcp.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z as z3 } from "zod";

// src/ops.ts
import { accessSync, constants as fsConstants, existsSync as existsSync2, mkdirSync as mkdirSync2, statSync, writeFileSync as writeFileSync2 } from "node:fs";
import { basename, dirname as dirname2, extname, join as join2, resolve } from "node:path";
import { z } from "zod";

// src/core/auth.ts
var ELEARNING_SELF = `${PLATFORM_URLS.elearning.base}/api/v1/users/self`;
var JW_HOME = "https://fdjwgl.fudan.edu.cn/student/home";
var WEBVPN_HOME = "https://webvpn.fudan.edu.cn/";
var WEBVPN_CAS = "https://webvpn.fudan.edu.cn/login?cas_login=true";
function safeHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === "set-cookie") continue;
    out[k] = v.replace(/[\r\n]+/g, ", ");
  }
  return out;
}
function sessionAuth(session) {
  return {
    async fetch(platform, url, init) {
      const headers = {};
      new Headers(init?.headers).forEach((v, k) => {
        headers[k] = v;
      });
      const r = await session.fetch(platform, url, { method: init?.method, headers, body: typeof init?.body === "string" ? init.body : void 0 });
      const nullBody = [101, 204, 205, 304].includes(r.status);
      const res = new Response(nullBody ? null : new Uint8Array(r.body), { status: r.status, headers: safeHeaders(r.headers) });
      Object.defineProperty(res, "url", { value: r.url });
      if (res.status === 401 && !await isPermissionDenied(res)) throw new NeedLoginError(platform);
      return res;
    },
    status: (platform) => platformStatus(session, platform),
    async requestLogin() {
      throw new NeedLoginError("elearning");
    }
  };
}
async function elearningUser(session) {
  try {
    const r = await session.raw(ELEARNING_SELF, { headers: { Accept: "application/json" }, timeoutMs: 15e3 });
    if (isUisLoginUrl(r.url) || r.status !== 200 || !/json/.test(r.contentType)) return null;
    const user = JSON.parse(r.text);
    return user.id ? { id: user.id, name: user.name } : null;
  } catch {
    return null;
  }
}
async function platformStatus(session, platform) {
  if (!session.hasState()) return "need_login";
  try {
    if (platform === "elearning") return await elearningUser(session) ? "ok" : "need_login";
    const r = await session.raw(platform === "jwfw" ? JW_HOME : PLATFORM_URLS[platform].entry, { timeoutMs: 15e3 });
    return isUisLoginUrl(r.url) ? "need_login" : r.status < 500 ? "ok" : "unavailable";
  } catch {
    return "unavailable";
  }
}
var where = (url) => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.slice(0, 60);
  }
};
async function webvpnCheck(session) {
  try {
    const r = await session.raw(WEBVPN_HOME, { timeoutMs: 15e3 });
    const u = new URL(r.url);
    const alive = r.status < 400 && u.hostname === "webvpn.fudan.edu.cn" && !u.pathname.startsWith("/login");
    return { alive, detail: `HTTP ${r.status}\uFF0C${where(r.url)}` };
  } catch (e) {
    return { alive: false, detail: `\u8FDE\u4E0D\u4E0A\uFF1A${String(e.message ?? e).split("\n")[0].slice(0, 80)}` };
  }
}
async function webvpnAlive(session) {
  return (await webvpnCheck(session)).alive;
}
async function ensureWebvpn(session, opts = {}) {
  if (await webvpnAlive(session)) return;
  const headless = opts.headless ?? true;
  await session.withPage(WEBVPN_CAS, async (page) => {
    const u = new URL(page.url());
    return u.hostname === "webvpn.fudan.edu.cn" && !u.pathname.startsWith("/login");
  }, { headless, timeoutMs: headless ? 3e4 : 3e5, stuckOnUisMs: 6e3 });
  const check = await webvpnCheck(session);
  if (!check.alive) {
    throw new FduError("NEED_LOGIN", `\u6CA1\u80FD\u5EFA\u7ACB WebVPN \u4F1A\u8BDD\uFF08\u6D4F\u89C8\u5668\u505C\u5728 ${where(session.lastUrl) || "\u672A\u77E5"}\uFF1B\u68C0\u67E5\u7ED3\u679C\uFF1A${check.detail}\uFF09\u3002`, "\u8FD0\u884C `fdu login --webvpn`\uFF0C\u5728\u6D4F\u89C8\u5668\u91CC\u5B8C\u6210\u767B\u5F55\uFF1B\u8FD8\u662F\u4E0D\u884C\u8BF7\u628A\u8FD9\u6761\u4FE1\u606F\u53D1\u7ED9\u5F00\u53D1\u8005\u3002");
  }
}
async function login(session, opts = {}) {
  const existing = await elearningUser(session);
  let user = existing;
  if (!user) {
    opts.onWaiting?.("\u5DF2\u6253\u5F00\u6D4F\u89C8\u5668\uFF0C\u8BF7\u5728\u5B66\u6821\u7684\u767B\u5F55\u9875\u9762\u91CC\u5B8C\u6210\u767B\u5F55\uFF08\u6700\u957F\u7B49\u5F85 5 \u5206\u949F\uFF09\u2026\u2026");
    const startedAt = Date.now();
    let fellBack = false;
    await session.withPage(`${PLATFORM_URLS.elearning.base}/login/cas`, async (page) => {
      if (new URL(page.url()).origin !== PLATFORM_URLS.elearning.base) return false;
      if (!fellBack && Date.now() - startedAt > 8e3 && new URL(page.url()).pathname.startsWith("/login/cas")) {
        fellBack = true;
        await page.goto(`${PLATFORM_URLS.elearning.base}/login`).catch(() => void 0);
        return false;
      }
      try {
        const r = await page.request.get(ELEARNING_SELF, { headers: { Accept: "application/json" }, failOnStatusCode: false });
        const data = r.ok() ? await r.json() : null;
        return !!data?.id;
      } catch {
        return false;
      }
    }, { headless: false, timeoutMs: opts.timeoutMs ?? 3e5 });
    user = await elearningUser(session);
    if (!user) throw new FduError("NEED_LOGIN", "\u6CA1\u6709\u5B8C\u6210\u767B\u5F55\u3002", "\u91CD\u65B0\u8FD0\u884C `fdu login`\uFF0C\u5728\u6D4F\u89C8\u5668\u91CC\u767B\u5F55\u540E\u7B49\u7A97\u53E3\u81EA\u52A8\u5173\u95ED\u3002");
  }
  let jwfw = await platformStatus(session, "jwfw");
  if (jwfw !== "ok") {
    await session.withPage(JW_HOME, (page) => {
      const u = new URL(page.url());
      return u.hostname === "fdjwgl.fudan.edu.cn" && u.pathname.startsWith("/student/home");
    }, { headless: true, timeoutMs: 25e3, platform: "jwfw" }).catch(() => void 0);
    for (let i = 0; i < 3 && jwfw !== "ok"; i++) {
      jwfw = await platformStatus(session, "jwfw");
      if (jwfw !== "ok") await new Promise((r) => setTimeout(r, 1500));
    }
  }
  let webvpn;
  if (opts.webvpn) {
    await ensureWebvpn(session, { headless: false });
    webvpn = await webvpnAlive(session);
  }
  await session.save();
  return { elearning: user, jwfw, webvpn };
}

// src/services/academic.ts
import { load as load2 } from "cheerio";

// src/services/timetable.ts
import { load } from "cheerio";

// src/core/types.ts
function shanghai(y, mo, d, h = 0, mi = 0) {
  return new Date(Date.UTC(y, mo - 1, d, h - 8, mi)).toISOString();
}

// src/services/timetable.ts
var UNDERGRAD_TABLE_URL = "https://fdjwgl.fudan.edu.cn/student/for-std/course-table";
var POSTGRAD_TABLE_URL = "https://yjsxk.fudan.edu.cn/yjsxkapp/sys/xsxkappfudan/xsxkCourse/loadKbxx.do";
var EXAM_URL = "https://fdjwgl.fudan.edu.cn/student/for-std/exam-arrange";
var PERIOD_STARTS = ["08:00", "08:55", "09:55", "10:50", "11:45", "13:30", "14:25", "15:25", "16:20", "17:15", "18:30", "19:25", "20:20", "21:15", "22:10"];
function periodTime(start, end) {
  const s = PERIOD_STARTS[Math.max(1, Math.min(15, start)) - 1];
  const e = PERIOD_STARTS[Math.max(1, Math.min(15, end)) - 1];
  const [h, m] = e.split(":").map(Number);
  const endMin = h * 60 + m + 45;
  return { start: s, end: `${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}` };
}
var TimetableFormatError = class extends Error {
  constructor(message = "\u6559\u52A1\u7CFB\u7EDF\u8FD4\u56DE\u7684\u8BFE\u8868\u683C\u5F0F\u548C\u9884\u671F\u4E0D\u540C\uFF0C\u5B66\u6821\u9875\u9762\u53EF\u80FD\u66F4\u65B0\u4E86\u3002") {
    super(message);
    this.name = "TimetableFormatError";
  }
};
function parseSemesterPage(html) {
  const literal = html.match(/semesters\s*=\s*JSON\.parse\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*\)/s);
  if (!literal) throw new TimetableFormatError();
  const jsonText = literal[2].replace(/\\x([0-9a-f]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\u([0-9a-f]{4})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\(["'\\/])/g, "$1");
  let rows;
  try {
    rows = JSON.parse(jsonText);
  } catch {
    throw new TimetableFormatError();
  }
  if (!Array.isArray(rows) || !rows.length) throw new TimetableFormatError();
  const semesters = rows.flatMap((r) => r && /^\d+$/.test(String(r.id)) && typeof r.name === "string" ? [{ id: String(r.id), name: r.name, startDate: typeof r.startDate === "string" ? r.startDate.slice(0, 10) : void 0 }] : []);
  const $ = load(html);
  const currentId = $("#allSemesters option[selected]").attr("value") ?? $("#allSemesters option").first().attr("value") ?? semesters[0]?.id;
  return { semesters, currentId };
}
var int = (v) => typeof v === "number" || typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
function parseUndergradTable(body3) {
  let data;
  try {
    data = JSON.parse(body3);
  } catch {
    throw new TimetableFormatError();
  }
  const activities = data?.studentTableVms?.[0]?.activities;
  if (!Array.isArray(activities)) throw new TimetableFormatError();
  return activities.flatMap((a) => {
    const r = a;
    const weekday = int(r.weekday);
    const startPeriod = int(r.startUnit);
    const endPeriod = int(r.endUnit);
    if (typeof r.courseName !== "string" || !(weekday >= 1 && weekday <= 7) || !(startPeriod >= 1 && endPeriod >= startPeriod && endPeriod <= 15)) return [];
    const weeks = Array.isArray(r.weekIndexes) ? [...new Set(r.weekIndexes.map(int).filter((w) => w >= 1 && w <= 30))].sort((x, y) => x - y) : [];
    return [{
      course: r.courseName.trim(),
      weekday,
      startPeriod,
      endPeriod,
      weeks,
      teachers: Array.isArray(r.teachers) ? r.teachers.filter((t) => typeof t === "string") : [],
      location: typeof r.room === "string" && r.room.trim() ? r.room.trim() : void 0
    }];
  });
}
function parsePostgradTable(body3) {
  let data;
  try {
    data = JSON.parse(body3);
  } catch {
    throw new TimetableFormatError();
  }
  if (!Array.isArray(data?.results)) throw new TimetableFormatError();
  const rows = data.results.flatMap((x) => {
    const r = x;
    const weekday = int(r.XQ);
    const startPeriod = int(r.KSJCDM);
    const endPeriod = r.JSJCDM == null ? startPeriod : int(r.JSJCDM);
    if (typeof r.KCMC !== "string" || !(weekday >= 1 && weekday <= 7) || !(startPeriod >= 1 && endPeriod >= startPeriod && endPeriod <= 15)) return [];
    const bits = typeof r.ZCBH === "string" ? r.ZCBH : "";
    return [{
      course: r.KCMC.trim(),
      weekday,
      startPeriod,
      endPeriod,
      weeks: [...bits].flatMap((b, i) => b === "1" ? [i + 1] : []),
      teachers: typeof r.JSXM === "string" && r.JSXM.trim() ? [r.JSXM.trim()] : [],
      location: typeof r.JASMC === "string" && r.JASMC.trim() ? r.JASMC.trim() : void 0
    }];
  });
  const merged = [];
  for (const e of rows.sort((a, b) => a.weekday - b.weekday || a.startPeriod - b.startPeriod)) {
    const prev = merged.find((m) => m.course === e.course && m.weekday === e.weekday && m.location === e.location && m.endPeriod + 1 === e.startPeriod && m.weeks.join() === e.weeks.join());
    if (prev) prev.endPeriod = e.endPeriod;
    else merged.push({ ...e });
  }
  return merged;
}
var EXAM_DATE = /(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/;
function parseExamPage(html) {
  const $ = load(html);
  const exams = /* @__PURE__ */ new Map();
  $("tr").each((_i, tr) => {
    const cells = $(tr).find("td").map((_j, td) => $(td).text().replace(/\s+/g, " ").trim()).get().filter(Boolean);
    if (cells.length < 2) return;
    const joined = cells.join(" ");
    const date = EXAM_DATE.exec(joined);
    const times = [...joined.matchAll(/(?<!\d)([01]?\d|2[0-3])[:：]([0-5]\d)(?!\d)/g)];
    if (!date || !times.length) return;
    const [y, mo, d] = [+date[1], +date[2], +date[3]];
    const at = (m) => shanghai(y, mo, d, +m[1], +m[2]);
    const course = cells.find((c) => !/^\d+$/.test(c) && !EXAM_DATE.test(c) && !/\d{1,2}[:：]\d{2}/.test(c) && !/考场|地点|教室|座位|校区|楼|室|闭卷|开卷|笔试|已安排|未安排|期末|期中/.test(c) && c.length >= 2) ?? cells[0];
    const location = cells.find((c) => /考场|教室|校区|楼|室|HGX|H\d/.test(c) && !EXAM_DATE.test(c));
    const exam = { course, startsAt: at(times[0]), endsAt: times[1] ? at(times[1]) : void 0, location, timeText: `${date[0]} ${times.map((t) => t[0]).join("~")}` };
    exams.set(`${course}|${exam.startsAt}`, exam);
  });
  return [...exams.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

// src/services/academic.ts
var JW = "https://fdjwgl.fudan.edu.cn/student/for-std";
var PROGRAM_PAGE = `${JW}/program-completion-preview`;
var COURSE_SELECT_PAGE = `${JW}/course-select`;
function extractTables(html) {
  const $ = load2(html);
  const out = [];
  $("table").each((_i, table) => {
    const cell = (el) => $(el).text().replace(/\s+/g, " ").trim();
    const rows = $(table).find("tr").toArray().map((tr) => $(tr).find("th, td").toArray().map(cell));
    const nonEmpty = rows.filter((r) => r.some(Boolean));
    if (nonEmpty.length < 2) return;
    const headerIdx = nonEmpty.findIndex((r) => $(table).find("tr").eq(rows.indexOf(r)).find("th").length > 0);
    const header = nonEmpty[headerIdx >= 0 ? headerIdx : 0];
    const body3 = nonEmpty.filter((r) => r !== header).slice(0, 200);
    const caption = $(table).find("caption").text().trim() || $(table).prevAll("h1,h2,h3,h4,.title,legend").first().text().replace(/\s+/g, " ").trim() || void 0;
    out.push({ caption, header, rows: body3 });
  });
  return out;
}
function tablesToText(tables, max = 8e3) {
  return tables.map((t) => [t.caption ? `\u3010${t.caption}\u3011` : "", t.header.join(" | "), ...t.rows.map((r) => r.join(" | "))].filter(Boolean).join("\n")).join("\n\n").slice(0, max);
}
var NUM = (s) => s && /^-?\d+(\.\d+)?$/.test(s.trim()) ? Number(s) : void 0;
function summarizeProgramTables(tables) {
  const out = [];
  for (const t of tables) {
    const idx = (re) => t.header.findIndex((h) => re.test(h));
    const name = idx(/类别|模块|课程组|名称|分类/);
    const required = idx(/要求|应修|最低/);
    const earned = idx(/已(获|修|得|完成)|实修|获得/);
    const remaining = idx(/还需|差额|尚需|未完成|缺/);
    if (name < 0 || required < 0 && earned < 0) continue;
    for (const r of t.rows) {
      if (!r[name]) continue;
      out.push({ name: r[name], required: NUM(r[required]), earned: NUM(r[earned]), remaining: NUM(r[remaining]) ?? (NUM(r[required]) !== void 0 && NUM(r[earned]) !== void 0 ? Math.max(0, NUM(r[required]) - NUM(r[earned])) : void 0) });
    }
  }
  return out.slice(0, 60);
}
function flattenJson(value, prefix = "", out = [], depth = 0) {
  if (out.length > 800 || depth > 9) return out;
  if (Array.isArray(value)) value.slice(0, 150).forEach((v, i) => flattenJson(v, `${prefix}[${i}]`, out, depth + 1));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) flattenJson(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
  else if (value !== null && value !== void 0 && value !== "") out.push(`${prefix}: ${String(value).slice(0, 80)}`);
  return out;
}
function modulesFromJson(data) {
  const out = [];
  const pick = (o, re) => {
    for (const [k, v] of Object.entries(o)) if (re.test(k)) {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : void 0;
      if (n !== void 0) return n;
    }
    return void 0;
  };
  const nameOf2 = (o) => {
    for (const k of ["nameZh", "name", "typeName", "moduleName", "courseTypeName", "groupName", "title"]) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (v && typeof v === "object" && typeof v.nameZh === "string") return v.nameZh;
    }
    return void 0;
  };
  const walk = (v, depth) => {
    if (out.length >= 80 || depth > 8) return;
    if (Array.isArray(v)) {
      v.forEach((x) => walk(x, depth));
      return;
    }
    if (!v || typeof v !== "object") return;
    const o = v;
    const name = nameOf2(o);
    const required = pick(o, /^(require|required|min|need)\w*credit/i);
    const earned = pick(o, /^(passed|acquired|finished|completed|obtain|earned|got)\w*credit/i);
    const taking = pick(o, /^(taking|studying|selected|inProgress|current)\w*credit/i);
    let next = depth;
    if (name && (required !== void 0 || earned !== void 0)) {
      out.push({ name: `${"\u3000".repeat(Math.min(depth, 3))}${name}`, required, earned, remaining: required !== void 0 && earned !== void 0 ? Math.max(0, Math.round((required - earned) * 10) / 10) : void 0, ...taking !== void 0 ? { taking } : {} });
      next = depth + 1;
    }
    for (const child of Object.values(o)) if (child && typeof child === "object") walk(child, next);
  };
  walk(data, 0);
  return out;
}
async function readProgramCompletion(reader, studentId) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  let jsonFallback;
  for (const url of [`${PROGRAM_PAGE}/json/${studentId}`, `${PROGRAM_PAGE}/info/${studentId}`]) {
    try {
      const res = await reader.getText(url);
      if (res.status >= 400) continue;
      try {
        const data = JSON.parse(res.text);
        const modules2 = modulesFromJson(data);
        const result = { modules: modules2, text: flattenJson(data).join("\n").slice(0, 12e3), source: "json", updatedAt: now };
        if (modules2.length > 1) return result;
        jsonFallback = result;
        continue;
      } catch {
      }
      const tables2 = extractTables(res.text);
      if (tables2.length) return { modules: summarizeProgramTables(tables2), text: tablesToText(tables2), source: "page", updatedAt: now };
    } catch (e) {
      if (e.name === "NeedLoginError") throw e;
    }
  }
  if (!reader.render) {
    if (jsonFallback) return jsonFallback;
    throw new Error("\u6559\u52A1\u7CFB\u7EDF\u6CA1\u6709\u8FD4\u56DE\u57F9\u517B\u65B9\u6848\u5B8C\u6210\u60C5\u51B5\u3002");
  }
  const html = await reader.render(PROGRAM_PAGE, (h) => /<table/i.test(h) && /学分/.test(h)).catch(() => "");
  const tables = extractTables(html);
  if (!tables.length) {
    if (jsonFallback) return jsonFallback;
    throw new Error("\u6CA1\u6709\u5728\u6559\u52A1\u7CFB\u7EDF\u91CC\u8BFB\u5230\u57F9\u517B\u65B9\u6848\u5B8C\u6210\u60C5\u51B5\uFF08\u9875\u9762\u53EF\u80FD\u8FD8\u6CA1\u5F00\u653E\u6216\u6539\u7248\u4E86\uFF09\u3002");
  }
  const modules = summarizeProgramTables(tables);
  return { modules, text: [tablesToText(tables), jsonFallback ? `
\u3010\u6570\u636E\u63A5\u53E3\u6C47\u603B\u3011
${jsonFallback.text.slice(0, 3e3)}` : ""].join(""), source: "page", updatedAt: now };
}
var WD = ["", "\u4E00", "\u4E8C", "\u4E09", "\u56DB", "\u4E94", "\u516D", "\u65E5"];
async function readSelectedCourses(reader, which = "current") {
  const page = await reader.getText(UNDERGRAD_TABLE_URL);
  const { semesters, currentId } = parseSemesterPage(page.text);
  const curIdx = Math.max(0, semesters.findIndex((s) => s.id === currentId));
  const target = which === "current" ? semesters[curIdx] : which === "next" ? semesters[curIdx - 1] : semesters.find((s) => s.name.includes(which));
  if (!target) throw new Error(which === "next" ? "\u6559\u52A1\u7CFB\u7EDF\u91CC\u8FD8\u6CA1\u6709\u4E0B\u5B66\u671F\uFF08\u9009\u8BFE\u53EF\u80FD\u8FD8\u6CA1\u5F00\u59CB\uFF09\u3002" : `\u6CA1\u6709\u627E\u5230\u5B66\u671F\u300C${which}\u300D\u3002`);
  const data = await reader.getText(`${UNDERGRAD_TABLE_URL}/semester/${target.id}/print-data`);
  let activities = [];
  try {
    activities = JSON.parse(data.text).studentTableVms?.[0]?.activities ?? [];
  } catch {
    throw new TimetableFormatError();
  }
  const entries = parseUndergradTable(data.text);
  const creditsOf = /* @__PURE__ */ new Map();
  for (const a of activities) {
    const v = typeof a.credits === "number" ? a.credits : typeof a.credits === "string" && Number.isFinite(Number(a.credits)) ? Number(a.credits) : void 0;
    if (typeof a.courseName === "string" && v !== void 0) creditsOf.set(a.courseName.trim(), v);
  }
  const byCourse = /* @__PURE__ */ new Map();
  entries.forEach((e) => {
    const credits = creditsOf.get(e.course);
    const c = byCourse.get(e.course) ?? { course: e.course, teachers: [], credits, sessions: [] };
    for (const t of e.teachers) if (!c.teachers.includes(t)) c.teachers.push(t);
    const weeks = e.weeks.length ? `${e.weeks[0]}\u2013${e.weeks.at(-1)}\u5468` : "";
    c.sessions.push(`\u5468${WD[e.weekday]} \u7B2C${e.startPeriod}\u2013${e.endPeriod}\u8282${e.location ? ` ${e.location}` : ""}${weeks ? ` ${weeks}` : ""}`);
    byCourse.set(e.course, c);
  });
  const courses = [...byCourse.values()];
  const withCredits = courses.filter((c) => c.credits !== void 0);
  let rounds;
  if (reader.render) {
    try {
      const html = await reader.render(COURSE_SELECT_PAGE, (h) => /选课|轮次/.test(h) && !/加载中/.test(h));
      const text = load2(html)("body").text().replace(/\s+/g, " ").trim();
      const m = text.match(/.{0,40}(?:轮次|选课时间|开放时间|第[一二三四]轮).{0,200}/);
      rounds = m?.[0];
    } catch {
    }
  }
  return { semester: target.name, courses, totalCredits: withCredits.length === courses.length && courses.length ? withCredits.reduce((n, c) => n + c.credits, 0) : void 0, rounds };
}

// src/services/campus-life.ts
import { load as load3 } from "cheerio";
var LIBRARY_URL = "https://mlibrary.fudan.edu.cn/api/common/h5/getspaceseat";
var CARD_URL = "https://ecard.fudan.edu.cn/epay/myepay/index";
function parseLibrary(body3) {
  let data;
  try {
    data = JSON.parse(body3);
  } catch {
    throw new Error("\u56FE\u4E66\u9986\u63A5\u53E3\u8FD4\u56DE\u7684\u683C\u5F0F\u548C\u9884\u671F\u4E0D\u540C\u3002");
  }
  if (String(data?.code) !== "1" || !Array.isArray(data.data)) throw new Error("\u56FE\u4E66\u9986\u4EBA\u6570\u6682\u65F6\u67E5\u4E0D\u5230\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002");
  const num3 = (v) => typeof v === "number" || typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : null;
  return data.data.flatMap((x) => {
    const r = x;
    const name = typeof r.campusName === "string" ? r.campusName.trim() : "";
    if (!name) return [];
    return [{ name, inside: num3(r.inNum), remaining: num3(r.canInNumb), openTime: typeof r.libraryOpenTime === "string" && r.libraryOpenTime.trim() ? r.libraryOpenTime.trim() : void 0 }];
  });
}
async function readLibrary(post) {
  const res = await post(LIBRARY_URL);
  if (res.status >= 400) throw new Error(`\u56FE\u4E66\u9986\u63A5\u53E3\u8FD4\u56DE ${res.status}`);
  return parseLibrary(res.text);
}
function parseCardBalance(html) {
  const $ = load3(html);
  const candidates = [
    $(".payway-box-bottom-item p").first().text(),
    $('[class*="balance"]').first().text()
  ].map((t) => t.replace(/\s/g, ""));
  for (const text of candidates) {
    const m = /^(?:[¥￥]|CNY|RMB|余额[:：]?)?(-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)元?$/i.exec(text);
    if (m) return Number(m[1].replace(/,/g, ""));
  }
  throw new Error("\u6CA1\u6709\u5728\u6821\u56ED\u5361\u9875\u9762\u4E0A\u627E\u5230\u4F59\u989D\uFF0C\u5B66\u6821\u9875\u9762\u53EF\u80FD\u66F4\u65B0\u4E86\u3002");
}
async function readCardBalance(reader) {
  const ready = (html2) => /payway-box-bottom-item|balance/.test(html2);
  let html = (await reader.getText(CARD_URL)).text;
  if (!ready(html) && reader.render) html = await reader.render(CARD_URL, ready);
  return parseCardBalance(html);
}

// src/services/dorm.ts
var ZLAPP_SSO = "https://zlapp.fudan.edu.cn/a_fudanzlapp/api/sso/index?sso=1";
var ZLAPP_ELEC = "https://zlapp.fudan.edu.cn/fudanelec/wap/default/info";
function parseElectricity(body3) {
  let data;
  try {
    data = JSON.parse(body3);
  } catch {
    throw new Error("\u7535\u91CF\u7CFB\u7EDF\u8FD4\u56DE\u7684\u683C\u5F0F\u548C\u9884\u671F\u4E0D\u540C\u3002");
  }
  if (Number(data.e) !== 0 || !data.d) throw new Error(data.m ? `\u7535\u91CF\u7CFB\u7EDF\uFF1A${data.m}` : "\u7535\u91CF\u7CFB\u7EDF\u6CA1\u6709\u8FD4\u56DE\u5BBF\u820D\u4FE1\u606F\uFF08\u53EF\u80FD\u6CA1\u6709\u7ED1\u5B9A\u5BBF\u820D\uFF09\u3002");
  const d = data.d;
  const num3 = (v) => v === null || v === void 0 || v === "" ? void 0 : Number(v);
  const remaining = num3(d.fj_surplus);
  if (remaining === void 0 || !Number.isFinite(remaining)) throw new Error("\u7535\u91CF\u7CFB\u7EDF\u6CA1\u6709\u8FD4\u56DE\u5269\u4F59\u7535\u91CF\u3002");
  return {
    room: [d.xq, d.ssmc, d.fjmc].filter((x) => x !== null && x !== void 0 && x !== "").join(" "),
    remainingKwh: remaining,
    usedKwh: num3(d.fj_used),
    totalKwh: num3(d.fj_all),
    updatedAt: typeof d.fj_update_time === "string" ? d.fj_update_time : void 0
  };
}
async function readElectricity(reader) {
  const notLoggedIn = (r) => /\/uc\/wap\/login/.test(r.url) || /<html/i.test(r.text.slice(0, 300));
  await reader.getText(ZLAPP_SSO).catch(() => void 0);
  let res = await reader.getText(ZLAPP_ELEC);
  if (notLoggedIn(res) && reader.render) {
    await reader.render(ZLAPP_SSO, (_html, url) => {
      try {
        const u = new URL(url);
        return u.hostname === "zlapp.fudan.edu.cn" && !u.pathname.includes("/uc/wap/login") && !u.pathname.includes("/sso/");
      } catch {
        return false;
      }
    });
    res = await reader.getText(ZLAPP_ELEC);
  }
  if (notLoggedIn(res)) throw new NeedLoginError("jwfw");
  return parseElectricity(res.text);
}

// src/services/elearning.ts
function isAssignmentDone(a) {
  return a.submitted || !!a.markedDone;
}
var MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
var CanvasClient = class {
  constructor(auth) {
    this.auth = auth;
  }
  auth;
  base = PLATFORM_URLS.elearning.base;
  async request(url) {
    for (let attempt = 0; ; attempt++) {
      const res = await this.auth.fetch("elearning", url, { headers: { Accept: "application/json" } });
      if (isUisLoginUrl(res.url)) throw new NeedLoginError("elearning");
      if (res.status === 401) {
        if (await isPermissionDenied(res)) throw Object.assign(new Error("\u6CA1\u6709\u6743\u9650\u67E5\u770B\u8FD9\u90E8\u5206 eLearning \u5185\u5BB9"), { status: 403 });
        throw new NeedLoginError("elearning");
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        const retry = res.headers.get("retry-after");
        const seconds = retry ? Number(retry) : NaN;
        const wait = Number.isFinite(seconds) ? seconds * 1e3 : retry ? Date.parse(retry) - Date.now() : 500 * 2 ** attempt;
        if (wait > 5e3) throw new Error("eLearning \u8BF7\u6C42\u53D7\u9650\uFF0C\u8BF7\u7A0D\u540E\u518D\u540C\u6B65");
        await res.body?.cancel();
        await new Promise((resolve2) => setTimeout(resolve2, Math.max(0, Number.isFinite(wait) ? wait : 500)));
        continue;
      }
      if (!res.ok) throw Object.assign(new Error(`eLearning API \u8FD4\u56DE ${res.status}`), { status: res.status });
      return res;
    }
  }
  async get(path, params = {}) {
    const first2 = new URL(`/api/v1${path}`, this.base);
    for (const [k, v] of Object.entries(params)) {
      for (const one of Array.isArray(v) ? v : [v]) first2.searchParams.append(k, one);
    }
    first2.searchParams.set("per_page", "100");
    let url = first2;
    const seen = /* @__PURE__ */ new Set();
    const rows = [];
    while (url) {
      if (url.origin !== first2.origin || url.pathname !== first2.pathname || url.username || url.password || seen.has(url.href)) {
        throw new Error("eLearning \u8FD4\u56DE\u4E86\u5F02\u5E38\u5206\u9875\u94FE\u63A5\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
      }
      seen.add(url.href);
      const res = await this.request(url.href);
      if (!res.headers.get("content-type")?.includes("json")) {
        throw new Error("eLearning \u672A\u8FD4\u56DE\u63A5\u53E3\u6570\u636E\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u540E\u540C\u6B65");
      }
      const data = await res.json();
      if (path === "/users/self") {
        if (!data || typeof data !== "object" || !("id" in data) || !data.id) throw new Error("\u65E0\u6CD5\u786E\u8BA4 eLearning \u767B\u5F55\u8EAB\u4EFD");
        return data;
      }
      if (!Array.isArray(data)) throw new Error("eLearning \u8FD4\u56DE\u7684\u6570\u636E\u683C\u5F0F\u4E0D\u6B63\u786E");
      rows.push(...data);
      const next = res.headers.get("link")?.split(/,(?=\s*<)/).find((part) => /;\s*rel="?next"?(?:\s*;|\s*$)/i.test(part))?.match(/<([^>]+)>/)?.[1];
      url = next ? new URL(next, url) : void 0;
    }
    return rows;
  }
  /** 返回单个对象的接口（例如某个文件的信息） */
  async getObject(path) {
    const res = await this.request(new URL(`/api/v1${path}`, this.base).href);
    if (!res.headers.get("content-type")?.includes("json")) throw new Error("eLearning \u672A\u8FD4\u56DE\u63A5\u53E3\u6570\u636E\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u540E\u540C\u6B65");
    const data = await res.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("eLearning \u8FD4\u56DE\u7684\u6570\u636E\u683C\u5F0F\u4E0D\u6B63\u786E");
    return data;
  }
  async ping() {
    try {
      await this.get("/users/self");
      return true;
    } catch (e) {
      if (e instanceof NeedLoginError) return false;
      throw e;
    }
  }
  async listCourses() {
    const raw = await this.get("/courses", {
      enrollment_state: "active",
      "include[]": ["term", "teachers"]
    });
    const courses = [];
    for (const c of raw) {
      const teachers = (c.teachers ?? []).map((t) => ({ name: t.display_name, email: t.email, role: "teacher" }));
      for (const role of ["teacher", "ta"]) {
        try {
          const staff = await this.get(`/courses/${c.id}/users`, { "enrollment_type[]": [role] });
          for (const person of staff) {
            const existing = teachers.find((t) => t.role === role && t.name === person.name);
            if (existing) existing.email = person.email ?? existing.email;
            else teachers.push({ name: person.name, email: person.email, role });
          }
        } catch (error) {
          if (![403, 404].includes(error.status ?? 0)) throw error;
        }
      }
      courses.push({ id: String(c.id), name: c.name, courseCode: c.course_code, term: c.term?.name, teachers });
    }
    return courses;
  }
  /** 「待办 / 计划」里被勾选为完成的作业 ID（一次同步内缓存 1 分钟，避免每门课重复请求） */
  plannerMarks;
  markedInPlanner() {
    if (!this.plannerMarks || Date.now() - this.plannerMarks.at > 6e4) {
      const ids = this.get("/planner/overrides").then((rows) => new Set(rows.filter((o) => o.plannable_type === "assignment" && o.marked_complete).map((o) => String(o.plannable_id)))).catch((error) => {
        if ([403, 404].includes(error.status ?? 0)) return /* @__PURE__ */ new Set();
        throw error;
      });
      this.plannerMarks = { at: Date.now(), ids };
    }
    return this.plannerMarks.ids;
  }
  /** 单元（模块）里要求「标记为完成」且已完成的作业 ID */
  async markedInModules(courseId) {
    try {
      const modules = await this.get(`/courses/${courseId}/modules`, { "include[]": ["items"] });
      return new Set(modules.flatMap((m) => m.items ?? []).filter((i) => i.type === "Assignment" && i.content_id != null && i.completion_requirement?.type === "must_mark_done" && i.completion_requirement.completed).map((i) => String(i.content_id)));
    } catch (error) {
      if ([403, 404].includes(error.status ?? 0)) return /* @__PURE__ */ new Set();
      throw error;
    }
  }
  async listAssignments(courseId) {
    const raw = await this.get(`/courses/${courseId}/assignments`, { "include[]": ["submission"] });
    const [planner, modules] = await Promise.all([this.markedInPlanner(), this.markedInModules(courseId)]);
    return raw.map((a) => ({
      id: String(a.id),
      courseId: String(a.course_id),
      name: a.name,
      description: a.description,
      dueAt: a.due_at ?? void 0,
      htmlUrl: a.html_url,
      submissionTypes: a.submission_types,
      submitted: !!a.submission && ["submitted", "graded", "pending_review"].includes(a.submission.workflow_state),
      submittedAt: a.submission?.submitted_at,
      updatedAt: a.updated_at,
      markedDone: planner.has(String(a.id)) || modules.has(String(a.id)) || a.submission?.excused === true
    }));
  }
  /**
   * 课程文件。先读「文件」栏目；老师把「文件」栏目隐藏时（没有权限），改从「单元」里找文件条目。
   */
  async listFiles(courseId, search) {
    const toFile = (f, folder) => ({
      id: String(f.id),
      name: f.display_name ?? f.filename ?? `\u6587\u4EF6 ${f.id}`,
      size: f.size,
      contentType: f["content-type"],
      updatedAt: f.updated_at,
      folder
    });
    const term = search?.trim();
    try {
      const params = { sort: "updated_at", order: "desc" };
      if (term && term.length >= 2) params.search_term = term;
      const [files, folders] = await Promise.all([
        this.get(`/courses/${courseId}/files`, params),
        this.get(`/courses/${courseId}/folders`).catch(() => [])
      ]);
      const folderName = new Map(folders.map((f) => [f.id, (f.full_name ?? f.name ?? "").replace(/^course files\/?/, "")]));
      return files.filter((f) => !f.locked_for_user && !f.hidden_for_user).map((f) => toFile(f, folderName.get(f.folder_id ?? -1) || void 0));
    } catch (error) {
      if (![403, 404].includes(error.status ?? 0)) throw error;
    }
    const modules = await this.get(`/courses/${courseId}/modules`, { "include[]": ["items"] });
    const out = [];
    for (const m of modules) {
      for (const item of m.items ?? []) {
        if (item.type !== "File" || item.content_id == null) continue;
        if (term && !(item.title ?? "").toLowerCase().includes(term.toLowerCase()) && !(m.name ?? "").toLowerCase().includes(term.toLowerCase())) continue;
        try {
          const f = await this.getObject(`/courses/${courseId}/files/${item.content_id}`);
          if (!f.locked_for_user) out.push(toFile(f, m.name));
        } catch (error) {
          if (![403, 404].includes(error.status ?? 0)) throw error;
        }
      }
    }
    return out;
  }
  /** 下载课程文件：先读文件信息拿到带校验的下载地址，再用同一登录会话下载 */
  async downloadFile(fileId) {
    if (!/^\d+$/.test(fileId)) throw new Error("\u6587\u4EF6 id \u4E0D\u5BF9\uFF0C\u8BF7\u7528\u8BFE\u4EF6\u5217\u8868\u91CC\u8FD4\u56DE\u7684 id\u3002");
    const info = await this.getObject(`/files/${fileId}`);
    if (info.locked_for_user) throw new Error("\u8FD9\u4E2A\u6587\u4EF6\u8FD8\u6CA1\u5F00\u653E\uFF0C\u6682\u65F6\u4E0D\u80FD\u4E0B\u8F7D\u3002");
    if ((info.size ?? 0) > MAX_DOWNLOAD_BYTES) throw new Error("\u6587\u4EF6\u8D85\u8FC7 200 MB\uFF0C\u8BF7\u5728 eLearning \u7F51\u9875\u4E0A\u4E0B\u8F7D\u3002");
    if (!info.url) throw new Error("eLearning \u6CA1\u6709\u8FD4\u56DE\u8FD9\u4E2A\u6587\u4EF6\u7684\u4E0B\u8F7D\u5730\u5740\uFF0C\u53EF\u80FD\u9700\u8981\u5728\u7F51\u9875\u4E0A\u4E0B\u8F7D\u3002");
    const res = await this.auth.fetch("elearning", info.url);
    if (!res.ok) throw Object.assign(new Error(`\u4E0B\u8F7D\u5931\u8D25\uFF08${res.status}\uFF09`), { status: res.status });
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.byteLength > MAX_DOWNLOAD_BYTES) throw new Error("\u6587\u4EF6\u8D85\u8FC7 200 MB\uFF0C\u8BF7\u5728 eLearning \u7F51\u9875\u4E0A\u4E0B\u8F7D\u3002");
    return { name: info.display_name ?? info.filename ?? `\u6587\u4EF6 ${fileId}`, contentType: info["content-type"] ?? res.headers.get("content-type") ?? void 0, data };
  }
  async listAnnouncements(courseIds, since) {
    if (courseIds.length === 0) return [];
    const params = { "context_codes[]": courseIds.map((id) => `course_${id}`) };
    if (since) params.start_date = since;
    const raw = await this.get("/announcements", params);
    return raw.map((a) => ({
      id: String(a.id),
      courseId: a.context_code.replace("course_", ""),
      title: a.title,
      message: a.message,
      postedAt: a.posted_at,
      htmlUrl: a.html_url
    }));
  }
};

// src/services/grades.ts
import { load as load4 } from "cheerio";
var JW2 = "https://fdjwgl.fudan.edu.cn/student/for-std";
var num = (v) => typeof v === "number" ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : void 0;
function parseGradeSheet(body3, semesterNames) {
  let data;
  try {
    data = JSON.parse(body3);
  } catch {
    throw new TimetableFormatError("\u6559\u52A1\u7CFB\u7EDF\u8FD4\u56DE\u7684\u6210\u7EE9\u683C\u5F0F\u548C\u9884\u671F\u4E0D\u540C\uFF0C\u5B66\u6821\u9875\u9762\u53EF\u80FD\u66F4\u65B0\u4E86\u3002");
  }
  const map = data?.semesterId2studentGrades;
  if (!map || typeof map !== "object") throw new TimetableFormatError("\u6559\u52A1\u7CFB\u7EDF\u8FD4\u56DE\u7684\u6210\u7EE9\u683C\u5F0F\u548C\u9884\u671F\u4E0D\u540C\uFF0C\u5B66\u6821\u9875\u9762\u53EF\u80FD\u66F4\u65B0\u4E86\u3002");
  return Object.entries(map).map(([id, rows]) => {
    const name = semesterNames.get(id) ?? `\u5B66\u671F ${id}`;
    const courses = (Array.isArray(rows) ? rows : []).flatMap((x) => {
      const r = x;
      const course = typeof r.courseName === "string" && r.courseName || typeof r.courseNameEn === "string" && r.courseNameEn || "";
      const grade = typeof r.gaGrade === "string" ? r.gaGrade : r.gaGrade == null ? "" : String(r.gaGrade);
      if (!course) return [];
      return [{
        course,
        code: typeof r.lessonCode === "string" && r.lessonCode || typeof r.courseCode === "string" && r.courseCode || void 0,
        credits: num(r.credits) ?? num(r.credit),
        grade: grade || "\u672A\u51FA",
        gp: num(r.gp),
        type: typeof r.courseModuleTypeName === "string" && r.courseModuleTypeName || typeof r.courseType === "string" && r.courseType || void 0,
        semester: name
      }];
    });
    return { id, name, courses };
  });
}
function weightedGpa(courses) {
  const counted = courses.filter((c) => c.gp !== void 0 && c.credits && c.credits > 0);
  const credits = counted.reduce((n, c) => n + c.credits, 0);
  if (!credits) return { credits: courses.reduce((n, c) => n + (c.credits ?? 0), 0) };
  return { gpa: Math.round(counted.reduce((n, c) => n + c.gp * c.credits, 0) / credits * 100) / 100, credits: courses.reduce((n, c) => n + (c.credits ?? 0), 0) };
}
function parseGpaRank(body3, studentNumber) {
  let data;
  try {
    data = JSON.parse(body3);
  } catch {
    return void 0;
  }
  const rows = Array.isArray(data?.data) ? data.data : [];
  const me = studentNumber ? rows.find((r) => String(r.code ?? "") === studentNumber) : void 0;
  if (!me) return { total: rows.length };
  return {
    gpa: num(me.gpa),
    credits: num(me.credit),
    ranking: num(me.ranking),
    total: rows.length,
    major: typeof me.major === "string" ? me.major : void 0,
    department: typeof me.department === "string" ? me.department : void 0,
    grade: me.grade == null ? void 0 : String(me.grade)
  };
}
async function readStudentId(reader) {
  const page = await reader.getText(UNDERGRAD_TABLE_URL);
  if (page.status >= 400) throw new Error(`\u6559\u52A1\u7CFB\u7EDF\u8FD4\u56DE ${page.status}`);
  const { semesters, currentId } = parseSemesterPage(page.text);
  const id = currentId ?? semesters[0]?.id;
  const data = await reader.getText(`${UNDERGRAD_TABLE_URL}/semester/${id}/print-data`);
  let studentId;
  try {
    studentId = JSON.parse(data.text).studentTableVms?.[0]?.id;
  } catch {
  }
  if (studentId === void 0 || studentId === null) throw new TimetableFormatError("\u6CA1\u6709\u4ECE\u6559\u52A1\u7CFB\u7EDF\u8BFB\u5230\u5B66\u751F\u4FE1\u606F\u3002");
  return { studentId: String(studentId), semesters, currentId };
}
async function readGrades(reader) {
  const { studentId, semesters } = await readStudentId(reader);
  const names = new Map(semesters.map((s) => [s.id, s.name]));
  let result = parseGradeSheet((await reader.getText(`${JW2}/grade/sheet/info/${studentId}?semester=`)).text, names).filter((s) => s.courses.length);
  if (!result.length) {
    result = [];
    for (const s of semesters.slice(0, 12)) {
      const one = parseGradeSheet((await reader.getText(`${JW2}/grade/sheet/info/${studentId}?semester=${s.id}`)).text, names);
      result.push(...one.filter((x) => x.courses.length));
    }
  }
  result.sort((a, b) => Number(b.id) - Number(a.id));
  const all = result.flatMap((s) => s.courses);
  return { studentId, semesters: result, ...weightedGpa(all), updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
}
async function readGpaRank(reader, studentId, studentNumber) {
  const index = await reader.getText(`${JW2}/grade/my-gpa/search-index/${studentId}`);
  const $ = load4(index.text);
  const grade = $('input[name="grade"]').attr("value");
  const dept2 = $('input[name="departmentAssoc"]').attr("value");
  if (!grade || !dept2) return void 0;
  const res = await reader.getText(`${JW2}/grade/my-gpa/search?studentAssoc=${encodeURIComponent(studentId)}&grade=${encodeURIComponent(grade)}&departmentAssoc=${encodeURIComponent(dept2)}&majorAssoc=`);
  return parseGpaRank(res.text, studentNumber);
}

// src/services/jw.ts
async function readSemesters(reader) {
  for (let attempt = 0; ; attempt++) {
    const page = await reader.getText(UNDERGRAD_TABLE_URL);
    if (page.status >= 400) throw new Error(`\u6559\u52A1\u7CFB\u7EDF\u8FD4\u56DE ${page.status}`);
    try {
      return parseSemesterPage(page.text);
    } catch (error) {
      if (/id\.fudan\.edu\.cn|uis\.fudan\.edu\.cn|authserver|统一身份认证/.test(page.url + page.text.slice(0, 3e3))) throw new NeedLoginError("jwfw");
      if (attempt >= 1) throw error;
    }
  }
}
var toView = (entries) => {
  const byCourse = /* @__PURE__ */ new Map();
  for (const e of entries) {
    const c = byCourse.get(e.course) ?? { course: e.course, teachers: [], sessions: [] };
    for (const t of e.teachers) if (!c.teachers.includes(t)) c.teachers.push(t);
    const { start, end } = periodTime(e.startPeriod, e.endPeriod);
    c.sessions.push({ weekday: e.weekday, periods: `${e.startPeriod}-${e.endPeriod}`, start, end, location: e.location, weeks: e.weeks });
    byCourse.set(e.course, c);
  }
  for (const c of byCourse.values()) c.sessions.sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start));
  return [...byCourse.values()];
};
async function readTimetable(reader, opts = {}) {
  if (opts.postgraduate) {
    const res = await reader.getText(`${POSTGRAD_TABLE_URL}?_=${Date.now()}`);
    if (res.status >= 400) throw new Error(`\u7814\u7A76\u751F\u9009\u8BFE\u7CFB\u7EDF\u8FD4\u56DE ${res.status}`);
    return { kind: "postgraduate", courses: toView(parsePostgradTable(res.text)) };
  }
  const { semesters, currentId } = await readSemesters(reader);
  const want = opts.semester?.trim();
  const semester = want ? semesters.find((s) => s.id === want) ?? semesters.find((s) => s.name.includes(want)) : semesters.find((s) => s.id === currentId) ?? semesters[0];
  if (!semester) throw want ? Object.assign(new Error(`\u6CA1\u6709\u627E\u5230\u5B66\u671F\u300C${want}\u300D\uFF0C\u7528 fdu jw semesters \u67E5\u770B\u5B66\u671F\u5217\u8868\u3002`), { code: "NOT_FOUND" }) : new TimetableFormatError();
  const data = await reader.getText(`${UNDERGRAD_TABLE_URL}/semester/${semester.id}/print-data`);
  if (data.status >= 400) throw new Error(`\u6559\u52A1\u7CFB\u7EDF\u8FD4\u56DE ${data.status}`);
  return { kind: "undergraduate", semester, courses: toView(parseUndergradTable(data.text)) };
}
async function readExams(reader, opts = {}) {
  const looksLoaded = (html2) => /<td[^>]*>[\s\S]*?20\d{2}\s*[-/.年]\s*\d{1,2}/.test(html2) || /暂无|没有.*考试|无考试安排/.test(html2);
  let studentId;
  try {
    studentId = (await readStudentId(reader)).studentId;
  } catch (e) {
    if (e instanceof NeedLoginError) throw e;
  }
  let html = (await reader.getText(studentId ? `${EXAM_URL}/info/${studentId}` : EXAM_URL)).text;
  if (studentId && !looksLoaded(html)) html = (await reader.getText(EXAM_URL)).text;
  if (!looksLoaded(html) && reader.render) html = await reader.render(EXAM_URL, looksLoaded);
  const now = opts.now ?? Date.now();
  return parseExamPage(html).filter((e) => opts.all || Date.parse(e.endsAt ?? e.startsAt) > now - 30 * 864e5).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}
var LESSON_SEARCH = "https://fdjwgl.fudan.edu.cn/student/for-std/lesson-search";
var nameOf = (x) => x && typeof x.nameZh === "string" && x.nameZh.trim() ? x.nameZh.trim() : void 0;
var numOf = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
function parseLessons(body3) {
  let j;
  try {
    j = JSON.parse(body3);
  } catch {
    throw new TimetableFormatError("\u5168\u6821\u5F00\u8BFE\u67E5\u8BE2\u8FD4\u56DE\u7684\u683C\u5F0F\u548C\u9884\u671F\u4E0D\u540C\uFF0C\u5B66\u6821\u9875\u9762\u53EF\u80FD\u66F4\u65B0\u4E86\u3002");
  }
  const rows = Array.isArray(j.data) ? j.data : [];
  const lessons = rows.map((r) => {
    const course = r.course ?? {};
    const teachers = (r.teacherAssignmentList ?? []).map((t) => nameOf(t.person)).filter((x) => !!x);
    const schedule = r.scheduleText?.dateTimePlacePersonText?.textZh;
    return {
      code: String(r.code ?? ""),
      course: nameOf(course) ?? nameOf(r) ?? "",
      ...typeof course.code === "string" ? { courseCode: course.code } : {},
      ...numOf(course.credits) !== void 0 ? { credits: numOf(course.credits) } : {},
      teachers: [...new Set(teachers)],
      ...typeof schedule === "string" && schedule.trim() ? { schedule: schedule.replace(/\s+/g, " ").trim() } : {},
      ...nameOf(r.openDepartment) ? { department: nameOf(r.openDepartment) } : {},
      ...numOf(r.limitCount) !== void 0 ? { limit: numOf(r.limitCount) } : {},
      ...numOf(r.stdCount) !== void 0 ? { selected: numOf(r.stdCount) } : {},
      ...nameOf(r.examMode) ? { examMode: nameOf(r.examMode) } : {},
      ...nameOf(r.teachLang) ? { language: nameOf(r.teachLang) } : {},
      ...nameOf(r.courseType) ? { courseType: nameOf(r.courseType) } : {}
    };
  });
  const p = j._page_ ?? {};
  return { lessons, page: Number(p.currentPage ?? 1) || 1, pages: Number(p.totalPages ?? 1) || 1, total: Number(p.totalRows ?? lessons.length) || lessons.length };
}
async function readLessons(reader, opts) {
  const { semesters, currentId } = await readSemesters(reader);
  const want = opts.semester?.trim();
  const semester = want ? semesters.find((s) => s.id === want) ?? semesters.find((s) => s.name.includes(want)) : semesters.find((s) => s.id === currentId) ?? semesters[0];
  if (!semester) throw Object.assign(new Error(`\u6CA1\u6709\u627E\u5230\u5B66\u671F\u300C${want}\u300D\uFF0C\u7528 fdu jw semesters \u67E5\u770B\u5B66\u671F\u5217\u8868\u3002`), { code: "NOT_FOUND" });
  const { studentId } = await readStudentId(reader);
  const qs = new URLSearchParams({ queryPage__: `${opts.page ?? 1},${opts.size ?? 20}`, courseNameZhLike: opts.keyword });
  const res = await reader.getText(`${LESSON_SEARCH}/semester/${semester.id}/search/${studentId}?${qs}`, { headers: { "X-Requested-With": "XMLHttpRequest", Accept: "application/json" } });
  if (res.status >= 400) throw new Error(`\u6559\u52A1\u7CFB\u7EDF\u8FD4\u56DE ${res.status}`);
  return { semester: semester.name, keyword: opts.keyword, ...parseLessons(res.text) };
}

// src/services/library-search.ts
var PRIMO_ORIGIN = "https://fudan-primo.hosted.exlibrisgroup.com.cn";
var REST = "/primo_library/libweb/webservices/rest";
var SCOPES = { articles: ["digital_tab", "article_scope"], all: ["default_tab", "default_scope"], books: ["book_journal", "book_journal"] };
var FIELDS = { all: "any", title: "title", author: "creator", subject: "sub", fulltext: "ftext" };
var LibraryError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "LibraryError";
  }
};
function clean(s) {
  return s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}
var list = (v) => (Array.isArray(v) ? v : [v]).filter((x) => typeof x === "string").map(clean).filter(Boolean);
var first = (v) => list(v)[0];
function normalizeRecord(raw) {
  const r = raw;
  const pnx = r?.pnx;
  if (!pnx || typeof pnx !== "object") return void 0;
  const display = pnx.display ?? {};
  const addata = pnx.addata ?? {};
  const search = pnx.search ?? {};
  const control = pnx.control ?? {};
  const facets = pnx.facets ?? {};
  const recordId = first(control.recordid);
  const title = first(display.title) ?? first(addata.atitle);
  if (!recordId || !title) return void 0;
  const context = r.context === "PC" || r.context === "L" ? r.context : recordId.startsWith("TN_") ? "PC" : "L";
  const date = first(addata.date) ?? first(pnx.sort?.creationdate);
  const year = date?.match(/\d{4}/)?.[0];
  const doi = first(addata.doi) ?? list(display.identifier).find((x) => x.startsWith("DOI:"))?.slice(4).trim();
  const levels = list(facets.toplevel);
  const availability = [...list(r.delivery?.availability), ...list(pnx.delivery?.fulltext)];
  const abstract = list(addata.abstract).join("\n\n") || list(display.description).join("\n\n") || void 0;
  const params = new URLSearchParams({ docid: recordId, context, vid: "fdu", lang: "zh_CN", adaptor: context === "PC" ? "primo_central_multiple_fe" : "Local Search Engine" });
  return {
    recordId,
    context,
    title,
    authors: (list(addata.au).length ? list(addata.au) : list(search.creator).length ? list(search.creator) : list(display.creator)).slice(0, 8),
    year: year ? Number(year) : void 0,
    journal: first(addata.jtitle),
    type: first(display.type),
    doi,
    abstract: abstract?.slice(0, 3e3),
    peerReviewed: levels.includes("peer_reviewed") || void 0,
    fullTextAvailable: availability.includes("fulltext") || levels.includes("online_resources") ? true : availability.some((a) => a.startsWith("no_fulltext")) ? false : void 0,
    url: `${PRIMO_ORIGIN}/primo-explore/fulldisplay?${params}`
  };
}
var LibrarySearch = class {
  constructor(getJson, now = () => Date.now()) {
    this.getJson = getJson;
    this.now = now;
  }
  getJson;
  now;
  token;
  last = 0;
  /** 两次请求之间至少间隔 1 秒，不给图书馆系统添负担 */
  async request(path, params, token) {
    const wait = 1e3 - (this.now() - this.last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last = this.now();
    const url = `${PRIMO_ORIGIN}${path}?${new URLSearchParams(params)}`;
    return this.getJson(url, { Accept: "application/json", ...token ? { Authorization: `Bearer ${token}` } : {} });
  }
  async guestToken(force = false) {
    if (!force && this.token && this.now() < this.token.until) return this.token.value;
    const res = await this.request(`${REST}/v1/guestJwt/FDU`, { vid: "fdu", lang: "zh_CN" });
    if (res.status >= 400) throw new LibraryError(`\u56FE\u4E66\u9986\u68C0\u7D22\u7CFB\u7EDF\u6682\u65F6\u4E0D\u53EF\u7528\uFF08${res.status}\uFF09\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002`);
    const value = res.text.trim().replace(/^"|"$/g, "");
    if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(value)) throw new LibraryError("\u56FE\u4E66\u9986\u68C0\u7D22\u7CFB\u7EDF\u6CA1\u6709\u8FD4\u56DE\u53EF\u7528\u7684\u8BBF\u5BA2\u4EE4\u724C\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002");
    this.token = { value, until: this.now() + 10 * 6e4 };
    return value;
  }
  async getData(path, params) {
    let res = await this.request(path, params, await this.guestToken());
    if (res.status === 401 || res.status === 403) res = await this.request(path, params, await this.guestToken(true));
    if (res.status === 404) throw new LibraryError("\u6CA1\u6709\u627E\u5230\u8FD9\u6761\u6587\u732E\uFF0C\u8BF7\u7528\u6700\u65B0\u68C0\u7D22\u7ED3\u679C\u91CC\u7684 record_id\u3002");
    if (res.status === 429 || res.status >= 500) throw new LibraryError("\u56FE\u4E66\u9986\u68C0\u7D22\u7CFB\u7EDF\u6682\u65F6\u7E41\u5FD9\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002");
    if (res.status >= 400) throw new LibraryError(`\u56FE\u4E66\u9986\u68C0\u7D22\u7CFB\u7EDF\u8FD4\u56DE ${res.status}\u3002`);
    try {
      return JSON.parse(res.text);
    } catch {
      throw new LibraryError("\u56FE\u4E66\u9986\u68C0\u7D22\u7CFB\u7EDF\u8FD4\u56DE\u7684\u683C\u5F0F\u548C\u9884\u671F\u4E0D\u540C\u3002");
    }
  }
  async search(q) {
    const query = q.query.replace(/[;,]/g, " ").replace(/\s+/g, " ").trim();
    if (!query) throw new LibraryError("\u8BF7\u63D0\u4F9B\u68C0\u7D22\u8BCD\u3002");
    const [tab, scope] = SCOPES[q.scope ?? "articles"];
    const clauses = [`${FIELDS[q.field ?? "all"]},contains,${query}`];
    if (q.yearFrom || q.yearTo) clauses.push(`dr_s,exact,${q.yearFrom ?? 1e3}0101`, `dr_e,exact,${q.yearTo ?? 2100}1231`);
    const includes = [q.peerReviewedOnly && "facet_tlevel,exact,peer_reviewed", q.fullTextOnly && "facet_tlevel,exact,online_resources"].filter(Boolean);
    const data = await this.getData(`${REST}/primo-explore/v1/pnxs`, {
      vid: "fdu",
      inst: "FDU",
      tab,
      scope,
      lang: "zh_CN",
      q: clauses.join(";"),
      qInclude: includes.join("|,|"),
      offset: String(q.offset ?? 0),
      limit: String(Math.min(20, Math.max(1, q.limit ?? 8))),
      sort: q.sort === "newest" ? "date" : "rank",
      pcAvailability: String(!q.fullTextOnly)
    });
    const records = (data.docs ?? []).map(normalizeRecord).filter((x) => !!x);
    this.remember(records);
    const searchUrl = `${PRIMO_ORIGIN}/primo-explore/search?${new URLSearchParams({ query: clauses[0], vid: "fdu", tab, search_scope: scope, lang: "zh_CN" })}`;
    return { total: Number(data.info?.total ?? records.length), records, searchUrl };
  }
  /** 最近检索到的文献（按 record_id 取完整摘要，不再请求图书馆） */
  recent = /* @__PURE__ */ new Map();
  remember(records) {
    for (const r of records) this.recent.set(r.recordId, r);
    while (this.recent.size > 200) this.recent.delete(this.recent.keys().next().value);
  }
  document(recordId) {
    return this.recent.get(recordId);
  }
};

// src/services/library-account.ts
var OPAC = "https://opac.fudan.edu.cn/";
var LIB_API = "https://fdulspgw.fudan.edu.cn/alsp/open-api/elib5";
var str = (v) => typeof v === "string" && v.trim() ? v.trim() : void 0;
var num2 = (v) => typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : void 0;
function libDate(v) {
  const s = str(v);
  if (!s) return void 0;
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : void 0;
}
function body(r, what) {
  if (r.status === 401 || r.status === 403) throw new FduError("NEED_LOGIN", "\u56FE\u4E66\u9986\u767B\u5F55\u5DF2\u8FC7\u671F\u3002", "\u8FD0\u884C `fdu library login`\uFF0C\u5728\u6253\u5F00\u7684\u56FE\u4E66\u9986\u9875\u9762\u91CC\u767B\u5F55\u4E00\u6B21\u3002");
  let j;
  try {
    j = JSON.parse(r.text);
  } catch {
    throw new FduError("UPSTREAM", `\u56FE\u4E66\u9986\u7CFB\u7EDF\u8FD4\u56DE\u7684\u4E0D\u662F\u6570\u636E\uFF08${what}\uFF0C${r.status}\uFF09\u3002`);
  }
  const code = Number(j.code);
  if (code === 401 || code === 403 || /登录|token|过期|未授权/i.test(String(j.msg ?? j.message ?? "")) && code !== 0 && code !== 200) {
    throw new FduError("NEED_LOGIN", "\u56FE\u4E66\u9986\u767B\u5F55\u5DF2\u8FC7\u671F\u3002", "\u8FD0\u884C `fdu library login`\uFF0C\u5728\u6253\u5F00\u7684\u56FE\u4E66\u9986\u9875\u9762\u91CC\u767B\u5F55\u4E00\u6B21\u3002");
  }
  if (code !== 0 && code !== 200) throw new FduError("UPSTREAM", `\u56FE\u4E66\u9986\u7CFB\u7EDF\uFF1A${String(j.msg ?? j.message ?? code)}`);
  return j;
}
function parseCurrentLoans(json, today) {
  const list2 = json?.data?.list ?? [];
  return list2.map((row) => {
    const info = row.itemInfo ?? {};
    const item = info.item ?? {};
    const inst = info.instance ?? {};
    const log = row.loanLog ?? {};
    const policy = row.circulationLoanPolicy ?? {};
    const dueDate = libDate(log.dueDate) ?? libDate(item.returnTime);
    const daysLeft = dueDate ? Math.round((Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 864e5) : void 0;
    return {
      title: str(inst.title) ?? "\uFF08\u672A\u77E5\u4E66\u540D\uFF09",
      ...str(inst.author) ? { author: str(inst.author) } : {},
      ...str(inst.callNo ?? item.callNo) ? { callNo: str(inst.callNo ?? item.callNo) } : {},
      ...str(inst.ISBN) ? { isbn: str(inst.ISBN) } : {},
      ...str(item.permanentLibraryName) ? { library: str(item.permanentLibraryName) } : {},
      ...str(item.permanentLocationName ?? item.temporaryLocationName) ? { location: str(item.permanentLocationName ?? item.temporaryLocationName) } : {},
      loanDate: libDate(log.loanDate) ?? libDate(item.checkoutDate),
      dueDate,
      renewed: num2(log.renewalCount) ?? num2(item.renewCount) ?? 0,
      ...num2(policy.renewalCount) !== void 0 ? { renewMax: num2(policy.renewalCount) } : {},
      overdue: daysLeft !== void 0 && daysLeft < 0,
      ...daysLeft !== void 0 ? { daysLeft } : {}
    };
  }).sort((a, b) => (a.dueDate ?? "9").localeCompare(b.dueDate ?? "9"));
}
function parseHistory(json) {
  const d = json?.data ?? {};
  const list2 = d.list ?? [];
  return {
    total: num2(d.total) ?? list2.length,
    loans: list2.map((row) => {
      const inst = row.catalogueInstance ?? {};
      return {
        title: str(inst.title) ?? "\uFF08\u672A\u77E5\u4E66\u540D\uFF09",
        ...str(inst.author) ? { author: str(inst.author) } : {},
        ...str(inst.callNo) ? { callNo: str(inst.callNo) } : {},
        loanDate: libDate(row.loanDate),
        ...libDate(row.returnDate) ? { returnDate: libDate(row.returnDate) } : {}
      };
    })
  };
}
function parseReader(json) {
  const d = json?.data ?? {};
  return {
    canBorrow: num2(d.canLoanTotal),
    overdue: num2(d.overdueTotal),
    fees: num2(d.fees),
    holds: num2(d.currentRequestCount),
    ...libDate(d.expirationDate) ? { cardExpires: libDate(d.expirationDate) } : {}
  };
}
async function readLoans(getJson, today) {
  const [reader, loans] = await Promise.all([
    getJson(`${LIB_API}/getReaderInfo`).then((r) => parseReader(body(r, "\u8BFB\u8005\u4FE1\u606F"))),
    getJson(`${LIB_API}/getReaderCurrentLoan?pageSize=100&pageNo=1`).then((r) => parseCurrentLoans(body(r, "\u5F53\u524D\u501F\u9605"), today))
  ]);
  return { ...reader, count: loans.length, dueSoon: loans.filter((l) => !l.overdue && (l.daysLeft ?? 99) <= 7).length, loans };
}
async function readHistory(getJson, page, size) {
  const qs = new URLSearchParams({ time: "", actionType: "", pageSize: String(size), pageNo: String(page) });
  return { page, ...parseHistory(body(await getJson(`${LIB_API}/v2/getReaderHistoryLoan?${qs}`), "\u5386\u53F2\u501F\u9605")) };
}

// src/services/mail.ts
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
var DEFAULT_FUDAN_STUDENT_IMAP = { host: "imap.exmail.qq.com", port: 993 };
var ImapMailClient = class {
  constructor(config) {
    this.config = config;
  }
  config;
  connect() {
    return new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: true,
      auth: { user: this.config.user, pass: this.config.password },
      logger: false,
      connectionTimeout: 2e4,
      greetingTimeout: 2e4,
      socketTimeout: 6e4
    });
  }
  /**
   * 保持一个只读连接打开收件箱并进入 IDLE：新邮件到达时服务器会马上通知（exists 事件）。
   * 断线后指数退避重连（5 秒起，最长 5 分钟）。不标记已读，不改动任何邮件。
   */
  watch(onNew, onState) {
    let stopped = false;
    let client;
    let delay = 5e3;
    let timer;
    const reconnect = (error) => {
      if (stopped || timer) return;
      onState?.("reconnecting", error);
      timer = setTimeout(() => {
        timer = void 0;
        void run();
      }, delay);
      delay = Math.min(delay * 2, 5 * 6e4);
    };
    const run = async () => {
      if (stopped) return;
      client = new ImapFlow({
        host: this.config.host,
        port: this.config.port,
        secure: true,
        auth: { user: this.config.user, pass: this.config.password },
        logger: false,
        connectionTimeout: 2e4,
        greetingTimeout: 2e4,
        // IDLE 连接会长时间没有数据：每 4 分钟重新发一次 IDLE，保持连接
        socketTimeout: 10 * 6e4,
        maxIdleTime: 4 * 6e4
      });
      const c = client;
      let count = -1;
      c.on("exists", (data) => {
        if (data.count > (count >= 0 ? count : data.prevCount)) onNew();
        count = data.count;
      });
      c.on("close", () => reconnect());
      c.on("error", () => {
      });
      try {
        await c.connect();
        const box = await c.mailboxOpen("INBOX", { readOnly: true });
        count = box.exists;
        delay = 5e3;
        onState?.("watching");
        onNew();
      } catch (e) {
        await c.logout().catch(() => c.close());
        reconnect(e.message);
      }
    };
    void run();
    return async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      onState?.("stopped");
      await client?.logout().catch(() => client?.close());
    };
  }
  async ping() {
    const client = this.connect();
    try {
      await client.connect();
      return true;
    } catch {
      return false;
    } finally {
      await client.logout().catch(() => void 0);
    }
  }
  async fetchSince(since, limit) {
    const client = this.connect();
    const out = [];
    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX", { readOnly: true });
      try {
        const uids = await client.search({ since }, { uid: true }) || [];
        const recent = limit === void 0 ? uids : uids.slice(-Math.max(0, Math.floor(limit)));
        if (limit !== void 0 && (!Number.isFinite(limit) || limit <= 0)) return out;
        if (recent.length === 0) return out;
        for (let offset = 0; offset < recent.length; offset += 100) {
          for await (const msg of client.fetch(recent.slice(offset, offset + 100), { uid: true, source: true }, { uid: true })) {
            if (!msg.source) continue;
            const parsed = await simpleParser(msg.source);
            const from = parsed.from?.value?.[0];
            const toList = Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : [];
            out.push({
              uid: String(msg.uid),
              messageId: parsed.messageId,
              threadKey: parsed.references && [parsed.references].flat()[0] || parsed.messageId,
              from: { name: from?.name, address: from?.address ?? "" },
              to: toList.flatMap((t) => t.value.map((v) => v.address ?? "")),
              subject: parsed.subject ?? "(\u65E0\u4E3B\u9898)",
              date: (parsed.date ?? /* @__PURE__ */ new Date()).toISOString(),
              text: (parsed.text ?? "").slice(0, 8e3)
            });
          }
        }
      } finally {
        lock.release();
      }
    } catch (error) {
      const code = error.code;
      const auth = error.authenticationFailed;
      if (auth || code === "AUTHENTICATIONFAILED") throw new Error("\u8BF7\u68C0\u67E5\u90AE\u7BB1\u5730\u5740\u3001\u5BA2\u6237\u7AEF\u4E13\u7528\u5BC6\u7801\uFF0C\u5E76\u786E\u8BA4\u7F51\u9875\u90AE\u7BB1\u5DF2\u5F00\u542F IMAP\u3002");
      throw new Error("\u8BF7\u68C0\u67E5\u90AE\u7BB1\u670D\u52A1\u5668\u3001\u7AEF\u53E3\u548C\u7F51\u7EDC\u8FDE\u63A5\u540E\u91CD\u8BD5\u540C\u6B65\u3002");
    } finally {
      await client.logout().catch(() => void 0);
    }
    return out;
  }
};

// src/services/notice-parse.ts
import { load as load5 } from "cheerio";
var ROW = "li, tr, dd, dl, article, .news, .item, .list-item, .news_list > div, .list > div";
var FILE = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|jpe?g|png|gif)(\?|$)/i;
function validDate(y, m, d) {
  if (y < 2e3 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return void 0;
  const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return (/* @__PURE__ */ new Date(`${iso}T00:00:00Z`)).toISOString().startsWith(iso) ? iso : void 0;
}
function findDate(text) {
  const full = /* @__PURE__ */ new Set();
  for (const m of text.matchAll(/(?<!\d)(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?!\d)/g)) {
    const d = validDate(+m[1], +m[2], +m[3]);
    if (d) full.add(d);
  }
  if (full.size === 1) return [...full][0];
  if (full.size > 1) return null;
  const ym = text.match(/(?<!\d)(20\d{2})\s*[-/.年]\s*(\d{1,2})(?![\d-/.])/);
  const rest = ym ? text.replace(ym[0], " ") : "";
  const day = ym ? rest.match(/(?<!\d)(\d{1,2})(?!\d)/) : null;
  if (ym && day) return validDate(+ym[1], +ym[2], +day[1]) ?? void 0;
  return void 0;
}
function cleanText(s) {
  return s.replace(/\s+/g, " ").trim();
}
function parseNoticeList(html, pageUrl, opts = {}) {
  const $ = load5(html);
  const base = new URL(pageUrl);
  const found = /* @__PURE__ */ new Map();
  $("a[href]").each((_, el) => {
    const a = $(el);
    const row = a.closest(ROW);
    if (!row.length || row.is("body, html")) return;
    const hrefs = new Set(row.find("a[href]").map((_i, x) => $(x).attr("href")).get());
    if (hrefs.size !== 1) return;
    let url;
    try {
      url = new URL(a.attr("href"), base);
    } catch {
      return;
    }
    const sameSite = url.hostname === base.hostname || url.hostname.endsWith(".fudan.edu.cn");
    if (!/^https?:$/.test(url.protocol) || !sameSite || url.username || url.password || FILE.test(url.pathname)) return;
    if (url.href.replace(/#.*$/, "") === base.href.replace(/#.*$/, "")) return;
    url.hash = "";
    const title = cleanText(a.attr("title") || a.find("[title]").attr("title") || rowTitle($, a));
    if (title.length < 4 || /^(更多|more|首页|上一页|下一页|尾页)/i.test(title)) return;
    const date = rowDate($, row, title);
    if (date === null) return;
    if (!date && !opts.allowNoDate) return;
    if (!found.has(url.href)) found.set(url.href, { url: url.href, title, date: date || void 0 });
  });
  return [...found.values()].sort((x, y) => (y.date ?? "").localeCompare(x.date ?? ""));
}
function spaced($, el) {
  const copy = el.clone();
  copy.find("*").each((_i, x) => {
    $(x).prepend(" ").append(" ");
  });
  return cleanText(copy.text());
}
var DATE_ONLY = /^[\s\d年月日\-/.:：]+$/;
function rowDate($, row, title) {
  const marked = row.find('time, [class*="date"], [class*="time"], [class*="Date"]').first();
  if (marked.length) {
    const d = findDate(`${spaced($, marked)} ${marked.attr("datetime") ?? ""}`);
    if (d) return d;
  }
  const only = row.find("span, div, p, em, i, td, font").filter((_i, x) => {
    const t = cleanText($(x).text());
    return t.length >= 4 && DATE_ONLY.test(t) && /20\d{2}/.test(t);
  }).first();
  if (only.length) {
    const parent = only.parent();
    const d = findDate(spaced($, parent.is(row) ? only : parent));
    if (d) return d;
  }
  return findDate(spaced($, row).split(title).join(" "));
}
function rowTitle($, a) {
  const candidates = a.find('.title, .tit, [class*="tt"], h3, h4, p, span').map((_i, x) => cleanText($(x).text())).get().filter((t) => t.length >= 6 && !DATE_ONLY.test(t));
  const text = candidates[0] ?? cleanText(a.text());
  return text.replace(/(?<!\d)20\d{2}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?/g, "");
}
var BODY = [".wp_articlecontent", ".v_news_content", "#vsb_content", ".article-content", ".article_content", ".content-con", ".TRS_Editor", ".entry-content", "article", ".article", ".content", "#content"];
function parseNoticeDetail(html, pageUrl) {
  const $ = load5(html);
  $("script, style, noscript, nav, header, footer").remove();
  const hasContent = (x) => cleanText($(x).text()).length > 30 || $(x).find("[pdfsrc], iframe[src], embed[src], img").length > 0;
  let body3;
  for (const sel of BODY) {
    const el = $(sel).filter((_i, x) => hasContent(x)).first();
    if (el.length) {
      body3 = el;
      break;
    }
  }
  if (!body3) {
    let best;
    let bestLen = 0;
    $("div, td, section").each((_i, x) => {
      const own = $(x).clone();
      own.children("div, section, table, ul").remove();
      const len = cleanText(own.text()).length;
      const linkLen = cleanText(own.find("a").text()).length;
      if (len > bestLen && linkLen < len / 2) {
        best = x;
        bestLen = len;
      }
    });
    body3 = best ? $(best) : $("body");
  }
  const base = new URL(pageUrl);
  const attachments = [];
  const addFile = (raw, name) => {
    if (!raw) return;
    try {
      const url = new URL(raw, base);
      if (FILE.test(url.pathname) && !attachments.some((f) => f.url === url.href)) {
        attachments.push({ name: name || decodeURIComponent(url.pathname.split("/").pop() ?? "\u9644\u4EF6"), url: url.href });
      }
    } catch {
    }
  };
  body3.find("a[href]").each((_i, x) => addFile($(x).attr("href"), cleanText($(x).text())));
  body3.find("[pdfsrc]").each((_i, x) => addFile($(x).attr("pdfsrc"), /['"]title['"]\s*:\s*['"]([^'"]+)['"]/.exec($(x).attr("sudyfile-attr") ?? "")?.[1] ?? ""));
  body3.find("iframe[src], embed[src]").each((_i, x) => addFile($(x).attr("src"), ""));
  if (!attachments.length) $("[pdfsrc], iframe[src], embed[src]").each((_i, x) => addFile($(x).attr("pdfsrc") ?? $(x).attr("src"), ""));
  body3.find("br").replaceWith("\n");
  body3.find("p, div, li, tr, h1, h2, h3, h4").each((_i, x) => {
    $(x).append("\n");
  });
  const text = body3.text().replace(/[ \t 　]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const meta = cleanText($(".arti_metas, .article-info, .info, .time, .date, .news_meta, .arti-metas, .view-info").first().text());
  const labeled = cleanText($("body").text()).match(/(?:发布(?:日期|时间)|日期|时间)\s*[:：]\s*(20\d{2}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2})/)?.[1];
  const title = cleanText($(".arti_title, .article-title, .news_title, .view-title, .art-tit h3, h1").first().text()) || cleanText($("title").text()).replace(/\s*[-|_].*$/, "");
  return { title: title || void 0, date: findDate(meta) || (labeled ? findDate(labeled) : void 0) || void 0, text, attachments };
}

// src/services/notice-sources.ts
var dept = (id, name, url) => ({ id, name, url, group: "\u5B66\u6821\u90E8\u95E8" });
var school = (id, name, url) => ({ id, name, url, group: "\u9662\u7CFB" });
var NOTICE_SOURCES = [
  dept("jwc", "\u6559\u52A1\u5904", "https://jwc.fudan.edu.cn/9397/list.htm"),
  dept("gs", "\u7814\u7A76\u751F\u9662", "https://gs.fudan.edu.cn/tzgg/list.htm"),
  dept("fao", "\u56FD\u9645\u5408\u4F5C\u4E0E\u4EA4\u6D41\u5904", "https://fao.fudan.edu.cn/15884/list.htm"),
  dept("xianghui", "\u76F8\u8F89\u5B66\u5802", "https://xianghui.fudan.edu.cn/cate/81"),
  dept("cec", "\u82F1\u8BED\u6559\u5B66\u90E8", "https://cec.fudan.edu.cn/23080/list.htm"),
  dept("fdty", "\u4F53\u80B2\u6559\u5B66\u90E8", "https://fdty.fudan.edu.cn/29222/list.htm"),
  dept("bwc", "\u4FDD\u536B\u5904", "https://baoweichu.fudan.edu.cn/6707/list.htm"),
  dept("zwc", "\u603B\u52A1\u5904", "https://zongwuchu.fudan.edu.cn/16531/list.htm"),
  dept("cwc", "\u8D22\u52A1\u5904", "https://cwc.fudan.edu.cn/12185/list.htm"),
  dept("ices", "\u56FD\u9645\u6587\u5316\u4EA4\u6D41\u5B66\u9662", "https://ices.fudan.edu.cn/6758/list.htm"),
  school("chinese", "\u4E2D\u56FD\u8BED\u8A00\u6587\u5B66\u7CFB", "https://chinese.fudan.edu.cn/tzgg/list.htm"),
  school("dfll", "\u5916\u56FD\u8BED\u8A00\u6587\u5B66\u5B66\u9662", "https://dfll.fudan.edu.cn/27751/list.htm"),
  school("xwxy", "\u65B0\u95FB\u5B66\u9662", "https://xwxy.fudan.edu.cn/ggl/list.htm"),
  school("history", "\u5386\u53F2\u5B66\u7CFB", "https://history.fudan.edu.cn/xwzx/tzgg.htm"),
  school("philosophy", "\u54F2\u5B66\u5B66\u9662", "https://philosophy.fudan.edu.cn/tzgg_20877/list.htm"),
  school("sirpa", "\u56FD\u9645\u5173\u7CFB\u4E0E\u516C\u5171\u4E8B\u52A1\u5B66\u9662", "https://sirpa.fudan.edu.cn/35036/list.htm"),
  school("som", "\u9A6C\u514B\u601D\u4E3B\u4E49\u5B66\u9662", "https://som.fudan.edu.cn/15048/list.htm"),
  school("law", "\u6CD5\u5B66\u9662", "https://law.fudan.edu.cn/28093/list.htm"),
  school("econ", "\u7ECF\u6D4E\u5B66\u9662", "https://econ.fudan.edu.cn/xwzx/tzgg.htm"),
  school("fisf", "\u56FD\u9645\u91D1\u878D\u5B66\u9662", "https://fisf.fudan.edu.cn/lists-notice.html"),
  school("tourism", "\u65C5\u6E38\u5B66\u7CFB", "https://tourism.fudan.edu.cn/xwzx/tzgg.htm"),
  school("chm", "\u6587\u7269\u4E0E\u535A\u7269\u9986\u5B66\u7CFB", "https://www.chm.fudan.edu.cn/tzgg/list.htm"),
  school("math", "\u6570\u5B66\u79D1\u5B66\u5B66\u9662", "https://math.fudan.edu.cn/30286/list.htm"),
  school("phys", "\u7269\u7406\u5B66\u7CFB", "https://phys.fudan.edu.cn/7453/list.htm"),
  school("chemistry", "\u5316\u5B66\u7CFB", "https://chemistry.fudan.edu.cn/45208/list.htm"),
  school("polymer", "\u9AD8\u5206\u5B50\u79D1\u5B66\u7CFB", "https://polymer.fudan.edu.cn/31394/list.htm"),
  school("imp", "\u6838\u79D1\u5B66\u4E0E\u6280\u672F\u7CFB", "https://imp.fudan.edu.cn/48897/list.htm"),
  school("life", "\u751F\u547D\u79D1\u5B66\u5B66\u9662", "https://life.fudan.edu.cn/28139/list.htm"),
  school("environment", "\u73AF\u5883\u79D1\u5B66\u4E0E\u5DE5\u7A0B\u7CFB", "https://environment.fudan.edu.cn/26493/list.htm"),
  school("atmsci", "\u5927\u6C14\u4E0E\u6D77\u6D0B\u79D1\u5B66\u7CFB", "https://atmsci.fudan.edu.cn/annoucement/list.htm"),
  school("sds", "\u5927\u6570\u636E\u5B66\u9662", "https://sds.fudan.edu.cn/zytz/list.htm"),
  school("ai", "\u8BA1\u7B97\u4E0E\u667A\u80FD\u521B\u65B0\u5B66\u9662", "https://ai.fudan.edu.cn/24257/list.htm"),
  school("fit", "\u672A\u6765\u4FE1\u606F\u521B\u65B0\u5B66\u9662", "https://fit.fudan.edu.cn/Data/List/event"),
  school("icmne", "\u96C6\u6210\u7535\u8DEF\u4E0E\u5FAE\u7EB3\u7535\u5B50\u521B\u65B0\u5B66\u9662", "https://icmne.fudan.edu.cn/tzgg/list.htm"),
  school("bme", "\u751F\u7269\u533B\u5B66\u5DE5\u7A0B\u4E0E\u6280\u672F\u521B\u65B0\u5B66\u9662", "https://bme-college.fudan.edu.cn/tzgg/list.htm"),
  school("ciram", "\u667A\u80FD\u673A\u5668\u4EBA\u4E0E\u5148\u8FDB\u5236\u9020\u521B\u65B0\u5B66\u9662", "https://ciram.fudan.edu.cn/tzgg/list.htm"),
  school("icome", "\u667A\u80FD\u6750\u6599\u4E0E\u672A\u6765\u80FD\u6E90\u521B\u65B0\u5B66\u9662", "https://icome.fudan.edu.cn/49262/list.htm"),
  school("basicmed", "\u57FA\u7840\u533B\u5B66\u9662", "https://basicmed.fudan.edu.cn/30927/list.htm"),
  school("sph", "\u516C\u5171\u536B\u751F\u5B66\u9662", "https://sph.fudan.edu.cn/ac/7"),
  school("spfdu", "\u836F\u5B66\u9662", "https://spfdu.fudan.edu.cn/28477/list.htm"),
  school("nursing", "\u62A4\u7406\u5B66\u9662", "https://nursing.fudan.edu.cn/tzgg/list.htm"),
  school("sfms", "\u6CD5\u533B\u5B66\u4E0E\u6CD5\u5EAD\u79D1\u5B66\u5B66\u9662", "https://sfms.fudan.edu.cn/51779/list.htm")
];
function aliases(name) {
  const short = name.replace(/^(复旦大学)/, "").replace(/(创新学院|学院|学系|系)$/, "");
  return [name, short].filter((s) => s.length >= 2);
}
function ownSchoolSources(school2) {
  const text = school2?.trim();
  if (!text) return [];
  return NOTICE_SOURCES.filter((s) => s.group === "\u9662\u7CFB" && aliases(s.name).some((a) => text.includes(a) || a.includes(text)));
}
function findNoticeSource(query) {
  const q = query.trim();
  if (!q) return void 0;
  const alias = { \u56FD\u4EA4\u5904: "fao", \u56FD\u9645\u4EA4\u6D41\u5904: "fao", \u7814\u9662: "gs", \u7ECF\u9662: "econ", \u8BA1\u9662: "ai", \u8BA1\u7B97\u673A: "ai", \u5927\u6570\u636E: "sds", \u6570\u9662: "math", \u7269\u7406: "phys", \u5316\u5B66: "chemistry", \u65B0\u9662: "xwxy", \u5916\u9662: "dfll", \u4E2D\u6587\u7CFB: "chinese", \u6CD5\u9662: "law", \u5386\u53F2: "history", \u54F2\u9662: "philosophy", \u56FD\u52A1: "sirpa", \u4F53\u80B2\u90E8: "fdty", \u82F1\u8BED\u90E8: "cec", \u516C\u536B: "sph", \u836F\u5B66: "spfdu", \u62A4\u7406: "nursing", \u57FA\u533B: "basicmed", \u751F\u79D1: "life", \u73AF\u5883: "environment", \u5FAE\u7535\u5B50: "icmne", \u96C6\u6210\u7535\u8DEF: "icmne" };
  const id = alias[q] ?? q;
  return NOTICE_SOURCES.find((s) => s.id === id) ?? NOTICE_SOURCES.find((s) => s.name === q) ?? ownSchoolSources(q)[0] ?? NOTICE_SOURCES.find((s) => s.name.includes(q) || q.includes(s.name));
}

// src/services/webvpn.ts
import { createCipheriv } from "node:crypto";
var WEBVPN_HOST = "webvpn.fudan.edu.cn";
var WEBVPN_LOGIN_URL = `https://${WEBVPN_HOST}/login?cas_login=true`;
var KEY = Buffer.from("wrdvpnisthebest!", "utf8");
var cache = /* @__PURE__ */ new Map();
function encryptHost(host) {
  const hit = cache.get(host);
  if (hit) return hit;
  const padded = host + "0".repeat((16 - host.length % 16) % 16);
  const cipher = createCipheriv("aes-128-cfb", KEY, KEY);
  const enc = Buffer.concat([cipher.update(padded, "utf8"), cipher.final()]);
  const out = KEY.toString("hex") + enc.toString("hex").slice(0, host.length * 2);
  cache.set(host, out);
  return out;
}
function toWebvpnUrl(url) {
  const u = new URL(url);
  const scheme = u.protocol.replace(":", "");
  const segment = u.port ? `${scheme}-${u.port}` : scheme;
  return `https://${WEBVPN_HOST}/${segment}/${encryptHost(u.hostname)}${u.pathname}${u.search}`;
}
function isWebvpnLogin(url) {
  try {
    const u = new URL(url);
    return u.hostname === WEBVPN_HOST && u.pathname.startsWith("/login");
  } catch {
    return false;
  }
}

// src/services/treehole.ts
var FORUM = "https://forum.fduhole.com/api";
var AUTH = "https://auth.fduhole.com/api";
var DANKE = "https://danke.fduhole.com/api";
var TreeholeLoginError = class extends Error {
  constructor(message = "\u9700\u8981\u767B\u5F55\u6811\u6D1E\u8D26\u53F7\uFF1A\u8FD0\u884C fdu hole login\u3002") {
    super(message);
    this.name = "TreeholeLoginError";
  }
};
var TreeholeError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "TreeholeError";
  }
};
var clean2 = (s, max = 600) => (typeof s === "string" ? s : "").replace(/!\[[^\]]*\]\([^)]*\)/g, "[\u56FE\u7247]").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
var TreeholeClient = class {
  constructor(deps) {
    this.deps = deps;
  }
  deps;
  route;
  now() {
    return this.deps.now?.() ?? Date.now();
  }
  /** 校园网内直连，否则走 WebVPN（结果缓存 10 分钟） */
  async via() {
    if (this.route && this.now() < this.route.until) return this.route.via;
    let via = "webvpn";
    try {
      const res = await this.deps.fetch(`${FORUM}/divisions`, { timeoutMs: 3e3 });
      if (res.status > 0 && /json/.test(res.contentType)) via = "direct";
    } catch {
    }
    this.route = { via, until: this.now() + 10 * 6e4 };
    return via;
  }
  /** 发请求；WebVPN 会话失效时重新建立一次 */
  async send(url, init = {}) {
    const via = await this.via();
    if (via === "direct") {
      const direct = await this.deps.fetch(url, init).catch(() => void 0);
      if (direct && (/json/.test(direct.contentType) || !/<html/i.test(direct.text))) return direct;
      this.route = { via: "webvpn", until: this.now() + 10 * 6e4 };
    }
    const target = toWebvpnUrl(url);
    let res = await this.deps.fetch(target, init);
    if (vpnLoginPage(res)) {
      await this.deps.ensureWebvpn();
      res = await this.deps.fetch(target, init);
      if (vpnLoginPage(res)) throw new TreeholeError("WebVPN \u767B\u5F55\u6CA1\u6709\u6210\u529F\uFF1A\u8BF7\u5148\u8FD0\u884C fdu login --webvpn\uFF0C\u518D\u767B\u5F55\u6811\u6D1E\u3002");
    }
    return res;
  }
  parse(res) {
    if (!/json/.test(res.contentType)) {
      console.warn("[fdu \u6811\u6D1E] \u8FD4\u56DE\u7684\u4E0D\u662F\u6570\u636E", res.status, res.url, pageTitle(res.text));
      throw new TreeholeError(`\u6811\u6D1E\u670D\u52A1\u8FD4\u56DE\u7684\u4E0D\u662F\u6570\u636E\uFF08${res.status}\uFF0C${hostOf(res.url)}${pageTitle(res.text) ? `\u300C${pageTitle(res.text)}\u300D` : ""}\uFF09\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002`);
    }
    try {
      return JSON.parse(res.text);
    } catch {
      throw new TreeholeError("\u6811\u6D1E\u670D\u52A1\u8FD4\u56DE\u7684\u683C\u5F0F\u548C\u9884\u671F\u4E0D\u540C\u3002");
    }
  }
  /** 用树洞账号登录，换取令牌（密码不保存） */
  async login(email, password) {
    const res = await this.send(`${AUTH}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
    const data = this.parse(res);
    if (!data.access || !data.refresh) throw new TreeholeError(data.message ? `\u6811\u6D1E\u767B\u5F55\u5931\u8D25\uFF1A${data.message}` : "\u6811\u6D1E\u767B\u5F55\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u90AE\u7BB1\u548C\u5BC6\u7801\u3002");
    this.deps.tokens.set({ access: data.access, refresh: data.refresh });
  }
  logout() {
    this.deps.tokens.set(null);
  }
  loggedIn() {
    return !!this.deps.tokens.get();
  }
  async refresh() {
    const t = this.deps.tokens.get();
    if (!t) return false;
    const res = await this.send(`${AUTH}/refresh`, { method: "POST", headers: { Authorization: `Bearer ${t.refresh}` } });
    if (res.status >= 400) return false;
    const data = this.parse(res);
    if (!data.access) return false;
    this.deps.tokens.set({ access: data.access, refresh: data.refresh ?? t.refresh });
    return true;
  }
  /** 带令牌的 GET；令牌过期时刷新一次 */
  async get(url, params = {}) {
    const q = Object.entries(params).filter(([, v]) => v !== void 0 && v !== "").map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
    const full = q ? `${url}?${q}` : url;
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = this.deps.tokens.get();
      if (!t) throw new TreeholeLoginError();
      const res = await this.send(full, { headers: { Authorization: `Bearer ${t.access}`, Accept: "application/json" } });
      if (res.status === 401) {
        if (attempt === 0 && await this.refresh()) continue;
        this.deps.tokens.set(null);
        throw new TreeholeLoginError("\u6811\u6D1E\u767B\u5F55\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u8FD0\u884C fdu hole login \u91CD\u65B0\u767B\u5F55\u3002");
      }
      if (res.status === 404) throw new TreeholeError("\u6CA1\u6709\u627E\u5230\uFF08\u53EF\u80FD\u5DF2\u88AB\u5220\u9664\u6216\u9690\u85CF\uFF09\u3002");
      if (res.status >= 400) {
        const msg = (() => {
          try {
            return JSON.parse(res.text).message;
          } catch {
            return void 0;
          }
        })();
        throw new TreeholeError(`\u6811\u6D1E\u670D\u52A1\u8FD4\u56DE ${res.status}${msg ? `\uFF1A${msg}` : ""}`);
      }
      return this.parse(res);
    }
    throw new TreeholeLoginError();
  }
  // ---------- 树洞 ----------
  async searchFloors(keyword, opts = {}) {
    const now = Math.floor(this.now() / 1e3);
    const floors = await this.get(`${FORUM}/floors/search`, {
      search: keyword,
      offset: 0,
      size: Math.min(30, opts.limit ?? 15),
      accurate: opts.accurate ? "true" : void 0,
      start_time: opts.withinDays ? now - opts.withinDays * 86400 : void 0,
      end_time: opts.withinDays ? now : void 0
    });
    return (Array.isArray(floors) ? floors : []).map((f) => floorView(f, 300));
  }
  async hole(holeId, opts = {}) {
    const hole = await this.get(`${FORUM}/holes/${holeId}`);
    const floors = await this.get(`${FORUM}/floors`, { hole_id: holeId, start_floor: opts.start ?? 0, length: Math.min(50, opts.length ?? 30) });
    return { ...holeView(hole), floors: (Array.isArray(floors) ? floors : []).map((f) => floorView(f, 600)) };
  }
  async latest(opts = {}) {
    const holes = await this.get(`${FORUM}/holes`, { division_id: opts.divisionId ?? 1, length: Math.min(20, opts.length ?? 10), tag: opts.tag });
    return (Array.isArray(holes) ? holes : []).map(holeView);
  }
  async divisions() {
    const d = await this.get(`${FORUM}/divisions`);
    return (Array.isArray(d) ? d : []).map((x) => ({ division_id: x.division_id, name: x.name, description: clean2(x.description, 80) }));
  }
  // ---------- 旦克课程评价 ----------
  async searchCourses(keyword, limit = 10) {
    const r = await this.get(`${DANKE}/v3/course_groups/search`, { query: keyword, page: 1, page_size: Math.min(20, limit) });
    const items = Array.isArray(r) ? r : r.items ?? [];
    return items.map((g) => ({ course_group_id: g.id, name: g.name, code: g.code, department: g.department, credits: g.credits, campus: g.campus_name, review_count: g.review_count, course_count: g.course_count }));
  }
  async courseReviews(groupId, maxReviews = 12) {
    const g = await this.get(`${DANKE}/v3/course_groups/${groupId}`);
    const reviews = (g.course_list ?? []).flatMap((c) => (c.review_list ?? []).map((rv) => ({
      teachers: c.teachers,
      term: c.year ? `${c.year} \u5B66\u5E74\u7B2C ${c.semester ?? "?"} \u5B66\u671F` : void 0,
      title: clean2(rv.title, 80),
      content: clean2(rv.content, 800),
      time: rv.time_created?.slice(0, 10),
      rating: rv.rank ? { overall: rv.rank.overall, content: rv.rank.content, workload: rv.rank.workload, assessment: rv.rank.assessment } : void 0,
      votes: rv.vote,
      remark: rv.remark
    })));
    reviews.sort((a, b) => (b.remark ?? 0) - (a.remark ?? 0) || (b.votes ?? 0) - (a.votes ?? 0));
    return {
      name: g.name,
      code: g.code,
      department: g.department,
      credits: g.credits,
      review_count: g.review_count,
      teachers: [...new Set((g.course_list ?? []).map((c) => c.teachers).filter(Boolean))],
      reviews: reviews.slice(0, Math.min(30, maxReviews))
    };
  }
};
function vpnLoginPage(r) {
  if (isWebvpnLogin(r.url)) return true;
  if (/json/.test(r.contentType)) return false;
  return /<html/i.test(r.text) && (/cas_login|webvpn/i.test(r.text) || /资源访问|统一身份认证/.test(pageTitle(r.text)));
}
function pageTitle(html) {
  return (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "").trim().slice(0, 40);
}
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "\u672A\u77E5\u5730\u5740";
  }
}
function floorView(f, max) {
  return { hole_id: f.hole_id, floor_id: f.floor_id, floor: f.ranking, who: f.anonyname, time: f.time_created?.slice(0, 16).replace("T", " "), likes: f.like, reply_to: f.reply_to || void 0, content: clean2(f.content, max) };
}
function holeView(h) {
  const first2 = h.floors?.first_floor ?? h.floors?.prefetch?.[0];
  return { hole_id: h.hole_id, division_id: h.division_id, tags: (h.tags ?? []).map((t) => t.name).filter(Boolean), replies: h.reply, views: h.view, time: h.time_created?.slice(0, 16).replace("T", " "), first_floor: clean2(first2?.content, 300) };
}

// src/services/calendar.ts
var SEMESTERS = [
  {
    name: "2026-2027\u5B66\u5E741\u5B66\u671F",
    week0Sunday: "2026-08-30",
    end: "2027-01-09",
    phases: [
      { weeks: [0], note: "\u62A5\u5230\u3001\u5165\u5B66\u6559\u80B2\u3001\u8865\u8003\u4E0E\u6CE8\u518C" },
      { weeks: [1, 2], note: "\u5F00\u5B66\u521D\uFF08\u6309\u60EF\u4F8B\u4E3A\u9009\u8BFE\u8C03\u6574\u671F\uFF09" },
      { weeks: [8, 9], note: "\u671F\u4E2D\uFF08\u6309\u60EF\u4F8B\uFF09" },
      { weeks: [16], note: "\u901A\u8BC6\u6559\u80B2\u8BFE\u7A0B\u8003\u8BD5" },
      { weeks: [17, 18], note: "\u505C\u8BFE\u8003\u8BD5\u5468" }
    ],
    holidays: [
      { from: "2026-09-25", to: "2026-09-25", note: "\u4E2D\u79CB\u8282\uFF08\u4EE5\u5B66\u6821\u901A\u77E5\u4E3A\u51C6\uFF09", tentative: true },
      { from: "2026-10-01", to: "2026-10-07", note: "\u56FD\u5E86\u8282\uFF08\u4EE5\u5B66\u6821\u901A\u77E5\u4E3A\u51C6\uFF09", tentative: true },
      { from: "2027-01-01", to: "2027-01-01", note: "\u5143\u65E6\uFF08\u4EE5\u5B66\u6821\u901A\u77E5\u4E3A\u51C6\uFF09", tentative: true }
    ]
  },
  {
    name: "2026-2027\u5B66\u5E742\u5B66\u671F",
    week0Sunday: "2027-02-14",
    end: "2027-06-26",
    phases: [
      { weeks: [0], note: "\u8865\u8003\u4E0E\u6CE8\u518C" },
      { weeks: [1, 2], note: "\u5F00\u5B66\u521D\uFF08\u6309\u60EF\u4F8B\u4E3A\u9009\u8BFE\u8C03\u6574\u671F\uFF09" },
      { weeks: [8, 9], note: "\u671F\u4E2D\uFF08\u6309\u60EF\u4F8B\uFF09" },
      { weeks: [16], note: "\u901A\u8BC6\u6559\u80B2\u8BFE\u7A0B\u8003\u8BD5" },
      { weeks: [17, 18], note: "\u505C\u8BFE\u8003\u8BD5\u5468" }
    ],
    holidays: [
      { from: "2027-04-05", to: "2027-04-05", note: "\u6E05\u660E\u8282\uFF08\u4EE5\u5B66\u6821\u901A\u77E5\u4E3A\u51C6\uFF09", tentative: true },
      { from: "2027-05-01", to: "2027-05-05", note: "\u52B3\u52A8\u8282\uFF08\u4EE5\u5B66\u6821\u901A\u77E5\u4E3A\u51C6\uFF09", tentative: true },
      { from: "2027-05-14", to: "2027-05-14", note: "\u6821\u7530\u5F84\u8FD0\u52A8\u4F1A\uFF0C\u505C\u8BFE\u4E00\u5929" },
      { from: "2027-06-09", to: "2027-06-09", note: "\u7AEF\u5348\u8282\uFF08\u4EE5\u5B66\u6821\u901A\u77E5\u4E3A\u51C6\uFF09", tentative: true }
    ]
  }
];
var DAY = 864e5;
var WEEKDAY = ["", "\u5468\u4E00", "\u5468\u4E8C", "\u5468\u4E09", "\u5468\u56DB", "\u5468\u4E94", "\u5468\u516D", "\u5468\u65E5"];
function shanghaiDay(t = Date.now()) {
  return new Date(+t + 8 * 36e5).toISOString().slice(0, 10);
}
function addDays(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}
function weekdayOf(day) {
  const d = (/* @__PURE__ */ new Date(`${day}T00:00:00Z`)).getUTCDay();
  return d === 0 ? 7 : d;
}
function sundayOf(day) {
  return addDays(day, -(/* @__PURE__ */ new Date(`${day}T00:00:00Z`)).getUTCDay());
}
function shanghaiTime(day, hhmm) {
  return new Date(Date.parse(`${day}T${hhmm}:00+08:00`)).toISOString();
}
function week0SundayFor(semester) {
  const known = SEMESTERS.find((s) => semester.name && s.name === semester.name.replace(/\s+/g, ""));
  if (known) return known.week0Sunday;
  if (semester.startDate && /^\d{4}-\d{2}-\d{2}$/.test(semester.startDate)) return addDays(sundayOf(semester.startDate), -7);
  return void 0;
}
function weekInfo(day, jw) {
  const weekday = weekdayOf(day);
  const base = { date: day, weekday, weekdayName: WEEKDAY[weekday] };
  const known = SEMESTERS.find((s) => day >= s.week0Sunday && day <= s.end);
  if (known) {
    const week = Math.floor((Date.parse(day) - Date.parse(known.week0Sunday)) / DAY / 7);
    const holiday = known.holidays.find((h) => day >= h.from && day <= h.to)?.note;
    const note = known.phases.find((p) => p.weeks.includes(week))?.note;
    return { ...base, semester: known.name, week, weekSunday: sundayOf(day), holiday, note, source: "calendar" };
  }
  const w0 = jw && week0SundayFor(jw);
  if (w0 && day >= w0) {
    const week = Math.floor((Date.parse(day) - Date.parse(w0)) / DAY / 7);
    if (week <= 20) return { ...base, semester: jw?.name, week, weekSunday: sundayOf(day), source: "jw" };
  }
  return { ...base, source: "none" };
}
function dateOfWeek(week0Sunday, week, weekday) {
  return addDays(week0Sunday, week * 7 + weekday % 7);
}
function holidayOn(day) {
  for (const s of SEMESTERS) {
    const h = s.holidays.find((x) => day >= x.from && day <= x.to);
    if (h) return h.note;
  }
  return void 0;
}

// src/services/overview.ts
var DAY2 = 864e5;
var showTime = (iso) => new Date(iso).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
async function settle(f) {
  try {
    return { ok: true, value: await f() };
  } catch (e) {
    const err = toFduError(e);
    return { ok: false, error: { code: err.code, message: err.message, ...err.hint ? { hint: err.hint } : {} } };
  }
}
function classesOn(table, day) {
  const info = weekInfo(day, table.semester);
  if (info.week === void 0 || holidayOn(day)) return [];
  const out = [];
  for (const c of table.courses) {
    for (const s of c.sessions) {
      if (s.weekday !== info.weekday || !s.weeks.includes(info.week)) continue;
      out.push({ course: c.course, start: s.start, end: s.end, startsAt: shanghaiTime(day, s.start), endsAt: shanghaiTime(day, s.end), location: s.location, teachers: c.teachers, periods: s.periods });
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}
async function overview(deps, opts) {
  const [table, due, exams] = await Promise.all([settle(deps.timetable), settle(deps.assignments), settle(deps.exams)]);
  const errors = {};
  if (!table.ok) errors.timetable = table.error;
  if (!due.ok) errors.assignments = due.error;
  if (!exams.ok) errors.exams = exams.error;
  const all = [table, due, exams];
  if (all.every((r) => !r.ok) && new Set(all.map((r) => !r.ok && r.error.code)).size === 1) {
    const first2 = Object.values(errors)[0];
    throw new FduError(first2.code, first2.message, first2.hint);
  }
  const days = [];
  for (let d = opts.from; d <= opts.to; d = addDays(d, 1)) {
    const info = weekInfo(d, table.ok ? table.value.semester : void 0);
    days.push({ ...info, classes: table.ok ? classesOn(table.value, d) : [] });
  }
  const start = Date.parse(`${opts.from}T00:00:00+08:00`);
  const end = Date.parse(`${opts.to}T00:00:00+08:00`) + DAY2;
  const dueEnd = Math.max(end, start + (opts.deadlineDays ?? 0) * DAY2);
  const examEnd = Math.max(end, start + (opts.examDays ?? 0) * DAY2);
  const pending = due.ok ? due.value.filter((a) => !a.done && a.dueAt) : [];
  return {
    from: opts.from,
    to: opts.to,
    days,
    deadlines: pending.filter((a) => Date.parse(a.dueAt) >= Math.min(start, opts.now) && Date.parse(a.dueAt) < dueEnd).sort((a, b) => a.dueAt.localeCompare(b.dueAt)).map((a) => ({ ...a, dueAtShanghai: showTime(a.dueAt) })),
    overdue: pending.filter((a) => Date.parse(a.dueAt) < Math.min(start, opts.now) && Date.parse(a.dueAt) > opts.now - 14 * DAY2).map((a) => ({ ...a, dueAtShanghai: showTime(a.dueAt) })),
    exams: exams.ok ? exams.value.filter((e) => Date.parse(e.startsAt) >= start && Date.parse(e.startsAt) < examEnd).map((e) => ({ ...e, startsAtShanghai: showTime(e.startsAt) })) : [],
    ...Object.keys(errors).length ? { errors } : {}
  };
}
function todayRange(now, date) {
  const day = date ?? shanghaiDay(now);
  return { from: day, to: day, deadlineDays: 3, examDays: 7 };
}
function weekRange(now, date) {
  const sunday = sundayOf(date ?? shanghaiDay(now));
  return { from: sunday, to: addDays(sunday, 6) };
}
function allSessions(table) {
  const w0 = table.semester ? week0SundayFor(table.semester) : void 0;
  if (!w0) return { sessions: [], skipped: [] };
  const sessions = [];
  const skipped = [];
  for (const c of table.courses) {
    for (const s of c.sessions) {
      for (const week of s.weeks) {
        const date = dateOfWeek(w0, week, s.weekday);
        const holiday = holidayOn(date);
        if (holiday) {
          skipped.push({ date, course: c.course, reason: holiday });
          continue;
        }
        sessions.push({ date, week, course: c.course, start: s.start, end: s.end, startsAt: shanghaiTime(date, s.start), endsAt: shanghaiTime(date, s.end), location: s.location, teachers: c.teachers, periods: s.periods });
      }
    }
  }
  return { sessions: sessions.sort((a, b) => a.startsAt.localeCompare(b.startsAt)), skipped, week0Sunday: w0 };
}

// src/services/ics.ts
import { createHash as createHash2 } from "node:crypto";
function icsText(s) {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
function foldLine(line) {
  const out = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    const limit = out.length ? 74 : 75;
    if (bytes + n > limit) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}
var stamp = (iso) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
function buildIcs(events, opts) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//fdu-cli//Fudan campus calendar//ZH",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(opts.name)}`,
    "X-WR-TIMEZONE:Asia/Shanghai"
  ];
  const dtstamp = stamp(new Date(opts.now).toISOString());
  for (const e of events) {
    const uid = `${createHash2("sha1").update(e.key).digest("hex").slice(0, 20)}@fdu-cli`;
    lines.push("BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${dtstamp}`, `DTSTART:${stamp(e.startsAt)}`, `DTEND:${stamp(e.endsAt)}`, `SUMMARY:${icsText(e.summary)}`);
    if (e.location) lines.push(`LOCATION:${icsText(e.location)}`);
    if (e.description) lines.push(`DESCRIPTION:${icsText(e.description)}`);
    if (e.url && /^https?:\/\//.test(e.url)) lines.push(`URL:${e.url}`);
    if (e.categories?.length) lines.push(`CATEGORIES:${e.categories.map(icsText).join(",")}`);
    if (e.alarmMinutes) lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsText(e.summary)}`, `TRIGGER:-PT${e.alarmMinutes}M`, "END:VALARM");
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r
`;
}

// src/services/doctor.ts
var HOSTS = [
  { name: "\u7EDF\u4E00\u8EAB\u4EFD\u8BA4\u8BC1", url: "https://id.fudan.edu.cn/", required: true },
  { name: "eLearning", url: "https://elearning.fudan.edu.cn/", required: true },
  { name: "\u6559\u52A1\u7CFB\u7EDF", url: "https://fdjwgl.fudan.edu.cn/student/home", required: true },
  { name: "WebVPN", url: "https://webvpn.fudan.edu.cn/", required: false, note: "\u6821\u5916\u8BBF\u95EE\u6811\u6D1E\u8981\u7528" },
  { name: "\u56FE\u4E66\u9986", url: "https://mlibrary.fudan.edu.cn/", required: false },
  { name: "\u6811\u6D1E", url: "https://forum.fduhole.com/api/divisions", required: false, note: "\u6821\u5916\u8FDE\u4E0D\u4E0A\u662F\u6B63\u5E38\u7684\uFF0C\u4F1A\u81EA\u52A8\u8D70 WebVPN" }
];
async function runDoctor(d) {
  const checks = [];
  const major = Number(d.nodeVersion.replace(/^v/, "").split(".")[0]);
  checks.push(major >= 20 ? { name: "Node.js", status: "ok", detail: d.nodeVersion } : { name: "Node.js", status: "fail", detail: `${d.nodeVersion}\uFF0C\u9700\u8981 20 \u6216\u66F4\u65B0`, fix: "\u5230 https://nodejs.org \u5B89\u88C5\u65B0\u7248 Node.js" });
  const dir = d.configDirState();
  if (!dir.writable) checks.push({ name: "\u914D\u7F6E\u76EE\u5F55", status: "fail", detail: `${d.configDir} \u4E0D\u80FD\u5199\u5165`, fix: "\u68C0\u67E5\u8FD9\u4E2A\u76EE\u5F55\u7684\u6743\u9650\uFF0C\u6216\u7528\u73AF\u5883\u53D8\u91CF FDU_HOME \u6362\u4E00\u4E2A\u4F4D\u7F6E" });
  else if (d.platform !== "win32" && dir.mode !== void 0 && dir.mode & 63) checks.push({ name: "\u914D\u7F6E\u76EE\u5F55", status: "warn", detail: `${d.configDir} \u5176\u4ED6\u7528\u6237\u4E5F\u80FD\u8BBF\u95EE\uFF08\u6743\u9650 ${(dir.mode & 511).toString(8)}\uFF09`, fix: `\u8FD0\u884C chmod 700 "${d.configDir}"` });
  else checks.push({ name: "\u914D\u7F6E\u76EE\u5F55", status: "ok", detail: d.configDir });
  try {
    checks.push({ name: "\u6D4F\u89C8\u5668", status: "ok", detail: await d.browser() });
  } catch (e) {
    checks.push({ name: "\u6D4F\u89C8\u5668", status: "fail", detail: `\u6CA1\u6709\u627E\u5230\u53EF\u7528\u7684\u6D4F\u89C8\u5668\uFF1A${String(e.message ?? e).split("\n")[0].slice(0, 160)}`, fix: "\u5B89\u88C5 Chrome \u6216 Edge\uFF1B\u6216\u8005\u8BBE\u7F6E FDU_BROWSER \u4E3A Chromium \u5185\u6838\u6D4F\u89C8\u5668\u7684\u8DEF\u5F84\uFF1B\u6216\u8005\u8FD0\u884C npx playwright install chromium" });
  }
  if (d.proxy) checks.push({ name: "\u4EE3\u7406", status: "ok", detail: `\u4F7F\u7528\u4EE3\u7406 ${d.proxy.replace(/\/\/[^@/]*@/, "//***@")}` });
  const clean3 = (e) => String(e.message ?? e).replace(/^apiRequestContext\.\w+:\s*/, "").split("\n")[0].slice(0, 120);
  const reach = await Promise.all(HOSTS.map(async (h) => {
    try {
      const r = await d.reach(h.url);
      const level = r.status >= 200 && r.status < 400 ? "ok" : r.status >= 400 && r.status < 500 ? "warn" : h.required ? "fail" : "warn";
      return { h, level, detail: `HTTP ${r.status}${r.status === 403 ? "\uFF08\u88AB\u62D2\u7EDD\u8BBF\u95EE\uFF0C\u68C0\u67E5\u4EE3\u7406\u6216\u7F51\u7EDC\u9650\u5236\uFF09" : ""}` };
    } catch (e) {
      return { h, level: h.required ? "fail" : "warn", detail: `\u8FDE\u4E0D\u4E0A\uFF1A${clean3(e)}` };
    }
  }));
  for (const { h, level, detail } of reach) {
    checks.push({
      name: `\u7F51\u7EDC\uFF1A${h.name}`,
      status: level,
      detail: level !== "ok" && h.note ? `${detail}\uFF08${h.note}\uFF09` : detail,
      fix: level !== "ok" && h.required ? "\u68C0\u67E5\u7F51\u7EDC\uFF1B\u5728\u6821\u5916\u8BF7\u786E\u8BA4\u6D4F\u89C8\u5668\u80FD\u6253\u5F00\u8FD9\u4E2A\u7F51\u7AD9\uFF0C\u5FC5\u8981\u65F6\u8FDE\u5B66\u6821 VPN\uFF1B\u7528\u4E86\u4EE3\u7406\u65F6\u68C0\u67E5 HTTPS_PROXY" : void 0
    });
  }
  try {
    const l = await d.login();
    if (!l.hasState) checks.push({ name: "\u590D\u65E6\u8D26\u53F7", status: "warn", detail: "\u8FD8\u6CA1\u6709\u767B\u5F55", fix: "\u8FD0\u884C fdu login" });
    else {
      checks.push(l.elearning === "ok" ? { name: "\u767B\u5F55\uFF1AeLearning", status: "ok", detail: "\u5DF2\u767B\u5F55" } : { name: "\u767B\u5F55\uFF1AeLearning", status: "fail", detail: `\u72B6\u6001\uFF1A${l.elearning}`, fix: "\u8FD0\u884C fdu login\uFF08\u767B\u5F55\u8FC7\u671F\u9700\u8981\u91CD\u65B0\u767B\u5F55\uFF09" });
      checks.push(l.jwfw === "ok" ? { name: "\u767B\u5F55\uFF1A\u6559\u52A1\u7CFB\u7EDF", status: "ok", detail: "\u5DF2\u767B\u5F55" } : { name: "\u767B\u5F55\uFF1A\u6559\u52A1\u7CFB\u7EDF", status: "warn", detail: `\u72B6\u6001\uFF1A${l.jwfw}`, fix: "\u8FD0\u884C fdu login --force \u91CD\u65B0\u767B\u5F55" });
      checks.push(l.webvpn ? { name: "\u767B\u5F55\uFF1AWebVPN", status: "ok", detail: "\u5DF2\u5EFA\u7ACB" } : { name: "\u767B\u5F55\uFF1AWebVPN", status: "warn", detail: "\u6CA1\u6709 WebVPN \u4F1A\u8BDD\uFF08\u53EA\u5728\u6821\u5916\u8BBF\u95EE\u6811\u6D1E\u65F6\u9700\u8981\uFF09", fix: "\u9700\u8981\u65F6\u8FD0\u884C fdu login --webvpn" });
    }
  } catch (e) {
    checks.push({ name: "\u590D\u65E6\u8D26\u53F7", status: "warn", detail: `\u67E5\u4E0D\u5230\u767B\u5F55\u72B6\u6001\uFF1A${String(e.message ?? e).slice(0, 120)}` });
  }
  checks.push(d.treehole ? { name: "\u6811\u6D1E\u8D26\u53F7", status: "ok", detail: "\u5DF2\u767B\u5F55" } : { name: "\u6811\u6D1E\u8D26\u53F7", status: "warn", detail: "\u6CA1\u6709\u767B\u5F55\uFF08\u4E0D\u7528\u6811\u6D1E\u3001\u65E6\u514B\u53EF\u4EE5\u5FFD\u7565\uFF09", fix: "fdu hole login --email \u5B66\u53F7@m.fudan.edu.cn" });
  checks.push(d.mail ? { name: "\u5B66\u751F\u90AE\u7BB1", status: "ok", detail: "\u5DF2\u914D\u7F6E" } : { name: "\u5B66\u751F\u90AE\u7BB1", status: "warn", detail: "\u6CA1\u6709\u914D\u7F6E\uFF08\u4E0D\u67E5\u90AE\u4EF6\u53EF\u4EE5\u5FFD\u7565\uFF09", fix: "fdu mail setup --user \u5B66\u53F7@m.fudan.edu.cn" });
  return { healthy: !checks.some((c) => c.status === "fail"), checks };
}

// src/services/icourse.ts
var ICOURSE = "https://icourse.fudan.edu.cn";
var CAS_LOGIN = `${ICOURSE}/casapi/index.php?r=auth/login&school_login=1`;
var TENANT = "222";
var DATE_IN_TITLE = /^(\d{4}-\d{2}-\d{2})/;
function clock(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor(sec % 3600 / 60);
  const s = Math.floor(sec % 60);
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
var IcourseClient = class _IcourseClient {
  constructor(deps) {
    this.deps = deps;
  }
  deps;
  route;
  loggedIn = false;
  url(path) {
    const u = `${ICOURSE}${path}`;
    return this.route === "webvpn" ? toWebvpnUrl(u) : u;
  }
  static json(res) {
    if (!/json/.test(res.contentType) && !/^\s*\{/.test(res.text)) return null;
    try {
      return JSON.parse(res.text);
    } catch {
      return null;
    }
  }
  /** 身份接口返回 code 0 / 200 才算登录了 iCourse */
  async whoami() {
    try {
      const res = await this.deps.fetch(this.url("/userapi/v1/infosimple"), { timeoutMs: 1e4 });
      if (this.route === "webvpn" && isWebvpnLogin(res.url)) return false;
      const j = _IcourseClient.json(res);
      return !!j && (j.code === 0 || j.code === 200 || j.code === "0");
    } catch {
      return false;
    }
  }
  /** 选路线（直连 / WebVPN）并确保登录了 iCourse */
  async ready() {
    if (this.loggedIn) return;
    if (!this.route) {
      try {
        const res = await this.deps.fetch(`${ICOURSE}/userapi/v1/infosimple`, { timeoutMs: 4e3 });
        this.route = _IcourseClient.json(res) ? "direct" : "webvpn";
      } catch {
        this.route = "webvpn";
      }
    }
    if (this.route === "webvpn") await this.deps.ensureWebvpn();
    if (await this.whoami()) {
      this.loggedIn = true;
      return;
    }
    const entry = this.route === "webvpn" ? toWebvpnUrl(CAS_LOGIN) : CAS_LOGIN;
    await this.deps.openInBrowser(entry, (u) => {
      try {
        const x = new URL(u);
        const onIcourse = this.route === "webvpn" ? x.hostname === "webvpn.fudan.edu.cn" && !x.pathname.startsWith("/login") : x.hostname === "icourse.fudan.edu.cn";
        return onIcourse && !x.pathname.includes("/casapi/");
      } catch {
        return false;
      }
    });
    if (!await this.whoami()) throw new FduError("NEED_LOGIN", "\u6CA1\u80FD\u767B\u5F55 iCourse\u3002", "\u5148\u8FD0\u884C `fdu login`\uFF08\u6821\u5916\u518D\u52A0 --webvpn\uFF09\uFF0C\u7136\u540E\u91CD\u8BD5\u3002");
    this.loggedIn = true;
  }
  async get(path, params) {
    await this.ready();
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const res = await this.deps.fetch(this.url(`${path}?${qs}`));
    const j = _IcourseClient.json(res);
    if (!j) throw new FduError("UPSTREAM", `iCourse \u8FD4\u56DE\u7684\u4E0D\u662F\u6570\u636E\uFF08${res.status}\uFF09\u3002`, "\u7A0D\u540E\u518D\u8BD5\uFF1B\u4E00\u76F4\u8FD9\u6837\u7684\u8BDD\u8FD0\u884C fdu login \u91CD\u65B0\u767B\u5F55\u3002");
    return j;
  }
  /** 一个学期的课程列表（一页）。term 是 iCourse 自己的学期编号 */
  async courseList(term, page, perPage, title) {
    const j = await this.get("/portal/courseapi/v3/multi-search/get-course-list", { tenant: TENANT, term, page, per_page: perPage, ...title ? { title } : {} });
    if (j.code !== 0) throw new FduError("UPSTREAM", `iCourse \u8BFE\u7A0B\u5217\u8868\u8BFB\u53D6\u5931\u8D25\uFF1A${j.msg ?? j.code}`);
    const d = j.data ?? {};
    const rows = Array.isArray(d.list) ? d.list : [];
    return {
      total: Number(d.total ?? 0) || 0,
      courses: rows.flatMap((r) => {
        const id = r.id ?? r.course_id;
        if (id === void 0 || id === null) return [];
        const dept2 = r.kkxy_name ?? r.school_name ?? r.dept_name;
        return [{ courseId: String(id), title: String(r.title ?? ""), teacher: String(r.realname ?? r.teacher ?? ""), ...dept2 ? { department: String(dept2) } : {}, ...r.term_name ? { term: String(r.term_name) } : {} }];
      })
    };
  }
  /**
   * 有课程的学期（新的在前）。iCourse 的学期编号是递增的整数，从大往小找。
   * newestOnly：找到最新的一个就停（搜索课程时用，少发请求）。
   */
  async terms(opts = {}) {
    const out = [];
    for (let code = opts.from ?? 40; code >= (opts.to ?? 10); code--) {
      const r = await this.courseList(String(code), 1, 1).catch(() => void 0);
      if (!r?.total) continue;
      out.push({ term: String(code), name: r.courses[0]?.term ?? String(code), courses: r.total });
      if (opts.newestOnly) break;
    }
    return out;
  }
  /** 按课程名找课程（默认最新学期） */
  async search(keyword, opts = {}) {
    const term = opts.term ?? (await this.terms({ newestOnly: true }))[0]?.term;
    if (!term) throw new FduError("NOT_FOUND", "\u6CA1\u6709\u5728 iCourse \u4E0A\u627E\u5230\u6709\u8BFE\u7A0B\u7684\u5B66\u671F\u3002");
    const r = await this.courseList(term, 1, Math.min(opts.limit ?? 20, 100), keyword);
    const k = keyword.toLowerCase();
    return { term, courses: r.courses.filter((c) => `${c.title} ${c.teacher}`.toLowerCase().includes(k)).slice(0, opts.limit ?? 20) };
  }
  /** 一门课的全部讲次（按日期排序），以及有没有回放 */
  async lectures(courseId) {
    if (!/^\d+$/.test(courseId)) throw new FduError("BAD_ARGS", "\u8BFE\u7A0B\u53F7\u5E94\u8BE5\u662F\u6570\u5B57\uFF08\u6765\u81EA fdu icourse search\uFF09\u3002");
    const j = await this.get("/courseapi/v3/multi-search/get-course-detail", { course_id: courseId });
    if (j.code !== 0) throw new FduError("NOT_FOUND", `iCourse \u4E0A\u6CA1\u6709\u627E\u5230\u8FD9\u95E8\u8BFE\uFF1A${j.msg ?? j.code}`);
    const d = j.data ?? {};
    const lectures = [];
    const tree = d.sub_list && typeof d.sub_list === "object" ? d.sub_list : {};
    for (const [y, months] of Object.entries(tree)) {
      for (const [m, days] of Object.entries(months ?? {})) {
        for (const [day, items] of Object.entries(days ?? {})) {
          for (const raw of Array.isArray(items) ? items : []) {
            if (raw.id === void 0 || raw.id === null) continue;
            const title = String(raw.sub_title ?? "");
            const date = DATE_IN_TITLE.exec(title)?.[1] ?? `${y.padStart(4, "0")}-${m.padStart(2, "0")}-${day.padStart(2, "0")}`;
            lectures.push({ lectureId: String(raw.id), title, date, ...raw.lecturer_name ? { lecturer: String(raw.lecturer_name) } : {}, hasPlayback: String(raw.playback_status) === "1" });
          }
        }
      }
    }
    lectures.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
    return { courseId, title: String(d.title ?? ""), teacher: String(d.realname ?? ""), lectures };
  }
  /**
   * 回放是否已经开放。学校对新回放有审核期，接口返回非 0（如「视频未到开放时间」）时按未开放处理。
   */
  async playbackOpen(courseId, lectureId) {
    const j = await this.get("/courseapi/v3/portal-home-setting/get-sub-info", { course_id: courseId, sub_id: lectureId });
    if (j.code === 0) return { open: true };
    return { open: false, reason: j.msg ? String(j.msg) : `iCourse \u8FD4\u56DE ${String(j.code)}` };
  }
  /** 课堂文字稿（平台自动转写，按时间分段）。只读已经开放的回放 */
  async transcript(courseId, lectureId) {
    if (!/^\d+$/.test(lectureId)) throw new FduError("BAD_ARGS", "\u8BB2\u6B21\u53F7\u5E94\u8BE5\u662F\u6570\u5B57\uFF08\u6765\u81EA fdu icourse lectures\uFF09\u3002");
    const gate = await this.playbackOpen(courseId, lectureId);
    if (!gate.open) throw new FduError("NOT_FOUND", `\u8FD9\u4E00\u8BB2\u7684\u56DE\u653E\u8FD8\u6CA1\u5F00\u653E\uFF08${gate.reason}\uFF09\u3002`, "\u5B66\u6821\u5BF9\u65B0\u56DE\u653E\u6709\u5BA1\u6838\u671F\uFF0C\u901A\u5E38\u4E00\u4E24\u5929\u540E\u5F00\u653E\uFF0C\u5230\u65F6\u518D\u8BD5\u3002");
    const j = await this.get("/courseapi/v3/web-socket/search-trans-result", { sub_id: lectureId, format: "json" });
    if (j.code !== 0) throw new FduError("UPSTREAM", `\u6587\u5B57\u7A3F\u8BFB\u53D6\u5931\u8D25\uFF1A${j.msg ?? j.code}`);
    const first2 = Array.isArray(j.list) ? j.list[0] : void 0;
    const raw = Array.isArray(first2?.all_content) ? first2.all_content : [];
    const segments = raw.map((s) => ({ start: Number(s.BeginSec ?? 0) || 0, end: Number(s.EndSec ?? s.BeginSec ?? 0) || 0, text: String(s.Text ?? "").trim() })).filter((s) => s.text).sort((a, b) => a.start - b.start);
    return { segments };
  }
};

// src/services/ecard.ts
import { load as load6 } from "cheerio";
var ECARD = "https://ecard.fudan.edu.cn";
var CONSUME_INDEX = `${ECARD}/epay/consume/index`;
var CONSUME_QUERY = `${ECARD}/epay/consume/query`;
var INCOME = /充值|退款|补助|转入|圈存|返还|冲正|撤销/;
var DT = /(\d{4})[.\-/年](\d{1,2})[.\-/月](\d{1,2})日?\s*(?:(\d{1,2}):(\d{2})(?::(\d{2}))?)?/;
var TIME_ONLY = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
var shanghaiIso = (y, mo, d, h = "0", mi = "0", s = "0") => new Date(Date.UTC(+y, +mo - 1, +d, +h - 8, +mi, +s)).toISOString();
function parseCsrf(html) {
  return load6(html)('meta[name="_csrf"]').attr("content")?.trim() || void 0;
}
function parseConsumePage(body3) {
  const inner = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(body3)?.[1] ?? body3;
  const $ = load6(inner);
  const pageText = $.root().text().replace(/\s+/g, "");
  const pages = /\d+\/(\d+)页/.exec(pageText)?.[1];
  const records = [];
  $("tr").each((_, tr) => {
    const cells = $(tr).find("td").map((_i, td) => $(td).text().replace(/ /g, " ").replace(/\s+/g, " ").trim()).get();
    if (cells.length < 4) return;
    let rest = cells;
    const m = DT.exec(cells[0]);
    if (!m) return;
    const [, y, mo, d] = m;
    let [h, mi, sec] = [m[4] ?? "0", m[5] ?? "0", m[6] ?? "0"];
    const t = m[4] === void 0 ? TIME_ONLY.exec(cells[1]) : null;
    if (t) {
      [h, mi, sec] = [t[1], t[2], t[3] ?? "0"];
      rest = [cells[0], ...cells.slice(2)];
    }
    const type = rest[1] ?? "";
    const merchant = rest[2] ?? "";
    const rawAmount = (rest[3] ?? "").replace(/[,，¥￥元\s]/g, "");
    const num3 = /[-+]?\d+(?:\.\d+)?/.exec(rawAmount)?.[0];
    if (num3 === void 0) return;
    const value = Math.abs(Number(num3));
    const signed = /^-/.test(num3) ? -value : /^\+/.test(num3) ? value : INCOME.test(type) ? value : -value;
    records.push({ time: shanghaiIso(y, mo, d, h, mi, sec), type, merchant, amount: Math.round(signed * 100) / 100 });
  });
  return { records, pages: pages ? Number(pages) : void 0 };
}
var pad = (n) => String(n).padStart(2, "0");
var ymd = (t) => {
  const d = new Date(t + 8 * 36e5);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
async function readCardRecords(reader, range, opts = {}) {
  let index = await reader.getText(CONSUME_INDEX);
  let csrf = parseCsrf(index.text);
  if (!csrf && reader.render) {
    await reader.render(CONSUME_INDEX, (html) => !!parseCsrf(html));
    index = await reader.getText(CONSUME_INDEX);
    csrf = parseCsrf(index.text);
  }
  if (!csrf) {
    if (/uis\.fudan|id\.fudan|统一身份认证/.test(index.url + index.text.slice(0, 2e3))) throw new NeedLoginError("jwfw");
    throw new FduError("FORMAT_CHANGED", "\u6CA1\u6709\u5728\u6821\u56ED\u5361\u6D88\u8D39\u67E5\u8BE2\u9875\u4E0A\u627E\u5230\u67E5\u8BE2\u5165\u53E3\uFF0C\u5B66\u6821\u9875\u9762\u53EF\u80FD\u66F4\u65B0\u4E86\u3002");
  }
  const maxPages = opts.maxPages ?? 30;
  const all = [];
  let pages = 1;
  let truncated = false;
  for (let page = 1; page <= pages; page++) {
    if (page > maxPages) {
      truncated = true;
      break;
    }
    const body3 = new URLSearchParams({
      aaxmlrequest: "true",
      pageNo: String(page),
      tabNo: "1",
      "pager.offset": "10",
      tradename: "",
      starttime: range.from,
      endtime: range.to,
      timetype: "1",
      _tradedirect: "on",
      _csrf: csrf
    }).toString();
    const res = await reader.getText(CONSUME_QUERY, {
      method: "POST",
      body: body3,
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/xml", Origin: ECARD, Referer: CONSUME_INDEX }
    });
    if (res.status >= 400) throw new FduError("UPSTREAM", `\u6821\u56ED\u5361\u7CFB\u7EDF\u8FD4\u56DE ${res.status}`);
    const r = parseConsumePage(res.text);
    if (page === 1 && r.pages) pages = r.pages;
    if (!r.records.length) break;
    all.push(...r.records);
    if (!r.pages && page === pages) pages++;
  }
  const seen = /* @__PURE__ */ new Set();
  const records = all.filter((x) => {
    const k = `${x.time}|${x.merchant}|${x.amount}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => b.time.localeCompare(a.time));
  return { records, truncated };
}
function cardRange(now, opts) {
  const to = opts.to ?? ymd(now);
  const from = opts.from ?? ymd(Date.parse(`${to}T12:00:00+08:00`) - ((opts.days ?? 7) - 1) * 864e5);
  if (from > to) throw new FduError("BAD_ARGS", "\u5F00\u59CB\u65E5\u671F\u4E0D\u80FD\u665A\u4E8E\u7ED3\u675F\u65E5\u671F\u3002");
  return { from, to };
}
function mealOf(iso) {
  const h = new Date(Date.parse(iso) + 8 * 36e5).getUTCHours();
  return h >= 5 && h < 10 ? "\u65E9\u9910" : h < 15 && h >= 10 ? "\u5348\u9910" : h >= 15 && h < 21 ? "\u665A\u9910" : "\u591C\u5BB5";
}
function summarize(records) {
  const round = (n) => Math.round(n * 100) / 100;
  const spend = records.filter((r) => r.amount < 0);
  const byMerchant = /* @__PURE__ */ new Map();
  const byDay = /* @__PURE__ */ new Map();
  const byMeal = /* @__PURE__ */ new Map();
  for (const r of spend) {
    const m = byMerchant.get(r.merchant) ?? { spent: 0, count: 0 };
    m.spent -= r.amount;
    m.count++;
    byMerchant.set(r.merchant, m);
    const day = ymd(Date.parse(r.time));
    byDay.set(day, (byDay.get(day) ?? 0) - r.amount);
    const meal = mealOf(r.time);
    const e = byMeal.get(meal) ?? { spent: 0, count: 0 };
    e.spent -= r.amount;
    e.count++;
    byMeal.set(meal, e);
  }
  const spent = round(spend.reduce((s, r) => s - r.amount, 0));
  const days = byDay.size;
  return {
    count: records.length,
    spent,
    toppedUp: round(records.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0)),
    averagePerDay: days ? round(spent / days) : 0,
    byMerchant: [...byMerchant].map(([merchant, v]) => ({ merchant, spent: round(v.spent), count: v.count })).sort((a, b) => b.spent - a.spent).slice(0, 10),
    byMeal: ["\u65E9\u9910", "\u5348\u9910", "\u665A\u9910", "\u591C\u5BB5"].flatMap((meal) => {
      const v = byMeal.get(meal);
      return v ? [{ meal, spent: round(v.spent), count: v.count }] : [];
    }),
    byDay: [...byDay].map(([date, v]) => ({ date, spent: round(v) })).sort((a, b) => a.date.localeCompare(b.date))
  };
}

// src/services/venues.ts
var BOOKING = "https://booking.fudan.edu.cn";
var SPORTS_TOPIC = 48;
var SPORTS_PAGE = `${BOOKING}/reservation/fe/site/special/special?id=${SPORTS_TOPIC}`;
var BOOKING_CAS = `https://id.fudan.edu.cn/authserver/login?service=${encodeURIComponent(`${BOOKING}/reservation/api/login/cas`)}`;
function body2(r, what) {
  if (r.status === 412) throw new FduError("UPSTREAM", "\u9884\u7EA6\u7CFB\u7EDF\u62E6\u622A\u4E86\u8FD9\u6B21\u8BBF\u95EE\uFF08\u9632\u722C\u866B\u9A8C\u8BC1\u6CA1\u6709\u901A\u8FC7\uFF09\u3002", "\u7A0D\u540E\u518D\u8BD5\uFF1B\u4E00\u76F4\u4E0D\u884C\u7684\u8BDD\u8BF7\u76F4\u63A5\u5728\u6D4F\u89C8\u5668\u91CC\u6253\u5F00 booking.fudan.edu.cn \u67E5\u770B\u3002");
  let j;
  try {
    j = JSON.parse(r.text);
  } catch {
    throw new FduError("UPSTREAM", `\u9884\u7EA6\u7CFB\u7EDF\u8FD4\u56DE\u7684\u4E0D\u662F\u6570\u636E\uFF08${what}\uFF0C${r.status}\uFF09\u3002`);
  }
  return j;
}
async function bookingReady(getJson) {
  try {
    const j = body2(await getJson(`${BOOKING}/reservation/api/topic/resource-list?id=${SPORTS_TOPIC}&pageSize=200`), "\u573A\u9986\u5217\u8868");
    return j.e === "OK";
  } catch {
    return false;
  }
}
async function listVenues(getJson) {
  const j = body2(await getJson(`${BOOKING}/reservation/api/topic/resource-list?id=${SPORTS_TOPIC}&pageSize=200`), "\u573A\u9986\u5217\u8868");
  if (j.e !== "OK") throw new FduError("UPSTREAM", `\u8BFB\u53D6\u573A\u9986\u5217\u8868\u5931\u8D25\uFF1A${j.m ?? "\u672A\u77E5\u539F\u56E0"}`);
  const rows = j.d?.data ?? [];
  return rows.flatMap((r) => r.base?.id !== void 0 && r.base?.name ? [{ id: String(r.base.id), name: String(r.base.name) }] : []);
}
function matchVenues(venues, query) {
  const q = query.trim();
  const byId = venues.filter((v) => v.id === q);
  if (byId.length) return byId;
  const words = q.split(/\s+/).filter(Boolean);
  return venues.filter((v) => words.every((w) => v.name.includes(w)));
}
async function venueCalendar(getJson, venueId, from, to) {
  if (!/^\d+$/.test(venueId)) throw new FduError("BAD_ARGS", "\u573A\u9986 id \u5E94\u8BE5\u662F\u6570\u5B57\uFF08\u6765\u81EA fdu venue list\uFF09\u3002");
  const qs = new URLSearchParams({ id: venueId, collective: "0", date: JSON.stringify({ start_date: from, end_date: to }) });
  const j = body2(await getJson(`${BOOKING}/reservation/site/resource/calendar?${qs}`), "\u573A\u9986\u65E5\u5386");
  if (j.e !== "OK") throw new FduError("UPSTREAM", `\u8BFB\u53D6\u573A\u9986\u7A7A\u95F2\u65F6\u6BB5\u5931\u8D25\uFF1A${j.m ?? "\u672A\u77E5\u539F\u56E0"}`);
  const d = j.d ?? {};
  const times = d.time ?? [];
  const courts = new Map((d.resource ?? []).map((r) => [String(r.id), String(r.name ?? r.id)]));
  const days = [];
  for (const [date, byCourt] of Object.entries(d.data ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const slots = times.map((t) => {
      const free = [];
      let total = 0;
      for (const [courtId, byTime] of Object.entries(byCourt ?? {})) {
        const cell = byTime?.[String(t.id)];
        if (!cell) continue;
        total++;
        const isFree = cell.num !== void 0 ? Number(cell.num) > 0 : Number(cell.status) === 0;
        if (isFree) free.push(courts.get(courtId) ?? courtId);
      }
      return { time: String(t.str_time ?? ""), ...t.start_time ? { start: String(t.start_time).slice(0, 5) } : {}, ...t.end_time ? { end: String(t.end_time).slice(0, 5) } : {}, free, total };
    }).filter((s) => s.total > 0);
    days.push({ date, slots, freeSlots: slots.filter((s) => s.free.length).length });
  }
  return days;
}

// src/services/capture.ts
import { load as load7 } from "cheerio";
var MAX_DEPTH = 6;
function shapeOf(value, depth = 0) {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length ? [shapeOf(value[0], depth + 1), `\u2026\u5171 ${value.length} \u9879`] : [];
  if (typeof value === "object") {
    if (depth >= MAX_DEPTH) return "object";
    const out = {};
    const entries = Object.entries(value);
    if (entries.length > 3 && entries.every(([k]) => /^\d+$|^\d{4}-\d{2}-\d{2}$/.test(k))) {
      return { "<\u952E\u4E3A\u65E5\u671F\u6216\u6570\u5B57>": shapeOf(entries[0][1], depth + 1), "\u2026": `\u5171 ${entries.length} \u4E2A\u952E` };
    }
    for (const [k, v] of entries.slice(0, 80)) out[k] = shapeOf(v, depth + 1);
    return out;
  }
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return "string(\u65E5\u671F)";
    if (/^-?\d+(\.\d+)?$/.test(value)) return "string(\u6570\u5B57)";
    return `string(${value.length})`;
  }
  return typeof value;
}
function htmlOutline(html) {
  const $ = load7(html);
  const tables = $("table").map((_, t) => [$(t).find("th").map((_i, th) => $(th).text().replace(/\s+/g, " ").trim()).get().filter(Boolean).slice(0, 20)]).get();
  const forms = $("form").map((_, f) => ({ action: $(f).attr("action")?.split("?")[0], fields: $(f).find("input[name],select[name],textarea[name]").map((_i, x) => $(x).attr("name")).get().filter((n) => !/csrf|token|password/i.test(n)) })).get();
  return { title: $("title").first().text().trim() || void 0, tables: tables.filter((t) => t.length), forms };
}
var FIELD = /^[\w.\[\]-]{1,60}$/;
function fieldsOf(postData) {
  if (!postData) return [];
  try {
    const j = JSON.parse(postData);
    if (j && typeof j === "object" && !Array.isArray(j)) return Object.keys(j).filter((k) => FIELD.test(k));
    return ["<JSON \u6570\u7EC4\uFF0C\u5DF2\u7701\u7565>"];
  } catch {
  }
  try {
    const keys = [...new URLSearchParams(postData).keys()];
    return keys.length && keys.every((k) => FIELD.test(k)) ? keys : ["<\u975E\u8868\u5355\u6570\u636E\uFF0C\u5DF2\u7701\u7565>"];
  } catch {
    return ["<\u975E\u8868\u5355\u6570\u636E\uFF0C\u5DF2\u7701\u7565>"];
  }
}
function maskPath(path) {
  return path.split("/").map((seg) => /^\d{4,}$/.test(seg) || /^[0-9a-f-]{20,}$/i.test(seg) || /^[A-Za-z0-9_-]{24,}$/.test(seg) ? "{id}" : seg).join("/");
}
var STANDARD = /^(accept|accept-.*|user-agent|referer|origin|cookie|connection|host|content-length|dnt|cache-control|pragma|sec-.*|upgrade-insecure-requests|priority|if-.*|range)$/i;
function headerNames(h) {
  if (!h) return void 0;
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (STANDARD.test(k)) continue;
    if (/^content-type$/i.test(k)) {
      out[k] = v.split(";")[0];
      continue;
    }
    if (/^authorization$/i.test(k)) {
      out[k] = `${v.split(/\s+/)[0]} ***`;
      continue;
    }
    out[k] = "***";
  }
  return Object.keys(out).length ? out : void 0;
}
function queryValues(u) {
  const out = {};
  for (const [k, v] of u.searchParams) {
    const secretName = /token|secret|passw|ticket/i.test(k) || /^(?:.*[_-])?(?:code|sign|signature|auth|key|apikey|session|sessionid|sid|pass)$/i.test(k);
    const masked = secretName ? "***" : redact(v).replace(/\d{8,}/g, "<\u6570\u5B57>").slice(0, 60);
    out[k] = masked;
  }
  return out;
}
async function describeCall(r, opts = {}) {
  let u;
  try {
    u = new URL(r.url);
  } catch {
    return null;
  }
  if (/\.(js|css|png|jpe?g|gif|svg|woff2?|ico|map)$/i.test(u.pathname) || /(^|\.)(mon-mp|hm\.baidu|google-analytics|cnzz)\b/i.test(u.hostname)) return null;
  const text = await r.body().catch(() => "");
  let response = `${r.contentType.split(";")[0] || "\u672A\u77E5\u7C7B\u578B"}\uFF08${text.length} \u5B57\u8282\uFF09`;
  const trimmed = text.trim();
  if (/json/.test(r.contentType) || /^[[{]/.test(trimmed)) {
    try {
      response = shapeOf(JSON.parse(trimmed));
    } catch {
    }
  } else if (/html|xml/.test(r.contentType) || /^</.test(trimmed)) {
    const inner = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(trimmed)?.[1] ?? trimmed;
    response = htmlOutline(inner);
  }
  const headers = headerNames(r.requestHeaders);
  return {
    method: r.method,
    endpoint: `${u.origin}${maskPath(u.pathname)}`,
    query: opts.keepQuery ? queryValues(u) : [...new Set(u.searchParams.keys())],
    ...headers ? { headers } : {},
    bodyFields: fieldsOf(r.postData),
    status: r.status,
    contentType: r.contentType.split(";")[0],
    response
  };
}
function dedupe(calls) {
  const map = /* @__PURE__ */ new Map();
  for (const c of calls) {
    const k = `${c.method} ${c.endpoint}`;
    const prev = map.get(k);
    if (!prev) map.set(k, c);
    else if (Array.isArray(prev.query) && Array.isArray(c.query)) prev.query = [.../* @__PURE__ */ new Set([...prev.query, ...c.query])];
    else if (!Array.isArray(prev.query) && !Array.isArray(c.query)) prev.query = { ...prev.query, ...c.query };
  }
  return [...map.values()];
}

// src/ops.ts
function op(o) {
  return o;
}
var FLAGS = /* @__PURE__ */ new WeakSet();
var flag = (description) => {
  const schema = z.preprocess((v) => v === "true" ? true : v === "false" ? false : v, z.boolean()).optional().describe(description);
  FLAGS.add(schema);
  return schema;
};
var int2 = (description, min = 1, max = 1e3) => z.coerce.number().int().min(min).max(max).optional().describe(description);
var DAY3 = 864e5;
var shanghaiDate = (iso) => iso ? new Date(iso).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : void 0;
var elearning = (ctx) => new CanvasClient(sessionAuth(ctx.session));
async function resolveCourses(ctx, query) {
  const courses = await elearning(ctx).listCourses();
  if (!query) return courses;
  const q = query.trim().toLowerCase();
  const hit = courses.filter((c) => c.id === q || c.name.toLowerCase().includes(q) || c.courseCode.toLowerCase().includes(q));
  if (!hit.length) throw new FduError("NOT_FOUND", `\u6CA1\u6709\u627E\u5230\u8BFE\u7A0B\u300C${query}\u300D\u3002`, "\u7528 `fdu elearning courses` \u67E5\u770B\u8BFE\u7A0B\u5217\u8868\uFF0C\u53EF\u4EE5\u4F20\u8BFE\u7A0B id \u6216\u540D\u79F0\u5173\u952E\u8BCD\u3002");
  return hit;
}
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  }));
  return out;
}
async function assignmentsOf(ctx, courses) {
  const client = elearning(ctx);
  const lists = await pool(courses, 4, async (c) => (await client.listAssignments(c.id).catch((e) => {
    if (e.status === 403) return [];
    throw e;
  })).map((a) => ({ ...a, course: c.name, done: isAssignmentDone(a), dueAtShanghai: shanghaiDate(a.dueAt) })));
  return lists.flat().sort((a, b) => (a.dueAt ?? "9").localeCompare(b.dueAt ?? "9"));
}
function safeTarget(dir, name) {
  const last = name.split(/[\\/]/).pop() ?? "";
  let clean3 = last.replace(/[:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "_").replace(/[. ]+$/, "").slice(0, 180) || "download";
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(clean3)) clean3 = `_${clean3}`;
  const ext = extname(clean3);
  const stem = clean3.slice(0, clean3.length - ext.length);
  let target = join2(dir, clean3);
  for (let i = 1; existsSync2(target); i++) target = join2(dir, `${stem} (${i})${ext}`);
  return target;
}
var HOLE = "hole.json";
var MAIL = "mail.json";
function treehole(ctx) {
  return new TreeholeClient({
    fetch: (url, init) => ctx.session.raw(url, init),
    ensureWebvpn: () => ensureWebvpn(ctx.session),
    tokens: {
      get: () => ctx.store.readJson(HOLE),
      set: (t) => {
        if (t) ctx.store.writeJson(HOLE, t);
        else ctx.store.remove(HOLE);
      }
    },
    now: ctx.now
  });
}
function mailClient(ctx) {
  const cfg = ctx.store.readJson(MAIL);
  if (!cfg?.user || !cfg.password) throw new FduError("NEED_MAIL_SETUP", "\u8FD8\u6CA1\u6709\u914D\u7F6E\u5B66\u751F\u90AE\u7BB1\u3002", "\u8FD0\u884C `fdu mail setup --user \u5B66\u53F7@m.fudan.edu.cn`\uFF0C\u8F93\u5165\u7F51\u9875\u90AE\u7BB1\u91CC\u751F\u6210\u7684\u5BA2\u6237\u7AEF\u4E13\u7528\u5BC6\u7801\u3002");
  return new ImapMailClient(cfg);
}
function icourse(ctx) {
  if (!ctx.session.hasState()) throw new NeedLoginError("icourse");
  return new IcourseClient({
    fetch: (url, init) => ctx.session.raw(url, { timeoutMs: init?.timeoutMs }),
    ensureWebvpn: () => ensureWebvpn(ctx.session),
    openInBrowser: async (url, done) => {
      await ctx.session.withPage(url, (page) => done(page.url()), { headless: true, timeoutMs: 3e4, platform: "icourse" });
    }
  });
}
function transcriptText(segments, every = 60) {
  const paras = [];
  let start = -Infinity;
  let cur = [];
  for (const s of segments) {
    if (s.start - start >= every && cur.length) {
      paras.push(cur.join(""));
      cur = [];
    }
    if (!cur.length) {
      start = s.start;
      cur.push(`[${clock(s.start)}] `);
    }
    cur.push(s.text);
  }
  if (cur.length) paras.push(cur.join(""));
  return paras.join("\n");
}
async function withBooking(ctx, work) {
  if (!ctx.session.hasState()) throw new NeedLoginError("jwfw");
  let result;
  let failure;
  let triedLogin = false;
  await ctx.session.withPage(SPORTS_PAGE, async (page) => {
    if (new URL(page.url()).hostname !== "booking.fudan.edu.cn") return false;
    const getJson = (url) => page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: "include", headers: { Accept: "application/json" } });
      return { status: r.status, text: await r.text() };
    }, url);
    try {
      if (!await bookingReady(getJson)) {
        if (triedLogin) throw new NeedLoginError("jwfw");
        triedLogin = true;
        await page.goto(BOOKING_CAS, { timeout: 3e4 }).catch(() => void 0);
        return false;
      }
      result = { value: await work(getJson) };
    } catch (e) {
      if (e instanceof Error && /Execution context was destroyed|navigat/i.test(e.message)) return false;
      failure = e;
    }
    return true;
  }, { headless: true, timeoutMs: 6e4, platform: "jwfw" });
  if (failure) throw failure;
  if (!result) throw new FduError("UPSTREAM", "\u573A\u9986\u9884\u7EA6\u7CFB\u7EDF\u6CA1\u6709\u6253\u5F00\u3002", "\u7A0D\u540E\u518D\u8BD5\uFF1B\u4E5F\u53EF\u4EE5\u76F4\u63A5\u5728\u6D4F\u89C8\u5668\u91CC\u6253\u5F00 booking.fudan.edu.cn \u67E5\u770B\u3002");
  return result.value;
}
function findLibraryToken(entries) {
  const plausible = (v) => typeof v === "string" && /^[\w.\-]{20,}$/.test(v);
  const dig = (o, depth = 0) => {
    if (!o || typeof o !== "object" || depth > 4) return void 0;
    for (const [k, v] of Object.entries(o)) {
      if (/^(access_?token|accessToken|token)$/i.test(k) && plausible(v)) return v;
      const inner = dig(v, depth + 1);
      if (inner) return inner;
    }
    return void 0;
  };
  const ranked = [...entries].sort(([a], [b]) => Number(/access/i.test(b)) - Number(/access/i.test(a)));
  for (const [k, v] of ranked) {
    if (!/token/i.test(k) && !/token/i.test(v.slice(0, 200))) continue;
    if (/token/i.test(k) && plausible(v.replace(/^"|"$/g, ""))) return v.replace(/^"|"$/g, "");
    try {
      const t = dig(JSON.parse(v));
      if (t) return t;
    } catch {
    }
  }
  return void 0;
}
async function storageEntries(page) {
  return page.evaluate(`(() => {
    const out = [];
    for (const st of [window.localStorage, window.sessionStorage]) {
      try { for (let i = 0; i < st.length; i++) { const k = st.key(i); out.push([k, st.getItem(k) || '']); } } catch {}
    }
    return out;
  })()`).then((v) => Array.isArray(v) ? v : []).catch(() => []);
}
var LIB_LOGIN_HINT = "\u8FD0\u884C `fdu library login`\uFF0C\u5728\u6253\u5F00\u7684\u56FE\u4E66\u9986\u9875\u9762\u91CC\u767B\u5F55\u4E00\u6B21\uFF08\u4E4B\u540E\u4F1A\u8BB0\u4F4F\uFF09\u3002";
async function withLibrary(ctx, work) {
  if (!ctx.session.hasState()) throw new NeedLoginError("jwfw");
  const started = Date.now();
  let result;
  let failure;
  await ctx.session.withPage(OPAC, async (page) => {
    if (new URL(page.url()).hostname !== "opac.fudan.edu.cn") return false;
    const token = findLibraryToken(await storageEntries(page));
    if (!token) {
      if (Date.now() - started < 1e4) return false;
      failure = new FduError("NEED_LOGIN", "\u8FD8\u6CA1\u6709\u767B\u5F55\u56FE\u4E66\u9986\u3002", LIB_LOGIN_HINT);
      return true;
    }
    const getJson = (url) => page.evaluate(async ([u, t]) => {
      const r = await fetch(u, { headers: { access_token: t, Accept: "application/json" } });
      return { status: r.status, text: await r.text() };
    }, [url, token]);
    try {
      result = { value: await work(getJson) };
    } catch (e) {
      if (e instanceof Error && /Execution context was destroyed|navigat/i.test(e.message)) return false;
      failure = e;
    }
    return true;
  }, { headless: true, timeoutMs: 4e4, platform: "jwfw" });
  if (failure) throw failure;
  if (!result) throw new FduError("UPSTREAM", "\u56FE\u4E66\u9986\u9875\u9762\u6CA1\u6709\u6253\u5F00\u3002", "\u7A0D\u540E\u518D\u8BD5\uFF1B\u4E5F\u53EF\u4EE5\u76F4\u63A5\u6253\u5F00 opac.fudan.edu.cn \u67E5\u770B\u3002");
  return result.value;
}
function overviewDeps(ctx) {
  const reader = ctx.session.reader("jwfw");
  return {
    timetable: () => readTimetable(reader),
    exams: () => readExams(reader, { now: ctx.now() }),
    assignments: async () => (await assignmentsOf(ctx, await resolveCourses(ctx))).map((x) => ({ name: x.name, course: x.course, dueAt: x.dueAt, done: x.done, htmlUrl: x.htmlUrl }))
  };
}
var needPrompt = (ctx) => {
  if (!ctx.prompt) throw new FduError("BAD_ARGS", "\u8FD9\u4E2A\u64CD\u4F5C\u9700\u8981\u5728\u7EC8\u7AEF\u91CC\u8F93\u5165\u5BC6\u7801\uFF0C\u8BF7\u76F4\u63A5\u5728\u7EC8\u7AEF\u8FD0\u884C\u3002");
  return ctx.prompt;
};
var OPS = [
  // ======================= 账号 =======================
  op({
    name: "auth.login",
    summary: "\u767B\u5F55\u590D\u65E6\u7EDF\u4E00\u8EAB\u4EFD\u8BA4\u8BC1\uFF1A\u6253\u5F00\u6D4F\u89C8\u5668\uFF0C\u4F60\u81EA\u5DF1\u8F93\u5165\u8D26\u53F7\u5BC6\u7801\u3001\u5B8C\u6210\u4E8C\u6B21\u9A8C\u8BC1\uFF1B\u4E4B\u540E eLearning\u3001\u6559\u52A1\u3001\u6821\u56ED\u5361\u7B49\u5171\u7528\u8FD9\u4E2A\u767B\u5F55\u3002",
    login: "none",
    effect: "auth",
    params: { webvpn: flag("\u987A\u4FBF\u5EFA\u7ACB WebVPN \u4F1A\u8BDD\uFF08\u6821\u5916\u8BBF\u95EE\u6811\u6D1E\u9700\u8981\uFF09"), force: flag("\u4E22\u5F03\u5DF2\u6709\u767B\u5F55\u72B6\u6001\uFF0C\u91CD\u65B0\u767B\u5F55") },
    examples: ["fdu login", "fdu login --webvpn"],
    async run(ctx, a) {
      if (a.force) ctx.session.clear();
      const r = await login(ctx.session, { webvpn: a.webvpn, onWaiting: ctx.log });
      return { loggedIn: true, user: r.elearning.name, jwfw: r.jwfw, webvpn: r.webvpn, stateFile: ctx.store.path("state.json") };
    }
  }),
  op({
    name: "auth.status",
    summary: "\u5404\u7CFB\u7EDF\u7684\u767B\u5F55\u72B6\u6001\uFF08\u590D\u65E6\u8D26\u53F7\u3001WebVPN\u3001\u6811\u6D1E\u3001\u5B66\u751F\u90AE\u7BB1\uFF09\u3002",
    login: "none",
    effect: "read",
    cache: false,
    params: {},
    async run(ctx) {
      const [elearningStatus, jwfw] = await Promise.all([platformStatus(ctx.session, "elearning"), platformStatus(ctx.session, "jwfw")]);
      return {
        uis: { elearning: elearningStatus, jwfw, webvpn: ctx.session.hasState() ? await webvpnAlive(ctx.session) : false },
        treehole: !!ctx.store.readJson(HOLE),
        mail: !!ctx.store.readJson(MAIL)?.user,
        profileDir: ctx.store.dir
      };
    }
  }),
  op({
    name: "auth.logout",
    summary: "\u5220\u9664\u672C\u673A\u4FDD\u5B58\u7684\u590D\u65E6\u8D26\u53F7\u767B\u5F55\u72B6\u6001\uFF08\u6811\u6D1E\u3001\u90AE\u7BB1\u5206\u522B\u7528 fdu hole logout\u3001fdu mail forget\uFF09\u3002",
    login: "none",
    effect: "auth",
    mcp: false,
    params: {},
    async run(ctx) {
      return { removed: ctx.session.clear(), cacheCleared: ctx.cache?.clear() ?? 0 };
    }
  }),
  op({
    name: "auth.doctor",
    summary: "\u68C0\u67E5\u8FD0\u884C\u73AF\u5883\uFF1ANode.js\u3001\u6D4F\u89C8\u5668\u3001\u914D\u7F6E\u76EE\u5F55\u3001\u80FD\u4E0D\u80FD\u8FDE\u4E0A\u5404\u4E2A\u5B66\u6821\u7CFB\u7EDF\u3001\u5404\u8D26\u53F7\u7684\u767B\u5F55\u72B6\u6001\uFF0C\u6BCF\u9879\u7ED9\u51FA\u4FEE\u590D\u5EFA\u8BAE\uFF08\u7ED3\u679C\u91CC\u6CA1\u6709\u8D26\u53F7\u548C Cookie\uFF0C\u53EF\u4EE5\u76F4\u63A5\u53D1\u7ED9\u522B\u4EBA\u5E2E\u5FD9\u770B\uFF09\u3002",
    login: "none",
    effect: "read",
    cache: false,
    params: {},
    examples: ["fdu doctor"],
    async run(ctx) {
      return runDoctor({
        nodeVersion: process.version,
        platform: process.platform,
        configDir: ctx.store.dir,
        configDirState: () => {
          try {
            mkdirSync2(ctx.store.dir, { recursive: true, mode: 448 });
            accessSync(ctx.store.dir, fsConstants.W_OK);
            return { writable: true, mode: statSync(ctx.store.dir).mode };
          } catch {
            return { writable: false };
          }
        },
        browser: () => ctx.session.probeBrowser(),
        reach: async (url) => {
          const r = await ctx.session.raw(url, { timeoutMs: 1e4 });
          return { status: r.status, url: r.url };
        },
        login: async () => {
          const hasState = ctx.session.hasState();
          if (!hasState) return { hasState, elearning: "need_login", jwfw: "need_login", webvpn: false };
          const [elearningStatus, jwfw, webvpn] = await Promise.all([platformStatus(ctx.session, "elearning"), platformStatus(ctx.session, "jwfw"), webvpnAlive(ctx.session)]);
          return { hasState, elearning: elearningStatus, jwfw, webvpn };
        },
        treehole: !!ctx.store.readJson(HOLE),
        mail: !!ctx.store.readJson(MAIL)?.user,
        proxy: proxyFromEnv()?.server
      });
    }
  }),
  op({
    name: "dev.capture",
    summary: "\u5F00\u53D1\u65B0\u529F\u80FD\u7528\uFF1A\u6253\u5F00\u6D4F\u89C8\u5668\uFF08\u5E26\u7740\u590D\u65E6\u8D26\u53F7\u767B\u5F55\u72B6\u6001\uFF09\uFF0C\u4F60\u5728\u91CC\u9762\u64CD\u4F5C\u67D0\u4E2A\u5B66\u6821\u7CFB\u7EDF\u7684\u9875\u9762\uFF0C\u5173\u6389\u7A97\u53E3\u540E\u628A\u9875\u9762\u7528\u5230\u7684\u63A5\u53E3\u7ED3\u6784\u5B58\u6210\u6587\u4EF6\u2014\u2014\u53EA\u6709\u5730\u5740\u3001\u53C2\u6570\u540D\u3001\u8FD4\u56DE\u7684\u5B57\u6BB5\u540D\u548C\u7C7B\u578B\u3001\u8868\u683C\u5217\u540D\uFF0C\u4E0D\u542B\u59D3\u540D\u3001\u5B66\u53F7\u3001\u91D1\u989D\u7B49\u4EFB\u4F55\u5177\u4F53\u5185\u5BB9\uFF0C\u53EF\u4EE5\u76F4\u63A5\u53D1\u7ED9\u5F00\u53D1\u8005\u3002",
    login: "none",
    effect: "local-write",
    mcp: false,
    cache: false,
    params: {
      url: z.string().url().describe("\u4ECE\u54EA\u4E2A\u9875\u9762\u5F00\u59CB\uFF0C\u5982 https://fdjwgl.fudan.edu.cn/student/home"),
      out: z.string().optional().describe("\u7ED3\u679C\u4FDD\u5B58\u5230\u54EA\u91CC\uFF0C\u9ED8\u8BA4\u5F53\u524D\u76EE\u5F55\u7684 fdu-capture-\u65F6\u95F4.json"),
      minutes: int2("\u6700\u591A\u5F55\u591A\u4E45\uFF08\u5206\u949F\uFF09\uFF0C\u9ED8\u8BA4 10", 1, 60),
      keepQuery: flag("\u4FDD\u7559\u67E5\u8BE2\u53C2\u6570\u7684\u503C\uFF08\u5982\u7FFB\u9875\u53C2\u6570\u7684\u683C\u5F0F\uFF1B\u4EE4\u724C\u548C\u957F\u6570\u5B57\u4F1A\u906E\u6389\uFF0C\u53D1\u51FA\u524D\u8BF7\u81EA\u5DF1\u770B\u4E00\u904D\uFF09")
    },
    examples: ["fdu dev capture --url https://fdjwgl.fudan.edu.cn/student/home"],
    async run(ctx, a) {
      const calls = [];
      ctx.log("\u5DF2\u6253\u5F00\u6D4F\u89C8\u5668\uFF1A\u8BF7\u70B9\u5230\u8981\u505A\u7684\u529F\u80FD\u9875\u9762\uFF0C\u67E5\u8BE2\u4E00\u4E24\u6B21\uFF0C\u7136\u540E\u5173\u6389\u6D4F\u89C8\u5668\u7A97\u53E3\u3002");
      await ctx.session.record(a.url, async (r) => {
        const c = await describeCall(r, { keepQuery: a.keepQuery });
        if (c) calls.push(c);
      }, (a.minutes ?? 10) * 6e4);
      const result = dedupe(calls).filter((c) => !/google|baidu|cnzz|analytics/i.test(c.endpoint));
      const stamp2 = new Date(ctx.now()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const target = resolve(ctx.cwd, a.out ?? `fdu-capture-${stamp2}.json`);
      mkdirSync2(dirname2(target), { recursive: true });
      const path = safeTarget(dirname2(target), basename(target));
      writeFileSync2(path, JSON.stringify({ startUrl: a.url.split("?")[0], capturedAt: new Date(ctx.now()).toISOString(), calls: result }, null, 2));
      return { path, calls: result.length, endpoints: result.map((c) => `${c.method} ${c.endpoint}`).slice(0, 50) };
    }
  }),
  op({
    name: "cache.clear",
    summary: "\u5220\u9664\u672C\u673A\u7F13\u5B58\u7684\u67E5\u8BE2\u7ED3\u679C\uFF08\u9000\u51FA\u767B\u5F55\u65F6\u4E5F\u4F1A\u81EA\u52A8\u5220\u9664\uFF09\u3002",
    login: "none",
    effect: "local-write",
    mcp: false,
    cache: false,
    params: {},
    async run(ctx) {
      return { removed: ctx.cache?.clear() ?? 0 };
    }
  }),
  // ======================= 汇总 =======================
  op({
    name: "overview.today",
    summary: "\u4ECA\u5929\u7684\u6982\u51B5\uFF1A\u4ECA\u5929\u7684\u8BFE\uFF08\u6309\u6559\u5B66\u5468\u548C\u653E\u5047\u5B89\u6392\u7B5B\u597D\uFF09\u30013 \u5929\u5185\u8981\u4EA4\u8FD8\u6CA1\u4EA4\u7684\u4F5C\u4E1A\u30017 \u5929\u5185\u7684\u8003\u8BD5\u3001\u8FC7\u4E86\u622A\u6B62\u8FD8\u6CA1\u4EA4\u7684\u4F5C\u4E1A\u3002\u67D0\u4E00\u7C7B\u8BFB\u4E0D\u5230\u65F6\u5176\u4ED6\u7167\u5E38\u8FD4\u56DE\uFF0C\u8BFB\u4E0D\u5230\u7684\u5199\u5728 errors \u91CC\u3002",
    login: "uis",
    effect: "read",
    params: { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("\u65E5\u671F YYYY-MM-DD\uFF0C\u9ED8\u8BA4\u4ECA\u5929") },
    examples: ["fdu today", "fdu today --date 2026-11-09"],
    async run(ctx, a) {
      const r = todayRange(ctx.now(), a.date);
      return overview(overviewDeps(ctx), { ...r, now: ctx.now() });
    }
  }),
  op({
    name: "overview.week",
    summary: "\u8FD9\u4E00\u5468\uFF08\u6309\u6821\u5386\u4ECE\u5468\u65E5\u5230\u5468\u516D\uFF09\u6BCF\u5929\u7684\u8BFE\u3001\u672C\u5468\u8981\u4EA4\u7684\u4F5C\u4E1A\u3001\u672C\u5468\u7684\u8003\u8BD5\uFF0C\u4EE5\u53CA\u7B2C\u51E0\u6559\u5B66\u5468\u3002",
    login: "uis",
    effect: "read",
    params: { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("\u8FD9\u4E00\u5468\u91CC\u7684\u4EFB\u610F\u4E00\u5929\uFF0C\u9ED8\u8BA4\u4ECA\u5929") },
    examples: ["fdu week", "fdu week --date 2026-11-16"],
    async run(ctx, a) {
      const r = weekRange(ctx.now(), a.date);
      return overview(overviewDeps(ctx), { ...r, now: ctx.now() });
    }
  }),
  op({
    name: "calendar.export",
    summary: "\u628A\u8BFE\u8868\u3001\u8003\u8BD5\u548C\u4F5C\u4E1A\u622A\u6B62\u65F6\u95F4\u5BFC\u51FA\u6210\u65E5\u5386\u6587\u4EF6\uFF08.ics\uFF09\uFF0C\u53EF\u4EE5\u5BFC\u5165\u82F9\u679C\u65E5\u5386\u3001Outlook\u3001Google \u65E5\u5386\u3002\u91CD\u590D\u5BFC\u5165\u540C\u4E00\u5B66\u671F\u4F1A\u66F4\u65B0\u5DF2\u6709\u65E5\u7A0B\uFF0C\u4E0D\u4F1A\u91CD\u590D\u6DFB\u52A0\u3002",
    login: "uis",
    effect: "local-write",
    cache: false,
    params: {
      out: z.string().optional().describe("\u4FDD\u5B58\u5230\u54EA\u91CC\uFF0C\u9ED8\u8BA4\u5F53\u524D\u76EE\u5F55\u7684 fudan.ics"),
      include: z.string().regex(/^(timetable|exams|assignments)(,(timetable|exams|assignments))*$/).optional().describe("\u5BFC\u51FA\u54EA\u4E9B\uFF0C\u9017\u53F7\u5206\u9694\uFF1Atimetable,exams,assignments\uFF08\u9ED8\u8BA4\u5168\u90E8\uFF09"),
      overwrite: flag("\u6587\u4EF6\u5DF2\u5B58\u5728\u65F6\u8986\u76D6\uFF08\u9ED8\u8BA4\u53E6\u5B58\u4E3A\u65B0\u6587\u4EF6\u540D\uFF09"),
      alarms: flag("\u8003\u8BD5\u548C\u4F5C\u4E1A\u622A\u6B62\u524D\u4E00\u5929\u63D0\u9192\uFF08\u9ED8\u8BA4\u5F00\uFF09")
    },
    examples: ["fdu calendar export", "fdu calendar export --include timetable,exams --out ~/Desktop/fudan.ics"],
    async run(ctx, a) {
      const include = new Set((a.include ?? "timetable,exams,assignments").split(","));
      const alarms = a.alarms ?? true;
      const deps = overviewDeps(ctx);
      const events = [];
      const errors = {};
      const counts = { classes: 0, exams: 0, deadlines: 0 };
      let skipped = [];
      let semester;
      let firstError;
      const attempt = async (name, f) => {
        try {
          await f();
        } catch (e) {
          firstError ??= e;
          errors[name] = e.message;
        }
      };
      if (include.has("timetable")) await attempt("timetable", async () => {
        const table = await deps.timetable();
        semester = table.semester?.name;
        const all = allSessions(table);
        if (!all.week0Sunday) throw new FduError("NOT_FOUND", "\u4E0D\u77E5\u9053\u8FD9\u4E2A\u5B66\u671F\u4ECE\u54EA\u5929\u5F00\u59CB\uFF0C\u6CA1\u6CD5\u6392\u51FA\u4E0A\u8BFE\u65E5\u671F\u3002");
        skipped = all.skipped;
        for (const s of all.sessions) {
          events.push({ key: `class|${s.course}|${s.date}|${s.start}`, summary: s.course, startsAt: s.startsAt, endsAt: s.endsAt, location: s.location, description: [`\u7B2C ${s.week} \u5468 \xB7 \u7B2C ${s.periods} \u8282`, s.teachers.join("\u3001")].filter(Boolean).join("\n"), categories: ["\u8BFE\u7A0B"] });
        }
        counts.classes = all.sessions.length;
      });
      if (include.has("exams")) await attempt("exams", async () => {
        for (const e of await deps.exams()) {
          events.push({ key: `exam|${e.course}|${e.startsAt}`, summary: `\u8003\u8BD5\uFF1A${e.course}`, startsAt: e.startsAt, endsAt: e.endsAt ?? new Date(Date.parse(e.startsAt) + 2 * 36e5).toISOString(), location: e.location, description: e.timeText, alarmMinutes: alarms ? 24 * 60 : void 0, categories: ["\u8003\u8BD5"] });
          counts.exams++;
        }
      });
      if (include.has("assignments")) await attempt("assignments", async () => {
        for (const x of await deps.assignments()) {
          if (x.done || !x.dueAt || Date.parse(x.dueAt) < ctx.now()) continue;
          events.push({ key: `due|${x.course}|${x.name}`, summary: `\u622A\u6B62\uFF1A${x.name}${x.course ? `\uFF08${x.course}\uFF09` : ""}`, startsAt: new Date(Date.parse(x.dueAt) - 30 * 6e4).toISOString(), endsAt: x.dueAt, url: x.htmlUrl, alarmMinutes: alarms ? 24 * 60 : void 0, categories: ["\u4F5C\u4E1A"] });
          counts.deadlines++;
        }
      });
      if (!events.length && firstError) throw firstError;
      const target = resolve(ctx.cwd, a.out ?? "fudan.ics");
      mkdirSync2(dirname2(target), { recursive: true });
      const path = a.overwrite ? target : safeTarget(dirname2(target), basename(target));
      writeFileSync2(path, buildIcs(events, { name: semester ? `\u590D\u65E6\u8BFE\u8868 ${semester}` : "\u590D\u65E6\u8BFE\u8868", now: ctx.now() }), { mode: 420 });
      return { path, events: counts, skippedHolidays: skipped, ...Object.keys(errors).length ? { errors } : {} };
    }
  }),
  // ======================= eLearning =======================
  op({
    name: "elearning.courses",
    summary: "\u672C\u5B66\u671F\u7684 eLearning \u8BFE\u7A0B\uFF08id\u3001\u540D\u79F0\u3001\u8BFE\u7A0B\u4EE3\u7801\u3001\u6559\u5E08\uFF09\u3002",
    login: "uis",
    effect: "read",
    params: {},
    async run(ctx) {
      return elearning(ctx).listCourses();
    }
  }),
  op({
    name: "elearning.assignments",
    summary: "\u4F5C\u4E1A\u5217\u8868\uFF1A\u622A\u6B62\u65F6\u95F4\uFF08\u542B\u4E0A\u6D77\u65F6\u95F4\uFF09\u3001\u662F\u5426\u5DF2\u63D0\u4EA4\u3002\u4E0D\u4F20\u8BFE\u7A0B\u65F6\u5217\u51FA\u5168\u90E8\u8BFE\u7A0B\u3002",
    login: "uis",
    effect: "read",
    params: { course: z.string().optional().describe("\u8BFE\u7A0B id \u6216\u540D\u79F0\u5173\u952E\u8BCD"), pending: flag("\u53EA\u770B\u8FD8\u6CA1\u4EA4\u7684") },
    examples: ["fdu elearning assignments --course \u6570\u636E\u7ED3\u6784", "fdu elearning assignments --pending"],
    async run(ctx, a) {
      const list2 = await assignmentsOf(ctx, await resolveCourses(ctx, a.course));
      return a.pending ? list2.filter((x) => !x.done) : list2;
    }
  }),
  op({
    name: "elearning.todo",
    summary: "\u63A5\u4E0B\u6765\u51E0\u5929\u8981\u4EA4\u3001\u8FD8\u6CA1\u4EA4\u7684\u4F5C\u4E1A\uFF08\u8DE8\u5168\u90E8\u8BFE\u7A0B\uFF0C\u6309\u622A\u6B62\u65F6\u95F4\u6392\u5E8F\uFF09\uFF0C\u4EE5\u53CA\u5DF2\u7ECF\u8FC7\u4E86\u622A\u6B62\u65F6\u95F4\u8FD8\u6CA1\u4EA4\u7684\u3002",
    login: "uis",
    effect: "read",
    params: { days: int2("\u5F80\u540E\u770B\u51E0\u5929\uFF0C\u9ED8\u8BA4 14", 1, 120) },
    async run(ctx, a) {
      const now = ctx.now();
      const until = now + (a.days ?? 14) * DAY3;
      const list2 = (await assignmentsOf(ctx, await resolveCourses(ctx))).filter((x) => !x.done && x.dueAt);
      return {
        upcoming: list2.filter((x) => Date.parse(x.dueAt) >= now && Date.parse(x.dueAt) <= until),
        overdue: list2.filter((x) => Date.parse(x.dueAt) < now && Date.parse(x.dueAt) > now - 14 * DAY3)
      };
    }
  }),
  op({
    name: "elearning.announcements",
    summary: "\u8BFE\u7A0B\u516C\u544A\uFF08\u9ED8\u8BA4\u6700\u8FD1 14 \u5929\uFF09\u3002",
    login: "uis",
    effect: "read",
    params: { course: z.string().optional().describe("\u8BFE\u7A0B id \u6216\u540D\u79F0\u5173\u952E\u8BCD"), days: int2("\u6700\u8FD1\u51E0\u5929\uFF0C\u9ED8\u8BA4 14", 1, 365) },
    async run(ctx, a) {
      const courses = await resolveCourses(ctx, a.course);
      const since = new Date(ctx.now() - (a.days ?? 14) * DAY3).toISOString();
      const names = new Map(courses.map((c) => [c.id, c.name]));
      const list2 = await elearning(ctx).listAnnouncements(courses.map((c) => c.id), since);
      return list2.map((x) => ({ ...x, course: names.get(x.courseId), postedAtShanghai: shanghaiDate(x.postedAt) }));
    }
  }),
  op({
    name: "elearning.files",
    summary: "\u67D0\u95E8\u8BFE\u7684\u8BFE\u4EF6\u548C\u6587\u4EF6\uFF08id\u3001\u6587\u4EF6\u540D\u3001\u5927\u5C0F\u3001\u6240\u5728\u6587\u4EF6\u5939\uFF09\u3002",
    login: "uis",
    effect: "read",
    params: { course: z.string().describe("\u8BFE\u7A0B id \u6216\u540D\u79F0\u5173\u952E\u8BCD"), search: z.string().optional().describe("\u6587\u4EF6\u540D\u5173\u952E\u8BCD") },
    examples: ["fdu elearning files --course \u7EBF\u6027\u4EE3\u6570 --search \u7B2C5\u8BB2"],
    async run(ctx, a) {
      const [course] = await resolveCourses(ctx, a.course);
      return { course: course.name, files: await elearning(ctx).listFiles(course.id, a.search) };
    }
  }),
  op({
    name: "elearning.download",
    summary: "\u4E0B\u8F7D\u4E00\u4E2A\u8BFE\u7A0B\u6587\u4EF6\u5230\u672C\u673A\uFF08\u9ED8\u8BA4\u5F53\u524D\u76EE\u5F55\uFF1B\u540C\u540D\u6587\u4EF6\u4E0D\u8986\u76D6\uFF0C\u81EA\u52A8\u52A0\u5E8F\u53F7\uFF1B\u5355\u4E2A\u6700\u5927 200 MB\uFF09\u3002",
    login: "uis",
    effect: "local-write",
    params: { file: z.string().describe("\u6587\u4EF6 id\uFF08\u6765\u81EA elearning files\uFF09"), out: z.string().optional().describe("\u4FDD\u5B58\u5230\u54EA\u4E2A\u6587\u4EF6\u5939\uFF0C\u9ED8\u8BA4\u5F53\u524D\u76EE\u5F55") },
    async run(ctx, a) {
      const f = await elearning(ctx).downloadFile(a.file);
      const dir = resolve(ctx.cwd, a.out ?? ".");
      mkdirSync2(dir, { recursive: true });
      const target = safeTarget(dir, f.name);
      writeFileSync2(target, f.data, { flag: "wx" });
      return { path: target, bytes: f.data.byteLength, contentType: f.contentType };
    }
  }),
  // ======================= 教务 =======================
  op({
    name: "jw.semesters",
    summary: "\u6559\u52A1\u7CFB\u7EDF\u91CC\u7684\u5B66\u671F\u5217\u8868\uFF08id\u3001\u540D\u79F0\uFF09\u548C\u5F53\u524D\u5B66\u671F\u3002",
    login: "uis",
    effect: "read",
    params: {},
    async run(ctx) {
      return readSemesters(ctx.session.reader("jwfw"));
    }
  }),
  op({
    name: "jw.week",
    summary: "\u67D0\u5929\u662F\u7B2C\u51E0\u6559\u5B66\u5468\u3001\u661F\u671F\u51E0\u3001\u662F\u5426\u653E\u5047\uFF08\u6309\u5B66\u6821\u6821\u5386\uFF1B\u6821\u5386\u6CA1\u8986\u76D6\u5230\u7684\u5B66\u671F\u6309\u6559\u52A1\u7CFB\u7EDF\u7684\u5B66\u671F\u5F00\u59CB\u65E5\u671F\u63A8\u7B97\uFF09\u3002",
    login: "none",
    effect: "read",
    cache: false,
    params: { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("\u65E5\u671F YYYY-MM-DD\uFF0C\u9ED8\u8BA4\u4ECA\u5929") },
    async run(ctx, a) {
      const day = a.date ?? shanghaiDay(ctx.now());
      let info = weekInfo(day);
      if (info.source === "none" && ctx.session.hasState()) {
        try {
          const { semesters, currentId } = await readSemesters(ctx.session.reader("jwfw"));
          info = weekInfo(day, semesters.find((x) => x.id === currentId));
        } catch {
        }
      }
      return info;
    }
  }),
  op({
    name: "jw.timetable",
    summary: "\u8BFE\u8868\uFF1A\u6BCF\u95E8\u8BFE\u7684\u4E0A\u8BFE\u65F6\u95F4\uFF08\u661F\u671F\u3001\u8282\u6B21\u3001\u8D77\u6B62\u65F6\u95F4\uFF09\u3001\u5730\u70B9\u3001\u6559\u5B66\u5468\u3001\u6559\u5E08\u3002",
    login: "uis",
    effect: "read",
    params: { semester: z.string().optional().describe("\u5B66\u671F id \u6216\u540D\u79F0\u5173\u952E\u8BCD\uFF0C\u9ED8\u8BA4\u5F53\u524D\u5B66\u671F"), postgraduate: flag("\u7814\u7A76\u751F\u8BFE\u8868\uFF08\u8BFB\u7814\u7A76\u751F\u9009\u8BFE\u7CFB\u7EDF\uFF09") },
    examples: ["fdu jw timetable", "fdu jw timetable --semester 2026-2027\u5B66\u5E741\u5B66\u671F"],
    async run(ctx, a) {
      return readTimetable(ctx.session.reader("jwfw"), { semester: a.semester, postgraduate: a.postgraduate });
    }
  }),
  op({
    name: "jw.exams",
    summary: "\u8003\u8BD5\u5B89\u6392\uFF08\u8BFE\u7A0B\u3001\u65F6\u95F4\u3001\u8003\u573A\uFF09\uFF0C\u6309\u65F6\u95F4\u6392\u5E8F\u3002",
    login: "uis",
    effect: "read",
    params: { all: flag("\u4E5F\u5217\u51FA\u4E00\u4E2A\u6708\u4EE5\u524D\u8003\u5B8C\u7684") },
    async run(ctx, a) {
      return (await readExams(ctx.session.reader("jwfw"), { all: a.all, now: ctx.now() })).map((e) => ({ ...e, startsAtShanghai: shanghaiDate(e.startsAt) }));
    }
  }),
  op({
    name: "jw.grades",
    summary: "\u5DF2\u51FA\u7684\u6210\u7EE9\uFF08\u6309\u5B66\u671F\uFF09\u548C\u6309\u5B66\u5206\u52A0\u6743\u7684\u7EE9\u70B9\uFF08P/NP \u4E0D\u8BA1\uFF09\u3002",
    login: "uis",
    effect: "read",
    sensitive: true,
    params: { semester: z.string().optional().describe("\u53EA\u770B\u67D0\u4E2A\u5B66\u671F\uFF08id \u6216\u540D\u79F0\u5173\u952E\u8BCD\uFF09") },
    async run(ctx, a) {
      const { studentId: _id, ...r } = await readGrades(ctx.session.reader("jwfw"));
      if (!a.semester) return r;
      const semesters = r.semesters.filter((s) => s.id === a.semester || s.name.includes(a.semester));
      return { ...r, semesters };
    }
  }),
  op({
    name: "jw.gpa",
    summary: "\u6559\u52A1\u7CFB\u7EDF\u91CC\u7684\u7EE9\u70B9\u548C\u672C\u5E74\u7EA7\u672C\u9662\u7CFB\u6392\u540D\uFF08\u53EA\u8FD4\u56DE\u4F60\u81EA\u5DF1\u7684\u4E00\u884C\u548C\u603B\u4EBA\u6570\uFF09\u3002",
    login: "uis",
    effect: "read",
    sensitive: true,
    params: { studentNumber: z.string().regex(/^\d{8,14}$/).optional().describe("\u5B66\u53F7\uFF0C\u7528\u6765\u5728\u6392\u540D\u8868\u91CC\u627E\u5230\u4F60\uFF1B\u4E0D\u4F20\u65F6\u5C1D\u8BD5\u4ECE eLearning \u8BFB\u53D6") },
    async run(ctx, a) {
      const reader = ctx.session.reader("jwfw");
      const { studentId } = await readStudentId(reader);
      let number = a.studentNumber;
      if (!number) {
        const profile = await ctx.session.raw("https://elearning.fudan.edu.cn/api/v1/users/self/profile", { headers: { Accept: "application/json" } }).catch(() => void 0);
        try {
          const p = JSON.parse(profile?.text ?? "{}");
          if (/^\d{8,14}$/.test(p.login_id ?? "")) number = p.login_id;
        } catch {
        }
      }
      const rank = await readGpaRank(reader, studentId, number);
      if (!rank) throw new FduError("NOT_FOUND", "\u6559\u52A1\u7CFB\u7EDF\u91CC\u6CA1\u6709\u627E\u5230\u7EE9\u70B9\u6392\u540D\uFF08\u53EF\u80FD\u8FD8\u6CA1\u5F00\u653E\uFF09\u3002");
      return { ...rank, note: rank.ranking === void 0 ? "\u6CA1\u6709\u5728\u6392\u540D\u8868\u91CC\u627E\u5230\u4F60\uFF0C\u8BF7\u7528 --student-number \u4F20\u5B66\u53F7\u3002" : void 0 };
    }
  }),
  op({
    name: "jw.program",
    summary: "\u57F9\u517B\u65B9\u6848\u5B8C\u6210\u60C5\u51B5\uFF1A\u5404\u7C7B\u522B\u8981\u6C42\u5B66\u5206\u3001\u5DF2\u83B7\u5B66\u5206\u3001\u8FD8\u5DEE\u591A\u5C11\u3002",
    login: "uis",
    effect: "read",
    sensitive: true,
    params: {},
    async run(ctx) {
      const reader = ctx.session.reader("jwfw");
      const { studentId } = await readStudentId(reader);
      return readProgramCompletion(reader, studentId);
    }
  }),
  op({
    name: "jw.lessons",
    summary: "\u5168\u6821\u5F00\u8BFE\u67E5\u8BE2\uFF1A\u6309\u8BFE\u7A0B\u540D\u641C\u67D0\u5B66\u671F\u5F00\u7684\u8BFE\uFF08\u6559\u5B66\u73ED\u4EE3\u7801\u3001\u5B66\u5206\u3001\u4EFB\u8BFE\u8001\u5E08\u3001\u4E0A\u8BFE\u65F6\u95F4\u5730\u70B9\u3001\u9650\u9009\u548C\u5DF2\u9009\u4EBA\u6570\u3001\u8003\u8BD5\u65B9\u5F0F\uFF09\uFF0C\u9009\u8BFE\u65F6\u7528\u3002",
    login: "uis",
    effect: "read",
    params: {
      keyword: z.string().min(1).describe("\u8BFE\u7A0B\u540D\uFF08\u5305\u542B\u5373\u53EF\uFF09\uFF0C\u5982\u300C\u6570\u636E\u7ED3\u6784\u300D"),
      semester: z.string().optional().describe("\u5B66\u671F id \u6216\u540D\u79F0\u5173\u952E\u8BCD\uFF0C\u9ED8\u8BA4\u5F53\u524D\u5B66\u671F"),
      page: int2("\u7B2C\u51E0\u9875\uFF0C\u9ED8\u8BA4 1", 1, 500),
      size: int2("\u6BCF\u9875\u51E0\u6761\uFF0C\u9ED8\u8BA4 20", 1, 100)
    },
    examples: ["fdu jw lessons --keyword \u6570\u636E\u7ED3\u6784", "fdu jw lessons --keyword \u7EBF\u6027\u4EE3\u6570 --semester 2026-2027\u5B66\u5E742\u5B66\u671F"],
    async run(ctx, a) {
      return readLessons(ctx.session.reader("jwfw"), { keyword: a.keyword, semester: a.semester, page: a.page, size: a.size });
    }
  }),
  op({
    name: "jw.selected",
    summary: "\u9009\u8BFE\u7ED3\u679C\uFF1A\u67D0\u5B66\u671F\u5DF2\u9009\u4E0A\u7684\u8BFE\u3001\u5B66\u5206\u548C\u4E0A\u8BFE\u65F6\u95F4\u3002",
    login: "uis",
    effect: "read",
    params: { which: z.string().optional().describe("current \u5F53\u524D\u5B66\u671F\uFF08\u9ED8\u8BA4\uFF09\u3001next \u4E0B\u5B66\u671F\uFF0C\u6216\u5B66\u671F\u540D\u5173\u952E\u8BCD") },
    async run(ctx, a) {
      return readSelectedCourses(ctx.session.reader("jwfw"), a.which ?? "current");
    }
  }),
  // ======================= iCourse 课程回放 =======================
  op({
    name: "icourse.search",
    summary: "\u5728 iCourse\uFF08\u8BFE\u7A0B\u56DE\u653E\uFF09\u91CC\u6309\u8BFE\u7A0B\u540D\u6216\u8001\u5E08\u627E\u8BFE\u7A0B\uFF0C\u8FD4\u56DE\u8BFE\u7A0B\u53F7\u3002\u9ED8\u8BA4\u627E\u6700\u65B0\u5B66\u671F\u3002",
    login: "uis",
    effect: "read",
    params: { keyword: z.string().min(1).describe("\u8BFE\u7A0B\u540D\u6216\u8001\u5E08\u540D"), term: z.string().regex(/^\d+$/).optional().describe("iCourse \u7684\u5B66\u671F\u7F16\u53F7\uFF08\u6765\u81EA icourse terms\uFF09\uFF0C\u9ED8\u8BA4\u6700\u65B0\u5B66\u671F"), limit: int2("\u6700\u591A\u51E0\u6761\uFF0C\u9ED8\u8BA4 20", 1, 100) },
    examples: ["fdu icourse search --keyword \u6570\u636E\u7ED3\u6784"],
    async run(ctx, a) {
      return icourse(ctx).search(a.keyword, { term: a.term, limit: a.limit });
    }
  }),
  op({
    name: "icourse.terms",
    summary: "iCourse \u4E0A\u6709\u8BFE\u7A0B\u7684\u5B66\u671F\u548C\u5BF9\u5E94\u7684\u5B66\u671F\u7F16\u53F7\uFF08\u65B0\u7684\u5728\u524D\uFF09\u3002",
    login: "uis",
    effect: "read",
    params: {},
    async run(ctx) {
      return icourse(ctx).terms();
    }
  }),
  op({
    name: "icourse.lectures",
    summary: "\u4E00\u95E8\u8BFE\u5728 iCourse \u4E0A\u7684\u5168\u90E8\u8BB2\u6B21\uFF1A\u65E5\u671F\u3001\u8282\u6B21\u3001\u4E3B\u8BB2\u4EBA\u3001\u6709\u6CA1\u6709\u56DE\u653E\uFF0C\u6309\u65E5\u671F\u6392\u5E8F\u3002",
    login: "uis",
    effect: "read",
    params: { course: z.string().regex(/^\d+$/).describe("\u8BFE\u7A0B\u53F7\uFF08\u6765\u81EA icourse search\uFF09"), playback: flag("\u53EA\u770B\u6709\u56DE\u653E\u7684") },
    examples: ["fdu icourse lectures --course 12345 --playback"],
    async run(ctx, a) {
      const r = await icourse(ctx).lectures(a.course);
      return a.playback ? { ...r, lectures: r.lectures.filter((l) => l.hasPlayback) } : r;
    }
  }),
  op({
    name: "icourse.transcript",
    summary: "\u67D0\u4E00\u8BB2\u7684\u8BFE\u5802\u6587\u5B57\u7A3F\uFF08\u5E73\u53F0\u81EA\u52A8\u8F6C\u5199\uFF0C\u5E26\u65F6\u95F4\uFF09\uFF0C\u53EF\u4EE5\u7528\u6765\u603B\u7ED3\u8FD9\u8282\u8BFE\u8BB2\u4E86\u4EC0\u4E48\u3002\u5B66\u6821\u5BA1\u6838\u671F\u5185\u8FD8\u6CA1\u5F00\u653E\u7684\u56DE\u653E\u4F1A\u5982\u5B9E\u8BF4\u660E\uFF0C\u4E0D\u7ED5\u8FC7\u3002\u6587\u5B57\u7A3F\u8F83\u957F\u65F6\u5206\u6BB5\u8FD4\u56DE\u3002",
    login: "uis",
    effect: "read",
    params: {
      course: z.string().regex(/^\d+$/).describe("\u8BFE\u7A0B\u53F7"),
      lecture: z.string().regex(/^\d+$/).describe("\u8BB2\u6B21\u53F7\uFF08\u6765\u81EA icourse lectures \u7684 lectureId\uFF09"),
      format: z.enum(["text", "segments"]).optional().describe("text \u6309\u5206\u949F\u5408\u6210\u6BB5\u843D\uFF08\u9ED8\u8BA4\uFF09\uFF1Bsegments \u539F\u59CB\u5206\u6BB5\uFF08\u5F00\u59CB\u3001\u7ED3\u675F\u79D2\u6570\uFF09"),
      offset: z.coerce.number().int().min(0).optional().describe("\u4ECE\u7B2C\u51E0\u4E2A\u5B57\u5F00\u59CB\uFF08\u5206\u6BB5\u8BFB\u53D6\u957F\u6587\u5B57\u7A3F\u7528\uFF0C\u9ED8\u8BA4 0\uFF09"),
      maxChars: z.coerce.number().int().min(1e3).max(2e5).optional().describe("\u6700\u591A\u8FD4\u56DE\u591A\u5C11\u5B57\uFF0C\u9ED8\u8BA4 30000")
    },
    examples: ["fdu icourse transcript --course 12345 --lecture 67890", "fdu icourse transcript --course 12345 --lecture 67890 --offset 30000"],
    async run(ctx, a) {
      const { segments } = await icourse(ctx).transcript(a.course, a.lecture);
      if (!segments.length) return { course: a.course, lecture: a.lecture, empty: true, note: "\u8FD9\u4E00\u8BB2\u6CA1\u6709\u6587\u5B57\u7A3F\uFF08\u5E73\u53F0\u6CA1\u6709\u8F6C\u5199\uFF0C\u6216\u8005\u6CA1\u6709\u58F0\u97F3\uFF09\u3002" };
      const max = a.maxChars ?? 3e4;
      const offset = a.offset ?? 0;
      const duration = clock(segments[segments.length - 1].end);
      if (a.format === "segments") {
        let seen = 0;
        let used = 0;
        const out = [];
        let next;
        for (const s of segments) {
          const len = s.text.length;
          if (seen + len <= offset) {
            seen += len;
            continue;
          }
          if (used + len > max && out.length) {
            next = seen;
            break;
          }
          out.push({ start: clock(s.start), end: clock(s.end), text: s.text });
          used += len;
          seen += len;
        }
        return { course: a.course, lecture: a.lecture, duration, segments: out, ...next !== void 0 ? { nextOffset: next } : {} };
      }
      const text = transcriptText(segments);
      const part = text.slice(offset, offset + max);
      const nextOffset = offset + max < text.length ? offset + max : void 0;
      return { course: a.course, lecture: a.lecture, duration, totalChars: text.length, offset, text: part, ...nextOffset !== void 0 ? { nextOffset, note: `\u8FD8\u6709 ${text.length - nextOffset} \u5B57\uFF0C\u7528 --offset ${nextOffset} \u7EE7\u7EED\u8BFB\u3002` } : {} };
    }
  }),
  // ======================= 校园生活 =======================
  op({
    name: "card.balance",
    summary: "\u6821\u56ED\u5361\u4F59\u989D\u3002",
    login: "uis",
    effect: "read",
    params: {},
    async run(ctx) {
      return { balance: await readCardBalance(ctx.session.reader("jwfw")), at: new Date(ctx.now()).toISOString() };
    }
  }),
  op({
    name: "card.transactions",
    summary: "\u6821\u56ED\u5361\u6D88\u8D39\u8BB0\u5F55\uFF08\u65F6\u95F4\u3001\u7C7B\u578B\u3001\u5546\u6237\u3001\u91D1\u989D\uFF1B\u652F\u51FA\u4E3A\u8D1F\uFF09\u548C\u7EDF\u8BA1\uFF1A\u603B\u652F\u51FA\u3001\u5145\u503C\u3001\u65E5\u5747\u3001\u6309\u5546\u6237\u548C\u9910\u6B21\u3002\u9ED8\u8BA4\u6700\u8FD1 7 \u5929\u3002",
    login: "uis",
    effect: "read",
    sensitive: true,
    params: {
      days: int2("\u6700\u8FD1\u51E0\u5929\uFF08\u542B\u4ECA\u5929\uFF09\uFF0C\u9ED8\u8BA4 7", 1, 366),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("\u5F00\u59CB\u65E5\u671F YYYY-MM-DD\uFF08\u548C --days \u4E8C\u9009\u4E00\uFF09"),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("\u7ED3\u675F\u65E5\u671F\uFF0C\u9ED8\u8BA4\u4ECA\u5929"),
      limit: int2("\u6700\u591A\u8FD4\u56DE\u51E0\u6761\u660E\u7EC6\uFF0C\u9ED8\u8BA4 100\uFF08\u7EDF\u8BA1\u6309\u5168\u90E8\u8BB0\u5F55\u7B97\uFF09", 0, 2e3),
      merchant: z.string().optional().describe("\u53EA\u770B\u5546\u6237\u540D\u5305\u542B\u8FD9\u4E2A\u8BCD\u7684\uFF0C\u5982\u300C\u98DF\u5802\u300D\u300C\u5317\u533A\u300D")
    },
    examples: ["fdu card transactions", "fdu card transactions --days 30 --limit 0", "fdu card transactions --from 2026-10-01 --to 2026-10-31"],
    async run(ctx, a) {
      const range = cardRange(ctx.now(), { days: a.days, from: a.from, to: a.to });
      const { records, truncated } = await readCardRecords(ctx.session.reader("jwfw"), range);
      const picked = a.merchant ? records.filter((r) => r.merchant.includes(a.merchant)) : records;
      const limit = a.limit ?? 100;
      return {
        ...range,
        summary: summarize(picked),
        records: picked.slice(0, limit).map((r) => ({ ...r, timeShanghai: shanghaiDate(r.time) })),
        ...picked.length > limit ? { note: `\u53EA\u5217\u51FA\u6700\u65B0 ${limit} \u6761\u660E\u7EC6\uFF0C\u7EDF\u8BA1\u6309\u5168\u90E8 ${picked.length} \u6761\u8BA1\u7B97\uFF1B\u8981\u5168\u90E8\u660E\u7EC6\u7528 --limit ${Math.min(2e3, picked.length)}\u3002` } : {},
        ...truncated ? { truncated: true, note: "\u8BB0\u5F55\u592A\u591A\uFF0C\u53EA\u8BFB\u4E86\u6700\u8FD1\u7684\u4E00\u90E8\u5206\uFF1B\u7F29\u77ED\u65E5\u671F\u8303\u56F4\u53EF\u4EE5\u8BFB\u5168\u3002" } : {}
      };
    }
  }),
  op({
    name: "venue.list",
    summary: "\u53EF\u4EE5\u9884\u7EA6\u7684\u4F53\u80B2\u573A\u9986\uFF08id\u3001\u540D\u79F0\uFF09\uFF0C\u5982\u300C\u5317\u533A\u4F53\u80B2\u9986-\u7FBD\u6BDB\u7403\u300D\u3002",
    login: "uis",
    effect: "read",
    params: {},
    async run(ctx) {
      return withBooking(ctx, listVenues);
    }
  }),
  op({
    name: "venue.free",
    summary: "\u4F53\u80B2\u573A\u9986\u7684\u7A7A\u95F2\u65F6\u6BB5\uFF1A\u6BCF\u4E2A\u65F6\u6BB5\u8FD8\u6709\u54EA\u4E9B\u573A\u5730\u7A7A\u7740\uFF08\u53EA\u770B\uFF0C\u4E0D\u9884\u7EA6\uFF09\u3002\u573A\u9986\u53EF\u4EE5\u5199 id \u6216\u540D\u79F0\u5173\u952E\u8BCD\uFF08\u5982\u300C\u5317\u533A \u7FBD\u6BDB\u7403\u300D\uFF09\u3002",
    login: "uis",
    effect: "read",
    params: {
      venue: z.string().min(1).describe("\u573A\u9986 id \u6216\u540D\u79F0\u5173\u952E\u8BCD\uFF0C\u591A\u4E2A\u8BCD\u7528\u7A7A\u683C\u5206\u5F00"),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("\u65E5\u671F YYYY-MM-DD\uFF0C\u9ED8\u8BA4\u4ECA\u5929"),
      days: int2("\u8FDE\u770B\u51E0\u5929\uFF0C\u9ED8\u8BA4 1", 1, 7),
      all: flag("\u4E5F\u5217\u51FA\u5DF2\u7ECF\u7EA6\u6EE1\u7684\u65F6\u6BB5")
    },
    examples: ['fdu venue free --venue "\u5317\u533A \u7FBD\u6BDB\u7403"', "fdu venue free --venue \u6B63\u5927 --date 2026-11-10 --days 3"],
    async run(ctx, a) {
      const from = a.date ?? shanghaiDay(ctx.now());
      const to = addDays(from, (a.days ?? 1) - 1);
      return withBooking(ctx, async (getJson) => {
        const matched = matchVenues(await listVenues(getJson), a.venue);
        if (!matched.length) throw new FduError("NOT_FOUND", `\u6CA1\u6709\u627E\u5230\u573A\u9986\u300C${a.venue}\u300D\u3002`, "\u7528 `fdu venue list` \u67E5\u770B\u573A\u9986\u540D\u79F0\u3002");
        if (matched.length > 5) throw new FduError("BAD_ARGS", `\u300C${a.venue}\u300D\u5BF9\u5E94\u4E86 ${matched.length} \u4E2A\u573A\u9986\uFF0C\u8BF7\u5199\u5F97\u66F4\u5177\u4F53\u4E00\u4E9B\uFF1A${matched.slice(0, 8).map((v) => v.name).join("\u3001")}\u2026\u2026`);
        const out = [];
        for (const v of matched) {
          const days = await venueCalendar(getJson, v.id, from, to);
          out.push({ venue: v.name, id: v.id, days: a.all ? days : days.map((d) => ({ ...d, slots: d.slots.filter((s) => s.free.length) })) });
        }
        return { from, to, venues: out, note: "\u53EA\u662F\u67E5\u770B\u7A7A\u95F2\u60C5\u51B5\uFF1B\u9884\u7EA6\u8BF7\u5230 booking.fudan.edu.cn\u3002" };
      });
    }
  }),
  op({
    name: "dorm.electricity",
    summary: "\u5BBF\u820D\u5269\u4F59\u7535\u91CF\uFF08\u5EA6\uFF09\u3002",
    login: "uis",
    effect: "read",
    params: {},
    async run(ctx) {
      return readElectricity(ctx.session.reader("jwfw"));
    }
  }),
  op({
    name: "library.seats",
    summary: "\u5404\u56FE\u4E66\u9986\u5728\u9986\u4EBA\u6570\u548C\u8FD8\u80FD\u8FDB\u591A\u5C11\u4EBA\uFF08\u516C\u5F00\u63A5\u53E3\uFF0C\u4E0D\u7528\u767B\u5F55\uFF09\u3002",
    login: "none",
    effect: "read",
    params: {},
    async run(ctx) {
      return readLibrary(async (url) => {
        const r = await ctx.session.raw(url, { method: "POST" });
        return { status: r.status, text: r.text };
      });
    }
  }),
  op({
    name: "library.login",
    summary: "\u767B\u5F55\u56FE\u4E66\u9986\u300C\u6211\u7684\u501F\u9605\u300D\uFF1A\u6253\u5F00\u56FE\u4E66\u9986\u9875\u9762\uFF0C\u70B9\u300C\u767B\u5F55\u300D\uFF08\u8D70\u7EDF\u4E00\u8EAB\u4EFD\u8BA4\u8BC1\uFF0C\u5DF2\u767B\u5F55\u590D\u65E6\u8D26\u53F7\u65F6\u4E00\u822C\u4E0D\u7528\u518D\u8F93\u5BC6\u7801\uFF09\uFF0C\u770B\u5230\u501F\u9605\u4FE1\u606F\u540E\u7A97\u53E3\u4F1A\u81EA\u52A8\u5173\u95ED\u3002",
    login: "none",
    effect: "auth",
    mcp: false,
    params: {},
    async run(ctx) {
      let ok = false;
      let listening = false;
      ctx.log("\u5DF2\u6253\u5F00\u56FE\u4E66\u9986\u9875\u9762\uFF1A\u8BF7\u70B9\u53F3\u4E0A\u89D2\u300C\u767B\u5F55\u300D\uFF0C\u767B\u5F55\u540E\u8FDB\u5165\u300C\u6211\u7684\u501F\u9605\u300D\uFF0C\u770B\u5230\u501F\u9605\u4FE1\u606F\u540E\u7A97\u53E3\u4F1A\u81EA\u52A8\u5173\u95ED\u3002");
      await ctx.session.withPage(OPAC, async (page) => {
        if (!listening) {
          listening = true;
          page.on("response", (res) => {
            if (!res.url().includes("fdulspgw.fudan.edu.cn/alsp/open-api/elib5/") || res.status() !== 200) return;
            if (res.request().headers().access_token) ok = true;
          });
        }
        return ok;
      }, { headless: false, timeoutMs: 3e5 });
      if (!ok) throw new FduError("NEED_LOGIN", "\u6CA1\u6709\u5B8C\u6210\u56FE\u4E66\u9986\u767B\u5F55\u3002", "\u91CD\u65B0\u8FD0\u884C `fdu library login`\uFF0C\u767B\u5F55\u540E\u70B9\u5F00\u300C\u6211\u7684\u501F\u9605\u300D\u3002");
      await ctx.session.save();
      return { loggedIn: true };
    }
  }),
  op({
    name: "library.loans",
    summary: "\u56FE\u4E66\u9986\u5728\u501F\u7684\u4E66\uFF1A\u4E66\u540D\u3001\u4F5C\u8005\u3001\u7D22\u4E66\u53F7\u3001\u9986\u85CF\u5730\u3001\u501F\u9605\u65E5\u671F\u3001\u5E94\u8FD8\u65E5\u671F\u3001\u8FD8\u5269\u51E0\u5929\u3001\u7EED\u501F\u6B21\u6570\uFF1B\u4EE5\u53CA\u8FD8\u80FD\u501F\u51E0\u672C\u3001\u903E\u671F\u51E0\u672C\u3001\u6B20\u8D39\u3002\u53EA\u770B\uFF0C\u4E0D\u7EED\u501F\u3002",
    login: "uis",
    effect: "read",
    sensitive: true,
    params: {},
    examples: ["fdu library loans"],
    async run(ctx) {
      return withLibrary(ctx, (getJson) => readLoans(getJson, shanghaiDay(ctx.now())));
    }
  }),
  op({
    name: "library.history",
    summary: "\u56FE\u4E66\u9986\u501F\u9605\u5386\u53F2\uFF08\u4E66\u540D\u3001\u4F5C\u8005\u3001\u501F\u9605\u548C\u5F52\u8FD8\u65E5\u671F\uFF09\uFF0C\u6309\u9875\u8BFB\u53D6\u3002",
    login: "uis",
    effect: "read",
    sensitive: true,
    params: { page: int2("\u7B2C\u51E0\u9875\uFF0C\u9ED8\u8BA4 1", 1, 1e3), size: int2("\u6BCF\u9875\u51E0\u6761\uFF0C\u9ED8\u8BA4 20", 1, 100) },
    async run(ctx, a) {
      return withLibrary(ctx, (getJson) => readHistory(getJson, a.page ?? 1, a.size ?? 20));
    }
  }),
  op({
    name: "library.search",
    summary: "\u590D\u65E6\u56FE\u4E66\u9986\u6587\u732E\u68C0\u7D22\uFF08\u8BBA\u6587\u3001\u56FE\u4E66\uFF1B\u8FD4\u56DE\u6807\u9898\u3001\u4F5C\u8005\u3001\u5E74\u4EFD\u3001\u6458\u8981\u3001DOI\u3001\u8BE6\u60C5\u9875\u94FE\u63A5\uFF09\u3002",
    login: "none",
    effect: "read",
    params: {
      query: z.string().min(1).describe("\u68C0\u7D22\u8BCD"),
      scope: z.enum(["articles", "all", "books"]).optional().describe("articles \u6587\u7AE0\uFF08\u9ED8\u8BA4\uFF09\u3001books \u56FE\u4E66\u671F\u520A\u3001all \u5168\u90E8"),
      field: z.enum(["all", "title", "author", "subject", "fulltext"]).optional(),
      limit: int2("\u8FD4\u56DE\u51E0\u6761\uFF0C\u9ED8\u8BA4 10", 1, 50),
      yearFrom: z.coerce.number().int().optional(),
      yearTo: z.coerce.number().int().optional(),
      sort: z.enum(["relevance", "newest"]).optional(),
      peerReviewedOnly: flag("\u53EA\u770B\u540C\u884C\u8BC4\u5BA1"),
      fullTextOnly: flag("\u53EA\u770B\u6709\u5168\u6587\u7684")
    },
    examples: ['fdu library search --query "graph neural network molecule" --year-from 2022'],
    async run(ctx, a) {
      const lib = new LibrarySearch(async (url, headers) => {
        const r = await ctx.session.raw(url, { headers });
        return { status: r.status, text: r.text };
      });
      return lib.search({ ...a, limit: a.limit ?? 10 });
    }
  }),
  // ======================= 学校通知 =======================
  op({
    name: "notices.sources",
    summary: "\u5185\u7F6E\u7684\u5B66\u6821\u90E8\u95E8\u548C\u9662\u7CFB\u5B98\u7F51\u901A\u77E5\u6765\u6E90\uFF08id\u3001\u540D\u79F0\u3001\u7F51\u5740\uFF09\u3002",
    login: "none",
    effect: "read",
    cache: false,
    params: {},
    async run() {
      return NOTICE_SOURCES;
    }
  }),
  op({
    name: "notices.list",
    summary: "\u67D0\u4E2A\u90E8\u95E8 / \u9662\u7CFB\u5B98\u7F51\u6700\u65B0\u7684\u901A\u77E5\u5217\u8868\uFF08\u6807\u9898\u3001\u65E5\u671F\u3001\u94FE\u63A5\uFF09\u3002",
    login: "none",
    effect: "read",
    params: { source: z.string().describe("\u6765\u6E90 id \u6216\u540D\u79F0\uFF0C\u5982 jwc\u3001\u6559\u52A1\u5904\u3001\u8BA1\u7B97\u673A\u5B66\u9662"), limit: int2("\u8FD4\u56DE\u51E0\u6761\uFF0C\u9ED8\u8BA4 20", 1, 100) },
    examples: ["fdu notices list --source \u6559\u52A1\u5904"],
    async run(ctx, a) {
      const source = NOTICE_SOURCES.find((s) => s.id === a.source) ?? findNoticeSource(a.source);
      if (!source) throw new FduError("NOT_FOUND", `\u6CA1\u6709\u627E\u5230\u901A\u77E5\u6765\u6E90\u300C${a.source}\u300D\u3002`, "\u7528 `fdu notices sources` \u67E5\u770B\u53EF\u7528\u6765\u6E90\u3002");
      const page = await ctx.session.raw(source.url);
      if (page.status >= 400) throw new FduError("UPSTREAM", `${source.name}\u7F51\u7AD9\u8FD4\u56DE ${page.status}\uFF08\u90E8\u5206\u9662\u7CFB\u7F51\u7AD9\u53EA\u5141\u8BB8\u6821\u56ED\u7F51\u8BBF\u95EE\uFF09\u3002`);
      return { source: source.name, url: source.url, notices: parseNoticeList(page.text, page.url).slice(0, a.limit ?? 20) };
    }
  }),
  op({
    name: "notices.read",
    summary: "\u8BFB\u4E00\u6761\u901A\u77E5\u7684\u6B63\u6587\u3001\u53D1\u5E03\u65E5\u671F\u548C\u9644\u4EF6\u94FE\u63A5\u3002",
    login: "none",
    effect: "read",
    params: { url: z.string().url().describe("\u901A\u77E5\u94FE\u63A5\uFF08\u6765\u81EA notices list\uFF09") },
    async run(ctx, a) {
      if (!/^https?:\/\//.test(a.url)) throw new FduError("BAD_ARGS", "\u53EA\u652F\u6301 http / https \u94FE\u63A5\u3002");
      const page = await ctx.session.raw(a.url);
      if (page.status >= 400) throw new FduError("UPSTREAM", `\u7F51\u7AD9\u8FD4\u56DE ${page.status}`);
      const d = parseNoticeDetail(page.text, page.url);
      return { url: page.url, ...d, text: d.text.slice(0, 2e4) };
    }
  }),
  // ======================= 树洞与旦克 =======================
  op({
    name: "hole.login",
    summary: "\u767B\u5F55\u6811\u6D1E\uFF08\u65E6\u631E\uFF09\u8D26\u53F7\uFF1A\u5BC6\u7801\u53EA\u7528\u6765\u6362\u53D6\u4EE4\u724C\uFF0C\u4E0D\u4FDD\u5B58\u3002\u6821\u5916\u4F1A\u81EA\u52A8\u8D70 WebVPN\uFF08\u9700\u8981\u5148 fdu login\uFF09\u3002",
    login: "none",
    effect: "auth",
    mcp: false,
    params: { email: z.string().email().describe("\u6811\u6D1E\u8D26\u53F7\u90AE\u7BB1\uFF0C\u901A\u5E38\u662F \u5B66\u53F7@m.fudan.edu.cn") },
    async run(ctx, a) {
      const password = await needPrompt(ctx)("\u6811\u6D1E\u5BC6\u7801\uFF08\u4E0D\u4F1A\u663E\u793A\uFF0C\u4E5F\u4E0D\u4F1A\u4FDD\u5B58\uFF09\uFF1A", { hidden: true });
      await treehole(ctx).login(a.email, password);
      return { loggedIn: true };
    }
  }),
  op({
    name: "hole.logout",
    summary: "\u5220\u9664\u672C\u673A\u4FDD\u5B58\u7684\u6811\u6D1E\u4EE4\u724C\u3002",
    login: "none",
    effect: "auth",
    mcp: false,
    params: {},
    async run(ctx) {
      return { removed: ctx.store.remove(HOLE) };
    }
  }),
  op({
    name: "hole.search",
    summary: "\u5728\u6811\u6D1E\u91CC\u641C\u7D22\u5E16\u5B50\u697C\u5C42\uFF08\u533F\u540D\u540C\u5B66\u7684\u4E2A\u4EBA\u770B\u6CD5\uFF0C\u4E0D\u662F\u4E8B\u5B9E\uFF09\u3002",
    login: "hole",
    effect: "read",
    params: { keyword: z.string().min(1), limit: int2("\u8FD4\u56DE\u51E0\u6761\uFF0C\u9ED8\u8BA4 10", 1, 50), days: int2("\u53EA\u770B\u6700\u8FD1\u51E0\u5929", 1, 3650), accurate: flag("\u7CBE\u786E\u5339\u914D") },
    async run(ctx, a) {
      return treehole(ctx).searchFloors(a.keyword, { limit: a.limit, withinDays: a.days, accurate: a.accurate });
    }
  }),
  op({
    name: "hole.read",
    summary: "\u8BFB\u4E00\u4E2A\u6811\u6D1E\u5E16\u5B50\uFF08\u6D1E\u53F7\uFF09\u53CA\u5176\u697C\u5C42\u3002",
    login: "hole",
    effect: "read",
    params: { id: z.coerce.number().int().positive().describe("\u6D1E\u53F7"), start: int2("\u4ECE\u7B2C\u51E0\u697C\u5F00\u59CB", 0, 1e5), length: int2("\u8BFB\u51E0\u697C\uFF0C\u9ED8\u8BA4 30", 1, 100) },
    async run(ctx, a) {
      return treehole(ctx).hole(a.id, { start: a.start, length: a.length });
    }
  }),
  op({
    name: "hole.latest",
    summary: "\u6811\u6D1E\u6700\u65B0\u7684\u5E16\u5B50\u3002",
    login: "hole",
    effect: "read",
    params: { length: int2("\u51E0\u6761\uFF0C\u9ED8\u8BA4 10", 1, 50), tag: z.string().optional().describe("\u6807\u7B7E") },
    async run(ctx, a) {
      return treehole(ctx).latest({ length: a.length, tag: a.tag });
    }
  }),
  op({
    name: "danke.search",
    summary: "\u65E6\u514B\uFF08\u8BFE\u7A0B\u8BC4\u4EF7\uFF09\u91CC\u641C\u7D22\u8BFE\u7A0B\u3002",
    login: "hole",
    effect: "read",
    params: { keyword: z.string().min(1).describe("\u8BFE\u7A0B\u540D\u6216\u8BFE\u7A0B\u4EE3\u7801"), limit: int2("\u51E0\u6761\uFF0C\u9ED8\u8BA4 10", 1, 50) },
    async run(ctx, a) {
      return treehole(ctx).searchCourses(a.keyword, a.limit);
    }
  }),
  op({
    name: "danke.reviews",
    summary: "\u67D0\u95E8\u8BFE\u5728\u65E6\u514B\u4E0A\u7684\u8BC4\u4EF7\uFF08\u8BC4\u5206\u3001\u4F5C\u4E1A\u91CF\u3001\u7ED9\u5206\u3001\u5404\u8001\u5E08\u7684\u8BC4\u4EF7\uFF09\u3002",
    login: "hole",
    effect: "read",
    params: { id: z.coerce.number().int().positive().describe("\u8BFE\u7A0B\u7EC4 id\uFF08\u6765\u81EA danke search \u7684 course_group_id\uFF09"), max: int2("\u6700\u591A\u51E0\u6761\u8BC4\u4EF7\uFF0C\u9ED8\u8BA4 12", 1, 50) },
    async run(ctx, a) {
      return treehole(ctx).courseReviews(a.id, a.max);
    }
  }),
  // ======================= 学生邮箱 =======================
  op({
    name: "mail.setup",
    summary: "\u914D\u7F6E\u5B66\u751F\u90AE\u7BB1\uFF08IMAP\uFF0C\u53EA\u8BFB\uFF09\uFF1A\u9700\u8981\u7F51\u9875\u90AE\u7BB1\u91CC\u751F\u6210\u7684\u5BA2\u6237\u7AEF\u4E13\u7528\u5BC6\u7801\uFF1B\u5BC6\u7801\u4EE5\u660E\u6587\u4FDD\u5B58\u5728\u672C\u673A\u914D\u7F6E\u76EE\u5F55\uFF08\u6743\u9650 600\uFF09\u3002",
    login: "none",
    effect: "auth",
    mcp: false,
    params: { user: z.string().email().describe("\u90AE\u7BB1\u5730\u5740"), host: z.string().optional().describe(`IMAP \u670D\u52A1\u5668\uFF0C\u9ED8\u8BA4 ${DEFAULT_FUDAN_STUDENT_IMAP.host}`), port: int2("\u7AEF\u53E3\uFF0C\u9ED8\u8BA4 993", 1, 65535) },
    async run(ctx, a) {
      const password = await needPrompt(ctx)("\u5BA2\u6237\u7AEF\u4E13\u7528\u5BC6\u7801\uFF08\u4E0D\u4F1A\u663E\u793A\uFF09\uFF1A", { hidden: true });
      const cfg = { host: a.host ?? DEFAULT_FUDAN_STUDENT_IMAP.host, port: a.port ?? DEFAULT_FUDAN_STUDENT_IMAP.port, user: a.user, password };
      if (!await new ImapMailClient(cfg).ping()) throw new FduError("NEED_MAIL_SETUP", "\u8FDE\u4E0D\u4E0A\u90AE\u7BB1\u3002", "\u68C0\u67E5\u90AE\u7BB1\u5730\u5740\u3001\u5BA2\u6237\u7AEF\u4E13\u7528\u5BC6\u7801\uFF0C\u5E76\u786E\u8BA4\u7F51\u9875\u90AE\u7BB1\u5DF2\u5F00\u542F IMAP\u3002");
      ctx.store.writeJson(MAIL, cfg);
      return { configured: true, user: cfg.user, file: ctx.store.path(MAIL) };
    }
  }),
  op({
    name: "mail.forget",
    summary: "\u5220\u9664\u672C\u673A\u4FDD\u5B58\u7684\u90AE\u7BB1\u914D\u7F6E\u548C\u5BC6\u7801\u3002",
    login: "none",
    effect: "auth",
    mcp: false,
    params: {},
    async run(ctx) {
      return { removed: ctx.store.remove(MAIL) };
    }
  }),
  op({
    name: "mail.list",
    summary: "\u6536\u4EF6\u7BB1\u91CC\u6700\u8FD1\u7684\u90AE\u4EF6\uFF08\u53D1\u4EF6\u4EBA\u3001\u4E3B\u9898\u3001\u65F6\u95F4\u3001\u6458\u8981\uFF09\uFF1B\u53EA\u8BFB\uFF0C\u4E0D\u6539\u53D8\u5DF2\u8BFB\u72B6\u6001\u3002",
    login: "mail",
    effect: "read",
    sensitive: true,
    params: { days: int2("\u6700\u8FD1\u51E0\u5929\uFF0C\u9ED8\u8BA4 7", 1, 365), limit: int2("\u6700\u591A\u51E0\u5C01\uFF0C\u9ED8\u8BA4 30", 1, 200), query: z.string().optional().describe("\u53EA\u770B\u53D1\u4EF6\u4EBA\u6216\u4E3B\u9898\u91CC\u5305\u542B\u8FD9\u4E2A\u8BCD\u7684") },
    async run(ctx, a) {
      const list2 = await mailClient(ctx).fetchSince(new Date(ctx.now() - (a.days ?? 7) * DAY3), 500);
      const q = a.query?.toLowerCase();
      return list2.filter((m) => !q || `${m.from.name ?? ""} ${m.from.address} ${m.subject}`.toLowerCase().includes(q)).reverse().slice(0, a.limit ?? 30).map((m) => ({ uid: m.uid, from: m.from, subject: m.subject, date: m.date, dateShanghai: shanghaiDate(m.date), snippet: m.text.replace(/\s+/g, " ").slice(0, 200) }));
    }
  }),
  op({
    name: "mail.read",
    summary: "\u8BFB\u4E00\u5C01\u90AE\u4EF6\u7684\u6B63\u6587\uFF08\u6309 uid\uFF0C\u6765\u81EA mail list\uFF09\u3002",
    login: "mail",
    effect: "read",
    sensitive: true,
    cache: false,
    params: { uid: z.string().regex(/^\d+$/), days: int2("\u5728\u6700\u8FD1\u51E0\u5929\u91CC\u627E\uFF0C\u9ED8\u8BA4 30", 1, 365) },
    async run(ctx, a) {
      const m = (await mailClient(ctx).fetchSince(new Date(ctx.now() - (a.days ?? 30) * DAY3), 1e3)).find((x) => x.uid === a.uid);
      if (!m) throw new FduError("NOT_FOUND", `\u6700\u8FD1 ${a.days ?? 30} \u5929\u91CC\u6CA1\u6709\u627E\u5230 uid \u4E3A ${a.uid} \u7684\u90AE\u4EF6\u3002`, "\u7528 --days \u653E\u5BBD\u8303\u56F4\u3002");
      return m;
    }
  })
];
function findOp(name) {
  return OPS.find((o) => o.name === name);
}

// src/run.ts
import { z as z2 } from "zod";
var cacheable = (op2) => op2.effect === "read" && op2.cache !== false;
var camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
var kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
async function runOp(op2, ctx, input, opts = {}) {
  let args;
  try {
    const parsed = z2.object(op2.params).strict().safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => i.code === "unrecognized_keys" ? `\u4E0D\u8BA4\u8BC6\u7684\u53C2\u6570\uFF1A${i.keys.map((k) => `--${kebab(k)}`).join("\u3001")}` : `--${kebab(String(i.path[0] ?? ""))}\uFF1A${i.message}`);
      throw new FduError("BAD_ARGS", issues.join("\uFF1B"), `\u7528 \`fdu describe ${op2.name}\` \u67E5\u770B\u53C2\u6570\u3002`);
    }
    args = parsed.data;
    const useCache = !!ctx.cache && cacheable(op2);
    if (opts.cachedOnly) {
      const hit = useCache ? ctx.cache.get(op2.name, args) : null;
      if (!hit) throw new FduError("NOT_FOUND", useCache ? "\u672C\u5730\u8FD8\u6CA1\u6709\u8FD9\u4E2A\u67E5\u8BE2\u7684\u7F13\u5B58\u3002" : "\u8FD9\u4E2A\u547D\u4EE4\u7684\u7ED3\u679C\u4E0D\u7F13\u5B58\u3002", "\u53BB\u6389 --cached \u8054\u7F51\u67E5\u8BE2\u4E00\u6B21\u3002");
      return { ok: true, op: op2.name, data: hit.data, cachedAt: hit.at };
    }
    const data = await op2.run(ctx, args);
    if (useCache) {
      try {
        ctx.cache.set(op2.name, args, data, ctx.now());
      } catch {
      }
    }
    return { ok: true, op: op2.name, data };
  } catch (e) {
    const err = toFduError(e);
    const failure = { ok: false, op: op2.name, error: { code: err.code, message: err.message, ...err.hint ? { hint: err.hint } : {} } };
    if (!opts.cachedOnly && args && ctx.cache && cacheable(op2) && (err.code.startsWith("NEED_") || err.code === "UPSTREAM")) {
      const hit = ctx.cache.get(op2.name, args);
      if (hit) failure.cached = { at: hit.at, data: hit.data };
    }
    return failure;
  }
}
function exitCode(r) {
  if (r.ok) return 0;
  if (r.error.code === "BAD_ARGS") return 2;
  if (r.error.code.startsWith("NEED_")) return 3;
  return 1;
}
function describeOp(op2) {
  const shape = z2.object(op2.params);
  const json = z2.toJSONSchema(shape, { io: "input", unrepresentable: "any" });
  const params = Object.entries(json.properties ?? {}).map(([name, p]) => ({
    flag: `--${kebab(name)}`,
    name,
    type: p.enum ? p.enum.join("|") : p.type ?? "boolean",
    required: (json.required ?? []).includes(name),
    description: p.description
  }));
  return {
    name: op2.name,
    command: `fdu ${op2.name.replace(".", " ")}`,
    summary: op2.summary,
    login: op2.login,
    effect: op2.effect,
    sensitive: !!op2.sensitive,
    cached: cacheable(op2),
    mcpTool: op2.mcp === false ? null : op2.name.replace(".", "_"),
    params,
    examples: op2.examples ?? []
  };
}

// src/mcp.ts
var VERSION = true ? "0.1.0" : "0.0.0-dev";
var LOGIN_NOTE = {
  uis: "\u9700\u8981\u590D\u65E6\u8D26\u53F7\u767B\u5F55\uFF08\u6CA1\u767B\u5F55\u65F6\u8FD4\u56DE NEED_LOGIN\uFF0C\u8BF7\u7528\u6237\u5728\u7EC8\u7AEF\u8FD0\u884C `fdu login`\uFF0C\u6216\u8C03\u7528 auth_login\uFF09\u3002",
  hole: "\u9700\u8981\u6811\u6D1E\u8D26\u53F7\uFF08\u6CA1\u767B\u5F55\u65F6\u8FD4\u56DE NEED_HOLE_LOGIN\uFF0C\u8BF7\u7528\u6237\u5728\u7EC8\u7AEF\u8FD0\u884C `fdu hole login --email ...`\uFF09\u3002",
  mail: "\u9700\u8981\u914D\u7F6E\u5B66\u751F\u90AE\u7BB1\uFF08\u6CA1\u914D\u7F6E\u65F6\u8FD4\u56DE NEED_MAIL_SETUP\uFF0C\u8BF7\u7528\u6237\u5728\u7EC8\u7AEF\u8FD0\u884C `fdu mail setup --user ...`\uFF09\u3002",
  none: ""
};
function mcpShape(op2) {
  return Object.fromEntries(Object.entries(op2.params).map(([k, v]) => [k, FLAGS.has(v) ? z3.boolean().optional().describe(v.description ?? "") : v]));
}
function toolDescription(op2) {
  return [
    op2.summary,
    LOGIN_NOTE[op2.login],
    op2.sensitive ? "\u8FD4\u56DE\u7684\u662F\u9690\u79C1\u6570\u636E\uFF08\u6210\u7EE9 / \u90AE\u4EF6\u7B49\uFF09\uFF1A\u53EA\u7528\u6765\u56DE\u7B54\u7528\u6237\u672C\u4EBA\u7684\u95EE\u9898\uFF0C\u4E0D\u8981\u5199\u8FDB\u4EE3\u7801\u4ED3\u5E93\u3001\u63D0\u4EA4\u4FE1\u606F\u6216\u53D1\u7ED9\u522B\u4EBA\u3002" : "",
    op2.effect === "local-write" ? "\u4F1A\u5728\u672C\u673A\u5199\u6587\u4EF6\uFF08\u4E0D\u8986\u76D6\u5DF2\u6709\u6587\u4EF6\uFF09\u3002" : ""
  ].filter(Boolean).join("\n");
}
function buildServer(session, store) {
  const server = new McpServer({ name: "fudan", version: VERSION });
  for (const op2 of OPS) {
    if (op2.mcp === false) continue;
    server.registerTool(op2.name.replace(".", "_"), {
      description: toolDescription(op2),
      inputSchema: mcpShape(op2),
      annotations: { readOnlyHint: op2.effect === "read", destructiveHint: false, openWorldHint: true }
    }, async (args) => {
      const ctx = { store, session, log: (m) => process.stderr.write(`${m}
`), cwd: process.cwd(), now: () => Date.now(), cache: new Cache(store) };
      const result = await runOp(op2, ctx, args ?? {});
      await session.release();
      return {
        // 失败但有上次的结果时一并返回，并写明是什么时候的
        content: [{ type: "text", text: JSON.stringify(result.ok ? result.data : { ...result.error, ...result.cached ? { cached: result.cached } : {} }, null, 1) }],
        ...result.ok ? {} : { isError: true }
      };
    });
  }
  return server;
}
async function serveMcp(opts = {}) {
  const store = new Store(opts.profile);
  const session = new Session(store, { browserPath: opts.browser });
  const server = buildServer(session, store);
  const shutdown = async () => {
    await session.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.stdin.on("end", () => void shutdown());
  await server.connect(new StdioServerTransport());
}

// src/cli.ts
var VERSION2 = true ? "0.1.0" : "0.0.0-dev";
var ALIASES = {
  login: "auth.login",
  logout: "auth.logout",
  status: "auth.status",
  doctor: "auth.doctor",
  todo: "elearning.todo",
  today: "overview.today",
  week: "overview.week"
};
var GLOBAL = /* @__PURE__ */ new Set(["compact", "profile", "browser", "headed", "cached"]);
function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== void 0 && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else if (a === "-h") flags.help = true;
    else if (a === "-v") flags.version = true;
    else positionals.push(a);
  }
  return { positionals, flags };
}
function resolveOpName(positionals) {
  const [a, b, ...rest] = positionals;
  if (!a) return { rest: [] };
  if (ALIASES[a]) return { name: ALIASES[a], rest: [b, ...rest].filter((x) => x !== void 0) };
  if (a.includes(".")) return { name: a, rest: [b, ...rest].filter((x) => x !== void 0) };
  return { name: b ? `${a}.${b}` : a, rest };
}
function prompt(question, opts = {}) {
  return new Promise((resolve2) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: !!process.stdin.isTTY });
    if (opts.hidden && process.stdin.isTTY) {
      process.stderr.write(question);
      rl._writeToOutput = () => void 0;
      rl.question("", (answer) => {
        rl.close();
        process.stderr.write("\n");
        resolve2(answer);
      });
    } else rl.question(question, (answer) => {
      rl.close();
      resolve2(answer);
    });
  });
}
var HELP = `fdu ${VERSION2} \u2014 \u590D\u65E6\u6821\u56ED\u670D\u52A1\u547D\u4EE4\u884C\uFF08\u8F93\u51FA JSON\uFF09

\u7528\u6CD5\uFF1A
  fdu login [--webvpn]            \u767B\u5F55\u590D\u65E6\u7EDF\u4E00\u8EAB\u4EFD\u8BA4\u8BC1\uFF08\u6253\u5F00\u6D4F\u89C8\u5668\uFF0C\u4F60\u81EA\u5DF1\u8F93\u5165\u8D26\u53F7\u5BC6\u7801\uFF09
  fdu status                      \u5404\u7CFB\u7EDF\u7684\u767B\u5F55\u72B6\u6001
  fdu doctor                      \u68C0\u67E5\u73AF\u5883\u3001\u7F51\u7EDC\u548C\u767B\u5F55\uFF0C\u7ED9\u51FA\u4FEE\u590D\u5EFA\u8BAE
  fdu today / fdu week            \u4ECA\u5929 / \u8FD9\u5468\u7684\u8BFE\u3001\u8981\u4EA4\u7684\u4F5C\u4E1A\u3001\u8003\u8BD5
  fdu <\u670D\u52A1> <\u64CD\u4F5C> [--\u53C2\u6570 \u503C]    \u4F8B\u5982 fdu jw timetable\u3001fdu elearning todo --days 7
  fdu services                    \u5217\u51FA\u5168\u90E8\u64CD\u4F5C
  fdu describe <\u670D\u52A1.\u64CD\u4F5C>         \u67E5\u770B\u53C2\u6570\u548C\u793A\u4F8B
  fdu mcp                         \u4EE5 MCP \u670D\u52A1\u8FD0\u884C\uFF08\u7ED9 Claude Code\u3001Codex \u7B49\u7528\uFF09

\u901A\u7528\u53C2\u6570\uFF1A--compact \u7D27\u51D1\u8F93\u51FA\uFF1B--cached \u4E0D\u8054\u7F51\uFF0C\u8FD4\u56DE\u4E0A\u6B21\u67E5\u8BE2\u7684\u7ED3\u679C\uFF1B--profile \u540D\u79F0 \u4F7F\u7528\u53E6\u4E00\u5957\u767B\u5F55\u72B6\u6001\uFF1B--browser \u8DEF\u5F84 \u6307\u5B9A\u6D4F\u89C8\u5668
\u670D\u52A1\uFF1Aauth\u3001overview\uFF08\u6C47\u603B\uFF09\u3001calendar\uFF08\u5BFC\u51FA\u65E5\u5386\uFF09\u3001elearning\u3001jw\uFF08\u6559\u52A1\uFF09\u3001card\u3001dorm\u3001library\u3001notices\u3001hole\uFF08\u6811\u6D1E\uFF09\u3001danke\uFF08\u65E6\u514B\uFF09\u3001mail\u3001cache
`;
async function main(argv) {
  const { positionals, flags } = parseArgs(argv);
  const print = (v) => process.stdout.write(`${JSON.stringify(v, null, flags.compact ? 0 : 2)}
`);
  if (flags.version) {
    process.stdout.write(`${VERSION2}
`);
    return 0;
  }
  const [first2] = positionals;
  if (!first2 || flags.help && !first2 || first2 === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  const profile = typeof flags.profile === "string" ? flags.profile : void 0;
  const browser = typeof flags.browser === "string" ? flags.browser : void 0;
  if (first2 === "mcp") {
    await serveMcp({ profile, browser });
    return -1;
  }
  if (first2 === "services") {
    print({ ok: true, data: OPS.map((o) => ({ name: o.name, command: `fdu ${o.name.replace(".", " ")}`, summary: o.summary, login: o.login, effect: o.effect, sensitive: !!o.sensitive })) });
    return 0;
  }
  if (first2 === "describe") {
    const target = positionals[1] ? resolveOpName(positionals.slice(1)).name : void 0;
    const op3 = target ? findOp(target) : void 0;
    if (!op3) {
      print({ ok: false, error: { code: "NOT_FOUND", message: `\u6CA1\u6709\u8FD9\u4E2A\u64CD\u4F5C\uFF1A${positionals.slice(1).join(" ")}`, hint: "\u7528 `fdu services` \u67E5\u770B\u5168\u90E8\u64CD\u4F5C\u3002" } });
      return 2;
    }
    print({ ok: true, data: describeOp(op3) });
    return 0;
  }
  const { name, rest } = resolveOpName(positionals);
  const op2 = name ? findOp(name) : void 0;
  if (!op2) {
    print({ ok: false, error: { code: "NOT_FOUND", message: `\u6CA1\u6709\u8FD9\u4E2A\u547D\u4EE4\uFF1A${positionals.join(" ")}`, hint: "\u7528 `fdu services` \u67E5\u770B\u5168\u90E8\u64CD\u4F5C\uFF0C\u6216 `fdu --help`\u3002" } });
    return 2;
  }
  if (rest.length) {
    print({ ok: false, op: op2.name, error: { code: "BAD_ARGS", message: `\u591A\u4F59\u7684\u53C2\u6570\uFF1A${rest.join(" ")}`, hint: `\u53C2\u6570\u8981\u5199\u6210 --\u540D\u5B57 \u503C\uFF0C\u7528 \`fdu describe ${op2.name}\` \u67E5\u770B\u3002` } });
    return 2;
  }
  if (flags.help) {
    print({ ok: true, data: describeOp(op2) });
    return 0;
  }
  const store = new Store(profile);
  const session = new Session(store, { browserPath: browser, headed: flags.headed === true });
  const input = Object.fromEntries(Object.entries(flags).filter(([k]) => !GLOBAL.has(k)).map(([k, v]) => [camel(k), v]));
  const ctx = {
    store,
    session,
    cwd: process.cwd(),
    now: () => Date.now(),
    log: (m) => process.stderr.write(`${m}
`),
    prompt: process.stdin.isTTY ? prompt : void 0,
    cache: new Cache(store)
  };
  try {
    const result = await runOp(op2, ctx, input, { cachedOnly: flags.cached === true });
    print(result);
    return exitCode(result);
  } finally {
    await session.close();
  }
}
var invokedDirectly = process.argv[1] && /(?:^|[\\/])(cli\.(?:ts|js)|fdu)$/.test(process.argv[1]);
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    if (code >= 0) process.exitCode = code;
  }, (e) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code: "INTERNAL", message: String(e?.message ?? e) } })}
`);
    process.exitCode = 1;
  });
}
export {
  main,
  parseArgs,
  resolveOpName
};
