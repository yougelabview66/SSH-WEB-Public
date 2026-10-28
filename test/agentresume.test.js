'use strict';
// 会话历史点「继续」：标签里还开着 Agent (Claude Code 等) 时，恢复命令会打进它的输入框 ——
// 先按两下 Ctrl+C 退出它 (Grok 这种界面上没有特别的字的，光标停在 > 开头的输入行上也认得)，等回到 shell 再执行；普通 shell 直接执行、不多按 Ctrl+C；
// 退不出来就不执行，提示手动退出，标签名还回去。
// 这台主机 uname 认不出是 Linux (像别的系统)，勾着「常驻会话」(新建主机默认勾上)：安静地开普通终端，不提示「常驻会话没开起来」，主机列表上不标「常驻」
const { Server } = require('ssh2');
const { BASE, ok, wait, run, hostKey, addHost } = require('./helpers');
const WebSocket = require('ws');

let st = null, mode = 'agent', got = '', ctrlC = [];
const AGENT = '\x1b[2J\x1b[H● 上一次的回复内容\r\n────────────────\r\n> \r\n────────────────\r\n  ? for shortcuts\x1b[3;3H';
const SHELL = '\x1b[2J\x1b[HResume this session with: claude --resume old\r\n$ ';
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('exec', (a, r, info) => { const ch = a(); ch.write(info.command === 'echo %OS%;$env:OS' ? '%OS%\n' : ''); ch.exit(info.command === 'echo %OS%;$env:OS' ? 0 : 1); ch.end(); }); // 像 sh
    s.on('shell', (a) => {
      st = a();
      st.write(AGENT);
      st.on('data', (d) => {
        d = d.toString();
        if (mode === 'exiting') return; // 正在退出：这时收到的输入会被丢掉 (同真的 Claude Code)
        got += d;
        if (d === '\x03') {
          ctrlC.push(Date.now());
          // 像 Claude Code：1 秒内连按两下 Ctrl+C 退出 —— 先清掉界面，过 1 秒才真的退出、回到 shell (stuck：怎么按都不退)
          if (mode === 'agent' && ctrlC.length >= 2 && ctrlC[ctrlC.length - 1] - ctrlC[ctrlC.length - 2] < 1000) {
            mode = 'exiting'; st.write('\x1b[2J\x1b[H');
            setTimeout(() => { mode = 'shell'; st.write(SHELL); }, 1000);
          }
        }
      });
    });
  }));
}).listen(2340, '127.0.0.1');

const resume = (sid, cmd, id) => fetch(BASE + '/api/agent-sessions/resume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid, cmd, id }) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

run(async () => {
  const host = await addHost('AR', 2340, { winDaemon: true });
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws');
  let sid = null;
  let out = '';
  ws.on('message', (d, bin) => { if (bin) { out += d.toString(); return; } const m = JSON.parse(d); if (m.type === 'status' && m.status === 'connected') sid = m.sid; });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'connect', hostId: host.id, title: 'AR', cols: 100, rows: 30 }));
  for (let i = 0; i < 50 && !sid; i++) await wait(100);
  await wait(800);
  ok(sid && out.includes('? for shortcuts') && !out.includes('常驻会话没开起来'), 'Linux 主机勾着常驻会话：照常开终端，不提示「常驻会话没开起来」');
  const h = (await (await fetch(BASE + '/api/hosts')).json()).find((x) => x.id === host.id);
  ok(h && h.winDaemon === true && h.os === 'other', '连过以后记下不是能用常驻会话的系统 (主机列表上不标「常驻」): ' + JSON.stringify(h && { winDaemon: h.winDaemon, os: h.os }));

  // 1. 开着 Agent：先两下 Ctrl+C 退出，回到 shell 再执行
  got = '';
  let r = await resume(sid, 'cd /home/demo/proj && claude --resume abc');
  ok(r.status === 200 && r.body.quit === true, '开着 Agent：先退出它: ' + JSON.stringify(r));
  ok(/^\x03\x03cd \/home\/demo\/proj && claude --resume abc\r$/.test(got), '先发两下 Ctrl+C，等 Agent 真的退出、shell 的提示符出来了才发恢复命令 (退出途中发的会被丢掉): ' + JSON.stringify(got));

  // 2. 已经在 shell 里：直接执行，不按 Ctrl+C
  got = '';
  r = await resume(sid, 'claude --resume def');
  ok(r.status === 200 && r.body.quit === false && got === 'claude --resume def\r', '在 shell 里：直接执行，不多按 Ctrl+C: ' + JSON.stringify([r.body, got]));

  // 2b. 开着 Grok 这种界面上没有特别的字的 Agent (只有输入行 > )：光标停在 > 开头的输入行上也算，先退出再执行
  mode = 'agent'; ctrlC = []; st.write('\x1b[2J\x1b[H Grok\r\n\r\n> \x1b[3;3H'); await wait(600);
  got = '';
  r = await resume(sid, 'claude --resume from-grok');
  ok(r.status === 200 && r.body.quit === true && /^\x03\x03claude --resume from-grok\r$/.test(got), '从 Grok 切到 Claude 的对话：先退出 Grok，回到 shell 再执行: ' + JSON.stringify([r.body, got]));

  // 3. Agent 怎么都退不出来：不执行，提示手动退出
  mode = 'stuck'; st.write(AGENT); await wait(500);
  got = '';
  r = await resume(sid, 'claude --resume ghi');
  ok(r.status === 409 && /手动退出/.test(r.body.error) && !got.includes('claude --resume ghi'), '退不出来：命令不发 (免得打进 Agent 的输入框)，提示手动退出: ' + JSON.stringify([r.body, got]));

  // 4. 命过名「甲」的标签「继续」对话 ghi (没命过名)：标签名先清掉；没成功 → 名字还回「甲」
  const renamed = [];
  ws.on('message', (d, bin) => { if (bin) return; const m = JSON.parse(d); if (m.type === 'renamed') renamed.push(m.suffix); });
  ws.send(JSON.stringify({ type: 'rename', suffix: '甲' })); await wait(300);
  renamed.length = 0;
  r = await resume(sid, 'claude --resume ghi', 'ghi');
  for (let i = 0; i < 20 && renamed.length < 2; i++) await wait(100); // WebSocket 上的消息可能比 HTTP 回复晚到
  ok(r.status === 409 && JSON.stringify(renamed) === JSON.stringify(['', '甲']), '「继续」没成功：标签名换成对话的 (清掉) 以后又还回「甲」: ' + JSON.stringify([r.body, renamed]));
  ws.close();
});
