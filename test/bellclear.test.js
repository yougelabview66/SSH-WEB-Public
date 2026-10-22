'use strict';
// 标签上的 🔔：有没看过的新通知才挂。新通知只有两种：Agent 的状态变成完成 / 待选择 / 报错 (同推送)；
// 终端提示音，而且上一条通知之后在这个标签里按过回车 (命令跑完了)。看没看过记在服务端：任何设备正在看、
// 点开通知、事情已经处理掉了 (Agent 接着干活 / 别的设备上回答了) 都算看过，所有设备一起去掉，刷新也不再出来。
// 看过以后什么都没发生又响的提示音 (Claude Code 做完一阵子没人理会再提醒一次)、焦点进出 / 滚轮上报：都不挂
const { Server } = require('ssh2');
const WebSocket = require('ws');
const { BASE, ok, wait, run, launch, hostKey, addHost } = require('./helpers');

const shells = [];
let tailCh = null;
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { const st = a(); st.write('$ '); shells.push(st); });
    s.on('exec', (a, r, info) => {
      const ch = a();
      if (info.command.includes('tail -n 0 -F')) { tailCh = ch; ch.write('SSHWEB_HOOKS=1\n'); return; } // 装了钩子：事件从这里来
      if (info.command === 'echo %OS%;$env:OS') { ch.write('%OS%\n'); ch.exit(0); ch.end(); return; }
    });
  }));
}).listen(2305, '127.0.0.1');

run(async () => {
  await addHost('BELL', 2305);
  const browser = await launch();
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'BELL' }).first().click(); await p.waitForSelector('.tab.active .dot.ok'); await wait(600);
  await p.locator('.host', { hasText: 'BELL' }).first().click(); await wait(1500); // 第二个标签 (当前)，第一个到后台
  const list = await (await fetch(BASE + '/api/sessions')).json();
  const a = list.find((x) => /-1$/.test(x.title)) || list[0];
  const ringA = () => p.evaluate(() => !![...document.querySelectorAll('.tab')].find((t) => /-1$/.test(t.querySelector('.title').textContent))?.classList.contains('ring'));
  const tabOf = (one) => p.locator('.tab').filter({ has: p.locator('.title', { hasText: one ? /-1$/ : /-2$/ }) }).first();
  const emit = (ev) => tailCh.write(JSON.stringify({ v: 2, t: 1, agent: 'claude', tabs: a.id, pane: '', ...ev }) + '\n');
  const bell = async () => { shells[0].write('\x07'); await wait(600); };
  const reload = async () => { await p.reload(); await p.waitForSelector('.tab'); await wait(1500); if (/-1$/.test(await p.textContent('.tab.active .title'))) { await tabOf(false).click(); await wait(500); } };
  const finish = async (msg = '做完了') => { emit({ hook_event_name: 'UserPromptSubmit', prompt: '做' }); await wait(500); emit({ hook_event_name: 'Stop', last_assistant_message: msg }); await wait(800); };
  // 另一台设备
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws');
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'attach', id: a.id, cols: 80, rows: 24 })); await wait(500);
  await wait(500);

  ok(!(await ringA()), '刚打开：没有铃铛');
  await bell();
  ok(!(await ringA()), '没按过回车、也没有 Agent 的事，响一下提示音：不挂 (不是新通知)');

  // Agent 做完了，没在看：挂；Claude Code 紧跟着自己的提示音不再算一条
  await finish(); await bell();
  ok(await ringA(), 'Agent 做完了、没在看这个标签：铃铛');
  // 看过了：去掉；之后 Claude Code 的提醒 (什么都没发生又响)：不挂，刷新也不挂
  await tabOf(true).click(); await wait(400); await tabOf(false).click(); await wait(500);
  ok(!(await ringA()), '切过去看了：铃铛去掉');
  await bell();
  ok(!(await ringA()), '看过以后什么都没发生又响 (Claude Code 的提醒)：不挂');
  ws.send(JSON.stringify({ type: 'data', data: '\x1b[I\x1b[O' })); ws.send(JSON.stringify({ type: 'data', data: '\x1b[<64;10;5M' })); await wait(400);
  await bell();
  ok(!(await ringA()), '只有焦点进出 / 滚轮上报 (切标签、tmux 里滚动) 之后又响：不挂');
  await reload();
  ok(!(await ringA()), '刷新页面后也不挂');

  // 正在看的时候做完了：不挂 (切走以后也不挂)
  await tabOf(true).click(); await wait(400);
  await finish(); await tabOf(false).click(); await wait(500); await bell();
  ok(!(await ringA()), '正在看这个标签时做完的：切走以后也不挂');

  // 要权限：挂；在另一台设备上回答了：去掉
  emit({ hook_event_name: 'UserPromptSubmit', prompt: '改文件' }); await wait(500);
  emit({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', command: 'ls' }); await wait(800);
  ok(await ringA(), '要权限：铃铛');
  ws.send(JSON.stringify({ type: 'data', data: '\r' })); await wait(1500);
  ok(!(await ringA()), '在另一台设备上回答了 (待选择 → 别的状态)：铃铛去掉');

  // 按回车跑了个命令，结束时响铃：挂；刷新还在；另一台设备看了：去掉
  ws.send(JSON.stringify({ type: 'data', data: 'make\r' })); await wait(800);
  await bell();
  ok(await ringA(), '按回车跑命令、结束时响铃：铃铛');
  await reload();
  ok(await ringA(), '刷新页面：没看过的铃铛还在 (服务端记着)');
  ws.send(JSON.stringify({ type: 'watching', watching: true, front: true })); await wait(600);
  ok(!(await ringA()), '在另一台设备上看了：这边的铃铛也去掉');
  ws.send(JSON.stringify({ type: 'watching', watching: false, front: false })); await wait(300);

  // Agent 接着干活了：去掉
  await finish();
  ok(await ringA(), '又做完了一次：铃铛');
  emit({ hook_event_name: 'UserPromptSubmit', prompt: '接着做' }); await wait(800);
  ok(!(await ringA()), 'Agent 接着干活了 (运行中)：铃铛去掉');

  // 点开通知：跳到那个标签，铃铛去掉
  emit({ hook_event_name: 'Stop', last_assistant_message: '好了' }); await wait(800);
  ok(await ringA(), '做完：铃铛');
  const viaSw = await p.evaluate((id) => {
    if (!navigator.serviceWorker) return 'no-sw';
    navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'open-session', id } }));
    return 'ok';
  }, a.id); await wait(500);
  ok(viaSw === 'ok' && !(await ringA()) && /-1$/.test(await p.textContent('.tab.active .title')), '点开通知：跳到那个标签，铃铛去掉');
  ws.close();
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close();
});
