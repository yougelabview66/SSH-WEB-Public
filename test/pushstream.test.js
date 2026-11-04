'use strict';
// 安卓 App 的推送：WebView 不支持 Web Push，App 在后台连着 /api/push/stream (SSE) 收，内容和 Web Push 一样，不经过谷歌的推送服务
const http = require('http');
const { BASE, ok, wait, run } = require('./helpers');

// 连上推送流，收到的事件放进 evs；lastId：断线重连时带上 (补发漏掉的)
function connect(id, lastId) {
  const evs = [];
  const u = new URL(BASE + '/api/push/stream?id=' + id);
  const st = { evs, res: null, status: 0, type: '', lastId: lastId || 0 };
  st.req = http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: lastId ? { 'Last-Event-ID': String(lastId) } : {} }, (res) => {
    st.res = res; st.status = res.statusCode; st.type = res.headers['content-type'] || '';
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = {};
        for (const line of block.split('\n')) {
          const m = /^(\w+): ?(.*)$/.exec(line);
          if (m) ev[m[1]] = (ev[m[1]] ? ev[m[1]] + '\n' : '') + m[2];
        }
        if (ev.event === 'push') { evs.push(JSON.parse(ev.data)); st.lastId = Number(ev.id); }
      }
    });
  });
  st.close = () => { try { st.req.destroy(); } catch {} };
  return st;
}
const post = (u, b) => fetch(BASE + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));

run(async () => {
  const a = connect('phone-1'), b = connect('tablet-2');
  await wait(800);
  ok(a.status === 200 && /text\/event-stream/.test(a.type), '推送流：SSE 连上 (text/event-stream): ' + a.status + ' ' + a.type);

  // 测试通知只发给点按钮的那台 App
  let r = await post('/api/push/test', { endpoint: 'app:phone-1' });
  await wait(500);
  ok(r.status === 200 && r.body.sent === 1 && a.evs.length === 1 && a.evs[0].title === 'SSH-WEB 测试通知' && b.evs.length === 0,
    '测试通知 (endpoint = app:设备 id)：只发给这台 App: ' + JSON.stringify([r.body, a.evs, b.evs]));
  r = await post('/api/push/test', { endpoint: 'app:nobody' });
  ok(r.status === 400 && /App 还没连上/.test(r.body.error), '这台 App 没连着：报错说清楚: ' + JSON.stringify(r.body));

  // 发给所有设备：没有浏览器订阅时，连着的 App 也算 (以前没有浏览器订阅就报错)
  r = await post('/api/push/test', {});
  await wait(500);
  ok(r.status === 200 && r.body.sent === 2 && a.evs.length === 2 && b.evs.length === 1, '发给所有设备：两台 App 都收到: ' + JSON.stringify(r.body));

  // App 换网络断开的那几秒漏掉的：重连时带上收到的最后一个编号，补发
  const last = a.lastId;
  a.close();
  await wait(500);
  await post('/api/push/test', {}); // 断开期间的推送 (只有 tablet-2 连着)
  await wait(300);
  const a2 = connect('phone-1', last);
  await wait(800);
  ok(a2.evs.length === 1 && a2.evs[0].title === 'SSH-WEB 测试通知' && b.evs.length === 2, '断线重连 (Last-Event-ID)：补发断开期间漏掉的推送: ' + JSON.stringify(a2.evs));
  // 只发给别的 App 的不补给这台
  const last2 = a2.lastId;
  a2.close(); await wait(300);
  await post('/api/push/test', { endpoint: 'app:tablet-2' });
  const a3 = connect('phone-1', last2);
  await wait(800);
  ok(a3.evs.length === 0, '只发给别的 App 的推送，重连时不补给这台');

  // 同一台 App 连了两次 (旧连接还没断开)：新的顶替旧的，不收两遍
  const a4 = connect('phone-1');
  await wait(600);
  await post('/api/push/test', { endpoint: 'app:phone-1' });
  await wait(500);
  ok(a4.evs.length === 1 && a3.evs.length === 0, '同一台 App 重复连接：新连接顶替旧的，只收一遍');
  a4.close(); a3.close(); b.close();
});
