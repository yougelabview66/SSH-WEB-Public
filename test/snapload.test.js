'use strict';
// 打开 / 刷新页面恢复会话：快照里有几千行滚动记录 (CPU 降速模拟慢电脑)，
// 终端一显示出来就是最底下的实时画面，恢复过程中不闪过历史记录
const { BASE, ok, wait, launch, hostKey } = require('./helpers');
const { Server } = require('ssh2');
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => {
      const st = a();
      const lines = [];
      for (let i = 1; i <= 5000; i++) lines.push(`\x1b[3${i % 7}mhistory line ${i}\x1b[0m ` + '彩色的历史输出 abc '.repeat(4));
      st.write(lines.join('\r\n') + '\r\nLIVE-BOTTOM $ ');
    });
  }));
}).listen(2296, '127.0.0.1');

(async () => {
  await fetch(BASE + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'S', host: '127.0.0.1', port: 2296, username: 'u', password: 'x' }) });
  const browser = await launch();
  const errors = [];
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'S' }).click(); await wait(3000);
  // 每一帧记下：终端看得见 (没被遮住、不透明) 时，屏幕最后一行是什么
  await p.addInitScript(() => {
    // 不用 WebGL 渲染 (画在 canvas 上读不到字)，改用 DOM 渲染，每一行是一个 div
    const gc = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (t, ...r) { return /webgl/.test(t) ? null : gc.call(this, t, ...r); };
    window.__seen = [];
    const tick = () => {
      const x = document.querySelector('.term.active .xterm');
      const box = document.querySelector('.term.active .term-box');
      if (x && box && !box.querySelector('.restoring') && getComputedStyle(x).opacity !== '0') {
        const rows = [...x.querySelectorAll('.xterm-rows > div')].map((d) => d.textContent.trim()).filter(Boolean);
        if (rows.length) window.__seen.push(rows[rows.length - 1].slice(0, 30));
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // 模拟慢一点的电脑 (CPU 降到 1/6)：快照要分好多帧才写完
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  await p.reload(); await wait(8000);
  const seen = await p.evaluate(() => window.__seen);
  const first = seen[0] || '';
  const bad = seen.filter((t) => !t.includes('LIVE-BOTTOM'));
  ok(seen.length > 0 && first.includes('LIVE-BOTTOM'), '刷新后终端一显示出来就是最底下的实时画面: ' + JSON.stringify(first));
  ok(bad.length === 0, `恢复过程中没有闪过历史记录 (看得见的 ${seen.length} 帧里有 ${bad.length} 帧不是实时画面${bad.length ? '，如 ' + JSON.stringify(bad.slice(0, 3)) : ''})`);
  ok(await p.evaluate(() => !document.querySelector('.term.active .restoring')), '恢复完「正在恢复会话…」撤掉');
  ok(await p.evaluate(() => document.activeElement.id) === 'dInput', '恢复后焦点在下方输入框');
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
