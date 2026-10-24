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

  // ------------------------------------------------------------ GPU 渲染 (WebGL)
  // 整屏重画的程序 (Claude Code / top 等) 更流畅、更省电。只给当前标签启用：
  // 隐藏的标签本来就不绘制，且浏览器同时能用的 WebGL 数量有限。
  // 不支持 WebGL 或 GPU 上下文丢失 (手机切到后台时可能发生) 时退回默认渲染，回到前台再启用
  // 先检测再加载：插件在不支持的浏览器上加载失败时会残留在终端里，导致触摸滚动失效
  const webglSupported = (() => {
    try { return !!window.WebglAddon && !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
  })();
  let webglFails = webglSupported ? 0 : 3;
  let webglOkTimer = 0;

  function enableWebgl(s) {
    if (s.webgl || s.closed || webglFails >= 3) return;
    const addon = new WebglAddon.WebglAddon();
    try {
      // 切到后台、锁屏时浏览器回收 GPU 上下文是正常的，不算失败 (以前锁屏三次以后这个页面就再也不用 WebGL 了，只能刷新)；
      // 在前台用着时丢的才算，正常用一段时间后清零
      addon.onContextLoss(() => {
        if (!document.hidden) webglFails++;
        disableWebgl(s);
      });
      clearTimeout(webglOkTimer);
      webglOkTimer = setTimeout(() => { if (s.webgl === addon && webglFails < 3) webglFails = 0; }, 10 * 60 * 1000);
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
    s.title = `${s.baseTitle}-${s.suffix || n}`;
    $('.title', s.tab).textContent = s.title;
    s.tab.title = s.title;
    if (active === s) document.title = `${s.title} - SSH-WEB`;
  }

  // 给标签命名 (入口见 70-tabs-shortcuts.js 的「命名标签」，服务端 session/index.js 的 rename)：
  // 主机名称保留，只改「主机名-」后面显示的部分；空 = 恢复按序号显示。主机设置、历史命令按主机的过滤都不受影响
  function applyTabSuffix(s, suffix) {
    suffix = String(suffix || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (s.suffix === suffix) return;
    s.suffix = suffix;
    s.title = `${s.baseTitle}-${suffix || s.n}`;
    $('.title', s.tab).textContent = s.title;
    s.tab.title = s.srvState ? (s.srvState.detail ? `${s.title}\n${s.srvState.label}：${s.srvState.detail}` : s.title) : s.title;
    if (active === s) document.title = `${s.title} - SSH-WEB`;
    renderDeskTabs(); // 状态卡片上的标签名跟着变
  }

  // 用户命了名：本地先改，再告诉服务端 (所有设备上的这个标签、刷新后的恢复、常驻会话都记新名字)。
  // ws 断着时走 HTTP；还没有会话 id (正在连) 就只改本地，连上时 connect 消息自己会带上
  function renameTab(s, suffix) {
    applyTabSuffix(s, suffix);
    if (!s.remoteId) return;
    s.pendingSuffix = suffix; // 命名时断线没送到的话，重新连上 (attached) 时补发
    if (s.ws && s.ws.readyState === WebSocket.OPEN) send(s, { type: 'rename', suffix });
    else api('POST', `/api/sessions/${s.remoteId}/rename`, { suffix }).then(() => { s.pendingSuffix = null; }).catch(() => {});
  }

  // 属于某个标签的弹层 (文件预览、端口预览、会话历史、钩子通知、历史命令、复制文本，带 .tab-panel 和 data-tab)：
  // 手机上同性能监控，只占标签栏到快捷键之间 (位置见 termsBox)，切到别的标签时藏起来、切回来再显示
  function tabPanels() {
    document.querySelectorAll('.tab-panel').forEach((o) => o.classList.toggle('tab-away', !!o.dataset.tab && o.dataset.tab !== active?.id));
  }
  // 终端区域 (标签栏下面到快捷键上面) 的位置记到 CSS 变量里：手机上的右边栏、上面那些弹层都放在这里 (键盘弹出、转屏跟着变)
  function termsBox() {
    const r = $('#terms').getBoundingClientRect();
    document.documentElement.style.setProperty('--terms-top', Math.round(r.top) + 'px');
    document.documentElement.style.setProperty('--terms-h', Math.round(r.height) + 'px');
  }
  new ResizeObserver(termsBox).observe($('#terms'));
  addEventListener('resize', termsBox);
  window.visualViewport?.addEventListener('resize', termsBox);
  window.visualViewport?.addEventListener('scroll', termsBox);

  // 切标签不接管：这个标签别的设备在用就锁着 (镜像显示)，点「在本机继续」才接管 (见 42-owner.js)
  function activate(s) {
    const prev = active;
    active = s;
    s.shown = true;
    // 还没看过的后台标签 (只收了状态，见 10-session.js)：现在要画面
    if (s.lite && s.ws?.readyState === WebSocket.OPEN) { s.lite = false; send(s, { type: 'sync', offset: s.offset }); }
    sessions.forEach((x) => {
      x.el.classList.toggle('active', x === s);
      x.tab.classList.toggle('active', x === s);
      if (x !== s) disableWebgl(x);
    });
    enableWebgl(s);
    requestAnimationFrame(() => { syncSize(s); focusTerm(s); });
    // 刚显示出来的标签：手机上有时只画出一部分 (要点一下输入框再收起键盘才完整)，切过来后照那样重新量一遍、整屏重画；
    // 新建的 WebGL 渲染器的字形缓存也清掉重画 (藏起来时量的字宽可能不对)
    if (prev !== s) {
      const redraw = () => {
        if (active !== s) return;
        if (s.webgl) try { s.term.clearTextureAtlas(); } catch {}
        relayout();
      };
      setTimeout(redraw, 100);
      setTimeout(redraw, 400);
    }
    revealTab(s.tab);
    tabPanels();
    s.tab.classList.remove('ring');
    updateSftpBtn();
    updateMobileBar();
    measureRtt();
    saveActive();
    reportWatching();
    document.title = active ? `${active.title} - SSH-WEB` : 'SSH-WEB';
  }

  // remote: 会话已在服务端结束 (其他设备关闭)，只移除本地标签；kill：接着的常驻会话也结束 (见 42-owner.js 的 askClose)
  function closeSession(s, remote, kill) {
    s.closed = true;
    if (s.pred) predClear(s);
    clearInterval(s.ping);
    clearTimeout(s.retryTimer);
    if (s.mon) clearTimeout(s.mon.timer);
    // 结束后台会话 (断开 SSH)
    if (!remote && s.remoteId) {
      if (s.ws && s.ws.readyState === WebSocket.OPEN) send(s, { type: 'close', ...(kill && { kill: true }) });
      else api('DELETE', '/api/sessions/' + s.remoteId).catch(() => {});
    }
    try { s.ws && s.ws.close(); } catch {}
    s.ro.disconnect();
    for (const off of s.offs || []) try { off(); } catch {} // 挂在 window / document 上的监听 (见 10-session.js 的复制)
    // 属于这个标签的弹层 (历史、会话历史、钩子、文件预览、端口预览、复制文本)：标签没了也一起关掉 (各自的关闭函数，连 Esc 监听一起摘掉)，
    // 不留在页面里挡快捷键
    for (const [sel, close] of [['.fpreview', () => closePreview()], ['.fwd', () => closeForward()], ['.hooksp', () => closeHooks()],
      ['.agentsp', () => closeAgentSessions()], ['#history', () => $('#history').classList.add('hidden')], ['#copyPanel', () => closeCopyPanel()]]) {
      const o = document.querySelector(sel);
      if (o && o.dataset.tab === s.id) try { close(); } catch {}
    }
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

