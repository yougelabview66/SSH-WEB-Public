'use strict';
// @env SSHWEBD_DIR=/tmp/sshweb-dl-bin
// 常驻会话 (sshwebd) 在 Linux 主机上：连上时认出是 Linux、什么架构，把 Linux 版传到 ~/.ssh-web/sshwebd-<哈希> (加执行权限)，
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
const { BASE, ok, wait, run, hostKey, addHost } = require('./helpers');

const BIN_DIR = '/tmp/sshweb-dl-bin'; // 服务器上的 Linux 版 (见开头的 @env)
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-dl-')));
const tmuxDir = path.join(home, 'tmux'); // tmux 的 socket 放这里 (TMUX_TMPDIR)，不碰本机的 tmux 服务
fs.mkdirSync(tmuxDir);
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
server(2341, false);
server(2342, true);

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
  if (!BIN) { ok(true, '(没有 Go：跳过 Linux 常驻会话测试)'); return; }
  // 装了钩子 (有 hook.sh 就读事件)
  fs.mkdirSync(path.join(home, '.ssh-web'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ssh-web', 'hook.sh'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(home, '.profile'), "PS1='$ '\n");
  const host = await addHost('DL', 2341, { winDaemon: true });

  // ---- 1. 连上：认出 Linux，传 Linux 版 (加执行权限)，新建常驻会话
  const a = tab(host.id);
  await until(() => /新建常驻会话 \d/.test(a.out) && a.last('status')?.status === 'connected', 20000);
  const up = fs.readdirSync(path.join(home, '.ssh-web')).find((n) => /^sshwebd-[0-9a-f]{8}$/.test(n));
  ok(a.out.includes('新建常驻会话 1') && up && (fs.statSync(path.join(home, '.ssh-web', up)).mode & 0o111), '认出 Linux：传 sshwebd-<哈希> (有执行权限)，新建常驻会话: ' + JSON.stringify([up, a.out.slice(-120)]));
  const h = (await (await fetch(BASE + '/api/hosts')).json()).find((x) => x.id === host.id);
  ok(h && h.os === 'linux', '记下这台是 Linux (主机列表上标「常驻」): ' + JSON.stringify(h && h.os));
  await until(() => /\$ $/.test(a.out), 5000);
  a.type('echo hi-$((40+2)) s=$SSHWEBD_SESSION\r');
  await until(() => a.out.includes('hi-42 s=1'), 5000);
  ok(a.out.includes('hi-42 s=1'), '打字、输出通；会话里有 SSHWEBD_SESSION');

  // ---- 2. 不用 tmux：历史取自服务器上的终端记录；项目目录按 SSHWEBD_SESSION 在 /proc 里找
  a.type("printf '\\033[32mGREEN-%s\\033[0m\\n' $((1+1))\r");
  await until(() => a.out.includes('GREEN-2'), 5000);
  let hs = await a.hist();
  ok(hs?.ok && hs.data.includes('hi-42 s=1') && hs.data.includes('\x1b[0;32mGREEN-2'), '不用 tmux：往上滚取到服务器上的终端记录 (带颜色): ' + JSON.stringify((hs?.data || hs?.reason || '').slice(-120)));
  fs.mkdirSync(path.join(home, 'proj'));
  // 以前同号会话 (守护进程重启前的会话 1) 留下的后台进程：会话号一样、创建时间不一样，不能认成这个会话的
  fs.mkdirSync(path.join(home, 'stale-dir'));
  fs.copyFileSync('/bin/sleep', path.join(home, 'claude')); fs.chmodSync(path.join(home, 'claude'), 0o755);
  const stale = spawn(path.join(home, 'claude'), ['300'], { cwd: path.join(home, 'stale-dir'), env: { SSHWEBD_SESSION: '1', SSHWEBD_STARTED: '123', PATH: process.env.PATH }, stdio: 'ignore' });
  a.type('cd proj\r'); await wait(800);
  const pi = await post('/api/project/info', { sid: a.sid(), dir: '' });
  ok(pi.source === 'terminal' && /\/proj$/.test(pi.root || pi.dir || ''), '项目目录：常驻会话里 cd 过去的目录 (按会话号 + 创建时间找进程，不认以前同号会话留下的): ' + JSON.stringify(pi));
  stale.kill();

  // ---- 3. 钩子：事件里 tabs 是旧标签、daemon 是会话编号 → 交给现在接着它的标签
  fs.mkdirSync(path.join(home, '.cache', 'ssh-web'), { recursive: true });
  await wait(1500);
  fs.appendFileSync(path.join(home, '.cache', 'ssh-web', 'hook.log'), JSON.stringify({ v: 2, t: Math.floor(Date.now() / 1000), agent: 'claude', tabs: 'old-tab', daemon: '1', pane: '', hook_event_name: 'UserPromptSubmit', prompt: '整理代码' }) + '\n');
  await until(() => /整理代码/.test(a.last('state')?.detail || ''), 5000);
  ok(/在做：整理代码/.test(a.last('state')?.detail || ''), '钩子事件按 daemon (会话编号) 交给现在接着它的标签: ' + JSON.stringify(a.last('state')));
  // Agent 报了它干活的目录 → 项目目录用它；Agent 退出 (SessionEnd) / 被直接杀掉 → 不再停在它的目录，回到终端所在的目录。
  // 每次读项目信息都在主机上看一眼 Agent 还在不在：在常驻会话里跑一个假的 claude (拷一份 sleep 改名)
  const agentDir = path.join(home, 'agent-dir'); fs.mkdirSync(agentDir);
  const hookLine = (ev) => fs.appendFileSync(path.join(home, '.cache', 'ssh-web', 'hook.log'), JSON.stringify({ v: 2, t: Math.floor(Date.now() / 1000), agent: 'claude', tabs: 'old-tab', daemon: '1', pane: '', ...ev }) + '\n');
  const projInfo = () => post('/api/project/info', { sid: a.sid(), dir: '' });
  a.type('"$HOME/claude" 300 &\r'); await wait(800);
  hookLine({ hook_event_name: 'PreToolUse', tool_name: 'Bash', command: 'ls', cwd: agentDir });
  await until(() => a.msgs.some((m) => m.type === 'agent-cwd'), 5000);
  let pj = await projInfo();
  ok(pj.source === 'agent' && /agent-dir$/.test(pj.root || pj.dir || ''), 'Agent 报了干活的目录、Agent 还在：项目目录用它: ' + JSON.stringify(pj));
  const nAgent = a.msgs.filter((m) => m.type === 'agent-cwd').length;
  a.type('kill $!\r'); await wait(500);
  hookLine({ hook_event_name: 'SessionEnd', reason: 'exit' });
  await until(() => a.msgs.filter((m) => m.type === 'agent-cwd').length > nAgent, 5000);
  pj = await projInfo();
  ok(pj.source === 'terminal' && /\/proj$/.test(pj.root || pj.dir || ''), 'Agent 退出 (SessionEnd)：项目目录回到终端所在的目录: ' + JSON.stringify(pj));
  // 被直接杀掉 (没报 SessionEnd)：打开 / 刷新右边栏时发现 Agent 不在了，不再用它的目录
  a.type('"$HOME/claude" 300 &\r'); await wait(800);
  hookLine({ hook_event_name: 'PreToolUse', tool_name: 'Bash', command: 'ls', cwd: agentDir }); await wait(1000);
  pj = await projInfo();
  const live = pj.source === 'agent' && /agent-dir$/.test(pj.root || pj.dir || '');
  a.type('kill -9 $!\r'); await wait(800);
  pj = await projInfo();
  ok(live && pj.source === 'terminal' && /\/proj$/.test(pj.root || pj.dir || ''), 'Agent 被直接杀掉、没报 SessionEnd：读项目信息时发现它不在了，回到终端所在的目录: ' + JSON.stringify(pj));

  // ---- 4. 断网 → 重新连上：接回同一个会话，只补发断开期间的输出
  a.type('sleep 1; echo after-drop-$((1+1))\r'); await wait(300);
  for (const c of conns) c.end();
  await until(() => a.out.includes('连接已断开'), 5000);
  await wait(1500);
  a.send({ type: 'reconnect' });
  await until(() => a.out.includes('after-drop-2'), 15000);
  ok(a.out.includes('接上常驻会话 1') && a.out.includes('after-drop-2') && a.out.split('hi-42 s=1').length - 1 === 1, '断网后重新连上：接回同一个会话，补上断开期间的输出，之前的不重发');

  // ---- 5. 用 tmux：敲 tmux 提示一次；历史走 tmux capture-pane；换个标签接上也找得到 pane
  if (hasTmux) {
    a.type('tmux -f /dev/null new -s t\r');
    await until(() => a.msgs.some((m) => m.type === 'toast'), 5000);
    ok(/不用再开 tmux/.test(a.msgs.find((m) => m.type === 'toast')?.text || ''), '在常驻会话里敲 tmux：提示一次不用再开 (开着也没问题)');
    await wait(1500);
    a.type('seq 1 40 | sed s/^/tline-/\r'); await wait(1200);
    hs = await a.hist();
    ok(hs?.ok && /tline-1\n/.test(hs.data) && hs.data.includes('tline-40'), '常驻会话里开着 tmux：历史走 tmux capture-pane: ' + JSON.stringify((hs?.data || hs?.reason || '').slice(-80)));
    // 关掉标签，再开一个标签接上这个会话 (LC_SSHWEB 还是第一个标签的，按 SSHWEBD_SESSION 照样找得到)
    await fetch(BASE + '/api/sessions/' + a.sid(), { method: 'DELETE' });
    a.ws.close(); await wait(800);
    const b = tab(host.id);
    await until(() => b.picks.length, 15000);
    b.send({ type: 'daemon-pick-response', id: '1' });
    await until(() => b.out.includes('接上常驻会话 1') && b.last('status')?.status === 'connected', 15000);
    await until(() => b.msgs.some((m) => m.type === 'toast'), 5000);
    ok(/不用再开 tmux/.test(b.msgs.find((m) => m.type === 'toast')?.text || ''), '接上时里面开着 tmux：也提示一次');
    hs = await b.hist();
    ok(hs?.ok && hs.data.includes('tline-40'), '换了标签接上：照样找得到这个会话里的 tmux pane: ' + JSON.stringify((hs?.data || hs?.reason || '').slice(-60)));
    try { execFileSync('tmux', ['kill-server'], { env: ENV, stdio: 'ignore' }); } catch {}
    await wait(800);
    b.type('exit\r');
    await until(() => /常驻会话 1 已结束/.test(b.out), 8000);
    b.ws.close();
  } else {
    ok(true, '(没有 tmux：跳过常驻会话里开 tmux 的部分)');
    a.type('exit\r');
    await until(() => /常驻会话 1 已结束/.test(a.out), 8000);
    a.ws.close();
  }

  // ---- 5b. 断线期间会话被别的标签接走了：重新连上时不去抢，提示一句、弹列表重新选
  const d = tab(host.id);
  await until(() => (d.picks.length || /新建常驻会话 \d/.test(d.out)), 15000);
  if (d.picks.length) d.send({ type: 'daemon-pick-response', id: '' });
  await until(() => /新建常驻会话 \d/.test(d.out) && d.last('status')?.status === 'connected', 15000);
  const did = /新建常驻会话 (\d+)/.exec(d.out)[1];
  for (const c of conns) c.end();
  await until(() => d.out.includes('连接已断开'), 5000);
  await wait(800);
  const e = tab(host.id);
  await until(() => e.picks.length, 15000);
  ok((e.picks[0].sessions || []).some((x) => x.id === did), '断线期间：这个会话没人接着，别的新标签的列表里有它');
  e.send({ type: 'daemon-pick-response', id: did });
  await until(() => e.out.includes(`接上常驻会话 ${did}`) && e.last('status')?.status === 'connected', 15000);
  d.out = '';
  d.send({ type: 'reconnect' });
  await until(() => d.picks.length, 15000);
  const dp = d.picks[0] || {};
  ok(d.out.includes(`之前接着的常驻会话 ${did} 已经被别的标签接上了`) && /已经被别的标签接上了/.test(dp.note || '') && !(dp.sessions || []).some((x) => x.id === did),
    '重新连上时会话已经被别的标签接走：不去抢，提示一句、弹列表重新选 (被接走的不在列表里): ' + JSON.stringify(dp));
  d.send({ type: 'daemon-pick-response', id: '' });
  await until(() => /新建常驻会话 \d/.test(d.out) && d.last('status')?.status === 'connected', 15000);
  ok(/新建常驻会话 \d/.test(d.out) && !d.out.includes(`接上常驻会话 ${did}`), '选「新建会话」：开一个新的，原来那个留给接走它的标签');
  for (const t of [d, e]) { t.type('exit\r'); }
  await wait(1500);
  d.ws.close(); e.ws.close();

  // ---- 6. 不是 Linux (macOS 等)：照常开普通终端，不提示
  const mac = await addHost('MAC', 2342, { winDaemon: true });
  const m = tab(mac.id);
  await until(() => m.out.includes('mac$') && m.last('status')?.status === 'connected', 15000);
  const hm = (await (await fetch(BASE + '/api/hosts')).json()).find((x) => x.id === mac.id);
  ok(darwinShells === 1 && !m.out.includes('常驻会话没开起来') && hm?.os === 'other', 'macOS：照常开普通终端，不提示，不标「常驻」: ' + JSON.stringify(hm?.os));
  m.ws.close();

  for (const x of await (await fetch(BASE + '/api/sessions')).json()) await fetch(BASE + '/api/sessions/' + x.id, { method: 'DELETE' });
  await wait(4000); // 守护进程没事做了自己退出 (SSHWEBD_IDLE=3s)
  ok(/没有会话了，退出/.test(fs.readFileSync(path.join(home, '.ssh-web', 'sshwebd.log'), 'utf8')), '守护进程没有会话后自己退出');
  try { execFileSync('tmux', ['kill-server'], { env: ENV, stdio: 'ignore' }); } catch {}
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(BIN_DIR, { recursive: true, force: true });
});
