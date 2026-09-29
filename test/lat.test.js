'use strict';
const net = require('net');
const { BASE, ok, wait, shot, launch, post, addHost, devices } = require('./helpers');
const { Server, utils } = require('ssh2');
const streams = [];
new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => { const s = acc(); s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { const st = a(); streams.push(st); st.write('$ '); }); }));
}).listen(2236, '127.0.0.1');
// 单向延迟 d 毫秒的 TCP 转发 (往返约 2d)
function delayProxy(listenPort, targetPort, d) {
  net.createServer((a) => {
    const b = net.connect(targetPort, '127.0.0.1');
    a.on('data', (x) => setTimeout(() => b.write(x), d));
    b.on('data', (x) => setTimeout(() => a.write(x), d));
    a.on('close', () => b.destroy()); b.on('close', () => a.destroy());
    a.on('error', () => {}); b.on('error', () => {});
  }).listen(listenPort, '127.0.0.1');
}
delayProxy(2237, 2236, 60);    // SSH 那段：往返约 120ms
const WEB_PORT = +new URL(BASE).port, SLOW_WEB_PORT = WEB_PORT + 1000 > 65000 ? WEB_PORT - 1000 : WEB_PORT + 1000;
delayProxy(SLOW_WEB_PORT, WEB_PORT, 50);  // 网页那段：往返约 100ms
const B = BASE;
(async () => {
  await post('/api/hosts', { name: 'FAST', host: '127.0.0.1', port: 2236, username: 'u', password: 'x' });
  await post('/api/hosts', { name: 'SLOW', host: '127.0.0.1', port: 2237, username: 'u', password: 'x' });
  const browser = await launch();
  const errors = [];
  // 打开详情卡片读数字，再关掉；同时读图标的颜色等级
  const lat = async (pg) => {
    const icon = await pg.evaluate(() => { const el = document.getElementById('lat'); return { vis: !el.classList.contains('hidden'), qw: el.querySelector('[data-k=web]').dataset.q, qs: el.querySelector('[data-k=ssh]').dataset.q, nw: el.querySelector('[data-k=web]').dataset.n, ns: el.querySelector('[data-k=ssh]').dataset.n, stacked: (() => { const a = el.querySelector('[data-k=web]').getBoundingClientRect(), b = el.querySelector('[data-k=ssh]').getBoundingClientRect(); return b.top >= a.bottom - 0.5 && Math.abs(a.left - b.left) < 1; })(), text: el.innerText.replace(/\s+/g, '') }; });
    if (!icon.vis) return { vis: false };
    await pg.click('#lat'); await wait(150);
    const d = await pg.evaluate(() => {
      const pop = document.getElementById('latPop'); const b = [...pop.querySelectorAll('.lp-row b')];
      const r = pop.getBoundingClientRect();
      return { popVis: !pop.classList.contains('hidden'), text: pop.innerText.replace(/\s+/g, ' ').trim(), web: parseInt(b[0]?.textContent, 10), ssh: parseInt(b[1]?.textContent, 10), wc: b[0]?.className, sc: b[1]?.className, inView: r.left >= 0 && r.right <= innerWidth };
    });
    await pg.click('#lat'); await wait(100);
    return { ...icon, ...d, iconText: icon.text };
  };
  // 直连：都很快
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(B + '/'); await p.waitForSelector('#app:not(.hidden)');
  ok(await p.isHidden('#lat'), '没有标签时不显示延迟');
  await p.locator('.host', { hasText: 'FAST' }).click(); await wait(7000);
  let l = await lat(p);
  ok(l.vis && l.web < 40 && l.ssh < 40 && l.wc === 'g' && l.sc === 'g', `直连：网页 ${l.web}ms、SSH ${l.ssh}ms，都是绿色 (${l.text})`);
  ok(l.iconText === '' && l.stacked && l.qw === 'g' && l.qs === 'g' && l.nw === '4' && l.ns === '4', '平时只有上下两排信号 (上网页、下 SSH，都是四格绿)，没有文字: ' + l.nw + '/' + l.ns);
  ok(l.popVis && /网页 \d+ ms/.test(l.text) && /SSH \d+ ms/.test(l.text), '点图标弹出详情: ' + l.text.slice(0, 60));
  ok(await p.isHidden('#latPop'), '再点一次图标关闭');
  await p.click('#lat'); await wait(150); await p.mouse.click(600, 400); await wait(150);
  ok(await p.isHidden('#latPop'), '点别处关闭');
  await p.click('#lat'); await wait(150); await p.screenshot({ path: shot('lat-pop.png') });
  await p.keyboard.press('Escape'); await wait(150);
  ok(await p.isHidden('#latPop'), '按 Esc 关闭');
  await p.screenshot({ path: shot('lat-desk.png') });
  // SSH 那段慢
  await p.locator('.host', { hasText: 'SLOW' }).click(); await wait(7000);
  l = await lat(p);
  ok(l.web < 40 && l.ssh >= 110 && l.ssh < 200 && l.sc === 'y' && l.qs === 'y' && l.qw === 'g' && l.nw === '4' && ['2', '3'].includes(l.ns), `SSH 那段加了 120ms：网页 ${l.web}ms、SSH ${l.ssh}ms (黄色) 图标 ${l.qw}/${l.qs}`);
  // 切回第一个标签：显示那个标签自己的数字
  await p.keyboard.press('Alt+1'); await wait(3500); l = await lat(p);
  ok(l.ssh < 40, `切回直连的标签，显示它自己的 SSH 延迟 ${l.ssh}ms`);
  // 网页那段慢：通过延迟代理访问
  const q = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage(); q.on('pageerror', (e) => errors.push(e.message));
  await q.goto(`http://127.0.0.1:${SLOW_WEB_PORT}/`); await q.waitForSelector('.tab'); await wait(8000);
  l = await lat(q);
  ok(l.web >= 95 && l.web < 200 && l.wc === 'y', `网页那段加了 100ms：网页 ${l.web}ms (黄色)，SSH ${l.ssh}ms`);
  // 断开 → 显示 –
  streams[0].end(); await wait(1500);
  await p.keyboard.press('Alt+1'); await wait(500); l = await lat(p);
  ok(/–/.test(l.text) && l.qw === 'na' && l.qs === 'na' && l.nw === '0' && l.ns === '0', '连接断开后详情显示「–」，图标变灰: ' + l.text.slice(0, 40));
  // 测量频率：平时 10 秒一次，打开卡片 2 秒一次
  await p.keyboard.press('Alt+2'); await wait(1500);
  const cdpP = await p.context().newCDPSession(p); await cdpP.send('Network.enable');
  let pings = 0;
  cdpP.on('Network.webSocketFrameSent', (e) => { if (/"type":"ping","t"/.test(e.response.payloadData)) pings++; });
  await wait(1000); pings = 0; await wait(12000);
  ok(pings >= 1 && pings <= 2, `卡片关着：12 秒内测了 ${pings} 次 (约 10 秒一次)`);
  pings = 0; await p.click('#lat'); await wait(6200);
  const sshTxt = await p.evaluate(() => document.querySelectorAll('#latPop .lp-row b')[1]?.textContent || '');
  ok(pings >= 3 && pings <= 4, `打开卡片：6 秒内测了 ${pings} 次 (马上测一次，之后约 2 秒一次)`);
  ok(/\d+ ms/.test(sshTxt), '打开卡片时 SSH 延迟也跟着更新: ' + sshTxt);
  await p.click('#lat'); await wait(200);
  // 手机：只显示数字
  const m = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage(); m.on('pageerror', (e) => errors.push(e.message));
  await m.goto(B + '/'); await m.waitForSelector('.tab'); await wait(1000);
  await m.locator('.tab', { hasText: 'SLOW' }).tap(); await wait(7000);
  l = await lat(m);
  ok(l.vis && !/\d/.test(l.iconText) && l.popVis && l.inView, '手机上也是只有图标，点开的详情完整显示在屏幕内');
  await m.tap('#lat'); await wait(200);
  await m.screenshot({ path: shot('lat-mobile.png') });
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
