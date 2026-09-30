'use strict';
// 主机状态由服务端判断 (lib/status.js)：网页关着时也在判断；多台设备看到的一致
const { BASE, ok, wait, shot, launch, addHost, run, hostKey } = require('./helpers');
const { Server, utils } = require('ssh2');

const streams = []; let got = '';
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc(); s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { const st = a(); streams.push(st); st.write('$ '); st.on('data', (d) => { got += d; }); });
  }));
}).listen(2253, '127.0.0.1');

// 模拟 tmux 里的 Claude Code 底部
const claudeScreen = (statusLine) => '\x1b[?1049h\x1b[H\x1b[2J● 之前的回答\r\n\r\n' +
  (statusLine ? statusLine + '\r\n\r\n' : '') +
  '────────────────────\r\n❯ \r\n────────────────────\r\n  ⏵⏵ auto mode on' + '\x1b[43;1H\x1b[42m[claude] 0:claude*\x1b[K\x1b[0m';

run(async () => {
  await addHost('ST', 2253);
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const open = async () => {
    const p = await ctx.newPage();
    await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
    return p;
  };
  const chip = (p) => p.evaluate(() => document.querySelector('#hostFloat .dp-tab .stt')?.textContent || '');

  let p = await open();
  await p.locator('.host', { hasText: 'ST' }).click(); await wait(1500);
  ok(await chip(p) === '空闲', '刚连上：空闲');
  streams[0].write(claudeScreen('✻ Frosting… (3s · ↓ 1k tokens)')); await wait(1500);
  ok(await chip(p) === '运行中', 'Claude 转圈 → 运行中 (服务端判断后推过来)');

  // 关掉网页，期间 Claude 做完
  await p.close(); await wait(500);
  streams[0].write(claudeScreen('✻ Worked for 12s')); await wait(2000);
  p = await open(); await wait(1500);
  ok(await chip(p) === '完成', '网页关着的时候 Claude 做完了，重新打开马上显示完成 (' + await chip(p) + ')');
  await p.screenshot({ path: shot('status.png') });

  // 两个网页同时开着：在一个里发送内容，另一个也变回空闲
  const q = await open(); await wait(1500);
  ok(await chip(q) === '完成', '第二个网页也显示完成');
  await p.click('#dInput'); await p.keyboard.type('好的'); await p.keyboard.press('Enter'); await wait(1800);
  ok(await chip(p) === '空闲' && await chip(q) === '空闲', '在一个网页里发送内容 → 两个网页都变回空闲 (' + await chip(p) + ' / ' + await chip(q) + ')');

  // 选择框：待选择
  streams[0].write(claudeScreen('').replace('❯ \r\n', ' Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n')); await wait(1500);
  ok(await chip(q) === '待选择', '选择框 → 待选择 (' + await chip(q) + ')');

  // 程序询问终端 (设备属性、光标位置、背景色)：网页自动回答，不算用户输入
  streams[0].write(claudeScreen('✻ Frosting… (2s)')); await wait(1500);
  streams[0].write(claudeScreen('✻ Worked for 2s')); await wait(1500);
  ok(await chip(p) === '完成', '又做完了一次');
  got = '';
  streams[0].write('\x1b[c\x1b[6n\x1b]11;?\x07'); await wait(1500);
  ok(await chip(p) === '完成' && await chip(q) === '完成', '程序询问终端后，网页的自动回答不算输入，状态还是完成 (' + await chip(p) + ')');
  ok((got.match(/\x1b\[\?1;2c/g) || []).length === 1, '两个网页都开着：同一个询问只转发一个回答给程序 (收到 ' + (got.match(/\x1b\[\?1;2c/g) || []).length + ' 个)');
  await browser.close();
});
