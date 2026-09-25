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
    showEmpty('loading');
    // 主机列表与后台会话同时加载，尽快恢复标签
    const [list] = await Promise.all([fetchSessions(), loadHosts().catch(() => {})]);
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
  const THEME = {
    background: '#000000', foreground: '#e5e7eb', cursor: '#22c55e',
    selectionBackground: 'rgba(148,163,184,.35)',
  };

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
    enableTouchScroll(s);
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
    if (s.ws && s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify(obj));
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
    updateSftpBtn();
    updateMobileBar();
    saveActive();
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
    $(`#mobileBar [data-mod=${name}]`).classList.toggle('on', on);
  }

  // xterm 修饰键参数: 1 + Shift(1) + Alt(2) + Ctrl(4)
  const modParam = () => 1 + (mods.shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
  const CURSOR = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' };
  const TILDE = { pgup: 5, pgdn: 6 };

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
    } else {
      out = { '^c': '\x03', '^d': '\x04', '^z': '\x1a', '^l': '\x0c' }[k];
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
    const seq = keySeq(k);
    if (seq) sendKeys(seq);
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

  // ------------------------------------------------------------ 触屏滑动滚动
  // xterm.js 6 不支持触摸滚动，手指滑动会被浏览器当成下拉刷新。这里自己处理，行为与电脑滚轮一致：
  // - 程序开启了鼠标追踪 (Claude Code、tmux、htop、vim mouse=a 等)：发送鼠标滚轮事件，由程序自己滚动
  // - 普通界面：滚动终端的历史记录 (带惯性)
  // - 不支持鼠标的全屏程序：不发送任何按键，避免误触发 (比如方向键会调出历史输入)
  function enableTouchScroll(s) {
    let lastY = null;
    let lastX = 0;
    let lastT = 0;
    let vel = 0; // px/ms
    let acc = 0; // 不足一行的累计像素
    let raf = 0;

    const lineHeight = () => {
      const row = s.box.querySelector('.xterm-rows > div');
      return (row && row.offsetHeight) || 17;
    };

    // 交给 xterm 按滚轮处理，它会按程序要求的鼠标协议 (SGR 等) 编码发送
    const wheel = (lines) => {
      const target = s.term.element.querySelector('.xterm-screen') || s.term.element;
      const r = target.getBoundingClientRect();
      const x = Math.min(Math.max(lastX, r.left + 1), r.right - 1);
      const y = r.top + r.height / 2;
      for (let i = 0; i < Math.min(Math.abs(lines), 10); i++) {
        target.dispatchEvent(new WheelEvent('wheel', {
          deltaY: lines > 0 ? -1 : 1, deltaMode: WheelEvent.DOM_DELTA_LINE,
          clientX: x, clientY: y, bubbles: true, cancelable: true,
        }));
      }
    };

    const scrollPx = (dy) => {
      acc += dy;
      const lh = lineHeight();
      const lines = Math.trunc(acc / lh);
      if (!lines) return;
      acc -= lines * lh;
      // lines > 0: 手指下滑 = 往回看
      if (s.term.modes.mouseTrackingMode !== 'none') wheel(lines);
      else if (s.term.buffer.active.type === 'normal') s.term.scrollLines(-lines);
    };

    const momentum = () => {
      if (Math.abs(vel) < 0.05) return;
      scrollPx(vel * 16);
      vel *= 0.95;
      raf = requestAnimationFrame(momentum);
    };

    s.box.addEventListener('touchstart', (e) => {
      cancelAnimationFrame(raf);
      if (e.touches.length !== 1) { lastY = null; return; }
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
      vel = 0.8 * (dy / Math.max(now - lastT, 1)) + 0.2 * vel;
      lastY = y;
      lastT = now;
      scrollPx(dy);
    }, { passive: false });

    s.box.addEventListener('touchend', () => {
      if (lastY == null) return;
      lastY = null;
      // 停顿后再松手不需要惯性
      if (performance.now() - lastT > 80) vel = 0;
      raf = requestAnimationFrame(momentum);
    }, { passive: true });
  }

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
      ctx.strokeStyle = 'rgba(148,163,184,.15)';
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
      ctx.strokeStyle = 'rgba(226,232,240,.4)';
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

  init().catch((e) => alert('初始化失败: ' + e.message));
})();
