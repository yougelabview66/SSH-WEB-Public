//go:build !windows

package main

// 在 Linux 上真跑一遍：编出 sshwebd，用 bridge (和 SSH-WEB 一样，一行一段 base64) 自动启动守护进程、开会话、打字、
// 断开再接上 (只补发没收到的)、两个客户端一起接、改大小、标题、退出码、结束会话、没事做了自己退出

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
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
				} else if typ == fMsg {
					var m Msg
					json.Unmarshal(p, &m)
					b.msgs = append(b.msgs, m)
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
