  // ------------------------------------------------------------ 各 Agent 的特殊处理
  // 按钩子报的、这个标签里在跑的 Agent (s.agent.id，见 10-session.js 的 'agent' 消息) 决定。每个 Agent 一项，
  // 别处只问 agentDoes(s, '某功能')：改哪个 Agent 只动它自己那一项，不影响别的 (Claude Code 用着没问题，别跟着 Grok 一起改)。
  // 没装钩子 / 不认识的 Agent：一项都没有，照通用的处理
  //  - sendNow：按键栏「立即发送」发 Ctrl+X Ctrl+S (Claude Code 排队的消息不等这轮回完就发)；别的 Agent 里这两个键另有用处，不发
  //  - dragSelect：程序开着鼠标时，电脑上左键拖动直接在终端里选字 (不用按住 Shift)，单击照常交给程序
  //  - keepSelOnHover：终端里有选中时，不让终端收到没按键的鼠标移动 —— 程序要了所有鼠标移动 (Grok 是这样) 时，
  //    鼠标一动终端就上报一次，上报算用户输入，xterm 会把选中清掉 (松开鼠标一挪，刚选的字就没了)
  //  - promptLine：它的输入框那一行长什么样 (以 > 开头，前面可能有边框)。下方输入栏发消息前先替你点一下这里 (见 agentBeforeSend)
  const AGENTS = {
    claude: { sendNow: true },
    grok: { dragSelect: true, keepSelOnHover: true, promptLine: /^(\s*[│┃|]?\s*)>/ },
  };
  const agentDoes = (s, what) => !!AGENTS[s?.agent?.id]?.[what];

  // 下方输入栏发消息前 (见 35-desk-input.js 的 submitText)：程序开着鼠标、认得出输入框在哪 (promptLine) 时，先替你点一下它的输入框。
  // Grok 的界面里焦点可能在聊天记录上 (单击过某条记录、按过 Esc / Tab)，这时发过去的字不进输入框，看着就是发了没反应；
  // 点输入框是它说的回到输入框的办法，焦点本来就在输入框时没有副作用。找不到输入框 (弹着菜单等) 就不点
  function agentBeforeSend(s) {
    const re = AGENTS[s?.agent?.id]?.promptLine;
    if (!re || s.term.modes.mouseTrackingMode === 'none') return;
    const b = s.term.buffer.active, rows = s.term.rows;
    for (let y = rows - 1; y >= Math.max(0, rows - 10); y--) { // 输入框在屏幕最下面几行
      const m = re.exec(b.getLine(b.baseY + y)?.translateToString(true) || '');
      if (!m) continue;
      const col = Math.min(s.term.cols, m[1].length + 3), row = y + 1; // 点在 > 后面 (从 1 数)
      send(s, { type: 'data', data: `\x1b[<0;${col};${row}M\x1b[<0;${col};${row}m` });
      return;
    }
  }

  // 电脑上终端里的鼠标 (dragSelect / keepSelOnHover)，每个标签打开终端后挂一次 (见 10-session.js)
  function agentMouse(s) {
    if (isTouch) return;
    const appMouse = () => s.term.modes.mouseTrackingMode !== 'none';
    const onScreen = (e) => !!e.target.closest?.('.xterm-screen');
    // 按下先不交给 xterm (它会马上报给程序)：挪够 DRAG_PX 算拖动 → 补一个按着 Shift 的按下，xterm 当成选字；
    // 没挪就松开算单击 → 补一个原样的按下，接着真的松开照常到 xterm，程序收到完整的一次单击
    s.box.addEventListener('mousedown', (e) => {
      if (!e.isTrusted || e.button !== 0 || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
      if (!agentDoes(s, 'dragSelect') || !appMouse() || !onScreen(e)) return;
      e.stopPropagation();
      const start = e;
      const replay = (shiftKey) => start.target.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, view: window, detail: start.detail, button: 0, buttons: 1,
        clientX: start.clientX, clientY: start.clientY, screenX: start.screenX, screenY: start.screenY, shiftKey,
      }));
      const done = () => { removeEventListener('mousemove', move, true); removeEventListener('mouseup', up, true); };
      const move = (ev) => {
        if (Math.hypot(ev.clientX - start.clientX, ev.clientY - start.clientY) < DRAG_PX) return;
        done();
        replay(true); // 这一下挪动接着传到 xterm，选区从按下的地方拉到这里
      };
      const up = (ev) => { if (ev.button === 0) { done(); replay(false); } };
      addEventListener('mousemove', move, true);
      addEventListener('mouseup', up, true);
    }, true);
    s.box.addEventListener('mousemove', (e) => {
      if (!e.buttons && agentDoes(s, 'keepSelOnHover') && appMouse() && s.term.hasSelection()) e.stopPropagation();
    }, true);
  }
