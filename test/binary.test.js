'use strict';
// 旧式鼠标点击 (二进制，mc / htop 这类程序) 写进会话：不报错，主机状态照常更新 (以前拿去当文字分析，抛异常)
const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-bin-'));
const { ok } = require('./helpers');
const { Session } = require('../lib/session');

const s = new Session({ host: '127.0.0.1', username: 'u', connType: 'direct' }, { title: 'B' });
const written = [];
s.stream = { write: (d) => written.push(d) };
s.state = { label: '空闲', cls: 'idle' };
let err = null;
try {
  s.write(Buffer.from('\x1b[M !!')); // 老式鼠标报告
  s.write('abc');
} catch (e) { err = e; }
ok(!err, '二进制输入不报错' + (err ? ': ' + err.message : ''));
ok(written.length === 2 && Buffer.isBuffer(written[0]), '二进制原样写进 SSH');
ok(s.cli.get().text === 'abc', '之后打的字照常算进终端输入框: ' + JSON.stringify(s.cli.get().text));
ok(s.tracker.dataAt > 0, '算作有输入 (主机状态照常更新)');
s.terminate();
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
process.exit();
