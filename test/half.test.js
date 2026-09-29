'use strict';
const { BASE, ok, wait, shot, launch, addHost } = require('./helpers');
const { Server, utils } = require('ssh2');
new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => { const s = acc(); s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { a().write('$ '); }); }));
}).listen(2252, '127.0.0.1');
(async () => {
  await addHost('HALF', 2252);
  const browser = await launch();
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'HALF' }).click(); await wait(1200);
  if (await p.isHidden('#deskBar')) await p.click('#btnInput');
  const st = () => p.evaluate(() => { const t = document.getElementById('dInput'); return { h: t.offsetHeight, sh: t.scrollHeight, ch: t.clientHeight, ov: getComputedStyle(t).overflowY, bh: document.getElementById('dSend').offsetHeight }; });
  for (const w of [1280, 640, 480, 360]) {
    await p.setViewportSize({ width: w, height: 800 }); await p.fill('#dInput', ''); await p.evaluate(() => document.getElementById('dInput').dispatchEvent(new Event('input'))); await wait(300);
    const s = await st();
    ok(s.ov === "hidden" && s.sh <= s.ch && s.h >= 60, `宽 ${w}: 空输入框高 ${s.h}px，无滚动条 (${s.ov})，发送按钮高 ${s.bh}`);
    if (w === 640) await p.screenshot({ path: shot('half.png') });
  }
  await p.setViewportSize({ width: 640, height: 800 });
  await p.click('#dInput'); await p.keyboard.type('一段很长的文字'.repeat(12)); await wait(200);
  let s = await st(); ok(s.ov === 'hidden' && s.h > 70, `长文字自动折行变高 ${s.h}px，无滚动条`);
  await p.keyboard.type('更多文字'.repeat(120)); await wait(200);
  s = await st(); ok(s.ov === 'auto' && s.h <= 330, `超过最大高度 (40vh) 才出现滚动条，高 ${s.h}px`);
  await p.screenshot({ path: shot('half2.png') });
  await p.fill('#dInput', ''); await p.evaluate(() => document.getElementById('dInput').dispatchEvent(new Event('input')));
  await browser.close();
  process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
