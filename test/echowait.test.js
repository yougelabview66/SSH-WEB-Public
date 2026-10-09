'use strict';
// lib/echo-wait.js：判断「程序已经把输入栏发出去的文字显示出来了」(用服务端的无界面终端，不用浏览器)
const { ok } = require('./helpers');
const { Terminal } = require('@xterm/headless');
const { echoKey, echoMarks, echoed } = require('../lib/echo-wait');

const term = () => new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
const write = (t, s) => new Promise((r) => t.write(s, r));

(async () => {
  ok(echoKey('   \r ') === null, '全是空白的文字没法判断 (退回固定间隔)');
  ok(echoKey('\x1b[200~a\rb\x1b[201~').pasted === true && echoKey('hello').pasted === false, '多行内容 (括号粘贴) 认得出来');

  // shell：提示符后面显示出来
  let t = term(), k = echoKey('ls -la /tmp');
  await write(t, '$ ');
  let base = echoMarks(t, k);
  ok(!echoed(t, k, base), '还没显示：不算');
  await write(t, 'ls -la /tmp');
  ok(echoed(t, k, base), 'shell 显示出命令：算');

  // 同样的话之前已经在画面上 (上一条消息)：要再多出现一次才算
  t = term(); k = echoKey('same again');
  await write(t, '> same again\r\n\r\n> ');
  base = echoMarks(t, k);
  ok(!echoed(t, k, base), '画面上原来就有同样的文字：不算');
  await write(t, 'same again');
  ok(echoed(t, k, base), '又多显示了一次：算');

  // Claude Code 的输入框：边框 │ 隔开、长文字折行
  t = term(); k = echoKey('please refactor the websocket reconnect logic');
  await write(t, '╭──────────────────────────────────────╮\r\n│ >                                    │\r\n╰──────────────────────────────────────╯');
  base = echoMarks(t, k);
  await write(t, '\x1b[2;1H│ > please refactor the websocket rec │\r\n│   onnect logic                       │\r\n╰──────────────────────────────────────╯');
  ok(echoed(t, k, base), 'Claude Code 输入框里折行、被边框隔开的文字：算');

  // 多行内容显示成占位
  t = term(); k = echoKey('\x1b[200~line1\rline2\rline3\x1b[201~');
  await write(t, '> ');
  base = echoMarks(t, k);
  await write(t, '[Pasted text #1 +2 lines]');
  ok(echoed(t, k, base), '多行内容显示成「[Pasted text #1 +2 lines]」：算');

  // 中文 (宽字符)
  t = term(); k = echoKey('帮我看看这个报错');
  await write(t, '> ');
  base = echoMarks(t, k);
  await write(t, '帮我看看这个报错');
  ok(echoed(t, k, base), '中文 (宽字符) 显示出来：算');
  // 显示的样子和原文不一样 (光标被挪过，文字没连在一起)：光标前面紧挨着的是文字的最后几个字，也算
  t = term(); k = echoKey('a\rb\rc');
  await write(t, '$ ls -al\r\n$ xyz\x1b[3D');
  base = echoMarks(t, k);
  await write(t, 'a\r\nb\r\nc');
  ok(echoed(t, k, base), '文字在画面上没连在一起，但光标停在最后一个字后面：算');

  // 只有别的输出 (程序正忙)：不算
  t = term(); k = echoKey('ls -al');
  await write(t, '$ ');
  base = echoMarks(t, k);
  await write(t, '\x1b7\x1b[5;1Hworking...\x1b8');
  ok(!echoed(t, k, base), '只有别的输出、光标没动：不算');
  process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
