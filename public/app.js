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

  async function init() {
    const me = await api('GET', '/api/me');
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
      groups[g].sort((a, b) => a.name.localeCompare(b.name)).forEach((h) => {
        const el = document.createElement('div');
        el.className = 'host';
        el.innerHTML = `
          <div class="info"><div class="name"></div><div class="addr"></div></div>
          ${h.connType === 'cloudflare' ? '<span class="badge" title="Cloudflare 隧道">CF</span>' : ''}
          <div class="ops"><button data-op="edit" title="编辑">✎</button><button data-op="del" title="删除">✕</button></div>`;
        $('.name', el).textContent = h.name;
        $('.addr', el).textContent = h.connType === 'cloudflare'
          ? `${h.username}@${h.host}` : `${h.username}@${h.host}:${h.port}`;
        el.addEventListener('click', async (e) => {
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
      scrollback: 10000,
      allowProposedApi: true,
    });
    s.fit = new FitAddon.FitAddon();
    s.term.loadAddon(s.fit);
    s.term.loadAddon(new WebLinksAddon.WebLinksAddon());
    s.term.open(s.box);
    enableTouchScroll(s);
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
    // Ctrl+Shift+C / Ctrl+Shift+V 复制粘贴
    s.term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
        navigator.clipboard?.writeText(s.term.getSelection());
        return false;
      }
      return true;
    });

    s.tab = document.createElement('div');
    s.tab.className = 'tab';
    s.tab.innerHTML = '<span class="dot"></span><span class="title"></span><button class="x" title="关闭">×</button>';
    // 标签显示「主机名-序号」: 家里 NAS-1、家里 NAS-2…，同一主机多开时序号递增，关闭后空出的序号可复用
    if (restore && restore.n) {
      s.baseTitle = title;
      s.n = restore.n;
    } else if (restore) {
      const m = /^(.*) \((\d+)\)$/.exec(title); // 兼容旧版本的「名称 (2)」
      s.baseTitle = m ? m[1] : title;
      s.n = m ? +m[2] : 1;
    } else {
      const used = new Set(sessions.filter((x) => x.baseTitle === title).map((x) => x.n));
      s.baseTitle = title;
      s.n = 1;
      while (used.has(s.n)) s.n++;
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
        ws.send(JSON.stringify({ type: 'attach', id: s.remoteId, ...size }));
      } else {
        ws.send(JSON.stringify({ type: 'connect', ...s.params, title: s.baseTitle, n: s.n, histHost: s.histHost, ...size }));
      }
      // 应用层心跳，避免 Cloudflare / 反向代理 100 秒空闲断开
      clearInterval(s.ping);
      s.ping = setInterval(() => send(s, { type: 'ping' }), 25000);
    };
    ws.onmessage = (ev) => {
      if (s.ws !== ws) return;
      if (ev.data instanceof ArrayBuffer) {
        s.term.write(new Uint8Array(ev.data), () => checkCapture(s));
        return;
      }
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'attached') {
        const isNew = !s.remoteId;
        s.remoteId = m.session.id;
        s.params = m.session.params || s.params;
        if (isNew) saveTabOrder();
        if (active === s) saveActive();
        reportWatching();
      } else if (m.type === 'snapshot') {
        // 还原服务端保存的画面和滚动记录
        s.term.reset();
        s.term.write(m.data);
        doneRestoring(s);
        if (active === s) syncSize(s);
      } else if (m.type === 'status') {
        s.sid = m.status === 'connected' ? m.sid : null;
        setStatus(s, m.status === 'connected' ? 'ok' : m.status === 'connecting' ? 'wait' : 'bad');
        if (m.status === 'closed') showReconnect(s, '重新连接');
        else hideReconnect(s);
        updateSftpBtn();
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
    if (ids.length) api('PUT', '/api/sessions/order', { ids }).catch(() => {});
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

  function activate(s) {
    active = s;
    sessions.forEach((x) => {
      x.el.classList.toggle('active', x === s);
      x.tab.classList.toggle('active', x === s);
    });
    requestAnimationFrame(() => { syncSize(s); focusTerm(s); });
    s.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    s.tab.classList.remove('ring');
    updateSftpBtn();
    updateMobileBar();
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
  const mods = { shift: false, ctrl: false, alt: false };

  function focusTerm(s) {
    if (!isTouch) s.term.focus();
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
  const modParam = () => 1 + (mods.shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
  const CURSOR = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' };
  const TILDE = { pgup: 5, pgdn: 6 };
  const FKEYS = {
    f1: '\x1bOP', f2: '\x1bOQ', f3: '\x1bOR', f4: '\x1bOS', f5: '\x1b[15~', f6: '\x1b[17~',
    f7: '\x1b[18~', f8: '\x1b[19~', f9: '\x1b[20~', f10: '\x1b[21~', f11: '\x1b[23~', f12: '\x1b[24~',
  };

  // 特殊键按下时生成要发送的字节 (含修饰键)
  function keySeq(k) {
    const m = modParam();
    let out;
    if (CURSOR[k]) {
      const c = CURSOR[k];
      if (m > 1) out = `\x1b[1;${m}${c}`;
      else if ('ABCD'.includes(c) && active && active.term.modes.applicationCursorKeysMode) out = '\x1bO' + c;
      else out = '\x1b[' + c;
    } else if (TILDE[k]) {
      out = m > 1 ? `\x1b[${TILDE[k]};${m}~` : `\x1b[${TILDE[k]}~`;
    } else if (k === 'tab') {
      out = mods.shift ? '\x1b[Z' : '\t'; // Shift+Tab (反向 Tab，Claude Code 切换模式)
      if (mods.alt) out = '\x1b' + out;
    } else if (k === 'esc') {
      out = '\x1b';
    } else if (k === 'bs') {
      out = mods.alt ? '\x1b\x7f' : mods.ctrl ? '\x08' : '\x7f';
    } else if (k === 'enter') {
      out = (mods.alt ? '\x1b' : '') + '\r';
    } else if (k === 'escesc') {
      out = '\x1b\x1b'; // Claude Code: 连按两次 Esc 撤回 / 编辑上一条
    } else if (FKEYS[k]) {
      out = FKEYS[k];
    } else if (/^\^[a-z]$/.test(k)) {
      out = String.fromCharCode(k.charCodeAt(1) - 96); // ^A..^Z
    }
    clearMods();
    return out;
  }

  // 输入框里常驻一个零宽字符作为「哨兵」：
  // 这样空输入框里按退格也会产生 input 事件，可以可靠地发送 ⌫
  const SENTINEL = '​';
  let composing = false;

  function resetInput() {
    mInput.value = SENTINEL;
    try { mInput.setSelectionRange(1, 1); } catch {}
  }

  // 把输入框里的文字发给终端并清空
  function flushInput() {
    const text = mInput.value.split(SENTINEL).join('');
    if (text) sendKeys(applyMods(text));
    resetInput();
  }

  mInput.addEventListener('focus', () => { if (!mInput.value) resetInput(); });
  mInput.addEventListener('compositionstart', () => { composing = true; });
  // 中文 / 联想输入：上屏后再发送
  mInput.addEventListener('compositionend', () => {
    composing = false;
    flushInput();
  });
  mInput.addEventListener('input', (e) => {
    if (composing || e.isComposing) return;
    if (!mInput.value.includes(SENTINEL) || e.inputType === 'deleteContentBackward') {
      // 哨兵被删掉 = 在空输入框里按了退格
      const rest = mInput.value.split(SENTINEL).join('');
      if (rest) sendKeys(applyMods(rest));
      sendKeys('\x7f');
      resetInput();
      return;
    }
    flushInput();
  });
  $('#mForm').addEventListener('submit', (e) => {
    e.preventDefault();
    composing = false;
    flushInput();
    if (active) beginCapture(active);
    sendKeys('\r');
  });

  // 按钮按下时不抢走输入框焦点，避免键盘收起
  $('#mobileBar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  $('#mobileBar .mkeys').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.a === 'kset') return openKeysEditor();
    if (b.dataset.mod) return setMod(b.dataset.mod, !mods[b.dataset.mod]);
    if (b.dataset.t) return sendKeys(applyMods(b.dataset.t));
    if (b.dataset.seq != null) { clearMods(); return sendKeys(b.dataset.seq); }
    const k = b.dataset.k;
    if (k === 'history') return openHistory();
    if (k === 'copy') return openCopyPanel(active);
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

  function fontToast(s, text) {
    let t = s.box.querySelector('.font-toast');
    if (!t) { t = document.createElement('div'); t.className = 'font-toast'; s.box.appendChild(t); }
    t.textContent = text;
    clearTimeout(t.timer);
    t.timer = setTimeout(() => t.remove(), 800);
  }

  function updateMobileBar() {
    $('#mobileBar').classList.toggle('hidden', !(isTouch && active));
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
      row.className = 'hrow';
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

  // 只为「当前标签 + 面板打开 + 已连接」的会话采集，其他暂停
  function syncMonitor(s) {
    const m = s.mon;
    if (!m) return;
    const want = m.open && s === active && !!s.sid && !s.closed;
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

  // ------------------------------------------------------------ 侧边栏
  const mobile = () => window.innerWidth <= 760;
  $('#btnToggle').addEventListener('click', () => {
    if (mobile()) app.classList.toggle('side-open');
    else app.classList.toggle('side-closed');
    setTimeout(() => active && active.fit.fit(), 50);
  });
  function closeSidebarOnMobile() { if (mobile()) app.classList.remove('side-open'); }
  $('#terms').addEventListener('click', closeSidebarOnMobile);

  applyTheme();
  renderKeyBar();
  setFontSize(fontSize, false);
  initPush();
  init().catch((e) => alert('初始化失败: ' + e.message));
})();
