'use strict';
const { BASE, ok, wait, shot, launch, post, devices, hostKey, chromium, waitFor } = require('./helpers');
const { Server } = require('ssh2');

// tmux 历史视图里的表格 (Claude Code 画的框线表格，夹着中文和 emoji)：每一行的右边框要对齐，
// 并且和实时画面 (xterm 按格子画) 的位置一样；占满整行宽度的分隔线不能折行
const TABLE = [
  '  ┌──────────┬─────────────────────────────────────────────────────────────────────────────────────────────────┐',
  '  │   步骤   │                                              结果                                               │',
  '  ├──────────┼─────────────────────────────────────────────────────────────────────────────────────────────────┤',
  '  │ 代码更新 │ 19ba4cd (v1.1.36) → 91fa959 (v1.2.0)（远端历史又重写了一次，内容等价已核对，直接 reset 到最新） │',
  '  ├──────────┼─────────────────────────────────────────────────────────────────────────────────────────────────┤',
  '  │ 数据备份 │ \x1b[1mdata.bak-20261013-135916\x1b[22m                                                                        │',
  '  ├──────────┼─────────────────────────────────────────────────────────────────────────────────────────────────┤',
  '  │ 镜像     │ aiproxy:local 重新构建成功                                                                      │',
  '  ├──────────┼─────────────────────────────────────────────────────────────────────────────────────────────────┤',
  '  │ 服务验证 │ 本地 8080 ✅ / CF 隧道 my-ai.example.com ✅，已登录账号 8 个全部可用                            │',
  '  └──────────┴─────────────────────────────────────────────────────────────────────────────────────────────────┘',
];
// 带表情的行：同 tmux 3.4+ capture-pane 抓出来的 —— ✅ 🔥 两格；⚠ 这类一格的字后面跟着 FE0F (显示成彩色表情)，
// tmux 当两格算，但第二格是个空格子，抓出来是「⚠️ + 空格」。服务器把这个空格去掉 (dropVs16Pad)，历史视图里
// 表情都装进两格宽的小格子 (同 Claude Code)，右边框和别的行对齐 (v1.83.47 没去空格，tmux 下 ⚠️ 那行偏出去一格)
const cw = (t) => { let n = 0; for (const c of t.replace(/\x1b\[[0-9;]*m/g, '')) { const cp = c.codePointAt(0); n += c === '\ufe0f' ? 0 : cp >= 0x1f300 || cp === 0x2705 || (cp >= 0x2e80 && cp <= 0xffe6) ? 2 : 1; } return n; };
const tmuxVs = (t) => t.replace(/\ufe0f/g, '\ufe0f ');
const row = (a, b) => `  │${a}${' '.repeat(10 - cw(a))}│${tmuxVs(b)}${' '.repeat(97 - cw(tmuxVs(b)))}│`;
TABLE.splice(TABLE.length - 1, 0,
  '  ├──────────┼─────────────────────────────────────────────────────────────────────────────────────────────────┤',
  row(' 磁盘     ', ' \x1b[1m243G/298G，82%\x1b[22m ⚠\ufe0f 偏满，建议留意'),
  '  ├──────────┼─────────────────────────────────────────────────────────────────────────────────────────────────┤',
  row(' 温度     ', ' CPU 53°C ✅ / 硬盘 41°C ✅ / 风扇 🔥 全速 ✔\ufe0f'));

let cols = 80;
// 比任何终端都宽的一行：历史视图里会被切成几行显示，复制出来必须还是一整行
const LONG = `LONG-${'abcdefghij'.repeat(30)}-END`;
const history = () => {
  const lines = [];
  for (let i = 1; i <= 200; i++) lines.push(`line ${i} 普通输出 abc`);
  lines.push(...TABLE, '─'.repeat(cols), '> 输入框', '─'.repeat(cols), LONG);
  for (let i = 201; i <= 230; i++) lines.push(`line ${i} 普通输出 abc`);
  return lines;
};

new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a, r, info) => { cols = info.cols; a && a(); });
    s.on('window-change', (a, r, info) => { cols = info.cols; a && a(); });
    s.on('env', (a) => a && a());
    s.on('shell', (a) => {
      const st = a();
      st.on('data', () => {});
      // 像 tmux：备用屏幕 + 鼠标 (SGR)，屏幕上是历史的最后几十行，最后一行状态栏
      setTimeout(() => st.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[H\x1b[2J' + history().slice(-20).join('\r\n')
        + '\x1b[999;1H\x1b[42m[main] 0:bash*\x1b[K\x1b[0m'), 300);
    });
    s.on('exec', (a) => {
      const ch = a();
      ch.write(history().join('\n') + '\n');
      ch.exit(0); ch.end();
    });
  }));
}).listen(2250, '127.0.0.1');

// 历史视图里每一行的位置：行首 / 行尾那个字的左右边缘，这一行占了几个视觉行
const measure = (sel = '.term.active .ls-body') => {
  const pre = document.querySelector(sel);
  const screen = document.querySelector('.term.active .xterm-screen');
  const nodes = [];
  const w = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
  let n, pos = 0;
  while ((n = w.nextNode())) { nodes.push([n, pos]); pos += n.data.length; }
  const at = (i) => { for (let k = nodes.length - 1; k >= 0; k--) if (nodes[k][1] <= i) return [nodes[k][0], i - nodes[k][1]]; };
  const text = pre.textContent;
  const lh = parseFloat(pre.style.lineHeight);
  const out = [];
  let start = 0;
  for (const line of text.split('\n')) {
    if (/^\s*[┌│├└─]/.test(line)) {
      const r = document.createRange();
      r.setStart(...at(start)); r.setEnd(...at(start + line.length));
      const whole = r.getBoundingClientRect();
      const last = document.createRange();
      last.setStart(...at(start + line.length - 1)); last.setEnd(...at(start + line.length));
      out.push({ line: line.slice(0, 20), right: last.getBoundingClientRect().right, rows: Math.round(whole.height / lh), len: [...line].length });
    }
    start += line.length + 1;
  }
  const sr = screen.getBoundingClientRect();
  const pr = pre.getBoundingClientRect();
  return { sw: pre.scrollWidth, cw: pre.clientWidth, bar: pre.offsetWidth - pre.clientWidth, visRight: pr.left + pre.clientLeft + pre.clientWidth, out, screenLeft: sr.left, screenWidth: sr.width, preLeft: pre.getBoundingClientRect().left + parseFloat(getComputedStyle(pre).paddingLeft) };
};

// 手指从 (x, y) 滑 (dx, dy)：一步步发触摸事件，浏览器按真的手指滑动处理 (原生滚动)
async function swipe(cdp, x, y, dx, dy) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 10; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / 10, y: y + dy * i / 10 }] }); await wait(20); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await wait(600);
}

async function check(p, label) {
  const r = await p.evaluate(measure);
  const tableRows = r.out.filter((x) => x.line.startsWith('  '));
  const rights = tableRows.map((x) => x.right);
  const spread = Math.max(...rights) - Math.min(...rights);
  ok(tableRows.length === TABLE.length && spread < 1, `${label}：表格每一行的右边框对齐 (相差 ${spread.toFixed(1)}px，各行 ${rights.map((x) => x.toFixed(1)).join(' ')})`);
  // 表情装在固定宽的小格子里 (不靠量字宽补间距：iPhone 上表情量出来的宽度不准，以前带 ✅ 的行右边框偏出去一格)
  const em = await p.evaluate((cols) => {
    const cell = document.querySelector('.term.active .xterm-screen').getBoundingClientRect().width / cols;
    return [...document.querySelectorAll('.term.active .ls-body .ls-c')].map((x) => ({ t: x.textContent, cells: x.getBoundingClientRect().width / cell }));
  }, cols).catch(() => null);
  const want = ['⚠\ufe0f', '✅', '🔥', '✔\ufe0f'];
  ok(em && want.every((t) => em.some((x) => x.t === t)) && em.every((x) => Math.abs(x.cells - 2) < 0.02),
    `${label}：表格里的表情 (含 ⚠️ ✔️ 这种带 FE0F 的) 都装在正好两格宽的小格子里: ` + JSON.stringify(em && [...new Map(em.map((x) => [x.t, +x.cells.toFixed(3)]))]));
  const full = r.out.filter((x) => x.line.startsWith('─'));
  if (label.includes('滚动条')) ok(r.bar > 0, `${label}：历史视图有滚动条 (${r.bar}px)`);
  const far = Math.max(...r.out.map((x) => x.right));
  if (label.includes('手机')) {
    // 表格比屏幕宽 (手机上看电脑画的表格)：整张表放进自己的横滑条带，每行还是一行；整个历史视图不横滚 (普通文字不跟着飘)
    const t = await p.evaluate(() => {
      const pre = document.querySelector('.term.active .ls-body'), tb = [...pre.querySelectorAll('.ls-tbl')];
      const c = pre.cloneNode(true); c.querySelectorAll('.ls-wrap').forEach((x) => x.remove());
      return { n: tb.length, sw: tb[0]?.scrollWidth, cw: tb[0]?.clientWidth, rows: tb[0] ? tb[0].textContent.split('\n').filter(Boolean).length : 0,
        preSw: pre.scrollWidth, preCw: pre.clientWidth, same: c.textContent === document.querySelector('.term.active .lscroll').lsText };
    });
    ok(t.n === 1 && t.rows === TABLE.length + 1 /* 紧跟着的整行分隔线也带框线字符，算在一起 */ && tableRows.every((x) => x.rows === 1) && t.sw > t.cw + 10,
      `${label}：超宽的表格整张放进一个横滑条带，每行不折行 (条带 ${t.n} 个，${t.rows} 行，内容宽 ${t.sw}px / 可见 ${t.cw}px)`);
    ok(t.preSw <= t.preCw, `${label}：整个历史视图不横向滚 (内容宽 ${t.preSw}px / 可见 ${t.preCw}px)`);
    ok(t.same, `${label}：历史视图的文字和原文一样 (表格条带没有多出 / 吃掉换行，长按定位、复制面板换算行号照旧)`);
    await p.evaluate(() => { const tb = document.querySelector('.term.active .ls-tbl'); tb.scrollLeft = tb.scrollWidth; });
    const r2 = await p.evaluate(measure).catch(() => null);
    const far2 = r2 && Math.max(...r2.out.filter((x) => x.line.startsWith('  ')).map((x) => x.right));
    ok(r2 && far2 <= r2.visRight + 0.5 && far2 > r2.visRight - 40, `${label}：表格滑到最右边能看到右边框 (最右 ${far2?.toFixed(1)}px，可见到 ${r2?.visRight.toFixed(1)}px)`);
    // 渐隐提示在 scroll 事件里去掉：事件是异步的，等它一下 (以前直接查，偶尔赶在事件之前)
    const noMore = () => !document.querySelector('.term.active .ls-tbl').classList.contains('more');
    ok(await waitFor(p, noMore, undefined, 2000).then(() => true, () => false), `${label}：滑到最右边，右边缘的渐隐提示去掉`);
    await p.evaluate(() => { document.querySelector('.term.active .ls-tbl').scrollLeft = 0; });
  } else ok(far <= r.visRight + 0.5, `${label}：最右边的字没被裁掉 / 没被滚动条盖住 (最右 ${far.toFixed(1)}px，可见到 ${r.visRight.toFixed(1)}px)`);
  ok(full.length >= 2 && full.every((x) => x.rows === 1), `${label}：占满整行的分隔线不折行 (${full.map((x) => x.len + ' 字 ' + x.rows + ' 行').join('，')})`);
  return r;
}

(async () => {
  await post('/api/hosts', { name: 'GRID', host: '127.0.0.1', port: 2250, username: 'u', password: 'x' });
  const browser = await launch();
  // 真实电脑上滚动条占 15px 左右：无头浏览器默认 --hide-scrollbars 测不出「滚动条吃掉宽度、满宽的分隔线被折行 / 右边被裁」
  const withBars = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'], ignoreDefaultArgs: ['--hide-scrollbars'] });
  const errors = [];

  for (const [label, opts, b] of [['电脑', { viewport: { width: 1280, height: 800 } }], ['电脑 (显示滚动条)', { viewport: { width: 1280, height: 800 } }, withBars], ['电脑 (粗体字更宽)', { viewport: { width: 1280, height: 800 } }], ['平板横屏', { ...devices['iPad Pro 11 landscape'] }], ['手机', { ...devices['iPhone 13'] }]]) {
    const ctx = await (b || browser).newContext(opts);
    const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
    // 模拟 Windows 上中文粗体是系统模拟加粗 (每个字宽出一点)：粗体字放大一点，表格里有粗体的那行右边框照样要对齐
    if (label.includes('粗体')) await p.addStyleTag({ content: '.ls-body [style*="font-weight:bold"] { font-size: 1.12em; }' });
    if (label.startsWith('电脑')) {
      await p.locator('.host', { hasText: ':2250' }).first().click(); await wait(2000);
      const b = await p.locator('.term.active .term-box').boundingBox(); await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await p.mouse.wheel(0, -100); await wait(1500);
    } else {
      await p.waitForSelector('.tab'); await wait(1000);
      await p.locator('.tab', { hasText: 'GRID' }).first().tap(); await wait(1500);
      await p.locator('.term.active button', { hasText: '在本机继续' }).tap(); await wait(1500); // 电脑那边刚用过，先接管 (按手机屏幕排版)
      const cdp = await ctx.newCDPSession(p);
      const box = await p.locator('.term.active .term-box').boundingBox();
      const x = box.x + box.width / 2, y0 = box.y + 60;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
      for (let i = 1; i <= 10; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + i * 20 }] }); await wait(30); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await wait(1500);
    }
    ok(!!(await p.$('.term.active .lscroll')), `${label}：打开了历史视图 (终端 ${cols} 列)`);
    if (label === '电脑') ok(await p.evaluate(() => typeof CellWidth?.useCellWidth === 'function' && CellWidth.cellWidth('✅') === 2), '网页里加载了字宽规则 (public/cellwidth.js，终端里 ✅ 算两格)');
    await p.evaluate(() => { const pre = document.querySelector('.term.active .ls-body'); pre.scrollTop = pre.scrollHeight; });
    await check(p, label);
    if (label === '手机') { // 真的用手指滑 (浏览器原生的触摸滚动)：以前触摸都被终端的滑动处理拦下，只换算成上下滚，左右滑不动
      const g = await ctx.newCDPSession(p);
      const pb = await p.locator('.term.active .ls-body').boundingBox();
      // 表格滚到看得见的地方 (条带上半截)，在表格上往左滑：只有表格动
      const tb = await p.evaluate(() => { const pre = document.querySelector('.term.active .ls-body'), t = pre.querySelector('.ls-tbl');
        pre.scrollTop += t.getBoundingClientRect().top - pre.getBoundingClientRect().top - 40; const r = t.getBoundingClientRect(); return { y: r.top + 30 }; });
      await swipe(g, pb.x + pb.width * 0.8, tb.y, -250, 0);
      const h1 = await p.evaluate(() => ({ t: document.querySelector('.term.active .ls-tbl').scrollLeft, pre: document.querySelector('.term.active .ls-body').scrollLeft }));
      ok(h1.t > 50 && h1.pre === 0, `${label}：手指按在表格上往左滑，只有表格往左移 (表格 ${h1.t}px，整个视图 ${h1.pre}px)`);
      // 在普通文字上往左滑：什么都不动 (不再左右飘)
      await p.evaluate(() => { document.querySelector('.term.active .ls-tbl').scrollLeft = 0; const pre = document.querySelector('.term.active .ls-body'); pre.scrollTop = pre.scrollHeight; });
      await swipe(g, pb.x + pb.width * 0.8, pb.y + pb.height / 2, -250, 0);
      const h2 = await p.evaluate(() => ({ t: document.querySelector('.term.active .ls-tbl').scrollLeft, pre: document.querySelector('.term.active .ls-body').scrollLeft }));
      ok(h2.t === 0 && h2.pre === 0, `${label}：手指按在普通文字上往左滑，什么都不横移 (表格 ${h2.t}px，整个视图 ${h2.pre}px)`);
      const top0 = await p.evaluate(() => document.querySelector('.term.active .ls-body').scrollTop);
      await swipe(g, pb.x + pb.width / 2, pb.y + pb.height / 3, 0, 250);
      const top1 = await p.evaluate(() => document.querySelector('.term.active .ls-body').scrollTop);
      ok(top1 < top0 - 50, `${label}：手指往下滑，历史往回滚 (scrollTop ${Math.round(top0)} → ${Math.round(top1)})`);
      // 长按打开复制面板：内容照历史视图的样子排，表格竖线照样对齐 (以前是文本框，iPhone 上中文不正好两个英文宽，竖线对不齐)
      await p.evaluate(() => { const pre = document.querySelector('.term.active .ls-body'), t = pre.querySelector('.ls-tbl');
        pre.scrollTop += t.getBoundingClientRect().top - pre.getBoundingClientRect().top - 40; });
      const tb2 = await p.evaluate(() => document.querySelector('.term.active .ls-tbl').getBoundingClientRect().top + 30);
      await g.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pb.x + 60, y: tb2 }] }); await wait(700);
      await g.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await wait(800);
      const c = await p.evaluate(measure, '#copyText');
      const crows = c.out.filter((x) => x.line.startsWith('  '));
      const cr = crows.map((x) => x.right), cspread = Math.max(...cr) - Math.min(...cr);
      const ct = await p.evaluate(() => { const p = document.getElementById('copyText'), t = p.querySelector('.ls-tbl'); return { shown: !document.getElementById('copyPanel').classList.contains('hidden'), tbl: !!t && t.scrollWidth > t.clientWidth, sw: p.scrollWidth, cw: p.clientWidth }; });
      ok(ct.shown && crows.length === TABLE.length && cspread < 1 && crows.every((x) => x.rows === 1),
        `${label}：长按出来的复制面板里，表格每一行的右边框对齐、不折行 (相差 ${cspread.toFixed(1)}px，${crows.length} 行)`);
      ok(ct.tbl && ct.sw <= ct.cw, `${label}：复制面板里超宽的表格自己左右滑，整个面板不横向滚`);
      await p.screenshot({ path: shot('lsgrid-手机-复制面板.png') });
      await p.tap('#copyClose'); await wait(300);
    }
    if (label.startsWith('电脑')) { // 选中切成几行显示的长行，松开鼠标自动复制：剪贴板里是原来的一整行
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
      const cp = await p.evaluate(async () => {
        const pre = document.querySelector('.term.active .ls-body'), w = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
        let a, b, n;
        while ((n = w.nextNode())) { const i = n.data.indexOf('LONG-'); if (i >= 0 && !a) a = [n, i]; const j = n.data.indexOf('-END'); if (j >= 0) b = [n, j + 4]; }
        const r = document.createRange(); r.setStart(...a); r.setEnd(...b);
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
        const shown = sel.toString();
        pre.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
        await new Promise((ok) => setTimeout(ok, 600));
        return { rows: shown.split('\n').length, clip: await navigator.clipboard.readText() };
      });
      ok(cp.rows > 1 && cp.clip === LONG, `${label}：选中切成 ${cp.rows} 行显示的长行，复制出来还是一整行 (${cp.clip.length} 字，${cp.clip.split('\n').length} 行)`);
    }
    await p.screenshot({ path: shot(`lsgrid-${label}.png`) });
    await ctx.close();
  }
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); await withBars.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
