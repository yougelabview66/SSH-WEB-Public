'use strict';
// @env DAEMON_AUTO_RECONNECT=0
// @env SSHWEBD_DIR=/tmp/sshweb-dt-bin
// 常驻会话选择框里显示的标签名 (「主机名-命名」) 要是最后一次命的名：
// 命名 → 关标签 (不结束会话) → 再开标签，选择框里是新名字，不是改之前的。
// 各种时候命的名都要记到会话上：接着会话时命名、选会话的弹窗还开着时先命名再接上、
// 网页带着名字重新连上 (刷新页面 / 服务重启) 后接回会话、清掉名字恢复按序号。
// 模拟的主机把命令在本机临时目录里真的执行 (同 daemonlinux.test.js)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { Server, utils: { sftp: { OPEN_MODE, STATUS_CODE } } } = require('ssh2');
const WebSocket = require('ws');
const { BASE, ok, wait, run, hostKey, addHost, killUnder } = require('./helpers');

const BIN_DIR = '/tmp/sshweb-dt-bin';
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-dt-')));
killUnder(home);
const until = async (fn, ms) => { for (const end = Date.now() + ms; !fn() && Date.now() < end;) await wait(100); };
const ENV = { HOME: home, PATH: process.env.PATH, SHELL: '/bin/sh', SSHWEBD_IDLE: '3s', LANG: 'C.UTF-8' };

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

const conns = [];
function server(port) {
  new Server({ hostKeys: [hostKey()] }, (c) => {
    conns.push(c);
    c.on('error', () => {});
    c.on('authentication', (ctx) => ctx.accept());
    c.on('ready', () => c.on('session', (acc) => {
      const s = acc();
      s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
      s.on('exec', (a, r, info) => {
        const ch = a(), cmd = info.command;
        // 命令在本机临时目录里真的执行 (bridge 这种一直跑的：通道的输入输出接上，通道关了就结束它)
        const pr = spawn('sh', ['-c', cmd], { cwd: home, env: ENV });
        pr.stdin.on('error', () => {}); // 进程已经结束还有输入过来：写入失败是异步报的 (EPIPE)，try 接不住，会让整个测试崩掉
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

server(2351);

// 一个标签 (直接用 WebSocket，和网页一样的消息)；extra：connect 里多带的 (suffix、daemonId，同网页刷新后恢复的标签)
function tab(hostId, extra = {}) {
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws');
  const t = { ws, out: '', msgs: [], picks: [] };
  ws.on('message', (d, bin) => {
    if (bin) { t.out += d.toString(); return; }
    const m = JSON.parse(d);
    t.msgs.push(m);
    if (m.type === 'daemon-pick') t.picks.push(m);
  });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'connect', hostId, title: 'DT', n: 1, cols: 100, rows: 30, ...extra })));
  t.send = (o) => ws.send(JSON.stringify(o));
  t.last = (type) => [...t.msgs].reverse().find((m) => m.type === type);
  t.sid = () => t.msgs.find((m) => m.type === 'attached')?.session?.id;
  t.ready = () => /(新建|接上)常驻会话 \d/.test(t.out) && t.last('status')?.status === 'connected';
  return t;
}
// 关标签、不结束常驻会话 (网页上关标签时选「保留」)
async function close(t) {
  await fetch(BASE + '/api/sessions/' + t.sid(), { method: 'DELETE' });
  t.ws.close(); await wait(600);
}
// 开一个新标签，等它弹出选择框：返回标签和会话 id 那一行
async function openPick(hostId, id, extra) {
  const t = tab(hostId, extra);
  await until(() => t.picks.length, 15000);
  return { t, row: t.picks.at(-1)?.sessions?.find((x) => x.id === id) };
}
const shown = (row) => row && (row.tab || row.tabDef); // 选择框里那一行显示的标签名 (胶囊；没命过名是接上后的「主机名-序号」)
const post = (u, b) => fetch(BASE + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const J = (row) => JSON.stringify(row && { tab: row.tab, tabDef: row.tabDef });

run(async () => {
  if (!BIN) { ok(true, '(没有 Go：跳过)'); return; }
  fs.writeFileSync(path.join(home, '.profile'), "PS1='$ '\n");
  fs.mkdirSync(path.join(home, '.ssh-web'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ssh-web', 'hook.sh'), '#!/bin/sh\n'); // 装了钩子 (有 hook.sh 就读事件)
  const host = await addHost('DT', 2351, { winDaemon: true });

  // ---- 1. 接着会话时命名「甲」→ 关标签 → 再开：选择框里是 DT-甲
  const a = tab(host.id);
  await until(a.ready, 20000);
  const id = /新建常驻会话 (\d+)/.exec(a.out)?.[1];
  a.send({ type: 'rename', suffix: '甲' }); await wait(300);
  await close(a);
  let { t, row } = await openPick(host.id, id);
  ok(shown(row) === 'DT-甲', '接着会话时命的名：再开标签选择框里显示: ' + J(row));

  // ---- 2. 接上它 (还原成「甲」)，改成「乙」→ 关 → 再开：是 DT-乙，不是改之前的 DT-甲
  t.send({ type: 'daemon-pick-response', id });
  await until(t.ready, 15000);
  ok(t.last('renamed')?.suffix === '甲', '接上时还原记着的名字「甲」: ' + JSON.stringify(t.last('renamed')));
  t.send({ type: 'rename', suffix: '乙' }); await wait(300);
  await close(t);
  ({ t, row } = await openPick(host.id, id));
  ok(shown(row) === 'DT-乙', '改名以后再开：显示新名字「乙」，不是改之前的: ' + J(row));

  // ---- 3. 选会话的弹窗还开着时先命名「丙」，再接上 → 关 → 再开：是 DT-丙
  t.send({ type: 'rename', suffix: '丙' }); await wait(300);
  t.send({ type: 'daemon-pick-response', id });
  await until(t.ready, 15000);
  ok(t.last('renamed')?.suffix === '丙', '先命的名不被记着的旧名字盖掉: ' + JSON.stringify(t.msgs.filter((m) => m.type === 'renamed')));
  await close(t);
  ({ t, row } = await openPick(host.id, id));
  ok(shown(row) === 'DT-丙', '弹窗开着时先命名再接上：再开显示「丙」: ' + J(row));

  // ---- 4. 服务重启期间改名「丁」(网页上记着没送到)：网页带着名字和 suffixNew 重新连上、接回原来的会话 → 关 → 再开：是 DT-丁
  t.ws.close(); await wait(600);
  let e = tab(host.id, { suffix: '丁', suffixNew: true, daemonId: id });
  await until(e.ready, 15000);
  ok(/接上常驻会话/.test(e.out) && !e.picks.length, '带着会话号重新连上：直接接回去: ' + JSON.stringify(e.out.slice(-80)));
  await close(e);
  ({ t, row } = await openPick(host.id, id));
  ok(shown(row) === 'DT-丁', '重连前刚改的名：再开显示「丁」: ' + J(row));
  t.ws.close(); await wait(600);

  // ---- 4b. 只是恢复标签带着的名字 (可能是以前还原出来的旧名字，没有 suffixNew)：不盖掉记着的新名字，标签换成最后命的「丁」
  e = tab(host.id, { suffix: '旧名字', daemonId: id });
  await until(e.ready, 15000);
  ok(e.last('renamed')?.suffix === '丁', '恢复的标签换成会话最后命的名字「丁」: ' + JSON.stringify(e.msgs.filter((m) => m.type === 'renamed')));
  await close(e);
  ({ t, row } = await openPick(host.id, id));
  ok(shown(row) === 'DT-丁', '恢复标签带着的旧名字不盖掉最后改的「丁」: ' + J(row));

  // ---- 5. 接上后清掉名字 (恢复按序号) → 关 → 再开：不再显示旧名字
  t.send({ type: 'daemon-pick-response', id });
  await until(t.ready, 15000);
  t.send({ type: 'rename', suffix: '' }); await wait(300);
  await close(t);
  ({ t, row } = await openPick(host.id, id));
  ok(row && !row.tab && shown(row) === `DT-${t.last('attached')?.session?.n}`, '清掉名字以后再开：不显示旧名字，胶囊是接上后这个标签的「DT-序号」: ' + J(row));

  // ---- 6. 命名「戊」后，在弹窗开着时清掉再接上：不还原成「戊」，再开也不显示
  t.send({ type: 'daemon-pick-response', id });
  await until(t.ready, 15000);
  t.send({ type: 'rename', suffix: '戊' }); await wait(300);
  await close(t);
  ({ t, row } = await openPick(host.id, id));
  ok(shown(row) === 'DT-戊', '命名「戊」: ' + J(row));
  t.send({ type: 'rename', suffix: '戊' }); await wait(200); // 网页上显示的是「戊」(选择框里看到的)
  t.send({ type: 'rename', suffix: '' }); await wait(300);
  t.send({ type: 'daemon-pick-response', id });
  await until(t.ready, 15000);
  ok(t.last('renamed')?.suffix === '', '弹窗开着时清掉的名字：接上时不还原旧名字: ' + JSON.stringify(t.msgs.filter((m) => m.type === 'renamed')));
  await close(t);
  ({ t, row } = await openPick(host.id, id));
  ok(row && !row.tab, '再开选择框里也不显示旧名字: ' + J(row));

  // ---- 7. 服务重启期间清掉名字 (suffixNew、没带名字) 连上：不还原旧名字，记录也清掉
  t.send({ type: 'daemon-pick-response', id });
  await until(t.ready, 15000);
  t.send({ type: 'rename', suffix: '己' }); await wait(300);
  await close(t);
  e = tab(host.id, { suffixNew: true, daemonId: id });
  await until(e.ready, 15000);
  ok(!e.msgs.some((m) => m.type === 'renamed'), '服务重启期间清掉的名字：接回去时不还原「己」: ' + JSON.stringify(e.msgs.filter((m) => m.type === 'renamed')));
  await close(e);
  ({ t, row } = await openPick(host.id, id));
  ok(row && !row.tab, '再开选择框里也不显示「己」: ' + J(row));

  // ---- 8. 会话里 Claude 在聊对话 conv-1：命名「庚」→ 关标签 → 接上它马上改成「辛」(Agent 还没再报事件) →
  // 结束会话 → 新标签在会话历史里「继续」conv-1：标签名是最后改的「辛」，不是「庚」
  t.send({ type: 'daemon-pick-response', id });
  await until(t.ready, 15000);
  fs.mkdirSync(path.join(home, '.cache', 'ssh-web'), { recursive: true });
  await wait(1500);
  const hook = (ev) => fs.appendFileSync(path.join(home, '.cache', 'ssh-web', 'hook.log'), JSON.stringify({ v: 2, t: Math.floor(Date.now() / 1000), agent: 'claude', tabs: 'old-tab', daemon: id, pane: '', session_id: 'conv-1', ...ev }) + '\n');
  // 读事件的通道可能还在换手 (前面的标签关了，换这个标签接着读)：没收到就再报一次
  for (let i = 0; i < 8 && !/整理代码/.test(t.last('state')?.detail || ''); i++) {
    hook({ hook_event_name: 'UserPromptSubmit', prompt: '整理代码' });
    await until(() => /整理代码/.test(t.last('state')?.detail || ''), 2000);
  }
  ok(/整理代码/.test(t.last('state')?.detail || ''), '钩子事件到了 (标签知道里面在聊 conv-1): ' + JSON.stringify([t.msgs.filter((m) => m.type === 'state').slice(-2), fs.readFileSync(path.join(home, '.cache', 'ssh-web', 'hook.log'), 'utf8').length]));
  // 会话历史列表：没命过名的标签里聊的，不显示胶囊
  const convFile = (cid) => { fs.mkdirSync(path.join(home, '.claude', 'projects', '-srv-x'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'projects', '-srv-x', cid + '.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: '整理代码' }, cwd: '/srv/x' }) + '\n'); };
  const capOf = async (sid, cid) => (await post('/api/agent-sessions', { sid, agent: 'claude' })).sessions?.find((x) => x.id === cid)?.tab;
  convFile('conv-1'); convFile('conv-2');
  let cap = await capOf(t.sid(), 'conv-1');
  ok(cap === undefined, '没命过名的标签里聊的对话：会话历史里不显示胶囊: ' + JSON.stringify(cap));
  t.send({ type: 'rename', suffix: '庚' }); await wait(300);
  // 标签命名「庚」后在里面开了新对话 conv-2 (对话上没命过名)：会话历史里 conv-2 的胶囊是它在聊的标签「DT-庚」
  hook({ session_id: 'conv-2', hook_event_name: 'UserPromptSubmit', prompt: '新对话' });
  await until(() => /新对话/.test(t.last('state')?.detail || ''), 5000);
  cap = await capOf(t.sid(), 'conv-2');
  ok(cap === 'DT-庚', '命过名的标签里开的新对话：胶囊是这个标签的名字「DT-庚」: ' + JSON.stringify(cap));
  // 打开会话历史的是另一个标签：胶囊照样是记着的，不跟着它
  const o = tab(host.id);
  await until(() => o.ready() || o.picks.length, 15000);
  if (o.picks.length) { o.send({ type: 'daemon-pick-response', id: '' }); await until(o.ready, 15000); }
  o.send({ type: 'rename', suffix: '卯' }); await wait(300);
  cap = await capOf(o.sid(), 'conv-2');
  ok(cap === 'DT-庚', '在别的标签 (DT-卯) 打开会话历史：胶囊还是记着的「DT-庚」: ' + JSON.stringify(cap));
  await close(o);
  // 没命过名的新标签里「继续」conv-2：标签名还原成胶囊上的「庚」(看到的就是继续后得到的)
  const u = tab(host.id);
  await until(() => u.ready() || u.picks.length, 15000);
  if (u.picks.length) { u.send({ type: 'daemon-pick-response', id: '' }); await until(u.ready, 15000); }
  const ru = await post('/api/agent-sessions/resume', { sid: u.sid(), cmd: 'true', id: 'conv-2' });
  await until(() => u.last('renamed'), 3000);
  ok(ru.quit === false && u.last('renamed')?.suffix === '庚', '在没命名的标签里「继续」conv-2：标签名变成胶囊上的「庚」: ' + JSON.stringify([ru, u.msgs.filter((m) => m.type === 'renamed')]));
  await close(u);
  hook({ hook_event_name: 'UserPromptSubmit', prompt: '整理代码二' }); // 再回到 conv-1 (下面按它测)
  await until(() => /整理代码二/.test(t.last('state')?.detail || ''), 5000);
  await close(t);
  ({ t } = await openPick(host.id, id));
  t.send({ type: 'daemon-pick-response', id });
  await until(t.ready, 15000);
  t.send({ type: 'rename', suffix: '辛' }); await wait(300);
  t.send({ type: 'close', kill: true });
  await wait(1500); // 等会话结束
  t.ws.close(); await wait(800);
  const n = tab(host.id);
  await until(() => n.ready() || n.picks.length, 15000);
  if (n.picks.length) { n.send({ type: 'daemon-pick-response', id: '' }); await until(n.ready, 15000); }
  await wait(1000);
  const r = await post('/api/agent-sessions/resume', { sid: n.sid(), cmd: 'true', id: 'conv-1' });
  await until(() => n.last('renamed'), 3000);
  // 会话历史列表：这个对话后面的胶囊是「DT-辛」
  const ls = await post('/api/agent-sessions', { sid: n.sid(), agent: 'claude' });
  ok(ls.sessions?.find((x) => x.id === 'conv-1')?.tab === 'DT-辛', '会话历史列表里这个对话带着命的名「DT-辛」(显示成胶囊): ' + JSON.stringify(ls.sessions || ls));
  ok(r.quit === false && n.last('renamed')?.suffix === '辛', '会话历史里「继续」这个对话：还原最后改的名字「辛」: ' + JSON.stringify([r, n.msgs.filter((m) => m.type === 'renamed')]));
  // 「继续」还原出来的名字也记到这个标签现在接着的常驻会话上：关标签 (保留) → 再开，选择框里那个会话也是 DT-辛
  const nid = /新建常驻会话 (\d+)/.exec(n.out)?.[1];
  await close(n);
  ({ t, row } = await openPick(host.id, nid));
  ok(shown(row) === 'DT-辛', '「继续」对话后，常驻会话也记成还原出来的名字「辛」: ' + J(row));
  t.ws.close();

  // ---- 9. 同一个常驻会话在两个标签里开着：一个标签改名「壬」，另一个标签马上跟着变
  const p1 = tab(host.id);
  await until(() => p1.ready() || p1.picks.length, 15000);
  if (p1.picks.length) { p1.send({ type: 'daemon-pick-response', id: '' }); await until(p1.ready, 15000); }
  const pid = /新建常驻会话 (\d+)/.exec(p1.out)?.[1];
  let p2; ({ t: p2 } = await openPick(host.id, pid));
  p2.send({ type: 'daemon-pick-response', id: pid, share: true });
  await until(p2.ready, 15000);
  p1.send({ type: 'rename', suffix: '壬' });
  await until(() => p2.last('renamed')?.suffix === '壬', 3000);
  ok(p2.last('renamed')?.suffix === '壬', '同一个会话的另一个标签跟着换成「壬」: ' + JSON.stringify(p2.msgs.filter((m) => m.type === 'renamed')));
  await close(p2);

  // ---- 10. 标签先命名「癸」，之后别的标签把会话改成「子」：「癸」这个标签再接上这个会话 → 用最后命的「子」
  const q1 = tab(host.id);
  await until(() => q1.picks.length, 15000);
  q1.send({ type: 'rename', suffix: '癸' }); await wait(300);
  q1.send({ type: 'daemon-pick-response', id: '' }); // 先接个新的会话
  await until(q1.ready, 15000);
  p1.send({ type: 'rename', suffix: '子' }); await wait(300);
  await close(p1);
  q1.send({ type: 'close' }); q1.ws.close(); await wait(600);
  const q2 = tab(host.id, { suffix: '癸' }); // 网页上恢复的「癸」标签 (服务重启后)，去接 pid 这个会话
  await until(() => q2.picks.length, 15000);
  q2.send({ type: 'daemon-pick-response', id: pid });
  await until(q2.ready, 15000);
  ok(q2.last('renamed')?.suffix === '子', '接上的会话后来命的名「子」比标签上的「癸」新：换成「子」: ' + JSON.stringify(q2.msgs.filter((m) => m.type === 'renamed')));

  // ---- 11. 标签命名「丑」后，在里面「继续」命过名 (辛) 的对话 conv-1：标签名换成对话的「辛」
  q2.send({ type: 'rename', suffix: '丑' }); await wait(300);
  const r2 = await post('/api/agent-sessions/resume', { sid: q2.sid(), cmd: 'true', id: 'conv-1' });
  await until(() => q2.last('renamed')?.suffix === '辛', 3000);
  ok(r2.quit === false && q2.last('renamed')?.suffix === '辛', '「继续」命过名的对话：标签名换成对话的「辛」(不管标签上原来叫什么): ' + JSON.stringify([r2, q2.msgs.filter((m) => m.type === 'renamed')]));
  const ls2 = await post('/api/agent-sessions', { sid: q2.sid(), agent: 'claude' });
  ok(ls2.sessions?.find((x) => x.id === 'conv-1')?.tab === 'DT-辛', '会话历史里这个对话还是「DT-辛」: ' + JSON.stringify(ls2.sessions?.find((x) => x.id === 'conv-1')));
  // 关掉 (保留) 再开：选择框里这个会话也是「DT-辛」
  await close(q2);
  ({ t, row } = await openPick(host.id, pid));
  ok(shown(row) === 'DT-辛', '「继续」换的名字也记到常驻会话上，再开选择框里是「DT-辛」: ' + J(row));
  t.ws.close();

  // ---- 12. 命名「寅」的标签「继续」没命过名的对话 conv-9：标签名清掉，按「主机名-序号」显示
  const w = tab(host.id);
  await until(() => w.ready() || w.picks.length, 15000);
  if (w.picks.length) { w.send({ type: 'daemon-pick-response', id: '' }); await until(w.ready, 15000); }
  w.send({ type: 'rename', suffix: '寅' }); await wait(300);
  const r3 = await post('/api/agent-sessions/resume', { sid: w.sid(), cmd: 'true', id: 'conv-9' });
  await until(() => w.last('renamed')?.suffix === '', 3000);
  ok(r3.quit === false && w.last('renamed')?.suffix === '', '「继续」没命过名的对话：标签名清掉，显示「DT-序号」: ' + JSON.stringify([r3, w.msgs.filter((m) => m.type === 'renamed')]));
  w.ws.close();

  for (const x of await (await fetch(BASE + '/api/sessions')).json()) await fetch(BASE + '/api/sessions/' + x.id, { method: 'DELETE' });
  for (const c of conns) c.end();
  await wait(500);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(BIN_DIR, { recursive: true, force: true });
});
