'use strict';
// 连的是 Windows 的 SSH (默认 cmd，没有 sh)，里面开的是 psmux (Windows 上的 tmux 克隆)：往上滚也进 SSH-WEB 的历史视图
// (ConPTY 没把备用屏幕传过来、只开了鼠标也算)
// (以前取历史要在 sh 里跑，Windows 上跑不起来，滚轮就交给了 psmux 自己的复制模式)。
// 不认 capture-pane 的 -e / -J 时去掉再试；第一次认出是 Windows 后直接用 psmux
const { Server } = require('ssh2');
const { BASE, ok, wait, run, launch, hostKey, addHost } = require('./helpers');

const HIST = [];
for (let i = 0; i < 300; i++) HIST.push(i === 20 ? '早先的输出 win-old-line' : `psmux history line ${i}`);
const cmds = [];
let mode = '00';
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    // 像 psmux：备用屏幕 + 鼠标，屏幕上是最后几十行
    // 像 Windows 的 SSH (ConPTY)：psmux 开了鼠标，但进备用屏幕的信号没传过来 (还在普通屏幕上)
    s.on('shell', (a) => a().write('\x1b[?1000h\x1b[?1006h\x1b[H\x1b[2J' + HIST.slice(-20).join('\r\n') + '\x1b[999;1H\x1b[42m[0] 0:pwsh*\x1b[K\x1b[0m'));
    s.on('exec', (a, r, info) => {
      const ch = a(), cmd = info.command;
      cmds.push(cmd);
      const out = (text, code) => { if (text) ch.write(text); ch.exit(code); ch.end(); };
      if (cmd.includes('hook.log')) return out('', 1); // 读钩子事件：cmd 里跑不了
      if (cmd === 'echo %OS%;$env:OS') return out('Windows_NT;$env:OS\r\n', 0); // 像 cmd
      if (cmd === 'sh' || cmd.startsWith('sh ')) { ch.stderr.write("'sh' is not recognized as an internal or external command,\r\n"); return out('', 1); }
      // 像 cmd：几条命令用 & 连起来
      let text = '', code = 0;
      for (const c of cmd.split(' & ')) {
        if (c.startsWith('echo ')) text += c.slice(5) + ' \r\n';
        else if (c.startsWith('psmux list-clients')) text += '200x50 1700000000 %1\r\n80x24 1700000100 %3\r\n';
        else if (c.startsWith('psmux display-message')) text += mode + '\r\n';
        else if (c.startsWith('psmux capture-pane')) { if (/ -e| -J/.test(c)) code = 1; else { text += HIST.join('\r\n') + '\r\n'; code = 0; } }
        else code = 1;
      }
      out(text, code);
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
  const overTerm = async () => { const b = await p.locator('.term.active .term-box').boundingBox(); await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2); };
  const viewText = () => p.evaluate(() => document.querySelector('.term.active .lscroll .ls-body')?.textContent || '');
  await overTerm(); await p.mouse.wheel(0, -100); await wait(2500);
  const t = await viewText();
  ok(t.includes('早先的输出 win-old-line') && !t.includes('\r'), 'Windows + psmux：往上滚进 SSH-WEB 的历史视图，看得到早先的输出');
  const capOf = (x) => (x.split(' & ').find((c) => c.startsWith('psmux capture-pane')) || '');
  const cap = cmds.map(capOf).filter(Boolean);
  ok(!cmds.some((x) => x === 'sh' || x.startsWith('sh ')) && cmds.includes('echo %OS%;$env:OS'), '先认出是 Windows (SSH 默认 cmd)，不再先试 sh: ' + JSON.stringify(cmds.map((x) => x.slice(0, 30))));
  ok(cap.length === 3 && cap.every((x) => / -S -\d+ -t %\d+$/.test(x)) && !/ -[eJ]/.test(cap[2]), '不认 -e / -J：去掉再试: ' + JSON.stringify(cap));
  ok(cmds.filter((x) => x.includes('capture-pane')).every((x) => /list-clients .* & echo __SSHWEB_M1__ & psmux display-message -p -t %\d+ .* & echo __SSHWEB_M2__ & psmux capture-pane/.test(x)), '找 pane、看模式、抓历史连成一条命令执行 (Windows 开通道慢)');
  await p.keyboard.press('Escape'); await wait(500);
  // 第二次：一条命令搞定，直接用认过的参数
  const n0 = cmds.length;
  await overTerm(); await p.mouse.wheel(0, -100); await wait(2000);
  const again = cmds.slice(n0);
  ok((await viewText()).includes('win-old-line') && again.length === 1 && / -p -S /.test(capOf(again[0])), '第二次往上滚：只执行一条命令，直接用认过的 capture-pane 参数: ' + JSON.stringify(again.map(capOf)));
  await p.keyboard.press('Escape'); await wait(500);
  // psmux 已经在复制模式里：滚轮照旧交给它
  mode = '01';
  await overTerm(); await p.mouse.wheel(0, -100); await wait(2000);
  ok(!(await p.$('.term.active .lscroll')), 'psmux 已经在复制模式里：不打开历史视图，滚轮交给它');
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close();
});
