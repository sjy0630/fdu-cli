import { describe, expect, it } from 'vitest';
import { findDate, parseNoticeDetail, parseNoticeList } from '../src/services/notice-parse';

/** 下面的页面是按复旦各网站真实结构写的小样例，内容虚构 */

describe('通知列表：各网站的写法', () => {
  it('建站系统常见列表：标题链接 + 日期 span', () => {
    const html = `<ul class="news_list"><li class="news"><span class="news_title"><a href="/2f/57/c1a1/page.htm" title="关于期中退课的通知">关于期中退课的通知</a></span><span class="news_meta">2026-10-27</span></li>
      <li class="news"><span class="news_title"><a href="/2f/58/c1a2/page.htm" title="寒假项目申请通知（2026/11/06更新）">寒假项目申请通知（2026/11/06更新）</a></span><span class="news_meta">2026-10-23</span></li></ul>
      <div class="nav"><li><a href="/">首页</a><a href="/about">概况</a></li></div>`;
    expect(parseNoticeList(html, 'https://jwc.fudan.edu.cn/9397/list.htm')).toEqual([
      { url: 'https://jwc.fudan.edu.cn/2f/57/c1a1/page.htm', title: '关于期中退课的通知', date: '2026-10-27' },
      { url: 'https://jwc.fudan.edu.cn/2f/58/c1a2/page.htm', title: '寒假项目申请通知（2026/11/06更新）', date: '2026-10-23' },
    ]);
  });

  it('日和年月拆在两个元素里', () => {
    const html = `<li class="news n2 clearfix"><div class="news_date"><div class="news_days">12</div><div class="news_year">2026.10</div></div><div class="news_title"><a href='/1d/82/c2a3/page.htm' title='推免生招生选拔工作通知'>推免生招生选拔工作通知</a></div></li>`;
    expect(parseNoticeList(html, 'https://ai.fudan.edu.cn/24257/list.htm')[0]).toMatchObject({ title: '推免生招生选拔工作通知', date: '2026-10-12' });
  });

  it('整行都在链接里，日期也在链接里', () => {
    const html = `<ul class="data-list2"><li><a href="/Data/View/7067"><div class="data-date"><span>24</span><p>2026-09</p></div><div class="data-tt"><p>推免研究生第二轮报名通知</p></div></a></li></ul>`;
    expect(parseNoticeList(html, 'https://fit.fudan.edu.cn/Data/List/event')[0]).toEqual({ url: 'https://fit.fudan.edu.cn/Data/View/7067', title: '推免研究生第二轮报名通知', date: '2026-09-24' });
  });

  it('链接里有日期、标题和摘要，摘要里的年份不干扰', () => {
    const html = `<li><a href="../info/1404/22452.htm" title="青年学术奖开放申请"><span>2026-09-30</span><h3>青年学术奖开放申请</h3><p>2025年5月，校友捐赠设立基金，现启动申请……</p></a></li>`;
    expect(parseNoticeList(html, 'https://history.fudan.edu.cn/xwzx/tzgg.htm')[0]).toEqual({ url: 'https://history.fudan.edu.cn/info/1404/22452.htm', title: '青年学术奖开放申请', date: '2026-09-30' });
  });

  it('表格行；附件和外站链接不算通知', () => {
    const html = `<table><tr><td><a href="/info/1.htm">关于奖学金评选的通知</a></td><td>2026年11月5日</td></tr>
      <tr><td><a href="/files/a.pdf">附件下载说明文件</a></td><td>2026-11-05</td></tr>
      <tr><td><a href="https://example.com/x">外站链接的一条新闻</a></td><td>2026-11-05</td></tr></table>`;
    expect(parseNoticeList(html, 'https://econ.fudan.edu.cn/list.htm')).toEqual([{ url: 'https://econ.fudan.edu.cn/info/1.htm', title: '关于奖学金评选的通知', date: '2026-11-05' }]);
  });

  it('日期识别', () => {
    expect(findDate('2026-1-5')).toBe('2026-01-05');
    expect(findDate('2026年11月5日')).toBe('2026-11-05');
    expect(findDate('2026-02-30')).toBeUndefined();
    expect(findDate('2026-11-05 至 2026-11-08')).toBeNull();
    expect(findDate('05 2026-11')).toBe('2026-11-05');
  });
});

describe('通知详情', () => {
  it('正文、发布日期、PDF 附件', () => {
    const d = parseNoticeDetail(`<html><head><title>某某通知-复旦大学</title></head><body><header><a href="/">首页</a></header>
      <h1 class="arti_title">推免生招生选拔工作通知</h1><p class="arti_metas">作者：发布时间：2026-10-08</p>
      <div class="wp_articlecontent"><p><div pdfsrc="/_upload/x/notice.pdf" sudyfile-attr="{'title':'推免通知.pdf'}" class="wp_pdf_player"></div></p></div></body></html>`, 'https://ai.fudan.edu.cn/1a/fa/c1/page.htm');
    expect(d).toMatchObject({ title: '推免生招生选拔工作通知', date: '2026-10-08', attachments: [{ name: '推免通知.pdf', url: 'https://ai.fudan.edu.cn/_upload/x/notice.pdf' }] });
  });

  it('「发布日期：」写在正文外', () => {
    const d = parseNoticeDetail(`<div class="art-tit"><h3>青年学术奖开放申请</h3><p><span>发布日期：2026-09-30</span></p></div><div id="vsb_content"><div class="v_news_content"><p>现启动本年度青年学术奖的申请和评选工作，欢迎符合条件的老师申请。</p></div></div>`, 'https://history.fudan.edu.cn/info/1404/22452.htm');
    expect(d.title).toBe('青年学术奖开放申请');
    expect(d.date).toBe('2026-09-30');
    expect(d.text).toContain('启动本年度');
  });
});

