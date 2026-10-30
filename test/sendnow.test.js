'use strict';
// 按键栏「立即发送」(Claude Code 的 Ctrl+X Ctrl+S)：按钩子报的这个标签里在跑的 Agent 决定发不发 ——
// 没收到过钩子事件 (不知道是什么)、Claude Code：发；别的 Agent (Gemini 的 Ctrl+X 开编辑器、Ctrl+S 切鼠标模式)、
// Agent 已退出 (普通终端里 Ctrl+S 让画面卡住)：不发，提示一下
const { Server } = require('ssh2');
const { BASE, ok, wait, run, launch, devices, hostKey } = require('./helpers');

let got = '', tailCh = null;
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { const st = a(); st.write('$ '); st.on('data', (d) => { got += d; }); });
    s.on('exec', (a, r, info) => {
      const ch = a();
      if (info.command.includes('tail -n 0 -F')) { tailCh = ch; ch.write('SSHWEB_HOOKS=1\n'); return; } // 装了钩子，一直开着读事件
      ch.exit(0); ch.end();
    });
  }));
}).listen(2227, '127.0.0.1');

run(async () => {
  const J = (method, url, body) => fetch(BASE + url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await J('POST', '/api/hosts', { name: 'SN', host: '127.0.0.1', port: 2227, username: 'u', password: 'x' });
  await J('PUT', '/api/settings/keybar', { keys: ['esc', 'sendnow'], custom: {} });
  const browser = await launch();
  const errors = [];
  const m = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
  m.on('pageerror', (e) => errors.push(e.message));
  await m.goto(BASE + '/'); await m.waitForSelector('#app:not(.hidden)');
  await m.tap('#btnToggle'); await m.locator('.host', { hasText: 'SN' }).tap(); await wait(1500);
  for (let i = 0; i < 50 && !tailCh; i++) await wait(100);
  const sid = (await (await fetch(BASE + '/api/sessions')).json()).find((x) => x.status === 'connected')?.id;
  const emit = async (ev) => { tailCh.write(JSON.stringify({ v: 1, t: 1, tabs: sid, pane: '', ...ev }) + '\n'); await wait(500); };
  const press = async () => { got = ''; await m.tap('#mobileBar [data-k=sendnow]'); await wait(300); };
  const toast = () => m.evaluate(() => document.querySelector('.term.active .font-toast')?.textContent || '');
  ok(!!tailCh && !!sid, '连上了、在读钩子事件');

  await press();
  ok(got === '\x18\x13', '没收到过钩子事件 (不知道在跑什么)：照旧发 Ctrl+X Ctrl+S');
  await emit({ agent: 'claude', hook_event_name: 'UserPromptSubmit', session_id: 'c1', prompt: '干活' });
  await press();
  ok(got === '\x18\x13', 'Claude Code：发');
  await emit({ agent: 'gemini', hook_event_name: 'BeforeAgent', session_id: 'g1', prompt: '干活' });
  await press();
  const t1 = await toast();
  ok(got === '' && /只支持 Claude Code.*Gemini/.test(t1), 'Gemini：不发，提示只支持 Claude Code: ' + JSON.stringify([got, t1]));
  // 输入框里有字：不发，字也留着 (不先把字发进终端)
  await m.fill('#mInput', 'abc'); await m.evaluate(() => document.getElementById('mInput').dispatchEvent(new Event('input')));
  await press();
  const kept = await m.evaluate(() => document.getElementById('mInput').value.replace(/​/g, ''));
  ok(got === '' && kept === 'abc', 'Gemini 时输入框有字：不发，字留在输入框里: ' + JSON.stringify([got, kept]));
  await m.fill('#mInput', ''); await m.evaluate(() => document.getElementById('mInput').dispatchEvent(new Event('input')));
  await emit({ agent: 'claude', hook_event_name: 'SessionStart', session_id: 'c2', source: 'startup' });
  await emit({ agent: 'claude', hook_event_name: 'SessionEnd', session_id: 'c2' });
  await press();
  ok(got === '' && /没有在运行的 Agent/.test(await toast()), 'Agent 退出了：不发 (普通终端里 Ctrl+S 让画面卡住)');
  // 刷新页面：重新连上时也知道现在是什么
  await emit({ agent: 'claude', hook_event_name: 'SessionStart', session_id: 'c3', source: 'startup' });
  await emit({ agent: 'codex', hook_event_name: 'UserPromptSubmit', session_id: 'x1', prompt: '干活' });
  await m.reload(); await m.waitForSelector('#app:not(.hidden)'); await wait(1500);
  await press();
  ok(got === '' && /Codex/.test(await toast()), '刷新页面后：照样知道这个标签里是 Codex，不发');
  await browser.close();
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
});
