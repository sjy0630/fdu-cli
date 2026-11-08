/** 各服务的名称和简介（帮助、命令参考共用；顺序就是帮助里的顺序） */
export const GROUPS: { id: string; name: string; desc: string }[] = [
  { id: 'overview', name: '汇总', desc: '今天 / 这周的课、要交的作业、考试（简写 fdu today、fdu week）' },
  { id: 'auth', name: '账号与环境', desc: '登录复旦统一身份认证、查看登录状态、检查环境（简写 fdu login、fdu status、fdu doctor）' },
  { id: 'elearning', name: 'eLearning', desc: '课程、作业和截止时间、公告、课件下载（简写 fdu todo）' },
  { id: 'jw', name: '教务系统', desc: '课表、考试、成绩绩点、培养方案、选课结果、全校开课查询、教学大纲、教学周' },
  { id: 'icourse', name: 'iCourse 课程回放', desc: '找课程、讲次列表、课堂文字稿' },
  { id: 'rooms', name: '教室', desc: '各教学楼每间教室的安排、空闲时段、现在的状态（经 WebVPN）' },
  { id: 'card', name: '校园卡', desc: '余额、消费记录和统计' },
  { id: 'library', name: '图书馆', desc: '在馆人数、文献检索、在借的书和借阅历史' },
  { id: 'notices', name: '学校通知', desc: '教务处、研究生院、各院系官网的通知' },
  { id: 'venue', name: '体育场馆', desc: '各场馆每个时段还有哪些场地空着（只看，不预约）' },
  { id: 'dorm', name: '宿舍', desc: '剩余电量' },
  { id: 'hole', name: '树洞', desc: '搜索和阅读树洞帖子（需要树洞账号）' },
  { id: 'danke', name: '蛋壳课评', desc: '课程评价（需要树洞账号）' },
  { id: 'mail', name: '学生邮箱', desc: '收件箱（IMAP 只读，需要客户端专用密码）' },
  { id: 'calendar', name: '日历', desc: '把课表、考试、作业截止导出成 .ics' },
  { id: 'cache', name: '缓存', desc: '本机缓存的查询结果' },
  { id: 'dev', name: '开发', desc: '录制学校系统页面用到的接口结构（接入新系统时用）' },
];

export const groupOf = (id: string) => GROUPS.find((g) => g.id === id);
