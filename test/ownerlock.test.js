'use strict';
// 正在用的设备断线 (手机锁屏，浏览器会断开连接)：其他设备上提示「手机已断开」，5 秒内回来还是它在用 (网络抖一下)，
// 没回来就换给正在看的设备；它亮屏重连回来时别人在用，它锁着 (先来先用)，点了才接管
const { Server } = require('ssh2');
const { BASE, ok, wait, launch, addHost, run, hostKey, devices } = require('./helpers');

let size = null;
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a, r, info) => { size = `${info.cols}×${info.rows}`; a(); });
    s.on('window-change', (a, r, info) => { size = `${info.cols}×${info.rows}`; a && a(); });
    s.on('shell', (a) => { a().write('$ '); });
  }));
}).listen(2299, '127.0.0.1');

// 能断开、挡住重连的 WebSocket (模拟手机锁屏时连不上)
const ctl = () => {
  window.__ws = []; window.__block = false;
  const W = window.WebSocket;
  window.WebSocket = class extends W {
    constructor(...a) { super(...a); window.__ws.push(this); if (window.__block) this.close(); }
  };
};
const notice = (pg) => pg.evaluate(() => document.querySelector('.term.active .owner-notice')?.textContent || '');
// 锁屏：页面到后台、连接断开、重连连不上
const lock = (pg) => pg.evaluate(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  window.__block = true; window.__ws.forEach((w) => w.close());
});
// 等它重连上
async function reconnected(pg) {
  for (let i = 0; i < 40; i++) {
    if (await pg.evaluate(() => !!document.querySelector('.tab.active .dot.ok'))) { await wait(1500); return true; }
    await wait(500);
  }
  return false;
}

run(async () => {
  await addHost('OL', 2299);
  const browser = await launch();
  const d = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await d.goto(BASE + '/'); await d.waitForSelector('#app:not(.hidden)');
  await d.locator('.host', { hasText: 'OL' }).click(); await d.waitForSelector('.tab.active .dot.ok'); await wait(1000);
  const desk = size;
  const mctx = await browser.newContext({ ...devices['Pixel 7'] });
  await mctx.addInitScript(ctl);
  const m = await mctx.newPage();
  await m.goto(BASE + '/'); await m.waitForSelector('.tab.active .dot.ok'); await wait(1500);
  await m.tap('.term.active .owner-notice button'); await wait(1000);
  const phone = size;
  ok(phone !== desk && (await notice(d)).includes('正在手机上使用'), `手机接管：按手机排版 ${phone}，电脑锁着`);

  // 网络抖一下 (页面在前台，断开 1.5 秒又连上)：还是手机在用
  await m.evaluate(() => { window.__block = true; window.__ws.forEach((w) => w.close()); });
  await wait(500);
  ok((await notice(d)).includes('手机已断开'), `手机断线：电脑上提示「${await notice(d)}」`);
  await wait(1000); await m.evaluate(() => { window.__block = false; });
  ok(await reconnected(m), '(手机重连上了)');
  await wait(4000);
  ok(size === phone && (await notice(m)) === '' && (await notice(d)).includes('正在手机上使用'), `手机断线几秒又连上：还是它在用 ${size}，电脑上提示改回「${await notice(d)}」`);

  // 手机锁屏 (页面到后台、连接断开、一直连不上)：5 秒后换给正在看的电脑
  await lock(m); await wait(1000);
  ok(size === phone && (await notice(d)).includes('手机已断开'), `手机锁屏：先不换 ${size}，电脑上提示「${await notice(d)}」`);
  await wait(5000);
  ok(size === desk && (await notice(d)) === '', `5 秒后换给电脑：按电脑排版 ${size}，电脑解锁`);

  // 手机亮屏重连：电脑在用，手机锁着 (先来先用)；点了才接管
  await m.evaluate(() => { delete document.hidden; window.__block = false; });
  ok(await reconnected(m), '(手机亮屏后重连上了)');
  ok(size === desk && (await notice(m)).includes('正在电脑上使用'), `手机亮屏重连：电脑在用，手机锁着「${await notice(m)}」，还是电脑的排版`);
  await m.tap('.term.active .owner-notice button'); await wait(1000);
  ok(size === phone && (await notice(d)).includes('正在手机上使用'), `手机点「在本机继续」：按手机排版 ${size}`);
  await browser.close();
});
