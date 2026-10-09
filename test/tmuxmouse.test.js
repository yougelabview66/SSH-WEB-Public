'use strict';
// 「开启 tmux 鼠标滚动」：开鼠标的同时，选完文字只复制、不退出复制模式 (以前松开鼠标就被甩回最新的地方)，
// 复制模式里 Ctrl+End 回到最新。模拟的 SSH 主机把命令交给本机一个隔离的真 tmux 执行 (本机没装 tmux 就跳过)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { BASE, ok, wait, launch, hostKey } = require('./helpers');
const { Server } = require('ssh2');

let hasTmux = true;
try { execSync('command -v tmux', { stdio: 'ignore' }); } catch { hasTmux = false; }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-tm-')); // tmux 的 socket 路径不能太长
const env = { ...process.env, TMUX_TMPDIR: dir }; delete env.TMUX;
const tmux = (args) => execSync(`tmux ${args}`, { env, encoding: 'utf8' }).trim();

new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc(); s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { a().write('$ '); });
    s.on('exec', (a, r, info) => {
      const ch = a();
      const p = spawn('sh', ['-c', info.command], { env });
      p.stdout.on('data', (d) => ch.write(d)); p.stderr.on('data', (d) => ch.stderr.write(d));
      p.on('close', (code) => { ch.exit(code || 0); ch.end(); });
    });
  }));
}).listen(2239, '127.0.0.1');

(async () => {
  if (!hasTmux) { ok(true, '本机没有 tmux，跳过'); process.exit(); }
  await fetch(BASE + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'TM', host: '127.0.0.1', port: 2239, username: 'u', password: 'x' }) });
  const browser = await launch();
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'TM' }).first().click(); await wait(1500);
  const sid = (await (await fetch(BASE + '/api/sessions')).json())[0]?.id;
  const on = () => fetch(`${BASE}/api/sessions/${sid}/tmux-mouse`, { method: 'POST' }).then(async (r) => ({ status: r.status, body: await r.json() }));

  let r = await on();
  ok(r.status === 400 && r.body.error.includes('没有检测到正在运行的 tmux'), '没有运行的 tmux：提示原因 ' + JSON.stringify(r.body));

  tmux('-f /dev/null new -d -s t -x 80 -y 24');
  r = await on();
  ok(r.status === 200 && r.body.ok, '开启成功 ' + JSON.stringify(r.body));
  ok(tmux('show -g mouse') === 'mouse on', 'tmux 鼠标已开启');
  for (const t of ['copy-mode', 'copy-mode-vi']) {
    const keys = tmux(`list-keys -T ${t}`);
    const line = (k) => keys.split('\n').find((l) => new RegExp(`-T ${t} +${k} `).test(l)) || '';
    ok(/copy-(pipe|selection)-no-clear$|copy-selection$/.test(line('MouseDragEnd1Pane')) && !line('MouseDragEnd1Pane').includes('cancel'), `${t}：拖动选字松开只复制，不退出复制模式 (${line('MouseDragEnd1Pane').replace(/\s+/g, ' ')})`);
    ok(!line('DoubleClick1Pane').includes('cancel') && line('DoubleClick1Pane').includes('select-word'), `${t}：双击选词也不退出`);
    ok(!line('TripleClick1Pane').includes('cancel') && line('TripleClick1Pane').includes('select-line'), `${t}：三击选行也不退出`);
    ok(/C-End +send-keys -X cancel$/.test(line('C-End')), `${t}：Ctrl+End 退出复制模式 (回到最新)`);
  }
  // 实际跑一遍：往上翻 100 行，选几行复制 (同松开鼠标时执行的命令)，还停在原处；Ctrl+End 回到最新
  const st = () => tmux("display -p -t t '#{pane_in_mode} #{scroll_position}'");
  tmux("send -t t 'seq 1 500' Enter"); await wait(500);
  tmux('copy-mode -t t'); tmux('send -t t -X -N 100 scroll-up');
  tmux('send -t t -X begin-selection'); tmux('send -t t -X -N 2 cursor-down');
  tmux(`send -t t -X ${tmux('list-keys -T copy-mode MouseDragEnd1Pane').split(/\s+/).pop()}`); await wait(200);
  const [mode, pos] = st().split(' ');
  ok(mode === '1' && +pos > 90 && /\d/.test(tmux('show-buffer')), `选完文字后还在复制模式、停在原处 (离最新 ${pos} 行)，选中的已复制`);
  tmux('send-keys -t t C-End'); await wait(200);
  ok(st().startsWith('0'), 'Ctrl+End 退出复制模式，回到最新');

  r = await on();
  ok(r.status === 200, '再点一次也没问题 (重复设置)');
  try { tmux('kill-server'); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
  await browser.close(); process.exit();
})().catch((e) => { try { tmux('kill-server'); } catch {} console.error(e); process.exit(1); });
