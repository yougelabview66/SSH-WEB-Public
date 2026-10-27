'use strict';
// public/cellwidth.js：网页里的终端和服务器上的无界面终端按同一份规则算字宽 —— ✅ 这类表情两格 (同 tmux / Claude Code)。
// xterm 默认按 Unicode 6 算成一格，程序按两格补的空格就多出一格，表格里带表情的行右边框往里缩一格 (实时画面和历史都歪)
const { ok } = require('./helpers');
const { Terminal } = require('@xterm/headless');
const { cellWidth, useCellWidth } = require('../public/cellwidth');
const { dropVs16Pad } = require('../lib/session/remote');

const write = (t, s) => new Promise((r) => t.write(s, r));
const term = () => { const t = new Terminal({ cols: 40, rows: 10, allowProposedApi: true }); useCellWidth(t); return t; };
// 每行右边框在第几格
const borders = (t, n) => [...Array(n).keys()].map((y) => {
  const l = t.buffer.active.getLine(y), c = t.buffer.active.getNullCell();
  for (let x = l.length - 1; x >= 0; x--) { l.getCell(x, c); if (/[│┐┘]/.test(c.getChars())) return x; }
  return -1;
});

(async () => {
  ok(cellWidth('✅') === 2 && cellWidth('🔥') === 2 && cellWidth('中') === 2 && cellWidth('⚠') === 1 && cellWidth('️') === 0 && cellWidth('a') === 1, '宽度表：✅ 🔥 中文两格，⚠ 一格，FE0F 不占格');

  // tmux 3.4 发给终端的原样输出 (表格是程序按 ✅ / ⚠️ 两格补的空格)：tmux 画在备用屏幕上，⚠️ 后面它自己补了一个空格子 (ECH + CUF)，
  // 终端这里 ⚠️ 不能再加宽
  const tmux = '\x1b[H┌──────────┬────────────┐\x1b[K\r\n│ CPU      │ 53°C ✅    │\x1b[K\r\n│ 磁盘     │ 82% ⚠️\x1b[1X\x1b[C     │\x1b[K\r\n│ plain    │ ok         │\x1b[K\r\n└──────────┴────────────┘\x1b[K\r\n';
  let t = term();
  await write(t, '\x1b[?1049h' + tmux);
  let b = borders(t, 5);
  ok(t.buffer.active.type === 'alternate' && b.every((x) => x === 24), `tmux 里的表格 (备用屏幕)：每行右边框都在第 24 格 (${b.join(' ')})`);
  const c = t.buffer.active.getLine(1).getCell(18);
  ok(c.getChars() === '✅' && c.getWidth() === 2, `✅ 占两格 (宽 ${c.getWidth()})`);

  // 直接输出 (没开 tmux，普通屏幕)：Claude Code 按 ✅、⚠️ 都两格补的空格，两行都对齐 (以前 ⚠️ 只算一格，右边框缩进去一格)
  const direct = '┌──────────┬────────────┐\r\n│ CPU      │ 53°C ✅    │\r\n│ 磁盘     │ 82% ⚠️     │\r\n│ 检查     │ 通过 ✔️    │\r\n└──────────┴────────────┘\r\n';
  t = term();
  await write(t, direct);
  b = borders(t, 5);
  ok(b.every((x) => x === 24), `直接输出的表格 (普通屏幕)：带 ✅ ⚠️ ✔️ 的行右边框都对齐 (${b.join(' ')})`);

  // tmux 抓的历史：⚠️ 后面补的空格子去掉 (中间夹着颜色也行)；✅️ 这种本来就两格的、后面不是空格的不动
  ok(dropVs16Pad('82% ⚠\ufe0f      │') === '82% ⚠\ufe0f     │', '抓的历史：⚠️ 后面补的空格去掉一个');
  ok(dropVs16Pad('\x1b[1m⚠\ufe0f\x1b[22m 偏满') === '\x1b[1m⚠\ufe0f\x1b[22m偏满', '中间夹着颜色也去掉');
  ok(dropVs16Pad('✅\ufe0f  x') === '✅\ufe0f  x' && dropVs16Pad('⚠\ufe0fx') === '⚠\ufe0fx', '本来就两格的 / 后面不是空格的不动');

  // 不用这份规则 (xterm 默认) 就是原来的样子：✅ 那行缩进去一格 —— 证明上面的断言测到了
  const raw = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
  await write(raw, '\x1b[?1049h' + tmux);
  b = borders(raw, 5);
  ok(b[1] === 23, `对照：xterm 默认规则下 ✅ 那行右边框缩进去一格 (${b.join(' ')})`);
})();
