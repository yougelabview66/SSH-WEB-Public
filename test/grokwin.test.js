'use strict';
// Windows 主机上跑着 Grok (钩子报的)：往上 / 往下滚不开历史视图 (经过 ConPTY 的全屏界面在终端历史里是重画的碎片)，
// 换成 PageUp / PageDown 让 Grok 自己翻页 (同 Linux 上的全屏 Grok)；不是 Grok 时照旧；手机上手指滑也一样。
// 电脑输入框的提示文字写着「连按两下 Alt 切换到 CLI 自带输入框」
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Server } = require('ssh2');
const { BASE, ok, wait, launch, devices, hostKey } = require('./helpers');

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

  // 还没报 Grok：照旧 (不发翻页键)
  shellIn = '';
  await wheel(-100, 4);
  ok(!shellIn.includes('\x1b[5~'), `没报 Grok 时滚轮不发翻页键 (${JSON.stringify(shellIn)})`);
  await m.keyboard.press('Escape'); await wait(300);

  emit({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }); await wait(1200);
  shellIn = '';
  await wheel(-100, 6);
  const up = (shellIn.match(/\x1b\[5~/g) || []).length;
  const hist = await m.evaluate(() => !!document.querySelector('.term.active .lscroll'));
  ok(up >= 1 && !hist && !/\x1b\[</.test(shellIn), `Windows 上的 Grok：往上滚发 PageUp (${up} 次)，不开历史视图 (${hist})，不发滚轮上报`);
  shellIn = '';
  await wheel(100, 6);
  const down = (shellIn.match(/\x1b\[6~/g) || []).length;
  ok(down >= 1 && !shellIn.includes('\x1b[5~'), `往下滚发 PageDown (${down} 次)`);

  // 手机：手指往下滑 (= 往回看) 也换成 PageUp
  const mctx = await browser.newContext({ ...devices['Pixel 7'] });
  const p = await mctx.newPage(); const cdp = await mctx.newCDPSession(p);
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.tap('#btnToggle'); await p.locator('.host', { hasText: 'GW' }).first().tap(); await wait(2500);
  await p.evaluate(() => document.querySelector('.term.active .owner-notice button')?.click()); await wait(500); // 电脑那边在用：先在手机上接管
  await p.focus('#mInput'); await p.keyboard.press('Backspace'); await wait(300);
  emit({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }); await wait(1200);
  const tb = await p.locator('.term.active .xterm-screen').boundingBox();
  shellIn = '';
  const x = tb.x + tb.width / 2;
  let y = tb.y + 60;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 0; i < 20; i++) { y += 20; await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] }); await wait(30); }
  await wait(200);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await wait(800);
  const mup = (shellIn.match(/\x1b\[5~/g) || []).length;
  ok(mup >= 1 && !/\x1b\[</.test(shellIn), `手机：手指往下滑发 PageUp (${mup} 次) ${JSON.stringify(shellIn.slice(0, 40))}`);

  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
