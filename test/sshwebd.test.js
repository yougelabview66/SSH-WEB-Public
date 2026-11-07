'use strict';
// sshwebd (sshwebd/ 目录，常驻会话的守护程序，Go 写的)：go vet (含 Windows、macOS 版) 和它自己的测试
// (在 Linux 上真跑守护进程、bridge、断开重连、补发、几个客户端、退出码、空闲退出)。没有 Go 就跳过
const path = require('path');
const { execFileSync } = require('child_process');
const { ok, run } = require('./helpers');

const src = path.join(__dirname, '..', 'sshwebd');
const go = ['/root/.local/go/bin/go', '/usr/local/go/bin/go', 'go'].find((g) => { try { execFileSync(g, ['version'], { stdio: 'ignore' }); return true; } catch { return false; } });
const sh = (env, ...args) => {
  try { return { ok: true, out: execFileSync(go, args, { cwd: src, env: { ...process.env, CGO_ENABLED: '0', ...env }, encoding: 'utf8', stdio: 'pipe' }) }; }
  catch (e) { return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` }; }
};

run(async () => {
  if (!go) { ok(true, '(没有 Go：跳过 sshwebd 测试)'); return; }
  let r = sh({}, 'vet', './...');
  ok(r.ok, 'go vet ' + r.out);
  r = sh({ GOOS: 'windows' }, 'vet', './...');
  ok(r.ok, 'go vet (Windows 版) ' + r.out);
  r = sh({ GOOS: 'windows', GOARCH: 'amd64' }, 'build', '-o', require('os').devNull, '.');
  ok(r.ok, '编得出 Windows exe ' + r.out);
  // macOS 版 (Docker 镜像里编 darwin-arm64 / darwin-amd64，按会话找进程等在 proc_darwin.go)：在 Linux 上跑不了，至少要编得过
  for (const arch of ['arm64', 'amd64']) {
    r = sh({ GOOS: 'darwin', GOARCH: arch }, 'vet', '.');
    ok(r.ok, `go vet (macOS ${arch} 版) ` + r.out);
  }
  r = sh({}, 'test', '-count=1', './...');
  ok(r.ok, 'go test ' + r.out.trim().split('\n').slice(-15).join('\n'));
});
