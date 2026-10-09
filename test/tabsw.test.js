'use strict';
// 切到哪个标签，就由这台设备接管那个标签的排版 (终端按这台设备的屏幕铺满)，其他设备上显示「正在 xx 上使用」。
// 打开 / 刷新页面时在后台的标签 (那时量不出尺寸)，切过去时也一样接管
const { Server } = require('ssh2');
const { BASE, ok, wait, shot, launch, addHost, run, hostKey, devices } = require('./helpers');

const sizes = {}; let nextId = 0;
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc(); const id = ++nextId;
    s.on('pty', (a, r, info) => { sizes[id] = `${info.cols}×${info.rows}`; a(); });
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
  // 电脑上开两个标签
  const d = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await d.goto(BASE + '/'); await d.waitForSelector('#app:not(.hidden)');
  await d.locator('.host', { hasText: 'TS' }).first().click(); await d.waitForSelector('.tab.active .dot.ok'); await wait(800);
  await d.locator('.host', { hasText: 'TS' }).first().click(); await wait(1500);
  ok(await d.locator('.tab').count() === 2, '电脑上开了两个标签');
  const deskSize = sizes[2];

  // 手机打开页面 (电脑还开着)：当前标签按手机排版；另一个标签在后台，还是电脑的
  const m = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
  await m.goto(BASE + '/'); await m.waitForSelector('.tab.active .dot.ok'); await wait(2000);
  const mf = await info(m);
  ok(filled(mf) && mf.notice === '', `手机打开页面：当前标签铺满 ${desc(mf)}`);
  const phoneSize = sizes[2];
  ok(phoneSize !== deskSize && sizes[1] === deskSize, `当前标签按手机排版 ${phoneSize}，后台标签还是电脑的 ${sizes[1]}`);

  // 手机切到后台的标签：接管它，铺满
  let f = await switchTab(m);
  ok(filled(f) && f.notice === '' && sizes[1] === phoneSize, `手机切到后台标签：按手机排版、铺满 ${desc(f)}，服务端 ${sizes[1]}`);
  await m.screenshot({ path: shot('tabsw-phone.png') });

  // 电脑上切标签：切到哪个就接管哪个 (之前被手机占着)，手机那边显示「正在电脑上使用」
  f = await switchTab(d);
  ok(f.tab.endsWith('-1') && filled(f) && f.notice === '' && sizes[1] === deskSize, `电脑切到被手机占着的标签：按电脑排版、铺满 ${desc(f)}，服务端 ${sizes[1]}`);
  ok((await info(m)).notice.includes('正在电脑上使用'), '手机上这个标签显示「正在电脑上使用」');
  f = await switchTab(d);
  ok(f.tab.endsWith('-2') && filled(f) && f.notice === '' && sizes[2] === deskSize, `电脑再切回另一个标签：也接管 ${desc(f)}，服务端 ${sizes[2]}`);
  await d.screenshot({ path: shot('tabsw-desk.png') });

  // 手机刷新页面：当前标签接管；切到后台标签也接管
  await m.reload(); await m.waitForSelector('.tab.active .dot.ok'); await wait(2000);
  f = await info(m);
  ok(filled(f) && f.notice === '', `手机刷新页面：当前标签铺满 ${desc(f)}`);
  f = await switchTab(m);
  ok(filled(f) && f.notice === '' && sizes[1] === phoneSize && sizes[2] === phoneSize, `手机刷新后切到后台标签：按手机排版、铺满 ${desc(f)}，服务端 ${JSON.stringify(sizes)}`);

  // 只是切走 (没切到它) 的标签不抢：电脑上停在标签 2，手机切来切去时标签 2 不会被电脑抢回来
  const before = sizes[2];
  f = await switchTab(m); await wait(500);
  ok(sizes[2] === before, `电脑那边没操作：手机切走后标签 2 还是手机的 ${sizes[2]}`);
});
