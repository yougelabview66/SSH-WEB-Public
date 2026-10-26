package main

import "bytes"

// ring：一个会话最近的输出 (接上时补发)。超过上限丢掉前面的 1/4，从下一个换行之后开始 (不从一个转义序列中间开始)。
// total 是从会话开始一共输出了多少字节，客户端用它记自己收到哪了，重新接上时只补发没收到的。
// marks：这段输出期间终端大小的变化。程序是按当时的大小画的 (Claude Code 这类光标定位、擦行重画的界面)，
// 补发时客户端要照着在同样的位置改大小重放，不然按一个大小重放出来的历史是乱的 (见 marksFrom)
type ring struct {
	buf   []byte
	max   int
	total int64 // buf 末尾对应的位置
	marks []sizeMark
}

// sizeMark：从输出的第 at 个字节起，终端是 cols x rows
type sizeMark struct {
	at         int64
	cols, rows int
}

const maxMarks = 2048 // 一直拖窗口大小时别无限涨：超了丢掉前面一半 (重放最前面那一小段的大小可能不准)

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
	// 丢掉已经不在缓冲里的大小变化，但留着缓冲开头那一刻的大小 (最后一个不晚于开头的)
	s, i := r.start(), 0
	for i+1 < len(r.marks) && r.marks[i+1].at <= s {
		i++
	}
	r.marks = r.marks[i:]
}

// mark：从现在 (输出的当前位置) 起终端是 cols x rows
func (r *ring) mark(cols, rows int) {
	if n := len(r.marks); n > 0 && r.marks[n-1].at == r.total { // 这期间没有输出：只算最后一次
		r.marks[n-1].cols, r.marks[n-1].rows = cols, rows
		return
	}
	r.marks = append(r.marks, sizeMark{r.total, cols, rows})
	if len(r.marks) > maxMarks {
		r.marks = append(r.marks[:0], r.marks[len(r.marks)-maxMarks/2:]...)
	}
}

// marksFrom：从 s 开始补发时要照着改的大小：s 那一刻的大小 (位置记成 s)，加上之后的每一次变化
func (r *ring) marksFrom(s int64) []sizeMark {
	var out []sizeMark
	for _, m := range r.marks {
		if m.at <= s {
			out = append(out[:0], sizeMark{s, m.cols, m.rows})
		} else {
			out = append(out, m)
		}
	}
	return out
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
