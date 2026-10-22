//go:build windows

package main

// Windows：用 ConPTY (Windows 10 1809 起自带的伪终端)。每个会话的进程放进一个作业对象，
// 会话结束 / 被结束时连同它开的子进程一起结束

import (
	"errors"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"unsafe"

	"golang.org/x/sys/windows"
)

type ptyProc interface {
	Read([]byte) (int, error)
	Write([]byte) (int, error)
	Resize(cols, rows int) error
	Wait() (int, error)
	Kill() error
	Close() error
	Pid() int
}

type winPty struct {
	hpc       windows.Handle // 伪终端
	proc      windows.Handle
	job       windows.Handle
	pid       int
	in        *os.File // 写给终端 (键盘输入)
	out       *os.File // 终端的输出
	closeOnce sync.Once
	closed    atomic.Bool
}

// 要启动的程序。cmd / PowerShell 先把代码页切到 UTF-8 (65001)：直接写 UTF-8 字节的程序 (比如 Claude Code)
// 中文才不乱 (Orca 也这么做)。别的当成整条命令行
func shellCmdline(shell string) (string, string) {
	switch strings.ToLower(shell) {
	case "", "powershell":
		return `powershell.exe -NoLogo -NoExit -Command "chcp.com 65001 > $null"`, "powershell"
	case "pwsh":
		return `pwsh.exe -NoLogo -NoExit -Command "chcp.com 65001 > $null"`, "pwsh"
	case "cmd":
		comspec := os.Getenv("ComSpec")
		if comspec == "" {
			comspec = `C:\Windows\System32\cmd.exe`
		}
		return windows.EscapeArg(comspec) + ` /K chcp 65001>nul`, "cmd"
	}
	return shell, shell
}

func startPty(shell, cwd string, env map[string]string, cols, rows int) (ptyProc, string, error) {
	cmdline, name := shellCmdline(shell)
	// 两条管道：输入 (我们写 → 终端读)、输出 (终端写 → 我们读)
	var inR, inW, outR, outW windows.Handle
	if err := windows.CreatePipe(&inR, &inW, nil, 0); err != nil {
		return nil, name, err
	}
	if err := windows.CreatePipe(&outR, &outW, nil, 0); err != nil {
		windows.CloseHandle(inR)
		windows.CloseHandle(inW)
		return nil, name, err
	}
	var hpc windows.Handle
	if err := windows.CreatePseudoConsole(windows.Coord{X: int16(cols), Y: int16(rows)}, inR, outW, 0, &hpc); err != nil {
		for _, h := range []windows.Handle{inR, inW, outR, outW} {
			windows.CloseHandle(h)
		}
		return nil, name, errors.New("创建 ConPTY 失败 (要 Windows 10 1809 以上)：" + err.Error())
	}
	// 伪终端自己留着它那头的管道
	windows.CloseHandle(inR)
	windows.CloseHandle(outW)
	p := &winPty{hpc: hpc, in: os.NewFile(uintptr(inW), "conpty-in"), out: os.NewFile(uintptr(outR), "conpty-out")}

	attrs, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		p.Close()
		return nil, name, err
	}
	defer attrs.Delete()
	// 伪终端这一项的值就是句柄本身 (不是指向它的指针)，不能经过 attrs.Update (它把值当 Go 指针记着)
	if r, _, err := procUpdateProcThreadAttribute.Call(uintptr(unsafe.Pointer(attrs.List())), 0, windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, uintptr(hpc), unsafe.Sizeof(hpc), 0, 0); r == 0 {
		p.Close()
		return nil, name, err
	}
	si := windows.StartupInfoEx{ProcThreadAttributeList: attrs.List()}
	si.Cb = uint32(unsafe.Sizeof(si))
	// 标准输入输出句柄明确给空的：不然守护进程自己的 (NUL) 会传给 shell，shell 不用伪终端、
	// 读到输入结束马上退出 (PowerShell 一开就「退出码 0」)
	si.Flags |= windows.STARTF_USESTDHANDLES
	cmd16, err := windows.UTF16PtrFromString(cmdline)
	if err != nil {
		p.Close()
		return nil, name, err
	}
	var cwd16 *uint16
	if cwd != "" {
		cwd16, _ = windows.UTF16PtrFromString(cwd)
	}
	envBlock := makeEnvBlock(mergeEnv(os.Environ(), env))
	var pi windows.ProcessInformation
	// 先挂起：放进作业对象之后再跑，不然它马上开的子进程会漏在作业外面
	flags := uint32(windows.EXTENDED_STARTUPINFO_PRESENT | windows.CREATE_UNICODE_ENVIRONMENT | windows.CREATE_SUSPENDED)
	if err := windows.CreateProcess(nil, cmd16, nil, nil, false, flags, &envBlock[0], cwd16, &si.StartupInfo, &pi); err != nil {
		p.Close()
		return nil, name, errors.New("启动 " + cmdline + " 失败：" + err.Error())
	}
	p.proc, p.pid = pi.Process, int(pi.ProcessId)
	if job, err := windows.CreateJobObject(nil, nil); err == nil {
		info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
		info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
		if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err == nil &&
			windows.AssignProcessToJobObject(job, pi.Process) == nil {
			p.job = job
		} else {
			windows.CloseHandle(job) // 放不进去 (外面的作业不让)：照样跑，只是结束时子进程可能留着
		}
	}
	_, err = windows.ResumeThread(pi.Thread)
	windows.CloseHandle(pi.Thread)
	if err != nil {
		p.Kill()
		p.Close()
		return nil, name, errors.New("恢复进程失败：" + err.Error())
	}
	return p, name, nil
}

var procUpdateProcThreadAttribute = windows.NewLazySystemDLL("kernel32.dll").NewProc("UpdateProcThreadAttribute")

func mergeEnv(base []string, extra map[string]string) []string {
	m := map[string]string{}
	keys := map[string]string{} // Windows 的环境变量名不分大小写：大写 → 原来的写法
	for _, kv := range base {
		if i := strings.IndexByte(kv[1:], '='); i >= 0 { // 跳过开头的 = (=C:=C:\ 这种)
			k := kv[:i+1]
			keys[strings.ToUpper(k)] = k
			m[k] = kv[i+2:]
		}
	}
	for k, v := range extra {
		if old, ok := keys[strings.ToUpper(k)]; ok && old != k {
			delete(m, old)
		}
		m[k] = v
	}
	out := make([]string, 0, len(m))
	for k, v := range m {
		out = append(out, k+"="+v)
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToUpper(out[i]) < strings.ToUpper(out[j]) })
	return out
}

func makeEnvBlock(env []string) []uint16 {
	var b []uint16
	for _, kv := range env {
		u, err := windows.UTF16FromString(kv)
		if err != nil {
			continue
		}
		b = append(b, u...) // 带着结尾的 0
	}
	return append(b, 0)
}

func (p *winPty) Read(b []byte) (int, error)  { return p.out.Read(b) }
func (p *winPty) Write(b []byte) (int, error) { return p.in.Write(b) }
func (p *winPty) Pid() int                    { return p.pid }

func (p *winPty) Resize(cols, rows int) error {
	return windows.ResizePseudoConsole(p.hpc, windows.Coord{X: int16(cols), Y: int16(rows)})
}

func (p *winPty) Wait() (int, error) {
	if _, err := windows.WaitForSingleObject(p.proc, windows.INFINITE); err != nil {
		return -1, err
	}
	var code uint32
	if err := windows.GetExitCodeProcess(p.proc, &code); err != nil {
		return -1, err
	}
	return int(code), nil
}

func (p *winPty) Kill() error {
	if p.closed.Load() {
		return nil
	}
	if p.job != 0 {
		return windows.TerminateJobObject(p.job, 1)
	}
	return windows.TerminateProcess(p.proc, 1)
}

// 关掉伪终端 (还连着的程序会收到关闭事件)、作业 (剩下的子进程一起结束)、管道。读输出的那边随后读到结束
func (p *winPty) Close() error {
	p.closeOnce.Do(func() {
		p.closed.Store(true)
		windows.ClosePseudoConsole(p.hpc)
		if p.job != 0 {
			windows.CloseHandle(p.job)
		}
		p.in.Close()
		p.out.Close()
		if p.proc != 0 {
			windows.CloseHandle(p.proc)
		}
	})
	return nil
}
