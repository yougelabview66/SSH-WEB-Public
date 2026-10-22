package main

// 守护进程：保管终端会话 (Windows 用 ConPTY)，SSH 断开、客户端都走了会话也继续跑；
// 没有会话、也没有客户端连着超过 idle 就自己退出 (不常驻占资源)

import (
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/url"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	maxSessions   = 32
	replayChunk   = 32 << 10
	clientQueue   = 4096     // 一个客户端最多积压这么多帧、
	clientBytes   = 32 << 20 // 这么多字节还没发出去，再多说明它卡住了：断开它 (重新接上会补发)
	writeDeadline = 30 * time.Second
)

type daemon struct {
	mu       sync.Mutex
	sessions map[string]*session
	conns    int
	lastBusy time.Time
	idle     time.Duration
	bufSize  int
	detached bool
	ln       net.Listener
	quit     chan struct{}
	quitOnce sync.Once
}

type session struct {
	d          *daemon
	id         string
	shell      string
	cwd        string
	created    time.Time
	p          ptyProc
	mu         sync.Mutex // 管 ring / clients / title / cwd / 大小 / 时间
	ring       *ring
	clients    map[*client]struct{}
	title      string
	cols, rows int
	lastOut    time.Time
	lastIn     time.Time
	inMu       sync.Mutex
	exited     bool
}

type client struct {
	conn    net.Conn
	out     chan []byte
	pending atomic.Int64 // 排着队还没发出去的字节
	closed  bool         // 在 session.mu 下改
}

func newDaemon(ln net.Listener, idle time.Duration, bufSize int) *daemon {
	return &daemon{sessions: map[string]*session{}, lastBusy: time.Now(), idle: idle, bufSize: bufSize, ln: ln, quit: make(chan struct{}), detached: !inJob()}
}

func (d *daemon) serve() {
	go d.idleLoop()
	for {
		c, err := d.ln.Accept()
		if err != nil {
			select {
			case <-d.quit:
				return
			default:
			}
			log.Printf("accept: %v", err)
			time.Sleep(100 * time.Millisecond)
			continue
		}
		go d.handle(c)
	}
}

func (d *daemon) stop() {
	d.quitOnce.Do(func() {
		close(d.quit)
		d.ln.Close()
	})
}

func (d *daemon) idleLoop() {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-d.quit:
			return
		case <-t.C:
		}
		d.mu.Lock()
		idle := len(d.sessions) == 0 && d.conns == 0 && time.Since(d.lastBusy) > d.idle
		d.mu.Unlock()
		if idle {
			log.Printf("没有会话了，退出")
			d.stop()
			return
		}
	}
}

func (d *daemon) hello(typ string) Msg {
	return Msg{Type: typ, Version: version, PID: os.Getpid(), Detached: d.detached}
}

func (d *daemon) handle(c net.Conn) {
	d.mu.Lock()
	d.conns++
	d.mu.Unlock()
	defer func() {
		d.mu.Lock()
		d.conns--
		d.lastBusy = time.Now()
		d.mu.Unlock()
	}()
	for {
		t, p, err := readFrame(c)
		if err != nil || t != fHello {
			c.Close()
			return
		}
		var req Request
		if json.Unmarshal(p, &req) != nil {
			writeJSON(c, fMsg, Msg{Type: "error", Error: "请求格式不对"})
			c.Close()
			return
		}
		switch req.Op {
		case "ping":
			writeJSON(c, fMsg, d.hello("hello"))
		case "list":
			m := d.hello("list")
			m.Sessions = d.list()
			writeJSON(c, fMsg, m)
		case "kill":
			if err := d.kill(req.ID); err != nil {
				writeJSON(c, fMsg, Msg{Type: "error", Error: err.Error()})
			} else {
				writeJSON(c, fMsg, Msg{Type: "ok", ID: req.ID})
			}
		case "quit":
			d.mu.Lock()
			n := len(d.sessions)
			d.mu.Unlock()
			if n > 0 && !req.Force {
				writeJSON(c, fMsg, Msg{Type: "error", Error: "还有 " + strconv.Itoa(n) + " 个会话"})
				continue
			}
			writeJSON(c, fMsg, Msg{Type: "ok"})
			c.Close()
			d.killAll()
			d.stop()
			return
		case "attach":
			d.attach(c, req)
			return
		default:
			writeJSON(c, fMsg, Msg{Type: "error", Error: "不认识的请求：" + req.Op})
		}
	}
}

func (d *daemon) list() []SessionInfo {
	d.mu.Lock()
	ss := make([]*session, 0, len(d.sessions))
	for _, s := range d.sessions {
		ss = append(ss, s)
	}
	d.mu.Unlock()
	out := make([]SessionInfo, 0, len(ss))
	for _, s := range ss {
		out = append(out, s.info())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created < out[j].Created })
	return out
}

func (s *session) info() SessionInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	ms := func(t time.Time) int64 {
		if t.IsZero() {
			return 0
		}
		return t.UnixMilli()
	}
	return SessionInfo{ID: s.id, Shell: s.shell, Cwd: s.cwd, Title: s.title, PID: s.p.Pid(), Created: ms(s.created),
		LastOutput: ms(s.lastOut), LastInput: ms(s.lastIn), Clients: len(s.clients), Cols: s.cols, Rows: s.rows}
}

func (d *daemon) kill(id string) error {
	d.mu.Lock()
	s := d.sessions[id]
	d.mu.Unlock()
	if s == nil {
		return errors.New("没有这个会话：" + id)
	}
	log.Printf("结束会话 %s", id)
	return s.p.Kill()
}

func (d *daemon) killAll() {
	d.mu.Lock()
	ss := make([]*session, 0, len(d.sessions))
	for _, s := range d.sessions {
		ss = append(ss, s)
	}
	d.mu.Unlock()
	for _, s := range ss {
		s.p.Kill()
	}
}

// 找到要接上的会话，没有就新建
func (d *daemon) getOrCreate(req Request) (*session, bool, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if req.ID != "" {
		if s := d.sessions[req.ID]; s != nil {
			return s, false, nil
		}
		if req.NoCreate {
			return nil, false, errors.New("会话不存在了：" + req.ID)
		}
		if len(req.ID) > 64 {
			return nil, false, errors.New("会话 id 太长")
		}
	}
	if len(d.sessions) >= maxSessions {
		return nil, false, errors.New("会话太多了 (最多 " + strconv.Itoa(maxSessions) + " 个)")
	}
	id := req.ID
	for n := 1; id == ""; n++ {
		if d.sessions[strconv.Itoa(n)] == nil {
			id = strconv.Itoa(n)
		}
	}
	cols, rows := req.Cols, req.Rows
	if cols <= 0 || rows <= 0 {
		cols, rows = 120, 30
	}
	cwd := req.Cwd
	if cwd == "" {
		cwd = homeDir()
	}
	env := map[string]string{}
	for k, v := range req.Env {
		env[k] = v
	}
	env["SSHWEBD_SESSION"] = id
	p, shell, err := startPty(req.Shell, cwd, env, cols, rows)
	if err != nil {
		return nil, false, errors.New("启动终端失败：" + err.Error())
	}
	s := &session{d: d, id: id, shell: shell, cwd: cwd, created: time.Now(), p: p, ring: newRing(d.bufSize),
		clients: map[*client]struct{}{}, cols: cols, rows: rows}
	d.sessions[id] = s
	log.Printf("新建会话 %s：%s (pid %d，%dx%d)", id, shell, p.Pid(), cols, rows)
	go s.run()
	return s, true, nil
}

func (d *daemon) attach(c net.Conn, req Request) {
	s, created, err := d.getOrCreate(req)
	if err != nil {
		writeJSON(c, fMsg, Msg{Type: "error", Error: err.Error()})
		c.Close()
		return
	}
	cl := &client{conn: c, out: make(chan []byte, clientQueue)}
	go cl.writeLoop()
	s.mu.Lock()
	if s.exited {
		s.mu.Unlock()
		cl.out <- jsonFrame(fMsg, Msg{Type: "error", Error: "会话已经结束了"})
		close(cl.out)
		return
	}
	// 补发和登记在同一把锁里：之后的输出一个字节不漏、不重复
	start, data := s.ring.since(req.Since)
	m := d.hello("attached")
	m.ID, m.Created, m.Start, m.End = s.id, created, start, s.ring.total
	cl.out <- jsonFrame(fMsg, m)
	for len(data) > 0 {
		n := min(len(data), replayChunk)
		cl.out <- frame(fOutput, data[:n])
		data = data[n:]
	}
	s.clients[cl] = struct{}{}
	resize := req.Cols > 0 && req.Rows > 0 && (req.Cols != s.cols || req.Rows != s.rows)
	s.mu.Unlock()
	if resize {
		s.resize(req.Cols, req.Rows)
	}
	for {
		t, p, err := readFrame(c)
		if err != nil {
			break
		}
		switch t {
		case fInput:
			s.write(p)
		case fResize:
			if cols, rows, ok := parseResize(p); ok && cols > 0 && rows > 0 {
				s.resize(cols, rows)
			}
		}
	}
	s.mu.Lock()
	s.dropClient(cl)
	s.mu.Unlock()
}

// 在 s.mu 下调用
func (s *session) dropClient(cl *client) {
	if cl.closed {
		return
	}
	cl.closed = true
	delete(s.clients, cl)
	close(cl.out)
}

// 在 s.mu 下调用：发不出去 (客户端卡住了) 就断开它
func (s *session) send(cl *client, b []byte) {
	if cl.closed {
		return
	}
	if cl.pending.Load() > clientBytes {
		log.Printf("会话 %s：客户端太慢，断开", s.id)
		s.dropClient(cl)
		return
	}
	select {
	case cl.out <- b:
		cl.pending.Add(int64(len(b)))
	default:
		log.Printf("会话 %s：客户端太慢，断开", s.id)
		s.dropClient(cl)
	}
}

func (cl *client) writeLoop() {
	broken := false
	for b := range cl.out {
		if broken {
			continue
		}
		cl.conn.SetWriteDeadline(time.Now().Add(writeDeadline))
		_, err := cl.conn.Write(b)
		cl.pending.Add(-int64(len(b)))
		if err != nil {
			broken = true
			cl.conn.Close()
		}
	}
	cl.conn.Close()
}

func (s *session) write(p []byte) {
	s.mu.Lock()
	s.lastIn = time.Now()
	s.mu.Unlock()
	s.inMu.Lock()
	defer s.inMu.Unlock()
	s.p.Write(p)
}

func (s *session) resize(cols, rows int) {
	s.mu.Lock()
	if cols == s.cols && rows == s.rows {
		s.mu.Unlock()
		return
	}
	s.cols, s.rows = cols, rows
	s.mu.Unlock()
	s.p.Resize(cols, rows)
}

func (s *session) run() {
	waited := make(chan int, 1)
	go func() {
		code, _ := s.p.Wait()
		waited <- code
		time.Sleep(150 * time.Millisecond) // 最后一点输出读完再关
		s.p.Close()
	}()
	buf := make([]byte, 32<<10)
	for {
		n, err := s.p.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			f := frame(fOutput, chunk)
			s.mu.Lock()
			s.ring.write(chunk)
			s.lastOut = time.Now()
			s.scanOsc(chunk)
			for cl := range s.clients {
				s.send(cl, f)
			}
			s.mu.Unlock()
		}
		if err != nil {
			break
		}
	}
	code := <-waited
	log.Printf("会话 %s 结束，退出码 %d", s.id, code)
	s.d.mu.Lock()
	delete(s.d.sessions, s.id)
	s.d.lastBusy = time.Now()
	s.d.mu.Unlock()
	s.mu.Lock()
	s.exited = true
	f := jsonFrame(fMsg, Msg{Type: "exit", ID: s.id, Code: code})
	for cl := range s.clients {
		s.send(cl, f)
		s.dropClient(cl)
	}
	s.mu.Unlock()
}

// 从输出里记下终端标题 (OSC 0 / 2：ESC ] 0 ; 标题 BEL) 和当前目录 (OSC 9;9：ESC ] 9 ; 9 ; 路径 BEL，Windows Terminal 的写法，
// 默认的 shell 每次显示提示符时发一次，见 shellCmdline；也认 OSC 7 file://主机/路径)，列表里显示。跨两块输出的不管
func (s *session) scanOsc(p []byte) {
	for i := 0; i+2 < len(p); i++ {
		if p[i] != 0x1b || p[i+1] != ']' {
			continue
		}
		for j := i + 2; j < len(p) && j-i < 4096; j++ {
			if p[j] != 0x07 && !(p[j] == 0x1b && j+1 < len(p) && p[j+1] == '\\') {
				continue
			}
			v := string(p[i+2 : j])
			switch {
			case strings.HasPrefix(v, "0;") || strings.HasPrefix(v, "2;"):
				if len(v) <= 258 {
					s.title = v[2:]
				}
			case strings.HasPrefix(v, "9;9;"):
				s.cwd = strings.Trim(v[4:], `"`)
			case strings.HasPrefix(v, "7;file://"):
				if u, err := url.Parse(v[2:]); err == nil && u.Path != "" {
					s.cwd = osPath(u.Path)
				}
			}
			i = j
			break
		}
	}
}

// OSC 7 里的路径 → 本机的写法 (Windows：/D:/x → D:\x)
func osPath(p string) string {
	if runtime.GOOS == "windows" {
		p = strings.TrimPrefix(p, "/")
		if len(p) >= 2 && p[1] == ':' {
			p = strings.ReplaceAll(p, "/", `\`)
		}
	}
	return p
}
