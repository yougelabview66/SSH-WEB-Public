'use strict';
// 连接目标：浏览器传来的连接参数整理成 SSH 连接配置 (已保存的主机从服务端读取加密凭据)、
// ALLOWED_HOSTS 白名单、Cloudflare 隧道地址、主机公钥指纹
const crypto = require('crypto');
const { ALLOWED_HOSTS } = require('./config');
const store = require('./store');
const { decrypt } = require('./auth');

const str = (v) => (typeof v === 'string' ? v : '');

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
    const h = store.hosts.read().find((x) => x.id === msg.hostId);
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

// 原始公钥: uint32 长度 + 算法名 + ...
function keyType(key) {
  try {
    return key.subarray(4, 4 + key.readUInt32BE(0)).toString('ascii');
  } catch {
    return 'unknown';
  }
}

function fingerprint(key) {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

module.exports = { str, buildConfig, keyType, fingerprint };
