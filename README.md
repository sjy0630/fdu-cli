# fdu-cli（`fdu`）

复旦校园服务的命令行和 MCP 服务，给 **Claude Code、Codex** 等编程助理用：让它直接查你的 DDL、课表、考试、成绩，下载课件，找学校通知和图书馆文献。

```bash
fdu login                      # 打开浏览器，登录复旦统一身份认证（一次即可）
fdu todo --days 7              # 这周要交、还没交的作业
fdu jw timetable               # 本学期课表
fdu jw exams                   # 考试安排
fdu elearning files --course 线性代数 --search 第5讲
fdu library search --query "graph neural network" --year-from 2022
fdu mcp                        # 以 MCP 服务运行
```

所有命令输出 JSON，适合程序和 AI 读取。完整命令见 [skills/fdu-cli/reference.md](skills/fdu-cli/reference.md)，或运行 `fdu services`、`fdu describe <服务.操作>`。

## 能做什么

| 服务 | 命令 | 说明 |
|---|---|---|
| eLearning | `fdu elearning courses / assignments / todo / announcements / files / download` | 课程、作业和截止时间、公告、课件列表和下载 |
| 教务系统 | `fdu jw semesters / timetable / exams / grades / gpa / program / selected` | 课表（含研究生）、考试、成绩和绩点、排名、培养方案完成情况、选课结果 |
| 校园卡 | `fdu card balance` | 余额 |
| 宿舍 | `fdu dorm electricity` | 剩余电量 |
| 图书馆 | `fdu library seats / search` | 各馆在馆人数；文献检索（不用登录） |
| 学校通知 | `fdu notices sources / list / read` | 教务处、研究生院、各院系官网通知（不用登录） |
| 树洞、旦克 | `fdu hole search / read / latest`，`fdu danke search / reviews` | 树洞帖子、课程评价（需要树洞账号；校外自动走 WebVPN） |
| 学生邮箱 | `fdu mail list / read` | 收件箱（IMAP 只读，需要客户端专用密码） |

对学校系统**全部只读**：不能提交作业、选课、发帖、发邮件，也不会改变邮件的已读状态。

## 安装

需要 Node.js 20 或更新版本，以及 Chrome 或 Edge 浏览器（登录和部分页面要用）。

```bash
npm install -g github:sjy0630/fdu-cli
fdu --version
```

从源码：

```bash
git clone https://github.com/sjy0630/fdu-cli.git
cd fdu-cli
npm install
npm link
```

没有装 Chrome / Edge 时，可以把 `FDU_BROWSER` 设成任意 Chromium 内核浏览器的可执行文件路径，或者运行 `npx playwright install chromium`。

## 登录

```bash
fdu login            # 复旦统一身份认证：eLearning、教务、校园卡、电量共用
fdu login --webvpn   # 顺便建立 WebVPN 会话（校外访问树洞需要）
fdu status           # 看看各系统的登录状态
```

`fdu login` 会打开浏览器，你在**学校自己的登录页面**里输入学号密码、完成短信 / 企业微信验证，登录成功后窗口自动关闭。程序不读取表单、不保存密码，只保存登录后的 Cookie。登录过期后重新运行 `fdu login` 即可。

```bash
fdu hole login --email 学号@m.fudan.edu.cn   # 树洞 / 旦克：密码只用来换令牌，不保存
fdu mail setup --user 学号@m.fudan.edu.cn    # 学生邮箱：输入网页邮箱里生成的客户端专用密码
```

### 本地保存了什么

都在 `~/.config/fdu-cli/default/`（Windows：`%APPDATA%\fdu-cli\default\`；可用 `FDU_HOME` 改位置，`--profile` 切换多套登录）。目录权限 700，文件权限 600：

| 文件 | 内容 |
|---|---|
| `state.json` | 统一身份认证登录后的 Cookie（不含密码） |
| `hole.json` | 树洞令牌 |
| `mail.json` | 邮箱 IMAP 配置和客户端专用密码（**明文**） |

这些文件能代表你登录学校系统：不要同步到网盘、提交到仓库或发给别人。`fdu logout`、`fdu hole logout`、`fdu mail forget` 分别删除。

## 接入 Claude Code

**方式一：插件（技能 + MCP 服务一起装）**。先按上面装好 `fdu`，然后在 Claude Code 里：

```text
/plugin marketplace add sjy0630/fdu-cli
/plugin install fdu-cli@fdu-cli
```

**方式二：只接 MCP 服务**

```bash
claude mcp add --scope user fudan -- fdu mcp
```

**方式三：只装技能**（让 Claude 通过命令行调用 `fdu`）：把 `skills/fdu-cli` 文件夹复制到 `~/.claude/skills/`。

## 接入 Codex

在 `~/.codex/config.toml` 里加上：

```toml
[mcp_servers.fudan]
command = "fdu"
args = ["mcp"]
```

技能：把 `skills/fdu-cli` 文件夹复制到 `~/.codex/skills/`。

其他支持 MCP 的客户端（Cursor、Cline、Claude Desktop 等）同理：命令 `fdu`，参数 `mcp`，stdio 方式。

## 输出格式

```json
{ "ok": true, "op": "jw.exams", "data": [ ... ] }
{ "ok": false, "op": "jw.grades", "error": { "code": "NEED_LOGIN", "message": "复旦账号没有登录或登录已过期。", "hint": "运行 `fdu login` ……" } }
```

| 退出码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 学校系统出错、网络问题、页面改版等 |
| 2 | 参数错误、命令不存在 |
| 3 | 需要登录或配置（`NEED_LOGIN` / `NEED_HOLE_LOGIN` / `NEED_MAIL_SETUP`） |

时间都是 ISO 格式（UTC，末尾 Z），常用字段另附 `*Shanghai`（北京时间）。加 `--compact` 输出单行 JSON。

## 隐私

- 成绩、绩点、培养方案、邮件标成了隐私数据（`fdu services` 里 `sensitive: true`）。技能会提醒编程助理：只用来回答你本人的问题，不写进代码仓库、提交信息或别的服务。
- 这些数据只在你的电脑和学校系统之间传输；交给哪个 AI 模型由你使用的编程助理决定。
- 不想让助理看到某类数据时，就不要在它里面登录对应的账号，或者用 `--profile` 分开。

## 开发

```bash
npm install
npm run dev -- jw exams      # 不打包直接运行
npm test                     # 单元测试（虚构数据，不连学校系统）
npm run check                # 类型检查 + 测试 + 打包
npm run docs                 # 改了命令后重新生成 skills/fdu-cli/reference.md
```

代码结构和约定见 [AGENTS.md](AGENTS.md)。

## 说明

- 本项目与复旦大学官方无关。学校系统随时可能改版，读不到时会返回 `FORMAT_CHANGED`，欢迎提 issue。
- 部分接口地址参考了社区项目（如旦挞 / DanXi）公开的接口信息，没有使用它们的代码。

## 许可

MIT
