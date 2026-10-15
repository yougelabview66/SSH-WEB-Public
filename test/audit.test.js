'use strict';
// 审计日志：登录 / 会话事件记下出口 IP、连接 IP、代理路径 (按 TRUST_PROXY 核实)、登录编号、SSH-WEB 到目标主机的连接
// @env AUTH_PASSWORD=test-pass-123 AUTH_USER=admin
const { WebSocket } = require('ws');
const { Server } = require('ssh2');
const { BASE, ok, wait, run, hostKey } = require('./helpers');

new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc(); s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { const st = a(); st.write('$ '); });
  }));
}).listen(2261, '127.0.0.1');

const login = async (password, headers = {}) => {
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ username: 'admin', password }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
};
let cookie = '';
const audit = (q = '') => fetch(BASE + '/api/audit?limit=50&q=' + encodeURIComponent(q), { headers: { cookie } }).then((r) => r.json());
const find = async (ev, pred = () => true, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = (await audit()).find((x) => x.ev === ev && pred(x));
    if (r) return r;
    await wait(100);
  }
  return null;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const openWs = (xff) => new Promise((resolve) => {
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws', { headers: { cookie, 'x-forwarded-for': xff } });
  ws.on('open', () => resolve(ws));
});

run(async () => {
  // 经过两层代理 (10.0.0.5 受信任，1.2.3.4 是出口)，最前面的 6.6.6.6 是客户端自己声称的
  await login('wrong', { 'x-forwarded-for': '6.6.6.6, 1.2.3.4, 10.0.0.5', 'cf-ray': 'abc123-NRT', 'cf-ipcountry': 'JP', 'user-agent': 'audit-test' });
  cookie = await login('test-pass-123');
  ok(cookie.startsWith('sshweb_session='), '登录成功');
  const fail = await find('login-fail');
  ok(fail && fail.ip === '1.2.3.4' && fail.peer === '127.0.0.1' && same(fail.path, ['1.2.3.4', '10.0.0.5', '127.0.0.1']),
    '登录失败：出口 IP 是第一个不受信任的地址，连接 IP 是本机，代理路径从出口到连接 IP');
  ok(fail && same(fail.claimed, ['6.6.6.6']) && fail.cf?.ray === 'abc123-NRT' && fail.cf?.country === 'JP' && fail.user === 'admin' && fail.ua === 'audit-test',
    '登录失败：客户端声称的地址单独记成 claimed，带 CF-Ray / 国家 / 尝试的用户名 / UA');
  ok(!JSON.stringify(fail).includes('wrong'), '登录失败不记密码');
  const lg = await find('login');
  ok(lg && lg.ip === '127.0.0.1' && same(lg.path, ['127.0.0.1']) && /^[0-9a-f]{12}$/.test(lg.sid), '直连登录：出口 IP 就是连接 IP，带登录编号');
  ok((await fetch(BASE + '/api/audit')).status === 401, '没登录不能看审计日志');

  // 新建会话 → 连上目标主机
  const a = await openWs('5.5.5.5');
  const created = new Promise((r) => a.on('message', (d) => { try { const m = JSON.parse(d); if (m.type === 'attached') r(m.session.id); } catch {} }));
  a.send(JSON.stringify({ type: 'connect', host: '127.0.0.1', port: 2261, username: 'u', password: 'x', title: 'audit', cols: 80, rows: 24, device: '电脑', deviceId: 'dev-a', pageId: 'p1' }));
  const id = await created;
  const open = await find('ssh-open', (x) => x.session === id);
  ok(open && open.ip === '5.5.5.5' && same(open.path, ['5.5.5.5', '127.0.0.1']) && open.sid === lg.sid && open.target === 'u@127.0.0.1:2261' && open.route === 'direct' && open.device === '电脑',
    '打开会话：记下出口 IP、代理路径、登录编号 (和登录那条一样)、目标主机、设备');
  const ready = await find('ssh-ok', (x) => x.session === id);
  ok(ready && ready.out?.remote === '127.0.0.1:2261' && /^127\.0\.0\.1:\d+$/.test(ready.out?.local || ''), '连上目标主机：记下 SSH-WEB 本机地址 → 目标主机地址');
  ok(!JSON.stringify(await audit()).includes('"x"'), '审计日志里没有 SSH 密码');

  // 同一设备 + 同一来源重连不重复记；换了出口 IP 再记一条
  const attach = (ws, deviceId) => ws.send(JSON.stringify({ type: 'attach', id, cols: 80, rows: 24, device: '手机', deviceId, pageId: 'p2' }));
  a.close();
  const b = await openWs('5.5.5.5'); attach(b, 'dev-a');
  await wait(500);
  ok(!(await find('ssh-attach', (x) => x.session === id, 300)), '同一设备、同一来源断线重连不重复记');
  const c = await openWs('7.7.7.7, 10.1.2.3'); attach(c, 'dev-b');
  const at = await find('ssh-attach', (x) => x.session === id);
  ok(at && at.ip === '7.7.7.7' && same(at.path, ['7.7.7.7', '10.1.2.3', '127.0.0.1']) && at.device === '手机', '别的设备从别的出口打开：记一条 ssh-attach');

  // 查找、关闭、退出
  ok((await audit('7.7.7.7')).every((x) => JSON.stringify(x).includes('7.7.7.7')) && (await audit('7.7.7.7')).length >= 1, '/api/audit?q= 按 IP 查');
  c.send(JSON.stringify({ type: 'close' }));
  const cl = await find('ssh-close', (x) => x.session === id);
  ok(cl && cl.ip === '7.7.7.7' && cl.sid === lg.sid, '关闭会话：记下是谁关的');
  b.close();
  const sid = lg.sid;
  await fetch(BASE + '/api/logout', { method: 'POST', headers: { cookie } });
  cookie = await login('test-pass-123');
  ok(await find('logout', (x) => x.sid === sid), '退出登录：记下登录编号');
});
