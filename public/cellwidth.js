// 一个字在终端里占几格：网页里的终端、服务器上的无界面终端、历史视图共用这一份 (服务器端 require，网页里 <script> 加载成 CellWidth)。
// 同 tmux / Claude Code / Windows 的 ConPTY：中日韩文字、全角符号、emoji (✅ ❌ 🔥 这类) 两格，组合用的附加符号不占格。
// xterm 默认按 Unicode 6 算，✅ 这类只占一格，程序按两格补的空格就多出一格 —— 表格里带表情的行右边框往里缩一格，
// 历史视图又按两格画，两边还对不上。⚠️ 这种「一格的字 + FE0F」不额外加宽：tmux 3.4 起自己把它当两格，
// 但发给终端时在后面补一个空格子 (终端当一格画正好对齐)，终端再加宽反而多出一格
(function (root) {
  'use strict';
  const WIDE = [[0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
    [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
    [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
    [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
    [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
    [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e],
    [0x3041, 0x4dbf], [0x4e00, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19],
    [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4], [0x17000, 0x18aff], [0x1b000, 0x1b2ff],
    [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f251],
    [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb], [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd]];
  const ZERO_RE = /[\u0300-\u036f\u0483-\u0489\u0591-\u05bd\u0610-\u061a\u064b-\u065f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u20d0-\u20ff\ufe00-\ufe0f\ufe20-\ufe2f\u{1f3fb}-\u{1f3ff}\u{e0100}-\u{e01ef}]/u;

  function cellWidth(c) {
    const cp = c.codePointAt(0);
    if (cp < 0x300) return 1;
    if (ZERO_RE.test(c)) return 0;
    let lo = 0, hi = WIDE.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cp < WIDE[mid][0]) hi = mid - 1;
      else if (cp > WIDE[mid][1]) lo = mid + 1;
      else return 2;
    }
    return 1;
  }

  // 给 xterm 用的宽度规则 (同 xterm 自带的 Unicode 6 规则的写法，只换了宽度表)。
  // charProperties 的返回值：第 0 位 = 和前一个字拼在一起，第 1-2 位 = 宽度 (xterm 内部 UnicodeService 的格式)
  const provider = {
    version: 'sshweb',
    wcwidth(cp) {
      if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
      return cellWidth(String.fromCodePoint(cp));
    },
    charProperties(cp, preceding) {
      let w = this.wcwidth(cp), join = w === 0 && preceding !== 0;
      if (join) {
        const pw = (preceding >> 1) & 3;
        if (pw === 0) join = false;
        else if (pw > w) w = pw;
      }
      return (w << 1) | (join ? 1 : 0);
    },
  };
  // 终端改用这份规则 (要 allowProposedApi)
  function useCellWidth(term) {
    term.unicode.register(provider);
    term.unicode.activeVersion = provider.version;
  }

  const api = { cellWidth, useCellWidth };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CellWidth = api;
})(this);
