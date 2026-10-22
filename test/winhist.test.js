'use strict';
// 连的是 Windows 的 SSH (默认 cmd，没有 sh)，没开常驻会话 (sshwebd)：不再用 psmux 取历史 (常驻会话代替了它)。
// 程序开着鼠标往上滚：不取历史、不打开历史视图、不弹「取不到 / 超时」，滚轮照常交给程序 (终端默认的方式)。
// Windows 的终端缩放交给 ConPTY 重画，程序的询问只回答终端型号和光标位置
const { Server } = require('ssh2');
const { BASE, ok, wait, run, launch, hostKey, addHost } = require('./helpers');

const HIST = [];
for (let i = 0; i < 300; i++) HIST.push(`win line ${i}`);
const cmds = [];
let shellSt = null, shellIn = ''; // 终端里收到的输入 (看浏览器自动回答了什么)
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    // 终端里的程序开了鼠标 (SGR 上报)
    s.on('shell', (a) => { shellSt = a(); shellSt.on('data', (d) => { shellIn += d; }); shellSt.write('\x1b[?1000h\x1b[?1006h\x1b[H\x1b[2J' + HIST.slice(-20).join('\r\n') + '\x1b[999;1H\x1b[42m[0] 0:pwsh*\x1b[K\x1b[0m'); });
    s.on('exec', (a, r, info) => {
      const ch = a(), cmd = info.command;
      cmds.push(cmd);
      const out = (text, code) => { if (text) ch.write(text); ch.exit(code); ch.end(); };
      if (cmd.includes('hook.log')) return out('', 1); // 读钩子事件：cmd 里跑不了
      if (cmd === 'echo %OS%;$env:OS') return out('Windows_NT;$env:OS\r\n', 0); // 像 cmd
      if (cmd === 'sh' || cmd.startsWith('sh ')) { ch.stderr.write("'sh' is not recognized as an internal or external command,\r\n"); return out('', 1); }
      out('', 1);
    });
  }));
}).listen(2298, '127.0.0.1');

run(async () => {
  await addHost('WINT', 2298);
  const browser = await launch();
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'WINT' }).first().click(); await p.waitForSelector('.tab.active .dot.ok'); await wait(1200);
  // Windows 主机：终端开了 windowsPty (缩放时不自己重新折行，交给 ConPTY 重画，不然文字错乱)
  ok(await p.evaluate(() => document.querySelector('.term.active').dataset.winpty) === '1', 'Windows 主机：认出来后终端按 ConPTY 的方式处理缩放 (windowsPty)');
  // 程序发来的询问 (经 ConPTY 转给外面的终端)：终端型号、模式、背景色、光标位置 —— Windows 上只回答光标位置，别的回答会被当成键盘输入
  shellIn = '';
  shellSt.write('\x1b[c\x1b[?2026$p\x1b]11;?\x07\x1b[6n'); await wait(800);
  ok(/^\x1b\[\?[\d;]*c\x1b\[\d+;\d+R$/.test(shellIn), 'Windows 主机：回答终端型号和光标位置 (程序等着它们)，模式 / 颜色的回答不发 (不会变成乱文字打进 Claude 的输入框): ' + JSON.stringify(shellIn));
  const overTerm = async () => { const b = await p.locator('.term.active .term-box').boundingBox(); await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2); };
  const n0 = cmds.length;
  shellIn = '';
  await overTerm(); await p.mouse.wheel(0, -100); await wait(2500);
  const toast = await p.evaluate(() => document.querySelector('.term.active .font-toast')?.textContent || '');
  ok(!(await p.$('.term.active .lscroll')) && !/psmux|取不到|超时/.test(toast), '没开常驻会话、程序开着鼠标：往上滚不打开历史视图，也不提示 psmux 超时: ' + JSON.stringify(toast));
  ok(!cmds.slice(n0).some((x) => /psmux|tmux|capture-pane/.test(x)), '不再在主机上找 psmux / tmux: ' + JSON.stringify(cmds.slice(n0)));
  ok(/\x1b\[<64;\d+;\d+M/.test(shellIn), '滚轮照常交给程序 (按程序要的鼠标协议发): ' + JSON.stringify(shellIn.slice(0, 40)));
  ok(!cmds.some((x) => x === 'sh' || x.startsWith('sh ')) && cmds.includes('echo %OS%;$env:OS'), '先认出是 Windows (SSH 默认 cmd)，不先试 sh: ' + JSON.stringify(cmds.map((x) => x.slice(0, 30))));
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close();
});
