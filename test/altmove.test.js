'use strict';
// 连按两下 Alt 在下方输入框和终端之间只切换光标，两边的字都不动
const { BASE, ok, wait, shot, launch, hostKey } = require('./helpers');
const { Server } = require('ssh2');

// 模拟 Claude Code 的输入框：上下两条横线，❯ 开头；空的时候显示灰色提示文字；
// 多行粘贴显示成 [Pasted text #1 +3 lines]；Ctrl+L 清空；长文字按单词折行，续行缩进两格
const W = 40;
let got = '', termRows = 0, ccStream = null;
function claudeServer(port, plain) {
  new Server({ hostKeys: [hostKey()] }, (c) => {
    c.on('authentication', (ctx) => ctx.accept());
    c.on('ready', () => c.on('session', (acc) => {
      const s = acc();
      s.on('pty', (a, r, i) => { termRows = i.rows; a(); }); s.on('window-change', (a, r, i) => { termRows = i.rows; a && a(); });
      s.on('shell', (a) => {
        const st = a();
        if (!plain) ccStream = st;
        if (plain) { st.write('$ ls\r\nfile1  file2\r\n$ '); st.on('data', (d) => { got += d; }); return; }
        let cur = '', pastes = 0;
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
          const body = cur ? wrap(cur).map((l, i) => (i ? '  ' : '❯ ') + l) : ['❯ \x1b[7mT\x1b[27m\x1b[2mry "fix lint errors"\x1b[22m'];
          st.write('\x1b[3;1H\x1b[J' + rule + '\r\n' + body.join('\r\n') + '\r\n' + rule + '\r\n  ⏵⏵ auto mode on (shift+tab to cycle)');
        };
        st.write('\x1b[?1049h\x1b[?2004h\x1b[H\x1b[2J● 之前的回答内容\r\n');
        draw();
        st.on('data', (d) => {
          const k = String(d); got += k;
          if (k === '\x0c') cur = '';
          else if (k.startsWith('\x1b[200~')) {
            const t = k.slice(6, -6);
            cur += t.includes('\r') ? `[Pasted text #${++pastes} +${t.split('\r').length} lines]` : t;
          } else if (!k.startsWith('\x1b') && k >= ' ') cur += k;
          else return;
          draw();
        });
      });
    }));
  }).listen(port, '127.0.0.1');
}
claudeServer(2253); claudeServer(2254, true);

(async () => {
  for (const [name, port] of [['CCM', 2253], ['SHELL', 2254]]) {
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
  // Claude Code 自己在输入框里显示推荐提示词 (正常颜色)，你没打过字：点它回到下方输入框
  ccStream.write('\x1b[4;1H\x1b[K❯ 帮我运行一下测试  → to accept');
  await wait(300); await clickRow(3);
  ok(await inDesk(), 'Claude Code 显示推荐提示词 (没在终端里打过字)：点它光标回到下方输入框');
  await p.locator('.host', { hasText: 'SHELL' }).click(); await wait(1500);
  await clickRow(0);
  ok(await inDesk(), '普通命令行 (没有 Claude Code 输入框)：点终端照旧回到下方输入框');
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
