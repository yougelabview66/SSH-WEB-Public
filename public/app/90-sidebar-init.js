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
