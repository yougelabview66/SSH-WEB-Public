'use strict';
// 正在用的设备断线 (手机锁屏 / 切到后台，浏览器会断开连接)：其他设备一直锁着 (提示「手机已断开」)、排版不变，点了才换；
// 它在后台重连回来还是使用者；别的设备在这期间接管了的话，它在后台重连不抢，回到前台重连才算最后连上的
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
  await m.goto(BASE + '/'); await m.waitForSelector('.tab.active .dot.ok'); await wait(2000);
  const phone = size;
  ok(phone !== desk && (await notice(d)).includes('正在手机上使用'), `手机打开：按手机排版 ${phone}，电脑上提示「正在手机上使用」`);

  // 手机锁屏断线：电脑上的提示一直留着，排版不变 (以前提示马上消失、10 秒后自动换成电脑的)
  await lock(m); await wait(500);
  ok(!(await m.evaluate(() => !!document.querySelector('.tab.active .dot.ok'))), '(手机断开了)');
  ok((await notice(d)).includes('手机已断开'), `手机锁屏断线：电脑上还锁着，提示「${await notice(d)}」`);
  await wait(11500);
  ok(size === phone && (await notice(d)).includes('手机已断开'), `过了 12 秒：排版还是手机的 ${size}，电脑上还锁着`);

  // 手机在后台重连回来 (还没亮屏)：还是使用者，手机上不提示
  await m.evaluate(() => { window.__block = false; });
  ok(await reconnected(m), '(手机在后台重连上了)');
  ok(size === phone && (await notice(m)) === '' && (await notice(d)).includes('正在手机上使用'), `手机在后台重连：还是它在用 ${size}，手机上不提示，电脑上提示改回「${await notice(d)}」`);

  // 手机又锁屏，这期间电脑点「在本机继续」
  await lock(m); await wait(800);
  await d.click('.term.active .owner-notice button'); await wait(1000);
  ok(size === desk && (await notice(d)) === '', `手机锁屏时电脑点「在本机继续」：按电脑排版 ${size}`);
  // 手机在后台重连：不抢，手机上提示「正在电脑上使用」
  await m.evaluate(() => { window.__block = false; });
  ok(await reconnected(m), '(手机在后台重连上了)');
  ok(size === desk && (await notice(m)).includes('正在电脑上使用'), `手机在后台重连：不抢 ${size}，手机上提示「正在电脑上使用」`);

  // 手机亮屏后才重连上 (锁屏时一直连不上)：它是最后连上的，按手机排版，电脑上提示
  await lock(m); await wait(1500);
  await m.evaluate(() => { delete document.hidden; window.__block = false; });
  ok(await reconnected(m), '(手机亮屏后重连上了)');
  ok(size === phone && (await notice(m)) === '' && (await notice(d)).includes('正在手机上使用'), `手机亮屏重连：按手机排版 ${size}，电脑上提示「正在手机上使用」`);
  await browser.close();
});
