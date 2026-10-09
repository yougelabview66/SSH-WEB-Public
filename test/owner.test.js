'use strict';
// 终端尺寸听使用者的：最新打开 / 刷新页面的设备马上按它排版，其他设备上显示「正在 xx 上使用 · 在本机继续」，
// 它们的尺寸不再改排版；点那个提示、或者在上面打字发送才换回来。断线自动重连、切回窗口都不抢
const { Server } = require('ssh2');
const { BASE, ok, wait, shot, launch, addHost, run, hostKey, devices } = require('./helpers');

let size = null; let changes = [];
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a, r, info) => { size = { cols: info.cols, rows: info.rows }; a(); });
    s.on('window-change', (a, r, info) => { size = { cols: info.cols, rows: info.rows }; changes.push(size); a && a(); });
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
  const notice = (pg) => pg.evaluate(() => { const n = document.querySelector('.term.active .owner-notice'); return n ? n.textContent : ''; });
  ok(await notice(d) === '', '只有一台设备：不显示「正在别的设备上使用」');

  // 手机打开同一个标签：马上按手机排版，电脑上提示被手机占用
  const m = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
  await m.goto(BASE + '/'); await m.waitForSelector('.tab'); await wait(2000);
  const phone = { ...size };
  ok(phone.cols < 80 && desk.cols > 100, `手机打开同一个标签：马上按手机排版 ${s()} (电脑是 ${desk.cols}×${desk.rows})`);
  ok((await notice(d)).includes('正在手机上使用') && (await notice(m)) === '', '电脑上提示「正在手机上使用」，手机上不提示: ' + await notice(d));
  await d.screenshot({ path: shot('owner-desk.png') });

  // 电脑：断线自动重连、窗口大小变了、切回窗口 (获得焦点) 都不抢排版
  await d.evaluate(() => window.__ws.forEach((w) => w.close())); await wait(3000);
  ok(await d.evaluate(() => !!document.querySelector('.tab.active .dot.ok')), '(电脑断线后已经自动重连)');
  ok(size.cols === phone.cols, `电脑断线自动重连：不改排版，还是手机的 ${s()}`);
  await d.setViewportSize({ width: 1200, height: 780 }); await wait(800);
  ok(size.cols === phone.cols, `电脑窗口大小变了：也不改排版 ${s()}`);
  await d.bringToFront(); await d.evaluate(() => window.dispatchEvent(new Event('focus'))); await wait(1200);
  ok(size.cols === phone.cols && (await notice(d)).includes('正在手机上使用'), `切回电脑窗口：不抢排版，还是手机的 ${s()}，提示还在`);

  // 电脑上点「在本机继续」：按电脑排版，手机上提示被电脑占用
  await d.click('.term.active .owner-notice button'); await wait(1000);
  ok(size.cols > 100 && (await notice(d)) === '', `电脑点「在本机继续」：按电脑排版 ${s()}，提示消失`);
  ok((await notice(m)).includes('正在电脑上使用'), '手机上提示「正在电脑上使用」');
  await m.screenshot({ path: shot('owner-phone.png') });

  // 手机开着时电脑刷新页面：尺寸不来回换 (旧页面一关不马上换成手机的，新页面连上还是电脑的)
  changes = [];
  await d.reload(); await d.waitForSelector('.tab.active .dot.ok'); await wait(2000);
  ok(changes.length === 0 && size.cols > 100, `电脑刷新页面：终端尺寸一次都没改 (${changes.map((c) => c.cols + '×' + c.rows).join(', ') || '无'})`);

  // 手机刷新页面 = 最新打开的：马上按手机排版
  await m.reload(); await m.waitForSelector('.tab'); await wait(2500);
  ok(size.cols === phone.cols && size.rows === phone.rows, `手机刷新页面：马上按手机排版 ${s()}`);

  // 在电脑上打字发送：按电脑排版 (不用先点提示)
  await d.locator('.term.active .xterm-helper-textarea').focus(); await d.keyboard.type('x'); await wait(800); // 直接在终端里打字
  ok(size.cols > 100 && (await notice(d)) === '', `在电脑上打字：按电脑排版 ${s()}，提示消失`);
  // 在手机上发送：按手机排版
  await m.tap('#mInput'); await m.keyboard.type('y'); await m.keyboard.press('Enter'); await wait(800);
  ok(size.cols === phone.cols, `在手机上发送内容：按手机排版 ${s()}`);

  // 第三台设备 (平板) 打开：按平板排版，另外两台都提示被平板占用
  const t = await (await browser.newContext({ ...devices['iPad Mini'] })).newPage();
  await t.goto(BASE + '/'); await t.waitForSelector('.tab'); await wait(2000);
  const tablet = { ...size };
  ok(tablet.cols !== phone.cols && tablet.cols !== desk.cols, `平板打开：按平板排版 ${s()}`);
  ok((await notice(d)).includes('正在平板上使用') && (await notice(m)).includes('正在平板上使用'), '电脑、手机都提示「正在平板上使用」');
  await t.reload(); await t.waitForSelector('.tab'); await wait(2500);
  ok(size.cols === tablet.cols, `平板刷新页面：还是按平板 ${s()}`);

  // 正在用的设备关掉页面：等一会儿 (可能只是在刷新) 没人接管，再换成还开着的设备的尺寸
  await t.context().close(); await m.context().close(); await wait(1000);
  ok(size.cols === tablet.cols, `正在用的平板关掉页面后先不换 (刷新的话马上就回来了) ${s()}`);
  ok(await notice(d) === '', '平板关掉了：电脑上马上撤掉「正在平板上使用」(不用等 10 秒)');
  await wait(10000);
  ok(size.cols > 100 && (await notice(d)) === '', `等了 10 秒没人接管：换成还开着的电脑的排版 ${s()}，电脑上的提示消失`);
  await browser.close();
});
