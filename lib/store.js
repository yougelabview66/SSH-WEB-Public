'use strict';
// 数据文件：DATA_DIR 下的 JSON (主机、已信任指纹、历史命令、收藏命令、界面设置)。
// 写入先写临时文件再改名，写到一半断电也不会把原文件弄坏；权限 600 (主机文件里有加密的凭据)
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

// 读：文件不存在才算空的。文件坏了 (断电写了一半、被改坏) 先改名留着 (xxx.json.broken-时间)，再试上一次的备份 (xxx.json.bak)；
// 读不了 (权限、文件句柄用完) 抛错，不当成空的：不然下一次写入会把「空列表 + 新改动」整个覆盖上去，所有主机都没了。
// 写：先写临时文件、刷到磁盘再改名，原来的留一份 .bak
function jsonFile(name, empty, pretty = true) {
  const file = path.join(DATA_DIR, name);
  const bak = file + '.bak';
  const parse = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  return {
    read() {
      try {
        return parse(file);
      } catch (e) {
        if (e.code === 'ENOENT') return empty();
        if (!(e instanceof SyntaxError)) throw e;
        const broken = `${file}.broken-${Date.now()}`;
        try { fs.renameSync(file, broken); } catch {}
        console.error(`[数据文件] ${name} 坏了 (${e.message})，原文件留在 ${path.basename(broken)}`);
        try {
          const v = parse(bak);
          fs.copyFileSync(bak, file);
          console.error(`[数据文件] 已用上一次的备份 ${path.basename(bak)} 恢复`);
          return v;
        } catch {
          return empty();
        }
      }
    },
    write(value) {
      const tmp = file + '.tmp';
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeSync(fd, pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value));
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      try { if (fs.existsSync(file)) fs.copyFileSync(file, bak); } catch {}
      fs.renameSync(tmp, file);
    },
  };
}

const hosts = jsonFile('hosts.json', () => []);
const known = jsonFile('known_hosts.json', () => ({})); // 已信任主机指纹 (类似 OpenSSH 的 known_hosts)
const history = jsonFile('history.json', () => [], false); // 条数多，不排版
const favorites = jsonFile('favorites.json', () => []);
const settings = jsonFile('settings.json', () => ({})); // 界面设置 (手机按键栏等)，多台设备共享

// 标签命过的名 (记的是「主机名-」后面显示的部分)：daemon = 按常驻会话记 (重开主机接上这个会话时还原)，
// conv = 按对话记 (会话历史里「继续」时还原)。key 由调用方拼 (见 session/index.js 的 rename、session/daemon.js)
const tabNames = jsonFile('tab-names.json', () => ({ daemon: {}, conv: {} }), false);
const TAB_NAMES_MAX = 200; // 每类最多记这么多条，超了丢最久没更新的
function saveTabName(kind, key, title) {
  if (kind !== 'daemon' && kind !== 'conv') return;
  let d;
  try { d = tabNames.read(); } catch { return; }
  if (!d || typeof d !== 'object') d = { daemon: {}, conv: {} };
  const map = (d[kind] && typeof d[kind] === 'object') ? d[kind] : (d[kind] = {});
  map[key] = { title, at: Date.now() };
  const keys = Object.keys(map);
  if (keys.length > TAB_NAMES_MAX) {
    keys.sort((a, b) => map[a].at - map[b].at);
    for (const k of keys.slice(0, keys.length - TAB_NAMES_MAX)) delete map[k];
  }
  try { tabNames.write(d); } catch {}
}
function delTabName(kind, key) {
  if (kind !== 'daemon' && kind !== 'conv') return;
  try {
    const d = tabNames.read();
    if (d?.[kind]?.[key] !== undefined) { delete d[kind][key]; tabNames.write(d); }
  } catch {}
}
function tabNameOf(kind, key) {
  try { return tabNames.read()[kind]?.[key]?.title || ''; } catch { return ''; }
}

// 返回给前端时不包含任何密文
function publicHost(h) {
  return {
    id: h.id,
    name: h.name,
    host: h.host,
    port: h.port,
    username: h.username,
    authType: h.authType,
    connType: h.connType || 'direct',
    cfClientId: h.cfClientId || '',
    hasCfSecret: !!h.cfClientSecret,
    group: h.group || '',
    winDaemon: !!h.winDaemon,
    os: h.os || (h.isWin === true ? 'windows' : h.isWin === false ? 'other' : undefined), // 连过以后认出来的系统 (windows / linux / other，没连过是 undefined)
    order: typeof h.order === 'number' ? h.order : null, // 侧边栏自定义顺序 (未排序过为 null，按名称排)
    hasSecret: !!(h.password || h.privateKey),
  };
}

module.exports = { hosts, known, history, favorites, settings, publicHost, saveTabName, delTabName, tabNameOf };
