'use strict';
// @env SSHWEBD_DIR=/tmp/sshweb-df-bin
// 常驻会话 (sshwebd) 开不起来时不再停在「连接中」(标签黄着)：
// - 先降级成普通终端，马上能用；
// - 同时自动修复 sshwebd：第 1 轮结束主机上僵死的进程，还不行第 2 轮把传上去的二进制删掉重新传；
// - 修复动作做完时用户已经在降级的终端里干活 (按过回车) 的话不硬切，下次连接自然用常驻会话；
// - 没人在干活就自动重连切回常驻会话。
// 不编真的 Go 版 sshwebd，用说桥接协议的假 sshwebd (test/daemonfix-fake.js) 冒充：先放「坏」的 (bridge 一启动
// 就报错)，第 1 轮修复只杀进程、主机上的文件没变 (还是坏的)，第 2 轮删掉文件 —— 连接前把服务器上的换成好的，
// 重传上去的就是好的。模拟主机同 daemonlinux.test.js (假的 /home/u 换成真的临时目录)；端口动态挑 (2343 这种
// 固定端口在 Windows 上可能落在保留段里)。
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Server, utils: { sftp: { OPEN_MODE, STATUS_CODE } } } = require('ssh2');
const WebSocket = require('ws');
const { BASE, ok, wait, run, hostKey, addHost } = require('./helpers');

const BIN_DIR = '/tmp/sshweb-df-bin'; // 服务器上的 Linux 版 (见开头的 @env)
const VHOME = '/home/u'; // 模拟主机的 home：SFTP 里的路径都挂在它下面
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-df-')));
const homeFwd = home.replace(/\\/g, '/'); // 命令里替换用正斜杠的写法 (sh 里好使)
const ENV = { HOME: home, PATH: process.env.PATH, LANG: 'C.UTF-8' };
const until = async (fn, ms) => { for (const end = Date.now() + ms; !fn() && Date.now() < end;) await wait(100); };
const freePort = () => new Promise((resolve) => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// 坏的 sshwebd：bridge 一启动就报错退出 (守护进程起不来)。好的 = daemonfix-fake.js，连接中拷进 BIN_DIR
const BROKEN = "#!/usr/bin/env node\nprocess.stdout.write('SSHWEBD ERROR fake-broken\\n');\n";
const healthy = () => fs.readFileSync(path.join(__dirname, 'daemonfix-fake.js'), 'utf8').replace(/\r\n/g, '\n'); // CRLF 会弄坏 shebang

const cmds = []; // 模拟主机上执行过的命令 (验证修复动作真的发过去了)
function server(port) {
  new Server({ hostKeys: [hostKey()] }, (c) => {
    c.on('error', () => {});
    c.on('authentication', (ctx) => ctx.accept());
    c.on('ready', () => c.on('session', (acc) => {
      const s = acc();
      s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
      // 普通终端 (降级用的)：管道接到一个真的 sh (没有 pty，把回车 \r 换成 \n)
      s.on('shell', (a) => {
        const ch = a();
        const pr = spawn('sh', [], { cwd: home, env: ENV });
        ch.on('data', (d) => { try { pr.stdin.write(d.toString().replace(/\r(?!\n)/g, '\n')); } catch {} });
        ch.stderr?.resume?.();
        ch.on('close', () => { try { pr.kill('SIGKILL'); } catch {} });
        pr.stdout.on('data', (d) => { try { ch.write(d); } catch {} });
        pr.stderr.on('data', (d) => { try { ch.stderr.write(d); } catch {} });
        pr.on('exit', () => { try { ch.exit(0); ch.end(); } catch {} });
        ch.on('close', () => { try { pr.kill('SIGKILL'); } catch {} });
      });
      s.on('exec', (a, r, info) => {
        const ch = a();
        cmds.push(info.command);
        if (info.command === 'uname -sm') { ch.write('Linux x86_64\n'); ch.exit(0); ch.end(); return; }
        if (/^pkill/.test(info.command)) { // 修复的杀进程慢一点：让测试「正在干活」的打字稳稳赶在修复完成前 (不然有时序竞态)
          setTimeout(() => { try { ch.exit(0); ch.end(); } catch {} }, 1500);
          return;
        }
        const cmd = info.command.split(VHOME).join(homeFwd); // 假的 home 路径换成真的，sh 里执行得了
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
        const loc = (p) => (p === '.' || p === '' || p === VHOME ? home : p.startsWith(VHOME + '/') ? path.join(home, p.slice(VHOME.length + 1)) : p);
        const handle = (v) => { const h = Buffer.alloc(4); h.writeUInt32BE(next); hs.set(next++, v); return h; };
        const get = (h) => hs.get(h.readUInt32BE());
        const okr = (id) => sf.status(id, STATUS_CODE.OK);
        const err = (id, e) => sf.status(id, e && e.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE);
        const attrs = (st) => ({ mode: st.mode, uid: 0, gid: 0, size: st.size, atime: st.atimeMs / 1000 | 0, mtime: st.mtimeMs / 1000 | 0 });
        const fsFlags = (f) => (f & OPEN_MODE.READ && f & OPEN_MODE.WRITE ? fs.constants.O_RDWR : f & OPEN_MODE.WRITE ? fs.constants.O_WRONLY : fs.constants.O_RDONLY)
          | (f & OPEN_MODE.CREAT ? fs.constants.O_CREAT : 0) | (f & OPEN_MODE.TRUNC ? fs.constants.O_TRUNC : 0) | (f & OPEN_MODE.EXCL ? fs.constants.O_EXCL : 0);
        sf.on('REALPATH', (id) => sf.name(id, [{ filename: VHOME, longname: VHOME, attrs: {} }]));
        sf.on('STAT', (id, p) => { try { sf.attrs(id, attrs(fs.statSync(loc(p)))); } catch (e) { err(id, e); } });
        sf.on('LSTAT', (id, p) => { try { sf.attrs(id, attrs(fs.lstatSync(loc(p)))); } catch (e) { err(id, e); } });
        sf.on('FSTAT', (id, h) => { try { sf.attrs(id, attrs(fs.fstatSync(get(h).fd))); } catch (e) { err(id, e); } });
        sf.on('MKDIR', (id, p) => { try { fs.mkdirSync(loc(p)); okr(id); } catch (e) { err(id, e); } });
        sf.on('OPEN', (id, p, flags) => { try { sf.handle(id, handle({ fd: fs.openSync(loc(p), fsFlags(flags), 0o755) })); } catch (e) { err(id, e); } });
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

// 一个标签 (直接用 WebSocket，和网页一样的消息)
function tab(hostId, title) {
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws');
  const t = { ws, out: '', msgs: [] };
  ws.on('message', (d, bin) => {
    if (bin) { t.out += d.toString(); return; }
    const m = JSON.parse(d);
    t.msgs.push(m);
  });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'connect', hostId, title, cols: 100, rows: 30 })));
  t.send = (o) => ws.send(JSON.stringify(o));
  t.type = (s) => t.send({ type: 'data', data: s });
  t.last = (type) => [...t.msgs].reverse().find((m) => m.type === type);
  t.sid = () => t.msgs.find((m) => m.type === 'attached')?.session?.id;
  return t;
}

run(async () => {
  // 服务器上先放「坏」的 sshwebd：连接时传到主机上，bridge 一启动就报错
  fs.rmSync(BIN_DIR, { recursive: true, force: true });
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.writeFileSync(path.join(BIN_DIR, 'version.txt'), '9.9.9\n');
  fs.writeFileSync(path.join(BIN_DIR, 'sshwebd-linux-amd64'), BROKEN);
  const port = await freePort();
  server(port);
  const host = await addHost('DF', port, { winDaemon: true });

  // ---- 1. sshwebd 坏了：提示原因、降级成普通终端 (不再停在「连接中」)，终端马上能用
  const t = tab(host.id, 'DF');
  await until(() => t.out.includes('常驻会话没开起来：fake-broken') && t.last('status')?.status === 'connected', 20000);
  ok(t.out.includes('常驻会话没开起来：fake-broken') && t.last('status')?.status === 'connected', 'sshwebd 坏了：提示原因并降级成普通终端 (标签不再黄着)');
  t.type('echo fallback-ok\r');
  await until(() => t.out.includes('fallback-ok'), 5000);
  ok(t.out.includes('fallback-ok'), '降级的普通终端能用 (能跑命令)');

  // ---- 2. 修复期间用户已经在终端里干活 (刚按过回车)：修完不硬切，下次连接自然用常驻会话
  await until(() => t.out.includes('正在修复 sshwebd'), 10000);
  await until(() => t.out.includes('sshwebd 已修复；正在用的普通终端不断开'), 20000);
  ok(t.out.includes('sshwebd 已修复；正在用的普通终端不断开'), '用户在降级的终端里干活：修复后不硬切，留在普通终端');
  ok(cmds.some((c) => c.includes('pkill')), '修复动作发到了主机上 (结束卡住的 sshwebd 进程)');
  await fetch(BASE + '/api/sessions/' + t.sid(), { method: 'DELETE' });
  t.ws.close();

  // ---- 3. 没人干活：自动修复 (杀进程 → 还不行删掉重传) 后自动重连切回常驻会话。
  // 服务器上换成「好」的 sshwebd：第 1 轮修复只杀进程 (主机上的文件还是坏的)，第 2 轮删掉文件重传 —— 传的就是好的
  fs.writeFileSync(path.join(BIN_DIR, 'sshwebd-linux-amd64'), healthy());
  const a = tab(host.id, 'DF');
  await until(() => a.out.includes('常驻会话没开起来：fake-broken') && a.last('status')?.status === 'connected', 20000);
  await until(() => a.out.includes('第 2/2 次'), 10000);
  await until(() => /新建常驻会话 \d+ \(sshwebd 9\.9\.9/.test(a.out) && a.last('status')?.status === 'connected', 40000);
  ok(/新建常驻会话 \d+ \(sshwebd 9\.9\.9/.test(a.out) && a.last('status')?.status === 'connected', '自动修复走满两轮 (杀进程 → 删掉重传)，重连切回常驻会话');
  ok(a.out.includes('sshwebd 已修复，重新连接切到常驻会话'), '切回前提示「已修复，重新连接切到常驻会话」');
  const onHost = fs.readFileSync(path.join(home, '.ssh-web', 'sshwebd-v9.9.9'), 'utf8');
  ok(onHost.includes('SSHWEBD READY 9.9.9'), '主机上坏掉的文件被删掉、重新传了好的 (不是一直用坏的)');
  ok(cmds.filter((c) => c.includes('pkill')).length >= 2, '两轮修复都向主机发了结束进程的命令');

  // ---- 4. 切回常驻会话以后终端能干活
  a.type('echo daemon-ok\r');
  await until(() => a.out.includes('daemon-ok'), 5000);
  ok(a.out.includes('daemon-ok'), '切回常驻会话后终端能用 (输入、输出都走守护进程)');
  await fetch(BASE + '/api/sessions/' + a.sid(), { method: 'DELETE' });
  a.ws.close();
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  fs.rmSync(BIN_DIR, { recursive: true, force: true });
});
