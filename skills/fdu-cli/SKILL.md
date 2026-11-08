---
name: fdu-cli
description: 查询复旦大学校园服务：eLearning 课程 / 作业 / DDL / 公告 / 课件下载，iCourse 课程回放和课堂文字稿，教务系统课表 / 考试 / 成绩 / 绩点排名 / 培养方案 / 选课结果，校园卡余额和消费记录，体育场馆空闲时段，食堂人数，校车时刻表，空教室，宿舍电量，图书馆人数和文献检索，学校和院系官网通知，树洞和蛋壳课评，学生邮箱。用户问到自己在复旦的课程、作业、考试、成绩、校园生活，或要下载课件、找通知、找文献时使用。
---

# 复旦校园服务（fdu-cli）

用 `fdu` 命令行（或同名 MCP 服务的工具）读取用户本人在复旦各系统里的数据。所有操作对学校系统**只读**：不能提交作业、选课、发帖、发邮件。

## 怎么调用

- 配置了 MCP 服务 `fudan` 时，直接用它的工具（`elearning_todo`、`jw_timetable` 等，命令里的点换成下划线）。
- 否则在终端运行 `fdu <服务> <操作> --参数 值 --compact`，读 stdout 里的 JSON：
  - 成功：`{"ok":true,"data":...}`
  - 失败：`{"ok":false,"error":{"code":"...","message":"...","hint":"..."}}`，照 `hint` 处理。
- 不确定参数时先 `fdu describe <服务.操作>`（JSON）；全部命令见同目录的 [reference.md](reference.md)，或运行 `fdu services`。用户问怎么用这个工具时，可以让他运行 `fdu help`。

## 登录

- 出问题先看 `fdu doctor`（环境、网络、各账号登录状态，每项带修复建议），或者只看登录状态 `fdu status`。需要登录时，命令会**自动在用户电脑上打开浏览器**（统一身份认证、二次验证如微信扫码、教室系统、图书馆、WebVPN 都是），用户完成后自动重试，调用会多等一会儿，这是正常的。告诉用户「请在弹出的窗口里登录 / 扫码」即可。还是返回 `NEED_LOGIN`（用户不在、或关了自动弹窗）时，请**用户自己**在终端运行提示里的命令（`fdu login`，或 `fdu login --url <页面>`）。不要替用户输入、索要或记录密码。
  - 用户同意时你也可以运行 `fdu login` 帮他打开浏览器，但它会等待用户在浏览器里操作（最长 5 分钟）。
- 树洞 / 蛋壳课评：`NEED_HOLE_LOGIN` 时请用户在终端运行 `fdu hole login --email 学号@m.fudan.edu.cn`（要在终端里输入密码，只能用户自己运行）。校外访问需要先 `fdu login --webvpn`。
- 学生邮箱：`NEED_MAIL_SETUP` 时请用户运行 `fdu mail setup --user 邮箱地址`，输入网页邮箱里生成的客户端专用密码。
- 公开数据（图书馆人数、文献检索、学校通知）不用登录。

## 隐私

- `jw.grades`、`jw.gpa`、`jw.program`、`card.transactions`、`library.loans`、`library.history`、`mail.list`、`mail.read` 返回隐私数据（消费记录能看出用户的行踪和习惯）：只用来回答用户本人的问题。**不要**写进代码仓库、提交信息、日志、issue / PR，也不要贴到别的服务里。
- 不要把 `~/.config/fdu-cli/`（Windows：`%APPDATA%\fdu-cli\`）里的文件读出来、复制或提交，那是登录凭证。
- 树洞内容是匿名同学的个人看法：引用时说明来源和洞号，综合多条再下结论，不当作事实。

## 时间

返回里的时间是 ISO（UTC，末尾 Z）。给用户看时用同时返回的 `*Shanghai` 字段，或者自己加 8 小时换算成北京时间。

## 常用做法

| 用户想要 | 命令 |
|---|---|
| 今天有什么（课、快到期的作业、考试） | `fdu today`（某天：`--date 2026-11-09`） |
| 这周的安排 | `fdu week`（校历一周从周日开始） |
| 现在第几教学周 | `fdu jw week` |
| 这周有什么 DDL | `fdu todo --days 7`（= `fdu elearning todo`） |
| 把课表放进日历 | `fdu calendar export --out ~/Desktop/fudan.ics`，再让用户导入日历软件 |
| 某门课的作业 | `fdu elearning assignments --course 数据结构` |
| 今天 / 这周的课 | `fdu jw timetable`，按 `weekday`（1 = 周一）和教学周 `weeks` 筛选 |
| 考试安排 | `fdu jw exams` |
| 成绩、绩点、排名 | `fdu jw grades`、`fdu jw gpa` |
| 还差多少学分 | `fdu jw program` |
| 下学期选了什么课 | `fdu jw selected --which next` |
| 下载课件 | 先 `fdu elearning files --course 线性代数 --search 第5讲`，再 `fdu elearning download --file <id> --out ./slides`（不覆盖已有文件） |
| 课程公告 | `fdu elearning announcements --days 7` |
| 总结某节课讲了什么 | `fdu icourse search --keyword 数据结构` → `fdu icourse lectures --course <课程号> --playback` → `fdu icourse transcript --course <课程号> --lecture <讲次号>`；文字稿长时按 `nextOffset` 接着读 |
| 教务处 / 院系通知 | `fdu notices list --source 教务处`，细节 `fdu notices read --url <链接>` |
| 借的书什么时候到期 | `fdu library loans`（没登录图书馆时请用户在终端运行 `fdu library login`）；不能续借，续借请用户自己去图书馆网站 |
| 选课：某门课谁开、几点、还有名额吗、讲什么怎么考 | `fdu jw lessons --keyword 数据结构`（下学期加 `--semester`）；教学大纲用结果里的 id：`fdu jw syllabus --lesson <id>`，或者 `--syllabus` 一起读前 5 个；再结合 `fdu danke reviews` 的评价给建议 |
| 找论文 | `fdu library search --query "..." --year-from 2022`，只依据摘要总结，给出 DOI 或链接 |
| 哪个图书馆人少 | `fdu library seats` |
| 找教室自习 / 哪间教室合适 / 某间教室今天的安排 | `fdu rooms day --building H2`（H2 二教、HGX 光华楼……）：每间教室的楼层、座位、现在的状态、全天安排和空闲时段，按用户的需求（离哪近、要多大、要待到几点、避开下课人流）自己挑；全校先用 `fdu rooms day --brief` 看大概。只要空教室名单也可以用 `fdu rooms free`。需要登录时请用户运行 `fdu rooms login` |
| 去哪吃饭 / 食堂人多吗 | `fdu canteen crowd --campus 邯郸`（只有用餐时段有数据，open 为 false 时照实告诉用户） |
| 下一班校车几点 | `fdu bus schedule --from 邯郸 --to 江湾`（节假日加 `--holiday`），按 departAt 结合当前时间挑出最近的几班 |
| 去哪打球 / 场馆还有空吗 | `fdu venue free --venue "北区 羽毛球" --days 3`（只能看，预约要用户自己去 booking.fudan.edu.cn） |
| 校园卡 / 电费 | `fdu card balance`、`fdu dorm electricity` |
| 这个月吃饭花了多少 | `fdu card transactions --from 2026-11-01 --limit 0`（只要统计，不要明细） |
| 课程口碑 | `fdu danke search --keyword 数据结构` → `fdu danke reviews --id <course_group_id>` |
| 树洞里怎么说 | `fdu hole search --keyword 食堂` → `fdu hole read --id <洞号>` |
| 最近的邮件 | `fdu mail list --days 3`，正文 `fdu mail read --uid <uid>` |

## 缓存

只读查询的结果会缓存在本机。网络不通或只想看上次的数据时加 `--cached`（返回里有 `cachedAt`，告诉用户是什么时候的数据）。联网失败时错误里如果带了 `cached: {at, data}`，可以先用这份数据回答，同时说明它是哪个时间的、以及怎么恢复（通常是 `fdu login`）。

## 出错时

- `NEED_LOGIN` / `NEED_HOLE_LOGIN` / `NEED_MAIL_SETUP`：按上面的「登录」处理，然后重试一次。
- `today` / `week` 某一类数据读不到时，结果里的 `errors` 写了是哪一类、为什么，其余照常返回。
- `UPSTREAM`：学校系统出错或网络问题。部分院系网站、树洞只允许校园网访问，校外请用户连学校 VPN 或 `fdu login --webvpn`。
- iCourse 回放「还没开放」是学校的审核期，告诉用户过一两天再看，不要尝试别的办法拿视频。文字稿是自动转写的，可能有错字，总结时以内容为主，不逐字引用。
- `FORMAT_CHANGED`：学校页面改版了，告诉用户，别反复重试。
- `NO_BROWSER`：用户需要安装 Chrome / Edge，或设置 `FDU_BROWSER`。
