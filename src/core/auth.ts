import { FduError } from './errors';
import { isPermissionDenied, isUisLoginUrl, NeedLoginError, PLATFORM_URLS, type FudanAuth, type FudanPlatform, type PlatformStatus } from './fudan-auth';
import type { Session } from './session';

const ELEARNING_SELF = `${PLATFORM_URLS.elearning.base}/api/v1/users/self`;
const JW_HOME = 'https://fdjwgl.fudan.edu.cn/student/home';
const WEBVPN_HOME = 'https://webvpn.fudan.edu.cn/';
const WEBVPN_CAS = 'https://webvpn.fudan.edu.cn/login?cas_login=true';

/** CanvasClient 等模块用的认证接口：返回标准 Response */
export function sessionAuth(session: Session): FudanAuth {
  return {
    async fetch(platform, url, init) {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
      const r = await session.fetch(platform, url, { method: init?.method, headers, body: typeof init?.body === 'string' ? init.body : undefined });
      const nullBody = [101, 204, 205, 304].includes(r.status);
      const res = new Response(nullBody ? null : new Uint8Array(r.body), { status: r.status, headers: r.headers });
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

export async function webvpnAlive(session: Session): Promise<boolean> {
  try {
    const r = await session.raw(WEBVPN_HOME, { timeoutMs: 15_000 });
    const u = new URL(r.url);
    return r.status < 400 && u.hostname === 'webvpn.fudan.edu.cn' && !u.pathname.startsWith('/login');
  } catch { return false; }
}

/**
 * 建立 WebVPN 会话（校外访问树洞等只对校园网开放的系统用）。
 * 统一身份认证已登录时，在无界面浏览器里打开 WebVPN 的认证入口，几秒内自动完成；
 * 需要重新输入密码时提示运行 fdu login --webvpn。
 */
export async function ensureWebvpn(session: Session, opts: { headless?: boolean } = {}): Promise<void> {
  if (await webvpnAlive(session)) return;
  const headless = opts.headless ?? true;
  await session.withPage(WEBVPN_CAS, async (page) => {
    const u = new URL(page.url());
    return u.hostname === 'webvpn.fudan.edu.cn' && !u.pathname.startsWith('/login');
  }, { headless, timeoutMs: headless ? 30_000 : 300_000, stuckOnUisMs: 6000 });
  if (!(await webvpnAlive(session))) {
    throw new FduError('NEED_LOGIN', '没能建立 WebVPN 会话。', '运行 `fdu login --webvpn`，在浏览器里完成登录。');
  }
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
    await session.withPage(PLATFORM_URLS.elearning.entry, async (page) => {
      if (new URL(page.url()).origin !== PLATFORM_URLS.elearning.base) return false;
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
    await session.withPage(JW_HOME, (page) => new URL(page.url()).hostname === 'fdjwgl.fudan.edu.cn', { headless: true, timeoutMs: 25_000, platform: 'jwfw' }).catch(() => undefined);
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
