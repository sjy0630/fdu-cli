import { FduError } from '../core/errors';
import { isWebvpnLogin, toWebvpnUrl } from './webvpn';

/**
 * iCourse（复旦智慧教学平台，icourse.fudan.edu.cn）：课程回放和课堂文字稿（只读）。
 *
 * - 登录：打开 iCourse 的「校内用户登录」入口，跳到统一身份认证；已经 fdu login 过时在无界面浏览器里自动完成。
 * - 校园网内直连，校外走 WebVPN。
 * - 学校对新上传的回放有审核期（接口返回「视频未到开放时间」）：审核期内如实说明还没开放，不绕过。
 */
export const ICOURSE = 'https://icourse.fudan.edu.cn';
const CAS_LOGIN = `${ICOURSE}/casapi/index.php?r=auth/login&school_login=1`;
/** 复旦在平台上的租户号 */
const TENANT = '222';

export interface RawResponse { status: number; url: string; contentType: string; text: string }
export interface IcourseDeps {
  fetch(url: string, init?: { timeoutMs?: number }): Promise<RawResponse>;
  /** 建立 WebVPN 会话 */
  ensureWebvpn(): Promise<void>;
  /** 在无界面浏览器里打开地址，直到 done 返回 true（用来走 iCourse 的统一身份认证登录） */
  openInBrowser(url: string, done: (url: string) => boolean): Promise<void>;
}

export interface IcourseCourse { courseId: string; title: string; teacher: string; department?: string; term?: string }
export interface IcourseLecture { lectureId: string; title: string; date: string; lecturer?: string; hasPlayback: boolean }
export interface TranscriptSegment { start: number; end: number; text: string }

/** 讲次标题一般是「2026-03-05第6-8节」，日期以它为准 */
const DATE_IN_TITLE = /^(\d{4}-\d{2}-\d{2})/;
/** 秒 → mm:ss 或 h:mm:ss */
export function clock(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export class IcourseClient {
  private route?: 'direct' | 'webvpn';
  private loggedIn = false;
  constructor(private readonly deps: IcourseDeps) {}

  private url(path: string): string {
    const u = `${ICOURSE}${path}`;
    return this.route === 'webvpn' ? toWebvpnUrl(u) : u;
  }

  private static json(res: RawResponse): { code?: unknown; msg?: string; data?: unknown; list?: unknown; params?: unknown } | null {
    if (!/json/.test(res.contentType) && !/^\s*\{/.test(res.text)) return null;
    try { return JSON.parse(res.text); } catch { return null; }
  }

  /** 身份接口返回 code 0 / 200 才算登录了 iCourse */
  private async whoami(): Promise<boolean> {
    try {
      const res = await this.deps.fetch(this.url('/userapi/v1/infosimple'), { timeoutMs: 10_000 });
      if (this.route === 'webvpn' && isWebvpnLogin(res.url)) return false;
      const j = IcourseClient.json(res);
      return !!j && (j.code === 0 || j.code === 200 || j.code === '0');
    } catch { return false; }
  }

  /** 选路线（直连 / WebVPN）并确保登录了 iCourse */
  private async ready(): Promise<void> {
    if (this.loggedIn) return;
    if (!this.route) {
      try {
        const res = await this.deps.fetch(`${ICOURSE}/userapi/v1/infosimple`, { timeoutMs: 4000 });
        this.route = IcourseClient.json(res) ? 'direct' : 'webvpn';
      } catch { this.route = 'webvpn'; }
    }
    if (this.route === 'webvpn') await this.deps.ensureWebvpn();
    if (await this.whoami()) { this.loggedIn = true; return; }
    const entry = this.route === 'webvpn' ? toWebvpnUrl(CAS_LOGIN) : CAS_LOGIN;
    await this.deps.openInBrowser(entry, (u) => {
      try {
        const x = new URL(u);
        const onIcourse = this.route === 'webvpn' ? x.hostname === 'webvpn.fudan.edu.cn' && !x.pathname.startsWith('/login') : x.hostname === 'icourse.fudan.edu.cn';
        return onIcourse && !x.pathname.includes('/casapi/');
      } catch { return false; }
    });
    if (!(await this.whoami())) throw new FduError('NEED_LOGIN', '没能登录 iCourse。', '先运行 `fdu login`（校外再加 --webvpn），然后重试。', { op: 'auth.login', args: { webvpn: true } });
    this.loggedIn = true;
  }

  private async get(path: string, params: Record<string, string | number>): Promise<{ code?: unknown; msg?: string; data?: unknown; list?: unknown }> {
    await this.ready();
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]));
    const res = await this.deps.fetch(this.url(`${path}?${qs}`));
    const j = IcourseClient.json(res);
    if (!j) throw new FduError('UPSTREAM', `iCourse 返回的不是数据（${res.status}）。`, '稍后再试；一直这样的话运行 fdu login 重新登录。');
    return j;
  }

  /** 一个学期的课程列表（一页）。term 是 iCourse 自己的学期编号 */
  private async courseList(term: string, page: number, perPage: number, title?: string) {
    const j = await this.get('/portal/courseapi/v3/multi-search/get-course-list', { tenant: TENANT, term, page, per_page: perPage, ...(title ? { title } : {}) });
    if (j.code !== 0) throw new FduError('UPSTREAM', `iCourse 课程列表读取失败：${j.msg ?? j.code}`);
    const d = (j.data ?? {}) as { total?: unknown; list?: unknown[] };
    const rows = Array.isArray(d.list) ? d.list as Record<string, unknown>[] : [];
    return {
      total: Number(d.total ?? 0) || 0,
      courses: rows.flatMap((r): IcourseCourse[] => {
        const id = r.id ?? r.course_id;
        if (id === undefined || id === null) return [];
        const dept = r.kkxy_name ?? r.school_name ?? r.dept_name;
        return [{ courseId: String(id), title: String(r.title ?? ''), teacher: String(r.realname ?? r.teacher ?? ''), ...(dept ? { department: String(dept) } : {}), ...(r.term_name ? { term: String(r.term_name) } : {}) }];
      }),
    };
  }

  /**
   * 有课程的学期（新的在前）。iCourse 的学期编号是递增的整数，从大往小找。
   * newestOnly：找到最新的一个就停（搜索课程时用，少发请求）。
   */
  async terms(opts: { newestOnly?: boolean; from?: number; to?: number } = {}): Promise<{ term: string; name: string; courses: number }[]> {
    const out: { term: string; name: string; courses: number }[] = [];
    for (let code = opts.from ?? 40; code >= (opts.to ?? 10); code--) {
      const r = await this.courseList(String(code), 1, 1).catch(() => undefined);
      if (!r?.total) continue;
      out.push({ term: String(code), name: r.courses[0]?.term ?? String(code), courses: r.total });
      if (opts.newestOnly) break;
    }
    return out;
  }

  /** 按课程名找课程（默认最新学期） */
  async search(keyword: string, opts: { term?: string; limit?: number } = {}): Promise<{ term: string; courses: IcourseCourse[] }> {
    const term = opts.term ?? (await this.terms({ newestOnly: true }))[0]?.term;
    if (!term) throw new FduError('NOT_FOUND', '没有在 iCourse 上找到有课程的学期。');
    const r = await this.courseList(term, 1, Math.min(opts.limit ?? 20, 100), keyword);
    // 接口按标题过滤；保险起见本地再筛一遍（课程名或老师名包含关键词）
    const k = keyword.toLowerCase();
    return { term, courses: r.courses.filter((c) => `${c.title} ${c.teacher}`.toLowerCase().includes(k)).slice(0, opts.limit ?? 20) };
  }

  /** 一门课的全部讲次（按日期排序），以及有没有回放 */
  async lectures(courseId: string): Promise<{ courseId: string; title: string; teacher: string; lectures: IcourseLecture[] }> {
    if (!/^\d+$/.test(courseId)) throw new FduError('BAD_ARGS', '课程号应该是数字（来自 fdu icourse search）。');
    const j = await this.get('/courseapi/v3/multi-search/get-course-detail', { course_id: courseId });
    if (j.code !== 0) throw new FduError('NOT_FOUND', `iCourse 上没有找到这门课：${j.msg ?? j.code}`);
    const d = (j.data ?? {}) as { title?: unknown; realname?: unknown; sub_list?: unknown };
    const lectures: IcourseLecture[] = [];
    // sub_list 的结构：{ 年: { 月: { 日: [讲次] } } }
    const tree = (d.sub_list && typeof d.sub_list === 'object' ? d.sub_list : {}) as Record<string, Record<string, Record<string, unknown[]>>>;
    for (const [y, months] of Object.entries(tree)) {
      for (const [m, days] of Object.entries(months ?? {})) {
        for (const [day, items] of Object.entries(days ?? {})) {
          for (const raw of Array.isArray(items) ? items as Record<string, unknown>[] : []) {
            if (raw.id === undefined || raw.id === null) continue;
            const title = String(raw.sub_title ?? '');
            const date = DATE_IN_TITLE.exec(title)?.[1] ?? `${y.padStart(4, '0')}-${m.padStart(2, '0')}-${day.padStart(2, '0')}`;
            lectures.push({ lectureId: String(raw.id), title, date, ...(raw.lecturer_name ? { lecturer: String(raw.lecturer_name) } : {}), hasPlayback: String(raw.playback_status) === '1' });
          }
        }
      }
    }
    lectures.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
    return { courseId, title: String(d.title ?? ''), teacher: String(d.realname ?? ''), lectures };
  }

  /**
   * 回放是否已经开放。学校对新回放有审核期，接口返回非 0（如「视频未到开放时间」）时按未开放处理。
   */
  async playbackOpen(courseId: string, lectureId: string): Promise<{ open: boolean; reason?: string }> {
    const j = await this.get('/courseapi/v3/portal-home-setting/get-sub-info', { course_id: courseId, sub_id: lectureId });
    if (j.code === 0) return { open: true };
    return { open: false, reason: j.msg ? String(j.msg) : `iCourse 返回 ${String(j.code)}` };
  }

  /** 课堂文字稿（平台自动转写，按时间分段）。只读已经开放的回放 */
  async transcript(courseId: string, lectureId: string): Promise<{ segments: TranscriptSegment[] }> {
    if (!/^\d+$/.test(lectureId)) throw new FduError('BAD_ARGS', '讲次号应该是数字（来自 fdu icourse lectures）。');
    const gate = await this.playbackOpen(courseId, lectureId);
    if (!gate.open) throw new FduError('NOT_FOUND', `这一讲的回放还没开放（${gate.reason}）。`, '学校对新回放有审核期，通常一两天后开放，到时再试。');
    const j = await this.get('/courseapi/v3/web-socket/search-trans-result', { sub_id: lectureId, format: 'json' });
    if (j.code !== 0) throw new FduError('UPSTREAM', `文字稿读取失败：${j.msg ?? j.code}`);
    const first = Array.isArray(j.list) ? (j.list as { all_content?: unknown }[])[0] : undefined;
    const raw = Array.isArray(first?.all_content) ? first.all_content as { BeginSec?: unknown; EndSec?: unknown; Text?: unknown }[] : [];
    const segments = raw
      .map((s) => ({ start: Number(s.BeginSec ?? 0) || 0, end: Number(s.EndSec ?? s.BeginSec ?? 0) || 0, text: String(s.Text ?? '').trim() }))
      .filter((s) => s.text)
      .sort((a, b) => a.start - b.start);
    return { segments };
  }
}
