# fdu 命令参考

> 由 `npm run docs` 根据代码里的操作表生成，不要手改。

所有命令输出 JSON：成功是 `{"ok":true,"op":...,"data":...}`，失败是 `{"ok":false,"error":{"code","message","hint"}}`。
退出码：0 成功，2 参数错误，3 需要登录或配置（`NEED_LOGIN` / `NEED_HOLE_LOGIN` / `NEED_MAIL_SETUP`），1 其他错误。
MCP 工具名是把命令里的点换成下划线，如 `jw.grades` → `jw_grades`。
简写：`fdu login` / `logout` / `status` / `doctor` / `today` / `week` / `todo`。
只读查询的结果会缓存在本机：加 `--cached` 不联网直接返回上次的结果（带 `cachedAt`）；联网失败时，错误里附上上次的结果 `cached: {at, data}`。

## 汇总

今天 / 这周的课、要交的作业、考试（简写 fdu today、fdu week）

### `fdu overview today`

今天的概况：今天的课（按教学周和放假安排筛好）、3 天内要交还没交的作业、7 天内的考试、过了截止还没交的作业。某一类读不到时其他照常返回，读不到的写在 errors 里。

登录：复旦账号 · 只读 · MCP：`overview_today`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--date` | string |  | 日期 YYYY-MM-DD，默认今天 |

```bash
fdu today
fdu today --date 2026-11-09
```

### `fdu overview week`

这一周（按校历从周日到周六）每天的课、本周要交的作业、本周的考试，以及第几教学周。

登录：复旦账号 · 只读 · MCP：`overview_week`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--date` | string |  | 这一周里的任意一天，默认今天 |

```bash
fdu week
fdu week --date 2026-11-16
```

## 账号与环境

登录复旦统一身份认证、查看登录状态、检查环境（简写 fdu login、fdu status、fdu doctor）

### `fdu auth login`

登录复旦统一身份认证：打开浏览器，你自己输入账号密码、完成二次验证；之后 eLearning、教务、校园卡等共用这个登录。

登录：不用 · 登录 / 退出 · MCP：`auth_login`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--webvpn` | boolean |  | 顺便建立 WebVPN 会话（校外访问树洞需要） |
| `--force` | boolean |  | 丢弃已有登录状态，重新登录 |
| `--url` | string |  | 打开这个页面完成登录或二次验证（如某些页面要求微信扫码），回到这个页面后窗口自动关闭 |

```bash
fdu login
fdu login --webvpn
fdu login --url https://my.fudan.edu.cn/simple_list/stqk
```

### `fdu auth status`

各系统的登录状态（复旦账号、WebVPN、树洞、学生邮箱）。

登录：不用 · 只读 · MCP：`auth_status`

### `fdu auth logout`

删除本机保存的复旦账号登录状态（树洞、邮箱分别用 fdu hole logout、fdu mail forget）。

登录：不用 · 登录 / 退出 · 仅命令行

### `fdu auth doctor`

检查运行环境：Node.js、浏览器、配置目录、能不能连上各个学校系统、各账号的登录状态，每项给出修复建议（结果里没有账号和 Cookie，可以直接发给别人帮忙看）。

登录：不用 · 只读 · MCP：`auth_doctor`

```bash
fdu doctor
```

## eLearning

课程、作业和截止时间、公告、课件下载（简写 fdu todo）

### `fdu elearning courses`

本学期的 eLearning 课程（id、名称、课程代码、教师）。

登录：复旦账号 · 只读 · MCP：`elearning_courses`

### `fdu elearning assignments`

作业列表：截止时间（含上海时间）、是否已提交。不传课程时列出全部课程。

登录：复旦账号 · 只读 · MCP：`elearning_assignments`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--course` | string |  | 课程 id 或名称关键词 |
| `--pending` | boolean |  | 只看还没交的 |

```bash
fdu elearning assignments --course 数据结构
fdu elearning assignments --pending
```

### `fdu elearning todo`

接下来几天要交、还没交的作业（跨全部课程，按截止时间排序），以及已经过了截止时间还没交的。

登录：复旦账号 · 只读 · MCP：`elearning_todo`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--days` | integer |  | 往后看几天，默认 14 |

### `fdu elearning announcements`

课程公告（默认最近 14 天）。

登录：复旦账号 · 只读 · MCP：`elearning_announcements`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--course` | string |  | 课程 id 或名称关键词 |
| `--days` | integer |  | 最近几天，默认 14 |

### `fdu elearning files`

某门课的课件和文件（id、文件名、大小、所在文件夹）。

登录：复旦账号 · 只读 · MCP：`elearning_files`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--course` | string | 是 | 课程 id 或名称关键词 |
| `--search` | string |  | 文件名关键词 |

```bash
fdu elearning files --course 线性代数 --search 第5讲
```

### `fdu elearning download`

下载一个课程文件到本机（默认当前目录；同名文件不覆盖，自动加序号；单个最大 200 MB）。

登录：复旦账号 · 会写本机文件 · MCP：`elearning_download`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--file` | string | 是 | 文件 id（来自 elearning files） |
| `--out` | string |  | 保存到哪个文件夹，默认当前目录 |

## 教务系统

课表、考试、成绩绩点、培养方案、选课结果、全校开课查询、教学大纲、教学周

### `fdu jw semesters`

教务系统里的学期列表（id、名称）和当前学期。

登录：复旦账号 · 只读 · MCP：`jw_semesters`

### `fdu jw week`

某天是第几教学周、星期几、是否放假（按学校校历；校历没覆盖到的学期按教务系统的学期开始日期推算）。

登录：不用 · 只读 · MCP：`jw_week`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--date` | string |  | 日期 YYYY-MM-DD，默认今天 |

### `fdu jw timetable`

课表：每门课的上课时间（星期、节次、起止时间）、地点、教学周、教师。

登录：复旦账号 · 只读 · MCP：`jw_timetable`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--semester` | string |  | 学期 id 或名称关键词，默认当前学期 |
| `--postgraduate` | boolean |  | 研究生课表（读研究生选课系统） |

```bash
fdu jw timetable
fdu jw timetable --semester 2026-2027学年1学期
```

### `fdu jw exams`

考试安排（课程、时间、考场），按时间排序。

登录：复旦账号 · 只读 · MCP：`jw_exams`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--all` | boolean |  | 也列出一个月以前考完的 |

### `fdu jw grades`

已出的成绩（按学期）和按学分加权的绩点（P/NP 不计）。

登录：复旦账号 · 只读 · **隐私数据** · MCP：`jw_grades`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--semester` | string |  | 只看某个学期（id 或名称关键词） |

### `fdu jw gpa`

教务系统里的绩点和本年级本院系排名（只返回你自己的一行和总人数）。

登录：复旦账号 · 只读 · **隐私数据** · MCP：`jw_gpa`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--student-number` | string |  | 学号，用来在排名表里找到你；不传时尝试从 eLearning 读取 |

### `fdu jw program`

培养方案完成情况：各类别要求学分、已获学分、还差多少。

登录：复旦账号 · 只读 · **隐私数据** · MCP：`jw_program`

### `fdu jw lessons`

全校开课查询：按课程名搜某学期开的课（教学班代码、学分、任课老师、上课时间地点、限选和已选人数、考试方式），选课时用。

登录：复旦账号 · 只读 · MCP：`jw_lessons`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--keyword` | string | 是 | 课程名（包含即可），如「数据结构」 |
| `--semester` | string |  | 学期 id 或名称关键词，默认当前学期 |
| `--page` | integer |  | 第几页，默认 1 |
| `--size` | integer |  | 每页几条，默认 20 |
| `--syllabus` | boolean |  | 同时读每个教学班的教学大纲（最多前 5 个，较慢） |

```bash
fdu jw lessons --keyword 数据结构
fdu jw lessons --keyword 线性代数 --semester 2026-2027学年2学期
fdu jw lessons --keyword 数据结构 --syllabus
```

### `fdu jw syllabus`

某个教学班的教学大纲：课程信息、简介、教学目标、每周内容安排、考核方式和权重、教材、教学团队。教学班 id 来自 fdu jw lessons。

登录：复旦账号 · 只读 · MCP：`jw_syllabus`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--lesson` | string | 是 | 教学班 id（fdu jw lessons 结果里的 id） |
| `--max-chars` | integer |  | 最多返回多少字，默认 30000 |

```bash
fdu jw syllabus --lesson 1037803
```

### `fdu jw selected`

选课结果：某学期已选上的课、学分和上课时间。

登录：复旦账号 · 只读 · MCP：`jw_selected`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--which` | string |  | current 当前学期（默认）、next 下学期，或学期名关键词 |

## iCourse 课程回放

找课程、讲次列表、课堂文字稿

### `fdu icourse search`

在 iCourse（课程回放）里按课程名或老师找课程，返回课程号。默认找最新学期。

登录：复旦账号 · 只读 · MCP：`icourse_search`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--keyword` | string | 是 | 课程名或老师名 |
| `--term` | string |  | iCourse 的学期编号（来自 icourse terms），默认最新学期 |
| `--limit` | integer |  | 最多几条，默认 20 |

```bash
fdu icourse search --keyword 数据结构
```

### `fdu icourse terms`

iCourse 上有课程的学期和对应的学期编号（新的在前）。

登录：复旦账号 · 只读 · MCP：`icourse_terms`

### `fdu icourse lectures`

一门课在 iCourse 上的全部讲次：日期、节次、主讲人、有没有回放，按日期排序。

登录：复旦账号 · 只读 · MCP：`icourse_lectures`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--course` | string | 是 | 课程号（来自 icourse search） |
| `--playback` | boolean |  | 只看有回放的 |

```bash
fdu icourse lectures --course 12345 --playback
```

### `fdu icourse transcript`

某一讲的课堂文字稿（平台自动转写，带时间），可以用来总结这节课讲了什么。学校审核期内还没开放的回放会如实说明，不绕过。文字稿较长时分段返回。

登录：复旦账号 · 只读 · MCP：`icourse_transcript`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--course` | string | 是 | 课程号 |
| `--lecture` | string | 是 | 讲次号（来自 icourse lectures 的 lectureId） |
| `--format` | text / segments |  | text 按分钟合成段落（默认）；segments 原始分段（开始、结束秒数） |
| `--offset` | integer |  | 从第几个字开始（分段读取长文字稿用，默认 0） |
| `--max-chars` | integer |  | 最多返回多少字，默认 30000 |

```bash
fdu icourse transcript --course 12345 --lecture 67890
fdu icourse transcript --course 12345 --lecture 67890 --offset 30000
```

## 教室

各教学楼每间教室的安排、空闲时段、现在的状态（经 WebVPN）

### `fdu rooms login`

登录空教室系统（学校多媒体教室的「在线课表」，校外经 WebVPN）：打开窗口，按提示登录，看到课表后窗口自动关闭。

登录：不用 · 登录 / 退出 · 仅命令行

### `fdu rooms free`

空教室：某栋楼某天某几节都空着的教室（按座位从多到少），以及空到什么时候。默认今天、从现在这节起两节。数据来自学校多媒体教室系统的在线课表。

登录：复旦账号 · 只读 · MCP：`rooms_free`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--building` | string | 是 | 教学楼代码，多个用逗号分开：H2、H3、H4、H5、H6、HGX、HQ、JA、JB、F1、F2、Z2（H2 = 二教，HGX = 光华楼） |
| `--date` | string |  | 日期 YYYY-MM-DD，默认今天 |
| `--from` | integer |  | 从第几节（1–14），默认现在这一节 |
| `--to` | integer |  | 到第几节（含），默认 from 的下一节 |
| `--min-seats` | integer |  | 至少多少座位 |

```bash
fdu rooms free --building H2
fdu rooms free --building H3,H4 --date 2026-11-10 --from 6 --to 8
```

### `fdu rooms day`

教室的完整信息（给 AI 判断用）：每栋楼的汇总（按楼层的教室数、座位，查今天时还有现在空着 / 在用几间），每间教室的楼层、座位、全天每段安排（节次、时间、课程代码、课名、老师、人数、临借活动等）、空闲时段；查今天时附上现在的状态（空到几点，或在上什么、到几点）。不指定楼时查全部教学楼（数据较多）。

登录：复旦账号 · 只读 · MCP：`rooms_day`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--building` | string |  | 教学楼代码，多个用逗号分开：H2、H3、H4、H5、H6、HGX、HQ、JA、JB、F1、F2、Z2（H2 = 二教，HGX = 光华楼）；不填查全部 |
| `--date` | string |  | 日期 YYYY-MM-DD，默认今天 |
| `--room` | string |  | 只看某间教室，如 H2101 |
| `--brief` | boolean |  | 简要：不列每节的课程，只给汇总、座位、现在的状态和空闲时段（查很多楼时用） |

```bash
fdu rooms day --building H2
fdu rooms day --building H3,HGX --date 2026-11-10
fdu rooms day --brief
```

## 校园卡

余额、消费记录和统计

### `fdu card balance`

校园卡余额。

登录：复旦账号 · 只读 · MCP：`card_balance`

### `fdu card transactions`

校园卡消费记录（时间、类型、商户、金额；支出为负）和统计：总支出、充值、日均、按商户和餐次。默认最近 7 天。

登录：复旦账号 · 只读 · **隐私数据** · MCP：`card_transactions`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--days` | integer |  | 最近几天（含今天），默认 7 |
| `--from` | string |  | 开始日期 YYYY-MM-DD（和 --days 二选一） |
| `--to` | string |  | 结束日期，默认今天 |
| `--limit` | integer |  | 最多返回几条明细，默认 100（统计按全部记录算） |
| `--merchant` | string |  | 只看商户名包含这个词的，如「食堂」「北区」 |

```bash
fdu card transactions
fdu card transactions --days 30 --limit 0
fdu card transactions --from 2026-10-01 --to 2026-10-31
```

## 图书馆

在馆人数、文献检索、在借的书和借阅历史

### `fdu library seats`

各图书馆在馆人数和还能进多少人（公开接口，不用登录）。

登录：不用 · 只读 · MCP：`library_seats`

### `fdu library login`

登录图书馆「我的借阅」：打开图书馆页面，点「登录」（走统一身份认证，已登录复旦账号时一般不用再输密码），看到借阅信息后窗口会自动关闭。

登录：不用 · 登录 / 退出 · 仅命令行

### `fdu library loans`

图书馆在借的书：书名、作者、索书号、馆藏地、借阅日期、应还日期、还剩几天、续借次数；以及还能借几本、逾期几本、欠费。只看，不续借。

登录：复旦账号 · 只读 · **隐私数据** · MCP：`library_loans`

```bash
fdu library loans
```

### `fdu library history`

图书馆借阅历史（书名、作者、借阅和归还日期），按页读取。

登录：复旦账号 · 只读 · **隐私数据** · MCP：`library_history`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--page` | integer |  | 第几页，默认 1 |
| `--size` | integer |  | 每页几条，默认 20 |

### `fdu library search`

复旦图书馆文献检索（论文、图书；返回标题、作者、年份、摘要、DOI、详情页链接）。

登录：不用 · 只读 · MCP：`library_search`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--query` | string | 是 | 检索词 |
| `--scope` | articles / all / books |  | articles 文章（默认）、books 图书期刊、all 全部 |
| `--field` | all / title / author / subject / fulltext |  |  |
| `--limit` | integer |  | 返回几条，默认 10 |
| `--year-from` | integer |  |  |
| `--year-to` | integer |  |  |
| `--sort` | relevance / newest |  |  |
| `--peer-reviewed-only` | boolean |  | 只看同行评审 |
| `--full-text-only` | boolean |  | 只看有全文的 |

```bash
fdu library search --query "graph neural network molecule" --year-from 2022
```

## 学校通知

教务处、研究生院、各院系官网的通知

### `fdu notices sources`

内置的学校部门和院系官网通知来源（id、名称、网址）。

登录：不用 · 只读 · MCP：`notices_sources`

### `fdu notices list`

某个部门 / 院系官网最新的通知列表（标题、日期、链接）。

登录：不用 · 只读 · MCP：`notices_list`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--source` | string | 是 | 来源 id 或名称，如 jwc、教务处、计算机学院 |
| `--limit` | integer |  | 返回几条，默认 20 |

```bash
fdu notices list --source 教务处
```

### `fdu notices read`

读一条通知的正文、发布日期和附件链接。

登录：不用 · 只读 · MCP：`notices_read`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--url` | string | 是 | 通知链接（来自 notices list） |

## 体育场馆

各场馆每个时段还有哪些场地空着（只看，不预约）

### `fdu venue list`

可以预约的体育场馆（id、名称），如「北区体育馆-羽毛球」。

登录：复旦账号 · 只读 · MCP：`venue_list`

### `fdu venue free`

体育场馆的空闲时段：每个时段还有哪些场地空着（只看，不预约）。场馆可以写 id 或名称关键词（如「北区 羽毛球」）。

登录：复旦账号 · 只读 · MCP：`venue_free`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--venue` | string | 是 | 场馆 id 或名称关键词，多个词用空格分开 |
| `--date` | string |  | 日期 YYYY-MM-DD，默认今天 |
| `--days` | integer |  | 连看几天，默认 1 |
| `--all` | boolean |  | 也列出已经约满的时段 |

```bash
fdu venue free --venue "北区 羽毛球"
fdu venue free --venue 正大 --date 2026-11-10 --days 3
```

## 食堂

各食堂现在的就餐人数

### `fdu canteen crowd`

各食堂现在的就餐人数和容量（ratio = 人数 / 容量）。不在用餐时段时 open 为 false，并附上学校页面的说明。

登录：复旦账号 · 只读 · MCP：`canteen_crowd`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--campus` | string |  | 只看某个校区：邯郸、枫林、江湾、张江 |

```bash
fdu canteen crowd
fdu canteen crowd --campus 邯郸
```

## 校车

校区间校车时刻表

### `fdu bus schedule`

校区间校车时刻表：每班车的出发校区、到达校区和发车时间，按发车时间排序。

登录：复旦账号 · 只读 · MCP：`bus_schedule`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--holiday` | boolean |  | 节假日时刻表（默认工作日） |
| `--from` | string |  | 出发校区：邯郸、江湾、枫林、张江 |
| `--to` | string |  | 到达校区 |

```bash
fdu bus schedule --from 邯郸 --to 江湾
fdu bus schedule --holiday
```

## 宿舍

剩余电量

### `fdu dorm electricity`

宿舍剩余电量（度）。

登录：复旦账号 · 只读 · MCP：`dorm_electricity`

## 树洞

搜索和阅读树洞帖子（需要树洞账号）

### `fdu hole login`

登录树洞（旦挞）账号：密码只用来换取令牌，不保存。校外会自动走 WebVPN（需要先 fdu login）。

登录：不用 · 登录 / 退出 · 仅命令行

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--email` | string | 是 | 树洞账号邮箱，通常是 学号@m.fudan.edu.cn |

### `fdu hole logout`

删除本机保存的树洞令牌。

登录：不用 · 登录 / 退出 · 仅命令行

### `fdu hole search`

在树洞里搜索帖子楼层（匿名同学的个人看法，不是事实）。

登录：树洞账号 · 只读 · MCP：`hole_search`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--keyword` | string | 是 |  |
| `--limit` | integer |  | 返回几条，默认 10 |
| `--days` | integer |  | 只看最近几天 |
| `--accurate` | boolean |  | 精确匹配 |

### `fdu hole read`

读一个树洞帖子（洞号）及其楼层。

登录：树洞账号 · 只读 · MCP：`hole_read`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--id` | integer | 是 | 洞号 |
| `--start` | integer |  | 从第几楼开始 |
| `--length` | integer |  | 读几楼，默认 30 |

### `fdu hole latest`

树洞最新的帖子。

登录：树洞账号 · 只读 · MCP：`hole_latest`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--length` | integer |  | 几条，默认 10 |
| `--tag` | string |  | 标签 |

## 蛋壳课评

课程评价（需要树洞账号）

### `fdu danke search`

在蛋壳课评（danke.fduhole.com，旦挞的课程评价）里搜索课程。

登录：树洞账号 · 只读 · MCP：`danke_search`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--keyword` | string | 是 | 课程名或课程代码 |
| `--limit` | integer |  | 几条，默认 10 |

### `fdu danke reviews`

某门课在蛋壳课评上的评价（评分、作业量、给分、各老师的评价）。

登录：树洞账号 · 只读 · MCP：`danke_reviews`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--id` | integer | 是 | 课程组 id（来自 danke search 的 course_group_id） |
| `--max` | integer |  | 最多几条评价，默认 12 |

## 学生邮箱

收件箱（IMAP 只读，需要客户端专用密码）

### `fdu mail setup`

配置学生邮箱（IMAP，只读）：需要网页邮箱里生成的客户端专用密码；密码以明文保存在本机配置目录（权限 600）。

登录：不用 · 登录 / 退出 · 仅命令行

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--user` | string | 是 | 邮箱地址 |
| `--host` | string |  | IMAP 服务器，默认 imap.exmail.qq.com |
| `--port` | integer |  | 端口，默认 993 |

### `fdu mail forget`

删除本机保存的邮箱配置和密码。

登录：不用 · 登录 / 退出 · 仅命令行

### `fdu mail list`

收件箱里最近的邮件（发件人、主题、时间、摘要）；只读，不改变已读状态。

登录：学生邮箱 · 只读 · **隐私数据** · MCP：`mail_list`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--days` | integer |  | 最近几天，默认 7 |
| `--limit` | integer |  | 最多几封，默认 30 |
| `--query` | string |  | 只看发件人或主题里包含这个词的 |

### `fdu mail read`

读一封邮件的正文（按 uid，来自 mail list）。

登录：学生邮箱 · 只读 · **隐私数据** · MCP：`mail_read`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--uid` | string | 是 |  |
| `--days` | integer |  | 在最近几天里找，默认 30 |

## 日历

把课表、考试、作业截止导出成 .ics

### `fdu calendar export`

把课表、考试和作业截止时间导出成日历文件（.ics），可以导入苹果日历、Outlook、Google 日历。重复导入同一学期会更新已有日程，不会重复添加。

登录：复旦账号 · 会写本机文件 · MCP：`calendar_export`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--out` | string |  | 保存到哪里，默认当前目录的 fudan.ics |
| `--include` | string |  | 导出哪些，逗号分隔：timetable,exams,assignments（默认全部） |
| `--overwrite` | boolean |  | 文件已存在时覆盖（默认另存为新文件名） |
| `--alarms` | boolean |  | 考试和作业截止前一天提醒（默认开） |

```bash
fdu calendar export
fdu calendar export --include timetable,exams --out ~/Desktop/fudan.ics
```

## 缓存

本机缓存的查询结果

### `fdu cache clear`

删除本机缓存的查询结果（退出登录时也会自动删除）。

登录：不用 · 会写本机文件 · 仅命令行

## 开发

录制学校系统页面用到的接口结构（接入新系统时用）

### `fdu dev capture`

开发新功能用：打开浏览器（带着复旦账号登录状态），你在里面操作某个学校系统的页面，关掉窗口后把页面用到的接口结构存成文件——只有地址、参数名、返回的字段名和类型、表格列名，不含姓名、学号、金额等任何具体内容，可以直接发给开发者。

登录：不用 · 会写本机文件 · 仅命令行

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--url` | string | 是 | 从哪个页面开始，如 https://fdjwgl.fudan.edu.cn/student/home |
| `--out` | string |  | 结果保存到哪里，默认当前目录的 fdu-capture-时间.json |
| `--minutes` | integer |  | 最多录多久（分钟），默认 10 |
| `--keep-query` | boolean |  | 保留查询参数的值（如翻页参数的格式；令牌和长数字会遮掉，发出前请自己看一遍） |
| `--html` | string |  | 另外保存地址里包含这段文字的网页的原始 HTML（如 day.asp），IP、令牌、长数字会遮掉 |

```bash
fdu dev capture --url https://fdjwgl.fudan.edu.cn/student/home
```
