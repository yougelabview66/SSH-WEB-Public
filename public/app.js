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
    if (me.authEnabled && !me.authed) return showLogin();
    $('#btnLogout').classList.toggle('hidden', !me.authEnabled);
    boot();
  }

  async function boot() {
    app.classList.remove('hidden');
    await loadHosts();
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
        const label = histHostLabel(h);
        const live = sessions.filter((x) => x.histHost === label && x.sid).length;
        const el = document.createElement('div');
        el.className = 'host' + (active && active.histHost === label ? ' current' : '');
        el.innerHTML = `
          <div class="info"><div class="name"></div><div class="addr"></div></div>
          ${live ? `<span class="live" title="${live} 个已连接的会话"></span>` : ''}
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
          const opened = sessions.find((x) => x.histHost === label);
          if (opened && opened !== active && !e.shiftKey) return activate(opened);
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
  const THEME = {
    background: '#000000', foreground: '#e5e7eb', cursor: '#22c55e',
    selectionBackground: 'rgba(148,163,184,.35)',
  };

  function openSession(params, title, connType) {
    $('#empty').classList.add('hidden');
    const s = { id: Math.random().toString(36).slice(2), params, title, connType };
    const h = params.hostId ? hosts.find((x) => x.id === params.hostId) : params;
    s.histHost = h ? histHostLabel(h) : title;

    s.el = document.createElement('div');
    s.el.className = 'term';
    s.box = document.createElement('div');
    s.box.className = 'term-box';
    s.el.appendChild(s.box);
    $('#terms').appendChild(s.el);

    s.term = new Terminal({
      cursorBlink: true,
      fontSize: window.innerWidth < 760 ? 12 : 14,
      fontFamily: 'ui-monospace, "Cascadia Code", Menlo, Consolas, "DejaVu Sans Mono", monospace',
      theme: THEME,
      scrollback: 10000,
      allowProposedApi: true,
    });
    s.fit = new FitAddon.FitAddon();
    s.term.loadAddon(s.fit);
    s.term.loadAddon(new WebLinksAddon.WebLinksAddon());
    s.term.open(s.box);
    if (isTouch) {
      // 触屏：xterm 的隐藏输入框在手机输入法下会丢字 / 重复，改用底部输入栏
      s.term.textarea.setAttribute('readonly', 'readonly');
      s.term.textarea.addEventListener('focus', () => mInput.focus());
      s.box.addEventListener('click', () => mInput.focus());
    }
    s.ro = new ResizeObserver(() => { if (active === s) s.fit.fit(); });
    s.ro.observe(s.box);
    s.term.onData((data) => {
      if (data === '\r') beginCapture(s);
      send(s, { type: 'data', data });
    });
    s.term.onResize(({ cols, rows }) => send(s, { type: 'resize', cols, rows }));
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
    $('.title', s.tab).textContent = title;
    s.tab.title = title;
    s.tab.addEventListener('click', (e) => {
      if (e.target.classList.contains('x')) closeSession(s);
      else activate(s);
    });
    s.tab.addEventListener('auxclick', (e) => { if (e.button === 1) closeSession(s); });
    $('#tabs').appendChild(s.tab);

    sessions.push(s);
    activate(s);
    connect(s);
  }

  function setStatus(s, st) {
    queueMicrotask(renderHosts);
    const dot = $('.dot', s.tab);
    dot.className = 'dot' + (st === 'ok' ? ' ok' : st === 'bad' ? ' bad' : '');
  }

  function send(s, obj) {
    if (s.ws && s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify(obj));
  }

  function connect(s) {
    s.reconnectBtn?.remove();
    setStatus(s, 'wait');
    s.fit.fit();
    const via = s.connType === 'cloudflare' ? ' (Cloudflare 隧道)' : '';
    s.term.write(`\r\n\x1b[90m正在连接 ${s.title}${via} ...\x1b[0m\r\n`);

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    s.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'connect', ...s.params, cols: s.term.cols, rows: s.term.rows }));
      // 应用层心跳，避免 Cloudflare / 反向代理 100 秒空闲断开
      s.ping = setInterval(() => send(s, { type: 'ping' }), 25000);
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        s.term.write(new Uint8Array(ev.data), () => checkCapture(s));
        return;
      }
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'status' && m.status === 'connected') {
        setStatus(s, 'ok');
        s.sid = m.sid;
        updateSftpBtn();
        if (s.sftp && s.sftp.open) s.sftp.load(s.sftp.path);
        focusTerm(s);
      } else if (m.type === 'hostkey') {
        activate(s);
        hostkeyDialog(m).then((accept) => send(s, { type: 'hostkey-response', accept }));
      } else if (m.type === 'prompt') {
        activate(s);
        promptDialog(m).then((answers) =>
          send(s, answers ? { type: 'prompt-response', answers } : { type: 'prompt-response', cancel: true }));
      } else if (m.type === 'fingerprint') {
        s.term.write(`\x1b[90m主机指纹: ${m.value}\x1b[0m\r\n`);
      } else if (m.type === 'info') {
        s.term.write(`\x1b[90m${m.message}\x1b[0m\r\n`);
      } else if (m.type === 'error') {
        s.term.write(`\r\n\x1b[31m✖ ${m.message}\x1b[0m\r\n`);
        setStatus(s, 'bad');
      }
    };
    ws.onclose = () => {
      clearInterval(s.ping);
      if (s.closed) return;
      s.sid = null;
      updateSftpBtn();
      setStatus(s, 'bad');
      s.term.write('\r\n\x1b[33m连接已断开\x1b[0m\r\n');
      showReconnect(s);
    };
  }

  function showReconnect(s) {
    if (s.reconnectBtn) return;
    const b = document.createElement('button');
    b.className = 'primary reconnect';
    b.textContent = '重新连接';
    b.onclick = () => connect(s);
    s.box.appendChild(b);
    s.reconnectBtn = b;
  }

  function activate(s) {
    active = s;
    sessions.forEach((x) => {
      x.el.classList.toggle('active', x === s);
      x.tab.classList.toggle('active', x === s);
    });
    requestAnimationFrame(() => { s.fit.fit(); focusTerm(s); });
    s.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    updateSftpBtn();
    updateMobileBar();
    renderHosts();
    document.title = active ? `${active.title} - SSH-WEB` : 'SSH-WEB';
  }

  function closeSession(s) {
    s.closed = true;
    clearInterval(s.ping);
    try { s.ws && s.ws.close(); } catch {}
    s.ro.disconnect();
    s.term.dispose();
    s.el.remove();
    s.tab.remove();
    sessions.splice(sessions.indexOf(s), 1);
    if (active === s) {
      active = null;
      if (sessions.length) activate(sessions[sessions.length - 1]);
      else $('#empty').classList.remove('hidden');
    }
    updateSftpBtn();
    updateMobileBar();
    renderHosts();
    document.title = active ? `${active.title} - SSH-WEB` : 'SSH-WEB';
  }

  window.addEventListener('beforeunload', (e) => {
    if (sessions.some((s) => s.ws && s.ws.readyState === WebSocket.OPEN)) e.preventDefault();
  });

  // ------------------------------------------------------------ 通用对话框
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let dialogQueue = Promise.resolve();

  // buttons: [{ label, value, cls, submit }]，返回 { value, form }
  function dialog(title, html, buttons) {
    const run = () => new Promise((resolve) => {
      const dlg = $('#dialog');
      const f = $('#dialogForm');
      $('#dialogTitle').textContent = title;
      $('#dialogBody').innerHTML = html;
      const acts = $('#dialogActions');
      acts.innerHTML = '';
      const finish = (value) => {
        dlg.classList.add('hidden');
        f.onsubmit = null;
        document.removeEventListener('keydown', onKey, true);
        resolve({ value, form: f });
      };
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
  async function promptDialog(m) {
    let html = '';
    if (m.instructions) html += `<p class="muted">${esc(m.instructions)}</p>`;
    m.prompts.forEach((pr, i) => {
      const isCode = /code|otp|token|verif|验证/i.test(pr.prompt);
      html += `<label>${esc(pr.prompt)}<input name="a${i}" type="${pr.echo ? 'text' : 'password'}" autocomplete="${isCode ? 'one-time-code' : 'off'}"${isCode ? ' inputmode="numeric"' : ''}></label>`;
    });
    const r = await dialog(m.title || '服务器要求验证', html, [
      { label: '取消', value: false, cancel: true },
      { label: '确定', value: true, cls: 'primary', submit: true },
    ]);
    if (!r.value) return null;
    return m.prompts.map((_, i) => r.form.elements['a' + i].value);
  }

  // 主机指纹确认
  async function hostkeyDialog(m) {
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
    const r = await dialog(m.status === 'changed' ? '主机指纹不匹配' : '确认主机指纹', html, buttons);
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
  const mods = { ctrl: false, alt: false };

  function focusTerm(s) {
    if (!isTouch) s.term.focus();
  }

  function sendKeys(data) {
    if (active) send(active, { type: 'data', data });
  }

  // 应用 Ctrl / Alt 修饰键 (一次性，用完自动取消)
  function applyMods(text) {
    if (!mods.ctrl && !mods.alt) return text;
    let out = text;
    if (mods.ctrl && text.length === 1) {
      const c = text.toUpperCase().charCodeAt(0);
      if (c >= 64 && c <= 95) out = String.fromCharCode(c - 64); // Ctrl+A..Z [ \ ] ^ _
      else if (text === ' ') out = '\x00';
      else if (text === '?') out = '\x7f';
    }
    if (mods.alt) out = '\x1b' + out;
    setMod('ctrl', false);
    setMod('alt', false);
    return out;
  }

  function setMod(name, on) {
    mods[name] = on;
    $(`#mobileBar [data-mod=${name}]`).classList.toggle('on', on);
  }

  const cursorKey = (c) => (active && active.term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + c;
  const KEYS = {
    esc: () => '\x1b', tab: () => '\t', bs: () => '\x7f',
    up: () => cursorKey('A'), down: () => cursorKey('B'), right: () => cursorKey('C'), left: () => cursorKey('D'),
    home: () => '\x1b[H', end: () => '\x1b[F', pgup: () => '\x1b[5~', pgdn: () => '\x1b[6~',
    '^c': () => '\x03', '^d': () => '\x04', '^z': () => '\x1a', '^l': () => '\x0c',
  };

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
    if (b.dataset.mod) return setMod(b.dataset.mod, !mods[b.dataset.mod]);
    if (b.dataset.t) return sendKeys(applyMods(b.dataset.t));
    const k = b.dataset.k;
    if (k === 'history') return openHistory();
    if (k === 'paste') {
      let text = '';
      try { text = await navigator.clipboard.readText(); } catch {}
      if (!text) text = prompt('粘贴内容（浏览器不允许直接读取剪贴板时在这里粘贴）：') || '';
      if (text) sendKeys(text);
      return;
    }
    if (KEYS[k]) sendKeys(applyMods(KEYS[k]()));
  });

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
    $('#histAll').checked = !active;
    $('#histList').innerHTML = '<div class="sftp-msg">加载中…</div>';
    try {
      histItems = await api('GET', '/api/history');
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

  function visibleHistory() {
    const q = $('#histSearch').value.trim().toLowerCase();
    const all = $('#histAll').checked || !active;
    return histItems.filter((h) => (all || h.host === active.histHost) && (!q || h.cmd.toLowerCase().includes(q)));
  }

  function renderHistory() {
    const list = $('#histList');
    const items = visibleHistory();
    const all = $('#histAll').checked || !active;
    $('#histClear').textContent = all ? '清空全部' : '清空本主机';
    $('#histClear').disabled = !items.length;
    list.innerHTML = '';
    if (!items.length) {
      list.innerHTML = '<div class="sftp-msg">暂无历史命令<br><span class="hint">在终端里执行过的命令会记录在这里</span></div>';
      return;
    }
    items.forEach((h) => {
      const row = document.createElement('div');
      row.className = 'hrow';
      row.innerHTML = `<div class="hmain" title="点击执行"><div class="cmd"></div><div class="hmeta"></div></div>
        <button data-op="fill" title="填入终端，不执行">填入</button>
        <button data-op="run" class="primary" title="执行">执行</button>
        <button data-op="del" class="del" title="删除">✕</button>`;
      $('.cmd', row).textContent = h.cmd;
      $('.hmeta', row).textContent = [all ? h.host : '', fmtAgo(h.time), h.count > 1 ? `${h.count} 次` : '']
        .filter(Boolean).join(' · ');
      row.addEventListener('click', async (e) => {
        const op = e.target.dataset.op || (e.target.closest('.hmain') ? 'run' : '');
        if (op === 'del') {
          try {
            await api('DELETE', '/api/history/' + h.id);
            histItems = histItems.filter((x) => x.id !== h.id);
            renderHistory();
          } catch (err) { alert(err.message); }
          return;
        }
        if (!op || !active || !active.sid) return;
        closeHistory();
        if (op === 'run') {
          sendKeys(h.cmd);
          // 等命令回显后再回车，这样也会被记录 (次数 +1、移到最前)
          setTimeout(() => { beginCapture(active); sendKeys('\r'); }, 50);
        } else {
          sendKeys(h.cmd);
        }
      });
      list.appendChild(row);
    });
  }

  $('#btnHistory').addEventListener('click', openHistory);
  $('#histClose').addEventListener('click', closeHistory);
  $('#histSearch').addEventListener('input', renderHistory);
  $('#histAll').addEventListener('change', renderHistory);
  histPanel.addEventListener('mousedown', (e) => { if (e.target === histPanel) closeHistory(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !histPanel.classList.contains('hidden')) closeHistory();
  });
  $('#histClear').addEventListener('click', async () => {
    const all = $('#histAll').checked || !active;
    if (!confirm(all ? '清空所有主机的历史命令？' : `清空 ${active.histHost} 的历史命令？`)) return;
    try {
      await api('DELETE', '/api/history' + (all ? '' : '?host=' + encodeURIComponent(active.histHost)));
      histItems = all ? [] : histItems.filter((h) => h.host !== active.histHost);
      renderHistory();
    } catch (err) { alert(err.message); }
  });

  // ------------------------------------------------------------ 侧边栏
  const mobile = () => window.innerWidth <= 760;
  $('#btnToggle').addEventListener('click', () => {
    if (mobile()) app.classList.toggle('side-open');
    else app.classList.toggle('side-closed');
    setTimeout(() => active && active.fit.fit(), 50);
  });
  function closeSidebarOnMobile() { if (mobile()) app.classList.remove('side-open'); }
  $('#terms').addEventListener('click', closeSidebarOnMobile);

  init().catch((e) => alert('初始化失败: ' + e.message));
})();
