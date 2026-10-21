  // ------------------------------------------------------------ 终端里搜索
  // Ctrl+Shift+F (终端里 Ctrl+F 留给程序：bash 光标右移、vim 翻页) 或「⋯ 更多 → 搜索终端」。
  // 普通终端搜终端自己的滚动记录；tmux 里终端只有当前一屏，历史在 tmux 手里：先像往上滚一样打开历史视图
  // (抓 3000 行，见 55-local-scroll.js)，在历史视图里搜。打字时不搜 (输入法组字会被打断)，按回车或点「搜索」才搜；
  // 搜过之后回车 = 上一个 (往旧的找)，Shift+回车 = 下一个，Esc 关闭
  let ts = null; // { s, el, input, info, matches, cur, mode: 'term' | 'view' }

  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.code !== 'KeyF') return;
    if (!active || document.querySelector('.overlay:not(.hidden)')) return;
    e.preventDefault();
    e.stopPropagation();
    openTermSearch(active);
  }, true);
  $('#btnSearch').addEventListener('click', () => { if (active) openTermSearch(active); });

  function openTermSearch(s) {
    if (ts && ts.s === s) { ts.input.focus(); ts.input.select(); return; }
    closeTermSearch();
    const el = document.createElement('div');
    el.className = 'tsearch';
    el.innerHTML = `<input type="text" placeholder="搜索终端…" enterkeyhint="search" spellcheck="false" autocomplete="off" autocapitalize="off">
      <button type="button" data-a="go" class="primary" title="搜索 (回车)">搜索</button>
      <span class="ts-info"></span>
      <button type="button" data-a="prev" title="上一个 (回车)">↑</button>
      <button type="button" data-a="next" title="下一个 (Shift+回车)">↓</button>
      <button type="button" data-a="close" title="关闭 (Esc)">×</button>`;
    s.box.appendChild(el);
    ts = { s, el, input: $('input', el), info: $('.ts-info', el), matches: [], cur: -1, mode: 'term', dirty: true };
    const { input } = ts;
    // 改了搜索词：清掉上次的结果提示，等回车 / 「搜索」
    let composing = false;
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => { composing = false; });
    input.addEventListener('input', () => {
      if (!ts) return;
      ts.dirty = true;
      ts.info.textContent = '';
      ts.el.classList.remove('none');
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.isComposing || composing || e.keyCode === 229)) { e.stopPropagation(); return; } // 回车是在选字
      if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? 1 : -1); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeTermSearch(); }
      e.stopPropagation(); // 打的字只进搜索框，不算在终端里打字 (历史视图里打字会回到实时画面)
    });
    el.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); }); // 焦点留在搜索框
    el.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'go') runSearch(true);
      else if (a === 'prev') go(-1);
      else if (a === 'next') go(1);
      else if (a === 'close') closeTermSearch();
    });
    // tmux 里：打开历史视图再搜 (同往上滚的第一下)
    const b = s.term.buffer.active;
    if (!s.scrollView && s.sid && b.type === 'alternate' && s.term.modes.mouseTrackingMode !== 'none' && !(s.noTmuxUntil > Date.now()) && !s.scrollLoading) {
      s.scrollLoading = true;
      s.heldWheel = 1;
      send(s, { type: 'tmux-history', lines: LS_LINES });
      s.lsTimer = setTimeout(() => onTmuxHistory(s, { ok: false, reason: 'timeout' }), 4000);
      ts.info.textContent = '正在取历史…';
      ts.wait = setInterval(() => {
        if (!ts || ts.s !== s) return;
        if (s.scrollLoading) return;
        clearInterval(ts.wait);
        runSearch(true);
      }, 150);
    }
    input.focus({ preventScroll: true });
  }

  // 历史视图里标出匹配：搜索框有焦点时用 CSS 高亮 (改选区会把焦点 / 输入法组的字从搜索框里抢走)，没有这个接口的浏览器才用选中
  const canHL = !!(window.CSS && CSS.highlights && window.Highlight);
  function markView(range) {
    if (canHL) CSS.highlights.delete('tsearch');
    if (!range) return;
    if (canHL && document.activeElement === ts?.input) { CSS.highlights.set('tsearch', new Highlight(range)); return; }
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function closeTermSearch() {
    if (!ts) return;
    clearInterval(ts.wait);
    ts.el.remove();
    if (canHL) CSS.highlights.delete('tsearch');
    if (ts.mode === 'term') ts.s.term.clearSelection();
    else getSelection()?.removeAllRanges();
    const s = ts.s;
    ts = null;
    if (s === active) {
      if (s.scrollView) s.scrollView.querySelector('.ls-body')?.focus({ preventScroll: true });
      else focusTerm(s);
    }
  }

  // 回车 / ↑↓：搜索词改过 (还没搜) 就先搜，搜过了就跳到上一个 / 下一个
  function go(d) {
    if (!ts) return;
    if (ts.dirty) runSearch(true);
    else step(d);
  }

  // fresh：搜索词变了，从最新 (最下面) 的一个开始
  function runSearch(fresh) {
    if (!ts) return;
    const q = ts.input.value;
    ts.dirty = false;
    const s = ts.s;
    ts.mode = s.scrollView ? 'view' : 'term';
    ts.matches = q ? (ts.mode === 'view' ? viewMatches(s, q) : termMatches(s.term, q)) : [];
    if (fresh || ts.cur >= ts.matches.length) ts.cur = ts.matches.length - 1;
    show();
  }

  function step(d) {
    if (!ts) return;
    const want = ts.s.scrollView ? 'view' : 'term';
    if (want !== ts.mode || !ts.matches.length) return runSearch(true); // 历史视图开了 / 关了：重新搜
    ts.cur = (ts.cur + d + ts.matches.length) % ts.matches.length;
    show();
  }

  function show() {
    const { matches, cur, s } = ts;
    const alt = ts.mode === 'term' && s.term.buffer.active.type === 'alternate';
    ts.info.textContent = ts.input.value ? (matches.length ? `${cur + 1}/${matches.length}` : '没找到') + (alt ? ' · 只搜当前一屏' : '') : '';
    ts.el.classList.toggle('none', !!ts.input.value && !matches.length);
    if (cur < 0) { if (ts.mode === 'term') s.term.clearSelection(); else markView(null); return; }
    const m = matches[cur];
    if (ts.mode === 'term') {
      s.term.select(m.col, m.row, m.len);
      s.term.scrollToLine(Math.max(0, m.row - Math.floor(s.term.rows / 2)));
    } else {
      markView(m.range);
      const pre = s.scrollView.querySelector('.ls-body');
      const r = m.range.getBoundingClientRect(), pr = pre.getBoundingClientRect();
      pre.scrollTop += r.top - pr.top - pre.clientHeight / 2;
    }
  }

  // 终端滚动记录里的匹配：按逻辑行 (折行的接起来) 找，不分大小写；位置换成格子 (中文占两格)
  function termMatches(term, q) {
    const b = term.buffer.active, cols = term.cols, out = [], ql = q.toLowerCase();
    const cell = b.getNullCell();
    for (let y = 0; y < b.length;) {
      let n = 1;
      while (y + n < b.length && b.getLine(y + n)?.isWrapped) n++;
      let str = '';
      const pos = []; // 每个字符 (UTF-16 单元) → [行, 列, 宽]
      for (let r = y; r < y + n; r++) {
        const line = b.getLine(r);
        if (!line) continue;
        for (let x = 0; x < cols; x++) {
          if (!line.getCell(x, cell)) break;
          const w = cell.getWidth();
          if (!w) continue; // 宽字符的后半格
          const ch = cell.getChars() || ' ';
          for (let k = 0; k < ch.length; k++) pos.push([r, x, w]);
          str += ch;
        }
      }
      const low = str.toLowerCase();
      for (let i = low.indexOf(ql); i >= 0 && ql; i = low.indexOf(ql, i + 1)) {
        const a = pos[i], z = pos[i + ql.length - 1];
        if (!a || !z) continue;
        out.push({ row: a[0], col: a[1], len: (z[0] - a[0]) * cols + z[1] + z[2] - a[1] });
      }
      y += n;
    }
    return out;
  }

  // 历史视图里的匹配：先把还没补进页面的历史补完，再在文字里找，每个匹配是一个 Range
  function viewMatches(s, q) {
    const v = s.scrollView;
    v.lsRest?.();
    const pre = v.querySelector('.ls-body');
    const nodes = [];
    let text = '';
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) { nodes.push([n, text.length]); text += n.data; }
    const low = text.toLowerCase(), ql = q.toLowerCase(), out = [];
    const at = (off) => { // 文字位置 → [节点, 节点里的位置] (二分)
      let lo = 0, hi = nodes.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (nodes[mid][1] <= off) lo = mid; else hi = mid - 1; }
      return [nodes[lo][0], off - nodes[lo][1]];
    };
    for (let i = low.indexOf(ql); i >= 0 && ql && nodes.length; i = low.indexOf(ql, i + 1)) {
      const r = document.createRange();
      r.setStart(...at(i));
      const [en, eo] = at(i + ql.length - 1);
      r.setEnd(en, eo + 1);
      out.push({ range: r });
    }
    return out;
  }
