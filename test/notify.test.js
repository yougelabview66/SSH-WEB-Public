'use strict';
// 完成通知：这台没开、别的设备开着时写出来，对话框里列出开了通知的设备，能单独删掉；
// 局域网 http:// 访问 (这台开不了通知) 也照样列出来、能删掉。
// 设了密码：没设密码时只认 localhost 的地址栏 (v1.82.0 防 DNS 重绑定)，lan.test 会被挡在外面，所以登录后再访问
// @env AUTH_PASSWORD=test-pass-123
const { BASE, ok, wait, launch } = require('./helpers');
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';
const subscribeOther = () => J('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/other-device', keys: { p256dh: 'x', auth: 'y' } } }, ANDROID);
let cookie = ''; // 登录凭证 (sshweb_session=…)
const J = (m, u, b, ua) => fetch(BASE + u, { method: m, headers: { 'content-type': 'application/json', cookie, ...(ua && { 'user-agent': ua }) }, body: b && JSON.stringify(b) }).then((r) => r.json());
// 浏览器带上同一个凭证 (凭证不绑地址栏，localhost 和 lan.test 都认)
const authed = async (browser, url) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const [name, value] = [cookie.slice(0, cookie.indexOf('=')), cookie.slice(cookie.indexOf('=') + 1)];
  await ctx.addCookies([{ name, value, url }]);
  return ctx.newPage();
};
(async () => {
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test-pass-123' }) });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  ok(r.status === 200 && cookie.startsWith('sshweb_session='), '登录拿到凭证');
  // 另一台设备 (手机上的 Chrome) 开过通知
  await subscribeOther();
  // lan.test 指到本机：不是 localhost 的 http:// 地址，浏览器不当作安全环境，跟局域网 IP 访问一样
  const browser = await launch(['--host-resolver-rules=MAP lan.test 127.0.0.1']);
  const errors = [];
  const p = await authed(browser, BASE); p.on('pageerror', (e) => errors.push(e.message));
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

  // 局域网 http:// 访问：这台开不了通知，但以前用域名开过通知的设备还会收到推送，要看得到、删得掉
  await subscribeOther();
  const lan = await authed(browser, BASE.replace('127.0.0.1', 'lan.test')); lan.on('pageerror', (e) => errors.push(e.message));
  const dialogs = []; lan.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await lan.goto(BASE.replace('127.0.0.1', 'lan.test') + '/'); await lan.waitForSelector('#app:not(.hidden)'); await wait(1500);
  ok(await lan.evaluate(() => !window.isSecureContext), '局域网地址：页面不是安全环境 (http://)');
  const lanLabel = await lan.locator('#btnNotify').textContent();
  ok(lanLabel === '不可用 · 其他 1 台已开', '局域网：按钮写出别的设备开着通知 (' + lanLabel + ')');
  await lan.click('#btnNotify'); await wait(500);
  await lan.screenshot({ path: require('./helpers').shot('notify-lan-dlg.png') });
  const lanBody = await lan.locator('#dialogBody').textContent();
  ok(await lan.isVisible('#dialog') && lanBody.includes('HTTPS') && lanBody.includes('安卓 · Chrome') && !dialogs.length, '局域网点开：说明要 HTTPS，并列出开了通知的设备');
  await lan.locator('#dialogBody [data-del]').click(); await wait(500);
  ok((await J('POST', '/api/push/subs', {})).length === 0, '局域网点「删除」：那台设备的订阅删掉了');
  await lan.keyboard.press('Escape'); await wait(300);
  ok(await lan.locator('#btnNotify').textContent() === '不可用', '删掉后按钮变回「不可用」');
  await lan.click('#btnNotify'); await wait(500);
  ok(dialogs.length === 1 && dialogs[0].includes('HTTPS') && !(await lan.isVisible('#dialog')), '没有设备开着时：只提示需要 HTTPS');

  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
