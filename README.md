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

- **后台会话**：SSH 连接保持在服务器上，关闭浏览器 / 断网后再打开，标签、画面和历史输出全部恢复；手机电脑可同时查看同一会话
- 多标签终端（xterm.js），自适应窗口大小、支持中文、链接可点击、手机可用
- 密码 / 私钥（含私钥密码）/ keyboard-interactive 认证
- **二次验证 (TOTP)**：服务器要求验证码时网页弹窗输入，密码仍自动填写
- **主机指纹校验**：类似 OpenSSH known_hosts，首次连接确认指纹，指纹变化时红色警告
- **性能监控**（参考 FinalShell）：CPU、内存、交换、网速曲线、磁盘 IO、分区用量、进程排行
- **历史命令**：自动记录执行过的命令，一键执行 / 填入 / 删除，手机和电脑共享
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
| `BG_TIMEOUT_HOURS` | `0` | 后台会话无人查看超过多少小时自动断开，`0` 为永不（已断开的会话 24 小时后清理） |
| `MAX_SESSIONS` | `30` | 最多同时保留的后台会话数 |
| `SCROLLBACK` | `5000` | 每个后台会话保留的滚动行数（用于恢复画面） |
| `HISTORY_MAX` | `1000` | 历史命令最多保存条数 |
| `HOSTKEY_POLICY` | `ask` | 主机指纹校验：`ask` 新主机和指纹变化都要确认；`accept-new` 新主机自动信任、变化时确认；`off` 不校验 |

数据都在 `./data`：`hosts.json`（主机列表，密码加密）、`known_hosts.json`（已信任的主机指纹）、`history.json`（历史命令）和 `.secret`，备份这个目录即可。

## 手机使用

手机 / 平板（触屏设备）连接后，底部会出现输入栏和特殊键：

- 点终端或输入栏弹出键盘，输入的内容实时发送；中文 / 联想输入在上屏后发送
- 回车键（输入法的「发送」）发送回车；输入栏为空时按退格会删除终端里的字符
- 特殊键：`历史` `Esc` `Tab` `Shift` `Ctrl` `Alt` 方向键 `Home` `End` `PgUp` `PgDn` `| / - ~` `^C` `^D` `^Z` `^L` 和粘贴
- `Shift` / `Ctrl` / `Alt` 点一下高亮，作用于下一个按键或字符，可以组合：例如 `Ctrl` + `c`、`Shift` + `Tab`（Claude Code 切换模式）、`Shift` + `↑`
- 粘贴：通过 HTTPS 访问时直接读取剪贴板，HTTP 下浏览器不允许读取，会弹出输入框让你粘贴

- **滑动查看历史**：普通界面直接滑动；Claude Code、vim 等支持鼠标的程序会收到滚轮事件自己滚动
- **tmux**：tmux 默认没开鼠标，滑动时会弹出提示，点「开启 tmux 鼠标滚动」即可（在目标主机执行 `tmux set -g mouse on`，不会往终端里打字）。
  tmux 重启后需要重新开启；想永久生效，在目标主机的 `~/.tmux.conf` 加一行 `set -g mouse on`

> 手机浏览器直接在 xterm.js 里打字会丢字、重复或不弹键盘，所以触屏设备改用这个输入栏。电脑端不受影响。

## 后台会话

SSH 连接由服务器保持，浏览器只是「挂载」上去查看和操作：

- **关闭浏览器 / 刷新 / 断网**：SSH 继续在服务器上运行（正在跑的命令不会中断），再打开网页时自动恢复所有标签、顺序和上次所在的标签，画面与滚动记录原样还原（vim、top 等全屏程序也可以）
- **多设备**：手机和电脑可以同时打开同一个会话，输入输出实时同步；验证码在一台设备上回答后，其他设备的弹窗自动关闭
- **关闭标签（×）** 才会真正断开 SSH，并在所有设备上同步关闭
- **SSH 自己断开**（主机重启、超时等）：保留记录，点「重新连接」用同样的参数重连，历史输出还在
- 网络中断时浏览器会自动重新挂载，不需要手动操作

> 后台会话保存在 SSH-WEB 进程的内存里，**重启容器会断开所有会话**（标签会保留并提示「后台会话已不存在」，已保存的主机可一键重新连接）。
> 没有保存到主机列表的连接，重新连接需要的密码只保存在内存中。

## 性能监控

连接后点标签栏的「📊 监控」，终端左侧展开面板（手机上全屏显示），每 2 秒刷新：

- 主机名、系统版本、内核、运行时间、负载
- CPU 使用率（用户 / 系统 / IO 等待）、核心数、温度（有传感器时）
- 内存、缓存、交换分区用量；超过 75% 变黄、90% 变红
- 网络上传 / 下载速度与最近 2 分钟曲线（鼠标悬停看数值），可切换网卡
- 磁盘读写速度、各分区用量
- 进程排行 Top 15，可按 CPU 或内存排序

实现方式：复用当前终端的 SSH 连接执行一段只读脚本（读取 `/proc`、`df`），不需要在目标主机安装任何东西，
兼容群晖等 BusyBox 系统；每次约 6KB 流量。只有当前标签且面板打开时才采集，切换标签或关闭面板即停止。
仅支持 Linux 主机，路由器等不支持的设备会显示提示。

## 历史命令

点标签栏的「🕘 历史」（手机上也可以点输入栏上方的「历史」键）打开：

- **执行**（或点命令本身）：直接运行；**填入**：只填到终端里，可以修改后再回车；**✕**：删除这一条
- 默认只显示当前主机的记录，勾选「全部主机」查看所有；支持搜索；「清空」清除当前主机或全部记录
- 记录保存在服务器 `data/history.json`，手机和电脑共享，同一主机的相同命令只保留一条并显示执行次数

记录方式：按回车时读取终端上显示的这一行命令（去掉提示符），所以 Tab 补全、↑ 调出的命令都能正确记录。以下情况**不会**记录：

- 以空格开头的命令（与 bash 的 `HISTCONTROL=ignorespace` 相同，适合含密码的命令）
- 密码输入（sudo、`read -s` 等）以及 vim / top 等全屏程序里的输入
- 提示符不是以 `$` `#` `%` `>` `❯` 加空格结尾的 shell
- 网络延迟很大时，在上一条命令的回显出现之前就盲打并回车的下一条命令

> 历史命令以明文保存，命令里如果带了密码，请在前面加一个空格，或执行后在历史里删除。

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
