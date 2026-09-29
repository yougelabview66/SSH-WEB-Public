'use strict';
const { BASE, ok, wait, shot, launch, post, addHost, devices } = require('./helpers');
const { Server, utils } = require('ssh2');
let got = ''; let chunks = [];
new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => { const s = acc(); s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { const st = a(); st.write('$ '); st.on('data', (d) => { got += d; chunks.push(String(d)); st.write(String(d).replace(/\r/g, '\r\n')); }); }); }));
}).listen(2226, '127.0.0.1');
(async () => {
  await fetch(BASE + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'M', host: '127.0.0.1', port: 2226, username: 'u', password: 'x' }) });
  const browser = await launch();
  const errors = [];
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const m = await ctx.newPage(); m.on('pageerror', (e) => errors.push(e.message));
  const cdp = await ctx.newCDPSession(m);
  await m.goto(BASE + '/'); await m.waitForSelector('#app:not(.hidden)');
  await m.tap('#btnToggle'); await m.locator('.host', { hasText: 'M' }).tap(); await wait(1200);
  const txt = () => m.evaluate(() => document.getElementById('mInput').value.replace(/​/g, ''));
  const isCmd = () => m.evaluate(() => document.getElementById('mobileBar').classList.contains('cmd'));
  const key = (k) => m.tap(`#mobileBar .mkeys [data-k="${k}"]`);
  await m.tap('#mInput');
  got = ''; chunks = [];
  await m.keyboard.type('ls -la', { delay: 30 }); await wait(300);
  ok(got === '' && await txt() === 'ls -la', '手机打字先留在输入框，不发送');
  await m.tap('#mForm button[type=submit]'); await wait(300);
  ok(got === 'ls -la\r' && chunks[chunks.length - 1] === '\r', '点 ↵ 整段发送再回车: ' + JSON.stringify(chunks));
  ok(await txt() === '', '发送后清空');
  got = ''; await m.keyboard.type('pwd'); await m.keyboard.press('Enter'); await wait(300);
  ok(got === 'pwd\r', '键盘上的「发送」(Enter) 也整段发送');
  // 中文输入法 (CDP 模拟组字)
  got = '';
  await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 });
  await cdp.send('Input.insertText', { text: '你好' }); await wait(200);
  ok(got === '' && await txt() === '你好', '中文上屏后留在输入框: ' + JSON.stringify(await txt()));
  await m.keyboard.press('Enter'); await wait(300); ok(got === '你好\r', '中文发送');
  // 空输入框退格 / 方向键直接发终端
  got = ''; await m.keyboard.press('Backspace'); await key('up'); await key('tab'); await key('bs'); await wait(300);
  ok(got === '\x7f\x1b[A\t\x7f', '空输入框：键盘退格、按键栏 ↑ Tab ⌫ 直接发给终端: ' + JSON.stringify(got));
  // 有文字时按键栏编辑输入框
  got = ''; await m.keyboard.type('abcd'); await key('left'); await key('bs'); await wait(200);
  ok(got === '' && await txt() === 'abd', '有文字时 ← ⌫ 只编辑输入框: ' + await txt());
  await key('home'); await m.keyboard.type('X'); await key('end'); await m.keyboard.type('Y'); await wait(200);
  ok(await txt() === 'XabdY', 'Home / End 移动光标: ' + await txt());
  await m.keyboard.press('Backspace'); await key('home'); await m.keyboard.press('Backspace'); await wait(200);
  ok(got === '' && await txt() === 'Xabd', '在最前面按退格不会删到终端里');
  await m.tap('#mobileBar .mkeys button:has-text("|")'); await wait(200);
  ok(got === '' && await txt() === '|Xabd', '| 等字符键插入到输入框光标处: ' + await txt());
  got = ''; await key('esc'); await wait(200);
  ok(got === '\x1b' && await txt() === '|Xabd', 'Esc 直接发给终端，文字保留');
  got = ''; await key('^c'); await wait(200);
  ok(got === '\x03' && await txt() === '|Xabd', '^C 直接发给终端，文字保留');
  // 全选删除不发退格
  got = ''; await m.evaluate(() => { const i = document.getElementById('mInput'); i.select(); });
  await m.keyboard.press('Backspace'); await wait(200);
  ok(got === '' && await txt() === '', '全选删除只清空输入框，不给终端发退格');
  // Tab 补全：先发文字再发 Tab
  got = ''; await m.keyboard.type('cd /us'); await key('tab'); await wait(200);
  ok(got === 'cd /us\t' && await txt() === '', 'Tab 先把文字发出去再补全: ' + JSON.stringify(got));
  await key('^c'); await wait(100);
  // Ctrl 修饰键
  got = ''; await m.keyboard.type('hello'); await m.tap('#mobileBar [data-mod=ctrl]'); await m.keyboard.type('c'); await wait(200);
  ok(got === '\x03' && await txt() === 'hello', '开 Ctrl 后打 c 发 ^C，输入框原文字不动: ' + JSON.stringify(got) + ' ' + await txt());
  ok(!(await m.locator('#mobileBar [data-mod=ctrl]').evaluate((b) => b.classList.contains('on'))), 'Ctrl 用完自动取消');
  got = ''; await m.tap('#mobileBar [data-mod=ctrl]'); await key('right'); await wait(200);
  ok(got === 'hello\x1b[1;5C', 'Ctrl + →：先发输入框文字，再发组合键: ' + JSON.stringify(got)); await key('bs');
  await m.evaluate(() => { const i = document.getElementById('mInput'); i.select(); }); await m.keyboard.press('Backspace'); await wait(300);
  // 命令模式
  got = ''; chunks = []; await m.keyboard.type('/com', { delay: 40 }); await wait(300);
  ok(got === '/com' && chunks.length >= 4 && await isCmd(), '打 / 进入命令模式，逐字发给终端 (显示 Claude Code 候选列表) ' + JSON.stringify(chunks) + (await isCmd()) + JSON.stringify(await txt()));
  await m.screenshot({ path: shot('mob-cmd.png') });
  got = ''; await key('down'); await key('tab'); await wait(200);
  ok(got === '\x1b[B\t' && await isCmd(), '命令模式下 ↓ Tab 发给终端');
  got = ''; await m.keyboard.type(' x'); await m.tap('#mForm button[type=submit]'); await wait(300);
  ok(got === ' x\r' && !(await isCmd()), '↵ 执行并退出命令模式');
  got = ''; await m.keyboard.type('/'); await m.keyboard.press('Backspace'); await wait(200);
  ok(got === '/\x7f' && !(await isCmd()), '删掉 / 退出命令模式');
  got = ''; await m.tap('#mobileBar .mkeys button:has-text("/")'); await wait(200);
  ok(got === '/' && await isCmd(), '按键栏的 / 在空输入框里也进入命令模式');
  got = ''; await key('esc'); await wait(200); ok(got === '\x1b' && !(await isCmd()), 'Esc 退出命令模式');
  got = ''; await m.keyboard.type('ab'); await wait(200); ok(got === '', '退出后回到本地编辑');
  // 粘贴按钮：先发已有文字
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await m.evaluate(() => navigator.clipboard.writeText('PASTE'));
  got = ''; await key('paste'); await wait(300);
  ok(got === 'abPASTE', '粘贴按钮：先发输入框文字再粘贴: ' + JSON.stringify(got));
  // 草稿按标签
  await m.keyboard.type('draft'); await wait(100);
  await m.tap('#btnToggle'); await m.locator('.host', { hasText: 'M' }).tap(); await wait(1200);
  ok(await txt() === '', '新标签输入框为空');
  await m.locator('.tab').first().tap(); await wait(400);
  ok(await txt() === 'draft', '切回原标签草稿还在');
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
