'use strict';
// 测试公共工具：由 test/run.js 启动干净的服务后运行，服务地址在 SSHWEB_URL
const os = require('os');
const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright-core');

const BASE = process.env.SSHWEB_URL || 'http://127.0.0.1:18889';
const SHOT_DIR = process.env.SHOT_DIR || path.join(os.tmpdir(), 'sshweb-shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const ok = (c, m) => { console.log((c ? '✔ ' : '✘ ') + m); if (!c) process.exitCode = 1; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (name) => path.join(SHOT_DIR, name);
// 用 playwright-core 1.49 对应的 Chromium (npx playwright-core install chromium)；也可以用 CHROME_PATH 指定
const launch = (args = []) => chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--no-sandbox', ...args],
});
const post = (p, body) => fetch(BASE + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json());
const addHost = (name, port, extra = {}) => post('/api/hosts', { name, host: '127.0.0.1', port, username: 'u', password: 'x', ...extra });
// 未捕获的错误算失败并退出 (模拟服务器会一直监听，不主动退出进程会挂住)
// 模拟 SSH 服务器的主机密钥：ssh2 生成的 ed25519 密钥偶尔自己都解析不了 (Malformed OpenSSH private key)，解析失败就重新生成
function hostKey() {
  const { utils } = require('ssh2');
  for (let i = 0; i < 20; i++) {
    const k = utils.generateKeyPairSync('ed25519').private;
    if (!(utils.parseKey(k) instanceof Error)) return k;
  }
  throw new Error('生成主机密钥失败');
}
// 等页面满足某个条件：从测试这边反复读取 (page.waitForFunction 反复检查时要在页面里执行字符串代码，会被安全策略 CSP 拦住)
async function waitFor(page, fn, arg, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page.evaluate(fn, arg).catch(() => false)) return;
    await wait(100);
  }
  throw new Error('等待超时: ' + fn.toString().slice(0, 80));
}
const run = (fn) => fn().then(() => process.exit()).catch((e) => { console.error('✘ 测试出错: ' + (e.stack || e)); process.exit(1); });

// 测试退出时 (包括中途出错)：结束程序文件在这个临时目录里的进程 (测试起的 sshwebd 守护进程；里面还有会话时它不会自己退出)
function killUnder(dir) {
  process.on('exit', () => {
    for (const p of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(p)) continue;
      let exe = '';
      try { exe = fs.readlinkSync(`/proc/${p}/exe`); } catch { continue; }
      if (exe.startsWith(dir + '/')) try { process.kill(+p, 'SIGKILL'); } catch {}
    }
  });
}

module.exports = { BASE, ok, wait, shot, launch, post, addHost, run, hostKey, waitFor, chromium, devices, killUnder };
