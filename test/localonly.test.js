'use strict';
// @env HOST=0.0.0.0
// 没设 AUTH_PASSWORD：只允许本机直接访问 (127.0.0.1 / ::1，不经过代理)。从局域网地址来的、带转发头
// (反向代理、cloudflared 转来的) 的网页、接口、WebSocket、端口预览一律拒绝；/healthz 在本机照样能用
const os = require('os');
const WebSocket = require('ws');
const { BASE, ok, run } = require('./helpers');

const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
const wsOpen = (url, headers) => new Promise((resolve) => {
  const ws = new WebSocket(url, { headers });
  ws.on('open', () => { ws.close(); resolve('open'); });
  ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
  ws.on('error', () => resolve('error'));
});

run(async () => {
  const port = new URL(BASE).port;
  let r = await fetch(BASE + '/');
  ok(r.status === 200, '本机直接访问：网页照常打开');
  ok((await (await fetch(BASE + '/api/me')).json()).authed === true, '本机直接访问：不用登录');
  ok(await wsOpen(BASE.replace('http', 'ws') + '/ws') === 'open', '本机直接访问：WebSocket 能连');

  r = await fetch(BASE + '/', { headers: { 'X-Forwarded-For': '203.0.113.9' } });
  const txt = await r.text();
  ok(r.status === 403 && /AUTH_PASSWORD/.test(txt) && /只允许在本机访问/.test(txt), '经过反向代理 (带 X-Forwarded-For)：拒绝，提示设置 AUTH_PASSWORD: ' + r.status);
  ok((await fetch(BASE + '/api/hosts', { headers: { 'CF-Connecting-IP': '203.0.113.9' } })).status === 403, 'Cloudflare 转来的 (CF-Connecting-IP)：接口拒绝');
  ok(await wsOpen(BASE.replace('http', 'ws') + '/ws', { 'X-Forwarded-For': '203.0.113.9' }) === 403, '经过代理的 WebSocket：拒绝');
  ok(await wsOpen(BASE.replace('http', 'ws') + '/p/5173/', { Forwarded: 'for=203.0.113.9' }) === 403, '经过代理的端口预览 WebSocket：拒绝');
  ok((await fetch(BASE + '/healthz')).status === 200, '/healthz (Docker 健康检查，容器里本机访问)：照常');

  if (!lan) { ok(true, '(这台机器没有局域网地址：跳过)'); return; }
  r = await fetch(`http://${lan}:${port}/`);
  ok(r.status === 403, `从局域网地址 (${lan}) 访问网页：拒绝`);
  ok((await fetch(`http://${lan}:${port}/api/sessions`)).status === 403, '从局域网地址访问接口：拒绝');
  ok(await wsOpen(`ws://${lan}:${port}/ws`) === 403, '从局域网地址连 WebSocket：拒绝');
});
