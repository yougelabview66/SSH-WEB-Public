'use strict';
// 手机按键栏的「⇄ CLI」(同电脑上连按两下 Alt)：点一下光标切到终端，键盘打的字直接进 CLI 自带的输入框
// (平时手机上终端是只读的，字都走下方输入栏)；点终端也留在终端；再点一下、或点下方输入栏切回，终端恢复只读
const { BASE, ok, wait, launch, devices, hostKey } = require('./helpers');
const { Server } = require('ssh2');
let got = '';
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { const st = a(); st.on('data', (d) => { got += d; }); st.write('> '); });
  }));
}).listen(2247, '127.0.0.1');

(async () => {
  await fetch(BASE + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'D', host: '127.0.0.1', port: 2247, username: 'u', password: 'x', daemon: false }) });
  const browser = await launch();
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const m = await ctx.newPage(); const errors = []; m.on('pageerror', (e) => errors.push(e.message));
  await m.goto(BASE + '/'); await m.waitForSelector('#app:not(.hidden)');
  await m.tap('#btnToggle'); await m.locator('.host', { hasText: 'D' }).first().tap(); await wait(1500);
  const st = () => m.evaluate(() => {
    const ta = document.querySelector('.term.active .xterm-helper-textarea');
    return { focus: document.activeElement === ta ? 'term' : document.activeElement?.id || '', ro: ta.hasAttribute('readonly'),
      on: !!document.querySelector('#mobileBar [data-k=cli].on'), input: document.getElementById('mInput').value.replace(/​/g, '') };
  });
  const s0 = await st();
  ok(s0.ro && await m.locator('#mobileBar [data-k=cli]').count() === 1, `按键栏有「⇄ CLI」，平时终端只读 (${s0.ro})`);

  await m.locator('#mobileBar [data-k=cli]').tap(); await wait(300);
  const s1 = await st();
  ok(s1.focus === 'term' && !s1.ro && s1.on, `点「⇄ CLI」：光标到终端、终端可以打字、按键亮着 ${JSON.stringify(s1)}`);
  got = '';
  await m.keyboard.type('ab'); await wait(300);
  await m.locator('#mobileBar [data-t="|"]').tap(); await wait(300);
  ok(got === 'ab|' && !(await st()).input, `打的字和字符键直接发给终端 (${JSON.stringify(got)})，不进下方输入栏`);
  await m.locator('.term.active .xterm-screen').tap(); await wait(300);
  ok((await st()).focus === 'term', '点终端：还留在终端，不拉回下方输入栏');

  await m.locator('#mobileBar [data-k=cli]').tap(); await wait(300);
  const s2 = await st();
  ok(s2.focus !== 'term' && s2.ro && !s2.on, `再点一下：切回，终端恢复只读 ${JSON.stringify(s2)}`);
  await m.tap('#mInput'); await wait(200);
  got = '';
  await m.keyboard.type('c'); await wait(300);
  ok(!got && (await st()).input === 'c', `切回后打字进下方输入栏 (${JSON.stringify(got)})`);

  // 点下方输入栏也切回
  await m.evaluate(() => { const v = document.getElementById('mInput'); v.blur(); });
  await m.locator('#mobileBar [data-k=cli]').tap(); await wait(300);
  await m.tap('#mInput'); await wait(300);
  const s3 = await st();
  ok(s3.focus === 'mInput' && s3.ro && !s3.on, `切到终端后点下方输入栏：切回 ${JSON.stringify(s3)}`);
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
