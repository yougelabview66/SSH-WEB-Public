  // ------------------------------------------------------------ tmux 本地快速滚动
  // tmux 开了鼠标时，历史在 tmux 手里，每滚一格都要 tmux 重画整屏再传回来，要等一个来回。
  // 改成：往上滚的第一下，服务端在目标主机上 tmux capture-pane 抓出这个 pane 的历史，
  // 网页盖一层可以原生滚动的历史视图，之后滚动全在本地。Esc / 回到实时画面 / 滚到底再往下 / 打字 退出。
  // 没有 tmux、pane 里是 vim 等全屏程序、分屏或抓到的不是这个画面时，照旧把滚轮交给程序
  const LS_LINES = 3000;
  const LS_WHEEL_QUIET = 400; // 滚轮停这么久才算这一下滚动结束
  const LS_CHUNK = 100; // 历史视图按块放进页面，每块这么多行


  // 常驻会话 (sshwebd)：程序没开鼠标 (比如 Claude Code) 也走历史视图，同 tmux 里的用法
  // (历史取自服务器上这个终端的记录；里面开着 tmux 时走 tmux capture-pane，取 tmux 的历史)。
  // 备用屏幕也照试：里面开着 tmux 时备用屏幕是 tmux 的，抓 tmux 的历史没问题；真正的全屏程序由服务端再查
  // (这个会话的 tmux pane 里是全屏程序 → busy / 没开 tmux → 终端记录自己在备用屏幕上取不了 → busy)，滚轮照旧交给程序
  const daemonHistory = (s) => !!s.params?.daemonId;

  function localScrollWheel(s, e) {
    if (s.bypassWheel) return true;
    if (s.scrollView) { scrollViewWheel(s, e.deltaY); return false; }
    // 刚往下滚回实时画面：这一下滚动剩下的 (滚轮 / 触摸板末尾常带一两格反方向的抖动) 都不算，免得又打开历史视图
    if (s.lsWheelUntil > Date.now()) { s.lsWheelUntil = Date.now() + LS_WHEEL_QUIET; return false; }
    if (s.scrollLoading) { s.heldWheel += e.deltaY < 0 ? 1 : -1; return false; } // 等结果期间的滚动先记下 (往上为正)
    // 程序开了鼠标 (tmux) 才试 (不是 tmux 的话服务端很快回 no-tmux，一段时间内不再试)；常驻会话 (Windows)一直试。
    // Windows 没开常驻会话：不取历史 (不用 psmux 了)，滚轮按终端默认的方式处理
    if (e.deltaY >= 0 || !s.sid || (s.term.modes.mouseTrackingMode === 'none' && !daemonHistory(s))) return true;
    if (s.winHost && !daemonHistory(s)) return true;
    if (s.noTmuxUntil > Date.now()) return true;
    s.scrollLoading = true;
    s.heldWheel = 1;
    send(s, { type: 'tmux-history', lines: LS_LINES });
    s.lsTimer = setTimeout(() => onTmuxHistory(s, { ok: false, reason: 'timeout' }), 12000); // 慢的主机 (NAS 第一次开通道、扫进程要好几秒) 多等一会儿，服务端那边同样放宽到 10 秒
    return false;
  }

  // 抓到的历史末尾应该就是现在的画面：拿当前屏幕的文字行去对，对上 6 成以上才算同一个 pane。
  // 比对用缓冲区的最后一屏 (baseY)，不看 xterm 视口滚到哪 —— 以前失败处理重发过滚轮的会话，xterm 自己的记录被滚上去过，
  // 视口停在上面，之后抓到的历史永远和视口对不上，一直失败 (打一个字 xterm 回到底部才又好一次)
  function historyMatchesScreen(s, data) {
    let i = data.length; // 只看最后几屏 (整段几千行去颜色要十几毫秒)
    for (let k = 0; k < s.term.rows * 3 && i > 0; k++) i = data.lastIndexOf('\n', i - 1);
    const plain = data.slice(Math.max(0, i)).replace(ANSI_RE, '');
    const b = s.term.buffer.active;
    let total = 0, hit = 0;
    for (let y = b.baseY; y < b.baseY + s.term.rows - 1; y++) { // 最后一行多半是 tmux 状态栏
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
    if (m.ok && s.heldWheel <= 0) return; // 等结果期间又滚回来了 (最后是往下的)，不打开
    if (m.ok && historyMatchesScreen(s, m.data)) return openLocalScroll(s, m.data, Math.max(1, s.heldWheel));
    // 用不了：一段时间内不再尝试，把刚才拦下的滚轮补发给程序 (会进入 tmux 自己的复制模式，不弹提示)
    const reason = m.ok ? 'mismatch' : m.reason;
    s.noTmuxUntil = Date.now() + ({ 'no-tmux': 300000, busy: 5000, 'in-mode': 3000 }[reason] || 30000);
    if (m.win) s.winHost = true;
    // 超时：提示一次原因 (真机上没法看，方便找问题)；Windows 主机没开常驻会话本来就没有历史，不提示
    if (reason === 'timeout' && !s.winHost && !s.winToastDone) {
      s.winToastDone = true;
      fontToast(s, 'tmux 的历史取不到（超时），这次滚轮交给它自己处理', 4000);
    }
    const target = s.term.element.querySelector('.xterm-screen') || s.term.element;
    // 常驻会话、程序没开鼠标：没有程序接滚轮 (tmux 复制模式那套不适用)，重发只会把 xterm 自己的记录滚上去，
    // 视口停在半路，之后抓到的历史和画面永远对不上、一直失败 —— 直接吞掉，等静默期过了再试
    if (s.params?.daemonId && s.term.modes.mouseTrackingMode === 'none') return;
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
    s.box.appendChild(v); // 先放进页面才量得出字宽
    const text = data.replace(/\n+$/, '');
    const cw = screen && screen.clientWidth / s.term.cols; // 实时画面一格多宽
    const fix = cw ? gridFit(pre, text, cw) : null, pal = palette256(theme);
    // 几千行一次全塞进页面要卡一两秒：分成块，先放最后几块马上显示，前面的在后台一块块补到上面。
    // 块从最后往前切 (最前面那块不满)；块末尾的换行留着，textContent 和整段文字一样 (复制面板按它数行)
    const lines = text.split('\n'), chunks = [], g = sgrInit();
    for (let i = 0, end = lines.length % LS_CHUNK || LS_CHUNK; i < lines.length; i = end, end += LS_CHUNK) {
      const t = lines.slice(i, end).join('\n') + (end < lines.length ? '\n' : '');
      chunks.push({ t, g: { ...g } }); // 这块开头的颜色 (接着上一块)
      sgrScan(t, g, pal);
    }
    const block = (c) => {
      const d = document.createElement('div');
      d.innerHTML = ansiToHtml(c.t, theme, fix, pal, { ...c.g });
      return d;
    };
    let next = chunks.length - 1;
    for (let n = 0; next >= 0 && n < s.term.rows * 2 + up * 3; n += LS_CHUNK) pre.prepend(block(chunks[next--]));
    // 补到上面时正在看的内容不动：浏览器自己会保持 (scroll anchoring)，已经滚到最顶上 / 不支持的浏览器手动补上多出来的高度
    const addAbove = (el) => {
      const ref = pre.firstChild, y0 = ref.getBoundingClientRect().top;
      pre.prepend(el);
      const d = ref.getBoundingClientRect().top - y0;
      if (d) pre.scrollTop += d;
    };
    const fill = () => {
      if (s.scrollView !== v) return;
      for (const t0 = performance.now(); next >= 0 && performance.now() - t0 < 10;) addAbove(block(chunks[next--]));
      if (next >= 0) setTimeout(fill);
    };
    // 复制面板要整段历史：剩下的一次补完
    v.lsRest = () => {
      if (next < 0) return;
      const f = document.createDocumentFragment();
      while (next >= 0) f.prepend(block(chunks[next--]));
      addAbove(f);
    };
    requestAnimationFrame(() => setTimeout(fill)); // 先让最后几块画出来
    s.scrollView = v;
    s.lsLine = lh;
    syncLsBars();
    pre.scrollTop = pre.scrollHeight - pre.clientHeight - up * 3 * lh; // 和滚轮一样往回看几行
    // 输入框藏起来了，焦点放这里：PageUp / PageDown / Home / 方向键直接滚历史。
    // 是搜索打开的 (光标在搜索框里) 就不抢：手机上输入法会弹出来又收起
    if (!document.activeElement?.closest?.('.tsearch')) pre.focus({ preventScroll: true });
    // 回到实时画面：click 给电脑；手机上再加一个 touchend —— 两指同时碰到屏幕时浏览器会把按钮的 click 取消掉
    // (以前就是「偶尔点了没反应」)，touchend 照样会来。preventDefault 掉免得再合成一次 click，两边都触发
    // 按钮用 closeLocalScroll，不用 closeByWheel：点按钮是有意的，没有残留滚轮要挡，
    // 设了静默期反而会让「点完马上往上滚」在 400ms 内没反应
    const closeBtn = v.querySelector('.ls-close');
    closeBtn.addEventListener('click', () => closeLocalScroll(s));
    closeBtn.addEventListener('touchend', (e) => { e.preventDefault(); closeLocalScroll(s); }, { passive: false });
    // 电脑：在最底下还往下滚 = 回到实时画面
    pre.addEventListener('wheel', (e) => {
      if (e.deltaY > 0 && atBottom(pre)) { e.preventDefault(); closeByWheel(s); }
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
    // 手机：已经在最底下时再往上推 = 回到实时画面。
    // 判据用「松手时还在最底下」，不看按下那一刻 —— 以前按下时只要差几像素（惯性还在滚、前面的历史刚补上来）
    // 就不认，推得再多也关不掉，看着就是「偶尔点了/推了没反应」
    let startY = 0;
    pre.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; }, { passive: true });
    pre.addEventListener('touchend', (e) => {
      const dy = (e.changedTouches[0]?.clientY ?? startY) - startY;
      if (dy < -40 && atBottom(pre)) closeByWheel(s);
    });
  }

  // 手机：「回到实时画面」的高度由 CSS 定 (整条通栏 56px，见 style.css 的 @media (pointer: coarse))。
  // 以前这里按按键栏按钮的高度 (约 32px) 设，手指够不准；高度统一交给 CSS 后不用再量，也不再需要 mkeyH

  // 历史视图打开时把输入栏 (电脑输入框 / 手机输入栏) 藏起来，多出来的地方给历史视图
  function syncLsBars() {
    $('#app').classList.toggle('ls-open', !!active?.scrollView);
  }

  const atBottom = (el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2;

  // 手指一开始是在终端上滑的，这一次滑动剩下的滚轮事件继续滚历史视图
  function scrollViewWheel(s, deltaY) {
    const pre = s.scrollView.querySelector('.ls-body');
    if (deltaY > 0 && atBottom(pre)) return closeByWheel(s);
    pre.scrollTop += Math.sign(deltaY) * 3 * s.lsLine;
  }

  function closeByWheel(s) {
    s.lsWheelUntil = Date.now() + LS_WHEEL_QUIET;
    closeLocalScroll(s);
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
    if (!active?.scrollView || document.querySelector('.overlay:not(.hidden):not(.tab-away)')) return;
    if (e.target.closest?.('.tsearch')) return; // 在搜索框里按的 (Esc 关搜索框，见 58-term-search.js)
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

  // 实时画面按格子画 (中文 / emoji 占两格，其他一格)，历史视图是普通文字：英文字宽和格子差一点点，
  // 中文、emoji 和后备字体里的符号更是宽窄不一，表格的竖线对不齐、占满一行的分隔线放不下而折行。
  // 量出每种字在历史视图里的实际宽度，用 letter-spacing 把每个字补成正好 1 / 2 格 (和实时画面一样宽)。
  // 英文统一补在整个视图上；返回其他要单独补的字 → 补多少 px
  function gridFit(pre, text, cw) {
    const chars = [...new Set(text.replace(ANSI_RE, '').match(/[^\x00-\x7f]/gu) || [])].filter(cellWidth);
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;letter-spacing:0';
    probe.innerHTML = `<span>${'0'.repeat(100)}</span>` + chars.map((c) => `<span>${esc(c)}</span>`).join('');
    pre.appendChild(probe);
    const w = [...probe.children].map((x) => x.getBoundingClientRect().width);
    probe.remove();
    const base = cw - w[0] / 100;
    pre.style.letterSpacing = base.toFixed(3) + 'px';
    const fix = new Map();
    chars.forEach((c, i) => {
      const d = cellWidth(c) * cw - w[i + 1];
      if (Math.abs(d - base) > 0.01) fix.set(c, d.toFixed(3));
    });
    return fix;
  }

  // 一个字在终端里占几格 (同 tmux：中日韩文字、全角符号、emoji 两格，组合用的附加符号不占格)
  const WIDE = [[0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
    [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
    [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
    [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
    [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
    [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e],
    [0x3041, 0x4dbf], [0x4e00, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19],
    [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4], [0x17000, 0x18aff], [0x1b000, 0x1b2ff],
    [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f251],
    [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb], [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd]];
  const ZERO_RE = /[\u0300-\u036f\u0483-\u0489\u0591-\u05bd\u0610-\u061a\u064b-\u065f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u20d0-\u20ff\ufe00-\ufe0f\ufe20-\ufe2f\u{1f3fb}-\u{1f3ff}\u{e0100}-\u{e01ef}]/u;
  function cellWidth(c) {
    const cp = c.codePointAt(0);
    if (cp < 0x300) return 1;
    if (ZERO_RE.test(c)) return 0;
    let lo = 0, hi = WIDE.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cp < WIDE[mid][0]) hi = mid - 1;
      else if (cp > WIDE[mid][1]) lo = mid + 1;
      else return 2;
    }
    return 1;
  }

  // 按 gridFit 量出来的结果，把要单独补宽度的字包起来；不占格的附加符号跟着前一个字
  function fitHtml(t, fix) {
    if (!fix?.size) return esc(t);
    let out = '', run = '', ls;
    const flush = () => {
      if (run) out += ls === undefined ? esc(run) : `<span style="letter-spacing:${ls}px">${esc(run)}</span>`;
      run = '';
    };
    for (const c of t) {
      const v = cellWidth(c) ? fix.get(c) : ls;
      if (v !== ls) { flush(); ls = v; }
      run += c;
    }
    flush();
    return out;
  }

  // 颜色 / 字体样式的状态：分块渲染时每块从上一块结束时的状态接着算
  const sgrInit = () => ({ fg: null, bg: null, fgIdx: -1, bold: false, dim: false, it: false, ul: false, inv: false, st: false });

  function applySgr(g, seq, pal) {
    if (!seq.endsWith('m') || seq[1] !== '[') return;
    const ps = (seq.slice(2, -1) || '0').split(/[;:]/).map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < ps.length; i++) {
      const c = ps[i];
      if (c === 0) Object.assign(g, sgrInit());
      else if (c === 1) g.bold = true;
      else if (c === 2) g.dim = true;
      else if (c === 3) g.it = true;
      else if (c === 4) g.ul = true;
      else if (c === 7) g.inv = true;
      else if (c === 9) g.st = true;
      else if (c === 22) g.bold = g.dim = false;
      else if (c === 23) g.it = false;
      else if (c === 24) g.ul = false;
      else if (c === 27) g.inv = false;
      else if (c === 29) g.st = false;
      else if (c >= 30 && c <= 37) { g.fg = pal[c - 30]; g.fgIdx = c - 30; }
      else if (c === 39) { g.fg = null; g.fgIdx = -1; }
      else if (c >= 40 && c <= 47) g.bg = pal[c - 40];
      else if (c === 49) g.bg = null;
      else if (c >= 90 && c <= 97) { g.fg = pal[c - 82]; g.fgIdx = -1; }
      else if (c >= 100 && c <= 107) g.bg = pal[c - 92];
      else if (c === 38 || c === 48) {
        let col = null;
        if (ps[i + 1] === 5) { col = pal[ps[i + 2]] || null; i += 2; }
        else if (ps[i + 1] === 2) { col = `rgb(${ps[i + 2]},${ps[i + 3]},${ps[i + 4]})`; i += 4; }
        if (c === 38) { g.fg = col; g.fgIdx = -1; } else g.bg = col;
      }
    }
  }

  // 只跟着颜色走一遍、不生成 HTML (算出下一块开头的颜色)
  function sgrScan(text, g, pal) {
    let m;
    ANSI_RE.lastIndex = 0;
    while ((m = ANSI_RE.exec(text))) applySgr(g, m[0], pal);
  }

  function ansiToHtml(text, theme, fix, pal = palette256(theme), g = sgrInit()) {
    let out = '', last = 0, m;
    const css = () => {
      let f = g.fg, b = g.bg;
      if (g.bold && g.fgIdx >= 0 && g.fgIdx < 8) f = pal[g.fgIdx + 8]; // 同 xterm：粗体用亮色
      if (g.inv) { const t = f; f = b || theme.background; b = t || theme.foreground; }
      let c = '';
      if (f) c += `color:${f};`;
      if (b) c += `background:${b};`;
      if (g.bold) c += 'font-weight:bold;';
      if (g.dim) c += 'opacity:.6;';
      if (g.it) c += 'font-style:italic;';
      if (g.ul || g.st) c += `text-decoration:${g.ul ? 'underline' : ''} ${g.st ? 'line-through' : ''};`;
      return c;
    };
    const put = (t) => {
      if (!t) return;
      const c = css();
      out += c ? `<span style="${c}">${fitHtml(t, fix)}</span>` : fitHtml(t, fix);
    };
    ANSI_RE.lastIndex = 0;
    while ((m = ANSI_RE.exec(text))) {
      put(text.slice(last, m.index));
      last = ANSI_RE.lastIndex;
      applySgr(g, m[0], pal);
    }
    put(text.slice(last));
    return out;
  }
