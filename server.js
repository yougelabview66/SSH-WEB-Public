'use strict';

/**
 * SSH-WEB —— 轻量级 Web SSH 终端
 * 设计参考: huashengdun/webssh、billchurch/webssh2、nirui/sshwifty
 *   浏览器 (xterm.js) <── WebSocket ──> Node.js (ssh2) <── SSH ──> 目标主机
 *
 * 连接方式:
 *   direct     : 直接 TCP 连接 host:port
 *   cloudflare : 目标 SSH 通过 Cloudflare Tunnel 暴露 (等同于 `cloudflared access ssh --hostname xxx`)，
 *                SSH 字节流封装在到 wss://<hostname> 的 WebSocket 二进制帧中，
 *                可选 Cloudflare Access Service Token (CF-Access-Client-Id / Secret)
 *
 * 这个文件只负责组装和启动，各部分在 lib/ 下：
 *   config.js      环境变量配置          auth.js       加密、登录凭证、登录限流
 *   store.js       数据文件 (主机等)      ssh-target.js 连接参数、白名单、指纹
 *   http.js        网页、登录、接口       api-data.js / api-sessions.js  各接口
 *   ws.js          WebSocket 消息         session/      后台会话 (SSH 连接、画面、输入、尺寸)
 *   events.js      通知所有页面           sftp.js / monitor.js / push.js / status.js / cli-input.js / echo-wait.js
 *   forward.js     端口预览 (转发目标主机上的开发服务)
 */

const http = require('http');
const { PORT, HOST, BG_TIMEOUT_HOURS, VERSION } = require('./lib/config');
const auth = require('./lib/auth');
const { createApp } = require('./lib/http');
const { attachWebSocket } = require('./lib/ws');
const { sessions, setPush } = require('./lib/session');
const forward = require('./lib/forward');

let ws = null;
const { app, push } = createApp({ onLogout: (jti) => ws.closeByJti(jti) });
setPush(push);

const server = http.createServer(app);
// Node 默认 5 分钟收不完请求就返回 408，大文件 / 慢网络上传会中途失败；这里不限制 (连接空闲仍由 keep-alive 管理)
server.requestTimeout = 0;
ws = attachWebSocket(server);
// 端口预览的 WebSocket (开发服务的热更新等，见 lib/forward.js)
server.on('upgrade', (req, socket, head) => { if (req.url.startsWith('/p/')) forward.upgrade(req, socket, head); });

// 每秒判断一次所有已连接会话的主机状态 (没人打开网页时也判断，手机才能收到推送)
setInterval(() => {
  for (const s of sessions.values()) s.updateState();
}, 1000);

// 清理长时间无人挂载的会话
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.clients.size) continue;
    const idleH = (now - s.detachedAt) / 3600000;
    if ((BG_TIMEOUT_HOURS > 0 && idleH > BG_TIMEOUT_HOURS) || (s.status === 'closed' && idleH > 24)) {
      console.log(`[${new Date().toISOString()}] 清理后台会话 ${s.title}`);
      s.terminate();
    }
  }
}, 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log(`SSH-WEB v${VERSION} 已启动: http://${HOST}:${PORT}`);
  if (!auth.authEnabled) {
    console.warn('⚠ 未设置 AUTH_PASSWORD，网页无需登录即可使用，请勿暴露到公网！');
  } else if (auth.WEAK_PASSWORD) {
    console.warn('⚠ AUTH_PASSWORD 仍是默认占位密码或少于 8 位，请在 docker-compose.yml 里改成强密码！');
  }
});

// 服务停止 (如更新容器) 时只断开连接，不通知浏览器关闭标签；重新启动后浏览器会提示会话已不存在并可重新连接
// 意外错误只记录日志，不让进程退出 (否则所有后台会话都会断开)
process.on('unhandledRejection', (e) => console.error('[未处理的异步错误]', e));
process.on('uncaughtException', (e) => console.error('[未捕获的异常]', e));

const shutdown = () => {
  for (const s of sessions.values()) s.closeConn();
  ws.wss.clients.forEach((c) => c.close());
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
