//go:build !windows

package main

// Linux / macOS：守护进程听 ~/.ssh-web/sshwebd.sock (只有自己能连)

import (
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
)

func sockPath() string {
	if p := os.Getenv("SSHWEBD_SOCK"); p != "" {
		return p
	}
	return filepath.Join(dataDir(), "sshwebd.sock")
}

func listen() (net.Listener, error) {
	p := sockPath()
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return nil, err
	}
	if c, err := net.DialTimeout("unix", p, time.Second); err == nil {
		c.Close()
		return nil, errAlreadyRunning
	}
	os.Remove(p) // 上次没清掉的
	old := syscall.Umask(0o077)
	ln, err := net.Listen("unix", p)
	syscall.Umask(old)
	return ln, err
}

func dial() (net.Conn, error) { return net.DialTimeout("unix", sockPath(), 2*time.Second) }

// 在后台启动守护进程 (新的会话组，不随这次 SSH 结束)
func spawnDaemon() (bool, error) {
	exe, err := os.Executable()
	if err != nil {
		return false, err
	}
	cmd := exec.Command(exe, "serve")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return false, err
	}
	cmd.Process.Release()
	return true, nil
}

func inJob() bool { return false }

func homeDir() string {
	if h, err := os.UserHomeDir(); err == nil {
		return h
	}
	return "/"
}

var errAlreadyRunning = errors.New("守护进程已经在运行")
