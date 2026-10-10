'use strict';
// 性能监控：一次采集还没回来时切走又切回标签，不会多出一条采集循环 (以前每来回一次多一条，采集越来越频繁)
const { Server } = require('ssh2');
const { BASE, ok, wait, launch, addHost, run, hostKey } = require('./helpers');

new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => a().write('$ '));
  }));
}).listen(2286, '127.0.0.1');

run(async () => {
  await addHost('ML', 2286);
  const browser = await launch();
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'ML' }).click(); await p.waitForSelector('.tab.active .dot.ok'); await wait(500);
  await p.locator('.host', { hasText: 'ML' }).click(); await wait(1500);
  // 采集接口：每次 3 秒才回来 (目标主机慢)
  let n = 0;
  await p.route('**/api/monitor/**', async (route) => { n++; await wait(3000); route.fulfill({ json: {} }).catch(() => {}); });
  await p.click('#btnMon'); await wait(300);
  // 采集还没回来时切走又切回
  await p.locator('.tab:not(.active)').first().click();
  await p.locator('.tab:not(.active)').first().click(); await wait(3500);
  const n0 = n;
  await wait(15000);
  const per = n - n0;
  ok(per <= 4, `15 秒内采集 ${per} 次 (每次 3 秒 + 间隔 2 秒，应该 3 次左右)`);
  await browser.close();
});
