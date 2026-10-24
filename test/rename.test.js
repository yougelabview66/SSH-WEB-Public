'use strict';
// 重命名标签：「⋯ 更多 → ✏️ 重命名标签」改当前标签的显示名；刷新页面后名字还在 (服务端记着)；
// 别的标签不受影响；服务端 /api/sessions 里也是新名字
const { BASE, ok, wait, shot, hostKey, chromium, run } = require('./helpers');
const { Server } = require('ssh2');
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => { const s = acc(); s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { const st = a(); st.write('$ '); }); }));
}).listen(2287, '127.0.0.1');
run(async () => {
  await fetch(BASE + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '重命名测试机', host: '127.0.0.1', port: 2287, username: 'u', password: 'x' }) });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  const errors = [];
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 600 } })).newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host').first().click();
  await p.waitForSelector('.tab');
  await p.waitForSelector('#btnMore:not(.hidden)');
  await wait(500);
  ok(await p.evaluate(() => document.querySelector('.tab.active .title').textContent) === '重命名测试机-1', '打开主机：标签是「重命名测试机-1」');

  // 更多菜单里点「重命名标签」
  await p.click('#btnMore'); await wait(200);
  ok(await p.isVisible('#btnRename'), '「⋯ 更多」菜单里有「✏️ 重命名标签」');
  await p.click('#btnRename'); await wait(200);
  ok(await p.isVisible('#dialog:not(.hidden)'), '点了弹出改名对话框');
  ok(await p.inputValue('#dialogBody input[name=name]') === '重命名测试机', '输入框预填当前名字');
  await p.fill('#dialogBody input[name=name]', '我的下载机');
  await p.keyboard.press('Enter'); await wait(300);
  ok(await p.isHidden('#dialog'), '回车保存，对话框关掉');
  ok(await p.evaluate(() => document.querySelector('.tab.active .title').textContent) === '我的下载机-1', '标签变成「我的下载机-1」(序号照旧挂后面)');
  ok(await p.evaluate(() => document.title) === '我的下载机-1 - SSH-WEB', '窗口标题跟着变');
  await p.screenshot({ path: shot('rename.png'), clip: { x: 0, y: 0, width: 1280, height: 50 } });

  // 服务端记着新名字
  const infos = await (await fetch(BASE + '/api/sessions')).json();
  ok(infos.length === 1 && infos[0].title === '我的下载机', '服务端 /api/sessions 里也是新名字');

  // 刷新页面：恢复的标签还是新名字
  await p.reload(); await p.waitForSelector('.tab'); await wait(800);
  ok(await p.evaluate(() => document.querySelector('.tab .title').textContent) === '我的下载机-1', '刷新页面后标签还是「我的下载机-1」');

  // 再开一个同主机的标签：默认名照旧、编号从 1 重新数 (改过的名字不影响它)
  await p.locator('.host').first().click(); await wait(600);
  const titles = await p.evaluate(() => [...document.querySelectorAll('.tab .title')].map((x) => x.textContent));
  ok(titles.length === 2 && titles[0] === '我的下载机-1' && titles[1] === '重命名测试机-1', `新开的标签用默认名、编号独立: ${titles.join('、')}`);

  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close();
});
