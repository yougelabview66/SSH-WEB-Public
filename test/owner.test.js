'use strict';
// 一个标签同一时间只有一台设备在用：最先用的客户端锁定这个标签，别的设备打开都锁着 —— 镜像显示 (按使用者的行列缩放)、
// 不能输入，只有点弹窗里的「在本机继续」才接管；使用者到后台 / 关掉页面也不自动换。使用者自己刷新页面还是它
// (断线 / 锁屏见 ownerlock.test.js，切标签见 tabsw.test.js)
const { Server } = require('ssh2');
const { BASE, ok, wait, shot, launch, addHost, run, hostKey, devices } = require('./helpers');

let size = null; let changes = []; let got = '';
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a, r, info) => { size = { cols: info.cols, rows: info.rows }; a(); });
    s.on('window-change', (a, r, info) => { size = { cols: info.cols, rows: info.rows }; changes.push(size); a && a(); });
    s.on('shell', (a) => { const st = a(); for (let i = 1; i <= 30; i++) st.write(`line ${i} ` + '一二三四五六七八九十'.repeat(3) + '\r\n'); st.write('$ '); st.on('data', (d) => { got += d; }); });
  }));
}).listen(2277, '127.0.0.1');

const notice = (pg) => pg.evaluate(() => document.querySelector('.term.active .owner-notice')?.textContent || '');
// 镜像显示：终端按使用者的行列排、整体缩放
const mirror = (pg) => pg.evaluate(() => {
  const x = document.querySelector('.term.active .xterm');
  return { on: document.querySelector('.term.active .term-box').classList.contains('mirror'), scale: x.style.transform, w: x.getBoundingClientRect().width, bw: document.querySelector('.term.active .term-box').clientWidth };
});
// 页面到后台 / 回到前台 (浏览器切到别的标签、最小化、手机锁屏)
const setHidden = (pg, h) => pg.evaluate((h) => {
  if (h) Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  else delete document.hidden;
  document.dispatchEvent(new Event('visibilitychange'));
}, h);

run(async () => {
  await addHost('OW', 2277);
  const browser = await launch();
  const d = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await d.goto(BASE + '/'); await d.waitForSelector('#app:not(.hidden)');
  await d.locator('.host', { hasText: 'OW' }).click(); await d.waitForSelector('.tab.active .dot.ok'); await wait(1000);
  const desk = { ...size };
  const s = () => `${size.cols}×${size.rows}`;
  ok(await notice(d) === '', '只有一台设备：不锁');

  // 电脑在用时手机打开：手机锁住，镜像只看，排版还是电脑的
  const m = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
  await m.goto(BASE + '/'); await m.waitForSelector('.tab.active .dot.ok'); await wait(2000);
  ok(size.cols === desk.cols && (await notice(m)).includes('正在电脑上使用'), `电脑在用时手机打开：手机锁住「${await notice(m)}」，还是电脑的排版 ${s()}`);
  let mm = await mirror(m);
  ok(mm.on && /scale/.test(mm.scale) && mm.w <= mm.bw + 1, `手机上镜像显示电脑的画面：缩放 ${mm.scale}，宽 ${Math.round(mm.w)} / ${mm.bw}`);
  ok(await m.evaluate(() => document.querySelector('.term.active .xterm-rows, .term.active canvas') !== null), '(终端内容照常显示，不再整块遮住)');
  await m.screenshot({ path: shot('owner-phone.png') });
  // 锁住时发送：发不出去，字留着
  got = '';
  await m.tap('#mInput'); await m.keyboard.type('hi'); await m.keyboard.press('Enter'); await wait(800);
  ok(got === '' && size.cols === desk.cols, `锁住的手机上发送：没发出去 (${JSON.stringify(got)})，排版不变`);

  // 手机点「在本机继续」：按手机排版，电脑锁住、镜像手机的画面
  await m.tap('.term.active .owner-notice button'); await wait(1200);
  const phone = { ...size };
  ok(phone.cols < 80 && (await notice(m)) === '' && !(await mirror(m)).on, `手机点「在本机继续」：按手机排版 ${s()}，手机解锁`);
  ok((await notice(d)).includes('正在手机上使用') && (await mirror(d)).on, `电脑锁住「${await notice(d)}」，镜像手机的画面`);
  await m.tap('#mInput'); await m.keyboard.press('Enter'); await wait(800);
  ok(got.includes('hi'), `接管后回车：刚才留着的字发出去了 (${JSON.stringify(got)})`);
  await d.screenshot({ path: shot('owner-desk.png') });

  // 锁住的电脑上打字：不发出去，提示晃一下
  got = '';
  await d.locator('.term.active .xterm-helper-textarea').focus(); await d.keyboard.type('x'); await wait(600);
  ok(got === '' && size.cols === phone.cols, `锁住的电脑上在终端里打字：没发出去 (${JSON.stringify(got)})`);
  ok(await d.evaluate(() => document.querySelector('.term.active .owner-notice').classList.contains('nudge')), '提示晃一下');
  await d.locator('#dInput').focus(); await d.keyboard.type('hello'); await d.keyboard.press('Enter'); await wait(600);
  ok(got === '' && await d.inputValue('#dInput') === 'hello', '下方输入框按回车：没发出去，字留在输入框里');

  // 电脑：窗口大小变了、切回窗口、刷新页面都不抢 (手机还在用)
  await d.setViewportSize({ width: 1200, height: 780 }); await wait(800);
  await d.evaluate(() => window.dispatchEvent(new Event('focus'))); await wait(1000);
  ok(size.cols === phone.cols, `电脑窗口大小变了、切回窗口：不抢 ${s()}`);
  changes = [];
  await d.reload(); await d.waitForSelector('.tab.active .dot.ok'); await wait(2000);
  ok(changes.length === 0 && (await notice(d)).includes('正在手机上使用'), `电脑刷新页面：还锁着，尺寸一次都没改 (${changes.map((c) => c.cols + '×' + c.rows).join(', ') || '无'})`);

  // 手机切到后台、关掉页面：都不自动换，电脑一直锁着，点了才接管
  await setHidden(m, true); await wait(7000);
  ok(size.cols === phone.cols && (await notice(d)).includes('正在手机上使用'), `手机切到后台 7 秒：不换 ${s()}，电脑还锁着「${await notice(d)}」`);
  await setHidden(m, false);
  await m.context().close(); await wait(7000);
  ok(size.cols === phone.cols && (await notice(d)).includes('手机已断开'), `手机关掉页面 7 秒：不换 ${s()}，电脑上弹窗「${await notice(d)}」`);
  await d.click('.term.active .owner-notice button'); await wait(1000);
  ok(size.cols > 100 && (await notice(d)) === '', `电脑点「在本机继续」：按电脑排版 ${s()}`);

  // 使用者自己刷新页面 / 关掉再打开：还是它，不锁
  changes = [];
  await d.reload(); await d.waitForSelector('.tab.active .dot.ok'); await wait(2000);
  ok((await notice(d)) === '' && changes.length === 0, `电脑 (在用) 刷新页面：还是它在用，不锁，尺寸没改 (${changes.length} 次)`);
  const d2 = await d.context().newPage(); await d.close();
  await d2.goto(BASE + '/'); await d2.waitForSelector('.tab.active .dot.ok'); await wait(2000);
  ok((await notice(d2)) === '', '电脑关掉页面再打开 (同一个浏览器)：还是它在用');
  // 别的设备打开 (使用者不在线也一样)：锁着
  const t = await (await browser.newContext({ ...devices['iPad Mini'] })).newPage();
  await t.goto(BASE + '/'); await t.waitForSelector('.tab.active .dot.ok'); await wait(1500);
  ok((await notice(t)).includes('正在电脑上使用') && size.cols > 100, `平板打开：锁着「${await notice(t)}」`);
  await d2.close(); await wait(1500);
  ok((await notice(t)).includes('电脑已断开'), `电脑关掉页面：平板上「${await notice(t)}」，还锁着`);
  await browser.close();
});
