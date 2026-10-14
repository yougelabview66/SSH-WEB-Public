'use strict';
// 服务重启后标签以服务端为准：电脑上开着昨天的 2 个标签，服务重启后手机新开 2 个，电脑上只剩手机开的 2 个
// (以前旧的 2 个留着提示「后台会话已不存在」，加上同步过来的 2 个变成 4 个)
// 要重启服务，所以这个测试自己启动一个服务 (固定端口、同一个数据目录重启两次)，不用 run.js 起的那个
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { Server } = require('ssh2');
const { ok, wait, launch, run, hostKey, waitFor, devices } = require('./helpers');

new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('error', () => {}); // 服务被杀掉时连接断开
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => a().write('$ '));
  }));
}).listen(2238, '127.0.0.1');

const ROOT = path.join(__dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-test-'));
let srv = null;
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
async function start(port) {
  srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: data, HOSTKEY_POLICY: 'off', AUTH_PASSWORD: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return; } catch {}
    await wait(150);
  }
  throw new Error('服务没有启动');
}
const stop = () => new Promise((resolve) => { srv.once('exit', resolve); srv.kill(); });
process.on('exit', () => { try { srv && srv.kill(); } catch {} fs.rmSync(data, { recursive: true, force: true }); });

run(async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  await start(port);
  await fetch(base + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'RS', host: '127.0.0.1', port: 2238, username: 'u', password: 'x' }) });

  const browser = await launch();
  const pc = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = [];
  pc.on('pageerror', (e) => errors.push(e.message));
  await pc.goto(base + '/'); await wait(1000);
  for (let i = 0; i < 2; i++) { await pc.locator('.host', { hasText: 'RS' }).click(); await pc.waitForSelector('.tab.active .dot.ok'); await wait(500); }
  ok(await pc.locator('.tab').count() === 2, '电脑开了 2 个标签');

  await stop();
  await start(port); // 服务重启：后台会话都没了
  await waitFor(pc, () => document.querySelectorAll('.tab').length === 0, null, 30000).catch(() => {});
  const n0 = await pc.locator('.tab').count();
  ok(n0 === 0, `服务重启后电脑上服务端已经没有的标签关掉了 (剩 ${n0} 个)`);
  ok(!(await pc.evaluate(() => document.body.textContent.includes('服务可能重启过'))), '不再留着「后台会话已不存在」的标签');

  const m = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
  await m.goto(base + '/'); await wait(1000);
  for (let i = 0; i < 2; i++) {
    await m.tap('#btnToggle'); await wait(300);
    await m.locator('.host', { hasText: 'RS' }).tap(); await m.waitForSelector('.tab.active .dot.ok'); await wait(500);
  }
  ok(await m.locator('.tab').count() === 2, '手机开了 2 个标签');
  await wait(1500);
  const n1 = await pc.locator('.tab').count(), live = await pc.locator('.tab .dot.ok').count();
  ok(n1 === 2 && live === 2, `电脑上的标签和服务端一样，是手机开的 2 个 (${n1} 个，连着的 ${live} 个)`);
  ok(!errors.length, '页面没有报错' + (errors.length ? ': ' + errors.join(' | ') : ''));

  await browser.close();
  await stop();
});
