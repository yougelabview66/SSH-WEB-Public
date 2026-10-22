'use strict';
// 数据文件：DATA_DIR 下的 JSON (主机、已信任指纹、历史命令、收藏命令、界面设置)。
// 写入先写临时文件再改名，写到一半断电也不会把原文件弄坏；权限 600 (主机文件里有加密的凭据)
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

function jsonFile(name, empty, pretty = true) {
  const file = path.join(DATA_DIR, name);
  return {
    read() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return empty();
      }
    },
    write(value) {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}

const hosts = jsonFile('hosts.json', () => []);
const known = jsonFile('known_hosts.json', () => ({})); // 已信任主机指纹 (类似 OpenSSH 的 known_hosts)
const history = jsonFile('history.json', () => [], false); // 条数多，不排版
const favorites = jsonFile('favorites.json', () => []);
const settings = jsonFile('settings.json', () => ({})); // 界面设置 (手机按键栏等)，多台设备共享

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

module.exports = { hosts, known, history, favorites, settings, publicHost };
