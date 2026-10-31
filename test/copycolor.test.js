'use strict';
// 普通画面 (不在历史视图) 打开的复制面板也带颜色：照终端每一格的颜色 / 粗体 / 反色显示，复制出来还是纯文字
const { BASE, ok, wait, shot, launch, devices, hostKey } = require('./helpers');
const { Server } = require('ssh2');
const LONG = 'long colored line '.repeat(8); // 手机上一行放不下，终端自动折成几行
let cols = 0;
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a, r, info) => { cols = info.cols; a(); });
    s.on('window-change', (a, r, info) => { cols = info.cols; a && a(); });
    s.on('shell', (a) => {
      const st = a();
      for (let i = 1; i <= 20; i++) st.write(`plain ${i}\r\n`);
      st.write('\x1b[31mERROR\x1b[0m 普通 \x1b[1;34mBOLDBLUE\x1b[0m\r\n');
      st.write('\x1b[38;5;208mC208\x1b[0m \x1b[38;2;255;128;0mRGB\x1b[0m \x1b[42mBGGREEN\x1b[0m \x1b[7mINV\x1b[0m\r\n');
      st.write('\x1b[32m中文绿色\x1b[0m end\r\n');
      st.write(`\x1b[36m${LONG}\x1b[0m\r\n`);
      st.write('$ ');
    });
  }));
}).listen(2238, '127.0.0.1');

(async () => {
  await fetch(BASE + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'K', host: '127.0.0.1', port: 2238, username: 'u', password: 'x', daemon: false }) });
  const browser = await launch();
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  const m = await ctx.newPage(); const errors = []; m.on('pageerror', (e) => errors.push(e.message));
  await m.goto(BASE + '/'); await m.waitForSelector('#app:not(.hidden)');
  await m.tap('#btnToggle'); await m.locator('.host', { hasText: 'K' }).first().tap(); await wait(1500);
  await m.locator('.mkeys button[data-k=copy]').tap(); await wait(500);

  const r = await m.evaluate(() => {
    const p = document.getElementById('copyText');
    // 包着这段字的最近一层带样式的 span
    const styleOf = (word) => {
      const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        if (!n.data.includes(word[0])) continue;
        // 这个字可能被按字宽拆进好几层 span：往上找带 color / background 的那层
        for (let e = n.parentElement; e && e !== p; e = e.parentElement) {
          if (/color|background/.test(e.getAttribute('style') || '') && e.textContent.includes(word)) return e.getAttribute('style');
        }
      }
      return '';
    };
    return {
      text: p.lsText || '', shown: p.textContent,
      error: styleOf('ERROR'), bold: styleOf('BOLDBLUE'), c208: styleOf('C208'), rgb: styleOf('RGB'),
      bg: styleOf('BGGREEN'), inv: styleOf('INV'), zh: styleOf('中文绿色'), plain: styleOf('plain 1'),
      info: document.getElementById('copyInfo').textContent,
    };
  });
  ok(!r.info.includes('tmux'), `普通画面打开 (${r.info})`);
  ok(/color/.test(r.error) && /color/.test(r.c208) && /color/.test(r.zh), `红色 / 256 色 / 中文的颜色都在 (ERROR: ${r.error}；C208: ${r.c208}；中文: ${r.zh})`);
  ok(/rgb\(255, ?128, ?0\)|#ff8000/i.test(r.rgb), `RGB 颜色照原样 (${r.rgb})`);
  ok(/font-weight:bold/.test(r.bold) && /color/.test(r.bold), `粗体带颜色 (${r.bold})`);
  ok(/background/.test(r.bg) && /background/.test(r.inv), `背景色、反色都显示 (背景: ${r.bg}；反色: ${r.inv})`);
  ok(!r.plain, `没颜色的字不加样式 (${r.plain || '无'})`);
  ok(!r.text.includes('\x1b') && r.text.includes('ERROR 普通 BOLDBLUE') && r.text.includes('C208 RGB BGGREEN INV'), '复制用的原文是纯文字，没有颜色序列');
  ok(r.text.includes('中文绿色 end') && !r.text.includes('中中'), '两格宽的中文不重复、不多出空格');
  const longLine = r.text.split('\n').find((l) => l.includes('long colored line'));
  ok(longLine === LONG && cols > 0 && cols < LONG.length, `终端自动折行的长行接回一整行 (终端 ${cols} 列，复制原文里是一行 ${longLine?.length} 字)`);

  await m.screenshot({ path: shot('copycolor.png') });
  await m.tap('#copyAll'); await wait(400);
  const clip = await m.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  ok(clip && !clip.includes('\x1b') && clip.includes('ERROR 普通 BOLDBLUE'), `「复制全部」复制出来是纯文字 (${clip.length} 字)`);
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
