  // ------------------------------------------------------------ 复制终端内容 (手机)
  // 手机上触摸被用来滚动，无法直接选中终端文字；这里把终端内容放进可选择的文本框
  const COPY_LINES = 1000;

  // 终端文字 (最后 1000 行，自动换行的续行接回上一行) 和缓冲区第 row 行在其中是第几行
  function terminalText(s, row = -1) {
    const b = s.term.buffer.active;
    const start = Math.max(0, b.length - COPY_LINES);
    const lines = [];
    let at = 0;
    for (let i = start; i < b.length; i++) {
      const line = b.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      // 自动换行的续行接回上一行
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
      if (i === row) at = lines.length - 1;
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return { text: lines.join('\n'), line: Math.min(at, Math.max(0, lines.length - 1)) };
  }

  // 手指按在终端第几行 (缓冲区里的行号)
  function terminalRowAt(s, y) {
    const t = s.term, screen = t.element?.querySelector('.xterm-screen') || t.element;
    const r = screen?.getBoundingClientRect();
    const top = t.buffer.active.viewportY;
    if (!r || !r.height || t.rows <= 0) return top;
    return top + Math.min(t.rows - 1, Math.max(0, Math.floor((y - r.top) / (r.height / t.rows))));
  }

  // 长按打开 (at = 手指位置)：复制面板里按住的那一行就在手指底下；按键栏的「复制」按钮：定位到最新内容。
  // 历史视图 (tmux 本地快速滚动) 打开时：复制的是历史视图里的文字 (不是终端当前那一屏)
  function openCopyPanel(s, at) {
    if (!s) return;
    const pre = $('#copyText');
    const hist = s.scrollView?.querySelector('.ls-body');
    let text, data, line = -1;
    if (hist) {
      s.scrollView.lsRest(); // 前面的历史还在后台往上补：先补完
      // 优先用原始文本：显示时长行会在 cols 格处被切开 (splitByCells)、插入换行，textContent 不是原文
      text = (s.scrollView.lsText ?? hist.textContent).replace(/\n+$/, '');
      data = s.scrollView.lsData ?? text;
      const domLine = at ? lineAt(hist, at.x, at.y) : firstVisibleLine(hist);
      // 换回原始文本的行号 (见 domLineToTextLine 的说明)。必须用历史视图切行时的格数 (lsCols)：
      // 它是按历史视图实际宽度量的，比终端列数小 (手机上小好几格)，拿 term.cols 换算会少数显示行、定位偏到后面
      line = domLineToTextLine(text.split('\n'), s.scrollView.lsCols || s.term?.cols || 80, domLine);
    } else {
      const t = terminalText(s, at ? terminalRowAt(s, at.y) : -1);
      text = data = t.text;
      if (at) line = t.line;
    }
    const n = text ? text.split('\n').length : 0;
    $('#copyInfo').textContent = hist ? `${n} 行 (tmux 历史)`
      : s.term.buffer.active.type === 'alternate' ? `${n} 行 (全屏程序只有当前画面)` : `${n} 行`;
    mInput.blur();
    $('#copyPanel').dataset.tab = s.id; // 手机上同性能监控 (见 tabPanels)
    $('#copyPanel').classList.remove('hidden');
    tabPanels(); // 同历史面板：在别的标签上打开过会带着 tab-away
    renderCopy(s, pre, data, text); // 面板显示出来才量得出宽度
    if (n && line >= 0) scrollToLine(pre, Math.min(line, n - 1), at?.y);
    else { pre._place = null; pre.scrollTop = pre.scrollHeight; } // 定位到最新内容
  }

  // 复制面板的内容照历史视图的样子排 (同一个 gridView)：每种字补成正好 1 / 2 格，表格竖线对齐，超宽的表格整张左右滑。
  // 以前是文本框：iPhone 上中文和英文是两种字体，一个中文字不正好是两个英文宽，文本框里没法按字补，表格竖线对不齐
  function renderCopy(s, pre, data, text) {
    pre.textContent = '';
    pre.style.paddingBottom = '';
    const fs = 12, lh = Math.round(fs * 1.45);
    Object.assign(pre.style, { fontFamily: s.term.options.fontFamily, fontSize: fs + 'px', lineHeight: lh + 'px', letterSpacing: '0' });
    const probe = document.createElement('span'); // 这个字号一格本来多宽
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
    probe.textContent = '0'.repeat(100);
    pre.appendChild(probe);
    const cw = probe.getBoundingClientRect().width / 100;
    probe.remove();
    const { cols, chunks, block } = gridView(pre, data, s.term.cols || 80, cw, termTheme());
    const f = document.createDocumentFragment();
    for (const c of chunks) f.append(block(c));
    pre.append(f);
    pre.lsText = text; // 复制全部、换算行号用原文
    pre.lsCols = cols;
  }

  // 把 DOM 里的行号换算成原始文本的行号：显示时长行会被 splitByCells 切成几行，
  // 所以 DOM 行号 ≥ 原始行号。按显示时的切法重数一遍，数到第 k 个显示行时它在原始的第几行。
  // 不换算的话 (v1.83.34 之后) 复制面板会定位到错误的位置 —— 按 DOM 行号去原始文本里找，
  // 短会话直接越界到末尾 (看着像「直接出现最新记录」)，长会话指到别的地方 (按的字和显示的对不上)
  function domLineToTextLine(rawLines, cols, k) {
    if (!(cols > 0)) return k;
    let shown = 0;
    for (let i = 0; i < rawLines.length; i++) {
      const n = Math.max(1, splitByCells(rawLines[i], cols).length);
      if (shown + n > k) return i;
      shown += n;
    }
    return Math.max(0, rawLines.length - 1);
  }

  // 复制面板滚到原文第 k 行，有 anchorY (手指的位置) 就让这一行停在手指那个高度，否则停在最上面。
  // 长行切成几行显示：先换算成第几个显示行，再量它实际在哪 (中文 / emoji 的行可能高一点，不能按行高乘)。
  // 字体刚加载完位置还会变，所以过一会儿再对一次 (用户自己滑过就不动了)
  function scrollToLine(pre, k, anchorY) {
    const place = () => {
      // 面板关了 / 换了内容 / 用户已经自己滑了：不动
      if (pre._place !== place || $('#copyPanel').classList.contains('hidden') || pre.scrollTop !== pre._lineTop) return;
      pre.style.paddingBottom = '';
      const top = domLineTop(pre, textLineToDomLine(pre.lsText.split('\n'), pre.lsCols, k));
      const want = top - anchorOffset(pre, anchorY);
      // 靠近最后的行滚不到手指那么高：底下补一点空白
      const short = want - (pre.scrollHeight - pre.clientHeight);
      if (short > 0) pre.style.paddingBottom = parseFloat(getComputedStyle(pre).paddingBottom) + short + 'px';
      pre.scrollTop = want;
      pre._lineTop = pre.scrollTop;
    };
    pre._place = place;
    pre._lineTop = pre.scrollTop;
    place();
    requestAnimationFrame(place);
    setTimeout(place, 300);
    document.fonts?.ready.then(place);
  }

  // 原文第 k 行是第几个显示行 (domLineToTextLine 反过来)
  function textLineToDomLine(rawLines, cols, k) {
    if (!(cols > 0)) return k;
    let shown = 0;
    for (let i = 0; i < k && i < rawLines.length; i++) shown += Math.max(1, splitByCells(rawLines[i], cols).length);
    return shown;
  }

  // 第 d 个显示行的顶端在 pre 内容里的位置 (px，从内容最上面算)：按文字找到这一行的第一个字，量它在哪
  function domLineTop(pre, d) {
    const w = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    let n, seen = 0, node = null, off = 0;
    while ((n = w.nextNode())) {
      if (seen === d) { node = n; off = 0; break; }
      let i = -1;
      while (seen < d && (i = n.data.indexOf('\n', i + 1)) >= 0) seen++;
      if (seen === d && i >= 0) {
        if (i + 1 < n.data.length) { node = n; off = i + 1; break; }
      }
    }
    if (!node) return d ? pre.scrollHeight : 0;
    // 在行首临时放一个空的小标记量位置 (空行只有换行符，换行符本身量不出位置)
    const r = document.createRange(), mk = document.createElement('span');
    r.setStart(node, off); r.collapse(true); r.insertNode(mk);
    const top = mk.getBoundingClientRect().top;
    mk.remove();
    return top - pre.getBoundingClientRect().top - pre.clientTop + pre.scrollTop - parseFloat(getComputedStyle(pre).paddingTop);
  }

  // 这一行显示在复制面板顶部往下多少：手指的高度 (上面留一行、下面留两行)
  function anchorOffset(pre, y) {
    if (y == null) return 0;
    const lh = parseFloat(getComputedStyle(pre).lineHeight) || 18;
    const want = y - pre.getBoundingClientRect().top - pre.clientTop - parseFloat(getComputedStyle(pre).paddingTop) - lh / 2;
    return Math.max(0, Math.min(Math.max(want, lh), pre.clientHeight - 3 * lh));
  }

  // 历史视图里最上面那一行是第几行
  function firstVisibleLine(pre) {
    const r = pre.getBoundingClientRect();
    return lineAt(pre, r.left + 8, r.top + 4);
  }

  // 历史视图里 (x, y) 处是第几行 (长行会折行显示，所以按文字算，不按像素算)
  function lineAt(pre, x, y) {
    let node, off;
    if (document.caretRangeFromPoint) { const rg = document.caretRangeFromPoint(x, y); node = rg?.startContainer; off = rg?.startOffset; }
    else if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); node = p?.offsetNode; off = p?.offset; }
    if (!node || !pre.contains(node)) {
      const avg = pre.scrollHeight / Math.max(1, pre.textContent.split('\n').length);
      return Math.floor((pre.scrollTop + y - pre.getBoundingClientRect().top) / avg);
    }
    const range = document.createRange();
    range.setStart(pre, 0);
    range.setEnd(node, off);
    return (range.toString().match(/\n/g) || []).length;
  }

  function closeCopyPanel() {
    $('#copyPanel').classList.add('hidden');
    try { window.getSelection()?.removeAllRanges(); } catch {}
  }

  async function copyText(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    // HTTP 下没有剪贴板接口 (或剪贴板接口拒绝写入)，用临时文本框 + execCommand 复制。
    // 临时文本框会抢走焦点，删掉后焦点落到页面上 (下方输入框没了光标)：复制完还给原来的元素。
    // 要在这里还：接口被拒时这段在 await 之后才跑，调用方同步还焦点的代码早就跑完了
    const had = document.activeElement;
    const tmp = document.createElement('textarea');
    tmp.value = text;
    tmp.setAttribute('readonly', '');
    tmp.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
    document.body.appendChild(tmp);
    tmp.select();
    tmp.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    tmp.remove();
    if (had && had !== document.body && had.isConnected && document.activeElement !== had) had.focus({ preventScroll: true });
    return ok;
  }

  function copyToast(msg) {
    const t = $('#copyToast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t.timer);
    t.timer = setTimeout(() => t.classList.remove('show'), 1600);
  }

  $('#copyAll').addEventListener('click', async () => {
    const text = $('#copyText').lsText || '';
    copyToast(await copyText(text) ? `已复制全部 (${text.length} 个字符)` : '复制失败，请长按文字手动复制');
  });
  // 复制面板里选中的文字 (去掉切长行插进去的换行，同历史视图)；没选中返回空
  const panelSel = () => {
    const sel = getSelection();
    return sel?.rangeCount && !sel.isCollapsed && $('#copyText').contains(sel.getRangeAt(0).commonAncestorContainer) ? plainSel(sel) : '';
  };
  // 按下按钮时先记下选中的文字：有的手机点按钮会把选中取消掉，到 click 时已经没了
  let selAtPress = '';
  $('#copySel').addEventListener('pointerdown', () => { selAtPress = panelSel(); });
  $('#copySel').addEventListener('click', async () => {
    const text = panelSel() || selAtPress;
    selAtPress = '';
    if (!text) return copyToast('请先长按文字选择要复制的部分');
    copyToast(await copyText(text) ? `已复制 ${text.length} 个字符` : '复制失败，请长按文字手动复制');
  });
  // 系统菜单的「拷贝」/ Ctrl+C：同上，去掉切长行插进去的换行
  $('#copyText').addEventListener('copy', (e) => {
    const text = panelSel();
    if (!text || !e.clipboardData) return;
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
  });
  $('#copyClose').addEventListener('click', closeCopyPanel);
  $('#copyPanel').addEventListener('mousedown', (e) => { if (e.target.id === 'copyPanel') closeCopyPanel(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#copyPanel').classList.contains('hidden')) closeCopyPanel();
  });

  // 全屏程序 (多为 tmux) 没开鼠标时无法滑动：提示并可一键为 tmux 开启鼠标
  function showScrollHint(s) {
    if (s.noScrollHint || s.scrollHint) return;
    const el = document.createElement('div');
    el.className = 'scroll-hint';
    el.innerHTML = `<div class="msg">当前全屏程序没有开启鼠标，无法滑动查看历史记录。<br>如果在用 <b>tmux</b>，可以一键开启鼠标滚动：</div>
      <div class="acts"><button class="primary" data-a="on">开启 tmux 鼠标滚动</button><button data-a="no">不再提示</button></div>`;
    s.box.appendChild(el);
    s.scrollHint = el;
    const close = () => { el.remove(); s.scrollHint = null; };
    el.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const a = e.target.dataset.a;
      if (a === 'no') { s.noScrollHint = true; return close(); }
      if (a !== 'on' || !s.sid) return;
      e.target.disabled = true;
      try {
        await api('POST', `/api/sessions/${s.sid}/tmux-mouse`);
        el.innerHTML = '<div class="msg">✔ 已为 tmux 开启鼠标，现在可以滑动查看历史了（在底部继续下滑会自动退出查看模式）。<br>'
          + '<span class="note">tmux 重启后需要重新开启；想永久生效，在 ~/.tmux.conf 加一行 <code>set -g mouse on</code></span></div>';
        setTimeout(close, 6000);
      } catch (err) {
        el.querySelector('.msg').textContent = '开启失败：' + err.message;
        setTimeout(close, 4000);
      }
    });
  }

  // ------------------------------------------------------------ 完成通知 (Web Push)
  // 告诉服务端哪个标签正被看着：正在看的标签响铃时不推送
  // watching：正在看这个标签 (终端按正在用的设备排版)；front：网页在前台 (没最小化、浏览器是当前窗口、
  // 5 分钟内动过鼠标 / 键盘)，这时哪个标签都不推送通知 (右上角悬浮窗看得到状态)；
  // 最小化 / 切到别的窗口 / 人离开了 (5 分钟没操作) 才推送
  const IDLE_MS = 5 * 60 * 1000;
  let lastAct = Date.now(), idle = false;
  function reportWatching() {
    const focused = document.hasFocus() || !!pipWin?.document.hasFocus(); // 焦点在置顶小窗口上也算
    const front = (!document.hidden || !!pipWin) && focused && !idle;
    for (const x of sessions) send(x, { type: 'watching', watching: !document.hidden && x === active, front });
  }
  window.addEventListener('focus', reportWatching);
  window.addEventListener('blur', reportWatching);
  const onAct = () => { lastAct = Date.now(); if (idle) { idle = false; reportWatching(); } };
  for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) window.addEventListener(ev, onAct, { capture: true, passive: true });
  setInterval(() => { if (!idle && Date.now() - lastAct > IDLE_MS) { idle = true; reportWatching(); } }, 15000);
  document.addEventListener('visibilitychange', () => {
    reportWatching();
    sessions.forEach(syncMonitor); // 页面不可见时暂停性能监控采集
    if (!document.hidden && active) enableWebgl(active);
    if (!document.hidden && active) active.tab.classList.remove('ring');
  });

  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && window.isSecureContext;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  let swReg = null;

  async function initPush() {
    if ('serviceWorker' in navigator && window.isSecureContext) {
      try {
        swReg = await navigator.serviceWorker.register('/sw.js');
        // 点击通知时，已打开的页面切到对应标签
        navigator.serviceWorker.addEventListener('message', (e) => {
          if (e.data && e.data.type === 'open-session') {
            const t = sessions.find((x) => x.remoteId === e.data.id);
            if (t) { activate(t); t.tab.classList.remove('ring'); } // 点开通知看了：铃铛去掉 (本来就在这个标签上也去掉)
          }
        });
      } catch {}
    }
    updateNotifyBtn();
  }

  async function currentSub() {
    try { return swReg ? await swReg.pushManager.getSubscription() : null; } catch { return null; }
  }

  // 服务器上所有开了通知的设备 (self = 这台)；读不到返回 null
  async function pushSubs(sub) {
    try { return await api('POST', '/api/push/subs', { endpoint: sub?.endpoint || '' }); } catch { return null; }
  }

  const b64ToBytes = (b64) => {
    const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  };

  // 订阅用的是不是服务器现在的推送密钥 (data 目录重建过密钥会变，旧订阅推不过去)；浏览器不提供或读不到就不比
  let serverKey = null;
  async function keyMatches(sub) {
    const k = sub.options?.applicationServerKey;
    if (!k) return true;
    try { serverKey ||= (await api('GET', '/api/push/key')).publicKey; } catch { return true; }
    const a = new Uint8Array(k), b = b64ToBytes(serverKey);
    return a.length === b.length && a.every((x, i) => x === b[i]);
  }

  // 这台是不是真的开着：浏览器有订阅、有通知权限，服务器上也还有这条 (可能在别的设备上被删了、失效被清理了)，
  // 而且密钥对得上；只看浏览器自己会显示「已开启」却永远收不到
  async function pushState() {
    const sub = pushSupported() ? await currentSub() : null;
    const subs = await pushSubs(sub);
    const on = !!sub && Notification.permission === 'granted' && (!subs || subs.some((x) => x.self)) && await keyMatches(sub);
    return { sub, subs: subs || [], on };
  }

  async function updateNotifyBtn() {
    const b = $('#btnNotify');
    const { subs, on } = await pushState();
    // 这台没开、别的设备开着：写出来 (不然会奇怪「没开通知怎么还有通知」)
    // 这台用不了 (局域网 http://) 也照样写出来：以前用域名开过通知的设备还会收到推送
    const others = on ? 0 : subs.filter((x) => !x.self).length;
    b.textContent = on ? '已开启' : (pushSupported() ? '未开启' : '不可用') + (others ? ` · 其他 ${others} 台已开` : '');
    b.classList.toggle('on', on);
    b.classList.toggle('na', !pushSupported());
    b.title = pushSupported() ? '终端有提示音时推送通知'
      : '需要通过 HTTPS 访问 (iPhone 需先添加到主屏幕)' + (others ? '；点开可以查看、删除已开通知的设备' : '');
  }

  // 浏览器里的旧订阅密钥对得上就接着用，只重新登记到服务器 (可能在别的设备上被删了)；密钥变了才重新订阅。
  // 不要随便重新订阅：要连得上浏览器的推送服务 (Chrome 是谷歌的 FCM)，连不上就失败，旧的也作废了
  async function enablePush() {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('没有获得通知权限，请在浏览器设置里允许这个网站发送通知');
    const reg = swReg || await navigator.serviceWorker.ready;
    const { publicKey } = await api('GET', '/api/push/key');
    serverKey = publicKey;
    let sub = await reg.pushManager.getSubscription();
    if (sub && !(await keyMatches(sub))) {
      await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
    if (!sub) {
      try {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
      } catch (e) {
        if (e.name !== 'AbortError') throw e;
        throw new Error(`连不上浏览器的推送服务（${e.message}）。Chrome 等浏览器要通过谷歌的推送服务 (FCM) 收通知：`
          + '网络连不上谷歌、手机没有谷歌服务，或 Brave 浏览器没打开「使用 Google 服务推送消息」时会这样，换个网络稍后再试');
      }
    }
    await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
    return sub;
  }
  // 测试通知只发给这台
  const testPush = (sub) => api('POST', '/api/push/test', { endpoint: sub.endpoint });

  $('#btnNotify').addEventListener('click', async () => {
    // 这台开不了通知的原因
    const why = !window.isSecureContext ? '完成通知需要通过 HTTPS 访问（例如 Cloudflare 隧道的域名），局域网 http:// 地址无法开启。'
      : !pushSupported() ? (isIOS && !standalone
        ? 'iPhone / iPad 需要先点 Safari 的「分享 → 添加到主屏幕」，从主屏幕图标打开后再开启通知（iOS 16.4 以上）。'
        : '当前浏览器不支持推送通知。') : '';
    // 开了通知的设备列表，每台都能单独删掉 (比如以前开过的浏览器、别的电脑)
    const { sub, subs, on } = await pushState();
    if (why && !subs.length) return alert(why);
    const day = (t) => t ? new Date(t).toLocaleDateString() : '';
    const listHtml = subs.length ? `<p>开了通知的设备（都会收到推送）：</p><div class="sub-list">${subs.map((x) => `<div class="sub-row">
        <span>${esc(x.device)}${x.self ? ' <b>（这台）</b>' : ''} <small>${day(x.created)} 开启</small></span>
        <button type="button" class="danger" data-del="${esc(x.id)}" data-self="${x.self ? 1 : ''}">删除</button></div>`).join('')}</div>` : '';
    const onDel = async (e) => {
      const btn = e.target.closest('[data-del]');
      if (!btn) return;
      btn.disabled = true;
      await api('POST', '/api/push/unsubscribe', { id: btn.dataset.del }).catch(() => {});
      if (btn.dataset.self && sub) await sub.unsubscribe().catch(() => {});
      btn.closest('.sub-row').remove();
      updateNotifyBtn();
    };
    $('#dialogBody').addEventListener('click', onDel);
    const rules = '网页开在前台时不推送，最小化、切到别的窗口或 5 分钟没操作才推送';
    try {
      if (why) {
        // 这台开不了，但别的设备开着 (比如以前用域名访问时开过)：照样列出来，在这里就能删掉
        await dialog('完成通知', `<p>${esc(why)}</p>${listHtml}`, [{ label: '关闭', value: null, cls: 'primary', cancel: true }]);
      } else if (on) {
        const r = await dialog('完成通知', `<p>这台设备已开启。Claude Code 完成、需要选择、出错或终端有提示音时推送；${rules}。</p>${listHtml}`, [
          { label: '关闭通知', value: 'off', cls: 'danger' },
          { label: '发送测试通知', value: 'test' },
          { label: '取消', value: null, cls: 'primary', cancel: true },
        ]);
        if (r.value === 'test') await testPush(sub);
        if (r.value === 'off') {
          await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
          await sub.unsubscribe();
        }
      } else if (subs.some((x) => !x.self)) {
        // 这台没开，但别的设备开着：先列出来，可以删掉，也可以在这台开启
        const r = await dialog('完成通知', `<p>这台设备还没开启。${rules}。</p>${listHtml}`, [
          { label: '在这台设备开启', value: 'on', cls: 'primary' },
          { label: '关闭', value: null, cancel: true },
        ]);
        if (r.value === 'on') await testPush(await enablePush());
      } else {
        await testPush(await enablePush());
      }
    } catch (e) {
      alert('操作失败：' + e.message);
    } finally {
      $('#dialogBody').removeEventListener('click', onDel);
    }
    updateNotifyBtn();
  });

