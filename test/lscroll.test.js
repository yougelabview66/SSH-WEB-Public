'use strict';
const { BASE, ok, wait, shot, launch, post, addHost, devices, hostKey, waitFor } = require('./helpers');
const { Server, utils } = require('ssh2');

// 模拟 tmux 的历史：3000 行，每 10 行一行红色
// 从 v1.83.40 起每行都夹好几段颜色 (像 Claude Code / 常驻会话的 localHistory)：ANSI 在终端里不占格，
// 切行时必须跳过。以前只有每 10 行一处红色，转义太少、偏差小到测不出来 —— 而转义被算成格数后，
// 显示行数比原文行数多出一截，复制面板按显示行号去原文里找行就会越界落到最后一行。
// 可见文字和以前一字不差 (只是拆成几段上色)，下面那些「和整段历史一字不差」的断言才照旧成立
const COLOR = (t, c) => `\x1b[${c}m${t}\x1b[0m`;
const HIST = [];
for (let i = 1; i <= 3000; i++) {
  HIST.push(i % 10 === 0 ? `${COLOR('ERROR', 31)} line ${COLOR(String(i), 33)} 出错了`
    : i % 7 === 0 ? `${COLOR('line', 36)} ${COLOR(String(i), 33)} ${COLOR('长行', 32)} ` + COLOR("很长的一行 Claude 输出 ".repeat(i % 3 + 2), 90)
    : `${COLOR('line', 36)} ${COLOR(String(i), 33)} ${COLOR('普通输出', 32)} ${COLOR('abc', 90)}`); // 有中文、有手机上会折行的长行
}
// 第 2900 行末尾开始蓝色、到第 2901 行才结束：正好跨过历史视图分块的边界 (块从最后往前每 100 行一块)。
// 这两行不加自己的颜色，蓝色才能一路带到下一块
HIST[2899] = 'line 2900 普通输出 abc\x1b[34m';
HIST[2900] = 'line 2901 普通输出 abc\x1b[39m';
const hist = HIST.join('\n') + '\n';
const PLAIN_HIST = HIST.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
const OTHER = Array.from({ length: 200 }, (_, i) => `完全不相干的另一个 pane ${i}`).join('\n') + '\n';

// mode: ok | none (没有 tmux) | busy (全屏程序) | other (抓到别的 pane) | plain (普通 shell，不开鼠标) | claude (全屏模式的 Claude Code)
let got = ''; let ccUp = 0; let winChanges = 0; const execs = []; const envs = [];
let opens = 0; let dropShell = false; // 开了几次 exec 通道；dropShell：常驻的 sh 收到下一段脚本时直接断开
let replyDelay = 0; // 常驻的 sh 晚这么多毫秒才回结果 (模拟远的主机)
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
        if (info.command.includes('hook.log')) return; // 读 Claude Code 钩子事件的通道 (tail -F 一直开着)，不是抓历史
        if (info.command === 'echo %OS%;$env:OS') { ch.write('%OS%\n'); ch.exit(0); ch.end(); return; } // 认 SSH 默认的 shell (像 Linux 的 sh)，不是抓历史
        opens++;
        const code = mode === 'none' ? 3 : mode === 'busy' || mode === 'claude' ? 4 : 0;
        const out = code ? '' : mode === 'other' ? OTHER : hist;
        if (info.command === 'sh') { // 常驻的 sh：读进来的每段脚本执行一次，最后打印结束标记和退出码
          let buf = '';
          ch.on('data', (d) => {
            buf += d;
            let m;
            while ((m = /printf '\\n%s %s\\n' '(\w+)' "\$\?"\n/.exec(buf))) {
              execs.push({ mode, cmd: buf.slice(0, m.index) });
              buf = buf.slice(m.index + m[0].length);
              if (dropShell) { dropShell = false; ch.close(); return; }
              const res = out + `\n${m[1]} ${code}\n`; // 分几次写回去，结束标记也拆开
              const reply = () => {
                for (let i = 0; i < res.length - 12; i += 50000) ch.write(res.slice(i, Math.min(i + 50000, res.length - 12)));
                ch.write(res.slice(-12));
              };
              if (replyDelay) setTimeout(reply, replyDelay); else reply();
            }
          });
          return;
        }
        execs.push({ mode, cmd: info.command });
        if (!code) ch.write(out);
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
  ok(v && v.text.includes('ERROR line 3000'), '历史视图马上显示最后面的内容');
  await waitFor(p, () => document.querySelector('.term.active .ls-body')?.textContent.startsWith('line 1 普通输出'), null, 8000).catch(() => {});
  v = await view();
  ok(v && v.text.replace(/\n+$/, '') === PLAIN_HIST, '前面的历史在后台分块补上：最后和整段 3000 行一字不差 (块与块之间的换行不多不少)');
  ok(v && /rgb|#/.test(v.red), '颜色保留 (ERROR 行是红色: ' + (v && v.red) + ')');
  const carry = await p.evaluate(() => {
    const pre = document.querySelector('.term.active .ls-body');
    const sp = [...pre.querySelectorAll('span')].find((x) => x.textContent.startsWith('line 2901'));
    return { n: pre.children.length, color: sp?.style.color || '', block: sp && sp.closest('.ls-body > div') !== [...pre.querySelectorAll('span')].find((x) => x.textContent.startsWith('ERROR line 2900'))?.closest('.ls-body > div') };
  });
  ok(carry.n === 30 && carry.block && /rgb|#/.test(carry.color), `分成 ${carry.n} 块，颜色接着上一块 (第 2901 行在新的一块里，接着第 2900 行末尾的蓝色: ${carry.color})`);
  const selAll = await p.evaluate(() => { const pre = document.querySelector('.term.active .ls-body'); getSelection().selectAllChildren(pre); const t = getSelection().toString(); getSelection().removeAllRanges(); return t; });
  ok(selAll.replace(/\n+$/, '') === PLAIN_HIST, '跨块选中复制的文字和整段历史一样');
  ok(opens === 1, '抓历史开了一个常驻通道');
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
  // Ctrl+End → 直接回到实时画面 (以前只滚到历史视图底部，还要再往下滚一下)，不发给终端
  await overTerm(); await p.mouse.wheel(0, -100); await wait(1000);
  ok(!!(await view()) && await p.evaluate(() => document.activeElement.classList.contains('ls-body')), '打开历史视图时焦点在历史视图上');
  // 比「离底部多远」不比 scrollTop：前面的历史还在后台往上补，scrollTop 会被整体推大
  v = await view(); await p.keyboard.press('PageUp'); await wait(200);
  const v2 = await view();
  ok(v2.max - v2.top > v.max - v.top, `PageUp 直接滚历史视图 (离底部 ${v.max - v.top} → ${v2.max - v2.top}px)`);
  got = ''; await p.keyboard.press('Control+End'); await wait(300);
  ok(!(await view()) && got === '' && await p.evaluate(() => document.activeElement.id) === 'dInput', 'Ctrl+End → 回到实时画面，焦点回到输入框，没有发给终端: ' + JSON.stringify(got));
  await overTerm(); await p.mouse.wheel(0, -100); await wait(1000);
  got = ''; await p.keyboard.press('End'); await wait(300);
  ok(!(await view()) && got === '', 'End → 回到实时画面');
  await overTerm(); await p.mouse.wheel(0, -100); await wait(1000);
  await p.keyboard.press('PageDown'); await wait(200);
  ok(!!(await view()), '还没到底时 PageDown 只往下滚');
  await p.evaluate(() => { const pre = document.querySelector('.term.active .ls-body'); pre.scrollTop = pre.scrollHeight; });
  await p.keyboard.press('PageDown'); await wait(300);
  ok(!(await view()), '到底了再按 PageDown → 回到实时画面');
  // 滚到底再往下 → 返回
  const ex0 = execs.length;
  await overTerm(); await p.mouse.wheel(0, -100); await wait(1000);
  ok(!!(await view()) && execs.length === ex0 + 1, '再往上滚 → 重新抓一次最新历史');
  ok(opens === 1, `之后再抓历史还是用那个常驻通道，不再每次开新通道 (抓了 ${execs.length} 次，开了 ${opens} 个通道)`);
  await p.evaluate(() => { const pre = document.querySelector('.term.active .ls-body'); pre.scrollTop = pre.scrollHeight; });
  await wait(200); await p.mouse.wheel(0, 200); await wait(300);
  ok(!(await view()), '滚到最底下再往下滚 → 回到实时画面');
  await wait(300); // 停一下：这一下滚动结束
  // 滚轮 / 触摸板往下滚回实时画面时，同一下滚动末尾常带一两格反方向的抖动：不能把历史视图又打开
  const ex1 = execs.length;
  await overTerm(); await p.mouse.wheel(0, -100); await wait(1000);
  await p.evaluate(() => { const pre = document.querySelector('.term.active .ls-body'); pre.scrollTop = pre.scrollHeight; });
  await wait(200); got = '';
  await p.mouse.wheel(0, 200); await wait(30); await p.mouse.wheel(0, 100); await wait(30); await p.mouse.wheel(0, -40); await wait(30); await p.mouse.wheel(0, 100);
  await wait(1200);
  ok(!(await view()) && execs.length === ex1 + 1 && !got.includes('\x1b[<6'), '往下滚回实时画面时夹着一下往上的抖动 → 不会又跳回历史视图，剩下的滚动也不发给 tmux');
  await p.mouse.wheel(0, -100); await wait(1000);
  ok(!!(await view()) && execs.length === ex1 + 2, '停一下再往上滚 → 照常打开历史视图');
  await p.click('.term.active .ls-close'); await wait(500);
  // 往上滚一下马上又往下滚回来 (历史还没抓回来)：最后是往下的，不打开
  // (主机回得慢一点：本机测试里历史 20 毫秒就回来了，比测试里滚轮的间隔还快，谁先到全看运气)
  replyDelay = 300;
  await overTerm(); await p.mouse.wheel(0, -100); await wait(20); await p.mouse.wheel(0, 100); await p.mouse.wheel(0, 100); await wait(1000);
  replyDelay = 0;
  ok(!(await view()) && execs.length === ex1 + 3, '往上滚一下又马上往下滚回来 → 历史抓回来也不打开');
  // 慢主机：常驻 sh 通道 4.5 秒才回 (以前常驻通道内部写死 3 秒超时，调用处传的 10 秒被忽略 → 报 timeout、静默 30 秒)
  replyDelay = 4500;
  await overTerm(); const exSlow = execs.length;
  await p.mouse.wheel(0, -100); await wait(6000);
  replyDelay = 0;
  ok(!!(await view()) && execs.length === exSlow + 1, '常驻通道 4.5 秒才回 → 照样打开历史视图 (超时放宽到 10 秒生效了)');
  await p.click('.term.active .ls-close'); await wait(500);
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
  // 常驻通道半路断了：这次改用临时通道照常打开，下次重新开常驻通道
  dropShell = true; const op0 = opens, ex3 = execs.length;
  await overTerm(); await p.mouse.wheel(0, -100); await wait(1200);
  ok(!!(await view()) && opens === op0 + 1 && execs.length === ex3 + 2 && execs[execs.length - 1].cmd.startsWith('sh -c'), '常驻通道断了 → 这次临时开通道抓，历史视图照常打开');
  await p.click('.term.active .ls-close'); await wait(300);
  await overTerm(); await p.mouse.wheel(0, -100); await wait(1000);
  ok(!!(await view()) && opens === op0 + 2 && execs.length === ex3 + 3, '下一次重新开常驻通道');
  await p.click('.term.active .ls-close'); await wait(300);
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
  const clickTermGoesDesk = async () => {
    await p.locator('.term.active .xterm-helper-textarea').focus();
    const b = await p.locator('.term.active .xterm-screen').boundingBox();
    await p.mouse.click(b.x + 200, b.y + 120); await wait(300);
    return p.evaluate(() => document.activeElement.id === 'dInput');
  };
  ok(await clickTermGoesDesk(), '退出复制模式发的 q 不算打进输入框的字：之后点终端光标照常回到下方输入框 (以前一直留在终端)');
  // 在复制模式里直接从输入框发送：先自动退出复制模式 (发 q)，消息照常发出去 (以前被复制模式吃掉)
  await overTerm(); await p.mouse.wheel(0, -100); await wait(900);
  ok(await p.isVisible('.term.active .tmux-exit'), '再往上滚又进了复制模式');
  await p.focus('#dInput'); await p.keyboard.type('继续'); got = '';
  // 回车要等程序把文字显示出来才写 (模拟的主机不回显：最多等 0.4 ~ 1.5 秒，见 lib/session/input.js 的 echoCap)，
  // 等到回车到了再比，不按固定时间 —— 机器慢一点 (GitHub 的测试机) 就会在回车到之前比、误报失败
  const enterArrived = async () => { for (const end = Date.now() + 3000; !got.endsWith('\r') && Date.now() < end;) await wait(50); };
  await p.keyboard.press('Enter'); await enterArrived(); await wait(200);
  ok(got === 'q继续\r' && await p.isHidden('.term.active .tmux-exit'), '复制模式里从输入框发送 → 先发 q 退出复制模式，消息照常发出: ' + JSON.stringify(got));
  got = ''; await p.keyboard.type('再来'); await p.keyboard.press('Enter'); await enterArrived(); await wait(200);
  ok(got === '再来\r', '已经回到实时画面时照常发送，不多发 q: ' + JSON.stringify(got));
  // 复制模式里按 Ctrl+End (tmux 不认，以前按了没反应)：换成 q 退出
  await overTerm(); await p.mouse.wheel(0, -100); await wait(900);
  await p.focus('#dInput'); got = ''; await p.keyboard.press('Control+End'); await wait(700);
  ok(got === 'q' && await p.isHidden('.term.active .tmux-exit'), '复制模式里按 Ctrl+End → 发 q 退出复制模式: ' + JSON.stringify(got));
  ok(await clickTermGoesDesk(), 'Ctrl+End 退出复制模式后，点终端光标照常回到下方输入框');
  await p.focus('#dInput');
  got = ''; await p.keyboard.press('Control+End'); await wait(300);
  ok(got === '\x1b[1;5F', '不在复制模式时 Ctrl+End 照常发给程序: ' + JSON.stringify(got));
  // 在复制模式里打 / 进命令模式：也先退出 (不然 / 是复制模式里的搜索)
  await overTerm(); await p.mouse.wheel(0, -100); await wait(900);
  await p.focus('#dInput'); got = ''; await p.keyboard.type('/'); await wait(500);
  ok(got === 'q/' && await p.isHidden('.term.active .tmux-exit'), '复制模式里打 / → 先退出复制模式再进命令模式: ' + JSON.stringify(got));
  await p.keyboard.press('Escape'); await wait(300);
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
  // 在历史视图里长按复制：复制的是历史 (不是终端当前那一屏)，按住的那一行在复制面板里就在手指底下
  // 有折行的长行、有中文 (后备字体行更高)：按文字找到第 1501 行，把它滚到历史视图最上面
  const seen = await m.evaluate(() => {
    const pre = document.querySelector('.term.active .ls-body'), w = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    let n = 0, node;
    while ((node = w.nextNode())) {
      const t = node.data; let i = -1;
      while (n < 1500 && (i = t.indexOf('\n', i + 1)) >= 0) n++;
      if (n === 1500) { // 下一行可能在下一个文字节点 (下一块) 里
        let tn = node, o = i + 1;
        while (tn && o >= tn.data.length) { tn = w.nextNode(); o = 0; }
        const rg = document.createRange(); rg.setStart(tn, o); rg.setEnd(tn, o + 1);
        pre.scrollTop += rg.getBoundingClientRect().top - pre.getBoundingClientRect().top; break; }
    }
    return pre.textContent.split('\n')[1500];
  });
  const lb = await m.locator('.term.active .ls-body').boundingBox();
  const px = lb.x + 100, py = Math.round(lb.y + lb.height * 0.6); // 复制面板的文本框盖得到的高度
  const pressed = await m.evaluate(([x, y]) => { // 手指下面是哪一行 (按文字)
    const pre = document.querySelector('.term.active .ls-body'), rg = document.caretRangeFromPoint(x, y), r = document.createRange();
    r.setStart(pre, 0); r.setEnd(rg.startContainer, rg.startOffset);
    return pre.textContent.split('\n')[(r.toString().match(/\n/g) || []).length];
  }, [px, py]);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: px, y: py }] }); await wait(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await wait(800); // 等面板过一会儿的再次对齐
  const cp = await m.evaluate((y) => {
    const ta = document.getElementById('copyText'), lines = ta.value.split('\n'), full = ta.value, st = ta.scrollTop;
    // 复制面板里手指高度是哪一行：前 k 行在这个文本框里实际多高 (量出来的，中文行更高)，找到盖住手指的那一行
    const target = y - ta.getBoundingClientRect().top - ta.clientTop + st;
    const pb = parseFloat(getComputedStyle(ta).paddingBottom), pad = ta.style.paddingBottom;
    ta.style.flex = 'none'; ta.style.height = ta.style.minHeight = '0px';
    const h = (k) => { ta.value = full.split('\n', k).join('\n'); return k ? ta.scrollHeight - pb : 0; };
    let lo = 0, hi = lines.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (h(mid) <= target) lo = mid; else hi = mid - 1; }
    ta.value = full; ta.style.flex = ta.style.height = ta.style.minHeight = ''; ta.style.paddingBottom = pad; ta.scrollTop = st;
    const top = lines[lo];
    return { shown: !document.getElementById('copyPanel').classList.contains('hidden'), n: lines.length, top,
      info: document.getElementById('copyInfo').textContent, hasOld: ta.value.includes('line 1 普通输出'), hasNew: ta.value.includes('ERROR line 3000') };
  }, py);
  ok(cp.shown && cp.hasOld && cp.hasNew && cp.n >= 3000 && cp.info.includes('tmux 历史'), `手机：在历史视图里长按 → 复制面板里是整段 tmux 历史 (${cp.n} 行，${cp.info})，不是终端当前那一屏`);
  const num = (t) => +(/line (\d+)/.exec(t || '') || [])[1];
  ok(num(pressed) > num(seen) && num(cp.top) === num(pressed), `按住的那一行在复制面板里就在手指底下 (按住「${pressed}」，面板里手指处「${cp.top}」)`);
  // 长行不折行 (电脑上画的宽表格折行后每行错开)，左右滑动看：有横向溢出，最长那行比一行能放下的格数长
  const wrap = await m.evaluate(() => {
    const ta = document.getElementById('copyText'), cs = getComputedStyle(ta);
    const longest = Math.max(...ta.value.split('\n').map((l) => l.length));
    const probe = document.createElement('span'); probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${cs.font}`;
    probe.textContent = '0'.repeat(10); document.body.appendChild(probe);
    const fit = Math.floor((ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) / (probe.getBoundingClientRect().width / 10)); probe.remove();
    return { ws: cs.whiteSpace, sw: ta.scrollWidth, cw: ta.clientWidth, longest, fit };
  });
  ok(wrap.ws === 'pre' && wrap.sw > wrap.cw && wrap.longest > wrap.fit, '手机：复制面板里长行不折行，可以左右滑动看 (有横向溢出) ' + JSON.stringify(wrap));
  const left = await m.evaluate(() => { const ta = document.getElementById('copyText'); ta.scrollLeft = 200; return ta.scrollLeft; });
  ok(left > 0, `手机：复制面板能左右滚 (scrollLeft ${left})`);
  await m.screenshot({ path: shot('lscroll-copy.png') });
  await m.evaluate(() => document.getElementById('copyPanel').classList.add('hidden'));
  // 电脑上在用这个标签 (手机这边锁着，点终端本来就不聚焦输入框)：先在手机上接管，下面才测得出会不会弹输入法
  const claim = async () => { await m.evaluate(() => document.querySelector('.term.active .owner-notice button')?.click()); await wait(500); };
  const mFocused = () => m.evaluate(() => document.activeElement?.id === 'mInput');
  await claim();
  ok(!!(await m.$('.term.active .lscroll')) && !(await m.$('.term.active .owner-notice')), '手机：接管后历史视图还开着');
  const hOf = (sel) => m.evaluate((sel) => document.querySelector(sel).getBoundingClientRect().height, sel);
  // 按钮尺寸要在点掉之前量 (点了之后历史视图和按钮都没了)
  const closeH = await hOf('.term.active .ls-close');
  const closeW = await m.evaluate(() => { const b = document.querySelector('.term.active .ls-close').getBoundingClientRect(); const v = document.querySelector('.term.active .lscroll').getBoundingClientRect(); return { bw: Math.round(b.width), vw: Math.round(v.width), br: Math.round(v.right - b.right) }; });
  await m.locator('.term.active .ls-close').tap(); await wait(400);
  ok(!(await m.$('.term.active .lscroll')) && await m.isVisible('#mobileBar'), '手机：点「回到实时画面」后输入栏回来');
  const keyH = await hOf('#mobileBar .mkeys button');
  // 以前是按按键栏按钮的高度设 (约 32px)，手指够不准；现在固定 56px 的整条通栏按钮
  ok(closeH >= 44, `手机：「回到实时画面」够大 (${closeH}px，最小点击区 44px，按键栏按键 ${keyH}px)`);
  // 位置还是右下角 (没占满宽度)，但按钮本身要够大
  ok(closeW.bw >= 100 && closeW.bw < closeW.vw * 0.6 && closeW.br >= 20 && closeW.br < 40, `手机：「回到实时画面」够大、离右边有一点距离但不过分 (${closeW.bw}×${closeH}px，离右边 ${closeW.br}px，终端宽 ${closeW.vw}px)`);
  ok(!(await mFocused()), '手机：点「回到实时画面」不聚焦输入框 (不弹输入法)');
  // tmux 自己的复制模式 (抓到的不是这个画面，滑动交给 tmux) 的「回到实时画面」也一样
  await m.locator('.tab', { hasText: 'OTHER' }).first().tap(); await wait(1500); await claim();
  const swipeDown = async () => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0t }] });
    for (let i = 1; i <= 15; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0t + i * 20 }] }); await wait(30); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await wait(1500);
  };
  await swipeDown();
  if (await m.isHidden('.term.active .tmux-exit')) await swipeDown(); // 第一下用来发现抓不到，之后的滑动才交给 tmux
  ok(await m.isVisible('.term.active .tmux-exit'), '手机：tmux 复制模式也显示「回到实时画面」');
  const exH = await hOf('.term.active .tmux-exit');
  ok(exH >= 44, `手机：tmux 复制模式的「回到实时画面」也够大 (${exH}px，按键栏按键 ${keyH}px)`);
  got = ''; await m.locator('.term.active .tmux-exit').tap(); await wait(700);
  // (按钮消失由上面电脑的测试管：模拟的 tmux 把位置标记画在第 60 列，手机终端没这么宽，清不干净)
  ok(got === 'q' && !(await mFocused()), '手机：点它发 q 退出复制模式，不聚焦输入框 (不弹输入法): ' + JSON.stringify(got));
  await m.locator('.term.active .xterm-screen').tap(); await wait(300);
  ok(await mFocused(), '手机：点终端本身还是照常聚焦输入框');
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
