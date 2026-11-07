'use strict';
// 手机后台回来 / 点推送通知进来：
// 1. 常驻会话里程序没开鼠标 (Claude Code 普通模式)，还没连上时在终端上滑：以前滑动交给 xterm，把它自己那份旧画面滚上去，
//    之后滑动又走历史视图、动不了它，回不到最新画面，也没有「回到实时画面」按钮。现在终端不动：新旧连接在比 (见 race 测试) 时
//    历史请求先排着，连上就自动打开历史视图 (不用再滑)；取历史在冷却时滑动吞掉，提示一下
// 2. 连接在后台已经断了、网页还以为连着 (假死)：以前等 8 秒心跳超时，再等旧连接关掉 (关闭握手) 才重连，很久看不到最新画面。
//    现在后台待了 2 秒以上回来马上新旧连接一起试，待得短的发心跳 1.5 秒没回话再一起试；
//    假死连接上在等的历史，换上新连接后在新连接上再要一次
// 3. 终端滚动区往上翻着 (普通 shell 里滑上去的) 显示「回到实时画面」，点了 / 从输入栏发字都回到最底下
// 4. 点推送通知 (Service Worker 的 open-session，安卓 App 也发这个) 切到那个标签并回到实时画面 (历史视图关掉)
// 常驻会话用 Playwright 拦 WebSocket 模拟：给 D 的会话信息加上 daemonId，取历史由这里回答；假死 = 两头的消息都不转
const { BASE, ok, wait, launch, devices, hostKey, addHost, waitFor } = require('./helpers');
const { Server } = require('ssh2');

const ROWS = Array.from({ length: 300 }, (_, i) => `row ${i + 1} 一行输出 abc`);
const HIST = ROWS.join('\n') + '\nLIVE $\n';
let got = '';
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { const st = a(); st.write(ROWS.join('\r\n') + '\r\nLIVE $ '); st.on('data', (d) => { got += d; }); });
  }));
}).listen(2357, '127.0.0.1');

(async () => {
  await addHost('D', 2357); // 当常驻会话 (拦 WebSocket 加 daemonId)
  await addHost('P', 2357); // 普通 shell
  const browser = await launch(['--disable-webgl']); // 用 DOM 渲染，好读出终端每行的字
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const errors = [];

  // ---- 拦 WebSocket
  const routes = []; // 每个连接一个 (第几次连)
  const ids = {}; // 标签名 → 会话 id
  let histMode = 'ok'; // 取历史怎么回答：ok 和屏幕对得上 / other 对不上 / drop 不回答
  let holdNew = false; // 新连接上服务端发来的先扣着 (模拟新连接还没连上)
  let histReqs = 0, frozenHist = 0; // 取历史的请求：回答了的 / 发在假死连接上的
  await ctx.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    const r = { frozen: false, held: holdNew ? [] : null, at: Date.now() };
    r.release = () => { const h = r.held || []; r.held = null; for (const m of h) try { ws.send(m); } catch {} };
    routes.push(r);
    ws.onMessage((msg) => {
      if (r.frozen) { if (String(msg).includes('"tmux-history"')) frozenHist++; return; }
      if (typeof msg === 'string' && msg.includes('"tmux-history"')) {
        histReqs++;
        if (histMode === 'drop') return;
        ws.send(JSON.stringify({ type: 'tmux-history', ok: true, data: histMode === 'ok' ? HIST : '完全不相干的画面\n'.repeat(50) }));
        return;
      }
      server.send(msg);
    });
    server.onMessage((msg) => {
      if (r.frozen) return;
      if (typeof msg === 'string' && msg.includes('"attached"')) {
        const o = JSON.parse(msg);
        ids[o.session.title] = o.session.id; r.title = o.session.title;
        if (o.session.title === 'D') { o.session.params = { ...o.session.params, daemonId: '1' }; msg = JSON.stringify(o); }
      }
      if (r.held) return r.held.push(msg);
      ws.send(msg);
    });
  });

  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  // Date.now 可以往后拨 (模拟在后台待了很久)
  await p.evaluate(() => { window.__shift = 0; const real = Date.now; Date.now = () => real() + window.__shift; });
  await p.tap('#btnToggle'); await p.locator('.host', { hasText: 'P' }).tap(); await wait(1500);
  await p.tap('#btnToggle'); await p.locator('.host', { hasText: 'D' }).tap(); await wait(1500);
  const act = () => p.evaluate(() => document.querySelector('.tab.active .title').textContent);
  await waitFor(p, () => !!document.querySelector('.tab.active .dot.ok'), null, 8000);
  ok(await act() === 'D-1' && ids.D && ids.P, '开了两个标签，当前是 D-1 (常驻会话)');

  const cdp = await ctx.newCDPSession(p);
  const box = await p.locator('.term.active .term-box').boundingBox();
  const x = box.x + box.width / 2, y0 = box.y + 150;
  const swipe = async (dir = 1) => { // dir 1：手指往下滑 (往回看)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
    for (let i = 1; i <= 15; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + dir * i * 20 }] }); await wait(30); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await wait(1200);
  };
  // 终端最底下显示的是不是实时画面 (最后一行有内容的是 LIVE $)
  const live = () => p.evaluate(() => {
    const rows = [...document.querySelectorAll('.term.active .xterm-rows > div')].map((d) => d.textContent.trim()).filter(Boolean);
    return rows.length > 5 && rows[rows.length - 1].startsWith('LIVE $');
  });
  const view = () => p.evaluate(() => !!document.querySelector('.term.active .lscroll'));
  const btn = () => p.isVisible('.term.active .tmux-exit');
  const connected = () => p.evaluate(() => !!document.querySelector('.tab.active .dot.ok'));
  const toast = () => p.evaluate(() => document.querySelector('.term.active .font-toast')?.textContent || '');
  const closeView = async () => { await p.locator('.term.active .ls-close').tap(); await wait(500); };
  // 切到后台 / 回到前台 (away：在后台待了多久，把 Date.now 往后拨)
  const setHidden = (hidden, away = 0) => p.evaluate(([h, a]) => {
    window.__shift += a;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, [hidden, away]);

  ok(await live() && await connected(), '一开始在实时画面、连着');
  await swipe();
  ok(await view() && histReqs === 1, '连着时手指往下滑 → 打开历史视图');
  await closeView();
  ok(!(await view()) && await live(), '点「回到实时画面」回来');

  // ---- 1+2. 在后台待了很久，D 的连接已经假死、新连接也还没连上 (扣着)：回来时新旧连接一起试，等的时候滑
  routes[routes.length - 1].frozen = true;
  holdNew = true;
  const n0 = routes.length;
  await setHidden(true);
  await setHidden(false, 60000);
  await wait(500);
  ok(routes.length === n0 + 2, `后台待了 60 秒回来：不等心跳，两个标签马上都开新连接一起试 (${routes.length - n0} 个)`);
  const req0 = histReqs;
  await swipe();
  ok(!/还没连上/.test(await toast()), '一起试的时候滑：不再提示「还没连上」(以前要连上后再滑一次): ' + await toast());
  await swipe();
  ok(await live(), '等的时候往下滑：终端不动，还在实时画面 (以前把终端自己的旧画面滚上去，回不来)');
  ok(!(await view()) && histReqs === req0, '还没定下来用哪条连接：历史请求先排着');
  ok(!(await btn()), '终端没被滚上去，也不用「回到实时画面」');
  holdNew = false;
  for (const r of routes.slice(n0)) r.release();
  await waitFor(p, () => !!document.querySelector('.term.active .lscroll'), null, 5000).catch(() => {});
  ok(await view() && histReqs === req0 + 1, `新连接连上 (旧的死了)：刚才滑的那一下自动打开历史视图，不用再滑 (${histReqs - req0})`);
  await closeView();
  ok(await live() && await connected(), '回到实时画面，连着');
  await swipe();
  ok(await view(), '再往下滑马上能进历史视图');
  await closeView();

  // ---- 2. 在后台待得短 (1 秒)，连接假死：先发心跳，1.5 秒没回话再一起试；假死连接上在等的历史在新连接上再要一次
  for (const r of routes) r.frozen = true; // 两个标签现在用的连接都假死
  const n1 = routes.length, f1 = frozenHist, req1 = histReqs;
  await setHidden(true);
  await setHidden(false, 1000);
  const t0 = Date.now();
  await wait(100);
  ok(routes.length === n1, '后台待了 1 秒：先发心跳，不马上开新连接');
  await swipe(); // 请求发在假死的连接上，不会有回答
  ok(frozenHist === f1 + 1, `假死时滑动：去取历史，请求发在假死的连接上 (${frozenHist - f1})`);
  while (routes.length < n1 + 2 && Date.now() - t0 < 10000) await wait(100);
  const secs = routes[n1] ? (routes[n1].at - t0) / 1000 : 99;
  ok(routes.length === n1 + 2 && secs > 1 && secs < 2.5, `心跳 ${secs.toFixed(1)} 秒没回话就一起试 (以前 3 秒后再直接换)`);
  await waitFor(p, () => !!document.querySelector('.term.active .lscroll'), null, 5000).catch(() => {});
  ok(await view() && histReqs === req1 + 1, `换上新连接：在新连接上再要一次历史，自动打开历史视图 (不用再滑，${histReqs - req1})`);
  ok(await connected(), '连着');
  await closeView();

  // ---- 4. 点推送通知：切到那个标签，开着的历史视图关掉
  await wait(1000);
  await swipe();
  await waitFor(p, () => !!document.querySelector('.term.active .lscroll'), null, 4000).catch(() => {});
  ok(await view(), 'D-1 开着历史视图');
  await p.locator('.tab', { hasText: 'P-1' }).tap(); await wait(500);
  const hasSw = await p.evaluate(() => 'serviceWorker' in navigator && window.isSecureContext);
  ok(hasSw, '页面有 Service Worker');
  await p.evaluate((id) => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'open-session', id } })), ids.D);
  await wait(600);
  ok(await act() === 'D-1' && !(await view()) && await live(), '点推送通知 → 切到 D-1，历史视图关掉，在实时画面');

  // ---- 1. 取历史对不上进了冷却：冷却期间滑动吞掉，不交给 xterm
  histMode = 'other';
  const reqM = histReqs;
  await swipe();
  while (histReqs === reqM) await wait(100);
  await wait(800);
  ok(!(await view()) && await live(), '历史和屏幕对不上：不打开，终端不动');
  histMode = 'ok';
  const req2 = histReqs;
  await swipe();
  ok(/暂时取不到/.test(await toast()), '冷却期间滑动提示一句: ' + await toast());
  await swipe();
  ok(histReqs === req2 && !(await view()) && await live(), '冷却期间滑动：不取历史，终端也不动 (以前交给 xterm 滚上去)');
  ok(!(await btn()), '终端没被滚上去，没有「回到实时画面」');

  // ---- 3. 普通 shell：终端自己的滚动区滑上去 → 显示「回到实时画面」
  await p.locator('.tab', { hasText: 'P-1' }).tap(); await wait(800);
  ok(await act() === 'P-1' && await live(), '切到普通 shell 的标签');
  await swipe();
  ok(!(await live()) && !(await view()), '普通 shell 往下滑：终端自己的滚动区滚上去 (不走历史视图)');
  ok(await btn(), '滚上去了 → 显示「回到实时画面」');
  await p.locator('.term.active .tmux-exit').tap(); await wait(500);
  ok(await live() && !(await btn()), '点了回到最底下，按钮消失');
  await swipe();
  ok(!(await live()) && await btn(), '再滑上去');
  got = '';
  await p.tap('#mobileBar .mkeys [data-k="tab"]');
  for (let i = 0; i < 30 && !got.includes('\t'); i++) await wait(100); // 按键经过服务端传到主机要一会儿
  await waitFor(p, () => !document.querySelector('.term.active .tmux-exit:not(.hidden)'), null, 2000).catch(() => {}); // 按钮每 300ms 才更新一次
  ok(got.includes('\t') && await live() && !(await btn()), '按键栏 / 输入栏发出按键 → 终端回到最底下: ' + JSON.stringify(got));

  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error('✘ 测试出错: ' + (e.stack || e)); process.exit(1); });
