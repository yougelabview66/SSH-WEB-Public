'use strict';
// 审计日志：谁 (出口 IP)、从哪里连进来 (连接 IP)、经过哪些代理 (代理路径) 登录 / 打开 / 关闭了哪个 SSH 会话，
// 以及这个会话怎么连到目标主机 (直连 / Cloudflare 隧道、本机地址 → 对端地址)。
// 一行一条 JSON，写在 DATA_DIR/audit.log (权限 600)，超过 AUDIT_MAX_MB 换成 audit.log.1 (只留一份旧的)
//
//   出口 IP (ip)   ：从连接 IP 往回按 TRUST_PROXY 数 X-Forwarded-For，第一个不受信任的地址 (和登录限流用的 req.ip 一样)，
//                    也就是用户那边的公网出口 (用了代理 / 机场就是代理的出口)
//   连接 IP (peer) ：直接连到 SSH-WEB 的地址 (反向代理、cloudflared 容器，或者用户本身)
//   代理路径 (path)：从出口 IP 到连接 IP 依次经过的地址 (每一跳都是受信任的代理报上来的)；
//                    X-Forwarded-For 里更前面的地址是客户端自己声称的，核实不了，单独记成 claimed；
//                    经过 Cloudflare 时记下 CF-Ray (能在 Cloudflare 后台查到这次请求) 和国家
//   登录编号 (sid) ：同一次登录 (续期也不变) 的编号 (凭证 id 的摘要)，把登录和它打开的会话串起来
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const proxyaddr = require('proxy-addr');
const { DATA_DIR, TRUST_PROXY, AUDIT_LOG, AUDIT_MAX_MB } = require('./config');

const FILE = path.join(DATA_DIR, 'audit.log');
const MAX_BYTES = Math.max(AUDIT_MAX_MB, 0.1) * 1024 * 1024;
// 和 Express 的 trust proxy 一样解析 (http.js 里 app.set('trust proxy', TRUST_PROXY))
const trust = proxyaddr.compile(TRUST_PROXY.split(',').map((s) => s.trim()).filter(Boolean));

const norm = (a) => String(a || '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
const cut = (v, n) => String(v ?? '').slice(0, n);

// 请求 (HTTP 或 WebSocket 握手) 的来源：出口 IP、连接 IP、代理路径
function origin(req) {
  const hops = proxyaddr.all(req, trust).map(norm); // [连接 IP, 受信任的代理…, 出口 IP]
  const o = { ip: hops[hops.length - 1], peer: hops[0], path: hops.slice().reverse() };
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const claimed = xff.slice(0, Math.max(xff.length - (hops.length - 1), 0));
  if (claimed.length) o.claimed = claimed.slice(-10).map((a) => cut(norm(a), 64));
  // CF-Ray 这类头只有受信任的代理 (cloudflared) 转过来的才算数
  if (trust(req.socket.remoteAddress, 0) && req.headers['cf-ray']) {
    o.cf = { ray: cut(req.headers['cf-ray'], 40) };
    if (req.headers['cf-ipcountry']) o.cf.country = cut(req.headers['cf-ipcountry'], 8);
  }
  if (req.headers['user-agent']) o.ua = cut(req.headers['user-agent'], 200);
  return o;
}

// 登录编号：凭证 id 的摘要 (不记原值)；没开登录时为空
const sid = (jti) => (jti ? crypto.createHash('sha256').update('ssh-web-audit:' + jti).digest('hex').slice(0, 12) : undefined);

// SSH-WEB 到目标主机的这一段：本机地址 → 对端地址 (Cloudflare 隧道时对端是 Cloudflare 的边缘节点)
const sockPath = (sock) => (sock && sock.remoteAddress
  ? { local: `${norm(sock.localAddress)}:${sock.localPort}`, remote: `${norm(sock.remoteAddress)}:${sock.remotePort}` }
  : undefined);

let size = 0;
try { size = fs.statSync(FILE).size; } catch {}

function log(ev, fields = {}) {
  if (!AUDIT_LOG) return;
  const line = JSON.stringify({ t: new Date().toISOString(), ev, ...fields }) + '\n';
  try {
    if (size && size + line.length > MAX_BYTES) {
      fs.renameSync(FILE, FILE + '.1');
      size = 0;
    }
    fs.appendFileSync(FILE, line, { mode: 0o600 });
    size += Buffer.byteLength(line);
  } catch (e) {
    console.error('写审计日志失败', e.message);
  }
}

// 文件末尾最多 2MB 里的完整行 (新的在前)
function tailLines(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const len = fs.fstatSync(fd).size;
    const n = Math.min(len, 2 * 1024 * 1024);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, len - n);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    if (n < len) lines.shift(); // 第一行可能只读到一半
    return lines.reverse();
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// 最近的记录 (新的在前)；q：只要整行里包含这段文字的 (按 IP、会话 id、登录编号、主机名查)
function recent(limit = 200, q = '') {
  const out = [];
  for (const f of [FILE, FILE + '.1']) {
    for (const l of tailLines(f)) {
      if (q && !l.includes(q)) continue;
      try { out.push(JSON.parse(l)); } catch { continue; }
      if (out.length >= limit) return out;
    }
  }
  return out;
}

module.exports = { origin, sid, sockPath, log, recent, FILE };
