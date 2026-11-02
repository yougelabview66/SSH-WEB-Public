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

// ---- 网页：认这个标签里在跑哪个 Agent
const src = fs.readFileSync(path.join(__dirname, '../public/app/09-agents.js'), 'utf8');
const { agentIdOf } = vm.runInNewContext(src + '\n;({ agentIdOf })', { isTouch: false, send: () => {}, window: {}, document: {} });
// 假终端：lines 是屏幕上的每一行 (从上到下)，type 是 normal / alternate
const term = (lines, type = 'normal', agent = null) => ({ agent: agent && { id: agent }, term: { rows: lines.length, buffer: { active: { type, baseY: 0, getLine: (y) => ({ translateToString: () => lines[y] ?? '' }) } } } });
const pad = (n) => Array(n).fill('');
ok(agentIdOf(term(['┃ 问点什么', '', '  ctrl+p commands', ...pad(10)], 'alternate')) === 'opencode',
  '同一个终端开在两台设备上，这边屏幕底下空着好几行：跳过空行，还是认得出 OpenCode (以前只看最后 6 行，认不出就进不了历史画面)');
ok(agentIdOf(term(['$ ', ...pad(5)], 'normal', 'opencode')) === null,
  'OpenCode 退出了 (不报事件，钩子报的还停在它)：终端不在全屏 (备用屏幕) 就不算它在跑，shell 里往上滑看终端历史，不再显示 OpenCode 的旧对话');
ok(agentIdOf(term(['OpenCode 界面', ...pad(3)], 'alternate', 'opencode')) === 'opencode', 'OpenCode 还开着 (全屏)：照钩子报的认');
ok(agentIdOf(term(['❯ ', '  Ctrl+x:shortcuts'], 'normal', 'opencode')) === 'grok', '屏幕上明明白白是 Grok：屏幕优先');
ok(agentIdOf(term(['claude 界面'], 'normal', 'claude')) === 'claude', 'Claude Code 不全屏：照钩子报的认 (不受影响)');

// ---- 网页：取历史失败后的冷却按 Agent 记，换了 Agent 马上重试
const ls = fs.readFileSync(path.join(__dirname, '../public/app/55-local-scroll.js'), 'utf8');
ok(/s\.noTmuxUntil > Date\.now\(\) && s\.noTmuxAgent === agentIdOf\(s\)/.test(ls) && /s\.noTmuxAgent = agentIdOf\(s\)/.test(ls) && /'no-agent-history': 3000/.test(ls),
  '取历史失败后的冷却：换了 Agent 不算 (以前 30 秒到 5 分钟里换了 Agent 也不试)；Agent 自己的记录读不到 (还没说话) 只停 3 秒');
process.exit();
