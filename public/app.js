'use strict';

(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const app = $('#app');
  const form = $('#hostForm');
  const F = form.elements;
  let hosts = [];
  const sessions = [];
  let active = null;
  // 触屏设备 (手机 / 平板)
  const isTouch = window.matchMedia('(pointer: coarse)').matches;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  // 本页面的标识：服务端广播「新建会话 / 标签顺序」时，自己发起的就不用再处理
  const pageId = Math.random().toString(36).slice(2);

  // ------------------------------------------------------------ API
  async function api(method, url, body) {
    const r = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && url !== '/api/login') showLogin();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }

  // ------------------------------------------------------------ 登录
  function showLogin() {
    app.classList.add('hidden');
    $('#login').classList.remove('hidden');
    $('#loginForm [name=username]').focus();
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    $('#loginErr').textContent = '';
    try {
      await api('POST', '/api/login', { username: fd.get('username'), password: fd.get('password') });
      $('#login').classList.add('hidden');
      boot();
    } catch (err) {
      $('#loginErr').textContent = err.message;
    }
  });

  $('#btnLogout').addEventListener('click', async () => {
    await api('POST', '/api/logout');
    location.reload();
  });

  // 终端保留的滚动行数，与服务端 (重新打开页面时能还原的行数) 一致
  let scrollback = 5000;

  async function init() {
    const me = await api('GET', '/api/me');
    if (me.scrollback > 0) scrollback = me.scrollback;
    if (me.weakPassword) $('#weakPw').classList.remove('hidden');
    if (me.authEnabled && !me.authed) return showLogin();
    $('#btnLogout').classList.toggle('hidden', !me.authEnabled);
    boot();
  }

  async function boot() {
    app.classList.remove('hidden');
    showEmpty('loading');
    // 主机列表与后台会话同时加载，尽快恢复标签
    const [list] = await Promise.all([fetchSessions(), loadHosts().catch(() => {}), loadKeybar()]);
    if (list.length) restoreSessions(list);
    else showEmpty('idle');
    startEvents();
  }

  // 没有标签时的占位: loading = 正在恢复会话，idle = 新建连接提示
  function showEmpty(mode) {
    $('#empty').classList.remove('hidden');
    $('#emptyLoading').classList.toggle('hidden', mode !== 'loading');
    $('#emptyIdle').classList.toggle('hidden', mode !== 'idle');
  }

  // ------------------------------------------------------------ 主机列表
  async function loadHosts() {
    hosts = await api('GET', '/api/hosts');
    renderHosts();
  }

  function renderHosts() {
    const q = $('#search').value.trim().toLowerCase();
    const list = $('#hostList');
    list.innerHTML = '';
    const filtered = hosts.filter((h) =>
      !q || [h.name, h.host, h.username, h.group].join(' ').toLowerCase().includes(q));
    const groups = {};
    filtered.forEach((h) => (groups[h.group || ''] ||= []).push(h));
    Object.keys(groups).sort().forEach((g) => {
      if (g) {
        const t = document.createElement('div');
        t.className = 'group-title';
        t.textContent = g;
        list.appendChild(t);
      }
      groups[g].sort(hostOrder).forEach((h) => {
        const el = document.createElement('div');
        el.className = 'host';
        el.dataset.id = h.id;
        el.dataset.group = h.group || '';
        el.innerHTML = `
          <div class="info"><div class="name"></div><div class="addr"></div></div>
          ${h.connType === 'cloudflare' ? '<span class="badge" title="Cloudflare 隧道">CF</span>' : ''}
          <div class="ops"><button data-op="edit" title="编辑">✎</button><button data-op="del" title="删除">✕</button></div>`;
        $('.name', el).textContent = h.name;
        $('.addr', el).textContent = h.connType === 'cloudflare'
          ? `${h.username}@${h.host}` : `${h.username}@${h.host}:${h.port}`;
        el.addEventListener('click', async (e) => {
          if (Date.now() < hostDragUntil) return; // 刚拖动完，不当作点击
          const op = e.target.dataset.op;
          if (op === 'edit') return openModal(h, true);
          if (op === 'del') {
            if (!confirm(`删除主机「${h.name}」？`)) return;
            await api('DELETE', '/api/hosts/' + h.id);
            return loadHosts();
          }
          closeSidebarOnMobile();
          if (h.hasSecret) openSession({ hostId: h.id }, h.name, h.connType);
          else openModal(h, false); // 未保存密码，弹窗输入
        });
        list.appendChild(el);
      });
    });
    if (!filtered.length) list.innerHTML = '<div class="muted" style="padding:8px">暂无主机</div>';
  }
  $('#search').addEventListener('input', renderHosts);

  // 排过序的按自定义顺序，没排过的按名称 (排在后面，如新加的主机)
  function hostOrder(a, b) {
    const ao = a.order ?? Infinity;
    const bo = b.order ?? Infinity;
    return ao !== bo ? ao - bo : a.name.localeCompare(b.name);
  }

  // ------------------------------------------------------------ 侧边栏主机拖动排序
  // 电脑：按住拖动超过 5px 开始；手机：长按 350ms 开始 (避免和上下滑动列表冲突)；只在同一分组内移动
  const hostListEl = $('#hostList');
  let hostDrag = null;
  let hostDragUntil = 0;

  function beginHostDrag() {
    if (!hostDrag) return;
    hostDrag.started = true;
    hostDrag.el.classList.add('dragging');
    if (hostDrag.touch) navigator.vibrate?.(15);
  }

  function moveHostDrag(y) {
    const el = hostDrag.el;
    const same = (x) => x && x.classList.contains('host') && x.dataset.group === el.dataset.group;
    const prev = el.previousElementSibling;
    const next = el.nextElementSibling;
    const mid = (x) => { const r = x.getBoundingClientRect(); return r.top + r.height / 2; };
    if (same(prev) && y < mid(prev)) hostListEl.insertBefore(el, prev);
    else if (same(next) && y > mid(next)) hostListEl.insertBefore(el, next.nextSibling);
    // 拖到边缘时自动滚动列表
    const r = hostListEl.getBoundingClientRect();
    if (y < r.top + 30) hostListEl.scrollTop -= 10;
    else if (y > r.bottom - 30) hostListEl.scrollTop += 10;
  }

  async function endHostDrag() {
    if (!hostDrag) return;
    clearTimeout(hostDrag.timer);
    const d = hostDrag;
    hostDrag = null;
    if (!d.started) return;
    d.el.classList.remove('dragging');
    hostDragUntil = Date.now() + 400;
    // 界面上的顺序 (搜索过滤时，未显示的主机保持原来的相对位置排在后面)
    const shown = [...hostListEl.querySelectorAll('.host')].map((x) => x.dataset.id);
    const rest = hosts.slice().sort(hostOrder).map((h) => h.id).filter((id) => !shown.includes(id));
    const ids = [...shown, ...rest];
    ids.forEach((id, i) => { const h = hosts.find((x) => x.id === id); if (h) h.order = i; });
    try { await api('PUT', '/api/hosts/order', { ids }); } catch (e) { alert('保存顺序失败：' + e.message); }
  }

  hostListEl.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.host');
    if (!el || e.target.closest('.ops') || e.button > 0) return;
    hostDrag = { el, startX: e.clientX, startY: e.clientY, started: false, touch: e.pointerType !== 'mouse' };
    if (hostDrag.touch) hostDrag.timer = setTimeout(beginHostDrag, 350);
  });
  window.addEventListener('pointermove', (e) => {
    if (!hostDrag) return;
    if (!hostDrag.started) {
      const moved = Math.max(Math.abs(e.clientX - hostDrag.startX), Math.abs(e.clientY - hostDrag.startY));
      if (hostDrag.touch) { if (moved > 8) endHostDrag(); return; } // 长按前就移动了 = 在滚动列表
      if (moved < 5) return;
      beginHostDrag();
    }
    moveHostDrag(e.clientY);
  });
  window.addEventListener('pointerup', endHostDrag);
  window.addEventListener('pointercancel', endHostDrag);
  hostListEl.addEventListener('touchmove', (e) => { if (hostDrag && hostDrag.started) e.preventDefault(); }, { passive: false });
  hostListEl.addEventListener('contextmenu', (e) => { if (e.target.closest('.host')) e.preventDefault(); });

  // ------------------------------------------------------------ 连接表单
  let editing = null; // 当前编辑的已保存主机

  function syncFormMode() {
    const cf = F.connType.value === 'cloudflare';
    form.classList.toggle('cf', cf);
    form.classList.toggle('key', F.authType.value === 'key');
    $('#hostLabel').textContent = cf ? '隧道主机名 (Hostname)' : '主机 / IP';
    F.host.placeholder = cf ? 'ssh.example.com' : '192.168.1.10';
  }
  form.addEventListener('change', (e) => {
    if (e.target.name === 'connType' || e.target.name === 'authType') syncFormMode();
  });

  $('#keyFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) F.privateKey.value = await f.text();
  });

  function openModal(h, editOnly) {
    editing = h || null;
    form.reset();
    F.id.value = h ? h.id : '';
    $('#modalTitle').textContent = h ? (editOnly ? '编辑主机' : `连接 ${h.name}`) : '新建连接';
    if (h) {
      F.name.value = h.name;
      F.group.value = h.group;
      F.host.value = h.host;
      F.port.value = h.port;
      F.username.value = h.username;
      F.connType.value = h.connType || 'direct';
      F.authType.value = h.authType || 'password';
      F.cfClientId.value = h.cfClientId || '';
    }
    const tips = [];
    if (h && h.hasSecret) tips.push('已保存登录凭据，留空则保持不变');
    if (h && h.hasCfSecret) tips.push('已保存 CF Client Secret，留空则保持不变');
    $('#secretHint').textContent = tips.join('；');
    $('#formErr').textContent = '';
    syncFormMode();
    $('#modal').classList.remove('hidden');
    (h ? (F.authType.value === 'key' ? F.privateKey : F.password) : F.host).focus();
  }

  function closeModal() { $('#modal').classList.add('hidden'); }

  function formData() {
    const d = Object.fromEntries(new FormData(form).entries());
    d.port = parseInt(d.port, 10) || 22;
    if (d.authType === 'password') { d.privateKey = ''; d.passphrase = ''; }
    else d.password = '';
    if (d.connType !== 'cloudflare') { d.cfClientId = ''; d.cfClientSecret = ''; }
    return d;
  }

  async function saveHost(d) {
    const body = { ...d };
    // 切换了认证方式时清掉旧凭据
    if (editing && editing.authType !== d.authType) body.clearSecret = true;
    const saved = await api('POST', '/api/hosts', body);
    await loadHosts();
    return saved;
  }

  $('#btnCancel').addEventListener('click', closeModal);
  $('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  $('#btnSaveOnly').addEventListener('click', async () => {
    if (!form.reportValidity()) return;
    try {
      await saveHost(formData());
      closeModal();
    } catch (err) { $('#formErr').textContent = err.message; }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData();
    const title = d.name || `${d.username}@${d.host}`;
    try {
      if (d.save) {
        const saved = await saveHost(d);
        // 通过 hostId 连接；本次输入的凭据同时带上 (若为空，服务端用已保存的)
        openSession({ hostId: saved.id, password: d.password, privateKey: d.privateKey, passphrase: d.passphrase },
          saved.name, d.connType);
      } else if (editing) {
        openSession({ hostId: editing.id, password: d.password, privateKey: d.privateKey, passphrase: d.passphrase },
          title, d.connType);
      } else {
        openSession(d, title, d.connType);
      }
      closeModal();
      closeSidebarOnMobile();
    } catch (err) { $('#formErr').textContent = err.message; }
  });

  $('#btnNew').addEventListener('click', () => openModal(null));

  // ------------------------------------------------------------ 终端会话
  // ------------------------------------------------------------ 主题 (跟随系统 / 浅色 / 深色)
  const TERM_THEMES = {
    dark: {
      background: '#000000', foreground: '#e5e7eb', cursor: '#22c55e', cursorAccent: '#000000',
      selectionBackground: 'rgba(148,163,184,.35)',
    },
    // 浅色终端用 GitHub Light 的 ANSI 色板，白底上黄色 / 白色也能看清
    light: {
      background: '#ffffff', foreground: '#1f2328', cursor: '#16a34a', cursorAccent: '#ffffff',
      selectionBackground: 'rgba(9,105,218,.2)',
      black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#9a6700', blue: '#0969da',
      magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
      brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01',
      brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
    },
  };
  const systemLight = window.matchMedia('(prefers-color-scheme: light)');
  const themeMode = () => { try { return localStorage.getItem('sshweb.theme') || 'auto'; } catch { return 'auto'; } };
  const effectiveTheme = () => {
    const m = themeMode();
    return m === 'auto' ? (systemLight.matches ? 'light' : 'dark') : m;
  };
  const termTheme = () => TERM_THEMES[effectiveTheme()];

  function applyTheme() {
    const m = themeMode();
    if (m === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = m;
    const eff = effectiveTheme();
    document.querySelector('meta[name=theme-color]').content = eff === 'light' ? '#ffffff' : '#111827';
    $('#themeSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    for (const s of sessions) s.term.options.theme = termTheme();
    for (const s of sessions) if (s.mon && s.mon.redraw) s.mon.redraw();
    syncPipTheme();
  }

  $('#themeSeg').addEventListener('click', (e) => {
    const mode = e.target.dataset.mode;
    if (!mode) return;
    try { localStorage.setItem('sshweb.theme', mode); } catch {}
    applyTheme();
  });
  systemLight.addEventListener('change', () => { if (themeMode() === 'auto') applyTheme(); });

  // restore: 服务端已有的后台会话信息 (刷新 / 重新打开浏览器时恢复)
  function openSession(params, title, connType, restore) {
    $('#empty').classList.add('hidden');
    const s = { id: Math.random().toString(36).slice(2), params, title, connType };
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
    }
    s.ro = new ResizeObserver(() => { if (active === s) s.fit.fit(); });
    s.ro.observe(s.box);
    s.term.onData((data) => {
      if (data === '\r') beginCapture(s);
      send(s, { type: 'data', data });
    });
    s.term.onResize(({ cols, rows }) => send(s, { type: 'resize', cols, rows }));
    // 旧式鼠标编码 (X10 等) 的上报走 onBinary，需要按原始字节发送
    s.term.onBinary((data) => {
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

  function send(s, obj) {
    if (!s.ws || s.ws.readyState !== WebSocket.OPEN) return;
    // 主机状态：输入 / 调整大小后的回显、重绘不算「运行中」；发了输入 = 已经看到了，「完成」清掉
    if (obj.type === 'data' || obj.type === 'resize') s.inputAt = Date.now();
    if (obj.type === 'data') {
      s.alertAt = s.doneAt = 0;
      s.dataAt = Date.now();
      if (s.scrollView) closeLocalScroll(s); // 打字 / 按键 = 回到实时画面
    }
    // 大段粘贴分块发送，避免单条消息超过服务端 1MB 上限导致连接被断开
    if (obj.type === 'data' && typeof obj.data === 'string' && obj.data.length > 32768) {
      for (let i = 0; i < obj.data.length; i += 32768) s.ws.send(JSON.stringify({ type: 'data', data: obj.data.slice(i, i + 32768) }));
      return;
    }
    s.ws.send(JSON.stringify(obj));
  }

  // 打开 WebSocket 并挂载到后台会话：已有会话用 attach，新连接用 connect
  function connect(s) {
    clearTimeout(s.retryTimer);
    hideReconnect(s);
    setStatus(s, 'wait');
    if (s.box.clientWidth) s.fit.fit();

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    s.ws = ws;
    const size = s.box.clientWidth ? { cols: s.term.cols, rows: s.term.rows } : {};

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
        if (s.lastOut - (s.inputAt || 0) > 400) { // 输入后 0.4 秒内的是回显
          (s.outTimes ||= []).push(s.lastOut);
          if (s.outTimes.length > 30) s.outTimes.splice(0, s.outTimes.length - 30);
          if (isRunning(s, s.lastOut)) { s.running = true; s.alertAt = s.doneAt = 0; } // 又开始干活了，之前的「完成」作废
        }
        const replay = s.muteOsc52;
        s.term.write(new Uint8Array(ev.data), () => {
          if (replay) s.muteOsc52 = false;
          checkCapture(s);
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
          if (active === s) focusTerm(s);
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
      } else if (m.type === 'pong') {
        if (Number.isFinite(m.t)) { s.rtt = Math.round(performance.now() - m.t); if (s === active) updateLat(); }
      } else if (m.type === 'lat') {
        s.sshRtt = m.ssh;
        if (s === active) updateLat();
      } else if (m.type === 'bell') {
        if (s !== active || document.hidden) s.tab.classList.add('ring');
        s.alertAt = Date.now();
        renderDeskTabs();
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
    s.fit.fit();
    send(s, { type: 'resize', cols: s.term.cols, rows: s.term.rows });
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

  // ------------------------------------------------------------ 多设备同步标签
  // 其他设备新开的标签、调整的顺序实时同步过来 (关闭标签由各会话自己的连接通知)。
  // 事件连接断开 (手机锁屏 / 断网) 重连后和服务端对一次账，补上漏掉的标签
  let eventsWs = null;
  let eventsRetry = 0;
  let eventsTimer = 0;

  function startEvents() {
    clearTimeout(eventsTimer);
    if (eventsWs && eventsWs.readyState <= WebSocket.OPEN) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    eventsWs = ws;
    let ping = 0;
    ws.onopen = () => {
      eventsRetry = 0;
      ws.send(JSON.stringify({ type: 'events' }));
      ping = setInterval(() => ws.send(JSON.stringify({ type: 'ping' })), 25000);
      syncTabs();
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.pageId === pageId) return;
      if (m.type === 'session-created') addRemoteTab(m.session);
      else if (m.type === 'order') applyTabOrder(m.ids);
    };
    ws.onclose = () => {
      clearInterval(ping);
      if (eventsWs !== ws) return;
      eventsTimer = setTimeout(startEvents, Math.min(1000 * 2 ** eventsRetry++, 10000));
    };
  }

  // 页面回到前台时立即重连 (手机锁屏期间连接可能已断)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && eventsWs && eventsWs.readyState > WebSocket.OPEN) startEvents();
  });

  function addRemoteTab(info) {
    if (!info || sessions.some((x) => x.remoteId === info.id)) return;
    const s = openSession(info.params || {}, info.title, info.connType, info);
    if (!active) activate(s);
  }

  async function syncTabs() {
    const list = await fetchSessions();
    // 本页正在新建的标签还不知道自己的会话 id，稍后再对账，避免重复
    if (sessions.some((x) => !x.remoteId && !x.closed)) { setTimeout(syncTabs, 1500); return; }
    list.forEach(addRemoteTab);
    applyTabOrder(list.map((x) => x.id));
  }

  function applyTabOrder(ids) {
    if (drag) return; // 本地正在拖动
    const pos = (x) => { const i = ids.indexOf(x.remoteId); return i < 0 ? Infinity : i; };
    sessions.sort((a, b) => pos(a) - pos(b));
    sessions.forEach((x) => tabsEl.appendChild(x.tab));
  }

  // ------------------------------------------------------------ GPU 渲染 (WebGL)
  // 整屏重画的程序 (Claude Code / top 等) 更流畅、更省电。只给当前标签启用：
  // 隐藏的标签本来就不绘制，且浏览器同时能用的 WebGL 数量有限。
  // 不支持 WebGL 或 GPU 上下文丢失 (手机切到后台时可能发生) 时退回默认渲染，回到前台再启用
  // 先检测再加载：插件在不支持的浏览器上加载失败时会残留在终端里，导致触摸滚动失效
  const webglSupported = (() => {
    try { return !!window.WebglAddon && !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
  })();
  let webglFails = webglSupported ? 0 : 3;

  function enableWebgl(s) {
    if (s.webgl || s.closed || webglFails >= 3) return;
    const addon = new WebglAddon.WebglAddon();
    try {
      addon.onContextLoss(() => {
        webglFails++;
        disableWebgl(s);
      });
      s.term.loadAddon(addon);
      s.webgl = addon;
    } catch {
      try { addon.dispose(); } catch {}
      webglFails = 3;
    }
  }

  function disableWebgl(s) {
    if (!s.webgl) return;
    try { s.webgl.dispose(); } catch {}
    s.webgl = null;
  }

  function setTabNumber(s, n) {
    s.n = n;
    s.title = `${s.baseTitle}-${n}`;
    $('.title', s.tab).textContent = s.title;
    s.tab.title = s.title;
    if (active === s) document.title = `${s.title} - SSH-WEB`;
  }

  function activate(s) {
    active = s;
    sessions.forEach((x) => {
      x.el.classList.toggle('active', x === s);
      x.tab.classList.toggle('active', x === s);
      if (x !== s) disableWebgl(x);
    });
    enableWebgl(s);
    requestAnimationFrame(() => { syncSize(s); focusTerm(s); });
    s.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    s.tab.classList.remove('ring');
    updateSftpBtn();
    updateMobileBar();
    measureRtt();
    saveActive();
    reportWatching();
    document.title = active ? `${active.title} - SSH-WEB` : 'SSH-WEB';
  }

  // remote: 会话已在服务端结束 (其他设备关闭)，只移除本地标签
  function closeSession(s, remote) {
    s.closed = true;
    clearInterval(s.ping);
    clearTimeout(s.retryTimer);
    if (s.mon) clearTimeout(s.mon.timer);
    // 结束后台会话 (断开 SSH)
    if (!remote && s.remoteId) {
      if (s.ws && s.ws.readyState === WebSocket.OPEN) send(s, { type: 'close' });
      else api('DELETE', '/api/sessions/' + s.remoteId).catch(() => {});
    }
    try { s.ws && s.ws.close(); } catch {}
    s.ro.disconnect();
    s.term.dispose();
    s.el.remove();
    s.tab.remove();
    sessions.splice(sessions.indexOf(s), 1);
    if (active === s) {
      active = null;
      if (sessions.length) activate(sessions[sessions.length - 1]);
      else showEmpty('idle');
    }
    updateSftpBtn();
    updateMobileBar();
    document.title = active ? `${active.title} - SSH-WEB` : 'SSH-WEB';
  }

  // 会话在后台保持，关闭 / 刷新页面不需要确认

  // ------------------------------------------------------------ 通用对话框
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let dialogQueue = Promise.resolve();
  let curDialog = null;

  // 同一会话的验证在其他设备上完成时，关闭本地弹窗
  function dismissDialog(tag) {
    if (curDialog && curDialog.tag === tag) curDialog.dismiss();
  }

  // buttons: [{ label, value, cls, submit }]，返回 { value, form }；被 dismiss 时返回 { dismissed: true }
  function dialog(title, html, buttons, tag) {
    const run = () => new Promise((resolve) => {
      const dlg = $('#dialog');
      const f = $('#dialogForm');
      $('#dialogTitle').textContent = title;
      $('#dialogBody').innerHTML = html;
      const acts = $('#dialogActions');
      acts.innerHTML = '';
      const finish = (value, dismissed) => {
        curDialog = null;
        dlg.classList.add('hidden');
        f.onsubmit = null;
        document.removeEventListener('keydown', onKey, true);
        resolve({ value, form: f, dismissed });
      };
      curDialog = { tag, dismiss: () => finish(null, true) };
      const onKey = (e) => {
        if (e.key === 'Escape' && !dlg.classList.contains('hidden')) {
          e.stopPropagation();
          finish(buttons.find((b) => b.cancel)?.value ?? null);
        }
      };
      buttons.forEach((b) => {
        const el = document.createElement('button');
        el.type = b.submit ? 'submit' : 'button';
        el.textContent = b.label;
        if (b.cls) el.className = b.cls;
        if (!b.submit) el.onclick = () => finish(b.value);
        acts.appendChild(el);
      });
      f.onsubmit = (e) => {
        e.preventDefault();
        finish(buttons.find((b) => b.submit)?.value);
      };
      document.addEventListener('keydown', onKey, true);
      dlg.classList.remove('hidden');
      (f.querySelector('input') || f.querySelector('button.primary, button.danger'))?.focus();
    });
    const p = dialogQueue.then(run);
    dialogQueue = p.catch(() => {});
    return p;
  }

  // keyboard-interactive / TOTP 验证码
  async function promptDialog(m, tag) {
    let html = '';
    if (m.instructions) html += `<p class="muted">${esc(m.instructions)}</p>`;
    m.prompts.forEach((pr, i) => {
      const isCode = /code|otp|token|verif|验证/i.test(pr.prompt);
      html += `<label>${esc(pr.prompt)}<input name="a${i}" type="${pr.echo ? 'text' : 'password'}" autocomplete="${isCode ? 'one-time-code' : 'off'}"${isCode ? ' inputmode="numeric"' : ''}></label>`;
    });
    const r = await dialog(m.title || '服务器要求验证', html, [
      { label: '取消', value: false, cancel: true },
      { label: '确定', value: true, cls: 'primary', submit: true },
    ], tag);
    if (r.dismissed) return undefined;
    if (!r.value) return null;
    return m.prompts.map((_, i) => r.form.elements['a' + i].value);
  }

  // 主机指纹确认
  async function hostkeyDialog(m, tag) {
    let html;
    let buttons;
    if (m.status === 'changed') {
      html = `<div class="warn-box"><b>⚠ 警告：主机指纹已变化！</b><br>
        可能是服务器重装 / 更换了密钥，也可能正在遭受中间人攻击。除非你确认服务器端确实换了密钥，否则不要继续。</div>
        <div>主机：<b>${esc(m.host)}</b></div>
        <div class="muted" style="margin-top:8px">已保存的指纹：</div><pre>${esc(m.oldKeyType)} ${esc(m.oldFingerprint)}</pre>
        <div class="muted">当前服务器指纹：</div><pre>${esc(m.keyType)} ${esc(m.fingerprint)}</pre>`;
      buttons = [
        { label: '取消连接', value: false, cls: 'primary', cancel: true },
        { label: '更新指纹并连接', value: true, cls: 'danger' },
      ];
    } else {
      html = `<div>首次连接 <b>${esc(m.host)}</b>，请核对服务器指纹：</div>
        <pre>${esc(m.keyType)} ${esc(m.fingerprint)}</pre>
        <div class="hint">可在服务器上执行 <code>ssh-keygen -lf /etc/ssh/ssh_host_${esc(String(m.keyType).replace(/^ssh-|^ecdsa-sha2-.*/, (x) => x.startsWith('ecdsa') ? 'ecdsa' : ''))}_key.pub</code> 对比</div>`;
      buttons = [
        { label: '取消', value: false, cancel: true },
        { label: '信任并连接', value: true, cls: 'primary', submit: true },
      ];
    }
    const r = await dialog(m.status === 'changed' ? '主机指纹不匹配' : '确认主机指纹', html, buttons, tag);
    if (r.dismissed) return null;
    return !!r.value;
  }

  // 已信任指纹管理
  async function knownHostsDialog() {
    const list = await api('GET', '/api/known-hosts');
    const html = list.length ? list.map((k, i) => `
      <div class="known-row"><div class="info"><div>${esc(k.key.replace(/^cf:/, '☁ '))}</div>
      <div class="fp">${esc(k.keyType)} ${esc(k.fingerprint)}</div>
      <div class="fp">${esc(new Date(k.addedAt).toLocaleString())}</div></div>
      <button type="button" data-del="${i}">删除</button></div>`).join('')
      : '<p class="muted">暂无已信任的主机</p>';
    const p = dialog('已信任的主机指纹', html, [{ label: '关闭', value: null, cls: 'primary', cancel: true }]);
    $('#dialogBody').querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        const k = list[+b.dataset.del];
        if (!confirm(`删除 ${k.key} 的指纹？下次连接将重新确认。`)) return;
        await api('DELETE', '/api/known-hosts?key=' + encodeURIComponent(k.key));
        b.closest('.known-row').remove();
      };
    });
    await p;
  }
  $('#btnKnown').addEventListener('click', () => knownHostsDialog().catch((e) => alert(e.message)));

  // ------------------------------------------------------------ SFTP 文件管理
  const fmtSize = (n) => {
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
  };
  const fmtTime = (t) => {
    const d = new Date(t);
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const joinPath = (dir, name) => (dir.endsWith('/') ? dir : dir + '/') + name;
  const parentPath = (p) => p.replace(/\/[^/]+\/?$/, '') || '/';
  const shellQuote = (x) => `'${x.replace(/'/g, `'\\''`)}'`;

  // ------------------------------------------------------------ 延迟显示：网页 ↔ SSH-WEB、SSH-WEB ↔ 目标主机
  // 打字、方向键、tmux 滚动都要等一个来回，看这两个数字就知道慢在哪一段
  const latCls = (ms) => (ms < 80 ? 'g' : ms < 200 ? 'y' : 'r');
  const latEl = $('#lat'), latPop = $('#latPop');
  const latOk = (s, ms) => s.sid && Number.isFinite(ms);

  // 标签栏两个信号图标：左网页、右 SSH，各按自己的延迟着色 (三格绿 / 两格黄 / 一格红，还没测到是灰色)
  function updateLat() {
    const s = active;
    latEl.classList.toggle('hidden', !s);
    if (!s) return closeLatPop();
    const q = (ms) => (latOk(s, ms) ? latCls(ms) : 'na');
    latEl.querySelector('[data-k=web]').dataset.q = q(s.rtt);
    latEl.querySelector('[data-k=ssh]').dataset.q = q(s.sshRtt);
    if (!latPop.classList.contains('hidden')) renderLatPop();
  }

  function renderLatPop() {
    const s = active;
    if (!s) return;
    const num = (ms) => (latOk(s, ms) ? `<b class="${latCls(ms)}">${ms} ms</b>` : '<b>–</b>');
    latPop.innerHTML = `
      <div class="lp-row"><span>网页</span>${num(s.rtt)}</div>
      <div class="lp-sub">浏览器 ↔ SSH-WEB（经过 Cloudflare 隧道 / 你的网络）</div>
      <div class="lp-row"><span>SSH</span>${num(s.sshRtt)}</div>
      <div class="lp-sub">SSH-WEB ↔ 目标主机</div>
      <div class="lp-tip">打字、方向键都要等一个来回。<br>绿 &lt; 80ms，黄 &lt; 200ms，红更慢</div>`;
    const r = latEl.getBoundingClientRect();
    latPop.style.top = r.bottom + 6 + 'px';
    latPop.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
  }

  function closeLatPop() {
    latPop.classList.add('hidden');
    latEl.classList.remove('on');
  }

  latEl.addEventListener('mousedown', (e) => e.preventDefault()); // 不抢走输入框焦点
  latEl.addEventListener('click', () => {
    if (!latPop.classList.contains('hidden')) return closeLatPop();
    latPop.classList.remove('hidden');
    latEl.classList.add('on');
    renderLatPop();
    measureRtt(); // 打开时马上测一次最新的
  });
  // 点别处 / Esc 关闭
  document.addEventListener('pointerdown', (e) => {
    if (!latPop.classList.contains('hidden') && !latPop.contains(e.target) && !latEl.contains(e.target)) closeLatPop();
  }, true);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !latPop.classList.contains('hidden')) { closeLatPop(); e.stopPropagation(); e.preventDefault(); }
  }, true);
  window.addEventListener('resize', () => { if (!latPop.classList.contains('hidden')) renderLatPop(); });

  // 平时 10 秒测一次 (手机流量下少唤醒网络，省电)，打开详情卡片时 2 秒一次；切换标签时马上测
  let rttAt = -Infinity; // performance.now() 从页面打开时算起，初始值不能用 0
  function measureRtt() {
    if (active && active.sid && !document.hidden) {
      send(active, { type: 'ping', t: performance.now() });
      rttAt = performance.now();
    }
    updateLat();
  }
  setInterval(() => {
    const gap = latPop.classList.contains('hidden') ? 10000 : 2000;
    if (performance.now() - rttAt >= gap - 50) measureRtt();
  }, 1000);

  function updateSftpBtn() {
    $('#btnHistory').classList.toggle('hidden', !active);
    $('#btnMon').classList.toggle('hidden', !active);
    $('#btnMon').classList.toggle('on', !!(active && active.mon && active.mon.open));
    sessions.forEach(syncMonitor);
    const b = $('#btnSftp');
    b.classList.toggle('hidden', !active);
    b.disabled = !(active && active.sid);
    b.classList.toggle('on', !!(active && active.sftp && active.sftp.open));
  }

  $('#btnSftp').addEventListener('click', () => {
    const s = active;
    if (!s || !s.sid) return;
    if (!s.sftp) s.sftp = createSftp(s);
    s.sftp.toggle();
    updateSftpBtn();
  });

  function createSftp(s) {
    const el = document.createElement('div');
    el.className = 'sftp';
    el.innerHTML = `
      <div class="sftp-bar">
        <button data-a="up" title="上级目录">↑</button>
        <input class="path" spellcheck="false">
        <button data-a="refresh" title="刷新">⟳</button>
      </div>
      <div class="sftp-bar">
        <button data-a="upload">⬆ 上传</button>
        <button data-a="mkdir">+ 文件夹</button>
        <button data-a="cd" title="终端切换到此目录">终端 cd</button>
        <span class="spacer"></span>
        <button data-a="close" title="关闭">×</button>
        <input type="file" multiple hidden>
      </div>
      <div class="sftp-list"></div>
      <div class="sftp-status"></div>`;
    const list = $('.sftp-list', el);
    const pathInput = $('.path', el);
    const fileInput = $('input[type=file]', el);
    const status = $('.sftp-status', el);
    const api2 = (m, action, body, q = '') => api(m, `/api/sftp/${s.sid}/${action}${q}`, body);

    const self = {
      open: false,
      path: '',
      seq: 0,
      toggle() {
        self.open = !self.open;
        if (self.open) {
          s.el.appendChild(el);
          if (!self.loaded) self.load('');
        } else {
          el.remove();
          focusTerm(s);
        }
      },
      async load(p) {
        if (!s.sid) { list.innerHTML = '<div class="sftp-msg">会话未连接</div>'; return; }
        list.innerHTML = '<div class="sftp-msg">加载中…</div>';
        const seq = ++self.seq; // 只采用最后一次请求的结果
        try {
          const r = await api2('GET', 'list', null, '?path=' + encodeURIComponent(p));
          if (seq !== self.seq) return;
          self.loaded = true;
          self.path = r.path;
          pathInput.value = r.path;
          render(r.items);
        } catch (e) {
          if (seq !== self.seq) return;
          list.innerHTML = `<div class="sftp-msg" style="color:var(--danger)">${esc(e.message)}</div>`;
        }
      },
    };

    function render(items) {
      list.innerHTML = '';
      if (!items.length) list.innerHTML = '<div class="sftp-msg">空目录（可拖拽文件到这里上传）</div>';
      items.forEach((it) => {
        const row = document.createElement('div');
        row.className = 'frow' + (it.isDir ? ' dir' : '');
        row.title = `${it.mode}  ${it.name}`;
        row.innerHTML = `<span class="ic">${it.isDir ? '📁' : it.type === 'link' ? '🔗' : '📄'}</span>
          <span class="fn"></span>
          <span class="meta">${it.isDir ? '' : fmtSize(it.size) + '<br>'}${fmtTime(it.mtime)}</span>
          <span class="fops">
            <button data-op="dl" title="${it.isDir ? '打包下载 (.tar.gz)' : '下载'}">⬇</button>
            <button data-op="mv" title="重命名 / 移动">✎</button>
            <button data-op="rm" title="删除">🗑</button>
          </span>`;
        $('.fn', row).textContent = it.name;
        const full = joinPath(self.path, it.name);
        row.addEventListener('click', async (e) => {
          const op = e.target.dataset.op;
          if (op === 'dl') return download(full);
          if (op === 'mv') {
            const to = prompt('重命名 / 移动到：', full);
            if (!to || to === full) return;
            try { await api2('POST', 'rename', { from: full, to }); self.load(self.path); } catch (err) { alert(err.message); }
            return;
          }
          if (op === 'rm') {
            if (!confirm(`确定删除${it.isDir ? '文件夹（包括其中所有内容）' : ''}「${it.name}」？`)) return;
            setStatus2(`正在删除 ${it.name} …`);
            try { await api2('POST', 'delete', { path: full }); setStatus2(''); self.load(self.path); } catch (err) { setStatus2(''); alert(err.message); }
            return;
          }
          if (it.isDir && e.target.closest('.fn, .ic')) self.load(full);
        });
        row.addEventListener('dblclick', () => (it.isDir ? self.load(full) : download(full)));
        list.appendChild(row);
      });
    }

    function download(p) {
      const a = document.createElement('a');
      a.href = `/api/sftp/${s.sid}/download?path=${encodeURIComponent(p)}`;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }

    function setStatus2(text, pct) {
      status.innerHTML = text ? `${esc(text)}${pct != null ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}` : '';
    }

    function putFile(file, target, overwrite) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', `/api/sftp/${s.sid}/upload?path=${encodeURIComponent(target)}${overwrite ? '&overwrite=1' : ''}`);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setStatus2(`上传 ${file.name}  ${fmtSize(e.loaded)} / ${fmtSize(e.total)}`, (e.loaded / e.total) * 100);
        };
        xhr.onload = () => {
          if (xhr.status === 200) return resolve('ok');
          if (xhr.status === 409) return resolve('exists');
          let msg = 'HTTP ' + xhr.status;
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
          reject(new Error(msg));
        };
        xhr.onerror = () => reject(new Error('网络错误'));
        xhr.send(file);
      });
    }

    async function upload(files) {
      const dir = self.path;
      let n = 0;
      for (const f of files) {
        const target = joinPath(dir, f.name);
        try {
          setStatus2(`上传 ${f.name}`, 0);
          let r = await putFile(f, target, false);
          if (r === 'exists') {
            if (!confirm(`「${f.name}」已存在，是否覆盖？`)) continue;
            r = await putFile(f, target, true);
          }
          n++;
        } catch (e) {
          alert(`上传 ${f.name} 失败：${e.message}`);
        }
      }
      setStatus2(n ? `已上传 ${n} 个文件` : '');
      if (self.path === dir) self.load(dir);
    }

    el.addEventListener('click', async (e) => {
      const a = e.target.dataset.a;
      if (a === 'up') self.load(parentPath(self.path));
      else if (a === 'refresh') self.load(self.path);
      else if (a === 'close') { self.toggle(); updateSftpBtn(); }
      else if (a === 'upload') fileInput.click();
      else if (a === 'cd') { send(s, { type: 'data', data: `cd ${shellQuote(self.path)}\r` }); focusTerm(s); }
      else if (a === 'mkdir') {
        const name = prompt('新文件夹名称：');
        if (!name) return;
        try { await api2('POST', 'mkdir', { path: joinPath(self.path, name) }); self.load(self.path); } catch (err) { alert(err.message); }
      }
    });
    pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') self.load(pathInput.value.trim()); });
    fileInput.addEventListener('change', () => { upload([...fileInput.files]); fileInput.value = ''; });
    list.addEventListener('dragover', (e) => { e.preventDefault(); list.classList.add('drag'); });
    list.addEventListener('dragleave', () => list.classList.remove('drag'));
    list.addEventListener('drop', (e) => {
      e.preventDefault();
      list.classList.remove('drag');
      const files = [...e.dataTransfer.files];
      if (files.length) upload(files);
    });
    return self;
  }

  // ------------------------------------------------------------ 手机输入栏
  const mInput = $('#mInput');
  const dInput = $('#dInput');
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
  }
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
  mInput.addEventListener('input', (e) => {
    if (composing || e.isComposing) return;
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

  // ------------------------------------------------------------ 抬高模式下方留白里的信息面板：各主机 (标签) 状态
  let deskTabList = [], lastStatusPaint = 0;
  const panelShown = () => !deskSpace.classList.contains('hidden');

  function renderDeskPanel() {
    if (!deskSpace.firstChild) deskSpace.innerHTML = '<div class="dp-h">主机状态</div><div class="dp-tabs"></div>';
    renderDeskTabs();
  }

  // 屏幕上最后 20 行有字的内容：Claude Code 的转圈状态行、选择框、API 报错都在最底部
  // (下面还有输入框、自定义状态栏、tmux 状态栏，所以要看 20 行)；
  // 只看这一段，避免对话里早先的内容一直算数 (tmux 里屏幕是满的，普通 shell 内容可能只在上半部分)
  function screenTail(x) {
    const b = x.term.buffer.active, top = b.viewportY, out = [];
    for (let y = top + x.term.rows - 1; y >= top && out.length < 20; y--) {
      const line = b.getLine(y)?.translateToString(true) || '';
      if (line.trim()) out.unshift(line);
    }
    return out.join('\n');
  }
  // 只认整行的格式，不认句子中间提到的字样 (对话内容里常会出现这些词)：
  // 待选择 = 选择框里当前选中的「❯ 1. xxx」、「Do you want to …」开头的行、行尾 [Y/n]
  // 报错 = 以 API Error 开头的行；普通的「⎿ Error: …」是工具调用失败，Claude 会自己处理，不算
  const CHOICE_RE = /^[\s│]*❯\s*\d+\.\s|^[\s│]*Do you want to |\[[Yy]\/[Nn]\]\s*$/m;
  const ERROR_RE = /^[\s│]*(⎿\s*)?API Error\b/m;
  // Claude Code 自己的状态行：干活时「✻ Frosting… (13m 58s · ↓ 37k tokens)」(转圈符号 + 随机动词 + …)，
  // 做完是「✻ Worked for 1m 2s」(固定的几个过去式动词)
  const CLAUDE_RUN_RE = /^\s*[·✢✳✶✻✽*]\s+[A-Z][A-Za-z\u00c0-\u024f-]+…/m;
  const CLAUDE_DONE_RE = /^\s*[·✢✳✶✻✽*]\s+(Baked|Brewed|Churned|Cogitated|Cooked|Crunched|Sautéed|Worked) for \d/m;

  // 运行中：最近 3 秒内持续有输出 (跨度超过 0.6 秒)；Claude Code 工作时的转圈动画会不停输出，
  // tmux 状态栏时钟之类的一次性刷新不算；只算提示音 0.5 秒之后的输出 (之前的是完成前的转圈)
  function isRunning(x, now) {
    const since = x.alertAt ? x.alertAt + 500 : 0;
    const t = (x.outTimes || []).filter((v) => now - v < 3000 && v > since);
    return t.length >= 3 && t[t.length - 1] - t[0] > 600;
  }

  // 运行中 (黄色闪烁) / 待选择、报错 (红色) / 完成 (绿色) / 空闲 (灰色)
  // 完成 = 运行中停下来了，或收到提示音 (Claude Code 的「等你输入」提示音默认要闲置 60 秒才发)；
  // 之后往这个标签发了输入就回到空闲
  // 先看 Claude Code 界面上的字 (最准)，不是 Claude Code 时再按输出节奏判断
  function tabState(x, now) {
    if (!x.sid) return ['未连接', 'off'];
    const tail = screenTail(x);
    if (CLAUDE_RUN_RE.test(tail)) { x.running = true; return ['运行中', 'run']; }
    if (CHOICE_RE.test(tail)) { x.running = false; return ['待选择', 'bad']; }
    if (ERROR_RE.test(tail)) { x.running = false; return ['报错', 'bad']; }
    // 「Worked for …」出现后你还没往这个标签发过内容 = 完成；发过 = 已经看到了，算空闲
    if (CLAUDE_DONE_RE.test(tail)) {
      x.running = false;
      if (!x.doneLineAt) x.doneLineAt = now;
      return (x.dataAt || 0) > x.doneLineAt ? ['空闲', 'idle'] : ['完成', 'done'];
    }
    x.doneLineAt = 0;
    if (isRunning(x, now)) { x.running = true; return ['运行中', 'run']; }
    if (x.running) { x.running = false; x.doneAt = now; }
    if (x.alertAt || x.doneAt) return ['完成', 'done'];
    return ['空闲', 'idle'];
  }

  // 主机状态画到所有显示着的地方：抬高模式的留白、网页内悬浮窗、置顶到桌面的小窗口
  function statusBoxes() {
    const out = [];
    if (panelShown()) out.push(deskSpace.querySelector('.dp-tabs'));
    if (!hostFloat.classList.contains('hidden') && !hostFloat.classList.contains('min')) out.push(hfTabs);
    if (pipWin) out.push(pipWin.document.querySelector('.dp-tabs'));
    return out.filter(Boolean);
  }

  function renderDeskTabs() {
    const boxes = statusBoxes();
    const sumOn = !hostFloat.classList.contains('hidden') && hostFloat.classList.contains('min');
    if (!boxes.length && !sumOn) return;
    deskTabList = tabOrder();
    const now = Date.now();
    const states = deskTabList.map((x) => tabState(x, now));
    const html = deskTabList.map((x, i) => {
      const [st, cls] = states[i];
      return `<div class="dp-tab${x === active ? ' cur' : ''}" data-k="${i}">
        <span class="${$('.dot', x.tab).className}"></span><span class="nm">${esc($('.title', x.tab).textContent)}</span>
        <span class="stt ${cls}">${st}</span></div>`;
    }).join('');
    for (const box of boxes) if (box.innerHTML !== html) box.innerHTML = html;
    // 悬浮窗收起时，标题栏上用小圆点显示每个标签的状态
    const sum = states.map(([st, cls], i) => `<i class="hf-d ${cls}" title="${esc($('.title', deskTabList[i].tab).textContent)}：${st}"></i>`).join('');
    if (hfSum.innerHTML !== sum) hfSum.innerHTML = sum;
  }
  setInterval(renderDeskTabs, 500);

  // 按下就切标签 (每 0.5 秒会重画，不等 click)，不抢走输入框焦点
  function onStatusDown(e) {
    if (e.button !== 0) return;
    const row = e.target.closest('.dp-tab');
    if (!row) return;
    e.preventDefault();
    const x = deskTabList[+row.dataset.k];
    if (x && x !== active) activate(x);
  }
  deskSpace.addEventListener('mousedown', onStatusDown);

  // ------------------------------------------------------------ 电脑：主机状态悬浮窗
  // 输入框不是「抬高」模式时显示在终端上，按住标题栏拖动，位置 / 收起状态每台电脑各自记住；
  // 📌 置顶到桌面：浏览器的文档画中画 (Chrome / Edge 116+)，浏览器最小化后也浮在最上面
  const hostFloat = $('#hostFloat'), hfTabs = $('#hostFloat .dp-tabs'), hfSum = $('#hostFloat .hf-sum');
  let pipWin = null;
  const hfPos = (() => { try { return JSON.parse(localStorage.getItem('sshweb.hostFloat')) || {}; } catch { return {}; } })();
  const saveHf = () => { try { localStorage.setItem('sshweb.hostFloat', JSON.stringify(hfPos)); } catch {} };
  if (hfPos.min) hostFloat.classList.add('min');
  if (!('documentPictureInPicture' in window)) hostFloat.querySelector('[data-a=pip]').remove();

  // 位置用「离 main 右边 / 上边的距离」保存，窗口大小变了也贴着右上角；超出范围时收回来
  function placeHostFloat() {
    const main = hostFloat.parentElement;
    const top0 = $('#tabbar').offsetHeight;
    const maxR = Math.max(0, main.clientWidth - hostFloat.offsetWidth);
    const maxT = Math.max(top0, main.clientHeight - hostFloat.offsetHeight);
    const r = Math.min(Math.max(0, hfPos.r ?? 12), maxR);
    const t = Math.min(Math.max(top0, hfPos.t ?? top0 + 8), maxT);
    hostFloat.style.right = r + 'px';
    hostFloat.style.top = t + 'px';
  }

  function updateHostFloat() {
    const show = !isTouch && !!active && deskMode !== 'lift' && !pipWin;
    const was = !hostFloat.classList.contains('hidden');
    hostFloat.classList.toggle('hidden', !show);
    if (show) {
      if (!was) renderDeskTabs();
      placeHostFloat();
    }
  }
  new ResizeObserver(() => { if (!hostFloat.classList.contains('hidden')) placeHostFloat(); }).observe(hostFloat.parentElement);

  hostFloat.addEventListener('mousedown', onStatusDown);
  hostFloat.querySelector('.hf-head').addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const head = e.currentTarget;
    head.setPointerCapture(e.pointerId);
    const r0 = hostFloat.getBoundingClientRect(), main = hostFloat.parentElement.getBoundingClientRect();
    const x0 = e.clientX, y0 = e.clientY;
    const r0px = main.right - r0.right, t0px = r0.top - main.top;
    hostFloat.classList.add('dragging');
    const move = (ev) => {
      hfPos.r = r0px - (ev.clientX - x0);
      hfPos.t = t0px + (ev.clientY - y0);
      placeHostFloat();
    };
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      head.removeEventListener('pointercancel', up);
      hostFloat.classList.remove('dragging');
      hfPos.r = parseFloat(hostFloat.style.right);
      hfPos.t = parseFloat(hostFloat.style.top);
      saveHf();
      if (active) focusTerm(active);
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
  });
  hostFloat.querySelector('.hf-head').addEventListener('mousedown', (e) => e.preventDefault()); // 不抢走输入框焦点
  hostFloat.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.a === 'min') {
      hfPos.min = hostFloat.classList.toggle('min');
      saveHf();
      renderDeskTabs();
      placeHostFloat();
    } else if (b.dataset.a === 'pip') openStatusPip();
  });

  // 置顶到桌面：内容和网页里的一样，样式直接引用同一个 style.css
  async function openStatusPip() {
    if (pipWin) return pipWin.focus();
    let w;
    try {
      w = await window.documentPictureInPicture.requestWindow({ width: 300, height: 150 });
    } catch (e) {
      return alert('无法打开置顶窗口：' + e.message);
    }
    pipWin = w;
    const d = w.document;
    d.title = '主机状态 - SSH-WEB';
    const link = d.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('style.css', location.href).href;
    d.head.appendChild(link);
    syncPipTheme();
    d.body.className = 'pip-body';
    d.body.innerHTML = '<div class="dp-tabs"></div>';
    d.addEventListener('mousedown', onStatusDown);
    w.addEventListener('pagehide', () => {
      pipWin = null;
      updateHostFloat();
    });
    updateHostFloat();
    renderDeskTabs();
  }
  function syncPipTheme() {
    if (!pipWin) return;
    const t = document.documentElement.dataset.theme;
    if (t) pipWin.document.documentElement.dataset.theme = t;
    else delete pipWin.document.documentElement.dataset.theme;
  }

  // 按住上下拖动的通用处理：onMove(鼠标相对按下时的位移 dy)，requestAnimationFrame 节流，松开后保存
  function dragY(e, onMove) {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    deskBar.classList.add('dragging');
    document.body.classList.add('no-select');
    const y0 = e.clientY;
    let y = y0, raf = 0;
    const update = () => { raf = 0; onMove(y - y0); };
    const move = (ev) => {
      y = ev.clientY;
      if (!raf) raf = requestAnimationFrame(update);
    };
    const up = () => {
      if (raf) { cancelAnimationFrame(raf); update(); }
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      deskBar.classList.remove('dragging');
      document.body.classList.remove('no-select');
      saveDeskPos();
      dInput.focus();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  // 按比例设置抬高位置 (像素)，超出范围时停在边界，不记住超出的值
  function setLiftPx(px) {
    const h = deskBar.parentElement.clientHeight;
    deskLift = Math.max(0, px) / h;
    applyDeskPos();
    deskLift = deskLiftPx() / h;
  }

  // 拖左边的把手上下调整位置
  $('#dGrip').addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || deskMode === 'bottom') return;
    const lift0 = deskLiftPx();
    dragY(e, (dy) => setLiftPx(lift0 - dy));
  });

  // 拖上边缘调整输入框高度 (最低高度，字多了照样自动变高)，往上拖变高，下边缘 / 抬高位置不动；双击恢复默认
  const DESK_MIN_H = 60;
  let deskMinH = (() => { try { return Math.max(DESK_MIN_H, parseInt(localStorage.getItem('sshweb.deskMinH'), 10) || DESK_MIN_H); } catch { return DESK_MIN_H; } })();

  function applyMinH() {
    dInput.style.minHeight = deskMinH + 'px';
    dInput.style.maxHeight = `max(40vh, ${deskMinH}px)`;
    autosizeDesk();
  }
  dInput.style.minHeight = deskMinH + 'px';
  dInput.style.maxHeight = `max(40vh, ${deskMinH}px)`;

  function setMinH(h) {
    // 最高到 main 的一半，抬高模式下还要给上方终端留出位置
    const main = deskBar.parentElement.clientHeight;
    let max = Math.round(main * 0.5);
    if (deskMode === 'lift') max = Math.min(max, main - $('#tabbar').offsetHeight - MIN_TERM - (deskBar.offsetHeight - dInput.offsetHeight));
    deskMinH = Math.round(Math.max(DESK_MIN_H, Math.min(h, max)));
    applyMinH();
  }

  $('#dResize').addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const h0 = dInput.offsetHeight;
    dragY(e, (dy) => setMinH(h0 - dy));
  });
  $('#dResize').addEventListener('dblclick', () => {
    deskMinH = DESK_MIN_H;
    applyMinH();
    saveDeskPos();
    dInput.focus();
  });

  function setDeskOn(on) {
    deskOn = on;
    if (!on && cmdMode) setCmdMode(false);
    try { localStorage.setItem('sshweb.deskInput', on ? '1' : '0'); } catch {}
    updateMobileBar();
    if (active) focusTerm(active);
  }

  // ------------------------------------------------------------ 自定义按键栏
  const KEY_DEFS = {
    history: { label: '历史', k: 'history' }, esc: { label: 'Esc', k: 'esc' }, tab: { label: 'Tab', k: 'tab' },
    shift: { label: 'Shift', mod: 'shift' }, ctrl: { label: 'Ctrl', mod: 'ctrl' }, alt: { label: 'Alt', mod: 'alt' },
    up: { label: '↑', k: 'up' }, down: { label: '↓', k: 'down' }, left: { label: '←', k: 'left' }, right: { label: '→', k: 'right' },
    bs: { label: '⌫', k: 'bs' }, home: { label: 'Home', k: 'home' }, end: { label: 'End', k: 'end' },
    pgup: { label: 'PgUp', k: 'pgup' }, pgdn: { label: 'PgDn', k: 'pgdn' },
    '^c': { label: '^C', k: '^c', desc: '中断' }, '^d': { label: '^D', k: '^d', desc: '退出' },
    '^z': { label: '^Z', k: '^z', desc: '挂起' }, '^l': { label: '^L', k: '^l', desc: '清屏' },
    copy: { label: '复制', k: 'copy' }, paste: { label: '粘贴', k: 'paste' },
    // 以下默认不显示，可以在设置里添加
    enter: { label: 'Enter', k: 'enter', desc: '回车' },
    escesc: { label: 'Esc Esc', k: 'escesc', desc: 'Claude Code 撤回' },
    '^b': { label: '^B', k: '^b', desc: 'tmux 前缀' }, '^r': { label: '^R', k: '^r', desc: '搜索历史' },
    '^a': { label: '^A', k: '^a', desc: '行首' }, '^e': { label: '^E', k: '^e', desc: '行尾' },
    '^u': { label: '^U', k: '^u', desc: '删到行首' }, '^w': { label: '^W', k: '^w', desc: '删一个词' },
    '^k': { label: '^K', k: '^k', desc: '删到行尾' },
  };
  for (let i = 1; i <= 12; i++) KEY_DEFS['f' + i] = { label: 'F' + i, k: 'f' + i };
  for (const ch of ['|', '/', '-', '~', '\\', '*', '&', '>', '<', '$', "'", '"', ':', ';', '_', '=', '`', '!', '#', '@', '%', '(', ')', '[', ']', '{', '}']) {
    KEY_DEFS['t:' + ch] = { label: ch, t: ch };
  }
  // 默认 = 原来的按键和顺序
  const DEFAULT_KEYS = ['history', 'esc', 'tab', 'shift', 'ctrl', 'alt', 'up', 'down', 'left', 'right', 'bs',
    'home', 'end', 'pgup', 'pgdn', 't:|', 't:/', 't:-', 't:~', '^c', '^d', '^z', '^l', 'copy', 'paste'];
  let keybar = { keys: DEFAULT_KEYS.slice(), custom: {} };

  // 自定义按键内容的转义: \r \n \t \e \\ \xHH \uHHHH
  function decodeSeq(str) {
    return str.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[rnte\\])/g, (m, c) => {
      if (c[0] === 'x' || c[0] === 'u') return String.fromCharCode(parseInt(c.slice(1), 16));
      return { r: '\r', n: '\n', t: '\t', e: '\x1b', '\\': '\\' }[c];
    });
  }

  const keyDef = (id, cfg = keybar) => KEY_DEFS[id] || (cfg.custom[id] && { label: cfg.custom[id].label, seq: cfg.custom[id].seq, desc: cfg.custom[id].seq });

  function renderKeyBar() {
    const box = $('#mobileBar .mkeys');
    box.innerHTML = '';
    for (const id of keybar.keys) {
      const d = keyDef(id);
      if (!d) continue;
      const b = document.createElement('button');
      b.textContent = d.label;
      if (d.k) b.dataset.k = d.k;
      else if (d.t) b.dataset.t = d.t;
      else if (d.mod) { b.dataset.mod = d.mod; b.classList.toggle('on', !!mods[d.mod]); }
      else if (d.seq != null) { b.dataset.seq = decodeSeq(d.seq); b.title = d.seq; }
      box.appendChild(b);
    }
    const set = document.createElement('button');
    set.className = 'kset';
    set.dataset.a = 'kset';
    set.title = '自定义按键栏';
    set.textContent = '⚙';
    box.appendChild(set);
  }

  async function loadKeybar() {
    try {
      const st = await api('GET', '/api/settings');
      if (st.keybar && Array.isArray(st.keybar.keys)) keybar = { keys: st.keybar.keys, custom: st.keybar.custom || {} };
    } catch {}
    renderKeyBar();
  }

  let keyEdit = null;
  function openKeysEditor() {
    keyEdit = { keys: keybar.keys.slice(), custom: { ...keybar.custom } };
    $('#kcLabel').value = '';
    $('#kcSeq').value = '';
    renderKeysEditor();
    mInput.blur();
    $('#keysPanel').classList.remove('hidden');
  }

  function renderKeysEditor() {
    const cur = $('#keysCur');
    cur.innerHTML = '';
    keyEdit.keys.forEach((id, i) => {
      const d = keyDef(id, keyEdit);
      if (!d) return;
      const row = document.createElement('div');
      row.className = 'krow';
      row.innerHTML = `<span class="kl"></span><span class="kd"></span>
        <button data-op="up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button data-op="down" ${i === keyEdit.keys.length - 1 ? 'disabled' : ''}>↓</button>
        <button data-op="del">✕</button>`;
      $('.kl', row).textContent = d.label;
      $('.kd', row).textContent = d.desc || '';
      row.addEventListener('click', (e) => {
        const op = e.target.dataset.op;
        const k = keyEdit.keys;
        if (op === 'up' && i > 0) [k[i - 1], k[i]] = [k[i], k[i - 1]];
        else if (op === 'down' && i < k.length - 1) [k[i + 1], k[i]] = [k[i], k[i + 1]];
        else if (op === 'del') k.splice(i, 1);
        else return;
        renderKeysEditor();
      });
      cur.appendChild(row);
    });
    const avail = $('#keysAvail');
    avail.innerHTML = '';
    const ids = [...DEFAULT_KEYS, ...Object.keys(KEY_DEFS), ...Object.keys(keyEdit.custom)];
    for (const id of [...new Set(ids)]) {
      if (keyEdit.keys.includes(id)) continue;
      const d = keyDef(id, keyEdit);
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = d.label;
      b.title = d.desc || '';
      b.onclick = () => { keyEdit.keys.push(id); renderKeysEditor(); };
      avail.appendChild(b);
    }
  }

  $('#keysCustom').addEventListener('submit', (e) => {
    e.preventDefault();
    const label = $('#kcLabel').value.trim();
    const seq = $('#kcSeq').value;
    if (!label || !seq) return alert('请填写名称和发送内容');
    const id = 'c:' + Math.random().toString(36).slice(2, 10);
    keyEdit.custom[id] = { label, seq };
    keyEdit.keys.push(id);
    $('#kcLabel').value = '';
    $('#kcSeq').value = '';
    renderKeysEditor();
  });
  $('#keysReset').addEventListener('click', () => {
    if (!confirm('恢复默认按键和顺序？自定义按键也会被删除。')) return;
    keyEdit = { keys: DEFAULT_KEYS.slice(), custom: {} };
    renderKeysEditor();
  });
  $('#keysCancel').addEventListener('click', () => $('#keysPanel').classList.add('hidden'));
  $('#keysSave').addEventListener('click', async () => {
    // 不在按键栏里的自定义按键一起删除
    const custom = {};
    for (const id of keyEdit.keys) if (keyEdit.custom[id]) custom[id] = keyEdit.custom[id];
    try {
      await api('PUT', '/api/settings/keybar', { keys: keyEdit.keys, custom });
      keybar = { keys: keyEdit.keys, custom };
      clearMods();
      renderKeyBar();
      $('#keysPanel').classList.add('hidden');
    } catch (err) { alert('保存失败：' + err.message); }
  });
  $('#keysPanel').addEventListener('mousedown', (e) => { if (e.target.id === 'keysPanel') $('#keysPanel').classList.add('hidden'); });

  // ------------------------------------------------------------ 终端字体大小 (手机双指捏合 / 侧边栏 A- A+)
  const FONT_MIN = 8;
  const FONT_MAX = 28;
  const defaultFont = () => (window.innerWidth < 760 ? 12 : 14);
  let fontSize = (() => { try { return parseInt(localStorage.getItem('sshweb.fontSize'), 10) || defaultFont(); } catch { return defaultFont(); } })();

  function setFontSize(n, save = true) {
    n = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n)));
    if (n !== fontSize) {
      fontSize = n;
      for (const x of sessions) x.term.options.fontSize = n;
      if (active) syncSize(active);
    }
    if (save) { try { localStorage.setItem('sshweb.fontSize', String(n)); } catch {} }
    $('#fontLabel').textContent = String(fontSize);
  }
  $('#fontDec').addEventListener('click', () => setFontSize(fontSize - 1));
  $('#fontInc').addEventListener('click', () => setFontSize(fontSize + 1));

  function fontToast(s, text, ms) {
    let t = s.box.querySelector('.font-toast');
    if (!t) { t = document.createElement('div'); t.className = 'font-toast'; s.box.appendChild(t); }
    t.textContent = text;
    clearTimeout(t.timer);
    t.timer = setTimeout(() => t.remove(), ms || 800);
  }

  function updateMobileBar() {
    $('#mobileBar').classList.toggle('hidden', !(isTouch && active));
    $('#deskBar').classList.toggle('hidden', !(!isTouch && active && deskOn));
    $('#btnInput').classList.toggle('hidden', !(!isTouch && active));
    $('#btnInput').classList.toggle('on', deskOn);
    applyDeskPos();
    updateHostFloat();
    if (cmdMode && cmdMode.s !== active) setCmdMode(false);
    // 每个标签有自己的草稿
    const draft = active?.draft || '';
    if (dInput.value !== draft) { dInput.value = draft; autosizeDesk(); }
    if (mText() !== draft) setMobileText(draft);
  }

  // iOS 键盘弹出时不会缩小页面，用 visualViewport 调整高度，让输入栏始终在键盘上方
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const onVV = () => {
      app.style.height = vv.height + 'px';
      window.scrollTo(0, 0);
      if (active) active.fit.fit();
    };
    vv.addEventListener('resize', onVV);
  }

  // ------------------------------------------------------------ 历史命令
  // 按回车时记下光标所在行，等回显到达 (光标换行) 后读取这一行，去掉提示符得到命令。
  // 这样 Tab 补全、↑ 调出的历史命令都能正确记录；vim 等全屏程序 (备用缓冲区) 内不记录。
  function histHostLabel(h) {
    return h.connType === 'cloudflare' ? `${h.username}@${h.host}` : `${h.username}@${h.host}:${h.port || 22}`;
  }

  function readLogicalLine(buf, row) {
    let start = row;
    while (start > 0 && buf.getLine(start)?.isWrapped) start--;
    let end = row;
    while (buf.getLine(end + 1)?.isWrapped) end++;
    let text = '';
    for (let i = start; i <= end; i++) text += buf.getLine(i)?.translateToString(i === end) || '';
    return text;
  }

  // 提示符以 $ # % > ❯ 加空格结尾，取第一个提示符之后的内容
  function extractCommand(line) {
    const m = /^.*?[$#%>❯]\s(.*)$/.exec(line || '');
    if (!m) return '';
    if (m[1].startsWith(' ')) return ''; // 以空格开头不记录 (同 bash HISTCONTROL=ignorespace)
    return m[1].trim();
  }

  function beginCapture(s) {
    const b = s.term.buffer.active;
    if (b.type === 'alternate' || !s.sid) return;
    const row = b.baseY + b.cursorY;
    if (s.capture) {
      // 上一次回车没有产生新行 (如 read -s 密码输入)，丢弃；否则先结算
      if (s.capture.row === row) cancelCapture(s);
      else finishCapture(s);
    }
    s.capture = { row, snap: readLogicalLine(b, row) };
    s.capture.timer = setTimeout(() => {
      const bb = s.term.buffer.active;
      if (bb.type !== 'alternate' && bb.baseY + bb.cursorY === row) cancelCapture(s);
      else finishCapture(s);
    }, 3000);
  }

  function cancelCapture(s) {
    if (s.capture) clearTimeout(s.capture.timer);
    s.capture = null;
  }

  // 每次输出写入后调用：光标还在这条命令行 (含自动换行的续行) 上就更新快照，真正换到新行后记录
  function checkCapture(s) {
    const c = s.capture;
    if (!c) return;
    const b = s.term.buffer.active;
    if (b.type === 'alternate') return finishCapture(s);
    const cur = b.baseY + b.cursorY;
    if (cur === c.row || (cur > c.row && b.getLine(cur)?.isWrapped)) {
      c.snap = readLogicalLine(b, c.row);
      return;
    }
    finishCapture(s);
  }

  function finishCapture(s) {
    const c = s.capture;
    if (!c) return;
    s.capture = null;
    clearTimeout(c.timer);
    // 执行 clear 等命令可能清掉这一行，此时用按回车时的快照
    const cmd = extractCommand(readLogicalLine(s.term.buffer.normal, c.row)) || extractCommand(c.snap);
    if (cmd) api('POST', '/api/history', { cmd, host: s.histHost }).catch(() => {});
  }

  const histPanel = $('#history');
  let histItems = [];
  let favItems = [];
  let histTab = (() => { try { return localStorage.getItem('sshweb.histTab') || 'fav'; } catch { return 'fav'; } })();

  const fmtAgo = (t) => {
    const d = (Date.now() - t) / 1000;
    if (d < 60) return '刚刚';
    if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
    if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
    if (d < 86400 * 30) return Math.floor(d / 86400) + ' 天前';
    return new Date(t).toLocaleDateString();
  };

  async function openHistory() {
    histPanel.classList.remove('hidden');
    $('#histSearch').value = '';
    $('#favInput').value = '';
    $('#histAll').checked = !active;
    $('#histList').innerHTML = '<div class="sftp-msg">加载中…</div>';
    if (isTouch) mInput.blur();
    try {
      [histItems, favItems] = await Promise.all([api('GET', '/api/history'), api('GET', '/api/favorites')]);
      renderHistory();
    } catch (e) {
      $('#histList').innerHTML = `<div class="sftp-msg" style="color:var(--danger)">${esc(e.message)}</div>`;
    }
    if (!isTouch) $('#histSearch').focus();
  }

  function closeHistory() {
    histPanel.classList.add('hidden');
    if (active) focusTerm(active);
  }

  const showAll = () => $('#histAll').checked || !active;
  const isFav = (cmd) => favItems.some((f) => f.cmd === cmd);

  function visibleItems() {
    const q = $('#histSearch').value.trim().toLowerCase();
    const all = showAll();
    const match = (cmd) => !q || cmd.toLowerCase().includes(q);
    if (histTab === 'fav') {
      // 收藏: 所有主机通用的 + 当前主机专用的
      return favItems.filter((f) => (all || !f.host || f.host === active.histHost) && match(f.cmd));
    }
    return histItems.filter((h) => (all || h.host === active.histHost) && match(h.cmd));
  }

  // 执行 / 填入到当前终端
  function useCommand(cmd, op) {
    if (!active || !active.sid) return;
    closeHistory();
    sendKeys(cmd);
    // 等命令回显后再回车，这样也会记入历史 (次数 +1、移到最前)
    if (op === 'run') setTimeout(() => { beginCapture(active); sendKeys('\r'); }, 50);
  }

  async function toggleFav(cmd) {
    const f = favItems.find((x) => x.cmd === cmd);
    if (f) {
      await api('DELETE', '/api/favorites/' + f.id);
      favItems = favItems.filter((x) => x !== f);
    } else {
      favItems.push(await api('POST', '/api/favorites', { cmd, host: '' }));
    }
  }

  function renderHistory() {
    histPanel.querySelectorAll('.htabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === histTab));
    $('#favAdd').classList.toggle('hidden', histTab !== 'fav');
    const list = $('#histList');
    const items = visibleItems();
    const all = showAll();
    const clear = $('#histClear');
    clear.classList.toggle('hidden', histTab !== 'hist');
    clear.textContent = all ? '清空全部' : '清空本主机';
    clear.disabled = !items.length;
    list.innerHTML = '';
    if (!items.length) {
      list.innerHTML = histTab === 'fav'
        ? '<div class="sftp-msg">还没有收藏的命令<br><span class="hint">在上面输入框添加，或在「历史」里点 ☆ 收藏</span></div>'
        : '<div class="sftp-msg">暂无历史命令<br><span class="hint">在终端里执行过的命令会记录在这里</span></div>';
      return;
    }
    items.forEach((h) => {
      const fav = histTab === 'fav';
      const row = document.createElement('div');
      row.className = fav ? 'hrow fav' : 'hrow';
      if (fav) row.dataset.id = h.id;
      row.innerHTML = `${fav ? '' : `<button data-op="star" class="star${isFav(h.cmd) ? ' on' : ''}" title="收藏">${isFav(h.cmd) ? '★' : '☆'}</button>`}
        <div class="hmain" title="点击执行"><div class="cmd"></div><div class="hmeta"></div></div>
        <button data-op="fill" title="填入终端，不执行">填入</button>
        <button data-op="run" class="primary" title="执行">执行</button>
        <button data-op="del" class="del" title="${fav ? '取消收藏' : '删除'}">✕</button>`;
      $('.cmd', row).textContent = h.cmd;
      if (fav) {
        // 适用范围: 点击在「所有主机」和「仅当前主机」之间切换
        const scope = document.createElement('button');
        scope.className = 'scope';
        scope.dataset.op = 'scope';
        scope.textContent = h.host ? `仅 ${h.host}` : '所有主机';
        scope.title = '点击切换适用范围';
        $('.hmeta', row).appendChild(scope);
      } else {
        $('.hmeta', row).textContent = [all ? h.host : '', fmtAgo(h.time), h.count > 1 ? `${h.count} 次` : '']
          .filter(Boolean).join(' · ');
      }
      row.addEventListener('click', async (e) => {
        if (Date.now() < favDragUntil) return; // 刚拖动完，不当作点击 (点击会执行命令)
        const op = e.target.dataset.op || (e.target.closest('.hmain') ? 'run' : '');
        try {
          if (op === 'star') { await toggleFav(h.cmd); return renderHistory(); }
          if (op === 'scope') {
            const host = h.host ? '' : (active ? active.histHost : '');
            Object.assign(h, await api('PUT', '/api/favorites/' + h.id, { host }));
            return renderHistory();
          }
          if (op === 'del') {
            if (fav) {
              await api('DELETE', '/api/favorites/' + h.id);
              favItems = favItems.filter((x) => x.id !== h.id);
            } else {
              await api('DELETE', '/api/history/' + h.id);
              histItems = histItems.filter((x) => x.id !== h.id);
            }
            return renderHistory();
          }
        } catch (err) { return alert(err.message); }
        if (op === 'run' || op === 'fill') useCommand(h.cmd, op);
      });
      list.appendChild(row);
    });
  }

  // 收藏拖动排序：电脑按住拖动，手机长按后拖动 (同侧边栏主机)。
  // 列表按主机 / 搜索筛选时，只调整显示出来的这几条的相对顺序，隐藏的收藏留在原位
  const histListEl = $('#histList');
  let favDrag = null;
  let favDragUntil = 0;

  function beginFavDrag() {
    if (!favDrag) return;
    favDrag.started = true;
    favDrag.el.classList.add('dragging');
    histListEl.classList.add('drag-active');
    if (favDrag.touch) navigator.vibrate?.(15);
  }

  function moveFavDrag(y) {
    const el = favDrag.el;
    const prev = el.previousElementSibling;
    const next = el.nextElementSibling;
    const mid = (x) => { const r = x.getBoundingClientRect(); return r.top + r.height / 2; };
    if (prev && y < mid(prev)) histListEl.insertBefore(el, prev);
    else if (next && y > mid(next)) histListEl.insertBefore(el, next.nextSibling);
    const r = histListEl.getBoundingClientRect();
    if (y < r.top + 30) histListEl.scrollTop -= 10;
    else if (y > r.bottom - 30) histListEl.scrollTop += 10;
  }

  async function endFavDrag() {
    if (!favDrag) return;
    clearTimeout(favDrag.timer);
    const d = favDrag;
    favDrag = null;
    if (!d.started) return;
    d.el.classList.remove('dragging');
    histListEl.classList.remove('drag-active');
    favDragUntil = Date.now() + 400;
    const shown = [...histListEl.querySelectorAll('.hrow.fav')].map((x) => x.dataset.id);
    // 显示出来的收藏按新顺序依次填回它们原来占的位置
    const slots = favItems.map((f, i) => (shown.includes(f.id) ? i : -1)).filter((i) => i >= 0);
    const next = favItems.slice();
    slots.forEach((slot, k) => { next[slot] = favItems.find((f) => f.id === shown[k]); });
    if (next.every((f, i) => f === favItems[i])) return;
    favItems = next;
    try {
      await api('PUT', '/api/favorites/order', { ids: favItems.map((f) => f.id) });
    } catch (e) {
      alert('保存顺序失败：' + e.message);
    }
  }

  histListEl.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.hrow.fav');
    if (!el || e.target.closest('button') || e.button > 0) return;
    favDrag = { el, startX: e.clientX, startY: e.clientY, started: false, touch: e.pointerType !== 'mouse' };
    if (favDrag.touch) favDrag.timer = setTimeout(beginFavDrag, 350);
  });
  window.addEventListener('pointermove', (e) => {
    if (!favDrag) return;
    if (!favDrag.started) {
      const moved = Math.max(Math.abs(e.clientX - favDrag.startX), Math.abs(e.clientY - favDrag.startY));
      if (favDrag.touch) { if (moved > 8) endFavDrag(); return; } // 长按前就移动了 = 在滚动列表
      if (moved < 5) return;
      beginFavDrag();
    }
    moveFavDrag(e.clientY);
  });
  window.addEventListener('pointerup', endFavDrag);
  window.addEventListener('pointercancel', endFavDrag);
  histListEl.addEventListener('touchmove', (e) => { if (favDrag && favDrag.started) e.preventDefault(); }, { passive: false });
  histListEl.addEventListener('contextmenu', (e) => { if (e.target.closest('.hrow.fav')) e.preventDefault(); });

  histPanel.querySelectorAll('.htabs button').forEach((b) => b.addEventListener('click', () => {
    histTab = b.dataset.tab;
    try { localStorage.setItem('sshweb.histTab', histTab); } catch {}
    renderHistory();
  }));
  $('#favAdd').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cmd = $('#favInput').value.trim();
    if (!cmd) return;
    try {
      const item = await api('POST', '/api/favorites', { cmd, host: '' });
      if (!favItems.some((x) => x.id === item.id)) favItems.push(item);
      $('#favInput').value = '';
      renderHistory();
    } catch (err) { alert(err.message); }
  });
  $('#btnHistory').addEventListener('click', openHistory);
  $('#histClose').addEventListener('click', closeHistory);
  $('#histSearch').addEventListener('input', renderHistory);
  $('#histAll').addEventListener('change', renderHistory);
  histPanel.addEventListener('mousedown', (e) => { if (e.target === histPanel) closeHistory(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !histPanel.classList.contains('hidden')) closeHistory();
  });
  $('#histClear').addEventListener('click', async () => {
    const all = showAll();
    if (!confirm(all ? '清空所有主机的历史命令？(收藏不受影响)' : `清空 ${active.histHost} 的历史命令？(收藏不受影响)`)) return;
    try {
      await api('DELETE', '/api/history' + (all ? '' : '?host=' + encodeURIComponent(active.histHost)));
      histItems = all ? [] : histItems.filter((h) => h.host !== active.histHost);
      renderHistory();
    } catch (err) { alert(err.message); }
  });

  // ------------------------------------------------------------ 触屏滑动滚动
  // xterm.js 6 不支持触摸滚动，手指滑动会被浏览器当成下拉刷新。这里自己处理，行为与电脑滚轮一致：
  // - 程序开启了鼠标追踪 (Claude Code、tmux、htop、vim mouse=a 等)：发送鼠标滚轮事件，由程序自己滚动
  // - 普通界面：滚动终端的历史记录 (带惯性)
  // - 不支持鼠标的全屏程序：不发送任何按键，避免误触发 (比如方向键会调出历史输入)
  // ------------------------------------------------------------ tmux 本地快速滚动
  // tmux 开了鼠标时，历史在 tmux 手里，每滚一格都要 tmux 重画整屏再传回来，要等一个来回。
  // 改成：往上滚的第一下，服务端在目标主机上 tmux capture-pane 抓出这个 pane 的历史，
  // 网页盖一层可以原生滚动的历史视图，之后滚动全在本地。Esc / 回到实时画面 / 滚到底再往下 / 打字 退出。
  // 没有 tmux、pane 里是 vim 等全屏程序、分屏或抓到的不是这个画面时，照旧把滚轮交给程序
  const LS_LINES = 3000;

  function localScrollWheel(s, e) {
    if (s.bypassWheel) return true;
    if (s.scrollView) { scrollViewWheel(s, e.deltaY); return false; }
    if (s.scrollLoading) { s.heldWheel += e.deltaY < 0 ? 1 : -1; return false; } // 等结果期间的滚动先记下 (往上为正)
    const b = s.term.buffer.active;
    if (e.deltaY >= 0 || !s.sid || s.term.modes.mouseTrackingMode === 'none' || b.type !== 'alternate') return true;
    if (s.noTmuxUntil > Date.now()) return true;
    s.scrollLoading = true;
    s.heldWheel = 1;
    send(s, { type: 'tmux-history', lines: LS_LINES });
    s.lsTimer = setTimeout(() => onTmuxHistory(s, { ok: false, reason: 'timeout' }), 4000);
    s.lsToast = setTimeout(() => fontToast(s, '读取 tmux 历史…'), 250);
    return false;
  }

  // 抓到的历史末尾应该就是现在的画面：拿当前屏幕的文字行去对，对上 6 成以上才算同一个 pane
  function historyMatchesScreen(s, data) {
    const plain = data.replace(ANSI_RE, '').split('\n').slice(-s.term.rows * 3).join('\n');
    const b = s.term.buffer.active;
    let total = 0, hit = 0;
    for (let y = b.viewportY; y < b.viewportY + s.term.rows - 1; y++) { // 最后一行多半是 tmux 状态栏
      const t = b.getLine(y)?.translateToString(true).trim();
      if (!t || t.length < 4) continue;
      total++;
      if (plain.includes(t)) hit++;
    }
    return !total || hit / total >= 0.6;
  }

  function onTmuxHistory(s, m) {
    if (!s.scrollLoading) return;
    s.scrollLoading = false;
    clearTimeout(s.lsTimer);
    clearTimeout(s.lsToast);
    s.box.querySelector('.font-toast')?.remove();
    if (m.ok && historyMatchesScreen(s, m.data)) return openLocalScroll(s, m.data, Math.max(1, s.heldWheel));
    // 用不了：一段时间内不再尝试，把刚才拦下的滚轮补发给程序 (会进入 tmux 自己的复制模式)；说明原因，方便排查
    const reason = m.ok ? 'mismatch' : m.reason;
    s.noTmuxUntil = Date.now() + ({ 'no-tmux': 300000, busy: 5000, 'in-mode': 3000 }[reason] || 30000);
    const why = {
      mismatch: '抓到的 tmux 画面和当前屏幕对不上 (可能是分屏或多个 tmux 客户端)',
      busy: 'pane 里是全屏程序，滚动交给它',
      failed: '读取 tmux 历史失败', timeout: '读取 tmux 历史超时', offline: '连接已断开',
    }[reason];
    if (why) fontToast(s, '本地滚动不可用：' + why + '，改用 tmux 自己的滚动', 3000);
    const target = s.term.element.querySelector('.xterm-screen') || s.term.element;
    const r = target.getBoundingClientRect();
    s.bypassWheel = true;
    for (let i = 0; i < Math.min(Math.abs(s.heldWheel), 8); i++) {
      target.dispatchEvent(new WheelEvent('wheel', {
        deltaY: s.heldWheel > 0 ? -1 : 1, deltaMode: WheelEvent.DOM_DELTA_LINE, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        bubbles: true, cancelable: true,
      }));
    }
    s.bypassWheel = false;
  }

  function openLocalScroll(s, data, up) {
    const theme = termTheme();
    const screen = s.box.querySelector('.xterm-screen');
    const lh = (screen && screen.clientHeight / s.term.rows) || 17;
    const v = document.createElement('div');
    v.className = 'lscroll';
    v.innerHTML = '<button class="ls-close" title="Esc / 滚到最底下再往下 / 打字 也可以返回">回到实时画面 ✕</button><pre class="ls-body"></pre>';
    const pre = v.querySelector('.ls-body');
    Object.assign(pre.style, {
      fontFamily: s.term.options.fontFamily, fontSize: s.term.options.fontSize + 'px', lineHeight: lh + 'px',
      color: theme.foreground, background: theme.background,
    });
    pre.innerHTML = ansiToHtml(data.replace(/\n+$/, ''), theme);
    s.box.appendChild(v);
    s.scrollView = v;
    s.lsLine = lh;
    pre.scrollTop = pre.scrollHeight - pre.clientHeight - up * 3 * lh; // 和滚轮一样往回看几行
    v.querySelector('.ls-close').addEventListener('click', () => closeLocalScroll(s));
    // 电脑：在最底下还往下滚 = 回到实时画面
    pre.addEventListener('wheel', (e) => {
      if (e.deltaY > 0 && atBottom(pre)) { e.preventDefault(); closeLocalScroll(s); }
    }, { passive: false });
    // 手机：已经在最底下时再往上推 = 回到实时画面
    let startY = 0, startBottom = false;
    pre.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; startBottom = atBottom(pre); }, { passive: true });
    pre.addEventListener('touchend', (e) => {
      const dy = (e.changedTouches[0]?.clientY ?? startY) - startY;
      if (startBottom && dy < -40) closeLocalScroll(s);
    });
  }

  const atBottom = (el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2;

  // 手指一开始是在终端上滑的，这一次滑动剩下的滚轮事件继续滚历史视图
  function scrollViewWheel(s, deltaY) {
    const pre = s.scrollView.querySelector('.ls-body');
    if (deltaY > 0 && atBottom(pre)) return closeLocalScroll(s);
    pre.scrollTop += Math.sign(deltaY) * 3 * s.lsLine;
  }

  function closeLocalScroll(s) {
    if (!s.scrollView) return;
    s.scrollView.remove();
    s.scrollView = null;
    if (s === active) focusTerm(s);
  }

  // 用不了本地滚动时滚轮交给 tmux，进入 tmux 自己的复制模式 (pane 右上角有 [5/300] 这样的位置标记)：
  // 同样显示「回到实时画面」，点了发 q 退出复制模式
  function tmuxInCopyMode(s) {
    const b = s.term.buffer.active;
    if (b.type !== 'alternate' || s.scrollView) return false;
    return /\[\d+\/\d+\]\s*$/.test(b.getLine(b.viewportY)?.translateToString(true) || '');
  }
  function updateCopyModeBtn(s) {
    const on = !!s.sid && tmuxInCopyMode(s);
    if (on && !s.copyBtn) {
      s.copyBtn = document.createElement('button');
      s.copyBtn.className = 'ls-close tmux-exit';
      s.copyBtn.textContent = '回到实时画面 ✕';
      s.copyBtn.title = '退出 tmux 复制模式 (发送 q)';
      s.copyBtn.addEventListener('mousedown', (e) => e.preventDefault());
      s.copyBtn.addEventListener('click', () => { send(s, { type: 'data', data: 'q' }); focusTerm(s); });
      s.box.appendChild(s.copyBtn);
    }
    if (s.copyBtn) s.copyBtn.classList.toggle('hidden', !on);
  }
  setInterval(() => { if (active) updateCopyModeBtn(active); }, 300);

  // 历史视图打开时 Esc 只用来返回，不发给终端 (免得打断 Claude Code)
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !active?.scrollView || document.querySelector('.overlay:not(.hidden)')) return;
    e.preventDefault();
    e.stopPropagation();
    closeLocalScroll(active);
  }, true);

  // tmux capture-pane -e 的颜色 (SGR) 转成 HTML；其他控制序列丢掉
  const ANSI_RE = /\x1b\[[0-9;:?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b./g;
  const XTERM_ANSI = ['#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
    '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec'];
  const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed',
    'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];

  function palette256(theme) {
    const p = ANSI_NAMES.map((n, i) => theme[n] || XTERM_ANSI[i]);
    const v = [0, 95, 135, 175, 215, 255];
    for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) p.push(`rgb(${v[r]},${v[g]},${v[b]})`);
    for (let i = 0; i < 24; i++) { const c = 8 + i * 10; p.push(`rgb(${c},${c},${c})`); }
    return p;
  }

  function ansiToHtml(text, theme) {
    const pal = palette256(theme);
    let fg = null, bg = null, fgIdx = -1, bold = false, dim = false, it = false, ul = false, inv = false, st = false;
    let out = '', last = 0, m;
    const css = () => {
      let f = fg, b = bg;
      if (bold && fgIdx >= 0 && fgIdx < 8) f = pal[fgIdx + 8]; // 同 xterm：粗体用亮色
      if (inv) { const t = f; f = b || theme.background; b = t || theme.foreground; }
      let c = '';
      if (f) c += `color:${f};`;
      if (b) c += `background:${b};`;
      if (bold) c += 'font-weight:bold;';
      if (dim) c += 'opacity:.6;';
      if (it) c += 'font-style:italic;';
      if (ul || st) c += `text-decoration:${ul ? 'underline' : ''} ${st ? 'line-through' : ''};`;
      return c;
    };
    const put = (t) => {
      if (!t) return;
      const c = css();
      out += c ? `<span style="${c}">${esc(t)}</span>` : esc(t);
    };
    ANSI_RE.lastIndex = 0;
    while ((m = ANSI_RE.exec(text))) {
      put(text.slice(last, m.index));
      last = ANSI_RE.lastIndex;
      const seq = m[0];
      if (!seq.endsWith('m') || seq[1] !== '[') continue;
      const ps = (seq.slice(2, -1) || '0').split(/[;:]/).map((x) => parseInt(x, 10) || 0);
      for (let i = 0; i < ps.length; i++) {
        const c = ps[i];
        if (c === 0) { fg = bg = null; fgIdx = -1; bold = dim = it = ul = inv = st = false; }
        else if (c === 1) bold = true;
        else if (c === 2) dim = true;
        else if (c === 3) it = true;
        else if (c === 4) ul = true;
        else if (c === 7) inv = true;
        else if (c === 9) st = true;
        else if (c === 22) bold = dim = false;
        else if (c === 23) it = false;
        else if (c === 24) ul = false;
        else if (c === 27) inv = false;
        else if (c === 29) st = false;
        else if (c >= 30 && c <= 37) { fg = pal[c - 30]; fgIdx = c - 30; }
        else if (c === 39) { fg = null; fgIdx = -1; }
        else if (c >= 40 && c <= 47) bg = pal[c - 40];
        else if (c === 49) bg = null;
        else if (c >= 90 && c <= 97) { fg = pal[c - 82]; fgIdx = -1; }
        else if (c >= 100 && c <= 107) bg = pal[c - 92];
        else if (c === 38 || c === 48) {
          let col = null;
          if (ps[i + 1] === 5) { col = pal[ps[i + 2]] || null; i += 2; }
          else if (ps[i + 1] === 2) { col = `rgb(${ps[i + 2]},${ps[i + 3]},${ps[i + 4]})`; i += 4; }
          if (c === 38) { fg = col; fgIdx = -1; } else bg = col;
        }
      }
    }
    put(text.slice(last));
    return out;
  }

  function enableTouchScroll(s) {
    const WHEEL_LINES = 3; // 手指移动 3 行发送一次滚轮 (同普通鼠标滚轮)
    const WHEEL_GAP = 35;  // 两次滚轮事件最小间隔 ms，给远端 (tmux 等) 重绘留时间
    const WHEEL_MAX_QUEUE = 4;
    let lastY = null;
    let lastX = 0;
    let lastT = 0;
    let vel = 0;      // px/ms
    let acc = 0;      // 还没换算成行 / 滚轮的累计像素
    let pendingPx = 0; // 本帧待处理的滑动距离 (合并同一帧内的多次 touchmove)
    let frame = 0;
    let lh = 17;
    let wheelQueue = 0; // 待发送的滚轮次数，正数 = 往回看
    let wheelTimer = 0;
    let lastWheelAt = 0;

    const measure = () => {
      const screen = s.box.querySelector('.xterm-screen');
      lh = (screen && s.term.rows && screen.clientHeight / s.term.rows) || 17;
    };
    const wheelMode = () => s.term.modes.mouseTrackingMode !== 'none';

    // 交给 xterm 按滚轮处理，它会按程序要求的鼠标协议 (SGR 等) 编码发送
    const sendWheel = (dir) => {
      const target = s.term.element.querySelector('.xterm-screen') || s.term.element;
      const r = target.getBoundingClientRect();
      target.dispatchEvent(new WheelEvent('wheel', {
        deltaY: dir > 0 ? -1 : 1, deltaMode: WheelEvent.DOM_DELTA_LINE,
        clientX: Math.min(Math.max(lastX, r.left + 1), r.right - 1), clientY: r.top + r.height / 2,
        bubbles: true, cancelable: true,
      }));
    };

    // 按固定间隔匀速发送，避免一次甩动瞬间发出几十个事件导致远端重绘堆积、画面一顿一顿
    const pumpWheel = () => {
      wheelTimer = 0;
      if (!wheelQueue) return;
      const wait = WHEEL_GAP - (performance.now() - lastWheelAt);
      if (wait > 0) { wheelTimer = setTimeout(pumpWheel, wait); return; }
      const dir = Math.sign(wheelQueue);
      sendWheel(dir);
      wheelQueue -= dir;
      lastWheelAt = performance.now();
      if (wheelQueue) wheelTimer = setTimeout(pumpWheel, WHEEL_GAP);
    };

    const queueWheel = (n) => {
      if (Math.sign(n) !== Math.sign(wheelQueue)) wheelQueue = 0; // 反向时丢弃旧方向
      wheelQueue = Math.max(-WHEEL_MAX_QUEUE, Math.min(WHEEL_MAX_QUEUE, wheelQueue + n));
      if (!wheelTimer) pumpWheel();
    };

    // dy > 0: 手指下滑 = 往回看
    const scrollPx = (dy) => {
      if (Math.sign(dy) !== Math.sign(acc)) acc = 0;
      acc += dy;
      if (wheelMode()) {
        const unit = lh * WHEEL_LINES;
        const n = Math.trunc(acc / unit);
        if (n) { acc -= n * unit; queueWheel(n); }
        return;
      }
      const lines = Math.trunc(acc / lh);
      if (!lines) return;
      acc -= lines * lh;
      if (s.term.buffer.active.type === 'normal') s.term.scrollLines(-lines);
      else showScrollHint(s);
    };

    // 同一帧内的多次 touchmove 合并处理 (高刷新率手机上 touchmove 比屏幕刷新还频繁)
    const flush = () => {
      frame = 0;
      const dy = pendingPx;
      pendingPx = 0;
      if (dy) scrollPx(dy);
    };

    // 惯性：按时间衰减 (与刷新率无关)；tmux 等远端滚动衰减更快，松手后不会一直漂
    let lastFrameT = 0;
    const momentum = (t) => {
      const dt = Math.min(t - lastFrameT, 50);
      lastFrameT = t;
      if (Math.abs(vel) < 0.04) return;
      scrollPx(vel * dt);
      vel *= Math.pow(wheelMode() ? 0.88 : 0.95, dt / 16);
      frame = requestAnimationFrame(momentum);
    };

    // 长按 (不移动) 打开复制面板
    let pressTimer = 0;
    let pressX = 0;
    let pressY = 0;
    const cancelPress = () => { clearTimeout(pressTimer); pressTimer = 0; };
    s.box.addEventListener('touchstart', (e) => {
      cancelPress();
      s.longPressed = false;
      if (e.touches.length === 1 && !e.target.closest('button, .scroll-hint')) {
        pressX = e.touches[0].clientX;
        pressY = e.touches[0].clientY;
        pressTimer = setTimeout(() => {
          pressTimer = 0;
          lastY = null; // 本次触摸不再滚动
          s.longPressed = true;
          navigator.vibrate?.(15);
          openCopyPanel(s);
        }, 500);
      }
    }, { passive: true });
    s.box.addEventListener('touchmove', (e) => {
      if (pressTimer && Math.hypot(e.touches[0].clientX - pressX, e.touches[0].clientY - pressY) > 8) cancelPress();
    }, { passive: true });
    s.box.addEventListener('touchend', cancelPress, { passive: true });
    s.box.addEventListener('touchcancel', cancelPress, { passive: true });

    // 双指捏合调整字体大小
    let pinch = null;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    s.box.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) pinch = { d0: dist(e.touches) || 1, base: fontSize, raf: 0, size: fontSize };
    }, { passive: true });
    s.box.addEventListener('touchmove', (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      pinch.size = pinch.base * dist(e.touches) / pinch.d0;
      if (!pinch.raf) {
        pinch.raf = requestAnimationFrame(() => {
          if (!pinch) return;
          pinch.raf = 0;
          setFontSize(pinch.size, false);
          fontToast(s, `字体 ${fontSize}`);
        });
      }
    }, { passive: false });
    const endPinch = (e) => {
      if (!pinch || e.touches.length >= 2) return;
      cancelAnimationFrame(pinch.raf);
      setFontSize(pinch.size, true);
      pinch = null;
    };
    s.box.addEventListener('touchend', endPinch, { passive: true });
    s.box.addEventListener('touchcancel', endPinch, { passive: true });

    s.box.addEventListener('touchstart', (e) => {
      cancelAnimationFrame(frame);
      frame = 0;
      pendingPx = 0;
      if (e.touches.length !== 1) { lastY = null; return; }
      measure();
      lastY = e.touches[0].clientY;
      lastX = e.touches[0].clientX;
      lastT = performance.now();
      vel = 0;
      acc = 0;
    }, { passive: true });

    s.box.addEventListener('touchmove', (e) => {
      if (lastY == null || e.touches.length !== 1) return;
      e.preventDefault(); // 阻止下拉刷新 / 页面滚动
      const y = e.touches[0].clientY;
      const now = performance.now();
      const dy = y - lastY;
      vel = 0.7 * (dy / Math.max(now - lastT, 1)) + 0.3 * vel;
      lastY = y;
      lastT = now;
      pendingPx += dy;
      if (!frame) frame = requestAnimationFrame(flush);
    }, { passive: false });

    s.box.addEventListener('touchend', () => {
      if (lastY == null) return;
      lastY = null;
      cancelAnimationFrame(frame);
      flush();
      // 停顿后再松手不需要惯性
      if (performance.now() - lastT > 80) vel = 0;
      vel = Math.max(-4, Math.min(4, vel));
      lastFrameT = performance.now();
      frame = requestAnimationFrame(momentum);
    }, { passive: true });
  }

  // ------------------------------------------------------------ 复制终端内容 (手机)
  // 手机上触摸被用来滚动，无法直接选中终端文字；这里把终端内容放进可选择的文本框
  const COPY_LINES = 1000;

  function terminalText(s) {
    const b = s.term.buffer.active;
    const start = Math.max(0, b.length - COPY_LINES);
    const lines = [];
    for (let i = start; i < b.length; i++) {
      const line = b.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      // 自动换行的续行接回上一行
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.join('\n');
  }

  function openCopyPanel(s) {
    if (!s) return;
    const ta = $('#copyText');
    ta.value = terminalText(s);
    const n = ta.value ? ta.value.split('\n').length : 0;
    $('#copyInfo').textContent = s.term.buffer.active.type === 'alternate'
      ? `${n} 行 (全屏程序只有当前画面)` : `${n} 行`;
    mInput.blur();
    $('#copyPanel').classList.remove('hidden');
    ta.scrollTop = ta.scrollHeight; // 定位到最新内容
  }

  function closeCopyPanel() {
    $('#copyPanel').classList.add('hidden');
    try { window.getSelection()?.removeAllRanges(); } catch {}
  }

  async function copyText(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    // HTTP 下没有剪贴板接口，用临时文本框 + execCommand 复制
    const tmp = document.createElement('textarea');
    tmp.value = text;
    tmp.setAttribute('readonly', '');
    tmp.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
    document.body.appendChild(tmp);
    tmp.select();
    tmp.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    tmp.remove();
    return ok;
  }

  function copyToast(msg) {
    const t = $('#copyToast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t.timer);
    t.timer = setTimeout(() => t.classList.remove('show'), 1600);
  }

  $('#copyAll').addEventListener('click', async () => {
    const text = $('#copyText').value;
    copyToast(await copyText(text) ? `已复制全部 (${text.length} 个字符)` : '复制失败，请长按文字手动复制');
  });
  $('#copySel').addEventListener('click', async () => {
    const ta = $('#copyText');
    const text = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    if (!text) return copyToast('请先长按文字选择要复制的部分');
    copyToast(await copyText(text) ? `已复制 ${text.length} 个字符` : '复制失败，请长按文字手动复制');
  });
  $('#copyClose').addEventListener('click', closeCopyPanel);
  $('#copyPanel').addEventListener('mousedown', (e) => { if (e.target.id === 'copyPanel') closeCopyPanel(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#copyPanel').classList.contains('hidden')) closeCopyPanel();
  });

  // 全屏程序 (多为 tmux) 没开鼠标时无法滑动：提示并可一键为 tmux 开启鼠标
  function showScrollHint(s) {
    if (s.noScrollHint || s.scrollHint) return;
    const el = document.createElement('div');
    el.className = 'scroll-hint';
    el.innerHTML = `<div class="msg">当前全屏程序没有开启鼠标，无法滑动查看历史记录。<br>如果在用 <b>tmux</b>，可以一键开启鼠标滚动：</div>
      <div class="acts"><button class="primary" data-a="on">开启 tmux 鼠标滚动</button><button data-a="no">不再提示</button></div>`;
    s.box.appendChild(el);
    s.scrollHint = el;
    const close = () => { el.remove(); s.scrollHint = null; };
    el.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const a = e.target.dataset.a;
      if (a === 'no') { s.noScrollHint = true; return close(); }
      if (a !== 'on' || !s.sid) return;
      e.target.disabled = true;
      try {
        await api('POST', `/api/sessions/${s.sid}/tmux-mouse`);
        el.innerHTML = '<div class="msg">✔ 已为 tmux 开启鼠标，现在可以滑动查看历史了（在底部继续下滑会自动退出查看模式）。<br>'
          + '<span class="note">tmux 重启后需要重新开启；想永久生效，在 ~/.tmux.conf 加一行 <code>set -g mouse on</code></span></div>';
        setTimeout(close, 6000);
      } catch (err) {
        el.querySelector('.msg').textContent = '开启失败：' + err.message;
        setTimeout(close, 4000);
      }
    });
  }

  // ------------------------------------------------------------ 完成通知 (Web Push)
  // 告诉服务端哪个标签正被看着：正在看的标签响铃时不推送
  function reportWatching() {
    for (const x of sessions) send(x, { type: 'watching', watching: !document.hidden && x === active });
  }
  document.addEventListener('visibilitychange', () => {
    reportWatching();
    sessions.forEach(syncMonitor); // 页面不可见时暂停性能监控采集
    if (!document.hidden && active) enableWebgl(active);
    if (!document.hidden && active) active.tab.classList.remove('ring');
  });

  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && window.isSecureContext;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  let swReg = null;

  async function initPush() {
    if ('serviceWorker' in navigator && window.isSecureContext) {
      try {
        swReg = await navigator.serviceWorker.register('/sw.js');
        // 点击通知时，已打开的页面切到对应标签
        navigator.serviceWorker.addEventListener('message', (e) => {
          if (e.data && e.data.type === 'open-session') {
            const t = sessions.find((x) => x.remoteId === e.data.id);
            if (t) activate(t);
          }
        });
      } catch {}
    }
    updateNotifyBtn();
  }

  async function currentSub() {
    try { return swReg ? await swReg.pushManager.getSubscription() : null; } catch { return null; }
  }

  async function updateNotifyBtn() {
    const b = $('#btnNotify');
    const on = pushSupported() && (await currentSub()) && Notification.permission === 'granted';
    b.textContent = !pushSupported() ? '不可用' : on ? '已开启' : '未开启';
    b.classList.toggle('on', !!on);
    b.classList.toggle('na', !pushSupported());
    b.title = pushSupported() ? '终端有提示音时推送通知' : '需要通过 HTTPS 访问 (iPhone 需先添加到主屏幕)';
  }

  const b64ToBytes = (b64) => {
    const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  };

  async function enablePush() {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('没有获得通知权限，请在浏览器设置里允许这个网站发送通知');
    const reg = swReg || await navigator.serviceWorker.ready;
    const { publicKey } = await api('GET', '/api/push/key');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
    await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
  }

  $('#btnNotify').addEventListener('click', async () => {
    if (!window.isSecureContext) {
      return alert('完成通知需要通过 HTTPS 访问（例如 Cloudflare 隧道的域名），局域网 http:// 地址无法使用。');
    }
    if (!pushSupported()) {
      return alert(isIOS && !standalone
        ? 'iPhone / iPad 需要先点 Safari 的「分享 → 添加到主屏幕」，从主屏幕图标打开后再开启通知（iOS 16.4 以上）。'
        : '当前浏览器不支持推送通知。');
    }
    const sub = await currentSub();
    try {
      if (sub && Notification.permission === 'granted') {
        const r = await dialog('完成通知', `<p>已开启。终端出现提示音（如 Claude Code 完成任务、<code>printf '\\a'</code>）时推送到这台设备；
          正在看的标签不会推送。</p>`, [
          { label: '关闭通知', value: 'off', cls: 'danger' },
          { label: '发送测试通知', value: 'test' },
          { label: '取消', value: null, cls: 'primary', cancel: true },
        ]);
        if (r.value === 'test') await api('POST', '/api/push/test');
        if (r.value === 'off') {
          await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
          await sub.unsubscribe();
        }
      } else {
        await enablePush();
        await api('POST', '/api/push/test');
      }
    } catch (e) {
      alert('操作失败：' + e.message);
    }
    updateNotifyBtn();
  });

  // ------------------------------------------------------------ 性能监控
  const MON_INTERVAL = 2000;
  const MON_POINTS = 60; // 图表保留 60 个点 (约 2 分钟)

  const fmtBytes = (n, digits = 1) => {
    if (n == null || isNaN(n)) return '-';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? Math.round(n) : n.toFixed(n < 10 ? digits : 0)) + ' ' + u[i];
  };
  const fmtRate = (n) => (n == null ? '-' : fmtBytes(n) + '/s');
  const fmtPct = (n) => (n == null ? '-' : n.toFixed(n < 10 ? 1 : 0) + '%');
  const fmtUptime = (sec) => {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return d ? `${d} 天 ${h} 小时` : h ? `${h} 小时 ${m} 分` : `${m} 分钟`;
  };
  const meterClass = (pct) => (pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : '');

  $('#btnMon').addEventListener('click', () => {
    const s = active;
    if (!s) return;
    if (!s.mon) s.mon = createMonitor(s);
    s.mon.open = !s.mon.open;
    if (s.mon.open) s.el.insertBefore(s.mon.el, s.el.firstChild);
    else { s.mon.el.remove(); focusTerm(s); }
    updateSftpBtn();
    requestAnimationFrame(() => s.fit.fit());
  });

  // 只为「页面可见 + 当前标签 + 面板打开 + 已连接」的会话采集，其他暂停
  function syncMonitor(s) {
    const m = s.mon;
    if (!m) return;
    const want = m.open && s === active && !!s.sid && !s.closed && !document.hidden;
    if (want && !m.running) {
      m.running = true;
      m.poll();
    } else if (!want && m.running) {
      m.running = false;
      clearTimeout(m.timer);
    }
  }

  function createMonitor(s) {
    const el = document.createElement('div');
    el.className = 'mon';
    el.innerHTML = `
      <div class="mon-head"><span class="mh">性能监控</span><button data-a="close" title="关闭">×</button></div>
      <div class="sub m-os"></div>
      <div class="sub m-up"></div>
      <div class="m-body"><div class="note" style="margin-top:14px">正在采集…</div></div>
      <div class="err m-err"></div>`;
    const m = { el, open: false, running: false, timer: null, hist: [], iface: '', procSort: 'cpu', last: null };

    el.querySelector('[data-a=close]').onclick = () => $('#btnMon').click();

    m.poll = async () => {
      if (!m.running) return;
      const sid = s.sid;
      try {
        const d = await api('GET', '/api/monitor/' + sid);
        if (!m.running || sid !== s.sid) return;
        $('.m-err', el).textContent = '';
        m.last = d;
        m.hist.push({ t: d.time, ifaces: d.ifaces });
        if (m.hist.length > MON_POINTS) m.hist.shift();
        render(d);
      } catch (e) {
        $('.m-err', el).textContent = e.message;
      }
      if (m.running) m.timer = setTimeout(m.poll, MON_INTERVAL);
    };

    function netOf(ifaces) {
      if (!m.iface) {
        let rx = 0, tx = 0, ok = false;
        for (const i of ifaces) if (i.rxRate != null) { rx += i.rxRate; tx += i.txRate; ok = true; }
        return ok ? { rx, tx } : { rx: null, tx: null };
      }
      const i = ifaces.find((x) => x.name === m.iface);
      return i ? { rx: i.rxRate, tx: i.txRate } : { rx: null, tx: null };
    }

    function render(d) {
      $('.mh', el).textContent = d.hostname || '性能监控';
      $('.m-os', el).textContent = [d.os, d.kernel].filter(Boolean).join(' · ');
      $('.m-up', el).textContent = `运行 ${fmtUptime(d.uptime)} · 负载 ${d.load.map((x) => x.toFixed(2)).join(' ')}`;
      const body = $('.m-body', el);
      if (!body.dataset.built) build(body);

      const c = d.cpu;
      $('.v-cpu', el).textContent = fmtPct(c.usage);
      setMeter($('.b-cpu', el), c.usage);
      $('.n-cpu', el).textContent = `${c.cores} 核 · 用户 ${fmtPct(c.user)} · 系统 ${fmtPct(c.system)} · IO等待 ${fmtPct(c.iowait)}`
        + (d.temp != null ? ` · ${d.temp.toFixed(0)}°C` : '');
      $('.n-cpu', el).title = c.model;

      const mp = d.mem.total ? (d.mem.used / d.mem.total) * 100 : 0;
      $('.v-mem', el).textContent = `${fmtBytes(d.mem.used)} / ${fmtBytes(d.mem.total)}`;
      setMeter($('.b-mem', el), mp);
      $('.n-mem', el).textContent = `已用 ${fmtPct(mp)} · 缓存 ${fmtBytes(d.mem.cache)}`;
      const swapSec = $('.s-swap', el);
      swapSec.hidden = !d.mem.swapTotal;
      if (d.mem.swapTotal) {
        const sp = (d.mem.swapUsed / d.mem.swapTotal) * 100;
        $('.v-swap', el).textContent = `${fmtBytes(d.mem.swapUsed)} / ${fmtBytes(d.mem.swapTotal)}`;
        setMeter($('.b-swap', el), sp);
      }

      // 网卡选择
      const sel = $('.m-iface', el);
      const names = d.ifaces.map((i) => i.name);
      if (sel.dataset.names !== names.join(',')) {
        sel.dataset.names = names.join(',');
        sel.innerHTML = '<option value="">全部网卡</option>' + names.map((n) => `<option>${esc(n)}</option>`).join('');
        sel.value = names.includes(m.iface) ? m.iface : '';
      }
      const net = netOf(d.ifaces);
      $('.v-rx', el).textContent = '下载 ' + fmtRate(net.rx);
      $('.v-tx', el).textContent = '上传 ' + fmtRate(net.tx);
      drawChart();

      $('.v-io', el).textContent = `读 ${fmtRate(d.io.readRate)} · 写 ${fmtRate(d.io.writeRate)}`;

      $('.m-disks', el).innerHTML = d.disks.map((k) => {
        const pct = k.total ? (k.used / k.total) * 100 : 0;
        return `<div class="dsk" title="${esc(k.fs)}"><div class="sec-t"><span class="mnt">${esc(k.mount)}</span>
          <span class="val">${fmtBytes(k.used)} / ${fmtBytes(k.total)} · ${fmtPct(pct)}</span></div>
          <div class="meter thin"><i class="${meterClass(pct)}" style="width:${Math.min(pct, 100)}%"></i></div></div>`;
      }).join('') || '<div class="note">无</div>';

      renderProcs(d);
    }

    function renderProcs(d) {
      const list = m.procSort === 'cpu' ? d.topCpu : d.topMem;
      $('.n-proc', el).textContent = `${d.procCount} 个进程`;
      $('.m-procs tbody', el).innerHTML = list.map((p) => `<tr title="PID ${p.pid}">
        <td>${esc(p.name)}</td><td>${p.cpu == null ? '-' : fmtPct(p.cpu)}</td><td>${fmtBytes(p.mem, 0)}</td></tr>`).join('');
    }

    function setMeter(i, pct) {
      i.style.width = Math.min(Math.max(pct || 0, 0), 100) + '%';
      const cls = meterClass(pct || 0);
      i.classList.toggle('warn', cls === 'warn');
      i.classList.toggle('crit', cls === 'crit');
    }

    function build(body) {
      body.dataset.built = '1';
      body.innerHTML = `
        <div class="sec"><div class="sec-t"><b>CPU</b><span class="val v-cpu"></span></div>
          <div class="meter"><i class="b-cpu"></i></div><div class="note n-cpu"></div></div>
        <div class="sec"><div class="sec-t"><b>内存</b><span class="val v-mem"></span></div>
          <div class="meter"><i class="b-mem"></i></div><div class="note n-mem"></div></div>
        <div class="sec s-swap"><div class="sec-t"><b>交换</b><span class="val v-swap"></span></div>
          <div class="meter"><i class="b-swap"></i></div></div>
        <div class="sec"><div class="sec-t"><b>网络</b><select class="m-iface" title="选择网卡"></select></div>
          <div class="net-legend"><span class="v-rx" style="--c:var(--dl)"></span><span class="v-tx" style="--c:var(--ul)"></span></div>
          <div class="chart-wrap"><canvas class="m-chart"></canvas><div class="chart-tip" hidden></div></div></div>
        <div class="sec"><div class="sec-t"><b>磁盘 IO</b><span class="val v-io"></span></div></div>
        <div class="sec"><div class="sec-t"><b>磁盘</b></div><div class="m-disks"></div></div>
        <div class="sec"><div class="sec-t"><b>进程</b><span class="note n-proc" style="margin:0"></span>
          <span class="ptabs"><button data-sort="cpu" class="on">CPU</button><button data-sort="mem">内存</button></span></div>
          <table class="ptable m-procs"><colgroup><col class="n"><col class="c"><col class="m"></colgroup>
          <thead><tr><th>名称</th><th>CPU</th><th>内存</th></tr></thead><tbody></tbody></table></div>`;
      $('.m-iface', el).onchange = (e) => { m.iface = e.target.value; if (m.last) render(m.last); };
      el.querySelectorAll('.ptabs button').forEach((b) => {
        b.onclick = () => {
          m.procSort = b.dataset.sort;
          el.querySelectorAll('.ptabs button').forEach((x) => x.classList.toggle('on', x === b));
          if (m.last) renderProcs(m.last);
        };
      });
      const cv = $('.m-chart', el);
      cv.addEventListener('pointermove', (e) => { m.hover = e.offsetX; drawChart(); });
      cv.addEventListener('pointerleave', () => { m.hover = null; drawChart(); });
    }

    // 网速折线图：下载蓝 / 上传橙，2px 线，y 轴从 0 开始，悬停显示数值
    function drawChart() {
      const cv = $('.m-chart', el);
      if (!cv) return;
      const w = cv.clientWidth, h = cv.clientHeight, dpr = window.devicePixelRatio || 1;
      if (!w) return;
      if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const pts = m.hist.map((p) => ({ t: p.t, ...netOf(p.ifaces) }));
      const max = Math.max(1024, ...pts.map((p) => Math.max(p.rx || 0, p.tx || 0))) * 1.15;
      const top = 14, bottom = h - 2;
      const y = (v) => bottom - ((v || 0) / max) * (bottom - top);
      const x = (i) => w - (pts.length - 1 - i) * (w / (MON_POINTS - 1));
      const css = getComputedStyle(el);
      // 网格与刻度 (弱化)
      ctx.strokeStyle = css.getPropertyValue('--border').trim();
      ctx.lineWidth = 1;
      for (const f of [0, 0.5, 1]) {
        const gy = Math.round(bottom - f * (bottom - top)) + 0.5;
        ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
      }
      ctx.fillStyle = css.getPropertyValue('--muted') || '#94a3b8';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(fmtRate(max), 2, 10);
      const line = (key, color) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        let started = false;
        pts.forEach((p, i) => {
          if (p[key] == null) { started = false; return; }
          if (!started) { ctx.moveTo(x(i), y(p[key])); started = true; } else ctx.lineTo(x(i), y(p[key]));
        });
        ctx.stroke();
      };
      line('rx', css.getPropertyValue('--dl').trim());
      line('tx', css.getPropertyValue('--ul').trim());

      const tip = $('.chart-tip', el);
      if (m.hover == null || !pts.length) { tip.hidden = true; return; }
      const i = Math.round((pts.length - 1) - (w - m.hover) / (w / (MON_POINTS - 1)));
      const p = pts[Math.min(Math.max(i, 0), pts.length - 1)];
      const px = x(pts.indexOf(p));
      ctx.strokeStyle = css.getPropertyValue('--muted').trim();
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(px) + 0.5, top); ctx.lineTo(Math.round(px) + 0.5, bottom); ctx.stroke();
      for (const [k, col] of [['rx', '--dl'], ['tx', '--ul']]) {
        if (p[k] == null) continue;
        ctx.fillStyle = css.getPropertyValue(col).trim();
        ctx.strokeStyle = css.getPropertyValue('--panel').trim() || '#111827';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(px, y(p[k]), 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      const ago = Math.round((Date.now() - p.t) / 1000);
      tip.innerHTML = `<div class="note" style="margin:0 0 2px">${ago <= 1 ? '现在' : ago + ' 秒前'}</div>
        <div style="--c:var(--dl)">下载 ${fmtRate(p.rx)}</div><div style="--c:var(--ul)">上传 ${fmtRate(p.tx)}</div>`;
      tip.hidden = false;
      // 默认在十字线右侧，放不下就放左侧
      const tw = tip.offsetWidth;
      tip.style.left = (px + 8 + tw > w ? Math.max(px - tw - 8, 0) : px + 8) + 'px';
    }

    m.redraw = drawChart;
    return m;
  }

  // ------------------------------------------------------------ 标签拖动排序
  // 鼠标：按住拖动超过 5px 开始；触屏：长按 350ms 开始 (避免和左右滑动标签栏冲突)
  const tabsEl = $('#tabs');
  let drag = null;

  function beginDrag() {
    if (!drag) return;
    drag.started = true;
    drag.tab.classList.add('dragging');
    tabsEl.classList.add('drag-active');
    if (drag.touch) navigator.vibrate?.(15);
  }

  function moveDrag(x) {
    const tabs = [...tabsEl.children];
    const i = tabs.indexOf(drag.tab);
    const prev = tabs[i - 1];
    const next = tabs[i + 1];
    const mid = (el) => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; };
    if (prev && x < mid(prev)) tabsEl.insertBefore(drag.tab, prev);
    else if (next && x > mid(next)) tabsEl.insertBefore(drag.tab, next.nextSibling);
    // 拖到边缘时自动滚动标签栏
    const r = tabsEl.getBoundingClientRect();
    if (x < r.left + 30) tabsEl.scrollLeft -= 12;
    else if (x > r.right - 30) tabsEl.scrollLeft += 12;
  }

  function endDrag() {
    if (!drag) return;
    clearTimeout(drag.timer);
    if (drag.started) {
      drag.tab.classList.remove('dragging');
      tabsEl.classList.remove('drag-active');
      // sessions 顺序与界面保持一致
      const order = [...tabsEl.children];
      sessions.sort((a, b) => order.indexOf(a.tab) - order.indexOf(b.tab));
      activate(drag.s);
      saveTabOrder();
    }
    drag = null;
  }

  tabsEl.addEventListener('pointerdown', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab || e.target.closest('.x') || e.button > 0) return;
    const s = sessions.find((x) => x.tab === tab);
    if (!s) return;
    drag = { s, tab, startX: e.clientX, startY: e.clientY, started: false, touch: e.pointerType !== 'mouse' };
    if (drag.touch) drag.timer = setTimeout(beginDrag, 350);
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.started) {
      const moved = Math.max(Math.abs(e.clientX - drag.startX), Math.abs(e.clientY - drag.startY));
      if (drag.touch) {
        if (moved > 8) endDrag(); // 长按前就移动了 = 在滑动标签栏
        return;
      }
      if (moved < 5) return;
      beginDrag();
    }
    moveDrag(e.clientX);
  });
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  // 触屏拖动时阻止页面 / 标签栏滚动
  tabsEl.addEventListener('touchmove', (e) => { if (drag && drag.started) e.preventDefault(); }, { passive: false });
  tabsEl.addEventListener('contextmenu', (e) => { if (e.target.closest('.tab')) e.preventDefault(); });

  // 按界面上的顺序排列的标签
  const tabOrder = () => [...tabsEl.querySelectorAll('.tab')].map((el) => sessions.find((x) => x.tab === el)).filter(Boolean);

  // ------------------------------------------------------------ 标签切换快捷键
  // Alt+1~9 跳到第 N 个标签，Alt+← / Alt+→ 上一个 / 下一个 (循环)；按界面上的标签顺序。
  // 捕获阶段处理，不再发给终端 / 输入框；Ctrl+Tab、Ctrl+数字会被浏览器占用，所以用 Alt
  window.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const n = /^Digit([1-9])$/.exec(e.code);
    if (!n && e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') return;
    if (document.querySelector('.overlay:not(.hidden)')) return; // 弹窗打开时不切换
    const list = tabOrder();
    if (!list.length) return;
    e.preventDefault();
    e.stopPropagation();
    let target;
    if (n) target = list[n[1] - 1];
    else {
      const i = list.indexOf(active);
      target = list[(i + (e.code === 'ArrowRight' ? 1 : -1) + list.length) % list.length];
    }
    if (target && target !== active) activate(target);
  }, true);

  // ------------------------------------------------------------ 连按两下 Alt：光标在输入框和终端之间切换
  // 只算单独按下又松开的 Alt (Alt+1 等组合键里的 Alt 不算)；输入框隐藏时顺便打开
  let altClean = false, altLast = 0;
  window.addEventListener('keydown', (e) => {
    altClean = e.key === 'Alt' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    if (e.key !== 'Alt') altLast = 0;
  }, true);
  window.addEventListener('keyup', (e) => {
    if (e.key !== 'Alt' || !altClean) return;
    altClean = false;
    e.preventDefault(); // Windows 上单独按 Alt 会激活浏览器菜单
    const now = Date.now();
    if (now - altLast > 400) { altLast = now; return; }
    altLast = 0;
    if (isTouch || !active || document.querySelector('.overlay:not(.hidden)')) return;
    if (document.activeElement === dInput) active.term.focus();
    else if (!deskOn) setDeskOn(true);
    else dInput.focus();
  }, true);
  window.addEventListener('blur', () => { altClean = false; altLast = 0; });

  // ------------------------------------------------------------ 侧边栏
  const mobile = () => window.innerWidth <= 760;
  function setSidebar(open) {
    if (mobile()) app.classList.toggle('side-open', open);
    else app.classList.toggle('side-closed', !open);
    setTimeout(() => active && active.fit.fit(), 50);
  }
  const sidebarOpen = () => (mobile() ? app.classList.contains('side-open') : !app.classList.contains('side-closed'));
  $('#btnToggle').addEventListener('click', () => setSidebar(!sidebarOpen()));
  $('#btnSideClose').addEventListener('click', () => { setSidebar(false); if (active) focusTerm(active); });
  function closeSidebarOnMobile() { if (mobile()) app.classList.remove('side-open'); }
  $('#terms').addEventListener('click', closeSidebarOnMobile);

  applyTheme();
  renderKeyBar();
  setFontSize(fontSize, false);
  initPush();
  init().catch((e) => alert('初始化失败: ' + e.message));
})();
