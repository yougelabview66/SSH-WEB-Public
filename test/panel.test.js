'use strict';
const { BASE, ok, wait, shot, launch, post, addHost, devices, hostKey } = require('./helpers');
const { Server, utils } = require('ssh2');
let got = ''; const streams = [];
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => { const s = acc(); s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { const st = a(); streams.push(st); st.write('$ '); st.on('data', (d) => { got += d; }); }); }));
}).listen(2234, '127.0.0.1');
const B = BASE;
(async () => {
  await post('/api/hosts', { name: 'PN', host: '127.0.0.1', port: 2234, username: 'u', password: 'x' });
  const browser = await launch();
  const errors = [];
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage(); p.on('pageerror', (e) => errors.push(e.message)); p.on('dialog', (d) => { console.log('DIALOG: ' + d.type() + ' ' + d.message()); d.dismiss().catch(() => {}); });
  await p.goto(B + '/'); await p.waitForSelector('#app:not(.hidden)');
  for (let i = 0; i < 2; i++) { await p.locator('.host', { hasText: 'PN' }).click(); await wait(1000); }
  const histHost = await p.evaluate(() => document.querySelector('.tab.active') && window.__hh);
  // 收藏：通用 2 个 + 别的主机专用 1 个
  await post('/api/favorites', { cmd: '/compact', host: '' });
  await post('/api/favorites', { cmd: 'git status', host: '' });
  await post('/api/favorites', { cmd: 'only-other-host', host: 'someone@elsewhere:22' });
  await wait(800);
  ok(await p.isVisible('#hostFloat .dp-tabs'), '主机状态显示在右上角的悬浮窗里 (底部模式也有)');
  ok(await p.locator('#hostFloat .dp-favs').count() === 0, '不显示收藏命令');
  // 标签状态
  const rows = () => p.evaluate(() => [...document.querySelectorAll('#hostFloat .dp-tab')].map((r) => ({ nm: r.querySelector('.nm').textContent, st: r.querySelector('.stt').textContent, cur: r.classList.contains('cur') })));
  let r = await rows();
  const lay = await p.evaluate(() => { const e = [...document.querySelectorAll('#hostFloat .dp-tab')].map((x) => x.getBoundingClientRect()); return { sameRow: Math.abs(e[0].top - e[1].top) < 1, leftToRight: e[1].left > e[0].right, text: document.querySelector('#hostFloat .dp-tabs').textContent }; });
  ok(lay.sameRow && lay.leftToRight, '横向排列：两个标签在同一行，从左到右');
  ok(!/有输出|秒前|分钟前/.test(lay.text), '不再显示「多少秒前有输出」: ' + lay.text.replace(/\s+/g, ' ').trim());
  ok(r.length === 2 && r[1].nm === 'PN-2' && r[1].cur && !r[0].cur, '两个标签各一行，当前标签高亮: ' + JSON.stringify(r.map((x) => x.nm)));
  const spin = async (ms) => { const iv = setInterval(() => streams[0].write('\r⠋ Working… ' + Date.now() % 1000), 150); await wait(ms); clearInterval(iv); };
  const st0 = async () => { const r0 = (await rows())[0]; const cls = await p.evaluate(() => document.querySelector('#hostFloat .dp-tab .stt').className); return r0.st + '|' + cls; };
  let x;
  streams[0].write('\r12:01'); await wait(1200); x = await st0(); ok(x === '空闲|stt idle', '一开始空闲；零星一次输出 (如 tmux 时钟) 不算运行中 (' + x + ')');
  await spin(1500); x = await st0();
  const anim = await p.evaluate(() => getComputedStyle(document.querySelector('#hostFloat .dp-tab .stt')).animationName);
  ok(x === '运行中|stt run' && anim === 'dp-blink', '持续有输出 → 运行中，黄色闪烁 (' + x + ', ' + anim + ')');
  await wait(3500); x = await st0(); ok(x === '完成|stt done', '运行停下来 3 秒 → 完成，绿色，不用等提示音 (' + x + ')');
  streams[0].write('\r12:02'); await wait(1200); x = await st0(); ok(x === '完成|stt done', '完成之后零星一次输出不影响 (' + x + ')');
  await spin(1500); x = await st0(); ok(x === '运行中|stt run', '再次开始运行 → 运行中 (' + x + ')');
  await spin(500); streams[0].write('\r\x1b[K✻ Done\x07'); await wait(300); streams[0].write('\r\n> '); await wait(1300);
  x = await st0(); ok(x === '完成|stt done', '转圈后收到提示音 → 完成 (' + x + ')');
  await p.screenshot({ path: shot('panel.png') });
  streams[0].write('\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n\x07'); await wait(1200);
  x = await st0(); ok(x === '待选择|stt bad', '屏幕底部出现选择题 → 待选择，红色 (' + x + ')');
  streams[0].write('\x1b[2J\x1b[H  ⎿  API Error: 500 Internal server error\r\n\x07'); await wait(1200);
  x = await st0(); ok(x === '报错|stt bad', '屏幕底部出现 API Error → 报错，红色 (' + x + ')');
  streams[0].write('\x1b[2J\x1b[H> \x07'); await wait(1200);
  x = await st0(); ok(x === '完成|stt done', '清屏后只有提示音 → 完成 (' + x + ')');
  // 正常的 Claude Code 界面：工具失败、对话里提到这些字样 → 不能算报错 / 待选择
  streams[0].write('\x1b[2J\x1b[H● Bash(ls /nope)\r\n  ⎿  Error: Exit code 2\r\n● 如果出现 API Error 就重试，比如 `❯ 1. Yes` 这种选项。\r\n  Do you want me to continue? 选项 [Y/n] 在句子中间\r\n────────\r\n> \r\n────────\r\n  ⏵⏵ accept edits on (shift+tab to cycle)\r\n');
  await wait(1200); x = await st0();
  ok(x === '完成|stt done', '正常界面里有 ⎿ Error、句中提到 API Error / ❯ 1. Yes → 不算报错 / 待选择 (' + x + ')');
  // tmux 满屏：真实的权限选择框在底部，最后一行是 tmux 状态栏
  streams[0].write('\x1b[2J\x1b[H' + '旧的对话内容\r\n'.repeat(20) + '\x1b[30;1H Bash command\r\n   rm -rf build\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. Yes, and don\'t ask again\r\n   3. No, and tell Claude what to do differently (esc)\r\n' + '\x1b[43;1H\x1b[42m[claude] 0:claude*   \x1b[0m');
  await wait(1200); x = await st0();
  ok(x === '待选择|stt bad', 'tmux 满屏、底部状态栏上方的权限选择框 → 待选择 (' + x + ')');
  streams[0].write('\x1b[2J\x1b[H旧内容\r\n  ⎿  API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}\r\n────────\r\n> \r\n────────\r\n');
  await wait(1200); x = await st0();
  ok(x === '报错|stt bad', '以 ⎿ API Error 开头的行 → 报错 (' + x + ')');
  streams[0].write('\x1b[2J\x1b[H> '); await wait(800);
  // 点行切换
  await p.locator('#hostFloat .dp-tab', { hasText: 'PN-1' }).click(); await wait(500); r = await rows();
  ok(await p.evaluate(() => document.querySelector('.tab.active .title').textContent) === 'PN-1' && r[0].cur, '点一行切到那个标签');
  ok(await p.evaluate(() => document.activeElement.id) === 'dInput', '切换后焦点在输入框');
  // 往这个标签发送内容 (回显不算运行中) → 完成清掉，回到空闲
  await p.keyboard.type('hi'); await p.keyboard.press('Enter');
  for (let i = 0; i < 3; i++) { streams[0].write(i ? 'x' : 'hi\r\n'); await wait(100); }
  await wait(1200); r = await rows();
  ok(r[0].st === '空闲', '往这个标签发送内容后 → 回到空闲，输入的回显不算运行中 (' + r[0].st + ')');
  // 断开 → 未连接
  streams[1].end(); await wait(1500); r = await rows();
  ok(r[1].st === '未连接', '连接断开 → 未连接 (' + r[1].st + ')');
  await p.click('#dMode'); await wait(400);
  ok(await p.isVisible('#hostFloat .dp-tabs'), '输入框浮动模式下悬浮窗照样显示');
  await p.click('#dMode'); await wait(300);
  await p.evaluate(() => document.querySelector('#themeSeg [data-mode=dark]').click()); await wait(300);
  await p.screenshot({ path: shot('panel-dark.png') });
  // 手机
  const m = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage(); m.on('pageerror', (e) => errors.push(e.message));
  await m.goto(B + '/'); await m.waitForSelector('.tab'); await wait(1200);
  ok(await m.isHidden('#hostFloat'), '手机上没有悬浮窗');
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
