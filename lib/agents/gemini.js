'use strict';
// Gemini CLI：钩子合并进 ~/.gemini/settings.json；会话在 ~/.gemini/tmp/<项目>/chats/session-….json(l)。没在真的 Gemini 上测过
const { posix } = require('path');
const { unq, field, oneLine, cleanPrompt } = require('./util');

module.exports = {
  id: 'gemini', name: 'Gemini CLI', short: 'Gemini',

  // ---- 钩子：超时的单位是毫秒；钩子脚本要先回 {} (见 hooks.js 的 HOOK_SH)
  hooks: {
    kind: 'settings', file: '.gemini/settings.json', arg: 'gemini', timeout: 10000,
    events: [['BeforeAgent'], ['AfterAgent'], ['BeforeTool'], ['AfterTool'], ['Notification']],
    detect: ['.gemini/settings.json', '.gemini/oauth_creds.json', '.gemini/installation_id'],
  },

  // ---- 会话历史：有 .project_root 的话就是原来的目录 (没有就只能在原来的目录里自己执行)
  sessions: {
    mark: '/.gemini/tmp/',
    script: String.raw`
cd "$HOME/.gemini/tmp" 2>/dev/null || exit 0
ls -t -- */chats/session-*.json */chats/session-*.jsonl 2>/dev/null | head -n $SCAN | while IFS= read -r f; do hit "$f" && echo "$f"; done | head -n $N | while IFS= read -r f; do
  printf '@@ %s %s\n' "$(st "$f")" "$PWD/$f"
  printf 'raw\t%s\n' "$(head -c 60000 -- "$f" | one)"
  r=$(dirname -- "$(dirname -- "$f")")
  [ -f "$r/.project_root" ] && printf 'cwdraw\t%s\n' "$(head -c 4096 -- "$r/.project_root" | one)"
done`,
    async sftp(x) {
      const proj = await x.subdirs([x.J('.gemini', 'tmp')]);
      const files = await x.filesIn(proj.map((d) => posix.join(d, 'chats')), (n) => /^session-.*\.jsonl?$/.test(n), (d) => ({ proj: posix.join(posix.dirname(d), '.project_root') }));
      await x.collect(await x.pick(files), async (f) => {
        const [raw, root] = await Promise.all([x.head(f, 60000), x.readPart(f.proj, 0, 4096).catch(() => '')]);
        return { raw: x.oneLn(raw), ...(root ? { cwdraw: x.oneLn(root) } : {}) };
      });
    },
    parse(r) {
      const raw = field(r, 'raw');
      const id = unq((/"sessionId"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(raw) || [])[1]) || posix.basename(r.path).replace(/^session-|\.jsonl?$/g, '');
      // 第一条你发的消息 (content 是文字，或者 [{ text }])
      const um = /"type"\s*:\s*"user"[\s\S]{0,400}?"(?:content|text)"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(raw);
      return { id, title: '', prompt: cleanPrompt(unq(um && um[1])), cwd: oneLine(field(r, 'cwdraw'), 4096) };
    },
    resume: (id) => `gemini --resume ${id}`,
  },
};
