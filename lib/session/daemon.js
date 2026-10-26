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
const { hostKey } = require('./hooks');

// 单个 SFTP 操作最多等 30 秒：经代理 / 隧道连的时候网络可能半开 (TCP 还连着、包全丢)，回调永远不来；
// 不限时的话常驻会话会一直停在「连接中」(标签黄着)，也走不到降级普通终端那一步
const SFTP_OP_MS = 30000;
const p = (fn, ms = SFTP_OP_MS) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`SFTP 操作超时 (${Math.round(ms / 1000)} 秒没回应)`)), ms);
  fn((e, v) => { clearTimeout(t); e ? reject(e) : resolve(v); });
});
// sshwebd 本身没救了 (僵死：不回话 / 起不来)：修复时可以放心把它的进程结束掉，见 repairDaemon
const daemonDead = (e) => { e.daemonDead = true; return e; };

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
    // Linux 报「只支持 Windows、Linux」会误导排查 (明明是 Linux)：说清楚是两个地方都没有二进制。
    // 用 Docker 跑的都有；从源码跑要自己编 (见 sshwebd/README.md)，或把编好的放到主机的 ~/.ssh-web/
    if (!e) throw new Error(win ? `主机上没有 sshwebd：把 sshwebd.exe 放到 ${at('')}`
      : `SSH-WEB 服务器上没有 ${plat} 版 sshwebd、主机的 ${at('')} 里也没有 (Docker 镜像自带；源码跑的要自己编，见 sshwebd/README.md)`);
    return at(e.filename);
  }
  await p((cb) => sftp.mkdir(dir, cb)).catch(() => {});
  const name = b.name;
  const st = await p((cb) => sftp.stat(posix.join(dir, name), cb)).catch(() => null);
  if (!st) { // 这个版本还没传过 (新版本是新名字，不会被运行中的旧进程占着)
    say(`\x1b[90m正在把 sshwebd 传到主机 (${(b.size / 1048576).toFixed(1)} MB) ...\x1b[0m`);
    const tmp = posix.join(dir, name + '.part');
    // 传大文件只看「有没有在动」：每传完一块续期，60 秒没有进展 (网络半开) 才算失败并关掉 SFTP 通道；慢但还在传的就一直等
    await new Promise((resolve, reject) => {
      const stall = () => { try { sftp.close(); } catch {} reject(new Error('上传 sshwebd 超时：60 秒没有进展')); };
      let t = setTimeout(stall, 60000);
      sftp.fastPut(b.file, tmp, { step: () => { clearTimeout(t); t = setTimeout(stall, 60000); } }, (e) => { clearTimeout(t); e ? reject(e) : resolve(); });
    });
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
    // 先判断再开通道：以前是反过来，连接刚断 (closeConn 把 ssh / sftpPromise 都置空) 时定时器正好到点，
    // 会先在 sftpOf 里解引用空的 ssh 抛错 —— 注释说的「别碰已断开的会话」根本没起作用
    if (!sess.ssh || sess.status !== 'connected') return;
    const sftp = await sftpOf(sess);
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
  // key 里要带用户名：同一台主机同一个端口、用不同账号连 (root / deploy) 时，两个标签的家目录不一样，
  // 传上去的路径也不同 —— 以前共用一次 deploy，第二个标签会拿到第一个账号家目录下的路径，权限不对起不来
  const who = sess.cfg?.username || '';
  const key = `${sess.hostId || `${sess.cfg?.rawHost}:${sess.cfg?.port}`}|${who}|${plat}`;
  const prev = deploying.get(key);
  if (prev) return prev;
  // 不叫 p：模块级的 p 是带超时的 SFTP 包装函数，同名会把那个遮住，以后在这里加 await p(...) 就会炸
  const pr = deploy(sess, say, plat).finally(() => { if (deploying.get(key) === pr) deploying.delete(key); });
  deploying.set(key, pr);
  return pr;
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
// 每个常驻会话里 Agent / 程序的实际工作目录 (Linux)：按 SSHWEBD_SESSION 分组，Agent 进程的目录优先 ——
// 同项目文件面板找目录的方式 (见 git-changes.js 的 projectDir)，比守护进程报的 shell 目录准 (Agent 在项目目录里干活、
// shell 还停在启动时的目录)。A = Agent 的目录，D = 会话里最新进程的目录
const PICK_CWD_SH = [
  'PATH="$PATH:/usr/local/bin:/opt/homebrew/bin"',
  'for f in /proc/[0-9]*/environ; do',
  "  s=$(tr '\\0' '\\n' < \"$f\" 2>/dev/null | sed -n 's/^SSHWEBD_SESSION=//p' | head -n 1)",
  '  [ -n "$s" ] || continue',
  '  p=${f%/environ}; p=${p#/proc/}',
  '  [ -r "/proc/$p/cmdline" ] || continue',
  '  set -f', // 按空格拆命令行：里面的 * 等不要展开成文件名 (拆完就恢复，别影响外面的 /proc 通配)
  "  set -- $(tr '\\0' ' ' < \"/proc/$p/cmdline\" 2>/dev/null) ''; n0=${1##*/}; n1=${2##*/}",
  '  set +f',
  '  c=$(readlink "/proc/$p/cwd" 2>/dev/null)',
  '  [ -n "$c" ] || continue',
  '  case "$n0" in claude|codex|gemini|grok|opencode) echo "A $s $c";; node|nodejs|bun|deno)',
  '    case "$n1" in claude|claude.*|codex|codex.*|gemini|gemini.*|grok|grok.*|opencode|opencode.*) echo "A $s $c";;',
  '      cli.js|cli.mjs|index.js) case "$2" in */claude*/*|*/codex*/*|*/gemini*/*|*/grok*/*|*/opencode*/*) echo "A $s $c";; esac;; esac;; esac',
  '  echo "D $s $c"',
  'done',
  'exit 0',
].join('\n');

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
    this.unameFailed = false; // 每次连上都重新问：上一次超时的结论不能留到这一次 (见 noteHostOs)
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
    this.daemonPlat = plat; // 修复时删哪个文件 (见 repairDaemon)
    if (!alive()) return;
    const exe = await deployOnce(this, (t) => alive() && this.line(t), plat);
    if (!alive()) return;
    this.daemonExe = exe; // 正在用的文件 (清理旧版本时不删它，见下面的定时清理)
    // 主机上跑 sshwebd 的命令 (bridge；关标签时结束会话用 kill，见 killDaemon)
    this.daemonCmd = (args) => (os === 'linux' ? `${shq(exe)} ${args}` : base === 'powershell' ? `& '${exe.replace(/'/g, "''")}' ${args}` : `"${exe}" ${args}`);
    const bridge = async () => {
      // exec 的回调也可能永远不来 (通道开不起来时不回话)：限时，不然又停在「连接中」
      const ch = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('开 sshwebd 通道超时 (20 秒没回应)')), 20000);
        ssh.exec(this.daemonCmd('bridge'), (e, c) => { clearTimeout(t); e ? reject(e) : resolve(c); });
      });
      const s = new DaemonStream(ch);
      try {
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(daemonDead(new Error('sshwebd 没有响应'))), 20000);
          s.once('ready', () => { clearTimeout(t); resolve(); });
          s.once('fail', (m) => { clearTimeout(t); reject(daemonDead(new Error(m))); });
          s.once('close', () => { clearTimeout(t); reject(daemonDead(new Error(s.errText?.trim() || 'sshwebd 没有运行起来'))); });
        });
      } catch (e) { s.close(); throw e; }
      return s;
    };
    let ds = await bridge();
    if (!alive()) return ds.close();
    try {
      // 主机上在跑的守护进程可能是旧版 (有常驻会话就一直不退出，传上去的新版只当 bridge 用)：版本号看它自己回的
      // 回话超时 = 守护进程僵死 (daemonDead：修复时可以结束它的进程)
      const ask2 = (pr, type) => ds.request(pr, type).catch((e) => { throw e.message === 'sshwebd 没有回复' ? daemonDead(e) : e; });
      let lr = await ask2({ op: 'list' }, 'list');
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
          lr = await ask2({ op: 'list' }, 'list');
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
        // 选会话前要读主机上的目录、会话文件 (daemonCwds 8s + claudePeek 15s + claudePeekByCwd 15s，慢主机上可能几十秒)，
        // 而连接超时 (SSH_READY_TIMEOUT，默认 20 秒) 还挂着 —— 以前慢主机会在弹列表之前就报「连接超时」。
        // 这里先撤掉连接超时，等用户真的选了再按用户输入的时限 (ask 里会重新计时)
        clearTimeout(this.timer);
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
      const m = await ask2({ op: 'attach', id, cols: this.cols, rows: this.rows, tag: this.id, env: { LC_SSHWEB: this.id }, ...(since !== undefined && { since }) }, 'attached');
      if (!alive()) return ds.close();
      clearTimeout(this.timer); // 问选哪个会话时又计上了连接超时
      this.daemonId = m.id;
      this.daemonOff = m.start;
      this.daemonCreated = m.at || list.find((x) => x.id === m.id)?.created || 0; // 接上以后这条连接不再回答请求，用接上时回的
      // 0.1.5 起会话的环境变量里带着 SSHWEBD_STARTED (= 创建时间)，认进程时一起比 (见 markerTest)
      this.daemonStarted = verAtLeast(this.daemonVer, '0.1.5') ? this.daemonCreated : 0;
      // 标签命过名的 (见 session/index.js 的 rename)：接上时不用再记一遍 —— 网页断线重连会把还原出来的名字
      // 当 suffix 再发回来，这里记了的话，清掉的名字会被旧记录又写回来，一直清不干净；真改名的当时就已经记下了
      const dKey = this.daemonKey(this.daemonId, this.daemonCreated);
      if (!this.renamed) {
        const aSid = agentInfo.get(dKey)?.sid;
        const saved = store.daemonInfo(dKey)?.title || (aSid ? store.tabNameOf('conv', `${hostKey(this)}|${aSid}`) : '');
        if (saved) this.rename(saved, false); // 自动还原：只改显示
      }
      this.line(`\x1b[90m${m.created ? '新建' : '接上'}常驻会话 ${m.id} (sshwebd ${ds.version}${m.detached ? '' : '，⚠ 没能脱离 SSH 会话，断开时会话会结束'})\x1b[0m`);
      this.stream = ds;
      ds.on('data', (d) => { this.daemonOff += d.length; this.output(d); });
      ds.on('msg', (x) => {
        if (x.type !== 'exit' && x.type !== 'error') return;
        this.line(`\r\n\x1b[33m常驻会话 ${this.daemonId} ${x.type === 'exit' ? `已结束 (退出码 ${x.code})` : `出错：${x.error}`}\x1b[0m`);
        if (x.type === 'exit' && this.daemonCreated) {
          const k0 = this.daemonKey(this.daemonId, this.daemonCreated);
          agentInfo.delete(k0);
          store.delTabName('daemon', k0); // 会话没了，记的标签名也不再需要
        }
        this.daemonId = this.daemonOff = null;
        this.broadcast({ type: 'params', params: this.info().params });
      });
      ds.on('close', () => { if (this.ssh === ssh) this.ended(); });
      ds.start();
      // 旧版本的文件：连接时清过一遍，但那时旧守护进程可能还活着占着删不掉；它退出后 (里面没会话，最多空闲 1 分钟)
      // 没人再清 —— 连接着的时候每 5 分钟再清一遍，别让旧文件一直留在主机上
      clearInterval(this.oldCleanTimer);
      this.oldCleanTimer = setInterval(() => {
        if (this.status !== 'connected' || !this.ssh || !this.daemonExe) { clearInterval(this.oldCleanTimer); this.oldCleanTimer = null; return; }
        cleanupOldDaemon(this, this.daemonExe.split(/[\\/]/).pop()).catch(() => {});
      }, 5 * 60 * 1000);
      this.oldCleanTimer.unref?.();
      this.broadcast({ type: 'params', params: this.info().params });
      if (os === 'linux') setTimeout(() => this.checkTmuxInside(ssh), 1500); // 等 .bashrc 里自动开的 tmux 起来
      if (users.length) this.noteShared(users);
      this.setStatus('connected');
    } catch (e) {
      ds.close();
      throw e;
    }
  }

  // 常驻会话开不起来的兜底 (openDaemon 的包装，ssh.js 连上后调这里)：
  // 不再停在「连接中」(标签黄着) —— 先降级成普通终端马上能用，再修 sshwebd，修好自动重连切回常驻会话：
  //   第 1 轮：守护进程僵死了 (不回话 / 起不来，daemonDead) 就结束主机上卡住的进程再连一次；
  //   第 2 轮：再把传上去的二进制删掉重新传 (对付传坏的文件) 再连一次；还不行就停在普通终端。
  // 降级以后用户已经在这个终端里干活 (按过回车) 的话不硬切，下次连接自然用常驻会话，免得打断正在跑的命令
  async openDaemonRetry(ssh, alive) {
    const { sessions } = require('./index');
    const round = this.daemonSwitch ? this.daemonRound || 0 : 0; // 修复引起的重连接着上一轮数；用户自己点「重新连接」从零开始
    this.daemonSwitch = false;
    try {
      await this.openDaemon(ssh, alive);
      this.daemonRound = 0;
      return;
    } catch (e) {
      if (!alive()) return;
      if (e.message === '已取消') return this.terminate();
      // 修不了的：不支持的系统、服务器上没有对应平台的 sshwebd、已经试完两轮修复 —— 照旧直接降级
      const repairable = e.message !== UNSUPPORTED && this.daemonPlat && localBin(this.daemonPlat) && round < 2;
      if (!repairable) {
        if (e.message !== UNSUPPORTED) this.line(`\x1b[33m⚠ ${round >= 2 ? '修复后常驻会话还是连不上' : '常驻会话没开起来'}：${e.message}，改用普通终端\x1b[0m`);
        return this.openShell(ssh, alive);
      }
      this.daemonRound = round + 1;
      this.line(`\x1b[33m⚠ 常驻会话没开起来：${e.message}\x1b[0m`);
      this.line(`\x1b[90m先改用普通终端，同时修复 sshwebd 再自动切回 (第 ${round + 1}/2 次) ...\x1b[0m`);
      const fallbackAt = Date.now();
      this.openShell(ssh, alive); // 降级：终端马上能用 (状态变「已连接」，后面不能再用 alive() 判断)
      const on = () => sessions.has(this.id) && this.ssh === ssh && this.status === 'connected'; // 修复期间标签被关 / 连接断了就停手
      const fixed = await this.repairDaemon(ssh, round, !!e.daemonDead).catch(() => false);
      if (!on()) return;
      if (!fixed) { this.line(`\x1b[33m⚠ 修复 sshwebd 没能做完，本次用普通终端 (网络恢复后可重连再试)\x1b[0m`); return; }
      if (this.sentAt > fallbackAt) {
        this.line(`\x1b[90m✔ sshwebd 已修复；正在用的普通终端不断开，下次连接时自动改用常驻会话\x1b[0m`);
        return;
      }
      await new Promise((ok) => setTimeout(ok, 1500)); // 等杀掉的进程退干净
      if (!on()) return;
      this.line(`\x1b[90m✔ sshwebd 已修复，重新连接切到常驻会话 ...\x1b[0m`);
      this.closeConn(); // 结束降级的普通终端 (只断连接，不动 SSH-WEB 里的标签)，重新连接走常驻流程
      this.setStatus('closed');
      this.daemonSwitch = true;
      this.connect();
    }
  }

  // 修 sshwebd：dead = 它本身僵死了 (不回话 / 起不来 —— 里面就算还有常驻会话也早就接不上了)，结束主机上所有
  // sshwebd 进程；round > 0 再把传上去的二进制删掉，下次连接重新传 (对付传坏的文件)。主机上自己放的
  // sshwebd(.exe) 不删。返回 true = 修复动作做完了值得再连一次；false = 连 SFTP 都用不了，重传不了，别空跑
  async repairDaemon(ssh, round, dead) {
    if (!this.daemonOs) return false;
    if (dead) {
      this.line(`\x1b[90m正在修复 sshwebd：结束主机上卡住的 sshwebd 进程 ...\x1b[0m`);
      // Linux 的匹配串里写 sshweb[d]：pkill 不会杀自己，但外面 sh -c 的命令行里带着同样的串，会把 sh 也杀了
      const kill = this.daemonOs === 'linux' ? `pkill -f ${shq('\\.ssh-web/sshweb[d]')}` : 'taskkill /F /IM sshwebd*.exe';
      await new Promise((r) => this.rawExec(ssh, kill, r, 15000)); // 没装 pkill 之类杀不干净也不影响后面的重试
    }
    if (!round) return true;
    const b = localBin(this.daemonPlat);
    const name = this.daemonExe?.split(/[\\/]/).pop() || b?.name;
    if (!name || !OLD_DAEMON_RE.test(name)) return true; // 主机上自己放的 sshwebd：不动它
    this.line(`\x1b[90m删除主机上可能损坏的 ${name}，下次连接重新传 ...\x1b[0m`);
    try {
      const sftp = await sftpOf(this);
      const home = await p((cb) => sftp.realpath('.', cb));
      const dir = posix.join(home, '.ssh-web');
      await p((cb) => sftp.unlink(posix.join(dir, name), cb)).catch(() => {});
      await p((cb) => sftp.unlink(posix.join(dir, name + '.part'), cb)).catch(() => {});
    } catch { return false; }
    return true;
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
      if (code === 0) { agentInfo.delete(k); store.delTabName('daemon', k); }
      resolve(code === 0 ? 'ok' : 'no');
    }));
  }

  // 接上的常驻会话还有别的标签接着 (选了「在这里也打开」，或者断线重连等情况)：这个标签和那些标签都提示一句，免得不知道两边在操作同一个终端
  noteShared(users) {
    const { sessions } = require('./index');
    this.broadcast({ type: 'toast', text: `这个常驻会话也在${this.usersText(users)}里打开着，两边显示同一个终端` });
    for (const u of users) sessions.get(u.tag)?.broadcast({ type: 'toast', text: `常驻会话 ${this.daemonId} 在标签「${this.tabName()}」里也打开了，两边显示同一个终端` });
  }

  // 记下保存的主机是什么系统 (windows / linux / other)：新建主机默认勾着常驻会话，主机列表上的「常驻」只给能用的主机标
  noteHostOs(os) {
    if (!this.hostId) return;
    // 没问出来 (shellBase 两次都没回话、uname 超时)，不是真的认出了别的系统：不改记着的。
    // 两个标志都在每次连接时重新算 (见 remote.js 的 shellBase、上面的 openDaemon)，不会留到下一次
    if (os === 'other' && (this.shellUnknown || this.unameFailed)) return;
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

  // 主机上每个常驻会话里 Agent / 前台程序的实际工作目录 (Linux)：按 SSHWEBD_SESSION 分组，Agent 的目录优先 (a)，
  // 会话里最新进程的目录其次 (d)。同项目文件面板找目录的方式 (见 git-changes.js 的 projectDir)，比守护进程报的
  // shell 目录准 (Agent 在项目目录里干活、shell 停在启动时的目录)。list：选择框要列的会话 (顺手把读到的记下来，重启后还准)
  async daemonCwds(list = []) {
    const map = new Map();
    if (this.daemonOs !== 'linux' || !this.ssh) return map; // Windows 读不到别的进程的目录，走记的 / 守护进程报的
    const r = await new Promise((resolve) => this.rawExec(this.ssh, `sh -c ${shq(PICK_CWD_SH)}`, resolve, 8000));
    for (const l of String(r?.out || '').split('\n')) {
      const m = /^(A|D) (\S+) (.+)$/.exec(l.trim());
      if (!m) continue;
      const cur = map.get(m[2]) || {};
      if (m[1] === 'A') cur.a = m[3];
      cur.d = m[3];
      map.set(m[2], cur);
    }
    // 先把记着的读出来 (一次)，循环里只比对 —— 以前每行都 store.daemonInfo() 一次，
    // 那个函数每次都同步读整个 tab-names.json + JSON.parse，会话多的时候白白阻塞事件循环
    const saved = store.daemonInfos();
    for (const x of list) {
      const cwd = map.get(x.id)?.a || map.get(x.id)?.d || '';
      if (!cwd || !x.created) continue;
      const k = this.daemonKey(x.id, x.created);
      if (saved[k]?.cwd !== cwd) store.saveDaemonInfo(k, { cwd });
    }
    return map;
  }

  // 钩子报来的 Agent 干活的目录 / 会话名称 (见 hooks.js、agent-sessions.js)：记到接着的常驻会话上
  noteDaemonAgent(info) {
    if (!this.daemonId || !this.daemonCreated) return;
    const k = this.daemonKey(this.daemonId, this.daemonCreated);
    const v = { ...agentInfo.get(k), ...info };
    agentInfo.delete(k); // 挪到最后：超过上限时先丢最久没更新的
    agentInfo.set(k, v);
    if (agentInfo.size > 500) agentInfo.delete(agentInfo.keys().next().value);
    // 选择框里显示的信息也记下来 (服务重启后还在)：会话名称、最新一次对话内容、干活的目录 (同项目文件用的)。
    // sid (里面 Agent 正在聊的对话) 也记：重启后选择框还能从主机的会话文件里读到它的标题和最后发送的一条消息 (见 pickDaemon)。
    // 对话 id、名称、目录变了马上写 (很少变)；只有最新一次对话内容 (每句话都变) 最多一分钟写一次 ——
    // 以前四样一起限流，被挡下的那次直接丢了：对话 id 正好在那一分钟里报来就一直没记下，重启后读不到标题
    if (info.name || info.last || info.cwd || info.sid) {
      // 记过的内容放内存里比对：钩子每个事件都带对话 id 和目录，别每次都同步读一遍 tab-names.json
      const e = this.infoSaved?.k === k ? this.infoSaved : (this.infoSaved = { k, ...store.daemonInfo(k) });
      const patch = {};
      if (info.sid && e?.sid !== info.sid) patch.sid = info.sid;
      // 名称只记第一次的兜底名：钩子每来一句话就换一次名字的话，选择框里看到的就是你刚打的最后一句
      // (会话文件读得到标题时 (见 pickDaemon) 本来就用不到它)
      if (info.name && !e?.name) patch.name = info.name;
      if (info.cwd && (e?.cwd || '') !== info.cwd) patch.cwd = info.cwd;
      const msgDue = Date.now() - (this.tabMsgAt || 0) > 60000;
      if (info.last && e?.msg !== info.last && (msgDue || Object.keys(patch).length)) patch.msg = info.last;
      if (patch.msg) this.tabMsgAt = Date.now();
      if (Object.keys(patch).length) { store.saveDaemonInfo(k, patch); Object.assign(e, patch); }
    }
  }

  // 常驻会话现在被哪些别的标签接着：[{ tag, name }]，name 是这台 SSH-WEB 上的标签名，别处 (别的 SSH-WEB、命令行) 接着的是 ''。
  // 自己的标记不算 (自己断网前的旧连接，接上时守护进程会踢掉)；旧版守护进程不报标记，只知道有几个在接着
  daemonUsers(x) {
    if (!Array.isArray(x.tags)) return Array.from({ length: x.clients || 0 }, () => ({ tag: '', name: '' }));
    const { sessions } = require('./index');
    return x.tags.filter((t) => t !== this.id).map((t) => { const s = t && sessions.get(t); return { tag: t, name: s ? s.tabName() : '' }; });
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
    // Linux 上把每个常驻会话里 Agent / 程序的实际目录读出来 (同项目文件面板的找法)，顺手记下来 (重启后还准)
    const liveCwd = await this.daemonCwds(list).catch(() => new Map());
    // 会话里面 Agent 正在聊的对话：从主机的会话文件里读对话的标题和你最后发送的一条消息 (同会话历史的读法，
    // 见 agent-sessions.js 的 claudePeek) —— 比钩子报的准；钩子的名称只是最近一次让它做的事的前几十个字。
    // 报过对话 id 的按 id 找；没报过的 (钩子装之前开的会话) 按它的工作目录找最新的对话文件
    const { claudePeek, claudePeekByCwd } = require('../agent-sessions');
    const savedInfos = store.daemonInfos();
    const sidOf = (x) => { const k = this.daemonKey(x.id, x.created); return agentInfo.get(k)?.sid || savedInfos[k]?.sid || ''; };
    const peek = new Map(); // 常驻会话号 → { title, last }
    const sids = [...new Set(list.map(sidOf).filter(Boolean))];
    // 已经按对话 id 认出来的文件 / 对话，按目录找的时候不能再分给别人
    const knownSids = new Set(), knownFiles = new Set();
    for (const x of list) { const id = sidOf(x); if (id) knownSids.add(id); }
    if (sids.length) {
      const bySid = await claudePeek(this, sids).catch(() => new Map());
      for (const x of list) {
        const v = bySid.get(sidOf(x));
        if (!v) continue;
        peek.set(x.id, v);
        if (v.file) knownFiles.add(v.file);
      }
    }
    const noSid = list.filter((x) => !sidOf(x) && !peek.has(x.id) && x.lastOutput)
      .map((x) => ({ id: String(x.id), cwd: liveCwd.get(x.id)?.a || liveCwd.get(x.id)?.d || x.cwd || '', to: x.lastOutput }))
      .filter((w) => w.cwd);
    if (noSid.length) {
      const byCwd = await claudePeekByCwd(this, noSid, { knownFiles, knownSids }).catch(() => new Map());
      byCwd.forEach((v, k) => peek.set(k, v));
    }
    for (;;) {
      // 记着的会话信息一次读出来：view() 每行都用，而 for(;;) 里删一个会话就整轮重渲染 ——
      // 以前每行都同步读一次文件，10 个会话删 3 次就是 30 次读 + JSON.parse
      const infos = store.daemonInfos();
      const view = (x) => {
        const a = agentInfo.get(this.daemonKey(x.id, x.created));
        const users = this.daemonUsers(x);
        const e = infos[this.daemonKey(x.id, x.created)] || null; // 记着的：命名的后缀、会话名称、最新对话内容、目录
        const lc = liveCwd.get(x.id);
        const pk = peek.get(x.id); // 从会话文件里读的：对话标题、最后发送的一条消息
        const n0 = pk?.title ? `Claude：${pk.title}` : a?.name || e?.name || (CONSOLE_TITLE_RE.test(x.title || '') ? '' : x.title || '');
        const name = n0.startsWith('Claude：') ? `✳ ${n0.slice(7)}` : n0; // Claude 的会话只显示 ✳ 图标，不写「Claude：」
        const last = pk?.last || a?.last || e?.msg || '';
        return { id: x.id,
          tab: e?.title ? `${this.title}-${e.title}` : '', // 命过名：会话自己的「主机名-名字」 (确认框、认会话用，没命过为空)
          tabDef: this.tabName(), // 没命过时胶囊显示接上以后标签默认的「主机名-序号」
          title: CONSOLE_TITLE_RE.test(x.title || '') ? '' : x.title || '', name,
          msg: last && !(name && name.includes(last)) ? last : '', // 最新一次对话内容 (和名称重复就不显示)
          cwd: lc?.a || lc?.d || a?.cwd || e?.cwd || x.cwd || '', // 主机上读到的实际目录 → 钩子报的 → 记的 → 守护进程报的
          when: `${x.lastOutput ? `${before(x.lastOutput)}有输出` : '还没有输出'} · ${before(x.created)}开的`,
          busy: users.length ? this.usersText(users) : '', tags: users.map((u) => u.tag).filter(Boolean) };
      };
      // 没人用的排前面
      const rows = list.map(view);
      // 标题只显示主机名称，不带「-序号」(按用户反馈，见 v1.83.2；v1.83.26 误改成 tabName()，已改回)
      const r = await this.ask('daemon-pick', { note, tab: this.title, ver: this.daemonVer || '', sessions:[...rows.filter((x) => !x.busy), ...rows.filter((x) => x.busy)] });
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
        await ds.request({ op: 'kill', id: x.id }, 'ok'); note = `已结束：${where}`; agentInfo.delete(k); store.delTabName('daemon', k);
        for (const t of tabs) t.terminate();
        if (tabs.length) note += `，关掉了接着它的标签${tabs.map((t) => `「${t.tabName()}」`).join('、')}`;
      } catch (e) { note = `没能结束：${e.message}`; }
      await new Promise((ok) => setTimeout(ok, 300)); // 结束要一会儿
      list = ((await ds.request({ op: 'list' }, 'list')).sessions || []).filter((f) => f.id !== x.id);
    }
  }

}

module.exports = SessionDaemon;
module.exports.DaemonStream = DaemonStream;
module.exports.UNSUPPORTED = UNSUPPORTED;
