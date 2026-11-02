'use strict';
// 终端对程序询问的自动回答：程序退出时问的终端型号 (Codex 退出时 ESC[<u … ESC[c，不等回答就退出) 不回答 ——
// 回答晚到会落进 shell，提示符后面多出「1;2c」、紧接着打的命令被拼坏。平时的询问照常回答 (程序拿它当「询问结束」的信号)
const { Server } = require('ssh2');
const { BASE, ok, wait, launch, hostKey } = require('./helpers');

let got = '', st = null;
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { st = a(); st.write('$ '); st.on('data', (d) => { got += d; }); });
    s.on('exec', (a) => { const ch = a(); ch.exit(3); ch.end(); });
  }));
}).listen(2341, '127.0.0.1');

(async () => {
  await fetch(BASE + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'TR', host: '127.0.0.1', port: 2341, username: 'u', password: 'x', daemon: false }) });
  const browser = await launch();
  const p = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'TR' }).first().click();
  for (let i = 0; i < 50 && !st; i++) await wait(200);
  await wait(1500);
  got = '';
  st.write('\x1b[?2026h\x1b[0m\x1b[?2026l\x1b]0;\x07\x1b[<1u\x1b[<u\x1b[>4;0m\x1b[?2004l\x1b[?1004l\x1b[c\x1b[0 q\x1b[?25hDisconnected from this task.\r\n$ ');
  await wait(1500);
  ok(!/\x1b\[\?[\d;]*c/.test(got), '程序退出时 (先弹出键盘增强设置 ESC[<u) 问的终端型号不回答，shell 里不会多出「1;2c」: ' + JSON.stringify(got));
  got = '';
  st.write('\x1b[c');
  await wait(1500);
  ok(/\x1b\[\?[\d;]*c/.test(got), '平时问终端型号照常回答: ' + JSON.stringify(got));
  got = '';
  st.write('\x1b[<u'); await wait(800); st.write('\x1b[c');
  await wait(1500);
  ok(/\x1b\[\?[\d;]*c/.test(got), '弹出键盘设置过了一会儿再问 (不是退出时连着发的)：照常回答: ' + JSON.stringify(got));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
