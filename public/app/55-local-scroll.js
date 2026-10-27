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
    const tc = s.term.cols || 80;
    // 历史视图能放字的宽度。滚动条已经扣掉了 (.ls-body 的 scrollbar-gutter: stable)：以前在放内容之前量，
    // 那时还没有滚动条，内容放进去后它占掉 15px 左右，最右边一两格被盖住
    const pcs = getComputedStyle(pre);
    const availW = pre.clientWidth - parseFloat(pcs.paddingLeft || 0) - parseFloat(pcs.paddingRight || 0);
    // 差一点放不下终端的列数 (左边距、滚动条占掉几像素，电脑上常见)：每格收窄一点，照样按终端列数排 ——
    // 不然占满整行的分隔线、表格边框会被折成两行 (下一行只剩一两个字)。留 2px：浏览器排字精度有限 (1/64px)，
    // 一行一百多格累计下来会差一两像素。差得多 (手机上看电脑开的大终端) 才按放得下的格数切，见下面的 cols
    const cell = cw && tc * cw > availW - 2 && availW / tc >= cw * 0.95 ? (availW - 2) / tc : cw;
    const fit = cell ? gridFit(pre, text, cell) : null, pal = palette256(theme);
    // 不再让浏览器折行：抓历史时折行已经拼回一整条 (-J / isWrapped)，必须正好在 cols 格处切开才和实时画面一致。
    // 浏览器按像素宽折行，和 cols × 每格宽 差一点点，表格竖线就对不上（右边一列跑到下一行行首）
    pre.style.whiteSpace = 'pre'; // 我们自己切，别让浏览器再折一次
    pre.style.overflowX = 'hidden';
    // 几千行一次全塞进页面要卡一两秒：分成块，先放最后几块马上显示，前面的在后台一块块补到上面。
    // 块从最后往前切 (最前面那块不满)；块末尾的换行留着，textContent 和整段文字一样 (复制面板按它数行)
    const lines = text.split('\n'), chunks = [], g = sgrInit();
    for (let i = 0, end = lines.length % LS_CHUNK || LS_CHUNK; i < lines.length; i = end, end += LS_CHUNK) {
      const t = lines.slice(i, end).join('\n') + (end < lines.length ? '\n' : '');
      chunks.push({ t, g: { ...g } }); // 这块开头的颜色 (接着上一块)
      sgrScan(t, g, pal);
    }
    // 每块硬切成若干显示行，再逐行转 HTML：这样长行（表格那种拼回来的）正好在边界处断开，
    // 浏览器不会再自己折一次。ANSI 颜色状态跨段接着算 (ansiToHtml 会把状态写进传进去的 g)。
    //
    // 切多少格：放得下终端的列数就按终端列数切 (和实时画面一样，占满整行的分隔线不折行)；
    // 放不下 (手机上看电脑开的大终端：终端 127 格，历史视图只放得下 58 格) 按实际放得下的格数切，不然右边被裁掉。
    // 复制面板换算行号要用同一个值 (见下面的 lsCols)。
    // 一格的真实宽度直接在 pre 里量 (此时 letter-spacing 已经由 gridFit 设好)：浏览器排字精度有限，
    // 拿 cell 算出来的和实际排出来的能差好几像素
    const cols = (() => {
      const probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
      probe.textContent = '0'.repeat(100);
      pre.appendChild(probe);
      const w = probe.getBoundingClientRect().width / 100;
      probe.remove();
      if (!(w > 0) || !(availW > 0)) return tc;
      return tc * w <= availW + 0.5 ? tc : Math.max(1, Math.floor((availW + 0.5) / w));
    })();
    const block = (c) => {
      const d = document.createElement('div');
      const g = { ...c.g };
      let html = '';
      for (const raw of c.t.split('\n')) {
        const segs = cols > 0 ? splitByCells(raw, cols) : [{ text: raw }];
        // ansiToHtml 自己会把 ANSI 状态写进传进去的 g，不用再 sgrScan 一遍。
        // 切开长行插进去的换行包在 .ls-wrap 里：选中复制时去掉 (见 plainSel)，复制出来还是原来的一整行
        segs.forEach((seg, i) => { html += ansiToHtml(seg.text, theme, fit, pal, g) + (i < segs.length - 1 ? SOFT_BR : '\n'); });
      }
      // 末尾这个换行是「块和块之间的分隔」：chunks 里每块 t 以 \n 结尾 (最后一块除外)，
      // 这里去掉的是本块自己加的那个，不是切块留的 —— 两个都去会让相邻块粘在一起 (c + d → cd)
      d.innerHTML = html.replace(/\n$/, '');
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
    // 复制面板要的是「原始历史文本」：显示时为了让长行正好在 cols 格断开 (splitByCells) 会插入换行，
    // 直接读 textContent 会多出一堆本不存在的换行。这里把去掉 ANSI 的原文存一份，复制时优先用它
    v.lsText = text.replace(ANSI_RE, '');
    v.lsCols = cols; // 显示时按几格切的行 (复制面板换算行号要用同一个值，见 60-copy-push.js 的 domLineToTextLine)
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
    // 手指在按钮上按下后滑动 (顺手翻历史) 不算点：松手时离按下的地方超过 10px 就不关
    let btnAt = null;
    closeBtn.addEventListener('touchstart', (e) => { const t = e.touches[0]; btnAt = t && { x: t.clientX, y: t.clientY }; }, { passive: true });
    closeBtn.addEventListener('touchend', (e) => {
      const t = e.changedTouches[0];
      if (btnAt && t && Math.hypot(t.clientX - btnAt.x, t.clientY - btnAt.y) > 10) return;
      e.preventDefault(); closeLocalScroll(s);
    }, { passive: false });
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
        const text = plainSel(sel);
        if (!text.trim()) return;
        const range = sel.getRangeAt(0).cloneRange();
        const ok = await copyText(text);
        // HTTP 下借用临时文本框复制会把选区清掉：选回来，还能接着按 Ctrl+C
        if (!sel.rangeCount || sel.isCollapsed) { sel.removeAllRanges(); sel.addRange(range); }
        fontToast(s, ok ? `已复制 ${text.length} 个字符` : '复制失败，请按 Ctrl+C 复制', 1200, v);
      });
    });
    // Ctrl+C / 右键复制：同上，去掉切长行插进去的换行
    pre.addEventListener('copy', (e) => {
      const sel = getSelection();
      if (!sel?.rangeCount || sel.isCollapsed || !e.clipboardData) return;
      e.clipboardData.setData('text/plain', plainSel(sel));
      e.preventDefault();
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
    // base 一起返回：ASCII 每格固定用 base 的间距。以前 fitHtml 让 ASCII 沿用「上一个字符的间距」，
    // 中文后面的英文就继承了中文的 +2px，整行被拉宽 / 压窄（历史视图里中英混排的行看起来错位）
    return { fix, base: base.toFixed(3), cell: cw };
  }

  // 历史视图里切长行插进去的换行 (显示用，原文里没有)
  const SOFT_BR = '<span class="ls-wrap">\n</span>';
  // 选中的文字去掉切长行插进去的换行 (直接 toString 会把一整行复制成好几行)
  function plainSel(sel) {
    const f = sel.getRangeAt(0).cloneContents();
    f.querySelectorAll('.ls-wrap').forEach((x) => x.remove());
    return f.textContent;
  }

  // 按格数把一行硬切成几段：抓历史用的是 tmux capture-pane -J / 本机记录的折行合并，长行是拼回一整条的，
  // 必须正好在 cols 格处切开才和实时画面一致。以前交给浏览器 pre-wrap 自己折行 —— 它按容器像素宽度折，
  // 和「cols × 每格宽」差一点点，表格的竖线就对不上（右边一列跑到下一行行首）。
  // 返回 [{ text, cell }]，cell = 这段开头在第几格 (用来给续行补缩进)
  //
  // ANSI 颜色序列 (\x1b[36m 之类) 在终端里不占格，这里也不能算格数：以前逐字符算，一段 \x1b[36m 算 5 格，
  // 而 Claude Code / 常驻会话的历史几乎每个词都换色 (见 remote.js 的 lineToAnsi)，一行能多算好几十格 ——
  // 长行被提前切开 (可见 75 格的行切成了 40 + 35)，显示行数比原文行数多出一截。
  // 复制面板按「显示行号」去原文里找行 (见 60-copy-push.js 的 domLineToTextLine)，两边切法必须一致，
  // 不然行号系统性偏大，短会话直接越界落到最后一行 (看着像「直接出现最新记录」)，长会话指到别的行。
  // 顺带：以前正好切在转义序列中间会把 \x1b[36m 劈成两半，后半截 [36m 当普通文字画出来 (画面里多出 0m / 36m)
  function splitByCells(text, cols) {
    const out = [];
    let cur = '', cells = 0, start = 0;
    // 普通文字逐字算格数；ANSI 序列整段原样带上、不算格数，也不会被切开
    const put = (s) => {
      for (const ch of s) {
        const w = cellWidth(ch);
        if (w && cells + w > cols) { out.push({ text: cur, cell: start }); cur = ''; cells = 0; start = 0; }
        cur += ch;
        cells += w;
      }
    };
    let at = 0;
    ANSI_RE.lastIndex = 0; // ANSI_RE 是 /g 的，matchAll 会从 lastIndex 开始
    for (const m of text.matchAll(ANSI_RE)) {
      put(text.slice(at, m.index));
      cur += m[0];
      at = m.index + m[0].length;
    }
    put(text.slice(at));
    out.push({ text: cur, cell: start });
    return out;
  }

  // 表情和符号 (不是中日韩文字)：历史视图里装进固定宽度的小格子 (见 fitHtml)
  const isEmoji = (cp) => cp < 0x2e80 || (cp >= 0x1f000 && cp < 0x20000);
  const VS16 = '\ufe0f';
  // 一个字在终端里占几格：和实时画面、服务器上的终端记录同一份规则 (public/cellwidth.js)
  const { cellWidth } = CellWidth;

  // 按 gridFit 量出来的结果，把要单独补宽度的字包起来；不占格的附加符号跟着前一个字。
  // ASCII (和 fix 里没有的字符) 一律用 base 的间距，不再沿用上一个字符的 —— 否则中文字符后面的英文
  // 会继承中文的间距，一行里越往右偏得越多
  //
  // 表情 (✅ 🔥 这类两格的，和后面跟着 FE0F 的 ⚠️ 等) 不靠量字宽补间距：装进 cell 宽 × 格数的小格子 (.ls-c)。
  // 表情的实际宽度各个浏览器、字体都不一样，iPhone 上量出来的和画出来的对不上，表格里带表情的行右边框就偏出去一格。
  // ⚠️ 的格子只有一格 (同实时画面，见 public/cellwidth.js)，画出来的表情伸到后面那格 (tmux 在那里补了空格子)
  function fitHtml(t, fit, base, cell) {
    const bs = base === undefined ? undefined : String(base);
    if (!fit?.size && bs === undefined) return esc(t);
    let out = '', run = '', ls;
    const flush = () => {
      if (run) out += ls === undefined ? esc(run) : `<span style="letter-spacing:${ls}px">${esc(run)}</span>`;
      run = '';
    };
    const cs = [...t];
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i], w = cellWidth(c);
      if (cell && w) {
        let j = i + 1; // 跟在后面不占格的 (FE0F、肤色、零宽连接符…)：和它装在一起
        while (j < cs.length && !cellWidth(cs[j])) j++;
        const tail = cs.slice(i + 1, j).join(''), vs = tail.includes(VS16);
        if (vs || (w === 2 && isEmoji(c.codePointAt(0)))) {
          flush();
          out += `<span class="ls-c" style="width:${(w * cell).toFixed(3)}px">${esc(c + tail)}</span>`;
          i = j - 1;
          continue;
        }
      }
      // 不占格的附加符号 (组合音标等) 跟着前一个字符走，不单独换间距
      const v = w ? (fit?.get(c) ?? bs) : ls;
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

  // fit：gridFit 的返回值 { fix, base }，或者 null (量不出来就原样输出)
  function ansiToHtml(text, theme, fit, pal = palette256(theme), g = sgrInit()) {
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
      const h = fitHtml(t, fit?.fix, fit?.base, fit?.cell);
      out += c ? `<span style="${c}">${h}</span>` : h;
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
