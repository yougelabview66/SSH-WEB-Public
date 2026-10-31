'use strict';
// Antigravity：钩子写进 ~/.gemini/config/hooks.json 里的「sshweb-status」分组。没有会话历史。没在真的 Antigravity 上测过

module.exports = {
  id: 'antigravity', name: 'Antigravity', short: 'Antigravity',

  // ---- 钩子：传来的内容不带事件名，命令里带上；PreToolUse 要回 {"decision":"ask"} (见 hooks.js 的 HOOK_SH)
  hooks: {
    kind: 'bundle', file: '.gemini/config/hooks.json', bundle: 'sshweb-status',
    arg: (ev) => `antigravity ${ev}`,
    events: [['PreInvocation'], ['PostInvocation'], ['Stop'], ['PreToolUse', '*'], ['PostToolUse', '*']],
    detect: ['.gemini/antigravity', '.gemini/antigravity-ide', '.gemini/antigravity-cli', '.gemini/config'],
  },

  // ---- 事件：用 ask_permission 工具 = 要你确认
  events: {
    permTool: 'ask_permission',
  },
};
