'use strict';
// 电脑上选中就复制：在终端里用鼠标拖动选中 / 双击选词，松开就复制到剪贴板 (同 tmux 开了鼠标时)，
// 没有 tmux 的会话 (Windows 常驻会话、直接的 shell) 也一样；只是点一下 (没选中) 不动剪贴板
const { BASE, ok, wait, launch, hostKey, addHost } = require('./helpers');
const { Server } = require('ssh2');
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { const st = a(); setTimeout(() => st.write('\x1b[2J\x1b[Hhello-copy-world second-word\r\nPS C:\\Users\\demo> '), 300); });
  }));
}).listen(2338, '127.0.0.1');

(async () => {
  await addHost('SC', 2338);
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  // 记下网页发给服务端的终端大小 (算一个字多宽多高)
  await ctx.addInitScript(() => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) { try { const m = typeof d === 'string' && JSON.parse(d); if (m && m.cols && m.rows) window.__size = m; } catch {} return send.call(this, d); };
  });
  const p = await ctx.newPage(); const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'SC' }).first().click(); await p.waitForSelector('.tab.active .dot.ok'); await wait(800);
  const clip = () => p.evaluate(() => navigator.clipboard.readText());
  await p.evaluate(() => navigator.clipboard.writeText('before'));
  const sb = await p.locator('.term.active .xterm-screen').boundingBox();
  const size = await p.evaluate(() => window.__size);
  const cell = { w: sb.width / size.cols, h: sb.height / size.rows };
  const y = sb.y + cell.h / 2;
  // 拖动选中第一行开头的 hello-copy-world (16 个字)
  await p.mouse.move(sb.x + 1, y); await p.mouse.down(); await p.mouse.move(sb.x + cell.w * 16 - 1, y, { steps: 6 }); await p.mouse.up(); await wait(400);
  ok(await clip() === 'hello-copy-world', '拖动选中，松开就复制: ' + JSON.stringify(await clip()));
  ok(await p.isVisible('.term.active .font-toast'), '提示「已复制」');
  // 双击选词
  await p.mouse.dblclick(sb.x + cell.w * 20, y); await wait(400);
  ok(await clip() === 'second-word', '双击选词也复制: ' + JSON.stringify(await clip()));
  // 只是点一下：剪贴板不变
  await p.evaluate(() => navigator.clipboard.writeText('keep'));
  await p.mouse.click(sb.x + cell.w * 5, y + cell.h); await wait(400);
  ok(await clip() === 'keep', '只点一下 (没选中)：不动剪贴板');
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
