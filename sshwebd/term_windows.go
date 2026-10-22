//go:build windows

package main

import (
	"os"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/term"
)

func termSize() (int, int) {
	if w, h, err := term.GetSize(int(os.Stdout.Fd())); err == nil {
		return w, h
	}
	return 0, 0
}

// 输入切到原始模式 (按键按 VT 序列给出，比如方向键)，输出打开 VT 处理 (颜色、光标移动)
func rawTerminal() (func(), error) {
	st, err := term.MakeRaw(int(os.Stdin.Fd()))
	if err != nil {
		return nil, err
	}
	out := windows.Handle(os.Stdout.Fd())
	var mode uint32
	outOK := windows.GetConsoleMode(out, &mode) == nil
	if outOK {
		windows.SetConsoleMode(out, mode|windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING|windows.DISABLE_NEWLINE_AUTO_RETURN)
	}
	return func() {
		term.Restore(int(os.Stdin.Fd()), st)
		if outOK {
			windows.SetConsoleMode(out, mode)
		}
	}, nil
}

// Windows 没有窗口大小变了的信号：每 300 毫秒看一次
func watchResize(fn func(cols, rows int)) func() {
	stop := make(chan struct{})
	go func() {
		w0, h0 := termSize()
		t := time.NewTicker(300 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				if w, h := termSize(); w > 0 && (w != w0 || h != h0) {
					w0, h0 = w, h
					fn(w, h)
				}
			}
		}
	}()
	return func() { close(stop) }
}
