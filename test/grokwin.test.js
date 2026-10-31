'use strict';
// Windows 主机上跑着 Grok (钩子报的)：滚轮照通用的处理，不换成翻页键 (用户要保留历史视图；1.83.86 ~ 1.84.0 曾换成 PageUp / PageDown)。
// 电脑输入框的提示文字写着「连按两下 Alt 切换到 CLI 自带输入框」
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Server } = require('ssh2');
const { BASE, ok, wait, launch, hostKey } = require('./helpers');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-gw-')));
fs.mkdirSync(path.join(home, '.ssh-web'));
fs.writeFileSync(path.join(home, '.ssh-web/watch.ps1'), ''); // 装过钩子：读事件的通道一直开着

// ---- 模拟 Windows 的 SSH：exec 走 cmd，钩子事件从 watch.ps1 的通道读
let watchCh = null, shellIn = '';
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => {
      const st = a();
      st.on('data', (d) => { shellIn += d; });
      st.write(Array.from({ length: 60 }, (_, i) => `grok 回复第 ${i} 行`).join('\r\n') + '\r\n> ');
    });
    s.on('exec', (a, r, info) => {
      const ch = a(), cmd = info.command;
      const out = (t, code) => { if (t) ch.write(t); ch.exit(code); ch.end(); };
      if (cmd === 'echo %OS%;$env:OS') return out('Windows_NT;$env:OS\r\n', 0); // 像 cmd
      if (cmd.includes('watch.ps1')) { watchCh = ch; ch.write('SSHWEB_HOOKS=1\r\n'); return; }
      ch.stderr.write(`'${cmd.split(' ')[0]}' is not recognized as an internal or external command,\r\n`);
      out('', 1);
    });
  }));
}).listen(2246, '127.0.0.1');

(async () => {
  await fetch(BASE + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'GW', host: '127.0.0.1', port: 2246, username: 'u', password: 'x', daemon: false }) });
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const m = await ctx.newPage(); const errors = []; m.on('pageerror', (e) => errors.push(e.message));
  await m.goto(BASE + '/'); await m.waitForSelector('#app:not(.hidden)');
  const ph = await m.evaluate(() => document.getElementById('dInput').placeholder);
  ok(ph.includes('连按两下 Alt') && !ph.includes('直接发给终端'), `电脑输入框提示：连按两下 Alt 切换到 CLI 输入框，不再写「直接发给终端」 (${ph})`);
  await m.locator('.host', { hasText: 'GW' }).first().click(); await wait(2500);
  await m.focus('#dInput'); await m.keyboard.press('Backspace'); await wait(300); // 这个标签刚有人操作 (没有标签的钩子事件交给它)
  const b = await m.locator('.term.active .xterm-screen').boundingBox();
  const wheel = async (dy, n) => { await m.mouse.move(b.x + b.width / 2, b.y + b.height / 2); for (let i = 0; i < n; i++) { await m.mouse.wheel(0, dy); await wait(60); } await wait(400); };
  const emit = (ev) => watchCh.write(JSON.stringify({ v: 2, t: 1, agent: 'grok', tabs: '', pane: '', ...ev }) + '\r\n');

  emit({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }); await wait(1200);
  shellIn = '';
  await wheel(-100, 6);
  await wheel(100, 6);
  ok(!shellIn.includes('\x1b[5~') && !shellIn.includes('\x1b[6~'), `Windows 上的 Grok：滚轮不换成翻页键 (${JSON.stringify(shellIn)})`);

  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
