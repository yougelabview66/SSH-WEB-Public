'use strict';
// Windows 主机的性能监控 (没有 /proc)：PowerShell 读性能计数器 (脚本从标准输入喂进去，结果 base64)，
// 服务端两次采样做差：CPU、网速、磁盘读写、进程 CPU；分区、内存、页面文件照常显示，没有负载 / IO 等待 / 缓存就不显示。
// 端口预览的端口列表：netstat -ano + tasklist 查进程名
const { Server } = require('ssh2');
const { BASE, ok, wait, launch, addHost, run, hostKey } = require('./helpers');

let calls = 0, script = '';
const sample = (k) => ({
  host: 'WIN-PC', os: 'Microsoft Windows 11 专业版', ver: '10.0.22631', model: ' Intel(R) Core(TM) i7 ', cores: 8, up: 3 * 86400 + 3600,
  memTotal: 16 * 2 ** 30, memFree: 6 * 2 ** 30, swapTotal: 4 * 2 ** 30, swapUsed: 2 ** 30,
  // 每次过 1 秒 (1e7 个 100ns)，其中 0.25 秒空闲 (CPU 75%)、用户 0.5 秒、系统 0.25 秒
  ts: 1e12 + k * 1e7, idle: 5e11 + k * 2.5e6, user: 1e11 + k * 5e6, sys: 1e11 + k * 2.5e6,
  dr: 1e9 + k * 2e6, dw: 2e9 + k * 1e6,
  net: [{ n: 'Intel[R] Ethernet', rx: 1e10 + k * 1e6, tx: 5e9 + k * 5e5 }, { n: 'isatap.{abc}', rx: 0, tx: 0 }],
  disks: [{ id: 'C:', label: '系统', total: 500e9, free: 200e9 }, { id: 'D:', label: '', total: 1000e9, free: 900e9 }],
  ps: [{ i: 4321, n: 'node', c: 10 + k * 0.5, m: 300e6 }, { i: 99, n: '微信', c: 5, m: 500e6 }, { i: 4, n: 'System', c: 0, m: 0 }],
});
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => a().write('C:\\Users\\demo>'));
    s.on('exec', (a, r, info) => {
      const ch = a(), cmd = info.command;
      const out = (t, code = 0) => { ch.write(t); ch.exit(code); ch.end(); };
      if (cmd === 'echo %OS%;$env:OS') return out('Windows_NT;$env:OS\r\n'); // SSH 默认 cmd
      if (cmd === 'powershell -NoProfile -NonInteractive -Command -') {
        let got = '';
        ch.on('data', (d) => { got += d; });
        ch.on('end', () => { script = got; const k = calls++; out(`@@winb64\r\n${Buffer.from(JSON.stringify(sample(k))).toString('base64')}\r\n`); });
        return;
      }
      if (cmd === 'netstat -ano & tasklist /fo csv /nh') {
        return out('\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n'
          + '  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       4321\r\n'
          + '  TCP    [::]:8080              [::]:0                 侦听            99\r\n'
          + '  TCP    192.168.1.5:50000      203.0.113.9:443        ESTABLISHED     4321\r\n'
          + '"node.exe","4321","Console","1","300,000 K"\r\n"微信.exe","99","Console","1","500,000 K"\r\n');
      }
      if (cmd.includes('watch.ps1')) return out('SSHWEB_HOOKS=0\r\n');
      ch.stderr.write(`'${cmd.split(' ')[0]}' is not recognized\r\n`); out('', 1);
    });
  }));
}).listen(2339, '127.0.0.1');

run(async () => {
  await addHost('MW', 2339);
  const browser = await launch();
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'MW' }).click(); await p.waitForSelector('.tab.active .dot.ok'); await wait(800);
  const sid = (await (await fetch(BASE + '/api/sessions')).json())[0].id;

  const d = await (await fetch(BASE + '/api/monitor/' + sid)).json();
  ok(/Get-CimInstance/.test(script) && !/\n./.test(script.trim()) && calls === 2, 'PowerShell 脚本从标准输入喂进去 (一行)，第一次采两次做差');
  ok(d.hostname === 'WIN-PC' && d.os.includes('Windows 11') && d.kernel === '10.0.22631' && d.cpu.cores === 8 && d.cpu.model === 'Intel(R) Core(TM) i7', '主机名、系统、版本、CPU 型号和核数: ' + JSON.stringify([d.hostname, d.os, d.kernel, d.cpu.model]));
  const near = (a, b) => a != null && Math.abs(a - b) < 0.5;
  ok(near(d.cpu.usage, 75) && near(d.cpu.user, 50) && near(d.cpu.system, 25) && d.cpu.iowait == null, `CPU 两次采样做差：使用率 75%、用户 50%、系统 25%: ${JSON.stringify(d.cpu)}`);
  ok(d.mem.total === 16 * 2 ** 30 && d.mem.used === 10 * 2 ** 30 && d.mem.swapTotal === 4 * 2 ** 30 && d.mem.cache == null && d.load.length === 0, '内存、页面文件；没有缓存和负载');
  ok(d.ifaces.length === 1 && d.ifaces[0].name === 'Intel[R] Ethernet' && d.ifaces[0].rxRate > 0 && d.io.readRate > 0, '网卡 (去掉 isatap 这类虚拟的) 和磁盘读写速率: ' + JSON.stringify([d.ifaces[0], d.io]));
  ok(d.disks.length === 2 && d.disks[0].mount === 'C:\\' && d.disks[0].used === 300e9, '分区：C:\\ D:\\ 的用量');
  ok(d.topCpu[0].name === 'node' && d.topCpu[0].cpu > 0 && d.topMem[0].name === '微信' && d.procCount === 3, '进程：按 CPU / 内存排，中文进程名不乱: ' + JSON.stringify(d.topMem[0]));

  // 网页上：Windows 没有的负载 / IO 等待 / 缓存不显示
  await p.click('#btnMore'); await p.click('#btnMon'); await wait(3500);
  const txt = await p.textContent('.term.active .mon');
  ok(txt.includes('WIN-PC') && txt.includes('C:\\') && txt.includes('微信') && !txt.includes('负载') && !txt.includes('IO等待') && !txt.includes('缓存'), '性能监控面板：显示主机、分区、进程；不显示负载 / IO 等待 / 缓存');

  // 端口预览的端口列表
  const ports = (await (await fetch(BASE + '/api/forward/ports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid }) })).json()).ports || [];
  ok(JSON.stringify(ports.map((x) => [x.port, x.proc])) === JSON.stringify([[5173, 'node'], [8080, '微信']]), 'Windows 的端口列表：netstat 列监听的端口，tasklist 查进程名 (状态翻译成中文也认): ' + JSON.stringify(ports));
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close();
});
