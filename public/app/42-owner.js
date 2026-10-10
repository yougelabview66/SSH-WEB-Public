  // ------------------------------------------------------------ 一个标签同一时间只有一台设备在用，其他设备锁住
  // 谁在用 (使用者)：最后连上的设备 —— 打开 / 刷新页面、页面在前台时断线重连、切到这个标签、点「在本机继续」、
  // 点「重新连接」。终端按它的屏幕排版 (见 lib/session/size.js)。
  // 其他设备锁住：终端上盖一层「正在 xx 上使用 · 在本机继续」，打字、按键、发送都不发出去 (下方输入框里打的字留着，
  // 接管后按回车再发)，免得两边同时输入、或者忘在一边的设备误触。使用者关掉页面 / 锁屏断线了也一直锁着
  // (提示改成「xx 已断开」)，点一下就接管
  function updateOwnerNotice(s, device, online) {
    if (s.mine !== false) {
      s.ownerNotice?.remove();
      s.ownerNotice = null;
      return;
    }
    if (!s.ownerNotice) {
      const el = document.createElement('div');
      el.className = 'owner-notice';
      el.innerHTML = '<div class="owner-card"><div class="owner-title"></div>'
        + '<div class="owner-sub">这里的排版按那台设备的屏幕排，也不能输入</div><button class="primary" type="button">在本机继续</button></div>';
      el.addEventListener('mousedown', (e) => e.preventDefault()); // 不抢走下方输入框的焦点
      el.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true }); // 不当成滑动终端
      el.addEventListener('click', (e) => {
        e.stopPropagation(); // 不让终端的点击处理再把光标拉到输入栏 (手机上会弹出键盘)
        claimSize(s);
      });
      s.box.appendChild(el);
      s.ownerNotice = el;
    }
    const name = device || '另一台设备';
    s.ownerNotice.querySelector('.owner-title').textContent = online === false ? `${name}已断开 (锁屏或关了页面)` : `正在${name}上使用`;
  }

  // 这个标签被别的设备锁住了：输入不发出去，晃一下提示，告诉怎么接管
  function inputLocked(s) {
    if (!s || s.mine !== false || !s.ownerNotice) return false;
    const el = s.ownerNotice;
    el.classList.remove('nudge');
    void el.offsetWidth; // 连按时重新播放动画
    el.classList.add('nudge');
    return true;
  }

  // 在本机继续：按这台设备的尺寸排版
  function claimSize(s) {
    if (!s.box.clientWidth) return;
    if (!s.scrollView) s.fit.fit();
    send(s, { type: 'resize', cols: s.term.cols, rows: s.term.rows, claim: true });
    // 光标去哪同点终端：终端的输入框里有没发送的字 (任何设备上打的都算) 时留在终端，方便接着改
    if (!isTouch && deskOn && s.cli.locked()) s.term.focus();
    else focusTerm(s);
  }

  // 页面是在后台打开的 (比如浏览器恢复上次的标签)：那时不抢排版，等切过来看它时再按这台设备排版
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    for (const s of sessions) if (s.claimOnShow) { s.claimOnShow = false; claimSize(s); }
  });
