'use strict';
// @env SSHWEBD_EXE=/tmp/sshweb-dw-sshwebd.exe
// Windows 常驻会话 (sshwebd)：主机设置里打开后，连上时开一个不要终端的通道跑 ~/.ssh-web/ 里的 sshwebd bridge，
// 终端在守护进程里 (服务器上有 sshwebd.exe 就先传过去)。这里模拟一台 Windows 主机 (SSH 默认 cmd)，bridge 用真的 sshwebd (Linux 版，用 sshwebd/ 的源码编，
// 或者 SSHWEBD_BIN 指定)：打字、断网后重新连上接着用 (只补发没收到的)、关了标签再开一个选「接上」、exit 结束
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { Server, utils: { sftp: { OPEN_MODE, STATUS_CODE } } } = require('ssh2');
const WebSocket = require('ws');
const { BASE, ok, wait, run, launch, hostKey, addHost } = require('./helpers');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-dw-')));
const dhome = path.join(home, 'daemon'); // 守护进程的数据目录 (socket、日志)
fs.mkdirSync(dhome);
const HOME = '/C:/Users/me';
const until = async (fn, ms) => { for (const end = Date.now() + ms; !fn() && Date.now() < end;) await wait(100); };
const SRV_EXE = '/tmp/sshweb-dw-sshwebd.exe'; // 服务器上的 sshwebd.exe (见开头的 @env)
fs.rmSync(SRV_EXE, { force: true });

// Linux 版 sshwebd：SSHWEBD_BIN，或者用 sshwebd/ 的源码编一个
function linuxBin() {
  if (process.env.SSHWEBD_BIN) return process.env.SSHWEBD_BIN;
  const src = path.join(__dirname, '..', 'sshwebd');
  const go = ['/root/.local/go/bin/go', '/usr/local/go/bin/go', 'go'].find((g) => { try { execFileSync(g, ['version'], { stdio: 'ignore' }); return true; } catch { return false; } });
  if (!go || !fs.existsSync(path.join(src, 'main.go'))) return null;
  const out = path.join(home, 'sshwebd');
  execFileSync(go, ['build', '-o', out, '.'], { cwd: src, env: { ...process.env, CGO_ENABLED: '0' }, stdio: 'ignore' });
  return out;
}
const BIN = linuxBin();
// 会话里 shell 的主目录：.profile 设提示符，每次显示时先报当前目录 (OSC 9;9，同 sshwebd 给 Windows 的 PowerShell / cmd 加的)。
// sshwebd 按登录 shell 启动 (sh -l)，/etc/profile 会改掉环境变量里的 PS1，所以写在 .profile 里
const shHome = path.join(home, 'shhome');
fs.mkdirSync(shHome);
fs.writeFileSync(path.join(shHome, '.profile'), 'PS1="$(printf \'\\033]9;9;\')\\$PWD$(printf \'\\007\')$ "\n');

let conns = [], shells = 0, bridges = [];
new Server({ hostKeys: [hostKey()] }, (c) => {
  conns.push(c);
  c.on('error', () => {});
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { shells++; a().write('C:\\Users\\me>'); });
    s.on('exec', (a, r, info) => {
      const ch = a(), cmd = info.command;
      const out = (t, code) => { if (t) ch.write(t); ch.exit(code); ch.end(); };
      if (cmd === 'echo %OS%;$env:OS') return out('Windows_NT;$env:OS\r\n', 0);
      if (cmd.includes('watch.ps1')) return out('SSHWEB_HOOKS=0\r\n', 0);
      const m = /^"C:\\Users\\me\\\.ssh-web\\(sshwebd[^"\\]*\.exe)" bridge$/.exec(cmd);
      if (m && BIN) { // 真的跑 bridge (Windows 的 OpenSSH 在 SSH 断开时结束整个会话的进程：这里通道关了就杀掉它)
        bridges.push({ cmd, exe: m[1] });
        const pr = spawn(BIN, ['bridge'], { env: { ...process.env, SSHWEBD_HOME: dhome, SSHWEBD_IDLE: '3s', SHELL: '/bin/sh', HOME: shHome, ENV: '' } });
        ch.on('data', (d) => pr.stdin.write(d));
        pr.stdout.on('data', (d) => { try { ch.write(d); } catch {} });
        pr.on('exit', (code) => { try { ch.exit(code || 0); ch.end(); } catch {} });
        ch.on('close', () => pr.kill('SIGKILL'));
        return;
      }
      ch.stderr.write(`'${cmd.split(' ')[0]}' is not recognized as an internal or external command,\r\n`);
      out('', 1);
    });
    s.on('sftp', (accept) => {
      const sf = accept();
      const hs = new Map(); let next = 1;
      const loc = (p) => { const r = p === '.' || p === '' ? HOME : p; return path.join(home, r.startsWith(HOME) ? r.slice(HOME.length) : '/nope'); };
      const handle = (v) => { const h = Buffer.alloc(4); h.writeUInt32BE(next); hs.set(next++, v); return h; };
      const get = (h) => hs.get(h.readUInt32BE());
      const okr = (id) => sf.status(id, STATUS_CODE.OK);
      const err = (id, e) => sf.status(id, e && e.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE);
      const attrs = (st) => ({ mode: st.mode, uid: 0, gid: 0, size: st.size, atime: st.atimeMs / 1000 | 0, mtime: st.mtimeMs / 1000 | 0 });
      const fsFlags = (f) => (f & OPEN_MODE.READ && f & OPEN_MODE.WRITE ? fs.constants.O_RDWR : f & OPEN_MODE.WRITE ? fs.constants.O_WRONLY : fs.constants.O_RDONLY)
        | (f & OPEN_MODE.CREAT ? fs.constants.O_CREAT : 0) | (f & OPEN_MODE.TRUNC ? fs.constants.O_TRUNC : 0) | (f & OPEN_MODE.EXCL ? fs.constants.O_EXCL : 0);
      sf.on('REALPATH', (id, p) => { const r = p === '.' ? HOME : p.replace(/\/+$/, ''); sf.name(id, [{ filename: r, longname: r, attrs: {} }]); });
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
        sf.name(id, fs.readdirSync(d.dir).map((n) => ({ filename: n, longname: n, attrs: attrs(fs.statSync(path.join(d.dir, n))) })));
      });
      sf.on('READ', (id, h, off, len) => { const buf = Buffer.alloc(len); const n = fs.readSync(get(h).fd, buf, 0, len, off); if (!n) return sf.status(id, STATUS_CODE.EOF); sf.data(id, buf.subarray(0, n)); });
      sf.on('WRITE', (id, h, off, data) => { try { fs.writeSync(get(h).fd, data, 0, data.length, off); okr(id); } catch (e) { err(id, e); } });
      sf.on('CLOSE', (id, h) => { const f = get(h); if (f && f.fd != null) fs.closeSync(f.fd); hs.delete(h.readUInt32BE()); okr(id); });
      sf.on('RENAME', (id, a, b) => { if (fs.existsSync(loc(b))) return err(id); try { fs.renameSync(loc(a), loc(b)); okr(id); } catch (e) { err(id, e); } });
      sf.on('REMOVE', (id, p) => { try { fs.unlinkSync(loc(p)); okr(id); } catch (e) { err(id, e); } });
      sf.on('SETSTAT', (id) => okr(id)); sf.on('FSETSTAT', (id) => okr(id));
    });
  }));
}).listen(2321, '127.0.0.1');

// 一个标签 (直接用 WebSocket，和网页一样的消息)
function tab(hostId, title) {
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws');
  const t = { ws, out: '', msgs: [], prompts: [] };
  ws.on('message', (d, bin) => {
    if (bin) { t.out += d.toString(); return; }
    const m = JSON.parse(d);
    t.msgs.push(m);
    if (m.type === 'prompt') t.prompts.push(m);
  });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'connect', hostId, title, cols: 100, rows: 30 })));
  t.send = (o) => ws.send(JSON.stringify(o));
  t.type = (s) => t.send({ type: 'data', data: s });
  t.last = (type) => [...t.msgs].reverse().find((m) => m.type === type);
  t.count = (s) => t.out.split(s).length - 1;
  return t;
}

run(async () => {
  if (!BIN) { ok(true, '(没有 Go，也没设 SSHWEBD_BIN：跳过常驻会话测试)'); return; }
  const host = await addHost('DW', 2321, { winDaemon: true });
  ok(host.winDaemon === true, '主机设置里记下「Windows 常驻会话」');

  // ---- 0. 主机上、服务器上都没有 sshwebd.exe (服务器上的路径用 SSHWEBD_EXE 指到一个不存在的文件)：提示放到哪里，改用普通终端
  const z = tab(host.id, 'DW');
  await until(() => z.out.includes('C:\\Users\\me>'), 15000);
  ok(/常驻会话没开起来：主机上没有 sshwebd：把 sshwebd\.exe 放到 C:\\Users\\me\\\.ssh-web\\/.test(z.out) && shells === 1 && !bridges.length,
    '没有 sshwebd.exe：提示放到 C:\\Users\\me\\.ssh-web\\，改开普通终端');
  await fetch(BASE + '/api/sessions/' + z.msgs.find((m) => m.type === 'attached')?.session?.id, { method: 'DELETE' });
  z.ws.close();

  // ---- 1. 主机上放了 sshwebd.exe：连上跑 bridge，新建常驻会话 (不开普通 shell，不传文件)
  const edir = path.join(home, '.ssh-web');
  fs.mkdirSync(edir);
  fs.writeFileSync(path.join(edir, 'sshwebd.exe'), 'exe on host');
  const a = tab(host.id, 'DW');
  await until(() => /\$ $/.test(a.out) && a.last('status')?.status === 'connected', 15000);
  ok(bridges.length === 1 && bridges[0].exe === 'sshwebd.exe' && shells === 1 && a.out.includes('新建常驻会话 1'),
    '开的是 bridge 通道 (cmd 写法 "C:\\…\\sshwebd.exe" bridge)，没开普通 shell: ' + JSON.stringify(bridges[0]));
  ok(fs.readdirSync(edir).join() === 'sshwebd.exe' && !a.out.includes('正在把 sshwebd 传到主机'), '服务器上没有 sshwebd.exe：不传文件，用主机上的');
  ok(a.last('params')?.params?.daemonId === '1', '告诉网页接着的是哪个常驻会话 (服务重启后照原样接回去)');
  a.type('echo hi-$((40+2)) $LC_SSHWEB\r');
  const sid = a.msgs.find((m) => m.type === 'attached')?.session?.id;
  await until(() => a.out.includes(`hi-42 ${sid}`), 5000);
  ok(a.out.includes(`hi-42 ${sid}`), '打字、输出都通；会话里有 LC_SSHWEB (钩子按它找标签)');

  // ---- 2. 断网 (SSH 连接断了)：会话在守护进程里继续跑；重新连上接着用，只补发没收到的
  a.type('sleep 1; echo after-drop-$((1+1))\r');
  await wait(300);
  for (const c of conns) c.end();
  await until(() => a.out.includes('连接已断开'), 5000);
  await wait(1500);
  ok(!a.out.includes('after-drop-2'), '断开期间的输出还没收到');
  a.send({ type: 'reconnect' });
  await until(() => a.out.includes('after-drop-2'), 15000);
  ok(a.out.includes('接上常驻会话 1') && a.out.includes('after-drop-2'), '重新连上：接回同一个常驻会话，断开期间的输出补上了');
  ok(a.count('hi-42') === 1, '之前收到过的不再重发 (hi-42 只出现一次): ' + a.count('hi-42'));
  ok(bridges.length === 2 && fs.readdirSync(edir).join() === 'sshwebd.exe', '重新连上照样用主机上的 sshwebd.exe');

  // 滚轮往上看历史 (同 Linux 上的 tmux)：常驻会话没有 tmux，历史从服务器上这个终端自己的记录里拿，带颜色
  a.type("printf '\\033[31mRED-%s\\033[0m\\n' $((40+2))\r");
  await until(() => a.out.includes('RED-42'), 5000);
  const hist = await new Promise((resolve) => {
    const n = a.msgs.length;
    a.send({ type: 'tmux-history', lines: 3000 });
    const t = setInterval(() => { const m = a.msgs.slice(n).find((x) => x.type === 'tmux-history'); if (m) { clearInterval(t); resolve(m); } }, 50);
    setTimeout(() => { clearInterval(t); resolve(null); }, 5000);
  });
  ok(hist?.ok && hist.data.includes('hi-42') && hist.data.includes('after-drop-2') && hist.data.includes('\x1b[0;31mRED-42'),
    '常驻会话往上滚看历史：从服务器上的终端记录拿 (之前的输出都在、带颜色): ' + JSON.stringify((hist?.data || hist?.reason || '').slice(-200)));

  // 提示符报的当前目录 (OSC 9;9，sshwebd 给 Windows 的 PowerShell / cmd 加上的)：右边栏的项目目录用它
  a.type("cd /tmp; printf '\\033]0;my-task\\007'\r"); await wait(800);
  const pi = await (await fetch(BASE + '/api/project/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid, dir: '' }) })).json();
  ok(pi.source === 'terminal' && JSON.stringify(pi).includes('tmp'), '常驻会话：右边栏的项目目录是 shell 报的当前目录 (cd 过去的): ' + JSON.stringify(pi).slice(0, 160));

  // ---- 3. 关掉标签 (常驻会话还在)，再开一个标签：问接哪个，选 1 接上 (全部补发)
  await fetch(BASE + '/api/sessions/' + sid, { method: 'DELETE' });
  a.ws.close();
  await wait(800);
  // 先多开一个常驻会话 (问接哪个时空着 = 新建)，关掉标签：现在有两个没人接着的
  const c0 = tab(host.id, 'DW');
  await until(() => c0.prompts.length, 15000);
  c0.send({ type: 'prompt-response', answers: [''] });
  await until(() => /新建常驻会话 \d/.test(c0.out) && c0.last('status')?.status === 'connected', 15000);
  const sid0 = c0.msgs.find((m) => m.type === 'attached')?.session?.id;
  await fetch(BASE + '/api/sessions/' + sid0, { method: 'DELETE' });
  c0.ws.close();
  await wait(800);
  const b = tab(host.id, 'DW');
  await until(() => b.prompts.length, 15000);
  const pr0 = b.prompts[0] || {};
  ok(/1\. \/tmp[\s\S]*2\. /.test(pr0.instructions || '') && /删 2/.test(pr0.instructions || ''), '问接哪个：两个会话都列出来，说明可以「删 N」结束: ' + JSON.stringify(pr0.instructions));
  // 删 2：结束第 2 个，再问一次，只剩第 1 个
  b.send({ type: 'prompt-response', answers: ['删 2'] });
  await until(() => b.prompts.length > 1, 8000);
  const pr = b.prompts[1] || {};
  ok(/^已结束：/.test(pr.instructions || '') && !/\n2\. /.test(pr.instructions || ''), '填「删 2」：第 2 个结束了，再问一次时只剩第 1 个: ' + JSON.stringify(pr.instructions));
  ok(pr.title === '接上常驻会话' && /1\. \/tmp\n\s+my-task\n\s+.*有输出 · .*开的/.test(pr.instructions || ''), '新开标签：问接哪个常驻会话，每个显示所在文件夹、标题、多久前有输出: ' + JSON.stringify(pr.instructions));
  b.send({ type: 'prompt-response', answers: ['1'] });
  await until(() => b.out.includes('after-drop-2') && b.last('status')?.status === 'connected', 10000);
  ok(b.out.includes('接上常驻会话 1') && b.out.includes('hi-42') && b.out.includes('after-drop-2'), '选 1：接上，之前的输出全部补发');

  // ---- 4. exit：常驻会话结束
  b.type('exit 5\r');
  await until(() => b.out.includes('连接已断开'), 8000);
  ok(b.out.includes('常驻会话 1 已结束 (退出码 5)'), '在会话里 exit：显示常驻会话结束和退出码');
  ok(!b.last('params')?.params?.daemonId, '结束后不再记着这个常驻会话');

  // ---- 4b. 服务器上有 sshwebd.exe：传到 ~/.ssh-web/sshwebd-<哈希>.exe 用它 (正在运行的 exe 不能覆盖，所以换名字)
  fs.writeFileSync(SRV_EXE, 'exe on server');
  const c = tab(host.id, 'DW');
  await until(() => /新建常驻会话 \d/.test(c.out) && c.last('status')?.status === 'connected', 15000);
  const cid = /新建常驻会话 (\d+)/.exec(c.out)?.[1];
  const up = fs.readdirSync(edir).find((n) => /^sshwebd-[0-9a-f]{8}\.exe$/.test(n));
  ok(up && fs.readFileSync(path.join(edir, up), 'utf8') === 'exe on server' && c.out.includes('正在把 sshwebd 传到主机') && bridges.at(-1).exe === up,
    `服务器上的 sshwebd.exe 传过去 (${up}) 再用它: ` + JSON.stringify(bridges.at(-1)));
  ok(fs.readdirSync(edir).sort().join() === [up, 'sshwebd.exe'].sort().join(), '主机上自己放的 sshwebd.exe 不删，没有留下 .part');
  c.type('exit\r');
  await until(() => c.out.includes(`常驻会话 ${cid} 已结束`), 8000);
  c.ws.close();

  // ---- 5. 网页：主机列表上标「常驻」，编辑主机时勾着
  const browser = await launch();
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  const row = p.locator('.host', { hasText: 'DW' }).first();
  const badge = row.locator('.badge', { hasText: '常驻' });
  const look = await badge.evaluate((e) => { const cs = getComputedStyle(e); return { color: cs.color, accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() }; }).catch(() => null);
  await badge.screenshot({ path: require('./helpers').shot('daemon-badge.png') }).catch(() => {});
  ok(await badge.count() === 1 && look && look.color !== 'rgb(255, 255, 255)', '主机列表上标「常驻」(主题绿的淡色标记，不是橙底白字): ' + JSON.stringify(look));
  await row.hover(); await row.locator('[data-op=edit]').click();
  ok(await p.isChecked('#hostForm [name=winDaemon]'), '编辑主机：「Windows 常驻会话」勾着');
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close();
  b.ws.close();
  for (const x of await (await fetch(BASE + '/api/sessions')).json()) await fetch(BASE + '/api/sessions/' + x.id, { method: 'DELETE' });
  await wait(4000); // 守护进程没事做了自己退出 (SSHWEBD_IDLE=3s)
  ok(/没有会话了，退出/.test(fs.readFileSync(path.join(dhome, 'sshwebd.log'), 'utf8')), '守护进程没有会话后自己退出');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(SRV_EXE, { force: true });
});
