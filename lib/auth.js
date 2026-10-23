'use strict';
// 登录与加密：SECRET、保存的主机密码加解密、登录凭证 (Cookie) 签名 / 校验 / 作废、登录失败限流
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, AUTH_USER, AUTH_PASSWORD, SESSION_HOURS } = require('./config');
const SESSION_MS = SESSION_HOURS * 3600 * 1000;

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
  // 续期过的凭证 jti 不变：别处留着的同一个凭证最多还能续到现在 + 有效期，记到那时候
  revoked.set(p.jti, Math.max(p.exp, now + SESSION_MS));
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
// docker-compose.yml 里的占位密码：公开写在仓库里，谁都知道，不能用来登录 (server.js 启动时直接退出并提示改掉)
const PLACEHOLDER_PASSWORD = AUTH_PASSWORD === '请修改为强密码';
// 过短的密码：页面上给出警告
const WEAK_PASSWORD = authEnabled && (PLACEHOLDER_PASSWORD || AUTH_PASSWORD.length < 8);

// 请求里带的登录凭证 (校验通过才返回内容)
const tokenOf = (req) => verify(parseCookies(req.headers.cookie)[COOKIE_NAME]);

// 没设密码时只让本机直接访问：连接来自 127.0.0.1 / ::1，而且没经过代理 (带转发头的是反向代理、cloudflared 转来的)。
// 局域网、Docker 容器外面 (连接来自网桥地址)、公网都不行，免得没设密码就把能登录所有服务器的入口暴露出去。
// 地址栏 (Host 头) 也必须是 localhost / 127.0.0.1 / [::1]：别的网站把自己的域名解析到 127.0.0.1 (DNS 重绑定)，
// 浏览器发来的请求看着是本机直连，Host 却是它的域名，不认
const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip'];
const LOCAL_HOST_RE = /^(localhost|127(\.\d{1,3}){3}|\[::1\])(:\d{1,5})?$/i;
const localHostname = (h) => LOCAL_HOST_RE.test(String(h || ''));
function isLocal(req) {
  return /^(127\.|::1$|::ffff:127\.)/.test(req.socket?.remoteAddress || '') && !PROXY_HEADERS.some((h) => req.headers[h])
    && localHostname(req.headers.host);
}
const localOnlyBlocked = (req) => !authEnabled && !isLocal(req);
const LOCAL_ONLY_MSG = 'SSH-WEB: AUTH_PASSWORD is not set, so only local access (127.0.0.1) is allowed. Set AUTH_PASSWORD and restart.\n'
  + 'SSH-WEB：没有设置 AUTH_PASSWORD，只允许在本机访问。设置 AUTH_PASSWORD 后重启即可。\n';

function isAuthed(req) {
  if (!authEnabled) return isLocal(req);
  return !!tokenOf(req);
}

// 用户名密码对了就发一个新凭证 (占位密码一律不认)
function login(username, password) {
  if (PLACEHOLDER_PASSWORD) return null;
  if (!(safeEqual(username || '', AUTH_USER) && safeEqual(password || '', AUTH_PASSWORD))) return null;
  return sign({ u: AUTH_USER, exp: Date.now() + SESSION_MS, jti: crypto.randomBytes(12).toString('base64url') });
}

// 用着就续期：凭证发出去超过 1 小时 (有效期很短时按 1/4) 就换一个从现在起算的，jti 不变 (退出登录照样作废)
// 返回新凭证；不用续时返回 null
function renew(req) {
  if (!authEnabled) return null;
  const p = tokenOf(req);
  if (!p || p.exp - Date.now() > SESSION_MS - Math.min(3600 * 1000, SESSION_MS / 4)) return null;
  return sign({ ...p, exp: Date.now() + SESSION_MS });
}

// ---------------------------------------------------------------- 登录限流
// 按客户端 IP (经过可信代理时是 X-Forwarded-For 里的) 每 5 次失败锁 5 分钟。
// 另外按连接的直连地址 (代理 / 局域网设备本身) 再限一层，次数宽一些：局域网里的设备往 X-Forwarded-For 里
// 每次填一个不同的 IP 也绕不过去；经过 cloudflared 的所有人共用一个直连地址，所以这一层放宽到 30 次
const loginFails = new Map(); // key -> { count, until }
const LIMITS = { ip: 5, peer: 30 };
const keysOf = (ip, peer) => [['ip', 'ip:' + ip], ...(peer && peer !== ip ? [['peer', 'peer:' + peer]] : [])];
function loginBlocked(ip, peer) {
  return keysOf(ip, peer).some(([, k]) => { const r = loginFails.get(k); return r && r.until > Date.now(); });
}
function loginFailed(ip, peer) {
  for (const [kind, k] of keysOf(ip, peer)) {
    const r = loginFails.get(k) || { count: 0, until: 0 };
    r.count += 1;
    if (r.count >= LIMITS[kind]) {
      r.until = Date.now() + 5 * 60 * 1000;
      r.count = 0;
    }
    loginFails.set(k, r);
  }
}
const loginOk = (ip) => loginFails.delete('ip:' + ip);
setInterval(() => {
  const now = Date.now();
  for (const [ip, r] of loginFails) if (r.until < now) loginFails.delete(ip);
}, 10 * 60 * 1000).unref();

// 用 SECRET 签一个短串 (端口预览地址里的口令：服务重启后不变，没有 SECRET 算不出来)
const signLabel = (label, len = 12) => crypto.createHmac('sha256', SECRET).update(label).digest('base64url').slice(0, len);

module.exports = {
  encrypt, decrypt, revoke, tokenOf, isAuthed, login, renew, loginBlocked, loginFailed, loginOk, signLabel,
  COOKIE_NAME, authEnabled, WEAK_PASSWORD, PLACEHOLDER_PASSWORD, localOnlyBlocked, localHostname, LOCAL_ONLY_MSG,
};
