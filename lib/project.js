'use strict';
// 右边栏「项目」选项卡 (像 VS Code / Orca 的资源管理器，见 public/app/66-right-bar.js)：
// 项目目录 (和「改动」共用：Agent 干活的目录 → 终端所在目录 → 主目录，也能手动指定；是 git 仓库就用仓库根目录)、
// 按层列目录 (SFTP，Windows 也能用)、项目里全部文件 (快速打开用：git ls-files 跳过 .gitignore；不是仓库用 find / SFTP 逐层列)

const { posix } = require('path');
const { liveSession } = require('./session');
const { sftpOf } = require('./sftp');
const { projectDir, quoter, run } = require('./git-changes');

const MAX_FILES = 50000;
const FILES_TTL = 120000; // 全部文件的列表记这么久 (再打开 / 换搜索词不用重新列)
const HEAVY = ['node_modules', '.git', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', '.next', '.cache', 'vendor', '.gradle', '.idea'];
const pr = (fn) => new Promise((resolve, reject) => fn((e, v) => (e ? reject(e) : resolve(v))));
// Windows 的路径 (D:\x、D:/x) ↔ SFTP 的路径 (/D:/x)
const toSftp = (p) => { const s = String(p).replace(/\\/g, '/'); return /^[A-Za-z]:/.test(s) ? '/' + s : s; };

async function info(sess, dir) {
  const base = await sess.shellBase(sess.ssh);
  const q = quoter(base);
  let source = 'manual';
  if (!dir) {
    dir = await projectDir(sess, base);
    source = sess.agentCwd && dir === sess.agentCwd ? 'agent' : dir ? 'terminal' : 'home';
  }
  const sftp = await sftpOf(sess);
  const at = dir || '.';
  const top = (await run(sess, `git -C ${q(at)} rev-parse --show-toplevel`)).out.trim().split(/\r?\n/).pop() || '';
  const isGit = !!top && !/fatal|not a git/i.test(top);
  let root;
  try { root = await pr((cb) => sftp.realpath(toSftp(isGit ? top : at), cb)); } catch { throw new Error(`找不到目录：${dir || '主目录'}`); }
  return { dir: at, source, root, isGit };
}

// 一层目录：文件夹在前，按名字排
async function ls(sess, path) {
  const sftp = await sftpOf(sess);
  const list = await pr((cb) => sftp.readdir(toSftp(path), cb));
  return list.filter((e) => e.filename !== '.git' && e.filename !== '.' && e.filename !== '..').map((e) => {
    const a = e.attrs;
    return { name: e.filename, dir: a.isDirectory(), link: a.isSymbolicLink(), size: a.size, heavy: a.isDirectory() && HEAVY.includes(e.filename) };
  }).sort((x, y) => (y.dir - x.dir) || x.name.localeCompare(y.name));
}

const filesCache = new Map(); // 会话 + 目录 → { at, files, more }
async function files(sess, root, isGit) {
  const key = `${sess.id}|${root}`, c = filesCache.get(key);
  if (c && Date.now() - c.at < FILES_TTL) return { files: c.files, more: c.more };
  const base = await sess.shellBase(sess.ssh);
  const q = quoter(base);
  const shRoot = root.replace(/^\/([A-Za-z]:)/, '$1'); // git / find 认 D:/x
  let out = [];
  if (isGit) {
    const r = await run(sess, `git -C ${q(shRoot)} -c core.quotepath=off ls-files -co --exclude-standard -z`);
    out = r.out.split('\0').filter(Boolean);
  } else if (base === 'sh') {
    const prune = HEAVY.map((n) => `-name ${q(n)}`).join(' -o ');
    const r = await run(sess, `sh -c ${q(`cd ${q(root)} && find . \\( ${prune} \\) -prune -o -type f -print | head -n ${MAX_FILES + 1}`)}`);
    out = r.out.split('\n').filter(Boolean).map((p) => p.replace(/^\.\//, ''));
  } else {
    // Windows 不是仓库：SFTP 一层层列 (跳过大目录，最多 8 秒)
    const sftp = await sftpOf(sess);
    const end = Date.now() + 8000, queue = [''];
    while (queue.length && out.length <= MAX_FILES && Date.now() < end) {
      const rel = queue.shift();
      const list = await pr((cb) => sftp.readdir(posix.join(root, rel), cb)).catch(() => []);
      for (const e of list) {
        if (e.filename === '.' || e.filename === '..') continue;
        const p = rel ? `${rel}/${e.filename}` : e.filename;
        if (e.attrs.isDirectory()) { if (!HEAVY.includes(e.filename)) queue.push(p); } else out.push(p);
      }
    }
  }
  const more = out.length > MAX_FILES;
  out = out.slice(0, MAX_FILES);
  filesCache.set(key, { at: Date.now(), files: out, more });
  if (filesCache.size > 50) filesCache.delete(filesCache.keys().next().value);
  return { files: out, more };
}

function registerProject(app) {
  const route = (fn) => async (req, res) => {
    const s = liveSession(String(req.body?.sid || ''));
    if (!s) return res.status(404).json({ error: '会话不存在或已断开' });
    try {
      res.json(await fn(s, req.body || {}));
    } catch (e) {
      res.status(400).json({ error: e.message || String(e) });
    }
  };
  app.post('/api/project/info', route((s, b) => info(s, String(b.dir || '').trim())));
  app.post('/api/project/ls', route(async (s, b) => ({ entries: await ls(s, String(b.path || '')) })));
  app.post('/api/project/files', route((s, b) => {
    if (b.fresh) filesCache.delete(`${s.id}|${b.root}`);
    return files(s, String(b.root || ''), !!b.isGit);
  }));
}

module.exports = { registerProject };
