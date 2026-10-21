'use strict';
// 侧边栏版本号右边的「清缓存刷新」：网页和用到的文件都绕过缓存重新下载、清掉 Cache Storage、不注销 Service Worker，然后刷新
const { BASE, ok, wait, run, launch, shot, devices } = require('./helpers');

run(async () => {
  const browser = await launch();
  const errors = [];
  for (const [name, opt] of [['电脑', { viewport: { width: 1280, height: 800 } }], ['手机', devices['Pixel 7']]]) {
    const p = await (await browser.newContext(opt)).newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)'); await wait(800);
    if (name === '手机') { await p.tap('#btnToggle'); await wait(500); }
    const pos = await p.evaluate(() => { const v = document.querySelector('.sidebar-foot .ver').getBoundingClientRect(), b = document.getElementById('btnHardReload').getBoundingClientRect(); return { right: b.left >= v.right, row: Math.abs((b.top + b.bottom) / 2 - (v.top + v.bottom) / 2) < 4, inView: b.right <= innerWidth && b.width > 0 }; });
    ok(pos.right && pos.row && pos.inView, `${name}：「清缓存刷新」在版本号右边、同一行: ` + JSON.stringify(pos));
    if (name === '手机') {
      const r = await p.locator('.ver-row').boundingBox();
      await p.screenshot({ path: shot('hardreload-mobile.png'), clip: { x: 0, y: r.y - 10, width: 300, height: r.height + 20 } });
      await p.emulateMedia({ colorScheme: 'dark' }); await wait(200);
      await p.screenshot({ path: shot('hardreload-mobile-dark.png'), clip: { x: 0, y: r.y - 10, width: 300, height: r.height + 20 } });
      await p.emulateMedia({ colorScheme: 'light' });
    }
    // 放一个缓存进 Cache Storage、注册 Service Worker，看刷新后缓存没了、Service Worker 还在
    await p.evaluate(async () => { await (await caches.open('old-cache')).put('/x', new Response('old')); await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; });
    const reqs = [];
    p.on('request', (r) => reqs.push(r.allHeaders().then((h) => [new URL(r.url()).pathname, h['cache-control'] || h.pragma || '', r.resourceType()], () => ['', '', ''])));
    const nav = p.waitForNavigation({ timeout: 15000 }).then(() => true, () => false);
    await p.click('#btnHardReload');
    const reloaded = await nav;
    await p.waitForSelector('#app:not(.hidden)'); await wait(500);
    reqs.splice(0, reqs.length, ...await Promise.all(reqs));
    const fresh = (path) => reqs.some(([u, cc, t]) => u === path && t === 'fetch' && /no-cache/.test(cc));
    ok(reloaded, `${name}：点了之后页面刷新`);
    ok(fresh('/') && fresh('/app.js') && fresh('/style.css'), `${name}：网页、app.js、style.css 都绕过缓存重新下载: ` + JSON.stringify(reqs.filter(([, , t]) => t === 'fetch').map(([u]) => u)));
    const st = await p.evaluate(async () => ({ caches: await caches.keys(), sw: (await navigator.serviceWorker.getRegistrations()).length }));
    ok(st.caches.length === 0 && st.sw === 1, `${name}：Cache Storage 清空了，Service Worker 没注销 (推送订阅还在): ` + JSON.stringify(st));
  }
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close();
});
