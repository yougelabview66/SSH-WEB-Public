'use strict';
// 会话：Windows 常驻会话 (sshwebd，源码在本项目的 sshwebd/ 目录，Go 写的，参考 Orca 的 orcad)。方法挂到 Session 上 (见 index.js)
//
// 主机设置里开了「Windows 常驻会话」：连上后不开普通的 shell，而是开一个不要终端的通道跑目标主机 ~/.ssh-web/ 里的
// `sshwebd bridge`，接到守护进程里的终端 (ConPTY)。守护进程脱离了 SSH 会话，
// SSH 断了、标签关了终端还在跑；这个标签重新连上接着用 (只补发没收到的输出)，新开的标签可以选一个没人接着的会话接上。
// 中间不经过 sshd 自己的终端那一层；数据一行一段 base64 (sshd 的默认 shell 是 PowerShell 时会按代码页改坏原始字节)
//
// sshwebd.exe 在构建 Docker 镜像时从 sshwebd/ 的源码编出来 (sshwebd/sshwebd.exe，SSHWEBD_EXE 可以指定别的路径)，
// 连接时自动传到目标主机；服务器上没有 (直接跑源码、没编 exe) 就用主机上自己放的 %USERPROFILE%\.ssh-web\sshwebd.exe
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { posix } = require('path');
const { EventEmitter } = require('events');
const { sftpOf } = require('../sftp');
const { ROOT } = require('../config');

const p = (fn) => new Promise((resolve, reject) => fn((e, v) => (e ? reject(e) : resolve(v))));

// 服务器上的 sshwebd.exe (没有返回 null)；名字按内容的哈希取，换了文件就是新名字
let bin = null;
function localExe() {
  const file = process.env.SSHWEBD_EXE || path.join(ROOT, 'sshwebd', 'sshwebd.exe');
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile()) return null;
  if (!bin || bin.file !== file || bin.size !== st.size || bin.mtime !== st.mtimeMs) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 8);
    bin = { file, size: st.size, mtime: st.mtimeMs, name: `sshwebd-${hash}.exe` };
  }
  return bin;
}

// 找到要运行的 sshwebd，返回 Windows 路径：
// - 服务器上有 sshwebd.exe：传到 ~/.ssh-web/sshwebd-<哈希>.exe (Windows 上正在运行的 exe 不能覆盖，所以换个名字)，
//   已经有了 (大小对得上) 就不传；以前这样传的删掉 (还在运行的删不掉，下次再删)
// - 没有：用主机上的 ~/.ssh-web/sshwebd.exe，没有就用那里最新的 sshwebd*.exe
async function deploy(sess, say) {
  const sftp = await sftpOf(sess);
  const home = await p((cb) => sftp.realpath('.', cb));
  if (!/^\/[A-Za-z]:/.test(home)) throw new Error('这台主机不是 Windows');
  const dir = posix.join(home, '.ssh-web'), win = (name) => `${home.slice(1).replace(/\//g, '\\')}\\.ssh-web\\${name}`;
  const b = localExe();
  if (!b) {
    const list = (await p((cb) => sftp.readdir(dir, cb)).catch(() => [])).filter((e) => /^sshwebd[^\\/]*\.exe$/i.test(e.filename));
    const e = list.find((x) => x.filename.toLowerCase() === 'sshwebd.exe') || list.sort((x, y) => y.attrs.mtime - x.attrs.mtime)[0];
    if (!e) throw new Error(`主机上没有 sshwebd：把 sshwebd.exe 放到 ${win('')}`);
    return win(e.filename);
  }
  const dst = posix.join(dir, b.name);
  await p((cb) => sftp.mkdir(dir, cb)).catch(() => {});
  const st = await p((cb) => sftp.stat(dst, cb)).catch(() => null);
  if (!st || st.size !== b.size) {
    say(`\x1b[90m正在把 sshwebd 传到主机 (${(b.size / 1048576).toFixed(1)} MB) ...\x1b[0m`);
    const tmp = dst + '.part';
    await p((cb) => sftp.fastPut(b.file, tmp, cb));
    await p((cb) => sftp.unlink(dst, cb)).catch(() => {});
    await p((cb) => sftp.rename(tmp, dst, cb));
  }
  const list = await p((cb) => sftp.readdir(dir, cb)).catch(() => []);
  for (const e of list) {
    if (/^sshwebd-[0-9a-f]{8}\.exe(\.part)?$/.test(e.filename) && e.filename !== b.name) sftp.unlink(posix.join(dir, e.filename), () => {});
  }
  return win(b.name);
}

// 一个 `sshwebd bridge` 通道，用起来和 shell 的流一样 (write / setWindow / pause / resume / close，'data' / 'close')。
// 终端输出先存着，start() 之后才发出去 (接上的回复和补发的输出可能在同一块里，不能在等回复的时候丢了)
class DaemonStream extends EventEmitter {
  constructor(ch) {
    super();
    this.ch = ch;
    this.lineBuf = '';
    this.frameBuf = Buffer.alloc(0);
    this.ready = false;
    this.held = [];
    this.waiters = [];
    this.stderr = new EventEmitter();
    this.stderr.pause = this.stderr.resume = () => {};
    ch.on('data', (d) => this.onData(d));
    ch.stderr.on('data', (d) => { if (!this.ready) this.errText = (this.errText || '') + d; });
    ch.on('close', () => { for (const w of this.waiters.splice(0)) w.reject(new Error(this.errText?.trim() || 'sshwebd 通道断开了')); this.emit('close'); });
  }

  onData(d) {
    this.lineBuf += d.toString('latin1');
    let i;
    while ((i = this.lineBuf.indexOf('\n')) >= 0) {
      const line = this.lineBuf.slice(0, i).trim();
      this.lineBuf = this.lineBuf.slice(i + 1);
      this.onLine(line);
    }
    if (this.lineBuf.length > 16 << 20) this.lineBuf = '';
  }

  onLine(line) {
    if (!this.ready) { // 之前可能有登录脚本打印的东西
      const m = /^SSHWEBD (READY|ERROR) ?(.*)$/.exec(line);
      if (m && m[1] === 'READY') { this.ready = true; this.version = m[2]; this.emit('ready'); }
      if (m && m[1] === 'ERROR') this.emit('fail', m[2]);
      return;
    }
    if (!line) return;
    const b = Buffer.from(line, 'base64');
    let buf = this.frameBuf.length ? Buffer.concat([this.frameBuf, b]) : b;
    while (buf.length >= 5) {
      const n = buf.readUInt32BE(1);
      if (buf.length < 5 + n) break;
      const t = buf[0], body = Buffer.from(buf.subarray(5, 5 + n));
      buf = buf.subarray(5 + n);
      if (t === 0x4f) { // O：终端输出
        if (this.held) this.held.push(body);
        else this.emit('data', body);
      } else if (t === 0x4d) { // M：消息
        let m;
        try { m = JSON.parse(body.toString()); } catch { continue; }
        const w = this.waiters.findIndex((x) => x.type === m.type || m.type === 'error');
        if (w >= 0) {
          const [x] = this.waiters.splice(w, 1);
          if (m.type === 'error') x.reject(new Error(m.error)); else x.resolve(m);
        } else this.emit('msg', m);
      }
    }
    this.frameBuf = buf;
  }

  send(type, payload) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const f = Buffer.alloc(5 + body.length);
    f[0] = type.charCodeAt(0);
    f.writeUInt32BE(body.length, 1);
    body.copy(f, 5);
    this.ch.write(f.toString('base64') + '\n');
  }

  // 发一个请求，等某种回复 (回 error 就报错)
  request(obj, type, ms = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('sshwebd 没有回复')), ms);
      this.waiters.push({ type, resolve: (m) => { clearTimeout(timer); resolve(m); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.send('H', JSON.stringify(obj));
    });
  }

  start() {
    const held = this.held;
    this.held = null;
    for (const b of held) this.emit('data', b);
  }

  write(data) {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    for (let i = 0; i < b.length; i += 48 << 10) this.send('I', b.subarray(i, i + (48 << 10)));
  }

  setWindow(rows, cols) {
    const s = Buffer.alloc(4);
    s.writeUInt16BE(Math.min(cols, 65535), 0);
    s.writeUInt16BE(Math.min(rows, 65535), 2);
    this.send('S', s);
  }

  pause() { this.ch.pause(); }
  resume() { this.ch.resume(); }
  close() { try { this.ch.close(); } catch {} }
}

// 多久以前：刚刚 / 3 分钟前 / 2 小时前 / 5 天前
const before = (ms) => {
  const m = Math.floor((Date.now() - ms) / 60000);
  return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 2880 ? `${Math.floor(m / 60)} 小时前` : `${Math.floor(m / 1440)} 天前`;
};

class SessionDaemon {
  // 连上后：常驻会话开起来了返回 true；不是 Windows 主机等情况抛错 (调用的地方改开普通 shell)
  async openDaemon(ssh, alive) {
    const base = await this.shellBase(ssh);
    if (base === 'sh') throw new Error('常驻会话只支持 Windows 主机');
    if (!alive()) return;
    const exe = await deploy(this, (t) => alive() && this.line(t));
    if (!alive()) return;
    const cmd = base === 'powershell' ? `& '${exe.replace(/'/g, "''")}' bridge` : `"${exe}" bridge`;
    const ch = await p((cb) => ssh.exec(cmd, cb));
    if (!alive()) return ch.close();
    const ds = new DaemonStream(ch);
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('sshwebd 没有响应')), 20000);
        ds.once('ready', () => { clearTimeout(t); resolve(); });
        ds.once('fail', (m) => { clearTimeout(t); reject(new Error(m)); });
        ds.once('close', () => { clearTimeout(t); reject(new Error(ds.errText?.trim() || 'sshwebd 没有运行起来')); });
      });
      const list = (await ds.request({ op: 'list' }, 'list')).sessions || [];
      // 这个标签以前接着的会话还在：接回去 (这个标签的终端里已经有之前的输出，只要没收到的)；不然看有没有没人接着的让你选
      let id = this.daemonId && list.some((x) => x.id === this.daemonId) ? this.daemonId : '';
      const since = id && this.daemonOff != null ? this.daemonOff : undefined;
      if (!id) {
        this.daemonOff = null;
        const free = list.filter((x) => !x.clients);
        if (free.length) id = await this.pickDaemon(ds, free);
      }
      if (!alive()) return ds.close();
      const m = await ds.request({ op: 'attach', id, cols: this.cols, rows: this.rows, env: { LC_SSHWEB: this.id }, ...(since !== undefined && { since }) }, 'attached');
      if (!alive()) return ds.close();
      clearTimeout(this.timer); // 问选哪个会话时又计上了连接超时
      this.daemonId = m.id;
      this.daemonOff = m.start;
      this.line(`\x1b[90m${m.created ? '新建' : '接上'}常驻会话 ${m.id} (sshwebd ${ds.version}${m.detached ? '' : '，⚠ 没能脱离 SSH 会话，断开时会话会结束'})\x1b[0m`);
      this.stream = ds;
      ds.on('data', (d) => { this.daemonOff += d.length; this.output(d); });
      ds.on('msg', (x) => {
        if (x.type !== 'exit' && x.type !== 'error') return;
        this.line(`\r\n\x1b[33m常驻会话 ${this.daemonId} ${x.type === 'exit' ? `已结束 (退出码 ${x.code})` : `出错：${x.error}`}\x1b[0m`);
        this.daemonId = this.daemonOff = null;
        this.broadcast({ type: 'params', params: this.info().params });
      });
      ds.on('close', () => { if (this.ssh === ssh) this.ended(); });
      ds.start();
      this.broadcast({ type: 'params', params: this.info().params });
      this.setStatus('connected');
    } catch (e) {
      ds.close();
      throw e;
    }
  }

  // 没人接着的常驻会话：问要接哪个 (用验证码那个弹窗)，空着 = 新建
  async pickDaemon(ds, free) {
    let note = '';
    for (;;) {
      // 每个会话：在哪个文件夹 (shell 报的当前目录)、标题 (Claude Code 等程序设置的)、多久前有输出
      const rows = free.map((x, i) => `${i + 1}. ${x.cwd || `会话 ${x.id}`}${x.title ? `\n    ${x.title}` : ''}`
        + `\n    ${x.lastOutput ? `${before(x.lastOutput)}有输出` : '还没有输出'} · ${before(x.created)}开的`).join('\n');
      const r = await this.ask('prompt', {
        title: '接上常驻会话',
        instructions: `${note}这台主机上有没接着的常驻会话：\n${rows}\n\n填编号接上；填「删 2」结束第 2 个 (里面的程序会被关掉，可以写几个：删 1 3)，`
          + '「删全部」全部结束；空着点「确定」新建一个',
        prompts: [{ prompt: '编号', echo: true }],
      });
      if (r.cancel || !Array.isArray(r.answers)) throw new Error('已取消');
      const a = String(r.answers[0] || '').trim();
      // 删：结束选中的会话，再问一次 (剩下的接着选，删光了就新建)
      const del = /^(?:删除?|del|d|x)\s*(全部|all|[\d\s,，、]+)$/i.exec(a);
      if (!del) return free[parseInt(a, 10) - 1]?.id || '';
      const picks = /全部|all/i.test(del[1]) ? free : [...new Set(del[1].split(/[\s,，、]+/).filter(Boolean))].map((k) => free[k - 1]).filter(Boolean);
      const done = [];
      for (const x of picks) {
        try { await ds.request({ op: 'kill', id: x.id }, 'ok'); done.push(x); } catch {}
      }
      note = done.length ? `已结束：${done.map((x) => x.cwd || `会话 ${x.id}`).join('、')}\n\n` : `没有这个编号：${del[1]}\n\n`;
      await new Promise((ok) => setTimeout(ok, 300)); // 结束要一会儿
      const gone = new Set(done.map((x) => x.id));
      free = ((await ds.request({ op: 'list' }, 'list')).sessions || []).filter((x) => !x.clients && !gone.has(x.id));
      if (!free.length) return '';
    }
  }

}

module.exports = SessionDaemon;
module.exports.DaemonStream = DaemonStream;
