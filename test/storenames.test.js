'use strict';
// 记着的标签名 (tab-names.json) 超过上限时丢哪条：按写入时间丢最久没写过的，刚写进来的一定留着
// (以前按命名时间丢：沿用对话以前起的名字时带着很早的命名时间，刚写进来就被丢掉)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ok } = require('./helpers');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-names-'));
const store = require('../lib/store');

for (let i = 0; i < 200; i++) store.saveTabName('conv', 'c' + i, '名字' + i, Date.now());
store.saveTabName('conv', 'old-name', '很早起的名字', 1000); // 命名时间很早，但刚写进来
const all = store.tabNamesOf('conv');
ok(Object.keys(all).length === 200, '最多记 200 条: ' + Object.keys(all).length);
ok(store.tabNameOf('conv', 'old-name') === '很早起的名字', '带着很早命名时间刚写进来的名字留着 (不按命名时间丢)');
ok(store.tabNameRec('conv', 'old-name').at === 1000, '命名时间照原样记着 (比谁的名字新还用它)');
ok(!all.c0 && all.c1 && all.c199, '丢的是最久没写过的那条 (第一条)');
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
process.exit();
