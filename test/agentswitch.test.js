'use strict';
// 一个标签里换着开不同的 Agent：历史视图要认得出现在是谁、拿对的对话号去读 (2026-11-02 真机上切几次就进不了历史画面)。
// 不用开浏览器：服务端直接调模块，网页的 09-agents.js 放进沙箱里跑 (真实的端到端切换见会话临时目录里的 switch.js)
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ok } = require('./helpers');
const SessionHooks = require('../lib/session/hooks');

// ---- 服务端：读历史用的对话号只给同一个 Agent 的
const sid = (hookSid, agent, daemon = () => '') => SessionHooks.prototype.agentSid.call({ hookSid, daemonAgentSid: daemon }, agent);
ok(sid({ id: 'g1', agent: 'grok' }, 'grok') === 'g1', '钩子报的对话号是这个 Agent 的：照用');
ok(sid({ id: 'g1', agent: 'grok' }, 'opencode') === '', '换成了别的 Agent (还没报事件)：不拿上一个 Agent 的对话号去读 (OpenCode 按它查不到就失败)');
ok(sid({ id: 'old' }, 'opencode') === 'old', '旧记录不知道是谁的：照旧用');
ok(sid(null, 'pi', (a) => (a === 'pi' ? 'p1' : '')) === 'p1' && sid(null, 'pi', (a) => (a === 'grok' ? 'g' : '')) === '', '标签刚接上常驻会话：用会话记着的、同一个 Agent 的对话号');

// ---- 服务端：退出时不报事件的 Agent (Codex / Antigravity / OpenCode)，回到 shell 提示符就当退出了
const fakeSess = (agent, lines, type = 'normal', extra = {}) => {
  const calls = [];
  const s = { hookAgent: agent, hook: { kind: 'done' }, hookSid: { id: 'x', agent }, termPending: 0, freshAgentCwd: () => false,
    term: { rows: lines.length, buffer: { active: { type, baseY: 0, cursorY: lines.length - 1, getLine: (y) => ({ translateToString: () => lines[y] ?? '' }) } } },
    promptShell: () => null, noteDaemonAgent: (i) => calls.push(['note', i]), setAgentCwd: (d) => calls.push(['cwd', d]), updateState: () => calls.push(['state']),
    setHookAgent(a) { this.hookAgent = a; calls.push(['agent', a]); }, ...extra };
  SessionHooks.prototype.checkAgentGone.call(s);
  return { gone: s.hookAgent === '' && s.hookSid === null && s.hook === null, calls };
};
ok(fakeSess('codex', ['Disconnected from this task.', 'root@host:~/proj# ']).gone, 'Codex 退出了 (不报事件)：光标那行是 shell 提示符 → 当它退出了，不再当它在跑');
ok(!fakeSess('codex', ['› 问点什么', '', '  gpt-5.6 · 80% context left']).gone, 'Codex 还开着 (光标在它的输入行 ›、下面是状态行)：不动');
ok(!fakeSess('opencode', ['root@host:~# '], 'alternate').gone, 'OpenCode 全屏界面还在 (备用屏幕)：不动');
ok(!fakeSess('claude', ['root@host:~# ']).gone && !fakeSess('pi', ['root@host:~# ']).gone, 'Claude Code、Pi 退出时自己报事件：不用猜，不动');
// Windows 主机：终端 (ConPTY) 不转出备用画面，OpenCode 开着也是普通画面；只认 PS C:\x> / C:\x> 这种提示符
const win = (line) => ({ shellOf: { base: 'powershell' }, promptShell: () => (/^PS [A-Za-z]:\\[^>]*>/.test(line) ? 'powershell' : /^[A-Za-z]:\\[^>]*>/.test(line) ? 'cmd' : null) });
ok(!fakeSess('opencode', ['  Build  deepseek', '  ┃ 问点什么 >'], 'normal', win('  ┃ 问点什么 >')).gone,
  'Windows 上 OpenCode 开着 (普通画面，光标那行以 > 结尾)：不当成 shell 提示符，不算退出');
ok(fakeSess('opencode', ['PS C:\\Users\\me> '], 'normal', win('PS C:\\Users\\me>')).gone, 'Windows 上回到 PowerShell 提示符：当 OpenCode 退出了');
ok(!fakeSess('opencode', ["PS C:\\Users\\me> cd 'C:\\p'; opencode --session ses_1"], 'normal', { ...win('PS C:\\Users\\me>'), agentStartAt: Date.now() }).gone,
  '「继续」刚发出恢复命令 (OpenCode 还没画出界面，光标那行还是带命令的提示符)：20 秒内不算退出');
const { atShellPrompt } = require('../lib/agent-sessions');
const cur = (line, extra = {}) => ({ term: { rows: 1, buffer: { active: { baseY: 0, cursorY: 0, getLine: () => ({ translateToString: () => line }) } } }, promptShell: () => null, ...extra });
ok(atShellPrompt(cur('root@host:~# ')) && atShellPrompt(cur('  ask >')) && !atShellPrompt(cur('  ask >', { shellOf: { base: 'powershell' } })),
  '提示符：Linux 上以 $ # > 等结尾就算；Windows 上只认 PS C:\\x> / C:\\x> (Agent 界面里以 > 结尾的行不算)');

// Windows 上光标还在 shell 报目录 (OSC 9;9) 时那一行：停在提示符上 (自己配置的提示符也认得)；画了界面光标到了别的行就不是
const rowSess = (cursorY, promptRow) => ({ ...cur('❯ '), shellOf: { base: 'powershell' }, promptRow, term: { rows: 30, buffer: { active: { type: 'normal', baseY: 0, cursorY, getLine: () => ({ translateToString: () => '❯ ' }) } } } });
ok(atShellPrompt(rowSess(5, 5)) && !atShellPrompt(rowSess(20, 5)) && !atShellPrompt(rowSess(5, null)),
  'Windows：光标还在报目录时那一行 = 停在提示符上 (自定义提示符也行)；光标去了别的行 (程序画了界面) 不是');

// 「继续」：Windows 上 OpenCode 开着、钩子没报、手机上屏幕也认不出它 —— 先退出它，等提示符出来再发命令 (以前直接发，打进了 OpenCode 的输入框)
(async () => {
  const { resumeInTerminal } = require('../lib/agent-sessions');
  let lines = ['  Build  deepseek-v4.1-flash', '', '  ┃ 问点什么'], cy = 2;
  const writes = [];
  const sess = { hook: null, hookSid: null, shellOf: { base: 'powershell' }, promptRow: 0, outAt: 0, termPending: 0,
    term: { rows: 3, buffer: { active: { type: 'normal', baseY: 0, viewportY: 0, get cursorY() { return cy; }, getLine: (y) => ({ translateToString: () => lines[y] ?? '' }) } } },
    promptShell() { return /^PS [A-Za-z]:\\[^>]*>/.test(lines[cy]) ? 'powershell' : null; },
    write(k) { writes.push(k); if (k === '\x03' && writes.filter((x) => x === '\x03').length === 2) { lines = ['PS C:\\Users\\me> ', '', '']; cy = 0; this.promptRow = 0; this.outAt = Date.now() - 1000; } },
    noteDaemonAgent() {}, setAgentCwd() {}, setHookAgent() {} };
  const r = await resumeInTerminal(sess, 'pi --session abc', '', '', '', 'pi');
  ok(r.quit === true && writes[0] === '\x03' && writes.at(-1) === 'pi --session abc\r' && writes.filter((x) => x.includes('pi --session')).length === 1,
    '「继续」：Windows 上停在 OpenCode 界面 (钩子没报、屏幕认不出)：先按 Ctrl+C 退出，回到 PS 提示符才发命令: ' + JSON.stringify(writes));
})().then(() => {

// ---- 网页：认这个标签里在跑哪个 Agent
const src = fs.readFileSync(path.join(__dirname, '../public/app/09-agents.js'), 'utf8');
const { agentIdOf } = vm.runInNewContext(src + '\n;({ agentIdOf })', { isTouch: false, send: () => {}, window: {}, document: {} });
// 假终端：lines 是屏幕上的每一行 (从上到下)，type 是 normal / alternate
const term = (lines, type = 'normal', agent = null, altSeen = true) => ({ agent: agent && { id: agent }, altSeen, term: { rows: lines.length, buffer: { active: { type, baseY: 0, getLine: (y) => ({ translateToString: () => lines[y] ?? '' }) } } } });
const pad = (n) => Array(n).fill('');
ok(agentIdOf(term(['┃ 问点什么', '', '  ctrl+p commands', ...pad(10)], 'alternate')) === 'opencode',
  '同一个终端开在两台设备上，这边屏幕底下空着好几行：跳过空行，还是认得出 OpenCode (以前只看最后 6 行，认不出就进不了历史画面)');
ok(agentIdOf(term(['$ ', ...pad(5)], 'normal', 'opencode')) === null,
  'OpenCode 退出了 (不报事件，钩子报的还停在它)：终端不在全屏 (备用屏幕) 就不算它在跑，shell 里往上滑看终端历史，不再显示 OpenCode 的旧对话');
ok(agentIdOf(term(['OpenCode 界面', ...pad(3)], 'alternate', 'opencode')) === 'opencode', 'OpenCode 还开着 (全屏)：照钩子报的认');
ok(agentIdOf(term(['  ┃ 问点什么', '  Build · deepseek'], 'normal', 'opencode', false)) === 'opencode',
  'Windows 主机 (这个标签从没进过备用画面)：OpenCode 开着也是普通画面，照钩子报的认 (以前当成已退出，进不了历史画面)');
ok(agentIdOf(term(['❯ ', '  Ctrl+x:shortcuts'], 'normal', 'opencode')) === 'grok', '屏幕上明明白白是 Grok：屏幕优先');
ok(agentIdOf(term(['claude 界面'], 'normal', 'claude')) === 'claude', 'Claude Code 不全屏：照钩子报的认 (不受影响)');

// ---- 网页：取历史失败后的冷却按 Agent 记，换了 Agent 马上重试
const ls = fs.readFileSync(path.join(__dirname, '../public/app/55-local-scroll.js'), 'utf8');
ok(/s\.noTmuxUntil > Date\.now\(\) && s\.noTmuxAgent === agentIdOf\(s\)/.test(ls) && /s\.noTmuxAgent = agentIdOf\(s\)/.test(ls) && /'no-agent-history': 3000/.test(ls),
  '取历史失败后的冷却：换了 Agent 不算 (以前 30 秒到 5 分钟里换了 Agent 也不试)；Agent 自己的记录读不到 (还没说话) 只停 3 秒');
process.exit();
});
