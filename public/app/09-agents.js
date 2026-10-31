  // ------------------------------------------------------------ 各 Agent 的特殊处理
  // 按钩子报的、这个标签里在跑的 Agent (s.agent.id，见 10-session.js 的 'agent' 消息) 决定。每个 Agent 一项，
  // 别处只问 agentDoes(s, '某功能')：改哪个 Agent 只动它自己那一项，不影响别的 (Claude Code 用着没问题，别跟着 Grok 一起改)。
  // 没装钩子 / 不认识的 Agent：一项都没有，照通用的处理
  //  - sendNow：按键栏「立即发送」发 Ctrl+X Ctrl+S (Claude Code 排队的消息不等这轮回完就发)；别的 Agent 里这两个键另有用处，不发
  //  - pageScrollOnWin：Windows 主机上往上 / 往下滚 (手机手指滑) 换成 PageUp / PageDown 让它自己翻页，不开历史视图
  //    (全屏界面经过 ConPTY 后，终端历史里是一屏屏重画的碎片，历史视图排不整齐；ConPTY 又不把滚轮转给它，见 55-local-scroll.js)
  //  - dragSelect：程序开着鼠标时，电脑上左键拖动直接在终端里选字 (不用按住 Shift)，单击照常交给程序
  //  - keepSelOnHover：终端里有选中时，不让终端收到没按键的鼠标移动 —— 程序要了所有鼠标移动 (Grok 是这样) 时，
  //    鼠标一动终端就上报一次，上报算用户输入，xterm 会把选中清掉 (松开鼠标一挪，刚选的字就没了)
  const AGENTS = {
    claude: { sendNow: true },
    grok: { pageScrollOnWin: true, dragSelect: true, keepSelOnHover: true },
  };
  const agentDoes = (s, what) => !!AGENTS[s?.agent?.id]?.[what];

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
