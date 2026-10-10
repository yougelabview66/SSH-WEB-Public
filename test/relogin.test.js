'use strict';
// 登录过期后重新登录：标签不重复 (以前全部重开一遍，每个标签多出一个)；开着历史等面板时登录框不被盖住
// @env AUTH_PASSWORD=test-pass-123 SESSION_HOURS=0.002
const { Server } = require('ssh2');
const { BASE, ok, wait, launch, run, hostKey } = require('./helpers');

new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => a().write('$ '));
  }));
}).listen(2287, '127.0.0.1');

run(async () => {
  const browser = await launch();
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await p.goto(BASE + '/');
  const login = async () => {
    await p.fill('#loginForm [name=username]', 'admin'); await p.fill('#loginForm [name=password]', 'test-pass-123');
    await p.click('#loginForm button[type=submit]', { timeout: 5000 }); await wait(1500);
  };
  await login();
  await p.evaluate(() => fetch('/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'RL', host: '127.0.0.1', port: 2287, username: 'u', password: 'x' }) }));
  await p.reload(); await wait(1000);
  await p.locator('.host', { hasText: 'RL' }).click(); await p.waitForSelector('.tab.active .dot.ok'); await wait(800);
  ok(await p.locator('.tab').count() === 1, '开了一个标签');

  await wait(6500); // 登录过期 (SESSION_HOURS=0.002 ≈ 7 秒)
  await p.click('#btnHistory'); await wait(1500); // 打开历史面板 → 接口返回未登录 → 弹出登录框
  ok(await p.isVisible('#login'), '登录过期：弹出登录框');
  const top = await p.evaluate(() => { const b = document.querySelector('#loginForm button[type=submit]').getBoundingClientRect();
    return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest('#login') !== null; });
  ok(top, '开着历史面板时登录框在最上面，点得到「登录」');
  await login(); await wait(2000);
  const n = await p.locator('.tab').count();
  ok(n === 1 && await p.isHidden('#login'), `重新登录后标签不重复 (${n} 个)`);
  ok(await p.evaluate(() => !!document.querySelector('.tab.active .dot.ok')), '标签照常连着');
  await browser.close();
});
