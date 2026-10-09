'use strict';
// 手机刚打开页面时地址栏伸缩，可视区域会短暂比页面矮：不能当成键盘弹出把界面固定成矮的
// (以前没占满屏幕，要点一下输入框弹出键盘再收起才恢复)。真的弹出键盘 (焦点在输入框) 时照旧固定在键盘上方
const { BASE, ok, wait, launch, devices, hostKey } = require('./helpers');
const { Server } = require('ssh2');
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => { const s = acc(); s.on('pty', (a) => a()); s.on('window-change', (a) => a && a()); s.on('shell', (a) => a().write('$ ')); }));
}).listen(2293, '127.0.0.1');

(async () => {
  await fetch(BASE + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'MH', host: '127.0.0.1', port: 2293, username: 'u', password: 'x' }) });
  const browser = await launch();
  const errors = [];
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  // 假的可视区域：测试里自己控制高度、发 resize
  await ctx.addInitScript(() => {
    const vv = new EventTarget();
    vv.scale = 1; vv.height = 0;
    Object.defineProperty(vv, 'height', { get: () => window.__vvH ?? document.documentElement.clientHeight });
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
    window.__vv = (h) => { window.__vvH = h; vv.dispatchEvent(new Event('resize')); };
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  // 手机上侧边栏收着，用接口建会话：直接点主机列表里的项
  await p.evaluate(() => document.querySelector('.host')?.click()); await wait(300);
  if (await p.isVisible('#modal')) await p.evaluate(() => document.querySelector('#hostForm button[type=submit]').click());
  await wait(1500);
  const full = await p.evaluate(() => document.documentElement.clientHeight);
  const appH = () => p.evaluate(() => Math.round(document.getElementById('app').getBoundingClientRect().height));

  // 刚打开：地址栏伸缩，可视区域短暂比页面矮 120px，焦点不在输入框里
  await p.evaluate(() => document.activeElement?.blur());
  await p.evaluate((h) => window.__vv(h), full - 120); await wait(200);
  ok(await appH() === full, `焦点不在输入框里、可视区域短暂变矮：界面照样占满屏幕 (${await appH()} / ${full}px)`);

  // 点输入栏弹出键盘：可视区域矮 300px → 界面固定在键盘上方
  await p.evaluate(() => document.getElementById('mInput').focus());
  await p.evaluate((h) => window.__vv(h), full - 300); await wait(200);
  ok(await appH() === full - 300, `焦点在输入栏、键盘弹出：界面缩到键盘上方 (${await appH()} / ${full - 300}px)`);

  // 收起键盘：可视区域恢复
  await p.evaluate(() => document.getElementById('mInput').blur());
  await p.evaluate(() => window.__vv(undefined)); await wait(200);
  ok(await appH() === full, `收起键盘：界面恢复占满 (${await appH()} / ${full}px)`);

  // 收起键盘时浏览器没报可视区域变化 (还停在矮的值)：离开输入框后过一会儿自己再算，也恢复
  await p.evaluate(() => document.getElementById('mInput').focus());
  await p.evaluate((h) => window.__vv(h), full - 300); await wait(200);
  await p.evaluate(() => { window.__vvH = undefined; document.getElementById('mInput').blur(); }); await wait(600);
  ok(await appH() === full, `收起键盘时浏览器没通知：离开输入框后自己恢复占满 (${await appH()} / ${full}px)`);

  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
