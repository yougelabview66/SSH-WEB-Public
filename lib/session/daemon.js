'use strict';
// 会话：常驻会话 (sshwebd，源码在本项目的 sshwebd/ 目录，Go 写的，参考 Orca 的 orcad)。方法挂到 Session 上 (见 index.js)
//
// 主机设置里开了「常驻会话」：连上后不开普通的 shell，而是开一个不要终端的通道跑目标主机 ~/.ssh-web/ 里的
// `sshwebd bridge`，接到守护进程里的终端 (Windows 是 ConPTY，Linux 是系统的 pty)。守护进程脱离了 SSH 会话，
// SSH 断了、标签关了终端还在跑；这个标签重新连上接着用 (只补发没收到的输出)，新开的标签可以选一个没人接着的会话接上。
// 中间不经过 sshd 自己的终端那一层；数据一行一段 base64 (sshd 的默认 shell 是 PowerShell 时会按代码页改坏原始字节)。
// Linux 上常驻会话里开不开 tmux 都行：历史、项目目录、钩子按会话的 SSHWEBD_SESSION 找 (见 tabMarker)
//
// sshwebd 在构建 Docker 镜像时从 sshwebd/ 的源码编出来：sshwebd/sshwebd.exe (SSHWEBD_EXE 可以指定别的路径)、
// sshwebd/sshwebd-linux-<架构> (SSHWEBD_DIR 可以指定别的目录)，连接时自动传到目标主机；
// 服务器上没有 (直接跑源码、没编) 就用主机上自己放的 ~/.ssh-web/sshwebd(.exe)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { posix } = require('path');
const { EventEmitter } = require('events');
const { sftpOf } = require('../sftp');
const store = require('../store');
const { broadcastEvent } = require('../events');
const { ROOT } = require('../config');

const p = (fn) => new Promise((resolve, reject) => fn((e, v) => (e ? reject(e) : resolve(v))));

// 服务器上对应平台的 sshwebd (windows / linux-amd64 / linux-arm64 / linux-armv7；没有返回 null)；名字按内容的哈希取，换了文件就是新名字
const bins = new Map();
function localBin(plat) {
  const file = plat === 'windows' ? (process.env.SSHWEBD_EXE || path.join(ROOT, 'sshwebd', 'sshwebd.exe'))
    : path.join(process.env.SSHWEBD_DIR || path.join(ROOT, 'sshwebd'), `sshwebd-${plat}`);
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile()) return null;
  const b = bins.get(plat);
  if (b && b.file === file && b.size === st.size && b.mtime === st.mtimeMs) return b;
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 8);
  const nb = { file, size: st.size, mtime: st.mtimeMs, name: `sshwebd-${hash}${plat === 'windows' ? '.exe' : ''}` };
  bins.set(plat, nb);
  return nb;
}

// uname -m → 编了哪个 Linux 版
const LINUX_ARCH = { x86_64: 'amd64', amd64: 'amd64', aarch64: 'arm64', arm64: 'arm64', armv7l: 'armv7', armv6l: 'armv7', armv8l: 'armv7' };
// 不是 Windows / Linux (macOS 等)、或者没有这个架构的：照常开普通终端，不提示 (见 ssh.js)
const UNSUPPORTED = '常驻会话目前只支持 Windows、Linux 主机';
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// 找到要运行的 sshwebd，返回在主机上的路径 (Windows 写法 / Linux 写法)：
// - 服务器上有对应平台的：传到 ~/.ssh-web/sshwebd-<哈希>(.exe) (Windows 上正在运行的 exe 不能覆盖，所以换个名字；Linux 再加执行权限)，
//   已经有了 (大小对得上) 就不传；以前这样传的删掉 (还在运行的删不掉，下次再删)
// - 没有：用主机上的 ~/.ssh-web/sshwebd(.exe)，没有就用那里最新的 sshwebd*
async function deploy(sess, say, plat) {
  const win = plat === 'windows';
  const sftp = await sftpOf(sess);
  const home = await p((cb) => sftp.realpath('.', cb));
  if (win !== /^\/[A-Za-z]:/.test(home)) throw new Error(win ? '这台主机不是 Windows' : UNSUPPORTED);
  const dir = posix.join(home, '.ssh-web');
  const at = (name) => (win ? `${home.slice(1).replace(/\//g, '\\')}\\.ssh-web\\${name}` : posix.join(dir, name));
  const b = localBin(plat);
  if (!b) {
    const re = win ? /^sshwebd[^\\/]*\.exe$/i : /^sshwebd(-[0-9a-z-]+)?$/;
    const list = (await p((cb) => sftp.readdir(dir, cb)).catch(() => [])).filter((e) => re.test(e.filename));
    const e = list.find((x) => x.filename.toLowerCase() === (win ? 'sshwebd.exe' : 'sshwebd')) || list.sort((x, y) => y.attrs.mtime - x.attrs.mtime)[0];
    if (!e) throw new Error(win ? `主机上没有 sshwebd：把 sshwebd.exe 放到 ${at('')}` : UNSUPPORTED);
    return at(e.filename);
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
  if (!win) await p((cb) => sftp.chmod(dst, 0o755, cb)).catch(() => {});
  const list = await p((cb) => sftp.readdir(dir, cb)).catch(() => []);
  const old = win ? /^sshwebd-[0-9a-f]{8}\.exe(\.part)?$/ : /^sshwebd-[0-9a-f]{8}(\.part)?$/;
  for (const e of list) {
    if (old.test(e.filename) && e.filename !== b.name) sftp.unlink(posix.join(dir, e.filename), () => {});
  }
  return at(b.name);
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

// 常驻会话里的 Agent (Claude Code 等)：干活的目录 (钩子报来的) 和会话名称 (从会话历史「继续」的那个对话的名称，
// 或者钩子报来的最近一次让它做的事)。同一台主机、同一个会话 (会话号会重复用，带上创建时间)，选择框里优先显示 ——
// shell 报的目录是最后一次显示提示符时的，`cd 某处; claude` 这种一行命令里 cd 之后就不再报了
const agentInfo = new Map();
// 控制台窗口默认的标题 (「管理员: C:\WINDOWS\System32\…\powershell.exe」这种)：看不出是哪个会话，不显示
const CONSOLE_TITLE_RE = /^(管理员|Administrator)\s*[:：]|\\(System32|WindowsPowerShell)\\|\b(powershell|pwsh|cmd)(\.exe)?$/i;

// 版本号 a >= b (x.y.z)
const verAtLeast = (a, b) => {
  const pa = String(a || '').split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== pb[i]) return (pa[i] || 0) > pb[i];
  return true;
};

// 多久以前：刚刚 / 3 分钟前 / 2 小时前 / 5 天前
const before = (ms) => {
  const m = Math.floor((Date.now() - ms) / 60000);
  return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 2880 ? `${Math.floor(m / 60)} 小时前` : `${Math.floor(m / 1440)} 天前`;
};

class SessionDaemon {
  // 连上后：常驻会话开起来了返回 true；不是 Windows / Linux 主机等情况抛错 (调用的地方改开普通 shell)
  async openDaemon(ssh, alive) {
    const base = await this.shellBase(ssh);
    // SSH 默认的 shell 是 sh 的：看是不是 Linux、什么架构
    let os = 'windows', plat = 'windows';
    if (base === 'sh') {
      const u = await new Promise((r) => this.rawExec(ssh, 'uname -sm', r));
      const m = /^Linux\s+(\S+)/m.exec(u.out || '');
      os = m ? 'linux' : 'other';
      plat = m && LINUX_ARCH[m[1]] ? `linux-${LINUX_ARCH[m[1]]}` : '';
    }
    this.noteHostOs(os);
    if (!plat) throw new Error(UNSUPPORTED);
    this.daemonOs = os;
    if (!alive()) return;
    const exe = await deploy(this, (t) => alive() && this.line(t), plat);
    if (!alive()) return;
    const cmd = os === 'linux' ? `${shq(exe)} bridge` : base === 'powershell' ? `& '${exe.replace(/'/g, "''")}' bridge` : `"${exe}" bridge`;
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
      // 这个标签以前接着的会话还在：接回去 (这个标签的终端里已经有之前的输出，只要没收到的)；不然看有没有没人接着的让你选。
      // 断线期间它被别的标签接走了 (接着它的客户端里有别的标签的标记；自己断网前的旧连接是自己的标记，接上时守护进程会踢掉)：
      // 不去抢，提示一句重新选。旧版守护进程不报标记，分不清就照旧接回去
      const prev = this.daemonId && list.find((x) => x.id === this.daemonId);
      const taken = prev && Array.isArray(prev.tags) && prev.tags.some((t) => t !== this.id);
      let id = prev && !taken ? this.daemonId : '';
      const since = id && this.daemonOff != null ? this.daemonOff : undefined;
      // 以前接着的会话没了 (电脑重启过、守护进程退出过、会话结束了)：说清楚，不悄悄换成别的
      if (this.daemonId && !prev) this.line(`\x1b[33m之前接着的常驻会话 ${this.daemonId} 已经不在了 (电脑重启过或会话结束了)；Claude Code 等的对话可以在「⋯ 更多 → 💬 会话历史」里继续\x1b[0m`);
      if (taken) this.line(`\x1b[33m之前接着的常驻会话 ${this.daemonId} 已经被别的标签接上了，请重新选一个或者新建\x1b[0m`);
      if (!id) {
        this.daemonOff = null;
        const free = list.filter((x) => !x.clients);
        // 被接走的那种情况：没有别的空闲会话也弹列表 (只有「新建会话」)，让人知道换成新的了
        if (free.length || taken) id = await this.pickDaemon(ds, free, taken ? `之前接着的会话 ${this.daemonId} 已经被别的标签接上了，请重新选一个或者新建` : '');
      }
      if (!alive()) return ds.close();
      // tag：这个标签的标记 (守护进程据此踢掉自己断网前的旧连接、在列表里报谁接着，见 sshwebd 的 Request.Tag)
      const m = await ds.request({ op: 'attach', id, cols: this.cols, rows: this.rows, tag: this.id, env: { LC_SSHWEB: this.id }, ...(since !== undefined && { since }) }, 'attached');
      if (!alive()) return ds.close();
      clearTimeout(this.timer); // 问选哪个会话时又计上了连接超时
      this.daemonId = m.id;
      this.daemonOff = m.start;
      this.daemonCreated = m.at || list.find((x) => x.id === m.id)?.created || 0; // 接上以后这条连接不再回答请求，用接上时回的
      // 0.1.5 起会话的环境变量里带着 SSHWEBD_STARTED (= 创建时间)，认进程时一起比 (见 markerTest)
      this.daemonStarted = verAtLeast(ds.version, '0.1.5') ? this.daemonCreated : 0;
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
      if (os === 'linux') setTimeout(() => this.checkTmuxInside(ssh), 1500); // 等 .bashrc 里自动开的 tmux 起来
      this.setStatus('connected');
    } catch (e) {
      ds.close();
      throw e;
    }
  }

  // 记下保存的主机是什么系统 (windows / linux / other)：新建主机默认勾着常驻会话，主机列表上的「常驻」只给能用的主机标
  noteHostOs(os) {
    if (!this.hostId) return;
    const list = store.hosts.read();
    const h = list.find((x) => x.id === this.hostId);
    if (!h || (h.os === os && h.isWin === undefined)) return;
    h.os = os;
    delete h.isWin; // 以前只记是不是 Windows
    try { store.hosts.write(list); } catch {}
    broadcastEvent({ type: 'hosts' }); // 打开着的页面重新读主机列表 (「常驻」标记跟着变)
  }

  // 常驻会话里开 tmux 是多余的 (守护进程已经能在断线、关标签后保住终端)：提示一次，开着也照常能用
  hintTmux() {
    if (this.tmuxHinted) return;
    this.tmuxHinted = true;
    this.broadcast({ type: 'toast', text: '常驻会话已经能在断线、关标签后保住终端，不用再开 tmux（开着也没问题）' });
  }

  // 接上 Linux 常驻会话时里面已经开着 tmux (比如 .bashrc 里自动开的)：也提示一次
  checkTmuxInside(ssh) {
    const script = `command -v tmux >/dev/null 2>&1 || exit 0; for c in $(tmux list-clients -F '#{client_pid}' 2>/dev/null); do `
      + `${this.markerTest('"/proc/$c/environ"')} && { echo SSHWEB_TMUX; break; }; done`;
    this.rawExec(ssh, `sh -c ${shq(script)}`, ({ out }) => { if (this.ssh === ssh && /SSHWEB_TMUX/.test(out || '')) this.hintTmux(); });
  }

  // 在主机上认这个标签的标记：常驻会话里是会话自己的 SSHWEBD_SESSION (换了标签接上也不变；LC_SSHWEB 是第一次开它的那个标签)，
  // 普通会话是 LC_SSHWEB (见 ssh.js 的 openShell)。找 tmux 客户端、找前台程序的当前目录都按它 (见 remote.js、git-changes.js)
  tabMarker() {
    return this.daemonId ? `SSHWEBD_SESSION=${this.daemonId}` : `LC_SSHWEB=${this.id}`;
  }

  // shell 里的条件：环境变量文件 (/proc/<pid>/environ，参数是带引号的路径) 里有这个标签的标记。
  // 常驻会话号会重复用：守护进程 0.1.5 起还带着创建时间 SSHWEBD_STARTED，两个都对上才算 (不认以前同号会话留下的后台进程)
  markerTest(file) {
    const has = (kv) => `tr '\\0' '\\n' < ${file} 2>/dev/null | grep -qx '${kv}'`;
    return this.daemonId && this.daemonStarted ? `{ ${has(this.tabMarker())} && ${has(`SSHWEBD_STARTED=${this.daemonStarted}`)}; }` : has(this.tabMarker());
  }

  daemonKey(id, created) {
    return `${this.hostId || `${this.cfg?.rawHost}:${this.cfg?.port}`}#${id}#${created}`;
  }

  // 钩子报来的 Agent 干活的目录 / 会话名称 (见 hooks.js、agent-sessions.js)：记到接着的常驻会话上
  noteDaemonAgent(info) {
    if (!this.daemonId || !this.daemonCreated) return;
    const k = this.daemonKey(this.daemonId, this.daemonCreated);
    agentInfo.set(k, { ...agentInfo.get(k), ...info });
  }

  // 没人接着的常驻会话：网页上列出来 (同会话历史的样子) 点一个接上、点「删除」结束、点「新建会话」开新的。
  // 返回要接的 id，'' = 新建
  async pickDaemon(ds, free, note = '') {
    for (;;) {
      const r = await this.ask('daemon-pick', {
        note,
        sessions: free.map((x) => ({ id: x.id, title: CONSOLE_TITLE_RE.test(x.title || '') ? '' : x.title || '',
          cwd: agentInfo.get(this.daemonKey(x.id, x.created))?.cwd || x.cwd || '',
          name: agentInfo.get(this.daemonKey(x.id, x.created))?.name || '',
          when: `${x.lastOutput ? `${before(x.lastOutput)}有输出` : '还没有输出'} · ${before(x.created)}开的` })),
      });
      if (r.cancel) throw new Error('已取消');
      const x = r.kill && free.find((f) => f.id === String(r.kill));
      if (!x) return free.some((f) => f.id === String(r.id || '')) ? String(r.id) : '';
      // 删除：结束这个会话 (里面的程序会关掉)，再问一次；删光了就新建
      const where = agentInfo.get(this.daemonKey(x.id, x.created))?.cwd || x.cwd || `会话 ${x.id}`;
      try { await ds.request({ op: 'kill', id: x.id }, 'ok'); note = `已结束：${where}`; agentInfo.delete(this.daemonKey(x.id, x.created)); } catch (e) { note = `没能结束：${e.message}`; }
      await new Promise((ok) => setTimeout(ok, 300)); // 结束要一会儿
      free = ((await ds.request({ op: 'list' }, 'list')).sessions || []).filter((f) => !f.clients && f.id !== x.id);
      if (!free.length) return '';
    }
  }


}

module.exports = SessionDaemon;
module.exports.DaemonStream = DaemonStream;
module.exports.UNSUPPORTED = UNSUPPORTED;
