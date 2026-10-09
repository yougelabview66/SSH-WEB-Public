  // ------------------------------------------------------------ 触屏滑动滚动
  // xterm.js 6 不支持触摸滚动，手指滑动会被浏览器当成下拉刷新。这里自己处理，行为与电脑滚轮一致：
  // - 程序开启了鼠标追踪 (Claude Code、tmux、htop、vim mouse=a 等)：发送鼠标滚轮事件，由程序自己滚动
  // - 普通界面：滚动终端的历史记录 (带惯性)
  // - 不支持鼠标的全屏程序：不发送任何按键，避免误触发 (比如方向键会调出历史输入)
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
    v.innerHTML = '<button class="ls-close" title="Esc / 滚到最底下再往下 / 打字 也可以返回">回到实时画面 ✕</button><pre class="ls-body"></pre>';
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
    v.querySelector('.ls-close').addEventListener('click', () => closeLocalScroll(s));
    // 电脑：在最底下还往下滚 = 回到实时画面
    pre.addEventListener('wheel', (e) => {
      if (e.deltaY > 0 && atBottom(pre)) { e.preventDefault(); closeLocalScroll(s); }
    }, { passive: false });
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

  // 用不了本地滚动时滚轮交给 tmux，进入 tmux 自己的复制模式 (pane 右上角有 [5/300] 这样的位置标记)：
  // 同样显示「回到实时画面」，点了发 q 退出复制模式
  function tmuxInCopyMode(s) {
    const b = s.term.buffer.active;
    if (b.type !== 'alternate' || s.scrollView) return false;
    return /\[\d+\/\d+\]\s*$/.test(b.getLine(b.viewportY)?.translateToString(true) || '');
  }
  // Claude Code 全屏模式 (/tui fullscreen) 自己接管滚轮，往上翻时输入框上方显示
  // 「Jump to bottom (ctrl+end) ↓」/「3 new messages (ctrl+end) ↓」：同样显示「回到实时画面」，点了发 Ctrl+End
  const CC_PILL = /(^|\s)(Jump to bottom|\d+ new messages?)(( \([^)]*\))? ↓|: \S.{0,24} to scroll)(\s|$)/;
  function claudeScrolledUp(s) {
    const b = s.term.buffer.active;
    if (b.type !== 'alternate' || s.scrollView) return false;
    for (let y = b.viewportY + s.term.rows - 1; y >= b.viewportY; y--) { // 提示在下半部分，从下往上找
      if (CC_PILL.test(b.getLine(y)?.translateToString(true) || '')) return true;
    }
    return false;
  }
  const EXIT_KEYS = { tmux: ['q', '退出 tmux 复制模式 (发送 q)'], claude: ['\x1b[1;5F', '回到 Claude Code 最新的对话 (发送 Ctrl+End)'] };
  function updateCopyModeBtn(s) {
    const mode = !s.sid ? null : tmuxInCopyMode(s) ? 'tmux' : claudeScrolledUp(s) ? 'claude' : null;
    if (mode && !s.copyBtn) {
      s.copyBtn = document.createElement('button');
      s.copyBtn.className = 'ls-close tmux-exit';
      s.copyBtn.textContent = '回到实时画面 ✕';
      s.copyBtn.addEventListener('mousedown', (e) => e.preventDefault());
      s.copyBtn.addEventListener('click', () => { send(s, { type: 'data', data: EXIT_KEYS[s.copyBtn.dataset.mode][0] }); focusTerm(s); });
      s.box.appendChild(s.copyBtn);
    }
    if (!s.copyBtn) return;
    s.copyBtn.classList.toggle('hidden', !mode);
    if (mode && s.copyBtn.dataset.mode !== mode) { s.copyBtn.dataset.mode = mode; s.copyBtn.title = EXIT_KEYS[mode][1]; }
  }
  setInterval(() => { if (active) updateCopyModeBtn(active); }, 300);

  // 历史视图打开时 Esc 只用来返回，不发给终端 (免得打断 Claude Code)
  window.addEventListener('keydown', (e) => {
    if (!active?.scrollView || document.querySelector('.overlay:not(.hidden)')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeLocalScroll(active);
      return;
    }
    // 输入框藏起来了，焦点不在任何输入框上时直接打字：回到实时画面，焦点回到输入框，这个字照常打进去
    const typing = !e.ctrlKey && !e.metaKey && !e.altKey && (e.key.length === 1 || e.key === 'Enter' || e.key === 'Backspace');
    if (typing && !e.target.closest?.('input, textarea, [contenteditable]')) closeLocalScroll(active);
  }, true);

  // Ctrl+End = 回到实时画面 (终端软件、Claude Code 都是这个习惯)，焦点在哪里都一样：
  // 历史视图 → 关掉；终端往上翻着 → 滚到最底下 (不发给程序)；tmux 复制模式 → 发 q 退出；
  // Claude Code 往上翻着 → 发 Ctrl+End (输入框里有字时，浏览器会拿它把输入框光标移到最后，发不出去)。
  // 都不是时照常：空输入框 / 终端里按 = 发给程序，有字的输入框里 = 光标移到最后
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'End' || !e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
    const s = active;
    if (!s || tmuxPrefix || document.querySelector('.overlay:not(.hidden)')) return;
    const b = s.term.buffer.active;
    let act;
    if (s.scrollView) act = () => closeLocalScroll(s);
    else if (b.viewportY < b.baseY) act = () => s.term.scrollToBottom();
    else if (s.sid && tmuxInCopyMode(s)) act = () => send(s, { type: 'data', data: EXIT_KEYS.tmux[0] });
    else if (s.sid && claudeScrolledUp(s)) act = () => send(s, { type: 'data', data: EXIT_KEYS.claude[0] });
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    act();
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

  function enableTouchScroll(s) {
    const WHEEL_LINES = 3; // 手指移动 3 行发送一次滚轮 (同普通鼠标滚轮)
    const WHEEL_GAP = 35;  // 两次滚轮事件最小间隔 ms，给远端 (tmux 等) 重绘留时间
    const WHEEL_MAX_QUEUE = 4;
    let lastY = null;
    let lastX = 0;
    let lastT = 0;
    let vel = 0;      // px/ms
    let acc = 0;      // 还没换算成行 / 滚轮的累计像素
    let pendingPx = 0; // 本帧待处理的滑动距离 (合并同一帧内的多次 touchmove)
    let frame = 0;
    let lh = 17;
    let wheelQueue = 0; // 待发送的滚轮次数，正数 = 往回看
    let wheelTimer = 0;
    let lastWheelAt = 0;

    const measure = () => {
      const screen = s.box.querySelector('.xterm-screen');
      lh = (screen && s.term.rows && screen.clientHeight / s.term.rows) || 17;
    };
    const wheelMode = () => s.term.modes.mouseTrackingMode !== 'none';

    // 交给 xterm 按滚轮处理，它会按程序要求的鼠标协议 (SGR 等) 编码发送
    const sendWheel = (dir) => {
      const target = s.term.element.querySelector('.xterm-screen') || s.term.element;
      const r = target.getBoundingClientRect();
      target.dispatchEvent(new WheelEvent('wheel', {
        deltaY: dir > 0 ? -1 : 1, deltaMode: WheelEvent.DOM_DELTA_LINE,
        clientX: Math.min(Math.max(lastX, r.left + 1), r.right - 1), clientY: r.top + r.height / 2,
        bubbles: true, cancelable: true,
      }));
    };

    // 按固定间隔匀速发送，避免一次甩动瞬间发出几十个事件导致远端重绘堆积、画面一顿一顿
    const pumpWheel = () => {
      wheelTimer = 0;
      if (!wheelQueue) return;
      const wait = WHEEL_GAP - (performance.now() - lastWheelAt);
      if (wait > 0) { wheelTimer = setTimeout(pumpWheel, wait); return; }
      const dir = Math.sign(wheelQueue);
      sendWheel(dir);
      wheelQueue -= dir;
      lastWheelAt = performance.now();
      if (wheelQueue) wheelTimer = setTimeout(pumpWheel, WHEEL_GAP);
    };

    const queueWheel = (n) => {
      if (Math.sign(n) !== Math.sign(wheelQueue)) wheelQueue = 0; // 反向时丢弃旧方向
      wheelQueue = Math.max(-WHEEL_MAX_QUEUE, Math.min(WHEEL_MAX_QUEUE, wheelQueue + n));
      if (!wheelTimer) pumpWheel();
    };

    // dy > 0: 手指下滑 = 往回看
    const scrollPx = (dy) => {
      if (Math.sign(dy) !== Math.sign(acc)) acc = 0;
      acc += dy;
      if (wheelMode()) {
        const unit = lh * WHEEL_LINES;
        const n = Math.trunc(acc / unit);
        if (n) { acc -= n * unit; queueWheel(n); }
        return;
      }
      const lines = Math.trunc(acc / lh);
      if (!lines) return;
      acc -= lines * lh;
      if (s.term.buffer.active.type === 'normal') s.term.scrollLines(-lines);
      else showScrollHint(s);
    };

    // 同一帧内的多次 touchmove 合并处理 (高刷新率手机上 touchmove 比屏幕刷新还频繁)
    const flush = () => {
      frame = 0;
      const dy = pendingPx;
      pendingPx = 0;
      if (dy) scrollPx(dy);
    };

    // 惯性：按时间衰减 (与刷新率无关)；tmux 等远端滚动衰减更快，松手后不会一直漂
    let lastFrameT = 0;
    const momentum = (t) => {
      const dt = Math.min(t - lastFrameT, 50);
      lastFrameT = t;
      if (Math.abs(vel) < 0.04) return;
      scrollPx(vel * dt);
      vel *= Math.pow(wheelMode() ? 0.88 : 0.95, dt / 16);
      frame = requestAnimationFrame(momentum);
    };

    // 长按 (不移动) 打开复制面板
    let pressTimer = 0;
    let pressX = 0;
    let pressY = 0;
    const cancelPress = () => { clearTimeout(pressTimer); pressTimer = 0; };
    s.box.addEventListener('touchstart', (e) => {
      cancelPress();
      s.longPressed = false;
      if (e.touches.length === 1 && !e.target.closest('button, .scroll-hint')) {
        pressX = e.touches[0].clientX;
        pressY = e.touches[0].clientY;
        pressTimer = setTimeout(() => {
          pressTimer = 0;
          lastY = null; // 本次触摸不再滚动
          s.longPressed = true;
          navigator.vibrate?.(15);
          openCopyPanel(s, { x: pressX, y: pressY });
        }, 500);
      }
    }, { passive: true });
    s.box.addEventListener('touchmove', (e) => {
      if (pressTimer && Math.hypot(e.touches[0].clientX - pressX, e.touches[0].clientY - pressY) > 8) cancelPress();
    }, { passive: true });
    s.box.addEventListener('touchend', cancelPress, { passive: true });
    s.box.addEventListener('touchcancel', cancelPress, { passive: true });

    // 双指捏合调整字体大小
    let pinch = null;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    s.box.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) pinch = { d0: dist(e.touches) || 1, base: fontSize, raf: 0, size: fontSize };
    }, { passive: true });
    s.box.addEventListener('touchmove', (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      pinch.size = pinch.base * dist(e.touches) / pinch.d0;
      if (!pinch.raf) {
        pinch.raf = requestAnimationFrame(() => {
          if (!pinch) return;
          pinch.raf = 0;
          setFontSize(pinch.size, false);
          fontToast(s, `字体 ${fontSize}`);
        });
      }
    }, { passive: false });
    const endPinch = (e) => {
      if (!pinch || e.touches.length >= 2) return;
      cancelAnimationFrame(pinch.raf);
      setFontSize(pinch.size, true);
      pinch = null;
    };
    s.box.addEventListener('touchend', endPinch, { passive: true });
    s.box.addEventListener('touchcancel', endPinch, { passive: true });

    s.box.addEventListener('touchstart', (e) => {
      cancelAnimationFrame(frame);
      frame = 0;
      pendingPx = 0;
      if (e.touches.length !== 1) { lastY = null; return; }
      measure();
      lastY = e.touches[0].clientY;
      lastX = e.touches[0].clientX;
      lastT = performance.now();
      vel = 0;
      acc = 0;
    }, { passive: true });

    s.box.addEventListener('touchmove', (e) => {
      if (lastY == null || e.touches.length !== 1) return;
      e.preventDefault(); // 阻止下拉刷新 / 页面滚动
      const y = e.touches[0].clientY;
      const now = performance.now();
      const dy = y - lastY;
      vel = 0.7 * (dy / Math.max(now - lastT, 1)) + 0.3 * vel;
      lastY = y;
      lastT = now;
      pendingPx += dy;
      if (!frame) frame = requestAnimationFrame(flush);
    }, { passive: false });

    s.box.addEventListener('touchend', () => {
      if (lastY == null) return;
      lastY = null;
      cancelAnimationFrame(frame);
      flush();
      // 停顿后再松手不需要惯性
      if (performance.now() - lastT > 80) vel = 0;
      vel = Math.max(-4, Math.min(4, vel));
      lastFrameT = performance.now();
      frame = requestAnimationFrame(momentum);
    }, { passive: true });
  }

