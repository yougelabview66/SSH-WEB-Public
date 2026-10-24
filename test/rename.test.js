'use strict';
// 命名标签：「⋯ 更多 → ✏️ 命名标签」给「主机名-」后面换一个名字 (主机名称保留，清空恢复按序号)；
// 刷新页面后名字还在 (服务端记着)；别的标签不受影响；HTTP 兜底接口也能改并广播到页面
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

  // 更多菜单里点「命名标签」(最后一项)
  await p.click('#btnMore'); await wait(200);
  ok(await p.isVisible('#btnRename'), '「⋯ 更多」菜单里有「✏️ 命名标签」');
  ok(await p.evaluate(() => document.querySelector('#morePop .mitem:last-of-type') === document.getElementById('btnRename')
    && document.getElementById('btnRename').textContent.includes('命名标签')), '菜单项叫「命名标签」，在钩子通知后面 (最后一项)');
  await p.click('#btnRename'); await wait(200);
  ok(await p.isVisible('#dialog:not(.hidden)'), '点了弹出命名对话框');
  ok(await p.inputValue('#dialogBody input[name=name]') === '1', '输入框预填当前序号「1」(主机名称保留在前面)');
  ok(await p.evaluate(() => getComputedStyle(document.querySelector('#dialogBody input[name=name]')).fontSize) === '16px',
    '输入框 16px：手机上聚焦不会把页面放大 (同终端搜索框的做法)');
  await p.fill('#dialogBody input[name=name]', '下载');
  await p.keyboard.press('Enter'); await wait(300);
  ok(await p.isHidden('#dialog'), '回车保存，对话框关掉');
  ok(await p.evaluate(() => document.querySelector('.tab.active .title').textContent) === '重命名测试机-下载', '主机名称保留，只改「-」后面的：变成「重命名测试机-下载」');
  ok(await p.evaluate(() => document.title) === '重命名测试机-下载 - SSH-WEB', '窗口标题跟着变');
  await p.screenshot({ path: shot('rename.png'), clip: { x: 0, y: 0, width: 1280, height: 50 } });

  // 服务端记着：主机名 + 后缀分开
  const infos = await (await fetch(BASE + '/api/sessions')).json();
  ok(infos.length === 1 && infos[0].title === '重命名测试机' && infos[0].suffix === '下载', '服务端 /api/sessions 里主机名不动、记着后缀');

  // 刷新页面：恢复的标签还是新名字
  await p.reload(); await p.waitForSelector('.tab'); await wait(800);
  ok(await p.evaluate(() => document.querySelector('.tab .title').textContent) === '重命名测试机-下载', '刷新页面后标签还是「重命名测试机-下载」');

  // HTTP 兜底接口改名也广播到开着的页面
  const infos2 = await (await fetch(BASE + '/api/sessions')).json();
  await fetch(`${BASE}/api/sessions/${infos2[0].id}/rename`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ suffix: '备用机' }) });
  await wait(500);
  ok(await p.evaluate(() => document.querySelector('.tab .title').textContent) === '重命名测试机-备用机', 'POST /api/sessions/:id/rename (后缀) 也广播到页面');

  // 清空 = 恢复按序号显示
  await p.click('#btnMore'); await p.click('#btnRename'); await wait(200);
  await p.fill('#dialogBody input[name=name]', '');
  await p.keyboard.press('Enter'); await wait(300);
  ok(await p.evaluate(() => document.querySelector('.tab.active .title').textContent) === '重命名测试机-1', '清空保存：恢复按序号显示「重命名测试机-1」');

  // 再开一个同主机的标签：接着序号往后排，不受命名影响
  await p.locator('.host').first().click(); await wait(600);
  const titles = await p.evaluate(() => [...document.querySelectorAll('.tab .title')].map((x) => x.textContent));
  ok(titles.length === 2 && titles[0] === '重命名测试机-1' && titles[1] === '重命名测试机-2', `新开的标签接着序号排: ${titles.join('、')}`);

  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close();
});
