//go:build !windows && !darwin

package main

// Linux (和别的有 /proc 的系统)：按会话找进程读 /proc

import (
	"bytes"
	"os"
	"strconv"
	"strings"
)

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

// Linux 上 SSH 登录一般已经带着语言环境 (pam_env 读 /etc/default/locale 等)：不动
func fixLocale(map[string]string) {}
