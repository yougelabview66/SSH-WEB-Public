'use strict';
// 各 Agent 的鼠标处理 (public/app/09-agents.js)：程序开着鼠标、要了所有鼠标移动 (像 Grok 的全屏界面) 时，电脑上
//  - Grok：左键直接拖动在终端里选字 (不用按 Shift)，松开自动复制；选中后挪鼠标不上报 (上报会让 xterm 清掉选中)；单击照常交给程序
//  - Claude Code：照旧 (拖动、挪动都交给程序)，不跟着 Grok 一起变
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Server } = require('ssh2');
const { BASE, ok, wait, launch, hostKey } = require('./helpers');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-am-')));
fs.mkdirSync(path.join(home, '.ssh-web'));
fs.writeFileSync(path.join(home, '.ssh-web/watch.ps1'), ''); // 装过钩子：读事件的通道一直开着

let watchCh = null, got = '', rows = 0;
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a, r, info) => { rows = info.rows; a(); }); s.on('window-change', (a, r, info) => { rows = info.rows; a && a(); });
    s.on('shell', (a) => {
      const st = a();
      st.on('data', (d) => { got += d; });
      // 全屏界面 + 鼠标：按下 / 松开、按住拖动、所有移动都要 (SGR)
      st.write('\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[H\x1b[2J');
      for (let i = 1; i <= 10; i++) st.write(`agent reply line ${i} hello world\r\n`);
      st.write('\x1b[999;1H\x1b[2A│ > \x1b[999;1HShift+Tab:mode'); // 最下面像 Grok 的输入框 (倒数第三行)
    });
    s.on('exec', (a, r, info) => {
      const ch = a(), cmd = info.command;
      const out = (t, code) => { if (t) ch.write(t); ch.exit(code); ch.end(); };
      if (cmd === 'echo %OS%;$env:OS') return out('Windows_NT;$env:OS\r\n', 0);
      if (cmd.includes('watch.ps1')) { watchCh = ch; ch.write('SSHWEB_HOOKS=1\r\n'); return; }
      ch.stderr.write(`'${cmd.split(' ')[0]}' is not recognized as an internal or external command,\r\n`);
      out('', 1);
    });
  }));
}).listen(2248, '127.0.0.1');

(async () => {
  await fetch(BASE + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'AM', host: '127.0.0.1', port: 2248, username: 'u', password: 'x', daemon: false }) });
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  const m = await ctx.newPage(); const errors = []; m.on('pageerror', (e) => errors.push(e.message));
  await m.goto(BASE + '/'); await m.waitForSelector('#app:not(.hidden)');
  await m.locator('.host', { hasText: 'AM' }).first().click(); await wait(2500);
  await m.focus('#dInput'); await m.keyboard.press('Backspace'); await wait(300); // 这个标签刚有人操作 (没有标签的钩子事件交给它)
  const b = await m.locator('.term.active .xterm-screen').boundingBox();
  const as = (agent) => { watchCh.write(JSON.stringify({ v: 2, t: 1, agent, tabs: '', pane: '', hook_event_name: 'UserPromptSubmit', prompt: 'hi' }) + '\r\n'); return wait(1200); };
  const clip = () => m.evaluate(() => navigator.clipboard.readText());
  const drag = async () => {
    await m.evaluate(() => navigator.clipboard.writeText('EMPTY'));
    await m.mouse.move(b.x + 10, b.y + 8); await wait(100);
    got = '';
    await m.mouse.down(); await m.mouse.move(b.x + 220, b.y + 60, { steps: 10 }); await m.mouse.up(); await wait(500);
  };
  const presses = () => (got.match(/\x1b\[<0;\d+;\d+M/g) || []).length;
  const hovers = () => (got.match(/\x1b\[<35;\d+;\d+M/g) || []).length;

  // ---- Grok
  await as('grok');
  await drag();
  const c1 = await clip(), p1 = presses();
  ok(c1.includes('reply line 1') && c1.includes('reply line 4') && p1 === 0, `Grok：直接拖动选中并复制「${c1.slice(0, 25)}」，按下没报给程序 (${p1})`);
  got = '';
  await m.mouse.move(b.x + 300, b.y + 150, { steps: 5 }); await wait(300);
  ok(hovers() === 0, `Grok：选着字时挪鼠标不上报 (${hovers()} 条)，选中不会被清掉`);
  await m.mouse.move(b.x + 60, b.y + 100); await wait(100);
  got = '';
  await m.mouse.down(); await m.mouse.up(); await wait(400);
  ok(/\x1b\[<0;\d+;\d+M/.test(got) && /\x1b\[<0;\d+;\d+m/.test(got), `Grok：单击照常交给程序 (按下、松开都报了：${JSON.stringify(got.replace(/\x1b\[<35;[^Mm]*M/g, ''))})`);
  got = '';
  await m.mouse.move(b.x + 400, b.y + 200, { steps: 3 }); await wait(300);
  ok(hovers() > 0, `Grok：没选着字时挪鼠标照常上报 (${hovers()} 条)`);

  // 下方输入栏发消息：先点一下 Grok 的输入框 (焦点可能在聊天记录上)，再发字
  await m.focus('#dInput'); got = '';
  await m.keyboard.type('hi'); await m.keyboard.press('Enter'); await wait(800);
  const click = `\x1b[<0;5;${rows - 2}M\x1b[<0;5;${rows - 2}m`;
  ok(got.includes(click + 'hi') , `Grok：发消息前先点它的输入框 (第 ${rows - 2} 行)，再发字 ${JSON.stringify(got.slice(0, 60))}`);
  got = '';
  await m.keyboard.press('Enter'); await wait(500);
  ok(!got.includes('\x1b[<0;'), `Grok：只发回车 (选菜单项) 时不点 ${JSON.stringify(got)}`);

  // ---- Claude Code：照旧
  await as('claude');
  await drag();
  const c2 = await clip(), p2 = presses();
  await m.focus('#dInput'); got = '';
  await m.keyboard.type('yo'); await m.keyboard.press('Enter'); await wait(800);
  ok(got.startsWith('yo') && !got.includes('\x1b[<0;'), `Claude Code：发消息不点输入框 ${JSON.stringify(got.slice(0, 30))}`);
  ok(c2 === 'EMPTY' && p2 === 1, `Claude Code：拖动照旧交给程序 (按下报了 ${p2} 次)，没在终端里选字 (剪贴板：${c2})`);

  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
