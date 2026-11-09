# fdu-cli（`fdu`）

[![GitHub stars](https://img.shields.io/github/stars/sjy0630/fdu-cli?style=flat&logo=github)](https://github.com/sjy0630/fdu-cli/stargazers)
[![npm version](https://img.shields.io/npm/v/fdu-cli?logo=npm)](https://www.npmjs.com/package/fdu-cli)
[![npm downloads](https://img.shields.io/npm/dm/fdu-cli)](https://www.npmjs.com/package/fdu-cli)
[![CI](https://github.com/sjy0630/fdu-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/sjy0630/fdu-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

复旦校园服务的命令行和 MCP 服务，给 **Claude Code、Codex** 等 AI 助理用：让它直接查你的课表、作业 DDL、考试、成绩，找空教室、看课程回放文字稿、读教学大纲，查图书馆借阅和校园卡消费，然后替你安排和提建议。

所有命令输出 JSON，对学校系统**全部只读**：不提交作业、不选课、不预约、不续借、不发帖、不发邮件。

## 一分钟上手

需要 Node.js 20 或更新版本，以及 Chrome 或 Edge 浏览器（登录和部分页面要用）。

```bash
npm install -g fdu-cli
```

```bash
fdu doctor        # 检查环境、网络和登录状态
fdu login         # 打开浏览器，在学校的登录页里登录（一次即可）
fdu today         # 今天的课、快到期的作业、考试
fdu help          # 全部命令
```

以后更新也是这条命令（或 `npm update -g fdu-cli`）。连不上 npm 时，可以装 GitHub 发布页上的安装包：`npm install -g https://github.com/sjy0630/fdu-cli/releases/latest/download/fdu-cli.tgz`。

想从源码安装（或者跟着最新代码）：

```bash
git clone https://github.com/sjy0630/fdu-cli.git ~/fdu-cli
cd ~/fdu-cli && npm install && npm install -g .
```

以后更新：`cd ~/fdu-cli && git pull && npm install`。

> 不要用 `npm install -g github:sjy0630/fdu-cli`：npm 从 Git 地址全局安装时会把命令指向一个装完就删掉的临时目录，装不上。

## 接入 AI 助理

**Claude Code**（插件：技能 + MCP 服务一起装，需要先装好 `fdu`）：

```text
/plugin marketplace add sjy0630/fdu-cli
/plugin install fdu-cli@fdu-cli
```

只接 MCP 服务：`claude mcp add --scope user fudan -- fdu mcp`；只装技能：把 `skills/fdu-cli` 复制到 `~/.claude/skills/`。

**Codex**：在 `~/.codex/config.toml` 里加上

```toml
[mcp_servers.fudan]
command = "fdu"
args = ["mcp"]
```

技能：把 `skills/fdu-cli` 复制到 `~/.codex/skills/`。

其他支持 MCP 的客户端（Cursor、Cline、Claude Desktop 等）同理：命令 `fdu`，参数 `mcp`，stdio 方式。

接好以后直接问：「这周有哪些 DDL」「帮我找个下午能自习到六点的教室」「数据结构这门课怎么考、口碑怎么样」「把上周三那节课的回放总结一下」「我借的书哪本快到期了」。

## 能做什么

| 服务 | 命令 | 内容 | 需要 |
|---|---|---|---|
| 汇总 | `fdu today`、`fdu week` | 当天 / 当周的课（按教学周和放假安排筛好）、要交的作业、考试 | 复旦账号 |
| eLearning | `fdu elearning courses / assignments / announcements / files / download`、`fdu todo` | 课程、作业和截止时间、公告、课件列表和下载 | 复旦账号 |
| 教务系统 | `fdu jw timetable / exams / grades / gpa / program / selected / semesters / week` | 课表（含研究生）、考试、成绩绩点和排名、培养方案完成情况、选课结果、教学周 | 复旦账号 |
| 选课参考 | `fdu jw lessons`、`fdu jw syllabus` | 全校开课查询（老师、时间地点、名额）；教学大纲（每周内容、考核方式和权重、教材、教学团队） | 复旦账号 |
| 课程回放 | `fdu icourse search / lectures / transcript / terms` | iCourse 讲次和课堂文字稿（自动转写，带时间） | 复旦账号 |
| 教室 | `fdu rooms day`、`fdu rooms free` | 各教学楼每间教室的座位、现在的状态、全天的课和临时借用、空闲时段 | 复旦账号 + `fdu rooms login` |
| 校园卡 | `fdu card balance / transactions` | 余额；消费记录和统计（总支出、日均、按商户和餐次） | 复旦账号 |
| 图书馆 | `fdu library seats / search` | 各馆在馆人数；文献检索 | 不用 |
| 图书馆借阅 | `fdu library loans / history` | 在借的书、应还日期、还剩几天、借阅历史 | 复旦账号 + `fdu library login` |
| 学校通知 | `fdu notices sources / list / read` | 教务处、研究生院、各院系官网的通知 | 不用 |
| 体育场馆 | `fdu venue list / free` | 各场馆每个时段还有哪些场地空着 | 复旦账号 |
| 食堂 | `fdu canteen crowd` | 各食堂现在的就餐人数和容量 | 复旦账号 |
| 校车 | `fdu bus schedule` | 校区间校车时刻表（工作日 / 节假日） | 复旦账号 |
| 宿舍 | `fdu dorm electricity` | 剩余电量 | 复旦账号 |
| 树洞、蛋壳课评 | `fdu hole search / read / latest`、`fdu danke search / reviews` | 树洞（旦挞茶楼）帖子；蛋壳课评（danke.fduhole.com）的课程评分和评价 | 树洞账号 |
| 学生邮箱 | `fdu mail list / read` | 收件箱（只读，不改已读状态） | 客户端专用密码 |
| 日历 | `fdu calendar export` | 课表、考试、作业截止导出成 .ics，导入苹果日历 / Outlook / Google 日历 | 复旦账号 |

每个命令的参数和示例：`fdu help <服务>`、`fdu help <服务> <命令>`，或者看 [命令参考](skills/fdu-cli/reference.md)。

## 登录

| 账号 | 命令 | 说明 |
|---|---|---|
| 复旦统一身份认证 | `fdu login` | 打开浏览器，你在**学校自己的登录页**里输入学号密码、完成短信 / 企业微信验证，窗口自动关闭。程序不读表单、不保存密码，只保存登录后的 Cookie |
| WebVPN | `fdu login --webvpn` | 校外访问内网系统（树洞、教室、iCourse）用；需要时一般会自动建立 |
| 教室系统 | `fdu rooms login` | 学校多媒体教室的「在线课表」要单独登录一次 |
| 图书馆借阅 | `fdu library login` | 在打开的图书馆页面里点「登录」，进「我的借阅」后窗口自动关闭 |
| 树洞 / 蛋壳课评 | `fdu hole login --email 学号@m.fudan.edu.cn` | 密码只用来换令牌，不保存 |
| 学生邮箱 | `fdu mail setup --user 学号@m.fudan.edu.cn` | 网页邮箱里生成的客户端专用密码（明文保存在本机） |

**登录过期会自动弹窗**：任何命令（包括 AI 通过 MCP 调用时）遇到需要登录，都会直接在你电脑上打开对应的页面。统一身份认证、某些页面要求的二次验证（如微信扫码）、教室系统、图书馆、WebVPN 都一样。你按提示完成后窗口自动关闭，这次查询接着完成，不用切到终端。命令行里最多等 3 分钟；**通过 MCP 调用时最多等 50 秒**（客户端的工具调用一般一分钟左右就超时），等不到时先返回「登录窗口已打开、等你完成」，窗口留着，完成后让 AI 再查一次即可。

- 关掉自动弹窗：设置环境变量 `FDU_AUTO_LOGIN=0`；改等待时间：`FDU_LOGIN_WAIT=秒数`（命令行）、`FDU_MCP_LOGIN_WAIT=秒数`（MCP）
- 手动完成某个页面的登录或二次验证：`fdu login --url <页面地址>`（`NEED_LOGIN` 的提示里会给出地址）
- **没有屏幕的电脑（虚拟机、服务器、给 AI 用的沙箱）**：在自己电脑上 `fdu login`，再 `fdu auth export` 导出一段文本；到那台电脑上运行 `fdu auth import`，粘贴后回车（或 `fdu auth import --file 文件`、`cat 文件 | fdu auth import`）。带走的是复旦账号、WebVPN、图书馆、树洞的登录状态，不带邮箱密码。这段文本能代表你登录学校系统，只在自己的设备之间传。登录过期后重新导一次
- `fdu status` 看各账号的状态，以及上次登录 / 导入是什么时候、之前几次登录各保持了多久（学校没有公开有效期，这是实际观察）。登录状态保存在本机，每次查询都会把学校续期后的状态写回去；能保持多久由学校决定

## 帮助

```bash
fdu help                    # 快速开始和全部命令
fdu help jw                 # 一个服务的全部命令（也可以只写 fdu jw）
fdu help jw lessons         # 一个命令的参数、示例、需要的登录（也可以 fdu jw lessons --help）
fdu services                # 全部命令（JSON，给 AI 看）
fdu describe jw.lessons     # 一个命令的说明（JSON，给 AI 看）
```

## 输出

```json
{ "ok": true, "op": "jw.exams", "data": [ ... ] }
{ "ok": false, "op": "jw.grades", "error": { "code": "NEED_LOGIN", "message": "复旦账号没有登录或登录已过期。", "hint": "运行 `fdu login` ……" } }
```

| 退出码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 学校系统出错、网络问题、页面改版（`UPSTREAM`、`FORMAT_CHANGED`） |
| 2 | 参数错误、命令不存在（`BAD_ARGS`、`NOT_FOUND`） |
| 3 | 需要登录或配置（`NEED_LOGIN`、`NEED_HOLE_LOGIN`、`NEED_MAIL_SETUP`），或要用户自己在终端输入密码（`NEED_TERMINAL`） |

- 时间都是 ISO 格式（UTC，末尾 Z），常用字段另附 `*Shanghai`（北京时间）。
- 只读查询的结果会缓存在本机：加 `--cached` 不联网，返回上次的结果（带 `cachedAt`）；联网失败时，错误里附上上次的结果 `cached`。缓存有有效期：实时数据（人数、空闲、余额、电量）30 分钟，成绩、消费、邮件等隐私数据 24 小时，其他 7 天；最多留 200 份。
- 网络不稳时，查询请求遇到超时、连接被重置或学校系统临时出错会自动重试 1–2 次。
- `FORMAT_CHANGED` 表示学校返回的内容和预期不同（多半是页面改版），不是网络问题。
- 教学周按学校校历计算（一周从周日开始，第 0 周是报到注册周）；内置 2026—2027 学年校历，之后的学期按教务系统的开学日期推算。
- 通用参数：`--compact` 单行输出，`--profile 名称` 另一套登录状态，`--browser 路径` 指定浏览器。

## 常见问题

**出问题了先做什么？** 运行 `fdu doctor`：检查 Node.js、浏览器、配置目录、各学校系统的网络、各账号的登录状态，每项都写了怎么修。结果里没有账号和 Cookie，可以直接贴给别人帮忙看。

**在校外能用吗？** 能。eLearning、教务、校园卡等直接访问；树洞、教室、iCourse 等只对校园网开放的系统会自动经过 WebVPN。

**提示找不到浏览器？** 安装 Chrome 或 Edge；或者把 `FDU_BROWSER` 设成任意 Chromium 内核浏览器的路径；或者运行 `npx playwright install chromium`。错误信息里会列出试过的每种浏览器和失败原因。

**在服务器、容器、虚拟机里用？** 以 root 运行时会自动给 Chromium 加 `--no-sandbox`，Linux 上会加 `--disable-dev-shm-usage`；还需要别的启动参数时用 `FDU_CHROMIUM_ARGS` 补（空格分开）。`fdu doctor` 的网络检查每项最多等 30 秒并重试一次，结果里有每项耗时。登录要在有图形界面的电脑上完成一次，再把 `~/.config/fdu-cli/default/state.json` 带过去（注意它能代表你登录）。

**能帮我续借、预约场馆、选课吗？** 不能，这个工具对学校系统只读。它会告诉你哪本书快到期、哪个场地有空，操作请到学校网站上自己完成。

**iCourse 说「回放还没开放」？** 学校对新回放有审核期，通常一两天后开放。

**返回 `FORMAT_CHANGED`？** 学校页面改版了，欢迎提 issue。

## 隐私

- 成绩、绩点、培养方案、校园卡消费记录、图书馆借阅、邮件标成了隐私数据（`fdu services` 里 `sensitive: true`）。技能会提醒 AI 助理：只用来回答你本人的问题，不写进代码仓库、提交信息或别的服务。
- 数据只在你的电脑和学校系统之间传输；交给哪个 AI 模型由你使用的助理决定。不想让它看到某类数据，就不要登录对应的账号，或者用 `--profile` 分开。

本机保存的东西都在 `~/.config/fdu-cli/default/`（Windows：`%APPDATA%\fdu-cli\default\`；`FDU_HOME` 可改位置），目录权限 700、文件权限 600：

| 文件 | 内容 |
|---|---|
| `state.json` | 统一身份认证、WebVPN、教室系统登录后的 Cookie（不含密码） |
| `library.json` | 图书馆借阅的令牌 |
| `hole.json` | 树洞令牌 |
| `mail.json` | 邮箱 IMAP 配置和客户端专用密码（**明文**） |
| `cache/` | 查询结果的缓存（含成绩等） |

这些文件能代表你登录学校系统：不要同步到网盘、提交到仓库或发给别人。删除：`fdu logout`（同时删除图书馆令牌和缓存）、`fdu hole logout`、`fdu mail forget`、`fdu cache clear`。

## 开发

```bash
npm install
npm run dev -- jw exams      # 不打包直接运行
npm test                     # 单元测试（虚构数据，不连学校系统）
npm run check                # 类型检查 + 测试 + 打包（dist/cli.js 要一起提交）
npm run docs                 # 改了命令后重新生成命令参考
```

代码结构和约定见 [AGENTS.md](AGENTS.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。

**想接一个新的学校系统？** 运行 `fdu dev capture --url <页面地址>`，在打开的浏览器里操作一遍再关掉，会生成一个接口结构文件：只有地址、参数名、返回的字段名和类型、表格列名，**不含**姓名、学号、金额等具体内容，可以直接附在 issue 里。加 `--keep-query` 保留查询参数的值，`--html <地址片段>` 另存匹配网页的原始 HTML（IP、令牌、长数字自动遮掉）。

## 说明

- 本项目与复旦大学官方无关。学校系统随时可能改版。
- 部分接口地址参考了社区项目（如旦挞 / DanXi、ehall、FudanCourtReservation、fudan-library-mcp）公开的接口信息。

## Star 趋势

[![Star History Chart](https://api.star-history.com/svg?repos=sjy0630/fdu-cli&type=Date)](https://star-history.com/#sjy0630/fdu-cli&Date)

## 许可

MIT
