'use strict';
// Antigravity CLI (agy)：钩子写进 ~/.gemini/config/hooks.json 里的「sshweb-status」分组；
// 会话在 ~/.gemini/antigravity-cli/brain/<对话号>/.system_generated/logs/transcript.jsonl。在 agy 1.4.12 上实测过。
// 官方的钩子说明在主机上：~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md
const { posix } = require('path');
const { str, parseJson, field, oneLine, cleanPrompt } = require('./util');

// ---- 会话历史的格式 (agy 1.4.12 实测；网上的开源项目 rawclaw / cc-sessions-viewer / agent-sessions 写的大体一致)：
// transcript.jsonl 一行一个步骤 { step_index, source, type, created_at, content, … }；你发的话是 type = USER_INPUT，
// content 里真正的话包在 <USER_REQUEST>…</USER_REQUEST> 里，后面还跟着 <ADDITIONAL_METADATA> 之类。
// 文件到检查点 (CHECKPOINT) 会整个重写、压缩，最前面的话可能已经没了 —— 那就用索引 history.jsonl 里的。
// 索引 ~/.gemini/antigravity-cli/history.jsonl 你说的每句话一行 { display, timestamp (毫秒), workspace }：workspace 是项目目录。
// 网上说有 conversationId，实测 1.4.12 没有 —— 那就拿对话第一句话的时间 (transcript 里的 created_at) 去对，两边差不到一秒，再核对文字。
// cache/last_conversations.json 是「目录 → 这个目录里最近一个对话」。agy 自动起的标题在 annotations/<对话号>.pbtxt 的 title:"…"
// (protobuf 文本格式，中文写成 \345\212… 这样的八进制转义)。
// 目录、标题、子 Agent 在 conversation_summaries.db 里最全，但那是 SQLite，主机上不一定有 sqlite3，不用。
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
// protobuf 文本格式的字符串 (title:"…" 引号里面) → 文字：\" \\ \n \t、八进制 \345、十六进制 \xe4 是 UTF-8 的字节
function pbStr(raw) {
  const bytes = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { bytes.push(...Buffer.from(c, 'utf8')); continue; }
    const n = raw[++i];
    if (/[0-7]/.test(n)) { const m = /^[0-7]{1,3}/.exec(raw.slice(i))[0]; bytes.push(parseInt(m, 8) & 255); i += m.length - 1; }
    else if (n === 'x') { const m = /^[0-9a-fA-F]{1,2}/.exec(raw.slice(i + 1))?.[0] || ''; if (m) bytes.push(parseInt(m, 16)); i += m.length; }
    else bytes.push(({ n: 10, t: 9, r: 13 })[n] ?? (n || '').charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}
const titleOf = (t) => { const m = /title:\s*"((?:[^"\\]|\\.)*)"/.exec(t || ''); return m ? pbStr(m[1]) : ''; };
// 第一条 USER_INPUT 那一行 → 它的时间 (毫秒；created_at 在 content 前面，截断了也取得到)
const createdOf = (line) => { const m = /"created_at"\s*:\s*"([^"]+)"/.exec(line || ''); const t = m ? Date.parse(m[1]) : NaN; return Number.isFinite(t) ? t : 0; };
// 对话号：路径里 brain/ 后面那一层
const idOf = (p) => (/\/brain\/([^/]+)\//.exec(p) || [])[1] || '';

module.exports = {
  id: 'antigravity', name: 'Antigravity', short: 'Antigravity', tested: true, // agy 1.4.12 实测过钩子和会话历史

  // ---- 钩子：传来的内容不带事件名，命令里带上；PreToolUse 要回 {"decision":"ask"} (见 hooks.js 的 HOOK_SH)。
  // 字段是驼峰写法：对话号 conversationId、你说的话 lastUserInput、目录 workspacePaths (数组)，hook.sh 里有别名。
  // 主界面不是全屏 (实测 alt=0，只有第一次进一个目录问「信不信任」那一屏是全屏)，不用另外设
  hooks: {
    kind: 'bundle', file: '.gemini/config/hooks.json', bundle: 'sshweb-status',
    tip: '用工具前回「ask」：照你自己的权限设置问你，不会自动允许',
    arg: (ev) => `antigravity ${ev}`,
    events: [['SessionStart'], ['PreInvocation'], ['PostInvocation'], ['Stop'], ['PreToolUse', '*'], ['PostToolUse', '*']],
    detect: ['.gemini/antigravity', '.gemini/antigravity-ide', '.gemini/antigravity-cli', '.gemini/config'],
  },

  // ---- 事件：用 ask_permission 工具 = 要你确认。
  // 没有「要权限」的钩子事件 (用工具前只有 PreToolUse，回 ask 后它自己按权限设置决定弹不弹)：
  // 钩子说在跑、屏幕上是它的确认框 (「Requesting permission for:」下面「> 1. Yes, run command」) 就算要你确认 (见 session/hooks.js 的 hookState)。
  // Stop 的 terminationReason：USER_CANCELED = 你打断了，ERROR = 出错 (别的是正常做完)
  events: {
    permTool: 'ask_permission',
    permScreen: /^\s*Requesting permission for:/m,
    stopAs: (ev) => (ev.reason === 'USER_CANCELED' ? 'interrupt' : ev.reason === 'ERROR' || ev.error ? 'error' : ''),
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
  printf 'title\t%s\n' "$(head -c 4096 -- "$D/annotations/$(printf '%s' "$f" | cut -d/ -f1).pbtxt" 2>/dev/null | one)"
  head -c 200000 -- "$f" | grep -q 'subagent_reminder' && printf 'sub\t1\n'
done
tail -n 3000 "$D/history.jsonl" 2>/dev/null | while IFS= read -r l; do printf 'idx\t%s\n' "$l"; done
[ -f "$D/cache/last_conversations.json" ] && printf 'idx\t{"lastConversations":%s}\n' "$(head -c 200000 "$D/cache/last_conversations.json" | one)"`,
    async sftp(x) {
      const dirs = await x.subdirs([x.J(ROOT, 'brain')]);
      const files = await x.filesIn(dirs.map((d) => posix.join(d, LOGS)), (n) => n === 'transcript.jsonl');
      const annDir = x.J(ROOT, 'annotations'), ann = new Map((await x.ls(annDir)).map((e) => [e.filename, e]));
      await x.collect(await x.pick(files), async (f) => {
        const h = await x.head(f, 200000);
        const input = h.split('\n').find((l) => /"type"\s*:\s*"USER_INPUT"/.test(l)) || '';
        const a = ann.get(`${idOf(f.path)}.pbtxt`);
        const title = a ? x.oneLn(await x.head(x.file(annDir, a), 4096)) : '';
        return { input: x.oneLn(input.slice(0, 20000)), title, ...(h.includes('subagent_reminder') ? { sub: '1' } : {}) };
      });
      const top = await x.ls(x.J(ROOT));
      const idx = top.find((e) => e.filename === 'history.jsonl');
      if (idx) x.extra.push(...(await x.tail(x.file(x.J(ROOT), idx), 1 << 20)).split('\n').filter(Boolean));
      const lc = (await x.ls(x.J(ROOT, 'cache'))).find((e) => e.filename === 'last_conversations.json');
      if (lc) x.extra.push(`{"lastConversations":${x.oneLn(await x.head(x.file(x.J(ROOT, 'cache'), lc), 200000))}}`);
    },
    // 索引：对话号 → 目录、第一句话 (有 conversationId 的；按时间往后写，第一次出现的就是第一句)；
    // 没有对话号的每句话 (按时间对)；last_conversations.json 的「目录 → 最近一个对话」反过来查
    context(extra) {
      const conv = new Map(), lines = [], last = new Map();
      for (const l of extra) {
        const o = parseJson(l);
        if (!o) continue;
        if (o.lastConversations && typeof o.lastConversations === 'object') {
          for (const [dir, id] of Object.entries(o.lastConversations)) if (str(id)) last.set(id, dir);
          continue;
        }
        const id = str(o.conversationId), dir = wsDir(o.workspace), text = str(o.display);
        if (!id) { if (dir && Number.isFinite(o.timestamp)) lines.push({ t: o.timestamp, dir, text: text.trim() }); continue; }
        const c = conv.get(id) || {};
        if (!c.cwd && dir) c.cwd = dir;
        if (!c.prompt && text.trim()) c.prompt = text;
        conv.set(id, c);
      }
      return { conv, lines, last };
    },
    parse(r, ctx) {
      const id = idOf(r.path), input = field(r, 'input');
      const c = ctx.conv.get(id) || {};
      const prompt = firstPrompt(input) || cleanPrompt(c.prompt);
      // 按时间对：第一句话前后 2 分钟内、文字一样的那一行；文字对不上 (改写过) 就取 10 秒内最近的
      let cwd = c.cwd || ctx.last.get(id) || '';
      const t0 = createdOf(input);
      if (!cwd && t0) {
        const near = ctx.lines.filter((x) => Math.abs(x.t - t0) <= 120000);
        const same = near.filter((x) => cleanPrompt(x.text) === prompt).sort((a, b) => Math.abs(a.t - t0) - Math.abs(b.t - t0))[0];
        const close = near.filter((x) => Math.abs(x.t - t0) <= 10000).sort((a, b) => Math.abs(a.t - t0) - Math.abs(b.t - t0))[0];
        cwd = (same || close)?.dir || '';
      }
      return { id, title: oneLine(titleOf(field(r, 'title'))), prompt, cwd: oneLine(cwd, 4096), sub: !!field(r, 'sub') };
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
