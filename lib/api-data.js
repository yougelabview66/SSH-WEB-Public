'use strict';
// 数据接口：主机、已信任指纹、历史命令、界面设置、收藏命令 (都要登录，见 http.js)
const crypto = require('crypto');
const { HISTORY_MAX } = require('./config');
const store = require('./store');
const { encrypt } = require('./auth');
const { str } = require('./ssh-target');

function registerHosts(app) {
  app.get('/api/hosts', (req, res) => {
    res.json(store.hosts.read().map(store.publicHost));
  });

  app.post('/api/hosts', (req, res) => {
    const b = req.body || {};
    if (!b.host || !b.username) return res.status(400).json({ error: '主机和用户名不能为空' });
    const list = store.hosts.read();
    let h = b.id ? list.find((x) => x.id === b.id) : null;
    if (!h) {
      h = { id: crypto.randomUUID() };
      list.push(h);
    }
    h.name = String(b.name || `${b.username}@${b.host}`).slice(0, 100);
    h.host = String(b.host).trim();
    h.port = parseInt(b.port, 10) || 22;
    h.username = String(b.username).trim();
    h.authType = b.authType === 'key' ? 'key' : 'password';
    h.group = String(b.group || '').slice(0, 50);
    h.connType = b.connType === 'cloudflare' ? 'cloudflare' : 'direct';
    h.cfClientId = h.connType === 'cloudflare' ? String(b.cfClientId || '').trim() : '';
    if (h.connType !== 'cloudflare') h.cfClientSecret = '';
    // 只有传了新值才覆盖密文；传 clearSecret 则清空
    if (b.clearSecret) {
      h.password = h.privateKey = h.passphrase = '';
    }
    if (b.password) h.password = encrypt(b.password);
    if (b.privateKey) h.privateKey = encrypt(b.privateKey);
    if (b.passphrase) h.passphrase = encrypt(b.passphrase);
    if (b.cfClientSecret && h.connType === 'cloudflare') h.cfClientSecret = encrypt(b.cfClientSecret);
    store.hosts.write(list);
    res.json(store.publicHost(h));
  });

  // 侧边栏拖动排序: ids 为新的完整顺序
  app.put('/api/hosts/order', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null;
    if (!ids) return res.status(400).json({ error: '顺序无效' });
    const list = store.hosts.read();
    for (const h of list) {
      const i = ids.indexOf(h.id);
      if (i >= 0) h.order = i;
    }
    store.hosts.write(list);
    res.json({ ok: true });
  });

  app.delete('/api/hosts/:id', (req, res) => {
    store.hosts.write(store.hosts.read().filter((h) => h.id !== req.params.id));
    res.json({ ok: true });
  });

  app.get('/api/known-hosts', (req, res) => {
    const known = store.known.read();
    res.json(Object.entries(known).map(([key, v]) => ({ key, ...v })));
  });

  app.delete('/api/known-hosts', (req, res) => {
    const known = store.known.read();
    delete known[String(req.query.key)];
    store.known.write(known);
    res.json({ ok: true });
  });
}

// 历史命令: 最新的在前；同一主机的相同命令只保留一条并累加次数
function registerHistory(app) {
  app.get('/api/history', (req, res) => {
    res.json(store.history.read());
  });

  app.post('/api/history', (req, res) => {
    const cmd = str(req.body?.cmd).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 2000);
    const host = str(req.body?.host).slice(0, 300);
    if (!cmd) return res.status(400).json({ error: '命令为空' });
    const list = store.history.read();
    const i = list.findIndex((h) => h.host === host && h.cmd === cmd);
    const item = i >= 0 ? list.splice(i, 1)[0] : { id: crypto.randomUUID(), cmd, host, count: 0 };
    item.count += 1;
    item.time = Date.now();
    list.unshift(item);
    store.history.write(list.slice(0, HISTORY_MAX));
    res.json(item);
  });

  app.delete('/api/history/:id', (req, res) => {
    store.history.write(store.history.read().filter((h) => h.id !== req.params.id));
    res.json({ ok: true });
  });

  // 清空: 带 host 参数只清空该主机的记录
  app.delete('/api/history', (req, res) => {
    const host = req.query.host;
    store.history.write(typeof host === 'string' ? store.history.read().filter((h) => h.host !== host) : []);
    res.json({ ok: true });
  });
}

// 界面设置 (手机按键栏等)，保存在服务端，多台设备共享
function registerSettings(app) {
  app.get('/api/settings', (req, res) => {
    res.json(store.settings.read());
  });

  // 手机按键栏: keys 为按键 id 顺序，custom 为自定义按键 { id: { label, seq } }；传 null 恢复默认
  app.put('/api/settings/keybar', (req, res) => {
    const st = store.settings.read();
    const b = req.body || {};
    if (b.reset) {
      delete st.keybar;
    } else {
      const keys = Array.isArray(b.keys) ? b.keys.filter((k) => typeof k === 'string').map((k) => k.slice(0, 40)).slice(0, 80) : null;
      if (!keys) return res.status(400).json({ error: '按键列表无效' });
      const custom = {};
      for (const [id, c] of Object.entries(b.custom || {})) {
        if (!/^c:[\w-]{1,40}$/.test(id) || !c || typeof c.label !== 'string' || typeof c.seq !== 'string') continue;
        custom[id] = { label: c.label.slice(0, 12), seq: c.seq.slice(0, 500) };
      }
      st.keybar = { keys, custom };
    }
    store.settings.write(st);
    res.json(st);
  });
}

// 收藏命令: host 为空表示所有主机通用；按添加顺序排列
function registerFavorites(app) {
  app.get('/api/favorites', (req, res) => {
    res.json(store.favorites.read());
  });

  app.post('/api/favorites', (req, res) => {
    const cmd = str(req.body?.cmd).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 2000);
    const host = str(req.body?.host).slice(0, 300);
    if (!cmd) return res.status(400).json({ error: '命令为空' });
    const list = store.favorites.read();
    let item = list.find((f) => f.cmd === cmd && f.host === host);
    if (!item) {
      item = { id: crypto.randomUUID(), cmd, host, created: Date.now() };
      list.push(item);
      store.favorites.write(list.slice(-500));
    }
    res.json(item);
  });

  // 拖动排序: ids 为新的完整顺序；没有列出的收藏保持原来的相对顺序排在后面
  app.put('/api/favorites/order', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null;
    if (!ids) return res.status(400).json({ error: '顺序无效' });
    const list = store.favorites.read();
    const pos = (f) => { const i = ids.indexOf(f.id); return i < 0 ? ids.length : i; };
    store.favorites.write(list.map((f, i) => [f, i]).sort((a, b) => pos(a[0]) - pos(b[0]) || a[1] - b[1]).map(([f]) => f));
    res.json({ ok: true });
  });

  // 修改适用范围 (所有主机 / 仅某台主机)
  app.put('/api/favorites/:id', (req, res) => {
    const list = store.favorites.read();
    const item = list.find((f) => f.id === req.params.id);
    if (!item) return res.status(404).json({ error: '收藏不存在' });
    if (typeof req.body?.host === 'string') item.host = req.body.host.slice(0, 300);
    store.favorites.write(list);
    res.json(item);
  });

  app.delete('/api/favorites/:id', (req, res) => {
    store.favorites.write(store.favorites.read().filter((f) => f.id !== req.params.id));
    res.json({ ok: true });
  });
}

module.exports = { registerHosts, registerHistory, registerSettings, registerFavorites };
