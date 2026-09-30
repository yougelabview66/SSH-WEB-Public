'use strict';
const { BASE, ok, wait, shot, launch, post, addHost, devices, hostKey } = require('./helpers');
const { Server, utils } = require('ssh2');
let got = ''; let chunks = []; let streams = [];
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => { const s = acc(); s.on('pty', (a) => a());
    s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { const st = a(); streams.push(st); st.write('$ '); st.on('data', (d) => { got += d; chunks.push(String(d)); st.write(String(d).replace(/\r/g, '\r\n')); }); }); }));
}).listen(2224, '127.0.0.1');
(async () => {
  await fetch(BASE + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'D', host: '127.0.0.1', port: 2224, username: 'u', password: 'x' }) });
  const browser = await launch();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'D' }).click(); await wait(1200);
  ok(await p.isVisible('#deskBar'), '电脑上底部显示输入栏');
  ok(await p.isHidden('#mobileBar'), '电脑上不显示手机按键栏');
  ok(await p.evaluate(() => document.activeElement.id) === 'dInput', '连接后焦点在输入框');
  got = ''; chunks = [];
  await p.keyboard.type('ls -la', { delay: 30 }); await wait(300);
  ok(got === '', '打字时不发送到终端 (本地编辑)');
  await p.keyboard.press('Backspace'); await p.keyboard.press('Backspace'); await p.keyboard.type('al');
  await p.keyboard.press('Enter'); await wait(300);
  ok(got === 'ls -al\r', '回车后整段发送 + 回车: ' + JSON.stringify(got));
  ok(chunks.length >= 2 && chunks[chunks.length - 1] === '\r', '文字和回车分两次发送');
  ok(await p.inputValue('#dInput') === '', '发送后清空输入框');
  got = ''; await p.keyboard.press('ArrowUp'); await p.keyboard.press('Tab'); await p.keyboard.press('Backspace');
  await p.keyboard.press('Control+c'); await p.keyboard.press('Shift+Tab'); await p.keyboard.press('Control+ArrowLeft'); await wait(300);
  ok(got === '\x1b[A\t\x7f\x03\x1b[Z\x1b[1;5D', '空输入框时 ↑ Tab ⌫ Ctrl+C Shift+Tab Ctrl+← 直接发给终端: ' + JSON.stringify(got));
  ok(await p.evaluate(() => document.activeElement.id) === 'dInput', 'Tab 不会让焦点跳走');
  got = ''; await p.keyboard.type('abc'); await p.keyboard.press('ArrowLeft'); await p.keyboard.press('Backspace'); await wait(200);
  ok(got === '' && await p.inputValue('#dInput') === 'ac', '有文字时方向键 / 退格只编辑输入框');
  await p.keyboard.press('Escape'); await wait(200);
  ok(got === '\x1b' && await p.inputValue('#dInput') === 'ac', 'Esc 随时发给终端，草稿保留');
  await p.fill('#dInput', ''); got = ''; await p.keyboard.press('Enter'); await wait(200);
  ok(got === '\r', '空输入框按回车只发回车');
  // 多行 (Shift+Enter)
  got = ''; await p.keyboard.type('a'); await p.keyboard.press('Shift+Enter'); await p.keyboard.type('b'); await p.keyboard.press('Shift+Enter'); await p.keyboard.type('c');
  const h1 = (await p.locator('#dInput').boundingBox()).height;
  ok(h1 > 70, 'Shift+Enter 换行，输入框自动变高 ' + h1);
  await p.keyboard.press('Enter'); await wait(300);
  ok(got === 'a\rb\rc\r', '无括号粘贴模式时多行按行发送: ' + JSON.stringify(got));
  ok((await p.locator('#dInput').boundingBox()).height < h1, '发送后输入框恢复一行');
  streams[0].write('\x1b[?2004h'); await wait(200);
  got = ''; await p.keyboard.type('x'); await p.keyboard.press('Shift+Enter'); await p.keyboard.type('y'); await p.keyboard.press('Enter'); await wait(300);
  ok(got === '\x1b[200~x\ry\x1b[201~\r', '括号粘贴模式 (Claude Code) 下多行作为粘贴发送再回车: ' + JSON.stringify(got));
  streams[0].write('\x1b[?2004l');
  // 中文输入法：用 insertText 模拟上屏
  got = ''; await p.keyboard.insertText('你好世界'); await wait(200);
  ok(got === '', '中文上屏不发送'); await p.keyboard.press('Enter'); await wait(300);
  ok(got === '你好世界\r', '中文回车发送');
  // 点终端：光标回到下方输入框 (习惯性点了 Claude Code 自己的输入框也不会跑进终端)
  await p.fill('#dInput', '');
  await p.locator('.term.active .term-box').click({ position: { x: 200, y: 100 } }); await wait(200);
  got = ''; await p.keyboard.type('pwd'); await wait(300);
  ok(got === '' && await p.inputValue('#dInput') === 'pwd' && await p.evaluate(() => document.activeElement.id) === 'dInput', '点终端后光标回到下方输入框，打的字进输入框');
  await p.fill('#dInput', '');
  // 拖动选中文字：不抢光标，方便复制
  const tb = await p.locator('.term.active .xterm-screen').boundingBox();
  await p.mouse.move(tb.x + 4, tb.y + 8); await p.mouse.down(); await p.mouse.move(tb.x + 200, tb.y + 8, { steps: 5 }); await p.mouse.up(); await wait(200);
  ok(await p.evaluate(() => document.activeElement.classList.contains('xterm-helper-textarea')), '在终端里拖动选中文字时不抢光标 (方便复制)');
  await p.click('#dInput');
  // 连按两下 Alt 进终端直接打字，这时点终端不拉回来
  await p.keyboard.press('Alt'); await p.keyboard.press('Alt'); await wait(200);
  await p.locator('.term.active .term-box').click({ position: { x: 200, y: 100 } }); await wait(200);
  got = ''; await p.keyboard.type('pwd'); await wait(300);
  ok(got === 'pwd', '连按两下 Alt 进终端后，点终端照样直接在终端打字');
  await p.keyboard.press('Enter'); await wait(100); // 发送掉 (终端输入框里有没发送的字时点终端会留在终端，见 altmove 测试)
  await p.click('#dInput'); await wait(100);
  await p.locator('.term.active .term-box').click({ position: { x: 200, y: 100 } }); await wait(200);
  ok(await p.evaluate(() => document.activeElement.id) === 'dInput', '光标回到输入框以后，再点终端又会回到输入框');
  // 输入框关掉时，点终端照旧直接打字
  await p.click('#dHide'); await wait(200);
  await p.locator('.term.active .term-box').click({ position: { x: 200, y: 100 } }); await wait(200);
  got = ''; await p.keyboard.type('ls'); await wait(300);
  ok(got === 'ls', '下方输入框关掉时，点终端照旧直接在终端打字');
  await p.click('#btnInput'); await wait(200);
  // 草稿按标签保存
  await p.click('#dInput'); await p.keyboard.type('draft1');
  await p.locator('.host', { hasText: 'D' }).click(); await wait(1200);
  ok(await p.inputValue('#dInput') === '', '新标签输入框为空');
  await p.locator('.tab').first().click(); await wait(300);
  ok(await p.inputValue('#dInput') === 'draft1', '切回原标签草稿还在');
  // 隐藏 / 显示
  await p.click('#dHide'); await wait(200);
  ok(await p.isHidden('#deskBar'), '× 隐藏输入栏');
  ok(await p.evaluate(() => document.activeElement.classList.contains('xterm-helper-textarea')), '隐藏后焦点回到终端');
  await p.reload(); await p.waitForSelector('.tab'); await wait(1200);
  ok(await p.isHidden('#deskBar'), '隐藏状态刷新后保持');
  await p.click('#btnInput'); await wait(200);
  ok(await p.isVisible('#deskBar'), '顶部「⌨ 输入框」重新打开');
  await p.screenshot({ path: shot('desk.png') });
  // 手机上不显示
  const m = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage(); m.on('pageerror', (e) => errors.push(e.message));
  await m.goto(BASE + '/'); await m.waitForSelector('.tab'); await wait(1200);
  ok(await m.isHidden('#deskBar') && await m.isVisible('#mobileBar') && await m.isHidden('#btnInput'), '手机上仍是原来的输入栏');
  got = ''; await m.tap('#mInput'); await m.keyboard.type('ab'); await wait(300);
  ok(got === '', '手机输入栏也是先本地编辑');
  got = ''; await m.tap('#mobileBar [data-mod=ctrl]'); await m.tap('#mobileBar [data-k=right]'); await m.tap('#mobileBar [data-k=up]'); await wait(200);
  ok(got === 'ab\x1b[1;5C\x1b[A', '手机按键栏修饰键正常且用完取消: ' + JSON.stringify(got));
  await m.screenshot({ path: shot('mobile.png') });
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
