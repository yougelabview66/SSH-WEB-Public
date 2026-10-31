'use strict';
// 各 Agent 专属的内容，一个 Agent 一个文件 (加新的 Agent：在这里加一个文件、列进 IDS)。每个文件里按用到的地方分几节，没有的节不写：
//  - hooks：钩子装在哪、怎么装 (lib/hooks.js)
//  - events：钩子事件翻译成状态时它自己的规矩 (lib/session/hooks.js)
//  - sessions：会话历史在哪、怎么抽字段、怎么继续、删除时移走什么 (lib/agent-sessions.js)
// 网页上各 Agent 的不同处理在 public/app/09-agents.js。改一个 Agent 只动它自己的文件，不影响别的 (Claude Code 用着没问题，别跟着别的一起改)

const IDS = ['claude', 'grok', 'codex', 'gemini', 'antigravity', 'opencode']; // 钩子面板、会话历史里的顺序
const AGENT_LIST = IDS.map((id) => require(`./${id}`));
const byId = new Map(AGENT_LIST.map((a) => [a.id, a]));
const agentById = (id) => byId.get(id) || null;

module.exports = { AGENT_LIST, agentById };
