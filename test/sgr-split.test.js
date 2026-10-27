'use strict';
// splitByCells：ANSI 颜色序列在终端里不占格，切行时必须跳过 (v1.83.40 修复)。
// 历史两种来源都带颜色：tmux capture-pane -e / 服务端 localHistory 的 lineToAnsi (每个颜色段写一次 \x1b[..m)。
// 历史视图按格数切行时 ANSI 不能算进格数，否则显示行数比原文多一截，复制面板定位会落到最后一行。
// 这里直接用 @xterm/headless 造一段带颜色的终端记录，跑 localHistory，再用网页里同一份 splitByCells 数行。
const { ok } = require('./helpers');
const { Terminal } = require('@xterm/headless');

// 从 public/app/55-local-scroll.js 里取 splitByCells 等实现 (和网页里跑的是同一份代码)
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app', '55-local-scroll.js'), 'utf8');
const ansiLine = src.slice(src.indexOf('  const ANSI_RE = '), src.indexOf('\n', src.indexOf('  const ANSI_RE = ')));
const a = src.indexOf('  function splitByCells(');
const b = src.indexOf('  // 按 gridFit 量出来的结果');
const mod = { exports: {} };
new Function('module', 'CellWidth', ansiLine + '\n' + src.slice(a, b) + '\nmodule.exports = { splitByCells, ANSI_RE, cellWidth };')(mod, require('../public/cellwidth'));
const { splitByCells, ANSI_RE, cellWidth } = mod.exports;

// 复刻 lib/session/remote.js 的 lineToAnsi (这里只关心「每段颜色都写 SGR」这个特性)
const { utils } = require('ssh2');
function lineToAnsi(line, cell) {
  let end = line.length;
  for (; end > 0; end--) { line.getCell(end - 1, cell); if ((cell.getChars() && cell.getChars() !== ' ') || !cell.isBgDefault()) break; }
  let out = '', prev = '';
  for (let x = 0; x < end; x++) {
    line.getCell(x, cell);
    if (!cell.getWidth()) continue;
    const sgr = `${cell.isBold() ? 1 : 0};${cell.isFgPalette() ? cell.getFgColor() : ''}`;
    if (sgr !== prev) { out += `\x1b[0${sgr}m`; prev = sgr; }
    out += cell.getChars() || ' ';
  }
  return prev ? out + '\x1b[0m' : out;
}

(async () => {
  const cols = 58;
  const t = new Terminal({ cols, rows: 30, allowProposedApi: true, scrollback: 5000 });
  let input = '';
  for (let i = 1; i <= 300; i++) {
    input += `\x1b[2m⏺\x1b[0m \x1b[1mRead\x1b[0m(\x1b[36m/vol1/1000/a/55-local-scroll.js\x1b[0m) \x1b[32m✔\x1b[0m READ${i}\r\n`;
    input += `\x1b[1m●\x1b[0m 我来看一下 \x1b[33msplitByCells\x1b[0m 这个函数 READ${i}\r\n`;
  }
  await new Promise((r) => t.write(input, r));
  const buf = t.buffer.active, cell = buf.getNullCell(), out = [];
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const text = lineToAnsi(line, cell);
    if (line.isWrapped && out.length) out[out.length - 1] += text; else out.push(text);
  }
  while (out.length && !out[out.length - 1]) out.pop();
  const data = out.join('\n') + '\n';
  ok((data.match(/\x1b\[/g) || []).length > out.length, `localHistory 的历史带 SGR 颜色 (${(data.match(/\x1b\[/g) || []).length} 处 / ${out.length} 行)`);

  // 显示侧：带颜色的原文按格数切；换算侧：去掉颜色的文本按格数切 —— 两边必须一样多
  const colored = data.replace(/\n+$/, '').split('\n');
  const plain = data.replace(ANSI_RE, '').replace(/\n+$/, '').split('\n');
  const nShown = colored.reduce((n, l) => n + splitByCells(l, cols).length, 0);
  const nCount = plain.reduce((n, l) => n + splitByCells(l, cols).length, 0);
  ok(nShown === nCount, `带色原文和去色文本切出一样多的行 (显示 ${nShown} / 换算 ${nCount})`);

  // 每一段都不能超宽 (超了浏览器会再折一次，行号又对不上)
  let widest = 0, broken = 0;
  for (const l of colored) for (const seg of splitByCells(l, cols)) {
    const w = [...seg.text.replace(ANSI_RE, '')].reduce((x, c) => x + cellWidth(c), 0);
    if (w > widest) widest = w;
    if (seg.text.replace(ANSI_RE, '').includes('\x1b')) broken++;
  }
  ok(widest <= cols, `每段都不超宽 (最宽 ${widest} 格 / ${cols} 格)`);
  ok(broken === 0, `ANSI 序列没有被切断 (${broken} 处)`);

  // 拼回去和原文一致 (一个字都不丢)
  const back = colored.map((l) => splitByCells(l, cols).map((s) => s.text).join('')).join('\n');
  ok(back === colored.join('\n'), '切完拼回去和原文一字不差');
  process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
