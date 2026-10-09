'use strict';
// 输入栏回车发送：程序一次读到「文字 + 回车」会当成粘贴、不提交，所以回车要和文字分开写进终端。
// 服务端等程序把文字显示出来 (说明已经读走了) 马上写回车：空闲时几毫秒 (比以前固定等 50ms 快)；
// 正忙 (先输出别的、过一会儿才显示) 时等它显示出来再写 (以前 50ms 一到就写，最容易被当成粘贴)；
// 不显示的输入 (密码) 没有任何输出，50ms 后照写。发送后输入栏变矮引起的终端尺寸变化排在回车之后
// (以前夹在文字和回车之间，Claude Code 要先整屏重画完才处理回车，发一条要等好久)
const { BASE, ok, wait, launch, hostKey } = require('./helpers');
const { Server } = require('ssh2');
let log = [];
let mode = 'echo'; // 模拟的程序：echo 马上显示 / busy 先输出别的 300ms 后才显示 / silent 不显示 / pasted 多行显示成占位 / ask 先问光标位置、收到回答才显示
let shell = null;
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a());
    s.on('window-change', (a) => { log.push({ t: Date.now(), resize: true }); a && a(); });
    s.on('shell', (a) => {
      const st = a(); shell = st;
      st.write('\x1b[?2004h$ '); // 同 Claude Code：开着括号粘贴
      let asked = '';
      st.on('data', (buf) => {
        const d = String(buf);
        log.push({ t: Date.now(), d });
        if (d === '\r') return st.write('\r\n$ ');
        if (/^\x1b\[\d+;\d+R$/.test(d)) { if (asked) { st.write(asked); asked = ''; } return; } // 收到光标位置的回答才显示
        const text = d.replace(/\x1b\[20[01]~/g, '');
        if (mode === 'echo') st.write(text);
        else if (mode === 'busy') {
          st.write('\x1b7\x1b[10;1Hworking.\x1b8');
          const t = setInterval(() => st.write('\x1b7\x1b[10;1Hworking..\x1b8'), 60);
          setTimeout(() => { clearInterval(t); st.write(text); }, 300);
        } else if (mode === 'pasted') st.write('[Pasted text #1 +2 lines]');
        else if (mode === 'ask') { asked = text; st.write('\x1b[6n'); }
        // silent：不显示 (输密码)
      });
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

  const sendAndLog = async (m, type, settle = 900) => {
    mode = m;
    shell.write('\x1b[H\x1b[2J$ '); // 清屏，免得上一轮的文字还在画面上
    await p.click('#dInput');
    await type();
    await wait(300);
    log = [];
    await p.keyboard.press('Enter');
    await wait(settle);
    const text = log.find((e) => e.d && e.d !== '\r' && !/^\x1b\[\d+;\d+R$/.test(e.d));
    const enter = log.find((e) => e.d === '\r');
    const resize = log.find((e) => e.resize);
    return { text, enter, resize, gap: text && enter ? enter.t - text.t : -1, merged: log.some((e) => e.d && e.d.length > 1 && e.d.endsWith('\r')) };
  };
  const word = (w) => () => p.keyboard.type(w);

  const r1 = await sendAndLog('echo', word('hello world'));
  ok(r1.text?.d === 'hello world' && r1.gap >= 0 && r1.gap < 40 && !r1.merged, `程序空闲、马上显示：回车 ${r1.gap}ms 后就写进去 (以前固定等 50ms)，文字和回车分开`);

  const r2 = await sendAndLog('busy', word('second message'));
  ok(r2.gap >= 290 && r2.gap < 600 && !r2.merged, `程序正忙 (先输出别的，300ms 后才显示文字)：回车等显示出来才写 (${r2.gap}ms；以前 50ms 一到就写，会被当成粘贴)`);

  const r3 = await sendAndLog('silent', word('secret'));
  ok(r3.gap >= 45 && r3.gap < 150 && !r3.merged, `不显示的输入 (密码，没有任何输出)：照旧 50ms 后写回车 (${r3.gap}ms)`);

  const r4 = await sendAndLog('pasted', async () => {
    await p.keyboard.type('line1'); await p.keyboard.press('Shift+Enter');
    await p.keyboard.type('line2'); await p.keyboard.press('Shift+Enter'); await p.keyboard.type('line3');
  });
  ok(r4.text?.d === '\x1b[200~line1\rline2\rline3\x1b[201~', '多行按括号粘贴发送: ' + JSON.stringify(r4.text?.d));
  ok(r4.gap >= 0 && r4.gap < 40, `多行内容显示成「[Pasted text #1 +2 lines]」也算显示出来了：回车 ${r4.gap}ms 后写`);
  ok(r4.resize && r4.resize.t > r4.enter.t, `输入栏变矮引起的终端尺寸变化排在回车之后 (回车后 ${r4.resize ? r4.resize.t - r4.enter.t : '?'}ms)`);

  const r5 = await sendAndLog('ask', word('query first'));
  ok(r5.gap >= 0 && r5.gap < 200, `程序先问光标位置、收到回答才显示：终端的自动回答不排在回车后面，不会卡到最长等待 (${r5.gap}ms)`);

  const r6 = await sendAndLog('echo', word('short'));
  ok(!r6.resize, '单行消息发送不改终端尺寸');

  // 窄窗口：提示文字放不下也不折行撑高输入框 (不然打字 / 发送时输入框高度来回变，终端反复改尺寸)
  await p.setViewportSize({ width: 420, height: 800 }); await wait(600);
  const hEmpty = await p.evaluate(() => document.getElementById('dInput').offsetHeight);
  await p.click('#dInput'); await p.keyboard.type('a'); await wait(200);
  const hTyped = await p.evaluate(() => document.getElementById('dInput').offsetHeight);
  ok(hEmpty === hTyped, `窄窗口里空输入框和打了一个字一样高 (${hEmpty}px / ${hTyped}px)：提示文字截短不折行`);
  await p.fill('#dInput', '');

  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
