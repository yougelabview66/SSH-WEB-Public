'use strict';
const { BASE, ok, wait, shot, launch, post, addHost, devices, hostKey } = require('./helpers');
const { Server, utils } = require('ssh2');
let got = '';
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => { const s = acc(); s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { const st = a(); st.write('$ '); st.on('data', (d) => { got += d; }); }); }));
}).listen(2228, '127.0.0.1');
(async () => {
  await fetch(BASE + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'T', host: '127.0.0.1', port: 2228, username: 'u', password: 'x' }) });
  const browser = await launch();
  const errors = [];
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  for (let i = 0; i < 3; i++) { await p.locator('.host', { hasText: 'T' }).click(); await wait(1000); }
  const act = () => p.evaluate(() => document.querySelector('.tab.active .title').textContent);
  const url0 = p.url();
  ok(await act() === 'T-3', '三个标签，当前是 T-3');
  got = '';
  await p.keyboard.press('Alt+1'); await wait(200); ok(await act() === 'T-1', 'Alt+1 → T-1');
  await p.keyboard.press('Alt+2'); await wait(200); ok(await act() === 'T-2', 'Alt+2 → T-2');
  await p.keyboard.press('Alt+ArrowRight'); await wait(200); ok(await act() === 'T-3', 'Alt+→ → T-3');
  await p.keyboard.press('Alt+ArrowRight'); await wait(200); ok(await act() === 'T-1', 'Alt+→ 在最后一个时循环到 T-1');
  await p.keyboard.press('Alt+ArrowLeft'); await wait(200); ok(await act() === 'T-3', 'Alt+← 在第一个时循环到 T-3');
  await p.keyboard.press('Alt+9'); await wait(200); ok(await act() === 'T-3', 'Alt+9 (没有第 9 个) 不变');
  await wait(300);
  ok(got === '', '快捷键没有发给终端: ' + JSON.stringify(got));
  ok(p.url() === url0, 'Alt+← 没有触发浏览器后退');
  ok(await p.evaluate(() => document.activeElement.id) === 'dInput', '切换后焦点在输入框');
  // 在终端里 (xterm 获得焦点) 也能用
  await p.locator('.term.active .term-box').click({ position: { x: 300, y: 200 } }); await wait(200);
  got = ''; await p.keyboard.press('Alt+1'); await wait(300);
  ok(await act() === 'T-1' && got === '', '焦点在终端里时 Alt+1 也能切换，且不发给终端');
  await p.locator('.term.active .term-box').click({ position: { x: 300, y: 200 } }); await wait(200);
  got = ''; await p.keyboard.press('Alt+b'); await wait(300);
  ok(got === '\x1bb', '其他 Alt 组合键 (Alt+b) 照常发给终端');
  // 按界面顺序 (模拟拖动排序后)
  await p.evaluate(() => { const t = document.getElementById('tabs'); t.appendChild(t.querySelector('.tab')); });
  await p.keyboard.press('Alt+1'); await wait(200); ok(await act() === 'T-2', '按界面上的标签顺序 (T-1 拖到最后后 Alt+1 → T-2)');
  await p.keyboard.press('Alt+3'); await wait(200); ok(await act() === 'T-1', 'Alt+3 → 排在第 3 的 T-1');
  // 弹窗打开时不切换
  await p.click('#btnHistory'); await wait(400);
  await p.keyboard.press('Alt+1'); await wait(200); ok(await act() === 'T-1', '历史命令窗口打开时不切换');
  await p.keyboard.press('Escape'); await wait(200);
  // 命令模式下切换后退出
  await p.click('#dInput'); await p.keyboard.type('/c'); await wait(100);
  await p.keyboard.press('Alt+1'); await wait(200);
  ok(await act() === 'T-2' && !(await p.evaluate(() => document.getElementById('deskBar').classList.contains('cmd'))), '命令模式下切换标签后退出命令模式');
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
