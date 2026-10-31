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
      if (m.type === 'version') checkVersion(m.version);
      else if (m.type === 'session-created') addRemoteTab(m.session);
      else if (m.type === 'order') applyTabOrder(m.ids);
      else if (m.type === 'hosts') loadHosts().catch(() => {}); // 主机信息变了 (比如连上后认出了系统)：重新读主机列表
    };
    ws.onclose = () => {
      clearInterval(ping);
      if (eventsWs !== ws) return;
      eventsTimer = setTimeout(startEvents, Math.min(1000 * 2 ** eventsRetry++, 10000));
    };
  }

  // 服务器版本和这个网页不一样 (服务器更新重启了，网页还是旧的)：顶部提醒刷新，侧边栏的版本号变红；
  // 不自动刷新 (可能正在打字)；点 × 后同一个新版本不再提醒
  const PAGE_VERSION = document.querySelector('meta[name=sshweb-version]')?.content || '';
  const verBar = $('#verBar'), verEl = $('.sidebar-foot .ver');
  let verDismissed = '';
  function checkVersion(v) {
    if (!v || !PAGE_VERSION) return;
    const old = v !== PAGE_VERSION;
    verEl.classList.toggle('old', old);
    verEl.textContent = old ? `SSH-WEB v${PAGE_VERSION} → v${v}` : `SSH-WEB v${PAGE_VERSION}`;
    verEl.title = old ? `服务器已经是 v${v}，点击刷新页面` : '网页的版本';
    $('.vb-text', verBar).textContent = `服务器已更新到 v${v}（这个页面还是 v${PAGE_VERSION}），刷新后生效`;
    verBar.dataset.v = v;
    verBar.classList.toggle('hidden', !old || verDismissed === v);
  }
  // 版本更新提示的「刷新页面」、红色版本号、侧边栏「清缓存刷新」都是清缓存再刷新 (见 hardReload)
  $('.vb-reload', verBar).addEventListener('click', (e) => hardReload(e.currentTarget));
  $('.vb-close', verBar).addEventListener('click', () => { verDismissed = verBar.dataset.v; verBar.classList.add('hidden'); });
  verEl.addEventListener('click', () => { if (verEl.classList.contains('old')) hardReload($('#btnHardReload')); });
  $('#btnHardReload').addEventListener('click', (e) => hardReload(e.currentTarget));
  // 清缓存强制刷新：网页和它用到的文件都绕过浏览器缓存重新下载一遍 (写回缓存)，清掉 Cache Storage、
  // 让 Service Worker 检查更新，再刷新。不注销 Service Worker (注销了推送订阅也没了)。b：点的按钮 (显示「正在刷新…」)
  let reloading = false;
  async function hardReload(b) {
    if (reloading) return;
    reloading = true;
    if (b) {
      b.disabled = true;
      const t = $('span', b) || b;
      t.textContent = '正在刷新…'; // 侧边栏的按钮：图标转起来 (style.css)
    }
    const urls = [location.pathname, ...[...document.querySelectorAll('script[src], link[rel=stylesheet][href], link[rel=manifest]')]
      .map((x) => new URL(x.src || x.href, location.href)).filter((u) => u.origin === location.origin).map((u) => u.pathname + u.search)];
    const jobs = urls.map((u) => fetch(u, { cache: 'reload', credentials: 'same-origin' }).catch(() => {}));
    if (window.caches) jobs.push(caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))).catch(() => {}));
    if (navigator.serviceWorker) jobs.push(navigator.serviceWorker.getRegistrations().then((rs) => Promise.all(rs.map((r) => r.update()))).catch(() => {}));
    await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, 8000))]); // 网络卡住也照样刷新
    location.reload();
  }
  // 保险：事件连接可能「假死」(以为还连着，其实服务器已经重启过) 收不到版本号，
  // 所以回到前台 / 窗口重新获得焦点 (最多 20 秒一次) / 网络恢复时，以及每 5 分钟，再主动问一次
  let verPolledAt = 0;
  async function pollVersion() {
    verPolledAt = Date.now();
    try { checkVersion((await api('GET', '/api/me')).version); } catch {}
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollVersion(); });
  window.addEventListener('focus', () => { if (Date.now() - verPolledAt > 20000) pollVersion(); });
  window.addEventListener('online', pollVersion);
  setInterval(() => { if (!document.hidden) pollVersion(); }, 5 * 60 * 1000);

  // 页面回到前台时立即重连 (手机锁屏期间连接可能已断)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && eventsWs && eventsWs.readyState > WebSocket.OPEN) startEvents();
  });

  function addRemoteTab(info) {
    if (!info) return;
    const cur = sessions.find((x) => x.remoteId === info.id);
    if (cur) {
      // 标签已经开着：可能在别的设备上命过名 (这边连接 / 事件断着没收到)，对账时跟过来
      if ((info.suffix || '') !== cur.suffix && cur.pendingSuffix == null) applyTabSuffix(cur, info.suffix || '');
      return;
    }
    const s = openSession(info.params || {}, info.title, info.connType, info);
    if (!active) activate(s);
  }

  // 和服务端对账，标签以服务端为准：补上别的设备新开的，关掉服务端已经没有的 (服务重启过、事件连接断开期间被关掉)
  async function syncTabs() {
    const known = new Set(sessions.map((x) => x.remoteId).filter(Boolean)); // 问之前就有的，问的途中刚建好的不算
    let list;
    try { list = await api('GET', '/api/sessions'); } catch { return; } // 没问到 (断网 / 登录过期) 不能当成一个都没有
    // 本页正在新建的标签 (还没有会话 id、也没出错) 还不知道自己的会话 id，稍后再对账，避免重复
    if (sessions.some((x) => !x.remoteId && !x.reconnectBtn)) { setTimeout(syncTabs, 1500); return; }
    const ids = new Set(list.map((x) => x.id));
    sessions.filter((x) => known.has(x.remoteId) && !ids.has(x.remoteId)).forEach((x) => closeSession(x, true));
    list.forEach(addRemoteTab);
    applyTabOrder(list.map((x) => x.id));
  }

  function applyTabOrder(ids) {
    if (drag) return; // 本地正在拖动
    const pos = (x) => { const i = ids.indexOf(x.remoteId); return i < 0 ? Infinity : i; };
    sessions.sort((a, b) => pos(a) - pos(b));
    sessions.forEach((x) => tabsEl.appendChild(x.tab));
  }
