//go:build windows

package main

// Windows：守护进程听命名管道 \\.\pipe\sshwebd-v1-<用户名> (只有自己这个用户能连)。
// 启动守护进程时要脱离 SSH 会话的作业对象：Windows 的 OpenSSH 在 SSH 断开时会结束整个作业，
// 它允许脱离，但要 CreateProcess 时明确带上 CREATE_BREAKAWAY_FROM_JOB (Orca 的 orcad 也是这样)

import (
	"errors"
	"net"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

func pipePath() string {
	if p := os.Getenv("SSHWEBD_PIPE"); p != "" {
		return p
	}
	u := os.Getenv("USERNAME")
	if u == "" {
		u = "user"
	}
	u = strings.Map(func(r rune) rune {
		if r == '\\' || r == '/' || r == ':' || r == ' ' {
			return '_'
		}
		return r
	}, u)
	return `\\.\pipe\sshwebd-v1-` + u
}

func listen() (net.Listener, error) {
	sddl := ""
	if u, err := windows.GetCurrentProcessToken().GetTokenUser(); err == nil {
		// 只给自己 (和 SYSTEM)。S:(ML;;NW;;;ME)：管理员账号通过 SSH 登录时进程是高权限的，
		// 不加这个标签，电脑桌面上 (普通权限) 运行的 sshwebd attach 连不上
		sddl = "D:P(A;;GA;;;SY)(A;;GA;;;" + u.User.Sid.String() + ")S:(ML;;NW;;;ME)"
	}
	cfg := &winio.PipeConfig{SecurityDescriptor: sddl, InputBufferSize: 64 << 10, OutputBufferSize: 64 << 10}
	ln, err := winio.ListenPipe(pipePath(), cfg)
	if err != nil && strings.Contains(sddl, "S:") && !pipeExists() {
		cfg.SecurityDescriptor = sddl[:strings.Index(sddl, "S:")]
		ln, err = winio.ListenPipe(pipePath(), cfg)
	}
	if err != nil {
		// 管道已经有了 = 别的守护进程在听
		if c, derr := dial(); derr == nil {
			c.Close()
			return nil, errAlreadyRunning
		}
		return nil, err
	}
	return ln, nil
}

func pipeExists() bool {
	c, err := dial()
	if err == nil {
		c.Close()
	}
	return err == nil
}

func dial() (net.Conn, error) {
	t := 2 * time.Second
	return winio.DialPipe(pipePath(), &t)
}

const createBreakawayFromJob = 0x01000000

// 返回守护进程是不是脱离了 SSH 会话的作业
func spawnDaemon() (bool, error) {
	exe, err := os.Executable()
	if err != nil {
		return false, err
	}
	start := func(flags uint32) error {
		cmd := exec.Command(exe, "serve")
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: flags}
		if err := cmd.Start(); err != nil {
			return err
		}
		return cmd.Process.Release()
	}
	base := uint32(windows.DETACHED_PROCESS | windows.CREATE_NEW_PROCESS_GROUP)
	if err := start(base | createBreakawayFromJob); err == nil {
		return true, nil
	}
	// 外面的作业不让脱离：照样启动，SSH 断开时会话会跟着结束
	return false, start(base)
}

var procIsProcessInJob = windows.NewLazySystemDLL("kernel32.dll").NewProc("IsProcessInJob")

func inJob() bool {
	var r int32
	ok, _, _ := procIsProcessInJob.Call(uintptr(windows.CurrentProcess()), 0, uintptr(unsafe.Pointer(&r)))
	return ok != 0 && r != 0
}

func homeDir() string {
	if h := os.Getenv("USERPROFILE"); h != "" {
		return h
	}
	if h, err := os.UserHomeDir(); err == nil {
		return h
	}
	return `C:\`
}

var errAlreadyRunning = errors.New("守护进程已经在运行")
