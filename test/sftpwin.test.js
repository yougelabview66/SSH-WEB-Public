'use strict';
// 连的是 Windows 的 SSH (OpenSSH)：SFTP 路径是 /D:/xxx，文件面板的路径框显示时去掉盘符前面的 /；
// 在路径框里输入 D:/xxx 回车，发给服务端时补回 /D:/xxx
const { Server, utils: { sftp: { STATUS_CODE } } } = require('ssh2');
const { BASE, ok, wait, run, launch, hostKey, addHost } = require('./helpers');

// 模拟 Windows 的 SFTP：主目录 /D:/示例工作区，下面有个文件夹「项目」；只认 /D:/… 这种路径
const DIRS = { '/D:/示例工作区': ['项目', 'a.txt'], '/D:/示例工作区/项目': ['b.txt'], '/D:': ['示例工作区'] };
const asked = [];
let got = '';
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { const st = a(); st.write('D:\\示例工作区> '); st.on('data', (d) => { got += d; }); });
    s.on('exec', (a) => { a(); });
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
}).listen(2297, '127.0.0.1');

run(async () => {
  await addHost('WIN', 2297);
  const browser = await launch();
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'WIN' }).first().click(); await p.waitForSelector('.tab.active .dot.ok'); await wait(800);
  await p.click('#btnSftp'); await p.waitForSelector('.sftp .frow');
  const pathVal = () => p.inputValue('.sftp .path');
  ok(await pathVal() === 'D:/示例工作区', 'Windows 主机：路径框显示 D:/示例工作区 (不显示最前面的 /): ' + await pathVal());
  await p.dblclick('.sftp .frow.dir'); await wait(800);
  ok(await pathVal() === 'D:/示例工作区/项目' && (await p.textContent('.sftp .frow .fn')) === 'b.txt', '双击进文件夹：D:/示例工作区/项目: ' + await pathVal());
  asked.length = 0;
  await p.fill('.sftp .path', 'D:/示例工作区'); await p.press('.sftp .path', 'Enter'); await wait(800);
  ok(asked.includes('/D:/示例工作区') && await pathVal() === 'D:/示例工作区' && await p.locator('.sftp .frow').count() === 2, '手动输入 D:/示例工作区 回车：发给服务端时补回 /D:/…，能打开: ' + JSON.stringify(asked));
  got = '';
  await p.click('.sftp [data-a=cd]'); await wait(600);
  ok(got === 'cd /d "D:\\示例工作区"\r', '「cd 到这里」：按 cmd 的写法发 cd /d "D:\\示例工作区": ' + JSON.stringify(got));
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close();
});
