  // ------------------------------------------------------------ 终端会话

  // restore: 服务端已有的后台会话信息 (刷新 / 重新打开浏览器时恢复)
  function openSession(params, title, connType, restore) {
    $('#empty').classList.add('hidden');
    const s = { id: Math.random().toString(36).slice(2), params, title, connType, cli: CliInput.create(), fresh: true };
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
    CellWidth.useCellWidth(s.term); // ✅ 这类表情算两格 (同 tmux / Claude Code，见 public/cellwidth.js)
    s.fit = new FitAddon.FitAddon();
    s.term.loadAddon(s.fit);
    const rawFit = s.fit.fit.bind(s.fit);
    s.fit.fit = () => mirrorFit(s, rawFit); // 被别的设备锁住时按它的行列镜像显示 (见 42-owner.js)
    s.term.loadAddon(new WebLinksAddon.WebLinksAddon());
    s.term.open(s.box);
    agentMouse(s); // 各 Agent 的鼠标处理 (见 09-agents.js)
    // 程序退出时的终端型号询问 (DA，ESC [ c) 不回答：Codex 退出时先弹出键盘增强设置 (ESC [ < u，只有退出时才发)、关掉括号粘贴等，
    // 接着问一次终端型号就退出了，不等回答 (实测 Codex 0.166)。回答 (ESC [ ? 1 ; 2 c) 晚到一点就落进 shell：
    // 提示符后面多出「1;2c」，紧接着打的命令被拼坏 (「1;2cclear」)。弹出键盘设置后 300 毫秒内的这种询问算退出时的，不回答
    s.term.parser.registerCsiHandler({ prefix: '<', final: 'u' }, () => { s.kbdPopAt = Date.now(); return false; });
    // 进过全屏备用画面 (Linux 上的 OpenCode 一开就进)：认 Agent 时才用「不在备用画面 = 全屏 Agent 已退出」(见 09-agents.js 的 agentIdOf)。
    // Windows 的终端 (ConPTY) 不转出备用画面，一直是普通画面，不能这么判断
    s.term.buffer.onBufferChange((b) => { if (b.type === 'alternate') s.altSeen = true; });
    s.term.parser.registerCsiHandler({ final: 'c' }, (params) => {
      if (s.kbdPopAt && Date.now() - s.kbdPopAt < 300 && params.length <= 1 && !(params[0] > 0)) { s.kbdPopAt = 0; return true; }
      return false;
    });
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
    // 滚轮进历史视图 (见 openLocalScroll)：统一在 box 的捕获阶段最先走一遍 localScrollWheel，不再依赖
    // xterm 的内部分发 —— 程序开了鼠标 (tmux) 时它把滚轮报给程序、没开时自己滚滚动区，两条路里
    // attachCustomWheelEventHandler 不一定被调到 (有反馈说输入框关着、焦点在终端上时触发不了)。
    // 返回 false (要进 / 已在历史视图) 就拦下不再给 xterm；返回 true 照旧交给它处理 (报给程序 / 自己滚)
    s.box.addEventListener('wheel', (e) => {
      if (s.bypassWheel || e.target.closest('.lscroll')) return;
      if (localScrollWheel(s, e) === false) { e.preventDefault(); e.stopPropagation(); }
    }, { capture: true, passive: false });
    if (isTouch) {
      // 触屏：xterm 的隐藏输入框在手机输入法下会丢字 / 重复，改用底部输入栏
      s.term.textarea.setAttribute('readonly', 'readonly');
      // 别的设备在用 (锁住，见 42-owner.js)：点终端不弹键盘 (打了也发不出去)，要写字点下面的输入栏
      s.term.textarea.addEventListener('focus', () => { if (!isLocked(s) && mDirect !== s) mInput.focus(); }); // 点了「⇄ CLI」就留在终端
      // 点终端上的按钮 (回到实时画面、重连等) 和历史视图不弹键盘：「回到实时画面」点完历史视图已经关了、输入栏刚回来，
      // 这一下 click 冒泡上来再聚焦输入框就会弹出输入法
      s.box.addEventListener('click', (e) => {
        if (s.longPressed) { s.longPressed = false; return; }
        if (!isLocked(s) && mDirect !== s && !e.target.closest('button, .lscroll, .tsearch')) mInput.focus(); // 搜索框自己要焦点；「⇄ CLI」时留在终端
      });
    } else {
      // 电脑：下方输入框开着时，点终端后光标回到下方输入框；点击本身照常交给 tmux / Claude Code。
      // 不抢的情况：选中了文字 (方便复制)、连按两下 Alt 进终端直接打字、
      // 终端的输入框里打过字、还没删光也没发送 (锁定，想改里面的内容；见 lib/cli-input.js，任何设备上打的都算)
      s.box.addEventListener('click', (e) => {
        if (e.button !== 0 || !deskOn || termDirect || s.term.hasSelection() || e.target.closest('button, .lscroll, .tsearch')) return;
        if (s.cli.locked()) { // 拖动选字松开也有 click，那不是想回输入框，不提示
          if (!selectingText()) fontToast(s, '终端的输入框里有没发送的字，光标留在终端 · 连按两下 Alt 回到下方输入框', 2500);
          return;
        }
        dInput.focus({ preventScroll: true });
      });
    }
    // 历史视图打开时输入栏藏起来、终端区域变高，先不重新排版 (免得 tmux 整屏重画)，关掉后尺寸又和原来一样
    s.ro = new ResizeObserver(() => { if (active === s && !s.scrollView && !rbResizing) s.fit.fit(); }); // 拖右边栏宽度时先不排，松手再排 (见 66-right-bar.js)
    s.ro.observe(s.box);
    s.term.onData((data) => {
      data = filterMouse(data); // 点击时手抖 / 连点两下：不让 tmux 当成拖动选字 / 双击选词 (见 DRAG_PX / DBL_MS)
      if (/\x1b\[[IO]/.test(data) && agentDoes(s, 'noFocusReport')) data = data.replace(/\x1b\[[IO]/g, ''); // Grok：焦点通知会让它整屏重画 (见 09-agents.js)
      if (!data) return;
      // 终端对程序询问的自动应答 (不是用户打的字)：服务端不算输入，不影响主机状态和打字预测
      if (TERM_REPLY_RE.test(data)) {
        // Windows 主机：程序的询问经 ConPTY 转给外面的终端，回答经 ConPTY 回去时被当成键盘输入 (ESC 被吃掉，
        // 剩下的 y、rgb:…、\ 打进 Claude 的输入框)。模式报告 ($y)、颜色 / OSC、DCS (版本号)、焦点进出不回答；
        // 终端型号 (DA，…c) 和光标位置 / 状态报告 (…R / …n) 照常回答：程序拿终端型号的回答当「询问结束」的信号，
        // 收不到就一直等，方向键这类 ESC 开头的按键被当成没收完的回答吞掉 (v1.68.2 拦了它，方向键就不好使了)
        if (s.winHost) data = (data.match(/\x1b\[[?>]?[\d;]*c|\x1b\[\??[\d;]*[Rn]/g) || []).join('');
        if (data) send(s, { type: 'data', data, auto: true });
        return;
      }
      if (data === '\r') beginCapture(s);
      send(s, { type: 'data', data });
    });
    s.term.onResize(({ cols, rows }) => {
      predClear(s, false);
      if (s.pred) { s.pred.sure = false; s.pred.next = null; }
      sendSize(s, cols, rows);
    });
    // 旧式鼠标编码 (X10 等) 的上报走 onBinary，需要按原始字节发送
    s.term.onBinary((data) => {
      data = filterMouse(data, true);
      if (!data || inputLocked(s)) return; // 别的设备在用 (见 42-owner.js)
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
      // Ctrl+End：终端往上翻过 (不在最底下) 时回到最底下 (同历史视图里的 Ctrl+End)，不发给程序
      if (e.type === 'keydown' && e.ctrlKey && e.key === 'End' && !e.shiftKey && !e.altKey && !e.metaKey) {
        const b = s.term.buffer.active;
        if (b.viewportY < b.baseY) { e.preventDefault(); s.term.scrollToBottom(); return false; }
      }
      // Windows / Linux 上 Ctrl+V 也粘贴 (同 Windows Terminal、VS Code)；xterm 默认会把它当 ^V 发给终端。
      // 返回 false 让浏览器执行默认的粘贴，由 xterm 的粘贴处理发送 (支持括号粘贴)。vim 列选择可用 Ctrl+Q
      if (!isMac && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyV') return false;
      return true;
    });
    // 选中就复制 (同 tmux 开了鼠标时松开就复制)：电脑上在终端里用鼠标选中文字 (拖动、双击选词、三击选行)，
    // 松开时自动复制到剪贴板。没有 tmux 的会话 (常驻会话 (Windows)、直接的 shell) 靠这个；tmux 自己选的 (没按 Shift) 不经过这里
    if (!isTouch) {
      // 只看「在终端里按下、松开后有选中的文字」：只是点一下 xterm 会清掉选中，不会误复制。
      // 不靠 onSelectionChange 判断有没有选：xterm 在松开之后才发它。用捕获阶段：xterm 自己的鼠标处理可能不让事件冒泡上来
      let pressed = false;
      s.box.addEventListener('mousedown', (e) => { if (e.button === 0) pressed = true; }, true);
      // 挂在 window 上：关标签时要摘掉 (closeSession 里 s.offs)，不然一直留着，还拉着整个终端不让回收
      const onUp = (e) => {
        if (!pressed || e.button !== 0) return;
        pressed = false;
        setTimeout(() => { // 等 xterm 处理完这次松开
          if (s.closed) return;
          const text = s.term.getSelection();
          if (text.trim()) copyText(text).then((done) => { if (done) fontToast(s, '已复制', 900); });
        }, 0);
      };
      window.addEventListener('mouseup', onUp, true);
      (s.offs ||= []).push(() => window.removeEventListener('mouseup', onUp, true));
    }

    s.tab = document.createElement('div');
    s.tab.className = 'tab';
    s.tab.innerHTML = '<span class="dot"></span><span class="title"></span><button class="x" title="关闭" aria-label="关闭">×</button>';
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
    // 命过名的标签：「主机名-」后面显示自定义的部分 (服务端记着，刷新后带回来)
    s.suffix = restore && typeof restore.suffix === 'string' ? restore.suffix.replace(/\s+/g, ' ').trim().slice(0, 100) : '';
    s.title = title = `${s.baseTitle}-${s.suffix || s.n}`;
    $('.title', s.tab).textContent = title;
    s.tab.title = title;
    s.tab.addEventListener('click', (e) => {
      if (e.target.classList.contains('x')) askClose(s); // 别的设备在用时先确认 (见 42-owner.js)
      else activate(s);
    });
    // 手机 Chrome 的触摸校正会把点在标签文字上的手指吸到旁边能点的元素上 —— 只认自己挂了 click 的，标签是 × 的祖先、不算，
    // 候选只剩 ×：× 加宽后标签又窄时，点标签就成了点关闭。文字也挂一个 (冒泡给上面的标签处理)，按住哪个算哪个
    $('.title', s.tab).addEventListener('click', () => {});
    s.tab.addEventListener('auxclick', (e) => { if (e.button === 1) askClose(s); });
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

  // 这台设备是什么 (别的设备上提示「正在 手机 上使用」)
  const deviceName = isTouch ? (Math.min(screen.width, screen.height) < 600 ? '手机' : '平板') : '电脑';

  function send(s, obj) {
    if (!s.ws || s.ws.readyState !== WebSocket.OPEN) return;
    if (obj.type === 'data' && !obj.auto && inputLocked(s)) return; // 别的设备在用：先点「在本机继续」(见 42-owner.js)
    // 打字 / 按键 = 回到实时画面。程序询问的自动应答 (auto，如焦点进出 \x1b[O / \x1b[I) 不算：
    // 打开历史视图时焦点从终端挪到历史视图上，开了焦点上报 (?1004) 的程序会让 xterm 立刻发一个「焦点离开」，
    // 以前这一下就把刚打开的历史视图关掉了 —— 不启用输入框 (焦点在终端) 时滚轮进不了历史画面就是这个原因
    if (obj.type === 'data' && !obj.auto && s.scrollView) closeLocalScroll(s);
    // 终端自己的滚动区往上翻着也回到最底下：xterm 只管从它自己的输入框打的字，手机输入栏 / 下方输入框发的它不知道
    if (obj.type === 'data' && !obj.auto) scrollTermToBottom(s);
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
    clearTimeout(s.wakeTimer);
    s.frozeOff = false; // 冻住时关掉的：这就重连了 (醒来时 resume 不用再连一遍)
    // 新连接接上会话 (服务端发来 status) 之前不算连着：sid 是旧连接的。以前回到前台重连时 sid 还留着，
    // 这时滑动就去要历史，请求发在还没接上的新连接上 / 已经死掉的旧连接上，等 12 秒超时再冷却 30 秒
    if (s.sid) { s.sid = null; updateSftpBtn(); }
    cancelHistoryWait(s); // 在等的历史走的是旧连接，不会来了
    dropHeldOut(s); // 后台时攒着没画的输出：新连接从终端里现有的画面接着补
    hideReconnect(s);
    setStatus(s, 'wait');
    if (s.box.clientWidth && !s.scrollView) s.fit.fit();

    // 旧的连接还开着 (点「重试」、回前台重连时)：先关掉，不然服务端那边多挂一个
    const old = s.ws;
    if (old && old.readyState <= WebSocket.OPEN) { s.ws = null; try { old.close(); } catch {} }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    s.ws = ws;
    s.lastMsg = s.connAt = Date.now();

    ws.onopen = () => {
      if (s.ws !== ws) return;
      s.retries = 0;
      s.lastMsg = Date.now();
      // 连上时的尺寸。要不要当使用者 (终端按这台设备排版)：最先用的客户端锁定标签，别人只能点「在本机继续」接管 ——
      // 这里只在没人用时才当 ('auto')；原来就是这台在用的 (同一个页面重连、同一个浏览器刷新)，服务端认得出 (pageId / deviceId)，还是它。
      // 是不是这台在用 (s.mine) 先照旧，服务端连上就会重新告诉：锁着的断线重连期间也锁着，打的字不会发出去
      // 镜像显示的是使用者的行列，报这台设备自己放得下的 (见 sendSize)
      const own = s.mine === false && s.box.clientWidth ? s.fit.proposeDimensions() : null;
      const size = !s.box.clientWidth ? {} : own?.cols ? { cols: own.cols, rows: own.rows } : { cols: s.term.cols, rows: s.term.rows };
      size.claim = document.hidden ? false : 'auto';
      // 还没显示出来 (恢复标签时后台的标签量不出尺寸)：等量出尺寸再接管 (见 syncSize)
      s.wantClaim = size.cols ? false : size.claim;
      size.device = deviceName;
      if (s.remoteId) {
        // 打开页面时在后台、还没看过的标签：先只要状态，不要画面 (最多 5000 行的快照)，切过来时再要 (见 activate)。
        // 冻住 / 后台待久了醒来换连接时 (wakeLite，见 wakeTab) 不在看的标签也这样：醒来一下子十来个标签一起补画面，
        // 正在看的、点推送要看的那个就得排在后面等。还没要过画面的 (lite) 重连也照旧只要状态
        s.lite = s !== active && (!s.shown || s.lite || !!s.wakeLite);
        s.wakeLite = false;
        // offset: 已收到的输出字节数，断线重连时服务端只补发缺的部分
        ws.send(JSON.stringify({ type: 'attach', id: s.remoteId, offset: s.offset, pageId, deviceId, lite: s.lite, ...size }));
      } else {
        // suffixNew：名字是刚改的、还没送到服务端 (服务重启期间改的名等)，接上常驻会话时要记到会话上 (见 session/index.js)
        ws.send(JSON.stringify({ type: 'connect', ...s.params, title: s.baseTitle, n: s.n, ...(s.suffix && { suffix: s.suffix }), ...(s.pendingSuffix != null && { suffixNew: true }), histHost: s.histHost, pageId, deviceId, ...size }));
      }
      // 应用层心跳，避免 Cloudflare / 反向代理 100 秒空闲断开；服务端每次都回 pong。
      // 不在这里判断「多久没收到东西就断开重连」：ping/pong 往返慢一个周期 (隧道卡、主机忙) 就会把好连接误杀，
      // 制造一次莫名其妙的断线；假死连接的检测放在回到前台时做 (wakeTabs 发一个 ping，几秒没回才断)
      clearInterval(s.ping);
      s.ping = setInterval(() => {
        if (s.ws !== ws) return clearInterval(s.ping);
        send(s, { type: 'ping' });
      }, 25000);
    };
    ws.onmessage = (ev) => {
      if (s.ws !== ws) return;
      // 页面的 JS 停过 (冻住了没收到 freeze 事件、电脑睡眠过) 刚醒：这条多半是排着队的旧输出，后面还有一大堆，
      // 写进 xterm 就要从旧到新全画一遍。不写，换新连接只补缺的 (旧连接后面的消息都不要了，见上面 s.ws !== ws)
      if (!document.hidden && Date.now() - tickAt >= PAUSED_MS) { pausedSeen = true; wakeTabs(); if (s.ws !== ws) return; }
      s.lastMsg = Date.now(); // 收到过东西 (输出 / pong) = 连接还活着 (见心跳和 wakeTabs)
      if (ev.data instanceof ArrayBuffer) {
        if (s.awaitScreen) return; // 回到前台向服务端要了画面：在那之前到的输出都包含在回答里了 (见 releaseOut)
        if (s.offset !== undefined) s.offset += ev.data.byteLength;
        s.lastOut = Date.now();
        if (pipWin && s.lastOut - (lastStatusPaint || 0) > 300) { lastStatusPaint = s.lastOut; renderDeskTabs(); }
        const replay = s.muteOsc52;
        if (document.hidden) { holdOut(s, new Uint8Array(ev.data), replay); return; }
        writeOut(s, new Uint8Array(ev.data), replay);
        return;
      }
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'attached') {
        const isNew = !s.remoteId;
        s.remoteId = m.session.id;
        s.params = m.session.params || s.params;
        if (m.session.n && m.session.n !== s.n) setTabNumber(s, m.session.n); // 其他设备可能已用了这个序号
        if ((m.session.suffix || '') !== s.suffix) {
          if (s.pendingSuffix != null) { // 命名时断线没送到：连上补发
            send(s, { type: 'rename', suffix: s.pendingSuffix });
            s.pendingSuffix = null;
          } else applyTabSuffix(s, m.session.suffix || ''); // 别的设备上命过名 / 服务端还原的
        } else s.pendingSuffix = null;
        if (isNew) saveTabOrder();
        if (active === s) saveActive();
        reportWatching();
      } else if (m.type === 'renamed') { // 这个标签命了名 (本机 / 别的设备 / 服务端还原上次的名字)
        applyTabSuffix(s, m.suffix);
        s.pendingSuffix = null;
      } else if (m.type === 'params') { // 接上了常驻会话 (见 lib/session/daemon.js)：记下是哪个，服务重启后照原样接回去
        s.params = m.params || s.params;
      } else if (m.type === 'snapshot') {
        s.awaitScreen = false;
        s.offset = m.offset;
        // 网页在后台：先不画 (同 holdOut)，回到前台再画；之后的输出接在它后面攒着
        if (document.hidden) { s.holdSnap = m.data; s.hold = []; s.holdBytes = 0; s.holdFrom = m.offset; return; }
        applySnapshot(s, m.data);
      } else if (m.type === 'resume') {
        s.awaitScreen = false;
        // 接下来的一帧是断开期间的输出补发，其中的复制序列是以前的，不再写剪贴板
        if (m.bytes) s.muteOsc52 = true;
        // 画面还在，服务端接着补发断开期间的输出
        doneRestoring(s);
        if (active === s) syncSize(s);
      } else if (m.type === 'winpty') {
        // Windows 主机：终端隔着 ConPTY，缩放时不自己重新折行，交给 ConPTY 重画 (见 lib/session/index.js 的 detectWinPty)
        s.term.options.windowsPty = m.on ? { backend: 'conpty' } : undefined;
        s.winHost = !!m.on;
        s.el.dataset.winpty = m.on ? '1' : '';
      } else if (m.type === 'status') {
        s.sid = m.status === 'connected' ? m.sid : null;
        setStatus(s, m.status === 'connected' ? 'ok' : m.status === 'connecting' ? 'wait' : 'bad');
        if (m.status === 'closed') showReconnect(s, '重新连接');
        else hideReconnect(s);
        updateSftpBtn();
        if (s === active) updateLat();
        if (m.status === 'connected' && s === active) measureRtt(); // 连上就测，不等下一轮
        if (m.status === 'connected') {
          historyConnected(s); // 上次是连接问题取不到历史的：不用再冷却，滑一下就能进历史画面 (见 55-local-scroll.js)
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
      } else if (m.type === 'agent-cwd') { // Agent 的目录变了：右边栏重新读 (见 66-right-bar.js)
        rbAgentCwd(s);
      } else if (m.type === 'toast') { // 服务端的一句提示 (比如常驻会话里不用再开 tmux)
        fontToast(s, m.text, 6000);
      } else if (m.type === 'daemon-pick' && dpOpen?.tag === s.id) { // 选择框开着 (删完一个服务端再问)：原地刷新列表
        dpOpen.update(m);
      } else if (m.type === 'daemon-pick') { // 常驻会话：选接哪个 (见 lib/session/daemon.js 的 pickDaemon)
        activate(s);
        daemonPickDialog(m, s.id, (kill, force) => send(s, { type: 'daemon-pick-response', kill, keep: true, ...(force && { force: true }) })).then((r) => {
          if (r === undefined) return; // 已在其他设备上选了
          // 切到正用着这个会话的标签：这个标签不要了 (同「退出」，服务端关掉它)
          if (r?.go) { if (!r.go.closed) activate(r.go); r = null; }
          send(s, r ? { type: 'daemon-pick-response', ...r } : { type: 'daemon-pick-response', cancel: true });
        });
      } else if (m.type === 'daemon-update') { // 主机上在跑的 sshwebd 是旧版、里面还有常驻会话：要不要现在强制换成新版 (见 lib/session/daemon.js)
        activate(s);
        dialog('sshwebd 有新版本', `<p>主机上在跑的 sshwebd 是 v${esc(m.old)}，SSH-WEB 带了 v${esc(m.ver)}，里面还有 ${m.n} 个常驻会话在跑。</p>
          <p class="muted">换成新版会结束这些会话（里面正跑的程序一起结束；Claude Code 等的对话可以在「💬 会话历史」里继续）。先用现有的也行，下次连接时再问。</p>`,
        [{ label: '否，先用现有的', value: null, cancel: true }, { label: '是，换成新版', value: true, cls: 'danger' }])
          .then((r) => send(s, { type: 'daemon-update-response', update: r.value === true }));
      } else if (m.type === 'tmux-history') {
        onTmuxHistory(s, m);
      } else if (m.type === 'owner') {
        s.mine = m.mine; // 是不是这台设备在用 (终端按它排版)
        if (m.cols) s.srvSize = { cols: m.cols, rows: m.rows };
        updateOwnerNotice(s, m);
        if (active === s && s.box.clientWidth && !s.scrollView) s.fit.fit(); // 锁住：换成镜像；解锁：按本机排版
      } else if (m.type === 'tsize') {
        s.srvSize = { cols: m.cols, rows: m.rows }; // 使用者那边尺寸变了，镜像跟着变
        if (active === s && s.mine === false && s.box.clientWidth && !s.scrollView) s.fit.fit();
      } else if (m.type === 'agent') {
        s.agent = { id: m.agent, name: m.name }; // 钩子报的这个标签里在跑的 Agent (按键栏「立即发送」用，见 30-mobile-input.js)
      } else if (m.type === 'cli') {
        s.cli.set(m); // 服务器算的终端输入框内容 (包括别的设备上打的字)
      } else if (m.type === 'state') {
        s.srvState = { label: m.label, cls: m.cls, detail: m.detail || '' };
        s.tab.title = s.srvState.detail ? `${s.title}\n${m.label}：${s.srvState.detail}` : s.title; // 鼠标移到标签上也看得到在做什么
        renderDeskTabs();
        gitOnState(s, m); // Agent 做完了：代码改动面板开着就刷新 (见 66-git-changes.js)
      } else if (m.type === 'pong') {
        if (Number.isFinite(m.t)) { s.rtt = latSample(s, 'web', Math.round(performance.now() - m.t)); if (s === active) updateLat(); }
      } else if (m.type === 'lat') {
        s.sshRtt = latSample(s, 'ssh', m.ssh);
        if (s === active) updateLat();
      } else if (m.type === 'notice') {
        // 标签上的 🔔：有没看过的新通知才挂 (哪些算新通知、什么时候算看过由服务端记，见 Session.newNotice)
        const viewing = s === active && !document.hidden;
        if (viewing && m.seq > m.ack) reportWatching(); // 正在看：告诉服务端看过了
        s.tab.classList.toggle('ring', m.seq > m.ack && !viewing);
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
        // 服务端没有这个会话了 (别的设备关掉了 / 服务重启过)：标签以服务端为准，直接关掉。
        // 以前服务重启后留着标签提示「后台会话已不存在」，别的设备新开的又同步过来，标签越来越多
        closeSession(s, true);
      }
    };
    ws.onclose = () => {
      clearInterval(s.ping);
      if (s.closed || s.ws !== ws) return;
      s.sid = null;
      cancelHistoryWait(s);
      updateSftpBtn();
      setStatus(s, 'wait');
      if (!s.remoteId) { showReconnect(s, '重试'); return; }
      // 网络断开：后台会话仍在，自动重新挂载。断网又在后台时先不试 (费电)，回到前台 / 网络恢复时马上重连 (见下面的 wakeTabs)
      const delay = Math.min(1000 * 2 ** (s.retries || 0), 10000);
      s.retries = (s.retries || 0) + 1;
      if (s.retries > 3) showReconnect(s, '正在重新连接… 点击立即重试');
      if (document.hidden && navigator.onLine === false) return;
      s.retryTimer = setTimeout(() => connect(s), delay);
    };
  }

  // 回到前台、网络恢复：在等重试的标签马上重连 (不用等最长 10 秒的退避)。
  // 看着还连着的：手机 / 平板在后台待了一阵 (点推送通知回来多半是这样)，系统早把连接掐了、网页这边还以为连着 ——
  // 以前先发心跳等 8 秒，没回话再关连接，关一个已经断了的连接浏览器还要等关闭握手 (可能几十秒) 才报关闭，再退避重连，
  // 回来后很久才看到最新画面，这期间滑动还会把终端的旧画面滚上去 (见 55-local-scroll.js)。现在：
  // - 手机 / 平板在后台待了 WAKE_RECONNECT_MS 以上：不等，直接换新连接
  // - 别的：发心跳，WAKE_PING_MS 内没回话就直接换新连接 (不等旧的关掉)；连接其实还好的话也只是多握一次手。
  //   固定时长，不按测到的延迟放宽：断线重连时扣着的回答一下子到了，测到的延迟会大得离谱
  // - 页面的 JS 停过 (PAUSED_MS，见下面的 tickAt)：电脑睡眠过、页面被冻住过，连接多半已经死了或者积压着一大堆旧输出，也直接换
  // 换新连接时带着已收到的字节数，服务端只补发缺的部分，画面不会重来；不在看的标签先只要状态 (wakeLite)，切过去再要画面
  const WAKE_RECONNECT_MS = 10000;
  const WAKE_PING_MS = 3000;
  let hiddenAt = document.hidden ? Date.now() : 0;
  // JS 停过没有：页面在跑时下面的定时器每 TICK_MS 跑一次，后台时浏览器把它压到最慢大约一分钟一次；
  // 隔了 PAUSED_MS 以上一次都没跑 = 页面被冻住过 / 电脑睡眠过。醒来先跑到的是定时器还是排着队的消息 (见 onmessage) 都认得出
  const TICK_MS = 15000;
  const PAUSED_MS = 150000;
  let tickAt = Date.now(), pausedSeen = false;
  function wakeTabs() {
    if (document.hidden) { hiddenAt ||= Date.now(); return; }
    const away = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    const paused = pausedSeen || Date.now() - tickAt >= PAUSED_MS;
    pausedSeen = false;
    tickAt = Date.now();
    const stale = paused || (isTouch && away >= WAKE_RECONNECT_MS);
    // 正在看的标签先连
    for (const s of [active, ...sessions.filter((x) => x !== active)]) wakeTab(s, stale);
  }
  // 一个标签：连接死了 / 要换 (stale) 就换新连接；看着还连着的发心跳，WAKE_PING_MS 内没回话再换。
  // 刚换过的 (醒来时 resume 已经连了) 不再换一遍
  function wakeTab(s, stale) {
    if (!s || s.closed) return;
    if (!s.remoteId) { releaseOut(s); return; }
    const ws = s.ws;
    if (!ws || ws.readyState > WebSocket.OPEN || (stale && Date.now() - (s.connAt || 0) > 2000)) {
      if (stale && s !== active) s.wakeLite = true;
      connect(s);
      return;
    }
    releaseOut(s); // 后台时攒着的输出 (见 holdOut)
    if (ws.readyState !== WebSocket.OPEN) return; // 正在连
    const at = Date.now();
    send(s, { type: 'ping' });
    clearTimeout(s.wakeTimer);
    s.wakeTimer = setTimeout(() => { if (s.ws === ws && !s.closed && (s.lastMsg || 0) < at) connect(s); }, WAKE_PING_MS);
  }
  document.addEventListener('visibilitychange', wakeTabs);
  window.addEventListener('online', wakeTabs);

  // JS 停过没有 (定时器和常量在上面 wakeTabs 前面)
  setInterval(() => {
    if (Date.now() - tickAt >= PAUSED_MS) {
      pausedSeen = true; // 在后台：回到前台时换 (见 wakeTabs)
      if (!document.hidden) wakeTabs();
    }
    tickAt = Date.now();
  }, TICK_MS);

  // 页面要被冻住了 (Edge 的睡眠标签、Chrome 省电模式冻结后台标签)：冻着时 JS 不跑，连接还开着，服务端照样发，
  // 消息在浏览器里排着队、服务端那边越积越多 (积压超过 1MB 还会停读 SSH，里面的程序 (Claude Code) 跟着卡住，15 秒后才断开这个页面)；
  // 醒来时一下子交给网页，已经在前台了就全写进 xterm，几 MB 的状态行重绘从旧到新画一遍 ——
  // 看着就是点推送进来停在旧消息上、好久才追上。现在冻住前把连接都关掉，醒来再连，只补缺的
  document.addEventListener('freeze', () => {
    for (const s of sessions) {
      if (s.closed || !s.remoteId || !s.ws) continue;
      const ws = s.ws;
      s.ws = null; // 它的关闭事件不再管 (不排重连，见 onclose)
      s.frozeOff = true;
      clearInterval(s.ping);
      clearTimeout(s.wakeTimer);
      try { ws.close(); } catch {}
    }
  });
  document.addEventListener('resume', () => {
    tickAt = Date.now(); // 冻着时关掉的连接这里就重连了，不用再按「JS 停过」换一遍
    pausedSeen = false;
    for (const s of [active, ...sessions.filter((x) => x !== active)]) {
      if (!s || s.closed || !s.frozeOff) continue;
      s.frozeOff = false;
      clearTimeout(s.retryTimer);
      if (s !== active) s.wakeLite = true;
      connect(s);
    }
  });

  // 回到最新的实时画面：关掉历史视图，终端滚动区滚到最底下 (点推送通知进来时：要看的是现在的)
  function goLive(s) {
    if (s.scrollView) closeLocalScroll(s);
    scrollTermToBottom(s);
  }
  function scrollTermToBottom(s) {
    const b = s.term.buffer.active;
    if (b.viewportY < b.baseY) s.term.scrollToBottom();
  }

  // 终端输出写进 xterm。replay：断线期间补发的那一帧，里面的复制序列是以前的，不写剪贴板
  function writeOut(s, data, replay) {
    if (replay) s.muteOsc52 = true;
    s.term.write(data, () => {
      if (replay) s.muteOsc52 = false;
      checkCapture(s);
      predCheck(s);
    });
  }
  // 还原服务端保存的画面和滚动记录
  function applySnapshot(s, data) {
    predClear(s, false);
    s.term.reset();
    // 画完停在最底下：几千行的快照手机上要画好一会儿，期间滚动区被滚上去过的话 xterm 不会跟到底，停在中间的旧画面上
    s.term.write(data, () => s.term.scrollToBottom());
    doneRestoring(s);
    if (active === s) syncSize(s);
  }

  // 网页在后台时收到的输出先不写进终端，攒着，回到前台再说 (见 releaseOut)。
  // 浏览器把后台网页的定时器压得很慢 (待了 5 分钟以上大约一分钟才跑一次)，xterm 靠定时器一小段一小段地处理写进去的输出，
  // 后台待久了攒下几 MB 没处理 (Claude Code 干活时状态行一秒刷好几次)；回到前台它要把这些重绘从旧到新全画一遍，
  // 看着就是「Ebbing… (1h 5m 50s …)」停在旧的时间不动，过好一阵才追上
  const HOLD_MAX = 256 * 1024;
  function holdOut(s, data, replay) {
    // holdFrom：攒之前终端画到了第几字节。新开的标签没记 (undefined)，要画面时服务端给整屏快照
    if (s.hold == null) { s.hold = []; s.holdBytes = 0; s.holdFrom = s.offset === undefined ? undefined : s.offset - data.length; }
    if (replay) s.muteOsc52 = false; // 记在这一帧上，写的时候再关剪贴板 (见 writeOut)
    if (s.hold === false) return; // 攒太多了：不再攒，回到前台直接要现在的画面
    s.hold.push([data, replay]);
    s.holdBytes += data.length;
    if (s.holdBytes > HOLD_MAX) s.hold = false;
  }
  // 回到前台：攒的不多就照常写进终端 (不用等服务端)；攒太多了不一条条补画，向服务端要现在的画面 ——
  // 服务端只补发缺的部分，缺得多时给一整屏快照 (见 lib/session/index.js 的 sendScreen)
  function releaseOut(s) {
    const { hold, holdSnap, holdFrom } = s;
    if (hold == null) return;
    s.hold = s.holdSnap = null;
    if (hold === false) {
      // 攒着的里面有还没画的快照：终端里还是快照之前的画面，只补后面缺的会对不上，要整屏快照 (不给 offset)
      const from = holdSnap != null ? undefined : holdFrom;
      s.offset = from;
      s.awaitScreen = true;
      send(s, { type: 'sync', offset: from });
      return;
    }
    if (holdSnap != null) applySnapshot(s, holdSnap);
    for (const [data, replay] of hold) writeOut(s, data, replay);
  }
  // 换新连接：攒着的不要了，从终端里现有的画面接着补 (还没画的快照：终端里是快照之前的画面，对不上，整屏重要)
  function dropHeldOut(s) {
    if (s.holdSnap != null) s.offset = undefined;
    else if (s.hold != null) s.offset = s.holdFrom;
    s.hold = s.holdSnap = null;
    s.awaitScreen = false;
  }

  function doneRestoring(s) {
    s.restoring?.remove();
    s.restoring = null;
  }

  // 让服务端终端尺寸与当前显示一致 (其他设备可能改过尺寸)
  function syncSize(s) {
    if (!s.box.clientWidth) return;
    if (!s.scrollView) s.fit.fit();
    sendSize(s, s.term.cols, s.term.rows);
  }

  // 告诉服务端这台设备的终端尺寸。不是使用者时只记下来 (换给它时用)，不改排版 (要接管见 claimSize)
  function sendSize(s, cols, rows) {
    if (!s.ws || s.ws.readyState !== WebSocket.OPEN) return; // 还没连上：连上时会带上尺寸
    if (s.mine === false) { // 镜像显示的是使用者的行列，报告的是这台设备放得下的
      const d = s.fit.proposeDimensions();
      if (!d?.cols || !d?.rows) return;
      cols = d.cols; rows = d.rows;
    }
    send(s, { type: 'resize', cols, rows, claim: s.mine ? 'auto' : (s.wantClaim || false) });
    s.wantClaim = false;
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
