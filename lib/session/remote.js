'use strict';
// 会话：借用已连上的 SSH 连接在目标主机上额外做的事：测往返延迟、抓 tmux 历史 (本地快速滚动)。方法挂到 Session 上 (见 index.js)

const crypto = require('crypto');

const HIST_MAX = 4 * 1024 * 1024; // 抓到的历史最多这么大
const HIST_IDLE = 10 * 60 * 1000; // 常驻的抓历史通道这么久不用就关掉

class SessionRemote {
  // 测到目标主机的 SSH 往返延迟：和 ssh2 自己的 keepalive 一样发一个 keepalive@openssh.com 全局请求，
  // 等对方回复 (成功 / 失败都算)；回复按发出顺序对应 _callbacks，所以排在队尾即可
  // 由浏览器测网页延迟时顺带触发 (平时 10 秒一次，打开延迟详情时 2 秒一次)，最快 1.5 秒一次
  measureLatency() {
    const ssh = this.ssh;
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

  // 本地快速滚动：在目标主机上抓 tmux 当前 pane 的历史 (带颜色，折行合并)，浏览器在本地滚动查看，不用每滚一格等一个来回。
  // 当前 pane：优先用 LC_SSHWEB 标记找到这个会话里的 tmux 客户端，找不到再选终端大小一样、最近有操作的；没有 tmux 时 exit 3，
  // pane 里是全屏程序时 exit 4、已在复制模式时 exit 5 (浏览器照旧把滚轮发给程序)
  captureTmux(ws, lines) {
    const reply = (obj) => this.sendTo(ws, { type: 'tmux-history', ...obj });
    const ssh = this.ssh;
    if (!ssh || this.status !== 'connected') return reply({ ok: false, reason: 'offline' });
    const n = Math.min(Math.max(parseInt(lines, 10) || 3000, 100), 10000);
    const script = [
      'PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"',
      'command -v tmux >/dev/null 2>&1 || exit 3',
      // 先找环境变量里带 LC_SSHWEB=<这个会话> 的 tmux 客户端 (就是这个标签里启动的那个；Linux 读 /proc/<pid>/environ)
      'p=',
      `for c in $(tmux list-clients -F '#{client_pid}:#{pane_id}' 2>/dev/null); do`,
      `  if tr '\\0' '\\n' < "/proc/\${c%%:*}/environ" 2>/dev/null | grep -qx 'LC_SSHWEB=${this.id}'; then p="\${c#*:}"; break; fi`,
      'done',
      // 找不到 (sshd 不接受 LC_* 环境变量、不是 Linux)：按终端大小一样、最近有操作的客户端猜
      `[ -n "$p" ] || p=$(tmux list-clients -F '#{client_width}x#{client_height} #{client_activity} #{pane_id}' 2>/dev/null | awk '{ print ($1 == "${this.cols}x${this.rows}") ? 1 : 0, $2, $3 }' | sort -k1,1nr -k2,2nr | head -n 1 | cut -d' ' -f3)`,
      '[ -n "$p" ] || exit 3',
      // 已在 tmux 复制模式 (exit 5)、pane 里是 vim / less 等全屏程序 (exit 4)：滚轮交给它们，不抓历史
      `m=$(tmux display -p -t "$p" '#{alternate_on}#{pane_in_mode}')`,
      '[ "${m#?}" = 1 ] && exit 5',
      '[ "$m" = 00 ] || exit 4',
      `exec tmux capture-pane -p -e -J -S -${n} -t "$p"`,
    ].join('\n');
    const done = (code, data) => {
      if (code !== 0 || !data.length) return reply({ ok: false, reason: { 3: 'no-tmux', 4: 'busy', 5: 'in-mode' }[code] || 'failed' });
      reply({ ok: true, data: data.toString('utf8') });
    };
    // 常驻通道用不了 (正在抓别的、开不了、半路断了) 就照旧临时开一个通道执行
    this.histShellRun(ssh, script, (r) => r ? done(r.code, r.data) : this.histExec(ssh, script, reply, done));
  }

  // 临时开一个通道执行抓历史的脚本，执行完就关
  histExec(ssh, script, reply, done) {
    ssh.exec(`sh -c '${script.replace(/'/g, "'\\''")}'`, (err, ch) => {
      if (err) return reply({ ok: false, reason: err.message });
      const chunks = [];
      let len = 0;
      const timer = setTimeout(() => { try { ch.close(); } catch {} }, 3000); // 抓不到就尽快让浏览器回退
      ch.on('data', (d) => { len += d.length; if (len <= HIST_MAX) chunks.push(d); });
      ch.stderr.resume();
      ch.on('close', (code) => {
        clearTimeout(timer);
        done(len > HIST_MAX ? 'big' : code, Buffer.concat(chunks));
      });
    });
  }

  // 常驻的 sh 通道：每次开新通道 (开通道、执行命令各等一个来回) 到远的主机要多等几百毫秒，所以第一次开了就留着，
  // 之后把脚本写进去，脚本跑完打印一行带随机串的结束标记和退出码。一段时间不用、出错、超时就关掉，下次再开
  histShellRun(ssh, script, cb) {
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
      const timer = setTimeout(() => fail('timeout'), 3000); // 抓不到就尽快让浏览器回退
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
