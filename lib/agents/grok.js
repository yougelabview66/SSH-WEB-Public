'use strict';
// Grok (xAI 的 Grok Build CLI)：钩子用自己的文件 ~/.grok/hooks/sshweb-status.json；会话在 ~/.grok/sessions/<目录>/<会话 id>/
const { posix } = require('path');
const { str, unesc, parseJson, field, oneLine, cleanPrompt, evName } = require('./util');

// Grok 的提醒：每次用工具前都会发一条「tool permission requested」(不管要不要你确认)，不算；文字像在问你的才算要权限
const routine = (ev) => evName(ev.notification_type) === 'permission_prompt' && String(ev.message || '').trim().toLowerCase() === 'tool permission requested'
  && (!ev.level || String(ev.level).trim().toLowerCase() === 'info');
const asky = (m) => /permission|approv|allow|confirm|needs your|requires your|feedback|clarify|question/i.test(String(m || ''));

module.exports = {
  id: 'grok', name: 'Grok', short: 'Grok', tested: true,
  icon: '◆', // 常驻会话选择框里代替「Grok：」(Grok 界面里默认的标志，见它文档 06-theming 的 bullet = "diamond")

  // ---- 钩子 (见 lib/hooks.js)：~/.grok/hooks/*.json 都会加载，用自己的文件，不碰你写的；PreToolUse 看问问题 (ask_user_question 不走权限确认)。
  // 顺带在 ~/.grok/pager.toml 设 alt_screen = "never" (见 hooks.js 的 tomlSet)：Grok 默认用终端的备用屏幕，聊过的内容不进终端历史 ——
  // Linux 上进不了历史视图，Windows 上经过 ConPTY 后历史视图里只有最新一屏 / 文字乱。不用备用屏幕时还是填满屏幕的样子，内容进终端历史
  hooks: {
    kind: 'own', file: '.grok/hooks/sshweb-status.json', arg: 'grok',
    events: [['SessionStart'], ['UserPromptSubmit'], ['Stop'], ['StopCancelled'], ['StopFailure'], ['SessionEnd'],
      ['PreToolUse', '.*'], ['PostToolUse', '.*'], ['PostToolUseFailure', '.*'], ['Notification']],
    toml: { file: '.grok/pager.toml', table: 'terminal', key: 'alt_screen', value: '"never"' },
    detect: ['.grok'],
  },

  // ---- 事件 (见 lib/session/hooks.js)：Notification 自己判断 (skip = 不算，perm = 要你确认)
  events: {
    notification: (ev) => (routine(ev) || !asky(ev.message) ? 'skip' : 'perm'),
  },

  // ---- 会话历史 (见 lib/agent-sessions.js)：<会话 id>/summary.json (info.id / info.cwd / generated_title)，第一句话在 chat_history.jsonl 的 <user_query> 里
  sessions: {
    mark: '/.grok/sessions/',
    script: String.raw`
cd "$HOME/.grok/sessions" 2>/dev/null || exit 0
ls -t -- */*/summary.json 2>/dev/null | head -n $SCAN | while IFS= read -r f; do d=$(dirname -- "$f"); hit "$f" "$d/chat_history.jsonl" && echo "$f"; done | head -n $N | while IFS= read -r f; do
  d=$(dirname -- "$f"); m="$d/chat_history.jsonl"; [ -f "$m" ] || m=$f
  printf '@@ %s %s\n' "$(st "$m")" "$PWD/$f"
  printf 'json\t%s\n' "$(head -c 65536 -- "$f" | one)"
  printf 'rawprompt\t%s\n' "$(grep -m1 -oE '<user_query>([^<]|<[^/])*' -- "$d/chat_history.jsonl" 2>/dev/null | head -n 1 | sed 's/^<user_query>//')"
done`,
    async sftp(x) {
      const dirs = await x.subdirs(await x.subdirs([x.J('.grok', 'sessions')]));
      const files = (await x.mapLimit(dirs, 8, async (dir) => {
        const ents = await x.ls(dir);
        const sum = ents.find((e) => e.filename === 'summary.json'), chat = ents.find((e) => e.filename === 'chat_history.jsonl');
        return sum ? [{ ...x.file(dir, sum), ...(chat ? { mtime: (chat.attrs.mtime || 0) * 1000 } : {}), chat: chat && x.file(dir, chat) }] : [];
      })).flat();
      await x.collect(await x.pick(files, async (f) => (await x.has(f)) || (!!f.chat && await x.has(f.chat))), async (f) => {
        const [sum, ch] = await Promise.all([x.head(f), f.chat ? x.head(f.chat) : '']);
        return { json: x.oneLn(sum), rawprompt: ((/<user_query>((?:[^<]|<[^/])*)/.exec(ch) || [])[1] || '') };
      });
    },
    parse(r) {
      const o = parseJson(field(r, 'json')) || {};
      const info = o.info && typeof o.info === 'object' ? o.info : {};
      return { id: str(info.id) || posix.basename(posix.dirname(r.path)), title: oneLine(str(o.generated_title) || str(o.session_summary)),
        prompt: cleanPrompt(unesc(field(r, 'rawprompt'))), cwd: str(info.cwd) };
    },
    resume: (id) => `grok --resume ${id}`,
    items: (file) => [posix.dirname(file)], // 整个会话目录
  },
};
