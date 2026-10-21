'use strict';
// HTTP：安全响应头、网页和前端资源、登录 / 退出，以及各个接口 (登录后才能用)
const fs = require('fs');
const path = require('path');
const express = require('express');
const { ROOT, DATA_DIR, AUTH_USER, SESSION_HOURS, COOKIE_SECURE, TRUST_PROXY, SCROLLBACK, PUSH_SUBJECT, VERSION } = require('./config');
const auth = require('./auth');
const { registerHosts, registerHistory, registerSettings, registerFavorites } = require('./api-data');
const { registerSessions } = require('./api-sessions');
const { liveSession } = require('./session');
const registerSftp = require('./sftp');
const forward = require('./forward');
const { registerHooks } = require('./hooks');
const { registerAgentSessions } = require('./agent-sessions');
const registerMonitor = require('./monitor');
const createPush = require('./push');

// onLogout(jti)：退出登录时断开用这个凭证打开的 WebSocket (见 ws.js)
function createApp({ onLogout }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', TRUST_PROXY);
  // 端口预览 (见 forward.js)：原样转发给目标主机上的开发服务，要在解析请求体之前 (不然 POST 的内容被读走了)，
  // 也不加 SSH-WEB 自己的安全头 (那是给 SSH-WEB 页面的)
  app.use('/p', forward.handle);
  app.use(express.json({ limit: '256kb' }));

  app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // 样式允许内联 (终端、历史视图的颜色都是内联样式)；脚本只能来自本站 (没有内联脚本)
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
      + "img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; "
      + "base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
    next();
  });

  // 带版本号 (?v=) 的前端资源内容不会变，让浏览器长期缓存，打开页面时不用再逐个向服务器确认；
  // 升级后首页里的版本号变了，会自动加载新文件
  // (只在文件存在时设置，404 不会被缓存)
  const staticOpts = {
    setHeaders(res) {
      if (res.req.query.v !== undefined) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  };

  // 前端静态资源 (xterm 直接从 node_modules 提供，NAS 离线也能用)
  for (const name of ['xterm', 'addon-fit', 'addon-web-links', 'addon-webgl']) {
    app.use('/vendor/' + name, express.static(path.join(ROOT, 'node_modules/@xterm', name), staticOpts));
  }
  // 首页不缓存，并给前端资源加版本号，升级后浏览器一定会加载新的 app.js / style.css
  const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8').replace(/\{\{VERSION\}\}/g, VERSION);
  // 登录凭证 Cookie (Max-Age 跟着有效期)；通过 HTTPS (如 Cloudflare 隧道) 访问时自动加 Secure
  const setSession = (req, res, token) => res.setHeader('Set-Cookie',
    `${auth.COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_HOURS * 3600)}`
    + (COOKIE_SECURE || req.secure ? '; Secure' : ''));
  // 用着就续期 (打开页面、调接口时)，只要隔一段时间用一次就不用重新登录；带长期缓存的静态资源不带 Cookie
  const renewSession = (req, res) => {
    const token = auth.renew(req);
    if (token) setSession(req, res, token);
  };
  const sendIndex = (req, res) => {
    renewSession(req, res);
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(INDEX_HTML);
  };
  app.get(['/', '/index.html'], sendIndex);
  // 前端代码按功能拆在 public/app/*.js (文件名带编号，按顺序)，这里拼成一个 app.js：
  // 各部分在同一个函数作用域里共用变量，所以只拆文件、不拆作用域，浏览器拿到的和拆之前完全一样
  const APP_DIR = path.join(ROOT, 'public', 'app');
  // lib/cli-input.js 服务端和网页共用 (网页里是全局的 CliInput)
  const APP_JS = "'use strict';\n\n" + fs.readFileSync(path.join(ROOT, 'lib', 'cli-input.js'), 'utf8') + "\n(() => {\n"
    + fs.readdirSync(APP_DIR).filter((f) => f.endsWith('.js')).sort().map((f) => fs.readFileSync(path.join(APP_DIR, f), 'utf8')).join('')
    + '})();\n';
  app.get('/app.js', (req, res) => {
    if (req.query.v !== undefined) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('js').send(APP_JS);
  });
  // Service Worker 必须每次检查更新
  app.get('/sw.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(ROOT, 'public', 'sw.js'));
  });
  app.use(express.static(path.join(ROOT, 'public'), { ...staticOpts, index: false }));

  app.get('/api/me', (req, res) => {
    renewSession(req, res); // 页面开着时回到前台 / 每 5 分钟会问一次
    res.json({
      authEnabled: auth.authEnabled, authed: auth.isAuthed(req), user: auth.authEnabled ? AUTH_USER : null,
      version: VERSION, weakPassword: auth.WEAK_PASSWORD, scrollback: SCROLLBACK,
    });
  });

  app.post('/api/login', (req, res) => {
    const ip = req.ip;
    if (!auth.authEnabled) return res.json({ ok: true });
    if (auth.loginBlocked(ip)) return res.status(429).json({ error: '失败次数过多，请 5 分钟后再试' });
    const { username, password } = req.body || {};
    const token = auth.login(username, password);
    if (token) {
      auth.loginOk(ip);
      setSession(req, res, token);
      return res.json({ ok: true });
    }
    auth.loginFailed(ip);
    res.status(401).json({ error: '用户名或密码错误' });
  });

  app.post('/api/logout', (req, res) => {
    const p = auth.tokenOf(req);
    try { auth.revoke(p); } catch (e) { console.error('退出登录：保存作废凭证失败', e.message); } // 写不了文件也照样清 Cookie
    // 用这个凭证打开的 WebSocket 马上断开
    if (p) onLogout(p.jti);
    res.setHeader('Set-Cookie', `${auth.COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.json({ ok: true });
  });

  // 以下接口需要登录
  app.use('/api', (req, res, next) => {
    if (!auth.isAuthed(req)) return res.status(401).json({ error: '未登录' });
    renewSession(req, res);
    next();
  });

  registerHosts(app);
  registerHistory(app);
  registerSettings(app);
  // 完成通知 (Web Push)
  const push = createPush(app, { dataDir: DATA_DIR, subject: PUSH_SUBJECT });
  registerFavorites(app);
  registerSftp(app, liveSession);
  registerMonitor(app, liveSession);
  registerSessions(app);
  forward.registerForward(app);
  registerHooks(app);
  registerAgentSessions(app);

  app.get('/healthz', (req, res) => res.send('ok'));
  return { app, push };
}

module.exports = { createApp };
