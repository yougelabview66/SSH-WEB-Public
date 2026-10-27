'use strict';
// 手机长按终端复制：复制面板里按住的那一行就在手指底下 (历史视图里的长按见 lscroll.test.js)
const { BASE, ok, wait, shot, launch, devices, hostKey } = require('./helpers');
const { Server } = require('ssh2');
let rows = 0;
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a, r, info) => { rows = info.rows; a(); });
    s.on('window-change', (a, r, info) => { rows = info.rows; a && a(); });
    s.on('shell', (a) => {
      const st = a();
      // 60 行编号的输出 (第 i 行是 L<i>)，最后是提示符
      for (let i = 1; i <= 60; i++) st.write(`L${i} 这是第 ${i} 行输出\r\n`);
      st.write('$ ');
    });
  }));
}).listen(2237, '127.0.0.1');
(async () => {
  await fetch(BASE + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'C', host: '127.0.0.1', port: 2237, username: 'u', password: 'x' }) });
  const browser = await launch();
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const m = await ctx.newPage(); const errors = []; m.on('pageerror', (e) => errors.push(e.message));
  const cdp = await ctx.newCDPSession(m);
  await m.goto(BASE + '/'); await m.waitForSelector('#app:not(.hidden)');
  await m.tap('#btnToggle'); await m.locator('.host', { hasText: 'C' }).tap(); await wait(1500);
  const sb = await m.locator('.term.active .xterm-screen').boundingBox();
  // 终端停在最底下：缓冲区 61 行 (L1..L60 和提示符)，屏幕上是最后 rows 行
  const top = Math.max(0, 61 - rows);
  for (const frac of [0.45, 0.85]) {
    const y = Math.round(sb.y + sb.height * frac), r = Math.floor((y - sb.y) / (sb.height / rows));
    const want = top + r < 60 ? `L${top + r + 1} ` : '$';
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sb.x + 60, y }] }); await wait(700);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await wait(800); // 等面板过一会儿的再次对齐
    const at = await m.evaluate((y) => {
      // 复制面板里手指高度是哪一行：按页面上这个位置的字算 (数前面有几个换行)
      const pre = document.getElementById('copyText'), x = pre.getBoundingClientRect().left + 20;
      const rg = document.caretRangeFromPoint(x, y), r = document.createRange();
      if (!rg || !pre.contains(rg.startContainer)) return { line: '', shown: !document.getElementById('copyPanel').classList.contains('hidden') };
      r.setStart(pre, 0); r.setEnd(rg.startContainer, rg.startOffset);
      return { line: pre.textContent.split('\n')[(r.toString().match(/\n/g) || []).length], shown: !document.getElementById('copyPanel').classList.contains('hidden') };
    }, y);
    ok(at.shown && at.line.startsWith(want), `长按终端${frac > 0.5 ? '靠下' : '中间'}的「${want.trim()}」：复制面板里手指处是「${at.line}」`);
    await m.screenshot({ path: shot(`copy-${frac}.png`) });
    await m.tap('#copyClose'); await wait(300);
  }
  ok(rows > 10, `终端 ${rows} 行`);
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
