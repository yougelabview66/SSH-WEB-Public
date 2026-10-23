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

// sshwebd 的版本号：编出来的文件旁边的 version.txt (构建 Docker 镜像时写的)，没有就看源码 sshwebd/main.go 里的 version
function binVersion(file) {
  const ok = (v) => (/^\d+(\.\d+)*$/.test(v) ? v : '');
  try { const v = ok(fs.readFileSync(path.join(path.dirname(file), 'version.txt'), 'utf8').trim()); if (v) return v; } catch {}
  try { return ok((/^var version = "([^"]+)"/m.exec(fs.readFileSync(path.join(ROOT, 'sshwebd', 'main.go'), 'utf8')) || [])[1] || ''); } catch { return ''; }
}

// 服务器上对应平台的 sshwebd (windows / linux-amd64 / linux-arm64 / linux-armv7；没有返回 null)。
// 主机上的名字带版本号 (sshwebd-v0.1.6.exe)，换了版本就是新名字；读不到版本号才按内容的哈希取
const bins = new Map();
function localBin(plat) {
  const file = plat === 'windows' ? (process.env.SSHWEBD_EXE || path.join(ROOT, 'sshwebd', 'sshwebd.exe'))
    : path.join(process.env.SSHWEBD_DIR || path.join(ROOT, 'sshwebd'), `sshwebd-${plat}`);
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile()) return null;
  const b = bins.get(plat);
  if (b && b.file === file && b.size === st.size && b.mtime === st.mtimeMs) return b;
  const ver = binVersion(file);
  const nb = { file, size: st.size, mtime: st.mtimeMs, base: `sshwebd-${ver ? `v${ver}` : crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 8)}`, ext: plat === 'windows' ? '.exe' : '' };
  nb.name = nb.base + nb.ext;
  bins.set(plat, nb);
  return nb;
}

// uname -m → 编了哪个 Linux 版
const LINUX_ARCH = { x86_64: 'amd64', amd64: 'amd64', aarch64: 'arm64', arm64: 'arm64', armv7l: 'armv7', armv6l: 'armv7', armv8l: 'armv7' };
// 不是 Windows / Linux (macOS 等)、或者没有这个架构的：照常开普通终端，不提示 (见 ssh.js)
const UNSUPPORTED = '常驻会话目前只支持 Windows、Linux 主机';
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// 找到要运行的 sshwebd，返回在主机上的路径 (Windows 写法 / Linux 写法)：
// - 服务器上有对应平台的：传到 ~/.ssh-web/sshwebd-v<版本>(.exe) (Linux 再加执行权限)。
//   名字只看版本号：版本一样 = 功能一样 (Docker 每次构建都重新编译，二进制略有不同，不是功能变了)，
//   主机上已经有同名文件就直接用、不重传也不改名 —— 以前被运行中的进程占住换不掉时会传成 -2，主机上越积越多
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
    const re = win ? /^sshwebd[^\\/]*\.exe$/i : /^sshwebd(-[0-9a-z.-]+)?$/;
    const list = (await p((cb) => sftp.readdir(dir, cb)).catch(() => [])).filter((e) => re.test(e.filename));
    const e = list.find((x) => x.filename.toLowerCase() === (win ? 'sshwebd.exe' : 'sshwebd')) || list.sort((x, y) => y.attrs.mtime - x.attrs.mtime)[0];
    if (!e) throw new Error(win ? `主机上没有 sshwebd：把 sshwebd.exe 放到 ${at('')}` : UNSUPPORTED);
    return at(e.filename);
  }
  await p((cb) => sftp.mkdir(dir, cb)).catch(() => {});
  const name = b.name;
  const st = await p((cb) => sftp.stat(posix.join(dir, name), cb)).catch(() => null);
  if (!st) { // 这个版本还没传过 (新版本是新名字，不会被运行中的旧进程占着)
    say(`\x1b[90m正在把 sshwebd 传到主机 (${(b.size / 1048576).toFixed(1)} MB) ...\x1b[0m`);
    const tmp = posix.join(dir, name + '.part');
    await p((cb) => sftp.fastPut(b.file, tmp, cb));
    await p((cb) => sftp.unlink(posix.join(dir, name), cb)).catch(() => {});
    try { await p((cb) => sftp.rename(tmp, posix.join(dir, name), cb)); }
    catch (e) { await p((cb) => sftp.unlink(tmp, cb)).catch(() => {}); throw new Error('没能把 sshwebd 传到主机：' + e.message); }
  }
  if (!win) await p((cb) => sftp.chmod(posix.join(dir, name), 0o755, cb)).catch(() => {});
  await cleanupOldDaemon(sess, name);
  return at(name);
}

// 主机 ~/.ssh-web 里的旧 sshwebd 文件：别的版本 (sshwebd-v0.1.5)、同版本换过名字的 (sshwebd-v0.1.6-2)、
// 以前按哈希起名的 (sshwebd-1a2b3c4d)、旁边的 .part / .sha256。正在运行的删不掉 (升级后旧守护进程里面
// 有会话会一直活着)，留着下次再删 —— 连接着的时候每 5 分钟也会清一次 (见 openDaemon)，不用等下次连接。
// 主机上自己放的 sshwebd(.exe) 不删
const OLD_DAEMON_RE = /^sshwebd-(v[0-9][0-9a-z.-]*|[0-9a-f]{8})(\.exe)?(\.part|\.sha256)?$/i;
async function cleanupOldDaemon(sess, keep) {
  try {
    const sftp = await sftpOf(sess);
    if (!sess.ssh || sess.status !== 'connected') return;
    const home = await p((cb) => sftp.realpath('.', cb));
    const dir = posix.join(home, '.ssh-web');
    const list = await p((cb) => sftp.readdir(dir, cb)).catch(() => []);
    for (const e of list) {
      if (OLD_DAEMON_RE.test(e.filename) && e.filename !== keep) sftp.unlink(posix.join(dir, e.filename), () => {});
    }
  } catch {} // 清不了就算了，下次再清
}

// 同一台主机同时只传一次 (服务重启后所有常驻标签一起自动接回、一起传)：后来的等前一个传完，共用它的结果。
// 不然几个标签往同一个 .part 里一起写、互相清掉对方刚传上去的文件，有的标签就退回普通终端了
const deploying = new Map(); // 主机 → Promise
function deployOnce(sess, say, plat) {
  const key = `${sess.hostId || `${sess.cfg?.rawHost}:${sess.cfg?.port}`}|${plat}`;
  const prev = deploying.get(key);
  if (prev) return prev;
  const p = deploy(sess, say, plat).finally(() => { if (deploying.get(key) === p) deploying.delete(key); });
  deploying.set(key, p);
  return p;
}

const FRAME_MAX = 4 << 20; // 同 sshwebd 的 maxFrame

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
      // sshwebd 一帧最多 4MB、帧类型只有 O / M：对不上就是数据乱了 (登录脚本插了东西、行被截断)，
      // 再拼下去只会无限占内存、画面卡住，关掉通道让外面重新连 (常驻会话会自动接回去)
      if (n > FRAME_MAX || (buf[0] !== 0x4f && buf[0] !== 0x4d)) { this.frameBuf = Buffer.alloc(0); this.close(); return; }
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

  // 发一个请求，等某种回复 (回 error 就报错)。超时了把自己从等待的列表里拿掉：不然晚到的回复被它吃掉，后面的请求整体错位
  request(obj, type, ms = 15000) {
    return new Promise((resolve, reject) => {
      const w = { type, resolve: (m) => { clearTimeout(timer); resolve(m); }, reject: (e) => { clearTimeout(timer); reject(e); } };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('sshwebd 没有回复'));
      }, ms);
      this.waiters.push(w);
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
      const u = await new Promise((r) => this.rawExec(ssh, 'uname -sm', r, 10000));
      this.unameFailed = u.code === -1; // 超时没回话：不是认出了别的系统 (回了但没输出 = 真不是 Linux，照常记)
      const m = /^Linux\s+(\S+)/m.exec(u.out || '');
      os = m ? 'linux' : 'other';
      plat = m && LINUX_ARCH[m[1]] ? `linux-${LINUX_ARCH[m[1]]}` : '';
    }
    this.noteHostOs(os);
    if (!plat) throw new Error(UNSUPPORTED);
    this.daemonOs = os;
    if (!alive()) return;
    const exe = await deployOnce(this, (t) => alive() && this.line(t), plat);
    if (!alive()) return;
    // 主机上跑 sshwebd 的命令 (bridge；关标签时结束会话用 kill，见 killDaemon)
    this.daemonCmd = (args) => (os === 'linux' ? `${shq(exe)} ${args}` : base === 'powershell' ? `& '${exe.replace(/'/g, "''")}' ${args}` : `"${exe}" ${args}`);
    const bridge = async () => {
      const ch = await p((cb) => ssh.exec(this.daemonCmd('bridge'), cb));
      const s = new DaemonStream(ch);
      try {
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('sshwebd 没有响应')), 20000);
          s.once('ready', () => { clearTimeout(t); resolve(); });
          s.once('fail', (m) => { clearTimeout(t); reject(new Error(m)); });
          s.once('close', () => { clearTimeout(t); reject(new Error(s.errText?.trim() || 'sshwebd 没有运行起来')); });
        });
      } catch (e) { s.close(); throw e; }
      return s;
    };
    let ds = await bridge();
    if (!alive()) return ds.close();
    try {
      // 主机上在跑的守护进程可能是旧版 (有常驻会话就一直不退出，传上去的新版只当 bridge 用)：版本号看它自己回的
      let lr = await ds.request({ op: 'list' }, 'list');
      if (lr.version && !verAtLeast(lr.version, ds.version)) {
        let go = !(lr.sessions || []).length; // 没有会话：不用问，直接换成新版
        if (!go) {
          // 有会话还开着：问一句。是 = 结束这些会话强制换 (Claude Code 等的对话能在「会话历史」里继续)；否 = 先用现有的，下次连接再问
          const r = await this.ask('daemon-update', { old: lr.version, ver: ds.version, n: (lr.sessions || []).length }).catch(() => ({}));
          if (!alive()) return ds.close();
          go = r.update === true;
          if (!go) this.line(`\x1b[90m主机上在跑的 sshwebd 是旧版 ${lr.version}，先用它 (SSH-WEB 带了 ${ds.version})\x1b[0m`);
        }
        if (go) {
          this.line(`\x1b[90m主机上的 sshwebd 是旧版 ${lr.version}，换成 ${ds.version}\x1b[0m`);
          try { await ds.request({ op: 'quit', force: true }, 'ok'); } catch {}
          ds.close();
          await new Promise((ok) => setTimeout(ok, 1500)); // 等旧进程退出、它占着的文件删得动了
          if (!alive()) return;
          ds = await bridge();
          lr = await ds.request({ op: 'list' }, 'list');
          cleanupOldDaemon(this, exe.split(/[\\/]/).pop()).catch(() => {}); // 旧版本的文件删掉 (删不掉下次连接再删)
        }
      }
      this.daemonVer = lr.version || ds.version;
      const list = lr.sessions || [];
      // 这个标签以前接着的会话还在：接回去 (这个标签的终端里已经有之前的输出，只要没收到的)；不然看有没有没人接着的让你选。
      // 断线期间它被别的标签接走了 (接着它的客户端里有别的标签的标记；自己断网前的旧连接是自己的标记，接上时守护进程会踢掉)：
      // 不去抢，提示一句重新选。旧版守护进程不报标记，分不清就照旧接回去
      // 自己选了「在这里也打开」(和别的标签一起用) 的会话：断线后照样接回去，不算被接走 (daemonShare)
      // 会话号会重复用：创建时间也对上才是原来那个 (不然是它结束以后同号的新会话)
      const prev = this.daemonId && list.find((x) => x.id === this.daemonId && !(this.daemonCreated && x.created && x.created !== this.daemonCreated));
      const taken = prev && !this.daemonShare && this.daemonUsers(prev).length > 0;
      let id = prev && !taken ? this.daemonId : '';
      const since = id && this.daemonOff != null ? this.daemonOff : undefined;
      // 以前接着的会话没了 (电脑重启过、守护进程退出过、会话结束了)：说清楚，不悄悄换成别的
      if (this.daemonId && !prev) this.line(`\x1b[33m之前接着的常驻会话 ${this.daemonId} 已经不在了 (电脑重启过或会话结束了)；Claude Code 等的对话可以在「⋯ 更多 → 💬 会话历史」里继续\x1b[0m`);
      if (taken) this.line(`\x1b[33m之前接着的常驻会话 ${this.daemonId} 已经被${this.usersText(this.daemonUsers(prev))}接上了，请重新选一个或者新建\x1b[0m`);
      let users = prev && id ? this.daemonUsers(prev) : []; // 接上时还有别的标签接着 (一起用的)：两边都提示一句
      if (!id) {
        this.daemonOff = null;
        this.daemonShare = false;
        // 主机上有常驻会话就弹列表 (有人接着的也列出来、标明在哪接着，接之前问要不要强制连接)；一个都没有才直接新建。
        // 突然断电 / 断网后主机上还挂着旧连接 (sshd 要很久才发现)，会话看着像有人在用，照样能在列表里强制连上
        if (list.length || taken) {
          const r = await this.pickDaemon(ds, list, taken ? `之前接着的会话 ${this.daemonId} 已经被${this.usersText(this.daemonUsers(prev))}接上了，请重新选一个或者新建` : '');
          id = r.id;
          users = r.users || [];
          this.daemonShare = !!r.share;
        }
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
      this.daemonStarted = verAtLeast(this.daemonVer, '0.1.5') ? this.daemonCreated : 0;
      this.line(`\x1b[90m${m.created ? '新建' : '接上'}常驻会话 ${m.id} (sshwebd ${ds.version}${m.detached ? '' : '，⚠ 没能脱离 SSH 会话，断开时会话会结束'})\x1b[0m`);
      this.stream = ds;
      ds.on('data', (d) => { this.daemonOff += d.length; this.output(d); });
      ds.on('msg', (x) => {
        if (x.type !== 'exit' && x.type !== 'error') return;
        this.line(`\r\n\x1b[33m常驻会话 ${this.daemonId} ${x.type === 'exit' ? `已结束 (退出码 ${x.code})` : `出错：${x.error}`}\x1b[0m`);
        if (x.type === 'exit' && this.daemonCreated) agentInfo.delete(this.daemonKey(this.daemonId, this.daemonCreated));
        this.daemonId = this.daemonOff = null;
        this.broadcast({ type: 'params', params: this.info().params });
      });
      ds.on('close', () => { if (this.ssh === ssh) this.ended(); });
      ds.start();
      this.broadcast({ type: 'params', params: this.info().params });
      if (os === 'linux') setTimeout(() => this.checkTmuxInside(ssh), 1500); // 等 .bashrc 里自动开的 tmux 起来
      if (users.length) this.noteShared(users);
      this.setStatus('connected');
    } catch (e) {
      ds.close();
      throw e;
    }
  }

  // 关标签时选了「结束会话」：结束接着的常驻会话 (里面的程序会关掉)。这台 SSH-WEB 上还有别的标签接着同一个会话就不结束；
  // 主机上别的连接不管 (多半是断电 / 断网前留下的旧连接，sshd 要很久才发现，强制连上的会话照样能结束)。
  // 返回 'ok' / 'busy' (别的标签正用着) / 'no' (没连着、不是常驻会话、没能结束)
  killDaemon() {
    const ssh = this.ssh, id = this.daemonId;
    if (!ssh || !id || !this.daemonCmd || this.status !== 'connected') return Promise.resolve('no');
    const { sessions } = require('./index');
    const k = this.daemonKey(id, this.daemonCreated);
    if ([...sessions.values()].some((x) => x !== this && x.status === 'connected' && x.daemonId === id && x.daemonKey(x.daemonId, x.daemonCreated) === k)) return Promise.resolve('busy');
    return new Promise((resolve) => this.rawExec(ssh, this.daemonCmd(`kill ${id}`), ({ code }) => {
      if (code === 0) agentInfo.delete(k);
      resolve(code === 0 ? 'ok' : 'no');
    }));
  }

  // 接上的常驻会话还有别的标签接着 (选了「在这里也打开」，或者断线重连等情况)：这个标签和那些标签都提示一句，免得不知道两边在操作同一个终端
  noteShared(users) {
    const { sessions } = require('./index');
    this.broadcast({ type: 'toast', text: `这个常驻会话也在${this.usersText(users)}里打开着，两边显示同一个终端` });
    for (const u of users) sessions.get(u.tag)?.broadcast({ type: 'toast', text: `常驻会话 ${this.daemonId} 在标签「${this.title}-${this.n}」里也打开了，两边显示同一个终端` });
  }

  // 记下保存的主机是什么系统 (windows / linux / other)：新建主机默认勾着常驻会话，主机列表上的「常驻」只给能用的主机标
  noteHostOs(os) {
    if (!this.hostId) return;
    if (os === 'other' && (this.shellUnknown || this.unameFailed)) return; // 没问出来，不是真的认出了别的系统：不改记着的
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
    const has = (kv) => `tr '\\0' '\\n' 2>/dev/null < ${file} | grep -qx '${kv}'`;
    return this.daemonId && this.daemonStarted ? `{ ${has(this.tabMarker())} && ${has(`SSHWEBD_STARTED=${this.daemonStarted}`)}; }` : has(this.tabMarker());
  }

  // shell 片段：带这个标签标记的进程号放进 $pids (按号从小到大)。GNU grep 用 -z 一次读完所有进程的环境变量 (几十毫秒)；
  // 不支持 -z 的 grep (busybox 等；ugrep 的 -z 是解压，也先试一下认出来) 才逐个进程看 (每个进程开几个子进程，进程多、机器慢时要好几秒)
  markedPidsSh() {
    const keys = [this.tabMarker(), ...(this.daemonId && this.daemonStarted ? [`SSHWEBD_STARTED=${this.daemonStarted}`] : [])];
    const fast = keys.map((k, i) => (i ? `[ -n "$l" ] && l=$(grep -lszx '${k}' $l 2>/dev/null)` : `l=$(grep -lszx '${k}' /proc/[0-9]*/environ 2>/dev/null)`)).join('; ');
    return [
      `if [ "$(printf 'xa\\0b\\0' | grep -czx b 2>/dev/null)" = 1 ]; then ${fast}; pids=$(printf '%s\\n' $l | sed -n 's#^/proc/\\([0-9]*\\)/environ$#\\1#p' | sort -n)`,
      `else pids=; for p in $(ls /proc 2>/dev/null | grep -E '^[0-9]+$' | sort -n); do ${this.markerTest('"/proc/$p/environ"')} && pids="$pids $p"; done; fi`,
    ].join('\n');
  }

  daemonKey(id, created) {
    return `${this.hostId || `${this.cfg?.rawHost}:${this.cfg?.port}`}#${id}#${created}`;
  }

  // 钩子报来的 Agent 干活的目录 / 会话名称 (见 hooks.js、agent-sessions.js)：记到接着的常驻会话上
  noteDaemonAgent(info) {
    if (!this.daemonId || !this.daemonCreated) return;
    const k = this.daemonKey(this.daemonId, this.daemonCreated);
    const v = { ...agentInfo.get(k), ...info };
    agentInfo.delete(k); // 挪到最后：超过上限时先丢最久没更新的
    agentInfo.set(k, v);
    if (agentInfo.size > 500) agentInfo.delete(agentInfo.keys().next().value);
  }

  // 常驻会话现在被哪些别的标签接着：[{ tag, name }]，name 是这台 SSH-WEB 上的标签名，别处 (别的 SSH-WEB、命令行) 接着的是 ''。
  // 自己的标记不算 (自己断网前的旧连接，接上时守护进程会踢掉)；旧版守护进程不报标记，只知道有几个在接着
  daemonUsers(x) {
    if (!Array.isArray(x.tags)) return Array.from({ length: x.clients || 0 }, () => ({ tag: '', name: '' }));
    const { sessions } = require('./index');
    return x.tags.filter((t) => t !== this.id).map((t) => { const s = t && sessions.get(t); return { tag: t, name: s ? `${s.title}-${s.n}` : '' }; });
  }

  usersText(users) {
    const names = [...new Set(users.map((u) => (u.name ? `标签「${u.name}」` : '别处 (别的 SSH-WEB、命令行，或者断电断网前留下的旧连接)')))];
    return names.join('、') || '别的标签';
  }

  // 问接哪个常驻会话：网页上列出来 (同会话历史的样子)，点一个接上、点「删除」结束、点「新建会话」开新的、「退出」关掉这个标签。
  // 还有连接的也列出来、标明在哪用：网页上先问要不要强制连接 (回 share)、强制删除 (回 force)。
  // 选完按最新的列表再查一遍 (问的时候别的标签可能刚接上 / 删掉了)。返回 { id, share, users }，id 为 '' = 新建。
  // 删除时网页上的弹窗不关 (回答带 keep)，这里结束后马上再问一次，网页原地刷新列表
  async pickDaemon(ds, list, note = '') {
    for (;;) {
      const view = (x) => {
        const a = agentInfo.get(this.daemonKey(x.id, x.created));
        const users = this.daemonUsers(x);
        return { id: x.id, title: CONSOLE_TITLE_RE.test(x.title || '') ? '' : x.title || '', cwd: a?.cwd || x.cwd || '', name: a?.name || '',
          when: `${x.lastOutput ? `${before(x.lastOutput)}有输出` : '还没有输出'} · ${before(x.created)}开的`,
          busy: users.length ? this.usersText(users) : '', tags: users.map((u) => u.tag).filter(Boolean) };
      };
      // 没人用的排前面
      const rows = list.map(view);
      const r = await this.ask('daemon-pick', { note, tab: `${this.title}-${this.n}`, ver: this.daemonVer || '', sessions:[...rows.filter((x) => !x.busy), ...rows.filter((x) => x.busy)] });
      if (r.cancel) throw new Error('已取消');
      const want = String(r.kill || r.id || '');
      if (!want) return { id: '' };
      list = (await ds.request({ op: 'list' }, 'list')).sessions || [];
      const x = list.find((f) => f.id === want);
      if (!x) { note = `会话 ${want} 已经不在了`; continue; }
      const where = agentInfo.get(this.daemonKey(x.id, x.created))?.cwd || x.cwd || `会话 ${x.id}`;
      const users = this.daemonUsers(x);
      if (!r.kill) {
        if (users.length && !r.share) { note = `${where} 刚被${this.usersText(users)}接上了`; continue; }
        return { id: x.id, share: users.length > 0, users };
      }
      // 删除：结束它 (里面的程序会关掉，这台 SSH-WEB 上接着它的标签一起关掉)，再问一次。还有连接的要网页上确认过强制删除 (问的时候刚有人接上的，再问一次)。
      // 删光了也问：新建还是退出
      if (users.length && !r.force) { note = `${where} 刚被${this.usersText(users)}接上了，要删除请再确认`; continue; }
      // 强制删除：这台 SSH-WEB 上接着它的标签也一起关掉 (先记下来，会话结束后它们会忘掉接着的是哪个)
      const { sessions } = require('./index');
      const k = this.daemonKey(x.id, x.created);
      const tabs = [...sessions.values()].filter((t) => t !== this && t.daemonId === x.id && t.daemonKey(t.daemonId, t.daemonCreated) === k);
      try {
        await ds.request({ op: 'kill', id: x.id }, 'ok'); note = `已结束：${where}`; agentInfo.delete(k);
        for (const t of tabs) t.terminate();
        if (tabs.length) note += `，关掉了接着它的标签${tabs.map((t) => `「${t.title}-${t.n}」`).join('、')}`;
      } catch (e) { note = `没能结束：${e.message}`; }
      await new Promise((ok) => setTimeout(ok, 300)); // 结束要一会儿
      list = ((await ds.request({ op: 'list' }, 'list')).sessions || []).filter((f) => f.id !== x.id);
    }
  }

}

module.exports = SessionDaemon;
module.exports.DaemonStream = DaemonStream;
module.exports.UNSUPPORTED = UNSUPPORTED;
