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
    // 自带完整对话的 Agent (Grok，见 09-agents.js 的 ownHistory)：不管开没开鼠标、是不是 Windows，都去读它的会话文件
    const own = agentDoes(s, 'ownHistory');
    if (e.deltaY >= 0 || !s.sid || (!own && s.term.modes.mouseTrackingMode === 'none' && !daemonHistory(s))) return true;
    if (!own && s.winHost && !daemonHistory(s)) return true;
    if (s.noTmuxUntil > Date.now()) return true;
    s.scrollLoading = true;
    s.heldWheel = 1;
    send(s, { type: 'tmux-history', lines: LS_LINES, ...(own && { agent: agentIdOf(s) }) });
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
    if (m.ok && (m.own || historyMatchesScreen(s, m.data))) return openLocalScroll(s, m.data, Math.max(1, s.heldWheel)); // own：Agent 的会话记录，不是终端画面
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

  // 往回滚 dist 像素：约 150ms 先快后慢的动画。按增量滚 —— 前面的历史还在后台往上补，scrollTop 会被整体推大，按绝对值滚会跳；
  // 中途自己滚了、摸了、按了键就停，交给你
  function smoothBack(pre, dist) {
    if (!(dist > 0)) return;
    const t0 = performance.now(), T = 150;
    let done = 0, stop = false;
    for (const ev of ['wheel', 'touchstart', 'mousedown', 'keydown']) pre.addEventListener(ev, () => { stop = true; }, { once: true, passive: true });
    const step = (t) => {
      if (stop || !pre.isConnected) return;
      const p = Math.min(1, Math.max(0, (t - t0) / T)), want = Math.round(dist * (1 - (1 - p) ** 3));
      pre.scrollTop -= want - done;
      done = want;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
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
    // 实时画面里最后一行有字的那一行的底边 (屏幕上的高度)：打开后历史的最后一行停在同一个高度 (见下面)
    const sr = screen?.getBoundingClientRect();
    let liveBottom = null;
    if (sr && s.term.rows) {
      const b = s.term.buffer.active;
      let last = s.term.rows - 1;
      while (last > 0 && !b.getLine(b.viewportY + last)?.translateToString(true).trim()) last--;
      liveBottom = sr.top + (last + 1) * (sr.height / s.term.rows);
    }
    s.box.appendChild(v); // 先放进页面才量得出字宽
    const text = data.replace(/\n+$/, '');
    const cw = screen && screen.clientWidth / s.term.cols; // 实时画面一格多宽
    const tc = s.term.cols || 80;
    const { cols, chunks, block } = gridView(pre, text, tc, cw, theme);
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
    v.lsData = text; // 带颜色的原文 (复制面板照历史视图的样子排，见 60-copy-panel.js 的 renderCopy)
    v.lsCols = cols; // 显示时按几格切的行 (复制面板换算行号要用同一个值，见 60-copy-panel.js 的 domLineToTextLine)
    syncLsBars();
    // 打开时历史的最后一行停在实时画面最后一行有字的那一行的高度，再用很快的动画往回滚 up 下滚轮的距离：
    // 以前直接滚到最底再跳 up 下 —— 底下的留白 (style.css 的 .ls-body) 露出来、手机上输入栏收起，整个画面往上 / 往下跳一截，看着割裂
    const pr = pre.getBoundingClientRect(), lastBlock = pre.lastElementChild;
    // 最后一行的底边 (在历史视图内容里的位置)：量最后一块的底边 —— 不到一屏时 scrollHeight 是画面的高度，不是内容的
    const end = lastBlock ? lastBlock.getBoundingClientRect().bottom - pr.top - pre.clientTop + pre.scrollTop : pre.scrollHeight;
    const want = liveBottom == null ? end - pre.clientHeight : end - (liveBottom - pr.top - pre.clientTop);
    // 历史不到一屏 (滚不到那么下面)：上面补一段空白，最后一行照样停在那个高度
    if (want < 0) pre.style.paddingTop = parseFloat(getComputedStyle(pre).paddingTop) - want + 'px';
    pre.scrollTop = Math.max(0, want);
    smoothBack(pre, up * 3 * lh); // 和滚轮一样往回看几行
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
