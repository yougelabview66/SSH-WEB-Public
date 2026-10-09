'use strict';
// 手机 (iPhone / 安卓) 上，页面里只要有密码框，点任何输入框 —— 包括下方的手机输入栏 —— 都会在输入法上方弹出「密码」填充栏。
// 平时页面里不能有密码框、也不带用户名 / 密码的自动填充提示；打开主机对话框时才变成密码框，关掉后变回来、填过的密码清掉
const { BASE, ok, wait, launch, devices, hostKey } = require('./helpers');
const { Server } = require('ssh2');
// 登录时要输入验证码 (不回显 → 对话框里是密码框)
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => {
    if (ctx.method !== 'keyboard-interactive') return ctx.reject(['keyboard-interactive']);
    ctx.prompt([{ prompt: 'Verification code: ', echo: false }], (answers) => (answers[0] === '123456' ? ctx.accept() : ctx.reject()));
  });
  c.on('ready', () => c.on('session', (acc) => { const s = acc(); s.on('pty', (a) => a()); s.on('shell', (a) => a().write('$ ')); }));
}).listen(2294, '127.0.0.1');

(async () => {
  const browser = await launch();
  const errors = [];
  const p = await (await browser.newContext({ ...devices['iPhone 13'] })).newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  const scan = () => p.evaluate(() => ({
    pw: document.querySelectorAll('input[type=password]').length,
    ac: [...document.querySelectorAll('input, textarea')].map((x) => x.getAttribute('autocomplete') || '').filter((a) => /password|username/.test(a)),
  }));
  let r = await scan();
  ok(r.pw === 0 && r.ac.length === 0, `平时页面里没有密码框、没有用户名 / 密码自动填充提示 (密码框 ${r.pw} 个，提示 ${JSON.stringify(r.ac)})`);

  await p.evaluate(() => document.getElementById('btnNew').click()); await wait(300);
  const field = (n) => p.evaluate((n) => { const x = document.querySelector(`#hostForm [name=${n}]`); return x.type + ' ' + x.autocomplete; }, n);
  ok(await field('password') === 'password new-password' && await field('passphrase') === 'password new-password' && await field('cfClientSecret') === 'password new-password',
    '打开主机对话框：密码、私钥密码、CF Secret 变成密码框 (输入时显示圆点)');
  await p.fill('#hostForm [name=password]', 'secret-1');
  await p.evaluate(() => document.getElementById('btnCancel').click()); await wait(200);
  r = await scan();
  ok(r.pw === 0 && r.ac.length === 0, '关掉对话框：变回普通文本框，没有自动填充提示');
  ok(await p.evaluate(() => document.querySelector('#hostForm [name=password]').value) === '', '关掉对话框：填过的密码清掉，不留在页面里');

  await p.evaluate(() => document.getElementById('btnNew').click()); await wait(300);
  ok(await field('password') === 'password new-password', '再打开又是密码框');
  await p.keyboard.press('Escape'); await wait(200);
  ok((await scan()).pw === 0, '按 Esc 关掉也变回来');

  // SSH 登录要验证码：对话框里是密码框，答完关掉后不留在页面里
  await fetch(BASE + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'KI', host: '127.0.0.1', port: 2294, username: 'u' }) });
  const d = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  d.on('pageerror', (e) => errors.push(e.message));
  await d.goto(BASE + '/'); await d.waitForSelector('#app:not(.hidden)');
  await d.locator('.host', { hasText: 'KI' }).click(); await wait(300);
  if (await d.isVisible('#modal')) await d.click('#hostForm button[type=submit]'); // 没存密码：先弹「连接」对话框，直接连
  await d.waitForSelector('#dialog:not(.hidden)', { timeout: 15000 });
  if (await d.locator('#dialogBody').textContent().then((t) => /指纹/.test(t))) { // 新主机先确认指纹
    await d.click('#dialogActions button.primary'); await wait(500);
    await d.waitForSelector('#dialog:not(.hidden)', { timeout: 15000 });
  }
  ok(await d.evaluate(() => document.querySelectorAll('#dialogBody input[type=password]').length) === 1, '验证码对话框：输入框不显示明文');
  await d.fill('#dialogBody input', '123456'); await d.keyboard.press('Enter');
  await d.waitForSelector('.tab.active .dot.ok', { timeout: 10000 }); await wait(300);
  ok(await d.evaluate(() => document.querySelectorAll('input[type=password]').length === 0 && !document.querySelector('#dialogBody input')),
    '答完验证码：对话框里的密码框和填过的验证码都清掉了');
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
