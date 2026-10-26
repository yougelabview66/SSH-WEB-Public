//go:build !windows

package main

// 在 Linux 上真跑一遍：编出 sshwebd，用 bridge (和 SSH-WEB 一样，一行一段 base64) 自动启动守护进程、开会话、打字、
// 断开再接上 (只补发没收到的)、两个客户端一起接、改大小、标题、退出码、结束会话、没事做了自己退出

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

var bin string

func TestMain(m *testing.M) {
	dir, _ := os.MkdirTemp("", "sshwebd-bin-")
	bin = filepath.Join(dir, "sshwebd")
	if out, err := exec.Command("go", buildArgs(bin)...).CombinedOutput(); err != nil {
		os.Stderr.Write(out)
		os.Exit(1)
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

// 一个 bridge 客户端 (模拟 SSH-WEB)
type bridge struct {
	t     *testing.T
	cmd   *exec.Cmd
	in    io.WriteCloser
	mu    sync.Mutex
	out   bytes.Buffer // 收到的终端输出
	msgs  []Msg
	ready string
	buf   []byte
	done  chan struct{}
	// 按收到的顺序记下每一帧：输出 (O:文字)、大小变化 (Z:列x行)、消息 (M:类型)
	events []string
}

func env(home string) []string {
	return append(os.Environ(), "SSHWEBD_HOME="+home, "SSHWEBD_IDLE=1s", "PS1=$ ", "ENV=")
}

func startBridge(t *testing.T, home string) *bridge {
	b := &bridge{t: t, done: make(chan struct{})}
	b.cmd = exec.Command(bin, "bridge")
	b.cmd.Env = env(home)
	b.in, _ = b.cmd.StdinPipe()
	stdout, _ := b.cmd.StdoutPipe()
	if err := b.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 1<<20), 16<<20)
	if !sc.Scan() {
		t.Fatal("bridge 没有输出")
	}
	b.ready = sc.Text()
	go func() {
		defer close(b.done)
		for sc.Scan() {
			raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(sc.Text()))
			if err != nil {
				t.Errorf("不是 base64：%q", sc.Text())
				continue
			}
			b.mu.Lock()
			b.buf = append(b.buf, raw...)
			for len(b.buf) >= 5 {
				n := int(b.buf[1])<<24 | int(b.buf[2])<<16 | int(b.buf[3])<<8 | int(b.buf[4])
				if len(b.buf) < 5+n {
					break
				}
				typ, p := b.buf[0], b.buf[5:5+n]
				if typ == fOutput {
					b.out.Write(p)
					b.events = append(b.events, "O:"+string(p))
				} else if typ == fMsg {
					var m Msg
					json.Unmarshal(p, &m)
					b.msgs = append(b.msgs, m)
					b.events = append(b.events, "M:"+m.Type)
				} else if typ == fSize {
					cols, rows, _ := parseResize(p)
					b.events = append(b.events, "Z:"+strconv.Itoa(cols)+"x"+strconv.Itoa(rows))
				}
				b.buf = b.buf[5+n:]
			}
			b.mu.Unlock()
		}
	}()
	return b
}

func (b *bridge) send(f []byte) {
	io.WriteString(b.in, base64.StdEncoding.EncodeToString(f)+"\r\n")
}
func (b *bridge) req(r Request)   { b.send(jsonFrame(fHello, r)) }
func (b *bridge) typ(s string)    { b.send(frame(fInput, []byte(s))) }
func (b *bridge) text() string    { b.mu.Lock(); defer b.mu.Unlock(); return b.out.String() }
func (b *bridge) close()          { b.in.Close(); b.cmd.Wait() }
func (b *bridge) received() int64 { b.mu.Lock(); defer b.mu.Unlock(); return int64(b.out.Len()) }
func (b *bridge) lastMsg(typ string) *Msg {
	b.mu.Lock()
	defer b.mu.Unlock()
	for i := len(b.msgs) - 1; i >= 0; i-- {
		if b.msgs[i].Type == typ {
			m := b.msgs[i]
			return &m
		}
	}
	return nil
}

func waitFor(t *testing.T, what string, fn func() bool) {
	t.Helper()
	for end := time.Now().Add(8 * time.Second); time.Now().Before(end); time.Sleep(30 * time.Millisecond) {
		if fn() {
			return
		}
	}
	t.Fatalf("等不到：%s", what)
}

func TestBridgeSession(t *testing.T) {
	home := t.TempDir()
	b := startBridge(t, home)
	if b.ready != "SSHWEBD READY "+version {
		t.Fatalf("第一行应该是 READY：%q", b.ready)
	}
	b.req(Request{Op: "list"})
	waitFor(t, "列表", func() bool { return b.lastMsg("list") != nil })
	b.req(Request{Op: "attach", Shell: "/bin/sh", Cols: 100, Rows: 30, Env: map[string]string{"LC_SSHWEB": "tab-1"}})
	waitFor(t, "attached", func() bool { return b.lastMsg("attached") != nil })
	a := b.lastMsg("attached")
	if !a.Created || a.ID != "1" || a.Start != 0 {
		t.Fatalf("新建的会话：%+v", a)
	}
	b.typ("echo hi-$((1+2)) $LC_SSHWEB $SSHWEBD_SESSION\r")
	waitFor(t, "命令输出", func() bool { return strings.Contains(b.text(), "hi-3 tab-1 1") })
	b.typ("printf '\\033]0;my-title\\007'; stty size\r")
	waitFor(t, "stty size", func() bool { return strings.Contains(b.text(), "30 100") })

	// 断开：会话还在。断开前让它过一会儿再输出，接上时补发
	b.typ("sleep 0.5; echo later-$((2*21))\r")
	time.Sleep(100 * time.Millisecond)
	got := b.received()
	b.close()
	time.Sleep(900 * time.Millisecond)

	b2 := startBridge(t, home)
	b2.req(Request{Op: "list"})
	waitFor(t, "列表", func() bool { return b2.lastMsg("list") != nil })
	l := b2.lastMsg("list")
	if len(l.Sessions) != 1 || l.Sessions[0].Clients != 0 || l.Sessions[0].Title != "my-title" {
		t.Fatalf("断开后会话还在、没人接着、记着标题：%+v", l.Sessions)
	}
	b2.req(Request{Op: "attach", ID: "1", Since: &got, Cols: 100, Rows: 30})
	waitFor(t, "补发断开期间的输出", func() bool { return strings.Contains(b2.text(), "later-42") })
	a2 := b2.lastMsg("attached")
	if a2.Created || a2.Start != got {
		t.Fatalf("接上已有的会话，从收到的位置补发：%+v (收到 %d)", a2, got)
	}
	if strings.Contains(b2.text(), "hi-3") {
		t.Fatal("已经收到过的不该再发")
	}

	// 第二个客户端一起接 (不带 since = 全部补发)，改大小
	b3 := startBridge(t, home)
	b3.req(Request{Op: "attach", ID: "1", NoCreate: true, Cols: 80, Rows: 20})
	waitFor(t, "全部补发", func() bool { return strings.Contains(b3.text(), "hi-3") && strings.Contains(b3.text(), "later-42") })
	b3.typ("stty size\r")
	waitFor(t, "两个都收到", func() bool { return strings.Contains(b3.text(), "20 80") && strings.Contains(b2.text(), "20 80") })
	b2.send(resizeFrame(90, 25))
	b2.typ("stty size\r")
	waitFor(t, "改大小", func() bool { return strings.Contains(b3.text(), "25 90") })

	// 不存在的会话 + NoCreate：报错
	b4 := startBridge(t, home)
	b4.req(Request{Op: "attach", ID: "nope", NoCreate: true})
	waitFor(t, "报错", func() bool { return b4.lastMsg("error") != nil })
	b4.close()

	// 退出：两个客户端都收到退出码
	b3.typ("exit 3\r")
	waitFor(t, "退出码", func() bool { m := b2.lastMsg("exit"); return m != nil && m.Code == 3 && b3.lastMsg("exit") != nil })
	<-b2.done
	<-b3.done
	b2.close()
	b3.close()

	// 没有会话、没有客户端：1 秒后守护进程自己退出 (socket 没人听了)
	time.Sleep(2500 * time.Millisecond)
	if c, err := dialEnv(home); err == nil {
		c.Close()
		t.Fatal("守护进程应该已经退出")
	}
	log, _ := os.ReadFile(filepath.Join(home, "sshwebd.log"))
	if !strings.Contains(string(log), "没有会话了，退出") {
		t.Fatalf("日志：%s", log)
	}
}

func TestKillAndCLI(t *testing.T) {
	home := t.TempDir()
	b := startBridge(t, home)
	b.req(Request{Op: "attach", ID: "work", Shell: "/bin/sh"})
	waitFor(t, "attached", func() bool { return b.lastMsg("attached") != nil })
	b.typ("sleep 100 & echo started\r")
	waitFor(t, "started", func() bool { return strings.Contains(b.text(), "started") })
	run := func(args ...string) string {
		c := exec.Command(bin, args...)
		c.Env = env(home)
		out, _ := c.CombinedOutput()
		return string(out)
	}
	if out := run("ls"); !strings.Contains(out, "work") || !strings.Contains(out, "/bin/sh") {
		t.Fatalf("ls：%s", out)
	}
	if out := run("quit"); !strings.Contains(out, "还有 1 个会话") {
		t.Fatalf("还有会话时 quit 不退出：%s", out)
	}
	run("kill", "work")
	waitFor(t, "被结束", func() bool { return b.lastMsg("exit") != nil })
	if out := run("ls"); !strings.Contains(out, "没有会话") {
		t.Fatalf("结束后：%s", out)
	}
	b.close()
}

func TestBridgeKilled(t *testing.T) {
	// SSH 断开时 bridge 被直接杀掉：会话不受影响
	home := t.TempDir()
	b := startBridge(t, home)
	b.req(Request{Op: "attach", ID: "s", Shell: "/bin/sh"})
	waitFor(t, "attached", func() bool { return b.lastMsg("attached") != nil })
	b.cmd.Process.Kill()
	b.cmd.Wait()
	b2 := startBridge(t, home)
	b2.req(Request{Op: "attach", ID: "s", NoCreate: true})
	waitFor(t, "接回来", func() bool { return b2.lastMsg("attached") != nil })
	b2.typ("exit\r")
	waitFor(t, "退出", func() bool { return b2.lastMsg("exit") != nil })
	b2.close()
}

func TestRing(t *testing.T) {
	r := newRing(100)
	r.write([]byte(strings.Repeat("a", 60) + "\n"))
	r.write([]byte(strings.Repeat("b", 30) + "\nccc"))
	if r.total != 95 || r.start() != 0 {
		t.Fatal(r.total, r.start())
	}
	r.write([]byte(strings.Repeat("d", 20)))
	// 超过 100：丢掉前面，从换行后开始
	if r.total != 115 || r.buf[0] != 'b' || r.start() != 61 {
		t.Fatalf("total=%d start=%d buf=%q", r.total, r.start(), r.buf)
	}
	at := int64(100)
	s, out := r.since(&at)
	if s != 100 || string(out) != strings.Repeat("d", 15) {
		t.Fatal(s, string(out))
	}
	at = 10 // 已经丢了：从缓冲开头
	if s, _ := r.since(&at); s != 61 {
		t.Fatal(s)
	}
	at = 999
	if s, out := r.since(&at); s != 115 || len(out) != 0 {
		t.Fatal(s, len(out))
	}
}

// 大小变化跟着输出的位置记：补发从哪开始，就从那一刻的大小开始，缓冲丢掉前面以后也留着开头那一刻的大小
func TestRingMarks(t *testing.T) {
	r := newRing(100)
	r.mark(80, 24)
	r.write([]byte(strings.Repeat("a", 40) + "\n")) // 0..41
	r.mark(60, 20)
	r.mark(50, 20)                                  // 中间没有输出：只算最后一次
	r.write([]byte(strings.Repeat("b", 40) + "\n")) // 41..82
	if got := r.marksFrom(0); len(got) != 2 || got[0] != (sizeMark{0, 80, 24}) || got[1] != (sizeMark{41, 50, 20}) {
		t.Fatalf("从头补发：%+v", got)
	}
	if got := r.marksFrom(60); len(got) != 1 || got[0] != (sizeMark{60, 50, 20}) {
		t.Fatalf("从中间补发：应该只有那一刻的大小 %+v", got)
	}
	r.write([]byte(strings.Repeat("c", 40) + "\n")) // 超过 100，丢掉前面 (从 b 那行之后开始)
	if r.start() != 82 {
		t.Fatalf("start=%d", r.start())
	}
	if len(r.marks) != 1 || r.marks[0] != (sizeMark{41, 50, 20}) {
		t.Fatalf("缓冲丢掉前面以后：只留开头那一刻的大小 %+v", r.marks)
	}
	if got := r.marksFrom(r.start()); len(got) != 1 || got[0] != (sizeMark{82, 50, 20}) {
		t.Fatalf("从缓冲开头补发：%+v", got)
	}
	for i := 0; i < maxMarks+10; i++ {
		r.write([]byte("x"))
		r.mark(100+i%7, 30)
	}
	if len(r.marks) > maxMarks {
		t.Fatalf("大小变化没封顶：%d", len(r.marks))
	}
}

// 要了 sizes 的客户端：补发里在改大小的位置夹着 Z，补完有 replayed；别的客户端改了大小也告诉它。没要的收不到 Z
func TestSizesReplay(t *testing.T) {
	home := t.TempDir()
	a := startBridge(t, home)
	defer a.close()
	a.req(Request{Op: "attach", Shell: "/bin/sh", Cols: 100, Rows: 30, Sizes: true})
	waitFor(t, "a 接上", func() bool { return a.lastMsg("replayed") != nil })
	a.typ("echo BEFORE-$((1+1))\r")
	waitFor(t, "改大小前的输出", func() bool { return strings.Contains(a.text(), "BEFORE-2") })
	old := startBridge(t, home) // 旧的客户端 (没要 sizes)
	defer old.close()
	old.req(Request{Op: "attach", ID: "1", NoCreate: true, Cols: 100, Rows: 30})
	waitFor(t, "old 接上", func() bool { return old.lastMsg("attached") != nil })
	a.send(resizeFrame(60, 20))
	time.Sleep(300 * time.Millisecond)
	a.typ("echo AFTER-$((2+1))\r")
	waitFor(t, "改大小后的输出", func() bool { return strings.Contains(a.text(), "AFTER-3") })
	a.mu.Lock()
	if strings.Contains(strings.Join(a.events, "\n"), "Z:60x20") { // 补发里那个 Z:100x30 是一开始的大小，不算
		t.Errorf("自己改的大小不用再告诉自己：%q", a.events)
	}
	a.mu.Unlock()
	// 新接上、从头补发：开头是一开始的大小，BEFORE 在 Z:60x20 前面、AFTER 在后面，最后是 replayed
	c := startBridge(t, home)
	defer c.close()
	c.req(Request{Op: "attach", ID: "1", NoCreate: true, Cols: 100, Rows: 30, Sizes: true})
	waitFor(t, "c 补发完", func() bool { return c.lastMsg("replayed") != nil })
	c.mu.Lock()
	ev := strings.Join(c.events, "\n")
	c.mu.Unlock()
	iz0, iz, ib, ia, ir := strings.Index(ev, "Z:100x30"), strings.Index(ev, "Z:60x20"), strings.LastIndex(ev, "BEFORE-2"), strings.LastIndex(ev, "AFTER-3"), strings.Index(ev, "M:replayed")
	if !(iz0 >= 0 && iz0 < ib && ib < iz && iz < ia && ia < ir) {
		t.Fatalf("补发的顺序不对 (应该 Z:100x30 … BEFORE-2 … Z:60x20 … AFTER-3 … M:replayed)：%q", ev)
	}
	// c 接上时把大小改回 100x30：要大小的 a 收到 Z:100x30，旧的客户端什么也收不到
	waitFor(t, "a 收到别人改的大小", func() bool {
		a.mu.Lock()
		defer a.mu.Unlock()
		return strings.Contains(strings.Join(a.events, "\n"), "Z:100x30")
	})
	old.mu.Lock()
	for _, e := range old.events {
		if strings.HasPrefix(e, "Z:") || e == "M:replayed" {
			t.Errorf("没要 sizes 的客户端不该收到 %q", e)
		}
	}
	old.mu.Unlock()
}

func dialEnv(home string) (io.Closer, error) {
	os.Setenv("SSHWEBD_HOME", home)
	defer os.Unsetenv("SSHWEBD_HOME")
	return dial()
}

// SSHWEBD_RACE=1：守护进程也用竞态检测编 (go test -race 只管测试本身)
func buildArgs(out string) []string {
	if os.Getenv("SSHWEBD_RACE") == "1" {
		return []string{"build", "-race", "-o", out, "."}
	}
	return []string{"build", "-o", out, "."}
}

// 输出里的终端标题 (OSC 0 / 2) 和当前目录 (OSC 9;9，Windows Terminal 的写法；OSC 7 file://) 记下来，列表里显示
func TestScanOsc(t *testing.T) {
	s := &session{}
	s.scanOsc([]byte("x\x1b]0;✳ 修复登录\x07y\x1b]9;9;\"D:\\code\\my-app\"\x1b\\PS D:\\code\\my-app> "))
	if s.title != "✳ 修复登录" || s.cwd != `D:\code\my-app` {
		t.Fatalf("标题 / 目录不对：%q %q", s.title, s.cwd)
	}
	s.scanOsc([]byte("\x1b]7;file://host/tmp/a%20b\x07"))
	if s.cwd != "/tmp/a b" {
		t.Fatalf("OSC 7 的目录不对：%q", s.cwd)
	}
	s.scanOsc([]byte("\x1b]9;4;3;50\x07")) // 进度条，不是目录
	if s.cwd != "/tmp/a b" {
		t.Fatalf("进度条被当成目录：%q", s.cwd)
	}
}

// 接上时带标记 (SSH-WEB 的标签)：列表里带出来；同一个标记再接上时，旧连接被踢掉 (断网后主机上还没断开的那条)
func TestClientTags(t *testing.T) {
	home := t.TempDir()
	a := startBridge(t, home)
	defer a.close()
	a.req(Request{Op: "attach", Shell: "/bin/sh", Cols: 80, Rows: 24, Tag: "tab-a"})
	waitFor(t, "a 接上", func() bool { return a.lastMsg("attached") != nil })
	b := startBridge(t, home)
	defer b.close()
	b.req(Request{Op: "attach", ID: "1", NoCreate: true, Cols: 80, Rows: 24, Tag: "tab-b"})
	waitFor(t, "b 接上", func() bool { return b.lastMsg("attached") != nil })
	tagsOf := func() []string {
		c := startBridge(t, home)
		defer c.close()
		c.req(Request{Op: "list"})
		waitFor(t, "列表", func() bool { return c.lastMsg("list") != nil })
		l := c.lastMsg("list")
		if len(l.Sessions) != 1 {
			t.Fatalf("会话数不对：%+v", l.Sessions)
		}
		tags := append([]string(nil), l.Sessions[0].Tags...)
		sort.Strings(tags)
		return tags
	}
	if got := strings.Join(tagsOf(), ","); got != "tab-a,tab-b" {
		t.Fatalf("列表里的标记不对：%q", got)
	}
	// tab-a 断网重连：新连接带同一个标记，旧的 (a) 被踢掉，b 还在
	a2 := startBridge(t, home)
	defer a2.close()
	a2.req(Request{Op: "attach", ID: "1", NoCreate: true, Cols: 80, Rows: 24, Tag: "tab-a"})
	waitFor(t, "a2 接上", func() bool { return a2.lastMsg("attached") != nil })
	waitFor(t, "旧的 a 被踢掉 (它的 bridge 跟着退出)", func() bool { return exited(a) })
	if got := strings.Join(tagsOf(), ","); got != "tab-a,tab-b" {
		t.Fatalf("重连以后的标记不对 (旧的 a 应该被踢掉，只剩新的 a 和 b)：%q", got)
	}
	// tab-a 关标签时要结束会话 (带自己的标记)：b 还接着，不结束
	if err := d0kill(t, home, "tab-a"); err == nil || err.Error() != errInUse {
		t.Fatalf("别的标签还接着时带标记结束应该被拒绝：%v", err)
	}
	if got := strings.Join(tagsOf(), ","); got != "tab-a,tab-b" {
		t.Fatalf("被拒绝后会话应该还在：%q", got)
	}
	// b 走了以后：只剩自己，结束
	b.close()
	waitFor(t, "b 断开", func() bool { return len(tagsOf()) == 1 })
	if err := d0kill(t, home, "tab-a"); err != nil {
		t.Fatalf("只有自己接着时应该能结束：%v", err)
	}
	waitFor(t, "a2 收到会话结束", func() bool { return a2.lastMsg("exit") != nil })
}

// 带标记结束会话 1 (同 sshwebd kill -t 标记 1)
func d0kill(t *testing.T, home, tag string) error {
	c := startBridge(t, home)
	defer c.close()
	c.req(Request{Op: "kill", ID: "1", Tag: tag})
	var m *Msg
	waitFor(t, "kill 的回复", func() bool {
		m = c.lastMsg("ok")
		if m == nil {
			m = c.lastMsg("error")
		}
		return m != nil
	})
	if m.Type == "error" {
		return errors.New(m.Error)
	}
	return nil
}

// bridge 进程已经退出了 (守护进程断开了它)
func exited(b *bridge) bool {
	select {
	case <-b.done:
		return true
	default:
		return false
	}
}
