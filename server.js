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
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocket, WebSocketServer, createWebSocketStream } = require('ws');
const { Client } = require('ssh2');
const registerSftp = require('./lib/sftp');
const registerMonitor = require('./lib/monitor');
const createPush = require('./lib/push');
const { StatusTracker } = require('./lib/status');
const { Terminal: HeadlessTerminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

// ---------------------------------------------------------------- 配置
const PORT = parseInt(process.env.PORT || '8888', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
const SESSION_HOURS = parseFloat(process.env.SESSION_HOURS || '24');
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
// 只信任来自这些地址的 X-Forwarded-For (反向代理 / cloudflared 容器)，防止伪造 IP 绕过登录限流
const TRUST_PROXY = process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal';
// 可选: 限制只能连接这些主机，逗号分隔，如 "192.168.1.*,nas.local"
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const SSH_READY_TIMEOUT = parseInt(process.env.SSH_READY_TIMEOUT || '20000', 10);
const SSH_KEEPALIVE = parseInt(process.env.SSH_KEEPALIVE || '15000', 10);
// 主机指纹校验策略: ask = 新主机和指纹变化都弹窗确认 (默认)
//                  accept-new = 新主机自动信任，指纹变化才弹窗
//                  off = 不校验 (不推荐)
const HOSTKEY_POLICY = ['ask', 'accept-new', 'off'].includes(process.env.HOSTKEY_POLICY)
  ? process.env.HOSTKEY_POLICY : 'ask';
// 后台会话: 无人挂载超过多少小时自动关闭 (默认 168 = 7 天，0 = 永不)；最多同时保留的会话数；每个会话保留的滚动行数
const BG_TIMEOUT_HOURS = parseFloat(process.env.BG_TIMEOUT_HOURS ?? '168') || 0;
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || '30', 10);
const SCROLLBACK = parseInt(process.env.SCROLLBACK || '5000', 10);
// 等待用户输入验证码 / 确认指纹的最长时间
const USER_INPUT_TIMEOUT = 5 * 60 * 1000;
// 终端输出流控: 几毫秒内的零碎输出合并成一帧发送；
// 浏览器积压超过 HIGH (网速慢 + 大量输出) 时暂停读取 SSH，降到 LOW 以下再继续，避免数据堆在服务端内存
const OUTPUT_FLUSH_MS = 4;
const WS_HIGH = 1024 * 1024;
const WS_LOW = 256 * 1024;
const TERM_HIGH = 4 * 1024 * 1024; // 无界面终端来不及解析的数据上限
const STUCK_MS = 15000; // 积压一直不减少 (网络已断但还没检测到)，断开这个浏览器，它会自动重连并拿到最新画面
// 每个会话保留最近这么多原始输出：浏览器断线重连时只补发断开期间的输出，不用重发整个画面快照
const REPLAY_MAX = 1024 * 1024;
const REPLAY_SMALL = 64 * 1024; // 补发量小于此值直接补发，不再序列化快照比较大小

fs.mkdirSync(DATA_DIR, { recursive: true });

// SECRET 用于签名登录 Cookie 以及加密保存的主机密码；未指定时自动生成并持久化
function loadSecret() {
  if (process.env.SECRET) return process.env.SECRET;
  const f = path.join(DATA_DIR, '.secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}
const SECRET = loadSecret();
const ENC_KEY = crypto.createHash('sha256').update('ssh-web-enc:' + SECRET).digest();

// ---------------------------------------------------------------- 工具函数
function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

function decrypt(b64) {
  if (!b64) return '';
  try {
    const buf = Buffer.from(b64, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}

// 退出登录后作废的凭证 id -> 过期时间 (保存到文件，服务重启后仍然有效)
const REVOKED_FILE = path.join(DATA_DIR, 'revoked.json');
const revoked = new Map((() => { try { return Object.entries(JSON.parse(fs.readFileSync(REVOKED_FILE, 'utf8'))); } catch { return []; } })());
function revoke(p) {
  if (!p || !p.jti) return;
  const now = Date.now();
  for (const [k, exp] of revoked) if (exp < now) revoked.delete(k);
  revoked.set(p.jti, p.exp);
  const tmp = REVOKED_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(revoked)), { mode: 0o600 });
  fs.renameSync(tmp, REVOKED_FILE);
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (!safeEqual(mac, expect)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    // 必须带 jti (v1.36.0 之前发的凭证没有，没法单独作废，更新后需要重新登录一次)
    return p.exp > Date.now() && typeof p.jti === 'string' && !revoked.has(p.jti) ? p : null;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((kv) => {
    const i = kv.indexOf('=');
    if (i <= 0) return;
    const v = kv.slice(i + 1).trim();
    try {
      out[kv.slice(0, i).trim()] = decodeURIComponent(v);
    } catch {
      out[kv.slice(0, i).trim()] = v;
    }
  });
  return out;
}

const COOKIE_NAME = 'sshweb_session';
const authEnabled = !!AUTH_PASSWORD;
// docker-compose.yml 里的占位密码或过短的密码，页面上给出警告
const WEAK_PASSWORD = authEnabled && (AUTH_PASSWORD === '请修改为强密码' || AUTH_PASSWORD.length < 8);

function isAuthed(req) {
  if (!authEnabled) return true;
  return !!verify(parseCookies(req.headers.cookie)[COOKIE_NAME]);
}

// * 只匹配一段 (不含 .)，如 192.168.1.* 不会匹配 192.168.1.5.evil.com
const ALLOWED_RES = ALLOWED_HOSTS.map((pattern) => new RegExp(
  '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]*') + '$', 'i'));

function hostAllowed(host) {
  if (!ALLOWED_RES.length) return true;
  return ALLOWED_RES.some((re) => re.test(host));
}

// 从隧道地址中取出主机名，用于 ALLOWED_HOSTS 校验
function cfHostname(h) {
  try {
    return new URL(/^wss?:\/\//i.test(h) ? h : 'wss://' + h).hostname;
  } catch {
    return '';
  }
}

// 接受 "ssh.example.com" / "https://ssh.example.com/" / "wss://..." 等写法
function normalizeCfHost(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (/^wss?:\/\//i.test(s)) return s;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(s) ? s : 'https://' + s);
    return u.host + (u.pathname !== '/' ? u.pathname : '');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- 主机存储
const HOSTS_FILE = path.join(DATA_DIR, 'hosts.json');

function readHosts() {
  try {
    return JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeHosts(list) {
  const tmp = HOSTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, HOSTS_FILE);
}

// 返回给前端时不包含任何密文
function publicHost(h) {
  return {
    id: h.id,
    name: h.name,
    host: h.host,
    port: h.port,
    username: h.username,
    authType: h.authType,
    connType: h.connType || 'direct',
    cfClientId: h.cfClientId || '',
    hasCfSecret: !!h.cfClientSecret,
    group: h.group || '',
    order: typeof h.order === 'number' ? h.order : null, // 侧边栏自定义顺序 (未排序过为 null，按名称排)
    hasSecret: !!(h.password || h.privateKey),
  };
}

// ---------------------------------------------------------------- 已信任主机指纹 (known_hosts)
const KNOWN_FILE = path.join(DATA_DIR, 'known_hosts.json');

function readKnown() {
  try {
    return JSON.parse(fs.readFileSync(KNOWN_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeKnown(obj) {
  const tmp = KNOWN_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, KNOWN_FILE);
}

// 原始公钥: uint32 长度 + 算法名 + ...
function keyType(key) {
  try {
    return key.subarray(4, 4 + key.readUInt32BE(0)).toString('ascii');
  } catch {
    return 'unknown';
  }
}

const str = (v) => (typeof v === 'string' ? v : '');

function fingerprint(key) {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

// ---------------------------------------------------------------- 历史命令
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const HISTORY_MAX = parseInt(process.env.HISTORY_MAX || '1000', 10);

function readHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeHistory(list) {
  const tmp = HISTORY_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 });
  fs.renameSync(tmp, HISTORY_FILE);
}

// ---------------------------------------------------------------- 收藏命令
const FAV_FILE = path.join(DATA_DIR, 'favorites.json');

function readFavs() {
  try {
    return JSON.parse(fs.readFileSync(FAV_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeFavs(list) {
  const tmp = FAV_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FAV_FILE);
}

// ---------------------------------------------------------------- 登录限流
const loginFails = new Map(); // ip -> { count, until }
function loginBlocked(ip) {
  const r = loginFails.get(ip);
  return r && r.until > Date.now();
}
function loginFailed(ip) {
  const r = loginFails.get(ip) || { count: 0, until: 0 };
  r.count += 1;
  if (r.count >= 5) {
    r.until = Date.now() + 5 * 60 * 1000;
    r.count = 0;
  }
  loginFails.set(ip, r);
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, r] of loginFails) if (r.until < now) loginFails.delete(ip);
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------- HTTP
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY);
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
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm'), staticOpts));
app.use('/vendor/addon-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit'), staticOpts));
app.use('/vendor/addon-web-links', express.static(path.join(__dirname, 'node_modules/@xterm/addon-web-links'), staticOpts));
app.use('/vendor/addon-webgl', express.static(path.join(__dirname, 'node_modules/@xterm/addon-webgl'), staticOpts));
// 首页不缓存，并给前端资源加版本号，升级后浏览器一定会加载新的 app.js / style.css
const VERSION = require('./package.json').version;
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8').replace(/\{\{VERSION\}\}/g, VERSION);
const sendIndex = (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(INDEX_HTML);
};
app.get(['/', '/index.html'], sendIndex);
// 前端代码按功能拆在 public/app/*.js (文件名带编号，按顺序)，这里拼成一个 app.js：
// 各部分在同一个函数作用域里共用变量，所以只拆文件、不拆作用域，浏览器拿到的和拆之前完全一样
const APP_DIR = path.join(__dirname, 'public', 'app');
const APP_JS = "'use strict';\n\n(() => {\n"
  + fs.readdirSync(APP_DIR).filter((f) => f.endsWith('.js')).sort().map((f) => fs.readFileSync(path.join(APP_DIR, f), 'utf8')).join('')
  + '})();\n';
app.get('/app.js', (req, res) => {
  if (req.query.v !== undefined) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.type('js').send(APP_JS);
});
// Service Worker 必须每次检查更新
app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});
app.use(express.static(path.join(__dirname, 'public'), { ...staticOpts, index: false }));

app.get('/api/me', (req, res) => {
  res.json({ authEnabled, authed: isAuthed(req), user: authEnabled ? AUTH_USER : null, version: VERSION, weakPassword: WEAK_PASSWORD, scrollback: SCROLLBACK });
});

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (!authEnabled) return res.json({ ok: true });
  if (loginBlocked(ip)) return res.status(429).json({ error: '失败次数过多，请 5 分钟后再试' });
  const { username, password } = req.body || {};
  if (safeEqual(username || '', AUTH_USER) && safeEqual(password || '', AUTH_PASSWORD)) {
    loginFails.delete(ip);
    const token = sign({ u: AUTH_USER, exp: Date.now() + SESSION_HOURS * 3600 * 1000, jti: crypto.randomBytes(12).toString('base64url') });
    res.setHeader('Set-Cookie',
      `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_HOURS * 3600)}` +
      (COOKIE_SECURE || req.secure ? '; Secure' : '')); // 通过 HTTPS (如 Cloudflare 隧道) 访问时自动加 Secure
    return res.json({ ok: true });
  }
  loginFailed(ip);
  res.status(401).json({ error: '用户名或密码错误' });
});

app.post('/api/logout', (req, res) => {
  const p = verify(parseCookies(req.headers.cookie)[COOKIE_NAME]);
  try { revoke(p); } catch (e) { console.error('退出登录：保存作废凭证失败', e.message); } // 写不了文件也照样清 Cookie
  // 用这个凭证打开的 WebSocket 马上断开
  if (p) for (const ws of wss.clients) if (ws.jti === p.jti) ws.close(4001, 'logged out');
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  res.json({ ok: true });
});

// 以下接口需要登录
app.use('/api', (req, res, next) => {
  if (!isAuthed(req)) return res.status(401).json({ error: '未登录' });
  next();
});

app.get('/api/hosts', (req, res) => {
  res.json(readHosts().map(publicHost));
});

app.post('/api/hosts', (req, res) => {
  const b = req.body || {};
  if (!b.host || !b.username) return res.status(400).json({ error: '主机和用户名不能为空' });
  const list = readHosts();
  let h = b.id ? list.find((x) => x.id === b.id) : null;
  if (!h) {
    h = { id: crypto.randomUUID() };
    list.push(h);
  }
  h.name = String(b.name || `${b.username}@${b.host}`).slice(0, 100);
  h.host = String(b.host).trim();
  h.port = parseInt(b.port, 10) || 22;
  h.username = String(b.username).trim();
  h.authType = b.authType === 'key' ? 'key' : 'password';
  h.group = String(b.group || '').slice(0, 50);
  h.connType = b.connType === 'cloudflare' ? 'cloudflare' : 'direct';
  h.cfClientId = h.connType === 'cloudflare' ? String(b.cfClientId || '').trim() : '';
  if (h.connType !== 'cloudflare') h.cfClientSecret = '';
  // 只有传了新值才覆盖密文；传 clearSecret 则清空
  if (b.clearSecret) {
    h.password = h.privateKey = h.passphrase = '';
  }
  if (b.password) h.password = encrypt(b.password);
  if (b.privateKey) h.privateKey = encrypt(b.privateKey);
  if (b.passphrase) h.passphrase = encrypt(b.passphrase);
  if (b.cfClientSecret && h.connType === 'cloudflare') h.cfClientSecret = encrypt(b.cfClientSecret);
  writeHosts(list);
  res.json(publicHost(h));
});

// 侧边栏拖动排序: ids 为新的完整顺序
app.put('/api/hosts/order', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null;
  if (!ids) return res.status(400).json({ error: '顺序无效' });
  const list = readHosts();
  for (const h of list) {
    const i = ids.indexOf(h.id);
    if (i >= 0) h.order = i;
  }
  writeHosts(list);
  res.json({ ok: true });
});

app.delete('/api/hosts/:id', (req, res) => {
  writeHosts(readHosts().filter((h) => h.id !== req.params.id));
  res.json({ ok: true });
});

app.get('/api/known-hosts', (req, res) => {
  const known = readKnown();
  res.json(Object.entries(known).map(([key, v]) => ({ key, ...v })));
});

app.delete('/api/known-hosts', (req, res) => {
  const known = readKnown();
  delete known[String(req.query.key)];
  writeKnown(known);
  res.json({ ok: true });
});

// 历史命令: 最新的在前；同一主机的相同命令只保留一条并累加次数
app.get('/api/history', (req, res) => {
  res.json(readHistory());
});

app.post('/api/history', (req, res) => {
  const cmd = str(req.body?.cmd).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 2000);
  const host = str(req.body?.host).slice(0, 300);
  if (!cmd) return res.status(400).json({ error: '命令为空' });
  const list = readHistory();
  const i = list.findIndex((h) => h.host === host && h.cmd === cmd);
  const item = i >= 0 ? list.splice(i, 1)[0] : { id: crypto.randomUUID(), cmd, host, count: 0 };
  item.count += 1;
  item.time = Date.now();
  list.unshift(item);
  writeHistory(list.slice(0, HISTORY_MAX));
  res.json(item);
});

app.delete('/api/history/:id', (req, res) => {
  writeHistory(readHistory().filter((h) => h.id !== req.params.id));
  res.json({ ok: true });
});

// 清空: 带 host 参数只清空该主机的记录
app.delete('/api/history', (req, res) => {
  const host = req.query.host;
  writeHistory(typeof host === 'string' ? readHistory().filter((h) => h.host !== host) : []);
  res.json({ ok: true });
});

// 界面设置 (手机按键栏等)，保存在服务端，多台设备共享
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const readSettings = () => { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; } };

app.get('/api/settings', (req, res) => {
  res.json(readSettings());
});

// 手机按键栏: keys 为按键 id 顺序，custom 为自定义按键 { id: { label, seq } }；传 null 恢复默认
app.put('/api/settings/keybar', (req, res) => {
  const st = readSettings();
  const b = req.body || {};
  if (b.reset) {
    delete st.keybar;
  } else {
    const keys = Array.isArray(b.keys) ? b.keys.filter((k) => typeof k === 'string').map((k) => k.slice(0, 40)).slice(0, 80) : null;
    if (!keys) return res.status(400).json({ error: '按键列表无效' });
    const custom = {};
    for (const [id, c] of Object.entries(b.custom || {})) {
      if (!/^c:[\w-]{1,40}$/.test(id) || !c || typeof c.label !== 'string' || typeof c.seq !== 'string') continue;
      custom[id] = { label: c.label.slice(0, 12), seq: c.seq.slice(0, 500) };
    }
    st.keybar = { keys, custom };
  }
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SETTINGS_FILE);
  res.json(st);
});

// 完成通知 (Web Push)
const push = createPush(app, { dataDir: DATA_DIR, subject: process.env.PUSH_SUBJECT || 'mailto:ssh-web@example.com' });

// 收藏命令: host 为空表示所有主机通用；按添加顺序排列
app.get('/api/favorites', (req, res) => {
  res.json(readFavs());
});

app.post('/api/favorites', (req, res) => {
  const cmd = str(req.body?.cmd).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 2000);
  const host = str(req.body?.host).slice(0, 300);
  if (!cmd) return res.status(400).json({ error: '命令为空' });
  const list = readFavs();
  let item = list.find((f) => f.cmd === cmd && f.host === host);
  if (!item) {
    item = { id: crypto.randomUUID(), cmd, host, created: Date.now() };
    list.push(item);
    writeFavs(list.slice(-500));
  }
  res.json(item);
});

// 拖动排序: ids 为新的完整顺序；没有列出的收藏保持原来的相对顺序排在后面
app.put('/api/favorites/order', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null;
  if (!ids) return res.status(400).json({ error: '顺序无效' });
  const list = readFavs();
  const pos = (f) => { const i = ids.indexOf(f.id); return i < 0 ? ids.length : i; };
  writeFavs(list.map((f, i) => [f, i]).sort((a, b) => pos(a[0]) - pos(b[0]) || a[1] - b[1]).map(([f]) => f));
  res.json({ ok: true });
});

// 修改适用范围 (所有主机 / 仅某台主机)
app.put('/api/favorites/:id', (req, res) => {
  const list = readFavs();
  const item = list.find((f) => f.id === req.params.id);
  if (!item) return res.status(404).json({ error: '收藏不存在' });
  if (typeof req.body?.host === 'string') item.host = req.body.host.slice(0, 300);
  writeFavs(list);
  res.json(item);
});

app.delete('/api/favorites/:id', (req, res) => {
  writeFavs(readFavs().filter((f) => f.id !== req.params.id));
  res.json({ ok: true });
});

// 后台会话 id -> Session；SFTP / 监控复用已连接会话的 SSH 连接
const sessions = new Map();
// 各页面的事件连接：新建会话、标签顺序变化时通知所有打开的页面 (手机电脑同时开着时实时同步标签)
const eventSockets = new Set();
function broadcastEvent(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of eventSockets) if (ws.readyState === ws.OPEN) ws.send(msg);
}
const liveSession = (sid) => {
  const s = sessions.get(sid);
  return s && s.status === 'connected' && s.ssh ? s : null;
};
registerSftp(app, liveSession);
registerMonitor(app, liveSession);

app.get('/api/sessions', (req, res) => {
  res.json([...sessions.values()].sort((a, b) => a.order - b.order).map((s) => s.info()));
});

// 保存标签顺序
app.put('/api/sessions/order', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  ids.forEach((id, i) => { const s = sessions.get(String(id)); if (s) s.order = i; });
  broadcastEvent({ type: 'order', ids: [...sessions.values()].sort((a, b) => a.order - b.order).map((x) => x.id), pageId: str(req.body?.pageId) });
  res.json({ ok: true });
});

// 为 tmux 开启鼠标 (滑动 / 滚轮查看历史)：用单独的 exec 通道执行，不影响终端画面
app.post('/api/sessions/:id/tmux-mouse', (req, res) => {
  const s = liveSession(req.params.id);
  if (!s) return res.status(404).json({ error: '会话未连接' });
  const cmd = 'command -v tmux >/dev/null 2>&1 || { echo NO_TMUX; exit 0; }; '
    + 'tmux list-sessions >/dev/null 2>&1 || { echo NO_SERVER; exit 0; }; '
    + 'tmux set -g mouse on && echo OK';
  s.ssh.exec(cmd, (err, stream) => {
    if (err) return res.status(500).json({ error: err.message });
    let out = '';
    const timer = setTimeout(() => stream.close(), 8000);
    stream.on('data', (d) => { out += d; });
    stream.stderr.on('data', (d) => { out += d; });
    stream.on('close', () => {
      clearTimeout(timer);
      if (res.headersSent) return;
      if (/\bOK\b/.test(out)) return res.json({ ok: true });
      if (out.includes('NO_TMUX')) return res.status(400).json({ error: '目标主机上没有安装 tmux' });
      if (out.includes('NO_SERVER')) return res.status(400).json({ error: '没有检测到正在运行的 tmux' });
      res.status(500).json({ error: out.trim().slice(0, 200) || '执行失败' });
    });
  });
});

app.delete('/api/sessions/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (s) s.terminate();
  res.json({ ok: true });
});

app.get('/healthz', (req, res) => res.send('ok'));

// ---------------------------------------------------------------- WebSocket <-> SSH
const server = http.createServer(app);
// Node 默认 5 分钟收不完请求就返回 408，大文件 / 慢网络上传会中途失败；这里不限制 (连接空闲仍由 keep-alive 管理)
server.requestTimeout = 0;
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

server.on('upgrade', (req, socket, head) => {
  const reject = (code, text) => {
    socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
  };
  socket.on('error', () => {});
  try {
    if (!req.url.startsWith('/ws') || new URL(req.url, 'http://x').pathname !== '/ws') return reject(404, 'Not Found');
    if (!isAuthed(req)) return reject(401, 'Unauthorized');
    if (!sameOrigin(req)) return reject(403, 'Forbidden');
    const jti = authEnabled ? verify(parseCookies(req.headers.cookie)[COOKIE_NAME])?.jti : null;
    wss.handleUpgrade(req, socket, head, (ws) => { ws.jti = jti; wss.emit('connection', ws, req); });
  } catch {
    reject(400, 'Bad Request');
  }
});

// ---------------------------------------------------------------- 后台会话
// SSH 连接由服务端持有，浏览器只是「挂载」上来查看和操作：
// 关闭浏览器 / 断网后会话继续在后台运行；重新打开时用无界面终端 (@xterm/headless) 的序列化结果还原画面。
class Session {
  constructor(cfg, meta) {
    this.id = crypto.randomUUID();
    this.cfg = cfg; // 含凭据，只保存在内存中，用于重新连接
    this.title = String(meta.title || `${cfg.username}@${cfg.host}`).slice(0, 100);
    this.n = Math.min(Math.max(parseInt(meta.n, 10) || 1, 1), 999); // 标签序号
    this.histHost = String(meta.histHost || '').slice(0, 300);
    this.hostId = meta.hostId || null;
    this.clientIp = meta.clientIp;
    this.cols = clampSize(meta.cols, 80);
    this.rows = clampSize(meta.rows, 24);
    this.created = Date.now();
    this.detachedAt = Date.now();
    this.order = Date.now();
    this.status = 'closed';
    this.clients = new Set();
    this.term = new HeadlessTerminal({ cols: this.cols, rows: this.rows, scrollback: SCROLLBACK, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
    this.ssh = this.stream = this.tunnel = null;
    this.pending = null;
    this.timer = null;
    this.sftpPromise = null;
    this.monPrev = null;
    this.attempt = 0;
    this.lastAlert = 0;
    this.flushTimer = null;
    this.flowTimer = null; // 暂停读取 SSH 期间轮询积压
    this.termPending = 0;
    this.outBytes = 0; // 累计输出字节数，浏览器用它告诉服务端自己收到了哪里
    this.replay = []; // 最近的输出块
    this.replayLen = 0;
    // 主机状态 (运行中 / 完成 / 待选择 / 报错 / 空闲)，见 lib/status.js
    this.tracker = new StatusTracker();
    this.state = { label: '空闲', cls: 'idle' };
    this.stateTimer = null;
    this.statePushAt = 0;
    // 提示音 / 通知序列 → 完成通知 (Claude Code、printf '\a' 等)
    this.term.onBell(() => this.alert('终端提示音'));
    this.term.parser.registerOscHandler(9, (d) => {
      if (!/^\d+;/.test(d)) this.alert(d); // OSC 9;4;… 是进度条，不是通知
      return true;
    });
    this.term.parser.registerOscHandler(777, (d) => {
      const [kind, title, ...body] = d.split(';');
      if (kind === 'notify') this.alert(body.join(';') || title, body.length ? title : '');
      return true;
    });
  }

  // 有设备的网页在前台 (没最小化、浏览器是当前窗口) 时不推送；同一会话 10 秒内最多推送一次；
  // 2 分钟内已经按主机状态推送过 (完成 / 待选择 / 报错) 就不再重复推送提示音
  alert(message, title) {
    this.broadcast({ type: 'bell' });
    const now = Date.now();
    this.tracker.onBell(now);
    this.scheduleState();
    // 刚按状态推送过、而且之后还没人操作过：提示音多半是同一件事，不重复推送
    if (now - this.lastAlert < 10000 || (now - this.statePushAt < 120000 && this.tracker.dataAt < this.statePushAt)) return;
    if (this.someoneFront()) return;
    this.lastAlert = now;
    const name = `${this.title}-${this.n}`;
    push.send({
      title: title ? `${name} · ${title}` : name,
      body: String(message || '终端提示音').slice(0, 200),
      tag: this.id,
      sessionId: this.id,
    }).catch(() => {});
  }

  // 输出 / 输入之后稍等一下再判断 (无界面终端解析是异步的)，另外每秒整体判断一次 (见下面的定时器)
  scheduleState() {
    if (!this.stateTimer) this.stateTimer = setTimeout(() => { this.stateTimer = null; this.updateState(); }, 300);
  }

  updateState() {
    if (this.status !== 'connected') return;
    const st = this.tracker.evaluate(this.term, Date.now());
    if (st.label === this.state.label) return;
    const prev = this.state;
    this.state = st;
    this.broadcast({ type: 'state', label: st.label, cls: st.cls });
    // 推送：刚进入待选择 / 报错；或者 Claude Code 从运行中变成完成 (why 只有这几种情况才有)
    if (st.why && (st.cls === 'bad' || prev.cls === 'run')) this.notifyState(st);
  }

  // 有设备的网页正在前台 (看得到右上角的主机状态)：不用推送；老版本网页没有 front，按正在看这个标签算
  someoneFront() {
    return [...this.clients].some((ws) => (ws.front ?? ws.watching));
  }

  notifyState(st) {
    const now = Date.now();
    if (this.someoneFront()) return;
    if (now - this.lastAlert < 10000) return;
    this.lastAlert = this.statePushAt = now;
    push.send({ title: `${this.title}-${this.n} · ${st.label}`, body: st.why, tag: this.id, sessionId: this.id }).catch(() => {});
  }

  info() {
    const c = this.cfg;
    return {
      id: this.id, title: this.title, n: this.n, histHost: this.histHost, status: this.status,
      connType: c.connType, created: this.created, order: this.order, clients: this.clients.size,
      // 服务器重启后用于重新创建会话 (不含凭据)
      params: this.hostId ? { hostId: this.hostId }
        : { host: c.rawHost, port: c.port, username: c.username, connType: c.connType, cfClientId: c.cfClientId },
    };
  }

  // 先发出排队中的终端输出，保证控制消息和输出的先后顺序不变
  sendTo(ws, obj) {
    this.flushWs(ws);
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  broadcast(obj) {
    for (const ws of this.clients) this.sendTo(ws, obj);
  }

  // 终端输出：写入无界面终端 (用于还原) 并转发给所有挂载的浏览器
  output(buf) {
    const len = buf.length;
    this.outBytes += len;
    this.replay.push(buf);
    this.replayLen += len;
    while (this.replayLen - this.replay[0].length >= REPLAY_MAX) this.replayLen -= this.replay.shift().length;
    this.termPending += len;
    this.term.write(buf, () => { this.termPending -= len; });
    // 连接过程中的提示、远端欢迎信息、tmux 首次重画不算「运行中」
    if (this.status === 'connected' && Date.now() - this.connectedAt > 1500) {
      this.tracker.onOutput(Date.now());
      this.scheduleState();
    }
    for (const ws of this.clients) {
      if (ws.syncBuf) ws.syncBuf.push(buf);
      else (ws.outQ ||= []).push(buf);
    }
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), OUTPUT_FLUSH_MS);
    if (!this.flowTimer && this.overHigh()) this.pause();
  }

  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const ws of this.clients) this.flushWs(ws);
  }

  flushWs(ws) {
    const q = ws.outQ;
    if (!q || !q.length) return;
    ws.outQ = null;
    if (ws.readyState === ws.OPEN) ws.send(q.length === 1 ? q[0] : Buffer.concat(q), { binary: true });
  }

  overHigh() {
    if (this.termPending > TERM_HIGH) return true;
    for (const ws of this.clients) if (ws.bufferedAmount > WS_HIGH) return true;
    return false;
  }

  // 暂停读取 SSH (远端程序会被阻塞，和真实终端的流控一样)，积压消化后恢复
  pause() {
    if (!this.stream) return;
    this.stream.pause();
    this.stream.stderr.pause();
    const now = Date.now();
    this.flowTimer = setInterval(() => {
      const t = Date.now();
      let low = this.termPending < TERM_HIGH / 4;
      for (const ws of this.clients) {
        const b = ws.bufferedAmount;
        if (b <= WS_LOW) continue;
        if (ws.lastBuf === undefined || b < ws.lastBuf) ws.lastProgress = t;
        ws.lastBuf = b;
        if (t - (ws.lastProgress || now) > STUCK_MS) {
          ws.terminate(); // close 事件里会 detach
          continue;
        }
        low = false;
      }
      if (low) this.resume();
    }, 50);
  }

  resume() {
    clearInterval(this.flowTimer);
    this.flowTimer = null;
    for (const ws of this.clients) ws.lastBuf = ws.lastProgress = undefined;
    if (this.stream) {
      this.stream.resume();
      this.stream.stderr.resume();
    }
  }

  line(text) {
    this.output(Buffer.from(text + '\r\n'));
  }

  // 从第 from 字节到当前的输出；已经不在保留范围内返回 null
  since(from) {
    if (!Number.isSafeInteger(from) || from > this.outBytes || from < this.outBytes - this.replayLen) return null;
    let skip = from - (this.outBytes - this.replayLen);
    const parts = [];
    for (const b of this.replay) {
      if (skip >= b.length) { skip -= b.length; continue; }
      parts.push(skip ? b.subarray(skip) : b);
      skip = 0;
    }
    return Buffer.concat(parts);
  }

  // from: 浏览器已收到的字节数 (断线重连时)，能补发就只补发缺的部分，否则发整个画面快照
  attach(ws, from) {
    this.clients.add(ws);
    ws.session = this;
    // 先缓存挂载期间的新输出，等快照发出后再补发，保证不丢不重
    ws.syncBuf = [];
    const offset = this.outBytes;
    const delta = from === undefined ? null : this.since(from);
    this.sendTo(ws, { type: 'attached', session: this.info() });
    this.term.write('', () => {
      const snap = delta && delta.length <= REPLAY_SMALL ? null : this.serializer.serialize() + this.extraModes();
      if (delta && (snap === null || delta.length < Buffer.byteLength(snap))) {
        this.sendTo(ws, { type: 'resume', bytes: delta.length });
        if (delta.length && ws.readyState === ws.OPEN) ws.send(delta, { binary: true });
      } else {
        this.sendTo(ws, { type: 'snapshot', data: snap, offset });
      }
      const buf = ws.syncBuf;
      ws.syncBuf = null;
      for (const b of buf) if (ws.readyState === ws.OPEN) ws.send(b, { binary: true });
      this.sendTo(ws, { type: 'status', status: this.status, sid: this.status === 'connected' ? this.id : null });
      if (this.sshRtt !== undefined) this.sendTo(ws, { type: 'lat', ssh: this.sshRtt });
      this.sendTo(ws, { type: 'state', label: this.state.label, cls: this.state.cls });
      if (this.pending) this.sendTo(ws, { type: this.pending.type, ...this.pending.payload });
    });
  }

  // SerializeAddon 不保存鼠标编码 (SGR 等) 和光标隐藏状态，这里补上：
  // 否则恢复后 tmux / Claude Code 的滚轮事件会用旧编码发送，程序收不到
  extraModes() {
    let out = '';
    try {
      const core = this.term._core;
      const enc = { SGR: '\x1b[?1006h', SGR_PIXELS: '\x1b[?1016h', URXVT: '\x1b[?1015h', UTF8: '\x1b[?1005h' };
      out += enc[core.coreMouseService.activeEncoding] || '';
      if (core.coreService.isCursorHidden) out += '\x1b[?25l';
    } catch {}
    return out;
  }

  detach(ws) {
    if (!this.clients.delete(ws)) return;
    if (!this.clients.size) this.detachedAt = Date.now();
    // 使用者关掉了页面：换成还开着的设备 (优先正在看的) 的尺寸
    if (this.owner === ws) {
      const rest = [...this.clients].reverse();
      this.owner = rest.find((c) => c.size && c.watching) || rest.find((c) => c.size) || null;
      if (this.owner) this.applySize(this.owner.size.cols, this.owner.size.rows);
    }
  }

  setStatus(status) {
    this.status = status;
    if (status === 'connected') { this.connectedAt = Date.now(); this.tracker = new StatusTracker(); }
    this.broadcast({ type: 'status', status, sid: status === 'connected' ? this.id : null });
  }

  // autoFrom：终端自动应答来自哪个浏览器 (不是用户打的字)。几台设备同时开着时每台都会回答同一个询问，
  // 0.5 秒内来自不同设备的相同应答只转发一次；自动应答不算输入，不影响主机状态
  write(data, autoFrom, fromWs) {
    if (!this.stream) return;
    // 有人在这台设备上打字：它就是使用者，按它的尺寸
    if (fromWs && !autoFrom && this.owner !== fromWs && fromWs.size) {
      this.owner = fromWs;
      this.applySize(fromWs.size.cols, fromWs.size.rows);
    }
    if (autoFrom) {
      const now = Date.now(), last = this.lastAuto;
      if (last && last.data === data && last.ws !== autoFrom && now - last.t < 500) return;
      this.lastAuto = { data, ws: autoFrom, t: now };
      this.stream.write(data);
      return;
    }
    this.stream.write(data);
    this.tracker.onInput(Date.now(), true); // 有人往这个标签发了内容：回显不算运行中，「完成」算已经看到了
    this.scheduleState();
  }

  // 终端尺寸听「正在用的设备」的：ws 是发来尺寸的浏览器，claim = 用户正在这台设备上 (页面在前台且有焦点)。
  // 别的设备正在用时，后台设备自动发来的尺寸 (断线重连、恢复画面等) 只记下来不生效，免得把正在用的设备的排版改掉；
  // 在一台设备上打字 (write) 也会让它成为使用者
  resize(cols, rows, ws, claim = true) {
    cols = clampSize(cols, 0);
    rows = clampSize(rows, 0);
    if (!cols || !rows) return;
    if (ws) {
      ws.size = { cols, rows };
      if (!claim && this.owner && this.owner !== ws && this.clients.has(this.owner)) return;
      this.owner = ws;
    }
    this.applySize(cols, rows);
  }

  applySize(cols, rows) {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.tracker.onInput(Date.now(), false); // 调整大小引起的重绘不算运行中
    this.term.resize(cols, rows);
    if (this.stream) this.stream.setWindow(rows, cols, 0, 0);
  }

  // 握手超时计时；等待用户输入时换成更长的计时
  armTimeout(ms, message) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(message), ms);
  }

  // 向浏览器提问 (验证码 / 指纹确认)；没有浏览器挂载时等待，挂载后补发
  ask(type, payload) {
    return new Promise((resolve) => {
      this.armTimeout(USER_INPUT_TIMEOUT, '等待输入超时');
      this.pending = { type, payload, resolve };
      this.broadcast({ type, ...payload });
    }).finally(() => { if (this.status === 'connecting') this.armTimeout(SSH_READY_TIMEOUT, '连接超时'); });
  }

  answer(msg) {
    if (this.pending && this.pending.type + '-response' === msg.type) {
      const { resolve } = this.pending;
      this.pending = null;
      this.broadcast({ type: 'prompt-done' }); // 其他浏览器关闭弹窗
      resolve(msg);
    }
  }

  // 测到目标主机的 SSH 往返延迟：和 ssh2 自己的 keepalive 一样发一个 keepalive@openssh.com 全局请求，
  // 等对方回复 (成功 / 失败都算)；回复按发出顺序对应 _callbacks，所以排在队尾即可
  // 由浏览器测网页延迟时顺带触发 (平时 10 秒一次，打开延迟详情时 2 秒一次)，最快 1.5 秒一次
  measureLatency() {
    const ssh = this.ssh;
    if (!ssh || this.status !== 'connected' || !this.clients.size || this.latPending) return;
    if (Date.now() - (this.latAt || 0) < 1500) return;
    this.latAt = Date.now();
    if (!ssh._protocol || !Array.isArray(ssh._callbacks)) return;
    this.latPending = true;
    const t0 = performance.now();
    try {
      ssh._callbacks.push(() => {
        if (this.ssh !== ssh) return;
        this.latPending = false;
        this.sshRtt = Math.round(performance.now() - t0);
        this.broadcast({ type: 'lat', ssh: this.sshRtt });
      });
      ssh._protocol.ping();
    } catch {
      this.latPending = false;
    }
  }

  // 本地快速滚动：在目标主机上抓 tmux 当前 pane 的历史 (带颜色，折行合并)，浏览器在本地滚动查看，不用每滚一格等一个来回。
  // 当前 pane：优先用 LC_SSHWEB 标记找到这个会话里的 tmux 客户端，找不到再选终端大小一样、最近有操作的；没有 tmux 时 exit 3，
  // pane 里是全屏程序时 exit 4、已在复制模式时 exit 5 (浏览器照旧把滚轮发给程序)
  captureTmux(ws, lines) {
    const reply = (obj) => this.sendTo(ws, { type: 'tmux-history', ...obj });
    const ssh = this.ssh;
    if (!ssh || this.status !== 'connected') return reply({ ok: false, reason: 'offline' });
    const n = Math.min(Math.max(parseInt(lines, 10) || 3000, 100), 10000);
    const script = [
      'PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"',
      'command -v tmux >/dev/null 2>&1 || exit 3',
      // 先找环境变量里带 LC_SSHWEB=<这个会话> 的 tmux 客户端 (就是这个标签里启动的那个；Linux 读 /proc/<pid>/environ)
      'p=',
      `for c in $(tmux list-clients -F '#{client_pid}:#{pane_id}' 2>/dev/null); do`,
      `  if tr '\\0' '\\n' < "/proc/\${c%%:*}/environ" 2>/dev/null | grep -qx 'LC_SSHWEB=${this.id}'; then p="\${c#*:}"; break; fi`,
      'done',
      // 找不到 (sshd 不接受 LC_* 环境变量、不是 Linux)：按终端大小一样、最近有操作的客户端猜
      `[ -n "$p" ] || p=$(tmux list-clients -F '#{client_width}x#{client_height} #{client_activity} #{pane_id}' 2>/dev/null | awk '{ print ($1 == "${this.cols}x${this.rows}") ? 1 : 0, $2, $3 }' | sort -k1,1nr -k2,2nr | head -n 1 | cut -d' ' -f3)`,
      '[ -n "$p" ] || exit 3',
      // 已在 tmux 复制模式 (exit 5)、pane 里是 vim / less 等全屏程序 (exit 4)：滚轮交给它们，不抓历史
      `m=$(tmux display -p -t "$p" '#{alternate_on}#{pane_in_mode}')`,
      '[ "${m#?}" = 1 ] && exit 5',
      '[ "$m" = 00 ] || exit 4',
      `exec tmux capture-pane -p -e -J -S -${n} -t "$p"`,
    ].join('\n');
    const MAX = 4 * 1024 * 1024;
    ssh.exec(`sh -c '${script.replace(/'/g, "'\\''")}'`, (err, ch) => {
      if (err) return reply({ ok: false, reason: err.message });
      const chunks = [];
      let len = 0;
      const timer = setTimeout(() => { try { ch.close(); } catch {} }, 3000); // 抓不到就尽快让浏览器回退
      ch.on('data', (d) => { len += d.length; if (len <= MAX) chunks.push(d); });
      ch.stderr.resume();
      ch.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 || !len || len > MAX) {
          return reply({ ok: false, reason: { 3: 'no-tmux', 4: 'busy', 5: 'in-mode' }[code] || 'failed' });
        }
        reply({ ok: true, data: Buffer.concat(chunks).toString('utf8') });
      });
    });
  }

  closeConn() {
    clearTimeout(this.timer);
    this.latPending = false;
    this.sshRtt = undefined;
    clearInterval(this.flowTimer);
    this.flowTimer = null;
    this.pending = null;
    try { this.stream && this.stream.close(); } catch {}
    try { this.ssh && this.ssh.end(); } catch {}
    try { this.tunnel && this.tunnel.terminate(); } catch {}
    this.stream = this.ssh = this.tunnel = null;
    this.sftpPromise = null;
    this.monPrev = null;
  }

  fail(message) {
    if (this.status === 'closed') return;
    this.closeConn();
    this.line(`\r\n\x1b[31m✖ ${message}\x1b[0m`);
    this.broadcast({ type: 'error', message });
    this.setStatus('closed');
  }

  ended() {
    if (this.status === 'closed') return;
    this.closeConn();
    this.line('\r\n\x1b[33m连接已断开\x1b[0m');
    this.setStatus('closed');
  }

  // 用户关闭标签：彻底结束
  terminate() {
    this.status = 'closed';
    this.closeConn();
    sessions.delete(this.id);
    this.broadcast({ type: 'terminated' });
    for (const ws of this.clients) ws.session = null;
    this.clients.clear();
    clearTimeout(this.flushTimer);
    this.replay = [];
    this.term.dispose();
  }

  connect() {
    if (this.status !== 'closed') return;
    const cfg = this.cfg;
    const attempt = ++this.attempt;
    const alive = () => attempt === this.attempt && this.status === 'connecting';
    this.status = 'connecting';
    this.setStatus('connecting');
    const knownKey = cfg.connType === 'cloudflare' ? `cf:${cfg.host}` : `${cfg.host}:${cfg.port}`;
    const target = cfg.connType === 'cloudflare' ? `${cfg.host} (Cloudflare 隧道)` : `${cfg.host}:${cfg.port}`;
    this.line(`\r\n\x1b[90m正在连接 ${this.title}-${this.n} (${cfg.username}@${target}) ...\x1b[0m`);

    const ssh = new Client();
    this.ssh = ssh;
    const connectOpts = {
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      readyTimeout: 0, // 由 armTimeout 控制，等待用户输入时不计时
      keepaliveInterval: SSH_KEEPALIVE,
      keepaliveCountMax: 4,
      tryKeyboard: true,
      hostVerifier: (key, verify) => {
        verifyHostKey(key).then(verify, () => verify(false));
      },
    };
    if (cfg.privateKey) {
      connectOpts.privateKey = cfg.privateKey;
      if (cfg.passphrase) connectOpts.passphrase = cfg.passphrase;
    }
    if (cfg.password) connectOpts.password = cfg.password;

    // 主机指纹校验 (类似 OpenSSH 的 known_hosts)
    const verifyHostKey = async (key) => {
      const fp = fingerprint(key);
      const type = keyType(key);
      this.line(`\x1b[90m主机指纹: ${type} ${fp}\x1b[0m`);
      if (HOSTKEY_POLICY === 'off') return true;

      const known = readKnown();
      const old = known[knownKey];
      if (old && old.fingerprint === fp) return true;

      const save = () => {
        const k = readKnown();
        k[knownKey] = { keyType: type, fingerprint: fp, addedAt: new Date().toISOString() };
        writeKnown(k);
      };
      if (!old && HOSTKEY_POLICY === 'accept-new') {
        save();
        return true;
      }
      const r = await this.ask('hostkey', {
        status: old ? 'changed' : 'new',
        host: target,
        keyType: type,
        fingerprint: fp,
        oldKeyType: old?.keyType,
        oldFingerprint: old?.fingerprint,
      });
      if (!alive()) return false;
      if (!r.accept) {
        this.fail(old ? '主机指纹不匹配，已拒绝连接' : '已取消：未信任主机指纹');
        return false;
      }
      save();
      return true;
    };

    // keyboard-interactive: 密码提示自动用已保存密码应答一次，其余 (TOTP 验证码等) 交给用户输入
    let passwordAutoUsed = false;
    ssh.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
      if (!prompts.length) return finish([]);
      const answers = prompts.map((pr) => {
        if (!passwordAutoUsed && cfg.password && !pr.echo && /pass(word|code)?|密码/i.test(pr.prompt)
            && !/verif|code|token|otp|验证/i.test(pr.prompt)) {
          return cfg.password;
        }
        return null;
      });
      if (answers.some((a) => a !== null)) passwordAutoUsed = true;
      const need = answers.map((a, i) => (a === null ? i : -1)).filter((i) => i >= 0);
      if (!need.length) return finish(answers);

      this.ask('prompt', {
        title: name || '',
        instructions: instructions || '',
        prompts: need.map((i) => ({ prompt: prompts[i].prompt, echo: !!prompts[i].echo })),
      }).then((r) => {
        if (!alive()) return;
        if (r.cancel || !Array.isArray(r.answers)) return this.fail('已取消认证');
        need.forEach((idx, k) => { answers[idx] = String(r.answers[k] ?? ''); });
        finish(answers);
      });
    });

    ssh.on('ready', () => {
      if (!alive()) return;
      clearTimeout(this.timer);
      console.log(`[${new Date().toISOString()}] ${this.clientIp} -> ${cfg.username}@${target} 已连接`);
      // LC_SSHWEB：给这个会话的 shell 做个标记，在里面启动的 tmux 客户端会继承，本地快速滚动靠它精确找到对应的 pane
      // (sshd 默认 AcceptEnv LANG LC_*；不接受时忽略，退回按终端大小猜)
      ssh.shell({ term: 'xterm-256color', cols: this.cols, rows: this.rows }, { env: { LC_SSHWEB: this.id } }, (err, stream) => {
        if (!alive()) return;
        if (err) return this.fail('打开 Shell 失败: ' + err.message);
        this.stream = stream;
        stream.on('data', (d) => this.output(d));
        stream.stderr.on('data', (d) => this.output(d));
        stream.on('close', () => { if (this.ssh === ssh) this.ended(); });
        this.setStatus('connected');
      });
    });

    ssh.on('error', (err) => {
      if (this.ssh !== ssh) return;
      const hint = err.level === 'client-authentication' ? '认证失败，请检查用户名/密码/密钥/验证码' : err.message;
      if (this.status === 'connected') {
        this.line(`\r\n\x1b[31m✖ ${hint}\x1b[0m`);
        this.ended();
      } else {
        this.fail(hint);
      }
    });
    ssh.on('close', () => { if (this.ssh === ssh) this.ended(); });

    this.armTimeout(SSH_READY_TIMEOUT, '连接超时');

    if (cfg.connType === 'cloudflare') {
      this.line(`\x1b[90m通过 Cloudflare 隧道连接 ${/^wss?:\/\//.test(cfg.host) ? cfg.host : 'wss://' + cfg.host} ...\x1b[0m`);
      this.openCloudflareTunnel(cfg)
        .then((sock) => {
          if (!alive()) return sock.destroy();
          connectOpts.sock = sock;
          ssh.connect(connectOpts);
        })
        .catch((e) => { if (alive()) this.fail(e.message); });
      return;
    }

    try {
      ssh.connect(connectOpts);
      ssh.setNoDelay(true); // 和 OpenSSH 一样关闭 Nagle，按键不等待合并，回显更快
    } catch (e) {
      this.fail(e.message);
    }
  }

  // 与 cloudflared access ssh 相同: 以 WebSocket 连接隧道主机名，SSH 原始字节走二进制帧
  openCloudflareTunnel(cfg) {
    return new Promise((resolve, reject) => {
      const headers = { 'User-Agent': 'cloudflared/ssh-web' };
      if (cfg.cfClientId && cfg.cfClientSecret) {
        headers['CF-Access-Client-Id'] = cfg.cfClientId;
        headers['CF-Access-Client-Secret'] = cfg.cfClientSecret;
      }
      const url = /^wss?:\/\//.test(cfg.host) ? cfg.host : `wss://${cfg.host}`;
      const t = new WebSocket(url, {
        headers,
        handshakeTimeout: SSH_READY_TIMEOUT,
        followRedirects: false,
        perMessageDeflate: false,
      });
      this.tunnel = t;
      let settled = false;
      t.on('unexpected-response', (req, res) => {
        settled = true;
        let msg = `Cloudflare 隧道握手失败: HTTP ${res.statusCode}`;
        if (res.statusCode === 302 || res.statusCode === 403 || res.statusCode === 401) {
          msg += '（该主机名受 Cloudflare Access 保护，请填写 Service Token 并在 Access 策略中放行 Service Auth）';
        } else if (res.statusCode === 502 || res.statusCode === 530) {
          msg += '（隧道离线或 NAS 上 cloudflared 未运行 / ingress 未指向 ssh://localhost:22）';
        }
        res.resume();
        reject(new Error(msg));
      });
      t.on('open', () => {
        settled = true;
        t._socket && t._socket.setNoDelay(true);
        const duplex = createWebSocketStream(t);
        duplex.on('error', () => {});
        resolve(duplex);
      });
      t.on('error', (e) => {
        if (!settled) {
          settled = true;
          reject(new Error('Cloudflare 隧道连接失败: ' + e.message));
        }
      });
    });
  }
}

function clampSize(v, def) {
  const n = parseInt(v, 10);
  return n > 0 ? Math.min(n, 1000) : def;
}

// 根据浏览器传来的参数生成连接配置；已保存的主机从服务端读取加密凭据
function buildConfig(msg) {
  let cfg = {
    host: String(msg.host || '').trim(),
    port: parseInt(msg.port, 10) || 22,
    username: String(msg.username || '').trim(),
    password: str(msg.password),
    privateKey: str(msg.privateKey),
    passphrase: str(msg.passphrase),
    connType: msg.connType === 'cloudflare' ? 'cloudflare' : 'direct',
    cfClientId: str(msg.cfClientId),
    cfClientSecret: str(msg.cfClientSecret),
  };
  if (msg.hostId) {
    const h = readHosts().find((x) => x.id === msg.hostId);
    if (!h) throw new Error('保存的主机不存在');
    cfg = {
      host: h.host,
      port: h.port,
      username: h.username,
      password: str(msg.password) || decrypt(h.password),
      privateKey: str(msg.privateKey) || decrypt(h.privateKey),
      passphrase: str(msg.passphrase) || decrypt(h.passphrase),
      connType: h.connType || 'direct',
      cfClientId: h.cfClientId || '',
      cfClientSecret: decrypt(h.cfClientSecret),
    };
  }
  if (!cfg.host || !cfg.username) throw new Error('主机和用户名不能为空');
  cfg.rawHost = cfg.host;
  if (cfg.connType === 'cloudflare') {
    cfg.host = normalizeCfHost(cfg.host);
    if (!cfg.host) throw new Error('Cloudflare 隧道主机名无效');
  }
  const checkHost = cfg.connType === 'cloudflare' ? cfHostname(cfg.host) : cfg.host;
  if (!checkHost || !hostAllowed(checkHost)) throw new Error(`不允许连接主机 ${checkHost || cfg.host}（ALLOWED_HOSTS 限制）`);
  return cfg;
}

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
        if (sess && typeof msg.data === 'string') sess.write(msg.data, msg.auto === true ? ws : null, ws);
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

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  console.log(`SSH-WEB v${VERSION} 已启动: http://${HOST}:${PORT}`);
  if (!authEnabled) {
    console.warn('⚠ 未设置 AUTH_PASSWORD，网页无需登录即可使用，请勿暴露到公网！');
  } else if (WEAK_PASSWORD) {
    console.warn('⚠ AUTH_PASSWORD 仍是默认占位密码或少于 8 位，请在 docker-compose.yml 里改成强密码！');
  }
});

// 服务停止 (如更新容器) 时只断开连接，不通知浏览器关闭标签；重新启动后浏览器会提示会话已不存在并可重新连接
// 意外错误只记录日志，不让进程退出 (否则所有后台会话都会断开)
process.on('unhandledRejection', (e) => console.error('[未处理的异步错误]', e));
process.on('uncaughtException', (e) => console.error('[未捕获的异常]', e));

const shutdown = () => {
  for (const s of sessions.values()) s.closeConn();
  wss.clients.forEach((ws) => ws.close());
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
