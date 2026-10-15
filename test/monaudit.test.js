'use strict';
// 监控面板的连接日志：只显示这台主机的记录；显示连接的主机 IP、是否用了代理、出口 IP 和归属地
// (归属地服务用本地模拟的，不访问外网)。是否代理：归属地服务认定、出口时区和浏览器时区对不上、运营商是云厂商
// @env GEOIP=http://127.0.0.1:2263/json/{ip}
const http = require('http');
const net = require('net');
const { Server } = require('ssh2');
const { BASE, ok, wait, shot, launch, addHost, run, hostKey, waitFor } = require('./helpers');

for (const port of [2262, 2265]) {
  new Server({ hostKeys: [hostKey()] }, (c) => {
    c.on('authentication', (ctx) => ctx.accept());
    c.on('ready', () => c.on('session', (acc) => {
      const s = acc();
      s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
      s.on('shell', (a) => a().write('$ '));
    }));
  }).listen(port, '127.0.0.1');
}

// 模拟 ip-api.com
const GEO = {
  // 东京的机场节点，归属地服务认得出是代理
  '203.0.113.90': { country: '日本', regionName: 'Tokyo', city: '東京都', isp: 'Example Proxy Ltd', timezone: 'Asia/Tokyo', offset: 32400, proxy: true, hosting: true },
  // 大阪的机场节点，但归属地服务没认出来 (看着像家庭宽带)：靠时区对不上判断
  '45.8.8.8': { country: '日本', regionName: 'Osaka', city: '大阪市', isp: 'Some Home ISP', timezone: 'Asia/Tokyo', offset: 32400, proxy: false, hosting: false },
  // 国内的云服务器出口：时区对得上，运营商是云厂商 → 可能
  '47.1.1.1': { country: '中国', regionName: '浙江', city: '杭州', isp: 'Hangzhou Alibaba Advertising Co.,Ltd.', timezone: 'Asia/Shanghai', offset: 28800, proxy: false, hosting: false },
};
const geoHits = [];
http.createServer((req, res) => {
  const ip = decodeURIComponent(req.url.split('/')[2]);
  geoHits.push(ip);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ status: 'success', ...(GEO[ip] || { country: '中国', regionName: '广东', city: '深圳', isp: '中国电信', timezone: 'Asia/Shanghai', offset: 28800 }) }));
}).listen(2263, '127.0.0.1');

// 模拟一层内网反向代理 (10.0.0.5 那一跳)：浏览器从出口 exitIp 连过来，转给 SSH-WEB 时加上 X-Forwarded-For
// (浏览器的 WebSocket 握手带不上自定义请求头，所以用真的代理)
let exitIp = '203.0.113.90';
const xff = () => `${exitIp}, 10.0.0.5`;
const target = new URL(BASE);
const proxy = http.createServer((req, res) => {
  const up = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, 'x-forwarded-for': xff() } },
    (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => res.destroy());
  req.pipe(up);
});
proxy.on('upgrade', (req, sock, head) => {
  const up = net.connect(target.port, target.hostname, () => {
    const headers = { ...req.headers, 'x-forwarded-for': xff() };
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
    up.write(head);
    up.pipe(sock); sock.pipe(up);
  });
  up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
});
proxy.listen(2264, '127.0.0.1');
const URL_ = 'http://127.0.0.1:2264';

// 当前标签 (看得见的) 监控面板里的连接日志
const readRows = (p) => p.evaluate(() => [...document.querySelectorAll('.mon .arow')].filter((r) => r.offsetParent).map((r) => ({
  head: r.querySelector('.ah').textContent,
  kv: Object.fromEntries([...r.querySelectorAll('.kv')].map((k) => [k.children[0].textContent, { v: k.children[1].textContent, cls: k.children[1].className }])),
})));
const openMon = async (p) => { if (!(await p.locator('.mon:visible').count())) await p.click('#btnMon'); };

run(async () => {
  await addHost('MA', 2262);
  await addHost('MB', 2265);
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Shanghai' });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(URL_ + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'MA' }).click(); await p.waitForSelector('.tab.active .dot.ok'); await wait(500);

  await openMon(p);
  await waitFor(p, () => [...document.querySelectorAll('.mon .arow')].filter((r) => r.offsetParent).length >= 2);
  let rows = await readRows(p);
  const open = rows.find((r) => r.head.includes('新建会话'));
  const ready = rows.find((r) => r.head.includes('已连上主机'));
  ok(rows.indexOf(ready) < rows.indexOf(open), '新的记录在上面');
  ok(open && open.kv['出口 IP']?.v === '203.0.113.90', '新建会话：显示出口 IP');
  ok(open && /日本 Tokyo 東京都 · Example Proxy Ltd/.test(open.kv['归属地']?.v), '新建会话：显示出口 IP 归属地 (国家 地区 城市 · 运营商)');
  ok(open && /^是 · 归属地服务认定是代理 \/ VPN IP/.test(open.kv['代理']?.v) && open.kv['代理'].cls.includes('bad'), '归属地服务认定是代理：是，标红');
  ok(open && /出口在日本 \(UTC\+9\)，浏览器时区 Asia\/Shanghai \(UTC\+8\)/.test(open.kv['代理']?.v), '同时列出时区对不上');
  ok(open && open.kv['连接 IP']?.v === '127.0.0.1 (经 10.0.0.5 → 127.0.0.1)' && open.kv['主机']?.v === 'u@127.0.0.1:2262', '显示连接 IP 和经过的代理、目标主机');
  ok(ready && /^127\.0\.0\.1:2262 · 内网$/.test(ready.kv['主机 IP']?.v) && ready.kv['代理']?.v === '否 · 直连', '已连上主机：显示主机 IP (内网)、直连没走代理');
  ok(geoHits.filter((x) => x === '203.0.113.90').length === 1 && !geoHits.includes('127.0.0.1'), '归属地只查公网 IP，查过的缓存起来');

  // 换一个归属地服务认不出来的机场节点：靠时区对不上判断；再换云服务器出口，刷新两次 (每次挂载都记)
  exitIp = '45.8.8.8';
  await p.reload(); await p.waitForSelector('.tab.active .dot.ok'); await wait(800);
  exitIp = '47.1.1.1';
  await p.reload(); await p.waitForSelector('.tab.active .dot.ok'); await wait(800);
  await p.reload(); await p.waitForSelector('.tab.active .dot.ok'); await wait(800);
  await openMon(p);
  await waitFor(p, () => [...document.querySelectorAll('.mon .arow')].some((r) => r.offsetParent && r.textContent.includes('47.1.1.1')));
  rows = await readRows(p);
  const tz = rows.find((r) => r.kv['出口 IP']?.v === '45.8.8.8');
  ok(tz && /^是 · 出口在日本 \(UTC\+9\)，浏览器时区 Asia\/Shanghai \(UTC\+8\)$/.test(tz.kv['代理']?.v) && tz.kv['代理'].cls.includes('bad'),
    '归属地服务没认出的机场节点：出口时区和浏览器时区对不上，判断为代理');
  const dc = rows.filter((r) => r.kv['出口 IP']?.v === '47.1.1.1');
  ok(dc.length === 1 && /^可能 · 运营商是机房 \/ 云厂商/.test(dc[0].kv['代理']?.v) && dc[0].kv['代理'].cls.includes('warn'), '出口是云服务器：可能，标黄');
  ok(dc.length === 1 && /×2/.test(dc[0].head), '同一来源连着刷新两次：面板上合成一条，显示 ×2');
  const all = await (await fetch(BASE + '/api/audit?limit=100&q=47.1.1.1')).json();
  ok(all.filter((x) => x.ev === 'ssh-attach').length === 2 && all.every((x) => x.geo?.city === '杭州' && x.proxy?.v === '可能'),
    '本地文件每次挂载都存，归属地和是否代理也存在里面');

  // 另一台主机：只显示它自己的记录
  await p.locator('.host', { hasText: 'MB' }).click(); await p.waitForSelector('.tab.active .dot.ok'); await wait(500);
  await openMon(p);
  await waitFor(p, () => [...document.querySelectorAll('.mon .arow')].filter((r) => r.offsetParent).length >= 2);
  rows = await readRows(p);
  ok(rows.length >= 2 && rows.every((r) => !r.kv['主机'] || r.kv['主机'].v === 'u@127.0.0.1:2265')
    && rows.every((r) => !r.kv['主机 IP'] || r.kv['主机 IP'].v.startsWith('127.0.0.1:2265')), '另一台主机的监控只显示它自己的记录');
  ok(!errors.length, '页面没有报错 ' + errors.join('; '));

  await p.emulateMedia({ colorScheme: 'dark' }); await p.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await p.locator('.tab', { hasText: 'MA' }).click(); await wait(800); await openMon(p);
  await p.locator('.mon:visible').screenshot({ path: shot('monaudit-dark.png') });
  await browser.close();
});
