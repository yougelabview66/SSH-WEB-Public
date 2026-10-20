'use strict';
// 文件预览：文件管理里点文件名 / 👁 —— 图片直接显示、文本 / 代码等宽显示、Markdown 排版、PDF 交给浏览器；
// 二进制 / 太大的文件给出提示；html / svg / Markdown 里的脚本都不会执行；双击照旧下载
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Server, utils: { sftp: { STATUS_CODE } } } = require('ssh2');
const { BASE, ok, wait, run, launch, shot, hostKey, addHost } = require('./helpers');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-pv-')));
// 2×2 的红色 PNG
function png() {
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.from([0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0, 0]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
fs.writeFileSync(path.join(root, 'pic.png'), png());
fs.writeFileSync(path.join(root, 'notes.md'), [
  '# 标题一', '', '一段 **粗体** 和 `code` 还有 [链接](https://example.com) 和 [相对](./a.md)。', '',
  '- 第一项', '- [x] 做完了', '  - 子项', '', '| 名字 | 值 |', '|---|---|', '| a | 1 |', '',
  '```js', 'const x = "<b>不加粗</b>";', '```', '', '> 引用', '',
  '<script>window.MDPWN = 1</script>', '<img src=x onerror="window.MDPWN = 2">',
].join('\n'));
fs.writeFileSync(path.join(root, 'code.js'), 'function hi() {\n\treturn "<tag>";\n}\n');
fs.writeFileSync(path.join(root, 'evil.html'), '<script>document.documentElement.dataset.pwned = 1</script><b>hi</b>');
fs.writeFileSync(path.join(root, 'evil.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>document.documentElement.setAttribute("data-pwned", "1")</script><rect width="10" height="10" fill="red"/></svg>');
fs.writeFileSync(path.join(root, 'big.txt'), Buffer.alloc(3 * 1024 * 1024, 'a'));
fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([1, 2, 0, 3, 4, 0, 0, 5]));
fs.writeFileSync(path.join(root, 'doc.pdf'), '%PDF-1.4\n%%EOF\n');

// 模拟 SSH 服务器：shell + 只读的 SFTP (列目录、读文件)
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => a().write('$ '));
    s.on('sftp', (accept) => {
      const sf = accept();
      const hs = new Map(); let next = 1;
      const handle = (v) => { const h = Buffer.alloc(4); h.writeUInt32BE(next); hs.set(next++, v); return h; };
      const get = (h) => hs.get(h.readUInt32BE());
      const err = (id) => sf.status(id, STATUS_CODE.NO_SUCH_FILE);
      const attrs = (st) => ({ mode: st.mode, uid: st.uid, gid: st.gid, size: st.size, atime: st.atimeMs / 1000 | 0, mtime: st.mtimeMs / 1000 | 0 });
      sf.on('REALPATH', (id, p) => { const r = p === '.' ? root : path.resolve(p); sf.name(id, [{ filename: r, longname: r, attrs: {} }]); });
      sf.on('STAT', (id, p) => { try { sf.attrs(id, attrs(fs.statSync(p))); } catch { err(id); } });
      sf.on('LSTAT', (id, p) => { try { sf.attrs(id, attrs(fs.lstatSync(p))); } catch { err(id); } });
      sf.on('OPENDIR', (id, p) => { try { sf.handle(id, handle({ dir: p, list: fs.readdirSync(p), done: false })); } catch { err(id); } });
      sf.on('READDIR', (id, h) => {
        const d = get(h);
        if (!d || d.done) return sf.status(id, STATUS_CODE.EOF);
        d.done = true;
        sf.name(id, d.list.map((n) => { const st = fs.statSync(path.join(d.dir, n)); return { filename: n, longname: n, attrs: attrs(st) }; }));
      });
      sf.on('OPEN', (id, p) => { try { sf.handle(id, handle({ fd: fs.openSync(p, 'r') })); } catch { err(id); } });
      sf.on('READ', (id, h, off, len) => {
        const f = get(h); const buf = Buffer.alloc(len);
        const n = fs.readSync(f.fd, buf, 0, len, off);
        if (!n) return sf.status(id, STATUS_CODE.EOF);
        sf.data(id, buf.subarray(0, n));
      });
      sf.on('CLOSE', (id, h) => { const f = get(h); if (f && f.fd != null) fs.closeSync(f.fd); hs.delete(h.readUInt32BE()); sf.status(id, STATUS_CODE.OK); });
    });
  }));
}).listen(2289, '127.0.0.1');

run(async () => {
  await addHost('PV', 2289);
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'PV' }).first().click(); await p.waitForSelector('.tab.active .dot.ok'); await wait(800);
  const sid = (await (await fetch(BASE + '/api/sessions')).json()).find((x) => x.status === 'connected')?.id;
  const url = (f, inline = true) => `${BASE}/api/sftp/${sid}/download?${inline ? 'inline=1&' : ''}path=${encodeURIComponent(path.join(root, f))}`;

  // 接口：类型、inline、不让脚本执行
  let r = await fetch(url('pic.png'));
  ok(r.headers.get('content-type') === 'image/png' && /^inline;/.test(r.headers.get('content-disposition')) && /sandbox/.test(r.headers.get('content-security-policy')),
    `图片按 image/png、inline 给，带沙箱 (${r.headers.get('content-type')} / ${r.headers.get('content-disposition')})`);
  r = await fetch(url('evil.html'));
  ok(/^text\/plain/.test(r.headers.get('content-type')) && r.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(r.headers.get('content-security-policy')),
    `html 按纯文本给、nosniff、带沙箱 (${r.headers.get('content-type')})`);
  r = await fetch(url('doc.pdf'));
  ok(r.headers.get('content-type') === 'application/pdf' && !/object-src 'none'|sandbox/.test(r.headers.get('content-security-policy') || ''), 'PDF 按原类型给，不带挡住 PDF 阅读器的策略');
  r = await fetch(url('big.txt'));
  ok(r.status === 413 && /太大/.test((await r.json()).error), '超过 2MB 的文本不预览：413 提示太大');
  r = await fetch(url('pic.png', false));
  ok(r.headers.get('content-type') === 'application/octet-stream' && /^attachment;/.test(r.headers.get('content-disposition')), '不带 inline 照旧是下载');

  // 直接打开 svg / html 的预览地址：里面的脚本不执行
  const q = await ctx.newPage();
  for (const f of ['evil.svg', 'evil.html']) {
    await q.goto(url(f)); await wait(300);
    ok(!(await q.evaluate(() => document.documentElement.getAttribute('data-pwned'))), `直接打开 ${f} 的预览地址，里面的脚本没有执行`);
  }
  await q.close();

  // 文件管理里预览
  await p.click('#btnSftp'); await p.waitForSelector('.sftp .frow');
  await p.fill('.sftp .path', root); await p.press('.sftp .path', 'Enter'); await p.waitForSelector('.sftp .frow:has-text("pic.png")');
  const row = (n) => p.locator('.sftp .frow', { hasText: n }).first();
  const openFile = async (n) => { await row(n).locator('.fn').click(); await wait(800); };
  const closeIt = async () => { await p.keyboard.press('Escape'); await wait(200); };

  await openFile('pic.png');
  ok(await p.evaluate(() => { const i = document.querySelector('.fpreview .fp-img'); return !!i && i.naturalWidth === 2; }), '点图片文件名：预览里显示图片');
  ok(await p.evaluate(() => document.querySelector('.fpreview .fp-name').textContent) === 'pic.png', '预览标题是文件名');
  await closeIt();
  ok(!(await p.$('.fpreview')), 'Esc 关掉预览');

  await openFile('notes.md');
  const md = await p.evaluate(() => { const m = document.querySelector('.fpreview .fp-md'); return m && {
    h1: m.querySelector('h1')?.textContent, strong: m.querySelector('strong')?.textContent, code: m.querySelector('p code')?.textContent,
    link: m.querySelector('a')?.getAttribute('href'), links: m.querySelectorAll('a').length, td: m.querySelector('td')?.textContent,
    pre: m.querySelector('pre code')?.textContent, quote: m.querySelector('blockquote')?.textContent.trim(), task: m.textContent.includes('☑ 做完了'),
    li: m.querySelectorAll('li').length, scripts: m.querySelectorAll('script, img').length, raw: m.textContent.includes('<script>window.MDPWN'), pwn: window.MDPWN };
  });
  ok(md && md.h1 === '标题一' && md.strong === '粗体' && md.code === 'code' && md.td === 'a' && md.li === 3 && md.task && md.quote === '引用', 'Markdown：标题、粗体、行内代码、表格、列表、任务、引用都排好了: ' + JSON.stringify(md));
  ok(md.link === 'https://example.com' && md.links === 1, 'Markdown：http 链接可点，相对路径的链接只显示文字');
  ok(md.pre === 'const x = "<b>不加粗</b>";', 'Markdown：代码块原样显示');
  ok(md.scripts === 0 && md.raw && md.pwn === undefined, 'Markdown 里的 <script> / <img onerror> 原样显示成文字，没有执行');
  await p.screenshot({ path: shot('preview-md.png') });
  await closeIt();

  await openFile('code.js');
  ok(await p.evaluate(() => document.querySelector('.fpreview pre.fp-text')?.textContent) === 'function hi() {\n\treturn "<tag>";\n}\n', '代码文件：等宽原样显示');
  await closeIt();

  await openFile('bin.dat');
  ok(/二进制/.test(await p.textContent('.fpreview .fp-body')), '二进制文件：提示不能预览');
  await closeIt();

  await openFile('big.txt');
  ok(/太大/.test(await p.textContent('.fpreview .fp-body')), '太大的文件：提示下载后查看');
  await closeIt();

  // 👁 按钮
  await row('code.js').hover(); await row('code.js').locator('[data-op=pv]').click(); await wait(600);
  ok(!!(await p.$('.fpreview pre.fp-text')), '👁 按钮也能预览');
  await p.click('.fpreview [data-a=close]'); await wait(200);
  ok(!(await p.$('.fpreview')), '× 关掉预览');

  // 双击照旧下载，不弹预览
  const dl = p.waitForEvent('download', { timeout: 5000 }).catch(() => null);
  await row('code.js').locator('.fn').dblclick();
  const d = await dl; await wait(600);
  ok(!!d && d.suggestedFilename() === 'code.js' && !(await p.$('.fpreview')), `双击文件照旧下载，不弹预览 (${d && d.suggestedFilename()})`);

  // PDF：交给浏览器在新标签页打开 (无界面浏览器里 PDF 会变成下载，这里只看打开的地址)
  await p.evaluate(() => { window.open = (u) => { window.__opened = u; return null; }; });
  await row('doc.pdf').locator('.fn').click(); await wait(600);
  const opened = await p.evaluate(() => window.__opened || '');
  ok(/inline=1/.test(opened) && opened.includes(encodeURIComponent('doc.pdf')) && !(await p.$('.fpreview')), 'PDF 在新标签页打开: ' + opened);

  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close();
  fs.rmSync(root, { recursive: true, force: true });
});
