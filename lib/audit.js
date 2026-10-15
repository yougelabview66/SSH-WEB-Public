'use strict';
// 审计日志：谁 (出口 IP)、从哪里连进来 (连接 IP)、经过哪些代理 (代理路径) 登录 / 打开 / 关闭了哪个 SSH 会话，
// 以及这个会话怎么连到目标主机 (直连 / Cloudflare 隧道、本机地址 → 对端地址)。
// 一行一条 JSON，全部写在 DATA_DIR/audit.log (权限 600)：每次挂载、重连都记，出口 IP 的归属地和是否代理的判断也一起存下，
// 单看文件就是完整的。超过 AUDIT_MAX_MB 就改名成 audit-<时间>.log 存档，不会自动删除
//
//   出口 IP (ip)   ：从连接 IP 往回按 TRUST_PROXY 数 X-Forwarded-For，第一个不受信任的地址 (和登录限流用的 req.ip 一样)，
//                    也就是用户那边的公网出口 (用了代理 / 机场就是代理的出口)
//   连接 IP (peer) ：直接连到 SSH-WEB 的地址 (反向代理、cloudflared 容器，或者用户本身)
//   代理路径 (path)：从出口 IP 到连接 IP 依次经过的地址 (每一跳都是受信任的代理报上来的)；
//                    X-Forwarded-For 里更前面的地址是客户端自己声称的，核实不了，单独记成 claimed；
//                    经过 Cloudflare 时记下 CF-Ray (能在 Cloudflare 后台查到这次请求) 和国家
//   登录编号 (sid) ：同一次登录 (续期也不变) 的编号 (凭证 id 的摘要)，把登录和它打开的会话串起来
//   geo / proxy    ：出口 IP 的归属地 (见 geo.js) 和是否用了代理 (见下面 judge)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const proxyaddr = require('proxy-addr');
const geo = require('./geo');
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

// 「地址:端口」里的地址 (IPv6 地址里也有冒号，按最后一个分)
const hostOf = (hp) => String(hp || '').replace(/:\d+$/, '');

// 是否用了代理 (用户那边的：机场 / VPN / 公司代理；SSH-WEB 前面的反向代理 / Cloudflare 看 path，不算)：
//   是  ：请求头声明经过了代理 (claimed)；归属地服务认定是代理 / VPN；出口 IP 所在时区和浏览器时区对不上
//         (人在国内、出口在日本 —— 机场节点归属地服务常常认不出来，时区对不上最准)
//   可能：出口是机房 / 云服务器的 IP (归属地服务认定是机房，或者运营商是常见的机房 / 云厂商)
//   否  ：都不是；内网 IP 也是否
//   未知：查不到归属地，也没有别的迹象
const DC = /hosting|host\b|cloud|server|data ?cent|\bvps\b|\bidc\b|colo|amazon|\baws\b|google|microsoft|azure|oracle|alibaba|aliyun|tencent|huawei cloud|digitalocean|linode|akamai|vultr|choopa|hetzner|\bovh\b|m247|datacamp|cdn77|leaseweb|zenlayer|g-?core|\bdmit\b|psychz|quadranet|kirino|bandwagon|\bit7\b|racknerd|colocrossing|buyvm|frantech|contabo|scaleway|example|cloudflare|fastly|kaopu|misaka|\bgigsgigscloud\b/i;
const utc = (sec) => { const m = Math.round(sec / 60); return `UTC${m < 0 ? '-' : '+'}${Math.floor(Math.abs(m) / 60)}${Math.abs(m) % 60 ? ':' + String(Math.abs(m) % 60).padStart(2, '0') : ''}`; };
function judge(rec, g) {
  const yes = [], maybe = [];
  if (rec.claimed?.length) yes.push('请求头声明经过 ' + rec.claimed.join(', '));
  if (g?.proxy) yes.push('归属地服务认定是代理 / VPN IP');
  if (g && !g.local && Number.isFinite(g.offset) && Number.isFinite(rec.tzOffset) && g.offset !== rec.tzOffset) {
    yes.push(`出口在${g.country || '国外'} (${utc(g.offset)})，浏览器时区 ${rec.tz || ''} (${utc(rec.tzOffset)})`.replace(' ()', ''));
  }
  if (g?.hosting) maybe.push('机房 IP');
  else if (g && !g.local && DC.test(`${g.isp} ${g.as}`)) maybe.push('运营商是机房 / 云厂商');
  if (yes.length) return { v: '是', why: [...yes, ...maybe] };
  if (maybe.length) return { v: '可能', why: maybe };
  if (g) return { v: '否', why: g.local ? ['内网'] : [] };
  return { v: '未知', why: [] };
}

// 记录里补上归属地和是否代理 (出口 IP)、目标主机 / 边缘节点的归属地；旧记录 (没存这些的) 查看时也用它补
async function enrich(rec) {
  const [g, hg] = await Promise.all([
    rec.ip && !rec.geo ? geo.lookup(rec.ip) : rec.geo,
    rec.out?.remote && !rec.out.geo ? geo.lookup(hostOf(rec.out.remote)) : rec.out?.geo,
  ]);
  if (rec.ip) {
    if (g) rec.geo = g;
    if (!rec.proxy) rec.proxy = judge(rec, g);
  }
  if (hg && rec.out) rec.out.geo = hg;
  return rec;
}

let size = 0;
try { size = fs.statSync(FILE).size; } catch {}
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

function write(rec) {
  const line = JSON.stringify(rec) + '\n';
  try {
    if (size && size + line.length > MAX_BYTES) {
      fs.renameSync(FILE, path.join(DATA_DIR, `audit-${stamp()}.log`));
      size = 0;
    }
    fs.appendFileSync(FILE, line, { mode: 0o600 });
    size += Buffer.byteLength(line);
  } catch (e) {
    console.error('写审计日志失败', e.message);
  }
}

// 先查归属地再写 (最多等 5 秒，查不到就不带)；按发生的顺序写，时间 t 是发生时的
let queue = Promise.resolve();
function log(ev, fields = {}) {
  if (!AUDIT_LOG) return queue;
  const rec = { t: new Date().toISOString(), ev, ...fields };
  const ready = enrich(rec).catch(() => rec);
  queue = queue.then(() => ready).then(write);
  return queue;
}
// 服务停止前等还没写完的记录
const flush = () => queue;

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

// 当前文件 + 最近的两份存档 (新的在前)
function files() {
  let arch = [];
  try {
    arch = fs.readdirSync(DATA_DIR).filter((f) => /^audit-\d{8}-\d{6}\.log$|^audit\.log\.1$/.test(f))
      .map((f) => path.join(DATA_DIR, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch {}
  return [FILE, ...arch.slice(0, 2)];
}

// 最近的记录 (新的在前)；q：只要整行里包含这段文字的；filter：再按内容筛
function recent(limit = 200, q = '', filter = null) {
  const out = [];
  for (const f of files()) {
    for (const l of tailLines(f)) {
      if (q && !l.includes(q)) continue;
      let x;
      try { x = JSON.parse(l); } catch { continue; }
      if (filter && !filter(x)) continue;
      out.push(x);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

module.exports = { origin, sid, sockPath, hostOf, log, flush, recent, enrich, FILE };
