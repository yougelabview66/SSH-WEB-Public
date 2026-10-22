package main

import "bytes"

// ring：一个会话最近的输出 (接上时补发)。超过上限丢掉前面的 1/4，从下一个换行之后开始 (不从一个转义序列中间开始)。
// total 是从会话开始一共输出了多少字节，客户端用它记自己收到哪了，重新接上时只补发没收到的
type ring struct {
	buf   []byte
	max   int
	total int64 // buf 末尾对应的位置
}

func newRing(max int) *ring { return &ring{max: max} }

func (r *ring) write(p []byte) {
	r.buf = append(r.buf, p...)
	r.total += int64(len(p))
	if len(r.buf) <= r.max {
		return
	}
	cut := len(r.buf) - r.max*3/4
	if i := bytes.IndexByte(r.buf[cut:], '\n'); i >= 0 && i < 4096 {
		cut += i + 1
	}
	n := copy(r.buf, r.buf[cut:])
	r.buf = r.buf[:n]
}

// start：缓冲里最早的字节的位置
func (r *ring) start() int64 { return r.total - int64(len(r.buf)) }

// since：从 at 开始的输出 (at 已经不在缓冲里了就从缓冲开头)，和实际开始的位置
func (r *ring) since(at *int64) (int64, []byte) {
	s := r.start()
	if at != nil && *at > s {
		s = *at
	}
	if s > r.total {
		s = r.total
	}
	off := int(s - r.start())
	out := make([]byte, len(r.buf)-off)
	copy(out, r.buf[off:])
	return s, out
}
