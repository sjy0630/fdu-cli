/**
 * fdu doctor：检查运行环境、网络和各系统的登录状态，每一项给出能照着做的修复建议。
 * 同学求助时先发这个结果（里面没有账号、Cookie 等敏感信息）。
 */
export interface Check { name: string; status: 'ok' | 'warn' | 'fail'; detail: string; fix?: string }

export interface DoctorDeps {
  nodeVersion: string;
  platform: string;
  configDir: string;
  /** 配置目录能不能写、权限是多少（Windows 上没有权限位） */
  configDirState(): { writable: boolean; mode?: number };
  /** 启动一次无界面浏览器，返回浏览器名称和版本 */
  browser(): Promise<string>;
  /** 访问一个地址，返回最终地址和状态码；连不上时抛错 */
  reach(url: string): Promise<{ status: number; url: string }>;
  login(): Promise<{ hasState: boolean; elearning: string; jwfw: string; webvpn: boolean }>;
  treehole: boolean;
  mail: boolean;
  proxy?: string;
}

const HOSTS: { name: string; url: string; required: boolean; note?: string }[] = [
  { name: '统一身份认证', url: 'https://id.fudan.edu.cn/', required: true },
  { name: 'eLearning', url: 'https://elearning.fudan.edu.cn/', required: true },
  { name: '教务系统', url: 'https://fdjwgl.fudan.edu.cn/student/home', required: true },
  { name: 'WebVPN', url: 'https://webvpn.fudan.edu.cn/', required: false, note: '校外访问树洞要用' },
  { name: '图书馆', url: 'https://mlibrary.fudan.edu.cn/', required: false },
  { name: '树洞', url: 'https://forum.fduhole.com/api/divisions', required: false, note: '校外连不上是正常的，会自动走 WebVPN' },
];

export async function runDoctor(d: DoctorDeps): Promise<{ healthy: boolean; checks: Check[] }> {
  const checks: Check[] = [];
  const major = Number(d.nodeVersion.replace(/^v/, '').split('.')[0]);
  checks.push(major >= 20
    ? { name: 'Node.js', status: 'ok', detail: d.nodeVersion }
    : { name: 'Node.js', status: 'fail', detail: `${d.nodeVersion}，需要 20 或更新`, fix: '到 https://nodejs.org 安装新版 Node.js' });

  const dir = d.configDirState();
  if (!dir.writable) checks.push({ name: '配置目录', status: 'fail', detail: `${d.configDir} 不能写入`, fix: '检查这个目录的权限，或用环境变量 FDU_HOME 换一个位置' });
  else if (d.platform !== 'win32' && dir.mode !== undefined && (dir.mode & 0o077)) checks.push({ name: '配置目录', status: 'warn', detail: `${d.configDir} 其他用户也能访问（权限 ${(dir.mode & 0o777).toString(8)}）`, fix: `运行 chmod 700 "${d.configDir}"` });
  else checks.push({ name: '配置目录', status: 'ok', detail: d.configDir });

  try {
    checks.push({ name: '浏览器', status: 'ok', detail: await d.browser() });
  } catch (e) {
    checks.push({ name: '浏览器', status: 'fail', detail: `没有找到可用的浏览器：${String((e as Error).message ?? e).split('\n')[0].slice(0, 160)}`, fix: '安装 Chrome 或 Edge；或者设置 FDU_BROWSER 为 Chromium 内核浏览器的路径；或者运行 npx playwright install chromium' });
  }

  if (d.proxy) checks.push({ name: '代理', status: 'ok', detail: `使用代理 ${d.proxy.replace(/\/\/[^@/]*@/, '//***@')}` });

  const clean = (e: unknown) => String((e as Error).message ?? e).replace(/^apiRequestContext\.\w+:\s*/, '').split('\n')[0].slice(0, 120);
  const reach = await Promise.all(HOSTS.map(async (h) => {
    try {
      const r = await d.reach(h.url);
      // 2xx / 3xx 正常；4xx 能连上但被拒绝（比如代理或防火墙拦了）；5xx 学校系统出错
      const level: Check['status'] = r.status >= 200 && r.status < 400 ? 'ok' : r.status >= 400 && r.status < 500 ? 'warn' : h.required ? 'fail' : 'warn';
      return { h, level, detail: `HTTP ${r.status}${r.status === 403 ? '（被拒绝访问，检查代理或网络限制）' : ''}` };
    } catch (e) {
      return { h, level: (h.required ? 'fail' : 'warn') as Check['status'], detail: `连不上：${clean(e)}` };
    }
  }));
  for (const { h, level, detail } of reach) {
    checks.push({
      name: `网络：${h.name}`, status: level, detail: level !== 'ok' && h.note ? `${detail}（${h.note}）` : detail,
      fix: level !== 'ok' && h.required ? '检查网络；在校外请确认浏览器能打开这个网站，必要时连学校 VPN；用了代理时检查 HTTPS_PROXY' : undefined,
    });
  }

  try {
    const l = await d.login();
    if (!l.hasState) checks.push({ name: '复旦账号', status: 'warn', detail: '还没有登录', fix: '运行 fdu login' });
    else {
      checks.push(l.elearning === 'ok' ? { name: '登录：eLearning', status: 'ok', detail: '已登录' } : { name: '登录：eLearning', status: 'fail', detail: `状态：${l.elearning}`, fix: '运行 fdu login（登录过期需要重新登录）' });
      checks.push(l.jwfw === 'ok' ? { name: '登录：教务系统', status: 'ok', detail: '已登录' } : { name: '登录：教务系统', status: 'warn', detail: `状态：${l.jwfw}`, fix: '运行 fdu login --force 重新登录' });
      checks.push(l.webvpn ? { name: '登录：WebVPN', status: 'ok', detail: '已建立' } : { name: '登录：WebVPN', status: 'warn', detail: '没有 WebVPN 会话（只在校外访问树洞时需要）', fix: '需要时运行 fdu login --webvpn' });
    }
  } catch (e) {
    checks.push({ name: '复旦账号', status: 'warn', detail: `查不到登录状态：${String((e as Error).message ?? e).slice(0, 120)}` });
  }
  checks.push(d.treehole ? { name: '树洞账号', status: 'ok', detail: '已登录' } : { name: '树洞账号', status: 'warn', detail: '没有登录（不用树洞、蛋壳课评可以忽略）', fix: 'fdu hole login --email 学号@m.fudan.edu.cn' });
  checks.push(d.mail ? { name: '学生邮箱', status: 'ok', detail: '已配置' } : { name: '学生邮箱', status: 'warn', detail: '没有配置（不查邮件可以忽略）', fix: 'fdu mail setup --user 学号@m.fudan.edu.cn' });

  return { healthy: !checks.some((c) => c.status === 'fail'), checks };
}
