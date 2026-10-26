'use strict';

/**
 * SFTP 文件管理 HTTP 接口
 * 复用终端会话已认证的 SSH 连接 (不需要再次输入密码 / TOTP)。
 * 大文件上传下载走 HTTP 流，不经过 WebSocket。
 */

const posix = require('path').posix;
const { Readable, Writable } = require('stream');
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

function contentDisposition(name, type = 'attachment') {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// 预览 (下载接口带 inline=1)：图片、PDF 按原类型给浏览器显示，其他都当纯文本 (网页自己判断能不能显示)。
// 不管什么文件都不让它在 SSH-WEB 的网址下执行脚本 (html / svg 里可能带)：nosniff + CSP sandbox；
// PDF 例外 (沙箱里浏览器不肯打开 PDF 阅读器)，浏览器的 PDF 阅读器不执行网页脚本
const PREVIEW_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  ico: 'image/x-icon', avif: 'image/avif', svg: 'image/svg+xml', pdf: 'application/pdf',
};
const PREVIEW_TEXT_MAX = 2 * 1024 * 1024; // 文本超过这么大不预览 (网页里显示不动)
const previewType = (name) => PREVIEW_TYPES[(name.match(/\.([^./]+)$/)?.[1] || '').toLowerCase()] || 'text/plain; charset=utf-8';

// ssh2 自带的读写流同时只有一个请求在途，每块数据都要等一个网络往返 (隧道上不到 1MB/s)；
// 这里同时发出多个请求 (和 OpenSSH sftp / scp 一样)，按顺序拼接输出
const INFLIGHT_BYTES = 4 * 1024 * 1024; // 同时在途的数据量上限

// 每个请求的块大小不超过服务器单包上限 (OpenSSH 256KB，其他 ~32KB)，否则 ssh2 会拆成串行请求
function chunkSize(sftp, key) {
  return Math.min(sftp[key] || 32 * 1024, 256 * 1024);
}

function maxInflight(chunk) {
  return Math.max(4, Math.min(64, Math.floor(INFLIGHT_BYTES / chunk)));
}

class ParallelReader extends Readable {
  constructor(sftp, handle, size) {
    super({ highWaterMark: 1024 * 1024 });
    this.sftp = sftp;
    this.handle = handle;
    this.size = size;
    this.pos = 0; // 下一个要请求的位置
    this.next = 0; // 下一个要输出的位置
    this.ready = new Map(); // 已读到、等待按顺序输出的块 (位置 -> 数据)
    this.inflight = 0;
    this.want = false;
    this.chunk = chunkSize(sftp, '_maxReadLen');
    this.limit = maxInflight(this.chunk);
  }

  _read() {
    this.want = true;
    if (this.next >= this.size) this.push(null);
    else this.pump();
  }

  pump() {
    while (this.want && this.inflight + this.ready.size < this.limit && this.pos < this.size) {
      const len = Math.min(this.chunk, this.size - this.pos);
      this.request(this.pos, len);
      this.pos += len;
    }
  }

  request(pos, len) {
    this.inflight++;
    const buf = Buffer.allocUnsafe(len);
    this.sftp.read(this.handle, buf, 0, len, pos, (err, n) => {
      this.inflight--;
      if (this.destroyed) return;
      if (err) return this.destroy(err);
      if (!n) return this.destroy(new Error('文件在下载过程中变小了'));
      this.ready.set(pos, n < len ? buf.subarray(0, n) : buf);
      if (n < len) this.request(pos + n, len - n); // 读到的比请求的少，补读剩下的部分
      this.flush();
    });
  }

  flush() {
    while (this.ready.has(this.next)) {
      const b = this.ready.get(this.next);
      this.ready.delete(this.next);
      this.next += b.length;
      if (!this.push(b)) this.want = false;
    }
    if (this.next >= this.size) this.push(null);
    else this.pump();
  }

  _destroy(err, cb) {
    this.ready.clear();
    this.sftp.close(this.handle, () => {});
    cb(err);
  }
}

class ParallelWriter extends Writable {
  constructor(sftp, handle) {
    super({ highWaterMark: 1024 * 1024 });
    this.sftp = sftp;
    this.handle = handle;
    this.pos = 0;
    this.inflight = 0;
    this.err = null;
    this.waiting = null; // { max, cb }: 在途请求降到 max 以下时回调
    this.chunk = chunkSize(sftp, '_maxWriteLen');
    this.limit = maxInflight(this.chunk);
  }

  _write(data, enc, cb) {
    for (let off = 0; off < data.length && !this.err; off += this.chunk) {
      const piece = data.subarray(off, off + this.chunk);
      const pos = this.pos;
      this.pos += piece.length;
      this.inflight++;
      this.sftp.write(this.handle, piece, 0, piece.length, pos, (err) => {
        this.inflight--;
        if (err && !this.err) this.err = err;
        this.wake();
      });
    }
    this.wait(this.limit - 1, cb);
  }

  wait(max, cb) {
    this.waiting = { max, cb };
    this.wake();
  }

  wake() {
    const w = this.waiting;
    if (!w || (!this.err && this.inflight > w.max)) return;
    this.waiting = null;
    w.cb(this.err);
  }

  // 等所有写入完成再关闭文件
  _final(cb) {
    this.wait(0, (err) => {
      if (err) return cb(err);
      const h = this.handle;
      this.handle = null;
      this.sftp.close(h, cb);
    });
  }

  _destroy(err, cb) {
    if (this.handle) this.sftp.close(this.handle, () => {});
    this.handle = null;
    cb(err);
  }
}

// 会话的 SFTP 通道 (懒加载，每个 SSH 连接只开一个；文件管理、钩子安装共用)。
// 开的时候最多等 20 秒 (主机的 sftp-server 卡住时，不然这个会话的文件、钩子、常驻会话上传都一起挂住)；
// 关掉时只清自己这一个 (断线重连后，旧通道晚到的 close 不能把新的清掉)
function sftpOf(sess) {
  if (!sess.sftpPromise) {
    const ssh = sess.ssh;
    // 连接已经断了 (closeConn 会把 ssh 置空)：直接给个说得清的错误，别让下面去读 null.sftp
    if (!ssh) return Promise.reject(new Error('连接已断开'));
    const pr = new Promise((resolve, reject) => {
      let timedOut = false;
      const t = setTimeout(() => { timedOut = true; reject(new Error('打开 SFTP 超时')); }, 20000);
      ssh.sftp((e, s) => {
        clearTimeout(t);
        // 超时之后才开起来的通道：没人再拿得到它了，关掉 —— 以前直接 resolve 进一个没人持有的 promise，
        // 通道一直挂着，主机上 sftp-server 卡住时每次重试都漏一个，攒到 sshd 的通道上限之后全都连不上
        if (timedOut) { try { s && s.close(); } catch {} return; }
        if (e) reject(e); else resolve(s);
      });
    });
    sess.sftpPromise = pr;
    const drop = () => { if (sess.sftpPromise === pr) sess.sftpPromise = null; };
    pr.then((s) => s.on('close', drop), drop);
  }
  return sess.sftpPromise;
}

module.exports = function registerSftp(app, getSession) {
  const router = express.Router();
  const str = (v) => (typeof v === 'string' ? v : '');

  // 取得会话的 SFTP 通道 (懒加载，每个 SSH 连接只开一个)
  router.use('/:sid', async (req, res, next) => {
    const sess = getSession(req.params.sid);
    if (!sess || !sess.ssh) return res.status(404).json({ error: '会话不存在或已断开' });
    try {
      req.sftp = await sftpOf(sess);
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
        if (posix.normalize(file) === '/') return res.status(400).json({ error: '不支持打包下载根目录' });
        // 目录: 在远端 tar 打包后流式下载
        // 用 ./name，避免以 - 开头的目录名被 tar 当成参数
        req.sess.ssh.exec(`tar czf - -C ${shq(posix.dirname(file))} ${shq('./' + name)}`, (err, stream) => {
          if (err) return res.status(500).json({ error: '打包失败：' + err.message });
          if (res.destroyed || req.destroyed) return stream.close(); // 浏览器已经取消了：不留着远端的 tar
          res.setHeader('Content-Type', 'application/gzip');
          res.setHeader('Content-Disposition', contentDisposition(name + '.tar.gz'));
          stream.pipe(res);
          stream.stderr.resume();
          res.on('close', () => stream.close());
        });
        return;
      }

      const inline = req.query.inline === '1';
      const type = inline ? previewType(name) : 'application/octet-stream';
      if (inline && type.startsWith('text/') && st.size > PREVIEW_TEXT_MAX) {
        return res.status(413).json({ error: `文件太大（${(st.size / 1048576).toFixed(1)} MB），请下载后查看` });
      }
      const handle = await p((cb) => req.sftp.open(file, 'r', cb));
      if (res.destroyed || req.destroyed) return req.sftp.close(handle, () => {}); // 打开文件的时候浏览器已经取消了：关掉，不留着句柄
      res.setHeader('Content-Type', type);
      res.setHeader('Content-Length', st.size);
      res.setHeader('Content-Disposition', contentDisposition(name, inline ? 'inline' : 'attachment'));
      if (inline) {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        // (全站的安全策略里 object-src 'none' 也会挡住浏览器的 PDF 阅读器，PDF 不带)
        if (type === 'application/pdf') res.removeHeader('Content-Security-Policy');
        else res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");
      }
      const rs = new ParallelReader(req.sftp, handle, st.size);
      rs.on('error', (e) => res.destroy(e));
      res.on('close', () => rs.destroy());
      rs.pipe(res);
    } catch (e) {
      res.status(400).json({ error: errMsg(e) });
    }
  });

  // PUT /upload?path=/完整/目标/路径&overwrite=1  请求体为文件原始内容
  // 先写到同一目录下的临时文件 (.名字.sshweb-xxx)，传完再换成目标文件：中途断网 / 取消，原来的文件不受影响
  // (以前直接打开目标文件写，一打开内容就清空了，覆盖上传断在中途原文件就没了)。
  // 覆盖时换到符号链接指向的真实文件上，权限照原来的；目录不让写临时文件 (只给了文件的写权限) 时退回直接写
  router.put('/:sid/upload', async (req, res) => {
    const file = String(req.query.path || '');
    if (!file) return res.status(400).json({ error: '缺少 path' });
    const sftp = req.sftp;
    let target = file, mode = null, existed = false;
    try {
      const st = await p((cb) => sftp.stat(file, cb));
      existed = true;
      if (req.query.overwrite !== '1') { req.resume(); return res.status(409).json({ error: '文件已存在' }); }
      if (st.isDirectory()) { req.resume(); return res.status(400).json({ error: '同名的是一个目录' }); }
      mode = st.mode & 0o7777;
      target = await p((cb) => sftp.realpath(file, cb)).catch(() => file);
    } catch {}
    let tmp = posix.join(posix.dirname(target), `.${posix.basename(target)}.sshweb-${Date.now().toString(36)}`);
    let handle;
    try {
      handle = await p((cb) => sftp.open(tmp, 'wx', cb));
    } catch {
      tmp = null; // 目录不能写：直接写目标文件 (同以前)
      try {
        handle = await p((cb) => sftp.open(target, 'w', cb));
      } catch (e) {
        req.resume();
        return res.status(400).json({ error: errMsg(e) });
      }
    }
    // 传完：换成目标文件。已有的文件优先用 OpenSSH 的原子替换，服务器不支持时先删再改名
    // (删掉原文件后改名失败：新文件留着不删，告诉在哪)
    let kept = false;
    const replace = async () => {
      if (!tmp) return;
      if (mode !== null) await p((cb) => sftp.chmod(tmp, mode, cb)).catch(() => {});
      if (existed) {
        try { return await p((cb) => sftp.ext_openssh_rename(tmp, target, cb)); } catch (e) { if (!/not support/i.test(e.message)) throw e; }
        await p((cb) => sftp.unlink(target, cb));
      }
      try {
        await p((cb) => sftp.rename(tmp, target, cb));
      } catch (e) {
        if (!existed) throw e;
        kept = true;
        throw new Error(`换上新文件失败，新文件留在 ${tmp}：${errMsg(e)}`);
      }
    };
    const ws = new ParallelWriter(sftp, handle);
    let done = false;
    const fail = (e) => {
      if (done) return;
      done = true;
      ws.destroy();
      if (!kept) sftp.unlink(tmp || target, () => {}); // 删掉传了一半的 (临时文件；直接写的时候是目标文件，同以前)
      if (e && !res.headersSent) res.status(400).json({ error: errMsg(e) });
    };
    req.on('close', () => { if (!req.complete) fail(); });
    if (req.destroyed && !req.complete) return fail(); // 打开文件期间浏览器已取消上传
    ws.on('error', fail);
    ws.on('finish', async () => {
      if (done) return;
      try {
        await replace();
        done = true;
        res.json({ ok: true });
      } catch (e) {
        fail(e);
      }
    });
    req.pipe(ws);
  });

  // 发给 Claude 的附件 (拖进终端的文件、粘贴的截图、手机选的图) 放在目标主机的 ~/.cache/ssh-web/uploads：
  // 建好目录 (逐级，已有的不管)，返回绝对路径；顺手删掉 7 天前的旧附件
  const ATTACH_KEEP = 7 * 86400;
  router.post('/:sid/attach-dir', async (req, res) => {
    const sftp = req.sftp;
    try {
      let dir = await p((cb) => sftp.realpath('.', cb));
      for (const part of ['.cache', 'ssh-web', 'uploads']) {
        dir = posix.join(dir, part);
        await p((cb) => sftp.mkdir(dir, cb)).catch(() => {});
      }
      if (!(await p((cb) => sftp.stat(dir, cb))).isDirectory()) throw new Error(`${dir} 不是目录`);
      res.json({ dir });
      sftp.readdir(dir, (err, list) => {
        if (err) return;
        const old = Date.now() / 1000 - ATTACH_KEEP;
        for (const f of list) if (f.attrs.isFile() && f.attrs.mtime < old) sftp.unlink(posix.join(dir, f.filename), () => {});
      });
    } catch (e) {
      res.status(400).json({ error: '建不了附件目录：' + errMsg(e) });
    }
  });

  // 「终端 cd」：按终端里的 shell 给出切换目录的命令 (Linux sh / Windows 的 cmd、PowerShell 写法不一样；Windows 的 SFTP 路径是 /D:/xxx)
  router.post('/:sid/cd', async (req, res) => {
    const dir = String(req.body?.path || '');
    if (!dir) return res.status(400).json({ error: '缺少路径' });
    const shell = await req.sess.termShell().catch(() => 'sh');
    const win = dir.replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\');
    const cmd = shell === 'cmd' ? `cd /d "${win}"` : shell === 'powershell' ? `cd '${win.replace(/'/g, "''")}'` : `cd ${shq(dir)}`;
    res.json({ shell, cmd });
  });

  router.post('/:sid/mkdir', async (req, res) => {
    try {
      await p((cb) => req.sftp.mkdir(str(req.body?.path), cb));
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: errMsg(e) });
    }
  });

  router.post('/:sid/rename', async (req, res) => {
    try {
      await p((cb) => req.sftp.rename(str(req.body?.from), str(req.body?.to), cb));
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: errMsg(e) });
    }
  });

  router.post('/:sid/delete', async (req, res) => {
    const target = str(req.body?.path);
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
module.exports.sftpOf = sftpOf;
