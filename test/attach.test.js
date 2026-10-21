'use strict';
// 图片 / 文件发给 Claude：电脑上拖到终端、粘贴截图，手机上点 📎 —— 传到目标主机的 ~/.cache/ssh-web/uploads，
// 路径填进输入框 (不发送)；剪贴板里有文字时照常粘贴文字；下方输入框关着时直接打进终端；7 天前的旧附件删掉；
// 别的设备在用 (锁着) 时不上传
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Server, utils: { sftp: { OPEN_MODE, STATUS_CODE } } } = require('ssh2');
const { BASE, ok, wait, run, launch, shot, hostKey, addHost, devices } = require('./helpers');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-att-')));
const upDir = path.join(home, '.cache', 'ssh-web', 'uploads');
let got = '';

// 模拟 SSH 服务器：shell (记下收到的输入) + SFTP (相对路径都在 home 下，和 OpenSSH 一样)
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { const st = a(); st.write('$ '); st.on('data', (d) => { got += d; }); });
    s.on('sftp', (accept) => {
      const sf = accept();
      const hs = new Map(); let next = 1;
      const abs = (p) => path.resolve(home, p);
      const handle = (v) => { const h = Buffer.alloc(4); h.writeUInt32BE(next); hs.set(next++, v); return h; };
      const get = (h) => hs.get(h.readUInt32BE());
      const okr = (id) => sf.status(id, STATUS_CODE.OK);
      const err = (id, e) => sf.status(id, e && e.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE);
      const attrs = (st) => ({ mode: st.mode, uid: st.uid, gid: st.gid, size: st.size, atime: st.atimeMs / 1000 | 0, mtime: st.mtimeMs / 1000 | 0 });
      const fsFlags = (f) => (f & OPEN_MODE.WRITE ? fs.constants.O_WRONLY : fs.constants.O_RDONLY)
        | (f & OPEN_MODE.CREAT ? fs.constants.O_CREAT : 0) | (f & OPEN_MODE.TRUNC ? fs.constants.O_TRUNC : 0) | (f & OPEN_MODE.EXCL ? fs.constants.O_EXCL : 0);
      sf.on('REALPATH', (id, p) => { const r = abs(p); sf.name(id, [{ filename: r, longname: r, attrs: {} }]); });
      sf.on('STAT', (id, p) => { try { sf.attrs(id, attrs(fs.statSync(abs(p)))); } catch (e) { err(id, e); } });
      sf.on('LSTAT', (id, p) => { try { sf.attrs(id, attrs(fs.lstatSync(abs(p)))); } catch (e) { err(id, e); } });
      sf.on('MKDIR', (id, p) => { try { fs.mkdirSync(abs(p)); okr(id); } catch (e) { err(id, e); } });
      sf.on('OPENDIR', (id, p) => { try { sf.handle(id, handle({ dir: abs(p), list: fs.readdirSync(abs(p)), done: false })); } catch (e) { err(id, e); } });
      sf.on('READDIR', (id, h) => {
        const d = get(h);
        if (!d || d.done) return sf.status(id, STATUS_CODE.EOF);
        d.done = true;
        sf.name(id, d.list.map((n) => ({ filename: n, longname: n, attrs: attrs(fs.statSync(path.join(d.dir, n))) })));
      });
      sf.on('OPEN', (id, p, flags) => { try { sf.handle(id, handle({ fd: fs.openSync(abs(p), fsFlags(flags), 0o644) })); } catch (e) { err(id, e); } });
      sf.on('WRITE', (id, h, off, data) => { try { fs.writeSync(get(h).fd, data, 0, data.length, off); okr(id); } catch (e) { err(id, e); } });
      sf.on('CLOSE', (id, h) => { const f = get(h); if (f && f.fd != null) fs.closeSync(f.fd); hs.delete(h.readUInt32BE()); okr(id); });
      sf.on('RENAME', (id, a, b) => { if (fs.existsSync(abs(b))) return err(id); try { fs.renameSync(abs(a), abs(b)); okr(id); } catch (e) { err(id, e); } });
      sf.on('REMOVE', (id, p) => { try { fs.unlinkSync(abs(p)); okr(id); } catch (e) { err(id, e); } });
      sf.on('SETSTAT', (id) => okr(id));
    });
  }));
}).listen(2290, '127.0.0.1');

const uploads = () => (fs.existsSync(upDir) ? fs.readdirSync(upDir).filter((f) => !f.includes('.sshweb-')).sort() : []);
// 在页面里把文件拖到 sel 上 / 粘贴到 sel
const drop = (pg, sel, name, text) => pg.evaluate(([sel, name, text]) => {
  const el = document.querySelector(sel);
  const dt = new DataTransfer();
  dt.items.add(new File([text], name, { type: 'text/plain' }));
  for (const t of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
}, [sel, name, text]);
const paste = (pg, sel, withText) => pg.evaluate(([sel, withText]) => {
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' }));
  if (withText) dt.setData('text/plain', 'TEXT');
  return document.querySelector(sel).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, [sel, withText]);

run(async () => {
  await addHost('AT', 2290);
  // 一个 8 天前的旧附件：这次上传后应该被删掉
  fs.mkdirSync(upDir, { recursive: true });
  const oldF = path.join(upDir, 'old.txt');
  fs.writeFileSync(oldF, 'old'); const t8 = Date.now() / 1000 - 8 * 86400; fs.utimesSync(oldF, t8, t8);

  const browser = await launch();
  const errors = [];
  const d = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  d.on('pageerror', (e) => errors.push(e.message));
  await d.goto(BASE + '/'); await d.waitForSelector('#app:not(.hidden)');
  await d.locator('.host', { hasText: 'AT' }).first().click(); await d.waitForSelector('.tab.active .dot.ok'); await wait(800);
  const dval = () => d.evaluate(() => document.getElementById('dInput').value);

  // 拖文件到终端
  got = '';
  await drop(d, '.term.active .term-box', 'my file.txt', 'hello');
  await wait(1500);
  let up = uploads();
  const f1 = up.find((f) => f.endsWith('-my_file.txt'));
  ok(!!f1 && fs.readFileSync(path.join(upDir, f1), 'utf8') === 'hello', '拖文件到终端：传到目标主机的 ~/.cache/ssh-web/uploads (文件名里的空格换成 _): ' + up.join(','));
  ok(await dval() === path.join(upDir, f1) + ' ' && got === '', '路径填进下方输入框，没有发送: ' + JSON.stringify(await dval()));
  ok(!fs.existsSync(oldF), '7 天前的旧附件删掉了');

  // 输入框里粘贴截图：接在后面 (隔一个空格)
  await d.evaluate(() => { const t = document.getElementById('dInput'); t.value = '看看这个图'; t.setSelectionRange(t.value.length, t.value.length); t.dispatchEvent(new Event('input')); });
  const notCanceled = await paste(d, '#dInput', false);
  await wait(1500);
  up = uploads();
  const f2 = up.find((f) => f.endsWith('-image.png'));
  ok(!notCanceled && !!f2 && fs.statSync(path.join(upDir, f2)).size === 4, '粘贴截图：传上去了 (没有再按文字粘贴): ' + up.join(','));
  ok(await dval() === `看看这个图 ${path.join(upDir, f2)} ` && got === '', '截图路径接在输入框文字后面，没有发送: ' + JSON.stringify(await dval()));

  // 剪贴板里有文字：照常粘贴文字，不上传
  const n0 = uploads().length;
  const notCanceled2 = await paste(d, '#dInput', true); await wait(800);
  ok(notCanceled2 && uploads().length === n0, '剪贴板里有文字时不拦，照常粘贴文字');

  // 下方输入框关着：路径直接打进终端
  await d.click('#dHide'); await wait(300);
  got = '';
  await drop(d, '.term.active .term-box', 'a.txt', 'A');
  await wait(1500);
  const f3 = uploads().find((f) => f.endsWith('-a.txt'));
  ok(!!f3 && got === path.join(upDir, f3) + ' ', '输入框关着：路径直接打进终端 (不回车): ' + JSON.stringify(got));
  await d.click('#btnInput'); await wait(300);

  // 拖到页面别处：不打开文件、不上传
  const n1 = uploads().length;
  const canceled = await d.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'x.txt')); const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }); document.querySelector('.tabs, #tabs, header, body').dispatchEvent(ev); return ev.defaultPrevented; });
  await wait(800);
  ok(canceled && uploads().length === n1, '拖到页面别处：不上传，也不让浏览器打开这个文件');

  // 电脑：下方输入框的 📎 (同手机)
  await d.evaluate(() => { const t = document.getElementById('dInput'); t.value = ''; t.dispatchEvent(new Event('input')); });
  got = '';
  const dch = d.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
  await d.click('#dAttach');
  const dfc = await dch;
  ok(!!dfc && await d.isVisible('#dAttach'), '电脑下方输入框也有 📎，点了弹出选择文件');
  if (dfc) await dfc.setFiles({ name: 'desk-pick.png', mimeType: 'image/png', buffer: Buffer.from('PNG') });
  await wait(1500);
  const f5 = uploads().find((f) => f.endsWith('-desk-pick.png'));
  ok(!!f5 && await dval() === path.join(upDir, f5) + ' ' && got === '' && await d.evaluate(() => document.activeElement.id) === 'dInput', '电脑选的文件传上去了，路径填进下方输入框，没有发送，光标在输入框里: ' + JSON.stringify(await dval()));
  await d.screenshot({ path: shot('attach-desk-button.png'), clip: { x: 250, y: 720, width: 1030, height: 80 } });
  // 📎：窄一点，和旁边的按钮一样高、一样带边框
  const box = () => d.evaluate(() => { const a = document.getElementById('dAttach'), r = a.getBoundingClientRect(), sd = document.getElementById('dSend').getBoundingClientRect(), cs = getComputedStyle(a);
    return { w: Math.round(r.width), h: Math.round(r.height), sh: Math.round(sd.height), top: Math.abs(r.top - sd.top), border: cs.borderTopStyle !== 'none' && cs.borderTopWidth !== '0px' }; });
  let bx = await box();
  ok(bx.w === 34 && bx.h === bx.sh && bx.top < 1 && bx.border, '📎 宽 34px，和发送按钮一样高、一样带边框: ' + JSON.stringify(bx));

  // 手机：点 📎 选图片
  const m = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
  m.on('pageerror', (e) => errors.push(e.message));
  await m.goto(BASE + '/'); await m.waitForSelector('#app:not(.hidden)'); await wait(1500);
  await m.evaluate(() => document.querySelector('.term.active .owner-notice button')?.click()); await wait(600); // 电脑在用：先接管
  const mtext = () => m.evaluate(() => document.getElementById('mInput').value.replace(/​/g, ''));
  got = '';
  const chooser = m.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
  await m.tap('#mAttach');
  const fc = await chooser;
  ok(!!fc, '手机点 📎：弹出选择文件');
  if (fc) await fc.setFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('JPEG') });
  await wait(1500);
  const f4 = uploads().find((f) => f.endsWith('-photo.jpg'));
  await m.screenshot({ path: shot('attach-mobile.png') });
  ok(!!f4 && await mtext() === path.join(upDir, f4) + ' ' && got === '', '手机选的图传上去了，路径填进输入栏，没有发送: ' + JSON.stringify(await mtext()));

  // 电脑这边现在被手机锁着：拖文件不上传
  const n2 = uploads().length;
  await drop(d, '.term.active .term-box', 'locked.txt', 'L'); await wait(1200);
  ok(uploads().length === n2 && !uploads().some((f) => f.endsWith('-locked.txt')), '别的设备在用 (锁着) 时拖文件不上传');

  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close();
  fs.rmSync(home, { recursive: true, force: true });
});
