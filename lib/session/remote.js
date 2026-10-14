'use strict';
// 会话：借用已连上的 SSH 连接在目标主机上额外做的事：测往返延迟、抓 tmux 历史 (本地快速滚动)。方法挂到 Session 上 (见 index.js)

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
    const MAX = 4 * 1024 * 1024;
    ssh.exec(`sh -c '${script.replace(/'/g, "'\\''")}'`, (err, ch) => {
      if (err) return reply({ ok: false, reason: err.message });
      const chunks = [];
      let len = 0;
      const timer = setTimeout(() => { try { ch.close(); } catch {} }, 3000); // 抓不到就尽快让浏览器回退
      ch.on('data', (d) => { len += d.length; if (len <= MAX) chunks.push(d); });
      ch.stderr.resume();
      ch.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 || !len || len > MAX) {
          return reply({ ok: false, reason: { 3: 'no-tmux', 4: 'busy', 5: 'in-mode' }[code] || 'failed' });
        }
        reply({ ok: true, data: Buffer.concat(chunks).toString('utf8') });
      });
    });
  }
}

module.exports = SessionRemote;
