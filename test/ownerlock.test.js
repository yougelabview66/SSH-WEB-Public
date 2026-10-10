'use strict';
// 正在用的设备断线 (手机锁屏，浏览器会断开连接)：其他设备上弹窗「手机已断开」，一直锁着不自动换；
// 手机重连回来 (不管多久、在前台还是后台) 还是它在用；断线期间别人点了「在本机继续」，手机回来就锁着
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

  // 手机锁屏 (页面到后台、连接断开、一直连不上)：电脑上「手机已断开」，不自动换
  await lock(m); await wait(7000);
  ok(size === phone && (await notice(d)).includes('手机已断开'), `手机锁屏 7 秒：不换 ${size}，电脑上「${await notice(d)}」`);
  // 手机亮屏重连：还是它在用
  await m.evaluate(() => { delete document.hidden; window.__block = false; });
  ok(await reconnected(m), '(手机亮屏后重连上了)');
  ok(size === phone && (await notice(m)) === '' && (await notice(d)).includes('正在手机上使用'), `手机重连回来：还是它在用 ${size}，电脑上改回「${await notice(d)}」`);

  // 手机又锁屏，这期间电脑点「在本机继续」；手机回来就锁着
  await lock(m); await wait(1000);
  await d.click('.term.active .owner-notice button'); await wait(1000);
  ok(size === desk && (await notice(d)) === '', `手机锁屏时电脑点「在本机继续」：按电脑排版 ${size}`);
  await m.evaluate(() => { delete document.hidden; window.__block = false; });
  ok(await reconnected(m), '(手机重连上了)');
  ok(size === desk && (await notice(m)).includes('正在电脑上使用'), `手机回来：电脑在用，手机锁着「${await notice(m)}」`);

  // 手机锁屏期间电脑关掉了这个标签：手机回来直接关掉标签 (以前显示「后台会话已不存在 (服务可能重启过)」+「重新连接」)
  await lock(m); await wait(800);
  await d.click('.tab.active .x'); await wait(800);
  await m.evaluate(() => { delete document.hidden; window.__block = false; });
  for (let i = 0; i < 30 && await m.locator('.tab').count(); i++) await wait(500);
  ok(await m.locator('.tab').count() === 0 && !(await m.evaluate(() => document.body.textContent.includes('服务可能重启过'))), '锁屏期间标签在电脑上被关掉：手机回来直接关掉这个标签');
  await browser.close();
});
