'use strict';
// 配置：全部来自环境变量 (见 docker-compose.yml / README)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const env = process.env;

const PORT = parseInt(env.PORT || '8888', 10);
const HOST = env.HOST || '0.0.0.0';
const DATA_DIR = env.DATA_DIR || path.join(ROOT, 'data');
const AUTH_USER = env.AUTH_USER || 'admin';
const AUTH_PASSWORD = env.AUTH_PASSWORD || '';
const SESSION_HOURS = parseFloat(env.SESSION_HOURS || '24');
const COOKIE_SECURE = env.COOKIE_SECURE === 'true';
// 只信任来自这些地址的 X-Forwarded-For (反向代理 / cloudflared 容器)，防止伪造 IP 绕过登录限流
const TRUST_PROXY = env.TRUST_PROXY || 'loopback, linklocal, uniquelocal';
// 可选: 限制只能连接这些主机，逗号分隔，如 "192.168.1.*,nas.local"
const ALLOWED_HOSTS = (env.ALLOWED_HOSTS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const SSH_READY_TIMEOUT = parseInt(env.SSH_READY_TIMEOUT || '20000', 10);
const SSH_KEEPALIVE = parseInt(env.SSH_KEEPALIVE || '15000', 10);
// 主机指纹校验策略: ask = 新主机和指纹变化都弹窗确认 (默认)
//                  accept-new = 新主机自动信任，指纹变化才弹窗
//                  off = 不校验 (不推荐)
const HOSTKEY_POLICY = ['ask', 'accept-new', 'off'].includes(env.HOSTKEY_POLICY)
  ? env.HOSTKEY_POLICY : 'ask';
// 后台会话: 无人挂载超过多少小时自动关闭 (默认 168 = 7 天，0 = 永不)；最多同时保留的会话数；每个会话保留的滚动行数
const BG_TIMEOUT_HOURS = parseFloat(env.BG_TIMEOUT_HOURS ?? '168') || 0;
const MAX_SESSIONS = parseInt(env.MAX_SESSIONS || '30', 10);
const SCROLLBACK = parseInt(env.SCROLLBACK || '5000', 10);
const HISTORY_MAX = parseInt(env.HISTORY_MAX || '1000', 10);
const PUSH_SUBJECT = env.PUSH_SUBJECT || 'mailto:ssh-web@example.com';
const VERSION = require('../package.json').version;

fs.mkdirSync(DATA_DIR, { recursive: true });

module.exports = {
  ROOT, PORT, HOST, DATA_DIR, AUTH_USER, AUTH_PASSWORD, SESSION_HOURS, COOKIE_SECURE, TRUST_PROXY, ALLOWED_HOSTS,
  SSH_READY_TIMEOUT, SSH_KEEPALIVE, HOSTKEY_POLICY, BG_TIMEOUT_HOURS, MAX_SESSIONS, SCROLLBACK, HISTORY_MAX, PUSH_SUBJECT, VERSION,
};
