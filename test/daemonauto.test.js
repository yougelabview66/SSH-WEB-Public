'use strict';
// @env SSHWEBD_DIR=/tmp/sshweb-da-bin
// 常驻会话断了自动重连：SSH 断开、或者没响应 (网络断过，心跳还没发现) 时会话还在主机上，自动重新连上接回去；
// 网页刚挂上来时探测一下 SSH 通不通。选择框标题带主机名 (不带序号)；连接断了还没回答的选择框关掉。
// 模拟主机同 daemonlinux.test.js。下面是那边的说明 —— 常驻会话 (sshwebd) 在 Linux 主机上：连上时认出是 Linux、什么架构，把 Linux 版传到 ~/.ssh-web/sshwebd-<哈希> (加执行权限)，
// 开一个不要终端的通道跑 bridge，终端在守护进程里。用不用 tmux 都行：
// - 不用 tmux：往上滚取的是服务器上这个终端的记录；项目目录按会话的 SSHWEBD_SESSION 在 /proc 里找
// - 用 tmux：历史走 tmux capture-pane，按 tmux 客户端环境里的 SSHWEBD_SESSION 找 pane (换了标签接上也找得到)；
//   敲 tmux / 接上时里面开着 tmux 都提示一次「不用再开 tmux」
// 钩子事件里的 tabs 是第一次开这个会话的标签，daemon 是会话编号：交给现在接着它的标签。
// 模拟的主机把命令在本机临时目录里真的执行 (HOME、TMUX_TMPDIR 都在临时目录，不碰本机真实的 tmux)；
// 不是 Linux (macOS 等) 的照常开普通终端，不提示
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { Server, utils: { sftp: { OPEN_MODE, STATUS_CODE } } } = require('ssh2');
const WebSocket = require('ws');
const { BASE, ok, wait, run, hostKey, addHost, killUnder } = require('./helpers');

const BIN_DIR = '/tmp/sshweb-da-bin'; // 服务器上的 Linux 版 (见开头的 @env)
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-da-')));
const tmuxDir = path.join(home, 'tmux'); // tmux 的 socket 放这里 (TMUX_TMPDIR)，不碰本机的 tmux 服务
fs.mkdirSync(tmuxDir);
killUnder(home); // 中途出错退出时也结束这里起的守护进程
const until = async (fn, ms) => { for (const end = Date.now() + ms; !fn() && Date.now() < end;) await wait(100); };
const ENV = { HOME: home, PATH: process.env.PATH, TMUX_TMPDIR: tmuxDir, SHELL: '/bin/sh', SSHWEBD_IDLE: '3s', LANG: 'C.UTF-8' };
const hasTmux = (() => { try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; } })();

// Linux 版 sshwebd：用 sshwebd/ 的源码编，放到 SSHWEBD_DIR (服务器按 uname -m 挑)
function buildBin() {
  const go = ['/root/.local/go/bin/go', '/usr/local/go/bin/go', 'go'].find((g) => { try { execFileSync(g, ['version'], { stdio: 'ignore' }); return true; } catch { return false; } });
  if (!go) return false;
  const arch = { x64: 'amd64', arm64: 'arm64', arm: 'armv7' }[process.arch];
  fs.rmSync(BIN_DIR, { recursive: true, force: true });
  fs.mkdirSync(BIN_DIR, { recursive: true });
  execFileSync(go, ['build', '-o', path.join(BIN_DIR, `sshwebd-linux-${arch}`), '.'], { cwd: path.join(__dirname, '..', 'sshwebd'), env: { ...process.env, CGO_ENABLED: '0' }, stdio: 'ignore' });
  return true;
}
const BIN = buildBin();

let conns = [], darwinShells = 0;
function server(port, darwin) {
  new Server({ hostKeys: [hostKey()] }, (c) => {
    conns.push(c);
    c.on('error', () => {});
    c.on('authentication', (ctx) => ctx.accept());
    c.on('ready', () => c.on('session', (acc) => {
      const s = acc();
      s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
      s.on('shell', (a) => { darwinShells++; a().write('mac$ '); });
      s.on('exec', (a, r, info) => {
        const ch = a(), cmd = info.command;
        if (darwin && cmd === 'uname -sm') { ch.write('Darwin arm64\n'); ch.exit(0); ch.end(); return; }
        // 命令在本机临时目录里真的执行 (bridge 这种一直跑的：通道的输入输出接上，通道关了就结束它)
        const pr = spawn('sh', ['-c', cmd], { cwd: home, env: ENV });
        pr.stdin.on('error', () => {}); // 进程已经结束还有输入过来：EPIPE 是异步报的，try 接不住
        ch.on('data', (d) => { try { pr.stdin.write(d); } catch {} });
        ch.on('end', () => { try { pr.stdin.end(); } catch {} });
        pr.stdout.on('data', (d) => { try { ch.write(d); } catch {} });
        pr.stderr.on('data', (d) => { try { ch.stderr.write(d); } catch {} });
        pr.on('exit', (code) => { try { ch.exit(code || 0); ch.end(); } catch {} });
        ch.on('close', () => { try { pr.kill('SIGKILL'); } catch {} });
      });
      s.on('sftp', (accept) => {
        const sf = accept();
        const hs = new Map(); let next = 1;
        const loc = (p) => (p === '.' || p === '' ? home : p);
        const handle = (v) => { const h = Buffer.alloc(4); h.writeUInt32BE(next); hs.set(next++, v); return h; };
        const get = (h) => hs.get(h.readUInt32BE());
        const okr = (id) => sf.status(id, STATUS_CODE.OK);
        const err = (id, e) => sf.status(id, e && e.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE);
        const attrs = (st) => ({ mode: st.mode, uid: 0, gid: 0, size: st.size, atime: st.atimeMs / 1000 | 0, mtime: st.mtimeMs / 1000 | 0 });
        const fsFlags = (f) => (f & OPEN_MODE.READ && f & OPEN_MODE.WRITE ? fs.constants.O_RDWR : f & OPEN_MODE.WRITE ? fs.constants.O_WRONLY : fs.constants.O_RDONLY)
          | (f & OPEN_MODE.CREAT ? fs.constants.O_CREAT : 0) | (f & OPEN_MODE.TRUNC ? fs.constants.O_TRUNC : 0) | (f & OPEN_MODE.EXCL ? fs.constants.O_EXCL : 0);
        sf.on('REALPATH', (id, p) => { const r = loc(p).replace(/\/+$/, '') || '/'; sf.name(id, [{ filename: r, longname: r, attrs: {} }]); });
        sf.on('STAT', (id, p) => { try { sf.attrs(id, attrs(fs.statSync(loc(p)))); } catch (e) { err(id, e); } });
        sf.on('LSTAT', (id, p) => { try { sf.attrs(id, attrs(fs.lstatSync(loc(p)))); } catch (e) { err(id, e); } });
        sf.on('FSTAT', (id, h) => { try { sf.attrs(id, attrs(fs.fstatSync(get(h).fd))); } catch (e) { err(id, e); } });
        sf.on('MKDIR', (id, p) => { try { fs.mkdirSync(loc(p)); okr(id); } catch (e) { err(id, e); } });
        sf.on('OPEN', (id, p, flags) => { try { sf.handle(id, handle({ fd: fs.openSync(loc(p), fsFlags(flags), 0o644) })); } catch (e) { err(id, e); } });
        sf.on('OPENDIR', (id, p) => { const l = loc(p); if (!fs.existsSync(l)) return err(id, { code: 'ENOENT' }); sf.handle(id, handle({ dir: l, done: false })); });
        sf.on('READDIR', (id, h) => {
          const d = get(h);
          if (!d || d.done) return sf.status(id, STATUS_CODE.EOF);
          d.done = true;
          sf.name(id, fs.readdirSync(d.dir).map((n) => ({ filename: n, longname: n, attrs: attrs(fs.lstatSync(path.join(d.dir, n))) })));
        });
        sf.on('READ', (id, h, off, len) => { const buf = Buffer.alloc(len); const n = fs.readSync(get(h).fd, buf, 0, len, off); if (!n) return sf.status(id, STATUS_CODE.EOF); sf.data(id, buf.subarray(0, n)); });
        sf.on('WRITE', (id, h, off, data) => { try { fs.writeSync(get(h).fd, data, 0, data.length, off); okr(id); } catch (e) { err(id, e); } });
        sf.on('CLOSE', (id, h) => { const f = get(h); if (f && f.fd != null) fs.closeSync(f.fd); hs.delete(h.readUInt32BE()); okr(id); });
        sf.on('RENAME', (id, a, b) => { try { fs.renameSync(loc(a), loc(b)); okr(id); } catch (e) { err(id, e); } });
        sf.on('REMOVE', (id, p) => { try { fs.unlinkSync(loc(p)); okr(id); } catch (e) { err(id, e); } });
        sf.on('SETSTAT', (id, p, a) => { try { if (a && a.mode != null) fs.chmodSync(loc(p), a.mode & 0o7777); okr(id); } catch (e) { err(id, e); } });
        sf.on('FSETSTAT', (id) => okr(id));
      });
    }));
  }).listen(port, '127.0.0.1');
}
server(2343, false);

// 一个标签 (直接用 WebSocket，和网页一样的消息)
function tab(hostId) {
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws');
  const t = { ws, out: '', msgs: [], picks: [] };
  ws.on('message', (d, bin) => {
    if (bin) { t.out += d.toString(); return; }
    const m = JSON.parse(d);
    t.msgs.push(m);
    if (m.type === 'daemon-pick') t.picks.push(m);
  });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'connect', hostId, title: 'DL', cols: 100, rows: 30 })));
  t.send = (o) => ws.send(JSON.stringify(o));
  t.type = (s) => t.send({ type: 'data', data: s });
  t.last = (type) => [...t.msgs].reverse().find((m) => m.type === type);
  t.sid = () => t.msgs.find((m) => m.type === 'attached')?.session?.id;
  t.hist = () => new Promise((resolve) => {
    const n = t.msgs.length;
    t.send({ type: 'tmux-history', lines: 3000 });
    const iv = setInterval(() => { const m = t.msgs.slice(n).find((x) => x.type === 'tmux-history'); if (m) { clearInterval(iv); resolve(m); } }, 50);
    setTimeout(() => { clearInterval(iv); resolve(null); }, 8000);
  });
  return t;
}
const post = (u, b) => fetch(BASE + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());

run(async () => {
  if (!BIN) { ok(true, '(没有 Go：跳过)'); return; }
  fs.mkdirSync(path.join(home, '.ssh-web'), { recursive: true });
  fs.writeFileSync(path.join(home, '.profile'), "PS1='$ '\n");
  const host = await addHost('DA', 2343, { winDaemon: true });
  const a = tab(host.id);
  await until(() => /新建常驻会话 \d/.test(a.out) && a.last('status')?.status === 'connected', 20000);
  a.type('echo one-$((1+1))\r');
  await until(() => a.out.includes('one-2'), 5000);

  // ---- 1. SSH 断开：会话还在主机上，自动重新连上接回去 (不用点「重新连接」)
  for (const c of conns) c.end();
  await until(() => a.out.includes('连接已断开'), 5000);
  const t0 = Date.now();
  await until(() => /自动重新连接 \(第 1 次\)/.test(a.out) && /接上常驻会话 1/.test(a.out) && a.last('status')?.status === 'connected', 15000);
  ok(/自动重新连接 \(第 1 次\)/.test(a.out) && /接上常驻会话 1/.test(a.out) && a.last('status')?.status === 'connected', `SSH 断开：自动重新连上，接回原来的常驻会话 (${Date.now() - t0}ms)`);
  a.type('echo two-$((2+2))\r');
  await until(() => a.out.includes('two-4'), 5000);
  ok(a.out.includes('two-4'), '重连后打字、输出照常');

  // ---- 2. SSH 没响应 (连接还在但主机不回了：网络断过，心跳还没发现)：网页刚挂上来时探测出来，自动重连
  const live = conns.at(-1);
  live._sock.pause(); // 模拟的主机不再读，什么都不回
  a.out = '';
  const b = new WebSocket(BASE.replace('http', 'ws') + '/ws');
  const bm = [];
  b.on('message', (d, bin) => { if (!bin) bm.push(JSON.parse(d)); });
  await new Promise((r) => b.on('open', r));
  b.send(JSON.stringify({ type: 'attach', id: a.sid(), offset: 0, cols: 100, rows: 30 }));
  const t1 = Date.now();
  await until(() => a.out.includes('SSH 连接没有响应') && /接上常驻会话 1/.test(a.out) && a.last('status')?.status === 'connected', 20000);
  ok(a.out.includes('SSH 连接没有响应') && /接上常驻会话 1/.test(a.out) && a.last('status')?.status === 'connected', `网页挂上来时 SSH 没响应：几秒内认出来，自动重连接回去 (${Date.now() - t1}ms)`);
  try { live._sock.resume(); live.end(); } catch {}
  b.close();
  a.type('echo three-$((3+3))\r');
  await until(() => a.out.includes('three-6'), 5000);
  ok(a.out.includes('three-6'), '探测出来重连以后照常');

  // ---- 3. 选择框标题带主机名 (不带「-序号」，按用户要求)；连接断了，还没回答的选择框关掉 (prompt-done)
  const c = tab(host.id);
  await until(() => c.picks.length, 15000);
  ok(c.picks[0].tab === 'DL', '选择框标题只带主机名、不带序号: ' + JSON.stringify(c.picks[0].tab));
  for (const x of conns) x.end();
  await until(() => c.msgs.some((m) => m.type === 'prompt-done'), 5000);
  ok(c.msgs.some((m) => m.type === 'prompt-done'), '连接断了：还没回答的选择框关掉 (不然回答了也没人收)');
  await until(() => /接上常驻会话 1/.test(a.out.split('连接已断开').pop() || '') && a.last('status')?.status === 'connected', 15000);
  for (const t of [a, c]) { await fetch(BASE + '/api/sessions/' + t.sid(), { method: 'DELETE' }); t.ws.close(); }
  fs.rmSync(home, { recursive: true, force: true });
});
