  // ------------------------------------------------------------ 输入栏共用：下方输入框开关、光标去哪、修饰键、特殊键的字节序列
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
