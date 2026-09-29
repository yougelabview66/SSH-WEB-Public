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

