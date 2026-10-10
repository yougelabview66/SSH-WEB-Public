'use strict';
// 切到一个标签：原来的使用者没在看它 (在别的标签 / 不在用)，这台直接接管、按本机屏幕铺满；还在看就锁着 (镜像只看)。
// 使用者切走了 (不看这个标签了)，5 秒后换给正在看它的设备。打开 / 刷新页面时在后台的标签 (那时量不出尺寸)，切过去时一样
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
  // 电脑上开两个标签，停在标签 2
  const d = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await d.goto(BASE + '/'); await d.waitForSelector('#app:not(.hidden)');
  await d.locator('.host', { hasText: 'TS' }).first().click(); await d.waitForSelector('.tab.active .dot.ok'); await wait(800);
  await d.locator('.host', { hasText: 'TS' }).first().click(); await wait(1500);
  ok(await d.locator('.tab').count() === 2, '电脑上开了两个标签');
  const deskSize = sizes[2];

  // 手机打开页面 (停在标签 2，电脑正在看)：锁着，还是电脑的排版
  const m = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
  await m.goto(BASE + '/'); await m.waitForSelector('.tab.active .dot.ok'); await wait(2000);
  let f = await info(m);
  ok(f.tab.endsWith('-2') && f.notice.includes('正在电脑上使用') && sizes[2] === deskSize, `手机打开页面：电脑正在看这个标签，手机锁着「${f.notice}」`);

  // 手机切到标签 1 (电脑没在看)：直接接管，铺满
  f = await switchTab(m);
  const phoneSize = sizes[1];
  ok(f.tab.endsWith('-1') && filled(f) && f.notice === '' && phoneSize !== deskSize, `手机切到电脑没在看的标签：直接接管、铺满 ${desc(f)}，服务端 ${phoneSize}`);
  await m.screenshot({ path: shot('tabsw-phone.png') });

  // 电脑切到标签 1 (手机正在看)：电脑锁着；标签 2 电脑不看了，但手机也没在看它，不换
  f = await switchTab(d);
  ok(f.tab.endsWith('-1') && f.notice.includes('正在手机上使用') && sizes[1] === phoneSize, `电脑切到手机正在看的标签：锁着「${f.notice}」，还是手机的 ${sizes[1]}`);
  await d.screenshot({ path: shot('tabsw-desk.png') });

  // 手机切到标签 2：电脑不在看 2 → 手机接管 2；手机不看 1 了 → 5 秒后换给正在看 1 的电脑
  f = await switchTab(m);
  ok(f.tab.endsWith('-2') && filled(f) && f.notice === '' && sizes[2] === phoneSize, `手机切到标签 2：直接接管、铺满 ${desc(f)}`);
  await wait(5000);
  f = await info(d);
  ok(f.notice === '' && filled(f) && sizes[1] === deskSize, `手机切走 5 秒后：标签 1 换给正在看的电脑、铺满 ${desc(f)}，服务端 ${sizes[1]}`);

  // 手机刷新页面 (停在标签 2，没人在看别的)：还是手机在用；切到标签 1 (电脑正在看)：锁着
  await m.reload(); await m.waitForSelector('.tab.active .dot.ok'); await wait(2000);
  f = await info(m);
  ok(f.tab.endsWith('-2') && filled(f) && f.notice === '', `手机刷新页面：标签 2 还是手机在用、铺满 ${desc(f)}`);
  f = await switchTab(m);
  ok(f.tab.endsWith('-1') && f.notice.includes('正在电脑上使用') && sizes[1] === deskSize, `手机切到电脑正在看的标签：锁着「${f.notice}」`);
});
