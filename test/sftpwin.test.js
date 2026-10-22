'use strict';
// 连的是 Windows 的 SSH (OpenSSH)：SFTP 路径是 /D:/xxx，文件面板的路径框显示时去掉盘符前面的 /；
// 在路径框里输入 D:/xxx 回车，发给服务端时补回 /D:/xxx；「终端 cd」按终端里的 shell 给写法：
// 默认 cmd → cd /d "D:\xxx"，默认 PowerShell → cd 'D:\xxx'
const { Server, utils: { sftp: { STATUS_CODE } } } = require('ssh2');
const { BASE, ok, wait, run, launch, hostKey, addHost } = require('./helpers');

// 模拟 Windows 的 SFTP：主目录 /D:/示例工作区，下面有个文件夹「项目」；只认 /D:/… 这种路径
const DIRS = { '/D:/示例工作区': ['项目', 'a.txt'], '/D:/示例工作区/项目': ['b.txt'], '/D:': ['示例工作区'] };
const asked = [];
const got = {}; // 端口 → 终端收到的输入

// shell：SSH 默认的命令行 (cmd / powershell)
function server(port, shell) {
  new Server({ hostKeys: [hostKey()] }, (c) => {
    c.on('authentication', (ctx) => ctx.accept());
    c.on('ready', () => c.on('session', (acc) => {
      const s = acc();
      s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
      s.on('shell', (a) => {
        const st = a();
        got[port] = '';
        // 终端屏幕上的提示符跟着 shell 走 (PowerShell 是 PS D:\…>)
        st.write(shell === 'powershell' ? 'PS D:\\示例工作区> ' : 'D:\\示例工作区> ');
        st.on('data', (d) => { got[port] += d; });
      });
      s.on('exec', (a, r, info) => {
        const ch = a(), cmd = info.command;
        const out = (t, code) => { if (t) ch.write(t); ch.exit(code); ch.end(); };
        // 分辨 shell 的那句话：cmd 原样打出 $env:OS，PowerShell 打出 %OS% 和 Windows_NT
        if (cmd === 'echo %OS%;$env:OS') return out(shell === 'cmd' ? 'Windows_NT;$env:OS\r\n' : '%OS%\r\nWindows_NT\r\n', 0);
        out('', 1);
      });
      s.on('sftp', (accept) => {
        const sf = accept();
        const hs = new Map(); let next = 1;
        const norm = (p) => (p === '.' || p === '' ? '/D:/示例工作区' : p.replace(/\/+$/, '') || '/');
        sf.on('REALPATH', (id, p) => {
          asked.push(p);
          const r = norm(p);
          if (!DIRS[r]) return sf.status(id, STATUS_CODE.NO_SUCH_FILE);
          sf.name(id, [{ filename: r, longname: r, attrs: {} }]);
        });
        sf.on('OPENDIR', (id, p) => {
          const r = norm(p);
          if (!DIRS[r]) return sf.status(id, STATUS_CODE.NO_SUCH_FILE);
          const h = Buffer.alloc(4); h.writeUInt32BE(next); hs.set(next++, { names: DIRS[r], done: false }); sf.handle(id, h);
        });
        sf.on('READDIR', (id, h) => {
          const d = hs.get(h.readUInt32BE());
          if (!d || d.done) return sf.status(id, STATUS_CODE.EOF);
          d.done = true;
          sf.name(id, d.names.map((n) => {
            const dir = !n.includes('.');
            return { filename: n, longname: n, attrs: { mode: (dir ? 0o040755 : 0o100644), size: 3, uid: 0, gid: 0, atime: 0, mtime: 1700000000 } };
          }));
        });
        sf.on('CLOSE', (id, h) => { hs.delete(h.readUInt32BE()); sf.status(id, STATUS_CODE.OK); });
      });
    }));
  }).listen(port, '127.0.0.1');
}
server(2297, 'cmd'); server(2299, 'powershell');

run(async () => {
  await addHost('WIN', 2297); await addHost('WINPS', 2299);
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('sshweb.hfOn', '0'); } catch {} }); // 状态悬浮窗会挡住文件面板的按钮
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'WIN' }).first().click(); await p.waitForSelector('.tab.active .dot.ok'); await wait(800);
  await p.click('#btnSftp'); await p.waitForSelector('.term.active .sftp .frow');
  const pathVal = () => p.inputValue('.term.active .sftp .path');
  ok(await pathVal() === 'D:/示例工作区', 'Windows 主机：路径框显示 D:/示例工作区 (不显示最前面的 /): ' + await pathVal());
  await p.dblclick('.term.active .sftp .frow.dir'); await wait(800);
  ok(await pathVal() === 'D:/示例工作区/项目' && (await p.textContent('.term.active .sftp .frow .fn')) === 'b.txt', '双击进文件夹：D:/示例工作区/项目: ' + await pathVal());
  asked.length = 0;
  await p.fill('.term.active .sftp .path', 'D:/示例工作区'); await p.press('.term.active .sftp .path', 'Enter'); await wait(800);
  ok(asked.includes('/D:/示例工作区') && await pathVal() === 'D:/示例工作区' && await p.locator('.term.active .sftp .frow').count() === 2, '手动输入 D:/示例工作区 回车：发给服务端时补回 /D:/…，能打开: ' + JSON.stringify(asked));

  // 「终端 cd」：按终端里的 shell 给写法
  const cdOn = async (port) => { got[port] = ''; await p.click('.term.active .sftp [data-a=cd]'); await wait(1200); return got[port]; };
  let g = await cdOn(2297);
  ok(g === 'cd /d "D:\\示例工作区"\r', '默认 cmd：发 cd /d "D:\\示例工作区" (换盘符也切得过去): ' + JSON.stringify(g));
  for (const [name, port, label] of [['WINPS', 2299, '默认 PowerShell']]) {
    await p.locator('.host', { hasText: name }).first().click(); await p.waitForSelector('.tab.active .dot.ok'); await wait(1000);
    await p.click('#btnSftp'); await p.waitForSelector('.term.active .sftp .frow');
    g = await cdOn(port);
    ok(g === "cd 'D:\\示例工作区'\r", `${label}：按 PowerShell 的写法发 cd 'D:\\示例工作区': ` + JSON.stringify(g));
  }
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close();
});
