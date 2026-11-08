import { describe, expect, it } from 'vitest';
import { NeedLoginError } from '../src/core/fudan-auth';
import type { CampusReader } from '../src/core/types';
import { cardRange, CONSUME_INDEX, CONSUME_QUERY, mealOf, parseConsumePage, parseCsrf, readCardRecords, summarize } from '../src/services/ecard';

/** 校园卡消费记录（页面结构按学校系统，商户和金额都是虚构的） */

const indexPage = '<html><head><meta name="_csrf" content="tok-123"/></head><body>消费查询</body></html>';
/** 一页查询结果：XML 包着 HTML 表格；时间有的合在一格，有的拆成两格 */
const page = (rows: string[], pageNo = 1, pages = 2) => `<?xml version="1.0" encoding="UTF-8"?><ajax-response><response type="object"><![CDATA[
  <table><thead><tr><th>交易时间</th><th>交易类型</th><th>商户</th><th>金额</th></tr></thead>
  <tbody>${rows.join('')}</tbody></table><div class="page"><b>${pageNo}</b>/${pages}页</div>]]></response></ajax-response>`;
const rowA = (date: string, time: string, type: string, merchant: string, amount: string) =>
  `<tr><td><div>${date}</div><div>${time}</div></td><td><span>${type}</span></td><td>${merchant}&nbsp;</td><td>${amount}&nbsp;</td></tr>`;
const rowB = (date: string, time: string, type: string, merchant: string, amount: string) =>
  `<tr><td>${date}</td><td>${time}</td><td>${type}</td><td>${merchant}</td><td>${amount}</td></tr>`;

describe('解析', () => {
  it('两种表格写法；支出为负，充值为正；带符号时以符号为准', () => {
    const r = parseConsumePage(page([
      rowA('2026.11.07', '12:31', '消费', '北区食堂（演示）', '12.50'),
      rowA('2026.11.07', '07:45', '消费', '南区面包房（演示）', '-6.00'),
      rowB('2026.11.06', '18:02', '充值', '支付宝充值', '100.00'),
      rowB('2026.11.06', '21:40', '退款', '超市（演示）', '3.20'),
      '<tr><td>合计</td><td></td><td></td><td></td></tr>',
    ]));
    expect(r.pages).toBe(2);
    expect(r.records).toEqual([
      { time: '2026-11-07T04:31:00.000Z', type: '消费', merchant: '北区食堂（演示）', amount: -12.5 },
      { time: '2026-11-06T23:45:00.000Z', type: '消费', merchant: '南区面包房（演示）', amount: -6 },
      { time: '2026-11-06T10:02:00.000Z', type: '充值', merchant: '支付宝充值', amount: 100 },
      { time: '2026-11-06T13:40:00.000Z', type: '退款', merchant: '超市（演示）', amount: 3.2 },
    ]);
    expect(parseCsrf(indexPage)).toBe('tok-123');
    expect(parseCsrf('<html></html>')).toBeUndefined();
  });

  it('日期范围和餐次（上海时间）', () => {
    const now = Date.parse('2026-11-08T05:00:00Z');
    expect(cardRange(now, {})).toEqual({ from: '2026-11-02', to: '2026-11-08' });
    expect(cardRange(now, { days: 1 })).toEqual({ from: '2026-11-08', to: '2026-11-08' });
    expect(cardRange(now, { from: '2026-10-01', to: '2026-10-31' })).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(() => cardRange(now, { from: '2026-11-09', to: '2026-11-01' })).toThrow('开始日期');
    expect(mealOf('2026-11-06T23:45:00.000Z')).toBe('早餐'); // 07:45
    expect(mealOf('2026-11-07T04:31:00.000Z')).toBe('午餐'); // 12:31
    expect(mealOf('2026-11-07T15:30:00.000Z')).toBe('夜宵'); // 23:30
  });

  it('统计：总支出、充值、日均、按商户和餐次', () => {
    const s = summarize([
      { time: '2026-11-07T04:31:00.000Z', type: '消费', merchant: '北区食堂', amount: -12.5 },
      { time: '2026-11-06T04:10:00.000Z', type: '消费', merchant: '北区食堂', amount: -10 },
      { time: '2026-11-06T23:45:00.000Z', type: '消费', merchant: '面包房', amount: -6 },
      { time: '2026-11-06T10:02:00.000Z', type: '充值', merchant: '支付宝充值', amount: 100 },
    ]);
    expect(s).toMatchObject({ count: 4, spent: 28.5, toppedUp: 100, averagePerDay: 14.25 });
    expect(s.byMerchant[0]).toEqual({ merchant: '北区食堂', spent: 22.5, count: 2 });
    expect(s.byMeal).toEqual([{ meal: '早餐', spent: 6, count: 1 }, { meal: '午餐', spent: 22.5, count: 2 }]);
  });
});

describe('读取', () => {
  const reader = (opts: { csrfAfterRender?: boolean; pages?: Record<number, string>; posts?: string[] } = {}): CampusReader & { rendered: string[] } => {
    let rendered = false;
    const r = {
      rendered: [] as string[],
      getText: async (url: string, init?: { method?: string; body?: string }) => {
        if (url === CONSUME_INDEX) return { url, status: 200, text: opts.csrfAfterRender && !rendered ? '<html>跳转中…</html>' : indexPage };
        if (url === CONSUME_QUERY && init?.method === 'POST') {
          opts.posts?.push(init.body ?? '');
          const pageNo = Number(new URLSearchParams(init.body).get('pageNo'));
          return { url, status: 200, text: opts.pages?.[pageNo] ?? page([], pageNo, 2) };
        }
        throw new NeedLoginError('jwfw');
      },
      render: async (url: string) => { r.rendered.push(url); rendered = true; return indexPage; },
    };
    return r;
  };

  it('带上令牌和日期逐页查询，按时间倒序、去重', async () => {
    const posts: string[] = [];
    const r = await readCardRecords(reader({ posts, pages: {
      1: page([rowA('2026.11.06', '12:00', '消费', '北区食堂', '10.00'), rowA('2026.11.07', '12:31', '消费', '北区食堂', '12.50')]),
      2: page([rowA('2026.11.06', '12:00', '消费', '北区食堂', '10.00'), rowA('2026.11.05', '18:00', '消费', '南区食堂', '15.00')], 2, 2),
    } }), { from: '2026-11-02', to: '2026-11-08' });
    expect(posts).toHaveLength(2);
    const first = new URLSearchParams(posts[0]);
    expect(Object.fromEntries(first)).toMatchObject({ _csrf: 'tok-123', starttime: '2026-11-02', endtime: '2026-11-08', pageNo: '1', aaxmlrequest: 'true' });
    expect(r.records.map((x) => x.time.slice(0, 10))).toEqual(['2026-11-07', '2026-11-06', '2026-11-05']);
    expect(r.truncated).toBe(false);
  });

  it('查询页上没有令牌时先在浏览器里走一遍单点登录', async () => {
    const rd = reader({ csrfAfterRender: true, pages: { 1: page([rowA('2026.11.07', '12:31', '消费', '北区食堂', '12.50')], 1, 1) } });
    const r = await readCardRecords(rd, { from: '2026-11-07', to: '2026-11-07' });
    expect(rd.rendered).toEqual([CONSUME_INDEX]);
    expect(r.records).toHaveLength(1);
  });

  it('被带到统一身份认证时要求登录；页数太多时只读一部分并说明', async () => {
    await expect(readCardRecords({ getText: async () => ({ url: 'https://id.fudan.edu.cn/idp/authCenter/authenticate', status: 200, text: '统一身份认证' }) }, { from: '2026-11-01', to: '2026-11-08' }))
      .rejects.toBeInstanceOf(NeedLoginError);
    const many = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [i + 1, page([rowA(`2026.11.0${i + 1}`, '12:00', '消费', '北区食堂', '10.00')], i + 1, 5)]));
    const r = await readCardRecords(reader({ pages: many }), { from: '2026-11-01', to: '2026-11-08' }, { maxPages: 3 });
    expect(r.records).toHaveLength(3);
    expect(r.truncated).toBe(true);
  });
});
