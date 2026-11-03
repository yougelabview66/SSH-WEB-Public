'use strict';
// 端口预览连目标主机的端口：Windows 的 sshd 把 localhost 解析成 ::1，只听 127.0.0.1 的服务连不上；
// 它连不上时还先回「通了」、随后马上关掉 (11-03 真机：OpenCode 2 后台服务的预览打不开)。
// 先连 127.0.0.1，通道被马上关掉就换 ::1、localhost；试通了的地址记住，之后直接用
const { EventEmitter } = require('events');
const { ok } = require('./helpers');
const { openUpstream } = require('../lib/forward');

// 假的 SSH：listen 是真的在听的地址；别的地址照 Windows sshd 的样子先给通道、马上关掉
const fake = (listen, refuseErr = false) => {
  const tried = [];
  return { tried, s: { id: 'tab-' + Math.random(), ssh: { forwardOut: (sa, sp, host, port, cb) => {
    tried.push(host);
    if (host !== listen && refuseErr) return cb(new Error('Connection refused'));
    const st = new EventEmitter();
    st.destroy = () => {};
    cb(null, st);
    if (host !== listen) setTimeout(() => { st.emit('end'); st.emit('close'); }, 20);
  } } } };
};
const open = (f, port) => new Promise((r) => openUpstream(f.s, port, (e, st) => r(e ? 'ERR ' + e.message : 'OK')));

(async () => {
  let f = fake('127.0.0.1');
  ok(await open(f, 3000) === 'OK' && f.tried.join() === '127.0.0.1', '服务听 127.0.0.1：直接连上');
  f = fake('::1');
  ok(await open(f, 5173) === 'OK' && f.tried.join() === '127.0.0.1,::1', '只听 ::1 (Windows 上 sshd 连不上也先说通了、马上关掉)：换 ::1 连上: ' + f.tried);
  f.tried.length = 0;
  ok(await open(f, 5173) === 'OK' && f.tried.join() === '::1', '同一个标签同一个端口：之后直接用试通了的地址，不再等');
  f = fake('localhost', true);
  ok(await open(f, 8080) === 'OK' && f.tried.join() === '127.0.0.1,::1,localhost', 'Linux 的 sshd 连不上直接报错：一个个试下去: ' + f.tried);
  f = fake('nowhere', true);
  ok(/^ERR/.test(await open(f, 9)), '都连不上：报错 (网页上显示「连不上」)');
  process.exit();
})();
