'use strict';
const { BASE, ok, wait, shot, launch, post, addHost, devices, hostKey } = require('./helpers');
const { Server, utils } = require('ssh2');
let got = '', rows = 0;
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => { const s = acc(); s.on('pty', (a, r, i) => { rows = i.rows; a(); }); s.on('window-change', (a, r, i) => { rows = i.rows; a && a(); });
    s.on('shell', (a) => { const st = a(); st.write('$ '); st.on('data', (d) => { got += d; }); }); }));
}).listen(2229, '127.0.0.1');
(async () => {
  await fetch(BASE + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'L', host: '127.0.0.1', port: 2229, username: 'u', password: 'x' }) });
  const browser = await launch();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'L' }).click(); await wait(1200);
  const st = () => p.evaluate(() => {
    const main = document.querySelector('main').getBoundingClientRect(), bar = document.getElementById('deskBar'), b = bar.getBoundingClientRect();
    const sp = document.getElementById('deskSpace');
    return { mode: document.getElementById('dMode').textContent, lift: Math.round(main.bottom - b.bottom), mainH: main.height, barTop: b.top,
      pos: getComputedStyle(bar).position, space: sp.classList.contains('hidden') ? 0 : sp.offsetHeight,
      grip: getComputedStyle(document.getElementById('dGrip')).display !== 'none',
      tabbarBottom: document.getElementById('tabbar').getBoundingClientRect().bottom };
  });
  let s = await st(); const rows0 = rows;
  ok(s.mode === '底部' && s.lift === 0 && !s.grip && s.space === 0, `默认「底部」：贴底，无把手，无留白 (终端 ${rows0} 行)`);
  await p.screenshot({ path: shot('lift-0.png') });
  await p.click('#dMode'); await wait(500); s = await st();
  ok(s.mode === '抬高' && Math.abs(s.lift - s.mainH / 3) < 3 && s.space === s.lift && s.grip && s.pos !== 'absolute', `「抬高」：留白 ${s.space}px ≈ main 的 1/3 (${Math.round(s.mainH / 3)})，显示把手`);
  ok(rows < rows0, `抬高后终端变矮并通知服务器：${rows0} → ${rows} 行`);
  ok(await p.evaluate(() => document.activeElement.id) === 'dInput', '切换后焦点在输入框');
  await p.screenshot({ path: shot('lift-1.png') });
  const rowsLift = rows;
  await p.click('#dMode'); await wait(500); s = await st();
  ok(s.mode === '浮动' && s.pos === 'absolute' && Math.abs(s.lift - s.mainH / 3) < 3 && s.space === 0, `「浮动」：position absolute，距底 ${s.lift}px，无留白`);
  ok(rows >= rows0, `浮动时输入栏不占位置，终端用满整个区域：${rowsLift} → ${rows} 行 (底部模式 ${rows0} 行)`);
  await p.screenshot({ path: shot('lift-2.png') });
  // 浮动下发送 / 命令模式 / 切标签
  got = ''; await p.keyboard.type('echo hi'); await p.keyboard.press('Enter'); await wait(300);
  ok(got === 'echo hi\r', '浮动模式下 Enter 发送');
  got = ''; await p.keyboard.type('/c'); await wait(200); ok(got === '/c' && await p.evaluate(() => document.getElementById('deskBar').classList.contains('cmd')), '浮动模式下命令模式正常');
  await p.keyboard.press('Escape'); await wait(100);
  // 拖动把手 (浮动)
  const drag = async (dy) => {
    const g = await p.locator('#dGrip').boundingBox();
    const x = g.x + g.width / 2, y = g.y + g.height / 2;
    await p.mouse.move(x, y); await p.mouse.down();
    for (let i = 1; i <= 10; i++) { await p.mouse.move(x, y + dy * i / 10); await wait(20); }
    await p.mouse.up(); await wait(300);
  };
  let before = (await st()).lift; await drag(-100); s = await st();
  ok(Math.abs(s.lift - (before + 100)) <= 2, `浮动：向上拖 100px，距底 ${before} → ${s.lift}`);
  await drag(-2000); s = await st();
  ok(s.barTop >= s.tabbarBottom - 1, `浮动：拖到最高被限制，不超出终端区域 (输入栏顶 ${s.barTop} ≥ 标签栏底 ${s.tabbarBottom})`);
  await drag(2000); s = await st(); ok(s.lift === 0, '浮动：拖到最低贴底');
  await drag(-250); s = await st(); const liftF = s.lift;
  ok(liftF > 200, `浮动：拖到距底 ${liftF}px`);
  // 回到抬高，共用同一个位置
  await p.click('#dMode'); await p.click('#dMode'); await wait(400); s = await st();
  ok(s.mode === '抬高' && Math.abs(s.lift - liftF) <= 2, `抬高和浮动共用位置 (${s.lift})`);
  await drag(-2000); s = await st();
  const termH = await p.evaluate(() => document.getElementById('terms').offsetHeight);
  ok(termH >= 118, `抬高：拖到最高时终端仍保留 ${termH}px (≥ 120)`);
  await drag(1000 - 0); await drag(-300); s = await st(); const liftL = s.lift;
  // 刷新后保持
  await p.reload(); await p.waitForSelector('.tab'); await wait(1500); s = await st();
  ok(s.mode === '抬高' && Math.abs(s.lift - liftL) <= 2, `刷新后模式和位置保持 (${s.mode} ${s.lift}px)`);
  // 窗口缩小自动收回
  await p.setViewportSize({ width: 1280, height: 420 }); await wait(500); s = await st();
  const termH2 = await p.evaluate(() => document.getElementById('terms').offsetHeight);
  ok(termH2 >= 118 && s.lift >= 0, `窗口变矮后自动收回：距底 ${s.lift}px，终端 ${termH2}px`);
  await p.setViewportSize({ width: 1280, height: 800 }); await wait(500); s = await st();
  ok(Math.abs(s.lift - liftL) <= 2, `窗口恢复后回到原来位置 (${s.lift})`);
  // × 隐藏留白也消失
  await p.click('#dHide'); await wait(300); s = await st();
  ok(await p.isHidden('#deskBar') && s.space === 0, '× 隐藏输入栏后留白也消失');
  await p.click('#btnInput'); await wait(300); s = await st();
  ok(s.mode === '抬高' && s.space > 0, '重新打开后恢复抬高模式');
  // Alt 切标签
  await p.locator('.host', { hasText: 'L' }).click(); await wait(1200);
  await p.keyboard.press('Alt+1'); await wait(300); s = await st();
  ok(await p.evaluate(() => document.querySelector('.tab.active .title').textContent) === 'L-1' && s.space > 0, 'Alt+1 切换标签，抬高模式保持');
  await p.click('#dMode'); await wait(200);
  // 浮动：每个标签各自记住位置
  const tabT = () => p.evaluate(() => document.querySelector('.tab.active .title').textContent);
  s = await st(); ok(s.mode === '浮动', '切到浮动');
  await drag(2000); const l1 = (await st()).lift;
  await p.keyboard.press('Alt+2'); await wait(300);
  await drag(-300); const l2 = (await st()).lift;
  ok(await tabT() === 'L-2' && l1 === 0 && l2 > 250, `浮动：L-1 拖到贴底 (${l1}px)，L-2 拖到 ${l2}px`);
  await p.keyboard.press('Alt+1'); await wait(300); s = await st();
  ok(await tabT() === 'L-1' && s.lift === l1, `切回 L-1：输入框回到它自己的位置 (${s.lift}px)`);
  await p.keyboard.press('Alt+2'); await wait(300); s = await st();
  ok(Math.abs(s.lift - l2) <= 2, `切到 L-2：回到 L-2 的位置 (${s.lift}px)`);
  await p.reload(); await p.waitForSelector('.tab'); await wait(1500);
  await p.keyboard.press('Alt+1'); await wait(300); const r1 = (await st()).lift;
  await p.keyboard.press('Alt+2'); await wait(300); const r2 = (await st()).lift;
  ok(r1 === l1 && Math.abs(r2 - l2) <= 2, `刷新后每个标签的位置都还在 (L-1 ${r1}px，L-2 ${r2}px)`);
  await p.click('#dMode'); await p.click('#dMode'); await wait(300); s = await st();
  ok(s.mode === '抬高' && Math.abs(s.lift - l2) <= 2, `抬高模式用共用位置 (最近一次拖到的 ${s.lift}px)`);
  await p.click('#dMode'); await wait(200);
  const id2 = await p.evaluate(() => localStorage.getItem('sshweb.active'));
  const had = await p.evaluate((id) => JSON.parse(localStorage.getItem('sshweb.floatLift') || '{}')[id] != null, id2);
  await p.locator('.tab.active .x').click(); await wait(500);
  const left = await p.evaluate((id) => JSON.parse(localStorage.getItem('sshweb.floatLift') || '{}')[id] != null, id2);
  ok(had && !left, '关掉标签后，它记的浮动位置也删掉');
  // 暗色截图
  await p.evaluate(() => document.querySelector('#themeSeg [data-mode=dark]').click()); await wait(300);
  await p.screenshot({ path: shot('lift-dark.png') });
  // 手机
  const m = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage(); m.on('pageerror', (e) => errors.push(e.message));
  await m.goto(BASE + '/'); await m.waitForSelector('.tab'); await wait(1200);
  ok(await m.isHidden('#deskBar') && await m.isHidden('#deskSpace') && await m.isVisible('#mobileBar'), '手机上没有这些按钮和留白，手机输入栏不变');
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
