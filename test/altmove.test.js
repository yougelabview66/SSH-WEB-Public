'use strict';
// 连按两下 Alt 在下方输入框和终端之间切换时，内容跟着剪切过去
const { BASE, ok, wait, shot, launch, hostKey } = require('./helpers');
const { Server } = require('ssh2');

// 模拟 Claude Code 的输入框：上下两条横线，❯ 开头；空的时候显示灰色提示文字；
// 多行粘贴显示成 [Pasted text #1 +3 lines]；Ctrl+L 清空；长文字按单词折行，续行缩进两格
const W = 40;
let got = '';
function claudeServer(port, plain) {
  new Server({ hostKeys: [hostKey()] }, (c) => {
    c.on('authentication', (ctx) => ctx.accept());
    c.on('ready', () => c.on('session', (acc) => {
      const s = acc();
      s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
      s.on('shell', (a) => {
        const st = a();
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

  // 两边都空：只切换光标，什么都不发
  got = ''; await altAlt();
  ok(await inTerm() && got === '', '下方输入框是空的：只把光标切到终端，什么都不发');
  await altAlt();
  ok(await inDesk() && got === '' && await p.inputValue('#dInput') === '', 'Claude Code 输入框里只有灰色提示文字：不当成内容，不发 Ctrl+L，只切回下方输入框');

  // 下方输入框 → 终端
  await p.keyboard.type('hello world'); got = '';
  await altAlt();
  ok(await inTerm() && got === 'hello world' && await p.inputValue('#dInput') === '', '下方输入框 → 终端：内容发进 Claude Code 的输入框 (不回车)，下方输入框清空: ' + JSON.stringify(got));
  await p.screenshot({ path: shot('altmove-term.png') });
  // 终端 → 下方输入框
  got = ''; await altAlt();
  ok(await inDesk() && await p.inputValue('#dInput') === 'hello world' && got === '\x0c', '终端 → 下方输入框：抄回 hello world，并发 Ctrl+L 清空 Claude Code 的输入框: ' + JSON.stringify(got));

  // 多行：按粘贴发过去，Claude Code 显示成 [Pasted text #1 +3 lines]，切回来还原成原文
  await p.fill('#dInput', 'line1\nline2\nline3'); await p.evaluate(() => document.getElementById('dInput').dispatchEvent(new Event('input')));
  got = ''; await altAlt();
  ok(got === '\x1b[200~line1\rline2\rline3\x1b[201~', '多行内容按粘贴发过去 (换行不会被当成提交): ' + JSON.stringify(got));
  got = ''; await altAlt();
  ok(await p.inputValue('#dInput') === 'line1\nline2\nline3' && got === '\x0c', 'Claude Code 显示成 [Pasted text …]，切回来还原成完整的多行原文');

  // 长文字自动折行：拼回原文 (单词之间补空格)
  const long = 'the quick brown fox jumps over the lazy dog and keeps running far away';
  await p.fill('#dInput', long); await p.evaluate(() => document.getElementById('dInput').dispatchEvent(new Event('input')));
  await altAlt(); await altAlt();
  ok(await p.inputValue('#dInput') === long, '长文字在 Claude Code 里折成几行，切回来拼回原文: ' + JSON.stringify(await p.inputValue('#dInput')));
  // 直接在 Claude Code 输入框里打的 (两行真换行由 Claude Code 自己画)
  await p.fill('#dInput', ''); await p.evaluate(() => document.getElementById('dInput').dispatchEvent(new Event('input')));
  await altAlt(); await p.keyboard.type('typed in cli'); await wait(300);
  await altAlt();
  ok(await p.inputValue('#dInput') === 'typed in cli', '在 Claude Code 输入框里直接打的字，切回来也搬到下方输入框');
  await p.fill('#dInput', ''); await p.evaluate(() => document.getElementById('dInput').dispatchEvent(new Event('input')));

  // 普通命令行：认不出 Claude Code 的输入框，只切换光标
  await p.locator('.host', { hasText: 'SHELL' }).click(); await wait(1500);
  await p.click('#dInput'); await altAlt();
  got = ''; await altAlt();
  ok(await inDesk() && got === '' && await p.inputValue('#dInput') === '', '普通命令行里认不出 Claude Code 的输入框：只切换光标，不抄也不清');
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
