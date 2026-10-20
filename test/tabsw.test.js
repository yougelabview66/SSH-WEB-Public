'use strict';
// 切标签不接管：别的设备在用的标签切过去是锁着的 (镜像显示)，点「在本机继续」才接管、按本机屏幕铺满；
// 自己在用的标签切过去照常铺满。打开 / 刷新页面时在后台的标签 (那时量不出尺寸)，切过去时一样
const { Server } = require('ssh2');
const { BASE, ok, wait, shot, launch, addHost, run, hostKey, devices } = require('./helpers');

const sizes = {}; let nextId = 0;
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    // 只给终端编号 (要了终端尺寸的才算；读钩子事件的 tail 这类通道不算)
    const s = acc(); let id = 0;
    s.on('pty', (a, r, info) => { id = ++nextId; sizes[id] = `${info.cols}×${info.rows}`; a(); });
    s.on('window-change', (a, r, info) => { sizes[id] = `${info.cols}×${info.rows}`; a && a(); });
    s.on('shell', (a) => { a().write(`TAB${id} $ `); });
  }));
}).listen(2298, '127.0.0.1');

// 当前标签：终端占的大小、终端区域大小、标题、有没有「正在 xx 上使用」
const info = (pg) => pg.evaluate(() => {
  const sc = document.querySelector('.term.active .xterm-screen').getBoundingClientRect();
  const box = document.querySelector('.term.active .term-box');
  const n = document.querySelector('.term.active .owner-notice');
  return { w: sc.width, h: sc.height, bw: box.clientWidth, bh: box.clientHeight, tab: document.querySelector('.tab.active .title').textContent, notice: n ? n.textContent : '' };
});
const filled = (f) => f.bw - f.w < 40 && f.bh - f.h < 40;
const desc = (f) => `${f.tab} 终端 ${Math.round(f.w)}×${Math.round(f.h)} / 区域 ${f.bw}×${f.bh}`;
const switchTab = async (pg) => { await pg.locator('.tab:not(.active)').first().click(); await wait(1500); return info(pg); };

run(async () => {
  await addHost('TS', 2298);
  const browser = await launch();
  // 电脑上开两个标签，停在标签 2
  const d = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await d.goto(BASE + '/'); await d.waitForSelector('#app:not(.hidden)');
  await d.locator('.host', { hasText: 'TS' }).first().click(); await d.waitForSelector('.tab.active .dot.ok'); await wait(800);
  await d.locator('.host', { hasText: 'TS' }).first().click(); await wait(1500);
  ok(await d.locator('.tab').count() === 2, '电脑上开了两个标签');
  const deskSize = sizes[2];

  // 手机打开页面：两个标签都是电脑在用，都锁着
  const m = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
  await m.goto(BASE + '/'); await m.waitForSelector('.tab.active .dot.ok'); await wait(2000);
  let f = await info(m);
  ok(f.notice.includes('正在电脑上使用') && sizes[2] === deskSize, `手机打开页面：锁着「${f.notice}」`);
  f = await switchTab(m);
  ok(f.notice.includes('正在电脑上使用') && sizes[1] === deskSize, `手机切到另一个标签 (电脑没在看)：也锁着，不接管 ${sizes[1]}`);

  // 手机点「在本机继续」：接管这个标签、铺满
  await m.tap('.term.active .owner-notice button'); await wait(1200);
  f = await info(m);
  const phoneSize = sizes[1];
  ok(f.notice === '' && filled(f) && phoneSize !== deskSize, `手机点「在本机继续」：接管、铺满 ${desc(f)}，服务端 ${phoneSize}`);
  await m.screenshot({ path: shot('tabsw-phone.png') });

  // 电脑切到被手机接管的标签：锁着
  f = await switchTab(d);
  ok(f.tab.endsWith('-1') && f.notice.includes('正在手机上使用') && sizes[1] === phoneSize, `电脑切到手机在用的标签：锁着「${f.notice}」`);
  await d.screenshot({ path: shot('tabsw-desk.png') });
  // 电脑切回自己在用的标签：照常铺满
  f = await switchTab(d);
  ok(f.tab.endsWith('-2') && f.notice === '' && filled(f) && sizes[2] === deskSize, `电脑切回自己在用的标签：铺满 ${desc(f)}`);

  // 手机刷新页面：自己在用的标签还是它 (同一个浏览器)，切到电脑的标签锁着
  await m.reload(); await m.waitForSelector('.tab.active .dot.ok'); await wait(2000);
  f = await info(m);
  ok(f.tab.endsWith('-1') && f.notice === '' && filled(f) && sizes[1] === phoneSize, `手机刷新页面：标签 1 还是手机在用、铺满 ${desc(f)}`);
  f = await switchTab(m);
  ok(f.tab.endsWith('-2') && f.notice.includes('正在电脑上使用'), `手机切到电脑在用的标签：锁着「${f.notice}」`);
});
