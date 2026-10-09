'use strict';
// 输入栏回车发送：回车和文字隔开 50ms (不然程序一次读到会当成粘贴、不提交)，间隔由服务端掐 ——
// 以前在网页里等，发送多行 / 折行的长消息后输入栏变矮、终端重新排版，浏览器正忙会把回车拖到两三百毫秒；
// 而且终端尺寸变化正好夹在文字和回车之间，Claude Code 要先整屏重画完才处理回车，发一条要等好久。
// 现在尺寸变化推迟到回车之后
const { BASE, ok, wait, launch, hostKey } = require('./helpers');
const { Server } = require('ssh2');
let log = [];
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a());
    s.on('window-change', (a) => { log.push({ t: Date.now(), resize: true }); a && a(); });
    s.on('shell', (a) => {
      const st = a();
      st.write('\x1b[?2004h$ '); // 同 Claude Code：开着括号粘贴
      st.on('data', (d) => { log.push({ t: Date.now(), d: String(d) }); st.write(String(d).replace(/\r/g, '\r\n')); });
    });
  }));
}).listen(2246, '127.0.0.1');

(async () => {
  await fetch(BASE + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'G', host: '127.0.0.1', port: 2246, username: 'u', password: 'x' }) });
  const browser = await launch();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'G' }).click(); await wait(1500);

  const sendAndLog = async (type) => {
    await p.click('#dInput');
    await type();
    await wait(400);
    log = [];
    await p.keyboard.press('Enter');
    await wait(800);
    const text = log.find((e) => e.d && e.d !== '\r');
    const enter = log.find((e) => e.d === '\r');
    const resize = log.find((e) => e.resize);
    return { text, enter, resize, gap: text && enter ? enter.t - text.t : -1 };
  };

  // 多行消息：发出去后输入栏从三行变回一行，终端变高
  const multi = await sendAndLog(async () => {
    await p.keyboard.type('line1'); await p.keyboard.press('Shift+Enter');
    await p.keyboard.type('line2'); await p.keyboard.press('Shift+Enter'); await p.keyboard.type('line3');
  });
  ok(multi.text && multi.text.d === '\x1b[200~line1\rline2\rline3\x1b[201~', '多行按括号粘贴发送: ' + JSON.stringify(multi.text?.d));
  ok(multi.gap >= 45 && multi.gap < 150, `多行：回车比文字晚 ${multi.gap}ms 写进终端 (约 50ms，以前浏览器正忙时会拖到两三百毫秒)`);
  ok(multi.resize && multi.resize.t > multi.enter.t, `输入栏变矮引起的终端尺寸变化推迟到回车之后 (回车后 ${multi.resize ? multi.resize.t - multi.enter.t : '?'}ms)`);

  // 单行消息：间隔一样
  const single = await sendAndLog(() => p.keyboard.type('hello world'));
  ok(single.text?.d === 'hello world' && single.gap >= 45 && single.gap < 150, `单行：文字和回车分两次、隔 ${single.gap}ms`);
  ok(!single.resize, '单行消息发送不改终端尺寸');

  // 窄窗口：提示文字放不下也不折行撑高输入框 (不然打字 / 发送时输入框高度来回变，终端反复改尺寸)
  await p.setViewportSize({ width: 520, height: 800 }); await wait(600);
  const hEmpty = await p.evaluate(() => document.getElementById('dInput').offsetHeight);
  await p.click('#dInput'); await p.keyboard.type('a'); await wait(200);
  const hTyped = await p.evaluate(() => document.getElementById('dInput').offsetHeight);
  ok(hEmpty === hTyped, `窄窗口里空输入框和打了一个字一样高 (${hEmpty}px / ${hTyped}px)：提示文字截短不折行`);
  await p.fill('#dInput', '');

  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
