'use strict';
const { BASE, ok, wait, shot, launch, post, addHost, devices } = require('./helpers');
const { Server, utils } = require('ssh2');
new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => { const s = acc(); s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { const st = a(); st.write('$ '); }); }));
}).listen(2232, '127.0.0.1');
(async () => {
  await fetch(BASE + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'B', host: '127.0.0.1', port: 2232, username: 'u', password: 'x' }) });
  const browser = await launch();
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'B' }).click(); await wait(1200);
  await p.click('#dInput'); for (let i = 0; i < 6; i++) { await p.keyboard.type('line ' + i); await p.keyboard.press('Shift+Enter'); } await wait(200);
  const r = await p.evaluate(() => ['dInput', 'dSend', 'dMode', 'dHide'].map((id) => [id, Math.round(document.getElementById(id).getBoundingClientRect().top), document.getElementById(id).offsetHeight]));
  console.log(JSON.stringify(r));
  ok(r.every(([, t]) => t === r[0][1]), '输入框变高后右边按钮和输入框顶部对齐');
  ok(r[1][2] === 60 && r[3][2] === 60, '按钮高度仍是 60px');
  ok(await p.evaluate(() => document.getElementById('dMode').textContent) === '底部', '模式按钮只显示「底部」');
  await p.screenshot({ path: shot('btntop.png') });
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
