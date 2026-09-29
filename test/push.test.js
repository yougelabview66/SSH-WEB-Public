'use strict';
// 主机状态变化时的推送通知 (手机切到后台也能收到)：本地模拟推送服务，收到后按 Web Push 标准解密检查内容
// @env PUSH_ALLOW_ANY_ENDPOINT=true NODE_TLS_REJECT_UNAUTHORIZED=0
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const ece = require('http_ece');
const { WebSocket } = require('ws');
const { Server, utils } = require('ssh2');
const { BASE, ok, wait, run, hostKey } = require('./helpers');

// 模拟推送服务 (HTTPS，自签名证书)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-push-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
  '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
const auth = crypto.randomBytes(16);
let pushes = [];
const pushSrv = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try { pushes.push(JSON.parse(ece.decrypt(Buffer.concat(chunks), { version: 'aes128gcm', privateKey: ecdh, authSecret: auth.toString('base64url') }).toString())); } catch (e) { pushes.push({ error: e.message }); }
    res.writeHead(201); res.end();
  });
}).listen(0, '127.0.0.1');
fs.rmSync(dir, { recursive: true, force: true });

const streams = [];
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc(); s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { const st = a(); streams.push(st); st.write('$ '); });
  }));
}).listen(2254, '127.0.0.1');

const claudeScreen = (statusLine, prompt = '❯ \r\n') => '\x1b[H\x1b[2J● 之前的回答\r\n\r\n' + (statusLine ? statusLine + '\r\n\r\n' : '') +
  '──────────\r\n' + prompt + '──────────\r\n  ⏵⏵ auto mode on';
const J = (m, u, b) => fetch(BASE + u, { method: m, headers: { 'content-type': 'application/json' }, body: b && JSON.stringify(b) }).then((r) => r.json());

run(async () => {
  if (!pushSrv.listening) await new Promise((r) => pushSrv.once('listening', r));
  const sub = { endpoint: `https://127.0.0.1:${pushSrv.address().port}/dev1`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  await J('POST', '/api/push/subscribe', { subscription: sub });
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws');
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'connect', host: '127.0.0.1', port: 2254, username: 'u', password: 'x', title: 'M', n: 1, cols: 80, rows: 24 }));
  await wait(1500);
  ws.send(JSON.stringify({ type: 'watching', watching: false }));
  pushes = [];

  streams[0].write(claudeScreen('✻ Frosting… (5s · ↓ 1k tokens)')); await wait(1500);
  ok(pushes.length === 0, '运行中不推送');
  streams[0].write(claudeScreen('✻ Worked for 9s')); await wait(1800);
  ok(pushes.length === 1 && pushes[0].title === 'M-1 · 完成' && pushes[0].body === '做完了' && pushes[0].sessionId,
    '没人在看：从运行中变成完成 → 推送 ' + JSON.stringify(pushes[0]));
  streams[0].write('\x07'); await wait(800);
  ok(pushes.length === 1, '紧接着的提示音不再重复推送');

  await wait(10500); // 同一会话 10 秒内最多推送一次
  streams[0].write(claudeScreen('', ' Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n')); await wait(1800);
  ok(pushes.length === 2 && pushes[1].title === 'M-1 · 待选择' && pushes[1].body === '需要你选择', '变成待选择 → 推送 ' + JSON.stringify(pushes[1]));

  await wait(10500);
  ws.send(JSON.stringify({ type: 'watching', watching: true }));
  streams[0].write(claudeScreen('✻ Frosting… (2s)')); await wait(1500);
  streams[0].write(claudeScreen('✻ Worked for 3s')); await wait(1800);
  ok(pushes.length === 2, '有人正在看这个标签：状态变了也不推送');
  ws.close();
});
