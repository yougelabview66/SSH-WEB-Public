'use strict';
const { BASE, ok, wait, shot, launch, post, addHost, devices, hostKey, waitFor } = require('./helpers');
const { Server, utils } = require('ssh2');
let got = ''; let lastCols = 0;
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => { const s = acc(); s.on('pty', (a, r, info) => { lastCols = info.cols; a(); });
    s.on('window-change', (a, r, info) => { lastCols = info.cols; a && a(); });
    s.on('shell', (a) => { const st = a(); st.write('$ '); st.on('data', (d) => { got += d; }); }); }));
}).listen(2222, '127.0.0.1');
(async () => {
  await fetch(BASE + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'K', host: '127.0.0.1', port: 2222, username: 'u', password: 'x' }) });
  const browser = await launch();
  const errors = [];
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  let m = await ctx.newPage(); m.on('pageerror', (e) => errors.push(e.message));
  await m.goto(BASE + '/'); await m.waitForSelector('#app:not(.hidden)');
  await m.tap('#btnToggle'); await m.locator('.host', { hasText: 'K' }).tap(); await wait(1000);
  const labels = () => m.locator('#mobileBar .mkeys button').allTextContents();
  const DEF = ['历史', 'Esc', 'Tab', 'Shift', 'Ctrl', 'Alt', '↑', '↓', '←', '→', '⌫', 'Home', 'End', 'PgUp', 'PgDn', '|', '/', '-', '~', '^C', '^D', '^Z', '^L', '复制', '粘贴', '⚙'];
  ok(JSON.stringify(await labels()) === JSON.stringify(DEF), '默认按键和顺序与原来一致 (最后多一个 ⚙ 设置)');

  // 编辑
  await m.tap('#mobileBar [data-a=kset]'); await m.waitForSelector('#keysPanel:not(.hidden)');
  await m.screenshot({ path: shot('keys1.png') });
  await m.locator('#keysCur .krow', { hasText: 'Home' }).locator('[data-op=del]').tap();
  await m.locator('#keysCur .krow', { hasText: 'Shift' }).locator('[data-op=del]').tap();
  for (const k of ['^B', 'Esc Esc', 'F5']) await m.locator('#keysAvail button', { hasText: new RegExp('^' + k.replace(/[\^$]/g, '\\$&') + '$') }).tap();
  await m.fill('#kcLabel', '压缩'); await m.fill('#kcSeq', '/compact\\r'); await m.tap('#keysCustom button');
  // 把「压缩」移到第 2 位
  for (let i = 0; i < 30; i++) {
    const rows = await m.locator('#keysCur .krow .kl').allTextContents();
    if (rows.indexOf('压缩') <= 1) break;
    await m.locator('#keysCur .krow', { hasText: '压缩' }).locator('[data-op=up]').tap();
  }
  await m.tap('#keysSave'); await wait(400);
  const now = await labels();
  ok(now[1] === '压缩' && !now.includes('Home') && !now.includes('Shift') && now.includes('^B') && now.includes('Esc Esc') && now.includes('F5'),
    '保存后按键栏更新: ' + now.join(' '));
  got = '';
  await m.tap('#mobileBar .mkeys button:has-text("压缩")'); await wait(200);
  ok(got === '/compact\r', '自定义按键发送 /compact + 回车');
  got = ''; await m.tap('#mobileBar [data-k="^b"]'); await wait(150);
  ok(got === '\x02', '^B 发送 tmux 前缀 (\\x02)');
  got = ''; await m.tap('#mobileBar [data-k=escesc]'); await wait(150);
  ok(got === '\x1b\x1b', 'Esc Esc 发送两次 Esc');
  got = ''; await m.tap('#mobileBar [data-k=f5]'); await wait(150);
  ok(got === '\x1b[15~', 'F5 发送 \\x1b[15~');
  got = ''; await m.tap('#mobileBar [data-mod=ctrl]'); await m.tap('#mobileBar [data-k=right]'); await wait(150);
  ok(got === '\x1b[1;5C', '删掉 Shift 后 Ctrl 组合键仍正常');
  // 重新打开 (换设备) 仍保持
  const m2 = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage(); m2.on('pageerror', (e) => errors.push(e.message));
  await m2.goto(BASE + '/'); await waitFor(m2, () => document.querySelectorAll('.tab').length === 1);
  await wait(500);
  ok(JSON.stringify(await m2.locator('#mobileBar .mkeys button').allTextContents()) === JSON.stringify(now), '设置保存在服务端，另一台设备打开也一样');
  await m2.context().close();
  await m.tap('.term.active .owner-notice button'); await wait(500); // 另一台手机打开过 (那时它在用)：这台被锁住，点一下接管
  // 恢复默认
  await m.tap('#mobileBar [data-a=kset]'); m.once('dialog', (d) => d.accept()); await m.tap('#keysReset'); await m.tap('#keysSave'); await wait(400);
  ok(JSON.stringify(await labels()) === JSON.stringify(DEF), '「恢复默认」回到原来的按键和顺序');

  // 双指捏合调字体
  const cdp = await ctx.newCDPSession(m);
  const box = await m.locator('.term.active .term-box').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + 300;
  const pinch = async (from, to) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx - from, y: cy, id: 1 }, { x: cx + from, y: cy, id: 2 }] });
    for (let i = 1; i <= 10; i++) { const d = from + (to - from) * i / 10; await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - d, y: cy, id: 1 }, { x: cx + d, y: cy, id: 2 }] }); await wait(20); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await wait(500);
  };
  const fs0 = await m.evaluate(() => parseInt(localStorage.getItem('sshweb.fontSize') || '12', 10));
  const cols0 = lastCols;
  await pinch(60, 120);
  const fs1 = await m.evaluate(() => parseInt(localStorage.getItem('sshweb.fontSize'), 10));
  ok(fs1 > fs0 && lastCols < cols0, `双指张开 → 字体变大 ${fs0} → ${fs1}，终端每行 ${cols0} → ${lastCols} 列 (已通知服务器)`);
  await pinch(120, 40);
  const fs2 = await m.evaluate(() => parseInt(localStorage.getItem('sshweb.fontSize'), 10));
  ok(fs2 < fs1 && lastCols > cols0 - 1, `双指捏合 → 字体变小 ${fs1} → ${fs2}，每行 ${lastCols} 列`);
  await pinch(100, 5);
  ok(await m.evaluate(() => parseInt(localStorage.getItem('sshweb.fontSize'), 10)) === 8, '最小限制 8');
  got = '';
  ok(got === '' && await m.isHidden('#copyPanel'), '捏合不会误触发长按复制 / 发送按键');
  await m.reload(); await waitFor(m, () => document.querySelectorAll('.tab').length === 1); await wait(800);
  ok((await m.textContent('#fontLabel')) === '8', '刷新后保持字体大小');
  await m.tap('#btnToggle'); await m.tap('#fontInc'); await m.tap('#fontInc');
  ok((await m.textContent('#fontLabel')) === '10', '侧边栏 A+ 调大字体');
  await m.tap('#terms', { position: { x: 400, y: 300 } }); await wait(300); // 点右侧终端区域关闭侧边栏
  await pinch(60, 90);
  await m.screenshot({ path: shot('keys2.png') });
  console.log('页面错误:', errors.length ? errors : '无');
  await browser.close(); process.exit();
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
