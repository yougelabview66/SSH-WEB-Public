'use strict';
// 没装钩子 (或 SSH-WEB 重启后 Agent 还没发过事件) 时看屏幕认 Grok (public/app/09-agents.js 的 screen)：
// 照 Grok 1.0.70 实测的样子 —— 不用备用屏幕 (alt_screen = "never")、要所有鼠标移动 (SGR)、输入框「│ ❯ …」带右边框、底下「Ctrl+x:shortcuts」。
//  - 电脑上左键直接拖动在终端里选字
//  - 下方输入栏发消息前先点它的输入框，点在已有文字的末尾 (中文占两格)：焦点在聊天记录上时 Grok 会把中文丢掉
//  - 屏幕上是 Claude Code 的界面：都不做
const { Server } = require('ssh2');
const { BASE, ok, wait, launch, hostKey } = require('./helpers');

const got = {}, rows = {};
const GROK = (r) => '\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[H\x1b[2J'
  + Array.from({ length: 8 }, (_, i) => `     grok reply line ${i} hello world`).join('\r\n')
  + `\x1b[${r - 3};1H  ╭${'─'.repeat(50)}╮\x1b[${r - 2};1H  │ ❯ 你好\x1b[${r - 2};55H│\x1b[${r - 1};1H  ╰${'─'.repeat(50)}╯`
  + `\x1b[${r};1H  Shift+Tab:mode  │  Ctrl+x:shortcuts\x1b[${r - 2};11H`;
const CLAUDE = (r) => '\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[H\x1b[2J'
  + Array.from({ length: 8 }, (_, i) => `claude reply line ${i} hello world`).join('\r\n')
  + `\x1b[${r - 2};1H│ > \x1b[${r};1H  ? for shortcuts\x1b[${r - 2};5H`;
for (const [port, draw] of [[2249, GROK], [2250, CLAUDE]]) {
  got[port] = '';
  new Server({ hostKeys: [hostKey()] }, (c) => {
    c.on('authentication', (ctx) => ctx.accept());
    c.on('ready', () => c.on('session', (acc) => {
      const s = acc();
      let st = null;
      s.on('pty', (a, r, info) => { rows[port] = info.rows; a(); });
      s.on('window-change', (a, r, info) => { rows[port] = info.rows; a && a(); if (st) st.write(draw(info.rows)); });
      s.on('shell', (a) => { st = a(); st.on('data', (d) => { got[port] += d; }); st.write(draw(rows[port] || 24)); });
    }));
  }).listen(port, '127.0.0.1');
}

(async () => {
  for (const [name, port] of [['GS', 2249], ['CS', 2250]]) {
    await fetch(BASE + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, host: '127.0.0.1', port, username: 'u', password: 'x', daemon: false }) });
  }
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  const m = await ctx.newPage(); const errors = []; m.on('pageerror', (e) => errors.push(e.message));
  await m.goto(BASE + '/'); await m.waitForSelector('#app:not(.hidden)');

  const run = async (name, port) => {
    await m.locator('.host', { hasText: name }).first().click(); await wait(2000);
    const b = await m.locator('.term.active .xterm-screen').boundingBox();
    await m.evaluate(() => navigator.clipboard.writeText('EMPTY'));
    await m.mouse.move(b.x + 40, b.y + 8); got[port] = '';
    await m.mouse.down(); await m.mouse.move(b.x + 260, b.y + 50, { steps: 10 }); await m.mouse.up(); await wait(500);
    const clip = await m.evaluate(() => navigator.clipboard.readText());
    const presses = (got[port].match(/\x1b\[<0;\d+;\d+M/g) || []).length;
    const focusIn = got[port].includes('\x1b[I');
    await m.focus('#dInput'); got[port] = '';
    await m.keyboard.type('hi'); await m.keyboard.press('Enter'); await wait(800);
    return { clip, presses, focusIn, sent: got[port], rows: rows[port] };
  };

  const g = await run('GS', 2249);
  ok(g.clip.includes('reply line') && g.presses === 0, `没装钩子、屏幕上是 Grok：直接拖动选中并复制「${g.clip.slice(0, 20)}」，按下没报给它 (${g.presses})`);
  ok(!g.focusIn && !g.sent.includes('\x1b[I') && !g.sent.includes('\x1b[O'), 'Grok：不把终端获得 / 失去焦点的通知转给它 (它一收到就整屏重画，冲掉选区)');
  const click = `\x1b[<0;11;${g.rows - 2}M\x1b[<0;11;${g.rows - 2}m`; // 「  │ ❯ 你好」：你好占第 7~10 格，点第 11 格
  ok(g.sent.startsWith(click + 'hi'), `Grok：发消息前点在输入框里「你好」后面 (第 11 列)，再发字 ${JSON.stringify(g.sent.slice(0, 40))}`);

  const c = await run('CS', 2250);
  ok(c.clip === 'EMPTY' && c.presses === 1, `屏幕上是 Claude Code：拖动照旧交给程序 (按下报了 ${c.presses} 次)`);
  ok(c.sent.startsWith('hi') && !c.sent.includes('\x1b[<0;'), `Claude Code：发消息不点输入框 ${JSON.stringify(c.sent.slice(0, 20))}`);
  ok(c.focusIn, 'Claude Code：焦点通知照常转给程序');

  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
