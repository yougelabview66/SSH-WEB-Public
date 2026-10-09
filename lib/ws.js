'use strict';
// WebSocket：浏览器 <-> 后台会话。握手时校验登录和来源；消息里 connect / attach 挂载会话，之后转发按键、尺寸等
const { WebSocketServer } = require('ws');
const { MAX_SESSIONS, VERSION } = require('./config');
const auth = require('./auth');
const { Session, sessions } = require('./session');
const { buildConfig, str } = require('./ssh-target');
const { eventSockets, broadcastEvent } = require('./events');

// 拒绝其他网站发起的 WebSocket 连接 (跨站 WebSocket 劫持)
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // 非浏览器客户端
  try {
    const host = new URL(origin).host;
    const fwd = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    return host === req.headers.host || (fwd && host === fwd);
  } catch {
    return false;
  }
}

function attachWebSocket(server) {
  // 压缩终端输出 (文本压缩率高，手机 / 隧道上省流量、更快)；按键回显这类小帧不压缩，不增加延迟
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    perMessageDeflate: {
      threshold: 256,
      zlibDeflateOptions: { level: 3 },
      concurrencyLimit: 4,
    },
  });

  server.on('upgrade', (req, socket, head) => {
    const reject = (code, text) => {
      socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
    };
    socket.on('error', () => {});
    try {
      if (!req.url.startsWith('/ws') || new URL(req.url, 'http://x').pathname !== '/ws') return reject(404, 'Not Found');
      if (!auth.isAuthed(req)) return reject(401, 'Unauthorized');
      if (!sameOrigin(req)) return reject(403, 'Forbidden');
      const jti = auth.authEnabled ? auth.tokenOf(req)?.jti : null;
      wss.handleUpgrade(req, socket, head, (ws) => { ws.jti = jti; wss.emit('connection', ws, req); });
    } catch {
      reject(400, 'Bad Request');
    }
  });

  wss.on('connection', (ws, req) => {
    const clientIp = req.headers['cf-connecting-ip'] ||
      req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    const sendCtl = (obj) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    };

    // WebSocket 心跳，防止 NAS 反代 / 路由器掐断空闲连接
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw, isBinary) => {
      const sess = ws.session;
      if (isBinary) {
        if (sess) sess.write(raw);
        return;
      }
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;

      switch (msg.type) {
        case 'connect': {
          if (sess) return;
          if (sessions.size >= MAX_SESSIONS) {
            return sendCtl({ type: 'error', message: `会话数量已达上限 (${MAX_SESSIONS})，请先关闭不用的标签` });
          }
          let cfg;
          try {
            cfg = buildConfig(msg);
          } catch (e) {
            return sendCtl({ type: 'error', message: e.message });
          }
          const s = new Session(cfg, {
            title: msg.title, n: msg.n, histHost: msg.histHost, hostId: msg.hostId, cols: msg.cols, rows: msg.rows, clientIp,
          });
          // 序号由服务端决定：接着所有设备上同名会话的最大序号往后排 (浏览器只知道自己打开时的标签)
          let maxN = 0;
          for (const x of sessions.values()) if (x.title === s.title) maxN = Math.max(maxN, x.n);
          s.n = Math.min(maxN + 1, 999);
          sessions.set(s.id, s);
          s.attach(ws);
          s.owner = ws; // 新建会话的设备就是使用者
          if (s.cols && s.rows) ws.size = { cols: s.cols, rows: s.rows };
          s.connect();
          broadcastEvent({ type: 'session-created', session: s.info(), pageId: str(msg.pageId) });
          break;
        }
        case 'attach': {
          if (sess) return;
          const s = sessions.get(String(msg.id));
          if (!s) return sendCtl({ type: 'gone' });
          s.resize(msg.cols, msg.rows, ws, msg.claim !== false);
          s.attach(ws, msg.offset);
          break;
        }
        case 'data':
          if (sess && typeof msg.data === 'string') sess.write(msg.data, msg.auto === true ? ws : null, ws, { gap: Number(msg.gap) || 0, echo: msg.echo === true, tmux: msg.tmux === true });
          break;
        case 'resize':
          if (sess) sess.resize(msg.cols, msg.rows, ws, msg.claim !== false);
          break;
        case 'reconnect':
          if (sess) sess.connect();
          break;
        case 'watching': // 浏览器当前是否正在看这个标签 (页面可见且是当前标签，决定终端按哪台设备排版)；
          ws.watching = !!msg.watching; // front：网页在前台 (没最小化、浏览器是当前窗口)，决定要不要推送
          if (msg.front !== undefined) ws.front = !!msg.front;
          break;
        case 'close':
          if (sess) sess.terminate();
          break;
        case 'prompt-response':
        case 'hostkey-response':
          if (sess) sess.answer(msg);
          break;
        case 'tmux-history':
          if (sess) sess.captureTmux(ws, msg.lines);
          break;
        case 'ping': // 带时间戳的用来测网页 ↔ 服务端的往返延迟，原样带回；顺便测一次到目标主机的 SSH 延迟
          if (!Number.isFinite(msg.t)) { sendCtl({ type: 'pong' }); break; }
          sendCtl({ type: 'pong', t: msg.t });
          if (sess) sess.measureLatency();
          break;
        case 'events': // 页面的事件连接 (不挂载会话)；告诉页面服务器现在的版本 (服务器更新重启后页面重连就知道了)
          if (!sess) eventSockets.add(ws);
          sendCtl({ type: 'version', version: VERSION });
          break;
      }
    });

    const detach = () => {
      eventSockets.delete(ws);
      if (ws.session) ws.session.detach(ws);
    };
    ws.on('close', detach);
    ws.on('error', detach);
  });

  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);
  wss.on('close', () => clearInterval(heartbeat));

  // 退出登录：用这个凭证打开的 WebSocket 马上断开
  const closeByJti = (jti) => {
    for (const ws of wss.clients) if (ws.jti === jti) ws.close(4001, 'logged out');
  };
  return { wss, closeByJti };
}

module.exports = { attachWebSocket };
