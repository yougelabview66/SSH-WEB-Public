'use strict';
// 登录用着就续期：隔一段时间用一次就不用重新登录；不用了才过期；续过期的凭证退出登录照样作废
// @env AUTH_PASSWORD=test-pass-123 SESSION_HOURS=0.002
const { BASE, ok, wait, run } = require('./helpers');

const login = async () => {
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test-pass-123' }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
};
const get = (u, cookie) => fetch(BASE + u, { headers: cookie ? { cookie } : {} });
const newCookie = (r) => (r.headers.get('set-cookie') || '').split(';')[0];

run(async () => {
  // 有效期 0.002 小时 ≈ 7.2 秒，凭证发出 1.8 秒 (1/4) 后再用就续期
  const a = await login();
  let r = await get('/api/hosts', a);
  ok(r.status === 200 && !newCookie(r), '刚登录不续期 (不用每个请求都换 Cookie)');
  await wait(2500);
  r = await get('/api/hosts', a);
  const a2 = newCookie(r);
  ok(r.status === 200 && a2.startsWith('sshweb_session=') && a2 !== a, '用着一段时间后接口返回续期的新凭证');
  ok(/Max-Age=7\b/.test(r.headers.get('set-cookie')) && /HttpOnly/.test(r.headers.get('set-cookie')), '续期的 Cookie 照样带有效期、HttpOnly: ' + r.headers.get('set-cookie'));
  r = await get('/', a2); await wait(2500);
  const home = await get('/', a2);
  const a3 = newCookie(home);
  ok(home.status === 200 && a3.startsWith('sshweb_session='), '打开页面也续期');
  const me = await get('/api/me', a3); await wait(2500);
  const a4 = newCookie(await get('/api/me', a3)) || a3;
  ok((await me.json()).authed && a4 !== a3, '页面开着时定时问的 /api/me 也续期');
  await wait(2500);
  // 从登录算起已经过了 10 秒 (> 7.2 秒)，一直在用就还登录着；最开始的凭证没续过，过期了
  ok((await get('/api/hosts', a4)).status === 200, '一直在用：过了原来的有效期还登录着');
  ok((await get('/api/hosts', a)).status === 401, '没续过的旧凭证照常过期');

  // 退出登录：续过期的凭证作废，同一次登录之前的凭证 (jti 一样) 也作废
  const b = await login(); await wait(2500);
  const b2 = newCookie(await get('/api/hosts', b));
  await fetch(BASE + '/api/logout', { method: 'POST', headers: { cookie: b2 } });
  ok((await get('/api/hosts', b2)).status === 401 && (await get('/api/hosts', b)).status === 401, '退出登录后续期的新凭证和之前的凭证都作废');
  ok((await get('/api/hosts', a4)).status === 200, '另一台设备的登录不受影响');

  // 不用了：过了有效期就要重新登录
  await wait(8000);
  ok((await get('/api/hosts', a4)).status === 401, '一段时间不用 (超过有效期) → 要重新登录');
});
