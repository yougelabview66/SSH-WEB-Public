  // ------------------------------------------------------------ 标签：编号、改名、切换、关闭
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
  // ws 断着时走 HTTP；还没有会话 id (正在连) 就只改本地，连上时 connect 消息带上 / attached 时补发。
  // 送到之前一直记着 (pendingSuffix)：不然连上时会被服务端那边的旧名字改回去
  function renameTab(s, suffix) {
    applyTabSuffix(s, suffix);
    s.pendingSuffix = suffix; // 命名时断线没送到的话，重新连上 (attached) 时补发
    if (!s.remoteId) return;
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
    // 新旧连接正在比 (见 10-session.js 的 raceTab)：比完再要 (raceWin)，不然这时的 offset 可能对不上赢的那条
    if (s.lite && !s.race && s.ws?.readyState === WebSocket.OPEN) { s.lite = false; send(s, { type: 'sync', offset: s.offset }); }
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
    clearTimeout(s.replyTimer);
    endRace(s); // 新旧连接正在比：不比了，关标签的消息直接发在现在这条上
    clearTimeout(s.connHintTimer);
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

