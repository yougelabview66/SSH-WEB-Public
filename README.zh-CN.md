# SSH-WEB

[![test](https://github.com/yougelabview66/SSH-WEB-Public/actions/workflows/test.yml/badge.svg)](https://github.com/yougelabview66/SSH-WEB-Public/actions/workflows/test.yml) [![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) | [简体中文](README.zh-CN.md)

轻量的自托管 Web SSH 终端，专为在远程主机上跑 AI 编程助手（Claude Code、Codex、Gemini 等）设计，手机、电脑都能用。一个 Docker 容器就能跑，适合部署在 NAS 上。

<p align="center">
  <img src="docs/images/desktop.png" alt="电脑：多标签、Agent 状态卡片、右边栏项目文件" width="100%">
</p>
<p align="center">
  <img src="docs/images/mobile.png" alt="手机：终端、输入栏和特殊键" width="280">
</p>

```
浏览器 (xterm.js) ──WebSocket──> SSH-WEB (Node.js + ssh2) ──SSH──────────────> 目标主机
                                                         └─WSS (Cloudflare)──> cloudflared ──> 主机:22
```

## 为什么用 SSH-WEB

大多数 Web SSH 只是把终端搬进浏览器标签：标签一关会话就没了，手机上也很难用。SSH-WEB 是围绕另一种用法设计的：**AI Agent 在远程主机上干一个小时的活，你在任何地方随时看一眼、回复一下。**

- **离开不丢东西**：SSH 连接由服务器保持，不在浏览器里。合上电脑、换网络、手机锁屏，回来时标签、画面、滚动记录都和离开时一样。不需要 tmux（用 tmux 也没问题）。
- **知道 Agent 在干什么**：每个标签显示 Claude Code 是在运行、做完了还是在等你，以及正在做的事。需要你决定时推送到手机，安卓上可以直接在通知里点「允许 / 拒绝」。
- **手机上真正好用**：输入栏对中文输入法友好，Esc / Tab / Ctrl / 方向键一点就有，手机网络慢时打字预测回显，tmux 历史也能顺滑滚动。电脑上开始的任务可以在手机上接着做；同一时间只由一台设备决定排版，画面不会来回折行。
- **不离开终端就能检查 Agent 的改动**：浏览项目文件、看改了什么、在具体的行上写批注，整理成一段话发回给 Agent。
- **什么都不用装**：只要一个浏览器。在 NAT 后面的主机可以通过 Cloudflare 隧道连接，用的那台设备不用装 `cloudflared`。
- **轻到能跑在 NAS 上**：一个 Node.js 容器，没有数据库（数据就是几个 JSON 文件），前端资源全部自带，内网离线也能用。
- **默认安全**：不设密码时只允许本机访问；保存的凭据加密存储；像 OpenSSH 一样校验主机指纹；登录失败限流。
- **Windows 主机同样好用**：处理 cmd / PowerShell 的各种差异，可选用自带的 sshwebd 守护程序让会话常驻。
- **测试充分**：60 多个端到端测试，用真的浏览器连模拟的 SSH 服务器跑。

## 使用场景

- **在家里的服务器、NAS 或云主机上跑 Claude Code（或 Codex、Gemini 等）**，用手机盯着：做完或要确认时收到通知，回复一下就可以放下手机。
- **所有机器一个面板**：NAS、VPS、GPU 服务器、Windows 电脑都在一排标签里，状态卡片一眼看出哪台在忙、做完了、在等你。
- **长时间任务**：模型训练、编译、备份，启动后关掉浏览器，结束时收到通知。
- **在任何地方访问家里的机器**：哪怕是借来的、不能装 SSH 客户端的电脑，通过 HTTPS 或 Cloudflare 隧道就能用。
- **快速审查 Agent 的改动**：在右边栏看对比、给某几行写批注、发回给 Agent 修改。
- **预览 Agent 做出来的网页**：通过内置的端口转发，在浏览器里打开远程主机上的开发服务（比如 `localhost:5173`）。

SSH-WEB 是单用户工具：一个登录保护所有主机，不适合需要多账号、分权限的团队。

## 功能

- **后台会话**：SSH 连接保持在服务器上，关掉浏览器、断网后再打开，标签、画面、历史输出全部恢复；手机和电脑可以同时打开同一个标签。
- **为 Agent 设计**：每个标签显示状态（运行中 / 完成 / 待选择），通过网页推送或 Claude Code 钩子发通知（安卓通知上能直接点「允许 / 拒绝」），主机状态卡片，会话历史。
- **手机好用**：带特殊键的输入栏、对输入法友好，网络慢时打字预测回显，tmux 里本地快速滚动。
- **右边栏**：文件树（git 状态、彩色图标）、模糊搜索文件（Ctrl+Shift+P）、代码改动对比，可以在改动的行上写批注发给 Agent。
- **文件和端口**：SFTP 文件管理（拖拽上传、预览），图片 / 文件发给 Agent，内置端口转发预览开发服务。
- **常驻会话（推荐开启）**：终端放在主机上一个很小的守护程序（[sshwebd](sshwebd/README.md)）里，断网、关掉标签、SSH-WEB 重启后都还在跑。支持 Windows 和 Linux。
- **Windows 主机**：支持 cmd / PowerShell、性能监控、端口列表，常驻会话基于 ConPTY。
- **性能监控**：CPU、内存、网速、磁盘、进程；延迟显示。
- **Cloudflare 隧道**：直接连接通过 `cloudflared` 暴露的主机（支持 Service Token），不用装客户端。
- **安全**：登录和失败限流、验证码（TOTP）弹窗、主机指纹校验、凭据 AES-256-GCM 加密保存、可限制可连接的主机。
- 浅色 / 深色主题，主机分组，历史命令和收藏命令，内网离线可用。

每个功能的详细说明：[docs/功能详细说明.md](docs/功能详细说明.md)

## 推荐：开启常驻会话

在主机设置里勾上 **「常驻会话」**（新建主机默认勾着）。SSH-WEB 会把一个很小的守护程序（`sshwebd`，约 3 MB，运行时只占几 MB 内存）传到主机上，终端在它里面运行：

- 断网、关掉浏览器标签、SSH-WEB 自己重启，终端照样在跑；重新连上自动接回去，只补发没收到的输出。
- 新开标签时列出还在跑的会话，每个显示所在文件夹和 Agent 正在做的事，点一下接上；不要的可以直接删除。
- 支持 **Windows**（代替 psmux）和 **Linux**（amd64 / arm64 / armv7）。不用再靠 tmux 保会话；在里面照样开 tmux 也没问题。
- 别的系统（比如 macOS）照常开普通终端。

<p align="center">
  <img src="docs/images/daemon-setting.png" alt="主机设置里的「常驻会话」" width="40%">
  &nbsp;
  <img src="docs/images/daemon-pick.png" alt="接上还在跑的常驻会话" width="50%">
</p>

## 快速部署

```bash
git clone https://github.com/yougelabview66/SSH-WEB-Public.git
cd SSH-WEB-Public
# 先改 docker-compose.yml 里的 AUTH_PASSWORD
docker compose up -d --build
```

访问 `http://服务器IP:8888`。数据都在 `./data`，备份这个目录即可。群晖、威联通、飞牛等可以在 Container Manager 里用这个目录的 `docker-compose.yml` 创建项目。

也可以直接用编好的镜像（amd64 / arm64），不用下载代码：

```bash
docker run -d --name ssh-web --restart unless-stopped \
  -p 8888:8888 -v $(pwd)/data:/data -e AUTH_PASSWORD=你的密码 \
  ghcr.io/yougelabview66/ssh-web:latest
```

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `AUTH_USER` / `AUTH_PASSWORD` | `admin` / 空 | 网页登录。**不设密码时只允许本机（127.0.0.1）直接访问**，要从别的设备用请设置密码 |
| `PORT` / `HOST` | `8888` / `0.0.0.0` | 监听地址 |
| `SECRET` | 自动生成 | Cookie 签名和凭据加密用（存在 `data/.secret`），丢了已保存的密码就解不开 |
| `COOKIE_SECURE` | `false` | 通过 HTTPS 访问时设为 `true` |
| `SESSION_HOURS` | `720` | 多久没用就要重新登录（小时） |
| `ALLOWED_HOSTS` | 不限 | 允许连接的主机，逗号分隔，如 `192.168.1.*,*.example.com` |
| `HOSTKEY_POLICY` | `ask` | 主机指纹校验：`ask`、`accept-new`、`off` |
| `TRUST_PROXY` | 内网地址 | 信任哪些代理发来的 `X-Forwarded-For` |
| `BG_TIMEOUT_HOURS` | `168` | 后台会话多久没人看就断开（`0` 为永不） |
| `MAX_SESSIONS` | `30` | 最多保留的后台会话数 |
| `SCROLLBACK` | `5000` | 每个会话保留的滚动行数 |
| `PUID` / `PGID` | 不设置 | 用这个用户（不是 root）运行 |

## 安全提示

SSH-WEB 是能登录你所有服务器的入口。放到公网时：

- 设置强 `AUTH_PASSWORD`，并设 `COOKIE_SECURE=true`；
- 用 HTTPS，最好前面再加 Cloudflare Access 等登录保护；
- 第一次连接时核对主机指纹，不要关掉指纹校验；
- 用 `ALLOWED_HOSTS` 限制能连接的主机。

发现安全问题请私下报告，见 [SECURITY.md](SECURITY.md)。

## 开发

```bash
npm install
AUTH_PASSWORD=test npm start

npx playwright-core install chromium   # 第一次需要
npm test                          # 或者只跑几个：npm test -- desk lat
```

测试用真的浏览器连本机（127.0.0.1）上的模拟 SSH 服务器，不会连接真实主机。参与开发见 [CONTRIBUTING.md](CONTRIBUTING.md)。服务端代码在 `lib/`，前端在 `public/app/`（按编号顺序拼起来），终端守护程序在 `sshwebd/`（Go；Windows 用 ConPTY，Linux 用 pty）。

## 致谢

设计参考了 [webssh](https://github.com/huashengdun/webssh)、[webssh2](https://github.com/billchurch/webssh2)、[sshwifty](https://github.com/nirui/sshwifty) 和 [Orca](https://github.com/stablyai/orca)；基于 [xterm.js](https://xtermjs.org/) 和 [ssh2](https://github.com/mscdex/ssh2)。

## 许可证

[MIT](LICENSE)
