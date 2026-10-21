'use strict';
// 终端里搜索：Ctrl+Shift+F / 「⋯ 更多 → 搜索历史」—— 普通终端搜滚动记录 (不分大小写、中文按两格选中、折行接起来)，
// 打字时不搜，回车或点「搜索」才搜；搜过后回车 = 上一个、Shift+回车 = 下一个、循环；没找到标红；Esc 关闭；tmux 里先打开历史视图再在里面搜
const { Server } = require('ssh2');
const { BASE, ok, wait, run, launch, shot, hostKey, addHost, devices } = require('./helpers');

// 普通 shell：一屏放不下的输出，needle 出现 3 次 (第一次早已滚出屏幕)，一行中文，一行跨折行的
const PLAIN = [];
for (let i = 0; i < 120; i++) PLAIN.push(i === 5 ? 'line 5 has needle-A here' : i === 60 ? 'line 60 Needle-B' : i === 100 ? 'line 100 NEEDLE-C' : `filler line ${i}`);
PLAIN.push('中文前缀中文目标后面');
PLAIN.push('x'.repeat(77) + 'WRAPMATCH tail');
PLAIN.push('$ ');
// 像 tmux：备用屏幕 + 鼠标，屏幕上是历史的最后几十行；抓历史 (常驻 sh 通道) 回整段
const HIST = [];
for (let i = 0; i < 400; i++) HIST.push(i === 30 ? 'old output with deepword inside' : `tmux history line ${i}`);

function server(port, tmux) {
  new Server({ hostKeys: [hostKey()] }, (c) => {
    c.on('authentication', (ctx) => ctx.accept());
    c.on('ready', () => c.on('session', (acc) => {
      const s = acc();
      s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
      s.on('shell', (a) => {
        const st = a();
        if (!tmux) return st.write(PLAIN.join('\r\n'));
        st.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[H\x1b[2J' + HIST.slice(-40).join('\r\n') + '\x1b[999;1H\x1b[42m[main] 0:bash*\x1b[K\x1b[0m');
      });
      s.on('exec', (a, r, info) => {
        const ch = a();
        if (info.command.includes('hook.log')) return; // 读钩子事件的通道
        if (info.command === 'sh') {
          ch.on('data', (d) => { const m = /printf '\\n%s %s\\n' '(__SSHWEB_[0-9a-f]+__)'/.exec(String(d)); if (m) ch.write(HIST.join('\n') + `\n${m[1]} 0\n`); });
          return;
        }
        ch.write(HIST.join('\n')); ch.exit(0); ch.end();
      });
    }));
  }).listen(port, '127.0.0.1');
}
server(2295, false); server(2235, true);

run(async () => {
  await addHost('SP', 2295); await addHost('ST', 2235);
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // 不用 WebGL (画在 canvas 上读不到字和选中的位置)，改用 DOM 渲染
  await ctx.addInitScript(() => { const gc = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, ...r) { return /webgl/.test(t) ? null : gc.call(this, t, ...r); }; });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'SP' }).first().click(); await p.waitForSelector('.tab.active .dot.ok'); await wait(1200);
  const info = () => p.textContent('.term.active .tsearch .ts-info');
  const rowsText = () => p.evaluate(() => document.querySelector('.term.active .xterm-rows').innerText);
  const type = async (t) => { await p.fill('.term.active .tsearch input', t); await p.press('.term.active .tsearch input', 'Enter'); await wait(400); };

  await p.keyboard.press('Control+Shift+F'); await wait(200);
  ok(await p.isVisible('.term.active .tsearch') && await p.evaluate(() => document.activeElement.matches('.tsearch input')), 'Ctrl+Shift+F：打开搜索框，光标在搜索框里');
  // 打字时不搜 (输入法组字不会被打断)，按回车 / 点「搜索」才搜
  const cdp = await ctx.newCDPSession(p);
  const compose = (t) => cdp.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length });
  await compose('nee'); await wait(500);
  ok(await info() === '' && await p.inputValue('.term.active .tsearch input') === 'nee', '输入法组字时：不搜');
  await cdp.send('Input.insertText', { text: 'needle' }); await wait(500);
  ok(await info() === '' && await p.inputValue('.term.active .tsearch input') === 'needle', '字上屏了也不自动搜，字完整');
  await p.click('.term.active .tsearch [data-a=go]'); await wait(400);
  ok(await info() === '3/3' && await p.evaluate(() => document.activeElement.matches('.tsearch input')), '点「搜索」：搜出来了，光标还在搜索框里: ' + await info());
  await p.fill('.term.active .tsearch input', 'needle-'); await wait(300);
  ok(await info() === '', '改了搜索词：上次的结果提示清掉，等回车');
  await p.fill('.term.active .tsearch input', ''); await wait(300);
  ok(!(await rowsText()).includes('line 5 has'), '(needle-A 那行已经滚出屏幕)');
  await type('needle');
  ok(await info() === '3/3', '不分大小写，找到 3 个，先停在最新 (最下面) 的: ' + await info());
  await p.press('.term.active .tsearch input', 'Enter'); await wait(300);
  await p.press('.term.active .tsearch input', 'Enter'); await wait(300);
  ok(await info() === '1/3' && (await rowsText()).includes('line 5 has needle-A here'), '回车往上找：跳到滚出屏幕的第一个，终端滚过去了');
  await p.press('.term.active .tsearch input', 'Enter'); await wait(300);
  ok(await info() === '3/3', '再往上：循环到最后一个');
  await p.press('.term.active .tsearch input', 'Shift+Enter'); await wait(300);
  ok(await info() === '1/3', 'Shift+回车往下：循环到第一个');
  await p.click('.term.active .tsearch [data-a=next]'); await wait(300);
  ok(await info() === '2/3' && (await rowsText()).includes('line 60 Needle-B'), '↓ 按钮：下一个');
  await p.screenshot({ path: shot('search-desk.png'), clip: { x: 250, y: 0, width: 1030, height: 400 } });

  // 中文：选中的宽度是 4 个字 × 2 格
  await type('中文目标');
  // 选中区域的宽度 (xterm 还会放一个高度为 0 的空块，不算)；一格多宽：在终端里量 10 个英文字
  const sel = await p.evaluate(() => ({
    boxes: [...document.querySelectorAll('.term.active .xterm-selection div')].map((d) => d.getBoundingClientRect()).filter((r) => r.height > 0).map((r) => r.width),
    info: document.querySelector('.term.active .ts-info').textContent,
  }));
  const cell = await p.evaluate(() => { const r = document.querySelector('.term.active .xterm-rows > div'); const m = document.createElement('span'); m.textContent = 'W'.repeat(10); r.appendChild(m); const w = m.getBoundingClientRect().width / 10; m.remove(); return w; });
  ok(sel.info === '1/1' && sel.boxes.length === 1 && Math.abs(sel.boxes[0] - cell * 8) < cell * 0.6, `中文：选中正好 4 个字 (8 格宽，${Math.round(sel.boxes[0])}px / 一格 ${cell.toFixed(1)}px)`);
  // 跨折行
  await type('wrapmatch');
  ok(await info() === '1/1', '跨折行的也找得到 (折行接起来找)');
  // 没找到
  await type('zzz-nope');
  ok(await info() === '没找到' && await p.evaluate(() => document.querySelector('.term.active .tsearch').classList.contains('none')), '没找到：提示并标红');
  await p.press('.term.active .tsearch input', 'Escape'); await wait(300);
  ok(!(await p.$('.term.active .tsearch')) && await p.evaluate(() => document.activeElement.id) === 'dInput', 'Esc 关掉搜索框，光标回到输入框');
  // 菜单里打开
  await p.click('#btnMore'); await p.click('#btnSearch'); await wait(200);
  ok(await p.isVisible('.term.active .tsearch'), '「⋯ 更多 → 搜索历史」也能打开');
  await p.click('#dInput'); await p.click('.term.active .tsearch input'); await wait(300);
  ok(await p.evaluate(() => document.activeElement.matches('.tsearch input')), '点搜索框：光标在搜索框里 (不被拉回下方输入框)');
  await p.click('.term.active .tsearch [data-a=close]'); await wait(200);
  ok(!(await p.$('.term.active .tsearch')), '× 关掉搜索框');

  // tmux：先打开历史视图，在历史视图里搜
  await p.locator('.host', { hasText: 'ST' }).first().click(); await p.waitForSelector('.tab.active .dot.ok'); await wait(1500);
  await p.keyboard.press('Control+Shift+F'); await wait(1500);
  ok(!!(await p.$('.term.active .lscroll')), 'tmux 里：打开搜索时先打开历史视图 (抓 tmux 历史)');
  // 用输入法打：组字时不搜；上屏后搜到，焦点和字都还在搜索框里 (以前改选区标出匹配，把输入法正在组的字打断了)
  await compose('deep'); await wait(500);
  ok(await info() === '' && await p.inputValue('.term.active .tsearch input') === 'deep', 'tmux 历史视图：输入法组字时不搜');
  await cdp.send('Input.insertText', { text: 'DEEPWORD' }); await wait(500);
  ok(await info() === '', 'tmux 历史视图：字上屏了也不自动搜');
  await p.press('.term.active .tsearch input', 'Enter'); await wait(500);
  const v = await p.evaluate(() => {
    const pre = document.querySelector('.term.active .ls-body'), hl = CSS.highlights.get('tsearch'), rg = hl && [...hl][0];
    const r = rg && rg.getBoundingClientRect(), pr = pre.getBoundingClientRect();
    return { hl: rg ? rg.toString() : '', inView: !!r && r.top >= pr.top && r.bottom <= pr.bottom, focus: document.activeElement.matches('.tsearch input'),
      val: document.activeElement.value, info: document.querySelector('.term.active .ts-info').textContent };
  });
  ok(v.info === '1/1' && v.hl === 'deepword' && v.inView && v.focus && v.val === 'DEEPWORD', '在历史视图里找到早先的输出，高亮并滚到那里，焦点和字都留在搜索框里: ' + JSON.stringify(v));
  await p.press('.term.active .tsearch input', 'Escape'); await wait(300);
  ok(!(await p.$('.term.active .tsearch')) && !!(await p.$('.term.active .lscroll')), 'Esc 先只关搜索框，历史视图还在');
  await p.keyboard.press('Escape'); await wait(300);
  ok(!(await p.$('.term.active .lscroll')), '再按 Esc 回到实时画面');

  // 手机：从「⋯」打开，搜索框放得下
  const m = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
  m.on('pageerror', (e) => errors.push(e.message));
  await m.goto(BASE + '/'); await m.waitForSelector('#app:not(.hidden)'); await wait(1500);
  // 先接管标签 (被电脑页锁着时点终端本来就不拉焦点，测不出来)
  // 在普通终端的标签上测 (tmux 里会先打开历史视图，下方输入栏藏起来了)
  await m.tap('.tab:has-text("SP-1")'); await wait(800);
  if (await m.isVisible('.term.active .owner-notice button')) { await m.tap('.term.active .owner-notice button'); await wait(800); }
  await m.tap('#btnMore'); await m.tap('#btnSearch'); await wait(300);
  await m.tap('#mInput'); await wait(200);
  await m.tap('.term.active .tsearch input'); await wait(400);
  ok(await m.evaluate(() => document.activeElement.matches('.tsearch input')), '手机：点搜索框，光标在搜索框里 (不跑到下方输入栏)');
  const mb = await m.evaluate(() => { const r = document.querySelector('.term.active .tsearch')?.getBoundingClientRect(); return r && { l: r.left, r: r.right, w: innerWidth }; });
  ok(!!mb && mb.l >= 0 && mb.r <= mb.w, '手机：「⋯ → 搜索历史」打开，搜索框在屏幕里: ' + JSON.stringify(mb));
  await m.screenshot({ path: shot('search-mobile.png'), clip: { x: 0, y: 0, width: 412, height: 140 } });
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close();
});
