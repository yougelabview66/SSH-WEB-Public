'use strict';
// 一键运行测试：node test/run.js [名字…]  (名字是 test/<名字>.test.js，不写就是全部)
// 每个测试单独启动一个干净的服务 (只监听 127.0.0.1 的随机端口、临时数据目录)，测完清理；
// 有任何一项失败或出错就以非 0 退出，拿来挡住有问题的提交
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const all = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).map((f) => f.slice(0, -8)).sort();
const want = process.argv.slice(2);
const names = want.length ? want : all;
for (const n of names) if (!all.includes(n)) { console.error(`没有这个测试: ${n} (可用: ${all.join(' ')})`); process.exit(2); }

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function waitUp(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url + '/healthz')).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('服务没有启动');
}

function runOne(name) {
  return new Promise(async (resolve) => {
    const port = await freePort();
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-test-'));
    const url = `http://127.0.0.1:${port}`;
    const srv = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: data, HOSTKEY_POLICY: 'off', AUTH_PASSWORD: '' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let srvErr = '';
    srv.stderr.on('data', (d) => { srvErr += d; });
    const done = (res) => { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); resolve(res); };
    try { await waitUp(url); } catch (e) { return done({ name, pass: 0, fail: 1, out: e.message + '\n' + srvErr }); }
    const t0 = Date.now();
    const t = spawn(process.execPath, [path.join(__dirname, name + '.test.js')], { cwd: ROOT, env: { ...process.env, SSHWEB_URL: url } });
    let out = '';
    t.stdout.on('data', (d) => { out += d; });
    t.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { out += '\n✘ 超时 (5 分钟)'; t.kill(); }, 5 * 60 * 1000);
    t.on('close', (code) => {
      clearTimeout(timer);
      const pass = (out.match(/^✔/gm) || []).length;
      let fail = (out.match(/^✘/gm) || []).length;
      if (code !== 0 && !fail) fail = 1; // 出错退出也算失败
      done({ name, pass, fail, out, secs: ((Date.now() - t0) / 1000).toFixed(0) });
    });
  });
}

(async () => {
  let failed = 0;
  for (const n of names) {
    const r = await runOne(n);
    console.log(`${r.fail ? '✘' : '✔'} ${n.padEnd(10)} 通过 ${r.pass}${r.fail ? `，失败 ${r.fail}` : ''}${r.secs ? `  (${r.secs}s)` : ''}`);
    if (r.fail) {
      failed++;
      console.log(r.out.split('\n').filter((l) => !l.startsWith('✔')).map((l) => '    ' + l).join('\n'));
    }
  }
  console.log(failed ? `\n${failed} 个测试有失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
})();
