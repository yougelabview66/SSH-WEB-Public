'use strict';

/**
 * SFTP 文件管理 HTTP 接口
 * 复用终端会话已认证的 SSH 连接 (不需要再次输入密码 / TOTP)。
 * 大文件上传下载走 HTTP 流，不经过 WebSocket。
 */

const posix = require('path').posix;
const express = require('express');

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function p(fn) {
  return new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));
}

function modeString(mode, type) {
  const t = type === 'dir' ? 'd' : type === 'link' ? 'l' : '-';
  const bits = 'rwxrwxrwx';
  let s = '';
  for (let i = 0; i < 9; i++) s += mode & (1 << (8 - i)) ? bits[i] : '-';
  return t + s;
}

function errMsg(e) {
  const map = { 2: '文件或目录不存在', 3: '权限不足', 4: '操作失败（目录非空或不支持）' };
  return map[e.code] || e.message || String(e);
}

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

module.exports = function registerSftp(app, getSession) {
  const router = express.Router();

  // 取得会话的 SFTP 通道 (懒加载，每个 SSH 连接只开一个)
  router.use('/:sid', async (req, res, next) => {
    const sess = getSession(req.params.sid);
    if (!sess || !sess.ssh) return res.status(404).json({ error: '会话不存在或已断开' });
    try {
      if (!sess.sftpPromise) {
        sess.sftpPromise = p((cb) => sess.ssh.sftp(cb));
        sess.sftpPromise.then((s) => s.on('close', () => { sess.sftpPromise = null; }),
          () => { sess.sftpPromise = null; });
      }
      req.sftp = await sess.sftpPromise;
      req.sess = sess;
      next();
    } catch (e) {
      res.status(500).json({ error: '无法打开 SFTP：' + e.message + '（目标主机可能未启用 SFTP 子系统）' });
    }
  });

  router.get('/:sid/list', async (req, res) => {
    const sftp = req.sftp;
    try {
      const dir = await p((cb) => sftp.realpath(req.query.path || '.', cb));
      const list = await p((cb) => sftp.readdir(dir, cb));
      const items = await Promise.all(list.map(async (f) => {
        const a = f.attrs;
        let type = a.isDirectory() ? 'dir' : a.isSymbolicLink() ? 'link' : 'file';
        let isDir = type === 'dir';
        if (type === 'link') {
          try { isDir = (await p((cb) => sftp.stat(posix.join(dir, f.filename), cb))).isDirectory(); } catch {}
        }
        return {
          name: f.filename,
          type,
          isDir,
          size: a.size,
          mtime: a.mtime * 1000,
          mode: modeString(a.mode, type),
        };
      }));
      items.sort((x, y) => (y.isDir - x.isDir) || x.name.localeCompare(y.name));
      res.json({ path: dir, items });
    } catch (e) {
      res.status(400).json({ error: errMsg(e) });
    }
  });

  router.get('/:sid/download', async (req, res) => {
    const file = String(req.query.path || '');
    if (!file) return res.status(400).json({ error: '缺少 path' });
    try {
      const st = await p((cb) => req.sftp.stat(file, cb));
      const name = posix.basename(file) || 'root';

      if (st.isDirectory()) {
        // 目录: 在远端 tar 打包后流式下载
        req.sess.ssh.exec(`tar czf - -C ${shq(posix.dirname(file))} ${shq(name)}`, (err, stream) => {
          if (err) return res.status(500).json({ error: '打包失败：' + err.message });
          res.setHeader('Content-Type', 'application/gzip');
          res.setHeader('Content-Disposition', contentDisposition(name + '.tar.gz'));
          stream.pipe(res);
          stream.stderr.resume();
          res.on('close', () => stream.close());
        });
        return;
      }

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', st.size);
      res.setHeader('Content-Disposition', contentDisposition(name));
      const rs = req.sftp.createReadStream(file);
      rs.on('error', (e) => res.destroy(e));
      res.on('close', () => rs.destroy());
      rs.pipe(res);
    } catch (e) {
      res.status(400).json({ error: errMsg(e) });
    }
  });

  // PUT /upload?path=/完整/目标/路径&overwrite=1  请求体为文件原始内容
  router.put('/:sid/upload', async (req, res) => {
    const file = String(req.query.path || '');
    if (!file) return res.status(400).json({ error: '缺少 path' });
    const sftp = req.sftp;
    if (req.query.overwrite !== '1') {
      try {
        await p((cb) => sftp.stat(file, cb));
        req.resume();
        return res.status(409).json({ error: '文件已存在' });
      } catch {}
    }
    const ws = sftp.createWriteStream(file);
    let done = false;
    const abort = () => {
      if (done) return;
      done = true;
      ws.destroy();
      sftp.unlink(file, () => {});
    };
    req.on('aborted', abort);
    ws.on('error', (e) => {
      abort();
      if (!res.headersSent) res.status(400).json({ error: errMsg(e) });
    });
    ws.on('close', () => {
      if (done) return;
      done = true;
      res.json({ ok: true });
    });
    req.pipe(ws);
  });

  router.post('/:sid/mkdir', async (req, res) => {
    try {
      await p((cb) => req.sftp.mkdir(String(req.body.path), cb));
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: errMsg(e) });
    }
  });

  router.post('/:sid/rename', async (req, res) => {
    try {
      await p((cb) => req.sftp.rename(String(req.body.from), String(req.body.to), cb));
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: errMsg(e) });
    }
  });

  router.post('/:sid/delete', async (req, res) => {
    const target = String(req.body.path || '');
    if (!target || target === '/') return res.status(400).json({ error: '不允许删除根目录' });
    const sftp = req.sftp;
    const rm = async (f) => {
      const st = await p((cb) => sftp.lstat(f, cb));
      if (st.isDirectory()) {
        for (const c of await p((cb) => sftp.readdir(f, cb))) await rm(posix.join(f, c.filename));
        await p((cb) => sftp.rmdir(f, cb));
      } else {
        await p((cb) => sftp.unlink(f, cb));
      }
    };
    try {
      await rm(target);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: errMsg(e) });
    }
  });

  app.use('/api/sftp', router);
};
