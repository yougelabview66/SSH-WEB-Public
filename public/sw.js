/* SSH-WEB Service Worker：接收完成通知 (Web Push)，点击通知打开对应标签；
   Claude Code 要权限时通知上带「允许 / 拒绝」(安卓 Chrome 支持；iPhone 的网页通知没有按钮，只能点开) */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'SSH-WEB', {
    body: d.body || '',
    tag: d.tag || 'ssh-web',
    renotify: true,
    icon: '/icon.svg',
    badge: '/icon.svg',
    data: { sessionId: d.sessionId || null, seq: d.seq ?? null },
    ...(Array.isArray(d.actions) && { actions: d.actions.slice(0, 2), requireInteraction: true }),
  }));
});

// 打开网页 (已经开着就切过去)，切到对应的标签
async function openPage(id) {
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of wins) {
    if (new URL(c.url).origin === self.location.origin) {
      try { await c.focus(); } catch {} // 有的浏览器不让切到前台：照样让页面切到那个标签 (去掉铃铛)
      if (id) c.postMessage({ type: 'open-session', id });
      return;
    }
  }
  await self.clients.openWindow('/' + (id ? '?session=' + encodeURIComponent(id) : ''));
}

// 点了「允许 / 拒绝」：交给服务器 (它会先核对确认框还在)，结果用一条短通知告诉你；没登录 / 已经处理过 / 出错就打开网页
async function answer(n, choice) {
  const { sessionId: id, seq } = n.data || {};
  let msg = '';
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/answer`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choice, seq }),
    });
    if (r.ok) {
      await self.registration.showNotification(choice === 'allow' ? '已允许' : '已拒绝', { body: n.title, tag: n.tag, icon: '/icon.svg', badge: '/icon.svg', silent: true, data: { sessionId: id } });
      return;
    }
    try { msg = (await r.json()).error || ''; } catch {}
  } catch {}
  if (msg) await self.registration.showNotification('没有发出去', { body: msg, tag: n.tag, icon: '/icon.svg', badge: '/icon.svg', data: { sessionId: id } });
  await openPage(id);
}

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  if (e.action === 'allow' || e.action === 'deny') return e.waitUntil(answer(e.notification, e.action));
  e.waitUntil(openPage(e.notification.data && e.notification.data.sessionId));
});
