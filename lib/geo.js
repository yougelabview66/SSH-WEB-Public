'use strict';
// IP 归属地 (监控面板的连接日志用)：默认在线查 ip-api.com (免费、中文、带「代理 / 机房 IP」判断，每分钟限 45 次)，
// 结果在内存里缓存 1 天 (查失败的 5 分钟后再试)；内网 / 保留地址不查。GEOIP=off 关闭，不把 IP 发给第三方
const net = require('net');
const { GEOIP } = require('./config');

const TTL = 24 * 3600 * 1000;
const FAIL_TTL = 5 * 60 * 1000;
const MAX = 5000;
const cache = new Map(); // ip -> { at, ttl, v }
const inflight = new Map(); // 同一个 IP 同时只查一次

// 内网 / 本机 / 保留地址 (不是公网 IP，查不到归属地)
function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168);
  }
  if (net.isIPv6(ip)) return /^(::1?$|f[cd]|fe[89ab])/i.test(ip);
  return true; // 不是 IP
}

async function query(ip) {
  const r = await fetch(GEOIP.replace('{ip}', encodeURIComponent(ip)), { signal: AbortSignal.timeout(5000) });
  const d = await r.json();
  if (d.status !== 'success') throw new Error(d.message || 'HTTP ' + r.status);
  const s = (v) => String(v ?? '').slice(0, 100);
  return { country: s(d.country), region: s(d.regionName), city: s(d.city), isp: s(d.isp), as: s(d.as), proxy: !!d.proxy, hosting: !!d.hosting };
}

// 返回 { local: true } (内网)、归属地，或 null (关闭了 / 查不到)
async function lookup(ip) {
  ip = String(ip || '');
  if (!ip) return null;
  if (isPrivate(ip)) return { local: true };
  if (!GEOIP) return null;
  const c = cache.get(ip);
  if (c && Date.now() - c.at < c.ttl) return c.v;
  if (inflight.has(ip)) return inflight.get(ip);
  const p = query(ip).then((v) => [v, TTL], () => [null, FAIL_TTL]).then(([v, ttl]) => {
    inflight.delete(ip);
    if (cache.size >= MAX) cache.delete(cache.keys().next().value);
    cache.set(ip, { at: Date.now(), ttl, v });
    return v;
  });
  inflight.set(ip, p);
  return p;
}

module.exports = { lookup, isPrivate };
