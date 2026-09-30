'use strict';
// 服务器版本和网页不一样时提醒刷新
const { BASE, ok, wait, shot, launch, devices } = require('./helpers');
const VERSION = require('../package.json').version;
(async () => {
  const browser = await launch();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(() => { const W = window.WebSocket; window.__ws = []; window.WebSocket = function (...a) { const w = new W(...a); window.__ws.push(w); return w; }; window.WebSocket.prototype = W.prototype; Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 }); });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)'); await wait(1500);
  ok(await p.isHidden('#verBar') && await p.evaluate(() => !document.querySelector('.sidebar-foot .ver').classList.contains('old')), `版本一致 (v${VERSION})：不提醒`);
  // 保险：事件连接「假死」没重连，页面回到前台时主动问一次服务器版本
  await p.route(BASE + '/api/me', async (r) => { const res = await r.fetch(); const j = await res.json(); r.fulfill({ response: res, json: { ...j, version: '9.9.9' } }); });
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await wait(800);
  ok(await p.isVisible('#verBar') && (await p.locator('#verBar .vb-text').textContent()).includes('v9.9.9'), '事件连接没断时，回到前台主动查一次也能发现服务器更新了');
  await p.unroute(BASE + '/api/me');
  // 模拟「服务器更新了，网页还是旧的」：把页面里的版本号换成旧的
  await p.route(BASE + '/', async (r) => { const res = await r.fetch(); r.fulfill({ response: res, body: (await res.text()).replaceAll(VERSION, '0.0.1') }); });
  await p.reload(); await p.waitForSelector('#app:not(.hidden)'); await wait(1500);
  const text = await p.locator('#verBar .vb-text').textContent();
  ok(await p.isVisible('#verBar') && text.includes('v' + VERSION) && text.includes('v0.0.1'), '版本不一致：顶部提醒 ' + text);
  const ver = await p.evaluate(() => { const v = document.querySelector('.sidebar-foot .ver'); return { old: v.classList.contains('old'), text: v.textContent }; });
  ok(ver.old && ver.text === `SSH-WEB v0.0.1 → v${VERSION}`, '侧边栏的版本号变红：' + ver.text);
  await p.screenshot({ path: shot('version.png') });
  await p.click('#verBar .vb-close'); await wait(200);
  ok(await p.isHidden('#verBar') && ver.old, '点 × 关掉提醒 (侧边栏仍是红的)');
  // 服务器重启：事件连接断了又连上，服务器再发一次版本号；同一个版本点过 × 就不再弹
  const n0 = await p.evaluate(() => { const n = window.__ws.length; for (const w of window.__ws) w.close(); return n; });
  await wait(2500);
  const n1 = await p.evaluate(() => window.__ws.filter((w) => w.readyState === 1).length);
  ok(n1 > 0 && await p.evaluate(() => window.__ws.length) > n0 && await p.isHidden('#verBar'), `连接断开后自动重连 (${n1} 条)，收到同一个新版本：点过 × 不再弹`);
  // 刷新成新版本
  await p.unroute(BASE + '/');
  await p.evaluate(() => location.reload()); await p.waitForSelector('#app:not(.hidden)'); await wait(1500);
  ok(await p.isHidden('#verBar') && await p.evaluate(() => document.querySelector('.sidebar-foot .ver').textContent) === `SSH-WEB v${VERSION}`, '刷新后网页是新版本，提醒消失');
  // 手机也一样
  const m = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage(); m.on('pageerror', (e) => errors.push(e.message));
  await m.route(BASE + '/', async (r) => { const res = await r.fetch(); r.fulfill({ response: res, body: (await res.text()).replaceAll(VERSION, '0.0.1') }); });
  await m.goto(BASE + '/'); await m.waitForSelector('#app:not(.hidden)'); await wait(1500);
  ok(await m.isVisible('#verBar'), '手机：版本不一致也提醒');
  await m.screenshot({ path: shot('version-mobile.png') });
  await m.click('#verBar .vb-reload'); await m.waitForSelector('#app:not(.hidden)'); await wait(1500);
  ok(await m.isVisible('#verBar'), '点「刷新页面」会重新加载 (这里拦截还在，所以仍是旧版本、仍提醒)');
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
