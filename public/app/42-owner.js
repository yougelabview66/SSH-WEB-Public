  // ------------------------------------------------------------ 别的设备正在用这个会话
  // 终端按使用者 (最新打开 / 刷新页面的设备) 的尺寸排版 (见 lib/session/size.js)。其他设备上盖一层提示：
  // 这里的排版是按那台设备的屏幕排的，可能是乱的；点一下在本机继续 (换成按这台设备排版)，在这里打字发送也一样
  function updateOwnerNotice(s, device) {
    if (s.mine !== false || s.ownerGone) {
      s.ownerNotice?.remove();
      s.ownerNotice = null;
      return;
    }
    if (!s.ownerNotice) {
      const el = document.createElement('div');
      el.className = 'owner-notice';
      el.innerHTML = '<div class="owner-card"><div class="owner-title"></div>'
        + '<div class="owner-sub">这里的排版是按那台设备的屏幕排的</div><button class="primary" type="button">在本机继续</button></div>';
      el.addEventListener('mousedown', (e) => e.preventDefault()); // 不抢走下方输入框的焦点
      el.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true }); // 不当成滑动终端
      el.addEventListener('click', (e) => {
        e.stopPropagation(); // 不让终端的点击处理再把光标拉到输入栏 (手机上会弹出键盘)
        claimSize(s);
      });
      s.box.appendChild(el);
      s.ownerNotice = el;
    }
    s.ownerNotice.querySelector('.owner-title').textContent = `正在${device || '另一台设备'}上使用`;
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
