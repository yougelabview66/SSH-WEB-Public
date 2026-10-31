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

