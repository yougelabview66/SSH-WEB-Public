  // ------------------------------------------------------------ 电脑输入栏
  // 打字先在本地输入框里编辑 (不走网络，没有回显延迟)，回车才整段发给终端；
  // 输入框为空时方向键 / Tab / 退格 / Ctrl+字母等直接发给终端，方便翻历史、补全、中断

  function autosizeDesk() {
    dInput.style.height = 'auto';
    const h = dInput.scrollHeight + 2;
    dInput.style.height = h + 'px';
    dInput.style.overflowY = h > dInput.clientHeight + 4 ? 'auto' : 'hidden'; // 到达最大高度才显示滚动条
    if (deskMode !== 'bottom') applyDeskPos(); // 输入栏变高后重新限制位置，不超出终端区域
  }
  // 窗口宽度变化后文字折行数会变，重新算高度
  window.addEventListener('resize', () => { if (deskOn) autosizeDesk(); });

  function setDeskText(text) {
    dInput.value = text;
    if (active) active.draft = text;
    autosizeDesk();
  }

  function deskSend() {
    const text = dInput.value;
    if (!active?.sid) return;
    setDeskText('');
    submitText(active, text);
  }

  // 把输入栏里编辑好的一段文字发给终端并回车 (电脑 / 手机输入栏共用)
  function submitText(s, text) {
    if (!s || !s.sid) return;
    if (!text) { beginCapture(s); send(s, { type: 'data', data: '\r' }); return; }
    let data = text.replace(/\r?\n/g, '\r');
    // 多行内容按粘贴发送 (Claude Code 等支持括号粘贴的程序不会把中间的换行当回车)
    if (data.includes('\r') && s.term.modes.bracketedPasteMode) data = '\x1b[200~' + data + '\x1b[201~';
    send(s, { type: 'data', data });
    // 文字和回车分开发，避免被当成一次粘贴而不提交；也等回显后再记历史
    setTimeout(() => { if (s.sid) { beginCapture(s); send(s, { type: 'data', data: '\r' }); } }, 50);
  }

  // 命令模式：空输入框里打 / 后，输入逐字直接发给终端，Claude Code 的 / 命令候选列表会在终端里弹出，
  // ↑ ↓ 选择、Tab 补全、Enter 执行；Enter / Esc / Ctrl+C 或退格删光后回到本地编辑
  let cmdMode = null; // { s: 所在标签, n: 已发出的字数 (退格删光时退出) }
  // 提示文字：一行放得下就用完整的，放不下换短的 (空输入框最低只有一行高，不让提示文字撑高)；再放不下就折行完整显示
  const DESK_PH = [dInput.placeholder, 'Enter 发送 · Shift+Enter 换行'];
  const CMD_PH = ['命令模式：直接输入到终端，Enter 执行，Esc 退出', '命令模式 · Enter 执行 · Esc 退出'];
  const phCtx = document.createElement('canvas').getContext('2d');
  function fitPlaceholder() {
    const list = cmdMode ? CMD_PH : DESK_PH;
    const cs = getComputedStyle(dInput);
    const room = dInput.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2;
    phCtx.font = cs.font;
    const ph = room > 0 ? list.find((t) => phCtx.measureText(t).width <= room) || list.at(-1) : list[0];
    if (dInput.placeholder !== ph) dInput.placeholder = ph;
  }
  // 宽度变了 (窗口大小、侧边栏开关)：重新挑提示文字、重新算高度
  let dInputW = 0;
  new ResizeObserver(() => {
    if (dInput.clientWidth === dInputW) return;
    dInputW = dInput.clientWidth;
    fitPlaceholder();
    autosizeDesk();
  }).observe(dInput);

  function setCmdMode(on) {
    cmdMode = on ? { s: active, n: 0 } : null;
    $('#deskBar').classList.toggle('cmd', on);
    $('#mobileBar').classList.toggle('cmd', on);
    fitPlaceholder();
  }

  function flushCmd() {
    const text = dInput.value;
    if (!cmdMode || !text) return;
    setDeskText('');
    cmdMode.n += [...text].length;
    sendKeys(text);
  }

  function cmdEnter() {
    flushCmd();
    setCmdMode(false);
    if (active) beginCapture(active);
    sendKeys('\r');
  }

  const DESK_KEYS = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Home: 'home', End: 'end',
    PageUp: 'pgup', PageDown: 'pgdn', Tab: 'tab', Backspace: 'bs', Delete: 'del',
  };

  // tmux 前缀键：Ctrl+B 和紧跟着的下一个键一起发给 tmux (Ctrl+B D 断开、Ctrl+B C 新窗口、Ctrl+B 方向键…)，
  // 不管输入框里有没有字；不然下一个键会变成输入框里的字，tmux 等不到
  let tmuxPrefix = false;
  function prefixKeySeq(e) {
    const md = { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey };
    if (DESK_KEYS[e.key]) return keySeq(DESK_KEYS[e.key], md);
    if (e.ctrlKey && /^Key[A-Z]$/.test(e.code)) return String.fromCharCode(e.code.charCodeAt(3) - 64);
    if (e.key === 'Enter') return '\r';
    if (e.key === 'Escape') return '\x1b';
    if (e.key.length === 1) return e.key;
    return '';
  }
  dInput.addEventListener('blur', () => { tmuxPrefix = false; });

  dInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // 输入法选字中
    if (active && tmuxPrefix) {
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return; // 只按了修饰键：继续等下一个键
      tmuxPrefix = false;
      const seq = prefixKeySeq(e);
      if (seq) { e.preventDefault(); sendKeys(seq); }
      return;
    }
    if (active && e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && e.code === 'KeyB') {
      e.preventDefault();
      sendKeys('\x02');
      tmuxPrefix = true;
      return;
    }
    if (cmdMode) {
      if (e.key === 'Enter') { e.preventDefault(); return cmdEnter(); }
      if (e.key === 'Escape' || (e.ctrlKey && e.code === 'KeyC')) setCmdMode(false); // 照常发给终端
      else if (e.key === 'Backspace' && --cmdMode.n <= 0) setCmdMode(false);
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      return deskSend();
    }
    if (!active || e.metaKey) return;
    const md = { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey };
    // Esc 随时发给终端 (如打断 Claude Code)，不影响正在编辑的文字
    if (e.key === 'Escape') { e.preventDefault(); return sendKeys(md.alt ? '\x1b\x1b' : '\x1b'); }
    if (dInput.value) {
      if (e.key === 'Tab') e.preventDefault(); // 有文字时 Tab 不跳走焦点
      return;
    }
    let seq;
    if (DESK_KEYS[e.key]) seq = keySeq(DESK_KEYS[e.key], md);
    else if (e.ctrlKey && !e.altKey && /^Key[A-Z]$/.test(e.code) && e.code !== 'KeyV') {
      seq = String.fromCharCode(e.code.charCodeAt(3) - 64); // Ctrl+C / Ctrl+D / Ctrl+R …
    }
    if (seq) { e.preventDefault(); sendKeys(seq); }
  });
  dInput.addEventListener('input', (e) => {
    if (!e.isComposing && active?.sid) {
      if (cmdMode) return flushCmd();
      if (dInput.value === '/') { setCmdMode(true); return flushCmd(); }
    }
    if (active) active.draft = dInput.value;
    autosizeDesk();
  });
  dInput.addEventListener('compositionend', () => flushCmd()); // 命令参数里的中文上屏后发送
  $('#dSend').addEventListener('click', () => { if (cmdMode) cmdEnter(); else deskSend(); dInput.focus(); });
  $('#dHide').addEventListener('click', () => setDeskOn(false));
  $('#btnInput').addEventListener('click', () => setDeskOn(!deskOn));

  // 输入栏模式：底部 / 浮动 (盖在终端上，拖左边的把手上下调整位置)；
  // 每个标签各自记住模式、浮动位置和高度 (按会话 ID)，没设置过的标签用最近一次选的模式 / 拖到的位置 / 高度；
  // 位置 = 距 main 底部占 main 高度的比例，每台电脑各自记住
  const DESK_MODES = { bottom: '底部', float: '浮动' };
  const loadJson = (k) => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } };
  // 以前的「抬高」模式已去掉，当作底部
  let deskModeDef = (() => { try { return localStorage.getItem('sshweb.deskMode') === 'float' ? 'float' : 'bottom'; } catch { return 'bottom'; } })();
  let deskMode = deskModeDef;
  const deskModes = loadJson('sshweb.deskModes');
  let deskLift = (() => { try { const v = parseFloat(localStorage.getItem('sshweb.deskLift')); return v >= 0 && v < 1 ? v : 1 / 3; } catch { return 1 / 3; } })();
  const floatLift = loadJson('sshweb.floatLift');
  const liftFrac = () => (active?.remoteId && floatLift[active.remoteId] != null ? floatLift[active.remoteId] : deskLift);
  const deskBar = $('#deskBar');

  // 切到别的标签：换成那个标签的模式
  function syncDeskMode() {
    const m = active?.remoteId && deskModes[active.remoteId];
    deskMode = DESK_MODES[m] ? m : deskModeDef;
  }

  // 按比例算出像素值，并限制在允许范围内 (窗口变小时自动收回)
  function deskLiftPx() {
    const mainH = deskBar.parentElement.clientHeight;
    const max = mainH - $('#tabbar').offsetHeight - deskBar.offsetHeight;
    return Math.round(Math.max(0, Math.min(liftFrac() * mainH, max)));
  }

  function applyDeskPos() {
    const shown = !deskBar.classList.contains('hidden');
    for (const m of Object.keys(DESK_MODES)) deskBar.classList.toggle(m, m === deskMode);
    $('#dMode').textContent = DESK_MODES[deskMode];
    if (!shown || deskMode === 'bottom') { deskBar.style.bottom = ''; return; }
    deskBar.style.bottom = deskLiftPx() + 'px';
  }

  // main 的高度变了 (窗口大小、手机键盘调整的 #app 高度) 就重新按比例算位置；
  // 不用 window resize：那时 visualViewport 还没把 #app 调到新高度
  new ResizeObserver(() => applyDeskPos()).observe(deskBar.parentElement);

  function saveDeskPos() {
    try {
      localStorage.setItem('sshweb.deskMode', deskModeDef);
      localStorage.setItem('sshweb.deskModes', JSON.stringify(deskModes));
      localStorage.setItem('sshweb.deskLift', String(deskLift));
      localStorage.setItem('sshweb.deskH', String(deskHDef));
      localStorage.setItem('sshweb.deskHs', JSON.stringify(deskHs));
      localStorage.setItem('sshweb.floatLift', JSON.stringify(floatLift));
    } catch {}
  }

  $('#dMode').addEventListener('click', () => {
    deskMode = deskModeDef = deskMode === 'float' ? 'bottom' : 'float';
    if (active?.remoteId) deskModes[active.remoteId] = deskMode;
    saveDeskPos();
    applyDeskPos();
    updateHostFloat();
    dInput.focus();
  });

