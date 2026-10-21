'use strict';
// 标签上的 🔔 (后台标签响铃了、还没看)：切过去看了消失；点开通知跳到那个标签消失；
// 事情已经处理掉了也消失 —— Agent 接着干活了 (状态变「运行中」)、从「完成」「待选择」变成别的 (在别的设备上看过 / 回答过)。
// 先响铃、状态再变「完成」(Claude 做完时就是这样) 不能把刚加的铃铛去掉
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
  const a = list.find((x) => x.title === 'BELL-1' || /-1$/.test(x.title)) || list[0];
  const ringA = () => p.evaluate(() => [...document.querySelectorAll('.tab')].find((t) => /-1$/.test(t.querySelector('.title').textContent))?.classList.contains('ring'));
  const emit = (ev) => tailCh.write(JSON.stringify({ v: 2, t: 1, agent: 'claude', tabs: a.id, pane: '', ...ev }) + '\n');
  await wait(800);

  // 先响铃，再收到「做完了」：铃铛留着
  shells[0].write('\x07'); await wait(500);
  ok(await ringA(), '后台标签响铃：标签上显示 🔔');
  emit({ hook_event_name: 'Stop', last_assistant_message: '做完了' }); await wait(800);
  ok(await ringA(), '先响铃、状态再变「完成」：铃铛还在 (还没看)');
  // Agent 接着干活：铃铛去掉
  emit({ hook_event_name: 'UserPromptSubmit', prompt: '接着做' }); await wait(800);
  ok(!(await ringA()), 'Agent 接着干活了 (运行中)：铃铛自动去掉');

  // 要权限，在别的设备上回答了 (往这个标签发了内容)：铃铛去掉
  shells[0].write('\x07'); await wait(300);
  emit({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', command: 'ls' }); await wait(800);
  ok(await ringA(), '要权限：铃铛还在');
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws');
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'attach', id: a.id, cols: 80, rows: 24 })); await wait(500);
  ws.send(JSON.stringify({ type: 'data', data: '\r' })); await wait(1500);
  ok(!(await ringA()), '在别的设备上回答了 (待选择 → 别的状态)：铃铛自动去掉');
  ws.close();

  // 点开通知：跳到那个标签，铃铛去掉
  shells[0].write('\x07'); await wait(500);
  ok(await ringA(), '又响铃：铃铛');
  const viaSw = await p.evaluate((id) => {
    if (!navigator.serviceWorker) return 'no-sw';
    navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'open-session', id } }));
    return 'ok';
  }, a.id); await wait(500);
  ok(viaSw === 'ok' && !(await ringA()) && /-1$/.test(await p.textContent('.tab.active .title')), '点开通知：跳到那个标签，铃铛去掉');
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close();
});
