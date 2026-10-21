'use strict';
const { BASE, ok, wait, shot, launch, post, addHost, devices, hostKey } = require('./helpers');
const { Server, utils } = require('ssh2');
const streams = [];
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => { const s = acc(); s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { const st = a(); streams.push(st); st.write('$ '); }); }));
}).listen(2251, '127.0.0.1');
const B = BASE;
(async () => {
  await fetch(B + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'HF', host: '127.0.0.1', port: 2251, username: 'u', password: 'x' }) });
  const browser = await launch();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(() => {
    window.__pipOpts = [];
    window.__watch = [];
    const wsSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) { if (typeof d === 'string' && d.includes('"watching"')) window.__watch.push(JSON.parse(d)); return wsSend.call(this, d); };
    const dp = window.documentPictureInPicture;
    if (dp) { const orig = dp.requestWindow.bind(dp); dp.requestWindow = (o) => { window.__pipOpts.push(o); return orig(o); }; }
  });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => { console.log('DIALOG: ' + d.message()); d.dismiss().catch(() => {}); });
  await p.goto(B + '/'); await p.waitForSelector('#app:not(.hidden)');
  ok(await p.isHidden('#hostFloat'), '没有标签时不显示悬浮窗');
  for (let i = 0; i < 2; i++) { await p.locator('.host', { hasText: 'HF' }).click(); await wait(1000); }
  const box = () => p.evaluate(() => { const r = document.getElementById('hostFloat').getBoundingClientRect(); const m = document.querySelector('main').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: m.right - r.right, top: r.top - m.top, mw: m.width, mh: m.height, mx: m.x }; });
  const chips = () => p.locator('#hostFloat .dp-tab').allTextContents();
  ok(await p.isVisible('#hostFloat'), '底部模式：显示主机状态悬浮窗');
  let b = await box();
  ok(b.right >= 8 && b.right <= 16 && b.top >= 38 && b.top <= 50, `默认在终端右上角 (离右边 ${Math.round(b.right)}px，离顶部 ${Math.round(b.top)}px)`);
  let c = await chips();
  ok(c.length === 2 && c[0].includes('HF-1') && c[1].includes('HF-2'), '悬浮窗里每个标签一个卡片: ' + c.map((x) => x.replace(/\s+/g, ' ').trim()).join(' | '));
  await p.screenshot({ path: shot('hfloat.png') });
  // 点卡片切标签，焦点留在输入框
  await p.locator('#hostFloat .dp-tab', { hasText: 'HF-1' }).click(); await wait(400);
  ok(await p.evaluate(() => document.querySelector('.tab.active .title').textContent) === 'HF-1', '点卡片切到那个标签');
  ok(await p.evaluate(() => document.activeElement.id) === 'dInput', '焦点仍在输入框');
  // 状态跟着变：后台标签持续输出 → 运行中
  const iv = setInterval(() => streams[1].write('.'), 150); await wait(1800);
  c = await chips(); clearInterval(iv);
  ok(c[1].includes('运行中'), '后台标签持续输出 → 悬浮窗里显示运行中');
  // 拖动
  const head = await p.locator('#hostFloat .hf-head .hf-title').boundingBox();
  await p.mouse.move(head.x + 10, head.y + 5); await p.mouse.down();
  for (let i = 1; i <= 10; i++) { await p.mouse.move(head.x + 10 - 40 * i, head.y + 5 + 25 * i); await wait(15); }
  await p.mouse.up(); await wait(300);
  const b2 = await box();
  ok(Math.abs((b.right - b2.right) + 400) <= 3 && Math.abs(b2.y - (b.y + 250)) <= 3, `按住标题栏拖动：右边缘移动了 (${Math.round(b.right - b2.right)}, ${Math.round(b2.y - b.y)})，悬浮窗按右上角定位`);
  ok(await p.evaluate(() => document.activeElement.id) === 'dInput', '拖完焦点回到输入框');
  // 拖到外面被限制在终端区域内
  const h2 = await p.locator('#hostFloat .hf-head .hf-title').boundingBox();
  await p.mouse.move(h2.x + 5, h2.y + 5); await p.mouse.down(); await p.mouse.move(h2.x + 3000, h2.y - 3000, { steps: 5 }); await p.mouse.up(); await wait(300);
  const b3 = await box();
  ok(b3.right >= -1 && b3.top >= 37 && b3.x + b3.w <= b3.mx + b3.mw + 1, `拖出范围时停在边上 (离右边 ${Math.round(b3.right)}，离顶部 ${Math.round(b3.top)})，不会盖住标签栏`);
  await p.mouse.move(h2.x, h2.y); // 移回来一点，方便后面检查
  const hb = await p.locator('#hostFloat .hf-head .hf-title').boundingBox();
  await p.mouse.move(hb.x + 5, hb.y + 5); await p.mouse.down(); await p.mouse.move(hb.x - 300, hb.y + 100, { steps: 5 }); await p.mouse.up(); await wait(300);
  const saved = await box();
  // 收起
  await p.click('#hostFloat [data-a=min]'); await wait(700);
  ok(await p.evaluate(() => document.getElementById('hostFloat').classList.contains('min')) && await p.isHidden('#hostFloat .dp-tabs') && await p.locator('#hostFloat .hf-d').count() === 2, '点「–」收起：只剩标题栏，用小圆点显示 2 个标签的状态');
  ok(await p.textContent('#hostFloat [data-a=min]') === '+' && await p.getAttribute('#hostFloat [data-a=min]', 'title') === '展开', '收起后按钮变成「+」(展开)，不再是「–」');
  await p.screenshot({ path: shot('hfloat-min.png') });
  // 刷新后位置、收起状态保持
  await p.reload(); await p.waitForSelector('.tab'); await wait(1500);
  const b4 = await box();
  ok(Math.abs(b4.right - saved.right) <= 2 && Math.abs(b4.top - saved.top) <= 2 && await p.evaluate(() => document.getElementById('hostFloat').classList.contains('min')), '刷新后位置和收起状态都保持');
  await p.click('#hostFloat [data-a=min]'); await wait(500);
  ok(await p.isVisible('#hostFloat .dp-tabs') && await p.textContent('#hostFloat [data-a=min]') === '–', '再点一次展开，按钮变回「–」');
  // 标题栏按钮靠右，最右边的「×」和第一行最右边的卡片对齐
  const al0 = await p.evaluate(() => { const f = document.getElementById('hostFloat'), cs = [...f.querySelectorAll('.dp-tab')];
    const top = cs[0].offsetTop, right = Math.max(...cs.filter((c) => c.offsetTop === top).map((c) => c.getBoundingClientRect().right));
    return { min: f.querySelector('[data-a=close]').getBoundingClientRect().right, right }; });
  ok(Math.abs(al0.min - al0.right) <= 1, '悬浮窗「×」的右边和第一行最右边的卡片对齐: ' + JSON.stringify(al0));
  // 悬浮窗和输入框模式无关：底部 / 浮动都显示
  await p.click('#dMode'); await wait(500);
  ok(await p.isVisible('#hostFloat'), '输入框浮动模式：悬浮窗照样显示');
  await p.click('#dMode'); await wait(300);
  // 「⋯ 更多 → 状态卡片」开关 (顶栏上不再单独放「🖥️ 状态」按钮，同手机)
  const toggleHf = async () => { await p.click('#btnMore'); await p.click('#btnFloatM'); await wait(300); };
  const hfBtnOn = () => p.evaluate(() => document.getElementById('btnFloatM').classList.contains('on'));
  ok(!(await p.$('#btnFloat')) && await hfBtnOn(), '顶栏上没有单独的「🖥️ 状态」按钮，菜单里的「状态卡片」默认打着勾');
  await toggleHf();
  ok(await p.isHidden('#hostFloat') && !await hfBtnOn(), '「⋯ 更多 → 状态卡片」关掉悬浮窗');
  await p.reload(); await p.waitForSelector('.tab'); await wait(1500);
  ok(await p.isHidden('#hostFloat'), '刷新后保持关闭');
  await toggleHf();
  ok(await p.isVisible('#hostFloat'), '再点一次打开');
  // 标题栏「–」右边的「×」：关掉 (同菜单里关，记住)
  const hbs = await p.evaluate(() => [...document.querySelectorAll('#hostFloat .hf-head button')].map((b) => b.dataset.a));
  ok(hbs.indexOf('close') === hbs.indexOf('min') + 1 && hbs.at(-1) === 'close', '标题栏「–」右边有「×」: ' + JSON.stringify(hbs));
  await p.click('#hostFloat [data-a=close]'); await wait(300);
  ok(await p.isHidden('#hostFloat') && !await hfBtnOn(), '点「×」关掉悬浮窗，菜单里的「状态卡片」也取消打勾');
  await p.reload(); await p.waitForSelector('.tab'); await wait(1500);
  ok(await p.isHidden('#hostFloat'), '点「×」关掉后刷新也保持关闭');
  await toggleHf();
  ok(await p.isVisible('#hostFloat'), '从「⋯ 更多 → 状态卡片」重新打开');
  // 置顶到桌面 (文档画中画)
  const hasPip = await p.evaluate(() => 'documentPictureInPicture' in window);
  if (hasPip) {
    await p.click('#hostFloat [data-a=pip]'); await wait(1500);
    const pip = await p.evaluate(() => { try { const w = window.documentPictureInPicture.window; return w ? { n: w.document.querySelectorAll('.dp-tab').length, text: w.document.body.innerText.replace(/\s+/g, ' ') } : null; } catch (e) { return 'err ' + e.message; } });
    ok(pip && pip.n === 2, '📌 置顶到桌面：小窗口里显示 2 个标签的状态: ' + JSON.stringify(pip));
    ok(await p.isHidden('#hostFloat'), '置顶窗口打开时，网页里的悬浮窗隐藏');
    // 焦点在置顶小窗口上：也算网页在前台，不推送 (无头浏览器里两边都算有焦点，这里模拟主网页失去焦点)
    const pf = await p.evaluate(async () => {
      const w = window.documentPictureInPicture.window, hf = document.hasFocus.bind(document);
      document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); await new Promise((r) => setTimeout(r, 100));
      const onPip = window.__watch.at(-1)?.front;
      w.document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); await new Promise((r) => setTimeout(r, 100));
      const none = window.__watch.at(-1)?.front;
      document.hasFocus = hf; delete w.document.hasFocus; window.dispatchEvent(new Event('focus'));
      return { onPip, none };
    });
    ok(pf.onPip === true && pf.none === false, '焦点只在置顶小窗口上：还算在前台 (不推送)；两边都没焦点：不在前台 ' + JSON.stringify(pf));
    const opts = await p.evaluate(() => window.__pipOpts.at(-1));
    ok(opts && opts.disallowReturnToOpener === true, '打开时不显示 Chrome 自带的「返回标签页」按钮 (disallowReturnToOpener)');
    ok(await p.evaluate(() => !!window.documentPictureInPicture.window.document.querySelector('[data-a=back]')), '小窗口里有自己的「↩ 网页」按钮');
    const al = await p.evaluate(() => { const d = window.documentPictureInPicture.window.document, cs = [...d.querySelectorAll('.dp-tab')];
      const top = cs[0].offsetTop, right = Math.max(...cs.filter((c) => c.offsetTop === top).map((c) => c.getBoundingClientRect().right));
      return { back: d.querySelector('[data-a=back]').getBoundingClientRect().right, right, win: d.body.clientWidth }; });
    ok(Math.abs(al.back - al.right) <= 1, '「↩ 网页」的右边和第一行最右边的卡片对齐: ' + JSON.stringify(al));
    await p.evaluate(() => window.documentPictureInPicture.window.document.querySelector('.dp-tab').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })));
    await wait(300);
    ok(await p.evaluate(() => !!window.documentPictureInPicture.window) && await p.evaluate(() => document.querySelector('.tab.active .title').textContent) === 'HF-1', '点小窗口里的卡片切到那个标签，小窗口继续留着');
    await p.evaluate(() => window.documentPictureInPicture.window?.close()); await wait(800);
    ok(await p.isVisible('#hostFloat'), '关掉置顶窗口后，网页里的悬浮窗重新出现');
    await p.click('#hostFloat [data-a=pip]'); await wait(1200);
    await toggleHf(); await wait(500);
    ok(await p.evaluate(() => !window.documentPictureInPicture.window) && await p.isHidden('#hostFloat'), '置顶窗口开着时关掉「状态卡片」：小窗口也一起关掉');
    await toggleHf();
    // 自动钉住
    await p.click('#hostFloat [data-a=auto]'); await wait(1200);
    ok(await p.evaluate(() => document.querySelector('#hostFloat [data-a=auto]').classList.contains('on')) && await p.evaluate(() => !!window.documentPictureInPicture.window), '打开「自动」：按钮高亮，并马上钉住');
    await p.reload(); await p.waitForSelector('.tab'); await wait(1500);
    ok(await p.evaluate(() => !window.documentPictureInPicture.window), '刷新后还没操作时不会弹出 (浏览器规定要先点击 / 按键)');
    let dialogs = 0; p.on('dialog', () => dialogs++);
    await p.keyboard.press('Escape'); await p.keyboard.press('Escape'); await wait(800);
    ok(dialogs === 0, '第一个键是 Esc (浏览器不算作用户操作)：不去打开，也不弹错误提示');
    await p.mouse.click(500, 300); await wait(1200);
    ok(await p.evaluate(() => !!window.documentPictureInPicture.window) && await p.isHidden('#hostFloat'), '第一次点击页面 → 自动钉住到桌面，网页里的悬浮窗隐藏');
    await p.evaluate(() => window.documentPictureInPicture.window.close()); await wait(800);
    await p.mouse.click(500, 300); await p.keyboard.press('a'); await wait(1200);
    ok(await p.evaluate(() => !window.documentPictureInPicture.window) && await p.isVisible('#hostFloat'), '手动关掉后，这次不再自动打开');
    await p.reload(); await p.waitForSelector('.tab'); await wait(1500);
    await p.keyboard.press('b'); await wait(1200);
    ok(await p.evaluate(() => !!window.documentPictureInPicture.window), '下次打开网页，第一次按键又自动钉住');
    await p.evaluate(() => window.documentPictureInPicture.window?.close()); await wait(500);
    await p.click('#hostFloat [data-a=auto]'); await wait(300);
    await p.evaluate(() => window.documentPictureInPicture.window?.close()); await wait(300);
  } else ok(true, '这个浏览器不支持文档画中画 (跳过)');
  // 手机
  const m = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage(); m.on('pageerror', (e) => errors.push(e.message));
  await m.goto(B + '/'); await m.waitForSelector('.tab'); await wait(1000);
  ok(await m.isHidden('#hostFloat'), '手机上不显示悬浮窗');
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
