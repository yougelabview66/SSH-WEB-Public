'use strict';
// Grok (xAI 的 Grok Build CLI)：钩子用自己的文件 ~/.grok/hooks/sshweb-status.json；会话在 ~/.grok/sessions/<目录>/<会话 id>/
const { posix } = require('path');
const { str, unesc, parseJson, field, oneLine, cleanPrompt, evName } = require('./util');
const { cellWidth } = require('../../public/cellwidth');

// Grok 的提醒：每次用工具前都会发一条「tool permission requested」(不管要不要你确认)，不算；文字像在问你的才算要权限
const routine = (ev) => evName(ev.notification_type) === 'permission_prompt' && String(ev.message || '').trim().toLowerCase() === 'tool permission requested'
  && (!ev.level || String(ev.level).trim().toLowerCase() === 'info');
const asky = (m) => /permission|approv|allow|confirm|needs your|requires your|feedback|clarify|question/i.test(String(m || ''));

// ---- 完整对话 (历史视图用，见下面的 history)。Grok 的全屏 (填充) 界面把对话放在自己的界面里滚动，终端历史里只有每次重画留下的一屏；
// 完整的对话在会话文件 chat_history.jsonl 里 (实测 Grok 1.0.70)：一行一条 —— user (带 prompt_index 的是你发的，
// 别的是系统插的提醒)、reasoning (summary 是思考的摘要)、assistant (content 是回答，tool_calls 是用的工具)、tool_result (工具的输出)
const pr = (fn) => new Promise((resolve, reject) => fn((e, v) => (e ? reject(e) : resolve(v))));
const HIST_MAX = 8 << 20; // 会话文件太大时只读最后这么多 (工具输出能很长)
const RESULT_LINES = 12; // 工具输出最多显示这么多行

// 找这个标签里 Grok 在用的会话文件：钩子报了会话号就是 sessions/*/<会话号>/；没报就找最近写过的 (目录对得上的优先)
async function sessionFile({ sftp, home, sid, cwd }) {
  const base = posix.join(home, '.grok', 'sessions');
  const ls = (d) => pr((cb) => sftp.readdir(d, cb)).catch(() => []);
  const stat = (f) => pr((cb) => sftp.stat(f, cb)).catch(() => null);
  const dirs = (await ls(base)).filter((e) => e.attrs.isDirectory()).map((e) => e.filename);
  if (sid && /^[\w.-]+$/.test(sid)) {
    for (const d of dirs) {
      const f = posix.join(base, d, sid, 'chat_history.jsonl');
      if (await stat(f)) return f;
    }
  }
  const dec = (d) => { try { return decodeURIComponent(d); } catch { return d; } };
  const mine = cwd ? dirs.filter((d) => dec(d) === cwd) : [];
  let best = null;
  for (const d of mine.length ? mine : dirs) {
    // 每个目录只看最近建的几个会话 (目录的修改时间)，再比会话文件本身的修改时间
    const subs = (await ls(posix.join(base, d))).filter((e) => e.attrs.isDirectory()).sort((x, y) => y.attrs.mtime - x.attrs.mtime).slice(0, 5);
    for (const e of subs) {
      const f = posix.join(base, d, e.filename, 'chat_history.jsonl');
      const st = await stat(f);
      if (st && (!best || st.mtime > best.mtime)) best = { f, mtime: st.mtime };
    }
  }
  return best?.f || null;
}

// 读文件 (太大就只读最后一段，去掉开头不完整的那行)
async function readTail(sftp, f) {
  const st = await pr((cb) => sftp.stat(f, cb));
  const start = Math.max(0, st.size - HIST_MAX), len = st.size - start;
  const h = await pr((cb) => sftp.open(f, 'r', cb));
  try {
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = await new Promise((resolve, reject) => sftp.read(h, buf, got, len - got, start + got, (e, nr) => (e ? reject(e) : resolve(nr))));
      if (!n) break;
      got += n;
    }
    const text = buf.subarray(0, got).toString('utf8');
    return start ? text.slice(text.indexOf('\n') + 1) : text;
  } finally { sftp.close(h, () => {}); }
}

// 会话记录 → 带颜色的文字 (格式同终端历史，历史视图照样排)：每轮之前一条分隔线；你说的话加粗；思考暗色只留第一行；
// 用的工具青色 (常用的写中文名)，命令和前几行输出暗色、左边一条竖线；回答里的 Markdown 简单排一下 (粗体、代码、标题、列表、表格)
const C = { bold: '\x1b[1m', dim: '\x1b[2m', cyan: '\x1b[36m', mag: '\x1b[35m', off: '\x1b[0m', boldOff: '\x1b[22m', fgOff: '\x1b[39m' };
// 工具输出、代码块左边的竖线：用框线字符 │ (暗色)，这样长行照样放进能左右滑的条带 (见 public/app/54-grid-view.js 的 block)，不折行
const BAR = '\x1b[2m│\x1b[22m';
const TOOL_NAMES = {
  run_terminal_command: '执行命令', read_file: '读文件', write_file: '写文件', edit_file: '改文件', create_file: '新建文件', delete_file: '删文件',
  list_dir: '列目录', list_directory: '列目录', grep: '搜索', search: '搜索', search_files: '找文件', glob: '找文件', web_search: '搜网页',
  web_fetch: '读网页', fetch: '读网页', ask_user_question: '问你', todo_write: '待办', task: '子任务',
};
const width = (t) => [...String(t)].reduce((n, ch) => n + cellWidth(ch), 0);
const pad = (t, w) => t + ' '.repeat(Math.max(0, w - width(t)));
// 一行里的 Markdown：**粗体**、`代码`
const inline = (t) => t.replace(/\*\*([^*]+)\*\*/g, `${C.bold}$1${C.boldOff}`).replace(/`([^`]+)`/g, `${C.cyan}$1${C.fgOff}`);
const plain = (t) => t.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
// Markdown 表格 (| a | b | 下面一行 |---|---|) → 带框线的表格，按格数对齐 (中文占两格)
function table(rows) {
  const cells = rows.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r)).map((r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => plain(c.trim())));
  const n = Math.max(...cells.map((r) => r.length));
  const w = Array.from({ length: n }, (_, i) => Math.max(...cells.map((r) => width(r[i] || ''))));
  const line = (l, m, r) => `${C.dim}${l}${w.map((x) => '─'.repeat(x + 2)).join(m)}${r}${C.off}`;
  const row = (r, head) => `${C.dim}│${C.off}` + w.map((x, i) => ` ${head ? C.bold : ''}${pad(r[i] || '', x)}${head ? C.boldOff : ''} ${C.dim}│${C.off}`).join('');
  return [line('┌', '┬', '┐'), row(cells[0], true), line('├', '┼', '┤'), ...cells.slice(1).map((r) => row(r)), line('└', '┴', '┘')];
}
function markdown(text) {
  const out = [], lines = text.split('\n');
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*```/.test(l)) { fence = !fence; continue; }
    if (fence) { out.push(`${BAR} ${C.cyan}${l}${C.off}`); continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) { // 表格：连续的 | … | 行
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      i--;
      out.push(...table(rows));
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) { out.push(`${C.bold}${C.mag}${plain(h[2])}${C.off}`); continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { out.push(`${C.dim}${'─'.repeat(20)}${C.off}`); continue; }
    out.push(inline(l.replace(/^(\s*)[-*]\s+/, '$1• ')));
  }
  return out;
}
function render(jsonl) {
  const out = [];
  const blank = () => { if (out.length && out[out.length - 1] !== '') out.push(''); };
  const texts = (c) => (Array.isArray(c) ? c.map((b) => (b?.type === 'text' ? str(b.text) : b?.type ? `[${b.type === 'image' ? '图片' : b.type}]` : '')).join('\n') : str(c));
  for (const line of jsonl.split('\n')) {
    const o = parseJson(line);
    if (!o) continue;
    if (o.type === 'user' && o.prompt_index != null) {
      const t = texts(o.content).replace(/<\/?user_query>/g, '').trim();
      if (out.length) { blank(); out.push(`${C.dim}${'━'.repeat(40)}${C.off}`); }
      t.split('\n').forEach((l, i) => out.push(`${C.bold}${i ? '  ' : '❯ '}${l}${C.off}`));
      out.push('');
    } else if (o.type === 'reasoning') {
      const t = (Array.isArray(o.summary) ? o.summary.map((x) => str(x?.text)).join(' ') : '').replace(/\s+/g, ' ').trim();
      if (t) out.push(`${C.dim}◆ ${oneLine(t, 160)}${C.off}`);
    } else if (o.type === 'assistant') {
      for (const c of Array.isArray(o.tool_calls) ? o.tool_calls : []) {
        const a = parseJson(c?.arguments) || {};
        const name = str(c?.name);
        const what = str(a.description) || str(a.path) || str(a.file_path) || str(a.query) || str(a.pattern) || str(a.url) || (a.command ? '' : '');
        out.push(`${C.cyan}◈ ${TOOL_NAMES[name] || name}${what ? `${C.off}  ${oneLine(what, 300)}` : ''}${C.off}`);
        if (a.command) out.push(`${BAR} ${C.dim}$ ${oneLine(a.command, 1000)}${C.off}`);
      }
      const t = str(o.content).trim();
      if (t) { blank(); out.push(...markdown(t)); out.push(''); }
    } else if (o.type === 'tool_result') {
      const lines = str(o.content).replace(/\s+$/, '').split('\n');
      for (const l of lines.slice(0, RESULT_LINES)) out.push(`${BAR} ${C.dim}${l}${C.off}`);
      if (lines.length > RESULT_LINES) out.push(`${BAR} ${C.dim}… 还有 ${lines.length - RESULT_LINES} 行${C.off}`);
    }
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}

module.exports = {
  id: 'grok', name: 'Grok', short: 'Grok', tested: true,
  logo: true, // 常驻会话选择框里代替「Grok：」：网页上画 Grok 的标志 (SVG，见 public/app/09-agents.js 的 AGENT_LOGOS)

  // ---- 钩子 (见 lib/hooks.js)：~/.grok/hooks/*.json 都会加载，用自己的文件，不碰你写的；PreToolUse 看问问题 (ask_user_question 不走权限确认)。
  // 顺带在 ~/.grok/pager.toml 设 alt_screen = "never" (见 hooks.js 的 tomlSet)：Grok 默认用终端的备用屏幕，聊过的内容不进终端历史 ——
  // Linux 上进不了历史视图，Windows 上经过 ConPTY 后历史视图里只有最新一屏 / 文字乱。不用备用屏幕时还是填满屏幕的样子，内容进终端历史
  hooks: {
    kind: 'own', file: '.grok/hooks/sshweb-status.json', arg: 'grok',
    tip: '同时在 ~/.grok/pager.toml 设 alt_screen = "never"：照样填满屏幕，聊过的内容进终端历史，历史视图完整',
    events: [['SessionStart'], ['UserPromptSubmit'], ['Stop'], ['StopCancelled'], ['StopFailure'], ['SessionEnd'],
      ['PreToolUse', '.*'], ['PostToolUse', '.*'], ['PostToolUseFailure', '.*'], ['Notification']],
    toml: { file: '.grok/pager.toml', table: 'terminal', key: 'alt_screen', value: '"never"' },
    detect: ['.grok'],
  },

  // ---- 历史视图 (见 lib/session/remote.js 的 captureTmux)：全屏界面的完整对话不在终端历史里，从会话文件读。
  // x = { sftp, home, sid (钩子报的会话号), cwd }；找不到文件抛错 (网页就把滚轮交还给 Grok 自己翻)
  history: {
    async read(x) {
      const f = await sessionFile(x);
      if (!f) throw new Error('找不到 Grok 的会话文件');
      return render(await readTail(x.sftp, f));
    },
    render,
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
