'use strict';
// 登录、退出登录作废凭证、安全响应头 (CSP) 下各功能正常
// @env AUTH_PASSWORD=test-pass-123 AUTH_USER=admin
const { WebSocket } = require('ws');
const { Server } = require('ssh2');
const { BASE, ok, wait, launch, run, hostKey } = require('./helpers');

new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc(); s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { const st = a(); st.write('$ '); });
  }));
}).listen(2255, '127.0.0.1');

const login = async (password = 'test-pass-123') => {
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) });
  return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
};
const get = (u, cookie) => fetch(BASE + u, { headers: cookie ? { cookie } : {} });
const wsOk = (cookie) => new Promise((resolve) => {
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws', { headers: { cookie } });
  ws.on('open', () => { ws.close(); resolve(true); });
  ws.on('error', () => resolve(false));
});

run(async () => {
  // 安全响应头
  const home = await get('/');
  const csp = home.headers.get('content-security-policy') || '';
  ok(/script-src 'self'/.test(csp) && /object-src 'none'/.test(csp) && /frame-ancestors 'self'/.test(csp), '首页带安全策略 (CSP)：只允许本站脚本');
  ok(!(await home.text()).match(/<script>(?!\s*<\/script>)/), '首页没有内联脚本 (主题脚本已挪到 theme.js)');

  // 登录 / 退出登录
  ok((await get('/api/hosts')).status === 401, '没登录不能访问接口');
  ok((await login('wrong')).status === 401, '密码错误登录失败');
  const a = await login();
  ok(a.status === 200 && a.cookie.startsWith('sshweb_session='), '登录成功拿到凭证');
  ok((await get('/api/hosts', a.cookie)).status === 200 && await wsOk(a.cookie), '凭证可以访问接口和 WebSocket');
  const b = await login(); // 另一台设备的登录
  const openWs = new WebSocket(BASE.replace('http', 'ws') + '/ws', { headers: { cookie: a.cookie } });
  await new Promise((r) => openWs.on('open', r));
  const closed = new Promise((r) => openWs.on('close', (code) => r(code)));
  await fetch(BASE + '/api/logout', { method: 'POST', headers: { cookie: a.cookie } });
  ok(await Promise.race([closed, wait(2000).then(() => 'timeout')]) === 4001, '退出登录：用这个凭证打开着的 WebSocket 马上断开');
  ok((await get('/api/hosts', a.cookie)).status === 401, '退出登录后，同一个旧凭证在服务端作废 (接口 401)');
  ok(!(await wsOk(a.cookie)), '旧凭证也连不上 WebSocket');
  ok((await get('/api/hosts', b.cookie)).status === 200, '另一台设备的登录不受影响');

  // 浏览器里：CSP 下各功能不报「违反安全策略」
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const cspErrs = [], errors = [];
  p.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) cspErrs.push(m.text()); });
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#login:not(.hidden)');
  const pw = () => p.evaluate(() => { const x = document.querySelector('#loginForm [name=password]'); return x.type + ' ' + x.autocomplete; });
  ok(await pw() === 'password current-password', '登录页：密码框是密码框，带自动填充提示 (浏览器能记住、填入登录密码)');
  await p.fill('#loginForm [name=username]', 'admin'); await p.fill('#loginForm [name=password]', 'test-pass-123');
  await p.click('#loginForm button[type=submit]'); await p.waitForSelector('#app:not(.hidden)');
  ok(await pw() === 'text off' && await p.inputValue('#loginForm [name=password]') === '', '登录后：登录框的密码清掉、变回普通文本框 (手机点输入栏不弹「密码」填充栏)');
  await p.click('#btnNew'); await wait(300);
  await p.fill('#hostForm [name=host]', '127.0.0.1'); await p.fill('#hostForm [name=port]', '2255');
  await p.fill('#hostForm [name=username]', 'u'); await p.fill('#hostForm [name=password]', 'x');
  await p.click('#hostForm button[type=submit]'); await wait(1800);
  ok(await p.evaluate(() => !!document.querySelector('.tab.active')), '登录后能连接主机');
  await p.click('#btnHistory'); await wait(400); await p.keyboard.press('Escape'); await wait(200);
  await p.click('#btnMore'); await p.click('#btnMon'); await wait(1500); await p.click('#btnMore'); await p.click('#btnMon'); await wait(200); // 监控在「⋯ 更多」菜单里
  await p.click('#btnSftp'); await wait(1000); await p.click('#btnSftp'); await wait(200);
  await p.click('#lat'); await wait(300); await p.click('#lat'); await wait(200);
  await p.click('#dMode'); await wait(300); await p.click('#dMode'); await wait(300);
  await p.evaluate(() => document.querySelector('#themeSeg [data-mode=dark]').click()); await wait(200);
  await p.reload(); await p.waitForSelector('#app:not(.hidden)');
  ok(await p.evaluate(() => document.documentElement.dataset.theme) === 'dark', '主题脚本 (theme.js) 照常在页面加载时生效');
  await wait(1500);
  ok(cspErrs.length === 0, '整个过程浏览器没有报违反安全策略' + (cspErrs.length ? ': ' + cspErrs.slice(0, 3).join(' | ') : ''));
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close();
});
