# AGENTS.md：给 AI 编码助手看的项目说明和进度

这份文件写给在这个仓库里干活的 AI 编码助手（Claude Code、Codex、OpenCode 等），也方便人快速了解现状。
功能细节看 [docs/功能详细说明.md](docs/功能详细说明.md)，开发和测试方法看 [CONTRIBUTING.md](CONTRIBUTING.md)。

更新时间：2026-11-07

## 项目是什么

SSH-WEB 是浏览器里的 SSH 终端（Node.js 服务端 + 网页），重点照顾手机和 AI 编码 Agent：

- 断线不丢会话（常驻会话 sshwebd，或 tmux）。
- 手机上能顺手操作：输入栏、按键栏、历史画面、长按复制。
- Agent 状态卡片和推送：靠各 Agent 的钩子 / 插件 / 终端状态信号认出「运行中、待选择、完成、报错」，推送到手机。
- 会话历史：列出主机上各 Agent 的对话，一键「继续」，在不同 Agent 之间切换。
- 文件管理、端口预览、资源监控、右边栏（项目文件、代码改动）。

支持的主机：Linux（常驻会话或 tmux）、Windows（常驻会话，sshwebd 用 ConPTY）、macOS（常驻会话，v1.85.2 起；项目负责人 2026-11-07 在 Mac 上确认能用）。

## 当前版本和状态

| 项目 | 状态 |
|---|---|
| SSH-WEB（私有库） | v1.85.2 |
| SSH-WEB（公开库） | v1.85.2（2026-11-07 发版，镜像 1.85.2 / 1.85 / latest，带 macOS 版 sshwebd；加安卓 App 之前是 v1.84.66） |
| sshwebd | 0.1.9（v1.85.2 加了 macOS 版，Linux、Windows 版功能没变，版本号没升，主机上不用换） |
| 自动化测试 | 94 组（v1.85.1 加了 wakescroll、bgout），2026-11-06 在 v1.85.1 上全部通过（1G 内存的开发机，`npm test`）。机器内存紧（同时开着别的 Agent、浏览器）时 mob、lscroll、attach 这类按时序判断的测试会偶尔失败，先看可用内存再重跑，别当成代码问题。另在一台 4 核 8G 的测试机上跑过全套（Docker：Playwright 1.49 镜像 + tmux + Node 22.23，同 CI）：93 组通过，sendgap 的「回车 40ms 内写」在容器里实测 44~48ms，v1.85.0 一样，是机器时序 |

## 目录结构

- `server.js`：入口。
- `lib/`：服务端。
  - `lib/session/`：一个终端标签的连接（SSH、常驻会话、钩子事件、输入）。
  - `lib/agents/<agent>.js`：每个 Agent 一个文件（钩子安装、事件差异、会话历史、屏幕特征）。
  - `lib/hooks.js`：钩子脚本（hook.sh / hook.ps1 / watch.ps1）和安装、卸载。
  - `lib/agent-sessions.js`：会话历史列表、「继续」、删除对话。
  - `lib/forward.js`：端口预览。
- `public/app/NN-*.js`：网页，按编号顺序拼成一个 app.js（服务端请求时拼）。各 Agent 的网页端特征在 `public/app/09-agents.js`。
- `sshwebd/`：终端守护程序（Go），Docker 构建时编出 exe。不提交编好的文件。
- `test/`：自动化测试，`node test/run.js [名字…]`，每组自己起服务、用模拟 SSH 主机，不碰真实主机。
- `docs/功能详细说明.md`：所有功能的详细说明，改功能要同步更新。

## 开发约定（必须遵守）

- **提交**：改完、测试通过就提交并推送，提交信息用中文，一句话说清改了什么、为什么。只 `git add` 本次相关的文件。在 main 上直接提交。
- **只推私有库**：远程 `origin` 是私有库，`public` 是公开库。只有项目负责人明确说了才推公开库。
- **版本号**：改代码要升版本，`package.json` 和 `package-lock.json` 两处一起改（`package-lock.json` 里有两处），改完跑 `node test/run.js version`。只改文档可以不升。
- **测试**：改了行为要加或改测试；推送前相关测试必须通过，失败就不提交。全套约 15 分钟，机器配置低时分批跑。
- **Agent 相关改动集中在 `lib/agents/` 和 `public/app/09-agents.js`**，不要在通用代码里按 Agent 名字写分支。改别的 Agent 不能影响 Claude Code。
- **新功能要考虑 Windows 主机**（PowerShell / cmd、ConPTY、Windows 版 OpenSSH 的差异）。
- **不写敏感信息**：代码、测试、文档、截图里不出现密码、密钥、真实主机名、IP、私人域名和真实姓名，用 `example.com`、`192.168.1.x` 之类代替。
- **测试不碰真实环境**：用临时目录；端到端实测时要隔离 sshwebd 的 socket，不能执行 pkill 之类会杀掉本机正在用的会话的命令。
- 代码注释和界面文字用中文。

## 各 Agent 适配进度

| Agent | Linux | Windows | 状态从哪来 | 备注 |
|---|---|---|---|---|
| Claude Code | ✅ 实测 | 未测（不需要） | 钩子（settings.json） | 最主要的 Agent |
| Codex 0.166 | ✅ 实测 | 没测（测试机连不上 OpenAI，已决定不再测） | 钩子（hooks.json，要 `/hooks` 批准一次） | 出错结束（额度用完等）不报事件，看屏幕红色「■」行（v1.84.59~60） |
| OpenCode 1.19 | ✅ 实测 | ✅ 实测 | 插件 | |
| OpenCode 2.2 | ✅ 实测 | ✅ 实测 | 终端状态信号 OSC 7501 + 读屏幕 | 数据库换了 session_v2 表；插件接口全换了；后台服务约占 300MB 内存 |
| pi | ✅ 实测 | ✅ 实测 | 扩展 | Windows 上退出事件会丢，靠提示符认出退出 |
| Grok | ✅ 实测 | ✅ 实测 | 钩子 | Windows 版也会执行 Claude Code 的钩子，重复事件已去重（v1.84.56） |
| agy（Antigravity） | ✅ 切换、历史画面实测 | 测试机没登录，没测 | 钩子 | 回答要在 Google 支持的地区才能测 |

「实测」= 真的 SSH-WEB + 真的主机 + 真的 Agent：开起来、说一句、状态变化、会话历史、历史画面、退出、互相「继续」切换。

## 最近完成（v1.84.37 ~ v1.85.2）

- 加 pi 适配；六个 Agent 实机测试后的一批修复；常驻会话选择框里画各 Agent 的标志。
- Agent 之间互相「继续」切换的一系列修复（Linux 31 种切换、Windows 6 种切换实测通过）。
- Windows：OpenCode 会话列表和历史视图；agy 钩子改成 .cmd 小文件；OpenCode 1.x 退出会把 PowerShell 带走（OpenCode 的 bug），「继续」时自动新开常驻会话；watch.ps1 进程泄漏修复。
- OpenCode 2 适配（新表、`opencode session export`、OSC 7501 状态）；Windows 上 OpenCode 数据库按块同步。
- 端口预览先连 127.0.0.1，不通再试 ::1 和 localhost（Windows 的 sshd 把 localhost 解析成 ::1）。
- sshwebd 0.1.9：常驻会话里 Ctrl+C 能打断程序了（以前守护进程带着「忽略 Ctrl+C」的设置传给了会话里的程序）。
- Codex 额度用完等出错结束时，状态显示「报错」并写出原因（以前一直停在「运行中」）。
- 手机上快速滑历史画面不再闪出一大片空白：历史画面打开后马上把前面的历史一次补完，手指在历史画面上滑（含惯性）时不往上补（v1.84.61~63）。
- 安卓 App（私有仓库 SSH-WEB.Android，WebView 套 SSH-WEB）收推送：服务端加 `/api/push/stream`（SSE），内容和 Web Push 一样，断线重连按 Last-Event-ID 补发（v1.84.67）。
- 手机后台回来 / 点推送通知进来（v1.85.1）：常驻会话里程序没开鼠标（Claude Code）时，历史只走历史视图，还没连上、取历史在冷却时滑动吞掉并提示，不再交给 xterm 把它那份旧画面滚上去（以前滚上去就回不来、也没按钮）；终端滚动区往上翻着时显示「回到实时画面」，从输入栏发字也回到最底下；回到前台不再等 8 秒心跳 + 旧连接关闭握手：触屏设备在后台待了 10 秒以上直接换新连接，其余心跳 3 秒没回话就换；换连接时在等的历史作废、不进冷却；点推送通知切过去时关掉历史视图、回到最底下；网页在后台时输出先攒着不写进 xterm（后台定时器被压慢，xterm 处理不过来，回来时 Claude Code 状态行停在旧时间好一阵），回来攒得少直接写、超过 256KB 发 `sync` 要现在的画面（服务端 `sync` 不再只给 lite 连接用）。Alt+↑ / ↓ 切换标签（同 ← / →）。
- macOS 主机能用常驻会话（v1.85.2）：以前 `uname` 报 Darwin 就安静地开普通终端（用户反馈「Mac 上用不了常驻」）。Docker 镜像加编 `sshwebd-darwin-arm64` / `-amd64`；sshwebd 按会话找进程在 macOS 上用 sysctl（`proc_darwin.go`，Linux 的 /proc 版挪到 `proc_linux.go`），语言环境都没设时补 `LC_CTYPE=UTF-8`；服务端记 `os: 'mac'`，靠 /proc 的（选择框目录、tmux 里的历史、tmux 提示）同 Windows 跳过，读 ~/.claude/projects 的选择框标题照样用（`stat` 加了 macOS 写法）。测试用 Linux 版冒充 macOS 版跑通（daemonlinux），项目负责人 2026-11-07 在真 Mac 上确认常驻会话能用。
- Windows 上第一次打开 OpenCode 会话历史不再等整个数据库拷完：列表走 OpenCode 2 后台服务的接口，历史画面先导出这一条，数据库在后台慢慢拷（v1.84.65）。
- OpenCode 2 在 Linux 上实测补全：插件新旧版都能加载、状态里写出你说的话和回复、认出打断、「继续」不再把命令打进还没退干净的 OpenCode（v1.84.64）。

## OpenCode 2 适配要点（2026-11-04 Linux 实测通过）

- **插件**：OpenCode 2 要求 `export default { id, setup }`，旧插件加载失败会弹「Plugin failed」、吞掉第一句话。现在插件写成 `export default { id, server, setup }`：OpenCode 1.x 用 `server()`（`readV1Plugin`），OpenCode 2 用 `id + setup()`（什么都不做）。连上装了钩子的主机时，SSH-WEB 自己装的旧版插件自动换成新版（`lib/hooks.js` 的 `refreshPlugins`）。
- **状态**：靠 OSC 7501（`lib/session/hooks.js` 的 `onProgramStatus`），信号里只有对话标题。你说的话、回复、是不是被打断从屏幕上读（`lib/agents/opencode.js` 的 `events.oscScreen`）：你说的话是和输入框同色的「┃」框（工具输出是暗色的「┃」框），回复在页脚「Build · 模型 · 4.7s · …」上面，页脚末尾「· interrupted」= 被打断。
- **时序**（实测）：开始干活的信号到的时候，对话区里还是上一轮；做完 / 打断的信号比页脚早几百毫秒，慢的机器上回复的字比页脚还晚。所以你说的话在整轮干活期间一直留意，做完 / 打断等页脚和回复画出来再报。
- **「继续」**：OpenCode 2 退出时先清界面、过几秒才清程序状态、真的退出。状态没清掉时，「安静 2 秒」不算回到 shell（免得命令被它吃掉）；光标那行认得出是 shell 提示符就马上发（Ctrl+C 退出时它不一定清状态）。认出它退出了，残留的状态一起清掉。

## 阶段状态

2026-11-04 这个阶段完结，公开库发版 v1.85.0（加了安卓 App 的推送流，版本号从 1.85 开始）。之后只修 bug 和点名的改动。

已知没测到的（风险低，有条件时再补）：

- Windows 上 OpenCode 2 的打断：识别逻辑和 Linux 同一套，Linux 上实测通过；Windows 上读屏幕（你说的话、回复）、旧插件自动换新、OpenCode 和 pi 互相「继续」切换、会话历史都已实测通过（v1.84.65）。
- agy 的回答、钩子通知没在真机上完整测过（测试机地区不支持 / 没登录）。
- 手机真机只靠自动化测试模拟；手机历史画面快滑空白已由项目负责人真机确认解决。
- macOS 常驻会话已在真 Mac 上确认能用（2026-11-07），没专门逐项测的：钩子 (hook.sh 在 macOS 上) 报状态、Claude Code 通过 SSH 读钥匙串里的登录信息、补上的 LC_CTYPE=UTF-8 下中文显示。
- PowerShell 5.1 不认 Ctrl+U：退出 Agent 时发的 Ctrl+U 是给 Agent 的，实际碰不到 PowerShell，不处理。

## 已经确定不做的

- 在线编辑器、分屏（已有终端搜索）。
- 元素点选、Docker 面板、Face ID 等对照同类项目推荐的功能。
- 切标签时保留 WebGL 渲染器（试过，会画面错乱，已撤回）。
