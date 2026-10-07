'use strict';

/**
 * 完成通知 (Web Push)
 * 终端里出现提示音 (BEL) 或通知序列 (OSC 9 / OSC 777) 时，推送到已订阅的浏览器 / 手机。
 * 由服务端发送，所以手机锁屏、切到其他 App、关掉浏览器也能收到。
 * 需要 HTTPS 访问 (浏览器要求)；iPhone 需先把网页添加到主屏幕。
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const webpush = require('web-push');

// 各浏览器官方推送服务的域名 (Chrome/Edge/安卓 → FCM，Firefox → Mozilla，Safari/iOS → Apple，旧 Edge → WNS)
const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
const pushHostAllowed = (url) => {
  if (process.env.PUSH_ALLOW_ANY_ENDPOINT === 'true') return true; // 仅用于测试
  try { return PUSH_HOSTS.some((re) => re.test(new URL(url).hostname)); } catch { return false; }
};

// 订阅列表里显示的设备名：浏览器 + 系统 (从订阅时的 User-Agent 看)
function deviceName(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? '安卓' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '未知系统';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : '浏览器';
  return `${os} · ${br}`;
}
const subId = (endpoint) => crypto.createHash('sha256').update(endpoint).digest('base64url').slice(0, 12);

module.exports = function createPush(app, { dataDir, subject }) {
  const KEY_FILE = path.join(dataDir, 'vapid.json');
  const SUB_FILE = path.join(dataDir, 'push.json');

  // VAPID 密钥首次启动时生成并保存，之后不变 (变了已订阅的设备会失效)
  let keys;
  try {
    keys = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
  } catch {
    keys = webpush.generateVAPIDKeys();
    fs.writeFileSync(KEY_FILE, JSON.stringify(keys), { mode: 0o600 });
  }
  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);

  const readSubs = () => {
    try { return JSON.parse(fs.readFileSync(SUB_FILE, 'utf8')); } catch { return []; }
  };
  const writeSubs = (list) => {
    const tmp = SUB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, SUB_FILE);
  };

  // endpoint：只发给这一台 (测试通知)，不写就发给所有开了通知的设备
  async function send(payload, endpoint) {
    const subs = readSubs().filter((s) => !endpoint || s.endpoint === endpoint);
    if (!subs.length) return 0;
    const body = JSON.stringify(payload);
    const dead = new Set();
    let ok = 0;
    await Promise.all(subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, body, { TTL: 3600, urgency: 'high', topic: payload.tag?.slice(0, 32) });
        ok++;
      } catch (e) {
        // 订阅已失效 (取消了通知权限 / 卸载了浏览器)；403 是订阅时用的推送密钥和现在的对不上
        // (data 目录重建过，vapid.json 变了)，这条订阅永远推不过去，也删掉，那台设备会显示未开启、重新开启即可
        if (e.statusCode === 404 || e.statusCode === 410 || e.statusCode === 403) dead.add(sub.endpoint);
        else console.warn('推送失败:', e.statusCode || '', e.message);
      }
    }));
    if (dead.size) writeSubs(readSubs().filter((s) => !dead.has(s.endpoint)));
    return ok;
  }

  app.get('/api/push/key', (req, res) => {
    res.json({ publicKey: keys.publicKey });
  });

  app.post('/api/push/subscribe', (req, res) => {
    const sub = req.body?.subscription;
    if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys) {
      return res.status(400).json({ error: '订阅信息无效' });
    }
    // 只允许官方推送服务，避免被用来让服务器向任意地址发请求
    if (!pushHostAllowed(sub.endpoint)) return res.status(400).json({ error: '不支持的推送服务地址' });
    const list = readSubs().filter((s) => s.endpoint !== sub.endpoint);
    list.push({ endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) },
      created: Date.now(), ua: String(req.headers['user-agent'] || '').slice(0, 200) });
    writeSubs(list.slice(-50));
    res.json({ ok: true });
  });

  // 所有开了通知的设备 (不返回推送地址和密钥)；self = 发请求的这台设备
  app.post('/api/push/subs', (req, res) => {
    const mine = String(req.body?.endpoint || '');
    res.json(readSubs().map((s) => ({ id: subId(s.endpoint), device: deviceName(s.ua), created: s.created || 0, self: !!mine && s.endpoint === mine })));
  });

  // 按推送地址 (这台设备关闭通知) 或列表里的 id (删掉别的设备) 取消订阅
  app.post('/api/push/unsubscribe', (req, res) => {
    const endpoint = String(req.body?.endpoint || ''), id = String(req.body?.id || '');
    writeSubs(readSubs().filter((s) => s.endpoint !== endpoint && (!id || subId(s.endpoint) !== id)));
    res.json({ ok: true });
  });

  // 测试通知只发给点按钮的这台 (endpoint)；老版本网页不传，就发给所有设备
  app.post('/api/push/test', async (req, res) => {
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
    const n = await send({ title: 'SSH-WEB 测试通知', body: '通知已开启，终端有提示音时会推送到这里', tag: 'test' }, endpoint);
    if (!n) return res.status(400).json({ error: endpoint ? '这台设备的订阅不在服务器上，或推送服务暂时不可用，请关闭后重新开启' : '没有可用的订阅，或推送服务暂时不可用' });
    res.json({ ok: true, sent: n });
  });

  return { send };
};
