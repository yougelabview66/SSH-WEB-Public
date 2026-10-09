  // ------------------------------------------------------------ tmux 本地快速滚动
  // tmux 开了鼠标时，历史在 tmux 手里，每滚一格都要 tmux 重画整屏再传回来，要等一个来回。
  // 改成：往上滚的第一下，服务端在目标主机上 tmux capture-pane 抓出这个 pane 的历史，
  // 网页盖一层可以原生滚动的历史视图，之后滚动全在本地。Esc / 回到实时画面 / 滚到底再往下 / 打字 退出。
  // 没有 tmux、pane 里是 vim 等全屏程序、分屏或抓到的不是这个画面时，照旧把滚轮交给程序
  const LS_LINES = 3000;

  function localScrollWheel(s, e) {
    if (s.bypassWheel) return true;
    if (s.scrollView) { scrollViewWheel(s, e.deltaY); return false; }
    if (s.scrollLoading) { s.heldWheel += e.deltaY < 0 ? 1 : -1; return false; } // 等结果期间的滚动先记下 (往上为正)
    const b = s.term.buffer.active;
    if (e.deltaY >= 0 || !s.sid || s.term.modes.mouseTrackingMode === 'none' || b.type !== 'alternate') return true;
    if (s.noTmuxUntil > Date.now()) return true;
    s.scrollLoading = true;
    s.heldWheel = 1;
    send(s, { type: 'tmux-history', lines: LS_LINES });
    s.lsTimer = setTimeout(() => onTmuxHistory(s, { ok: false, reason: 'timeout' }), 4000);
    return false;
  }

  // 抓到的历史末尾应该就是现在的画面：拿当前屏幕的文字行去对，对上 6 成以上才算同一个 pane
  function historyMatchesScreen(s, data) {
    const plain = data.replace(ANSI_RE, '').split('\n').slice(-s.term.rows * 3).join('\n');
    const b = s.term.buffer.active;
    let total = 0, hit = 0;
    for (let y = b.viewportY; y < b.viewportY + s.term.rows - 1; y++) { // 最后一行多半是 tmux 状态栏
      const t = b.getLine(y)?.translateToString(true).trim();
      if (!t || t.length < 4) continue;
      total++;
      if (plain.includes(t)) hit++;
    }
    return !total || hit / total >= 0.6;
  }

  function onTmuxHistory(s, m) {
    if (!s.scrollLoading) return;
    s.scrollLoading = false;
    clearTimeout(s.lsTimer);
    if (m.ok && historyMatchesScreen(s, m.data)) return openLocalScroll(s, m.data, Math.max(1, s.heldWheel));
    // 用不了：一段时间内不再尝试，把刚才拦下的滚轮补发给程序 (会进入 tmux 自己的复制模式，不弹提示)
    const reason = m.ok ? 'mismatch' : m.reason;
    s.noTmuxUntil = Date.now() + ({ 'no-tmux': 300000, busy: 5000, 'in-mode': 3000 }[reason] || 30000);
    const target = s.term.element.querySelector('.xterm-screen') || s.term.element;
    const r = target.getBoundingClientRect();
    s.bypassWheel = true;
    for (let i = 0; i < Math.min(Math.abs(s.heldWheel), 8); i++) {
      target.dispatchEvent(new WheelEvent('wheel', {
        deltaY: s.heldWheel > 0 ? -1 : 1, deltaMode: WheelEvent.DOM_DELTA_LINE, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        bubbles: true, cancelable: true,
      }));
    }
    s.bypassWheel = false;
  }

  function openLocalScroll(s, data, up) {
    const theme = termTheme();
    const screen = s.box.querySelector('.xterm-screen');
    const lh = (screen && screen.clientHeight / s.term.rows) || 17;
    const v = document.createElement('div');
    v.className = 'lscroll';
    v.innerHTML = '<button class="ls-close" title="Esc / 滚到最底下再往下 / 打字 也可以返回">回到实时画面 ✕</button><pre class="ls-body" tabindex="-1"></pre>';
    const pre = v.querySelector('.ls-body');
    Object.assign(pre.style, {
      fontFamily: s.term.options.fontFamily, fontSize: s.term.options.fontSize + 'px', lineHeight: lh + 'px',
      color: theme.foreground, background: theme.background,
    });
    pre.innerHTML = ansiToHtml(data.replace(/\n+$/, ''), theme);
    s.box.appendChild(v);
    s.scrollView = v;
    s.lsLine = lh;
    syncLsBars();
    pre.scrollTop = pre.scrollHeight - pre.clientHeight - up * 3 * lh; // 和滚轮一样往回看几行
    pre.focus({ preventScroll: true }); // 输入框藏起来了，焦点放这里：PageUp / PageDown / Home / 方向键直接滚历史
    v.querySelector('.ls-close').addEventListener('click', () => closeLocalScroll(s));
    // 电脑：在最底下还往下滚 = 回到实时画面
    pre.addEventListener('wheel', (e) => {
      if (e.deltaY > 0 && atBottom(pre)) { e.preventDefault(); closeLocalScroll(s); }
    }, { passive: false });
    // 电脑：选中文字松开鼠标就自动复制 (同终端里 tmux 开鼠标后的选中即复制)
    pre.addEventListener('mouseup', (e) => {
      if (e.button !== 0) return;
      setTimeout(async () => { // 等浏览器把选区定下来 (双击选词、三击选行)
        const sel = getSelection();
        if (!sel?.rangeCount || sel.isCollapsed || !pre.contains(sel.anchorNode) || !pre.contains(sel.focusNode)) return;
        const text = sel.toString();
        if (!text.trim()) return;
        const range = sel.getRangeAt(0).cloneRange();
        const ok = await copyText(text);
        // HTTP 下借用临时文本框复制会把选区清掉：选回来，还能接着按 Ctrl+C
        if (!sel.rangeCount || sel.isCollapsed) { sel.removeAllRanges(); sel.addRange(range); }
        fontToast(s, ok ? `已复制 ${text.length} 个字符` : '复制失败，请按 Ctrl+C 复制', 1200, v);
      });
    });
    // 手机：已经在最底下时再往上推 = 回到实时画面
    let startY = 0, startBottom = false;
    pre.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; startBottom = atBottom(pre); }, { passive: true });
    pre.addEventListener('touchend', (e) => {
      const dy = (e.changedTouches[0]?.clientY ?? startY) - startY;
      if (startBottom && dy < -40) closeLocalScroll(s);
    });
  }

  // 历史视图打开时把输入栏 (电脑输入框 / 手机输入栏) 藏起来，多出来的地方给历史视图
  function syncLsBars() {
    $('#app').classList.toggle('ls-open', !!active?.scrollView);
  }

  const atBottom = (el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2;

  // 手指一开始是在终端上滑的，这一次滑动剩下的滚轮事件继续滚历史视图
  function scrollViewWheel(s, deltaY) {
    const pre = s.scrollView.querySelector('.ls-body');
    if (deltaY > 0 && atBottom(pre)) return closeLocalScroll(s);
    pre.scrollTop += Math.sign(deltaY) * 3 * s.lsLine;
  }

  function closeLocalScroll(s) {
    if (!s.scrollView) return;
    s.scrollView.remove();
    s.scrollView = null;
    syncLsBars();
    if (s === active) focusTerm(s);
  }

  // 历史视图打开时 Esc 只用来返回，不发给终端 (免得打断 Claude Code)
  window.addEventListener('keydown', (e) => {
    if (!active?.scrollView || document.querySelector('.overlay:not(.hidden)')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeLocalScroll(active);
      return;
    }
    // Ctrl+End / End = 回到实时画面 (以前只把历史视图滚到底，还要再往下滚一下才回去)；已经在最底下再按 PageDown 也是，同滚轮
    const inInput = e.target.closest?.('input, textarea, [contenteditable]');
    const pre = active.scrollView.querySelector('.ls-body');
    if ((e.key === 'End' && !e.shiftKey && (e.ctrlKey || !inInput)) || (e.key === 'PageDown' && !inInput && atBottom(pre))) {
      e.preventDefault();
      e.stopPropagation();
      closeLocalScroll(active);
      return;
    }
    // 输入框藏起来了，焦点不在任何输入框上时直接打字：回到实时画面，焦点回到输入框，这个字照常打进去
    const typing = !e.ctrlKey && !e.metaKey && !e.altKey && (e.key.length === 1 || e.key === 'Enter' || e.key === 'Backspace');
    if (typing && !inInput) closeLocalScroll(active);
  }, true);

  // tmux capture-pane -e 的颜色 (SGR) 转成 HTML；其他控制序列丢掉
  const ANSI_RE = /\x1b\[[0-9;:?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b./g;
  const XTERM_ANSI = ['#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
    '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec'];
  const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed',
    'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];

  function palette256(theme) {
    const p = ANSI_NAMES.map((n, i) => theme[n] || XTERM_ANSI[i]);
    const v = [0, 95, 135, 175, 215, 255];
    for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) p.push(`rgb(${v[r]},${v[g]},${v[b]})`);
    for (let i = 0; i < 24; i++) { const c = 8 + i * 10; p.push(`rgb(${c},${c},${c})`); }
    return p;
  }

  function ansiToHtml(text, theme) {
    const pal = palette256(theme);
    let fg = null, bg = null, fgIdx = -1, bold = false, dim = false, it = false, ul = false, inv = false, st = false;
    let out = '', last = 0, m;
    const css = () => {
      let f = fg, b = bg;
      if (bold && fgIdx >= 0 && fgIdx < 8) f = pal[fgIdx + 8]; // 同 xterm：粗体用亮色
      if (inv) { const t = f; f = b || theme.background; b = t || theme.foreground; }
      let c = '';
      if (f) c += `color:${f};`;
      if (b) c += `background:${b};`;
      if (bold) c += 'font-weight:bold;';
      if (dim) c += 'opacity:.6;';
      if (it) c += 'font-style:italic;';
      if (ul || st) c += `text-decoration:${ul ? 'underline' : ''} ${st ? 'line-through' : ''};`;
      return c;
    };
    const put = (t) => {
      if (!t) return;
      const c = css();
      out += c ? `<span style="${c}">${esc(t)}</span>` : esc(t);
    };
    ANSI_RE.lastIndex = 0;
    while ((m = ANSI_RE.exec(text))) {
      put(text.slice(last, m.index));
      last = ANSI_RE.lastIndex;
      const seq = m[0];
      if (!seq.endsWith('m') || seq[1] !== '[') continue;
      const ps = (seq.slice(2, -1) || '0').split(/[;:]/).map((x) => parseInt(x, 10) || 0);
      for (let i = 0; i < ps.length; i++) {
        const c = ps[i];
        if (c === 0) { fg = bg = null; fgIdx = -1; bold = dim = it = ul = inv = st = false; }
        else if (c === 1) bold = true;
        else if (c === 2) dim = true;
        else if (c === 3) it = true;
        else if (c === 4) ul = true;
        else if (c === 7) inv = true;
        else if (c === 9) st = true;
        else if (c === 22) bold = dim = false;
        else if (c === 23) it = false;
        else if (c === 24) ul = false;
        else if (c === 27) inv = false;
        else if (c === 29) st = false;
        else if (c >= 30 && c <= 37) { fg = pal[c - 30]; fgIdx = c - 30; }
        else if (c === 39) { fg = null; fgIdx = -1; }
        else if (c >= 40 && c <= 47) bg = pal[c - 40];
        else if (c === 49) bg = null;
        else if (c >= 90 && c <= 97) { fg = pal[c - 82]; fgIdx = -1; }
        else if (c >= 100 && c <= 107) bg = pal[c - 92];
        else if (c === 38 || c === 48) {
          let col = null;
          if (ps[i + 1] === 5) { col = pal[ps[i + 2]] || null; i += 2; }
          else if (ps[i + 1] === 2) { col = `rgb(${ps[i + 2]},${ps[i + 3]},${ps[i + 4]})`; i += 4; }
          if (c === 38) { fg = col; fgIdx = -1; } else bg = col;
        }
      }
    }
    put(text.slice(last));
    return out;
  }
