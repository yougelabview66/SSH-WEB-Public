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
    if (!active?.sid || inputLocked(active)) return; // 别的设备在用：字留在输入框里，接管后再发
    setDeskText('');
    submitText(active, text);
  }

  // tmux 复制模式 (往上翻历史时 tmux 自己的查看模式，右下角有「回到实时画面」) 里发的字会被复制模式
  // 当成按键吃掉 (j k 移动、回车复制并退出、/ 搜索…)，到不了程序：先发 q 退出 (同点「回到实时画面」)，
  // tmux 按顺序处理，紧跟着的内容就进了程序。退出后 tmux 重画要一个来回，期间画面还像在复制模式，不重复发 q
  function leaveTmuxCopyMode(s) {
    if (!s?.sid || Date.now() - (s.copyExitAt || 0) < 1500 || !tmuxInCopyMode(s)) return;
    s.copyExitAt = Date.now();
    send(s, { type: 'data', data: 'q', tmux: true });
  }

  // 回车和文字分开写进终端 (程序一次读到会当成粘贴、不提交)：文字标上 echo、回车标上 gap 一起马上发出，
  // 服务端等程序把文字显示出来再写回车 (没输出时最多等 ENTER_GAP)，发送后终端尺寸变化也由服务端排到回车之后 (见 server.js Session.write)
  const ENTER_GAP = 50;

  // 把输入栏里编辑好的一段文字发给终端并回车 (电脑 / 手机输入栏共用)
  function submitText(s, text) {
    if (!s || !s.sid) return;
    leaveTmuxCopyMode(s);
    if (!text) { beginCapture(s); send(s, { type: 'data', data: '\r' }); return; }
    let data = text.replace(/\r?\n/g, '\r');
    // 多行内容按粘贴发送 (Claude Code 等支持括号粘贴的程序不会把中间的换行当回车)
    if (data.includes('\r') && s.term.modes.bracketedPasteMode) data = '\x1b[200~' + data + '\x1b[201~';
    send(s, { type: 'data', data, echo: true });
    beginCapture(s); // 记历史等回显，见 checkCapture
    send(s, { type: 'data', data: '\r', gap: ENTER_GAP });
  }

  // 命令模式：空输入框里打 / 后，输入逐字直接发给终端，Claude Code 的 / 命令候选列表会在终端里弹出，
  // ↑ ↓ 选择、Tab 补全、Enter 执行；Enter / Esc / Ctrl+C 或退格删光后回到本地编辑
  let cmdMode = null; // { s: 所在标签, n: 已发出的字数 (退格删光时退出) }
  // 提示文字：一行放得下就用完整的，放不下换短的；再放不下就截短加省略号 —— 提示文字折行会把空输入框撑高，
  // 打字 / 发送时输入框高度来回变，每次都让终端改尺寸、程序整屏重画
  const DESK_PH = [dInput.placeholder, 'Enter 发送 · Shift+Enter 换行'];
  const CMD_PH = ['命令模式：直接输入到终端，Enter 执行，Esc 退出', '命令模式 · Enter 执行 · Esc 退出'];
  const phCtx = document.createElement('canvas').getContext('2d');
  function fitPlaceholder() {
    const list = cmdMode ? CMD_PH : DESK_PH;
    const cs = getComputedStyle(dInput);
    const room = dInput.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2;
    phCtx.font = cs.font;
    const fits = (t) => phCtx.measureText(t).width <= room;
    let ph = room > 0 ? list.find(fits) : list[0];
    if (!ph) { // 最短的也放不下：截短
      const short = list.at(-1);
      let n = short.length - 1;
      while (n > 1 && !fits(short.slice(0, n) + '…')) n--;
      ph = short.slice(0, n) + '…';
    }
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
    if (on) leaveTmuxCopyMode(active); // 不然 / 会变成复制模式里的搜索
    cmdMode = on ? { s: active, n: 0 } : null;
    $('#deskBar').classList.toggle('cmd', on);
    $('#mobileBar').classList.toggle('cmd', on);
    fitPlaceholder();
  }

  function flushCmd() {
    const text = dInput.value;
    if (!cmdMode || !text || inputLocked(active)) return; // 别的设备在用：字留在输入框里
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
      if (dInput.value === '/' && !isLocked(active)) { setCmdMode(true); return flushCmd(); }
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

