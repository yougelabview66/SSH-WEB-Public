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
    // 复制完取消选中、退出编辑 (iPhone 上选区和焦点留着，第二次长按就选不上)：「复制选中」按钮和系统菜单的「拷贝」都是
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    const pick = () => m.evaluate(() => { const p = document.getElementById('copyText'); p.focus(); const r = document.createRange(); r.selectNodeContents(p.querySelector('div') || p);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString().length; });
    const state = () => m.evaluate(() => ({ sel: getSelection().toString().length, focus: document.activeElement?.id || '' }));
    const n1 = await pick();
    await m.locator('#copySel').tap(); await wait(300);
    const s1 = await state();
    const n2 = await pick();
    await m.evaluate(() => document.getElementById('copyText').dispatchEvent(new ClipboardEvent('copy', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true })));
    await wait(100);
    const s2 = await state();
    ok(n1 > 0 && n2 > 0 && !s1.sel && s1.focus !== 'copyText' && !s2.sel && s2.focus !== 'copyText',
      `手机：复制后取消选中、退出编辑 (按钮：选中 ${s1.sel} 字、焦点 ${s1.focus || '无'}；系统拷贝：选中 ${s2.sel} 字、焦点 ${s2.focus || '无'})`);
    // 选着字时轻点任何地方都复位 (字上、标题)，复位后照样可编辑；长按、拖动不算轻点
    const touch = async (sel, ms) => {
      const b = await m.locator(sel).first().boundingBox(), x = b.x + Math.min(30, b.width / 2), y = b.y + Math.min(20, b.height / 2);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }); await wait(ms);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await wait(150);
    };
    const full = () => m.evaluate(() => ({ sel: getSelection().toString().length, focus: document.activeElement?.id || '', ce: document.getElementById('copyText').isContentEditable }));
    await pick(); await touch('#copyText', 80); const t1 = await full();
    await pick(); await touch('#copyPanel h3', 80); const t2 = await full();
    await pick(); await touch('#copyText', 600); const t3 = await full();
    ok(!t1.sel && t1.focus !== 'copyText' && t1.ce, `手机：选着字轻点字上，取消选中、退出编辑、仍可编辑 ${JSON.stringify(t1)}`);
    ok(!t2.sel && t2.focus !== 'copyText' && t2.ce, `手机：选着字轻点标题，取消选中、退出编辑 ${JSON.stringify(t2)}`);
    ok(t3.sel > 0, `手机：长按不算轻点，选中的字还在 (${t3.sel} 字)`);
    await m.evaluate(() => { getSelection().removeAllRanges(); document.getElementById('copyText').blur(); });
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
