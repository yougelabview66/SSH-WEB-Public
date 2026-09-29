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
// 用 playwright-core 1.49 对应的 Chromium (npx playwright install chromium)；也可以用 CHROME_PATH 指定
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
const run = (fn) => fn().then(() => process.exit()).catch((e) => { console.error('✘ 测试出错: ' + (e.stack || e)); process.exit(1); });

module.exports = { BASE, ok, wait, shot, launch, post, addHost, run, hostKey, chromium, devices };
