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

  // 普通程序一阵一阵地输出 (tail -f 看日志)：显示运行中 / 完成，但不推送
  for (let k = 0; k < 2; k++) {
    for (let i = 0; i < 8; i++) { streams[0].write(`log line ${k}-${i}\r\n`); await wait(150); }
    await wait(4000);
  }
  ok(pushes.length === 0, '一阵一阵的普通输出 (像 tail -f)：不推送 ' + JSON.stringify(pushes));

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
  ws.send(JSON.stringify({ type: 'data', data: '1' })); // 在手机上回复了
  await wait(10500);
  streams[0].write('\x07'); await wait(800);
  ok(pushes.length === 3 && pushes[2].body === '终端提示音', '回复过之后，下一次提示音照常推送 ' + JSON.stringify(pushes[2]));

  await wait(10500);
  ws.send(JSON.stringify({ type: 'watching', watching: true }));
  const before = pushes.length;
  streams[0].write(claudeScreen('✻ Frosting… (2s)')); await wait(1500);
  streams[0].write(claudeScreen('✻ Worked for 3s')); await wait(1800);
  ok(pushes.length === before, '有人正在看这个标签：状态变了也不推送');
  // 网页在前台但看的是别的标签：也不推送 (右上角悬浮窗看得到)
  ws.send(JSON.stringify({ type: 'watching', watching: false, front: true }));
  streams[0].write(claudeScreen('✻ Frosting… (2s)')); await wait(1500);
  streams[0].write(claudeScreen('✻ Worked for 4s')); await wait(1800);
  ok(pushes.length === before, '网页在前台、看的是别的标签：不推送');
  // 网页最小化 / 切到别的窗口：推送
  ws.send(JSON.stringify({ type: 'watching', watching: false, front: false }));
  streams[0].write(claudeScreen('✻ Frosting… (2s)')); await wait(1500);
  streams[0].write(claudeScreen('✻ Worked for 5s')); await wait(1800);
  ok(pushes.length === before + 1 && pushes.at(-1).title === 'M-1 · 完成', '网页最小化 / 不在前台：推送 ' + JSON.stringify(pushes.at(-1)));
  ws.close();

  // 开了通知的设备列表：不返回推送地址 / 密钥；标出是不是这台；能按设备删掉
  const post = (u, b, ua) => fetch(BASE + u, { method: 'POST', headers: { 'content-type': 'application/json', ...(ua && { 'user-agent': ua }) }, body: JSON.stringify(b) }).then((r) => r.json());
  const sub2 = { ...sub, endpoint: sub.endpoint.replace('/dev1', '/dev2') };
  await post('/api/push/subscribe', { subscription: sub2 }, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0');
  let list = await post('/api/push/subs', { endpoint: sub.endpoint });
  const other = list.find((x) => !x.self);
  ok(list.length === 2 && list.filter((x) => x.self).length === 1 && other && other.device === 'Windows · Edge' && !JSON.stringify(list).includes('dev2') && !JSON.stringify(list).includes('p256dh'),
    '列出开了通知的设备 (浏览器 + 系统)，标出这台，不泄露推送地址和密钥: ' + JSON.stringify(list.map((x) => [x.device, x.self])));
  await post('/api/push/unsubscribe', { id: other.id });
  list = await post('/api/push/subs', { endpoint: sub.endpoint });
  ok(list.length === 1 && list[0].self, '按设备删掉另一台，这台还在');
  await post('/api/push/unsubscribe', { id: 'nope' });
  ok((await post('/api/push/subs', {})).length === 1, '删不存在的 id 不影响别的订阅');
});
