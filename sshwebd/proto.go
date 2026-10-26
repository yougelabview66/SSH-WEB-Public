package main

// 守护进程和客户端 (bridge / attach / ls) 之间的通信格式：一帧 = 1 字节类型 + 4 字节长度 (大端) + 内容。
// 一个连接先发若干个请求 (H)：list / kill / ping / quit 回一条消息 (M) 后可以接着发；attach 之后这个连接就是这个会话的终端：
// 客户端发输入 (I)、终端大小 (S)，守护进程发终端输出 (O) 和消息 (M：attached / replayed / exit / error)；
// attach 时要了 sizes 的客户端 (SSH-WEB) 还会收到终端大小的变化 (Z)，夹在输出中间、在变化发生的位置

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
)

const (
	fHello  = 'H' // 客户端 → 守护进程：请求 (JSON)
	fInput  = 'I' // 客户端 → 守护进程：键盘输入
	fResize = 'S' // 客户端 → 守护进程：终端大小 (2 字节列数 + 2 字节行数)
	fOutput = 'O' // 守护进程 → 客户端：终端输出
	fMsg    = 'M' // 守护进程 → 客户端：消息 (JSON)
	fSize   = 'Z' // 守护进程 → 客户端：终端大小变了 (同 S 的格式)。只发给 attach 时要了 sizes 的客户端
)

const maxFrame = 4 << 20

// Request：客户端的请求
type Request struct {
	Op    string            `json:"op"`              // list / attach / kill / ping / quit
	ID    string            `json:"id,omitempty"`    // 会话 id；attach 时空着 = 新建一个
	Cols  int               `json:"cols,omitempty"`  // attach：终端大小
	Rows  int               `json:"rows,omitempty"`  //
	Shell string            `json:"shell,omitempty"` // 新建时：cmd / powershell / pwsh，或者整条命令行
	Cwd   string            `json:"cwd,omitempty"`   // 新建时：起始目录 (默认主目录)
	Env   map[string]string `json:"env,omitempty"`   // 新建时：额外的环境变量
	// attach：从输出的第几个字节开始补发 (接着上次收到的位置)；不填 = 缓冲里有的全部补发
	Since    *int64 `json:"since,omitempty"`
	NoCreate bool   `json:"noCreate,omitempty"` // attach：会话不存在就报错，不新建
	// attach：客户端的标记 (SSH-WEB 的标签)。同一个标记的旧连接 (断网后主机上还没断开的) 踢掉；列表里带出来，
	// SSH-WEB 据此分清会话是被自己还是被别的标签接着
	Tag   string `json:"tag,omitempty"`
	Force bool   `json:"force,omitempty"` // quit：还有会话也退出 (会话全部结束)
	// attach：要不要收终端大小的变化 (Z 帧)：补发的输出里夹着当时的大小变化，补完发一条 replayed；之后别的客户端
	// 改了大小也告诉它。SSH-WEB 据此按当时的大小重放 (服务重启后接上，历史不乱)。旧的客户端不要，不会收到不认识的帧
	Sizes bool `json:"sizes,omitempty"`
}

// SessionInfo：列表里的一个会话
type SessionInfo struct {
	ID         string   `json:"id"`
	Shell      string   `json:"shell"`
	Cwd        string   `json:"cwd"`
	Title      string   `json:"title"` // 终端标题 (程序用 OSC 0 / 2 设置的)
	PID        int      `json:"pid"`
	Created    int64    `json:"created"`        // 毫秒时间戳
	LastOutput int64    `json:"lastOutput"`     //
	LastInput  int64    `json:"lastInput"`      //
	Clients    int      `json:"clients"`        // 现在有几个客户端接着
	Tags       []string `json:"tags,omitempty"` // 接着的客户端的标记 (见 Request.Tag)
	Cols       int      `json:"cols"`
	Rows       int      `json:"rows"`
}

// Msg：守护进程发出的消息
type Msg struct {
	Type     string        `json:"type"` // hello / list / attached / replayed / exit / error / ok
	Version  string        `json:"version,omitempty"`
	PID      int           `json:"pid,omitempty"`
	Detached bool          `json:"detached,omitempty"` // 守护进程不在 SSH 会话的作业里 (SSH 断了会话还在)
	Sessions []SessionInfo `json:"sessions,omitempty"`
	ID       string        `json:"id,omitempty"`
	Created  bool          `json:"created,omitempty"` // attach：这个会话是刚新建的
	At       int64         `json:"at,omitempty"`      // attach：这个会话是什么时候开的 (毫秒时间戳，同列表里的 created)
	Start    int64         `json:"start"`             // attach：补发的输出从第几个字节开始
	End      int64         `json:"end"`               // attach：补发到第几个字节 (之后实时发)
	Code     int           `json:"code"`              // exit：退出码
	Error    string        `json:"error,omitempty"`
}

func frame(t byte, p []byte) []byte {
	b := make([]byte, 5+len(p))
	b[0] = t
	binary.BigEndian.PutUint32(b[1:], uint32(len(p)))
	copy(b[5:], p)
	return b
}

func jsonFrame(t byte, v any) []byte {
	p, _ := json.Marshal(v)
	return frame(t, p)
}

func writeFrame(w io.Writer, t byte, p []byte) error {
	_, err := w.Write(frame(t, p))
	return err
}

func writeJSON(w io.Writer, t byte, v any) error {
	_, err := w.Write(jsonFrame(t, v))
	return err
}

func readFrame(r io.Reader) (byte, []byte, error) {
	var h [5]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(h[1:])
	if n > maxFrame {
		return 0, nil, errors.New("帧太大")
	}
	p := make([]byte, n)
	if _, err := io.ReadFull(r, p); err != nil {
		return 0, nil, err
	}
	return h[0], p, nil
}

func resizeFrame(cols, rows int) []byte { return sizeFrameOf(fResize, cols, rows) }

// sizeFrame：告诉客户端终端大小变了 (Z)
func sizeFrame(cols, rows int) []byte { return sizeFrameOf(fSize, cols, rows) }

func sizeFrameOf(t byte, cols, rows int) []byte {
	var p [4]byte
	binary.BigEndian.PutUint16(p[:], uint16(cols))
	binary.BigEndian.PutUint16(p[2:], uint16(rows))
	return frame(t, p[:])
}

func parseResize(p []byte) (int, int, bool) {
	if len(p) != 4 {
		return 0, 0, false
	}
	return int(binary.BigEndian.Uint16(p)), int(binary.BigEndian.Uint16(p[2:])), true
}
