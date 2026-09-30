'use strict';
// 标签多到放不下：不显示滚动条 (不把标签压矮)、两边渐隐 + ‹ › 箭头、滚轮左右翻、▾ 全部标签
const { BASE, ok, wait, shot, hostKey, chromium, devices } = require('./helpers');
const { Server } = require('ssh2');
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => { const s = acc(); s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { const st = a(); st.write('$ '); }); }));
}).listen(2252, '127.0.0.1');
(async () => {
  await fetch(BASE + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '家里的NAS服务器', host: '127.0.0.1', port: 2252, username: 'u', password: 'x' }) });
  // 像 Windows 电脑一样显示占地方的滚动条 (无头浏览器默认藏起来，复现不出标签被压矮)
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'], ignoreDefaultArgs: ['--hide-scrollbars'] });
  const errors = [];
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 600 } })).newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  const st = () => p.evaluate(() => {
    const t = document.getElementById('tabs'), a = document.querySelector('.tab.active');
    const ar = a.getBoundingClientRect(), tr = t.getBoundingClientRect();
    return { tabH: Math.round(a.getBoundingClientRect().height), barH: document.getElementById('tabbar').clientHeight, x: Math.round(t.scrollLeft),
      l: t.classList.contains('more-l'), r: t.classList.contains('more-r'), arrows: !document.getElementById('tabsL').classList.contains('hidden'),
      list: !document.getElementById('btnTabList').classList.contains('hidden'), lDis: document.getElementById('tabsL').disabled, rDis: document.getElementById('tabsR').disabled,
      inView: ar.left >= tr.left + (t.classList.contains('more-l') ? 20 : 0) - 1 && ar.right <= tr.right - (t.classList.contains('more-r') ? 20 : 0) + 1,
      pos: [Math.round(ar.left - tr.left), Math.round(tr.right - ar.right)], focus: document.activeElement.id };
  });
  for (let i = 0; i < 3; i++) { await p.locator('.host').first().click(); await wait(500); }
  let s = await st();
  ok(!s.arrows && !s.list && !s.l && !s.r, '标签放得下时：没有箭头、没有 ▾、不渐隐');
  for (let i = 0; i < 11; i++) { await p.locator('.host').first().click(); await wait(400); }
  await wait(800);
  s = await st();
  ok(s.tabH >= s.barH - 1, `14 个标签放不下时，标签高度不被压矮 (${s.tabH}px / 标签栏 ${s.barH}px)`);
  ok(s.arrows && s.list, '放不下时：显示 ‹ › 箭头和 ▾');
  ok(s.l && !s.r && !s.lDis && s.rDis, '停在最右边 (新开的标签)：左边渐隐、右箭头变灰 ' + JSON.stringify(s));
  ok(s.inView, '当前标签完整露出来，不停在渐隐的地方 ' + JSON.stringify(s.pos));
  await p.screenshot({ path: shot('tabbar.png'), clip: { x: 0, y: 0, width: 1280, height: 50 } });
  // 滚轮上下滚 = 左右翻
  const tb = await p.locator('#tabs').boundingBox();
  await p.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
  const x0 = s.x;
  await p.mouse.wheel(0, -400); await wait(400);
  s = await st();
  ok(s.x < x0 && s.r, `鼠标在标签栏上滚轮往上 → 标签往左翻 (${x0} → ${s.x})，右边也出现渐隐`);
  // 箭头
  await p.click('#dInput');
  const x1 = s.x; await p.click('#tabsL'); await wait(700);
  s = await st();
  ok(s.x < x1 && s.focus === 'dInput', `点 ‹ 往左翻 (${x1} → ${s.x})，焦点留在输入框`);
  await p.click('#tabsR'); await wait(700);
  ok((await st()).x > s.x, '点 › 往右翻');
  // ▾ 全部标签
  await p.click('#btnTabList'); await wait(300);
  const rows = await p.locator('#tabListPop .dp-tab').allTextContents();
  ok(await p.isVisible('#tabListPop') && rows.length === 14 && rows[13].includes('家里的NAS服务器-14') && await p.locator('#tabListPop .dp-tab.cur').count() === 1,
    `点 ▾ 列出全部 14 个标签 (带状态)，当前标签高亮: ${rows[0].replace(/\s+/g, ' ').trim()} …`);
  await p.screenshot({ path: shot('tablist.png'), clip: { x: 700, y: 0, width: 580, height: 600 } });
  await p.locator('#tabListPop .dp-tab').first().click(); await wait(500);
  s = await st();
  ok(await p.isHidden('#tabListPop') && await p.evaluate(() => document.querySelector('.tab.active .title').textContent) === '家里的NAS服务器-1', '点列表里的第 1 个 → 切过去，列表关掉');
  ok(s.x === 0 && s.inView && !s.l && s.focus === 'dInput', '切到的标签滚进视野 (到最左边)，焦点留在输入框 ' + JSON.stringify(s));
  await p.click('#btnTabList'); await wait(200); await p.keyboard.press('Escape'); await wait(200);
  ok(await p.isHidden('#tabListPop'), 'Esc 关掉列表');
  await p.click('#btnTabList'); await wait(200); await p.mouse.click(600, 400); await wait(200);
  ok(await p.isHidden('#tabListPop'), '点别处关掉列表');
  // Alt+← 循环到最后一个也要滚进视野
  await p.keyboard.press('Alt+ArrowLeft'); await wait(400);
  s = await st();
  ok(s.inView && s.x > 0, 'Alt+← 跳到最后一个标签，它也完整露出来 ' + JSON.stringify(s));
  // 关掉标签到放得下 → 箭头 / ▾ 消失
  while (await p.locator('.tab').count() > 3) { await p.locator('.tab.active .x').click(); await wait(250); }
  await wait(400); s = await st();
  ok(!s.arrows && !s.list && !s.l && !s.r, '关到放得下时箭头、▾、渐隐都消失');
  // 手机：没有箭头 (手指滑)，有 ▾
  const m = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage(); m.on('pageerror', (e) => errors.push(e.message));
  await m.goto(BASE + '/'); await m.waitForSelector('.tab'); await wait(1000);
  for (let i = 0; i < 5; i++) { await m.locator('#btnToggle').tap(); await wait(300); await m.locator('.host').first().tap(); await wait(600); }
  await wait(600);
  const ms = await m.evaluate(() => ({ arrows: !document.getElementById('tabsL').classList.contains('hidden'), list: !document.getElementById('btnTabList').classList.contains('hidden'),
    tabH: document.querySelector('.tab').getBoundingClientRect().height, barH: document.getElementById('tabbar').clientHeight, n: document.querySelectorAll('.tab').length }));
  ok(!ms.arrows && ms.list && ms.tabH >= ms.barH - 1, `手机：${ms.n} 个标签放不下时不显示箭头 (手指滑)，有 ▾，标签高度不变`);
  const mr = await m.evaluate(() => { const t = document.getElementById('tabs'), a = document.querySelector('.tab.active').getBoundingClientRect(), c = t.getBoundingClientRect();
    return { r: t.classList.contains('more-r'), right: Math.round(c.right - a.right) }; });
  ok(!mr.r && Math.abs(mr.right) <= 1, '手机：标签栏很窄时，新开的最后一个标签也完整露出来 (滚到底、右边不渐隐) ' + JSON.stringify(mr));
  await m.screenshot({ path: shot('tabbar-mobile.png'), clip: { x: 0, y: 0, width: 412, height: 50 } });
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
