import { FduError } from './errors';
import { isPermissionDenied, isUisLoginUrl, NeedLoginError, PLATFORM_URLS, type FudanAuth, type FudanPlatform, type LoginPage, type PlatformStatus } from './fudan-auth';
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

/** WebVPN 是否已登录。检查要开浏览器，2 分钟内查过且有效就不再查（fresh 时强制重查） */
export async function webvpnAlive(session: Session, opts: { fresh?: boolean } = {}): Promise<boolean> {
  if (!opts.fresh && session.webvpnAliveAt && Date.now() - session.webvpnAliveAt < 120_000) return true;
  const alive = (await webvpnCheck(session)).alive;
  session.webvpnAliveAt = alive ? Date.now() : undefined;
  return alive;
}

/**
 * 建立 WebVPN 会话（校外访问树洞、内网网站时用）。
 * 先在常驻的无界面浏览器里走 WebVPN 的统一身份认证入口：复旦账号已登录时几秒内自动完成；
 * 需要重新输入密码时：headless=false 打开有界面的窗口让你登录，否则提示运行 fdu login --webvpn。
 */
export async function ensureWebvpn(session: Session, opts: { headless?: boolean } = {}): Promise<void> {
  // 要打开窗口登录时（自动登录、fdu login --webvpn）不信缓存
  if (await webvpnAlive(session, { fresh: opts.headless === false })) return;
  const page = await session.browserPage(WEBVPN_HOME);
  await page.goto(WEBVPN_CAS, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  // 复旦账号有效时几秒内自动走完；停在统一身份认证登录页超过 4 秒说明要重新登录，不再空等
  let onUisSince = 0;
  for (let i = 0; i < 40; i++) {
    const u = new URL(page.url());
    if (u.hostname === 'webvpn.fudan.edu.cn' && !u.pathname.startsWith('/login')) break;
    if (isUisLoginUrl(page.url())) {
      onUisSince ||= Date.now();
      if (Date.now() - onUisSince > 4000) break;
    } else onUisSince = 0;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (await webvpnAlive(session, { fresh: true })) return;
  if (opts.headless === false) {
    await session.withPage(WEBVPN_CAS, async (p) => {
      const u = new URL(p.url());
      return u.hostname === 'webvpn.fudan.edu.cn' && !u.pathname.startsWith('/login');
    }, { headless: false, timeoutMs: 300_000, stuckOnUisMs: 6000 });
    if (await webvpnAlive(session, { fresh: true })) return;
  }
  const check = await webvpnCheck(session);
  throw new FduError('NEED_LOGIN', `没能建立 WebVPN 会话（检查时停在 ${check.detail}）。`, '运行 `fdu login --webvpn`，在浏览器里完成登录；还是不行请把这条信息发给开发者。', { op: 'auth.login', args: { webvpn: true } });
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
  // eLearning 自己的会话比统一身份认证活得久：它还在、但教务系统的单点登录走不通，
  // 说明统一身份认证已经过期，打开浏览器重新登录（登录后会直接回到教务系统）
  if (jwfw === 'need_login' && existing) {
    opts.onWaiting?.('统一身份认证已过期，已打开浏览器，请在学校的登录页面里重新登录（最长等待 5 分钟）……');
    await session.withPage(JW_HOME, (page) => {
      const u = new URL(page.url());
      return u.hostname === 'fdjwgl.fudan.edu.cn' && u.pathname.startsWith('/student/home');
    }, { headless: false, timeoutMs: opts.timeoutMs ?? 300_000, platform: 'jwfw' }).catch(() => undefined);
    jwfw = await platformStatus(session, 'jwfw');
  }
  let webvpn: boolean | undefined;
  if (opts.webvpn) {
    await ensureWebvpn(session, { headless: false });
    webvpn = await webvpnAlive(session);
  }
  await session.save();
  return { elearning: user, jwfw, webvpn };
}

/**
 * 打开触发登录的页面，完成统一身份认证登录或二次验证（如微信扫码），回到这个页面就算完成。
 * 先在无界面浏览器里试一次：只是单点登录要靠页面脚本时不用弹窗；停在统一身份认证时再打开窗口。
 */
export async function loginAt(session: Session, target: LoginPage, opts: { timeoutMs?: number; onWaiting?: (msg: string) => void } = {}): Promise<boolean> {
  const host = new URL(target.url).hostname;
  const done = target.done ?? ((u: string) => { try { return new URL(u).hostname === host && !isUisLoginUrl(u); } catch { return false; } });
  // 连续两次（约 1 秒）停在目标页面才算完成，避免跳转途中误判
  const settled = () => { let n = 0; return (page: { url(): string }) => (done(page.url()) ? ++n >= 2 : (n = 0, false)); };
  let ok = false;
  const quiet = settled();
  await session.withPage(target.url, (page) => (ok = quiet(page)), { headless: true, timeoutMs: 20_000 }).catch(() => undefined);
  if (!ok) {
    opts.onWaiting?.(`需要登录或二次验证，已打开浏览器（${host}）：请按页面提示完成，完成后窗口会自动关闭（最长等待 ${Math.round((opts.timeoutMs ?? 180_000) / 1000)} 秒）……`);
    const visible = settled();
    await session.withPage(target.url, (page) => (ok = visible(page)), { headless: false, timeoutMs: opts.timeoutMs ?? 180_000 }).catch(() => undefined);
  }
  if (ok) await session.save();
  return ok;
}
