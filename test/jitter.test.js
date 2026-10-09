'use strict';
// 点击终端时手抖：tmux 开着鼠标时，按下到松开之间挪过一点点也会被当成拖动 (进复制模式选字、松开就复制、
// 闪一下「回到实时画面」)。按住后挪动不到 5px 不上报移动；挪够了照常上报 (真拖动选字不受影响)。
// 以及：复制时剪贴板接口被拒、改用临时文本框复制后，焦点要还给下方输入框 (以前落到页面上，点了终端光标不回输入框)
const { BASE, ok, wait, launch, hostKey } = require('./helpers');
const { Server } = require('ssh2');
let got = '';
let cols = 80;
let osc52 = false; // 收到松开鼠标的上报时，回一条 OSC 52 设置剪贴板 (同 tmux 拖动选字松开后的复制)
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a, r, info) => { cols = info.cols; a(); });
    s.on('window-change', (a, r, info) => { cols = info.cols; a && a(); });
    s.on('shell', (a) => {
      const st = a();
      st.write('\x1b[?1002h\x1b[?1006h$ '); // 同 tmux mouse on：按键 + 按住移动上报，SGR 编码
      st.on('data', (d) => {
        got += d;
        if (osc52 && /\x1b\[<0;\d+;\d+m/.test(String(d))) { osc52 = false; st.write('\x1b]52;c;' + Buffer.from('hello').toString('base64') + '\x07'); }
      });
    });
  }));
}).listen(2245, '127.0.0.1');

(async () => {
  await fetch(BASE + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'J', host: '127.0.0.1', port: 2245, username: 'u', password: 'x' }) });
  const browser = await launch();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }); // 不授权剪贴板：writeText 会被拒
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'J' }).click(); await wait(1200);
  const sb = await p.locator('.term.active .xterm-screen').boundingBox();
  const cellW = sb.width / cols;
  const x0 = sb.x + 200, y0 = sb.y + sb.height / 2;
  const motion = () => (got.match(/\x1b\[<32;\d+;\d+M/g) || []).length;

  // 手抖不到 5px，但跨过了字符格的边界 (以前会上报移动)
  const edge = sb.x + Math.ceil((x0 - sb.x) / cellW) * cellW; // 右边最近的格子边界
  got = '';
  await p.mouse.move(edge - 1.5, y0); await p.mouse.down();
  await p.mouse.move(edge + 1.5, y0, { steps: 3 }); await p.mouse.up(); await wait(400);
  ok(/\x1b\[<0;\d+;\d+M/.test(got) && /\x1b\[<0;\d+;\d+m/.test(got), '手抖时按下和松开照常上报: ' + JSON.stringify(got));
  ok(motion() === 0, '挪动不到 5px (跨过了格子边界) 不上报移动，tmux 看到的是单击');
  ok(await p.evaluate(() => document.activeElement.id) === 'dInput', '点完光标回到下方输入框');

  // 真拖动：挪够了照常上报
  got = '';
  await p.mouse.move(x0, y0); await p.mouse.down();
  await p.mouse.move(x0 + cellW * 6, y0, { steps: 6 }); await p.mouse.up(); await wait(400);
  ok(motion() >= 3, `真拖动 (6 个字宽) 照常上报移动 (${motion()} 次)，拖动选字不受影响`);

  // 松开后远端发来 OSC 52 复制；没有剪贴板权限 → writeText 被拒 → 改用临时文本框复制 (异步)，焦点要还给输入框
  const copied = await p.evaluate(() => {
    window.__copied = [];
    const ec = document.execCommand.bind(document);
    document.execCommand = (c, ...r) => { const v = ec(c, ...r); if (c === 'copy') window.__copied.push(document.activeElement?.value); return v; };
    return true;
  });
  osc52 = true; got = '';
  await p.mouse.move(x0, y0); await p.mouse.down();
  await p.mouse.move(x0 + cellW * 4, y0, { steps: 4 }); await p.mouse.up(); await wait(800);
  const r = await p.evaluate(() => ({ copied: window.__copied, active: document.activeElement.id || document.activeElement.tagName }));
  ok(copied && r.copied.includes('hello'), '远端的 OSC 52 复制改用临时文本框完成: ' + JSON.stringify(r.copied));
  ok(r.active === 'dInput', '临时文本框复制完焦点还给下方输入框 (以前落到 ' + r.active + ')');

  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
