#!/usr/bin/env node
// 测试用的假 sshwebd：实现常驻会话用到的桥接协议 (SSHWEBD READY / list / attach / 输入输出 / kill / quit)。
// 由 test/daemonfix.test.js 当成 Linux 版二进制传到模拟主机上冒充 sshwebd —— 不用编 Go。
// 真的 sshwebd 有常驻的守护进程，这里每个 bridge 进程自己管自己的会话，对本测试够用 (一个标签一个通道)。
'use strict';
const { spawn } = require('child_process');

if (process.argv[2] !== 'bridge') process.exit(0);
process.stdout.write('SSHWEBD READY 9.9.9\n');

const sessions = new Map();
let next = 1;
let cur = null; // 这个通道接着的会话 (一个通道只接一个)
let buf = '';

// 一帧：1 字节类型 (O 输出 / M 消息) + 4 字节长度 + 内容，整帧 base64 成一行
const send = (t, body) => {
  const b = Buffer.from(body);
  const f = Buffer.alloc(5 + b.length);
  f[0] = t.charCodeAt(0);
  f.writeUInt32BE(b.length, 1);
  b.copy(f, 5);
  process.stdout.write(f.toString('base64') + '\n');
};
const msg = (o) => send('M', JSON.stringify(o));
const open = (id) => {
  const at = Date.now();
  const sh = spawn('sh', [], { env: { ...process.env, SSHWEBD_SESSION: id, SSHWEBD_STARTED: String(at) } });
  sh.stdout.on('data', (b) => send('O', b));
  sh.stderr.on('data', (b) => send('O', b));
  sh.on('exit', () => msg({ type: 'exit', code: 0 }));
  const s = { id, at, sh };
  sessions.set(id, s);
  return s;
};

process.stdin.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const f = Buffer.from(line, 'base64');
    const t = String.fromCharCode(f[0]);
    const body = f.subarray(5, 5 + f.readUInt32BE(1));
    if (t === 'H') { // H：请求 (JSON)
      const r = JSON.parse(body.toString());
      if (r.op === 'list') msg({ type: 'list', version: '9.9.9', sessions: [...sessions.values()].map((s) => ({ id: s.id, created: s.at, title: '', cwd: '', clients: 0, tags: [] })) });
      else if (r.op === 'attach') {
        let s = r.id ? sessions.get(String(r.id)) : null;
        const created = !s;
        if (!s) s = open(String(next++));
        cur = s;
        msg({ type: 'attached', id: s.id, start: 0, created, at: s.at, detached: true });
      } else if (r.op === 'kill') {
        const s = sessions.get(String(r.id));
        if (s) { try { s.sh.kill(); } catch {} sessions.delete(String(r.id)); }
        msg({ type: 'ok' });
      } else if (r.op === 'quit') { msg({ type: 'ok' }); process.exit(0); }
      else msg({ type: 'error', error: 'unknown op ' + r.op });
    } else if (t === 'I' && cur) cur.sh.stdin.write(body.toString().replace(/\r(?!\n)/g, '\n')); // I：终端输入 (没有 pty，\r 当回车)
    // S：改终端大小，不用管
  }
});
