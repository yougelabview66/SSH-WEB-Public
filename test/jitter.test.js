'use strict';
// 点击终端时手抖：tmux 开着鼠标时，按下到松开之间挪过一点点也会被当成拖动 (进复制模式选字、松开就复制、
// 闪一下「回到实时画面」)。按住后挪动不到 5px 不上报移动；挪够了照常上报 (真拖动选字不受影响)。
// 以及：复制时剪贴板接口被拒、改用临时文本框复制后，焦点要还给下方输入框 (以前落到页面上，点了终端光标不回输入框)
const { BASE, ok, wait, launch, hostKey } = require('./helpers');
const { Server } = require('ssh2');
let got = '';
let cols = 80;
let shell = null;
let osc52 = false; // 收到松开鼠标的上报时，回一条 OSC 52 设置剪贴板 (同 tmux 拖动选字松开后的复制)
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a, r, info) => { cols = info.cols; a(); });
    s.on('window-change', (a, r, info) => { cols = info.cols; a && a(); });
    s.on('shell', (a) => {
      const st = a(); shell = st;
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
  await wait(600); got = '';
  await p.mouse.move(x0, y0); await p.mouse.down();
  await p.mouse.move(x0 + cellW * 6, y0, { steps: 6 }); await p.mouse.up(); await wait(400);
  ok(motion() >= 3, `真拖动 (6 个字宽) 照常上报移动 (${motion()} 次)，拖动选字不受影响`);

  // 连点两下 / 三下：tmux 会当成双击选词 / 三击选行 (并复制)。实时画面里不要：间隔太短的那几下不交给 tmux
  const presses = () => (got.match(/\x1b\[<0;\d+;\d+M/g) || []).length;
  const releases = () => (got.match(/\x1b\[<0;\d+;\d+m/g) || []).length;
  await wait(600);
  got = ''; await p.mouse.dblclick(x0, y0); await wait(400);
  ok(presses() === 1 && releases() === 1, `双击：tmux 只收到一次按下 / 松开 (${presses()} / ${releases()})，不会双击选词`);
  ok(await p.evaluate(() => document.activeElement.id) === 'dInput', '双击后光标照样回到下方输入框');
  await wait(600);
  got = ''; await p.mouse.click(x0, y0, { clickCount: 3 }); await wait(400);
  ok(presses() === 1 && releases() === 1, `三击：tmux 只收到一次按下 / 松开 (${presses()} / ${releases()})`);
  await wait(600);
  got = ''; await p.mouse.click(x0, y0); await wait(700); await p.mouse.click(x0 + cellW * 3, y0); await wait(300);
  ok(presses() === 2 && releases() === 2, `间隔够长 (0.7 秒) 的两次单击都交给 tmux (${presses()} / ${releases()})`);
  // 点一下马上拖动选字：第二下先扣着，拖动起来后补发按下，拖动照常交给 tmux
  await wait(600);
  got = ''; await p.mouse.click(x0, y0); await wait(100);
  await p.mouse.down(); await p.mouse.move(x0 + cellW * 6, y0, { steps: 6 }); await p.mouse.up(); await wait(400);
  const pressAt = [...got.matchAll(/\x1b\[<0;\d+;\d+M/g)].map((m) => m.index);
  ok(presses() === 2 && motion() >= 3 && releases() === 2 && pressAt[1] < got.indexOf('\x1b[<32;'),
    `点一下马上拖动：先补发按下再上报移动，拖动照常交给 tmux (按下 ${presses()}、移动 ${motion()}、松开 ${releases()})`);

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

  // tmux 开鼠标时拖动选字也是进复制模式实现的：停在当前画面，右上角位置标记是 [0/N]，松开就复制并退出 ——
  // 在选字不是在看历史，不显示「回到实时画面」(以前选字时这个按钮会闪一下)
  const mark = (t) => shell.write(`\x1b7\x1b[1;${cols - t.length + 1}H${t}\x1b8`);
  const btn = () => p.isVisible('.term.active .tmux-exit');
  shell.write('\x1b[?1049h\x1b[H\x1b[2J$ '); // tmux 用的是备用屏幕
  await p.mouse.move(x0, y0); await p.mouse.down();
  await p.mouse.move(x0 + cellW * 6, y0, { steps: 6 }); mark('[0/40]'); await wait(800);
  ok(!await btn(), '拖动选字中 (复制模式 [0/40]) 不显示「回到实时画面」');
  await p.mouse.up(); await wait(150); mark('      '); await wait(800); // tmux 复制完退出复制模式，标记消失
  ok(!await btn(), '松开、tmux 退出复制模式的过程中也不闪');
  // 不是选字时停在 [0/N]：滚轮刚滚第一格 (只进了复制模式还没滚)、Ctrl+B [ 手动进的 —— 照常显示
  await wait(1600); mark('[0/40]'); await wait(800);
  ok(await btn(), '没在选字时的复制模式 [0/40] (滚轮第一格 / Ctrl+B [) 照常显示「回到实时画面」');
  got = ''; await p.fill('#dInput', 'hi'); await p.press('#dInput', 'Enter'); await wait(400);
  ok(got.startsWith('qhi'), '复制模式里从输入框发送，照样先发 q 退出: ' + JSON.stringify(got));
  await wait(1600);
  // 往上翻着看历史时再拖动选字：还是在历史里，按钮不藏
  await p.mouse.move(x0, y0); await p.mouse.down();
  await p.mouse.move(x0 + cellW * 6, y0, { steps: 6 }); mark('[3/40]'); await wait(800);
  ok(await btn(), '往上翻着 ([3/40]) 拖动选字时按钮照常显示');
  await p.mouse.up(); await wait(300);

  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
