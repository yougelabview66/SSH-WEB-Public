'use strict';
// Codex：钩子合并进 ~/.codex/hooks.json；会话在 ~/.codex/sessions/年/月/日/rollout-….jsonl。钩子、历史视图、会话历史在 Codex 0.166 上实测过
const { posix } = require('path');
const { str, unq, parseJson, field, oneLine, cleanPrompt } = require('./util');

module.exports = {
  id: 'codex', name: 'Codex', short: 'Codex', tested: true, // Codex 0.166 在 SSH-WEB 里实测过
  proc: ['codex'],
  noEndEvent: true, // 退出时不报事件：终端回到 shell 提示符就算退出了 (见 lib/session/hooks.js 的 checkAgentGone)
  logo: true, // 常驻会话选择框里名字前面画它的标志 (SVG，见 public/app/09-agents.js 的 AGENT_LOGOS)

  // ---- 钩子：~/.codex/hooks.json (顶层只能有 hooks / description，别的键 Codex 会整个文件不认)；Interrupt 的超时最多 3 秒。
  // 新加的钩子要在 Codex 里输入 /hooks 批准一次才生效。
  // 顺带在 ~/.codex/config.toml 的 [tui] 设 alternate_screen = "never" (同 Grok 的 pager.toml，见 hooks.js 的 tomlSet)：
  // Codex 默认用终端的备用屏幕、开着鼠标，聊过的内容不进终端历史，进不了历史视图 (实测 Codex 0.166)；
  // 设了以后同 --no-alt-screen，界面直接画在终端里，内容进终端历史
  hooks: {
    kind: 'settings', file: '.codex/hooks.json', strict: true, arg: 'codex',
    tip: '装好后要在 Codex 里输入 /hooks 批准一次才生效；同时在 ~/.codex/config.toml 设 alternate_screen = "never"：聊过的内容进终端历史，能进历史视图',
    after: '在 Codex 里输入 /hooks 批准一次。',
    events: [['UserPromptSubmit'], ['PreToolUse'], ['PermissionRequest'], ['PostToolUse'], ['Stop'], ['Interrupt', null, 3]],
    toml: { file: '.codex/config.toml', table: 'tui', key: 'alternate_screen', value: '"never"' },
    detect: ['.codex'],
  },

  // ---- 出错结束 (额度用完、断网重试用完等) 不报 Stop (实测 0.166)，状态会一直停在「运行中」：钩子说在跑时看屏幕 (见 session/hooks.js 的 hookState)。
  // 出错写成红色的「■ 原因」，被打断是「■ Conversation interrupted …」；在跑时底部是「Working (5s • esc to interrupt)」。
  // 「■」那条要是最新的：它下面除了输入框 (一行「› …」) 没有新的你说的话「› …」(选择框的「› 1. …」不算)
  events: {
    errorScreen(rows) {
      if (rows.some((l) => /esc to interrupt/.test(l))) return null;
      let e = -1;
      for (let i = rows.length - 1; i >= 0; i--) if (/^\s*■ \S/.test(rows[i])) { e = i; break; }
      if (e < 0) return null;
      if (rows.slice(e + 1).filter((l) => /^\s*› /.test(l) && !/^\s*› \d+\. /.test(l)).length > 1) return null;
      if (/^\s*■ Conversation interrupted/.test(rows[e])) return { interrupt: true };
      // 原因换行写了几行：接到空行、或上一行已经是句末为止
      let msg = rows[e].replace(/^\s*■\s*/, '').trim();
      for (let i = e + 1; i < rows.length && i <= e + 3 && rows[i].trim() && !/[.。!?！？]$/.test(msg); i++) msg += ' ' + rows[i].trim();
      return { error: msg };
    },
  },

  // ---- 会话历史：第一行 session_meta 里有 id 和 cwd；你说的话：新版 (实测 0.166) 是 item_completed 里的 UserMessage (content[].text)，
  // 旧版是 user_message (message)；起过名字的在 ~/.codex/session_index.jsonl (thread_name，新版会自动起)
  sessions: {
    mark: '/.codex/sessions/',
    script: String.raw`
cd "$HOME/.codex/sessions" 2>/dev/null || exit 0
ls -t -- */*/*/rollout-*.jsonl 2>/dev/null | head -n $SCAN | while IFS= read -r f; do hit "$f" && echo "$f"; done | head -n $N | while IFS= read -r f; do
  printf '@@ %s %s\n' "$(st "$f")" "$PWD/$f"
  l=$(head -n 1 -- "$f")
  printf 'id\t%s\n' "$(printf '%s' "$l" | j id)"
  printf 'cwd\t%s\n' "$(printf '%s' "$l" | j cwd)"
  l=$(grep -m1 -E '"type":"(UserMessage|user_message)"' -- "$f" | head -c 65536)
  case "$l" in *'"type":"UserMessage"'*) printf 'prompt\t%s\n' "$(printf '%s' "$l" | j text)";; *) printf 'prompt\t%s\n' "$(printf '%s' "$l" | j message)";; esac
done
tail -n 3000 "$HOME/.codex/session_index.jsonl" 2>/dev/null | while IFS= read -r l; do printf 'idx\t%s\n' "$l"; done`,
    async sftp(x) {
      const dirs = await x.subdirs(await x.subdirs(await x.subdirs([x.J('.codex', 'sessions')]))); // 年 / 月 / 日
      const files = await x.filesIn(dirs, (n) => /^rollout-.*\.jsonl$/.test(n));
      await x.collect(await x.pick(files), async (f) => {
        const h = await x.head(f, 262144);
        const first = h.split('\n')[0] || '';
        const um = h.split('\n').find((l) => l.includes('"type":"UserMessage"') || l.includes('"type":"user_message"')) || '';
        return { id: x.jfirst(first, 'id'), cwd: x.jfirst(first, 'cwd'), prompt: x.jfirst(um, um.includes('"type":"UserMessage"') ? 'text' : 'message') };
      });
      const idx = (await x.ls(x.J('.codex'))).find((e) => e.filename === 'session_index.jsonl');
      if (idx) x.extra.push(...(await x.tail(x.file(x.J('.codex'), idx), 1 << 20)).split('\n').filter(Boolean));
    },
    // 不属于某个会话的行 (起名索引)：会话 id → 名字
    context(extra) {
      const names = new Map();
      for (const l of extra) {
        const o = parseJson(l);
        if (o && str(o.id) && str(o.thread_name)) names.set(o.id, o.thread_name);
      }
      return { names };
    },
    parse(r, ctx) {
      const id = unq(field(r, 'id')) || (/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i.exec(posix.basename(r.path)) || [])[1] || '';
      return { id, title: oneLine(ctx.names.get(id) || ''), prompt: cleanPrompt(unq(field(r, 'prompt'))), cwd: unq(field(r, 'cwd')) };
    },
    resume: (id) => `codex resume ${id}`,
  },
};
