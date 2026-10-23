//go:build !windows

package main

// Linux / macOS：用系统的 pty (Linux 是正式支持的；macOS 主要是开发、测试用)

import (
	"bytes"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

type ptyProc interface {
	Read([]byte) (int, error)
	Write([]byte) (int, error)
	Resize(cols, rows int) error
	Wait() (int, error) // 等终端里的程序退出，返回退出码
	Kill() error        // 结束整个会话 (连同它开的子进程)
	Close() error
	Pid() int
}

type unixPty struct {
	f   *os.File
	cmd *exec.Cmd
}

// 要启动的程序：空着 = 登录 shell；sh / bash / zsh 这样的名字直接用；别的当成整条命令交给 sh -c
func shellArgv(shell string) ([]string, string) {
	switch shell {
	case "":
		sh := os.Getenv("SHELL")
		if sh == "" {
			sh = "/bin/sh"
		}
		return []string{sh, "-l"}, sh
	case "sh", "bash", "zsh", "fish":
		return []string{shell, "-l"}, shell
	}
	return []string{"/bin/sh", "-c", shell}, shell
}

func startPty(shell, cwd string, env map[string]string, cols, rows int) (ptyProc, string, error) {
	argv, name := shellArgv(shell)
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = cwd
	cmd.Env = mergeEnv(os.Environ(), env)
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		return nil, name, err
	}
	// 换成非阻塞的 (交给 Go 的轮询)：后台还有进程占着终端时，关掉它能让读输出的那边马上返回
	nfd := -1
	if rc, err := f.SyscallConn(); err == nil {
		rc.Control(func(fd uintptr) { nfd, _ = syscall.Dup(int(fd)) })
	}
	if nfd >= 0 && syscall.SetNonblock(nfd, true) == nil {
		f.Close()
		f = os.NewFile(uintptr(nfd), "ptmx")
	}
	return &unixPty{f: f, cmd: cmd}, name, nil
}

func mergeEnv(base []string, extra map[string]string) []string {
	m := map[string]string{}
	for _, kv := range base {
		if i := strings.IndexByte(kv, '='); i > 0 {
			m[kv[:i]] = kv[i+1:]
		}
	}
	if _, ok := m["TERM"]; !ok || m["TERM"] == "dumb" {
		m["TERM"] = "xterm-256color"
	}
	for k, v := range extra {
		m[k] = v
	}
	out := make([]string, 0, len(m))
	for k, v := range m {
		out = append(out, k+"="+v)
	}
	sort.Strings(out)
	return out
}

func (p *unixPty) Read(b []byte) (int, error)  { return p.f.Read(b) }
func (p *unixPty) Write(b []byte) (int, error) { return p.f.Write(b) }
func (p *unixPty) Pid() int                    { return p.cmd.Process.Pid }
func (p *unixPty) Close() error                { return p.f.Close() }
func (p *unixPty) Resize(cols, rows int) error {
	rc, err := p.f.SyscallConn() // 不用 pty.Setsize：它取 Fd() 会把文件改回阻塞的
	if err != nil {
		return err
	}
	rc.Control(func(fd uintptr) {
		err = unix.IoctlSetWinsize(int(fd), unix.TIOCSWINSZ, &unix.Winsize{Col: uint16(cols), Row: uint16(rows)})
	})
	return err
}

func (p *unixPty) Wait() (int, error) {
	err := p.cmd.Wait()
	if p.cmd.ProcessState == nil {
		return -1, err
	}
	return p.cmd.ProcessState.ExitCode(), nil
}

// 结束整个会话：shell 和它开的进程 (后台任务在别的进程组里，按会话 id 找；Linux 读 /proc)
func (p *unixPty) Kill() error {
	pid := p.cmd.Process.Pid
	kill := func(sig syscall.Signal) {
		syscall.Kill(-pid, sig)
		for _, q := range sessionPids(pid) {
			syscall.Kill(q, sig)
		}
	}
	kill(syscall.SIGHUP)
	go func() {
		time.Sleep(2 * time.Second)
		kill(syscall.SIGKILL)
	}()
	return nil
}

func sessionPids(sid int) []int {
	ents, _ := os.ReadDir("/proc")
	var out []int
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		b, err := os.ReadFile("/proc/" + e.Name() + "/stat")
		if err != nil {
			continue
		}
		// pid (名字) 状态 ppid pgrp session …：名字里可能有空格，从最后一个 ) 往后数
		f := strings.Fields(string(b[bytes.LastIndexByte(b, ')')+1:]))
		if len(f) > 3 && f[3] == strconv.Itoa(sid) {
			out = append(out, pid)
		}
	}
	return out
}
