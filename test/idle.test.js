'use strict';
// 网页开在前台，但 5 分钟没动鼠标 / 键盘 (人离开了)：告诉服务器「不在前台」，完成通知照常推送；一回来动一下又恢复
const { BASE, ok, wait, launch, hostKey } = require('./helpers');
const { Server } = require('ssh2');
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => { const s = acc(); s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { const st = a(); st.write('$ '); }); }));
}).listen(2255, '127.0.0.1');
(async () => {
  await fetch(BASE + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'IDLE', host: '127.0.0.1', port: 2255, username: 'u', password: 'x' }) });
  const browser = await launch();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // 记下网页发给服务器的 watching 消息
  await ctx.addInitScript(() => {
    window.__watch = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) {
      if (typeof d === 'string' && d.includes('"watching"')) window.__watch.push(JSON.parse(d));
      return send.call(this, d);
    };
  });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.clock.install();
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'IDLE' }).click(); await wait(1500);
  const last = () => p.evaluate(() => window.__watch.at(-1));
  let m = await last();
  ok(m && m.front === true && m.watching === true, '刚打开、正在操作：在前台 (不推送) ' + JSON.stringify(m));
  await p.clock.fastForward(4 * 60 * 1000); await wait(300);
  ok((await last()).front === true, '4 分钟没操作：还算在前台');
  await p.clock.fastForward(2 * 60 * 1000); await wait(300);
  m = await last();
  ok(m.front === false && m.watching === true, '超过 5 分钟没动鼠标 / 键盘：告诉服务器不在前台 (照常推送)，终端排版不受影响 ' + JSON.stringify(m));
  const n = await p.evaluate(() => window.__watch.length);
  await p.clock.fastForward(60 * 1000); await wait(300);
  ok(await p.evaluate(() => window.__watch.length) === n, '一直没人操作：不重复发');
  await p.mouse.move(400, 300); await p.mouse.move(420, 320); await wait(300);
  ok((await last()).front === true, '动一下鼠标：马上恢复成在前台');
  await p.clock.fastForward(6 * 60 * 1000); await wait(300);
  await p.keyboard.press('a'); await wait(300);
  ok((await last()).front === true, '按一下键盘也算回来了');
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
