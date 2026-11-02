'use strict';
// Antigravity CLI (agy)：钩子写进 ~/.gemini/config/hooks.json 里的「sshweb-status」分组；
// 会话在 ~/.gemini/antigravity-cli/brain/<对话号>/.system_generated/logs/transcript.jsonl。没在真的 Antigravity 上测过
const { posix } = require('path');
const { str, parseJson, field, oneLine, cleanPrompt } = require('./util');

// ---- 会话历史的格式 (网上几个读 agy 会话的开源项目 rawclaw / cc-sessions-viewer / agent-sessions 写的一致，没在真机上核对过)：
// transcript.jsonl 一行一个步骤 { step_index, source, type, created_at, content, … }；你发的话是 type = USER_INPUT，
// content 里真正的话包在 <USER_REQUEST>…</USER_REQUEST> 里，后面还跟着 <ADDITIONAL_METADATA> 之类。
// 文件到检查点 (CHECKPOINT) 会整个重写、压缩，最前面的话可能已经没了 —— 那就用索引 history.jsonl 里的。
// 索引 ~/.gemini/antigravity-cli/history.jsonl 每行 { display, timestamp, workspace, conversationId }：workspace 是项目目录。
// 子 Agent (开头带 <subagent_reminder>) 也有自己的对话目录，不列
const ROOT = '.gemini/antigravity-cli';
const LOGS = '.system_generated/logs';

// 第一条 USER_INPUT 那一行 (可能截断了) → 你说的话
function firstPrompt(line) {
  if (!line) return '';
  const o = parseJson(line);
  let text = o ? str(o.content) : '';
  if (!o) { // 截断了：取 "content":" 后面的，尽量解出转义
    const m = /"content"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(line);
    const raw = m ? m[1].replace(/\\u[0-9a-fA-F]{0,3}$|\\$/, '') : '';
    try { text = JSON.parse(`"${raw}"`); } catch { text = raw; }
  }
  const req = /<USER_REQUEST>([\s\S]*?)(<\/USER_REQUEST>|$)/.exec(text);
  return cleanPrompt(req ? req[1] : text);
}
// 索引里的目录：一般是绝对路径，万一是 file:// 地址也认
const wsDir = (w) => {
  const s = str(w);
  if (!s.startsWith('file://')) return s;
  try { return decodeURIComponent(s.slice(7)).replace(/^\/([A-Za-z]:)/, '$1'); } catch { return s.slice(7); }
};
// 对话号：路径里 brain/ 后面那一层
const idOf = (p) => (/\/brain\/([^/]+)\//.exec(p) || [])[1] || '';

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

  // ---- 会话历史 (格式见上面)
  sessions: {
    mark: `/${ROOT}/brain/`,
    script: String.raw`
D="$HOME/${ROOT}"
cd "$D/brain" 2>/dev/null || exit 0
ls -t -- */${LOGS}/transcript.jsonl 2>/dev/null | head -n $SCAN | while IFS= read -r f; do hit "$f" "$(dirname -- "$f")/transcript_full.jsonl" && echo "$f"; done | head -n $N | while IFS= read -r f; do
  printf '@@ %s %s\n' "$(st "$f")" "$PWD/$f"
  printf 'input\t%s\n' "$(grep -m1 -E '"type"[[:space:]]*:[[:space:]]*"USER_INPUT"' -- "$f" | head -c 20000 | one)"
  head -c 200000 -- "$f" | grep -q 'subagent_reminder' && printf 'sub\t1\n'
done
tail -n 3000 "$D/history.jsonl" 2>/dev/null | while IFS= read -r l; do printf 'idx\t%s\n' "$l"; done`,
    async sftp(x) {
      const dirs = await x.subdirs([x.J(ROOT, 'brain')]);
      const files = await x.filesIn(dirs.map((d) => posix.join(d, LOGS)), (n) => n === 'transcript.jsonl');
      await x.collect(await x.pick(files), async (f) => {
        const h = await x.head(f, 200000);
        const input = h.split('\n').find((l) => /"type"\s*:\s*"USER_INPUT"/.test(l)) || '';
        return { input: x.oneLn(input.slice(0, 20000)), ...(h.includes('subagent_reminder') ? { sub: '1' } : {}) };
      });
      const idx = (await x.ls(x.J(ROOT))).find((e) => e.filename === 'history.jsonl');
      if (idx) x.extra.push(...(await x.tail(x.file(x.J(ROOT), idx), 1 << 20)).split('\n').filter(Boolean));
    },
    // 索引：对话号 → 目录、第一句话 (索引按时间往后写，第一次出现的就是第一句)
    context(extra) {
      const conv = new Map();
      for (const l of extra) {
        const o = parseJson(l);
        const id = o && str(o.conversationId);
        if (!id) continue;
        const c = conv.get(id) || {};
        if (!c.cwd && wsDir(o.workspace)) c.cwd = wsDir(o.workspace);
        if (!c.prompt && str(o.display).trim()) c.prompt = str(o.display);
        conv.set(id, c);
      }
      return { conv };
    },
    parse(r, ctx) {
      const id = idOf(r.path);
      const c = ctx.conv.get(id) || {};
      return { id, title: '', prompt: firstPrompt(field(r, 'input')) || cleanPrompt(c.prompt), cwd: oneLine(c.cwd || '', 4096), sub: !!field(r, 'sub') };
    },
    hide: (s) => s.sub, // 子 Agent 的对话
    resume: (id) => `agy --conversation ${id}`,
    // 删除：整个对话目录 brain/<对话号>，还有 conversations/<对话号>.db (连同 -wal / -shm)
    items: (file, id) => {
      const brain = posix.dirname(posix.dirname(posix.dirname(file)));
      const db = posix.join(posix.dirname(posix.dirname(brain)), 'conversations', `${id}.db`);
      return [brain, db, `${db}-wal`, `${db}-shm`];
    },
  },
};
