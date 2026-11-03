  // ------------------------------------------------------------ 各 Agent 的特殊处理
  // 按这个标签里在跑的 Agent 决定 (见 agentIdOf)。每个 Agent 一项，
  // 别处只问 agentDoes(s, '某功能')：改哪个 Agent 只动它自己那一项，不影响别的 (Claude Code 用着没问题，别跟着 Grok 一起改)。
  // 认不出是哪个 Agent：一项都没有，照通用的处理
  //  - sendNow：按键栏「立即发送」发 Ctrl+X Ctrl+S (Claude Code 排队的消息不等这轮回完就发)；别的 Agent 里这两个键另有用处，不发
  //  - dragSelect：程序开着鼠标时，电脑上左键拖动直接在终端里选字 (不用按住 Shift)，单击照常交给程序
  //  - keepSelOnHover：终端里有选中时，不让终端收到没按键的鼠标移动 —— 程序要了所有鼠标移动 (Grok 是这样) 时，
  //    鼠标一动终端就上报一次，上报算用户输入，xterm 会把选中清掉 (松开鼠标一挪，刚选的字就没了)
  //  - promptLine：它的输入框那一行长什么样 (以 > / ❯ 开头，前面可能有边框)。下方输入栏发消息前先替你点一下这里 (见 agentBeforeSend)
  //  - screen：屏幕最下面几行有这个就认作是它 (Grok 底下一直有「Ctrl+x:shortcuts」)
  //  - ownHistory：历史视图看它会话文件里的完整对话 (服务端读，见 lib/agents/ 里各自的 history)，不抓终端历史 ——
  //    Grok 的全屏 (填充) 界面把对话放在自己的界面里滚动，终端历史里只有每次重画留下的一屏
  //  - noFocusReport：不把终端「获得 / 失去焦点」的通知 (ESC [I / ESC [O) 转给它 —— Grok 一收到就清屏、整屏重画，
  //    刚拖出来的选区立刻被冲掉 (实测 Grok 1.0.70；Hermes 的网页终端也是这样，见 hermes-inputbar 的 patch18)
  const AGENTS = {
    claude: { sendNow: true },
    grok: { dragSelect: true, keepSelOnHover: true, noFocusReport: true, ownHistory: true, promptLine: /^(\s*[│┃|]?\s*)[>❯›]/, screen: /Ctrl\+x:shortcuts/ },
    // 全屏界面 (没有关掉的设置)：历史视图从它的数据库读完整对话 (lib/agents/opencode.js 的 history)。
    // 屏幕最下面一直有「ctrl+p commands」：还没跟它说话 (插件没报过事件) 也认得出
    // altScreen：一直是全屏界面 —— 终端不在备用屏幕上就是它已经退出了 (OpenCode 退出时不报事件，钩子报的还停在它)
    // (只在这个标签进过备用画面时这么判断：Windows 的终端不转出备用画面，OpenCode 开着也是普通画面)
    opencode: { ownHistory: true, altScreen: true, screen: /ctrl\+p\s+commands/ },
  };
  // 这个标签里在跑的 Agent：屏幕上明明白白是它 (各 Agent 的 screen) 就是它；屏幕上认不出才用钩子报的 (s.agent.id，见 10-session.js 的
  // 'agent' 消息)。屏幕优先：钩子报的可能是这个标签里以前跑过的、或者记错标签的 Agent (同一台主机上 Claude Code 和 Grok 都开着)，
  // 也可能还没报 (没装钩子、SSH-WEB 重启后 Agent 还没发过事件 —— Grok 里中文发不出去就一直等不到事件)
  // 屏幕最下面的 6 行指的是最后 6 行有字的：同一个终端同时开在两台设备上时，终端按小的那边的大小画，
  // 大的这边屏幕底下空着几行，只看最后 6 行就一个字都没有，认不出 (OpenCode 还没说话时就进不了历史画面)
  function agentIdOf(s) {
    const b = s?.term?.buffer.active;
    if (b) {
      const tail = [];
      for (let y = s.term.rows - 1; y >= 0 && tail.length < 6; y--) {
        const t = b.getLine(b.baseY + y)?.translateToString(true) || '';
        if (t.trim()) tail.push(t);
      }
      const text = tail.join('\n');
      for (const [id, a] of Object.entries(AGENTS)) if (a.screen?.test(text)) return id;
    }
    const id = s?.agent?.id || null;
    return AGENTS[id]?.altScreen && s.altSeen && b && b.type !== 'alternate' ? null : id;
  }
  const agentDoes = (s, what) => !!AGENTS[agentIdOf(s)]?.[what];
  // Agent 的标志 (常驻会话选择框里名字前面画，服务端告诉是哪个 Agent，见 lib/agents/index.js 的 agentLabel)。
  // 都取自 LobeHub 图标库 (@lobehub/icons-static-svg 的同名 svg；Pi 的和 pi.dev 官网标志同一个图形)；颜色跟着文字走
  const AGENT_LOGOS = {
    grok: '<svg class="ag-logo" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" aria-label="Grok"><path d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815"/></svg>',
    codex: '<svg class="ag-logo" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" aria-label="Codex"><path clip-rule="evenodd" d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"/></svg>',
    antigravity: '<svg class="ag-logo" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" aria-label="Antigravity"><path d="M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z"/></svg>',
    opencode: '<svg class="ag-logo" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" aria-label="OpenCode"><path d="M16 6H8v12h8V6zm4 16H4V2h16v20z"/></svg>',
    pi: '<svg class="ag-logo" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" aria-label="Pi"><path clip-rule="evenodd" d="M1 1h16.5v11H12v5.5H6.5V23H1V1zm5.5 5.5V12H12V6.5H6.5z"/><path d="M17.5 12H23v11h-5.5V12z"/></svg>',
  };
  const agentLogo = (id) => AGENT_LOGOS[id] || '';

  // 下方输入栏发消息前 (见 35-desk-input.js 的 submitText)：程序开着鼠标、认得出输入框在哪 (promptLine) 时，先替你点一下它的输入框。
  // Grok 的焦点停在聊天记录上 (单击过某条记录、按过 Esc / Tab) 时，打英文它会自己回到输入框，打中文却直接丢掉 (实测 Grok 1.0.70)，
  // 发中文看着就是没反应；点输入框是它说的回到输入框的办法。点在输入框里已有文字的末尾 —— 点哪光标就到哪，
  // 点在开头的话发的字会插到原来的字前面。找不到输入框 (弹着菜单等) 就不点
  function agentBeforeSend(s) {
    const re = AGENTS[agentIdOf(s)]?.promptLine;
    if (!re || s.term.modes.mouseTrackingMode === 'none') return;
    const b = s.term.buffer.active, rows = s.term.rows;
    for (let y = rows - 1; y >= Math.max(0, rows - 10); y--) { // 输入框在屏幕最下面几行
      const line = b.getLine(b.baseY + y);
      const m = re.exec(line?.translateToString(true) || '');
      if (!m) continue;
      // 按格子找：提示符 (> / ❯) 在哪一格、右边框在哪一格、中间最后一个字到哪一格 (中文占两格)
      let px = -1, border = line.length, end = -1, cell;
      for (let x = 0; x < line.length; x++) {
        cell = line.getCell(x, cell);
        const ch = cell?.getChars() || '';
        if (px < 0) { if ('>❯›'.includes(ch) && ch) px = x; continue; }
        if ('│┃|'.includes(ch) && ch) { border = x; break; }
        if (ch && ch !== ' ') end = x + Math.max(1, cell.getWidth());
      }
      if (px < 0) continue;
      const at = Math.min(Math.max(end, px + 2), border - 1, s.term.cols - 1); // 从 0 数的格
      const col = at + 1, row = y + 1;
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
      if (!e.buttons && s.term.hasSelection() && appMouse() && agentDoes(s, 'keepSelOnHover')) e.stopPropagation(); // 先看有没有选中 (看屏幕认 Agent 要读几行)
    }, true);
  }
