'use strict';
// 完成通知：这台没开、别的设备开着时写出来，对话框里列出开了通知的设备，能单独删掉
const { BASE, ok, wait, launch } = require('./helpers');
const J = (m, u, b, ua) => fetch(BASE + u, { method: m, headers: { 'content-type': 'application/json', ...(ua && { 'user-agent': ua }) }, body: b && JSON.stringify(b) }).then((r) => r.json());
(async () => {
  // 另一台设备 (手机上的 Chrome) 开过通知
  await J('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/other-device', keys: { p256dh: 'x', auth: 'y' } } },
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36');
  const browser = await launch();
  const errors = [];
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)'); await wait(1500);
  const label = await p.locator('#btnNotify').textContent();
  ok(label === '未开启 · 其他 1 台已开', '这台没开、别的设备开着：按钮上写出来 (' + label + ')');
  await p.screenshot({ path: require('./helpers').shot('notify-btn.png'), clip: { x: 0, y: 560, width: 250, height: 120 } });
  await p.click('#btnNotify'); await wait(500);
  await p.screenshot({ path: require('./helpers').shot('notify-dlg.png') });
  const body = await p.locator('#dialogBody').textContent();
  ok(await p.isVisible('#dialog') && body.includes('安卓 · Chrome') && body.includes('这台设备还没开启'), '点开：列出开了通知的设备 (安卓 · Chrome)');
  await p.locator('#dialogBody [data-del]').click(); await wait(500);
  ok(await p.locator('#dialogBody .sub-row').count() === 0 && (await J('POST', '/api/push/subs', {})).length === 0, '点「删除」：那台设备的订阅删掉了');
  await p.keyboard.press('Escape'); await wait(300);
  ok(await p.locator('#btnNotify').textContent() === '未开启', '删掉后按钮变回「未开启」');
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
