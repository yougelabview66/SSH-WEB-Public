'use strict';
// 回到前台 / 连接可能死了：新旧连接一起试，谁先回话用谁 (以前手机在后台待了 10 秒以上直接换新连接，
// 旧连接其实好好的也要白等一次建连接，这期间画面是旧的、滑动提示「还没连上」；待得短的心跳 3 秒没回话才换)
// 1. 旧连接好好的：一个来回就接着用，新连接关掉；不会被锁住 (服务端同一个页面的两条连接算一个使用者，关掉没用上的那条，使用者交回留下的)
// 2. 旧连接死了 (两头的消息都不转)：新连接一连上就换过去；服务端按编号马上断开旧连接 (以前要等心跳 30~60 秒才发现，
//    这期间还当有人在看、不推送，输出往里积压)；死的时候主机上的输出一次不落、不重复
// 3. 页面一直在前台、连接死了：打字 2 秒没回话就一起试，换过去以后打字照常
// 4. 网络变了 (navigator.connection 的 type 变了)：一起试
// 5. 别的设备开着同一个会话：比完以后还是这台在用，那边照样锁着
const { BASE, ok, wait, launch, devices, hostKey, addHost, waitFor } = require('./helpers');
const { Server } = require('ssh2');

let shell = null, got = '';
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => {
      const st = a(); shell = st;
      st.write('READY $ ');
      st.on('data', (d) => { got += d; st.write(String(d).replace(/\r/g, '\r\n')); }); // 回显
    });
  }));
}).listen(2362, '127.0.0.1');

(async () => {
  await addHost('R', 2362);
  const browser = await launch(['--disable-webgl']); // 用 DOM 渲染，好读出终端每行的字
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  // 网络信息：页面里换成可以手动改 type 的假对象 (安卓 Chrome 有 navigator.connection.type)
  await ctx.addInitScript(() => {
    const c = new EventTarget(); c.type = 'wifi';
    Object.defineProperty(navigator, 'connection', { configurable: true, get: () => c });
  });
  const errors = [];
  // ---- 拦 WebSocket：每条连接记下什么时候开的、两头什么时候关的；dead = 两头的消息都不转、页面关了也不告诉服务端 (假死)
  // delayNew：新开的连接上服务端发来的晚这么久转给页面 (本机上两条连接都很快，要旧连接先回话时让新连接慢一点，同真实网络里建连接要多几个来回)
  const routes = [];
  let delayNew = 0;
  await ctx.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    const r = { dead: false, at: Date.now(), attached: 0, pageClosed: 0, serverClosed: 0, drop: null, delay: routes.length ? delayNew : 0 };
    routes.push(r);
    ws.onMessage((m) => {
      if (r.dead) return;
      if (typeof m === 'string' && m.includes('"type":"events"')) r.events = true; // 页面的事件连接 (见 15-sync.js)，不是标签的
      if (typeof m === 'string' && m.includes('"type":"drop"')) r.drop = JSON.parse(m).cid;
      server.send(m);
    });
    server.onMessage((m) => {
      if (r.dead) return;
      if (!r.attached && typeof m === 'string' && m.includes('"attached"')) r.attached = Date.now();
      if (r.delay) setTimeout(() => { if (!r.dead) ws.send(m); }, r.delay); else ws.send(m);
    });
    ws.onClose(() => { r.pageClosed = Date.now(); if (!r.dead) server.close(); });
    server.onClose(() => { r.serverClosed = Date.now(); ws.close(); });
  });

  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.evaluate(() => { window.__shift = 0; const real = Date.now; Date.now = () => real() + window.__shift; });
  await p.tap('#btnToggle'); await p.locator('.host', { hasText: 'R' }).tap();
  await waitFor(p, () => !!document.querySelector('.tab.active .dot.ok'), null, 10000);
  await wait(800);
  const screen = () => p.evaluate(() => [...document.querySelectorAll('.term.active .xterm-rows > div')].map((d) => d.textContent.trim()).filter(Boolean).join('\n'));
  const shown = async (re, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (re.test(await screen())) return Date.now() - t; await wait(30); } return -1; };
  const locked = () => p.evaluate(() => !!document.querySelector('.term.active .owner-notice') || document.querySelector('.term.active .term-box').classList.contains('mirror'));
  // 打字 (手机输入栏)，返回主机收到没有
  const send = async (text) => {
    await p.tap('#mInput');
    await p.keyboard.type(text);
    await p.tap('#mForm button[type=submit]');
  };
  const type = async (text) => {
    got = '';
    await send(text);
    for (let i = 0; i < 40 && !got.includes(text); i++) await wait(100);
    return got.includes(text);
  };
  const setHidden = (hidden, away = 0) => p.evaluate(([h, a]) => {
    window.__shift += a;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, [hidden, away]);
  // 标签的连接 (不算事件连接)、现在开着的几条、现在用的那条
  const tabs = () => routes.filter((r) => !r.events);
  const live = () => tabs().filter((r) => !r.pageClosed && !r.dead).length;
  const hintText = () => p.evaluate(() => document.querySelector('.term.active .conn-hint')?.textContent || '');
  const cur = () => tabs().filter((r) => !r.pageClosed && !r.dead).pop();
  ok(/READY \$/.test(await screen()) && live() === 1, '连上了 (一条连接)');

  // 别的设备 (电脑) 也开着这个会话：手机在用，电脑锁着
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const q = await ctx2.newPage();
  q.on('pageerror', (e) => errors.push(e.message));
  await q.goto(BASE + '/'); await q.waitForSelector('#app:not(.hidden)');
  await waitFor(q, () => !!document.querySelector('.tab.active .dot.ok'), null, 10000);
  await wait(800);
  const qNotice = () => q.evaluate(() => document.querySelector('.term.active .owner-notice')?.textContent || '');
  ok(/手机/.test(await qNotice()) && !(await locked()), '电脑上锁着 (正在手机上使用)，手机没锁: ' + await qNotice());

  // ---- 1. 旧连接好好的：在后台待了 5 秒回来，一起试，旧连接一个来回就接着用
  const n1 = tabs().length, old1 = cur();
  delayNew = 300;
  await setHidden(true);
  await setHidden(false, 5000);
  for (let i = 0; i < 30 && tabs().length === n1; i++) await wait(50);
  ok(tabs().length === n1 + 1, `回到前台：开了一条新连接一起试 (${tabs().length - n1} 条)`);
  for (let i = 0; i < 40 && !tabs()[n1]?.pageClosed; i++) await wait(50);
  await wait(500);
  ok(tabs()[n1]?.pageClosed && !old1.pageClosed, '旧连接先回话：接着用旧的，新连接关掉');
  ok(live() === 1, `只剩一条连接 (${live()})`);
  ok(!(await hintText()), '旧连接马上回话：不显示「正在连接…」');
  ok(!(await locked()), '手机没被锁住 (关掉的新连接以前会把使用者带走)');
  ok(/手机/.test(await qNotice()), '电脑上照样显示正在手机上使用: ' + await qNotice());
  ok(await type('echo one'), '打字照常发到主机');
  shell.write('\r\nAFTER-1 输出照常\r\n$ ');
  ok(await shown(/AFTER-1/) >= 0, '输出照常显示');

  // ---- 2. 旧连接死了：后台期间主机还在输出；回来一起试，新连接一连上就换过去
  delayNew = 0;
  await wait(500);
  const old2 = cur();
  old2.dead = true;
  await setHidden(true);
  shell.write('\r\nDEAD-2 死的时候的输出\r\n$ ');
  await wait(300);
  const n2 = tabs().length;
  const t2 = Date.now();
  await setHidden(false, 5000);
  const ts2 = await shown(/DEAD-2/);
  ok(ts2 >= 0 && ts2 < 1500, `旧连接死了：新连接一连上就换过去，马上看到死的时候的输出 (${ts2} ms)`);
  for (let i = 0; i < 40 && !old2.serverClosed; i++) await wait(50);
  ok(tabs()[n2]?.drop && old2.serverClosed && old2.serverClosed - t2 < 2000,
    `服务端按编号马上断开死掉的旧连接 (${old2.serverClosed ? old2.serverClosed - t2 : '-'} ms，以前要等心跳 30~60 秒)`);
  ok(live() === 1 && !(await locked()), '只剩新连接，没被锁住');
  ok(/手机/.test(await qNotice()), '电脑上照样显示正在手机上使用');
  const n2b = await p.evaluate(() => ([...document.querySelectorAll('.term.active .xterm-rows > div')].map((d) => d.textContent).join('\n').match(/DEAD-2/g) || []).length);
  ok(n2b === 1, `那段输出只出现一次 (${n2b})`);
  ok(await type('echo two'), '换过去以后打字照常');

  // ---- 2b. 新连接也慢 (旧的死了，新的 2.5 秒才回话)：超过 0.8 秒还没好就在终端正中显示「正在连接…」，连上就消失
  delayNew = 2500;
  await wait(2500); // 刚换的连接 2 秒内不再换
  cur().dead = true;
  await setHidden(true);
  const tb = Date.now();
  await setHidden(false, 5000);
  await wait(400);
  ok(!(await hintText()), '刚开始一起试：先不显示 (连得快的不闪一下)');
  let th = -1;
  for (let i = 0; i < 40; i++) { if (/正在连接/.test(await hintText())) { th = Date.now() - tb; break; } await wait(50); }
  ok(th >= 700 && th < 1400, `一直没连上：显示「正在连接…」(${th} ms)`);
  // 和其他提示 (.font-toast，如「还没连上，连上后再滑就能看历史」) 同一个位置；手机上是终端正中
  const center = (sel) => p.evaluate((q) => { const r = document.querySelector(q)?.getBoundingClientRect(); return r && { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; }, sel);
  const hc = await center('.term.active .conn-hint'), bc = await center('.term.active .term-box');
  ok(hc && Math.abs(hc.x - bc.x) < 4 && Math.abs(hc.y - bc.y) < 4, `手机上在终端正中: ${JSON.stringify(hc)} / ${JSON.stringify(bc)}`);
  // 那个位置正显示着别的提示：先让它，它没了再显示
  const vis = () => p.evaluate(() => { const h = document.querySelector('.term.active .conn-hint'); return !!h && getComputedStyle(h).display !== 'none'; });
  await p.evaluate(() => { const t = document.createElement('div'); t.className = 'font-toast'; t.id = 'fakeToast'; t.textContent = '别的提示'; document.querySelector('.term.active .term-box').appendChild(t); });
  const tc = await center('#fakeToast');
  ok(tc && Math.abs(tc.x - hc.x) < 4 && Math.abs(tc.y - hc.y) < 4, `和其他提示同一个位置: ${JSON.stringify(tc)}`);
  ok(!(await vis()), '同一个位置正显示着别的提示：先不显示，不叠在一起');
  await p.evaluate(() => document.getElementById('fakeToast').remove());
  ok(await vis(), '别的提示没了：接着显示');
  ok(!(await p.isVisible('.term.active .reconnect')), '不和「重新连接」按钮一起出现');
  for (let i = 0; i < 80 && await hintText(); i++) await wait(50);
  ok(!(await hintText()) && live() === 1, '新连接连上：提示消失');
  delayNew = 0;

  // ---- 3. 页面一直在前台、连接死了：打字 2 秒没回话就一起试
  await wait(500);
  const old3 = cur();
  old3.dead = true;
  const n3 = tabs().length;
  const t3 = Date.now();
  await send('lost'); // 发在死连接上 (丢了，不重发：不知道到底到没到，重发可能打两遍)
  for (let i = 0; i < 80 && !tabs()[n3]?.attached; i++) await wait(50);
  const s3 = tabs()[n3]?.attached ? (tabs()[n3].at - t3) / 1000 : 99;
  ok(s3 > 1.5 && s3 < 3, `打了字 ${s3.toFixed(1)} 秒没回话：一起试，换上新连接`);
  await wait(500);
  ok(live() === 1 && old3.serverClosed, '死掉的旧连接服务端也断开了');
  ok(await type('echo three'), '换过去以后打字照常');

  // ---- 4. 网络变了 (Wi-Fi → 流量)：一起试；旧连接还好就接着用
  delayNew = 300;
  await wait(2500); // 刚换的连接 2 秒内不再换
  const n4 = tabs().length, old4 = cur();
  await p.evaluate(() => { navigator.connection.type = 'cellular'; navigator.connection.dispatchEvent(new Event('change')); });
  for (let i = 0; i < 30 && tabs().length === n4; i++) await wait(50);
  ok(tabs().length === n4 + 1, '网络类型变了：开一条新连接一起试');
  await wait(1000);
  ok(!old4.pageClosed && live() === 1, '旧连接还好：接着用');
  const n4b = tabs().length;
  await p.evaluate(() => navigator.connection.dispatchEvent(new Event('change'))); // 只是网速估计变了 (type 没变)
  await wait(600);
  ok(tabs().length === n4b, '类型没变的 change 不算');

  ok(!(await locked()) && /手机/.test(await qNotice()), '最后：手机还在用，电脑还锁着');
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error('✘ 测试出错: ' + (e.stack || e)); process.exit(1); });
