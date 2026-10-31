  // ------------------------------------------------------------ 按终端的格子排版 (历史视图、复制面板共用)
  // 每种字补成正好 1 / 2 格宽，长行在放得下的格数处切开，超宽的表格整张放进横滑条带；颜色序列 (SGR) 转成 HTML
  // 按终端的格子排一段带颜色的文字 (历史视图、复制面板共用)：每种字补成正好 1 / 2 格宽 (gridFit)，长行在放得下的格数处切开，
  // 超宽的表格整张放进横滑条带。pre 要先放进页面 (量字宽)；tc = 终端列数，cw = 一格本来多宽。
  // 返回切行的格数 cols、分好的块 chunks 和把一块转成元素的 block
  function gridView(pre, text, tc, cw, theme) {
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
    pre.style.overflowX = 'hidden'; // 整体不横滚：超宽的表格在自己的条带里左右滑 (见 block 的 .ls-tbl)，别的行都切到放得下
    // 表格条带滑到最右边就去掉右边缘的渐隐 (还有内容的提示)。复制面板的 pre 一直是同一个，只挂一次
    if (!pre.lsTblScroll) {
      pre.lsTblScroll = true;
      pre.addEventListener('scroll', (e) => {
        const t = e.target;
        if (t.classList?.contains('ls-tbl')) t.classList.toggle('more', t.scrollLeft + t.clientWidth < t.scrollWidth - 2);
      }, true);
    }
    // 几千行一次全塞进页面要卡一两秒：分成块，先放最后几块马上显示，前面的在后台一块块补到上面。
    // 块从最后往前切 (最前面那块不满)；块末尾的换行留着，textContent 和整段文字一样 (复制面板按它数行)
    const lines = text.split('\n'), chunks = [], g = sgrInit();
    for (let i = 0, end = lines.length % LS_CHUNK || LS_CHUNK; i < lines.length; end = i + LS_CHUNK) {
      // 表格 (连续带框线的行) 不拆到两块里：超宽的表格整张放进一个横滑的条带 (见 block)，拆开的两半各滑各的
      while (end > i + 1 && end < lines.length && BOX_RE.test(lines[end - 1]) && BOX_RE.test(lines[end])) end--;
      const t = lines.slice(i, end).join('\n') + (end < lines.length ? '\n' : '');
      chunks.push({ t, g: { ...g } }); // 这块开头的颜色 (接着上一块)
      sgrScan(t, g, pal);
      i = end;
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
      const rows = c.t.split('\n');
      for (let k = 0; k < rows.length; k++) {
        const raw = rows[k];
        // 比历史视图宽的表格 (连续带框线的行，有一行放不下)：整张表放进自己的横滑条带 (.ls-tbl)，手指按在表上才能左右滑，
        // 别的文字不动 (以前整个历史视图一起横滑，上下滑普通文字时手指稍斜一点就左右飘)。
        // 条带是块元素，自己就换行：最后一行后面的换行照样写上 (textContent 和原文一样，复制面板按它数行)，
        // 是这一块的最后一行就不写 (同下面去掉的那个)
        if (cols > 0 && BOX_RE.test(raw)) {
          let j = k;
          while (j < rows.length && BOX_RE.test(rows[j])) j++;
          if (rows.slice(k, j).some((r) => lineCells(r) > cols)) {
            html += '<div class="ls-tbl more">';
            for (let m = k; m < j; m++) html += ansiToHtml(rows[m], theme, fit, pal, g) + (m < rows.length - 1 ? '\n' : '');
            html += '</div>';
            k = j - 1;
            continue;
          }
        }
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
    return { cols, chunks, block };
  }

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
  // 英文统一补在整个视图上；返回其他要单独补的字 → 补多少 px。
  // 粗体单独量一遍 (同 xterm 的字宽缓存分粗细)：Windows 上中文粗体常是系统模拟加粗，每个字宽出 1px 左右，
  // 以前按常规体补，一行里几个粗体中文右边框就偏出去几像素
  function gridFit(pre, text, cw) {
    const chars = [...new Set(text.replace(ANSI_RE, '').match(/[^\x00-\x7f]/gu) || [])].filter(cellWidth);
    const measure = (style) => {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;letter-spacing:0';
      probe.innerHTML = `<span style="${style}">${'0'.repeat(100)}</span>` + chars.map((c) => `<span style="${style}">${esc(c)}</span>`).join('');
      pre.appendChild(probe);
      const w = [...probe.children].map((x) => x.getBoundingClientRect().width);
      probe.remove();
      const base = cw - w[0] / 100;
      const fix = new Map();
      chars.forEach((c, i) => {
        const d = cellWidth(c) * cw - w[i + 1];
        if (Math.abs(d - base) > 0.01) fix.set(c, d.toFixed(3));
      });
      return { fix, base };
    };
    const reg = measure('font-weight:normal');
    pre.style.letterSpacing = reg.base.toFixed(3) + 'px';
    // 粗体：只在历史里有粗体 (SGR 1) 时才量
    const bold = /\x1b\[(?:[0-9;]*;)?1(?:;[0-9;]*)?m/.test(text) ? measure('font-weight:bold') : reg;
    // base 一起返回：ASCII 每格固定用 base 的间距。以前 fitHtml 让 ASCII 沿用「上一个字符的间距」，
    // 中文后面的英文就继承了中文的 +2px，整行被拉宽 / 压窄（历史视图里中英混排的行看起来错位）
    return { fix: reg.fix, base: reg.base.toFixed(3), cell: cw, bold: { fix: bold.fix, base: bold.base.toFixed(3) } };
  }

  const BOX_RE = /[\u2500-\u257f]/;
  // 一行占几格 (颜色序列不算，FE0F 同 splitByCells)
  function lineCells(text) {
    let n = 0, prev = 0;
    for (const ch of text.replace(ANSI_RE, '')) {
      const w = ch === VS16 ? vs16Width(prev) : cellWidth(ch);
      n += w;
      if (w) prev = ch === VS16 ? 2 : w;
    }
    return n;
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
  // 复制面板按「显示行号」去原文里找行 (见 60-copy-panel.js 的 domLineToTextLine)，两边切法必须一致，
  // 不然行号系统性偏大，短会话直接越界落到最后一行 (看着像「直接出现最新记录」)，长会话指到别的行。
  // 顺带：以前正好切在转义序列中间会把 \x1b[36m 劈成两半，后半截 [36m 当普通文字画出来 (画面里多出 0m / 36m)
  //
  // 带框线字符 (│ ┌ ├ └ ─ 这些) 的行不切：表格比历史视图宽 (电脑上画的表格拿到手机上看) 时，切开的每一行都折成两三行，
  // 整张表错行看不出结构。保持一整行，放进横滑的条带里左右滑动看 (见 openLocalScroll 的 block)
  function splitByCells(text, cols) {
    if (BOX_RE.test(text)) return [{ text, cell: 0 }];
    const out = [];
    let cur = '', cells = 0, start = 0;
    // 普通文字逐字算格数；ANSI 序列整段原样带上、不算格数，也不会被切开
    let prev = 0; // 上一个字占几格 (后面跟 FE0F 时它变成两格，见 vs16Width)
    const put = (s) => {
      for (const ch of s) {
        const w = ch === VS16 ? vs16Width(prev) : cellWidth(ch);
        // FE0F 不和前面的字分开 (宁可这一行多出一格)
        if (w && ch !== VS16 && cells + w > cols) { out.push({ text: cur, cell: start }); cur = ''; cells = 0; start = 0; }
        cur += ch;
        cells += w;
        if (w) prev = ch === VS16 ? 2 : w;
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
  // FE0F (要求显示成彩色表情)：跟在一格宽的字后面 (⚠ ✔ ℹ 这类) 让它变成两格 —— 同实时画面的普通屏幕 (public/cellwidth.js)。
  // tmux 抓的历史里 ⚠️ 后面补的空格子服务器上已经去掉了 (见 lib/session/remote.js 的 dropVs16Pad)
  const VS16 = '\ufe0f';
  const vs16Width = (prev) => (prev === 1 ? 1 : 0);
  // 一个字在终端里占几格：和实时画面、服务器上的终端记录同一份规则 (public/cellwidth.js)
  const { cellWidth } = CellWidth;

  // 按 gridFit 量出来的结果，把要单独补宽度的字包起来；不占格的附加符号跟着前一个字。
  // ASCII (和 fix 里没有的字符) 一律用 base 的间距，不再沿用上一个字符的 —— 否则中文字符后面的英文
  // 会继承中文的间距，一行里越往右偏得越多
  //
  // 表情 (✅ 🔥 这类两格的，和后面跟着 FE0F 的 ⚠️ 等) 不靠量字宽补间距：装进 cell 宽 × 格数的小格子 (.ls-c)。
  // 表情的实际宽度各个浏览器、字体都不一样，iPhone 上量出来的和画出来的对不上，表格里带表情的行右边框就偏出去一格
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
          out += `<span class="ls-c" style="width:${((vs ? 2 : w) * cell).toFixed(3)}px">${esc(c + tail)}</span>`;
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
      const f = g.bold ? fit?.bold : fit;
      const h = fitHtml(t, f?.fix, f?.base, fit?.cell);
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
