  // ------------------------------------------------------------ 抬高模式下方留白里的信息面板：各主机 (标签) 状态
  let deskTabList = [], lastStatusPaint = 0;
  const panelShown = () => !deskSpace.classList.contains('hidden');

  function renderDeskPanel() {
    if (!deskSpace.firstChild) deskSpace.innerHTML = '<div class="dp-h">主机状态</div><div class="dp-tabs"></div>';
    renderDeskTabs();
  }

  // 主机状态画到所有显示着的地方：抬高模式的留白、网页内悬浮窗、置顶到桌面的小窗口
  function statusBoxes() {
    const out = [];
    if (panelShown()) out.push(deskSpace.querySelector('.dp-tabs'));
    if (!hostFloat.classList.contains('hidden') && !hostFloat.classList.contains('min')) out.push(hfTabs);
    if (pipWin) out.push(pipWin.document.querySelector('.dp-tabs'));
    return out.filter(Boolean);
  }

  function renderDeskTabs() {
    const boxes = statusBoxes();
    const sumOn = !hostFloat.classList.contains('hidden') && hostFloat.classList.contains('min');
    if (!boxes.length && !sumOn) return;
    deskTabList = tabOrder();
    // 状态由服务端判断后推过来 (lib/status.js)；没连上的显示未连接
    const states = deskTabList.map((x) => (!x.sid ? ['未连接', 'off'] : x.srvState ? [x.srvState.label, x.srvState.cls] : ['空闲', 'idle']));
    const html = deskTabList.map((x, i) => {
      const [st, cls] = states[i];
      return `<div class="dp-tab${x === active ? ' cur' : ''}" data-k="${i}">
        <span class="${$('.dot', x.tab).className}"></span><span class="nm">${esc($('.title', x.tab).textContent)}</span>
        <span class="stt ${cls}">${st}</span></div>`;
    }).join('');
    for (const box of boxes) if (box.innerHTML !== html) box.innerHTML = html;
    alignPipBack();
    alignHfHead();
    // 悬浮窗收起时，标题栏上用小圆点显示每个标签的状态
    const sum = states.map(([st, cls], i) => `<i class="hf-d ${cls}" title="${esc($('.title', deskTabList[i].tab).textContent)}：${st}"></i>`).join('');
    if (hfSum.innerHTML !== sum) hfSum.innerHTML = sum;
  }
  setInterval(renderDeskTabs, 500);

  // 按下就切标签 (每 0.5 秒会重画，不等 click)，不抢走输入框焦点
  function onStatusDown(e) {
    if (e.button !== 0) return;
    const row = e.target.closest('.dp-tab');
    if (!row) return;
    e.preventDefault();
    const x = deskTabList[+row.dataset.k];
    if (x && x !== active) activate(x);
  }
  deskSpace.addEventListener('mousedown', onStatusDown);

  // ------------------------------------------------------------ 电脑：主机状态悬浮窗
  // 顶部「🖥️ 状态」开关，显示在终端上 (和输入框模式无关)，按住标题栏拖动，开关 / 位置 / 收起状态每台电脑各自记住；
  // 📌 置顶到桌面：浏览器的文档画中画 (Chrome / Edge 116+)，浏览器最小化后也浮在最上面
  const hostFloat = $('#hostFloat'), hfTabs = $('#hostFloat .dp-tabs'), hfSum = $('#hostFloat .hf-sum');
  let pipWin = null;
  const hfPos = (() => { try { return JSON.parse(localStorage.getItem('sshweb.hostFloat')) || {}; } catch { return {}; } })();
  const saveHf = () => { try { localStorage.setItem('sshweb.hostFloat', JSON.stringify(hfPos)); } catch {} };
  if (hfPos.min) hostFloat.classList.add('min');
  let hfOn = (() => { try { return localStorage.getItem('sshweb.hfOn') !== '0'; } catch { return true; } })();
  const btnFloat = $('#btnFloat');
  btnFloat.addEventListener('click', () => {
    hfOn = !hfOn;
    try { localStorage.setItem('sshweb.hfOn', hfOn ? '1' : '0'); } catch {}
    if (!hfOn && pipWin) pipWin.close(); // 关掉时置顶小窗口也一起关
    updateHostFloat();
  });
  const pipOk = 'documentPictureInPicture' in window;
  if (!pipOk) { hostFloat.querySelector('[data-a=pip]').remove(); hostFloat.querySelector('[data-a=auto]').remove(); }
  // 自动钉住：浏览器规定置顶窗口只能在用户点击 / 按键时打开，所以在打开网页后的第一次操作时顺手打开；
  // 这次手动关掉了就不再自动打开，下次打开网页再说
  let autoPin = (() => { try { return localStorage.getItem('sshweb.autoPin') === '1'; } catch { return false; } })();
  let pipClosedByUser = false;
  const autoBtn = hostFloat.querySelector('[data-a=auto]');
  autoBtn?.classList.toggle('on', autoPin);
  const tryAutoPin = (e) => {
    if (e.type === 'keydown' && (e.key === 'Escape' || e.repeat)) return; // 浏览器不把 Esc 算作用户操作，打不开
    if (autoPin && hfOn && pipOk && !pipWin && !pipClosedByUser && !isTouch && active) openStatusPip(true);
  };
  window.addEventListener('pointerdown', tryAutoPin, true);
  window.addEventListener('keydown', tryAutoPin, true);

  // 位置用「离 main 右边 / 上边的距离」保存，窗口大小变了也贴着右上角；超出范围时收回来
  function placeHostFloat() {
    const main = hostFloat.parentElement;
    const top0 = $('#tabbar').offsetHeight;
    const maxR = Math.max(0, main.clientWidth - hostFloat.offsetWidth);
    const maxT = Math.max(top0, main.clientHeight - hostFloat.offsetHeight);
    const r = Math.min(Math.max(0, hfPos.r ?? 12), maxR);
    const t = Math.min(Math.max(top0, hfPos.t ?? top0 + 8), maxT);
    hostFloat.style.right = r + 'px';
    hostFloat.style.top = t + 'px';
  }

  function updateHostFloat() {
    btnFloat.classList.toggle('hidden', !(!isTouch && active));
    btnFloat.classList.toggle('on', hfOn);
    const show = !isTouch && !!active && hfOn && !pipWin;
    const was = !hostFloat.classList.contains('hidden');
    hostFloat.classList.toggle('hidden', !show);
    if (show) {
      if (!was) renderDeskTabs();
      placeHostFloat();
    }
  }
  new ResizeObserver(() => { if (!hostFloat.classList.contains('hidden')) { alignHfHead(); placeHostFloat(); } }).observe(hostFloat.parentElement);

  hostFloat.addEventListener('mousedown', onStatusDown);
  hostFloat.querySelector('.hf-head').addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const head = e.currentTarget;
    head.setPointerCapture(e.pointerId);
    const r0 = hostFloat.getBoundingClientRect(), main = hostFloat.parentElement.getBoundingClientRect();
    const x0 = e.clientX, y0 = e.clientY;
    const r0px = main.right - r0.right, t0px = r0.top - main.top;
    hostFloat.classList.add('dragging');
    const move = (ev) => {
      hfPos.r = r0px - (ev.clientX - x0);
      hfPos.t = t0px + (ev.clientY - y0);
      placeHostFloat();
    };
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      head.removeEventListener('pointercancel', up);
      hostFloat.classList.remove('dragging');
      hfPos.r = parseFloat(hostFloat.style.right);
      hfPos.t = parseFloat(hostFloat.style.top);
      saveHf();
      if (active) focusTerm(active);
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
  });
  hostFloat.querySelector('.hf-head').addEventListener('mousedown', (e) => e.preventDefault()); // 不抢走输入框焦点
  hostFloat.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.a === 'min') {
      hfPos.min = hostFloat.classList.toggle('min');
      saveHf();
      renderDeskTabs();
      placeHostFloat();
    } else if (b.dataset.a === 'pip') openStatusPip();
    else if (b.dataset.a === 'auto') {
      autoPin = !autoPin;
      try { localStorage.setItem('sshweb.autoPin', autoPin ? '1' : '0'); } catch {}
      autoBtn.classList.toggle('on', autoPin);
      if (autoPin) { pipClosedByUser = false; openStatusPip(); }
    }
  });

  // 置顶到桌面：内容和网页里的一样，样式直接引用同一个 style.css
  let pipOpening = false;
  async function openStatusPip(auto) {
    if (pipWin) return pipWin.focus();
    if (pipOpening) return;
    pipOpening = true;
    let w;
    try {
      // disallowReturnToOpener：不显示 Chrome 自带的「返回标签页」按钮 (点了会关掉小窗口)，用自己的「↩ 网页」代替
      w = await window.documentPictureInPicture.requestWindow({ width: 300, height: 170, disallowReturnToOpener: true });
    } catch (e) {
      if (!auto) alert('无法打开置顶窗口：' + e.message); // 自动钉住失败不打扰，下次操作再试
      return;
    } finally {
      pipOpening = false;
    }
    pipWin = w;
    const d = w.document;
    d.title = '主机状态 - SSH-WEB';
    const link = d.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('style.css', location.href).href;
    d.head.appendChild(link);
    syncPipTheme();
    d.body.className = 'pip-body';
    d.body.innerHTML = '<div class="pip-head"><button data-a="back" title="切回网页，小窗口继续留着">↩ 网页</button></div><div class="dp-tabs"></div>';
    // 点卡片：切到那个标签并把网页切到前面；小窗口不关
    d.addEventListener('mousedown', (e) => {
      if (e.target.closest('[data-a=back]') || e.target.closest('.dp-tab')) { onStatusDown(e); window.focus(); }
    });
    w.addEventListener('resize', alignPipBack);
    d.fonts?.ready.then(alignPipBack);
    link.addEventListener('load', alignPipBack);
    w.addEventListener('pagehide', () => {
      pipWin = null;
      pipClosedByUser = true; // 小窗口被关掉 (点了 ✕)：这次不再自动打开
      updateHostFloat();
    });
    updateHostFloat();
    renderDeskTabs();
  }
  // 标题栏最右边的按钮和第一行最右边的卡片右边对齐 (卡片自动换行，第一行通常到不了最右边)：
  // 置顶小窗口的「↩ 网页」、网页里悬浮窗的「–」
  function firstRowGap(box) {
    const cards = box.children;
    if (!cards.length) return 0;
    const top = cards[0].offsetTop;
    let right = 0;
    for (const c of cards) if (c.offsetTop === top) right = Math.max(right, c.getBoundingClientRect().right);
    return Math.max(0, Math.round(box.getBoundingClientRect().right - right));
  }
  function alignPipBack() {
    if (!pipWin) return;
    const d = pipWin.document, head = d.querySelector('.pip-head'), box = d.querySelector('.dp-tabs');
    if (!head || !box) return;
    const pad = firstRowGap(box) + 'px';
    if (head.style.paddingRight !== pad) head.style.paddingRight = pad;
  }
  function alignHfHead() {
    const head = hostFloat.querySelector('.hf-head');
    head.style.paddingRight = '';
    if (hostFloat.classList.contains('hidden') || hostFloat.classList.contains('min')) return;
    // 悬浮窗宽度按内容撑开：卡片撑的宽度才对齐；只有一两张卡片时宽度由标题栏撑，加宽标题栏只会把整个窗口撑宽，保持原样
    const w0 = hostFloat.offsetWidth;
    const base = parseFloat(getComputedStyle(head).paddingRight);
    const pad = firstRowGap(hfTabs);
    if (pad <= base) return;
    head.style.paddingRight = pad + 'px';
    if (hostFloat.offsetWidth > w0) head.style.paddingRight = '';
  }
  function syncPipTheme() {
    if (!pipWin) return;
    const t = document.documentElement.dataset.theme;
    if (t) pipWin.document.documentElement.dataset.theme = t;
    else delete pipWin.document.documentElement.dataset.theme;
  }

  // 按住上下拖动的通用处理：onMove(鼠标相对按下时的位移 dy)，requestAnimationFrame 节流，松开后保存
  function dragY(e, onMove) {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    deskBar.classList.add('dragging');
    document.body.classList.add('no-select');
    const y0 = e.clientY;
    let y = y0, raf = 0;
    const update = () => { raf = 0; onMove(y - y0); };
    const move = (ev) => {
      y = ev.clientY;
      if (!raf) raf = requestAnimationFrame(update);
    };
    const up = () => {
      if (raf) { cancelAnimationFrame(raf); update(); }
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      deskBar.classList.remove('dragging');
      document.body.classList.remove('no-select');
      saveDeskPos();
      dInput.focus();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  // 按比例设置抬高位置 (像素)，超出范围时停在边界，不记住超出的值
  function setLiftPx(px) {
    const h = deskBar.parentElement.clientHeight;
    const own = deskMode === 'float' && active?.remoteId; // 浮动：记到这个标签上，同时作为共用位置
    deskLift = Math.max(0, px) / h;
    if (own) floatLift[active.remoteId] = deskLift;
    applyDeskPos();
    deskLift = deskLiftPx() / h;
    if (own) floatLift[active.remoteId] = deskLift;
  }

  // 拖左边的把手上下调整位置
  $('#dGrip').addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || deskMode === 'bottom') return;
    const lift0 = deskLiftPx();
    dragY(e, (dy) => setLiftPx(lift0 - dy));
  });

  // 拖上边缘调整输入框高度 (最低高度，字多了照样自动变高)，往上拖变高，下边缘 / 抬高位置不动；双击恢复默认
  // 最低 / 默认 40px = 一行；右边的按钮和输入框设定的高度一样高
  // (以前默认 60px 存在 sshweb.deskMinH 里：拖高过的 (> 60) 保留，60 当作没设置过，改用新默认)
  const DESK_MIN_H = 40;
  let deskMinH = (() => {
    try {
      const v = parseInt(localStorage.getItem('sshweb.deskH'), 10);
      if (v) return Math.max(DESK_MIN_H, v);
      const old = parseInt(localStorage.getItem('sshweb.deskMinH'), 10);
      return old > 60 ? old : DESK_MIN_H;
    } catch { return DESK_MIN_H; }
  })();

  function setMinHStyle() {
    dInput.style.minHeight = deskMinH + 'px';
    dInput.style.maxHeight = `max(40vh, ${deskMinH}px)`;
    deskBar.style.setProperty('--desk-h', deskMinH + 'px');
  }
  function applyMinH() {
    setMinHStyle();
    autosizeDesk();
  }
  setMinHStyle();

  function setMinH(h) {
    // 最高到 main 的一半，抬高模式下还要给上方终端留出位置
    const main = deskBar.parentElement.clientHeight;
    let max = Math.round(main * 0.5);
    if (deskMode === 'lift') max = Math.min(max, main - $('#tabbar').offsetHeight - MIN_TERM - (deskBar.offsetHeight - dInput.offsetHeight));
    deskMinH = Math.round(Math.max(DESK_MIN_H, Math.min(h, max)));
    applyMinH();
  }

  $('#dResize').addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const h0 = dInput.offsetHeight;
    dragY(e, (dy) => setMinH(h0 - dy));
  });
  $('#dResize').addEventListener('dblclick', () => {
    deskMinH = DESK_MIN_H;
    applyMinH();
    saveDeskPos();
    dInput.focus();
  });

  function setDeskOn(on) {
    deskOn = on;
    if (!on && cmdMode) setCmdMode(false);
    try { localStorage.setItem('sshweb.deskInput', on ? '1' : '0'); } catch {}
    updateMobileBar();
    if (active) focusTerm(active);
  }

