  // ------------------------------------------------------------ 复制终端内容 (手机)
  // 手机上触摸被用来滚动，无法直接选中终端文字；这里把终端内容放进可选择的文本框
  const COPY_LINES = 1000;

  function terminalText(s) {
    const b = s.term.buffer.active;
    const start = Math.max(0, b.length - COPY_LINES);
    const lines = [];
    for (let i = start; i < b.length; i++) {
      const line = b.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      // 自动换行的续行接回上一行
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.join('\n');
  }

  // 历史视图 (tmux 本地快速滚动) 打开时：复制的是历史视图里的文字 (不是终端当前那一屏)，
  // 复制面板滚到正在看的那一行
  function openCopyPanel(s) {
    if (!s) return;
    const ta = $('#copyText');
    const hist = s.scrollView?.querySelector('.ls-body');
    ta.value = hist ? hist.textContent.replace(/\n+$/, '') : terminalText(s);
    const n = ta.value ? ta.value.split('\n').length : 0;
    $('#copyInfo').textContent = hist ? `${n} 行 (tmux 历史)`
      : s.term.buffer.active.type === 'alternate' ? `${n} 行 (全屏程序只有当前画面)` : `${n} 行`;
    mInput.blur();
    $('#copyPanel').classList.remove('hidden');
    if (hist && n) scrollToLine(ta, firstVisibleLine(hist));
    else { ta._place = null; ta.scrollTop = ta.scrollHeight; } // 定位到最新内容
  }

  // 复制面板滚到第 k 行：中文 / emoji 用的后备字体让这些行比别的行高，不能按「平均行高 × 行号」算，
  // 量前 k 行实际有多高。字体刚加载完行高还会变，所以过一会儿再对一次 (用户自己滑过就不动了)
  function scrollToLine(ta, k) {
    const full = ta.value;
    const place = () => {
      // 面板关了 / 换了内容 / 用户已经自己滑了：不动
      if (ta._place !== place || $('#copyPanel').classList.contains('hidden') || ta.scrollTop !== ta._lineTop) return;
      ta.style.flex = 'none'; ta.style.height = ta.style.minHeight = '0px';
      ta.value = full.split('\n', k).join('\n');
      const h = k ? ta.scrollHeight - parseFloat(getComputedStyle(ta).paddingBottom) : 0;
      ta.value = full;
      ta.style.flex = ta.style.height = ta.style.minHeight = '';
      ta.scrollTop = h;
      ta._lineTop = ta.scrollTop;
    };
    ta._place = place;
    ta._lineTop = ta.scrollTop;
    place();
    requestAnimationFrame(place);
    setTimeout(place, 300);
    document.fonts?.ready.then(place);
  }

  // 历史视图里最上面那一行是第几行 (长行会折行显示，所以按文字算，不按像素算)
  function firstVisibleLine(pre) {
    const r = pre.getBoundingClientRect(), x = r.left + 8, y = r.top + 4;
    let node, off;
    if (document.caretRangeFromPoint) { const rg = document.caretRangeFromPoint(x, y); node = rg?.startContainer; off = rg?.startOffset; }
    else if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); node = p?.offsetNode; off = p?.offset; }
    if (!node || !pre.contains(node)) return Math.round(pre.scrollTop / (pre.scrollHeight / Math.max(1, pre.textContent.split('\n').length)));
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
    // HTTP 下没有剪贴板接口，用临时文本框 + execCommand 复制
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
    const text = $('#copyText').value;
    copyToast(await copyText(text) ? `已复制全部 (${text.length} 个字符)` : '复制失败，请长按文字手动复制');
  });
  $('#copySel').addEventListener('click', async () => {
    const ta = $('#copyText');
    const text = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    if (!text) return copyToast('请先长按文字选择要复制的部分');
    copyToast(await copyText(text) ? `已复制 ${text.length} 个字符` : '复制失败，请长按文字手动复制');
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
            if (t) activate(t);
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

  // 每次开启都换一个新订阅：旧的可能是旧推送密钥订的、或者服务器上已经删了，接着用会一直收不到
  async function enablePush() {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('没有获得通知权限，请在浏览器设置里允许这个网站发送通知');
    const reg = swReg || await navigator.serviceWorker.ready;
    const { publicKey } = await api('GET', '/api/push/key');
    serverKey = publicKey;
    const old = await reg.pushManager.getSubscription();
    if (old) {
      await api('POST', '/api/push/unsubscribe', { endpoint: old.endpoint }).catch(() => {});
      await old.unsubscribe().catch(() => {});
    }
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
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

