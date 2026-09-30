'use strict';
// 终端尺寸「谁在用听谁的」：电脑、手机同时开着同一个标签时，排版按正在用的那台设备
const { Server } = require('ssh2');
const { BASE, ok, wait, launch, addHost, run, hostKey, devices } = require('./helpers');

let size = null;
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a, r, info) => { size = { cols: info.cols, rows: info.rows }; a(); });
    s.on('window-change', (a, r, info) => { size = { cols: info.cols, rows: info.rows }; a && a(); });
    s.on('shell', (a) => { a().write('$ '); });
  }));
}).listen(2277, '127.0.0.1');

run(async () => {
  await addHost('OW', 2277);
  const browser = await launch();
  const trackWs = () => { window.__ws = []; const W = window.WebSocket; window.WebSocket = class extends W { constructor(...a) { super(...a); window.__ws.push(this); } }; };
  const dctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await dctx.addInitScript(trackWs);
  const d = await dctx.newPage();
  await d.goto(BASE + '/'); await d.waitForSelector('#app:not(.hidden)');
  await d.locator('.host', { hasText: 'OW' }).click(); await d.waitForSelector('.tab.active .dot.ok'); await wait(1000);
  const desk = { ...size };
  const s = () => `${size.cols}×${size.rows}`;

  const m = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
  await m.goto(BASE + '/'); await m.waitForSelector('.tab'); await wait(2000);
  const phone = { ...size };
  ok(phone.cols < 80 && desk.cols > 100, `手机打开同一个标签：按手机排版 ${s()} (电脑是 ${desk.cols}×${desk.rows})`);

  // 电脑在后台 (没有焦点)：断线自动重连、窗口大小变化都不抢尺寸
  await d.evaluate(() => { document.hasFocus = () => false; });
  await d.evaluate(() => window.__ws.forEach((w) => w.close())); await wait(3000);
  ok(await d.evaluate(() => !!document.querySelector('.tab.active .dot.ok')), '(电脑断线后已经自动重连)');
  ok(size.cols === phone.cols, `电脑在后台自动重连：不改排版，还是手机的 ${s()}`);
  await d.setViewportSize({ width: 1200, height: 780 }); await wait(800);
  ok(size.cols === phone.cols, `电脑在后台窗口大小变了：也不改排版 ${s()}`);

  // 回到电脑上 (电脑获得焦点)：按电脑排版
  await d.evaluate(() => { delete document.hasFocus; window.dispatchEvent(new Event('focus')); }); await wait(1200);
  ok(size.cols > 100, `回到电脑上用：按电脑排版 ${s()}`);

  // 电脑用过之后，手机刷新页面：按手机排版 (反馈的问题)
  await m.reload(); await m.waitForSelector('.tab'); await wait(2500);
  ok(size.cols === phone.cols && size.rows === phone.rows, `电脑用过之后手机刷新页面：按手机排版 ${s()}`);

  // 在电脑上打字：按电脑排版
  await d.locator('.term.active .xterm-helper-textarea').focus(); await d.keyboard.type('x'); await wait(800); // 直接在终端里打字
  ok(size.cols > 100, `在电脑上打字：按电脑排版 ${s()}`);
  // 在手机上打字 (输入栏发送)：按手机排版
  await m.tap('#mInput'); await m.keyboard.type('y'); await m.keyboard.press('Enter'); await wait(800);
  ok(size.cols === phone.cols, `在手机上发送内容：按手机排版 ${s()}`);

  // 第三台设备 (平板) 也开着：三台轮流使用，每次都按正在用的那台
  const t = await (await browser.newContext({ ...devices['iPad Mini'] })).newPage();
  await t.goto(BASE + '/'); await t.waitForSelector('.tab'); await wait(2000);
  const tablet = { ...size };
  ok(tablet.cols !== phone.cols && tablet.cols !== desk.cols, `平板打开：按平板排版 ${s()}`);
  await m.tap('#mInput'); await m.keyboard.type('z'); await m.keyboard.press('Enter'); await wait(800);
  ok(size.cols === phone.cols, `三台都开着，在手机上用：按手机 ${s()}`);
  await d.evaluate(() => window.dispatchEvent(new Event('focus'))); await wait(1200);
  ok(size.cols > 100, `回到电脑：按电脑 ${s()}`);
  await t.reload(); await t.waitForSelector('.tab'); await wait(2500);
  ok(size.cols === tablet.cols, `平板刷新页面：按平板 ${s()}`);
  await t.context().close(); await wait(1000);

  // 正在用的手机关掉页面：换成还开着的电脑的尺寸
  await m.context().close(); await wait(1000);
  ok(size.cols > 100, `手机关掉页面后：换成电脑的排版 ${s()}`);
  await browser.close();
});
