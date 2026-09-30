'use strict';
// 连按两下 Alt 在下方输入框和终端之间只切换光标，两边的字都不动
const { BASE, ok, wait, shot, launch, hostKey } = require('./helpers');
const { Server } = require('ssh2');

// 模拟 Claude Code 的输入框：上下两条横线，❯ 开头；空的时候显示灰色提示文字；
// 多行粘贴显示成 [Pasted text #1 +3 lines]；Ctrl+L 清空；长文字按单词折行，续行缩进两格
const W = 40;
let got = '', termRows = 0, ccStream = null;
function claudeServer(port, plain, mouse) {
  new Server({ hostKeys: [hostKey()] }, (c) => {
    c.on('authentication', (ctx) => ctx.accept());
    c.on('ready', () => c.on('session', (acc) => {
      const s = acc();
      s.on('pty', (a, r, i) => { termRows = i.rows; a(); }); s.on('window-change', (a, r, i) => { termRows = i.rows; a && a(); });
      s.on('shell', (a) => {
        const st = a();
        if (!plain && !mouse) ccStream = st;
        if (plain) { st.write('$ ls\r\nfile1  file2\r\n$ '); st.on('data', (d) => { got += d; }); return; }
        let cur = '', pastes = 0; const hist = [];
        const wrap = (t) => {
          const lines = [];
          for (const para of t.split('\n')) {
            let ln = '';
            for (const w of para.split(' ')) {
              if (ln && (ln + ' ' + w).length > W - 2) { lines.push(ln); ln = w; } else ln = ln ? ln + ' ' + w : w;
            }
            lines.push(ln);
          }
          return lines;
        };
        const draw = () => {
          const rule = '─'.repeat(W);
          // 和真实界面一样：上面的横线右边带会话名称；空输入框显示暗灰色的推荐文字
          const body = cur ? wrap(cur).map((l, i) => (i ? '  ' : '❯ ') + l) : ['\x1b[1m❯\x1b[22m \x1b[2m用第二个办法，你自己开一个观察\x1b[22m'];
          st.write('\x1b[3;1H\x1b[J' + rule + ' 会话名称 ─\r\n' + body.join('\r\n') + '\r\n' + rule + '\r\n  ⏵⏵ auto mode on (shift+tab to cycle)');
        };
        // mouse：像开了鼠标的 tmux，点终端会收到鼠标报告 (sgr = ESC[<0;x;yM，x10 = 老式 ESC[M + 3 字节)
        st.write('\x1b[?1049h\x1b[?2004h' + (mouse ? '\x1b[?1000h' + (mouse === 'sgr' ? '\x1b[?1006h' : '') : '') + '\x1b[H\x1b[2J● 之前的回答内容\r\n');
        draw();
        st.on('data', (d) => {
          const k = String(d); got += k;
          if (k === '\r') { if (cur) hist.push(cur); cur = ''; }
          else if (k === '\x1b[A' || k === '\x1bOA') cur = hist.at(-1) || cur; // ↑ 翻出上一条
          else if (k === '\x0c' || k === '\x15' || k === '\x03') cur = '';
          else if (k === '\x7f') cur = cur.slice(0, -1);
          else if (k === '\x17') cur = cur.replace(/\S+\s*$/, ''); // Ctrl+W 删一个词
          else if (k.startsWith('\x1b[200~')) {
            const t = k.slice(6, -6);
            cur += t.includes('\r') ? `[Pasted text #${++pastes} +${t.split('\r').length} lines]` : t;
          } else if (!k.startsWith('\x1b') && k >= ' ' && k !== '\x7f') cur += k;
          else return;
          draw();
        });
      });
    }));
  }).listen(port, '127.0.0.1');
}
claudeServer(2253); claudeServer(2254, true); claudeServer(2256, false, 'sgr'); claudeServer(2257, false, 'x10');

(async () => {
  for (const [name, port] of [['CCM', 2253], ['SHELL', 2254], ['MSGR', 2256], ['MX10', 2257]]) {
    await fetch(BASE + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, host: '127.0.0.1', port, username: 'u', password: 'x' }) });
  }
  const browser = await launch();
  const errors = [];
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'CCM' }).click(); await wait(1500);
  const altAlt = async () => { await p.keyboard.press('Alt'); await p.keyboard.press('Alt'); await wait(500); };
  const inTerm = () => p.evaluate(() => document.activeElement.classList.contains('xterm-helper-textarea'));
  const inDesk = () => p.evaluate(() => document.activeElement.id === 'dInput');
  await p.click('#dInput');

  // 下方输入框有字：切到终端只切换光标，字留在下方输入框，什么都不发
  await p.keyboard.type('hello world'); got = '';
  await altAlt();
  ok(await inTerm() && got === '' && await p.inputValue('#dInput') === 'hello world', '下方输入框 → 终端：只切换光标，下方输入框的字不动、不发给终端: ' + JSON.stringify(got));
  await p.screenshot({ path: shot('altmove-term.png') });
  // 在终端里打的字照常发给 Claude Code
  await p.keyboard.type('typed in cli'); await wait(300);
  ok(got === 'typed in cli', '在终端里打的字直接发给 Claude Code');
  // 切回下方输入框：只切换光标，不读、不清 Claude Code 的输入框
  got = ''; await altAlt();
  ok(await inDesk() && got === '' && await p.inputValue('#dInput') === 'hello world', '终端 → 下方输入框：只切换光标，不抄回来、不发 Ctrl+L，下方输入框的字还在');

  // 点终端：记得在终端的输入框里打过字 (还没发送) → 光标留在终端 (想改里面的内容)；没打过字 → 回到下方输入框
  const clickRow = async (row) => {
    const r = await p.evaluate(() => { const e = document.querySelector('.term.active .xterm-screen').getBoundingClientRect(); return { x: e.left, y: e.top, h: e.height }; });
    await p.mouse.click(r.x + 120, r.y + (row + 0.5) * (r.h / termRows)); await wait(300);
  };
  const typeInTerm = async (keys) => { await p.locator('.term.active .xterm-helper-textarea').focus(); for (const k of keys) await p.keyboard.press(k); await wait(200); await p.click('#dInput'); };
  await clickRow(3); // 前面在终端里打了 typed in cli
  ok(await inTerm(), '在终端的输入框里打过字：点 Claude Code 的输入框，光标留在终端，方便修改');
  await p.click('#dInput'); await clickRow(0);
  ok(await inTerm(), '打过字还没发送时，点终端别处也留在终端');
  await typeInTerm(['Control+l']); await clickRow(3);
  ok(await inDesk(), 'Ctrl+L 清空后：点终端回到下方输入框');
  await typeInTerm(['a', 'b', 'Backspace', 'Backspace']); await clickRow(3);
  ok(await inDesk(), '打了字又用退格删光：点终端回到下方输入框');
  await typeInTerm(['x', 'Enter']); await clickRow(3);
  ok(await inDesk(), '打了字按回车发送后：点终端回到下方输入框');
  await typeInTerm(['ArrowUp']); await clickRow(3);
  ok(await inTerm(), '按 ↑ 翻出历史 (输入框里有了字)：点终端留在终端');
  await typeInTerm(['Control+c']); await clickRow(3);
  ok(await inDesk(), 'Ctrl+C 后：点终端回到下方输入框');
  await p.fill('#dInput', ''); await p.click('#dInput'); await p.keyboard.press('Tab'); await wait(300); // 下方输入框空着按 Tab：发给 Claude Code，填入推荐文字
  await clickRow(3);
  ok(await inTerm(), '下方输入框空着按 Tab (Claude Code 填入推荐文字)：点 Claude Code 的输入框锁定在终端');
  await typeInTerm(['Control+c']);
  // 打了字再用 Ctrl+W 删光 (记忆数不准，还以为有字)：屏幕上输入框只剩暗灰色的推荐文字 → 回到下方输入框
  await typeInTerm(['h', 'e', 'l', 'l', 'o', ' ', 'y', 'o', 'u']); await clickRow(3);
  ok(await inTerm(), '打了 hello you：点输入框留在终端');
  await typeInTerm(['Control+w', 'Control+w']); await clickRow(3);
  ok(await inDesk(), 'Ctrl+W 删光后输入框出现暗灰色推荐文字：点它回到下方输入框 (推荐文字不当成字)');
  await clickRow(3); await clickRow(0);
  ok(await inDesk(), '之后再点也回到下方输入框 (记忆已作废)');
  // Claude Code 自己在输入框里显示推荐提示词 (正常颜色)，你没打过字：点它回到下方输入框
  ccStream.write('\x1b[4;1H\x1b[K❯ 帮我运行一下测试  → to accept');
  await wait(300); await clickRow(3);
  ok(await inDesk(), 'Claude Code 显示推荐提示词 (没在终端里打过字)：点它光标回到下方输入框');

  // 记忆存在服务器上：别的设备上打的字、刷新页面前打的字也算
  const p2 = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage(); p2.on('pageerror', (e) => errors.push(e.message));
  await p2.goto(BASE + '/'); await p2.waitForSelector('.tab'); await wait(1500);
  await p2.locator('.tab', { hasText: 'CCM' }).first().click(); await wait(800);
  await p2.locator('.term.active .xterm-helper-textarea').focus(); await p2.keyboard.type('from other device'); await wait(600);
  await p.click('#dInput'); await clickRow(3);
  ok(await inTerm(), '在另一台设备的终端输入框里打了字：这台点 Claude Code 的输入框也锁定在终端');
  await p.reload(); await p.waitForSelector('.tab'); await wait(1500);
  await p.click('#dInput'); await clickRow(3);
  ok(await inTerm(), '刷新页面后：记忆还在 (存在服务器上)，点输入框锁定在终端');
  await p2.keyboard.press('Enter'); await wait(600);
  await p.click('#dInput'); await clickRow(3);
  ok(await inDesk(), '另一台设备按回车发送后：这台点输入框回到下方输入框');
  await p2.context().close();
  await p.locator('.host', { hasText: 'SHELL' }).click(); await wait(1500);
  await clickRow(0);
  ok(await inDesk(), '普通命令行 (没有 Claude Code 输入框)：点终端照旧回到下方输入框');
  // 开了鼠标的 tmux：点终端会发鼠标报告，不能被当成打了字
  for (const [name, desc] of [['MSGR', '新式鼠标报告 ESC[<0;x;yM'], ['MX10', '老式鼠标报告 ESC[M']]) {
    await p.locator('.host', { hasText: name }).click(); await wait(1500);
    got = '';
    for (let i = 0; i < 3; i++) { await clickRow(3); await clickRow(0); }
    ok(got.includes(name === 'MSGR' ? '\x1b[<0;' : '\x1b[M') && await inDesk(), `tmux 开了鼠标 (${desc})：连点终端 6 次，鼠标点击不算打字，光标回到下方输入框`);
    await typeInTerm(['a']); await clickRow(3);
    ok(await inTerm(), `tmux 开了鼠标 (${desc})：真的在终端里打了字，点终端留在终端`);
    await typeInTerm(['Enter']); await clickRow(3);
    ok(await inDesk(), `tmux 开了鼠标 (${desc})：发送后点终端回到下方输入框`);
  }
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
