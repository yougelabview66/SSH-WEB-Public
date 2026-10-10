  // ------------------------------------------------------------ 一个标签同一时间只有一台设备在用，其他设备锁住
  // 最先用的客户端锁定这个标签 (规则见 lib/session/size.js)：别的设备打开 / 切到这个标签都锁着，
  // 只有点弹窗里的「在本机继续」才接管；使用者关掉页面 / 断线了也一直锁着 (弹窗提示「xx 已断开」)。
  // 锁住的一端：镜像 —— 终端按使用者的行列排、整体缩放放进来，看到的和它一模一样 (不会折乱)，能看进度；
  // 终端中间一个弹窗「正在 xx 上使用 · 在本机继续」。打字、按键、发送都不发出去 (下方输入框里打的字留着，接管后回车再发)
  function updateOwnerNotice(s, m = {}) {
    s.box.classList.toggle('mirror', s.mine === false);
    if (s.mine !== false) {
      s.ownerNotice?.remove();
      s.ownerNotice = null;
      return;
    }
    if (!s.ownerNotice) {
      const el = document.createElement('div');
      el.className = 'owner-notice';
      el.innerHTML = '<div class="owner-title"></div><button class="primary" type="button">在本机继续</button>';
      el.addEventListener('mousedown', (e) => e.preventDefault()); // 不抢走下方输入框的焦点
      el.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true }); // 不当成滑动终端
      el.addEventListener('click', (e) => {
        e.stopPropagation(); // 不让终端的点击处理再把光标拉到输入栏 (手机上会弹出键盘)
        claimSize(s);
      });
      s.box.appendChild(el);
      s.ownerNotice = el;
    }
    const name = m.device || '另一台设备';
    s.ownerNotice.querySelector('.owner-title').textContent = m.online === false ? `${name}已断开` : `正在${name}上使用`;
  }

  // 镜像显示：锁住时终端按使用者的行列排，整体缩小放进这台设备的终端区域；没锁住时照常按本机屏幕排 (rawFit)
  function mirrorFit(s, rawFit) {
    const el = s.term.element;
    const m = s.srvSize;
    if (s.mine !== false || !m?.cols || !el) {
      if (el?.style.transform) { el.style.transform = ''; el.style.width = ''; el.style.height = ''; }
      return rawFit();
    }
    if (s.term.cols !== m.cols || s.term.rows !== m.rows) s.term.resize(m.cols, m.rows);
    const scale = () => {
      const scr = el.querySelector('.xterm-screen');
      if (!scr || !scr.offsetWidth || s.mine !== false) return;
      const w = scr.offsetWidth, h = scr.offsetHeight;
      const k = Math.min(s.box.clientWidth / w, s.box.clientHeight / h, 1);
      el.style.width = w + 'px';
      el.style.height = h + 'px';
      el.style.transform = `scale(${k.toFixed(4)})`;
    };
    scale();
    requestAnimationFrame(scale); // 改行列后渲染器下一帧才更新大小
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
    s.mine = true; // 先在本地解锁、按本机屏幕排 (服务端收到 claim 一定给，马上会确认)
    updateOwnerNotice(s);
    if (!s.scrollView) s.fit.fit();
    send(s, { type: 'resize', cols: s.term.cols, rows: s.term.rows, claim: 'take' });
    // 光标去哪同点终端：终端的输入框里有没发送的字 (任何设备上打的都算) 时留在终端，方便接着改
    if (!isTouch && deskOn && s.cli.locked()) s.term.focus();
    else focusTerm(s);
  }
