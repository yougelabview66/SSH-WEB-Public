'use strict';
// 右边栏 (参考 Orca / VS Code)：两个选项卡「项目」(文件夹树 + 快速打开) 和「改动」(代码改动 + 批注)，共用一个项目目录。
// 项目：点开文件夹才读那一层，改过的文件按 git 状态上色、文件夹带圆点，点文件预览，「⋯」发路径给 Agent / 看改动；
//   搜索框按文件名模糊搜索 (跳过 .gitignore 的)，↑↓ 回车打开，最近打开的排前面，Ctrl+Shift+P 跳到搜索框。
// 改动：改了哪些文件、红绿对比，在改动的行上写批注 (Shift 选一段)，「发给 Agent」整理成一段话填进输入框 (不发送)。
// 电脑上展开时固定在右边 (终端变窄、可拖宽度)，收起成右边缘一列图标；手机上全屏。
// 模拟的 SSH 服务器：命令在本机真的跑 (真的 git 仓库)，SFTP 读本机文件；项目目录自动找：这个标签里程序的当前目录 (/proc)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync, spawn } = require('child_process');
const { Server, utils: { sftp: { OPEN_MODE, STATUS_CODE } } } = require('ssh2');
const { BASE, ok, wait, run, launch, shot, hostKey, addHost, devices } = require('./helpers');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-rb-')));
const repo = path.join(home, 'proj');
const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' }).toString();
fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
fs.writeFileSync(path.join(repo, 'a.txt'), 'a\nb\nc\n');
fs.writeFileSync(path.join(repo, 'sub', '中文 名.txt'), 'x\n');
fs.writeFileSync(path.join(repo, 'gone.txt'), 'del\n');
fs.writeFileSync(path.join(repo, 'README.md'), '# 说明\n');
g('add', '-A'); g('commit', '-qm', 'init');
fs.writeFileSync(path.join(repo, 'a.txt'), 'a\nB2\nc\nd\n'); // 改一行、加一行
fs.unlinkSync(path.join(repo, 'gone.txt'));
fs.writeFileSync(path.join(repo, 'new.txt'), 'new\nfile\n');
g('mv', 'sub/中文 名.txt', 'sub/renamed.txt');
fs.mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
fs.writeFileSync(path.join(repo, 'node_modules', 'pkg', 'renamed-in-deps.txt'), 'x\n'); // 被 .gitignore 跳过：搜不到

let got = '', shellSt = null;
const kids = [];
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { const st = shellSt = a(); st.write('$ '); st.on('data', (d) => { got += d; }); });
    s.on('exec', (a, r, info) => {
      const ch = a();
      if (info.command.includes('hook.log') || info.command === 'sh') return;
      const p = execFile('sh', ['-c', info.command], { cwd: home, env: { HOME: home, PATH: process.env.PATH }, encoding: 'buffer', maxBuffer: 1 << 26 }, () => {});
      p.stdout.on('data', (d) => ch.write(d));
      p.on('close', (code) => { ch.exit(code || 0); ch.end(); });
    });
    s.on('sftp', (accept) => {
      const sf = accept();
      const hs = new Map(); let next = 1;
      const abs = (p) => path.resolve(home, p);
      const handle = (v) => { const h = Buffer.alloc(4); h.writeUInt32BE(next); hs.set(next++, v); return h; };
      const get = (h) => hs.get(h.readUInt32BE());
      const attrs = (st) => ({ mode: st.mode, uid: 0, gid: 0, size: st.size, atime: st.atimeMs / 1000 | 0, mtime: st.mtimeMs / 1000 | 0 });
      const nf = (id) => sf.status(id, STATUS_CODE.NO_SUCH_FILE);
      sf.on('REALPATH', (id, p) => { const r = abs(p); sf.name(id, [{ filename: r, longname: r, attrs: {} }]); });
      sf.on('STAT', (id, p) => { try { sf.attrs(id, attrs(fs.statSync(abs(p)))); } catch { nf(id); } });
      sf.on('LSTAT', (id, p) => { try { sf.attrs(id, attrs(fs.lstatSync(abs(p)))); } catch { nf(id); } });
      sf.on('OPENDIR', (id, p) => { const l = abs(p); if (!fs.existsSync(l) || !fs.statSync(l).isDirectory()) return nf(id); sf.handle(id, handle({ dir: l, done: false })); });
      sf.on('READDIR', (id, h) => {
        const d = get(h);
        if (!d || d.done) return sf.status(id, STATUS_CODE.EOF);
        d.done = true;
        sf.name(id, fs.readdirSync(d.dir).map((n) => ({ filename: n, longname: n, attrs: attrs(fs.lstatSync(path.join(d.dir, n))) })));
      });
      sf.on('OPEN', (id, p, flags) => { if (!(flags & OPEN_MODE.READ)) return sf.status(id, STATUS_CODE.FAILURE); try { sf.handle(id, handle({ fd: fs.openSync(abs(p), 'r') })); } catch { nf(id); } });
      sf.on('READ', (id, h, off, len) => { const buf = Buffer.alloc(len); const n = fs.readSync(get(h).fd, buf, 0, len, off); if (!n) return sf.status(id, STATUS_CODE.EOF); sf.data(id, buf.subarray(0, n)); });
      sf.on('FSTAT', (id, h) => { try { sf.attrs(id, attrs(fs.fstatSync(get(h).fd))); } catch { nf(id); } });
      sf.on('CLOSE', (id, h) => { const f = get(h); if (f && f.fd != null) fs.closeSync(f.fd); hs.delete(h.readUInt32BE()); sf.status(id, STATUS_CODE.OK); });
    });
  }));
}).listen(2304, '127.0.0.1');

run(async () => {
  await addHost('RB', 2304);
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await ctx.addInitScript(() => { try { localStorage.setItem('sshweb.hfOn', '0'); } catch {} });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.accept());
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'RB' }).first().click(); await p.waitForSelector('.tab.active .dot.ok'); await wait(800);
  const sid = (await (await fetch(BASE + '/api/sessions')).json())[0].id;
  // 终端里「正在跑的程序」：带这个标签的标记 (LC_SSHWEB)，当前目录在仓库的子目录里
  kids.push(spawn('sleep', ['300'], { cwd: path.join(repo, 'sub'), env: { LC_SSHWEB: sid, PATH: process.env.PATH }, stdio: 'ignore' }));
  ok(!(await p.evaluate(() => document.querySelector('.term.active').dataset.winpty)), 'Linux 主机：不开 windowsPty (照常重新折行)');
  got = '';
  shellSt.write('\x1b[c\x1b]11;?\x07\x1b[6n'); await wait(800);
  ok(/\x1b\[\?[\d;]*c/.test(got) && /rgb:/.test(got) && /\x1b\[\d+;\d+R/.test(got), 'Linux 主机：终端型号、颜色、光标位置照常回答: ' + JSON.stringify(got));
  const termW = () => p.evaluate(() => Math.round(document.querySelector('.term.active .term-box').getBoundingClientRect().width));
  const w0 = await termW();
  const RB = '#rightBar';

  // ======== 项目：文件夹树
  await p.click('#btnMore'); await wait(200);
  { const r = await p.locator('#morePop').boundingBox(); await p.screenshot({ path: shot('menu-icons.png'), clip: { x: r.x - 4, y: r.y - 4, width: r.width + 8, height: r.height + 8 } }); }
  await p.click('#btnProj');
  await p.waitForSelector(`${RB} .pf-row`);
  const tabs = await p.$$eval(`${RB} .rb-tabs button`, (xs) => xs.map((x) => [x.dataset.tab, x.classList.contains('on'), !!x.querySelector('svg.ic')]));
  ok(JSON.stringify(tabs) === JSON.stringify([['files', true, true], ['git', false, true]]), '右边栏两个选项卡：项目 (第一个，打开着)、改动，都是线条图标: ' + JSON.stringify(tabs));
  const emo = await p.evaluate(() => { const ic = document.querySelector('#btnProj svg.emo').getBoundingClientRect(), mon = document.getElementById('btnMon');
    const t = document.createRange(); t.setStart(mon.firstChild, 0); t.setEnd(mon.firstChild, 2); const e = t.getBoundingClientRect(); return { w: Math.round(ic.width), ew: Math.round(e.width), filled: !!document.querySelector('#btnProj svg.emo path[fill="#bfdbfe"]') }; });
  ok(emo.filled && Math.abs(emo.w - emo.ew) <= 4, '「⋯ 更多」里「项目文件」的图标：彩色、大小和其他 emoji 图标一样: ' + JSON.stringify(emo));
  const headBtns = await p.$$eval(`${RB} .rb-head > button`, (xs) => xs.filter((x) => getComputedStyle(x).display !== 'none').map((x) => x.dataset.a));
  await p.screenshot({ path: shot('rb-head-desk.png'), clip: { x: 840, y: 0, width: 440, height: 90 } });
  const edge = await p.evaluate(() => { const b = document.querySelector('#rightBar [data-a=collapse]').getBoundingClientRect(), r = document.getElementById('rightBar').getBoundingClientRect(); return Math.round(r.right - b.right); });
  ok(edge <= 10, `「»」贴着右边栏的右边 (离右边 ${edge}px)`);
  ok(JSON.stringify(headBtns) === JSON.stringify(['refresh', 'collapse']), '电脑：右上角只有刷新和「»」收起 (没有重复的关闭)，「»」在最右边: ' + JSON.stringify(headBtns));
  const rowLook = await p.evaluate(() => { const r = document.querySelector('#rightBar .pf-row[data-rel="a.txt"]'); return { icon: !!r.querySelector('svg.fi'), fs: getComputedStyle(r).fontSize, color: getComputedStyle(r.querySelector('.pf-name')).color, st: r.querySelector('.pf-st').textContent }; });
  ok(rowLook.icon && rowLook.fs === '13px' && rowLook.st === 'M' && rowLook.color !== 'rgb(15, 23, 42)', '文件树样式：类型图标、13px 字、改过的文件名用 git 状态色、右边状态字母: ' + JSON.stringify(rowLook));
  // 彩色图标 (同 Antigravity / VS Code)：Markdown 蓝色 M↓、.gitignore 红色 git、node_modules 文件夹带绿点、普通文件夹不带
  const icons = await p.evaluate(() => {
    const ic = (rel) => document.querySelector(`#rightBar .pf-row[data-rel="${rel}"] svg.fi`);
    return { md: ic('README.md')?.querySelector('path')?.getAttribute('stroke'), git: ic('.gitignore')?.querySelector('path')?.getAttribute('fill'),
      nm: [...(ic('node_modules')?.querySelectorAll('circle') || [])].map((c) => c.getAttribute('fill')), sub: ic('sub')?.querySelectorAll('circle').length, w: ic('README.md')?.getBoundingClientRect().width };
  });
  ok(icons.md === '#519aba' && icons.git === '#f05033' && icons.nm.includes('#8bc34a') && icons.sub === 0 && icons.w === 16, '彩色图标：Markdown 蓝色 M↓、.gitignore 红色 git、node_modules 带绿点、普通文件夹不带，16px: ' + JSON.stringify(icons));
  await p.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark')); await wait(200);
  await p.locator(RB).screenshot({ path: shot('rb-icons-dark.png') });
  await p.evaluate(() => document.documentElement.removeAttribute('data-theme')); await wait(200);
  await p.locator(RB).screenshot({ path: shot('rb-icons-light.png') });
  const rows = () => p.$$eval(`${RB} .pf-row`, (xs) => xs.map((x) => [x.querySelector('.pf-name').textContent, x.dataset.dir ? 'd' : 'f', (x.className.match(/st-(\w+)/) || [])[1] || '', !!x.querySelector('.pf-dot'), x.classList.contains('heavy')]));
  let rs = await rows();
  ok(rs.some(([n, t, , dot]) => n === 'sub' && t === 'd' && dot) && rs.some(([n, , st]) => n === 'a.txt' && st === 'modified') && rs.some(([n, , st]) => n === 'new.txt' && st === 'untracked')
    && rs.some(([n, , , , heavy]) => n === 'node_modules' && heavy) && !rs.some(([n]) => n === '.git') && rs[0][1] === 'd',
  '文件夹树：文件夹在前，隐藏 .git，node_modules 变灰，改过的文件按状态上色，里面有改动的文件夹带圆点: ' + JSON.stringify(rs));
  ok(await p.textContent(`${RB} .rb-src`) === '终端所在的目录' && await termW() < w0 - 300, '项目目录自动找到 (仓库根目录)，展开时终端变窄');
  await p.click(`${RB} .pf-row[data-rel="sub"]`); await wait(800);
  rs = await rows();
  ok(rs.some(([n, , st]) => n === 'renamed.txt' && st === 'renamed'), '点文件夹：展开读出下一层 (改名的文件标出来)');
  await p.screenshot({ path: shot('rb-files.png') });
  await p.click(`${RB} .pf-row[data-rel="README.md"]`); await p.waitForSelector('.fpreview .fp-body h1', { timeout: 5000 }).catch(() => {});
  ok(await p.isVisible('.fpreview') && /说明/.test(await p.textContent('.fpreview .fp-body')), '点文件：直接预览 (Markdown)');
  await p.keyboard.press('Escape'); await wait(300);
  // 「⋯」：发路径给 Agent / 看改动
  await p.hover(`${RB} .pf-row[data-rel="a.txt"]`); await p.click(`${RB} .pf-row[data-rel="a.txt"] .pf-more`);
  const menu = await p.$$eval(`${RB} .pf-menu button`, (xs) => xs.map((x) => x.textContent));
  ok(JSON.stringify(menu) === JSON.stringify(['预览', '发路径给 Agent', '复制路径', '下载', '看改动']), '「⋯」：预览 / 发路径给 Agent / 复制路径 / 下载 / 看改动 (改过的才有): ' + JSON.stringify(menu));
  await p.click(`${RB} .pf-menu [data-m=agent]`); await wait(300);
  ok((await p.inputValue('#dInput')).trim() === path.join(repo, 'a.txt'), '发路径给 Agent：路径填进下方输入框');
  await p.fill('#dInput', '');
  await p.hover(`${RB} .pf-row[data-rel="a.txt"]`); await p.click(`${RB} .pf-row[data-rel="a.txt"] .pf-more`); await p.click(`${RB} .pf-menu [data-m=diff]`);
  await p.waitForSelector(`${RB} .gl.add`);
  ok(await p.evaluate(() => document.querySelector('#rightBar .rb-tabs .on').dataset.tab) === 'git' && (await p.textContent(`${RB} .gp-fpath`)) === 'a.txt', '「看改动」：切到「改动」选项卡，打开这个文件的改动');

  // ======== 快速打开：搜索框
  await p.click(`${RB} .rb-tabs [data-tab=files]`);
  await p.click('.term.active .term-box'); await wait(200);
  await p.keyboard.press('Control+Shift+P'); await wait(300);
  ok(await p.evaluate(() => document.activeElement.matches('#rightBar .pf-search input')), 'Ctrl+Shift+P：光标跳到「项目」的搜索框');
  await p.keyboard.type('ren'); await wait(1200);
  const hits = () => p.$$eval(`${RB} .pf-hit`, (xs) => xs.map((x) => x.dataset.rel));
  let hs = await hits();
  ok(hs[0] === 'sub/renamed.txt' && !hs.some((x) => x.includes('node_modules')) && await p.locator(`${RB} .pf-hit.sel em`).count() === 3, '模糊搜索：找到 sub/renamed.txt，匹配的字母高亮，跳过 .gitignore 里的: ' + JSON.stringify(hs));
  await p.keyboard.press('Enter'); await wait(800);
  ok(await p.isVisible('.fpreview') && (await p.textContent('.fpreview .fp-name')) === 'renamed.txt', '回车：预览选中的文件');
  await p.keyboard.press('Escape'); await wait(300);
  await p.fill(`${RB} .pf-search input`, 'txt'); await wait(600);
  hs = await hits();
  ok(hs[0] === 'sub/renamed.txt' && hs.includes('a.txt') && hs.includes('new.txt'), '最近打开过的排前面: ' + JSON.stringify(hs));
  await p.press(`${RB} .pf-search input`, 'ArrowDown'); await wait(200);
  ok((await p.getAttribute(`${RB} .pf-hit.sel`, 'data-rel')) === hs[1], '↓：选下一个');
  await p.press(`${RB} .pf-search input`, 'Escape'); await wait(300);
  ok(await p.inputValue(`${RB} .pf-search input`) === '' && await p.locator(`${RB} .pf-row`).count() > 3, 'Esc：清空搜索，回到文件夹树');
  await p.screenshot({ path: shot('rb-search.png') });

  // ======== 改动：列表、批注、发给 Agent
  await p.click(`${RB} .rb-tabs [data-tab=git]`);
  await p.click(`${RB} [data-a=back]`).catch(() => {});
  await p.waitForSelector(`${RB} .gp-file`);
  const files = await p.$$eval(`${RB} .gp-file`, (xs) => xs.map((x) => [x.querySelector('.gp-st').textContent, x.querySelector('.gp-name b').textContent, x.querySelector('.gp-cnt').textContent.trim()]));
  ok(files.length === 4 && files.some(([s, n, c]) => s === 'M' && n === 'a.txt' && c === '+2 −1') && files.some(([s, n]) => s === 'D' && n === 'gone.txt')
    && files.some(([s, n]) => s === 'R' && n === 'renamed.txt') && files.some(([s, n]) => s === '新' && n === 'new.txt') && (await p.textContent(`${RB} .rb-tabs .rb-count`)) === '4',
  '「改动」：修改 (带增删行数) / 删除 / 改名 / 新文件，选项卡上显示改动数: ' + JSON.stringify(files));
  await p.click(`${RB} .gp-file:has-text("a.txt")`); await p.waitForSelector(`${RB} .gl.add`);
  const dl = await p.$$eval(`${RB} .gl[data-i]`, (xs) => xs.map((x) => x.className.replace('gl ', '') + ':' + x.querySelector('.no').textContent + ':' + x.querySelector('code').textContent));
  ok(JSON.stringify(dl) === JSON.stringify(['ctx:1:a', 'del:2:b', 'add:2:B2', 'ctx:3:c', 'add:4:d']), '红绿对比，带行号 (删掉的显示旧行号): ' + JSON.stringify(dl));
  await p.click(`${RB} .gl.add:has-text("B2")`);
  await p.fill(`${RB} .gp-edit textarea`, '这里改回小写');
  await p.click(`${RB} [data-a=addnote]`); await wait(200);
  await p.click(`${RB} .gl.ctx:has-text("c")`);
  await p.click(`${RB} .gl.add:has-text("d")`, { modifiers: ['Shift'] });
  ok(await p.locator(`${RB} .gl.sel`).count() === 2, 'Shift + 点：选中一段 (两行)');
  await p.fill(`${RB} .gp-edit textarea`, '最后这两行合成一行');
  await p.press(`${RB} .gp-edit textarea`, 'Control+Enter'); await wait(200);
  const notes = await p.$$eval(`${RB} .gp-note`, (xs) => xs.map((x) => x.textContent.replace('✕', '').trim()));
  ok(JSON.stringify(notes) === JSON.stringify(['第 2 行这里改回小写', '第 3–4 行最后这两行合成一行']) && await p.textContent(`${RB} .gp-ncount`) === '批注 2 条', '批注挂在行下面，上面显示条数: ' + JSON.stringify(notes));
  await p.screenshot({ path: shot('rb-diff.png') });
  await p.click(`${RB} [data-a=back]`); await wait(200);
  ok((await p.textContent(`${RB} .gp-file:has-text("a.txt") .gp-nb`)) === '✎2', '回到列表：有批注的文件带 ✎2');
  await p.click(`${RB} .gp-file:has-text("new.txt")`); await p.waitForSelector(`${RB} .gl.add`);
  ok(JSON.stringify(await p.$$eval(`${RB} .gl[data-i]`, (xs) => xs.map((x) => x.className))) === JSON.stringify(['gl add', 'gl add']), '未跟踪的新文件：整个文件算新增');
  await p.click(`${RB} [data-a=back]`);
  await p.click(`${RB} .gp-file:has-text("gone.txt")`); await p.waitForSelector(`${RB} .gl.del`);
  await p.click(`${RB} .gl.del`);
  await p.fill(`${RB} .gp-edit textarea`, '这个文件不要删');
  await p.click(`${RB} [data-a=addnote]`); await wait(200);
  await p.click(`${RB} [data-a=back]`);
  got = '';
  await p.click(`${RB} [data-a=send]`); await wait(300);
  const want = `请按下面的批注修改代码（路径相对 ${repo}）：\n1. a.txt 第 2 行（B2）：这里改回小写\n2. a.txt 第 3–4 行（c）：最后这两行合成一行\n3. gone.txt 删掉的第 1 行（del）：这个文件不要删`;
  ok(await p.inputValue('#dInput') === want && got === '' && await p.isHidden(`${RB} .gp-notes`), '「发给 Agent」：批注整理成一段话填进输入框，没有发送，批注清空: ' + JSON.stringify(await p.inputValue('#dInput')));

  // ======== 刷新、拖宽度、收起成一列图标、展开、关闭
  fs.writeFileSync(path.join(repo, 'later.txt'), 'x\n');
  await p.click(`${RB} [data-a=refresh]`);
  for (let i = 0; i < 50 && await p.locator(`${RB} .gp-file`).count() !== 5; i++) await wait(100);
  ok(await p.locator(`${RB} .gp-file`).count() === 5, '⟳ 刷新：新改的文件出现了');
  const pb = await p.locator(RB).boundingBox();
  const screenW = () => p.evaluate(() => Math.round(document.querySelector('.term.active .xterm-screen').getBoundingClientRect().width));
  const sw0 = await screenW();
  await p.mouse.move(pb.x + 1, pb.y + 300); await p.mouse.down(); await p.mouse.move(pb.x - 99, pb.y + 300, { steps: 5 }); await wait(300);
  const swMid = await screenW();
  await p.mouse.up(); await wait(400);
  const nw = Math.round((await p.locator(RB).boundingBox()).width), sw1 = await screenW();
  ok(Math.abs(nw - (pb.width + 100)) <= 2 && await p.evaluate(() => localStorage.getItem('sshweb.rbW')) == nw, `拖左边缘调宽度并记住 (${Math.round(pb.width)} → ${nw})`);
  ok(swMid === sw0 && sw1 < sw0 - 50, `拖的过程中终端不重排 (不卡)，松手才按新宽度排一次 (${sw0} → 拖着 ${swMid} → 松手 ${sw1})`);
  // 窗口窄、左右两边栏都开着：顶栏按钮放不下时只留图标，「⋯ 更多」不压到右边栏的「项目」上
  await p.setViewportSize({ width: 944, height: 547 }); await wait(500);
  const top = await p.evaluate(() => {
    const r = (q) => document.querySelector(q).getBoundingClientRect();
    return { side: r('#sidebar').width, more: Math.round(r('#btnMore').right), main: Math.round(r('main').right), rb: Math.round(r('#rightBar').left),
      lbl: getComputedStyle(document.querySelector('#btnMore .lbl')).display };
  });
  await p.screenshot({ path: shot('rb-narrow-top.png') });
  ok(top.side > 100 && top.more <= top.main && top.more <= top.rb && top.lbl === 'none', '窄窗口、左右两边栏都开着：顶栏按钮只留图标，「更多」不压到右边栏: ' + JSON.stringify(top));
  await p.setViewportSize({ width: 1280, height: 800 }); await wait(500);
  await p.click(`${RB} [data-a=collapse]`); await wait(500);
  const rail = await p.$$eval('#rightRail button', (xs) => xs.map((x) => [x.dataset.tab, x.textContent.trim()]));
  ok(await p.isHidden(RB) && JSON.stringify(rail) === JSON.stringify([['files', ''], ['git', '5']]) && await termW() > w0 - 100, '「»」收起：右边缘一列两个图标 (改动带数字)，终端恢复宽度: ' + JSON.stringify(rail));
  await p.screenshot({ path: shot('rb-collapsed.png') });
  await p.reload(); await p.waitForSelector('.tab.active .dot.ok'); await wait(1500);
  ok(await p.isVisible('#rightRail'), '刷新页面后还是收起的状态');
  await p.click('#rightRail [data-tab=files]'); await p.waitForSelector(`${RB} .pf-row`);
  ok(await p.evaluate(() => document.querySelector('#rightBar .rb-tabs .on').dataset.tab) === 'files' && Math.round((await p.locator(RB).boundingBox()).width) === nw, '点图标：展开到对应的选项卡，宽度还是拖过的');
  // 会话历史「继续」了别的目录里的对话：右边栏马上换到那个目录 (不等新的 Agent 报钩子事件)
  const other = path.join(home, 'other-proj'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'only-in-other.txt'), 'x\n');
  // 新的 Agent 在那个目录里跑起来了 (假的 claude：拷一份 sleep 改名，带这个标签的标记)
  fs.copyFileSync('/bin/sleep', path.join(home, 'claude')); fs.chmodSync(path.join(home, 'claude'), 0o755);
  const fakeAgent = spawn(path.join(home, 'claude'), ['300'], { cwd: other, env: { LC_SSHWEB: sid, PATH: process.env.PATH }, stdio: 'ignore' });
  kids.push(fakeAgent);
  await fetch(BASE + '/api/agent-sessions/resume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid, cmd: 'echo resumed', name: 'Claude：别的项目', cwd: other }) });
  await p.click(`${RB} .rb-tabs [data-tab=files]`).catch(() => {});
  await p.waitForSelector(`${RB} .pf-row[data-rel="only-in-other.txt"]`, { timeout: 8000 }).catch(() => {});
  ok(await p.locator(`${RB} .pf-row[data-rel="only-in-other.txt"]`).count() === 1 && await p.textContent(`${RB} .rb-src`) === 'Agent 干活的目录',
    '会话历史切到别的目录里的对话：右边栏自动换到那个目录 (Agent 干活的目录): ' + JSON.stringify(await p.textContent(`${RB} .rb-src`)));
  // 再切回原来仓库里的对话 (后面接着看这个仓库的改动)；刚才那个 Agent 退出了
  fakeAgent.kill(); await wait(300);
  await fetch(BASE + '/api/agent-sessions/resume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid, cmd: 'echo back', cwd: repo }) });
  await p.waitForSelector(`${RB} .pf-row[data-rel="a.txt"]`, { timeout: 8000 }).catch(() => {});
  await p.fill(`${RB} .rb-dir input`, '/'); await p.press(`${RB} .rb-dir input`, 'Enter'); await wait(1500);
  ok(await p.locator(`${RB} .pf-row`).count() > 0 && /不是 git 仓库/.test(await p.evaluate(() => { document.querySelector('#rightBar .rb-tabs [data-tab=git]').click(); return document.querySelector('#rightBar .gp-body').textContent; })), '手动填不是仓库的目录：「项目」照样能看文件，「改动」提示不是 git 仓库');
  await p.fill(`${RB} .rb-dir input`, ''); await p.press(`${RB} .rb-dir input`, 'Enter'); await wait(1200);

  // ======== 手机：全屏
  const m = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
  m.on('pageerror', (e) => errors.push(e.message));
  await m.goto(BASE + '/'); await m.waitForSelector('#app:not(.hidden)'); await wait(1500);
  if (await m.isVisible('.term.active .owner-notice button')) { await m.tap('.term.active .owner-notice button'); await wait(800); }
  await m.tap('#btnMore'); await m.tap('#btnProj'); await m.waitForSelector(`${RB} .pf-row`);
  const mb = await m.evaluate(() => { const r = document.getElementById('rightBar').getBoundingClientRect(); return { l: r.left, t: r.top, w: Math.round(r.width), iw: innerWidth }; });
  ok(mb.l === 0 && mb.t === 0 && mb.w === mb.iw && await m.isVisible(`${RB} [data-a=collapse]`) && !(await m.$(`${RB} [data-a=close]`)), '手机：全屏显示，右上角和电脑一样是「»」收起 (没有「×」): ' + JSON.stringify(mb));
  await m.screenshot({ path: shot('rb-mobile-files.png') });
  await m.screenshot({ path: shot('rb-head-mobile.png'), clip: { x: 0, y: 0, width: 412, height: 80 } });
  ok(await m.evaluate(() => Math.round(innerWidth - document.querySelector('#rightBar [data-a=collapse]').getBoundingClientRect().right)) <= 10, '手机：「»」贴着屏幕右边');
  await m.tap(`${RB} .rb-tabs [data-tab=git]`); await m.waitForSelector(`${RB} .gp-file`);
  await m.tap(`${RB} .gp-file:has-text("a.txt")`); await m.waitForSelector(`${RB} .gl.add`);
  await m.tap(`${RB} .gl.add:has-text("d")`);
  await m.fill(`${RB} .gp-edit textarea`, '手机上的批注');
  await m.tap(`${RB} [data-a=addnote]`); await wait(200);
  await m.tap(`${RB} [data-a=send]`); await wait(400);
  const mt = await m.evaluate(() => document.getElementById('mInput').value.replace(/​/g, ''));
  ok(await m.isHidden(RB) && mt.includes('a.txt 第 4 行（d）：手机上的批注'), '手机：发给 Agent 后右边栏关掉，批注在输入栏里: ' + JSON.stringify(mt));
  await m.tap('#btnMore'); await m.tap('#btnProj'); await m.waitForSelector(RB);
  await m.tap(`${RB} [data-a=collapse]`); await wait(400);
  ok(await m.isHidden(RB) && await m.isHidden('#rightRail'), '手机：点「»」收起 = 右边栏关掉 (手机上没有右边缘那列图标)');

  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close();
  for (const k of kids) k.kill();
  fs.rmSync(home, { recursive: true, force: true });
});
