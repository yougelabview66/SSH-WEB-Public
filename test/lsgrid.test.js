'use strict';
const { BASE, ok, wait, shot, launch, post, devices, hostKey, chromium } = require('./helpers');
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
// tmux 当两格算，但第二格是个空格子，抓出来是「⚠️ + 空格」。历史视图和实时画面一样：✅ 装进两格宽的小格子，
// ⚠️ 装进一格宽的 (画出来伸到后面的空格上)，右边框和别的行对齐 (v1.83.47 把 ⚠️ 也装进两格，tmux 下右边框偏出去一格)
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
const measure = () => {
  const pre = document.querySelector('.term.active .ls-body');
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
  return { bar: pre.offsetWidth - pre.clientWidth, visRight: pr.left + pre.clientLeft + pre.clientWidth, out, screenLeft: sr.left, screenWidth: sr.width, preLeft: pre.getBoundingClientRect().left + parseFloat(getComputedStyle(pre).paddingLeft) };
};

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
  ok(em && want.every((t) => em.some((x) => x.t === t)) && em.every((x) => Math.abs(x.cells - (x.t.includes('\ufe0f') ? 1 : 2)) < 0.02),
    `${label}：表格里的表情装在固定宽的小格子里 (✅ 🔥 两格，⚠️ ✔️ 这种带 FE0F 的一格): ` + JSON.stringify(em && [...new Map(em.map((x) => [x.t, +x.cells.toFixed(3)]))]));
  const full = r.out.filter((x) => x.line.startsWith('─'));
  if (label.includes('滚动条')) ok(r.bar > 0, `${label}：历史视图有滚动条 (${r.bar}px)`);
  const far = Math.max(...r.out.map((x) => x.right));
  ok(far <= r.visRight + 0.5, `${label}：最右边的字没被裁掉 / 没被滚动条盖住 (最右 ${far.toFixed(1)}px，可见到 ${r.visRight.toFixed(1)}px)`);
  ok(full.length >= 2 && full.every((x) => x.rows === 1), `${label}：占满整行的分隔线不折行 (${full.map((x) => x.len + ' 字 ' + x.rows + ' 行').join('，')})`);
  return r;
}

(async () => {
  await post('/api/hosts', { name: 'GRID', host: '127.0.0.1', port: 2250, username: 'u', password: 'x' });
  const browser = await launch();
  // 真实电脑上滚动条占 15px 左右：无头浏览器默认 --hide-scrollbars 测不出「滚动条吃掉宽度、满宽的分隔线被折行 / 右边被裁」
  const withBars = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'], ignoreDefaultArgs: ['--hide-scrollbars'] });
  const errors = [];

  for (const [label, opts, b] of [['电脑', { viewport: { width: 1280, height: 800 } }], ['电脑 (显示滚动条)', { viewport: { width: 1280, height: 800 } }, withBars], ['平板横屏', { ...devices['iPad Pro 11 landscape'] }]]) {
    const ctx = await (b || browser).newContext(opts);
    const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
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
