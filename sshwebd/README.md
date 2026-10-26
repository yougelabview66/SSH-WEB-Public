# sshwebd

SSH-WEB 的终端守护程序（「常驻会话」，在 SSH-WEB 项目的 `sshwebd/` 目录），支持 Windows 和 Linux，参考 [Orca](https://github.com/stablyai/orca) 的 `orcad`。
在 Windows 主机上代替 psmux、在 Linux 主机上代替 tmux 保住会话：终端会话放在一个常驻的守护进程里，SSH 断了、网页标签关了，终端里的程序（比如 Claude Code）照样跑，重新连上接着用。

## 为什么不用 psmux

- **断线后会话丢失**：Windows 自带的 OpenSSH 在 SSH 断开时会结束这次登录开的所有进程（整个作业对象）。sshwebd 启动守护进程时带上 `CREATE_BREAKAWAY_FROM_JOB`，脱离这个作业，所以 SSH 断了守护进程和里面的终端都还在（Orca 也是这么做的）。
- **中文错位、画面乱**：psmux 跑在 sshd 自己开的终端（ConPTY）里面，终端里再套一层终端，两层 ConPTY 各自重画，容易错位。SSH-WEB 用 `sshwebd bridge` 通过一个**不要终端**的 SSH 通道直接和守护进程通信，只有守护进程这一层 ConPTY。
- **省资源**：Go 写的单个 exe（约 3.5 MB），不依赖 Node / Python。守护进程空闲时只占几 MB 内存；没有会话、也没人连着超过 1 分钟就自己退出。

## 怎么工作

```
SSH-WEB ──SSH exec 通道 (不要终端)── sshwebd bridge ──命名管道── sshwebd serve (守护进程)
                一行一段 base64                          \\.\pipe\sshwebd-v1-<用户名>     └─ 会话 1：ConPTY + powershell
                                                                                         └─ 会话 2：ConPTY + cmd …
电脑上的终端 ── sshwebd attach ──命名管道──┘
```

- **守护进程（serve）**：
  - 每个会话一个 ConPTY，记住最近 1 MB 输出。
  - 客户端接上时补发；带上次收到的位置，就只补发没收到的。
  - 同时记下这段输出期间终端大小的变化（在输出的第几个字节变成几列几行）。SSH-WEB 接上时要了的话（0.1.8 起），补发里在同样的位置夹着当时的大小，它照着改大小重放，服务重启、换个标签接上以后历史不乱。
  - 同一个会话可以几个客户端一起接，终端大小按最近一次设置的；一个客户端改了大小，也告诉别的要了大小的客户端。
  - 会话里的程序都放在一个作业对象里，会话结束时连同子进程一起结束。
  - 新开的 cmd / PowerShell 先把代码页切到 UTF-8（`chcp 65001`），直接写 UTF-8 的程序中文才不乱。
- **bridge**：
  - 守护进程没在跑就先启动它。
  - 输出一行 `SSHWEBD READY <版本>`，之后两个方向都是一行一段 base64。原因是 sshd 的默认 shell 是 PowerShell 时，会把程序的输出当文字按代码页重新解码，原始字节会被改坏（Orca 的经验）。
- **命名管道**：只有自己这个用户能连。管道带一个中等完整性标签：管理员账号通过 SSH 启动的守护进程是高权限的，不加这个标签，桌面上普通权限的终端连不上。
- **不用 `powershell -EncodedCommand`**：它是 Windows Defender 的报警项。SSH-WEB 直接执行 `sshwebd-v<版本>.exe bridge`。

## 和 SSH-WEB 一起用

1. 在 SSH-WEB 里编辑这台主机（Windows 或 Linux），勾上「常驻会话」（新建主机默认勾着）。
2. 连接时 SSH-WEB 自动把 sshwebd.exe 传到这台主机的 `~/.ssh-web/sshwebd-v<版本>.exe`（如 `sshwebd-v0.1.6.exe`；已经有了就不传；同一个版本重新编过、正在运行的又换不掉时传成 `sshwebd-v0.1.6-2.exe`）。版本号来自编出来的文件旁边的 `version.txt`（构建 Docker 镜像时写），没有就读 `main.go` 里的 `version`。exe 是构建 Docker 镜像时从这个目录的源码编出来的；不用 Docker、直接跑 SSH-WEB 源码时，先按下面「编译」编出 `sshwebd/sshwebd.exe`，或者自己把 exe 放到主机的 `%USERPROFILE%\.ssh-web\sshwebd.exe`。
3. **新开标签**：新建一个会话（默认 PowerShell）。主机上有常驻会话时会弹出列表问你接哪个（还有连接的也列出来、标明在哪接着，接上或删除前先问要不要强制），也可以新建或者退出（关掉这个标签）。
4. **断线后**：这个标签重新连上，自动接回原来的会话，只补发断开期间的输出。
5. **关了标签**：会话还在。下次新开标签时可以选它接上；在会话里 `exit` 才会结束它。

## 命令

```
sshwebd attach [会话]   接上一个会话（不写：只有一个就接它，没有就新建，多个让你选）；Ctrl+] 离开（会话继续跑）
    -shell 名字         新建时用的 shell：powershell（默认）/ cmd / pwsh，或者整条命令行
sshwebd new [会话]      新建一个会话并接上
sshwebd ls              列出会话
sshwebd kill 会话       结束一个会话 (-t 标记：别的标记的客户端还接着就不结束)
sshwebd quit [-f]       结束守护进程（还有会话时要加 -f，会话全部结束）
sshwebd bridge          给 SSH-WEB 用
sshwebd serve           运行守护进程（一般不用手动运行，上面的命令会自动启动）
```

在电脑上打开终端（Windows Terminal 等），运行 `%USERPROFILE%\.ssh-web\sshwebd-v<版本>.exe attach`（文件名看 `.ssh-web` 文件夹里的），就能接上手机上开的同一个会话；两边可以同时用。

日志在 `%USERPROFILE%\.ssh-web\sshwebd.log`。

## 编译

在这个目录下：

```
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o sshwebd.exe .
go test ./...        # 在 Linux 上真跑一遍（守护进程、bridge、断开重连、补发、几个客户端、退出码、空闲退出）
```

SSH-WEB 的 `node test/run.js sshwebd` 会跑 go vet 和这些测试；`daemonwin` 测试用这里的源码编出 Linux 版，接到 SSH-WEB 上真跑。

Linux 版用系统的 pty（SSH-WEB 的 Docker 镜像里编了 amd64 / arm64 / armv7，连接时按 `uname -m` 传过去）；macOS 也能编译，但 SSH-WEB 还不会自动传。Windows 版需要 Windows 10 1809 及以上（ConPTY）。

Linux 上常驻会话里开不开 tmux 都行，见 SSH-WEB 的 docs/功能详细说明.md。个别发行版 systemd 设了 `KillUserProcesses=yes` 时，SSH 断开会结束用户的所有进程，要执行一次 `loginctl enable-linger`。

