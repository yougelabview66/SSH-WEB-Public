'use strict';

// 浏览器传来的终端行列数：不是正数用默认值，最大 1000
function clampSize(v, def) {
  const n = parseInt(v, 10);
  return n > 0 ? Math.min(n, 1000) : def;
}

module.exports = { clampSize };
