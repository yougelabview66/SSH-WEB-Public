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

  // ------------------------------------------------------------ 标签多到放不下
  // 不显示滚动条 (电脑上的滚动条会把标签压矮)；还有更多的那一边渐隐，电脑上两边有 ‹ › 箭头，
  // 滚轮上下滚也能左右翻；▾ 列出全部标签
  const tabsL = $('#tabsL'), tabsR = $('#tabsR'), btnTabList = $('#btnTabList'), tabListPop = $('#tabListPop');
  let overflowRaf = 0, revealPending = false;
  function updateTabsOverflow() {
    overflowRaf = 0;
    // 箭头 / ▾ 自己也占地方：按不算它们时放不放得下来判断，免得它们一出一收来回跳
    const extra = [tabsL, tabsR, btnTabList].reduce((w, b) => w + (b.classList.contains('hidden') ? 0 : b.offsetWidth), 0);
    const sw = tabsEl.scrollWidth, cw = tabsEl.clientWidth, x = tabsEl.scrollLeft;
    const over = sw > cw + extra + 1;
    const was = !btnTabList.classList.contains('hidden');
    tabsL.classList.toggle('hidden', !over || isTouch);
    tabsR.classList.toggle('hidden', !over || isTouch);
    btnTabList.classList.toggle('hidden', !over);
    // 标签增删 / 改名 (连上后标题加上 -N 会变宽)、箭头出现 / 消失改变了宽度：当前标签重新滚进视野；用户自己滚动时不管
    if ((over !== was || revealPending) && active && !drag) revealTab(active.tab); // 拖动排序时不拉回
    revealPending = false;
    if (!over && !tabListPop.classList.contains('hidden')) closeTabList();
    const l = over && x > 1, r = over && x + tabsEl.clientWidth < sw - 1;
    tabsEl.classList.toggle('more-l', l);
    tabsEl.classList.toggle('more-r', r);
    tabsL.disabled = !l;
    tabsR.disabled = !r;
  }
  // 把标签滚进视野，并且不停在两边渐隐的地方
  // 两边留出渐隐的宽度 (第一个 / 最后一个标签那一头没有渐隐，不用留)；标签栏太窄 (手机) 放不下留边时不留，再放不下就左边对齐
  function revealTab(tab) {
    if (!tab.isConnected) return;
    const r = tab.getBoundingClientRect(), c = tabsEl.getBoundingClientRect(), cw = tabsEl.clientWidth, x = tabsEl.scrollLeft;
    let left = r.left - c.left + x, right = left + r.width;
    if (right - left + 64 <= cw) {
      if (tab.previousElementSibling) left -= 32;
      if (tab.nextElementSibling) right += 32;
    }
    if (left < x || right - left > cw) tabsEl.scrollLeft = left;
    else if (right > x + cw) tabsEl.scrollLeft = right - cw;
  }
  const queueOverflow = (reveal) => {
    if (reveal === true) revealPending = true;
    if (!overflowRaf) overflowRaf = requestAnimationFrame(updateTabsOverflow);
  };
  tabsEl.addEventListener('scroll', queueOverflow, { passive: true });
  new ResizeObserver(() => queueOverflow(true)).observe(tabsEl);
  new MutationObserver(() => queueOverflow(true)).observe(tabsEl, { childList: true, subtree: true, characterData: true });

  tabsEl.addEventListener('wheel', (e) => {
    if (tabsEl.scrollWidth <= tabsEl.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // 触控板左右滑照常
    e.preventDefault();
    tabsEl.scrollLeft += e.deltaY * (e.deltaMode === 1 ? 20 : 1);
  }, { passive: false });
  for (const [b, dir] of [[tabsL, -1], [tabsR, 1]]) {
    b.addEventListener('mousedown', (e) => e.preventDefault()); // 不抢走输入框焦点
    b.addEventListener('click', () => tabsEl.scrollBy({ left: dir * tabsEl.clientWidth * 0.7, behavior: 'smooth' }));
  }

  function renderTabList() {
    const html = tabOrder().map((x, i) => {
      const [st, cls] = !x.sid ? ['未连接', 'off'] : x.srvState ? [x.srvState.label, x.srvState.cls] : ['空闲', 'idle'];
      return `<div class="dp-tab${x === active ? ' cur' : ''}" data-k="${i}">
        <span class="${$('.dot', x.tab).className}"></span><span class="nm">${esc($('.title', x.tab).textContent)}</span>
        <span class="stt ${cls}">${st}</span></div>`;
    }).join('');
    if (tabListPop.innerHTML !== html) tabListPop.innerHTML = html;
    const r = btnTabList.getBoundingClientRect();
    tabListPop.style.top = r.bottom + 4 + 'px';
    tabListPop.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    tabListPop.style.maxHeight = `calc(100% - ${r.bottom + 12}px)`;
  }
  let tabListTimer = 0;
  function closeTabList() {
    tabListPop.classList.add('hidden');
    btnTabList.classList.remove('on');
    clearInterval(tabListTimer);
  }
  btnTabList.addEventListener('mousedown', (e) => e.preventDefault());
  btnTabList.addEventListener('click', () => {
    if (!tabListPop.classList.contains('hidden')) return closeTabList();
    tabListPop.classList.remove('hidden');
    btnTabList.classList.add('on');
    renderTabList();
    tabListPop.querySelector('.cur')?.scrollIntoView({ block: 'nearest' });
    tabListTimer = setInterval(renderTabList, 500); // 状态跟着变
  });
  tabListPop.addEventListener('mousedown', (e) => e.preventDefault());
  tabListPop.addEventListener('click', (e) => {
    const row = e.target.closest('.dp-tab');
    const x = row && tabOrder()[+row.dataset.k];
    closeTabList();
    if (x && x !== active) activate(x);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!tabListPop.classList.contains('hidden') && !tabListPop.contains(e.target) && !btnTabList.contains(e.target)) closeTabList();
  }, true);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !tabListPop.classList.contains('hidden')) { closeTabList(); e.stopPropagation(); e.preventDefault(); }
  }, true);

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

  // ------------------------------------------------------------ 连按两下 Alt：光标在输入框和终端之间切换 (只切换光标，两边的字都不动)
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
    const inDesk = document.activeElement === dInput;
    if (active.scrollView) closeLocalScroll(active); // 历史视图打开时下方输入框是藏起来的：先回到实时画面，再放回输入框
    if (inDesk) { active.term.focus(); termDirect = true; }
    else if (!deskOn) setDeskOn(true);
    else dInput.focus();
  }, true);
  window.addEventListener('blur', () => { altClean = false; altLast = 0; });

