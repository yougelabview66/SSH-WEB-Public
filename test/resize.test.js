'use strict';
const { BASE, ok, wait, shot, launch, post, addHost, devices, hostKey } = require('./helpers');
const { Server, utils } = require('ssh2');
let got = '', rows = 0;
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => { const s = acc(); s.on('pty', (a, r, i) => { rows = i.rows; a(); }); s.on('window-change', (a, r, i) => { rows = i.rows; a && a(); });
    s.on('shell', (a) => { const st = a(); st.write('$ '); st.on('data', (d) => { got += d; }); }); }));
}).listen(2230, '127.0.0.1');
(async () => {
  await fetch(BASE + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'R', host: '127.0.0.1', port: 2230, username: 'u', password: 'x' }) });
  const browser = await launch();
  const errors = [];
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'R' }).click(); await wait(1200);
  const st = () => p.evaluate(() => {
    const main = document.querySelector('main').getBoundingClientRect(), b = document.getElementById('deskBar').getBoundingClientRect();
    return { h: document.getElementById('dInput').offsetHeight, top: Math.round(b.top), lift: Math.round(main.bottom - b.bottom), mainH: main.height,
      tabbarBottom: document.getElementById('tabbar').getBoundingClientRect().bottom, terms: document.getElementById('terms').offsetHeight,
      ov: getComputedStyle(document.getElementById('dInput')).overflowY };
  });
  const drag = async (dy) => {
    const g = await p.locator('#dResize').boundingBox();
    const x = g.x + 300, y = g.y + g.height / 2;
    await p.mouse.move(x, y); await p.mouse.down();
    for (let i = 1; i <= 10; i++) { await p.mouse.move(x, y + dy * i / 10); await wait(20); }
    await p.mouse.up(); await wait(300);
  };
  let s = await st(); const rows0 = rows;
  ok(s.h === 40, '默认高度 40px (一行)');
  const cur = await p.evaluate(() => getComputedStyle(document.getElementById('dResize')).cursor);
  ok(cur === 'ns-resize', '上边缘鼠标显示上下调整光标');
  await drag(-80); s = await st();
  ok(Math.abs(s.h - 120) <= 2 && s.lift === 0, `底部：上边缘往上拖 80px → 高 ${s.h}px，仍贴底`);
  ok(rows < rows0, `终端相应变矮 ${rows0} → ${rows} 行`);
  ok(s.ov === 'hidden', '拖高后空输入框没有滚动条');
  ok(await p.evaluate(() => document.activeElement.id) === 'dInput', '拖完焦点在输入框');
  got = ''; await p.keyboard.type('abc'); await p.keyboard.press('Enter'); await wait(300); s = await st();
  ok(got === 'abc\r' && Math.abs(s.h - 120) <= 2, `发送后保持设定高度 ${s.h}px (不缩回 40)`);
  await p.keyboard.type('x\n'.repeat(1)); for (let i = 0; i < 10; i++) await p.keyboard.press('Shift+Enter'); await wait(200); s = await st();
  ok(s.h > 120, `字多了照样自动变高 ${s.h}px`);
  await p.fill('#dInput', ''); await p.evaluate(() => document.getElementById('dInput').dispatchEvent(new Event('input'))); await wait(200);
  await drag(2000); s = await st(); ok(s.h === 40, '往下拖最低 40px');
  await drag(-2000); s = await st(); ok(s.h <= s.mainH * 0.5 + 2, `往上拖最高为 main 一半：${s.h}px`);
  // 抬高模式
  await p.click('#dMode'); await wait(400); s = await st();
  const lift1 = s.lift;
  ok(s.terms >= 118 && s.top >= s.tabbarBottom, `抬高模式下自动限制：终端保留 ${s.terms}px，输入栏距底 ${s.lift}px`);
  await p.dblclick('#dResize', { position: { x: 300, y: 4 } }); await wait(300); s = await st();
  ok(s.h === 40, '双击上边缘恢复 40px');
  const liftA = s.lift; await drag(-100); s = await st();
  ok(Math.abs(s.h - 140) <= 2 && Math.abs(s.lift - liftA) <= 1, `抬高：往上拖 100 → 高 ${s.h}px，下边缘不动 (距底 ${liftA} → ${s.lift})`);
  // 浮动
  await p.click('#dMode'); await wait(400); s = await st();
  const liftF = s.lift; await drag(-60); s = await st();
  ok(Math.abs(s.h - 200) <= 2 && Math.abs(s.lift - liftF) <= 1, `浮动：往上拖 60 → 高 ${s.h}px，下边缘不动`);
  await drag(-2000); s = await st();
  ok(s.top >= s.tabbarBottom - 1, `浮动：拖到最高不超出终端区域 (顶 ${s.top} ≥ ${s.tabbarBottom})`);
  await drag(2000); await drag(-40); s = await st(); const hSaved = s.h;
  // 位置把手仍可用
  const g = await p.locator('#dGrip').boundingBox(); const before = s.lift;
  await p.mouse.move(g.x + 6, g.y + g.height - 10); await p.mouse.down();
  for (let i = 1; i <= 10; i++) { await p.mouse.move(g.x + 6, g.y + g.height - 10 - 5 * i); await wait(20); }
  await p.mouse.up(); await wait(300); s = await st();
  ok(Math.abs(s.lift - before - 50) <= 2 && s.h === hSaved, `左边把手调位置仍正常 (距底 ${before} → ${s.lift})，高度不变`);
  // 刷新保持
  await p.reload(); await p.waitForSelector('.tab'); await wait(1500); s = await st();
  ok(Math.abs(s.h - hSaved) <= 2, `刷新后高度保持 ${s.h}px`);
  ok(await p.evaluate(() => document.getElementById('dSend').offsetHeight) === s.h, '右边按钮和设定的输入框高度一样高');
  // 以前存的默认 60px 当作没设置过 → 40px；拖高过的 (> 60) 保留
  for (const [old, want] of [['60', 40], ['150', 150]]) {
    await p.evaluate((v) => { localStorage.removeItem('sshweb.deskH'); localStorage.setItem('sshweb.deskMinH', v); }, old);
    await p.reload(); await p.waitForSelector('.tab'); await wait(1200); s = await st();
    ok(Math.abs(s.h - want) <= 2, `老版本存的 ${old}px → ${s.h}px`);
  }
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
