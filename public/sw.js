/* SSH-WEB Service Worker：接收完成通知 (Web Push)，点击通知打开对应标签 */
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
    data: { sessionId: d.sessionId || null },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const id = e.notification.data && e.notification.data.sessionId;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) {
      if (new URL(c.url).origin === self.location.origin) {
        await c.focus();
        if (id) c.postMessage({ type: 'open-session', id });
        return;
      }
    }
    await self.clients.openWindow('/' + (id ? '?session=' + encodeURIComponent(id) : ''));
  })());
});
