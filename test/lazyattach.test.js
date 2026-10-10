'use strict';
// 打开页面时在后台的标签先只收状态、不收画面 (最多 5000 行的快照)，切过去时再补画面：
// 标签多时打开更快、更省流量；后台标签的连接状态、主机状态、提示音 (标签闪) 照常
const { Server } = require('ssh2');
const { BASE, ok, wait, launch, addHost, run, hostKey } = require('./helpers');

const streams = [];
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => {
      const st = a(); const id = streams.push(st);
      const lines = [];
      for (let i = 1; i <= 5000; i++) lines.push(`T${id} history line ${i} ` + '彩色的历史输出 abc '.repeat(4));
      st.write(lines.join('\r\n') + `\r\nT${id}-BOTTOM $ `);
    });
  }));
}).listen(2284, '127.0.0.1');

// 统计每条终端连接收到的字节数
const track = () => {
  window.__ws = [];
  const W = window.WebSocket;
  window.WebSocket = class extends W {
    constructor(...a) {
      super(...a); const me = { bytes: 0 }; window.__ws.push(me);
      this.addEventListener('message', (e) => { me.bytes += typeof e.data === 'string' ? e.data.length : e.data.byteLength; });
    }
  };
};
const total = (pg) => pg.evaluate(() => window.__ws.reduce((n, x) => n + x.bytes, 0));
const bottom = (pg) => pg.evaluate(() => {
  const s = document.querySelector('.term.active .xterm-rows'); // DOM 渲染时
  return s ? s.textContent : '';
});

run(async () => {
  await addHost('LZ', 2284);
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // 不用 WebGL 渲染 (画在 canvas 上读不到字)
  await ctx.addInitScript(() => { const gc = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, ...r) { return /webgl/.test(t) ? null : gc.call(this, t, ...r); }; });
  await ctx.addInitScript(track);
  const p = await ctx.newPage();
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'LZ' }).click(); await p.waitForSelector('.tab.active .dot.ok'); await wait(800);
  await p.locator('.host', { hasText: 'LZ' }).click(); await wait(2500);
  ok(await p.locator('.tab').count() === 2, '开了两个标签');

  await p.reload(); await p.waitForSelector('.tab.active .dot.ok'); await wait(2500);
  const first = await total(p);
  ok((await bottom(p)).includes('T2-BOTTOM'), '当前标签显示正常');
  ok(await p.locator('.tab .dot.ok').count() === 2, '后台标签的连接状态照常显示 (绿点)');

  // 后台标签响提示音：标签照常闪
  streams[0].write('\x07'); await wait(1000);
  ok(await p.evaluate(() => [...document.querySelectorAll('.tab')].some((t) => !t.classList.contains('active') && t.classList.contains('ring'))), '后台标签有提示音：标签照常提醒');

  // 切过去：补上画面
  await p.locator('.tab:not(.active)').first().click(); await wait(2500);
  const after = await total(p);
  const kb = (n) => Math.round(n / 1024);
  ok(after - first > 100000 && after - first > first * 0.6,
    `打开页面只收当前标签的画面 (${kb(first)} KB)，切到后台标签时才收它的 (${kb(after - first)} KB)`);
  ok((await bottom(p)).includes('T1-BOTTOM'), '切过去的标签画面完整: ' + (await bottom(p)).slice(-40));
  // 切过去之后的新输出照常
  streams[0].write('\r\nNEW-OUTPUT-AFTER $ '); await wait(800);
  ok((await bottom(p)).includes('NEW-OUTPUT-AFTER'), '之后的新输出照常显示');
  // 切回来再切过去：不再重新要画面
  await p.locator('.tab:not(.active)').first().click(); await wait(800);
  const a2 = await total(p);
  await p.locator('.tab:not(.active)').first().click(); await wait(800);
  ok(await total(p) - a2 < 20000, `看过的标签切回来不再重新收画面 (${await total(p) - a2} 字节)`);
  await browser.close();
});
