//go:build !windows

package main

import (
	"os"
	"os/signal"
	"syscall"

	"golang.org/x/term"
)

func termSize() (int, int) {
	if w, h, err := term.GetSize(int(os.Stdout.Fd())); err == nil {
		return w, h
	}
	return 0, 0
}

func rawTerminal() (func(), error) {
	st, err := term.MakeRaw(int(os.Stdin.Fd()))
	if err != nil {
		return nil, err
	}
	return func() { term.Restore(int(os.Stdin.Fd()), st) }, nil
}

func watchResize(fn func(cols, rows int)) func() {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGWINCH)
	stop := make(chan struct{})
	go func() {
		for {
			select {
			case <-stop:
				return
			case <-ch:
				if w, h := termSize(); w > 0 {
					fn(w, h)
				}
			}
		}
	}()
	return func() { signal.Stop(ch); close(stop) }
}
