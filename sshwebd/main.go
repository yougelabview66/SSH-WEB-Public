// sshwebd：SSH-WEB 的终端守护程序 (参考 Orca 的 orcad)。
// 在 Windows 上代替 psmux：终端会话放在一个常驻的守护进程里 (ConPTY)，SSH 断了、网页关了会话还在，重新连上接着用。
// SSH-WEB 用 `sshwebd bridge` 通过一个 SSH 通道直接和守护进程通信 (不经过 sshd 的终端那一层，中文不错位)；
// 在电脑上也能用 `sshwebd attach` 接上同一个会话。
package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"text/tabwriter"
	"time"
)

var version = "0.1.3"

const usage = `sshwebd %s：SSH-WEB 的终端守护程序

用法：
  sshwebd attach [会话]   接上一个会话 (不写：只有一个就接它，没有就新建，多个让你选)；Ctrl+] 离开 (会话继续跑)
      -shell 名字         新建时用的 shell：powershell (默认) / cmd / pwsh，或者整条命令行
  sshwebd new [会话]      新建一个会话并接上
  sshwebd ls              列出会话
  sshwebd kill 会话       结束一个会话
  sshwebd quit            结束守护进程 (还有会话时要加 -f，会话全部结束)
  sshwebd bridge          给 SSH-WEB 用：把标准输入输出 (每行一段 base64) 接到守护进程
  sshwebd serve           运行守护进程 (一般不用手动运行，上面的命令会自动启动)
  sshwebd version
`

func dataDir() string {
	if d := os.Getenv("SSHWEBD_HOME"); d != "" {
		return d
	}
	return filepath.Join(homeDir(), ".ssh-web")
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, usage, version)
		os.Exit(2)
	}
	cmd, args := os.Args[1], os.Args[2:]
	switch cmd {
	case "serve":
		os.Exit(runServe(args))
	case "bridge":
		os.Exit(runBridge())
	case "attach", "a":
		os.Exit(runAttach(args, false))
	case "new":
		os.Exit(runAttach(args, true))
	case "ls", "list":
		os.Exit(runList())
	case "kill":
		os.Exit(runKill(args))
	case "quit":
		os.Exit(runQuit(args))
	case "version", "-v", "--version":
		fmt.Println(version)
	case "help", "-h", "--help":
		fmt.Printf(usage, version)
	default:
		fmt.Fprintf(os.Stderr, "不认识的命令：%s\n\n"+usage, cmd, version)
		os.Exit(2)
	}
}

func runServe(args []string) int {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	defIdle := time.Minute
	if v, err := time.ParseDuration(os.Getenv("SSHWEBD_IDLE")); err == nil {
		defIdle = v
	}
	idle := fs.Duration("idle", defIdle, "没有会话、也没有客户端连着多久后退出")
	buf := fs.Int("buffer", 1<<20, "每个会话记住最近多少字节输出 (接上时补发)")
	spawn := fs.String("spawn", "", "(内部用) 怎么启动的：breakaway = 带着脱离 SSH 会话的作业启动成功，plain = 没能脱离")
	fs.Parse(args)
	os.MkdirAll(dataDir(), 0o700)
	logPath := filepath.Join(dataDir(), "sshwebd.log")
	if st, err := os.Stat(logPath); err == nil && st.Size() > 1<<20 {
		os.Rename(logPath, logPath+".1")
	}
	if f, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
		log.SetOutput(f)
		defer f.Close()
	}
	ln, err := listen()
	if errors.Is(err, errAlreadyRunning) {
		return 0
	}
	if err != nil {
		log.Printf("启动失败：%v", err)
		fmt.Fprintln(os.Stderr, "启动失败：", err)
		return 1
	}
	d := newDaemon(ln, *idle, *buf)
	// 脱离了没有：带着脱离启动成功的就算 (之后还可能在别的作业里)；直接运行的看在不在作业里
	d.detached = *spawn == "breakaway" || (*spawn == "" && !inJob())
	log.Printf("sshwebd %s 启动 (pid %d，启动方式：%s，脱离 SSH 会话：%v，在作业里：%v)", version, os.Getpid(), map[string]string{"breakaway": "脱离作业", "plain": "没能脱离", "": "直接运行"}[*spawn], d.detached, inJob())
	d.serve()
	return 0
}

// 连上守护进程，没在跑就启动一个
func connect() (net.Conn, error) {
	if c, err := dial(); err == nil {
		return c, nil
	}
	if _, err := spawnDaemon(); err != nil {
		return nil, fmt.Errorf("启动守护进程失败：%w", err)
	}
	for i := 0; i < 50; i++ {
		time.Sleep(100 * time.Millisecond)
		if c, err := dial(); err == nil {
			return c, nil
		}
	}
	return nil, fmt.Errorf("守护进程没有启动起来 (看 %s)", filepath.Join(dataDir(), "sshwebd.log"))
}

// 发一个请求，等一条回复
func request(c net.Conn, req Request) (Msg, error) {
	var m Msg
	if err := writeJSON(c, fHello, req); err != nil {
		return m, err
	}
	c.SetReadDeadline(time.Now().Add(10 * time.Second))
	defer c.SetReadDeadline(time.Time{})
	t, p, err := readFrame(c)
	if err != nil {
		return m, err
	}
	if t != fMsg || json.Unmarshal(p, &m) != nil {
		return m, errors.New("守护进程回的内容不对")
	}
	if m.Type == "error" {
		return m, errors.New(m.Error)
	}
	return m, nil
}

// bridge：SSH-WEB 通过一个 SSH 通道 (exec，不要终端) 运行它。先输出一行 SSHWEBD READY <版本>，
// 之后两个方向都是一行一段 base64 (原样传守护进程的帧)：sshd 的默认 shell 是 PowerShell 时，
// 它会把程序的输出当文字按代码页重新解码，原始字节会被改坏，base64 不会 (Orca 也这么做)
func runBridge() int {
	var wmu sync.Mutex
	writeLine := func(s string) {
		wmu.Lock()
		os.Stdout.WriteString(s + "\n")
		wmu.Unlock()
	}
	c, err := connect()
	if err != nil {
		writeLine("SSHWEBD ERROR " + strings.ReplaceAll(err.Error(), "\n", " "))
		return 1
	}
	defer c.Close()
	writeLine("SSHWEBD READY " + version)
	go func() {
		buf := make([]byte, 24<<10)
		for {
			n, err := c.Read(buf)
			if n > 0 {
				writeLine(base64.StdEncoding.EncodeToString(buf[:n]))
			}
			if err != nil {
				os.Exit(0)
			}
		}
	}()
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 64<<10), 8<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		b, err := base64.StdEncoding.DecodeString(line)
		if err != nil {
			continue
		}
		if _, err := c.Write(b); err != nil {
			return 0
		}
	}
	return 0
}

func runList() int {
	c, err := connect()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer c.Close()
	m, err := request(c, Request{Op: "list"})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	printSessions(m.Sessions)
	return 0
}

func ago(ms int64) string {
	if ms == 0 {
		return "-"
	}
	d := time.Since(time.UnixMilli(ms))
	switch {
	case d < time.Minute:
		return "刚刚"
	case d < time.Hour:
		return strconv.Itoa(int(d.Minutes())) + " 分钟前"
	case d < 48*time.Hour:
		return strconv.Itoa(int(d.Hours())) + " 小时前"
	}
	return strconv.Itoa(int(d.Hours()/24)) + " 天前"
}

func printSessions(ss []SessionInfo) {
	if len(ss) == 0 {
		fmt.Println("没有会话")
		return
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "会话\t程序\t标题\t最近输出\t接着的\t开始于")
	for _, s := range ss {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%d\t%s\n", s.ID, s.Shell, s.Title, ago(s.LastOutput), s.Clients, time.UnixMilli(s.Created).Format("01-02 15:04"))
	}
	w.Flush()
}

func runKill(args []string) int {
	if len(args) != 1 {
		fmt.Fprintln(os.Stderr, "用法：sshwebd kill 会话")
		return 2
	}
	c, err := dial()
	if err != nil {
		fmt.Fprintln(os.Stderr, "守护进程没在运行")
		return 1
	}
	defer c.Close()
	if _, err := request(c, Request{Op: "kill", ID: args[0]}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

func runQuit(args []string) int {
	force := len(args) > 0 && (args[0] == "-f" || args[0] == "--force")
	c, err := dial()
	if err != nil {
		return 0
	}
	defer c.Close()
	if _, err := request(c, Request{Op: "quit", Force: force}); err != nil {
		fmt.Fprintln(os.Stderr, err.Error()+" (加 -f 一起结束)")
		return 1
	}
	return 0
}

func runAttach(args []string, fresh bool) int {
	fs := flag.NewFlagSet("attach", flag.ExitOnError)
	shell := fs.String("shell", "", "新建时用的 shell")
	fs.Parse(args)
	id := fs.Arg(0)
	c, err := connect()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer c.Close()
	if id == "" && !fresh {
		m, err := request(c, Request{Op: "list"})
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		switch len(m.Sessions) {
		case 0:
		case 1:
			id = m.Sessions[0].ID
		default:
			printSessions(m.Sessions)
			fmt.Print("接上哪个 (输入会话，直接回车新建)：")
			line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
			id = strings.TrimSpace(line)
		}
	}
	if fresh && id != "" {
		m, _ := request(c, Request{Op: "list"})
		for _, s := range m.Sessions {
			if s.ID == id {
				fmt.Fprintln(os.Stderr, "已经有这个会话了：", id)
				return 1
			}
		}
	}
	cols, rows := termSize()
	cwd, _ := os.Getwd()
	if err := writeJSON(c, fHello, Request{Op: "attach", ID: id, Cols: cols, Rows: rows, Shell: *shell, Cwd: cwd}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	t, p, err := readFrame(c)
	var m Msg
	if err != nil || t != fMsg || json.Unmarshal(p, &m) != nil {
		fmt.Fprintln(os.Stderr, "接不上守护进程")
		return 1
	}
	if m.Type != "attached" {
		fmt.Fprintln(os.Stderr, m.Error)
		return 1
	}
	restore, err := rawTerminal()
	if err != nil {
		fmt.Fprintln(os.Stderr, "终端切不到原始模式：", err)
		return 1
	}
	var wmu sync.Mutex
	send := func(b []byte) error {
		wmu.Lock()
		defer wmu.Unlock()
		_, err := c.Write(b)
		return err
	}
	done := make(chan string, 2)
	stopResize := watchResize(func(cols, rows int) { send(resizeFrame(cols, rows)) })
	go func() {
		for {
			t, p, err := readFrame(c)
			if err != nil {
				done <- "\r\n[和守护进程断开了]\r\n"
				return
			}
			switch t {
			case fOutput:
				os.Stdout.Write(p)
			case fMsg:
				var x Msg
				json.Unmarshal(p, &x)
				if x.Type == "exit" {
					done <- fmt.Sprintf("\r\n[会话 %s 结束了，退出码 %d]\r\n", m.ID, x.Code)
					return
				}
				if x.Type == "error" {
					done <- "\r\n[" + x.Error + "]\r\n"
					return
				}
			}
		}
	}()
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := os.Stdin.Read(buf)
			if n > 0 {
				b := buf[:n]
				if i := indexByte(b, 0x1d); i >= 0 { // Ctrl+]
					if i > 0 {
						send(frame(fInput, b[:i]))
					}
					done <- fmt.Sprintf("\r\n[离开了会话 %s，它还在跑：sshwebd attach %s 接回来]\r\n", m.ID, m.ID)
					return
				}
				if send(frame(fInput, b)) != nil {
					return
				}
			}
			if err != nil {
				if err != io.EOF {
					done <- ""
				}
				return
			}
		}
	}()
	msg := <-done
	stopResize()
	restore()
	os.Stdout.WriteString(msg)
	return 0
}

func indexByte(b []byte, c byte) int {
	for i, x := range b {
		if x == c {
			return i
		}
	}
	return -1
}
