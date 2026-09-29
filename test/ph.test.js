'use strict';
const { BASE, ok, wait, shot, launch, post, addHost, devices } = require('./helpers');
const { Server, utils } = require('ssh2');
new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => { const s = acc(); s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { const st = a(); st.write('$ '); }); }));
}).listen(2233, '127.0.0.1');
(async () => {
  await fetch(BASE + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'H', host: '127.0.0.1', port: 2233, username: 'u', password: 'x' }) });
  const browser = await launch();
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'H' }).click(); await wait(1200);
  // 用一个同样样式的 div 量出提示文字实际需要的高度
  const st = () => p.evaluate(() => {
    const t = document.getElementById('dInput'), cs = getComputedStyle(t);
    const d = document.createElement('div');
    d.textContent = t.placeholder;
    Object.assign(d.style, { position: 'absolute', visibility: 'hidden', width: t.clientWidth + 'px', font: cs.font, lineHeight: cs.lineHeight,
      padding: cs.padding, boxSizing: 'border-box', whiteSpace: 'pre-wrap', wordBreak: cs.wordBreak, overflowWrap: 'break-word' });
    document.body.appendChild(d); const need = d.offsetHeight; d.remove();
    return { h: t.offsetHeight, ch: t.clientHeight, sh: t.scrollHeight, ov: t.style.overflowY || cs.overflowY, need, ph: t.placeholder };
  });
  for (const w of [1280, 1000, 640, 480, 360]) {
    await p.setViewportSize({ width: w, height: 800 }); await wait(400);
    const s = await st();
    ok(s.ov === 'hidden' && s.need <= s.ch + 1, `宽 ${w}: 输入框 ${s.h}px，提示文字需要 ${s.need}px，完整显示、无滚动条`);
    if (w === 640) await p.screenshot({ path: shot('ph-640.png') });
    if (w === 1280) await p.screenshot({ path: shot('ph-1280.png') });
  }
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
