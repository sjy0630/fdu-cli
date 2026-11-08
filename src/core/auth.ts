import { FduError } from './errors';
import { isPermissionDenied, isUisLoginUrl, NeedLoginError, PLATFORM_URLS, type FudanAuth, type FudanPlatform, type PlatformStatus } from './fudan-auth';
import type { Session } from './session';

const ELEARNING_SELF = `${PLATFORM_URLS.elearning.base}/api/v1/users/self`;
const JW_HOME = 'https://fdjwgl.fudan.edu.cn/student/home';
const WEBVPN_HOME = 'https://webvpn.fudan.edu.cn/';
const WEBVPN_CAS = 'https://webvpn.fudan.edu.cn/login?cas_login=true';

/**
 * 把响应头转成标准 Headers 能接受的形式：Cookie 已经由会话保存，这里不需要 Set-Cookie；
 * 同名头被合并时值里会有换行（标准 Headers 不允许），换成逗号。
 */
export function safeHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === 'set-cookie') continue;
    out[k] = v.replace(/[\r\n]+/g, ', ');
  }
  return out;
}

/** CanvasClient 等模块用的认证接口：返回标准 Response */
export function sessionAuth(session: Session): FudanAuth {
  return {
    async fetch(platform, url, init) {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
      const r = await session.fetch(platform, url, { method: init?.method, headers, body: typeof init?.body === 'string' ? init.body : undefined });
      const nullBody = [101, 204, 205, 304].includes(r.status);
      const res = new Response(nullBody ? null : new Uint8Array(r.body), { status: r.status, headers: safeHeaders(r.headers) });
      Object.defineProperty(res, 'url', { value: r.url });
      if (res.status === 401 && !(await isPermissionDenied(res))) throw new NeedLoginError(platform);
      return res;
    },
    status: (platform) => platformStatus(session, platform),
    async requestLogin() { throw new NeedLoginError('elearning'); },
  };
}

/** eLearning 身份接口能返回用户 id，才算登录成功 */
async function elearningUser(session: Session): Promise<{ id: number; name?: string } | null> {
  try {
    const r = await session.raw(ELEARNING_SELF, { headers: { Accept: 'application/json' }, timeoutMs: 15_000 });
    if (isUisLoginUrl(r.url) || r.status !== 200 || !/json/.test(r.contentType)) return null;
    const user = JSON.parse(r.text) as { id?: number; name?: string };
    return user.id ? { id: user.id, name: user.name } : null;
  } catch { return null; }
}

export async function platformStatus(session: Session, platform: FudanPlatform): Promise<PlatformStatus> {
  if (!session.hasState()) return 'need_login';
  try {
    if (platform === 'elearning') return (await elearningUser(session)) ? 'ok' : 'need_login';
    const r = await session.raw(platform === 'jwfw' ? JW_HOME : PLATFORM_URLS[platform].entry, { timeoutMs: 15_000 });
    return isUisLoginUrl(r.url) ? 'need_login' : r.status < 500 ? 'ok' : 'unavailable';
  } catch { return 'unavailable'; }
}

/** 只留协议、主机和路径，去掉参数（里面可能有票据） */
const where = (url: string) => { try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return url.slice(0, 60); } };

/**
 * WebVPN 是否已登录：在浏览器里打开 WebVPN 首页，看会不会被带到登录页。
 * （WebVPN 只认真正的浏览器发出的请求，后台请求即使带着同样的 Cookie 也会被带回登录页。）
 */
export async function webvpnCheck(session: Session): Promise<{ alive: boolean; detail: string }> {
  try {
    const page = await session.browserPage(WEBVPN_HOME);
    await page.goto(WEBVPN_HOME, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    const u = new URL(page.url());
    const alive = u.hostname === 'webvpn.fudan.edu.cn' && !u.pathname.startsWith('/login');
    return { alive, detail: where(page.url()) };
  } catch (e) { return { alive: false, detail: `打不开：${String((e as Error).message ?? e).split('\n')[0].slice(0, 80)}` }; }
}

export async function webvpnAlive(session: Session): Promise<boolean> {
  return (await webvpnCheck(session)).alive;
}

/**
 * 建立 WebVPN 会话（校外访问树洞、内网网站时用）。
 * 先在常驻的无界面浏览器里走 WebVPN 的统一身份认证入口：复旦账号已登录时几秒内自动完成；
 * 需要重新输入密码时：headless=false 打开有界面的窗口让你登录，否则提示运行 fdu login --webvpn。
 */
export async function ensureWebvpn(session: Session, opts: { headless?: boolean } = {}): Promise<void> {
  if (await webvpnAlive(session)) return;
  const page = await session.browserPage(WEBVPN_HOME);
  await page.goto(WEBVPN_CAS, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  for (let i = 0; i < 40; i++) {
    const u = new URL(page.url());
    if (u.hostname === 'webvpn.fudan.edu.cn' && !u.pathname.startsWith('/login')) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (await webvpnAlive(session)) return;
  if (opts.headless === false) {
    await session.withPage(WEBVPN_CAS, async (p) => {
      const u = new URL(p.url());
      return u.hostname === 'webvpn.fudan.edu.cn' && !u.pathname.startsWith('/login');
    }, { headless: false, timeoutMs: 300_000, stuckOnUisMs: 6000 });
    if (await webvpnAlive(session)) return;
  }
  const check = await webvpnCheck(session);
  throw new FduError('NEED_LOGIN', `没能建立 WebVPN 会话（检查时停在 ${check.detail}）。`, '运行 `fdu login --webvpn`，在浏览器里完成登录；还是不行请把这条信息发给开发者。');
}

export interface LoginResult { elearning: { id: number; name?: string }; jwfw: PlatformStatus; webvpn?: boolean }

/**
 * 登录：打开浏览器到 eLearning，跳到统一身份认证后由你自己登录（账号密码、短信 / 企业微信验证都在学校页面里完成）。
 * eLearning 身份接口确认登录后，顺路打开教务系统完成单点登录，再保存 Cookie。
 */
export async function login(session: Session, opts: { webvpn?: boolean; timeoutMs?: number; onWaiting?: (msg: string) => void } = {}): Promise<LoginResult> {
  const existing = await elearningUser(session);
  let user = existing;
  if (!user) {
    opts.onWaiting?.('已打开浏览器，请在学校的登录页面里完成登录（最长等待 5 分钟）……');
    // 直接从 eLearning 的统一身份认证入口开始（会马上跳到学校的登录页），不停在 eLearning 首页等你点「登录」；
    // 这个入口不存在时退回 /login
    const startedAt = Date.now();
    let fellBack = false;
    await session.withPage(`${PLATFORM_URLS.elearning.base}/login/cas`, async (page) => {
      if (new URL(page.url()).origin !== PLATFORM_URLS.elearning.base) return false;
      if (!fellBack && Date.now() - startedAt > 8000 && new URL(page.url()).pathname.startsWith('/login/cas')) {
        fellBack = true;
        await page.goto(`${PLATFORM_URLS.elearning.base}/login`).catch(() => undefined);
        return false;
      }
      try {
        const r = await page.request.get(ELEARNING_SELF, { headers: { Accept: 'application/json' }, failOnStatusCode: false });
        const data = r.ok() ? await r.json() as { id?: number } : null;
        return !!data?.id;
      } catch { return false; }
    }, { headless: false, timeoutMs: opts.timeoutMs ?? 300_000 });
    user = await elearningUser(session);
    if (!user) throw new FduError('NEED_LOGIN', '没有完成登录。', '重新运行 `fdu login`，在浏览器里登录后等窗口自动关闭。');
  }
  // 教务系统的单点登录最后一步靠页面脚本，在无界面浏览器里走一遍
  let jwfw = await platformStatus(session, 'jwfw');
  if (jwfw !== 'ok') {
    // 要等跳转全部走完、停在教务系统首页，才算单点登录完成
    await session.withPage(JW_HOME, (page) => {
      const u = new URL(page.url());
      return u.hostname === 'fdjwgl.fudan.edu.cn' && u.pathname.startsWith('/student/home');
    }, { headless: true, timeoutMs: 25_000, platform: 'jwfw' }).catch(() => undefined);
    for (let i = 0; i < 3 && jwfw !== 'ok'; i++) {
      jwfw = await platformStatus(session, 'jwfw');
      if (jwfw !== 'ok') await new Promise((r) => setTimeout(r, 1500));
    }
  }
  let webvpn: boolean | undefined;
  if (opts.webvpn) {
    await ensureWebvpn(session, { headless: false });
    webvpn = await webvpnAlive(session);
  }
  await session.save();
  return { elearning: user, jwfw, webvpn };
}
