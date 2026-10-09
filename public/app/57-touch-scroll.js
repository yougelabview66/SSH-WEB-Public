  // ------------------------------------------------------------ 触屏滑动滚动
  // xterm.js 6 不支持触摸滚动，手指滑动会被浏览器当成下拉刷新。这里自己处理，行为与电脑滚轮一致：
  // - 程序开启了鼠标追踪 (Claude Code、tmux、htop、vim mouse=a 等)：发送鼠标滚轮事件，由程序自己滚动
  // - 普通界面：滚动终端的历史记录 (带惯性)
  // - 不支持鼠标的全屏程序：不发送任何按键，避免误触发 (比如方向键会调出历史输入)
  function enableTouchScroll(s) {
    const WHEEL_LINES = 3; // 手指移动 3 行发送一次滚轮 (同普通鼠标滚轮)
    const WHEEL_GAP = 35;  // 两次滚轮事件最小间隔 ms，给远端 (tmux 等) 重绘留时间
    const WHEEL_MAX_QUEUE = 4;
    let lastY = null;
    let lastX = 0;
    let lastT = 0;
    let vel = 0;      // px/ms
    let acc = 0;      // 还没换算成行 / 滚轮的累计像素
    let pendingPx = 0; // 本帧待处理的滑动距离 (合并同一帧内的多次 touchmove)
    let frame = 0;
    let lh = 17;
    let wheelQueue = 0; // 待发送的滚轮次数，正数 = 往回看
    let wheelTimer = 0;
    let lastWheelAt = 0;

    const measure = () => {
      const screen = s.box.querySelector('.xterm-screen');
      lh = (screen && s.term.rows && screen.clientHeight / s.term.rows) || 17;
    };
    const wheelMode = () => s.term.modes.mouseTrackingMode !== 'none';

    // 交给 xterm 按滚轮处理，它会按程序要求的鼠标协议 (SGR 等) 编码发送
    const sendWheel = (dir) => {
      const target = s.term.element.querySelector('.xterm-screen') || s.term.element;
      const r = target.getBoundingClientRect();
      target.dispatchEvent(new WheelEvent('wheel', {
        deltaY: dir > 0 ? -1 : 1, deltaMode: WheelEvent.DOM_DELTA_LINE,
        clientX: Math.min(Math.max(lastX, r.left + 1), r.right - 1), clientY: r.top + r.height / 2,
        bubbles: true, cancelable: true,
      }));
    };

    // 按固定间隔匀速发送，避免一次甩动瞬间发出几十个事件导致远端重绘堆积、画面一顿一顿
    const pumpWheel = () => {
      wheelTimer = 0;
      if (!wheelQueue) return;
      const wait = WHEEL_GAP - (performance.now() - lastWheelAt);
      if (wait > 0) { wheelTimer = setTimeout(pumpWheel, wait); return; }
      const dir = Math.sign(wheelQueue);
      sendWheel(dir);
      wheelQueue -= dir;
      lastWheelAt = performance.now();
      if (wheelQueue) wheelTimer = setTimeout(pumpWheel, WHEEL_GAP);
    };

    const queueWheel = (n) => {
      if (Math.sign(n) !== Math.sign(wheelQueue)) wheelQueue = 0; // 反向时丢弃旧方向
      wheelQueue = Math.max(-WHEEL_MAX_QUEUE, Math.min(WHEEL_MAX_QUEUE, wheelQueue + n));
      if (!wheelTimer) pumpWheel();
    };

    // dy > 0: 手指下滑 = 往回看
    const scrollPx = (dy) => {
      if (Math.sign(dy) !== Math.sign(acc)) acc = 0;
      acc += dy;
      if (wheelMode()) {
        const unit = lh * WHEEL_LINES;
        const n = Math.trunc(acc / unit);
        if (n) { acc -= n * unit; queueWheel(n); }
        return;
      }
      const lines = Math.trunc(acc / lh);
      if (!lines) return;
      acc -= lines * lh;
      if (s.term.buffer.active.type === 'normal') s.term.scrollLines(-lines);
      else showScrollHint(s);
    };

    // 同一帧内的多次 touchmove 合并处理 (高刷新率手机上 touchmove 比屏幕刷新还频繁)
    const flush = () => {
      frame = 0;
      const dy = pendingPx;
      pendingPx = 0;
      if (dy) scrollPx(dy);
    };

    // 惯性：按时间衰减 (与刷新率无关)；tmux 等远端滚动衰减更快，松手后不会一直漂
    let lastFrameT = 0;
    const momentum = (t) => {
      const dt = Math.min(t - lastFrameT, 50);
      lastFrameT = t;
      if (Math.abs(vel) < 0.04) return;
      scrollPx(vel * dt);
      vel *= Math.pow(wheelMode() ? 0.88 : 0.95, dt / 16);
      frame = requestAnimationFrame(momentum);
    };

    // 长按 (不移动) 打开复制面板
    let pressTimer = 0;
    let pressX = 0;
    let pressY = 0;
    const cancelPress = () => { clearTimeout(pressTimer); pressTimer = 0; };
    s.box.addEventListener('touchstart', (e) => {
      cancelPress();
      s.longPressed = false;
      if (e.touches.length === 1 && !e.target.closest('button, .scroll-hint')) {
        pressX = e.touches[0].clientX;
        pressY = e.touches[0].clientY;
        pressTimer = setTimeout(() => {
          pressTimer = 0;
          lastY = null; // 本次触摸不再滚动
          s.longPressed = true;
          navigator.vibrate?.(15);
          openCopyPanel(s, { x: pressX, y: pressY });
        }, 500);
      }
    }, { passive: true });
    s.box.addEventListener('touchmove', (e) => {
      if (pressTimer && Math.hypot(e.touches[0].clientX - pressX, e.touches[0].clientY - pressY) > 8) cancelPress();
    }, { passive: true });
    s.box.addEventListener('touchend', cancelPress, { passive: true });
    s.box.addEventListener('touchcancel', cancelPress, { passive: true });

    // 双指捏合调整字体大小
    let pinch = null;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    s.box.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) pinch = { d0: dist(e.touches) || 1, base: fontSize, raf: 0, size: fontSize };
    }, { passive: true });
    s.box.addEventListener('touchmove', (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      pinch.size = pinch.base * dist(e.touches) / pinch.d0;
      if (!pinch.raf) {
        pinch.raf = requestAnimationFrame(() => {
          if (!pinch) return;
          pinch.raf = 0;
          setFontSize(pinch.size, false);
          fontToast(s, `字体 ${fontSize}`);
        });
      }
    }, { passive: false });
    const endPinch = (e) => {
      if (!pinch || e.touches.length >= 2) return;
      cancelAnimationFrame(pinch.raf);
      setFontSize(pinch.size, true);
      pinch = null;
    };
    s.box.addEventListener('touchend', endPinch, { passive: true });
    s.box.addEventListener('touchcancel', endPinch, { passive: true });

    s.box.addEventListener('touchstart', (e) => {
      cancelAnimationFrame(frame);
      frame = 0;
      pendingPx = 0;
      if (e.touches.length !== 1) { lastY = null; return; }
      measure();
      lastY = e.touches[0].clientY;
      lastX = e.touches[0].clientX;
      lastT = performance.now();
      vel = 0;
      acc = 0;
    }, { passive: true });

    s.box.addEventListener('touchmove', (e) => {
      if (lastY == null || e.touches.length !== 1) return;
      e.preventDefault(); // 阻止下拉刷新 / 页面滚动
      const y = e.touches[0].clientY;
      const now = performance.now();
      const dy = y - lastY;
      vel = 0.7 * (dy / Math.max(now - lastT, 1)) + 0.3 * vel;
      lastY = y;
      lastT = now;
      pendingPx += dy;
      if (!frame) frame = requestAnimationFrame(flush);
    }, { passive: false });

    s.box.addEventListener('touchend', () => {
      if (lastY == null) return;
      lastY = null;
      cancelAnimationFrame(frame);
      flush();
      // 停顿后再松手不需要惯性
      if (performance.now() - lastT > 80) vel = 0;
      vel = Math.max(-4, Math.min(4, vel));
      lastFrameT = performance.now();
      frame = requestAnimationFrame(momentum);
    }, { passive: true });
  }
