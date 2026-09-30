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
    return { mode: document.getElementById('dMode').textContent, lift: Math.round(main.bottom - b.bottom), mainH: main.height, barTop: b.top,
      pos: getComputedStyle(bar).position,
      grip: getComputedStyle(document.getElementById('dGrip')).display !== 'none',
      tabbarBottom: document.getElementById('tabbar').getBoundingClientRect().bottom };
  });
  const tabT = () => p.evaluate(() => document.querySelector('.tab.active .title').textContent);
  let s = await st(); const rows0 = rows;
  ok(s.mode === '底部' && s.lift === 0 && !s.grip, `默认「底部」：贴底，无把手 (终端 ${rows0} 行)`);
  ok(await p.evaluate(() => !document.getElementById('deskSpace')), '「抬高」模式和下方留白已去掉');
  await p.screenshot({ path: shot('lift-0.png') });
  await p.click('#dMode'); await wait(500); s = await st();
  ok(s.mode === '浮动' && s.pos === 'absolute' && Math.abs(s.lift - s.mainH / 3) < 3 && s.grip, `点一下直接到「浮动」：盖在终端上，距底 ${s.lift}px ≈ main 的 1/3，显示把手`);
  ok(rows >= rows0, `浮动时输入栏不占位置，终端用满整个区域：${rows} 行 (底部模式 ${rows0} 行)`);
  ok(await p.evaluate(() => document.activeElement.id) === 'dInput', '切换后焦点在输入框');
  await p.screenshot({ path: shot('lift-2.png') });
  await p.click('#dMode'); await wait(300); s = await st();
  ok(s.mode === '底部' && s.lift === 0, '再点一下回到「底部」 (只有两种模式)');
  await p.click('#dMode'); await wait(300);
  // 浮动下发送 / 命令模式
  got = ''; await p.keyboard.type('echo hi'); await p.keyboard.press('Enter'); await wait(300);
  ok(got === 'echo hi\r', '浮动模式下 Enter 发送');
  got = ''; await p.keyboard.type('/c'); await wait(200); ok(got === '/c' && await p.evaluate(() => document.getElementById('deskBar').classList.contains('cmd')), '浮动模式下命令模式正常');
  await p.keyboard.press('Escape'); await wait(100);
  // 拖动把手
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
  // 刷新后保持
  await p.reload(); await p.waitForSelector('.tab'); await wait(1500); s = await st();
  ok(s.mode === '浮动' && Math.abs(s.lift - liftF) <= 2, `刷新后模式和位置保持 (${s.mode} ${s.lift}px)`);
  // 窗口缩小自动收回
  await p.setViewportSize({ width: 1280, height: 420 }); await wait(500); s = await st();
  ok(s.barTop >= s.tabbarBottom - 1 && s.lift >= 0, `窗口变矮后自动收回：距底 ${s.lift}px，不超出终端区域`);
  await p.setViewportSize({ width: 1280, height: 800 }); await wait(500); s = await st();
  ok(Math.abs(s.lift - liftF) <= 2, `窗口恢复后回到原来位置 (${s.lift})`);
  // × 隐藏再打开
  await p.click('#dHide'); await wait(300);
  ok(await p.isHidden('#deskBar'), '× 隐藏输入栏');
  await p.click('#btnInput'); await wait(300); s = await st();
  ok(s.mode === '浮动' && Math.abs(s.lift - liftF) <= 2, '重新打开后恢复浮动模式和位置');
  // ---- 每个标签各自记住模式和浮动位置
  await p.locator('.host', { hasText: 'L' }).click(); await wait(1200);
  s = await st();
  ok(await tabT() === 'L-2' && s.mode === '浮动', '新开的标签用最近一次选的模式 (浮动)');
  await p.click('#dMode'); await wait(300); s = await st();
  ok(s.mode === '底部' && s.lift === 0, 'L-2 切到底部');
  await p.keyboard.press('Alt+1'); await wait(300); s = await st();
  ok(await tabT() === 'L-1' && s.mode === '浮动' && Math.abs(s.lift - liftF) <= 2, `切回 L-1：还是它自己的浮动模式和位置 (${s.lift}px)`);
  await p.keyboard.press('Alt+2'); await wait(300); s = await st();
  ok(s.mode === '底部' && s.lift === 0, '切到 L-2：还是底部');
  // 浮动位置也各自记住
  await p.click('#dMode'); await wait(300); await drag(2000); const l2 = (await st()).lift;
  await p.keyboard.press('Alt+1'); await wait(300); const l1 = (await st()).lift;
  ok(l2 === 0 && Math.abs(l1 - liftF) <= 2, `L-2 浮动拖到贴底 (${l2}px)，L-1 还在自己的位置 (${l1}px)`);
  await p.keyboard.press('Alt+2'); await wait(300); await p.click('#dMode'); await wait(300); // L-2 回到底部
  await p.reload(); await p.waitForSelector('.tab'); await wait(1500);
  await p.keyboard.press('Alt+1'); await wait(300); const r1 = await st();
  await p.keyboard.press('Alt+2'); await wait(300); const r2 = await st();
  ok(r1.mode === '浮动' && Math.abs(r1.lift - liftF) <= 2 && r2.mode === '底部', `刷新后每个标签的模式 / 位置都还在 (L-1 ${r1.mode} ${r1.lift}px，L-2 ${r2.mode})`);
  // 老版本存的「抬高」当作底部
  const idOf = () => p.evaluate(() => localStorage.getItem('sshweb.active'));
  const id2 = await idOf();
  await p.evaluate(() => { localStorage.setItem('sshweb.deskMode', 'lift'); localStorage.setItem('sshweb.deskModes', '{}'); });
  await p.reload(); await p.waitForSelector('.tab'); await wait(1500);
  ok((await st()).mode === '底部', '以前选的「抬高」模式刷新后变成底部');
  // 关掉标签，记的模式 / 位置一起删掉
  await p.click('#dMode'); await wait(300); await drag(-100);
  const had = await p.evaluate((id) => [JSON.parse(localStorage.getItem('sshweb.deskModes') || '{}')[id], JSON.parse(localStorage.getItem('sshweb.floatLift') || '{}')[id]], id2);
  await p.locator('.tab.active .x').click(); await wait(500);
  const left = await p.evaluate((id) => [JSON.parse(localStorage.getItem('sshweb.deskModes') || '{}')[id], JSON.parse(localStorage.getItem('sshweb.floatLift') || '{}')[id]], id2);
  ok(had[0] === 'float' && had[1] != null && left[0] == null && left[1] == null, '关掉标签后，它记的模式和浮动位置也删掉');
  // 暗色截图
  await p.evaluate(() => document.querySelector('#themeSeg [data-mode=dark]').click()); await wait(300);
  await p.screenshot({ path: shot('lift-dark.png') });
  // 手机
  const m = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage(); m.on('pageerror', (e) => errors.push(e.message));
  await m.goto(BASE + '/'); await m.waitForSelector('.tab'); await wait(1200);
  ok(await m.isHidden('#deskBar') && await m.isVisible('#mobileBar'), '手机上没有电脑输入框，手机输入栏不变');
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
