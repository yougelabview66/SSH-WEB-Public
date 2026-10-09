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
  $('.vb-reload', verBar).addEventListener('click', () => location.reload());
  $('.vb-close', verBar).addEventListener('click', () => { verDismissed = verBar.dataset.v; verBar.classList.add('hidden'); });
  verEl.addEventListener('click', () => { if (verEl.classList.contains('old')) location.reload(); });
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

  // claim：切到这个标签 = 在这台设备上用它，终端按这台设备的屏幕排版，其他设备上显示「正在 xx 上使用」(见 42-owner.js)。
  // 弹出主机密钥 / 验证码对话框时自动切过去的不算 (每台设备都会弹，不然谁都抢)；刚打开页面恢复标签时按 10-session.js 的规则
  function activate(s, claim = true) {
    const prev = active;
    active = s;
    sessions.forEach((x) => {
      x.el.classList.toggle('active', x === s);
      x.tab.classList.toggle('active', x === s);
      if (x !== s) disableWebgl(x);
    });
    enableWebgl(s);
    claim = claim && !!prev && prev !== s && !document.hidden;
    requestAnimationFrame(() => { syncSize(s, claim); focusTerm(s); });
    revealTab(s.tab);
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
    if (s.pred) predClear(s);
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
    if (s.remoteId && (floatLift[s.remoteId] != null || deskModes[s.remoteId] || deskHs[s.remoteId])) { // 这个标签记的输入框模式 / 位置 / 高度不再需要
      delete floatLift[s.remoteId];
      delete deskModes[s.remoteId];
      delete deskHs[s.remoteId];
      saveDeskPos();
    }
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

