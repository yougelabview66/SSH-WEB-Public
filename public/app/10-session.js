  // ------------------------------------------------------------ 终端会话

  // restore: 服务端已有的后台会话信息 (刷新 / 重新打开浏览器时恢复)
  function openSession(params, title, connType, restore) {
    $('#empty').classList.add('hidden');
    const s = { id: Math.random().toString(36).slice(2), params, title, connType, cli: CliInput.create() };
    if (restore) {
      s.remoteId = restore.id;
      s.histHost = restore.histHost;
    } else {
      const h = params.hostId ? hosts.find((x) => x.id === params.hostId) : params;
      s.histHost = h ? histHostLabel(h) : title;
    }

    s.el = document.createElement('div');
    s.el.className = 'term';
    s.box = document.createElement('div');
    s.box.className = 'term-box';
    s.el.appendChild(s.box);
    $('#terms').appendChild(s.el);

    s.term = new Terminal({
      cursorBlink: true,
      fontSize,
      fontFamily: 'ui-monospace, "Cascadia Code", Menlo, Consolas, "DejaVu Sans Mono", monospace',
      theme: termTheme(),
      scrollback,
      allowProposedApi: true,
    });
    s.fit = new FitAddon.FitAddon();
    s.term.loadAddon(s.fit);
    s.term.loadAddon(new WebLinksAddon.WebLinksAddon());
    s.term.open(s.box);
    // 远端程序通过 OSC 52 设置剪贴板：tmux 开鼠标后拖动选中、松开即复制，vim 等插件的复制也走这里。
    // 只允许写入，不响应读取请求 (同 Windows Terminal)，避免剪贴板内容被远端读走
    s.term.parser.registerOscHandler(52, (data) => {
      const b64 = data.slice(data.indexOf(';') + 1);
      if (!b64 || b64 === '?' || s.muteOsc52 || b64.length > 4 * 1024 * 1024) return true;
      try {
        const text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
        const had = document.activeElement;
        copyText(text); // HTTP 下借用临时文本框复制，会抢走焦点，复制完还回去
        if (had && had !== document.activeElement) had.focus({ preventScroll: true });
      } catch {}
      return true;
    });
    enableTouchScroll(s);
    // tmux 里往上滚：拦下来改成本地快速滚动 (见 openLocalScroll)；手机滑动也会变成滚轮事件走到这里
    s.term.attachCustomWheelEventHandler((e) => localScrollWheel(s, e));
    if (isTouch) {
      // 触屏：xterm 的隐藏输入框在手机输入法下会丢字 / 重复，改用底部输入栏
      s.term.textarea.setAttribute('readonly', 'readonly');
      s.term.textarea.addEventListener('focus', () => mInput.focus());
      s.box.addEventListener('click', () => { if (s.longPressed) { s.longPressed = false; return; } mInput.focus(); });
    } else {
      // 电脑：下方输入框开着时，点终端后光标回到下方输入框；点击本身照常交给 tmux / Claude Code。
      // 不抢的情况：选中了文字 (方便复制)、连按两下 Alt 进终端直接打字、
      // 终端的输入框里打过字、还没删光也没发送 (锁定，想改里面的内容；见 lib/cli-input.js，任何设备上打的都算)
      s.box.addEventListener('click', (e) => {
        if (e.button !== 0 || !deskOn || termDirect || s.term.hasSelection() || e.target.closest('button, .lscroll')) return;
        if (s.cli.locked()) { // 拖动选字松开也有 click，那不是想回输入框，不提示
          if (!selectingText()) fontToast(s, '终端的输入框里有没发送的字，光标留在终端 · 连按两下 Alt 回到下方输入框', 2500);
          return;
        }
        dInput.focus({ preventScroll: true });
      });
    }
    // 历史视图打开时输入栏藏起来、终端区域变高，先不重新排版 (免得 tmux 整屏重画)，关掉后尺寸又和原来一样
    s.ro = new ResizeObserver(() => { if (active === s && !s.scrollView) s.fit.fit(); });
    s.ro.observe(s.box);
    s.term.onData((data) => {
      data = filterMouse(data); // 点击时手抖 / 连点两下：不让 tmux 当成拖动选字 / 双击选词 (见 DRAG_PX / DBL_MS)
      if (!data) return;
      // 终端对程序询问的自动应答 (不是用户打的字)：服务端不算输入，不影响主机状态和打字预测
      if (TERM_REPLY_RE.test(data)) return send(s, { type: 'data', data, auto: true });
      if (data === '\r') beginCapture(s);
      send(s, { type: 'data', data });
    });
    s.term.onResize(({ cols, rows }) => {
      predClear(s, false);
      if (s.pred) { s.pred.sure = false; s.pred.next = null; }
      send(s, { type: 'resize', cols, rows, claim: userHere() });
    });
    // 旧式鼠标编码 (X10 等) 的上报走 onBinary，需要按原始字节发送
    s.term.onBinary((data) => {
      data = filterMouse(data, true);
      if (!data) return;
      if (s.ws && s.ws.readyState === WebSocket.OPEN) s.ws.send(Uint8Array.from(data, (c) => c.charCodeAt(0) & 255));
    });
    // 复制粘贴快捷键
    s.term.attachCustomKeyEventHandler((e) => {
      // 复制: Ctrl+Shift+C；Windows / Linux 上有选中内容时 Ctrl+C 也复制 (同 Windows Terminal)，没选中仍发送 ^C 中断
      if (e.type === 'keydown' && e.ctrlKey && !e.altKey && !e.metaKey && e.code === 'KeyC'
          && (e.shiftKey || (!isMac && s.term.hasSelection()))) {
        e.preventDefault();
        const text = s.term.getSelection();
        if (text) {
          copyText(text); // HTTP 下没有剪贴板接口时会借用临时文本框，复制完把焦点还给终端
          s.term.focus();
          if (!e.shiftKey) s.term.clearSelection();
        }
        return false;
      }
      // Windows / Linux 上 Ctrl+V 也粘贴 (同 Windows Terminal、VS Code)；xterm 默认会把它当 ^V 发给终端。
      // 返回 false 让浏览器执行默认的粘贴，由 xterm 的粘贴处理发送 (支持括号粘贴)。vim 列选择可用 Ctrl+Q
      if (!isMac && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyV') return false;
      return true;
    });

    s.tab = document.createElement('div');
    s.tab.className = 'tab';
    s.tab.innerHTML = '<span class="dot"></span><span class="title"></span><button class="x" title="关闭">×</button>';
    // 标签显示「主机名-序号」: 家里 NAS-1、家里 NAS-2…，新开的标签接着同一主机当前最大的序号往后排
    // (有 1 和 3 时新开的是 4，不补空出的 2)；该主机没有打开的标签时从 1 开始
    if (restore && restore.n) {
      s.baseTitle = title;
      s.n = restore.n;
    } else if (restore) {
      const m = /^(.*) \((\d+)\)$/.exec(title); // 兼容旧版本的「名称 (2)」
      s.baseTitle = m ? m[1] : title;
      s.n = m ? +m[2] : 1;
    } else {
      const max = Math.max(0, ...sessions.filter((x) => x.baseTitle === title).map((x) => x.n));
      s.baseTitle = title;
      s.n = max + 1;
    }
    s.title = title = `${s.baseTitle}-${s.n}`;
    $('.title', s.tab).textContent = title;
    s.tab.title = title;
    s.tab.addEventListener('click', (e) => {
      if (e.target.classList.contains('x')) closeSession(s);
      else activate(s);
    });
    s.tab.addEventListener('auxclick', (e) => { if (e.button === 1) closeSession(s); });
    $('#tabs').appendChild(s.tab);

    if (restore) {
      s.restoring = document.createElement('div');
      s.restoring.className = 'restoring';
      s.restoring.innerHTML = '<div class="spinner"></div>正在恢复会话…';
      s.box.appendChild(s.restoring);
    }
    sessions.push(s);
    if (!restore) activate(s);
    connect(s);
    return s;
  }

  function setStatus(s, st) {
    const dot = $('.dot', s.tab);
    dot.className = 'dot' + (st === 'ok' ? ' ok' : st === 'bad' ? ' bad' : '');
  }

  // 终端自动应答：设备属性 (DA1/DA2)、状态 / 光标位置报告 (DSR/CPR)、模式报告 (DECRPM)、焦点进出、
  // OSC 颜色查询的回答 (10/11/12/4 …)、DCS 回答 (XTGETTCAP 等)
  const TERM_REPLY_RE = /^(?:\x1b\[[?>]?[\d;]*c|\x1b\[\??[\d;]*[Rn]|\x1b\[\??[\d;]*\$y|\x1b\[[IO]|\x1b\][\d;]+[^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\)+$/;

  // 用户是不是正在这台设备上：页面在前台而且有焦点。只有这样发出的尺寸才会改变终端排版
  // (别的设备正在用时，后台设备自动重连 / 恢复画面发出的尺寸服务端只记下来不生效)
  const userHere = () => !document.hidden && document.hasFocus();

  function send(s, obj) {
    if (!s.ws || s.ws.readyState !== WebSocket.OPEN) return;
    if (obj.type === 'data' && s.scrollView) closeLocalScroll(s); // 打字 / 按键 = 回到实时画面
    // tmux 复制模式里 Ctrl+End 没有用 (不认这个键，按了没反应)：换成 q 退出复制模式，同「回到实时画面」
    if (obj.type === 'data' && obj.data === '\x1b[1;5F' && tmuxInCopyMode(s)) obj = { ...obj, data: 'q', tmux: true };
    // tmux：给 tmux 的按键 (退出复制模式的 q)，不是打进程序输入框的字 —— 不预测回显、不算进终端输入框的内容
    // (以前算进去了：以为输入框里有个 q，之后点终端光标一直留在终端，不回下方输入框)
    if (obj.type === 'data' && typeof obj.data === 'string' && !obj.auto && !obj.tmux) {
      predictInput(s, obj.data); // 打字预测回显
      s.cli.feed(obj.data, { running: s.srvState?.cls === 'run' }); // 终端输入框里的内容先在本地算一遍 (服务器算好后会同步过来，以服务器的为准)
    }
    // 大段粘贴分块发送，避免单条消息超过服务端 1MB 上限导致连接被断开
    if (obj.type === 'data' && typeof obj.data === 'string' && obj.data.length > 32768) {
      for (let i = 0; i < obj.data.length; i += 32768) {
        const last = i + 32768 >= obj.data.length;
        s.ws.send(JSON.stringify({ ...(last ? obj : { type: 'data' }), data: obj.data.slice(i, i + 32768) })); // echo / gap 标在最后一块上
      }
      return;
    }
    s.ws.send(JSON.stringify(obj));
  }

  // 打开 WebSocket 并挂载到后台会话：已有会话用 attach，新连接用 connect
  function connect(s) {
    clearTimeout(s.retryTimer);
    hideReconnect(s);
    setStatus(s, 'wait');
    if (s.box.clientWidth && !s.scrollView) s.fit.fit();

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    s.ws = ws;
    const size = s.box.clientWidth ? { cols: s.term.cols, rows: s.term.rows } : {};
    size.claim = userHere();

    ws.onopen = () => {
      s.retries = 0;
      if (s.remoteId) {
        // offset: 已收到的输出字节数，断线重连时服务端只补发缺的部分
        ws.send(JSON.stringify({ type: 'attach', id: s.remoteId, offset: s.offset, ...size }));
      } else {
        ws.send(JSON.stringify({ type: 'connect', ...s.params, title: s.baseTitle, n: s.n, histHost: s.histHost, pageId, ...size }));
      }
      // 应用层心跳，避免 Cloudflare / 反向代理 100 秒空闲断开
      clearInterval(s.ping);
      s.ping = setInterval(() => send(s, { type: 'ping' }), 25000);
    };
    ws.onmessage = (ev) => {
      if (s.ws !== ws) return;
      if (ev.data instanceof ArrayBuffer) {
        if (s.offset !== undefined) s.offset += ev.data.byteLength;
        s.lastOut = Date.now();
        if (pipWin && s.lastOut - (lastStatusPaint || 0) > 300) { lastStatusPaint = s.lastOut; renderDeskTabs(); }
        const replay = s.muteOsc52;
        s.term.write(new Uint8Array(ev.data), () => {
          if (replay) s.muteOsc52 = false;
          checkCapture(s);
          predCheck(s);
        });
        return;
      }
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'attached') {
        const isNew = !s.remoteId;
        s.remoteId = m.session.id;
        s.params = m.session.params || s.params;
        if (m.session.n && m.session.n !== s.n) setTabNumber(s, m.session.n); // 其他设备可能已用了这个序号
        if (isNew) saveTabOrder();
        if (active === s) saveActive();
        reportWatching();
      } else if (m.type === 'snapshot') {
        // 还原服务端保存的画面和滚动记录
        predClear(s, false);
        s.term.reset();
        s.term.write(m.data);
        s.offset = m.offset;
        doneRestoring(s);
        if (active === s) syncSize(s);
      } else if (m.type === 'resume') {
        // 接下来的一帧是断开期间的输出补发，其中的复制序列是以前的，不再写剪贴板
        if (m.bytes) s.muteOsc52 = true;
        // 画面还在，服务端接着补发断开期间的输出
        doneRestoring(s);
        if (active === s) syncSize(s);
      } else if (m.type === 'status') {
        s.sid = m.status === 'connected' ? m.sid : null;
        setStatus(s, m.status === 'connected' ? 'ok' : m.status === 'connecting' ? 'wait' : 'bad');
        if (m.status === 'closed') showReconnect(s, '重新连接');
        else hideReconnect(s);
        updateSftpBtn();
        if (s === active) updateLat();
        if (m.status === 'connected' && s === active) measureRtt(); // 连上就测，不等下一轮
        if (m.status === 'connected') {
          if (s.sftp && s.sftp.open) s.sftp.load(s.sftp.path);
          // 重新连接 SSH 时，服务端用它记着的最后一次尺寸开新 shell (可能是别的设备设的)：按这台设备的屏幕同步一次
          if (active === s) { syncSize(s); focusTerm(s); }
        }
      } else if (m.type === 'hostkey') {
        activate(s);
        hostkeyDialog(m, s.id).then((accept) => { if (accept != null) send(s, { type: 'hostkey-response', accept }); });
      } else if (m.type === 'prompt') {
        activate(s);
        promptDialog(m, s.id).then((answers) => {
          if (answers === undefined) return; // 已在其他设备上回答
          send(s, answers ? { type: 'prompt-response', answers } : { type: 'prompt-response', cancel: true });
        });
      } else if (m.type === 'tmux-history') {
        onTmuxHistory(s, m);
      } else if (m.type === 'cli') {
        s.cli.set(m); // 服务器算的终端输入框内容 (包括别的设备上打的字)
      } else if (m.type === 'state') {
        s.srvState = { label: m.label, cls: m.cls };
        renderDeskTabs();
      } else if (m.type === 'pong') {
        if (Number.isFinite(m.t)) { s.rtt = latSample(s, 'web', Math.round(performance.now() - m.t)); if (s === active) updateLat(); }
      } else if (m.type === 'lat') {
        s.sshRtt = latSample(s, 'ssh', m.ssh);
        if (s === active) updateLat();
      } else if (m.type === 'bell') {
        if (s !== active || document.hidden) s.tab.classList.add('ring');
      } else if (m.type === 'prompt-done') {
        dismissDialog(s.id);
      } else if (m.type === 'error') {
        setStatus(s, 'bad');
        // 会话创建前的错误 (参数无效 / 数量上限) 服务端不会写入终端
        if (!s.remoteId) {
          s.term.write(`\r\n\x1b[31m✖ ${m.message}\x1b[0m\r\n`);
          showReconnect(s, '重试');
        }
      } else if (m.type === 'terminated') {
        // 在其他设备上关闭了这个标签
        closeSession(s, true);
      } else if (m.type === 'gone') {
        doneRestoring(s);
        // 服务端没有这个会话了 (服务重启过)
        s.remoteId = null;
        s.offset = undefined;
        s.sid = null;
        setStatus(s, 'bad');
        updateSftpBtn();
        s.term.write('\r\n\x1b[33m后台会话已不存在 (服务可能重启过)\x1b[0m\r\n');
        showReconnect(s, '重新连接');
      }
    };
    ws.onclose = () => {
      clearInterval(s.ping);
      if (s.closed || s.ws !== ws) return;
      s.sid = null;
      updateSftpBtn();
      setStatus(s, 'wait');
      if (!s.remoteId) { showReconnect(s, '重试'); return; }
      // 网络断开：后台会话仍在，自动重新挂载
      const delay = Math.min(1000 * 2 ** (s.retries || 0), 10000);
      s.retries = (s.retries || 0) + 1;
      if (s.retries > 3) showReconnect(s, '正在重新连接… 点击立即重试');
      s.retryTimer = setTimeout(() => connect(s), delay);
    };
  }

  function doneRestoring(s) {
    s.restoring?.remove();
    s.restoring = null;
  }

  // 让服务端终端尺寸与当前显示一致 (其他设备可能改过尺寸)
  function syncSize(s) {
    if (!s.box.clientWidth) return;
    if (!s.scrollView) s.fit.fit();
    send(s, { type: 'resize', cols: s.term.cols, rows: s.term.rows, claim: userHere() });
  }

  function showReconnect(s, text) {
    if (!s.reconnectBtn) {
      const b = document.createElement('button');
      b.className = 'primary reconnect';
      b.onclick = () => {
        if (s.remoteId && s.ws && s.ws.readyState === WebSocket.OPEN) send(s, { type: 'reconnect' });
        else connect(s);
      };
      s.box.appendChild(b);
      s.reconnectBtn = b;
    }
    s.reconnectBtn.textContent = text;
  }

  function hideReconnect(s) {
    s.reconnectBtn?.remove();
    s.reconnectBtn = null;
  }

  // 标签顺序与当前标签保存起来，重新打开时恢复
  function saveTabOrder() {
    const ids = sessions.map((x) => x.remoteId).filter(Boolean);
    if (ids.length) api('PUT', '/api/sessions/order', { ids, pageId }).catch(() => {});
  }

  function saveActive() {
    try { if (active && active.remoteId) localStorage.setItem('sshweb.active', active.remoteId); } catch {}
  }

  async function fetchSessions() {
    try { return await api('GET', '/api/sessions'); } catch { return []; }
  }

  function restoreSessions(list) {
    let want = null;
    try { want = localStorage.getItem('sshweb.active'); } catch {}
    // 点击通知打开网页时 (?session=xxx) 直接切到对应标签
    const fromNotify = new URLSearchParams(location.search).get('session');
    if (fromNotify) {
      want = fromNotify;
      history.replaceState(null, '', '/');
    }
    const opened = list.map((info) => openSession(info.params || {}, info.title, info.connType, info));
    activate(opened.find((x) => x.remoteId === want) || opened[opened.length - 1]);
  }
