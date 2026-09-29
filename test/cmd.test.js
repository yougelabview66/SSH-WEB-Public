'use strict';
const { BASE, ok, wait, shot, launch, post, addHost, devices } = require('./helpers');
const { Server, utils } = require('ssh2');
let got = ''; let chunks = [];
new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => { const s = acc(); s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { const st = a(); st.write('$ '); st.on('data', (d) => { got += d; chunks.push(String(d)); st.write(String(d).replace(/\r/g, '\r\n')); }); }); }));
}).listen(2225, '127.0.0.1');
(async () => {
  await fetch(BASE + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'C', host: '127.0.0.1', port: 2225, username: 'u', password: 'x' }) });
  const browser = await launch();
  const errors = [];
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'C' }).click(); await wait(1200);
  const isCmd = () => p.evaluate(() => document.getElementById('deskBar').classList.contains('cmd'));
  got = ''; chunks = [];
  await p.keyboard.type('/com', { delay: 40 }); await wait(300);
  ok(got === '/com' && chunks.length >= 4, '打 / 后逐字发给终端 (候选列表在终端里实时出现): ' + JSON.stringify(chunks));
  ok(await isCmd() && await p.inputValue('#dInput') === '', '进入命令模式，输入框高亮并保持为空');
  await p.screenshot({ path: shot('cmd.png') });
  got = ''; await p.keyboard.press('ArrowDown'); await p.keyboard.press('ArrowUp'); await p.keyboard.press('Tab'); await wait(200);
  ok(got === '\x1b[B\x1b[A\t', '↑ ↓ 选择、Tab 补全发给终端');
  ok(await p.evaluate(() => document.activeElement.id) === 'dInput', 'Tab 后焦点仍在输入框');
  got = ''; await p.keyboard.type(' 保'); await p.keyboard.insertText('留重点'); await wait(200);
  ok(got === ' 保留重点', '参数 (含中文) 也逐字发送: ' + JSON.stringify(got));
  got = ''; await p.keyboard.press('Enter'); await wait(200);
  ok(got === '\r' && !(await isCmd()), 'Enter 执行并退出命令模式');
  got = ''; await p.keyboard.type('hello'); await wait(200);
  ok(got === '' && await p.inputValue('#dInput') === 'hello', '退出后回到本地编辑');
  await p.fill('#dInput', '');
  // 退格删光退出
  got = ''; await p.keyboard.type('/c'); await p.keyboard.press('Backspace'); await wait(100);
  ok(await isCmd(), '删掉一个字仍在命令模式');
  await p.keyboard.press('Backspace'); await wait(100);
  ok(got === '/c\x7f\x7f' && !(await isCmd()), '删掉 / 后退出命令模式');
  got = ''; await p.keyboard.type('ab'); await wait(200); ok(got === '', '随后打字又是本地编辑'); await p.fill('#dInput', '');
  // Esc 退出
  got = ''; await p.keyboard.type('/x'); await p.keyboard.press('Escape'); await wait(200);
  ok(got === '/x\x1b' && !(await isCmd()), 'Esc 发给终端并退出命令模式');
  // Ctrl+C 退出
  got = ''; await p.keyboard.type('/y'); await p.keyboard.press('Control+c'); await wait(200);
  ok(got === '/y\x03' && !(await isCmd()), 'Ctrl+C 发给终端并退出命令模式');
  // 发送按钮
  got = ''; await p.keyboard.type('/z'); await p.click('#dSend'); await wait(200);
  ok(got === '/z\r' && !(await isCmd()), '命令模式下点 ↵ 按钮也是执行');
  // 文字中间的 / 、粘贴的 / 命令不触发
  got = ''; await p.keyboard.type('a/b'); await wait(200); ok(got === '' && !(await isCmd()), '不在开头的 / 不触发命令模式');
  await p.fill('#dInput', '');
  await p.evaluate(() => { const t = document.getElementById('dInput'); t.focus(); document.execCommand('insertText', false, '/compact'); });
  await wait(200); ok(got === '' && !(await isCmd()) && await p.inputValue('#dInput') === '/compact', '粘贴整条 /命令 仍在本地，Enter 一次发送');
  await p.keyboard.press('Enter'); await wait(300); ok(got === '/compact\r', '粘贴的命令回车发送');
  // 切标签退出
  got = ''; await p.keyboard.type('/q'); ok(await isCmd(), '进入命令模式');
  await p.locator('.host', { hasText: 'C' }).click(); await wait(1200);
  ok(!(await isCmd()), '切换 / 新开标签后退出命令模式');
  got = ''; await p.keyboard.type('zz'); await wait(200); ok(got === '', '新标签里打字是本地编辑');
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
