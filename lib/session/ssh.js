'use strict';
// 会话：建立 SSH 连接 (直连 / Cloudflare 隧道)、主机指纹校验、验证码等交互认证、断开。方法挂到 Session 上 (见 index.js)
const { Client } = require('ssh2');
const { WebSocket, createWebSocketStream } = require('ws');
const { SSH_READY_TIMEOUT, SSH_KEEPALIVE, HOSTKEY_POLICY } = require('../config');
const store = require('../store');
const { fingerprint, keyType } = require('../ssh-target');

// 等待用户输入验证码 / 确认指纹的最长时间
const USER_INPUT_TIMEOUT = 5 * 60 * 1000;

class SessionSsh {
  // 握手超时计时；等待用户输入时换成更长的计时
  armTimeout(ms, message) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(message), ms);
  }

  // 向浏览器提问 (验证码 / 指纹确认)；没有浏览器挂载时等待，挂载后补发
  ask(type, payload) {
    return new Promise((resolve) => {
      this.armTimeout(USER_INPUT_TIMEOUT, '等待输入超时');
      this.pending = { type, payload, resolve };
      this.broadcast({ type, ...payload });
    }).finally(() => { if (this.status === 'connecting') this.armTimeout(SSH_READY_TIMEOUT, '连接超时'); });
  }

  answer(msg) {
    if (this.pending && this.pending.type + '-response' === msg.type) {
      const { resolve } = this.pending;
      this.pending = null;
      this.broadcast({ type: 'prompt-done' }); // 其他浏览器关闭弹窗
      resolve(msg);
    }
  }


  closeConn() {
    clearTimeout(this.timer);
    this.latPending = false;
    this.sshRtt = undefined;
    clearInterval(this.flowTimer);
    this.flowTimer = null;
    this.pending = null;
    try { this.stream && this.stream.close(); } catch {}
    try { this.ssh && this.ssh.end(); } catch {}
    try { this.tunnel && this.tunnel.terminate(); } catch {}
    this.stream = this.ssh = this.tunnel = null;
    this.sftpPromise = null;
    this.monPrev = null;
    this.unwatchHooks(); // 这台主机的钩子事件改由别的标签读 (见 hooks.js)
  }

  fail(message) {
    if (this.status === 'closed') return;
    this.closeConn();
    this.line(`\r\n\x1b[31m✖ ${message}\x1b[0m`);
    this.broadcast({ type: 'error', message });
    this.setStatus('closed');
  }

  ended() {
    if (this.status === 'closed') return;
    this.closeConn();
    this.line('\r\n\x1b[33m连接已断开\x1b[0m');
    this.setStatus('closed');
  }

  connect() {
    if (this.status !== 'closed') return;
    const cfg = this.cfg;
    const attempt = ++this.attempt;
    const alive = () => attempt === this.attempt && this.status === 'connecting';
    this.status = 'connecting';
    this.setStatus('connecting');
    const knownKey = cfg.connType === 'cloudflare' ? `cf:${cfg.host}` : `${cfg.host}:${cfg.port}`;
    const target = cfg.connType === 'cloudflare' ? `${cfg.host} (Cloudflare 隧道)` : `${cfg.host}:${cfg.port}`;
    this.line(`\r\n\x1b[90m正在连接 ${this.title}-${this.n} (${cfg.username}@${target}) ...\x1b[0m`);

    const ssh = new Client();
    this.ssh = ssh;
    const connectOpts = {
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      readyTimeout: 0, // 由 armTimeout 控制，等待用户输入时不计时
      keepaliveInterval: SSH_KEEPALIVE,
      keepaliveCountMax: 4,
      tryKeyboard: true,
      hostVerifier: (key, verify) => {
        verifyHostKey(key).then(verify, () => verify(false));
      },
    };
    if (cfg.privateKey) {
      connectOpts.privateKey = cfg.privateKey;
      if (cfg.passphrase) connectOpts.passphrase = cfg.passphrase;
    }
    if (cfg.password) connectOpts.password = cfg.password;

    // 主机指纹校验 (类似 OpenSSH 的 known_hosts)
    const verifyHostKey = async (key) => {
      const fp = fingerprint(key);
      const type = keyType(key);
      this.line(`\x1b[90m主机指纹: ${type} ${fp}\x1b[0m`);
      if (HOSTKEY_POLICY === 'off') return true;

      const known = store.known.read();
      const old = known[knownKey];
      if (old && old.fingerprint === fp) return true;

      const save = () => {
        const k = store.known.read();
        k[knownKey] = { keyType: type, fingerprint: fp, addedAt: new Date().toISOString() };
        store.known.write(k);
      };
      if (!old && HOSTKEY_POLICY === 'accept-new') {
        save();
        return true;
      }
      const r = await this.ask('hostkey', {
        status: old ? 'changed' : 'new',
        host: target,
        keyType: type,
        fingerprint: fp,
        oldKeyType: old?.keyType,
        oldFingerprint: old?.fingerprint,
      });
      if (!alive()) return false;
      if (!r.accept) {
        this.fail(old ? '主机指纹不匹配，已拒绝连接' : '已取消：未信任主机指纹');
        return false;
      }
      save();
      return true;
    };

    // keyboard-interactive: 密码提示自动用已保存密码应答一次，其余 (TOTP 验证码等) 交给用户输入
    let passwordAutoUsed = false;
    ssh.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
      if (!prompts.length) return finish([]);
      const answers = prompts.map((pr) => {
        if (!passwordAutoUsed && cfg.password && !pr.echo && /pass(word|code)?|密码/i.test(pr.prompt)
            && !/verif|code|token|otp|验证/i.test(pr.prompt)) {
          return cfg.password;
        }
        return null;
      });
      if (answers.some((a) => a !== null)) passwordAutoUsed = true;
      const need = answers.map((a, i) => (a === null ? i : -1)).filter((i) => i >= 0);
      if (!need.length) return finish(answers);

      this.ask('prompt', {
        title: name || '',
        instructions: instructions || '',
        prompts: need.map((i) => ({ prompt: prompts[i].prompt, echo: !!prompts[i].echo })),
      }).then((r) => {
        if (!alive()) return;
        if (r.cancel || !Array.isArray(r.answers)) return this.fail('已取消认证');
        need.forEach((idx, k) => { answers[idx] = String(r.answers[k] ?? ''); });
        finish(answers);
      });
    });

    ssh.on('ready', () => {
      if (!alive()) return;
      clearTimeout(this.timer);
      console.log(`[${new Date().toISOString()}] ${this.clientIp} -> ${cfg.username}@${target} 已连接`);
      // Windows 常驻会话 (sshwebd，见 daemon.js)：开不起来 (不是 Windows 主机等) 就照常开 shell
      if (!cfg.winDaemon) return this.openShell(ssh, alive);
      this.openDaemon(ssh, alive).catch((e) => {
        if (!alive()) return;
        if (e.message === '已取消') return this.fail('已取消');
        this.line(`\x1b[33m⚠ 常驻会话没开起来：${e.message}，改用普通终端\x1b[0m`);
        this.openShell(ssh, alive);
      });
    });

    ssh.on('error', (err) => {
      if (this.ssh !== ssh) return;
      const hint = err.level === 'client-authentication' ? '认证失败，请检查用户名/密码/密钥/验证码' : err.message;
      if (this.status === 'connected') {
        this.line(`\r\n\x1b[31m✖ ${hint}\x1b[0m`);
        this.ended();
      } else {
        this.fail(hint);
      }
    });
    ssh.on('close', () => { if (this.ssh === ssh) this.ended(); });

    this.armTimeout(SSH_READY_TIMEOUT, '连接超时');

    if (cfg.connType === 'cloudflare') {
      this.line(`\x1b[90m通过 Cloudflare 隧道连接 ${/^wss?:\/\//.test(cfg.host) ? cfg.host : 'wss://' + cfg.host} ...\x1b[0m`);
      this.openCloudflareTunnel(cfg)
        .then((sock) => {
          if (!alive()) return sock.destroy();
          connectOpts.sock = sock;
          ssh.connect(connectOpts);
        })
        .catch((e) => { if (alive()) this.fail(e.message); });
      return;
    }

    try {
      ssh.connect(connectOpts);
      ssh.setNoDelay(true); // 和 OpenSSH 一样关闭 Nagle，按键不等待合并，回显更快
    } catch (e) {
      this.fail(e.message);
    }
  }

  // LC_SSHWEB：给这个会话的 shell 做个标记，在里面启动的 tmux 客户端会继承，本地快速滚动靠它精确找到对应的 pane
  // (sshd 默认 AcceptEnv LANG LC_*；不接受时忽略，退回按终端大小猜)
  openShell(ssh, alive) {
    ssh.shell({ term: 'xterm-256color', cols: this.cols, rows: this.rows }, { env: { LC_SSHWEB: this.id } }, (err, stream) => {
      if (!alive()) return;
      if (err) return this.fail('打开 Shell 失败: ' + err.message);
      this.stream = stream;
      stream.on('data', (d) => this.output(d));
      stream.stderr.on('data', (d) => this.output(d));
      stream.on('close', () => { if (this.ssh === ssh) this.ended(); });
      this.setStatus('connected');
    });
  }

  // 与 cloudflared access ssh 相同: 以 WebSocket 连接隧道主机名，SSH 原始字节走二进制帧
  openCloudflareTunnel(cfg) {
    return new Promise((resolve, reject) => {
      const headers = { 'User-Agent': 'cloudflared/ssh-web' };
      if (cfg.cfClientId && cfg.cfClientSecret) {
        headers['CF-Access-Client-Id'] = cfg.cfClientId;
        headers['CF-Access-Client-Secret'] = cfg.cfClientSecret;
      }
      const url = /^wss?:\/\//.test(cfg.host) ? cfg.host : `wss://${cfg.host}`;
      const t = new WebSocket(url, {
        headers,
        handshakeTimeout: SSH_READY_TIMEOUT,
        followRedirects: false,
        perMessageDeflate: false,
      });
      this.tunnel = t;
      let settled = false;
      t.on('unexpected-response', (req, res) => {
        settled = true;
        let msg = `Cloudflare 隧道握手失败: HTTP ${res.statusCode}`;
        if (res.statusCode === 302 || res.statusCode === 403 || res.statusCode === 401) {
          msg += '（该主机名受 Cloudflare Access 保护，请填写 Service Token 并在 Access 策略中放行 Service Auth）';
        } else if (res.statusCode === 502 || res.statusCode === 530) {
          msg += '（隧道离线或 NAS 上 cloudflared 未运行 / ingress 未指向 ssh://localhost:22）';
        }
        res.resume();
        reject(new Error(msg));
      });
      t.on('open', () => {
        settled = true;
        t._socket && t._socket.setNoDelay(true);
        const duplex = createWebSocketStream(t);
        duplex.on('error', () => {});
        resolve(duplex);
      });
      t.on('error', (e) => {
        if (!settled) {
          settled = true;
          reject(new Error('Cloudflare 隧道连接失败: ' + e.message));
        }
      });
    });
  }
}

module.exports = SessionSsh;
