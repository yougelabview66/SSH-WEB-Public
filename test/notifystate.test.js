'use strict';
// 完成通知：按钮的「已开启」要和服务器对得上 (在别的设备上被删了、推送密钥变了都算没开)，
// 重新开启换新订阅；测试通知只发给这台；推送服务回 403 (密钥对不上) 的订阅自动删掉
// 浏览器的推送订阅是模拟的 (无头 Chromium 连不上真的推送服务、通知权限也读不对)，推送发到本地模拟推送服务
// @env PUSH_ALLOW_ANY_ENDPOINT=true NODE_TLS_REJECT_UNAUTHORIZED=0
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { BASE, ok, wait, run, launch, waitFor } = require('./helpers');

// 模拟推送服务：记下推到了哪个地址；/bad 开头的回 403 (像密钥对不上)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-push-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
  '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
let pushed = [];
const pushSrv = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (req, res) => {
  req.resume();
  req.on('end', () => { pushed.push(req.url); res.writeHead(req.url.startsWith('/bad') ? 403 : 201); res.end(); });
}).listen(0, '127.0.0.1');
fs.rmSync(dir, { recursive: true, force: true });

const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
const keys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
const J = (u, b) => fetch(BASE + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const has = async (endpoint) => (await J('/api/push/subs', { endpoint })).some((x) => x.self);

// 页面里的 PushManager 换成模拟的：订阅存在 localStorage (刷新后还在，跟真的一样)，每次订阅换一个新地址
function fakePush({ base, keys }) {
  const load = () => { try { return JSON.parse(localStorage.getItem('fakeSub')); } catch { return null; } };
  const b64 = (u8) => btoa(String.fromCharCode(...new Uint8Array(u8)));
  const make = (s) => s && {
    endpoint: s.endpoint,
    options: { applicationServerKey: Uint8Array.from(atob(s.key), (c) => c.charCodeAt(0)).buffer },
    toJSON: () => ({ endpoint: s.endpoint, keys }),
    unsubscribe: async () => { localStorage.removeItem('fakeSub'); return true; },
  };
  // 无头 Chromium 里 Notification.permission 总是 denied (授权了也一样)，按已授权算
  Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
  Notification.requestPermission = async () => 'granted';
  PushManager.prototype.getSubscription = async function () { return make(load()); };
  PushManager.prototype.subscribe = async function (o) {
    if (load()) throw new DOMException('已经有订阅了，要先取消', 'InvalidStateError');
    const n = Number(localStorage.getItem('fakeN') || 0) + 1;
    localStorage.setItem('fakeN', n);
    const s = { endpoint: `${base}/this-${n}`, key: b64(o.applicationServerKey) };
    localStorage.setItem('fakeSub', JSON.stringify(s));
    return make(s);
  };
}

run(async () => {
  if (!pushSrv.listening) await new Promise((r) => pushSrv.once('listening', r));
  const base = `https://127.0.0.1:${pushSrv.address().port}`;
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.grantPermissions(['notifications'], { origin: BASE });
  await ctx.addInitScript(fakePush, { base, keys });
  const p = await ctx.newPage();
  const errors = [], alerts = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => { alerts.push(d.message()); d.accept(); });
  const label = () => p.locator('#btnNotify').textContent();
  const open = async () => { await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)'); await waitFor(p, () => document.querySelector('#btnNotify').textContent !== ''); await wait(500); };
  const clickBtn = async (text) => { await p.click(`#dialogActions button:has-text("${text}")`); await wait(800); };

  await open();
  ok(await label() === '未开启', '一开始：未开启');
  await p.click('#btnNotify'); await wait(1200);
  ok(await label() === '已开启' && await has(`${base}/this-1`), '点开启：订阅登记到服务器，按钮显示已开启');
  ok(pushed.length === 1 && pushed[0] === '/this-1', '开启后的测试通知发到这台 ' + JSON.stringify(pushed));

  // 另一台设备也开着：在这台点「发送测试通知」只发给这台
  await J('/api/push/subscribe', { subscription: { endpoint: `${base}/other`, keys } });
  pushed = [];
  await p.click('#btnNotify'); await wait(500);
  await clickBtn('发送测试通知');
  ok(pushed.length === 1 && pushed[0] === '/this-1', '发送测试通知：只发给这台，别的设备收不到 ' + JSON.stringify(pushed));

  // 在别的设备上把这台删了：浏览器里订阅还在，但服务器上没了 → 不能再显示已开启
  await J('/api/push/unsubscribe', { endpoint: `${base}/this-1` });
  await open();
  ok(await label() === '未开启 · 其他 1 台已开', '这台的订阅在服务器上被删了：显示未开启 (' + await label() + ')');
  await p.click('#btnNotify'); await wait(500);
  ok((await p.locator('#dialogBody').textContent()).includes('这台设备还没开启'), '点开：提示这台还没开启');
  pushed = [];
  await clickBtn('在这台设备开启'); await wait(500);
  ok(await label() === '已开启' && await has(`${base}/this-2`) && !(await has(`${base}/this-1`)), '重新开启：换了新订阅登记到服务器，显示已开启');
  ok(pushed.length === 1 && pushed[0] === '/this-2', '重新开启后的测试通知发到新订阅 ' + JSON.stringify(pushed));

  // 推送密钥变了 (data 目录重建过)：浏览器里的订阅是旧密钥订的 → 显示未开启，重新开启换新订阅
  await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('fakeSub')); s.key = btoa('old-key'.repeat(10)); localStorage.setItem('fakeSub', JSON.stringify(s)); });
  await open();
  ok((await label()).startsWith('未开启') && await has(`${base}/this-2`), '订阅的推送密钥和服务器的对不上：显示未开启 (' + await label() + ')');
  await p.click('#btnNotify'); await wait(500);
  await clickBtn('在这台设备开启'); await wait(500);
  ok(await label() === '已开启' && await has(`${base}/this-3`) && !(await has(`${base}/this-2`)), '重新开启：旧订阅从服务器删掉，换成新密钥的订阅');

  // 推送服务回 403 (密钥对不上)：那条订阅永远推不过去，自动删掉；别的照常
  await J('/api/push/subscribe', { subscription: { endpoint: `${base}/bad-1`, keys } });
  pushed = [];
  await fetch(BASE + '/api/push/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const left = await J('/api/push/subs', {});
  ok(pushed.includes('/bad-1') && pushed.includes('/this-3') && left.length === 2 && !(await has(`${base}/bad-1`)), '推送服务回 403 的订阅自动删掉，其他的还在 ' + JSON.stringify(pushed));

  ok(alerts.length === 0, '没有弹出错误提示 ' + alerts.join('; '));
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close();
});
