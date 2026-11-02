'use strict';
// 各 Agent 专属的内容，一个 Agent 一个文件 (加新的 Agent：在这里加一个文件、列进 IDS)。每个文件里按用到的地方分几节，没有的节不写：
//  - hooks：钩子装在哪、怎么装 (lib/hooks.js)
//  - events：钩子事件翻译成状态时它自己的规矩 (lib/session/hooks.js)
//  - sessions：会话历史在哪、怎么抽字段、怎么继续、删除时移走什么 (lib/agent-sessions.js)
// 网页上各 Agent 的不同处理在 public/app/09-agents.js。改一个 Agent 只动它自己的文件，不影响别的 (Claude Code 用着没问题，别跟着别的一起改)

const IDS = ['claude', 'grok', 'codex', 'antigravity', 'opencode', 'pi']; // 钩子面板、会话历史里的顺序
const AGENT_LIST = IDS.map((id) => require(`./${id}`));
const byId = new Map(AGENT_LIST.map((a) => [a.id, a]));
const agentById = (id) => byId.get(id) || null;
// 常驻会话选择框里的会话名称：钩子记的是「简称：内容」。有文字图标的 Agent 换成图标 (「Claude：改代码」→「✳ 改代码」)；
// 有标志的 (logo，网页上画 SVG) 去掉「Grok：」，另外告诉网页是哪个 Agent (agent)
function agentLabel(name) {
  const a = AGENT_LIST.find((x) => (x.icon || x.logo) && name.startsWith(`${x.short}：`));
  if (!a) return { name, agent: '' };
  const rest = name.slice(a.short.length + 1);
  return a.logo ? { name: rest, agent: a.id } : { name: `${a.icon} ${rest}`, agent: '' };
}

// 各 Agent 的进程名 (各自的 proc)：主机上找 Agent 进程用 (项目目录、常驻会话里有没有 Agent、会话占用)。
// 用 node / bun 跑的也认 (第二个词是这些名字，或者是它们安装目录里的 cli.js 之类)
const AGENT_PROCS = AGENT_LIST.flatMap((a) => a.proc || []);
// sh 的 case 写法：程序名本身 / node 跑的脚本名 / 安装目录 (命令行第二个词里的路径)
const procCase = { names: AGENT_PROCS.join('|'), scripts: AGENT_PROCS.map((n) => `${n}|${n}.*`).join('|'), dirs: AGENT_PROCS.map((n) => (n === 'pi' ? '*/pi-coding-agent/*' : `*/${n}*/*`)).join('|') };

module.exports = { AGENT_LIST, agentById, agentLabel, AGENT_PROCS, procCase };
