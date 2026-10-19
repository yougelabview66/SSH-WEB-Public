'use strict';
// 切标签：最近用过的几个标签 (电脑 6 个、手机 4 个) 留着 WebGL 渲染器，切回来不重建 (以前每次切换都拆掉重建，标签多时卡)；
// 超出的空下来再拆；藏着时字号变了切回来重建；几个标签的 GPU 上下文一起丢 (切到后台) 只算一次失败，不会就此关掉 WebGL
const { Server } = require('ssh2');
const { BASE, ok, wait, launch, addHost, run, hostKey } = require('./helpers');
let n = 0;
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc(); const id = ++n;
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { a().write(`\x1b[32mTAB${id}\x1b[0m $ `); });
  }));
}).listen(2288, '127.0.0.1');

run(async () => {
  await addHost('GL', 2288);
  const browser = await launch();
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  if (!(await p.evaluate(() => !!document.createElement('canvas').getContext('webgl2')))) { ok(true, '(没有 WebGL，跳过)'); await browser.close(); return; }
  for (let i = 0; i < 8; i++) { await p.locator('.host', { hasText: 'GL' }).first().click(); await wait(700); }
  await wait(1500);
  const tabs = p.locator('.tab');
  ok(await tabs.count() === 8, '开了 8 个标签');
  // 每个标签的 WebGL 画布打上编号，看切回来是不是同一个
  const mark = () => p.evaluate(() => { let k = 0; document.querySelectorAll('.term').forEach((t) => { const c = t.querySelector('canvas'); if (c && !c.dataset.id) c.dataset.id = 'c' + (++window.__cid || (window.__cid = 1)) + '-' + k; k++; }); });
  const canvasOf = (i) => p.evaluate((i) => document.querySelectorAll('.term')[i].querySelector('canvas')?.dataset.id || null, i);
  const glCount = () => p.evaluate(() => [...document.querySelectorAll('.term')].filter((t) => t.querySelector('canvas')).length);
  const sw = async (i) => { await tabs.nth(i).click(); await wait(250); await mark(); };
  await mark();
  await sw(1); await sw(2); await sw(3);
  const c1 = await canvasOf(1), c2 = await canvasOf(2);
  ok(!!c1 && !!c2, '切走的标签还留着 WebGL 画布');
  await sw(1); await sw(2);
  ok(await canvasOf(1) === c1 && await canvasOf(2) === c2, '切回最近用过的标签：渲染器没有重建 (同一个画布)');
  // 用过的超过 6 个：最久没用的空下来后拆掉
  for (const i of [0, 4, 5, 6, 7]) await sw(i);
  await wait(2500); // 切换 1 秒后开始拆，一次拆一个
  const cnt = await glCount();
  ok(cnt === 6 && !(await canvasOf(3)), `用过 8 个标签，只留最近 6 个的 WebGL (现在 ${cnt} 个)，最久没用的拆掉了`);
  await sw(3);
  ok(!!(await canvasOf(3)), '切回被拆掉的标签：重新建渲染器');
  // 藏着的时候字号变了：切回来重建 (藏起来时量不准字宽)，画出来的宽度和当前标签一样
  const before = await canvasOf(7);
  await p.click('#fontInc'); await wait(300);
  await sw(7); await wait(600);
  ok(await canvasOf(7) !== before, '藏着时字号变了，切回来渲染器重建');
  const dims = await p.evaluate(() => { const sc = document.querySelector('.term.active .xterm-screen'); const box = document.querySelector('.term.active .term-box'); return [sc.getBoundingClientRect().width, box.clientWidth]; });
  ok(dims[1] - dims[0] < 40 && dims[0] > 0, `字号变了切回来终端照样铺满 (${Math.round(dims[0])} / ${dims[1]})`);
  await p.click('#fontDec'); await wait(300);
  // 几个标签的 GPU 上下文一起丢 (手机切到后台)：只算一次失败 (失败三次才关掉 WebGL)，不能一下子就关掉
  const lost = await p.evaluate(() => { let k = 0; document.querySelectorAll('.term canvas').forEach((c) => { try { c.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext(); k++; } catch {} }); return k; });
  await wait(4000); // xterm 等 3 秒没恢复才报上下文丢了
  await sw(1); await wait(300);
  ok(lost >= 3 && await p.evaluate(() => !!document.querySelector('.term.active canvas')), `${lost} 个标签的 GPU 上下文一起丢了，切标签 WebGL 照样能用`);
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close();
});
