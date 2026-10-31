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
    // iPhone 把挂着鼠标点击监听的元素 (连同里面的东西) 当成「能点的按钮」，长按不选词、要长按再拖才选得上；tabindex 同理。
    // 复制面板的文字和它外面的每一层 (到 body 为止) 都不能有
    const clicky = [];
    for (let i = 0; ; i++) {
      const { result } = await cdp.send('Runtime.evaluate', { expression: `(() => { let e = document.getElementById('copyText'); for (let k = 0; k < ${i}; k++) e = e.parentElement; return e === document.body ? null : e; })()` });
      if (!result.objectId) break;
      const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
      const bad = listeners.filter((l) => ['click', 'mousedown', 'mouseup', 'dblclick'].includes(l.type)).map((l) => l.type);
      const ti = await m.evaluate((k) => { let e = document.getElementById('copyText'); for (let j = 0; j < k; j++) e = e.parentElement; return e.getAttribute('tabindex'); }, i);
      if (bad.length || ti != null) clicky.push(`第 ${i} 层 ${bad.join('/')}${ti != null ? ' tabindex' : ''}`);
    }
    ok(clicky.length === 0, `手机：复制面板的文字和外层都不挂点击监听、没有 tabindex，iPhone 长按就能选词 ${clicky.join('；')}`);
    // 手机上可编辑 (iPhone 才显示选中的高亮和「拷贝」菜单)、不弹键盘、改不了
    const before = await m.evaluate(() => { const p = document.getElementById('copyText'); p.focus(); return { t: p.textContent, ce: p.isContentEditable, im: p.inputMode }; });
    await cdp.send('Input.insertText', { text: 'ZZZ' });
    await m.keyboard.press('Backspace'); await m.keyboard.press('Enter'); await wait(200);
    const after = await m.evaluate(() => { const p = document.getElementById('copyText'); p.blur(); return p.textContent; });
    ok(before.ce && before.im === 'none' && after === before.t, `手机：复制面板可编辑 (${before.ce})、不弹键盘 (inputmode=${before.im})，打字 / 删除 / 回车都改不了内容 (${after === before.t ? '没变' : '变了'})`);
    await m.screenshot({ path: shot(`copy-${frac}.png`) });
    await m.tap('#copyClose'); await wait(300);
  }
  ok(rows > 10, `终端 ${rows} 行`);
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  // 复制面板打开期间不自动放大：iPhone 上聚焦小于 16px 的可编辑区域会放大页面 (只给苹果设备加，安卓上会连双指缩放一起关掉)
  const vp = (p) => p.evaluate(() => document.querySelector('meta[name=viewport]').content);
  const android = await vp(m);
  await m.locator('.mkeys button[data-k=copy]').tap(); await wait(300);
  ok(!(await vp(m)).includes('maximum-scale') && android === await vp(m), `安卓：打开复制面板不改缩放设置 (${await vp(m)})`);
  await m.tap('#copyClose');
  const ictx = await browser.newContext({ ...devices['iPhone 13'] });
  const ip = await ictx.newPage();
  await ip.goto(BASE + '/'); await ip.waitForSelector('#app:not(.hidden)');
  await ip.tap('#btnToggle'); await ip.locator('.host', { hasText: 'C' }).first().tap(); await wait(1500);
  const base = await vp(ip);
  await ip.locator('.mkeys button[data-k=copy]').tap(); await wait(300);
  const open = await vp(ip);
  await ip.tap('#copyClose'); await wait(200);
  const closed = await vp(ip);
  ok(open.includes('maximum-scale=1') && closed === base, `iPhone：复制面板打开时不自动放大 (${open})，关掉后恢复 (${closed})`);
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
