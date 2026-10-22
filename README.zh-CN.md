# SSH-WEB

[English](README.md) | [简体中文](README.zh-CN.md)

轻量的自托管 Web SSH 终端，专为在远程主机上跑 AI 编程助手（Claude Code、Codex、Gemini 等）设计，手机、电脑都能用。一个 Docker 容器就能跑，适合部署在 NAS 上。

```
浏览器 (xterm.js) ──WebSocket──> SSH-WEB (Node.js + ssh2) ──SSH──────────────> 目标主机
                                                         └─WSS (Cloudflare)──> cloudflared ──> 主机:22
```

## 功能

- **后台会话**：SSH 连接保持在服务器上，关掉浏览器、断网后再打开，标签、画面、历史输出全部恢复；手机和电脑可以同时打开同一个标签。
- **为 Agent 设计**：每个标签显示状态（运行中 / 完成 / 待选择），通过网页推送或 Claude Code 钩子发通知（安卓通知上能直接点「允许 / 拒绝」），主机状态卡片，会话历史。
- **手机好用**：带特殊键的输入栏、对输入法友好，网络慢时打字预测回显，tmux 里本地快速滚动。
- **右边栏**：文件树（git 状态、彩色图标）、模糊搜索文件（Ctrl+Shift+P）、代码改动对比，可以在改动的行上写批注发给 Agent。
- **文件和端口**：SFTP 文件管理（拖拽上传、预览），图片 / 文件发给 Agent，内置端口转发预览开发服务。
- **Windows 主机**：支持 cmd / PowerShell；可选的常驻会话用 [sshwebd](sshwebd/README.md)（很小的 ConPTY 守护程序），断线后终端继续运行。
- **性能监控**：CPU、内存、网速、磁盘、进程；延迟显示。
- **Cloudflare 隧道**：直接连接通过 `cloudflared` 暴露的主机（支持 Service Token），不用装客户端。
- **安全**：登录和失败限流、验证码（TOTP）弹窗、主机指纹校验、凭据 AES-256-GCM 加密保存、可限制可连接的主机。
- 浅色 / 深色主题，主机分组，历史命令和收藏命令，内网离线可用。

每个功能的详细说明：[docs/功能详细说明.md](docs/功能详细说明.md)

## 快速部署

```bash
git clone https://github.com/yougelabview66/SSH-WEB.git
cd SSH-WEB
# 先改 docker-compose.yml 里的 AUTH_PASSWORD
docker compose up -d --build
```

访问 `http://服务器IP:8888`。数据都在 `./data`，备份这个目录即可。群晖、威联通、飞牛等可以在 Container Manager 里用这个目录的 `docker-compose.yml` 创建项目。

不用 compose：

```bash
docker build -t ssh-web .
docker run -d --name ssh-web --restart unless-stopped \
  -p 8888:8888 -v $(pwd)/data:/data -e AUTH_PASSWORD=你的密码 ssh-web
```

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `AUTH_USER` / `AUTH_PASSWORD` | `admin` / 空 | 网页登录。**密码为空就不需要登录**，只适合可信内网 |
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

npx playwright install chromium   # 第一次需要
npm test                          # 或者只跑几个：npm test -- desk lat
```

测试用真的浏览器连本机（127.0.0.1）上的模拟 SSH 服务器，不会连接真实主机。服务端代码在 `lib/`，前端在 `public/app/`（按编号顺序拼起来），Windows 守护程序在 `sshwebd/`（Go）。

## 致谢

设计参考了 [webssh](https://github.com/huashengdun/webssh)、[webssh2](https://github.com/billchurch/webssh2)、[sshwifty](https://github.com/nirui/sshwifty) 和 [Orca](https://github.com/stablyai/orca)；基于 [xterm.js](https://xtermjs.org/) 和 [ssh2](https://github.com/mscdex/ssh2)。

## 许可证

[MIT](LICENSE)
