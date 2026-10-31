'use strict';
// Claude Code：钩子合并进 ~/.claude/settings.json；会话在 ~/.claude/projects/<目录>/<会话 id>.jsonl
const { posix } = require('path');
const { unq, field, oneLine, cleanPrompt } = require('./util');

module.exports = {
  id: 'claude', name: 'Claude Code', short: 'Claude', tested: true,
  icon: '✳', // 常驻会话选择框里代替「Claude：」(Claude Code 自己在终端标题里用的)

  // ---- 钩子 (见 lib/hooks.js)
  hooks: {
    kind: 'settings', file: '.claude/settings.json', backup: true, arg: '',
    events: [
      ['SessionStart'], ['UserPromptSubmit'], ['PreToolUse', 'AskUserQuestion'], ['PermissionRequest', '*'], ['PostToolUse', '*'],
      ['Notification'], ['Stop'], ['StopFailure'], ['SessionEnd'],
    ],
    detect: ['.claude'],
  },

  // ---- 事件 (见 lib/session/hooks.js)
  events: {
    preToolUseOnlyAsk: true, // PreToolUse 只装了问问题的 (用工具看 PostToolUse)
    answerPerm: true, // 通知上的「允许 / 拒绝」：确认框的按键是确定的 (回车 = 选中的「1. Yes」，Esc = No)
  },

  // ---- 会话历史 (见 lib/agent-sessions.js)。标题优先用 /rename 起的名字，再是自动起的标题，再是第一句话；子 Agent 的在更深一层，不算
  sessions: {
    mark: '/.claude/projects/',
    script: String.raw`
cd "$HOME/.claude/projects" 2>/dev/null || exit 0
ls -t -- */*.jsonl 2>/dev/null | head -n $SCAN | while IFS= read -r f; do hit "$f" && echo "$f"; done | head -n $N | while IFS= read -r f; do
  printf '@@ %s %s\n' "$(st "$f")" "$PWD/$f"
  printf 'cwd\t%s\n' "$(j cwd < "$f")"
  printf 'ctitle\t%s\n' "$(tail -c 2000000 -- "$f" | jl customTitle)"
  v=$(tail -c 2000000 -- "$f" | jl aiTitle); [ -n "$v" ] || v=$(j aiTitle < "$f")
  printf 'title\t%s\n' "$v"
  printf 'prompt\t%s\n' "$(grep -m 30 -E '"role":"user","content":"' -- "$f" | grep -v '"isMeta":true' | grep -vE '"content":"(<|Caveat)' | head -n 1 | j content)"
done`,
    // Windows 主机：用 SFTP 读 (x 是 agent-sessions.js 的 scanSftp 给的工具)，抽出和上面一样的字段
    async sftp(x) {
      const files = await x.filesIn(await x.subdirs([x.J('.claude', 'projects')]), (n) => n.endsWith('.jsonl'));
      await x.collect(await x.pick(files), async (f) => {
        const [h, t] = await Promise.all([x.head(f), x.tail(f)]);
        const line = h.split('\n').find((l) => /"role":"user","content":"/.test(l) && !l.includes('"isMeta":true') && !/"content":"(<|Caveat)/.test(l)) || '';
        return { cwd: x.jfirst(h, 'cwd'), ctitle: x.jlast(t, 'customTitle'), title: x.jlast(t, 'aiTitle') || x.jfirst(h, 'aiTitle'), prompt: x.jfirst(line, 'content') };
      });
    },
    parse: (r) => ({ id: posix.basename(r.path).replace(/\.jsonl$/, ''), title: oneLine(unq(field(r, 'ctitle')) || unq(field(r, 'title'))),
      prompt: cleanPrompt(unq(field(r, 'prompt'))), cwd: unq(field(r, 'cwd')) }),
    // 只有 /clear 之类命令、没说过话的会话不列 (Claude 自己的 --resume 列表也不显示)
    hide: (s) => !s.title && !s.prompt,
    resume: (id) => `claude --resume ${id}`,
    // 删除时一起移走：同名目录 (子 Agent、工具输出)
    items: (file) => [file, file.replace(/\.jsonl$/, '')],
  },
};
