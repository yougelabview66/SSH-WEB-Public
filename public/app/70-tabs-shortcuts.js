  // ------------------------------------------------------------ 标签拖动排序
  // 鼠标：按住拖动超过 5px 开始；触屏：长按 350ms 开始 (避免和左右滑动标签栏冲突)
  const tabsEl = $('#tabs');
  let drag = null;

  function beginDrag() {
    if (!drag) return;
    drag.started = true;
    drag.tab.classList.add('dragging');
    tabsEl.classList.add('drag-active');
    if (drag.touch) navigator.vibrate?.(15);
  }

  function moveDrag(x) {
    const tabs = [...tabsEl.children];
    const i = tabs.indexOf(drag.tab);
    const prev = tabs[i - 1];
    const next = tabs[i + 1];
    const mid = (el) => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; };
    if (prev && x < mid(prev)) tabsEl.insertBefore(drag.tab, prev);
    else if (next && x > mid(next)) tabsEl.insertBefore(drag.tab, next.nextSibling);
    // 拖到边缘时自动滚动标签栏
    const r = tabsEl.getBoundingClientRect();
    if (x < r.left + 30) tabsEl.scrollLeft -= 12;
    else if (x > r.right - 30) tabsEl.scrollLeft += 12;
  }

  function endDrag() {
    if (!drag) return;
    clearTimeout(drag.timer);
    if (drag.started) {
      drag.tab.classList.remove('dragging');
      tabsEl.classList.remove('drag-active');
      // sessions 顺序与界面保持一致
      const order = [...tabsEl.children];
      sessions.sort((a, b) => order.indexOf(a.tab) - order.indexOf(b.tab));
      activate(drag.s);
      saveTabOrder();
    }
    drag = null;
  }

  tabsEl.addEventListener('pointerdown', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab || e.target.closest('.x') || e.button > 0) return;
    const s = sessions.find((x) => x.tab === tab);
    if (!s) return;
    drag = { s, tab, startX: e.clientX, startY: e.clientY, started: false, touch: e.pointerType !== 'mouse' };
    if (drag.touch) drag.timer = setTimeout(beginDrag, 350);
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.started) {
      const moved = Math.max(Math.abs(e.clientX - drag.startX), Math.abs(e.clientY - drag.startY));
      if (drag.touch) {
        if (moved > 8) endDrag(); // 长按前就移动了 = 在滑动标签栏
        return;
      }
      if (moved < 5) return;
      beginDrag();
    }
    moveDrag(e.clientX);
  });
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  // 触屏拖动时阻止页面 / 标签栏滚动
  tabsEl.addEventListener('touchmove', (e) => { if (drag && drag.started) e.preventDefault(); }, { passive: false });
  tabsEl.addEventListener('contextmenu', (e) => { if (e.target.closest('.tab')) e.preventDefault(); });

  // 按界面上的顺序排列的标签
  const tabOrder = () => [...tabsEl.querySelectorAll('.tab')].map((el) => sessions.find((x) => x.tab === el)).filter(Boolean);

  // ------------------------------------------------------------ 标签切换快捷键
  // Alt+1~9 跳到第 N 个标签，Alt+← / Alt+→ 上一个 / 下一个 (循环)；按界面上的标签顺序。
  // 捕获阶段处理，不再发给终端 / 输入框；Ctrl+Tab、Ctrl+数字会被浏览器占用，所以用 Alt
  window.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const n = /^Digit([1-9])$/.exec(e.code);
    if (!n && e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') return;
    if (document.querySelector('.overlay:not(.hidden)')) return; // 弹窗打开时不切换
    const list = tabOrder();
    if (!list.length) return;
    e.preventDefault();
    e.stopPropagation();
    let target;
    if (n) target = list[n[1] - 1];
    else {
      const i = list.indexOf(active);
      target = list[(i + (e.code === 'ArrowRight' ? 1 : -1) + list.length) % list.length];
    }
    if (target && target !== active) activate(target);
  }, true);

  // ------------------------------------------------------------ 连按两下 Alt：光标在输入框和终端之间切换
  // 只算单独按下又松开的 Alt (Alt+1 等组合键里的 Alt 不算)；输入框隐藏时顺便打开
  let altClean = false, altLast = 0;
  window.addEventListener('keydown', (e) => {
    altClean = e.key === 'Alt' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    if (e.key !== 'Alt') altLast = 0;
  }, true);
  window.addEventListener('keyup', (e) => {
    if (e.key !== 'Alt' || !altClean) return;
    altClean = false;
    e.preventDefault(); // Windows 上单独按 Alt 会激活浏览器菜单
    const now = Date.now();
    if (now - altLast > 400) { altLast = now; return; }
    altLast = 0;
    if (isTouch || !active || document.querySelector('.overlay:not(.hidden)')) return;
    if (document.activeElement === dInput) active.term.focus();
    else if (!deskOn) setDeskOn(true);
    else dInput.focus();
  }, true);
  window.addEventListener('blur', () => { altClean = false; altLast = 0; });

