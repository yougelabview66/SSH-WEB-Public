'use strict';
// 端口预览：目标主机上本机才能访问的网页 (Claude Code 跑起来的开发服务，如 localhost:5173)，
// 借标签的 SSH 连接转发 (同 ssh -L)，在浏览器里打开 /p/<端口>-<口令>/ 就能看。
//
// 口令用 SECRET 算出来 (每个端口固定，服务重启后不变，开发服务的 --base 设一次就行)，地址本身就是凭证，不靠登录 Cookie。
// 预览的网页和 SSH-WEB 同一个网址，默认加浏览器沙箱 (隔离)：它拿不到 SSH-WEB 的登录状态，不能借你的身份开会话、发命令；
// 代价是它自己的 localStorage / cookie 用不了。在网页上为某个端口打开「完整模式」就不加沙箱 (风险见网页上的说明)

const http = require('http');
const crypto = require('crypto');
const auth = require('./auth');
const { sessions, liveSession } = require('./session');

const tokenOf = (port) => auth.signLabel('preview:' + port);
const prefixOf = (port) => `/p/${port}-${tokenOf(port)}`;
// 隔离：不给 allow-same-origin，网页的来源变成「不透明」，带不上 SSH-WEB 的 Cookie
const SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock';

const routes = new Map(); // 端口 → { sid, hostId, full }：在哪个标签里点的预览 (那个标签断了就找同一台主机别的标签)

// /p/<端口>-<口令>/<路径>：口令对得上返回 { port, path, prefix }
function parse(url) {
  const m = /^\/p\/(\d{1,5})-([A-Za-z0-9_-]{12})(\/[^]*)?$/.exec(url);
  if (!m) return null;
  const port = +m[1];
  if (port < 1 || port > 65535) return null;
  const want = Buffer.from(tokenOf(port)), got = Buffer.from(m[2]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  return { port, path: m[3] || '', prefix: prefixOf(port) };
}

function sessionFor(port) {
  const r = routes.get(port);
  if (!r) return { r: null, s: null };
  let s = liveSession(r.sid);
  if (!s && r.hostId) s = [...sessions.values()].find((x) => x.hostId === r.hostId && liveSession(x.id)) || null;
  return { r, s };
}

// 发给开发服务的请求头：Host 换成它自己的 (Vite 等会检查)，不带 SSH-WEB 的登录 Cookie；
// Origin 是 SSH-WEB / 沙箱 (null) 的换成它自己的 (不然有的开发服务会当成跨站请求拒绝)
function upstreamHeaders(req, port) {
  const h = { ...req.headers, host: `localhost:${port}` };
  if (h.cookie) {
    const rest = h.cookie.split(/;\s*/).filter((c) => c && !c.startsWith(auth.COOKIE_NAME + '=')).join('; ');
    if (rest) h.cookie = rest; else delete h.cookie;
  }
  if (h.origin) h.origin = `http://localhost:${port}`;
  return h;
}

function errorPage(res, code, text) {
  if (res.headersSent) return res.destroy();
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SSH-WEB 端口预览</title>`
    + `<body style="font:15px/1.6 system-ui,sans-serif;padding:24px;max-width:640px;margin:auto"><h3>端口预览打不开</h3><p>${text}</p></body>`);
}

function handle(req, res) {
  const t = parse('/p' + req.url);
  if (!t) return errorPage(res, 404, '预览地址不对。请在 SSH-WEB 里点「🌐 预览」重新打开。');
  if (!t.path) { res.writeHead(301, { Location: t.prefix + '/' }); return res.end(); } // 补上结尾的 /，网页里的相对路径才对
  const { r, s } = sessionFor(t.port);
  if (!s) {
    return errorPage(res, 502, r ? '打开预览的标签已经断开了。请重新连上这台主机，再在 SSH-WEB 里点「🌐 预览」。'
      : `端口 ${t.port} 还没在 SSH-WEB 里打开过预览 (或 SSH-WEB 重启过)。请在对应主机的标签里点「🌐 预览」。`);
  }
  s.ssh.forwardOut('127.0.0.1', 0, 'localhost', t.port, (err, stream) => {
    if (err) return errorPage(res, 502, `目标主机上的 localhost:${t.port} 连不上 (${err.message})。开发服务是不是还没启动，或者端口不对？`);
    const preq = http.request({ createConnection: () => stream, method: req.method, path: t.path, headers: upstreamHeaders(req, t.port) }, (pres) => {
      const h = { ...pres.headers };
      // 跳转到开发服务自己的地址：改回预览地址
      if (h.location) {
        const loc = h.location.replace(new RegExp(`^https?://(localhost|127\\.0\\.0\\.1|\\[::1\\]):${t.port}(?=/|$)`), '');
        if (loc.startsWith('/') && !loc.startsWith('//')) h.location = t.prefix + loc;
        else if (loc === '') h.location = t.prefix + '/';
      }
      if (r.full) {
        // 完整模式：开发服务设的 Cookie 只在这个预览地址下有效，不和 SSH-WEB 的混在一起
        if (h['set-cookie']) h['set-cookie'] = h['set-cookie'].map((c) => (/;\s*path=/i.test(c) ? c.replace(/;\s*path=[^;]*/i, `; Path=${t.prefix}/`) : `${c}; Path=${t.prefix}/`));
      } else {
        h['content-security-policy'] = [].concat(h['content-security-policy'] || [], SANDBOX);
        // 沙箱里的网页来源是 null：加载模块脚本、fetch 自己的接口都算跨域，要允许
        if (!h['access-control-allow-origin']) h['access-control-allow-origin'] = '*';
      }
      res.writeHead(pres.statusCode, pres.statusMessage, h);
      pres.pipe(res);
    });
    preq.on('error', (e) => errorPage(res, 502, `转发出错：${e.message}`));
    res.on('close', () => { if (!res.writableFinished) stream.destroy(); });
    req.pipe(preq);
  });
}

// WebSocket (开发服务的热更新等)：握手请求原样转过去 (换掉 Host / Origin / Cookie)，之后两边直接对接
function upgrade(req, socket, head) {
  socket.on('error', () => {});
  const t = parse(req.url);
  const { s } = t ? sessionFor(t.port) : {};
  if (!t || !t.path || !s) return socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
  s.ssh.forwardOut('127.0.0.1', 0, 'localhost', t.port, (err, stream) => {
    if (err) return socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    const h = upstreamHeaders(req, t.port);
    let raw = `${req.method} ${t.path} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(h)) for (const x of [].concat(v)) raw += `${k}: ${x}\r\n`;
    stream.write(raw + '\r\n');
    if (head && head.length) stream.write(head);
    stream.pipe(socket).on('error', () => {});
    socket.pipe(stream);
    const end = () => { socket.destroy(); stream.destroy(); };
    stream.on('close', end);
    socket.on('close', end);
  });
}

// 网页用的接口 (要登录)：目标主机上在监听的端口；打开某个端口的预览
function registerForward(app) {
  // 列出目标主机上在监听的 TCP 端口 (ss，没有就用 netstat)，带上进程名和预览地址
  app.post('/api/forward/ports', (req, res) => {
    const s = liveSession(String(req.body?.sid || ''));
    if (!s) return res.status(404).json({ error: '会话不存在或已断开' });
    const script = 'PATH="$PATH:/usr/sbin:/sbin"; ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null || netstat -an 2>/dev/null';
    s.runScript(script, (r) => {
      if (!r) return res.status(502).json({ error: '在目标主机上执行命令失败' });
      res.json({ ports: parsePorts(r.data.toString('utf8')).map((x) => ({ ...x, prefix: prefixOf(x.port) })) });
    });
  });

  // 打开预览：记下这个端口用哪个标签转发、是不是完整模式，返回预览地址
  app.post('/api/forward', (req, res) => {
    const s = liveSession(String(req.body?.sid || ''));
    const port = parseInt(req.body?.port, 10);
    if (!s) return res.status(404).json({ error: '会话不存在或已断开' });
    if (!(port >= 1 && port <= 65535)) return res.status(400).json({ error: '端口要在 1–65535 之间' });
    routes.set(port, { sid: s.id, hostId: s.hostId, full: !!req.body?.full });
    res.json({ url: prefixOf(port) + '/', prefix: prefixOf(port) });
  });
}

// ss / netstat 的输出 → [{ port, addr, proc }]，同一个端口只留一条 (优先本机地址)
function parsePorts(text) {
  const out = new Map();
  for (const line of text.split('\n')) {
    if (!/LISTEN/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    const local = cols.find((c) => /[:.]\d+$/.test(c) && /^(\*|\[?[0-9a-fA-F:.%\w]*\]?)[:.]\d+$/.test(c));
    if (!local) continue;
    const m = /^(.*)[:.](\d+)$/.exec(local);
    const port = +m[2];
    if (!port) continue;
    const addr = m[1].replace(/^\[|\]$/g, '').replace(/%.*$/, '') || '*';
    const proc = (/users:\(\("([^"]+)"/.exec(line) || /\d+\/(\S+)\s*$/.exec(line) || [])[1] || '';
    const old = out.get(port);
    if (!old || (!old.proc && proc)) out.set(port, { port, addr, proc: proc || old?.proc || '' });
  }
  return [...out.values()].sort((a, b) => a.port - b.port);
}

module.exports = { handle, upgrade, registerForward, parsePorts, prefixOf };
