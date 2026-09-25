'use strict';

/**
 * 主机性能监控 (参考 FinalShell)
 * 复用终端会话的 SSH 连接执行一段只读脚本，读取 /proc 等信息；
 * CPU 使用率、网速、磁盘 IO、进程 CPU 等需要两次采样做差，结果按会话缓存在服务端。
 * 只依赖 sh / cat / awk / df，兼容群晖等 BusyBox 系统。
 */

const SCRIPT = [
  'export LC_ALL=C',
  'echo @@info',
  'hostname 2>/dev/null || cat /proc/sys/kernel/hostname',
  '(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || uname -s',
  'uname -r',
  'grep -m1 -iE "model name|^cpu model|^Hardware" /proc/cpuinfo 2>/dev/null | cut -d: -f2-',
  'getconf CLK_TCK 2>/dev/null || echo 100',
  'getconf PAGESIZE 2>/dev/null || echo 4096',
  'echo @@stat', 'grep "^cpu" /proc/stat',
  'echo @@mem', 'cat /proc/meminfo',
  'echo @@load', 'cat /proc/loadavg',
  'echo @@uptime', 'cat /proc/uptime',
  'echo @@net', 'cat /proc/net/dev',
  'echo @@disk', 'cat /proc/diskstats 2>/dev/null',
  'echo @@df', 'df -kP 2>/dev/null',
  'echo @@temp', 'cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null',
  // 每个进程: pid utime+stime rss 名称 (名称可能含空格，用 ") X " 定位)
  'echo @@ps',
  'awk \'{ r = match($0, /\\) [A-Za-z] /); if (!r) next; l = index($0, "(");'
    + ' n = substr($0, l + 1, r - l - 1); split(substr($0, r + 2), f, " ");'
    + ' print $1, f[12] + f[13], f[22], n }\' /proc/[0-9]*/stat 2>/dev/null',
  'echo @@end',
].join('\n');

function sections(out) {
  const res = {};
  let cur = null;
  for (const line of out.split('\n')) {
    const m = /^@@(\w+)$/.exec(line.trim());
    if (m) {
      cur = m[1];
      res[cur] = [];
    } else if (cur) {
      res[cur].push(line);
    }
  }
  return res;
}

// 不统计的文件系统 / 挂载点
const SKIP_FS = /^(tmpfs|devtmpfs|udev|none|overlay|shm|rootfs|cgroup.*|efivarfs)$/;
const SKIP_MOUNT = /^\/(dev|run|sys|proc|snap|boot\/efi)(\/|$)|\/docker\/|\/containers\/|^\/var\/lib\/kubelet/;
// 统计 IO 的整盘设备 (不含分区)
const WHOLE_DISK = /^(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+|sata\d+|md\d+)$/;

function parse(out, prev, now) {
  const s = sections(out);
  if (!s.stat || !s.stat.length || !s.mem) {
    throw new Error('目标主机不支持 (需要 Linux /proc)');
  }
  const [hostname, os, kernel, cpuModel, clk, page] = (s.info || []).map((x) => x.trim());
  const clkTck = parseInt(clk, 10) || 100;
  const pageSize = parseInt(page, 10) || 4096;
  const dt = prev ? (now - prev.time) / 1000 : 0;

  // CPU
  const cpuLines = s.stat.filter((l) => l.startsWith('cpu'));
  const parseCpu = (l) => {
    const v = l.trim().split(/\s+/).slice(1).map(Number);
    const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = v;
    return { total: user + nice + system + idle + iowait + irq + softirq + steal, idle: idle + iowait,
      user: user + nice, system: system + irq + softirq, iowait };
  };
  const cpuNow = parseCpu(cpuLines[0]);
  const cores = cpuLines.length - 1 || 1;
  const cpu = { cores, model: cpuModel || '', usage: null, user: null, system: null, iowait: null };
  if (prev) {
    const d = cpuNow.total - prev.cpu.total;
    if (d > 0) {
      cpu.usage = (1 - (cpuNow.idle - prev.cpu.idle) / d) * 100;
      cpu.user = ((cpuNow.user - prev.cpu.user) / d) * 100;
      cpu.system = ((cpuNow.system - prev.cpu.system) / d) * 100;
      cpu.iowait = ((cpuNow.iowait - prev.cpu.iowait) / d) * 100;
    }
  }

  // 内存 (kB -> 字节)
  const mi = {};
  for (const l of s.mem) {
    const m = /^(\w+):\s+(\d+)/.exec(l);
    if (m) mi[m[1]] = +m[2] * 1024;
  }
  const available = mi.MemAvailable ?? (mi.MemFree + (mi.Buffers || 0) + (mi.Cached || 0));
  const mem = {
    total: mi.MemTotal || 0,
    used: (mi.MemTotal || 0) - (available || 0),
    cache: (mi.Buffers || 0) + (mi.Cached || 0) + (mi.SReclaimable || 0),
    swapTotal: mi.SwapTotal || 0,
    swapUsed: (mi.SwapTotal || 0) - (mi.SwapFree || 0),
  };

  const load = (s.load?.[0] || '').trim().split(/\s+/).slice(0, 3).map(Number);
  const uptime = parseFloat(s.uptime?.[0]) || 0;

  // 网络
  const netNow = {};
  for (const l of s.net || []) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(l);
    if (!m) continue;
    const v = m[2].trim().split(/\s+/).map(Number);
    netNow[m[1]] = { rx: v[0], tx: v[8] };
  }
  const ifaces = Object.keys(netNow)
    .filter((n) => n !== 'lo' && !/^(veth|docker|br-|virbr|tun|tap|cali|flannel|cni)/.test(n))
    .map((n) => {
      const p = prev?.net[n];
      const ok = p && dt > 0 && netNow[n].rx >= p.rx && netNow[n].tx >= p.tx;
      return { name: n, rxRate: ok ? (netNow[n].rx - p.rx) / dt : null, txRate: ok ? (netNow[n].tx - p.tx) / dt : null,
        rxTotal: netNow[n].rx, txTotal: netNow[n].tx };
    })
    .sort((a, b) => (b.rxTotal + b.txTotal) - (a.rxTotal + a.txTotal));

  // 磁盘 IO (扇区 512 字节)
  const diskNow = { r: 0, w: 0 };
  for (const l of s.disk || []) {
    const v = l.trim().split(/\s+/);
    if (v.length < 10 || !WHOLE_DISK.test(v[2])) continue;
    // md 阵列与成员盘都统计会重复，有 md 时只算 md
    diskNow[v[2]] = { r: +v[5] * 512, w: +v[9] * 512 };
  }
  const names = Object.keys(diskNow).filter((n) => n !== 'r' && n !== 'w');
  const useMd = names.some((n) => n.startsWith('md'));
  for (const n of names) {
    if (useMd !== n.startsWith('md')) continue;
    diskNow.r += diskNow[n].r;
    diskNow.w += diskNow[n].w;
  }
  const io = { readRate: null, writeRate: null };
  if (prev && dt > 0 && diskNow.r >= prev.disk.r && diskNow.w >= prev.disk.w) {
    io.readRate = (diskNow.r - prev.disk.r) / dt;
    io.writeRate = (diskNow.w - prev.disk.w) / dt;
  }

  // 文件系统
  const seen = new Set();
  const disks = [];
  for (const l of (s.df || []).slice(1)) {
    const v = l.trim().split(/\s+/);
    if (v.length < 6) continue;
    const [fs, total, used, avail] = v;
    const mount = v.slice(5).join(' ');
    if (SKIP_FS.test(fs) || SKIP_MOUNT.test(mount) || +total === 0 || seen.has(fs)) continue;
    seen.add(fs);
    disks.push({ fs, mount, total: +total * 1024, used: +used * 1024, avail: +avail * 1024 });
  }

  // 温度 (毫摄氏度)
  const temps = (s.temp || []).map((t) => parseInt(t, 10) / 1000).filter((t) => t > 0 && t < 150);
  const temp = temps.length ? Math.max(...temps) : null;

  // 进程
  const psNow = {};
  const procs = [];
  for (const l of s.ps || []) {
    const m = /^(\d+) (\d+) (\d+) (.*)$/.exec(l);
    if (!m) continue;
    const pid = +m[1];
    const ticks = +m[2];
    psNow[pid] = ticks;
    const rss = +m[3] * pageSize;
    if (rss === 0 && ticks === 0) continue; // 内核线程
    const p = prev?.ps[pid];
    procs.push({
      pid,
      name: m[4],
      mem: rss,
      memPct: mem.total ? (rss / mem.total) * 100 : 0,
      cpu: p != null && dt > 0 && ticks >= p ? ((ticks - p) / clkTck / dt) * 100 : null,
    });
  }
  const topCpu = [...procs].sort((a, b) => (b.cpu || 0) - (a.cpu || 0) || b.mem - a.mem).slice(0, 15);
  const topMem = [...procs].sort((a, b) => b.mem - a.mem).slice(0, 15);

  return {
    snapshot: { time: now, cpu: cpuNow, net: netNow, disk: { r: diskNow.r, w: diskNow.w }, ps: psNow },
    data: {
      time: now, hostname, os, kernel, uptime, load, temp, cpu, mem, ifaces, io, disks,
      procCount: procs.length, topCpu, topMem,
    },
  };
}

function run(ssh, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    ssh.exec(SCRIPT, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      const timer = setTimeout(() => { stream.close(); reject(new Error('采集超时')); }, timeoutMs);
      stream.on('data', (d) => { if (out.length < 4 * 1024 * 1024) out += d; });
      stream.stderr.resume();
      stream.on('close', () => { clearTimeout(timer); resolve(out); });
    });
  });
}

module.exports = function registerMonitor(app, getSession) {
  app.get('/api/monitor/:sid', async (req, res) => {
    const sess = getSession(req.params.sid);
    if (!sess || !sess.ssh) return res.status(404).json({ error: '会话不存在或已断开' });
    // 同一会话同时只采集一次 (多个浏览器标签看同一会话时共用结果)
    if (!sess.monPending) {
      const sample = async () => {
        const out = await run(sess.ssh);
        const r = parse(out, sess.monPrev, Date.now());
        sess.monPrev = r.snapshot;
        return r.data;
      };
      // 第一次没有上一次采样可以做差，间隔 0.5 秒再采一次
      sess.monPending = (sess.monPrev ? sample() : sample().then(() => new Promise((r) => setTimeout(r, 500))).then(sample))
        .finally(() => { sess.monPending = null; });
    }
    try {
      res.json(await sess.monPending);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
};

module.exports.parse = parse;
module.exports.SCRIPT = SCRIPT;
