'use strict';
// 重新连接后按当前设备的屏幕尺寸调整终端 (别的设备可能最后改过尺寸)
const { Server } = require('ssh2');
const { BASE, ok, wait, launch, addHost, run, hostKey, devices } = require('./helpers');

const shells = []; // 每次打开 shell 时的尺寸，以及之后的调整
let size = null;
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    let pty = null;
    s.on('pty', (a, r, info) => { pty = { cols: info.cols, rows: info.rows }; a(); });
    s.on('window-change', (a, r, info) => { size = { cols: info.cols, rows: info.rows }; a && a(); });
    s.on('shell', (a) => { const st = a(); shells.push({ st, pty }); size = pty; st.write('$ '); });
  }));
}).listen(2268, '127.0.0.1');

run(async () => {
  await addHost('RS', 2268);
  const browser = await launch();
  const d = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await d.goto(BASE + '/'); await d.waitForSelector('#app:not(.hidden)');
  await d.locator('.host', { hasText: 'RS' }).click(); await d.waitForSelector('.tab.active .dot.ok'); await wait(800);
  const desk = { ...size };
  ok(desk.cols > 100, `电脑打开：${desk.cols}×${desk.rows}`);

  // 手机也打开同一个标签：尺寸变成手机的
  const m = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
  await m.goto(BASE + '/'); await m.waitForSelector('.tab'); await wait(1500);
  ok(size.cols < 80, `手机打开同一个标签：服务器尺寸变成手机的 ${size.cols}×${size.rows}`);
  await m.context().close(); await wait(500);

  // SSH 断开，在电脑上点「重新连接」
  shells[0].st.end(); await wait(1500);
  await d.click('.term.active .reconnect'); await d.waitForSelector('.tab.active .dot.ok'); await wait(1200);
  ok(shells.length === 2, '重新建立了 SSH 连接 (新的 shell)');
  ok(size.cols === desk.cols && size.rows === desk.rows,
    `重新连接后按电脑的屏幕调整：${size.cols}×${size.rows} (新 shell 打开时是 ${shells[1].pty.cols}×${shells[1].pty.rows}，电脑应为 ${desk.cols}×${desk.rows})`);

  // 网页和 NAS 的连接断了又连上 (刷新页面) 也按当前屏幕
  await d.setViewportSize({ width: 1000, height: 700 }); await wait(600);
  const before = { ...size };
  await d.reload(); await d.waitForSelector('.tab.active .dot.ok'); await wait(1200);
  ok(size.cols === before.cols && size.rows === before.rows, `刷新页面重新挂载：尺寸和当前窗口一致 ${size.cols}×${size.rows}`);
  await browser.close();
});
