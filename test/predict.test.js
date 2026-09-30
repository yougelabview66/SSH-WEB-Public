'use strict';
// 打字预测回显：网络慢时终端里打的字先在本地显示，服务器回显后换成真实的字
const net = require('net');
const { Server } = require('ssh2');
const { BASE, ok, wait, shot, launch, addHost, run, hostKey } = require('./helpers');

// mode: shell (光标就在输入点) | claude (光标藏在底部，输入框里自己画假光标) | noecho (输密码) | upper (第一个字正常，之后回显成大写 = 猜错)
let got = '';
function mockServer(port, mode) {
  new Server({ hostKeys: [hostKey()] }, (c) => {
    c.on('authentication', (ctx) => ctx.accept());
    c.on('ready', () => c.on('session', (acc) => {
      const s = acc(); s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
      s.on('shell', (a) => {
        const st = a();
        let text = '', n = 0;
        const drawClaude = () => st.write(`\x1b[4;1H\x1b[2K❯ ${text}\x1b[7m \x1b[0m\x1b[20;1H`);
        if (mode === 'claude') { st.write('\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J● 之前的回答\r\n\r\n────────\r\n'); drawClaude(); st.write('\x1b[5;1H────────\x1b[20;1H'); }
        else st.write('$ ');
        st.on('data', (d) => {
          const k = String(d); got += k;
          for (const ch of k) {
            if (mode === 'noecho') continue;
            if (mode === 'noecho-log') { st.write(`\x1b7\x1b[12;1H\x1b[2Klog: got ${ch} from somewhere\x1b8`); continue; }
            if (ch === '\r') { text = ''; n = 0; if (mode === 'claude') drawClaude(); else st.write('\r\n$ '); continue; }
            if (ch === '\x7f') { text = text.slice(0, -1); if (mode === 'claude') drawClaude(); else st.write('\b \b'); continue; }
            if (ch < ' ') continue;
            const out = mode === 'upper' && n++ > 0 ? ch.toUpperCase() : ch;
            text += out;
            if (mode === 'claude') drawClaude(); else st.write(out);
          }
        });
      });
    }));
  }).listen(port, '127.0.0.1');
}
// 单向延迟 d 毫秒的 TCP 转发 (往返约 2d)：模拟远处的主机
function delayProxy(listenPort, targetPort, d) {
  net.createServer((a) => {
    const b = net.connect(targetPort, '127.0.0.1');
    a.on('data', (x) => setTimeout(() => b.write(x), d));
    b.on('data', (x) => setTimeout(() => a.write(x), d));
    a.on('close', () => b.destroy()); b.on('close', () => a.destroy());
    a.on('error', () => {}); b.on('error', () => {});
  }).listen(listenPort, '127.0.0.1');
}
mockServer(2266, 'noecho-log'); delayProxy(2276, 2266, 70);
mockServer(2260, 'shell'); mockServer(2261, 'claude'); mockServer(2262, 'noecho'); mockServer(2263, 'upper'); mockServer(2264, 'shell');
delayProxy(2270, 2260, 70); delayProxy(2271, 2261, 70); delayProxy(2272, 2262, 70); delayProxy(2273, 2263, 70);

run(async () => {
  for (const [n, port] of [['PWLOG', 2276], ['SHELL', 2270], ['CLAUDE', 2271], ['PASSWD', 2272], ['WRONG', 2273], ['FAST', 2264]]) await addHost(n, port);
  const browser = await launch();
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  const open = async (name) => {
    await p.locator('.host', { hasText: name }).first().click(); await wait(7000); // 等延迟测量 (刚连上 2 秒一次，攒够 3 次)
    await p.locator('.term.active .xterm-helper-textarea').focus(); await wait(200); // 焦点放到终端里直接打字 (点终端会回到下方输入框)
  };
  const pred = () => p.evaluate(() => [...document.querySelectorAll('.term.active .pred-ch')].map((e) => e.textContent).join(''));
  const type = async (t) => { for (const ch of t) await p.keyboard.type(ch); };

  // ---- 普通 shell
  await open('SHELL');
  await type('e'); await wait(30);
  ok(await pred() === '', '每行第一个字先探测：不显示，等服务器回显');
  await wait(500);
  await type('cho'); await wait(30);
  ok(await pred() === 'cho', '确认会回显后，接着打的字马上显示 (服务器回显还没到): ' + JSON.stringify(await pred()));
  ok(await p.evaluate(() => getComputedStyle(document.querySelector('.term.active .pred-ch')).textDecorationLine) === 'underline', '预测的字带下划线 (还没确认)');
  await p.screenshot({ path: shot('predict.png') });
  await wait(600);
  ok(await pred() === '', '服务器回显到了，和预测一致：换成真实的字');
  await type('ab'); await p.keyboard.press('Backspace'); await wait(30);
  ok(await pred() === 'a', '退格撤掉还没确认的预测: ' + JSON.stringify(await pred()));
  await wait(600);
  await type('xy'); await wait(30);
  ok(await pred() === 'xy', '继续打字继续预测');
  await p.keyboard.press('ArrowLeft'); await wait(30);
  ok(await pred() === '', '方向键会移动光标：马上清掉预测');
  await wait(600);
  await type('z'); await wait(600); // 方向键之后重新探测
  await type('zz'); await wait(30);
  ok(await pred() === 'zz', '回车前的预测');
  await p.keyboard.press('Enter'); await wait(20);
  ok(await pred() === '', '按回车马上清掉预测 (输出滚屏后位置就不对了)');
  await wait(400);
  await type('q'); await type('w'); await p.keyboard.press('Backspace'); await wait(600);
  ok(await pred() === '', '探测期间打的字又删掉了：不会画出来');
  await type('e'); await wait(30);
  ok(await pred() === 'e', '探测期间退格没有引起「猜错」暂停，接着照常预测');
  await wait(500); await p.keyboard.press('Enter'); await wait(400);
  await type('l'); await wait(30);
  ok(await pred() === '', '回车后新的一行重新探测');
  await wait(500); await type('s'); await wait(30);
  ok(await pred() === 's', '新一行确认后继续预测');
  await wait(500);

  // ---- 类似 Claude Code：终端光标藏在底部，输入框里自己画假光标
  await open('CLAUDE');
  await type('h'); await wait(600);
  await type('ey'); await wait(30);
  const pos = await p.evaluate(() => {
    const els = [...document.querySelectorAll('.term.active .pred-ch')];
    const sc = document.querySelector('.term.active .xterm-screen').getBoundingClientRect();
    const br = document.querySelector('.term.active .term-box').getBoundingClientRect();
    return els.map((e) => ({ t: e.textContent, top: parseFloat(e.style.top) - (sc.top - br.top), left: parseFloat(e.style.left) - (sc.left - br.left), h: parseFloat(e.style.height), w: parseFloat(e.style.width) }));
  });
  ok(pos.length === 2 && pos[0].t === 'e' && Math.round(pos[0].top / pos[0].h) === 3 && Math.round(pos[0].left / pos[0].w) === 3,
    'Claude Code 式界面：对比屏幕找到真正的输入位置 (第 4 行、「❯ h」后面)，不是底部的终端光标: ' + JSON.stringify(pos.map((x) => [x.t, Math.round(x.top / x.h), Math.round(x.left / x.w)])));
  await wait(600);
  ok(await pred() === '', '回显一致，换成真实的字');

  // ---- 输密码 (服务器不回显)：永远不显示
  await open('PASSWD');
  let shown = '';
  for (const ch of 'secret123') { await type(ch); await wait(80); shown += await pred(); }
  await wait(700); shown += await pred();
  ok(shown === '', '服务器不回显 (输密码)：打的字一个都不显示');
  await open('PWLOG');
  shown = '';
  for (const ch of 'sesame12') { await type(ch); await wait(120); shown += await pred(); }
  await wait(700); shown += await pred();
  ok(shown === '', '输密码时别处的日志恰好冒出打的字：也不会误判，一个都不显示');

  // ---- 猜错了：撤掉，暂停 5 秒
  await open('WRONG');
  await type('a'); await wait(600);
  await type('bc'); await wait(30);
  ok(await pred() === 'bc', '先照常预测');
  await wait(900);
  ok(await pred() === '', '服务器回显的是 BC (和预测不一样)：撤掉预测，以服务器为准');
  await type('d'); await wait(30);
  ok(await pred() === '', '猜错后暂停几秒不预测');

  // ---- 关闭 / 网速快
  await p.evaluate(() => document.querySelector('#predSeg [data-mode=off]').click());
  await open('SHELL'); await type('e'); await wait(600); await type('cho'); await wait(30);
  ok(await pred() === '', '设置成「关」：不预测');
  await p.evaluate(() => document.querySelector('#predSeg [data-mode=auto]').click());
  await open('FAST'); await type('e'); await wait(400); await type('cho'); await wait(30);
  ok(await pred() === '', '「自动」而且网速快 (往返 < 60ms)：不预测，和以前一样');
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close();
});
