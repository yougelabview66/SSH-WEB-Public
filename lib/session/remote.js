'use strict';
// 会话：借用已连上的 SSH 连接在目标主机上额外做的事：测往返延迟、抓 tmux 历史 (本地快速滚动)。方法挂到 Session 上 (见 index.js)

const crypto = require('crypto');

const HIST_MAX = 4 * 1024 * 1024; // 抓到的历史最多这么大
const HIST_IDLE = 30 * 60 * 1000; // 常驻的抓历史通道这么久不用就关掉 (关了下次要重开，慢的主机第一次又要等好几秒)

// 无界面终端的一行 → 带 SGR 颜色的文字 (末尾的空白去掉)
const colorSgr = (palette, rgb, deflt, v, base, bright) => (deflt ? '' : rgb ? `;${base + 8};2;${v >> 16 & 255};${v >> 8 & 255};${v & 255}`
  : palette ? (v < 8 ? `;${base + v}` : v < 16 ? `;${bright + v - 8}` : `;${base + 8};5;${v}`) : '');
function cellSgr(c) {
  return (c.isBold() ? ';1' : '') + (c.isDim() ? ';2' : '') + (c.isItalic() ? ';3' : '') + (c.isUnderline() ? ';4' : '') + (c.isInverse() ? ';7' : '')
    + colorSgr(c.isFgPalette(), c.isFgRGB(), c.isFgDefault(), c.getFgColor(), 30, 90)
    + colorSgr(c.isBgPalette(), c.isBgRGB(), c.isBgDefault(), c.getBgColor(), 40, 100);
}
function lineToAnsi(line, cell) {
  let end = line.length;
  for (; end > 0; end--) { // 末尾没有字、也没有背景色的格子不要
    line.getCell(end - 1, cell);
    if ((cell.getChars() && cell.getChars() !== ' ') || !cell.isBgDefault()) break;
  }
  let out = '', prev = '';
  for (let x = 0; x < end; x++) {
    line.getCell(x, cell);
    if (!cell.getWidth()) continue; // 宽字的后半格
    const sgr = cellSgr(cell);
    if (sgr !== prev) { out += `\x1b[0${sgr}m`; prev = sgr; }
    out += cell.getChars() || ' ';
  }
  return prev ? out + '\x1b[0m' : out;
}

class SessionRemote {
  // 测到目标主机的 SSH 往返延迟：和 ssh2 自己的 keepalive 一样发一个 keepalive@openssh.com 全局请求，
  // 等对方回复 (成功 / 失败都算)；回复按发出顺序对应 _callbacks，所以排在队尾即可
  // 由浏览器测网页延迟时顺带触发 (平时 10 秒一次，打开延迟详情时 2 秒一次)，最快 1.5 秒一次
  measureLatency() {
    const ssh = this.ssh;
    // 上一次测的过了 10 秒还没回：SSH 已经不通了 (网络断过，心跳还没发现)
    if (ssh && this.status === 'connected' && this.latPending && Date.now() - (this.latAt || 0) > 10000) { this.latPending = false; return this.sshDead(); }
    if (!ssh || this.status !== 'connected' || !this.clients.size || this.latPending) return;
    if (Date.now() - (this.latAt || 0) < 1500) return;
    this.latAt = Date.now();
    if (!ssh._protocol || !Array.isArray(ssh._callbacks)) return;
    this.latPending = true;
    const t0 = performance.now();
    try {
      ssh._callbacks.push(() => {
        if (this.ssh !== ssh) return;
        this.latPending = false;
        this.sshRtt = Math.round(performance.now() - t0);
        this.broadcast({ type: 'lat', ssh: this.sshRtt });
      });
      ssh._protocol.ping();
    } catch {
      this.latPending = false;
    }
  }

  // SSH 还通不通：同 measureLatency 发一个 keepalive，ms 内没回复就当断了 (见 ssh.js 的 sshDead)。
  // 判据是「等的这段时间里一点终端输出都没有」：主机忙、隧道卡、通道里排着大量输出时回复会晚到，
  // 只要还有输出就说明连接活着，不判死 (普通会话断开会把里面的 Claude Code 一起结束，
  // 宁可交给 ssh2 自己的心跳 (30 ~ 40 秒) 去发现)
  probeSsh(ms = 8000) {
    const ssh = this.ssh;
    if (!ssh || this.status !== 'connected' || this.probing || !ssh._protocol || !Array.isArray(ssh._callbacks)) return;
    this.probing = true;
    const sent = Date.now();
    const timer = setTimeout(() => {
      this.probing = false;
      if (this.ssh !== ssh || (this.outAt || 0) > sent) return;
      // 普通会话断了终端就没了：只有常驻会话 (断了会自动接回去) 才马上断开重连
      if (this.daemonId) this.sshDead();
    }, ms);
    try {
      ssh._callbacks.push(() => { clearTimeout(timer); this.probing = false; });
      ssh._protocol.ping();
    } catch {
      clearTimeout(timer);
      this.probing = false;
    }
  }

  // 服务器上这个终端自己的历史 (最近 n 行，带颜色，折行合并)，格式同 tmux capture-pane -p -e -J。
  // 全屏程序 (备用屏幕) 时不抓，滚轮交给程序 (同 tmux 的 exit 4)
  localHistory(n) {
    const t = this.term;
    if (t.buffer.active.type === 'alternate') return { ok: false, reason: 'busy' };
    const b = t.buffer.normal, cell = b.getNullCell(), out = [];
    for (let y = Math.max(0, b.length - n); y < b.length; y++) {
      const line = b.getLine(y);
      if (!line) continue;
      const text = lineToAnsi(line, cell);
      if (line.isWrapped && out.length) out[out.length - 1] += text; else out.push(text);
    }
    while (out.length && !out[out.length - 1]) out.pop();
    return { ok: true, data: out.join('\n') + '\n' };
  }

  // 本地快速滚动：在目标主机上抓 tmux 当前 pane 的历史 (带颜色，折行合并)，浏览器在本地滚动查看，不用每滚一格等一个来回。
  // 当前 pane：优先用标记 (LC_SSHWEB；常驻会话里是 SSHWEBD_SESSION，见 tabMarker) 找到这个会话里的 tmux 客户端，
  // 找不到再选终端大小一样、最近有操作的 (常驻会话里不猜，免得猜到别的会话的 tmux)；没有 tmux 时 exit 3，
  // pane 里是全屏程序时 exit 4、已在复制模式时 exit 5 (浏览器照旧把滚轮发给程序)。
  // 常驻会话：Windows 上没有 tmux，历史就是服务器上这个终端自己的记录；Linux 上里面开着 tmux 就用 tmux 的，没开 (exit 3) 用自己的记录
  captureTmux(ws, lines) {
    const reply = (obj) => this.sendTo(ws, { type: 'tmux-history', ...obj });
    const ssh = this.ssh;
    if (!ssh || this.status !== 'connected') return reply({ ok: false, reason: 'offline' });
    const n = Math.min(Math.max(parseInt(lines, 10) || 3000, 100), 10000);
    if (this.daemonId && this.daemonOs !== 'linux') return reply(this.localHistory(n));
    const script = [
      'PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"',
      'command -v tmux >/dev/null 2>&1 || exit 3',
      // 先找环境变量里带标记的 tmux 客户端 (就是这个标签 / 常驻会话里启动的那个；Linux 读 /proc/<pid>/environ)
      'p=',
      `for c in $(tmux list-clients -F '#{client_pid}:#{pane_id}' 2>/dev/null); do`,
      `  if ${this.markerTest('"/proc/${c%%:*}/environ"')}; then p="\${c#*:}"; break; fi`,
      'done',
      // 找不到 (sshd 不接受 LC_* 环境变量、不是 Linux)：按终端大小一样、最近有操作的客户端猜 (常驻会话里不猜)
      ...(this.daemonId ? [] : [`[ -n "$p" ] || p=$(tmux list-clients -F '#{client_width}x#{client_height} #{client_activity} #{pane_id}' 2>/dev/null | awk '{ print ($1 == "${this.cols}x${this.rows}") ? 1 : 0, $2, $3 }' | sort -k1,1nr -k2,2nr | head -n 1 | cut -d' ' -f3)`]),
      '[ -n "$p" ] || exit 3',
      // 已在 tmux 复制模式 (exit 5)、pane 里是 vim / less 等全屏程序 (exit 4)：滚轮交给它们，不抓历史
      `m=$(tmux display -p -t "$p" '#{alternate_on}#{pane_in_mode}')`,
      '[ "${m#?}" = 1 ] && exit 5',
      '[ "$m" = 00 ] || exit 4',
      // -J：把终端里折行的行拼回一整条。历史视图里那些「表格错位」其实是终端在窄窗口下画过一遍、
      // 内容被折成几行留在滚动缓冲里，去掉 -J 也改变不了它们本来就是独立行的事实，反而让真正折行的
      // 长命令读起来更碎。所以保留 -J
      `exec tmux capture-pane -p -e -J -S -${n} -t "$p"`,
    ].join('\n');
    const done = (code, data) => {
      if (code === 0 && data.length) return reply({ ok: true, data: data.toString('utf8') });
      if (code === 3 && this.daemonId) return reply(this.localHistory(n)); // 常驻会话里没开 tmux：用自己的记录
      // 超时如实报：慢的主机 (NAS 进程多、开通道慢) 第一次抓历史要好几秒，以前报成 failed，看着像没原因
      reply({ ok: false, reason: { 3: 'no-tmux', 4: 'busy', 5: 'in-mode', timeout: 'timeout' }[code] || 'failed' });
    };
    // Windows 主机 (SSH 默认的 shell 是 cmd / PowerShell)：不用 tmux / psmux，没开常驻会话就没有历史可取 (滚轮交给终端自己)
    this.shellBase(ssh).then((base) => {
      if (base !== 'sh') return reply({ ok: false, reason: 'no-tmux', win: true });
      // 常驻通道用不了 (正在抓别的、开不了、半路断了) 就照旧临时开一个通道执行。
      // 多等一会儿 (慢的 NAS 第一次开通道、扫 /proc 要好几秒；通道开了会留着复用，之后不用再等)
      this.histShellRun(ssh, script, (r) => r ? done(r.code, r.data) : this.histExec(ssh, script, reply, done, 10000), 10000);
    });
  }

  // 终端里是哪种 shell (决定「终端 cd」的写法)：sh / cmd / powershell。
  // SSH 默认的 shell 用一句话分辨 (echo %OS%;$env:OS —— cmd 原样打出 $env:OS，PowerShell 打出 %OS% 和 Windows_NT，sh 只有 %OS%)，按连接记住；
  // Windows 上终端里可能又换了 shell：看屏幕上光标那一行的提示符 (SSH 默认 cmd，终端里开了 PowerShell)；
  // 常驻会话 (Windows) (sshwebd) 默认开的是 PowerShell
  async termShell() {
    const ssh = this.ssh;
    if (!ssh || this.status !== 'connected') return 'sh';
    const base = await this.shellBase(ssh);
    if (base === 'sh') return base;
    return this.promptShell() || (this.daemonId ? 'powershell' : base);
  }

  // SSH 默认的 shell (单独开通道执行命令时用的)：sh / cmd / powershell，按连接记住
  // 没回话 (Windows 上 PowerShell 冷启动、Defender 扫描、隧道慢，几秒都有可能)：多等一会儿再试一次，
  // 还是没回话就按 sh 处理但不记住 (下次再问)，免得把 Windows 主机当成 Linux 一直记着。
  // 同时问的 (连上时监控、钩子、常驻会话一起问) 共用一次
  shellBase(ssh) {
    if (this.shellOf?.ssh === ssh) return Promise.resolve(this.shellOf.base);
    if (this.shellAsk?.ssh === ssh) return this.shellAsk.p;
    const ask = (ms) => new Promise((resolve) => this.rawExec(ssh, 'echo %OS%;$env:OS', resolve, ms));
    const p = (async () => {
      for (const ms of [8000, 15000]) {
        const { out } = await ask(ms);
        const o = String(out || '').trim();
        if (!o) continue;
        const base = /^Windows_NT;\$env:OS/.test(o) ? 'cmd' : /^%OS%\s+Windows_NT/.test(o) ? 'powershell' : 'sh';
        if (this.ssh === ssh) { this.shellOf = { ssh, base }; this.shellUnknown = false; }
        return base;
      }
      if (this.ssh === ssh) this.shellUnknown = true; // 没认出来 (见 daemon.js 的 noteHostOs：不改记着的系统)
      return 'sh';
    })();
    this.shellAsk = { ssh, p };
    p.finally(() => { if (this.shellAsk?.p === p) this.shellAsk = null; });
    return p;
  }

  // 终端屏幕上光标那一行的提示符：「PS D:\xx>」= PowerShell，「D:\xx>」= cmd；看不出来返回 null
  promptShell() {
    const b = this.term?.buffer?.active;
    const line = b && b.getLine(b.baseY + b.cursorY)?.translateToString(true).trim();
    if (!line) return null;
    if (/^PS [A-Za-z]:\\[^>]*>/.test(line)) return 'powershell';
    if (/^[A-Za-z]:\\[^>]*>/.test(line)) return 'cmd';
    return null;
  }

  // 临时开一个通道执行一条命令 (不经过 sh，Windows 上由 cmd 执行)：cb({ code, out })，ms 毫秒还没完就关掉。
  // 连接中也行 (常驻会话要先看是不是 Windows 主机，见 daemon.js)
  rawExec(ssh, cmd, cb, ms = 3000) {
    if (this.ssh !== ssh || (this.status !== 'connected' && this.status !== 'connecting')) return cb({ code: -1, out: '' });
    ssh.exec(cmd, (err, ch) => {
      if (err) return cb({ code: -1, out: '' });
      const chunks = [];
      let len = 0, code = -1;
      const timer = setTimeout(() => { try { ch.close(); } catch {} }, ms);
      ch.on('data', (d) => { len += d.length; if (len <= HIST_MAX) chunks.push(d); });
      ch.stderr.resume();
      ch.on('exit', (c) => { code = c; });
      ch.on('close', () => { clearTimeout(timer); cb({ code: len > HIST_MAX ? -1 : code, out: Buffer.concat(chunks).toString('utf8') }); });
    });
  }

  // 在目标主机上执行一段脚本：cb({ code, data })，连不上 / 开不了通道时 cb(null)。优先借用常驻通道 (见 histShellRun)
  runScript(script, cb) {
    const ssh = this.ssh;
    if (!ssh || this.status !== 'connected') return cb(null);
    this.histShellRun(ssh, script, (r) => (r ? cb(r) : this.histExec(ssh, script, () => cb(null), (code, data) => cb({ code, data }))));
  }

  // 临时开一个通道执行抓历史的脚本，执行完就关
  histExec(ssh, script, reply, done, ms = 3000) {
    ssh.exec(`sh -c '${script.replace(/'/g, "'\\''")}'`, (err, ch) => {
      if (err) return reply({ ok: false, reason: err.message });
      const chunks = [];
      let len = 0;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { ch.close(); } catch {} }, ms); // 抓不到就尽快让浏览器回退 (慢主机上多等一会儿)
      ch.on('data', (d) => { len += d.length; if (len <= HIST_MAX) chunks.push(d); });
      ch.stderr.resume();
      ch.on('close', (code) => {
        clearTimeout(timer);
        done(timedOut ? 'timeout' : len > HIST_MAX ? 'big' : code, Buffer.concat(chunks));
      });
    });
  }

  // 常驻的 sh 通道：每次开新通道 (开通道、执行命令各等一个来回) 到远的主机要多等几百毫秒，所以第一次开了就留着，
  // 之后把脚本写进去，脚本跑完打印一行带随机串的结束标记和退出码。一段时间不用、出错、超时就关掉，下次再开
  histShellRun(ssh, script, cb, ms = 3000) {
    if (this.histBusy || this.histNoShell === ssh) return cb(null);
    this.histBusy = true;
    const finish = (r) => { this.histBusy = false; cb(r); };
    const run = (ch) => {
      const mark = Buffer.from(`\n__SSHWEB_${crypto.randomBytes(8).toString('hex')}__ `);
      const chunks = [];
      let len = 0, tail = Buffer.alloc(0);
      const end = (r, keep) => {
        clearTimeout(timer);
        ch.removeListener('data', onData);
        ch.removeListener('close', onClose);
        if (keep) this.histIdle(ch);
        else this.histClose(ch);
        finish(r);
      };
      const fail = (code) => end({ code, data: Buffer.alloc(0) });
      const onData = (d) => {
        len += d.length;
        if (len > HIST_MAX) return fail('big');
        chunks.push(d);
        // 结束标记在最后：只在上一块的末尾 + 这一块里找
        const t = Buffer.concat([tail, d]);
        const i = t.indexOf(mark);
        if (i < 0 || t.indexOf(10, i + mark.length) < 0) { tail = t.subarray(Math.max(0, t.length - mark.length - 8)); return; }
        const all = Buffer.concat(chunks), at = all.lastIndexOf(mark);
        end({ code: parseInt(all.subarray(at + mark.length).toString(), 10), data: all.subarray(0, at) }, true);
      };
      const onClose = () => end(null); // 半路断了：这次改用临时通道
      const timer = setTimeout(() => fail('timeout'), ms); // 抓不到就尽快让浏览器回退 (慢主机上多等一会儿，同 histExec)
      ch.on('data', onData);
      ch.on('close', onClose);
      clearTimeout(ch.idleTimer);
      // 脚本整个放进子 shell (里面的 exit / exec 不影响常驻的 sh)，不读常驻通道的输入
      ch.write(`(\n${script}\n) </dev/null 2>/dev/null; printf '\\n%s %s\\n' '${mark.toString().trim()}' "$?"\n`);
    };
    if (this.histCh && this.histSsh === ssh) return run(this.histCh);
    this.histClose(this.histCh);
    ssh.exec('sh', (err, ch) => {
      if (err || this.ssh !== ssh) { // 开不了 (比如限制了通道数)：这个连接以后都用临时通道
        if (err) this.histNoShell = ssh;
        try { ch && ch.close(); } catch {}
        return finish(null);
      }
      this.histCh = ch;
      this.histSsh = ssh;
      ch.stderr.resume();
      ch.on('close', () => { if (this.histCh === ch) this.histCh = null; clearTimeout(ch.idleTimer); });
      run(ch);
    });
  }

  histIdle(ch) {
    clearTimeout(ch.idleTimer);
    ch.idleTimer = setTimeout(() => this.histClose(ch), HIST_IDLE);
  }

  histClose(ch) {
    if (!ch) return;
    clearTimeout(ch.idleTimer);
    if (this.histCh === ch) this.histCh = null;
    try { ch.close(); } catch {}
  }
}

module.exports = SessionRemote;
