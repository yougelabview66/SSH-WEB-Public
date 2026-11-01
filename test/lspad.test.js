'use strict';
// 历史最后一块很小 (连着的框线行让切块往前挪，最后一块只剩 1 行) 时，刚打开历史视图顶上不能补一段空白 (以前按块数当 100 行算，放进去的不够一屏，顶上空了 692px)
const { BASE, ok, wait, launch, post, hostKey } = require('./helpers');
const { Server } = require('ssh2');
const HIST = Array.from({ length: 3000 }, (_, i) => `line ${i + 1} 普通输出 abc`);
HIST[2899] = '├──────┤'; HIST[2900] = '│ box  │'; // 第 2900、2901 行连着是框线：切块往前挪一行，最后一块只剩 1 行
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a()); s.on('env', (a) => a && a());
    s.on('shell', (a) => { const st = a(); st.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[H\x1b[2J' + HIST.slice(-60).join('\r\n') + '\x1b[999;1H\x1b[42m[main] 0:bash*\x1b[K\x1b[0m'); });
    s.on('exec', (a, r, info) => {
      const ch = a();
      if (info.command.includes('hook.log')) return;
      if (info.command === 'echo %OS%;$env:OS') { ch.write('%OS%\n'); ch.exit(0); ch.end(); return; }
      if (info.command === 'sh') { let buf = ''; ch.on('data', (d) => { buf += d; let m; while ((m = /printf '\\n%s %s\\n' '(\w+)' "\$\?"\n/.exec(buf))) { buf = buf.slice(m.index + m[0].length); ch.write(HIST.join('\n') + `\n\n${m[1]} 0\n`); } }); return; }
      ch.write(HIST.join('\n') + '\n'); ch.exit(0); ch.end();
    });
  }));
}).listen(2293, '127.0.0.1');
(async () => {
  await post('/api/hosts', { name: 'PP', host: '127.0.0.1', port: 2293, username: 'u', password: 'x' });
  const browser = await launch();
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)'); await p.locator('.host', { hasText: 'PP' }).first().click(); await wait(2500);
  const b = await p.locator('.term.active .term-box').boundingBox(); await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await p.evaluate(() => { window.__pt = []; const loop = () => { const pre = document.querySelector('.term.active .ls-body'); if (pre) window.__pt.push(pre.style.paddingTop || '-'); if (window.__pt.length < 30) requestAnimationFrame(loop); }; requestAnimationFrame(loop); });
  await p.mouse.wheel(0, -100); await wait(1500);
  const r = await p.evaluate(() => { const pre = document.querySelector('.term.active .ls-body'); return { pt: pre.style.paddingTop, first: window.__pt.slice(0, 3) }; });
  ok(!r.pt && r.first.every((x) => x === '-'), '最后一块只有 1 行：刚打开顶上不补空白 ' + JSON.stringify(r));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
