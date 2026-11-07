//go:build darwin

package main

// macOS：没有 /proc，按会话找进程用 sysctl 列出全部进程再逐个问会话 id

import "golang.org/x/sys/unix"

func sessionPids(sid int) []int {
	procs, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil {
		return nil
	}
	var out []int
	for i := range procs {
		pid := int(procs[i].Proc.P_pid)
		if pid <= 0 {
			continue
		}
		if s, err := unix.Getsid(pid); err == nil && s == sid {
			out = append(out, pid)
		}
	}
	return out
}

// macOS 的 sshd 不设语言环境 (终端程序自己设，macOS 的 ssh 客户端再带过去)：SSH-WEB 起的守护进程里什么都没有，
// zsh 会把中文显示成 <e4><b8><ad> 这种。一个都没设时补上 LC_CTYPE=UTF-8 (同 macOS 的 ssh 客户端带过去的)，
// 只管字符怎么认，界面语言照旧；.zshrc 里自己设了的照样生效
func fixLocale(m map[string]string) {
	if m["LC_ALL"] == "" && m["LC_CTYPE"] == "" && m["LANG"] == "" {
		m["LC_CTYPE"] = "UTF-8"
	}
}
