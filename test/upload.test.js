'use strict';
// 文件上传：覆盖已有文件时先写临时文件、传完再换上去 —— 中途断开原文件不受影响 (以前一开始写就把原文件清空了)；
// 权限照原来的；符号链接还是符号链接 (换的是它指向的文件)；不覆盖时文件已存在返回 409；不留临时文件
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Server, utils: { sftp: { OPEN_MODE, STATUS_CODE } } } = require('ssh2');
const WebSocket = require('ws');
const { BASE, ok, wait, run, hostKey, addHost } = require('./helpers');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-up-'));

// 模拟 SSH 服务器：shell + SFTP (文件操作直接落到 root 目录；和 OpenSSH 一样，目标已存在时普通改名失败)
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => a().write('$ '));
    s.on('sftp', (accept) => {
      const sf = accept();
      const fds = new Map(); let next = 1;
      const okr = (id) => sf.status(id, STATUS_CODE.OK);
      const err = (id, e) => sf.status(id, e && e.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : e && e.code === 'EACCES' ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE);
      const attrs = (st) => ({ mode: st.mode, uid: st.uid, gid: st.gid, size: st.size, atime: st.atimeMs / 1000 | 0, mtime: st.mtimeMs / 1000 | 0 });
      const fsFlags = (f) => (f & OPEN_MODE.READ && f & OPEN_MODE.WRITE ? fs.constants.O_RDWR : f & OPEN_MODE.WRITE ? fs.constants.O_WRONLY : fs.constants.O_RDONLY)
        | (f & OPEN_MODE.CREAT ? fs.constants.O_CREAT : 0) | (f & OPEN_MODE.TRUNC ? fs.constants.O_TRUNC : 0)
        | (f & OPEN_MODE.EXCL ? fs.constants.O_EXCL : 0) | (f & OPEN_MODE.APPEND ? fs.constants.O_APPEND : 0);
      sf.on('REALPATH', (id, p) => { let r; try { r = fs.realpathSync(p); } catch { r = path.resolve(p); } sf.name(id, [{ filename: r, longname: r, attrs: {} }]); });
      sf.on('STAT', (id, p) => { try { sf.attrs(id, attrs(fs.statSync(p))); } catch (e) { err(id, e); } });
      sf.on('LSTAT', (id, p) => { try { sf.attrs(id, attrs(fs.lstatSync(p))); } catch (e) { err(id, e); } });
      sf.on('OPEN', (id, p, flags) => {
        try { const h = Buffer.alloc(4); h.writeUInt32BE(next); fds.set(next++, fs.openSync(p, fsFlags(flags), 0o644)); sf.handle(id, h); } catch (e) { err(id, e); }
      });
      sf.on('WRITE', (id, h, off, data) => { try { fs.writeSync(fds.get(h.readUInt32BE()), data, 0, data.length, off); okr(id); } catch (e) { err(id, e); } });
      sf.on('CLOSE', (id, h) => { try { fs.closeSync(fds.get(h.readUInt32BE())); fds.delete(h.readUInt32BE()); okr(id); } catch (e) { err(id, e); } });
      sf.on('RENAME', (id, a, b) => { if (fs.existsSync(b)) return err(id); try { fs.renameSync(a, b); okr(id); } catch (e) { err(id, e); } });
      sf.on('REMOVE', (id, p) => { try { fs.unlinkSync(p); okr(id); } catch (e) { err(id, e); } });
      sf.on('SETSTAT', (id, p, a) => { try { if (a.mode !== undefined) fs.chmodSync(p, a.mode & 0o7777); okr(id); } catch (e) { err(id, e); } });
    });
  }));
}).listen(2285, '127.0.0.1');

// 上传：body 为内容；cut = 只发前面这么多字节就断开 (模拟中途断网)
function put(sid, file, body, { overwrite = false, cut = 0 } = {}) {
  return new Promise((resolve) => {
    const u = new URL(`${BASE}/api/sftp/${sid}/upload?path=${encodeURIComponent(file)}${overwrite ? '&overwrite=1' : ''}`);
    const req = http.request(u, { method: 'PUT', headers: { 'content-length': body.length } }, (res) => {
      let d = ''; res.on('data', (x) => { d += x; }); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', () => resolve({ status: 0 }));
    if (cut) { req.write(body.subarray(0, cut)); setTimeout(() => { req.destroy(); resolve({ status: 'cut' }); }, 800); } else req.end(body);
  });
}
const leftovers = () => fs.readdirSync(root).filter((f) => f.includes('.sshweb-'));

run(async () => {
  await addHost('UP', 2285);
  const host = (await (await fetch(BASE + '/api/hosts')).json()).find((h) => h.name === 'UP');
  // 直接用 WebSocket 开一个会话 (文件接口借用它的 SSH 连接)
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws');
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'connect', hostId: host.id, title: 'UP', cols: 80, rows: 24 }));
  let sid = null;
  for (let i = 0; i < 50 && !sid; i++) { await wait(200); sid = (await (await fetch(BASE + '/api/sessions')).json()).find((x) => x.status === 'connected')?.id; }
  ok(!!sid, '(会话已连上)');

  const f = path.join(root, 'conf.txt');
  fs.writeFileSync(f, 'ORIGINAL'); fs.chmodSync(f, 0o600);
  let r = await put(sid, f, Buffer.from('NEW CONTENT'));
  ok(r.status === 409 && fs.readFileSync(f, 'utf8') === 'ORIGINAL', `不覆盖时文件已存在：返回 409，原文件不动 (${r.status})`);

  r = await put(sid, f, Buffer.from('NEW CONTENT'), { overwrite: true });
  ok(r.status === 200 && fs.readFileSync(f, 'utf8') === 'NEW CONTENT', `覆盖上传：换成新内容 (${r.status} ${r.body})`);
  ok((fs.statSync(f).mode & 0o777) === 0o600, `权限照原来的 600 (${(fs.statSync(f).mode & 0o777).toString(8)})`);
  ok(!leftovers().length, '没有留下临时文件');

  // 中途断开：原文件不受影响，临时文件删掉
  const big = Buffer.alloc(3 * 1024 * 1024, 'x');
  r = await put(sid, f, big, { overwrite: true, cut: 256 * 1024 });
  await wait(1500);
  ok(fs.readFileSync(f, 'utf8') === 'NEW CONTENT', `覆盖上传中途断开：原文件还在、内容没变 (${fs.statSync(f).size} 字节)`);
  ok(!leftovers().length, '传了一半的临时文件删掉了: ' + leftovers().join(','));

  // 符号链接：换的是它指向的文件，链接本身还在
  const real = path.join(root, 'real.txt'), link = path.join(root, 'link.txt');
  fs.writeFileSync(real, 'OLD'); fs.symlinkSync(real, link);
  r = await put(sid, link, Buffer.from('VIA LINK'), { overwrite: true });
  ok(r.status === 200 && fs.lstatSync(link).isSymbolicLink() && fs.readFileSync(real, 'utf8') === 'VIA LINK', '覆盖符号链接：链接还在，指向的文件换成新内容');

  // 新文件
  const nf = path.join(root, 'new.bin');
  r = await put(sid, nf, Buffer.from('HELLO'));
  ok(r.status === 200 && fs.readFileSync(nf, 'utf8') === 'HELLO' && !leftovers().length, '上传新文件：写好了，没有临时文件');

  ws.close();
  fs.rmSync(root, { recursive: true, force: true });
});
