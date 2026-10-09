'use strict';
const { BASE, ok, wait, shot, launch, post, addHost, devices, hostKey } = require('./helpers');
const { Server, utils } = require('ssh2');
let got = ''; let chunks = [];
new Server({ hostKeys: [hostKey()] }, (c) => {
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
  // 多行：文字满一行自动换行、输入框变高
  const mh = () => m.evaluate(() => { const t = document.getElementById('mInput'); return { h: t.offsetHeight, ov: getComputedStyle(t).overflowY, tag: t.tagName }; });
  const h1 = await mh();
  ok(h1.tag === 'DIV' && h1.h <= 44, `一开始一行高 (${h1.h}px)`);
  // 不是表单输入框：手机浏览器 / 系统密码管理不会在输入法上方挂「密码填充」栏
  ok(await m.evaluate(() => !document.querySelector('#mobileBar input, #mobileBar textarea') && /^(plaintext-only|true)$/.test(document.getElementById('mInput').contentEditable)),
    '手机输入框是可编辑的 div，不是表单输入框 (不会弹「密码填充」栏)');
  got = ''; await m.keyboard.type('这是一段很长的中文说明文字，用来测试手机输入框在文字满了之后会不会自动换行变高'); await wait(200);
  const h2 = await mh();
  ok(h2.h > h1.h + 15 && h2.ov === 'hidden' && got === '', `文字满一行后自动换行、输入框变高 ${h1.h} → ${h2.h}px，没有滚动条，也没发送`);
  await m.screenshot({ path: shot('mob-multiline.png') });
  await m.keyboard.type('再多一些文字'.repeat(40)); await wait(200);
  const h3 = await mh();
  ok(h3.ov === 'auto' && h3.h < 915 * 0.32, `超过最大高度 (30vh) 才出现滚动条，高 ${h3.h}px`);
  await m.keyboard.press('Enter'); await wait(400);
  ok(got.startsWith('这是一段很长') && got.endsWith('\r') && !got.slice(0, -1).includes('\n'), '按发送：整段发出去，没有插入换行');
  ok((await mh()).h <= 44, '发送后恢复一行高');
  // 有的手机输入法的「发送」是 beforeinput insertLineBreak
  got = ''; await m.keyboard.type('echo hi'); await wait(100);
  await m.evaluate(() => document.getElementById('mInput').dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertLineBreak', bubbles: true, cancelable: true })));
  await wait(400);
  ok(got === 'echo hi\r', '输入法的「发送」(insertLineBreak) 也是发送: ' + JSON.stringify(got));
  got = ''; await m.keyboard.type('line1'); await m.keyboard.press('Shift+Enter'); await m.keyboard.type('line2'); await wait(200);
  ok(got === '' && await m.evaluate(() => document.getElementById('mInput').value.includes('line1\nline2')), '实体键盘 Shift+回车：换行，不发送');
  await m.keyboard.press('Enter'); await wait(400);
  ok(got.includes('line1') && got.includes('line2') && got.endsWith('\r'), '再按回车整段发送');
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
