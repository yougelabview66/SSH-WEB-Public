  // ------------------------------------------------------------ 复制终端内容 (手机)
  // 手机上触摸被用来滚动，无法直接选中终端文字；这里把终端内容放进可选择的文本框
  const COPY_LINES = 1000;

  // 终端文字 (最后 1000 行，自动换行的续行接回上一行) 和缓冲区第 row 行在其中是第几行。
  // text 是纯文字 (复制用)；data 是同样的文字带上颜色序列 (面板照历史视图的样子显示颜色，见 renderCopy)，
  // 去掉颜色序列后和 text 一字不差 (换算行号两边要一致)
  function terminalText(s, row = -1) {
    const b = s.term.buffer.active;
    const start = Math.max(0, b.length - COPY_LINES);
    const lines = [], colored = [];
    let at = 0, cell;
    for (let i = start; i < b.length; i++) {
      const line = b.getLine(i);
      if (!line) continue;
      // 逐格读，同 translateToString(true)：没写过字的格子是空格，行尾没写过字的格子去掉，两格宽的字的后半格跳过
      const cells = [];
      let end = 0;
      for (let x = 0; x < line.length; x++) {
        cell = line.getCell(x, cell);
        if (!cell?.getWidth()) continue;
        const ch = cell.getChars();
        cells.push([ch || ' ', cellSgr(cell)]);
        if (ch) end = cells.length;
      }
      let text = '', ansi = '', cur = '';
      for (let k = 0; k < end; k++) {
        const [ch, sgr] = cells[k];
        if (sgr !== cur) { ansi += `\x1b[0${sgr && ';' + sgr}m`; cur = sgr; }
        text += ch;
        ansi += ch;
      }
      if (cur) ansi += '\x1b[0m'; // 每行从默认样式开始 (分块显示时颜色不会带到下一行)
      // 自动换行的续行接回上一行
      if (line.isWrapped && lines.length) { lines[lines.length - 1] += text; colored[colored.length - 1] += ansi; }
      else { lines.push(text); colored.push(ansi); }
      if (i === row) at = lines.length - 1;
    }
    while (lines.length && !lines[lines.length - 1].trim()) { lines.pop(); colored.pop(); }
    return { text: lines.join('\n'), data: colored.join('\n'), line: Math.min(at, Math.max(0, lines.length - 1)) };
  }

  // 一格的样式换成颜色序列的参数 (历史视图认得的那些，见 54-grid-view.js 的 applySgr)；默认样式是空串
  function cellSgr(c) {
    if (c.isAttributeDefault()) return '';
    const p = [];
    if (c.isBold()) p.push(1);
    if (c.isDim()) p.push(2);
    if (c.isItalic()) p.push(3);
    if (c.isUnderline()) p.push(4);
    if (c.isInverse()) p.push(7);
    if (c.isStrikethrough()) p.push(9);
    for (const fg of [true, false]) {
      if (fg ? c.isFgDefault() : c.isBgDefault()) continue;
      const v = fg ? c.getFgColor() : c.getBgColor();
      if (fg ? c.isFgRGB() : c.isBgRGB()) p.push(fg ? 38 : 48, 2, (v >> 16) & 255, (v >> 8) & 255, v & 255);
      // 前 16 色写成 30~37 / 90~97 (背景 40~47 / 100~107)：历史视图只对这种写法做「粗体用亮色」(同 xterm)
      else if (v < 8) p.push((fg ? 30 : 40) + v);
      else if (v < 16) p.push((fg ? 90 : 100) + v - 8);
      else p.push(fg ? 38 : 48, 5, v);
    }
    return p.join(';');
  }

  // 手指按在终端第几行 (缓冲区里的行号)
  function terminalRowAt(s, y) {
    const t = s.term, screen = t.element?.querySelector('.xterm-screen') || t.element;
    const r = screen?.getBoundingClientRect();
    const top = t.buffer.active.viewportY;
    if (!r || !r.height || t.rows <= 0) return top;
    return top + Math.min(t.rows - 1, Math.max(0, Math.floor((y - r.top) / (r.height / t.rows))));
  }

  // 长按打开 (at = 手指位置)：复制面板里按住的那一行就在手指底下；按键栏的「复制」按钮：定位到最新内容。
  // 历史视图 (tmux 本地快速滚动) 打开时：复制的是历史视图里的文字 (不是终端当前那一屏)
  function openCopyPanel(s, at) {
    if (!s) return;
    const pre = $('#copyText');
    const hist = s.scrollView?.querySelector('.ls-body');
    let text, data, line = -1;
    if (hist) {
      s.scrollView.lsRest(); // 前面的历史还在后台往上补：先补完
      // 优先用原始文本：显示时长行会在 cols 格处被切开 (splitByCells)、插入换行，textContent 不是原文
      text = (s.scrollView.lsText ?? hist.textContent).replace(/\n+$/, '');
      data = s.scrollView.lsData ?? text;
      const domLine = at ? lineAt(hist, at.x, at.y) : firstVisibleLine(hist);
      // 换回原始文本的行号 (见 domLineToTextLine 的说明)。必须用历史视图切行时的格数 (lsCols)：
      // 它是按历史视图实际宽度量的，比终端列数小 (手机上小好几格)，拿 term.cols 换算会少数显示行、定位偏到后面
      line = domLineToTextLine(text.split('\n'), s.scrollView.lsCols || s.term?.cols || 80, domLine);
    } else {
      const t = terminalText(s, at ? terminalRowAt(s, at.y) : -1);
      text = t.text;
      data = t.data;
      if (at) line = t.line;
    }
    const n = text ? text.split('\n').length : 0;
    $('#copyInfo').textContent = hist ? `${n} 行 (tmux 历史)`
      : s.term.buffer.active.type === 'alternate' ? `${n} 行 (全屏程序只有当前画面)` : `${n} 行`;
    mInput.blur();
    $('#copyPanel').dataset.tab = s.id; // 手机上同性能监控 (见 tabPanels)
    $('#copyPanel').classList.remove('hidden');
    tabPanels(); // 同历史面板：在别的标签上打开过会带着 tab-away
    noAutoZoom(true);
    renderCopy(s, pre, data, text); // 面板显示出来才量得出宽度
    if (n && line >= 0) scrollToLine(pre, Math.min(line, n - 1), at?.y);
    else { pre._place = null; pre.scrollTop = pre.scrollHeight; } // 定位到最新内容
  }

  // 复制面板的内容照历史视图的样子排 (同一个 gridView)：每种字补成正好 1 / 2 格，表格竖线对齐，超宽的表格整张左右滑。
  // 以前是文本框：iPhone 上中文和英文是两种字体，一个中文字不正好是两个英文宽，文本框里没法按字补，表格竖线对不齐
  function renderCopy(s, pre, data, text) {
    pre.textContent = '';
    pre.style.paddingBottom = '';
    const fs = 12, lh = Math.round(fs * 1.45);
    Object.assign(pre.style, { fontFamily: s.term.options.fontFamily, fontSize: fs + 'px', lineHeight: lh + 'px', letterSpacing: '0' });
    const probe = document.createElement('span'); // 这个字号一格本来多宽
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
    probe.textContent = '0'.repeat(100);
    pre.appendChild(probe);
    const cw = probe.getBoundingClientRect().width / 100;
    probe.remove();
    const { cols, chunks, block } = gridView(pre, data, s.term.cols || 80, cw, termTheme());
    const f = document.createDocumentFragment();
    for (const c of chunks) f.append(block(c));
    pre.append(f);
    pre.lsText = text; // 复制全部、换算行号用原文
    pre.lsCols = cols;
    pre._render = () => renderCopy(s, pre, data, text); // 手机上万一被改了内容，照原样重排 (见下面的可编辑模式)
  }

  // 把 DOM 里的行号换算成原始文本的行号：显示时长行会被 splitByCells 切成几行，
  // 所以 DOM 行号 ≥ 原始行号。按显示时的切法重数一遍，数到第 k 个显示行时它在原始的第几行。
  // 不换算的话 (v1.83.34 之后) 复制面板会定位到错误的位置 —— 按 DOM 行号去原始文本里找，
  // 短会话直接越界到末尾 (看着像「直接出现最新记录」)，长会话指到别的地方 (按的字和显示的对不上)
  function domLineToTextLine(rawLines, cols, k) {
    if (!(cols > 0)) return k;
    let shown = 0;
    for (let i = 0; i < rawLines.length; i++) {
      const n = Math.max(1, splitByCells(rawLines[i], cols).length);
      if (shown + n > k) return i;
      shown += n;
    }
    return Math.max(0, rawLines.length - 1);
  }

  // 复制面板滚到原文第 k 行，有 anchorY (手指的位置) 就让这一行停在手指那个高度，否则停在最上面。
  // 长行切成几行显示：先换算成第几个显示行，再量它实际在哪 (中文 / emoji 的行可能高一点，不能按行高乘)。
  // 字体刚加载完位置还会变，所以过一会儿再对一次 (用户自己滑过就不动了)
  function scrollToLine(pre, k, anchorY) {
    const place = () => {
      // 面板关了 / 换了内容 / 用户已经自己滑了：不动
      if (pre._place !== place || $('#copyPanel').classList.contains('hidden') || pre.scrollTop !== pre._lineTop) return;
      pre.style.paddingBottom = '';
      const top = domLineTop(pre, textLineToDomLine(pre.lsText.split('\n'), pre.lsCols, k));
      const want = top - anchorOffset(pre, anchorY);
      // 靠近最后的行滚不到手指那么高：底下补一点空白
      const short = want - (pre.scrollHeight - pre.clientHeight);
      if (short > 0) pre.style.paddingBottom = parseFloat(getComputedStyle(pre).paddingBottom) + short + 'px';
      pre.scrollTop = want;
      pre._lineTop = pre.scrollTop;
    };
    pre._place = place;
    pre._lineTop = pre.scrollTop;
    place();
    requestAnimationFrame(place);
    setTimeout(place, 300);
    document.fonts?.ready.then(place);
  }

  // 原文第 k 行是第几个显示行 (domLineToTextLine 反过来)
  function textLineToDomLine(rawLines, cols, k) {
    if (!(cols > 0)) return k;
    let shown = 0;
    for (let i = 0; i < k && i < rawLines.length; i++) shown += Math.max(1, splitByCells(rawLines[i], cols).length);
    return shown;
  }

  // 第 d 个显示行的顶端在 pre 内容里的位置 (px，从内容最上面算)：按文字找到这一行的第一个字，量它在哪
  function domLineTop(pre, d) {
    const w = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    let n, seen = 0, node = null, off = 0;
    while ((n = w.nextNode())) {
      if (seen === d) { node = n; off = 0; break; }
      let i = -1;
      while (seen < d && (i = n.data.indexOf('\n', i + 1)) >= 0) seen++;
      if (seen === d && i >= 0) {
        if (i + 1 < n.data.length) { node = n; off = i + 1; break; }
      }
    }
    if (!node) return d ? pre.scrollHeight : 0;
    // 在行首临时放一个空的小标记量位置 (空行只有换行符，换行符本身量不出位置)
    const r = document.createRange(), mk = document.createElement('span');
    r.setStart(node, off); r.collapse(true); r.insertNode(mk);
    const top = mk.getBoundingClientRect().top;
    mk.remove();
    return top - pre.getBoundingClientRect().top - pre.clientTop + pre.scrollTop - parseFloat(getComputedStyle(pre).paddingTop);
  }

  // 这一行显示在复制面板顶部往下多少：手指的高度 (上面留一行、下面留两行)
  function anchorOffset(pre, y) {
    if (y == null) return 0;
    const lh = parseFloat(getComputedStyle(pre).lineHeight) || 18;
    const want = y - pre.getBoundingClientRect().top - pre.clientTop - parseFloat(getComputedStyle(pre).paddingTop) - lh / 2;
    return Math.max(0, Math.min(Math.max(want, lh), pre.clientHeight - 3 * lh));
  }

  // 历史视图里最上面那一行是第几行
  function firstVisibleLine(pre) {
    const r = pre.getBoundingClientRect();
    return lineAt(pre, r.left + 8, r.top + 4);
  }

  // 历史视图里 (x, y) 处是第几行 (长行会折行显示，所以按文字算，不按像素算)
  function lineAt(pre, x, y) {
    let node, off;
    if (document.caretRangeFromPoint) { const rg = document.caretRangeFromPoint(x, y); node = rg?.startContainer; off = rg?.startOffset; }
    else if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); node = p?.offsetNode; off = p?.offset; }
    if (!node || !pre.contains(node)) {
      const avg = pre.scrollHeight / Math.max(1, pre.textContent.split('\n').length);
      return Math.floor((pre.scrollTop + y - pre.getBoundingClientRect().top) / avg);
    }
    const range = document.createRange();
    range.setStart(pre, 0);
    range.setEnd(node, off);
    return (range.toString().match(/\n/g) || []).length;
  }

  // 苹果设备上复制面板打开期间不自动放大：手机上它是可编辑的 (见下面)，字是 12px，iPhone 聚焦小于 16px 的可编辑区域
  // 会把整个页面放大 (第一次长按就放大)。maximum-scale=1 在 iPhone / iPad 上只挡自动放大，双指照样能放大；
  // 安卓上它会连双指缩放一起关掉，所以只给苹果设备加
  const viewportMeta = document.querySelector('meta[name=viewport]'), viewportBase = viewportMeta?.content;
  const appleTouch = isTouch && /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
  function noAutoZoom(on) {
    if (!appleTouch || !viewportMeta) return;
    viewportMeta.content = on ? viewportBase + ', maximum-scale=1' : viewportBase;
  }

  function closeCopyPanel() {
    $('#copyPanel').classList.add('hidden');
    noAutoZoom(false);
    resetCopySel();
  }

  // 复制面板回到刚打开时的样子：取消选中、退出编辑。手机上它是可编辑的 (见下面)，选区和焦点留着的话
  // iPhone 上第二次长按就选不上；光取消、失焦还不够，iPhone 自己记着上一次选字的状态，
  // 先关掉「可编辑」、下一帧再打开，让它把那套状态也丢掉
  function resetCopySel() {
    const pre = $('#copyText');
    try { getSelection()?.removeAllRanges(); } catch {}
    pre.blur();
    if (!pre.isContentEditable) return;
    pre.contentEditable = 'false';
    requestAnimationFrame(() => { pre.contentEditable = 'true'; });
  }

  async function copyText(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    // HTTP 下没有剪贴板接口 (或剪贴板接口拒绝写入)，用临时文本框 + execCommand 复制。
    // 临时文本框会抢走焦点，删掉后焦点落到页面上 (下方输入框没了光标)：复制完还给原来的元素。
    // 要在这里还：接口被拒时这段在 await 之后才跑，调用方同步还焦点的代码早就跑完了
    const had = document.activeElement;
    const tmp = document.createElement('textarea');
    tmp.value = text;
    tmp.setAttribute('readonly', '');
    tmp.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
    document.body.appendChild(tmp);
    tmp.select();
    tmp.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    tmp.remove();
    if (had && had !== document.body && had.isConnected && document.activeElement !== had) had.focus({ preventScroll: true });
    return ok;
  }

  function copyToast(msg) {
    const t = $('#copyToast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t.timer);
    t.timer = setTimeout(() => t.classList.remove('show'), 1600);
  }

  // 手机上复制完复位 (见 resetCopySel)。等这一轮事件处理完再清 (系统菜单的「拷贝」要先把选中的字交出去)
  const copiedReset = () => { if (isTouch) setTimeout(resetCopySel); };
  $('#copyAll').addEventListener('click', async () => {
    const text = $('#copyText').lsText || '';
    copyToast(await copyText(text) ? `已复制全部 (${text.length} 个字符)` : '复制失败，请长按文字手动复制');
    copiedReset();
  });
  // 复制面板里选中的文字 (去掉切长行插进去的换行，同历史视图)；没选中返回空
  const panelSel = () => {
    const sel = getSelection();
    return sel?.rangeCount && !sel.isCollapsed && $('#copyText').contains(sel.getRangeAt(0).commonAncestorContainer) ? plainSel(sel) : '';
  };
  // 按下按钮时先记下选中的文字：有的手机点按钮会把选中取消掉，到 click 时已经没了
  let selAtPress = '';
  $('#copySel').addEventListener('pointerdown', () => { selAtPress = panelSel(); });
  $('#copySel').addEventListener('click', async () => {
    const text = panelSel() || selAtPress;
    selAtPress = '';
    if (!text) return copyToast('请先长按文字选择要复制的部分');
    const ok = await copyText(text);
    copyToast(ok ? `已复制 ${text.length} 个字符` : '复制失败，请长按文字手动复制');
    if (ok) copiedReset();
  });
  // 系统菜单的「拷贝」/ Ctrl+C：同上，去掉切长行插进去的换行
  $('#copyText').addEventListener('copy', (e) => {
    const text = panelSel();
    if (!text || !e.clipboardData) return;
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
    copiedReset();
  });
  $('#copyClose').addEventListener('click', closeCopyPanel);

  // 电脑上点面板外的暗色背景关掉。监听挂在 document 上，不挂在面板上 (不让面板里的字算成「能点的按钮」)
  document.addEventListener('mousedown', (e) => { if (e.target.id === 'copyPanel') closeCopyPanel(); });
  // 手机上复制面板是「可编辑、但不弹键盘、改不了」的：iPhone 对普通文字 (pre) 长按能选中，但不显示高亮、手柄和「拷贝」菜单，
  // 看着就是长按没反应 (v1.83.55 ~ 1.83.80；以前是文本框，走输入框那套选字，没这个问题)。可编辑的元素也走那一套。
  // 改内容的操作 (打字、删除、粘贴、剪切、拖放) 全拦下；万一还是被改了 (外接键盘组字拦不住)，照原样重排
  if (isTouch) {
    const pre = $('#copyText');
    pre.removeAttribute('tabindex');
    Object.assign(pre, { contentEditable: 'true', inputMode: 'none', spellcheck: false });
    pre.setAttribute('autocorrect', 'off');
    pre.setAttribute('autocapitalize', 'off');
    pre.addEventListener('beforeinput', (e) => e.preventDefault());
    for (const type of ['paste', 'drop']) pre.addEventListener(type, (e) => e.preventDefault());
    pre.addEventListener('cut', (e) => { // 当成复制 (同上面的 copy，去掉切长行插进去的换行)
      e.preventDefault();
      const text = panelSel();
      if (text && e.clipboardData) e.clipboardData.setData('text/plain', text);
      copiedReset();
    });
    pre.addEventListener('input', () => {
      const top = pre.scrollTop;
      pre._render?.();
      pre.scrollTop = top;
    });
    // 选着字 / 还在编辑时，轻点任何地方都复位 (面板里的字、标题、空白、面板外面都算)。只认轻点 (按得短、没挪)：
    // 长按选字、拖手柄、滑动都不算。「复制选中」「复制全部」除外：它们要用到选中的字，复制完自己复位。
    // 点在字上时拦下 iPhone 自己的处理 (放光标、弹菜单)，不然刚取消的选中又被它接着用
    let tapAt = null;
    document.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      tapAt = e.touches.length === 1 && !$('#copyPanel').classList.contains('hidden') ? { x: t.clientX, y: t.clientY, t: performance.now() } : null;
    }, { capture: true, passive: true });
    document.addEventListener('touchend', (e) => {
      const a = tapAt, t = e.changedTouches[0];
      tapAt = null;
      if (!a || !t || performance.now() - a.t > 350 || Math.hypot(t.clientX - a.x, t.clientY - a.y) > 10) return;
      if (e.target.closest?.('#copySel, #copyAll')) return;
      const sel = getSelection();
      const selected = sel?.rangeCount && !sel.isCollapsed && pre.contains(sel.anchorNode);
      if (!selected && document.activeElement !== pre) return;
      if (pre.contains(e.target)) e.preventDefault();
      resetCopySel();
    }, { capture: true, passive: false });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#copyPanel').classList.contains('hidden')) closeCopyPanel();
  });
