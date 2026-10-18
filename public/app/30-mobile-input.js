  // ------------------------------------------------------------ 手机输入栏
  const mInput = $('#mInput');
  // 手机输入框是可编辑的 div (contenteditable)，不是 <textarea>：手机浏览器和系统的密码管理会在
  // 每个表单输入框弹键盘时，在输入法上方加一条「密码填充」栏 (autocomplete="off" 也挡不住)，
  // 可编辑的 div 不算表单输入框。这里给它补上 textarea 的 value / selectionStart / selectionEnd /
  // setSelectionRange / select，下面的逻辑照旧当 textarea 用
  makeTextbox(mInput);

  function makeTextbox(el) {
    // 不支持 plaintext-only 的浏览器 (旧 Firefox) 用 true，粘贴时自己只插纯文字
    if (el.contentEditable !== 'plaintext-only') {
      el.contentEditable = 'true';
      el.addEventListener('paste', (e) => {
        e.preventDefault();
        document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
      });
    }
    // 纯文字：文字节点；<br>、块元素 (浏览器自己插入的) 算换行；最后那个 <br> 只是让空的最后一行有高度
    const textOf = (root) => {
      let out = '';
      const walk = (node) => {
        for (let n = node.firstChild; n; n = n.nextSibling) {
          if (n.nodeType === Node.TEXT_NODE) out += n.data;
          else if (n.nodeName === 'BR') { if (n !== root.lastChild || root !== el) out += '\n'; }
          else {
            if ((n.nodeName === 'DIV' || n.nodeName === 'P') && out && !out.endsWith('\n')) out += '\n';
            walk(n);
          }
        }
      };
      walk(root);
      return out;
    };
    // 选区在文字里的位置；不在输入框里时用最后一次的 (同 textarea 失去焦点后还记得光标)
    let last = [0, 0];
    const offsets = () => {
      const sel = getSelection();
      if (!sel?.rangeCount) return null;
      const r = sel.getRangeAt(0);
      if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null;
      const pre = document.createRange();
      pre.selectNodeContents(el);
      pre.setEnd(r.startContainer, r.startOffset);
      const a = textOf(pre.cloneContents()).length;
      pre.setEnd(r.endContainer, r.endOffset);
      return (last = [a, textOf(pre.cloneContents()).length]);
    };
    document.addEventListener('selectionchange', offsets);
    // 文字位置 → DOM 位置
    const point = (pos) => {
      let left = pos;
      const find = (node) => {
        for (let n = node.firstChild; n; n = n.nextSibling) {
          if (n.nodeType === Node.TEXT_NODE) {
            if (left <= n.data.length) return [n, left];
            left -= n.data.length;
          } else if (n.nodeName === 'BR') {
            if (left === 0) return [node, [...node.childNodes].indexOf(n)];
            left -= 1;
          } else {
            const p = find(n);
            if (p) return p;
          }
        }
        return null;
      };
      return find(el) || [el, el.childNodes.length];
    };
    const select = (a, b) => {
      const sel = getSelection();
      if (!sel) return;
      const r = document.createRange();
      r.setStart(...point(a));
      r.setEnd(...point(Math.max(a, b)));
      sel.removeAllRanges();
      sel.addRange(r);
      last = [a, Math.max(a, b)];
    };
    const syncEmpty = () => el.classList.toggle('empty', !textOf(el).replace(/\u200b/g, ''));
    el.addEventListener('input', syncEmpty);
    Object.defineProperties(el, {
      value: {
        get: () => textOf(el),
        set: (v) => {
          el.textContent = v;
          if (v.endsWith('\n')) el.appendChild(document.createElement('br')); // 显示出最后的空行
          last = [v.length, v.length];
          if (document.activeElement === el) select(v.length, v.length);
          syncEmpty();
        },
      },
      selectionStart: { get: () => (offsets() || last)[0] },
      selectionEnd: { get: () => (offsets() || last)[1] },
      setSelectionRange: { value: (a, b) => (document.activeElement === el ? select(a, b) : (last = [a, b])) },
      select: { value: () => { el.focus({ preventScroll: true }); select(0, textOf(el).length); } },
    });
    // 聚焦时光标回到上次的位置 (可编辑的 div 默认放在最前面)，点到哪里就以点的位置为准
    el.addEventListener('focus', () => { if (!offsets()) select(...last); });
    syncEmpty();
  }

  // 手机输入栏和电脑输入栏逻辑一致：打字先在本地编辑，点 ↵ / 键盘「发送」才整段发给终端；
  // 空输入框里打 / 进入命令模式 (逐字发送，见 setCmdMode)，开着 Ctrl / Alt 时打的字也直接发送。
  // 输入框里常驻一个零宽字符作为「哨兵」：
  // 这样空输入框里按退格也会产生 input 事件，可以可靠地发送 ⌫
  const SENTINEL = '​';
  let composing = false;

  const mText = () => mInput.value.split(SENTINEL).join('');
  // 光标不停在哨兵前面 (点输入框最左边时可编辑的 div 会把光标放在那里，打的字就跑到哨兵前面了)
  document.addEventListener('selectionchange', () => {
    if (document.activeElement !== mInput || composing) return;
    if (mInput.selectionStart === 0 && mInput.selectionEnd === 0 && mInput.value.startsWith(SENTINEL)) mInput.setSelectionRange(1, 1);
  });

  function setMobileText(text, caret = text.length) {
    mInput.value = SENTINEL + text;
    try { mInput.setSelectionRange(caret + 1, caret + 1); } catch {}
    if (active) active.draft = text;
    autosizeMobile();
  }

  // 文字满一行自动换行、输入框变高 (最高 30vh，再多在框里滚动)
  function autosizeMobile() {
    mInput.style.height = 'auto';
    const h = mInput.scrollHeight + 2;
    mInput.style.height = h + 'px';
    mInput.style.overflowY = h > mInput.clientHeight + 4 ? 'auto' : 'hidden';
  }
  window.addEventListener('resize', () => { if (isTouch) autosizeMobile(); });
  const resetInput = () => setMobileText('');

  // 把输入框里的文字立即发给终端并清空 (命令模式、修饰键，或按特殊键前保持先后顺序)
  function flushInput() {
    const text = mText();
    if (text && inputLocked(active)) return; // 别的设备在用：字留在输入框里
    setMobileText('');
    if (!text) return;
    if (cmdMode) cmdMode.n += [...text].length;
    sendKeys(text); // 修饰键留给后面的按键
  }

  // 本地编辑的内容变化后：需要立即发送的情况就发送，否则只保存草稿
  function onMobileText() {
    const text = mText();
    if (isReinsert(text)) return setMobileText('');
    if (mods.ctrl || mods.alt) {
      // 开着 Ctrl / Alt：只把新打的字按组合键发出去 (如 Ctrl + c = ^C)，输入框里原来的文字不动
      const prev = active?.draft || '';
      let p = 0, q = 0;
      while (p < prev.length && p < text.length && prev[p] === text[p]) p++;
      while (q < prev.length - p && q < text.length - p && prev[prev.length - 1 - q] === text[text.length - 1 - q]) q++;
      const typed = text.slice(p, text.length - q);
      setMobileText(prev, p);
      if (typed) {
        if (cmdMode) cmdMode.n += [...typed].length;
        sendKeys(applyMods(typed));
      }
      return;
    }
    if (cmdMode) return flushInput();
    if (text === '/' && active?.sid && !isLocked(active)) { setCmdMode(true); return flushInput(); }
    if (active) active.draft = text;
  }

  mInput.addEventListener('focus', () => { if (!mInput.value.startsWith(SENTINEL)) setMobileText(mText()); });
  // 安卓上按返回键 / 输入法的收起键只把键盘收起来，焦点还留在输入框里：之后点 ↵ (选 CLI 的选项)、方向键等，
  // 浏览器又把键盘弹出来。所以看到键盘收起 (宽度不变、可视高度比聚焦以来最矮时高出一截) 就让输入框失去焦点，
  // 要打字再点输入框或终端。没有屏幕键盘 (实体键盘) 时高度不变，不受影响
  const viewH = () => Math.min(innerHeight, window.visualViewport?.height ?? innerHeight);
  let kbLow = null; // 输入框聚焦以来最矮的可视高度 (键盘开着时的高度)
  mInput.addEventListener('focus', () => { kbLow = { w: innerWidth, h: viewH() }; });
  function checkKeyboardClosed() {
    if (!isTouch || !kbLow || document.activeElement !== mInput) return;
    const h = viewH();
    if (innerWidth !== kbLow.w) kbLow = { w: innerWidth, h }; // 转屏：重新量
    else if (h < kbLow.h) kbLow.h = h;
    else if (h - kbLow.h > 150) mInput.blur();
  }
  window.addEventListener('resize', checkKeyboardClosed);
  window.visualViewport?.addEventListener('resize', checkKeyboardClosed);
  // 浏览器漏报可视区域变化时，点按钮前再量一次
  document.addEventListener('pointerdown', checkKeyboardClosed, true);
  mInput.addEventListener('compositionstart', () => { composing = true; });
  // 中文 / 联想输入：上屏后再处理
  mInput.addEventListener('compositionend', () => {
    composing = false;
    onMobileText();
  });
  // 键盘上的「发送」(textarea 里默认是换行) 和实体键盘的回车 = 发送；Shift+回车才换行
  let shiftEnter = false; // 实体键盘 Shift+回车：放行换行
  mInput.addEventListener('beforeinput', (e) => {
    if (shiftEnter) return; // 放行，input 里再清掉标记
    if ((e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') && !composing) {
      e.preventDefault();
      mobileEnter();
    }
  });
  mInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.shiftKey) { shiftEnter = true; return; }
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); mobileEnter(); }
  });
  mInput.addEventListener('input', (e) => {
    if (composing || e.isComposing) {
      // 输入法把刚发出去的字当成组字又填回来：结束组字，上屏后删掉
      if (isReinsert(mText())) { endComposition(); setMobileText(''); }
      return;
    }
    // 个别输入法的「发送」没有先经过 beforeinput：换行已经插进去了，删掉再发送
    if (shiftEnter && (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph')) shiftEnter = false; // Shift+回车：保留换行
    else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
      const at = mInput.selectionStart;
      if (mInput.value[at - 1] === '\n') mInput.value = mInput.value.slice(0, at - 1) + mInput.value.slice(at);
      return mobileEnter();
    }
    autosizeMobile();
    if (!mInput.value.startsWith(SENTINEL)) {
      // 哨兵被删掉 = 在输入框最前面按了退格：空输入框就发 ⌫ 给终端，有文字就什么都不删
      const rest = mText();
      if (!rest) {
        const had = active?.draft;
        resetInput();
        if (had) return; // 选中文字后删除，只是清空输入框
        if (cmdMode && --cmdMode.n <= 0) setCmdMode(false);
        return sendKeys('\x7f');
      }
      setMobileText(rest, 0);
    }
    onMobileText();
  });
  $('#mForm').addEventListener('submit', (e) => {
    e.preventDefault();
    mobileEnter();
  });

  // 输入法还在组字 (手机输入法正在打的那个英文词、中文拼音选字) 时点 ↵ / 按键栏：先让输入法把字上屏、结束组字。
  // 不然发出去、清空输入框后，输入法还记着这段字，接着又把它填回输入框 (CLI 里有了，输入框里还留着)。
  // 输入框离开再回来，浏览器会把正在组的字上屏，输入法也会丢掉它记着的字
  let reinsert = null; // 组字中发出去的那段字：输入法要是还把它填回来 (马上就会)，删掉
  // 只看发出去后的第一次输入 (输入法填回来是紧跟着的)，之后打的字不管
  const isReinsert = (text) => {
    const r = reinsert;
    reinsert = null;
    return !!(r && text && Date.now() - r.at < 500 && r.text.endsWith(text));
  };
  function endComposition() {
    const was = composing;
    composing = false;
    if (!was || document.activeElement !== mInput) return;
    mInput.blur();
    mInput.focus({ preventScroll: true });
    return true;
  }

  function mobileEnter(ended = false) {
    if (inputLocked(active)) return; // 别的设备在用：字留在输入框里，接管后再发
    const wasComposing = endComposition() || ended;
    if (cmdMode) { flushInput(); setCmdMode(false); }
    const text = mText();
    setMobileText('');
    submitText(active, text);
    reinsert = wasComposing && text ? { text, at: Date.now() } : null;
  }

  // 按钮按下时不抢走输入框焦点，避免键盘收起
  $('#mobileBar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  $('#mobileBar .mkeys').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.a === 'kset') return openKeysEditor();
    const ended = endComposition();
    if (b.dataset.mod) return setMod(b.dataset.mod, !mods[b.dataset.mod]);
    if (b.dataset.t) {
      // | / - ~ 等字符键：和键盘打字一样先放进输入框
      const t = mods.shift ? b.dataset.t.toUpperCase() : b.dataset.t;
      if (mods.shift) setMod('shift', false);
      const v = mText(), at = Math.max(0, (mInput.selectionStart ?? v.length + 1) - 1);
      setMobileText(v.slice(0, at) + t + v.slice(at), at + t.length);
      return onMobileText();
    }
    const k = b.dataset.k;
    if (k === 'history') return openHistory();
    if (k === 'copy') return openCopyPanel(active);
    const text = mText();
    if (text) {
      const plain = !mods.shift && !mods.ctrl && !mods.alt;
      const at = Math.max(0, (mInput.selectionStart ?? text.length + 1) - 1);
      // 输入框有文字时 ⌫ ← → Home End 编辑输入框；回车 = 发送
      if (plain && k === 'bs') return at > 0 && setMobileText(text.slice(0, at - 1) + text.slice(at), at - 1);
      if (plain && CARET[k]) return setMobileText(text, CARET[k](at, text.length));
      if (plain && k === 'enter') return mobileEnter(ended);
      // Esc、^C 等控制键不影响正在编辑的文字；其他键 (Tab 补全等) 先把文字发出去再发按键
      if (!['esc', 'escesc'].includes(k) && !/^\^/.test(k)) {
        flushInput();
        if (ended) reinsert = { text, at: Date.now() };
      }
    }
    if (cmdMode && (['esc', 'escesc', 'enter', '^c'].includes(k) || (k === 'bs' && --cmdMode.n <= 0))) setCmdMode(false);
    if (b.dataset.seq != null) { clearMods(); return sendKeys(b.dataset.seq); }
    if (k === 'paste') {
      if (inputLocked(active)) return; // 别的设备在用：不弹粘贴框 (粘贴的内容也发不出去)
      let text = '';
      try { text = await navigator.clipboard.readText(); } catch {}
      if (!text) text = prompt('粘贴内容（浏览器不允许直接读取剪贴板时在这里粘贴）：') || '';
      if (text) sendKeys(text);
      return;
    }
    const seq = keySeq(k);
    if (seq) sendKeys(seq);
  });

  const CARET = {
    left: (at) => Math.max(0, at - 1), right: (at, n) => Math.min(n, at + 1),
    home: () => 0, end: (at, n) => n,
  };
