'use strict';
// lib/cli-input.js：照着按键模拟终端 (Claude Code) 输入框里的内容，判断要不要锁定在终端
const { ok } = require('./helpers');
const { create } = require('../lib/cli-input');

const t = (name, keys, want, opt) => {
  const m = create();
  for (const k of keys) m.feed(k, opt);
  ok(m.locked() === want, `${name} → ${want ? '锁定' : '不锁定'} ${JSON.stringify(m.get())}`);
};

// 打字 / 删除 / 发送
t('打字', ['hello'], true);
t('打字后回车发送', ['hello', '\r'], false);
t('退格删光', ['ab', '\x7f', '\x7f'], false);
t('中文退格删光', ['你好', '\x7f', '\x7f'], false);
t('emoji 退格删光', ['a😀', '\x7f', '\x7f'], false);
t('Ctrl+W 删两个词', ['hello you', '\x17', '\x17'], false);
t('Alt+退格删词', ['hello', '\x1b\x7f'], false);
t('Ctrl+退格删词', ['hello', '\b'], false);
t('左移后 Delete 删光', ['ab', '\x1b[D', '\x1b[D', '\x1b[3~', '\x1b[3~'], false);
t('Home 后 Ctrl+K', ['hello', '\x1b[H', '\x0b'], false);
t('Ctrl+U', ['hello', '\x15'], false);
t('中间删一个还有字', ['abc', '\x1b[D', '\x7f'], true);
t('Ctrl+J 换行后删光', ['a', '\n', 'b', '\x7f', '\x7f', '\x7f'], false);
t('Ctrl+C', ['abc', '\x03'], false);
t('Ctrl+L', ['abc', '\x0c'], false);
t('粘贴', ['\x1b[200~line1\rline2\x1b[201~'], true);
// 不是打字的输入
t('鼠标点击 (新式 / 老式报告) 不算', ['\x1b[<0;10;5M\x1b[<0;10;5m', '\x1b[M !&'], false);
t('焦点进出不算', ['\x1b[I', '\x1b[O'], false);
t('空闲时单独按 Esc 不影响', ['abc', '\x1b'], true);
t('空闲时空输入框按 Esc 不锁定', ['\x1b'], false);
// 不知道内容变成了什么：当作有字
t('↑ 翻出历史', ['\x1b[A'], true);
t('↑ 翻出历史后回车', ['\x1b[A', '\r'], false);
t('→ 采用推荐文字', ['\x1b[C'], true);
t('空的时候按 Tab (填入推荐文字)', ['\t'], true);
t('有字时按 Tab 补全', ['ab', '\t'], true);
t('Tab 后 Ctrl+U', ['\t', '\x15'], false);
// Claude Code 运行中按 Esc 打断：可能把刚发的话放回输入框
t('运行中按 Esc 打断', ['\x1b'], true, { running: true });
t('运行中按 Esc 后 Ctrl+U', ['\x1b', '\x15'], false, { running: true });
// Ctrl+R 搜索历史
t('Ctrl+R 搜索中', ['\x12', 'git'], true);
t('Ctrl+R 搜索后按 Esc 选中 (放进输入框)', ['\x12', 'git', '\x1b'], true);
t('Ctrl+R 搜索后按 Tab 选中', ['\x12', 'git', '\t'], true);
t('Ctrl+R 搜索后按回车 (直接发送)', ['\x12', 'git', '\r'], false);
t('空输入框 Ctrl+R 后 Ctrl+C 取消', ['\x12', 'git', '\x03'], false);
t('有字时 Ctrl+R 后 Ctrl+C 取消 (恢复原来的字)', ['abc', '\x12', 'git', '\x03'], true);
t('Ctrl+R 搜索时粘贴不进输入框，取消后还是空的', ['\x12', '\x1b[200~xyz\x1b[201~', '\x03'], false);
// @ 文件 / / 命令候选列表
t('@ 文件列表里按回车 (选中文件，没发送)', ['look at @src/ma', '\r'], true);
t('选中文件后再回车发送', ['look at @src/ma', '\r', ' ok', '\r'], false);
t('/ 命令按回车 (执行)', ['/compact', '\r'], false);
t('邮箱里的 @ 不算文件列表', ['mail a@b.com now', '\r'], false);

// tmux 前缀键 Ctrl+B：后面那个键是给 tmux 的，不算打字
t('Ctrl+B D (tmux 断开) 不算打字', ['\x02', 'd'], false);
t('Ctrl+B 和 D 在同一段里', ['\x02d'], false);
t('Ctrl+B 方向键 (tmux 切分屏) 不是翻历史', ['\x02', '\x1b[A'], false);
t('Ctrl+B 后先来焦点报告，再按 C', ['\x02', '\x1b[I', 'c'], false);
t('Ctrl+B C 之后正常打字', ['\x02', 'c', 'hi'], true);
t('有字时按 Ctrl+B D，字还在', ['abc', '\x02', 'd'], true);

// 服务器同步过来的状态能原样还原 (包括搜索中)
const a = create(); a.feed('abc'); a.feed('\x12');
const b = create(); b.set(JSON.parse(JSON.stringify(a.get())));
b.feed('\x03');
ok(b.locked() && b.get().text === 'abc', '服务器同步过来的状态 (搜索中) 能还原，取消搜索后恢复原来的字');
process.exit();
