'use strict';
// Agent 会话记录排成带颜色的文字 (历史视图里显示完整对话的 Agent 共用：Grok、OpenCode)：颜色、竖线、Markdown (粗体、代码、标题、列表、表格)
const { cellWidth } = require('../../public/cellwidth');

const C = { bold: '\x1b[1m', dim: '\x1b[2m', cyan: '\x1b[36m', mag: '\x1b[35m', off: '\x1b[0m', boldOff: '\x1b[22m', fgOff: '\x1b[39m' };
// 工具输出、代码块左边的竖线：用框线字符 │ (暗色)，这样长行照样放进能左右滑的条带 (见 public/app/54-grid-view.js 的 block)，不折行
const BAR = '\x1b[2m│\x1b[22m';
const width = (t) => [...String(t)].reduce((n, ch) => n + cellWidth(ch), 0);
const pad = (t, w) => t + ' '.repeat(Math.max(0, w - width(t)));
// 一行里的 Markdown：**粗体**、`代码`
const inline = (t) => t.replace(/\*\*([^*]+)\*\*/g, `${C.bold}$1${C.boldOff}`).replace(/`([^`]+)`/g, `${C.cyan}$1${C.fgOff}`);
const plain = (t) => t.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
// Markdown 表格 (| a | b | 下面一行 |---|---|) → 带框线的表格，按格数对齐 (中文占两格)
function table(rows) {
  const cells = rows.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r)).map((r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => plain(c.trim())));
  const n = Math.max(...cells.map((r) => r.length));
  const w = Array.from({ length: n }, (_, i) => Math.max(...cells.map((r) => width(r[i] || ''))));
  const line = (l, m, r) => `${C.dim}${l}${w.map((x) => '─'.repeat(x + 2)).join(m)}${r}${C.off}`;
  const row = (r, head) => `${C.dim}│${C.off}` + w.map((x, i) => ` ${head ? C.bold : ''}${pad(r[i] || '', x)}${head ? C.boldOff : ''} ${C.dim}│${C.off}`).join('');
  return [line('┌', '┬', '┐'), row(cells[0], true), line('├', '┼', '┤'), ...cells.slice(1).map((r) => row(r)), line('└', '┴', '┘')];
}
function markdown(text) {
  const out = [], lines = text.split('\n');
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*```/.test(l)) { fence = !fence; continue; }
    if (fence) { out.push(`${BAR} ${C.cyan}${l}${C.off}`); continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) { // 表格：连续的 | … | 行
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      i--;
      out.push(...table(rows));
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) { out.push(`${C.bold}${C.mag}${plain(h[2])}${C.off}`); continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { out.push(`${C.dim}${'─'.repeat(20)}${C.off}`); continue; }
    out.push(inline(l.replace(/^(\s*)[-*]\s+/, '$1• ')));
  }
  return out;
}
module.exports = { C, BAR, markdown };
