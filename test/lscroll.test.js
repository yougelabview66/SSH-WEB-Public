'use strict';
const { BASE, ok, wait, shot, launch, post, addHost, devices, hostKey } = require('./helpers');
const { Server, utils } = require('ssh2');

// 模拟 tmux 的历史：3000 行，每 10 行一行红色
const HIST = [];
for (let i = 1; i <= 3000; i++) HIST.push(i % 10 === 0 ? `\x1b[31mERROR line ${i}\x1b[39m 出错了` : i % 7 === 0 ? `line ${i} 长行 ` + "很长的一行 Claude 输出 ".repeat(i % 3 + 2) : `line ${i} 普通输出 abc`); // 有中文、有手机上会折行的长行
const hist = HIST.join('\n') + '\n';
const OTHER = Array.from({ length: 200 }, (_, i) => `完全不相干的另一个 pane ${i}`).join('\n') + '\n';

// mode: ok | none (没有 tmux) | busy (全屏程序) | other (抓到别的 pane) | plain (普通 shell，不开鼠标) | claude (全屏模式的 Claude Code)
let got = ''; let ccUp = 0; let winChanges = 0; const execs = []; const envs = [];
function mockServer(port, mode) {
  new Server({ hostKeys: [hostKey()] }, (c) => {
    c.on('authentication', (ctx) => ctx.accept());
    c.on('ready', () => c.on('session', (acc) => {
      const s = acc();
      s.on('pty', (a) => a()); s.on('window-change', (a) => { winChanges++; a && a(); });
      s.on('env', (a, r, info) => { envs.push({ mode, key: info.key, val: info.val }); a && a(); });
      s.on('shell', (a) => {
        const st = a();
        st.on('data', (d) => {
          got += d; const k = String(d);
          if (mode === 'claude') {
            // 模拟 Claude Code 全屏模式：滚轮往上 → 输入框上方盖一个提示 (两边还是对话内容)，第二次起是「N new messages」；Ctrl+End → 回到底部，提示消失
            if (k.includes('\x1b[<64;')) { st.write(`\x1b7\x1b[20;1H\x1b[K对话内容 xyz          \x1b[7m ${++ccUp > 1 ? ccUp + ' new messages' : 'Jump to bottom'} (ctrl+end) ↓ \x1b[0m          对话内容\x1b8`); }
            if (k === '\x1b[1;5F') { ccUp = 0; st.write('\x1b7\x1b[20;1H\x1b[K\x1b8'); }
            return;
          }
          // 模拟 tmux 复制模式：收到滚轮向上就在右上角显示位置标记，收到 q 退出
          if (mode !== 'plain' && k.includes('\x1b[<64;')) st.write('\x1b7\x1b[1;60H\x1b[7m[5/300]\x1b[0m\x1b8');
          if (mode !== 'plain' && k === 'q') st.write('\x1b7\x1b[1;60H\x1b[K\x1b8');
        });
        if (mode === 'plain') { st.write(HIST.slice(-80).join('\r\n') + '\r\n$ '); return; }
        if (mode === 'claude') {
          st.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[H\x1b[2J' + HIST.slice(-10).join('\r\n')
            + '\r\n回答里提到 Jump to bottom 这几个字\r\nJump to bottom\r\n3 new messages 也是普通文字' // 普通对话文字，不算提示
            + '\x1b[30;1H────────\r\n> \r\n────────');
          return;
        }
        // 像 tmux：备用屏幕 + 鼠标 (SGR)，屏幕上是历史的最后几十行，最后一行状态栏
        st.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[H\x1b[2J' + HIST.slice(-60).join('\r\n') + '\x1b[999;1H\x1b[42m[main] 0:bash*\x1b[K\x1b[0m');
      });
      s.on('exec', (a, r, info) => {
        const ch = a();
        execs.push({ mode, cmd: info.command });
        const code = mode === 'none' ? 3 : mode === 'busy' || mode === 'claude' ? 4 : 0;
        if (!code) ch.write(mode === 'other' ? OTHER : hist);
        ch.exit(code); ch.end();
      });
    }));
  }).listen(port, '127.0.0.1');
}
mockServer(2240, 'ok'); mockServer(2241, 'none'); mockServer(2242, 'busy'); mockServer(2243, 'other'); mockServer(2244, 'plain'); mockServer(2245, 'claude');
const B = BASE;
const WHEEL_UP = '\x1b[<64;';

(async () => {
  for (const [n, port] of [['TMUX', 2240], ['NOTMUX', 2241], ['BUSY', 2242], ['OTHER', 2243], ['PLAIN', 2244], ['CC', 2245]]) {
    await post('/api/hosts', { name: n, host: '127.0.0.1', port, username: 'u', password: 'x' });
  }
  const browser = await launch();
  const errors = [];
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(B + '/'); await p.waitForSelector('#app:not(.hidden)');
  const PORTS = { TMUX: 2240, NOTMUX: 2241, BUSY: 2242, OTHER: 2243, PLAIN: 2244, CC: 2245 };
  const open = async (name) => { await p.locator('.host', { hasText: ':' + PORTS[name] }).first().click(); await wait(1500); };
  const overTerm = async () => { const b = await p.locator('.term.active .term-box').boundingBox(); await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2); };
  const view = () => p.evaluate(() => {
    const v = document.querySelector('.term.active .lscroll'); if (!v) return null;
    const pre = v.querySelector('.ls-body');
    return { top: pre.scrollTop, max: pre.scrollHeight - pre.clientHeight, text: pre.textContent, red: [...pre.querySelectorAll('span')].find((x) => x.textContent.startsWith('ERROR'))?.style.color || '' };
  });

  // ---- tmux：往上滚 → 本地历史视图
  await open('TMUX');
  const termH0 = await p.evaluate(() => document.querySelector('.term.active .term-box').getBoundingClientRect().height);
  await overTerm(); got = ''; winChanges = 0;
  await p.mouse.wheel(0, -100); await wait(1200);
  ok(await p.evaluate(() => !document.querySelector('.term.active .font-toast')), '打开历史视图时不弹「读取 tmux 历史…」');
  let v = await view();
  ok(!!v, 'tmux 里往上滚 → 打开本地历史视图');
  ok(execs.length === 1 && execs[0].cmd.includes('capture-pane') && execs[0].cmd.includes('-S -3000'), '服务端在目标主机上执行 tmux capture-pane 抓 3000 行');
  ok(!got.includes(WHEEL_UP), '这一下滚轮没有发给 tmux');
  const env = envs.find((e) => e.mode === 'ok' && e.key === 'LC_SSHWEB');
  ok(env && /^[0-9a-f-]{36}$/.test(env.val), '打开 shell 时带上 LC_SSHWEB=<会话 ID> 环境变量: ' + (env && env.val));
  ok(env && execs[0].cmd.includes('LC_SSHWEB=' + env.val), '抓历史时按这个 ID 找对应的 tmux 客户端');
  ok(v && v.text.includes('line 1 普通输出') && v.text.includes('ERROR line 3000'), '历史视图里有完整的 3000 行');
  ok(v && /rgb|#/.test(v.red), '颜色保留 (ERROR 行是红色: ' + (v && v.red) + ')');
  ok(v && v.max - v.top > 0 && v.max - v.top < 200, `一开始停在底部往回几行的位置 (离底部 ${v && v.max - v.top}px)`);
  const lsH = await p.evaluate(() => document.querySelector('.term.active .lscroll').getBoundingClientRect().height);
  ok(await p.isHidden('#deskBar') && lsH > termH0 + 40, `历史视图打开时输入框藏起来，历史视图变高 (${Math.round(termH0)} → ${Math.round(lsH)}px)`);
  ok(winChanges === 0, '输入框藏起来时终端尺寸不变 (不会让 tmux 整屏重画)');
  await p.screenshot({ path: shot('lscroll.png') });
  // 本地滚动：不再发任何东西给服务器
  const before = got.length;
  for (let i = 0; i < 20; i++) await p.mouse.wheel(0, -300);
  await wait(500); v = await view();
  ok(v && v.max - v.top > 3000 && got.length === before && execs.length === 1, `连续往上滚在本地进行 (离底部 ${v && v.max - v.top}px)，没有发给服务器`);
  // Esc 返回，不发 Esc 给终端
  got = ''; await p.keyboard.press('Escape'); await wait(300);
  ok(!(await view()) && !got.includes('\x1b'), 'Esc → 回到实时画面，Esc 没有发给终端');
  ok(await p.isVisible('#deskBar') && winChanges === 0 && await p.evaluate(() => document.activeElement.id) === 'dInput', '回到实时画面后输入框回来、焦点在输入框，终端尺寸始终没变');
  // 滚到底再往下 → 返回
  await overTerm(); await p.mouse.wheel(0, -100); await wait(1000);
  ok(!!(await view()) && execs.length === 2, '再往上滚 → 重新抓一次最新历史');
  await p.evaluate(() => { const pre = document.querySelector('.term.active .ls-body'); pre.scrollTop = pre.scrollHeight; });
  await wait(200); await p.mouse.wheel(0, 200); await wait(300);
  ok(!(await view()), '滚到最底下再往下滚 → 回到实时画面');
  // 打字 → 返回
  await overTerm(); await p.mouse.wheel(0, -100); await wait(1000);
  got = ''; await p.keyboard.type('ls'); await p.keyboard.press('Enter'); await wait(400);
  ok(!(await view()) && got.includes('ls') && await p.isVisible('#deskBar'), '输入框藏着时直接打字 → 回到实时画面，打的字一个不少照常发出: ' + JSON.stringify(got));
  // 连按两下 Alt：历史视图打开时下方输入框是藏起来的 → 先回到实时画面，光标放回输入框
  await overTerm(); await p.mouse.wheel(0, -100); await wait(1000);
  await p.keyboard.press('Alt'); await p.keyboard.press('Alt'); await wait(300);
  ok(!(await view()) && await p.isVisible('#deskBar') && await p.evaluate(() => document.activeElement.id) === 'dInput', '历史视图打开时连按两下 Alt：回到实时画面，光标在下方输入框');
  // 选中即复制：在历史视图里拖动选中，松开鼠标就复制到剪贴板 (不用按 Ctrl+C)，选区还在
  await p.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await p.evaluate(() => navigator.clipboard.writeText('旧内容'));
  await overTerm(); await p.mouse.wheel(0, -100); await wait(1000);
  const lb0 = await p.locator('.term.active .ls-body').boundingBox();
  got = '';
  await p.mouse.move(lb0.x + 20, lb0.y + 40); await p.mouse.down();
  await p.mouse.move(lb0.x + 300, lb0.y + 100, { steps: 5 }); await p.mouse.up(); await wait(400);
  const sel = await p.evaluate(() => getSelection().toString());
  const clip = await p.evaluate(() => navigator.clipboard.readText());
  const toastT = await p.evaluate(() => document.querySelector('.term.active .lscroll .font-toast')?.textContent || '');
  ok(sel.length > 10 && clip === sel && got === '', `历史视图里选中文字松开就复制到剪贴板 (${clip.length} 个字符)，没有发给终端`);
  ok(toastT === `已复制 ${sel.length} 个字符` && !!(await view()), '提示「' + toastT + '」，历史视图不关');
  const tp = await p.evaluate(() => { const v = document.querySelector('.term.active .lscroll').getBoundingClientRect(), t = document.querySelector('.term.active .lscroll .font-toast').getBoundingClientRect(), c = document.querySelector('.term.active .ls-close').getBoundingClientRect();
    return { right: Math.round(v.right - t.right), aboveClose: Math.round(c.top - t.bottom), bottom: Math.round(v.bottom - t.bottom) }; });
  ok(tp.right < 30 && tp.aboveClose >= 0 && tp.bottom < 80, `提示在右下角、「回到实时画面」上面 (离右边 ${tp.right}px，离底部 ${tp.bottom}px)`);
  await p.screenshot({ path: shot('lscroll-copysel.png') });
  await p.mouse.click(lb0.x + 20, lb0.y + 40); await wait(300); // 单击 (没选中文字) 不复制
  ok(await p.evaluate(() => navigator.clipboard.readText()) === clip, '单击不复制');
  // 按钮 → 返回
  await p.click('.term.active .ls-close'); await wait(300);
  ok(!(await view()), '点「回到实时画面」返回');
  // 往下滚不触发
  await overTerm(); const e0 = execs.length; await p.mouse.wheel(0, 100); await wait(500);
  ok(!(await view()) && execs.length === e0, '往下滚不会打开历史视图');

  // ---- 回退：没有 tmux / 全屏程序 / 抓到别的 pane → 滚轮照旧发给程序
  for (const [name, desc] of [['NOTMUX', '没有 tmux'], ['BUSY', 'pane 里是全屏程序 / 复制模式'], ['OTHER', '抓到的不是这个画面']]) {
    await open(name); await overTerm();
    const ex = execs.length; got = '';
    await p.mouse.wheel(0, -100); await wait(1000);
    ok(!(await view()) && execs.length === ex + 1 && got.includes(WHEEL_UP), `${desc} → 不打开历史视图，这一下滚轮补发给程序`);
    got = ''; await p.mouse.wheel(0, -100); await wait(500);
    ok(execs.length === ex + 1 && got.includes(WHEEL_UP), `${desc} → 之后一段时间直接发给程序，不再重复去抓`);
  }
  // ---- 回退后：提示原因；tmux 复制模式也有「回到实时画面」
  await open('OTHER'); await wait(5000); await overTerm();
  await p.mouse.wheel(0, -100); await wait(900);
  const toast = await p.evaluate(() => document.querySelector('.term.active .font-toast')?.textContent || '');
  ok(toast === '', '本地滚动用不了时不弹任何提示');
  await wait(500);
  ok(await p.isVisible('.term.active .tmux-exit'), '进入 tmux 自己的复制模式 ([5/300]) → 也显示「回到实时画面」');
  await p.screenshot({ path: shot('copymode.png') });
  got = ''; await p.click('.term.active .tmux-exit'); await wait(700);
  ok(got === 'q' && await p.isHidden('.term.active .tmux-exit'), '点它发送 q 退出复制模式，按钮消失');
  await open('NOTMUX'); await wait(500);
  ok(await p.evaluate(() => !document.querySelector('.term.active .font-toast')), '没有 tmux 时也不弹提示');
  // ---- Claude Code 全屏模式：它自己滚，出现「Jump to bottom (ctrl+end) ↓」时也显示「回到实时画面」
  await open('CC'); await wait(500);
  ok(await p.isHidden('.term.active .tmux-exit'), 'Claude Code 全屏模式：对话里的普通文字 (Jump to bottom / 3 new messages) 不当成提示');
  await overTerm(); got = '';
  await p.mouse.wheel(0, -100); await wait(1500);
  ok(got.includes(WHEEL_UP) && !(await view()), 'Claude Code 全屏模式：滚轮交给它自己滚，不打开历史视图');
  ok(await p.isVisible('.term.active .tmux-exit'), '出现「Jump to bottom (ctrl+end) ↓」→ 显示「回到实时画面」');
  await p.mouse.wheel(0, -100); await wait(600);
  ok(await p.isVisible('.term.active .tmux-exit'), '变成「2 new messages (ctrl+end) ↓」时按钮还在');
  await p.screenshot({ path: shot('cc-fullscreen.png') });
  got = ''; await p.click('.term.active .tmux-exit'); await wait(700);
  ok(got === '\x1b[1;5F' && await p.isHidden('.term.active .tmux-exit'), '点它发送 Ctrl+End 回到最新对话，提示消失后按钮也消失: ' + JSON.stringify(got));
  // ---- 普通 shell (没开鼠标)：xterm 自己的本地滚动，不去抓
  await open('PLAIN'); await overTerm();
  const ex2 = execs.length;
  const y0 = await p.evaluate(() => document.querySelector('.term.active .xterm-viewport')?.scrollTop ?? -1);
  await p.mouse.wheel(0, -300); await wait(500);
  const y1 = await p.evaluate(() => document.querySelector('.term.active .xterm-viewport')?.scrollTop ?? -1);
  ok(!(await view()) && execs.length === ex2, `普通 shell 不去抓 tmux 历史 (xterm 自己滚动 ${y0} → ${y1})`);

  // ---- 手机：在终端上往下滑 (往回看) → 打开历史视图
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const m = await ctx.newPage(); m.on('pageerror', (e) => errors.push(e.message));
  await m.goto(B + '/'); await m.waitForSelector('.tab'); await wait(1000);
  await m.locator('.tab', { hasText: 'TMUX-1' }).first().tap(); await wait(1200);
  const cdp = await ctx.newCDPSession(m);
  const box = await m.locator('.term.active .term-box').boundingBox();
  const x = box.x + box.width / 2, y0t = box.y + 200;
  got = '';
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0t }] });
  for (let i = 1; i <= 15; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0t + i * 20 }] }); await wait(30); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await wait(1500);
  const mv = await m.evaluate(() => { const pre = document.querySelector('.term.active .ls-body'); return pre ? { top: pre.scrollTop, max: pre.scrollHeight - pre.clientHeight } : null; });
  ok(!!mv && !got.includes(WHEEL_UP), '手机：在终端上往下滑 → 打开本地历史视图，滑动没有发给 tmux');
  ok(await m.isHidden('#mobileBar'), '手机：历史视图打开时输入栏 (连同按键栏) 藏起来');
  await m.screenshot({ path: shot('lscroll-mobile.png') });
  // 在历史视图里长按复制：复制的是历史，面板停在正在看的那一行 (不是终端当前那一屏)
  // 有折行的长行、有中文 (后备字体行更高)：按文字找到第 1501 行，把它滚到历史视图最上面
  const seen = await m.evaluate(() => {
    const pre = document.querySelector('.term.active .ls-body'), w = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    let n = 0, node;
    while ((node = w.nextNode())) {
      const t = node.data; let i = -1;
      while (n < 1500 && (i = t.indexOf('\n', i + 1)) >= 0) n++;
      if (n === 1500) { const rg = document.createRange(); rg.setStart(node, i + 1); rg.setEnd(node, i + 2);
        pre.scrollTop += rg.getBoundingClientRect().top - pre.getBoundingClientRect().top; break; }
    }
    return pre.textContent.split('\n')[1500];
  });
  const lb = await m.locator('.term.active .ls-body').boundingBox();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: lb.x + 100, y: lb.y + 150 }] }); await wait(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await wait(800); // 等面板过一会儿的再次对齐
  const cp = await m.evaluate(() => {
    const ta = document.getElementById('copyText'), lines = ta.value.split('\n'), full = ta.value, st = ta.scrollTop;
    // 复制面板最上面是哪一行：前 k 行在这个文本框里实际多高，正好等于滚动位置的那个 k
    const pb = parseFloat(getComputedStyle(ta).paddingBottom);
    const h = (k) => { ta.value = full.split('\n', k).join('\n'); return ta.scrollHeight - pb; };
    ta.style.flex = 'none'; ta.style.height = ta.style.minHeight = '0px';
    let top = '';
    for (let k = 1; k < lines.length; k++) if (Math.abs(h(k) - st) < 2) { top = lines[k]; break; } else if (k % 100 === 0 && h(k + 100) < st) k += 99;
    ta.value = full; ta.style.flex = ta.style.height = ta.style.minHeight = ''; ta.scrollTop = st;
    return { shown: !document.getElementById('copyPanel').classList.contains('hidden'), n: lines.length, top,
      info: document.getElementById('copyInfo').textContent, hasOld: ta.value.includes('line 1 普通输出'), hasNew: ta.value.includes('ERROR line 3000') };
  });
  ok(cp.shown && cp.hasOld && cp.hasNew && cp.n >= 3000 && cp.info.includes('tmux 历史'), `手机：在历史视图里长按 → 复制面板里是整段 tmux 历史 (${cp.n} 行，${cp.info})，不是终端当前那一屏`);
  const num = (t) => +(/line (\d+)/.exec(t || '') || [])[1];
  ok(num(cp.top) === num(seen), `复制面板停在正在看的那一行 (历史视图最上面「${seen}」，复制面板最上面「${cp.top}」)`);
  await m.screenshot({ path: shot('lscroll-copy.png') });
  await m.evaluate(() => document.getElementById('copyPanel').classList.add('hidden'));
  await m.locator('.term.active .ls-close').tap(); await wait(400);
  ok(!(await m.$('.term.active .lscroll')) && await m.isVisible('#mobileBar'), '手机：点「回到实时画面」后输入栏回来');
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
