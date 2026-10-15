'use strict';
// 监控面板的连接日志：显示连接的主机 IP、是否用了代理、出口 IP 和归属地 (归属地服务用本地模拟的，不访问外网)
// @env GEOIP=http://127.0.0.1:2263/json/{ip}
const http = require('http');
const net = require('net');
const { Server } = require('ssh2');
const { BASE, ok, wait, shot, launch, addHost, run, hostKey, waitFor } = require('./helpers');

new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => a().write('$ '));
  }));
}).listen(2262, '127.0.0.1');

// 模拟 ip-api.com：203.0.113.90 是东京的代理 / 机房 IP
const geoHits = [];
http.createServer((req, res) => {
  const ip = decodeURIComponent(req.url.split('/')[2]);
  geoHits.push(ip);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(ip === '203.0.113.90'
    ? { status: 'success', country: '日本', regionName: 'Tokyo', city: '東京都', isp: 'Example Proxy Ltd', proxy: true, hosting: true }
    : { status: 'success', country: '中国', regionName: '广东', city: '深圳', isp: '中国电信', proxy: false, hosting: false }));
}).listen(2263, '127.0.0.1');

// 模拟一层内网反向代理 (10.0.0.5 那一跳)：浏览器从出口 203.0.113.90 连过来，转给 SSH-WEB 时加上 X-Forwarded-For
// (浏览器的 WebSocket 握手带不上自定义请求头，所以用真的代理)
const XFF = '203.0.113.90, 10.0.0.5';
const target = new URL(BASE);
const proxy = http.createServer((req, res) => {
  const up = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, 'x-forwarded-for': XFF } },
    (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => res.destroy());
  req.pipe(up);
});
proxy.on('upgrade', (req, sock, head) => {
  const up = net.connect(target.port, target.hostname, () => {
    const headers = { ...req.headers, 'x-forwarded-for': XFF };
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
    up.write(head);
    up.pipe(sock); sock.pipe(up);
  });
  up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
});
proxy.listen(2264, '127.0.0.1');
const URL_ = 'http://127.0.0.1:2264';

run(async () => {
  await addHost('MA', 2262);
  const browser = await launch();
  // 浏览器经过代理 (出口 203.0.113.90) 再经过内网反向代理 10.0.0.5 到 SSH-WEB
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(URL_ + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'MA' }).click(); await p.waitForSelector('.tab.active .dot.ok'); await wait(500);

  await p.click('#btnMon');
  await waitFor(p, () => document.querySelectorAll('.mon .arow').length >= 2);
  const rows = await p.evaluate(() => [...document.querySelectorAll('.mon .arow')].map((r) => ({
    head: r.querySelector('.ah').textContent,
    kv: Object.fromEntries([...r.querySelectorAll('.kv')].map((k) => [k.children[0].textContent, { v: k.children[1].textContent, cls: k.children[1].className }])),
  })));
  const open = rows.find((r) => r.head.includes('新建会话'));
  const ready = rows.find((r) => r.head.includes('已连上主机'));
  ok(rows.indexOf(ready) < rows.indexOf(open), '新的记录在上面');
  ok(open && open.kv['出口 IP']?.v === '203.0.113.90', '新建会话：显示出口 IP');
  ok(open && /日本 Tokyo 東京都 · Example Proxy Ltd/.test(open.kv['归属地']?.v), '新建会话：显示出口 IP 归属地 (国家 地区 城市 · 运营商)');
  ok(open && /^是 · 代理 \/ VPN IP/.test(open.kv['代理']?.v) && open.kv['代理'].cls.includes('bad'), '新建会话：出口 IP 是代理，标红');
  ok(open && open.kv['连接 IP']?.v === '127.0.0.1 (经 10.0.0.5 → 127.0.0.1)' && open.kv['主机']?.v === 'u@127.0.0.1:2262', '新建会话：显示连接 IP 和经过的代理、目标主机');
  ok(ready && /^127\.0\.0\.1:2262 · 内网$/.test(ready.kv['主机 IP']?.v) && ready.kv['代理']?.v === '否 · 直连', '已连上主机：显示主机 IP (内网)、直连没走代理');
  ok(geoHits.filter((x) => x === '203.0.113.90').length === 1 && !geoHits.includes('127.0.0.1'), '归属地只查公网 IP，查过的缓存起来');

  // 刷新：同一个出口不重复查归属地
  await p.click('.m-aref'); await wait(800);
  ok(geoHits.filter((x) => x === '203.0.113.90').length === 1, '点刷新不重复查归属地 (有缓存)');
  const vis = await p.evaluate(() => { const r = document.querySelector('.m-alist').getBoundingClientRect(); return r.height > 50 && r.top < 200; });
  ok(vis, '连接日志在监控面板上方，一打开就能看到');
  ok(!errors.length, '页面没有报错 ' + errors.join('; '));
  await p.emulateMedia({ colorScheme: 'dark' }); await p.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark')); await wait(300);
  await p.locator('.mon').screenshot({ path: shot('monaudit-dark.png') });
  await p.emulateMedia({ colorScheme: 'light' }); await p.evaluate(() => document.documentElement.setAttribute('data-theme', 'light')); await wait(300);
  await p.locator('.mon').screenshot({ path: shot('monaudit-light.png') });
  await browser.close();
});
