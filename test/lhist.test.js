'use strict';
// 常驻会话的历史 (服务器上无界面终端的记录，见 lib/session/remote.js 的 localHistory)：折成几段的长行拼回去时不能去掉中间的空白。
// Claude Code 画表格不写空格，用 \x1b[nG 跳列，跳过的是空格子；宽终端里画的表格，手机接管 (终端变窄) 后一行折成几段，
// 折点落在空格子里 —— 以前每段都去掉末尾空白再拼，表格行的右边框紧跟在内容后面，横线还是原来的长度 (整张表乱掉)
const { ok } = require('./helpers');
const { Terminal } = require('@xterm/headless');
const { useCellWidth, cellWidth } = require('../public/cellwidth');
const SessionRemote = require('../lib/session/remote');

const write = (t, s) => new Promise((r) => t.write(s, r));
const cells = (s) => [...s.replace(/\x1b\[[0-9;]*m/g, '')].reduce((n, c) => n + cellWidth(c), 0);
const history = (t) => SessionRemote.prototype.localHistory.call({ term: t }, 1000).data.split('\n').filter((x) => x.trim());

(async () => {
  const W = 118;
  const row = (a, b) => `  │\x1b[5G${a}\x1b[46G│\x1b[48G${b}\x1b[${W}G│\r\n`;
  const table = `  ┌${'─'.repeat(42)}┬${'─'.repeat(W - 47)}┐\r\n` + row('容器内 package.json', '1.83.50')
    + row('55-local-scroll.js', '与 git show HEAD: 的 md5 全一致') + row('代理补丁', '\x1b[1m工作区 8 处\x1b[22m、仓库 0 处；config.js 的 SSH_PROXY 在')
    + `  └${'─'.repeat(42)}┴${'─'.repeat(W - 47)}┘\r\n`;
  const t = new Terminal({ cols: W, rows: 20, allowProposedApi: true, scrollback: 1000 });
  useCellWidth(t);
  await write(t, table);
  let h = history(t);
  ok(h.length === 5 && h.every((x) => cells(x) === W), `宽终端里：表格每行 ${W} 格 (${h.map(cells).join(' ')})`);

  t.resize(57, 20); // 手机接管，终端变窄：表格每行折成三段
  h = history(t);
  ok(h.length === 5 && h.every((x) => cells(x) === W), `终端变窄后取历史：折开的行拼回去，表格每行还是 ${W} 格、右边框对齐 (${h.map(cells).join(' ')})`);
  ok(h[1].includes('1.83.50' + ' '.repeat(10)), '表格行里的空白没被吃掉');

  // 宽字在行尾放不下、折到下一行开头：上一行最后那个空格子不算 (不多出一个空格)
  const u = new Terminal({ cols: 20, rows: 5, allowProposedApi: true });
  useCellWidth(u);
  await write(u, 'a'.repeat(19) + '中文\r\n');
  const l = history(u)[0];
  ok(l === 'a'.repeat(19) + '中文', `宽字放不下折到下一行：拼回去不多出空格 (${JSON.stringify(l)})`);
})();
