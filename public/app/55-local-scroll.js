  // ------------------------------------------------------------ tmux 本地快速滚动
  // tmux 开了鼠标时，历史在 tmux 手里，每滚一格都要 tmux 重画整屏再传回来，要等一个来回。
  // 改成：往上滚的第一下，服务端在目标主机上 tmux capture-pane 抓出这个 pane 的历史，
  // 网页盖一层可以原生滚动的历史视图，之后滚动全在本地。Esc / 回到实时画面 / 滚到底再往下 / 打字 退出。
  // 没有 tmux、pane 里是 vim 等全屏程序、分屏或抓到的不是这个画面时，照旧把滚轮交给程序。
  // 切换要看不出来：历史视图的最后一屏和实时画面逐行对齐 (同样的位置、同样的状态栏)，打开时从这里滑上去，
  // 回来时滚到底正好就是实时画面；这个标签打开过一次后，往上滚不等网络，先拿当前画面打开，历史抓回来再补到上面
  const LS_LINES = 3000;
  const LS_WHEEL_QUIET = 400; // 滚轮停这么久才算这一下滚动结束

  const lsLineH = (s) => (s.box.querySelector('.xterm-screen')?.clientHeight / s.term.rows) || 17;
  // 这一下滚轮要滚多少像素 (往上为正)
  const wheelPx = (s, e) => -e.deltaY * (e.deltaMode === 1 ? lsLineH(s) : e.deltaMode === 2 ? lsLineH(s) * s.term.rows : 1);

  function localScrollWheel(s, e) {
    if (s.bypassWheel) return true;
    if (s.scrollView) { scrollViewWheel(s, e.deltaY); return false; }
    // 刚往下滚回实时画面：这一下滚动剩下的 (滚轮 / 触摸板末尾常带一两格反方向的抖动) 都不算，免得又打开历史视图
    if (s.lsWheelUntil > Date.now()) { s.lsWheelUntil = Date.now() + LS_WHEEL_QUIET; return false; }
    if (s.scrollLoading) { s.heldWheel += e.deltaY < 0 ? 1 : -1; s.heldPx += wheelPx(s, e); return false; } // 等结果期间的滚动先记下 (往上为正)
    const b = s.term.buffer.active;
    if (e.deltaY >= 0 || !s.sid || s.term.modes.mouseTrackingMode === 'none' || b.type !== 'alternate') return true;
    if (s.noTmuxUntil > Date.now()) return true;
    s.scrollLoading = true;
    s.heldWheel = 1;
    s.heldPx = wheelPx(s, e);
    send(s, { type: 'tmux-history', lines: LS_LINES });
    s.lsTimer = setTimeout(() => onTmuxHistory(s, { ok: false, reason: 'timeout' }), 4000);
    if (s.lsOk) openLocalScroll(s, null); // 这个标签用得了本地滚动：不等网络，先拿当前画面打开
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
    const early = s.scrollView; // 先拿当前画面打开的
    if (m.ok && !early && s.heldWheel <= 0) return; // 等结果期间又滚回来了 (最后是往下的)，不打开
    if (m.ok && historyMatchesScreen(s, m.data)) {
      s.lsOk = true;
      return early ? fillLocalScroll(s, m) : openLocalScroll(s, m);
    }
    // 用不了：一段时间内不再尝试，把刚才拦下的滚轮补发给程序 (会进入 tmux 自己的复制模式，不弹提示)
    s.lsOk = false;
    if (early) closeLocalScroll(s);
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

  // m = 抓回来的历史；为空 = 还没抓回来，先放当前画面
  function openLocalScroll(s, m) {
    const theme = termTheme();
    const screen = s.box.querySelector('.xterm-screen');
    const lh = lsLineH(s);
    const v = document.createElement('div');
    v.className = 'lscroll';
    v.innerHTML = '<button class="ls-close" title="Esc / 往下滚到底 / 打字 也可以返回">回到实时画面 ✕</button><pre class="ls-body" tabindex="-1"></pre>';
    const pre = v.querySelector('.ls-body');
    Object.assign(pre.style, {
      fontFamily: s.term.options.fontFamily, fontSize: s.term.options.fontSize + 'px', lineHeight: lh + 'px',
      color: theme.foreground, background: theme.background,
    });
    v.style.background = theme.background;
    s.box.appendChild(v); // 先放进页面才量得出字宽
    s.scrollView = v;
    s.lsLine = lh;
    syncLsBars();
    // 输入栏藏起来后历史视图比终端高：底下留出多出来的高度，最后一屏每一行都还在实时画面里那一行的位置
    if (screen) pre.style.paddingBottom = Math.max(0, v.getBoundingClientRect().bottom - screen.getBoundingClientRect().bottom) + 'px';
    renderLs(s, pre, m);
    pre.scrollTop = pre.scrollHeight; // 停在最底下 = 和实时画面一模一样
    pre.scrollTo({ top: pre.scrollHeight - pre.clientHeight - Math.max(lh, s.heldPx || 0), behavior: 'smooth' }); // 照这一下滚轮滑上去
    pre.focus({ preventScroll: true }); // 输入框藏起来了，焦点放这里：PageUp / PageDown / Home / 方向键直接滚历史
    v.querySelector('.ls-close').addEventListener('click', () => closeLocalScroll(s));
    // 电脑：往下滚到底 = 回到实时画面 (最后一屏和实时画面一样，不用到底了再多滚一下)
    pre.addEventListener('wheel', (e) => {
      if (e.deltaY > 0 && toBottom(pre) <= -wheelPx(s, e)) { e.preventDefault(); closeByWheel(s); }
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

  // 先拿当前画面打开的，历史抓回来了：换成完整的历史，正在看的那一行不动 (两者最后一屏是对齐的，按离底部的距离保持)
  function fillLocalScroll(s, m) {
    const pre = s.scrollView.querySelector('.ls-body');
    const fromBottom = pre.scrollHeight - pre.scrollTop;
    renderLs(s, pre, m);
    pre.scrollTop = pre.scrollHeight - fromBottom;
  }

  // 历史视图的内容：抓到的历史 (末尾就是 pane 现在这一屏，连底下的空行) + 终端里 pane 下面那几行 (tmux 状态栏)，
  // 和实时画面逐行对上。还没抓回来时放当前画面，上面留一段空白可以先接着往上滚
  function renderLs(s, pre, m) {
    const rows = s.term.rows;
    let text;
    if (m) {
      const end = paneEnd(s, m.pane);
      text = m.data.replace(/\n$/, '') + (end < rows ? '\n' + screenAnsi(s, end, rows) : '');
    } else text = screenAnsi(s, 0, rows);
    const theme = termTheme();
    const screen = s.box.querySelector('.xterm-screen');
    const cw = screen && screen.clientWidth / s.term.cols; // 实时画面一格多宽
    const html = ansiToHtml(text, theme, cw ? gridFit(pre, text, cw) : null);
    pre.innerHTML = m ? html : `<div class="ls-wait" style="height:${pre.clientHeight * 2}px"></div>` + html;
  }

  // pane 最后一行的下一行在终端里是第几行 (下面是状态栏)；服务端没给 pane 位置时按 tmux 默认 (状态栏一行、在最底下) 算
  function paneEnd(s, p) {
    if (!p) return s.term.rows - 1;
    const st = p.status === 'off' ? 0 : p.status === 'on' ? 1 : (parseInt(p.status, 10) || 1);
    return Math.min(s.term.rows, (p.position === 'top' ? st : 0) + p.top + p.height);
  }

  // 终端屏幕上第 from ~ to-1 行转成带颜色 (SGR) 的文字，和 tmux capture-pane -e 一样交给 ansiToHtml
  function screenAnsi(s, from, to) {
    const b = s.term.buffer.active, out = [];
    const cell = b.getNullCell();
    for (let y = from; y < to; y++) {
      const line = b.getLine(b.viewportY + y);
      let end = line ? line.length : 0;
      while (end > 0 && blankCell(line.getCell(end - 1, cell))) end--;
      let t = '', last = '';
      for (let x = 0; x < end; x++) {
        const c = line.getCell(x, cell);
        if (!c.getWidth()) continue; // 中文 / emoji 占两格，后一格是空的
        const sgr = cellSgr(c);
        if (sgr !== last) { t += `\x1b[0${sgr}m`; last = sgr; }
        t += c.getChars() || ' ';
      }
      out.push(last ? t + '\x1b[0m' : t);
    }
    return out.join('\n');
  }
  const blankCell = (c) => (c.getChars() || ' ') === ' ' && c.isBgDefault() && !c.isInverse();
  const sgrColor = (c, fg) => {
    const v = fg ? c.getFgColor() : c.getBgColor();
    if (fg ? c.isFgRGB() : c.isBgRGB()) return `;${fg ? 38 : 48};2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`;
    if (!(fg ? c.isFgPalette() : c.isBgPalette())) return '';
    return v < 8 ? `;${(fg ? 30 : 40) + v}` : v < 16 ? `;${(fg ? 82 : 92) + v}` : `;${fg ? 38 : 48};5;${v}`;
  };
  const cellSgr = (c) => (c.isBold() ? ';1' : '') + (c.isDim() ? ';2' : '') + (c.isItalic() ? ';3' : '') + (c.isUnderline() ? ';4' : '')
    + (c.isInverse() ? ';7' : '') + (c.isStrikethrough() ? ';9' : '') + sgrColor(c, true) + sgrColor(c, false);

  // 历史视图打开时把输入栏 (电脑输入框 / 手机输入栏) 藏起来，多出来的地方给历史视图
  function syncLsBars() {
    $('#app').classList.toggle('ls-open', !!active?.scrollView);
  }

  const toBottom = (el) => el.scrollHeight - el.clientHeight - el.scrollTop;
  const atBottom = (el) => toBottom(el) <= 2;

  // 手指一开始是在终端上滑的，这一次滑动剩下的滚轮事件继续滚历史视图
  function scrollViewWheel(s, deltaY) {
    const pre = s.scrollView.querySelector('.ls-body');
    const step = 3 * s.lsLine;
    if (deltaY > 0 && toBottom(pre) <= step) return closeByWheel(s); // 这一下就到底了
    pre.scrollTop += Math.sign(deltaY) * step;
  }

  function closeByWheel(s) {
    s.lsWheelUntil = Date.now() + LS_WHEEL_QUIET;
    closeLocalScroll(s);
  }

  // 回到实时画面：历史视图很快淡出 (滚到底时和实时画面一模一样，看不出来；看历史期间又有新输出时不会一下子跳变)，
  // 输入栏淡入 (它回来的地方原来是历史视图底下留空的那一截)
  function closeLocalScroll(s) {
    const v = s.scrollView;
    if (!v) return;
    if (s.scrollLoading) { s.scrollLoading = false; clearTimeout(s.lsTimer); } // 先拿当前画面打开的，历史还没抓回来
    s.scrollView = null;
    v.classList.add('ls-gone'); // 淡出期间点不到、滚轮直接落到终端上
    setTimeout(() => v.remove(), 150);
    const app = $('#app');
    if (app.classList.contains('ls-open') && !active?.scrollView) {
      app.classList.add('ls-back');
      clearTimeout(closeLocalScroll.t);
      closeLocalScroll.t = setTimeout(() => app.classList.remove('ls-back'), 250);
    }
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

  function ansiToHtml(text, theme, fix) {
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
      out += c ? `<span style="${c}">${fitHtml(t, fix)}</span>` : fitHtml(t, fix);
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
