'use strict';
// 手机：键盘弹出时输入栏在键盘上方；从后台回来 (键盘在后台收起了) 页面恢复占满屏幕，终端重新算行数
const { Server } = require('ssh2');
const { BASE, ok, wait, shot, launch, addHost, run, hostKey, devices } = require('./helpers');

let rows = 0;
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a, r, info) => { rows = info.rows; a(); });
    s.on('window-change', (a, r, info) => { rows = info.rows; a && a(); });
    s.on('shell', (a) => { const st = a(); for (let i = 1; i <= 100; i++) st.write(`line ${i}\r\n`); st.write('$ '); });
  }));
}).listen(2267, '127.0.0.1');

run(async () => {
  await addHost('VP', 2267);
  const browser = await launch();
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const m = await ctx.newPage();
  const errors = []; m.on('pageerror', (e) => errors.push(e.message));
  await m.goto(BASE + '/'); await m.waitForSelector('#app:not(.hidden)');
  await m.tap('#btnToggle'); await m.locator('.host', { hasText: 'VP' }).tap(); await wait(1500);
  const layout = () => m.evaluate(() => {
    const app = document.getElementById('app'), bar = document.getElementById('mobileBar').getBoundingClientRect();
    return { style: app.style.height, appH: app.getBoundingClientRect().height, winH: document.documentElement.clientHeight, barBottom: Math.round(bar.bottom) };
  });
  const full = await layout(); const rows0 = rows;
  ok(full.style === '' && Math.abs(full.appH - full.winH) < 2 && Math.abs(full.barBottom - full.winH) < 2, `正常：页面占满屏幕，输入栏在最底下 (${full.appH} / ${full.winH})`);

  // 模拟键盘弹出：可视区域变矮
  await m.evaluate(() => {
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: () => 400 });
    window.visualViewport.dispatchEvent(new Event('resize'));
  });
  await wait(400);
  let l = await layout();
  ok(l.style === '400px' && l.barBottom === 400 && rows < rows0, `键盘弹出：页面缩到可视区域 (400px)，输入栏在键盘上方，终端变成 ${rows} 行`);

  // 模拟在后台时键盘收起了，但浏览器没有通知：可视区域已恢复，页面还停在 400px
  await m.evaluate(() => { delete window.visualViewport.height; });
  l = await layout();
  ok(l.style === '400px', '(模拟) 切到后台再回来：页面还停在键盘弹出时的高度');
  await m.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await wait(800);
  l = await layout();
  ok(l.style === '' && Math.abs(l.appH - l.winH) < 2 && Math.abs(l.barBottom - l.winH) < 2, `回到前台：页面重新占满屏幕，输入栏回到最底下 (${l.appH} / ${l.winH})`);
  ok(rows === rows0, `终端重新算行数并通知服务器：${rows} 行 (和原来 ${rows0} 行一样)`);
  const gap = await m.evaluate(() => {
    const screen = document.querySelector('.term.active .xterm-screen').getBoundingClientRect();
    return Math.round(document.getElementById('mobileBar').getBoundingClientRect().top - screen.bottom);
  });
  ok(gap >= 0 && gap < 30, `终端内容和输入栏之间没有空一大块 (间隔 ${gap}px)`);
  await m.screenshot({ path: shot('viewport.png') });

  // 页面重新获得焦点 (比如从别的 App 切回来) 也会重新算
  await m.evaluate(() => { document.getElementById('app').style.height = '300px'; window.dispatchEvent(new Event('focus')); });
  await wait(800);
  l = await layout();
  ok(l.style === '' && Math.abs(l.appH - l.winH) < 2, '重新获得焦点：同样恢复占满屏幕');
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close();
});
