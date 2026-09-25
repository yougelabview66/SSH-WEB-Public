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

// ---------------------------------------------------------------- 配置
const PORT = parseInt(process.env.PORT || '8888', 10);
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
// 等待用户输入验证码 / 确认指纹的最长时间
const USER_INPUT_TIMEOUT = 5 * 60 * 1000;

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

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (!safeEqual(mac, expect)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
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
  next();
});

// 前端静态资源 (xterm 直接从 node_modules 提供，NAS 离线也能用)
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/vendor/addon-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));
app.use('/vendor/addon-web-links', express.static(path.join(__dirname, 'node_modules/@xterm/addon-web-links')));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/me', (req, res) => {
  res.json({ authEnabled, authed: isAuthed(req), user: authEnabled ? AUTH_USER : null });
});

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (!authEnabled) return res.json({ ok: true });
  if (loginBlocked(ip)) return res.status(429).json({ error: '失败次数过多，请 5 分钟后再试' });
  const { username, password } = req.body || {};
  if (safeEqual(username || '', AUTH_USER) && safeEqual(password || '', AUTH_PASSWORD)) {
    loginFails.delete(ip);
    const token = sign({ u: AUTH_USER, exp: Date.now() + SESSION_HOURS * 3600 * 1000 });
    res.setHeader('Set-Cookie',
      `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_HOURS * 3600)}` +
      (COOKIE_SECURE ? '; Secure' : ''));
    return res.json({ ok: true });
  }
  loginFailed(ip);
  res.status(401).json({ error: '用户名或密码错误' });
});

app.post('/api/logout', (req, res) => {
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

// 活动的 SSH 会话，sid -> { ssh, sftpPromise }，供 SFTP 接口复用连接
const sessions = new Map();
registerSftp(app, (sid) => sessions.get(sid));

app.get('/healthz', (req, res) => res.send('ok'));

// ---------------------------------------------------------------- WebSocket <-> SSH
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

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
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } catch {
    reject(400, 'Bad Request');
  }
});

wss.on('connection', (ws, req) => {
  // 仅用于日志
  const clientIp = req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const sid = crypto.randomUUID();
  let ssh = null;
  let stream = null;
  let tunnel = null;
  let started = false;
  let failed = false;
  let timer = null;
  let pending = null; // 正在等待浏览器回应的请求 { type, resolve }

  const sendCtl = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };
  const sendData = (buf) => {
    if (ws.readyState === ws.OPEN) ws.send(buf, { binary: true });
  };
  const cleanup = () => {
    clearTimeout(timer);
    pending = null;
    sessions.delete(sid);
    try { stream && stream.close(); } catch {}
    try { ssh && ssh.end(); } catch {}
    try { tunnel && tunnel.terminate(); } catch {}
    stream = null;
    ssh = null;
    tunnel = null;
  };

  // 握手超时计时；等待用户输入时换成更长的计时
  const armTimeout = (ms, message) => {
    clearTimeout(timer);
    timer = setTimeout(() => fail(message), ms);
  };

  // 向浏览器提问 (验证码 / 指纹确认)，返回 Promise
  const ask = (type, payload) => new Promise((resolve) => {
    armTimeout(USER_INPUT_TIMEOUT, '等待输入超时');
    pending = { type, resolve };
    sendCtl({ type, ...payload });
  }).finally(() => armTimeout(SSH_READY_TIMEOUT, '连接超时'));

  // WebSocket 心跳，防止 NAS 反代 / 路由器掐断空闲连接
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      if (stream) stream.write(raw);
      return;
    }
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'connect':
        if (started) return;
        started = true;
        startSsh(msg);
        break;
      case 'data':
        if (stream && typeof msg.data === 'string') stream.write(msg.data);
        break;
      case 'resize': {
        const cols = Math.min(Math.max(parseInt(msg.cols, 10) || 0, 0), 1000);
        const rows = Math.min(Math.max(parseInt(msg.rows, 10) || 0, 0), 1000);
        if (stream && cols && rows) stream.setWindow(rows, cols, 0, 0);
        break;
      }
      case 'prompt-response':
      case 'hostkey-response':
        if (pending && pending.type + '-response' === msg.type) {
          const { resolve } = pending;
          pending = null;
          resolve(msg);
        }
        break;
      case 'ping':
        sendCtl({ type: 'pong' });
        break;
    }
  });

  ws.on('close', cleanup);
  ws.on('error', cleanup);

  function startSsh(msg) {
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

    // 使用已保存的主机：从服务端读取加密的凭据，浏览器端拿不到
    if (msg.hostId) {
      const h = readHosts().find((x) => x.id === msg.hostId);
      if (!h) return fail('保存的主机不存在');
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

    if (!cfg.host || !cfg.username) return fail('主机和用户名不能为空');
    if (cfg.connType === 'cloudflare') {
      cfg.host = normalizeCfHost(cfg.host);
      if (!cfg.host) return fail('Cloudflare 隧道主机名无效');
    }
    const checkHost = cfg.connType === 'cloudflare' ? cfHostname(cfg.host) : cfg.host;
    if (!checkHost || !hostAllowed(checkHost)) return fail(`不允许连接主机 ${checkHost || cfg.host}（ALLOWED_HOSTS 限制）`);
    const knownKey = cfg.connType === 'cloudflare' ? `cf:${cfg.host}` : `${cfg.host}:${cfg.port}`;
    const target = cfg.connType === 'cloudflare' ? `${cfg.host} (Cloudflare 隧道)` : `${cfg.host}:${cfg.port}`;

    ssh = new Client();
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
    async function verifyHostKey(key) {
      const fp = fingerprint(key);
      const type = keyType(key);
      sendCtl({ type: 'fingerprint', value: `${type} ${fp}` });
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
      const r = await ask('hostkey', {
        status: old ? 'changed' : 'new',
        host: target,
        keyType: type,
        fingerprint: fp,
        oldKeyType: old?.keyType,
        oldFingerprint: old?.fingerprint,
      });
      if (!r.accept) {
        fail(old ? '主机指纹不匹配，已拒绝连接' : '已取消：未信任主机指纹');
        return false;
      }
      save();
      return true;
    }

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

      ask('prompt', {
        title: name || '',
        instructions: instructions || '',
        prompts: need.map((i) => ({ prompt: prompts[i].prompt, echo: !!prompts[i].echo })),
      }).then((r) => {
        if (r.cancel || !Array.isArray(r.answers)) return fail('已取消认证');
        need.forEach((idx, k) => { answers[idx] = String(r.answers[k] ?? ''); });
        finish(answers);
      });
    });

    ssh.on('ready', () => {
      clearTimeout(timer);
      console.log(`[${new Date().toISOString()}] ${clientIp} -> ${cfg.username}@${target} 已连接`);
      sessions.set(sid, { ssh, sftpPromise: null });
      sendCtl({ type: 'status', status: 'connected', sid });
      ssh.shell(
        {
          term: 'xterm-256color',
          cols: Math.min(parseInt(msg.cols, 10) || 80, 1000),
          rows: Math.min(parseInt(msg.rows, 10) || 24, 1000),
        },
        (err, s) => {
          if (err) return fail('打开 Shell 失败: ' + err.message);
          stream = s;
          s.on('data', sendData);
          s.stderr.on('data', sendData);
          s.on('close', () => {
            sendCtl({ type: 'status', status: 'closed' });
            cleanup();
            ws.close();
          });
        }
      );
    });

    ssh.on('error', (err) => {
      if (!ssh) return; // 已经因拒绝指纹等原因清理过
      const hint = err.level === 'client-authentication' ? '认证失败，请检查用户名/密码/密钥/验证码' : err.message;
      fail(hint);
    });
    ssh.on('end', () => sendCtl({ type: 'status', status: 'closed' }));

    armTimeout(SSH_READY_TIMEOUT, '连接超时');

    if (cfg.connType === 'cloudflare') {
      sendCtl({ type: 'info', message: `通过 Cloudflare 隧道连接 ${/^wss?:\/\//.test(cfg.host) ? cfg.host : 'wss://' + cfg.host} ...` });
      openCloudflareTunnel(cfg)
        .then((sock) => {
          if (!ssh) return sock.destroy();
          connectOpts.sock = sock;
          ssh.connect(connectOpts);
        })
        .catch((e) => fail(e.message));
      return;
    }

    try {
      ssh.connect(connectOpts);
    } catch (e) {
      fail(e.message);
    }
  }

  // 与 cloudflared access ssh 相同: 以 WebSocket 连接隧道主机名，SSH 原始字节走二进制帧
  function openCloudflareTunnel(cfg) {
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
      tunnel = t;
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
      t.on('close', () => {
        if (ssh) sendCtl({ type: 'status', status: 'closed' });
      });
    });
  }

  function fail(message) {
    if (failed) return;
    failed = true;
    sendCtl({ type: 'error', message });
    cleanup();
    setTimeout(() => ws.close(), 200);
  }
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SSH-WEB 已启动: http://0.0.0.0:${PORT}`);
  if (!authEnabled) {
    console.warn('⚠ 未设置 AUTH_PASSWORD，网页无需登录即可使用，请勿暴露到公网！');
  }
});

const shutdown = () => {
  wss.clients.forEach((ws) => ws.close());
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
