'use strict';
// 端口预览：目标主机上本机的开发服务借 SSH 连接转发，在 /p/<端口>-<口令>/ 打开 —— 页面、跳转、POST、WebSocket 都通；
// 默认加沙箱 (隔离)，「完整模式」不加、开发服务的 Cookie 限定在预览地址下；口令不对 404；
// 还没打开过、标签断了、端口没在监听时给出说明；发给开发服务的请求不带 SSH-WEB 的登录 Cookie
const http = require('http');
const net = require('net');
const { Server } = require('ssh2');
const WebSocket = require('ws');
const { BASE, ok, wait, run, launch, shot, hostKey, addHost } = require('./helpers');

// 「目标主机上」的开发服务 (测试里就在本机随便一个端口)
let seen = {}; let wsSeen = {};
const dev = http.createServer((req, res) => {
  seen = { url: req.url, host: req.headers.host, origin: req.headers.origin, cookie: req.headers.cookie };
  if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'devc=1; Path=/' }); return res.end('<h1 id="dev">DEV SERVER</h1>'); }
  if (req.url === '/echo') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(seen)); }
  if (req.url === '/redir') { res.writeHead(302, { Location: '/target' }); return res.end(); }
  if (req.url === '/abs') { res.writeHead(302, { Location: 'http://localhost:5173/x?y=1' }); return res.end(); }
  if (req.url === '/post') { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { res.writeHead(200); res.end('GOT ' + b); }); return; }
  res.writeHead(404); res.end('nope');
});
new WebSocket.Server({ server: dev }).on('connection', (ws, req) => {
  wsSeen = { url: req.url, host: req.headers.host, origin: req.headers.origin };
  ws.on('message', (m) => ws.send('echo:' + m));
});

const SS = 'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\n'
  + 'LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=11,fd=20))\n'
  + 'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))\n'
  + 'LISTEN 0 50 [::]:3000 [::]:* users:(("python3",pid=12,fd=4))\n';

// 模拟 SSH 服务器：shell + exec (列端口) + direct-tcpip (只有 5173 端口在监听，转到上面的开发服务)
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('tcpip', (accept, reject, info) => {
    if (info.destPort !== 5173) return reject();
    const ch = accept();
    const sock = net.connect(dev.address().port, '127.0.0.1');
    ch.pipe(sock).pipe(ch);
    sock.on('error', () => ch.destroy()); ch.on('error', () => sock.destroy());
  });
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => a().write('$ '));
    s.on('exec', (a, r, info) => {
      const ch = a();
      if (info.command === 'sh') { // 常驻通道：读到脚本就回列端口的结果 + 结束标记
        ch.on('data', (d) => { const m = /printf '\\n%s %s\\n' '(__SSHWEB_[0-9a-f]+__)'/.exec(String(d)); if (m) ch.write(SS + `\n${m[1]} 0\n`); });
        return;
      }
      ch.write(SS); ch.exit(0); ch.end();
    });
  }));
}).listen(2291, '127.0.0.1');

run(async () => {
  await new Promise((r) => dev.listen(0, '127.0.0.1', r));
  await addHost('FW', 2291);
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'FW' }).first().click(); await p.waitForSelector('.tab.active .dot.ok'); await wait(800);

  // 打开面板：列出在监听的端口 (不列 22)，带前缀
  // 入口在顶栏最右边「⋯ 更多」的菜单里 (性能监控也收在里面)，顶栏不变宽
  const lastBtn = await p.evaluate(() => [...document.querySelectorAll('#tabbar > button')].filter((b) => !b.classList.contains('hidden') && b.offsetWidth).pop()?.id);
  ok(lastBtn === 'btnMore' && !(await p.isVisible('#btnMon')) && !(await p.isVisible('#btnFwd')), '「⋯ 更多」在顶栏最后，监控、端口预览收在菜单里: ' + lastBtn);
  await p.click('#btnMore');
  ok(await p.isVisible('#btnMon') && await p.isVisible('#btnFwd'), '点「⋯ 更多」展开菜单：性能监控、端口预览');
  await p.screenshot({ path: shot('more-menu.png'), clip: { x: 780, y: 0, width: 500, height: 140 } });
  await p.keyboard.press('Escape'); await wait(150);
  ok(!(await p.isVisible('#morePop')), 'Esc 收起菜单');
  await p.click('#btnMore'); await p.mouse.click(500, 400); await wait(150);
  ok(!(await p.isVisible('#morePop')), '点别处收起菜单');
  await p.click('#btnMore'); await p.click('#btnFwd'); await p.waitForSelector('.fwd .fwd-row', { timeout: 8000 }).catch(() => {});
  ok(!(await p.isVisible('#morePop')), '点了菜单项菜单就收起');
  const rows = await p.evaluate(() => [...document.querySelectorAll('.fwd .fwd-row')].map((r) => [r.dataset.port, r.querySelector('.fwd-meta').textContent, r.querySelector('code').textContent]));
  ok(rows.length === 2 && rows[0][0] === '3000' && rows[1][0] === '5173' && rows[1][1] === 'node · 127.0.0.1', '面板列出目标主机上在监听的端口和进程 (不列 22): ' + JSON.stringify(rows));
  await p.screenshot({ path: shot('forward-panel.png') });
  const prefix = rows.find((r) => r[0] === '5173')?.[2] || '';
  ok(/^\/p\/5173-[A-Za-z0-9_-]{12}$/.test(prefix), '每个端口有固定的预览前缀: ' + prefix);
  const U = BASE + prefix;

  // 还没在 SSH-WEB 里打开过：说明怎么做；口令不对：404
  let r = await fetch(U + '/');
  ok(r.status === 502 && /还没在 SSH-WEB 里打开过/.test(await r.text()), '还没打开过预览的端口：提示在标签里点「🌐 预览」');
  r = await fetch(BASE + '/p/5173-AAAAAAAAAAAA/');
  ok(r.status === 404, '口令不对：404');

  // 点「打开」：新标签页打开预览
  const popup = ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null);
  await p.locator('.fwd .fwd-row[data-port="5173"] [data-open]').click();
  const pg = await popup;
  if (pg) await pg.waitForSelector('#dev', { timeout: 8000 }).catch(() => {});
  ok(!!pg && pg.url() === U + '/' && (await pg.textContent('#dev').catch(() => '')) === 'DEV SERVER', '点「打开」：新标签页里显示目标主机上的开发服务: ' + (pg && pg.url()));
  ok(pg && await pg.evaluate(() => window.opener === null), '预览页面拿不到 SSH-WEB 页面 (opener 是空的)');
  ok(pg && await pg.evaluate(() => { try { localStorage.getItem('x'); return false; } catch { return true; } }), '默认隔离：预览页面在沙箱里 (localStorage 用不了)');

  // 转发细节
  r = await fetch(U + '/');
  ok(/sandbox allow-scripts/.test(r.headers.get('content-security-policy') || '') && r.headers.get('access-control-allow-origin') === '*', '隔离模式：响应加沙箱、允许跨域 (沙箱里来源是 null)');
  r = await fetch(U + '/echo', { headers: { cookie: 'sshweb_session=SECRET; other=1', origin: BASE } });
  let e = await r.json();
  ok(e.host === 'localhost:5173' && e.cookie === 'other=1' && e.origin === 'http://localhost:5173' && e.url === '/echo',
    '发给开发服务的请求：Host / Origin 换成它自己的、去掉 SSH-WEB 的登录 Cookie、路径去掉前缀: ' + JSON.stringify(e));
  r = await fetch(U + '/redir', { redirect: 'manual' });
  ok(r.headers.get('location') === prefix + '/target', '跳转到 / 开头的地址：补上预览前缀: ' + r.headers.get('location'));
  r = await fetch(U + '/abs', { redirect: 'manual' });
  ok(r.headers.get('location') === prefix + '/x?y=1', '跳转到 http://localhost:5173/…：改回预览地址: ' + r.headers.get('location'));
  r = await fetch(U + '/post', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
  ok(await r.text() === 'GOT {"a":1}', 'POST 的内容原样转过去 (没被 SSH-WEB 先读走)');
  r = await fetch(U, { redirect: 'manual' });
  ok(r.status === 301 && r.headers.get('location') === prefix + '/', '没有结尾的 /：跳到带 / 的地址 (相对路径才对)');

  // WebSocket (热更新)
  const ws = new WebSocket(U.replace('http', 'ws') + '/hmr', { headers: { origin: BASE } });
  const echo = await new Promise((res) => { ws.on('open', () => ws.send('hi')); ws.on('message', (m) => res(String(m))); ws.on('error', () => res('ERR')); setTimeout(() => res('TIMEOUT'), 5000); });
  ws.close();
  ok(echo === 'echo:hi' && wsSeen.url === '/hmr' && wsSeen.host === 'localhost:5173' && wsSeen.origin === 'http://localhost:5173', 'WebSocket 也能转发: ' + echo + ' ' + JSON.stringify(wsSeen));

  // 完整模式：不加沙箱，开发服务的 Cookie 限定在预览地址下
  await p.check('.fwd .fwd-row[data-port="5173"] [data-full]');
  const popup2 = ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null);
  await p.locator('.fwd .fwd-row[data-port="5173"] [data-open]').click();
  const pg2 = await popup2; await wait(800);
  r = await fetch(U + '/');
  ok(!/sandbox/.test(r.headers.get('content-security-policy') || '') && r.headers.get('set-cookie') === `devc=1; Path=${prefix}/`, '完整模式：不加沙箱，Cookie 只在预览地址下: ' + r.headers.get('set-cookie'));
  ok(pg2 && await pg2.evaluate(() => { try { localStorage.setItem('x', '1'); return true; } catch { return false; } }), '完整模式：预览页面能用 localStorage');
  ok(await p.evaluate(() => JSON.parse(localStorage.getItem('sshweb.fwdFull') || '{}')['5173'] === true), '完整模式按端口记住');

  // 手动输入没在监听的端口
  const popup3 = ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null);
  await p.fill('.fwd .fwd-add input', '5999'); await p.click('.fwd .fwd-add button');
  const pg3 = await popup3; if (pg3) await pg3.waitForLoadState().catch(() => {});
  ok(pg3 && /连不上/.test(await pg3.textContent('body').catch(() => '')), '端口没在监听：预览页说明连不上');

  // Esc 关面板
  await p.keyboard.press('Escape'); await wait(200);
  ok(!(await p.$('.fwd')), 'Esc 关掉面板');

  // 标签关掉 (会话断开)：预览说明断开了
  await p.locator('.tab.active .x').click(); await wait(400);
  if (await p.$('.dialog .primary, #dialog .primary')) await p.click('.dialog .primary, #dialog .primary').catch(() => {});
  await wait(1500);
  r = await fetch(U + '/');
  ok(r.status === 502 && /断开/.test(await r.text()), '打开预览的标签断开后：提示重新连接');

  // 手机：「⋯ 更多」也在顶栏最后，菜单不超出屏幕
  const m = await (await browser.newContext({ ...require('./helpers').devices['Pixel 7'] })).newPage();
  await m.goto(BASE + '/'); await m.waitForSelector('#app:not(.hidden)');
  await m.tap('#btnToggle'); await m.locator('.host', { hasText: 'FW' }).first().tap(); await m.waitForSelector('.tab.active .dot.ok'); await wait(600);
  await m.tap('#btnMore'); await wait(200);
  ok(await m.evaluate(() => { const r = document.getElementById('morePop').getBoundingClientRect(); return document.getElementById('btnFwd').offsetWidth > 0 && r.right <= innerWidth && r.left >= 0; }), '手机：点「⋯」展开菜单，菜单在屏幕里');
  await m.screenshot({ path: shot('more-menu-mobile.png'), clip: { x: 0, y: 0, width: 412, height: 160 } });
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close();
  dev.close();
});
