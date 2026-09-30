  // ------------------------------------------------------------ 手机输入栏
  const mInput = $('#mInput');
  const dInput = $('#dInput');
  let termDirect = false; // 连按两下 Alt 进了终端直接打字：点终端时不把光标拉回下方输入框，光标回到输入框后恢复
  dInput.addEventListener('focus', () => { termDirect = false; });
  let deskOn = (() => { try { return localStorage.getItem('sshweb.deskInput') !== '0'; } catch { return true; } })();
  const mods = { shift: false, ctrl: false, alt: false };

  function focusTerm(s) {
    if (isTouch) return;
    if (deskOn) dInput.focus({ preventScroll: true });
    else s.term.focus();
  }

  function sendKeys(data) {
    if (active) send(active, { type: 'data', data });
  }

  function clearMods() {
    for (const k of Object.keys(mods)) setMod(k, false);
  }

  // 对输入的文字应用 Shift / Ctrl / Alt (一次性，用完自动取消)
  function applyMods(text) {
    if (!mods.shift && !mods.ctrl && !mods.alt) return text;
    let out = text;
    if (mods.shift && text.length === 1) out = out.toUpperCase();
    if (mods.ctrl && out.length === 1) {
      const c = out.toUpperCase().charCodeAt(0);
      if (c >= 64 && c <= 95) out = String.fromCharCode(c - 64); // Ctrl+A..Z [ \ ] ^ _
      else if (out === ' ') out = '\x00';
      else if (out === '?') out = '\x7f';
    }
    if (mods.alt) out = '\x1b' + out;
    clearMods();
    return out;
  }

  function setMod(name, on) {
    mods[name] = on;
    $(`#mobileBar [data-mod=${name}]`)?.classList.toggle('on', on);
  }

  // xterm 修饰键参数: 1 + Shift(1) + Alt(2) + Ctrl(4)
  const modParam = (md) => 1 + (md.shift ? 1 : 0) + (md.alt ? 2 : 0) + (md.ctrl ? 4 : 0);
  const CURSOR = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' };
  const TILDE = { pgup: 5, pgdn: 6, del: 3 };
  const FKEYS = {
    f1: '\x1bOP', f2: '\x1bOQ', f3: '\x1bOR', f4: '\x1bOS', f5: '\x1b[15~', f6: '\x1b[17~',
    f7: '\x1b[18~', f8: '\x1b[19~', f9: '\x1b[20~', f10: '\x1b[21~', f11: '\x1b[23~', f12: '\x1b[24~',
  };

  // 特殊键按下时生成要发送的字节 (含修饰键)；md 默认用手机按键栏的修饰键状态
  function keySeq(k, md = mods) {
    const m = modParam(md);
    let out;
    if (CURSOR[k]) {
      const c = CURSOR[k];
      if (m > 1) out = `\x1b[1;${m}${c}`;
      else if ('ABCD'.includes(c) && active && active.term.modes.applicationCursorKeysMode) out = '\x1bO' + c;
      else out = '\x1b[' + c;
    } else if (TILDE[k]) {
      out = m > 1 ? `\x1b[${TILDE[k]};${m}~` : `\x1b[${TILDE[k]}~`;
    } else if (k === 'tab') {
      out = md.shift ? '\x1b[Z' : '\t'; // Shift+Tab (反向 Tab，Claude Code 切换模式)
      if (md.alt) out = '\x1b' + out;
    } else if (k === 'esc') {
      out = '\x1b';
    } else if (k === 'bs') {
      out = md.alt ? '\x1b\x7f' : md.ctrl ? '\x08' : '\x7f';
    } else if (k === 'enter') {
      out = (md.alt ? '\x1b' : '') + '\r';
    } else if (k === 'escesc') {
      out = '\x1b\x1b'; // Claude Code: 连按两次 Esc 撤回 / 编辑上一条
    } else if (FKEYS[k]) {
      out = FKEYS[k];
    } else if (/^\^[a-z]$/.test(k)) {
      out = String.fromCharCode(k.charCodeAt(1) - 96); // ^A..^Z
    }
    if (md === mods) clearMods();
    return out;
  }

  // 手机输入栏和电脑输入栏逻辑一致：打字先在本地编辑，点 ↵ / 键盘「发送」才整段发给终端；
  // 空输入框里打 / 进入命令模式 (逐字发送，见 setCmdMode)，开着 Ctrl / Alt 时打的字也直接发送。
  // 输入框里常驻一个零宽字符作为「哨兵」：
  // 这样空输入框里按退格也会产生 input 事件，可以可靠地发送 ⌫
  const SENTINEL = '​';
  let composing = false;

  const mText = () => mInput.value.split(SENTINEL).join('');

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
    setMobileText('');
    if (!text) return;
    if (cmdMode) cmdMode.n += [...text].length;
    sendKeys(text); // 修饰键留给后面的按键
  }

  // 本地编辑的内容变化后：需要立即发送的情况就发送，否则只保存草稿
  function onMobileText() {
    const text = mText();
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
    if (text === '/' && active?.sid) { setCmdMode(true); return flushInput(); }
    if (active) active.draft = text;
  }

  mInput.addEventListener('focus', () => { if (!mInput.value.startsWith(SENTINEL)) setMobileText(mText()); });
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
    if (composing || e.isComposing) return;
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
    composing = false;
    mobileEnter();
  });

  function mobileEnter() {
    if (cmdMode) { flushInput(); setCmdMode(false); }
    const text = mText();
    setMobileText('');
    submitText(active, text);
  }

  // 按钮按下时不抢走输入框焦点，避免键盘收起
  $('#mobileBar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  $('#mobileBar .mkeys').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.a === 'kset') return openKeysEditor();
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
      if (plain && k === 'enter') return mobileEnter();
      // Esc、^C 等控制键不影响正在编辑的文字；其他键 (Tab 补全等) 先把文字发出去再发按键
      if (!['esc', 'escesc'].includes(k) && !/^\^/.test(k)) flushInput();
    }
    if (cmdMode && (['esc', 'escesc', 'enter', '^c'].includes(k) || (k === 'bs' && --cmdMode.n <= 0))) setCmdMode(false);
    if (b.dataset.seq != null) { clearMods(); return sendKeys(b.dataset.seq); }
    if (k === 'paste') {
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

