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
    const name = s.ownerName = m.device || '另一台设备';
    s.ownerOnline = m.online !== false;
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

  // 这个标签被别的设备锁住了 (正在别的设备上用)
  const isLocked = (s) => !!s && s.mine === false && !!s.ownerNotice;

  // 锁住时输入不发出去，晃一下提示，告诉怎么接管
  function inputLocked(s) {
    if (!isLocked(s)) return false;
    const el = s.ownerNotice;
    el.classList.remove('nudge');
    void el.offsetWidth; // 连按时重新播放动画
    el.classList.add('nudge');
    return true;
  }

  // 关掉标签会断开 SSH，在用的那台设备上的这个标签也一起没了：锁住时 (别的设备在用) 先问一下
  // 接着常驻会话的标签：问要不要把常驻会话也结束 (结束 = 里面的程序关掉；保留 = 在主机后台接着跑，下次打开这台主机能接上)。
  // 这个浏览器里别的标签也接着同一个会话：不问，只关这个标签
  async function askClose(s) {
    let asked = false;
    if (isLocked(s)) {
      const who = s.ownerOnline ? `正在${s.ownerName}上使用` : `是${s.ownerName}在用的 (现在断开了)`;
      if (!confirm(`这个标签${who}，关掉会断开 SSH 连接，${s.ownerName}上的这个标签也会一起关掉。确定关闭？`)) return;
      asked = true;
    }
    const did = s.sid && s.params?.daemonId;
    const shared = did && sessions.some((x) => x !== s && !x.closed && x.params?.daemonId === did && x.params?.hostId === s.params.hostId);
    if (did && !shared) {
      const r = await dialog('关闭标签', `<p>「${esc(s.title)}」接着常驻会话 ${esc(did)}。要把这个常驻会话也结束吗？</p>
        <p class="muted">结束：会话里运行的程序（比如 Claude Code）会关掉。<br>保留在后台：在主机上继续运行，下次打开这台主机时可以接上。</p>`, [
        { label: '取消', value: null, cancel: true },
        { label: '保留在后台', value: 'keep' },
        { label: '结束会话', value: 'kill', cls: 'danger', submit: true },
      ], 'close-' + s.id);
      if (!r.value || s.closed) return;
      return closeSession(s, false, r.value === 'kill');
    }
    // 普通会话 (不是常驻会话)：关了 SSH 就断了，里面的 Claude Code 等一起结束、找不回来。手机上点标签时手指一偏就点到 ×，先问一句
    if (isTouch && !asked && s.sid && !did && !confirm(`关闭「${s.title}」？\n\n会断开 SSH 连接，里面正在运行的程序 (比如 Claude Code) 会一起结束。`)) return;
    closeSession(s);
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
