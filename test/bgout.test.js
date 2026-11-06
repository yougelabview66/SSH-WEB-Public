'use strict';
// 网页在后台时收到的输出先攒着不写进终端，回到前台再说：
// 以前一直往 xterm 里写，浏览器把后台网页的定时器压得很慢，xterm 处理不过来，攒下几 MB (Claude Code 干活时状态行一秒刷好几次)；
// 回到前台要把这些重绘从旧到新全画一遍，「Ebbing… (1h 5m 50s …)」停在旧的时间不动，过好一阵才追上。
// 现在：攒得少 → 回来直接写进去 (不用等服务端)；攒得多 (超过 256KB) → 不一条条补画，向服务端要现在的画面 (sync)，马上是最新的，之后的输出照常接上
const { BASE, ok, wait, launch, hostKey, addHost, waitFor } = require('./helpers');
const { Server } = require('ssh2');

const shells = [];
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { const st = a(); shells.push(st); st.write('READY $ '); });
  }));
}).listen(2358, '127.0.0.1');

(async () => {
  await addHost('B', 2358);
  const browser = await launch(['--disable-webgl']); // 用 DOM 渲染，好读出终端每行的字
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  const sent = []; // 网页发给服务端的 (看有没有 sync)
  let down = 0; // 服务端发给网页的终端输出字节数
  const routes = [];
  await ctx.routeWebSocket(/\/ws$/, (ws) => {
    routes.push(ws);
    const server = ws.connectToServer();
    ws.onMessage((m) => { if (typeof m === 'string') sent.push(JSON.parse(m)); server.send(m); });
    server.onMessage((m) => { if (typeof m !== 'string') down += m.length; ws.send(m); });
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'B' }).click();
  await waitFor(p, () => !!document.querySelector('.tab.active .dot.ok'), null, 15000);
  await wait(800);
  const st = shells[0];
  const screen = () => p.evaluate(() => [...document.querySelectorAll('.term.active .xterm-rows > div')].map((d) => d.textContent.trim()).filter(Boolean).join('\n'));
  const setHidden = (hidden) => p.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  const out = async (text) => { const d0 = down; st.write(text); while (down - d0 < Buffer.byteLength(text)) await wait(50); await wait(300); };
  await waitFor(p, () => /READY/.test(document.querySelector('.term.active .xterm-rows')?.textContent || ''), null, 8000).catch(() => {});
  ok(/READY \$/.test(await screen()), '连上了');

  // ---- 攒得少：回来直接写进去，不向服务端要画面
  await setHidden(true);
  await out('\r\nSMALL-1 后台时的一点输出\r\n$ ');
  ok(!/SMALL-1/.test(await screen()), '网页在后台：收到的输出先不写进终端');
  const s0 = sent.length;
  await setHidden(false);
  await waitFor(p, () => /SMALL-1/.test(document.querySelector('.term.active .xterm-rows').textContent), null, 3000).catch(() => {});
  ok(/SMALL-1/.test(await screen()), '回到前台：攒着的写进终端');
  ok(!sent.slice(s0).some((m) => m.type === 'sync'), '攒得少：不用向服务端要画面');

  // ---- 攒得多：回来向服务端要现在的画面
  await setHidden(true);
  // 模拟 Claude Code 干活时的状态行：同一行一直重画 (回车 + 清行)，几千次
  let big = '';
  for (let i = 1; i <= 6000; i++) big += `\r\x1b[2K✻ Ebbing… (${i}s · ↓ ${i * 13} tokens) ${'·'.repeat(30)}`;
  big += '\r\n最后一行 BIG-END $ ';
  await out(big);
  ok(Buffer.byteLength(big) > 256 * 1024, `后台收到 ${(Buffer.byteLength(big) / 1024).toFixed(0)}KB 输出`);
  await wait(3000); // 服务端自己的无界面终端也要把这么多输出解析完 (实际是一小时里慢慢来的，早就解析完了)
  ok(!/BIG-END/.test(await screen()), '网页在后台：没写进终端');
  const s1 = sent.length;
  const t0 = Date.now();
  await setHidden(false);
  await waitFor(p, () => /BIG-END/.test(document.querySelector('.term.active .xterm-rows').textContent), null, 5000).catch(() => {});
  const secs = (Date.now() - t0) / 1000;
  const sync = sent.slice(s1).find((m) => m.type === 'sync');
  ok(!!sync, '攒得多：向服务端要现在的画面: ' + JSON.stringify(sync));
  ok(/BIG-END/.test(await screen()) && secs < 3, `回到前台 ${secs.toFixed(1)} 秒就是最新的画面`);
  ok(/Ebbing… \(6000s/.test(await screen()) && !/Ebbing… \(5999s/.test(await screen()), '状态行是最后那一次的 (6000s)');

  // 之后的输出照常接上 (没有重复、没有漏)
  await out('\r\nAFTER-1 回来以后的输出\r\n$ ');
  const sc = await screen();
  ok(/AFTER-1/.test(sc) && (sc.match(/BIG-END/g) || []).length === 1, '之后的输出照常接上，没有重复: ' + JSON.stringify(sc.split('\n').slice(-4)));

  // 刷新页面：画面一样 (服务端和网页记的位置对得上)
  const before = (await screen()).split('\n').slice(-3).join('\n');
  await p.reload(); await p.waitForSelector('#app:not(.hidden)');
  await waitFor(p, () => !!document.querySelector('.tab.active .dot.ok'), null, 15000);
  await waitFor(p, () => /AFTER-1/.test(document.querySelector('.term.active .xterm-rows')?.textContent || ''), null, 10000).catch(() => {});
  await wait(500);
  const after = (await screen()).split('\n').slice(-3).join('\n');
  ok(after === before, '刷新后画面一样: ' + JSON.stringify([before, after]));

  // ---- 在后台时断线重连：攒着的不要了，新连接从终端里现有的画面接着补
  await setHidden(true);
  await out('\r\nDROP-1 后台断线前的输出\r\n$ ');
  const n = routes.length;
  await routes[n - 1].close(); // 连接断了 (网页在后台照样自动重连)
  while (routes.length === n) await wait(100);
  await wait(1000);
  await out('\r\nDROP-2 重连以后的输出\r\n$ ');
  await setHidden(false);
  await waitFor(p, () => /DROP-2/.test(document.querySelector('.term.active .xterm-rows').textContent), null, 15000).catch(() => {});
  const sd = await screen();
  ok(/DROP-1/.test(sd) && /DROP-2/.test(sd) && (sd.match(/DROP-1/g) || []).length === 1, '后台断线重连后：前后的输出都在，没有重复: ' + JSON.stringify(sd.split('\n').slice(-5)));

  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error('✘ 测试出错: ' + (e.stack || e)); process.exit(1); });
