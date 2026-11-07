# fdu 命令参考

> 由 `npm run docs` 根据代码里的操作表生成，不要手改。

所有命令输出 JSON：成功是 `{"ok":true,"op":...,"data":...}`，失败是 `{"ok":false,"error":{"code","message","hint"}}`。
退出码：0 成功，2 参数错误，3 需要登录或配置（`NEED_LOGIN` / `NEED_HOLE_LOGIN` / `NEED_MAIL_SETUP`），1 其他错误。
MCP 工具名是把命令里的点换成下划线，如 `jw.grades` → `jw_grades`。

## 账号

### `fdu auth login`

登录复旦统一身份认证：打开浏览器，你自己输入账号密码、完成二次验证；之后 eLearning、教务、校园卡等共用这个登录。

登录：不用 · 登录 / 退出 · MCP：`auth_login`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--webvpn` | boolean |  | 顺便建立 WebVPN 会话（校外访问树洞需要） |
| `--force` | boolean |  | 丢弃已有登录状态，重新登录 |

```bash
fdu login
fdu login --webvpn
```

### `fdu auth status`

各系统的登录状态（复旦账号、WebVPN、树洞、学生邮箱）。

登录：不用 · 只读 · MCP：`auth_status`

### `fdu auth logout`

删除本机保存的复旦账号登录状态（树洞、邮箱分别用 fdu hole logout、fdu mail forget）。

登录：不用 · 登录 / 退出 · 仅命令行

## eLearning

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

### `fdu jw semesters`

教务系统里的学期列表（id、名称）和当前学期。

登录：复旦账号 · 只读 · MCP：`jw_semesters`

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

### `fdu jw selected`

选课结果：某学期已选上的课、学分和上课时间。

登录：复旦账号 · 只读 · MCP：`jw_selected`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--which` | string |  | current 当前学期（默认）、next 下学期，或学期名关键词 |

## 校园卡

### `fdu card balance`

校园卡余额。

登录：复旦账号 · 只读 · MCP：`card_balance`

## 宿舍

### `fdu dorm electricity`

宿舍剩余电量（度）。

登录：复旦账号 · 只读 · MCP：`dorm_electricity`

## 图书馆

### `fdu library seats`

各图书馆在馆人数和还能进多少人（公开接口，不用登录）。

登录：不用 · 只读 · MCP：`library_seats`

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

## 树洞

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

## 旦克（课程评价）

### `fdu danke search`

旦克（课程评价）里搜索课程。

登录：树洞账号 · 只读 · MCP：`danke_search`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--keyword` | string | 是 | 课程名或课程代码 |
| `--limit` | integer |  | 几条，默认 10 |

### `fdu danke reviews`

某门课在旦克上的评价（评分、作业量、给分、各老师的评价）。

登录：树洞账号 · 只读 · MCP：`danke_reviews`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `--id` | integer | 是 | 课程组 id（来自 danke search 的 course_group_id） |
| `--max` | integer |  | 最多几条评价，默认 12 |

## 学生邮箱

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
