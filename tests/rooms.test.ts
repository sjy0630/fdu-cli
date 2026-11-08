import { describe, expect, it } from 'vitest';
import { blocks, dayPageUrl, floorOf, freeRooms, nowStatus, parseDayPage, periodAt, periodSpan, roomsDay, roomsReport } from '../src/services/rooms';

/** 空教室：页面结构按学校多媒体教室系统的「在线课表」，课程、老师、活动都是虚构的 */

const head = (no: number, start: string, end: string) =>
  `<td id="td${String(no).padStart(3, '0')}" align="center">第${no}节<br><table><tr><td>${start}<td>-<td>${end}</table></td>`;
const header = `<tr><td>教室</td><td>座</td>${head(1, '8:00', '8:45')}${head(2, '8:55', '9:40')}${head(3, '9:55', '10:40')}${head(4, '10:50', '11:35')}</tr>`;
const course = (code: string, name: string, teacher: string, n: number, tags = ['本', '理学']) =>
  `<td style="background-color:#d2ead2;">${tags.map((t) => `<span class=tag><span class='rare'>${t}</span></span>`).join('')}${code}<br>[${name}](${teacher}){${n}人}<!--200人--><br></td>`;
const empty = '<td style="background-color:white;color:black;"></td>';
const row = (id: number, room: string, cap: number, cells: string[]) =>
  `<tr><td id="r${id}"><div><table><tr><td><a id="rt${id}" href="room2.asp?id=${id}">${room}</a></td></tr></table></div><img src="green.png"></td>
   <td><span id="cap${id}">${cap}</span></td>${cells.join('\n')}</tr>`;
const page = `<html><head><title>在线课表</title></head><body>
  <input type="text" id="datetime" value="2026/11/6" style="display:none"/>
  <span title="第9教学周">9</span>
  <table id="statusTable_1">${header}</table>
  <table>${header}
    ${row(1, 'H2101', 234, [empty, empty, course('MATH10026.09', '微积分A（演示）', '王老师', 146), course('MATH10026.09', '微积分A（演示）', '王老师', 146)])}
    ${row(2, 'H2102A', 30, [course('GEEF20011.04', '英语写作（演示）', '李老师', 24, ['本', '通识']), empty, empty, empty])}
    ${row(3, 'H2103', 60, [empty, empty, empty, empty])}
    ${row(4, 'H2104', 32, [empty, '<td><span class=tag><span>临借</span></span>某学院团校课程（演示）</td>', empty, '<td>不开放自修</td>'])}
  </table></body></html>`;

describe('在线课表解析', () => {
  const p = parseDayPage(page);

  it('日期、教学周、节次（表头出现两次也只算一遍）、每间教室的座位', () => {
    expect(p.date).toBe('2026-11-06');
    expect(p.week).toBe(9);
    expect(p.periods).toEqual([
      { no: 1, start: '08:00', end: '08:45' }, { no: 2, start: '08:55', end: '09:40' },
      { no: 3, start: '09:55', end: '10:40' }, { no: 4, start: '10:50', end: '11:35' },
    ]);
    expect(p.rooms.map((r) => [r.room, r.capacity])).toEqual([['H2101', 234], ['H2102A', 30], ['H2103', 60], ['H2104', 32]]);
  });

  it('课程、临借和其他标注；连续的同一安排合成一块', () => {
    expect(blocks(p.rooms[0])).toEqual([{ from: 3, to: 4, occupant: expect.objectContaining({ kind: 'course', code: 'MATH10026.09', name: '微积分A（演示）', teacher: '王老师', people: 146, tags: ['本', '理学'] }) }]);
    expect(p.rooms[3].periods[1]).toMatchObject({ kind: 'borrow', name: '某学院团校课程（演示）', tags: ['临借'] });
    expect(p.rooms[3].periods[3]).toMatchObject({ kind: 'other', text: '不开放自修' });
  });

  it('某几节都空着的教室：按座位从多到少，说明空到什么时候', () => {
    expect(freeRooms(p, 1, 2)).toEqual([
      { room: 'H2101', capacity: 234, freeUntil: '第 3 节（09:55）前' },
      { room: 'H2103', capacity: 60, freeUntil: '今天之后都空着' },
    ]);
    expect(freeRooms(p, 3, 4).map((r) => r.room)).toEqual(['H2103', 'H2102A']);
    expect(freeRooms(p, 1, 4, { minCapacity: 50 }).map((r) => r.room)).toEqual(['H2103']);
  });

  it('当前时间在第几节；时间段；页面地址（日期不补零，经 WebVPN）', () => {
    expect(periodAt(p.periods, '08:30')).toBe(1);
    expect(periodAt(p.periods, '08:50')).toBe(2); // 课间算下一节
    expect(periodAt(p.periods, '12:00')).toBeUndefined();
    expect(periodSpan(p.periods, 2, 3)).toBe('08:55-10:40');
    expect(roomsDay('2026-11-06')).toBe('2026-11-6');
    expect(dayPageUrl('H2', '2026-11-06', { webvpn: false })).toBe('http://10.64.130.6/day.asp?b=H2&c=&p=&day=2026-11-6');
    expect(dayPageUrl('H2', '2026-11-06')).toMatch(/^https:\/\/webvpn\.fudan\.edu\.cn\/http\/[0-9a-f]+\/day\.asp\?b=H2/);
  });

  it('被带到登录页时要求登录；格式变了时说明', () => {
    expect(() => parseDayPage('<html><title>统一身份认证</title>authCenter</html>')).toThrow(expect.objectContaining({ code: 'NEED_LOGIN' }));
    expect(() => parseDayPage('<html><body>别的页面</body></html>')).toThrow(expect.objectContaining({ code: 'FORMAT_CHANGED' }));
  });
});

describe('给 AI 的完整报告', () => {
  const p = parseDayPage(page);

  it('楼层；现在的状态：在用（在做什么、到几点）/ 空着（空到几点）/ 下课了', () => {
    expect(floorOf('H2', 'H2101')).toBe(1);
    expect(floorOf('HGX', 'HGX508')).toBe(5);
    expect(nowStatus(p, p.rooms[0], '10:00')).toEqual({ status: 'busy', what: 'MATH10026.09 微积分A（演示）', until: '11:35' });
    expect(nowStatus(p, p.rooms[0], '08:30')).toEqual({ status: 'free', until: '09:55' });
    expect(nowStatus(p, p.rooms[2], '09:00')).toEqual({ status: 'free', until: '今天结束' });
    expect(nowStatus(p, p.rooms[0], '12:00')).toEqual({ status: 'closed' });
    // 课间：按下一节算
    expect(nowStatus(p, p.rooms[0], '09:45')).toEqual({ status: 'free', until: '09:55' });
  });

  it('每间教室的全部安排和空闲时段，按楼层汇总', () => {
    const r = roomsReport('H2', p, { nowHm: '10:00' });
    expect(r).toMatchObject({ building: 'H2', date: '2026-11-06', week: 9 });
    expect(r.summary).toEqual({ rooms: 4, seats: 356, freeNow: 3, busyNow: 1, floors: [{ floor: 1, rooms: 4, seats: 356, freeNow: 3, busyNow: 1 }] });
    expect(r.rooms[0]).toEqual({
      room: 'H2101', floor: 1, seats: 234, now: { status: 'busy', what: 'MATH10026.09 微积分A（演示）', until: '11:35' },
      schedule: [{ periods: '3-4', time: '09:55-11:35', kind: 'course', code: 'MATH10026.09', name: '微积分A（演示）', teacher: '王老师', people: 146, tags: ['本', '理学'] }],
      free: ['第1–2节 08:00-09:40'],
    });
    expect(r.rooms[3].schedule).toEqual([
      { periods: '2-2', time: '08:55-09:40', kind: 'borrow', name: '某学院团校课程（演示）', tags: ['临借'] },
      { periods: '4-4', time: '10:50-11:35', kind: 'other', note: '不开放自修' },
    ]);
    expect(r.rooms[3].free).toEqual(['第1节 08:00-08:45', '第3节 09:55-10:40']);
    // 不是今天：没有「现在」
    expect(roomsReport('H2', p).rooms[0]).not.toHaveProperty('now');
    expect(roomsReport('H2', p, { room: 'h2103' }).rooms.map((x) => x.room)).toEqual(['H2103']);
  });
});
