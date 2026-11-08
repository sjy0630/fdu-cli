# 给参与开发的人和编程助理

## 结构

```
src/
  cli.ts            命令行入口：解析参数、输出 JSON、退出码
  mcp.ts            fdu mcp：把操作表注册成 MCP 工具（stdio）
  ops.ts            操作表：每个命令定义一次（参数、需要的登录、是否隐私、效果），命令行和 MCP 共用
  run.ts            参数校验、错误统一、describe
  reference.ts      生成 skills/fdu-cli/reference.md
  core/
    session.ts      登录会话：Playwright 请求接口（不开浏览器）+ 需要时用浏览器渲染 / 登录；Cookie 存 state.json
    auth.ts         登录流程、登录状态、WebVPN、给 eLearning 客户端用的认证接口
    store.ts        本地配置目录（700 / 600，原子写入）
    errors.ts       错误码
    fudan-auth.ts   各平台地址、NeedLoginError
  services/         各系统的读取和解析（只依赖注入的读取接口，方便测试）
skills/fdu-cli/     给 Claude Code / Codex 的技能（SKILL.md）和命令参考
.claude-plugin/     Claude Code 插件和插件市场清单；.mcp.json 是插件带的 MCP 服务
tests/              vitest；页面和接口样例都是虚构内容
```

## 加一个命令

### 先判断该不该加

fdu 相当于给 AI 用的指令集：命令负责把学校系统的数据原样、稳定地拿出来，怎么组合由 AI 决定。命令越少越清楚，AI 越不容易选错。

- **能拿到新数据**（新的系统、新的接口）→ 加成原子命令。只做读取和整理，不替 AI 做判断或下结论。
- **只是把已有命令组合起来** → 默认不加，让 AI 自己组合。只有大多数人每天都会用、而且组合起来明显费时或费额度，才做成伪指令（现有的 `today`、`week`、`todo`、`rooms free` 就是这类）。
- **需要常驻、定时或发通知** → 不做，交给 agent。fdu 每次运行完就退出。
- 能用已有命令加一个参数解决的，不新开命令。

### 怎么加

不知道学校系统用什么接口时，请有账号的人运行 `fdu dev capture --url <页面>` 操作一遍，拿到去掉内容的接口结构文件，再照着写。

1. 在 `services/` 里写读取和解析，读取通过 `CampusReader`（或注入的 fetch），不直接发请求，这样测试能用假数据。
2. 在 `ops.ts` 的 `OPS` 里加一项：`name` 形如 `服务.操作`，写清 `summary`、`params`（zod，带 `.describe()`）、`login`、`effect`；成绩、邮件这类数据标 `sensitive: true`；需要在终端输入密码的标 `mcp: false`。
3. 加测试，运行 `npm run docs` 更新命令参考，`npm run check` 全部通过（它会重新构建 `dist/cli.js`，一起提交：从 GitHub 直接安装时用的是仓库里的构建结果）。

## 约定

- **只读**：不做任何会改变学校系统数据的操作（提交、选课、发帖、发邮件、标已读）。下载只写本机文件，不覆盖已有文件。
- **不碰密码**：统一身份认证只在浏览器里由用户本人登录；树洞密码只用来换令牌；邮箱客户端专用密码是唯一保存的密码，文件权限 600，并在文档里写明。
- **不提交真实数据**：测试里的页面、成绩、邮件都用虚构内容；不要提交 `state.json` 等登录文件、真实学号、Cookie。
- **输出稳定**：命令输出的字段是给程序读的，改名或删字段要在 README 里说明。
- 错误一律变成 `FduError`（`code` + `message` + `hint`），`hint` 告诉用户下一步怎么做。
- 不复制 GPL / AGPL 或没有许可证的项目代码，只参考公开的接口信息。
