'use strict';
// 数据文件：DATA_DIR 下的 JSON (主机、已信任指纹、历史命令、收藏命令、界面设置)。
// 写入先写临时文件再改名，写到一半断电也不会把原文件弄坏；权限 600 (主机文件里有加密的凭据)
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

// 读：文件不存在才算空的。文件坏了 (断电写了一半、被改坏) 先改名留着 (xxx.json.broken-时间)，再试上一次的备份 (xxx.json.bak)；
// 读不了 (权限、文件句柄用完) 抛错，不当成空的：不然下一次写入会把「空列表 + 新改动」整个覆盖上去，所有主机都没了。
// 写：先写临时文件、刷到磁盘再改名，原来的留一份 .bak
// sync：写完要不要 fsync 刷到磁盘 (默认要)。history.json 每条命令都写一次，在机械盘上 fsync + 复制备份
// 会让事件循环阻塞几十毫秒、拖慢所有终端的输出；它只是命令历史，丢了不影响功能 (写还是原子的 rename，崩了最多退回上一次的内容)
function jsonFile(name, empty, pretty = true, { sync = true } = {}) {
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
        if (sync) fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      // 留一份上一次的 .bak (读坏了时恢复用)；不 fsync 的 (history.json) 也不复制，见上面 sync 的说明
      if (sync) try { if (fs.existsSync(file)) fs.copyFileSync(file, bak); } catch {}
      fs.renameSync(tmp, file);
    },
  };
}

const hosts = jsonFile('hosts.json', () => []);
const known = jsonFile('known_hosts.json', () => ({})); // 已信任主机指纹 (类似 OpenSSH 的 known_hosts)
const history = jsonFile('history.json', () => [], false, { sync: false }); // 条数多，不排版；每条命令都写，不 fsync (见上面)
const favorites = jsonFile('favorites.json', () => []);
const settings = jsonFile('settings.json', () => ({})); // 界面设置 (手机按键栏等)，多台设备共享

// 标签命过的名 (记的是「主机名-」后面显示的部分)：conv = 按对话记 (会话历史里「继续」时还原)。
// daemon 的条目升级成了常驻会话的信息卡：title = 命名标签的后缀，name = Agent 的会话名称，
// msg = 最新一次对话内容，cwd = Agent 干活的目录 (同项目文件用的) —— 选择框里显示、重启后还在
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
// 常驻会话的信息：patch 里有的字段才改，全空了就删掉这条
function saveDaemonInfo(key, patch) {
  let d;
  try { d = tabNames.read(); } catch { return; }
  if (!d || typeof d !== 'object') d = { daemon: {}, conv: {} };
  if (!d.daemon || typeof d.daemon !== 'object') d.daemon = {};
  const next = { ...d.daemon[key], ...patch, at: Date.now() };
  // sid 也要算「有内容」：钩子有时只单独报一个 session_id (见 session/hooks.js 的 noteDaemonAgent)，
  // 以前条件里没有 sid，这种只带 sid 的 patch 会把刚写进去的记录整条删掉 —— 服务重启后按对话 id 读标题就查不到了
  if (next.title || next.name || next.msg || next.cwd || next.sid) d.daemon[key] = next;
  else delete d.daemon[key];
  const keys = Object.keys(d.daemon);
  if (keys.length > TAB_NAMES_MAX) {
    keys.sort((a, b) => d.daemon[a].at - d.daemon[b].at);
    for (const k of keys.slice(0, keys.length - TAB_NAMES_MAX)) delete d.daemon[k];
  }
  try { tabNames.write(d); } catch {}
}
function daemonInfo(key) {
  try { return tabNames.read().daemon?.[key] || null; } catch { return null; }
}
// 整张表一次读出来：要按一批会话号查的时候用这个，别在循环里一个个调 daemonInfo()
// (那个每次都同步读整个文件 + JSON.parse)。调用方自己按 key 取，取不到当空
function daemonInfos() {
  try { const d = tabNames.read().daemon; return d && typeof d === 'object' ? d : {}; } catch { return {}; }
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

module.exports = { hosts, known, history, favorites, settings, publicHost, saveTabName, saveDaemonInfo, daemonInfo, daemonInfos, delTabName, tabNameOf };
