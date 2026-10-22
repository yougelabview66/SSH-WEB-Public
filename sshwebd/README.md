# sshwebd

SSH-WEB 的 Windows 终端守护程序（在 SSH-WEB 项目的 `sshwebd/` 目录），参考 [Orca](https://github.com/stablyai/orca) 的 `orcad`。
在 Windows 主机上代替 psmux：终端会话放在一个常驻的守护进程里，SSH 断了、网页标签关了，终端里的程序（比如 Claude Code）照样跑，重新连上接着用。

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
  - 同一个会话可以几个客户端一起接，终端大小按最近一次设置的。
  - 会话里的程序都放在一个作业对象里，会话结束时连同子进程一起结束。
  - 新开的 cmd / PowerShell 先把代码页切到 UTF-8（`chcp 65001`），直接写 UTF-8 的程序中文才不乱。
- **bridge**：
  - 守护进程没在跑就先启动它。
  - 输出一行 `SSHWEBD READY <版本>`，之后两个方向都是一行一段 base64。原因是 sshd 的默认 shell 是 PowerShell 时，会把程序的输出当文字按代码页重新解码，原始字节会被改坏（Orca 的经验）。
- **命名管道**：只有自己这个用户能连。管道带一个中等完整性标签：管理员账号通过 SSH 启动的守护进程是高权限的，不加这个标签，桌面上普通权限的终端连不上。
- **不用 `powershell -EncodedCommand`**：它是 Windows Defender 的报警项。SSH-WEB 直接执行 `sshwebd-<哈希>.exe bridge`。

## 和 SSH-WEB 一起用

1. 在 SSH-WEB 里编辑这台 Windows 主机，勾上「Windows 常驻会话」。
2. 连接时 SSH-WEB 自动把 sshwebd.exe 传到这台主机的 `~/.ssh-web/sshwebd-<哈希>.exe`（已经有了就不传；换个名字是因为正在运行的 exe 不能覆盖）。exe 是构建 Docker 镜像时从这个目录的源码编出来的；不用 Docker、直接跑 SSH-WEB 源码时，先按下面「编译」编出 `sshwebd/sshwebd.exe`，或者自己把 exe 放到主机的 `%USERPROFILE%\.ssh-web\sshwebd.exe`。
3. **新开标签**：新建一个会话（默认 PowerShell）。如果有没人接着的会话，会弹窗问你接哪个，空着就新建。
4. **断线后**：这个标签重新连上，自动接回原来的会话，只补发断开期间的输出。
5. **关了标签**：会话还在。下次新开标签时可以选它接上；在会话里 `exit` 才会结束它。

## 命令

```
sshwebd attach [会话]   接上一个会话（不写：只有一个就接它，没有就新建，多个让你选）；Ctrl+] 离开（会话继续跑）
    -shell 名字         新建时用的 shell：powershell（默认）/ cmd / pwsh，或者整条命令行
sshwebd new [会话]      新建一个会话并接上
sshwebd ls              列出会话
sshwebd kill 会话       结束一个会话
sshwebd quit [-f]       结束守护进程（还有会话时要加 -f，会话全部结束）
sshwebd bridge          给 SSH-WEB 用
sshwebd serve           运行守护进程（一般不用手动运行，上面的命令会自动启动）
```

在电脑上打开终端（Windows Terminal 等），运行 `%USERPROFILE%\.ssh-web\sshwebd-<哈希>.exe attach`（文件名看 `.ssh-web` 文件夹里的），就能接上手机上开的同一个会话；两边可以同时用。

日志在 `%USERPROFILE%\.ssh-web\sshwebd.log`。

## 编译

在这个目录下：

```
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o sshwebd.exe .
go test ./...        # 在 Linux 上真跑一遍（守护进程、bridge、断开重连、补发、几个客户端、退出码、空闲退出）
```

SSH-WEB 的 `node test/run.js sshwebd` 会跑 go vet 和这些测试；`daemonwin` 测试用这里的源码编出 Linux 版，接到 SSH-WEB 上真跑。

Linux / macOS 也能编译（用系统的 pty，主要拿来测试）。Windows 版需要 Windows 10 1809 及以上（ConPTY）。

