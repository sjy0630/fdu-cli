import { FduError } from '../core/errors';

/**
 * 图书馆「我的借阅」（新系统 opac.fudan.edu.cn，接口在 fdulspgw.fudan.edu.cn，只读，不续借）。
 *
 * 登录由图书馆的网页应用完成（统一身份认证），它把令牌存在浏览器里；
 * 调用方在浏览器里打开图书馆页面、找到令牌，再用请求头 access_token 读接口。
 * 只返回借阅需要的字段：读者信息里的姓名、证号、邮箱等一概不返回。
 */
export const OPAC = 'https://opac.fudan.edu.cn/';
export const LIB_API = 'https://fdulspgw.fudan.edu.cn/alsp/open-api/elib5';

export type GetJson = (url: string) => Promise<{ status: number; text: string }>;

export interface Loan {
  title: string;
  author?: string;
  callNo?: string;
  isbn?: string;
  library?: string;
  location?: string;
  loanDate?: string;
  dueDate?: string;
  /** 已续借次数 / 最多可续借次数 */
  renewed: number;
  renewMax?: number;
  overdue: boolean;
  daysLeft?: number;
}
export interface HistoryLoan { title: string; author?: string; callNo?: string; loanDate?: string; returnDate?: string }

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** 「2026-11-20」「2026-11-20 23:59:59」「20261120」都认，返回 YYYY-MM-DD */
export function libDate(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}

function body(r: { status: number; text: string }, what: string): { code?: unknown; msg?: unknown; message?: unknown; data?: unknown } {
  if (r.status === 401 || r.status === 403) throw new FduError('NEED_LOGIN', '图书馆登录已过期。', '运行 `fdu library login`，在打开的图书馆页面里登录一次。', { op: 'library.login' });
  let j: { code?: unknown; msg?: unknown; message?: unknown; data?: unknown };
  try { j = JSON.parse(r.text); } catch { throw new FduError('UPSTREAM', `图书馆系统返回的不是数据（${what}，${r.status}）。`); }
  const code = Number(j.code);
  if (code === 401 || code === 403 || /登录|token|过期|未授权/i.test(String(j.msg ?? j.message ?? '')) && code !== 0 && code !== 200) {
    throw new FduError('NEED_LOGIN', '图书馆登录已过期。', '运行 `fdu library login`，在打开的图书馆页面里登录一次。', { op: 'library.login' });
  }
  if (code !== 0 && code !== 200) throw new FduError('UPSTREAM', `图书馆系统：${String(j.msg ?? j.message ?? code)}`);
  return j;
}

export function parseCurrentLoans(json: unknown, today: string): Loan[] {
  const list = ((json as { data?: { list?: unknown[] } })?.data?.list ?? []) as Record<string, unknown>[];
  return list.map((row) => {
    const info = (row.itemInfo ?? {}) as { item?: Record<string, unknown>; instance?: Record<string, unknown> };
    const item = info.item ?? {};
    const inst = info.instance ?? {};
    const log = (row.loanLog ?? {}) as Record<string, unknown>;
    const policy = (row.circulationLoanPolicy ?? {}) as Record<string, unknown>;
    const dueDate = libDate(log.dueDate) ?? libDate(item.returnTime);
    const daysLeft = dueDate ? Math.round((Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) : undefined;
    return {
      title: str(inst.title) ?? '（未知书名）',
      ...(str(inst.author) ? { author: str(inst.author) } : {}),
      ...(str(inst.callNo ?? item.callNo) ? { callNo: str(inst.callNo ?? item.callNo) } : {}),
      ...(str(inst.ISBN) ? { isbn: str(inst.ISBN) } : {}),
      ...(str(item.permanentLibraryName) ? { library: str(item.permanentLibraryName) } : {}),
      ...(str(item.permanentLocationName ?? item.temporaryLocationName) ? { location: str(item.permanentLocationName ?? item.temporaryLocationName) } : {}),
      loanDate: libDate(log.loanDate) ?? libDate(item.checkoutDate),
      dueDate,
      renewed: num(log.renewalCount) ?? num(item.renewCount) ?? 0,
      ...(num(policy.renewalCount) !== undefined ? { renewMax: num(policy.renewalCount) } : {}),
      overdue: daysLeft !== undefined && daysLeft < 0,
      ...(daysLeft !== undefined ? { daysLeft } : {}),
    };
  }).sort((a, b) => (a.dueDate ?? '9').localeCompare(b.dueDate ?? '9'));
}

export function parseHistory(json: unknown): { total: number; loans: HistoryLoan[] } {
  const d = ((json as { data?: { list?: unknown[]; total?: unknown } })?.data ?? {});
  const list = (d.list ?? []) as Record<string, unknown>[];
  return {
    total: num(d.total) ?? list.length,
    loans: list.map((row) => {
      const inst = (row.catalogueInstance ?? {}) as Record<string, unknown>;
      return {
        title: str(inst.title) ?? '（未知书名）',
        ...(str(inst.author) ? { author: str(inst.author) } : {}),
        ...(str(inst.callNo) ? { callNo: str(inst.callNo) } : {}),
        loanDate: libDate(row.loanDate),
        ...(libDate(row.returnDate) ? { returnDate: libDate(row.returnDate) } : {}),
      };
    }),
  };
}

/** 读者信息里只取和借阅有关的数：还能借几本、逾期几本、欠费、预约数、证件到期日 */
export function parseReader(json: unknown) {
  const d = ((json as { data?: Record<string, unknown> })?.data ?? {});
  return {
    canBorrow: num(d.canLoanTotal),
    overdue: num(d.overdueTotal),
    fees: num(d.fees),
    holds: num(d.currentRequestCount),
    ...(libDate(d.expirationDate) ? { cardExpires: libDate(d.expirationDate) } : {}),
  };
}

export async function readLoans(getJson: GetJson, today: string) {
  const [reader, loans] = await Promise.all([
    getJson(`${LIB_API}/getReaderInfo`).then((r) => parseReader(body(r, '读者信息'))),
    getJson(`${LIB_API}/getReaderCurrentLoan?pageSize=100&pageNo=1`).then((r) => parseCurrentLoans(body(r, '当前借阅'), today)),
  ]);
  return { ...reader, count: loans.length, dueSoon: loans.filter((l) => !l.overdue && (l.daysLeft ?? 99) <= 7).length, loans };
}

export async function readHistory(getJson: GetJson, page: number, size: number) {
  const qs = new URLSearchParams({ time: '', actionType: '', pageSize: String(size), pageNo: String(page) });
  return { page, ...parseHistory(body(await getJson(`${LIB_API}/v2/getReaderHistoryLoan?${qs}`), '历史借阅')) };
}
