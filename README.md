# SSH-WEB

轻量级 Web SSH 终端，适合部署在 NAS 的 Docker 中。设计参考了
[huashengdun/webssh](https://github.com/huashengdun/webssh)、
[billchurch/webssh2](https://github.com/billchurch/webssh2)、
[nirui/sshwifty](https://github.com/nirui/sshwifty)。

```
浏览器 (xterm.js) ──WebSocket──> SSH-WEB (Node.js + ssh2) ──SSH──────────────> 目标主机
                                                          └─WSS (Cloudflare)──> cloudflared ──> NAS:22
```

## 功能

- 多标签终端（xterm.js），自适应窗口大小、支持中文、链接可点击、手机可用
- 密码 / 私钥（含私钥密码）/ keyboard-interactive 认证
- **二次验证 (TOTP)**：服务器要求验证码时网页弹窗输入，密码仍自动填写
- **主机指纹校验**：类似 OpenSSH known_hosts，首次连接确认指纹，指纹变化时红色警告
- **SFTP 文件管理**：浏览、上传（拖拽 / 多文件 / 进度条）、下载、文件夹打包下载、新建、重命名、删除、终端 cd 到当前目录
- **支持连接通过 Cloudflare Tunnel 暴露 SSH 的 NAS**（相当于内置了 `cloudflared access ssh`，支持 Access Service Token）
- 主机列表（分组、搜索），凭据用 AES-256-GCM 加密保存在服务器，浏览器拿不到
- 网页登录保护、登录失败限流、签名 Cookie
- 可限制允许连接的目标主机（`ALLOWED_HOSTS`）
- WebSocket 心跳，适配 Cloudflare / 反向代理的空闲超时
- 前端依赖全部本地提供，内网离线可用

## 部署（NAS Docker）

把整个目录上传到 NAS，例如 `/volume1/docker/ssh-web`，然后：

```bash
cd /volume1/docker/ssh-web
# 先修改 docker-compose.yml 里的 AUTH_PASSWORD
docker compose up -d --build
```

访问 `http://NAS_IP:8888`。

> 群晖 / 威联通 / 飞牛 等可以在「Container Manager → 项目」里选择这个目录，直接用 `docker-compose.yml` 创建项目。

不用 compose 也可以：

```bash
docker build -t ssh-web .
docker run -d --name ssh-web --restart unless-stopped \
  -p 8888:8888 -v $(pwd)/data:/data \
  -e AUTH_PASSWORD=你的密码 ssh-web
```

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8888` | 监听端口 |
| `AUTH_USER` | `admin` | 网页登录用户名 |
| `AUTH_PASSWORD` | 空 | 网页登录密码，**为空则不需要登录**（仅限可信内网） |
| `SECRET` | 自动生成 | 用于 Cookie 签名和凭据加密，自动生成的保存在 `/data/.secret`。**丢失后已保存的密码无法解密** |
| `SESSION_HOURS` | `24` | 登录有效期（小时） |
| `COOKIE_SECURE` | `false` | 通过 HTTPS 访问时设为 `true` |
| `ALLOWED_HOSTS` | 空（不限） | 允许连接的主机，逗号分隔，`*` 只匹配一段（不跨 `.`），如 `192.168.1.*,*.example.com`；Cloudflare 隧道按隧道主机名校验 |
| `TRUST_PROXY` | `loopback, linklocal, uniquelocal` | 信任哪些地址发来的 `X-Forwarded-For`（用于登录限流取真实 IP）。默认只信任内网地址（反向代理、cloudflared 容器），防止公网伪造 |
| `SSH_READY_TIMEOUT` | `20000` | SSH 连接超时（毫秒） |
| `SSH_KEEPALIVE` | `15000` | SSH keepalive 间隔（毫秒） |
| `HOSTKEY_POLICY` | `ask` | 主机指纹校验：`ask` 新主机和指纹变化都要确认；`accept-new` 新主机自动信任、变化时确认；`off` 不校验 |

数据都在 `./data`：`hosts.json`（主机列表，密码加密）、`known_hosts.json`（已信任的主机指纹）和 `.secret`，备份这个目录即可。

## 二次验证 (TOTP)

适用于服务器开启了 Google Authenticator 等二次验证（如群晖 SSH 两步验证、`libpam-google-authenticator`）。
连接时服务器询问的「Password」会自动用保存的密码填写，「Verification code」等其他问题会在网页上弹窗让你输入，
手机上会自动弹出数字键盘。等待输入期间不会超时（最长 5 分钟）。

## 主机指纹校验

- 首次连接某台主机时弹窗显示指纹，确认后保存到 `data/known_hosts.json`
- 以后指纹不变则直接连接；**指纹变化会红色警告**，默认拒绝，确认服务器重装过才选「更新指纹并连接」
- 侧边栏底部「已信任的主机指纹」可以查看和删除
- 直连按 `主机:端口` 记录，Cloudflare 隧道按隧道主机名记录

## SFTP 文件管理

连接成功后点标签栏右侧「📁 文件」打开，复用当前终端的 SSH 连接（不用再输密码 / 验证码）。

- 点文件夹进入，路径栏可直接输入路径回车跳转
- 上传：按钮选择或直接把文件拖到列表里，带进度条，重名会询问是否覆盖
- 下载：文件直接下载；文件夹在服务器上用 `tar` 打包成 `.tar.gz` 下载
- 「终端 cd」让终端切换到当前浏览的目录
- 传输走 HTTP 流，不占用终端的 WebSocket，大文件也没问题（通过 Cloudflare 隧道访问 SSH-WEB 时，上传单个文件受 Cloudflare 100MB 请求体限制）

> 需要目标主机开启 SFTP 子系统。群晖需要在「控制面板 → 文件服务 → FTP → SFTP」里启用 SFTP 服务。

## 连接通过 Cloudflare 隧道暴露 SSH 的 NAS

适用于这种情况：NAS 上运行了 `cloudflared`，并在 Cloudflare Zero Trust 里配置了
Public Hostname `ssh.example.com → ssh://localhost:22`。平时需要用
`cloudflared access ssh --hostname ssh.example.com` 才能连上。

在 SSH-WEB 中：

1. 新建连接 → 选择 **Cloudflare 隧道**
2. 「隧道主机名」填 `ssh.example.com`（不用填端口）
3. 填 NAS 的 SSH 用户名和密码 / 私钥
4. 如果该主机名配置了 **Cloudflare Access** 应用（大多数都会配），还需要 Service Token：
   - Zero Trust → Access → Service Auth → Service Tokens → 创建，得到 `Client ID` 和 `Client Secret`
   - 在该主机名对应的 Access 应用里添加一条策略：Action 选 **Service Auth**，Include 选 **Service Token** → 选刚创建的 token
   - 把 Client ID / Secret 填到连接表单里（Secret 会加密保存）

> 通过浏览器弹出 Cloudflare 登录页的那种身份认证（邮箱验证码 / GitHub 登录等）没法在服务端自动完成，所以必须用 Service Token，或者对该主机名不启用 Access（仅靠 SSH 密码/密钥保护，不推荐）。

常见错误：

| 提示 | 原因 |
|---|---|
| HTTP 302 / 401 / 403 | 主机名受 Access 保护，Service Token 未填、填错或策略里没放行 Service Auth |
| HTTP 502 / 530 | 隧道离线、NAS 上 cloudflared 没运行，或 ingress 没指向 `ssh://localhost:22` |
| 认证失败 | 隧道已通，SSH 用户名 / 密码 / 密钥错误 |

## 通过 Cloudflare 隧道把 SSH-WEB 发布到公网（可选）

`docker-compose.yml` 里有注释掉的 `cloudflared` 服务：

1. Zero Trust → Networks → Tunnels 创建隧道，复制 token 填到 `TUNNEL_TOKEN`
2. Public Hostname：`web.example.com → http://ssh-web:8888`（WebSocket 默认支持，不用额外设置）
3. 设置 `COOKIE_SECURE=true`
4. **强烈建议**给 `web.example.com` 加一个 Cloudflare Access 应用（邮箱验证码等），再加上 SSH-WEB 自带的登录，形成两道防线

用群晖 / Nginx Proxy Manager 等做反向代理时，记得开启 WebSocket 支持。

## 安全提示

- 这是一个「能登录你所有服务器」的入口，公网暴露时务必设置强 `AUTH_PASSWORD`，最好再套 Cloudflare Access
- 首次连接时认真核对指纹（`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`），不要关闭指纹校验
- 用 `ALLOWED_HOSTS` 限制可连接范围，防止被当作跳板

## 本地开发

```bash
npm install
AUTH_PASSWORD=test npm start
```

快捷键：`Ctrl+Shift+C` 复制选中内容，鼠标中键关闭标签。
