'use strict';
// 电脑上点推送通知进来，很久还停在旧消息上 (Windows + Edge 反馈)：网页在后台被冻住了 (Edge 的睡眠标签、Chrome 省电模式冻结后台标签)，
// 冻着时 JS 不跑、连接还开着，服务端照样发，消息在浏览器里排着队；醒来一下子交给网页，几 MB 的旧输出从旧到新全写进 xterm 才追上。
// 1. 冻住前 (freeze 事件) 把连接都关掉：冻着时服务端不再往这个页面发 (不积压，也不会因为积压停读 SSH 卡住里面的程序)；
//    醒来 (resume) 重连只补缺的，正在看的标签马上是最新画面；不在看的只要状态，点推送切过去再要画面
// 2. 没收到 freeze 事件、JS 停过 (电脑睡眠过等，定时器两分半以上没跑) 刚醒：排着队的旧输出不写进终端，换新连接只补缺的，不重复
// 3. 页面一直在前台、连接假死：点推送通知切过去时发心跳，3 秒没回话就换新连接 (以前要等心跳超时，一直停在旧画面上)
const { BASE, ok, wait, launch, hostKey, addHost, waitFor } = require('./helpers');
const { Server } = require('ssh2');

const shells = {}; // 用户名 (ua / ub) → shell 通道
new Server({ hostKeys: [hostKey()] }, (c) => {
  let user = '';
  c.on('authentication', (ctx) => { user = ctx.username; ctx.accept(); });
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { const st = a(); shells[user] = st; st.write(`READY-${user} $ `); });
  }));
}).listen(2361, '127.0.0.1');

// Claude Code 干活时的状态行：一帧在原地重画两行 (不折行、不滚动，约 180 字节)，n 帧
const frames = (n, tag) => Array.from({ length: n }, (_, i) => `\r\x1b[2K✻ Ebbing… (${tag} ${i}s · ↓ ${i * 3} tokens · esc to interrupt)` + '\r\n\x1b[2K' + `${tag}-${i} `.repeat(8) + '\x1b[1A').join('');
// 写给 shell，等全部写出去 (SSH 窗口满了要等 SSH-WEB 读走)，返回用了多久
const pour = (st, data) => new Promise((resolve) => { const t = Date.now(); st.write(data, () => resolve(Date.now() - t)); });

(async () => {
  await addHost('A', 2361, { username: 'ua' });
  await addHost('B', 2361, { username: 'ub' });
  const browser = await launch(['--disable-webgl']); // 用 DOM 渲染，好读出终端每行的字
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // 页面收到的字节数 (输出和画面快照等消息)、标签开过几个连接、现在开着几个 (不算同步标签用的事件连接，见 15-sync.js：只有几条小消息)
  await ctx.addInitScript(() => {
    window.__rx = 0; window.__conns = 0; window.__open = new Set();
    const W = window.WebSocket;
    window.WebSocket = class extends W {
      constructor(...a) {
        super(...a);
        window.__conns++; window.__open.add(this);
        this.addEventListener('message', (e) => { window.__rx += e.data instanceof ArrayBuffer ? e.data.byteLength : e.data.length; });
        this.addEventListener('close', () => window.__open.delete(this));
      }
      send(d) {
        if (typeof d === 'string' && d.includes('"type":"events"')) { this.events = true; window.__conns--; }
        return super.send(d);
      }
    };
  });
  const errors = [];
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'A' }).click(); await wait(800);
  await p.locator('.host', { hasText: 'B' }).click(); await wait(800);
  await p.locator('.tab', { hasText: 'A-1' }).click(); // B 也看过 (不是打开页面时就在后台、没看过的)
  await waitFor(p, () => document.querySelectorAll('.tab .dot.ok').length === 2, null, 15000);
  await wait(800);
  const ids = Object.fromEntries((await (await fetch(BASE + '/api/sessions')).json()).map((x) => [x.title, x.id]));
  const act = () => p.evaluate(() => document.querySelector('.tab.active .title').textContent);
  const screen = (tab) => p.evaluate((t) => {
    const el = [...document.querySelectorAll('.term')].find((x) => x.classList.contains('active') === (t === 'active'));
    return [...(el?.querySelectorAll('.xterm-rows > div') || [])].map((d) => d.textContent.trim()).filter(Boolean).join('\n');
  }, tab);
  const stat = () => p.evaluate(() => ({ rx: window.__rx, conns: window.__conns, open: [...window.__open].filter((w) => w.readyState === 1 && !w.events).length }));
  const setHidden = (hidden) => p.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  const shown = async (re, tab = 'active', ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (re.test(await screen(tab))) return Date.now() - t; await wait(50); } return -1; };
  ok(/READY-ua/.test(await screen('active')) && await act() === 'A-1', '两个标签都连上了，在看 A-1');

  // ---- 1. 冻住：连接都关掉，冻着时的输出不往这个页面发
  await setHidden(true);
  await p.evaluate(() => document.dispatchEvent(new Event('freeze')));
  await wait(800);
  const s0 = await stat();
  ok(s0.open === 0, '冻住前：两个标签的连接都关掉 (还开着 ' + s0.open + ' 个)');
  const big = (tag) => frames(10000, tag) + `\r\n\r\n\x1b[2KLATEST-${tag.slice(1)} 最新一行\r\n$ `;
  const mb = (Buffer.byteLength(big('FA')) / 1048576).toFixed(1);
  const pa = await pour(shells.ua, big('FA'));
  const pb = await pour(shells.ub, big('FB'));
  ok(pa < 4000 && pb < 4000, `冻着时主机上的程序照常输出，不被卡住 (各 ${mb}MB，用了 ${pa} / ${pb} ms)`);
  await wait(500);
  ok((await stat()).rx === s0.rx, '冻着时页面收不到输出 (服务端不再往这里发)');
  // 醒来：在看的 A-1 马上是最新画面；B-1 只要状态
  const r0 = await stat();
  await p.evaluate(() => document.dispatchEvent(new Event('resume')));
  await setHidden(false);
  const ta = await shown(/LATEST-A/);
  ok(ta >= 0 && ta < 2000, `醒来：在看的 A-1 很快就是最新画面 (${ta} ms)`);
  await wait(800);
  const r1 = await stat();
  ok(r1.conns - r0.conns === 2 && r1.open === 2, `醒来：两个标签都重连 (${r1.conns - r0.conns} 个)`);
  ok(r1.rx - r0.rx < 600 * 1024, `醒来时只补缺的、不在看的 B-1 先不要画面：收了 ${Math.round((r1.rx - r0.rx) / 1024)}KB (主机上输出了 ${mb * 2}MB)`);
  ok(!/LATEST-B/.test(await screen('inactive')), '不在看的 B-1 还没要画面');
  // 点推送通知切到 B-1：马上要画面
  await p.evaluate((id) => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'open-session', id } })), ids.B);
  const tb = await shown(/LATEST-B/);
  ok(await act() === 'B-1' && tb >= 0 && tb < 2000, `点推送通知切到 B-1：很快就是最新画面 (${tb} ms)`);
  // 之后的输出照常接上，不重复
  await pour(shells.ub, '\r\nAFTER-B 醒来后的输出\r\n$ ');
  ok(await shown(/AFTER-B/) >= 0, 'B-1 之后的输出照常接上');
  const textB = await p.evaluate(() => { const b = [...document.querySelectorAll('.term.active .xterm-rows > div')].map((d) => d.textContent).join('\n'); return (b.match(/LATEST-B/g) || []).length; });
  ok(textB === 1, `B-1 最新一行只出现一次，没有重复补发 (${textB})`);

  // ---- 2. 没收到 freeze 事件、JS 停过 (把 Date.now 往后拨三分钟)：醒来先到的输出不写，换新连接
  await p.locator('.tab', { hasText: 'A-1' }).click(); await wait(800);
  await p.evaluate(() => { window.__shift = 0; const real = Date.now; Date.now = () => real() + window.__shift; });
  const c0 = (await stat()).conns;
  await p.evaluate(() => { window.__shift += 180000; });
  await pour(shells.ua, '\r\nUNIQ-A 停过以后的输出\r\n$ ');
  const tu = await shown(/UNIQ-A/);
  await wait(800);
  const c1 = (await stat()).conns;
  ok(c1 - c0 >= 1, `JS 停过刚醒：换新连接 (${c1 - c0} 个)`);
  const nu = await p.evaluate(() => ([...document.querySelectorAll('.term.active .xterm-rows > div')].map((d) => d.textContent).join('\n').match(/UNIQ-A/g) || []).length);
  ok(tu >= 0 && tu < 3000 && nu === 1, `换了连接以后是最新画面，那段输出只出现一次 (${tu} ms，${nu} 次)`);
  await pour(shells.ua, '\r\nNEXT-A 又一段\r\n$ ');
  ok(await shown(/NEXT-A/) >= 0, '之后的输出照常接上');
  await wait(500);
  const c2 = (await stat()).conns;
  await pour(shells.ua, '\r\nCALM-A 正常的输出\r\n$ ');
  await shown(/CALM-A/); await wait(500);
  ok((await stat()).conns === c2, '没再停过：不会每来一段输出就换连接');
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await ctx.close();

  // ---- 3. 页面一直在前台、连接假死：点推送通知切过去，心跳 3 秒没回话就换新连接
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const routes = [];
  await ctx2.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    const r = { frozen: false };
    routes.push(r);
    ws.onMessage((m) => { if (!r.frozen) server.send(m); });
    server.onMessage((m) => { if (!r.frozen) ws.send(m); });
  });
  const q = await ctx2.newPage();
  q.on('pageerror', (e) => errors.push(e.message));
  await q.goto(BASE + '/'); await q.waitForSelector('#app:not(.hidden)');
  await waitFor(q, () => document.querySelectorAll('.tab .dot.ok').length === 2, null, 15000); // 恢复上面的两个标签
  await q.locator('.tab', { hasText: 'A-1' }).click(); await wait(800);
  const ids2 = Object.fromEntries((await (await fetch(BASE + '/api/sessions')).json()).map((x) => [x.title, x.id]));
  for (const r of routes) r.frozen = true; // 两个标签的连接都假死 (电脑睡眠过、换了网络，页面没去过后台)
  const n0 = routes.length;
  await pour(shells.ub, '\r\nZOMBIE-B 假死期间的输出\r\n$ ');
  const z0 = Date.now();
  await q.evaluate((id) => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'open-session', id } })), ids2.B);
  let tz = -1;
  for (let i = 0; i < 100; i++) {
    const t = await q.evaluate(() => [...document.querySelectorAll('.term.active .xterm-rows > div')].map((d) => d.textContent).join('\n'));
    if (/ZOMBIE-B/.test(t)) { tz = Date.now() - z0; break; }
    await wait(100);
  }
  ok(routes.length > n0 && tz >= 2500 && tz < 6000, `点推送通知时连接假死：心跳 3 秒没回话换新连接，看到最新画面 (${tz} ms，新连接 ${routes.length - n0} 个)`);
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close();
  process.exit();
})().catch((e) => { console.log('✘ 测试出错: ' + (e.stack || e)); process.exit(1); });
