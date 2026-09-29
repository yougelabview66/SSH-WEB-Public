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
  const DESK_PH = dInput.placeholder;

  function setCmdMode(on) {
    cmdMode = on ? { s: active, n: 0 } : null;
    $('#deskBar').classList.toggle('cmd', on);
    $('#mobileBar').classList.toggle('cmd', on);
    dInput.placeholder = on ? '命令模式：直接输入到终端，Enter 执行，Esc 退出' : DESK_PH;
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

  dInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // 输入法选字中
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

  // 输入栏位置：底部 / 抬高 (终端变矮，下方留白) / 浮动 (盖在终端上)；
  // 高度 = 距 main 底部占 main 高度的比例，两种模式共用，每台电脑各自记住
  const DESK_MODES = { bottom: '底部', lift: '抬高', float: '浮动' };
  let deskMode = (() => { try { return DESK_MODES[localStorage.getItem('sshweb.deskMode')] ? localStorage.getItem('sshweb.deskMode') : 'bottom'; } catch { return 'bottom'; } })();
  let deskLift = (() => { try { const v = parseFloat(localStorage.getItem('sshweb.deskLift')); return v >= 0 && v < 1 ? v : 1 / 3; } catch { return 1 / 3; } })();
  const deskBar = $('#deskBar'), deskSpace = $('#deskSpace');
  const MIN_TERM = 120; // 抬高模式下上方终端至少保留的高度 (px)

  // 按比例算出像素值，并限制在允许范围内 (窗口变小时自动收回)
  function deskLiftPx() {
    const mainH = deskBar.parentElement.clientHeight;
    const max = mainH - $('#tabbar').offsetHeight - deskBar.offsetHeight - (deskMode === 'lift' ? MIN_TERM : 0);
    return Math.round(Math.max(0, Math.min(deskLift * mainH, max)));
  }

  function applyDeskPos() {
    const shown = !deskBar.classList.contains('hidden');
    for (const m of Object.keys(DESK_MODES)) deskBar.classList.toggle(m, m === deskMode);
    $('#dMode').textContent = DESK_MODES[deskMode];
    deskBar.classList.toggle('float', deskMode === 'float');
    deskSpace.classList.toggle('hidden', !(shown && deskMode === 'lift'));
    if (!shown || deskMode === 'bottom') { deskBar.style.bottom = ''; return; }
    const px = deskLiftPx();
    if (deskMode === 'lift') { deskSpace.style.height = px + 'px'; deskBar.style.bottom = ''; renderDeskPanel(); }
    else deskBar.style.bottom = px + 'px';
  }

  // main 的高度变了 (窗口大小、手机键盘调整的 #app 高度) 就重新按比例算位置；
  // 不用 window resize：那时 visualViewport 还没把 #app 调到新高度
  new ResizeObserver(() => applyDeskPos()).observe(deskBar.parentElement);

  function saveDeskPos() {
    try {
      localStorage.setItem('sshweb.deskMode', deskMode);
      localStorage.setItem('sshweb.deskLift', String(deskLift));
      localStorage.setItem('sshweb.deskMinH', String(deskMinH));
    } catch {}
  }

  $('#dMode').addEventListener('click', () => {
    const order = Object.keys(DESK_MODES);
    deskMode = order[(order.indexOf(deskMode) + 1) % order.length];
    saveDeskPos();
    applyDeskPos();
    updateHostFloat();
    dInput.focus();
  });

