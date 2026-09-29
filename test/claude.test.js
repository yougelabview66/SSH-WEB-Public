'use strict';
const { BASE, ok, wait, shot, launch, post, addHost, devices } = require('./helpers');
const { Server, utils } = require('ssh2');
const streams = [];
new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => { const s = acc(); s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { const st = a(); streams.push(st); st.write('$ '); }); }));
}).listen(2250, '127.0.0.1');
const B = BASE;
// 模拟 tmux 里的 Claude Code 底部：(状态行) + 提示 + 输入框 + 5 行自定义状态栏 + 模式行 + tmux 状态栏
const claudeScreen = (statusLine) => '\x1b[?1049h\x1b[H\x1b[2J' +
  '● 这是 Claude 之前的回答内容\r\n  继续一些说明文字\r\n\r\n' +
  (statusLine ? statusLine + '\r\n  ⎿  Tip: Use /btw to ask a quick side question\r\n\r\n' : '') +
  '────────────────────────────────────────\r\n❯ \r\n────────────────────────────────────────\r\n' +
  '  ◆ Opus 5.5 (1M) · high · Pro\r\n  👤 user · Personal\r\n  📁 /root/project\r\n  Context ▬▬▬▭▭ 42%\r\n  Session ▬▬▭▭▭ 33%\r\n' +
  '  ⏵⏵ auto mode on (shift+tab to cycle)' + '\x1b[43;1H\x1b[42m[claude] 0:claude*\x1b[K\x1b[0m';
(async () => {
  await fetch(B + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'CC', host: '127.0.0.1', port: 2250, username: 'u', password: 'x' }) });
  const browser = await launch();
  const errors = [];
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(B + '/'); await p.waitForSelector('#app:not(.hidden)');
  for (let i = 0; i < 2; i++) { await p.locator('.host', { hasText: 'CC' }).click(); await wait(1000); }
  await p.click('#dMode'); await wait(500); // 抬高 → 显示主机状态
  const st = async (i = 0) => (await p.evaluate((i) => document.querySelectorAll('#deskSpace .dp-tab .stt')[i]?.textContent, i));
  // CC-1 在后台
  streams[0].write(claudeScreen('✻ Frosting… (12s · ↓ 1.2k tokens)')); await wait(5000);
  ok(await st() === '运行中', 'Claude 在思考、画面 5 秒没变 → 仍然是运行中 (' + await st() + ')');
  streams[0].write(claudeScreen('· Hyperspacing… (2m 3s · esc to interrupt)')); await wait(1000);
  ok(await st() === '运行中', '转圈符号换成 ·、动词换一个也认 (' + await st() + ')');
  streams[0].write(claudeScreen('✻ Worked for 2m 10s')); await wait(1000);
  ok(await st() === '完成', '出现「✻ Worked for 2m 10s」→ 完成 (' + await st() + ')');
  streams[0].write(claudeScreen('✻ Sautéed for 45s')); await wait(1000);
  ok(await st() === '完成', '其他过去式动词 (Sautéed for) 也认 (' + await st() + ')');
  await p.screenshot({ path: shot('claude-done.png') });
  // 切过去发送内容 → 空闲
  await p.locator('#deskSpace .dp-tab').first().click(); await wait(400);
  await p.click('#dInput'); await p.keyboard.type('好的'); await p.keyboard.press('Enter'); await wait(1200);
  ok(await st() === '空闲', '看到后往这个标签发送内容 → 空闲 (' + await st() + ')');
  // 没有状态行、输出停停走走 (像别的设备在打字)：不应该算完成 / 运行中乱跳
  streams[0].write(claudeScreen('')); await wait(3500);
  ok(await st() === '空闲', '只有输入框的 Claude 界面 → 空闲 (' + await st() + ')');
  // 选择框优先于完成
  streams[0].write(claudeScreen('✻ Worked for 3s').replace('❯ \r\n', ' Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n')); await wait(1000);
  ok(await st() === '待选择', '选择框 → 待选择 (' + await st() + ')');
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
