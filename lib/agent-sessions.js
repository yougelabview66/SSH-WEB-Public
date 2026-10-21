'use strict';
// Agent 会话历史 (参考 Orca)：列出目标主机上 Claude Code / Grok / Codex / Gemini CLI / OpenCode 以前的会话，
// 搜索，点「继续」在终端里执行恢复命令 (cd 到原来的目录 && claude --resume <id> 等)。
// 会话文件可能很大 (Claude 一个会话十几 MB)：在目标主机上用 sh / grep 只抽出标题、目录、第一句话、时间，不把文件传回来。
// Windows 主机 (cmd / PowerShell，没有 sh)：改用 SFTP，每个文件只读开头和结尾一段，抽出同样的字段；全文搜索分块读、有时间上限
// 除了 Claude Code 和 Grok，各家的会话格式是照着 Orca 的代码写的，没在真的 Agent 上测过

const { posix } = require('path');
const { liveSession } = require('./session');
const { sftpOf } = require('./sftp');

const MAX_LIST = 80; // 最多列出最近的这么多个
const SCAN = 300; // 搜索时最多看最近的这么多个会话文件
const OUT_MAX = 4 << 20;
const TIMEOUT = 20000;

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// 公共部分：j 字段 = 取第一个 "字段":"…" 的值 (原样保留转义，是一个 JSON 字符串)；jl = 取最后一个；
// hit 文件… = 有搜索词时文件里有没有 (不分大小写)；st 文件 = 修改时间 大小
const PRELUDE = String.raw`
j() { grep -m1 -oE "\"$1\"[[:space:]]*:[[:space:]]*\"([^\"\\\\]|\\\\.)*\"" | head -n 1 | sed "s/^\"$1\"[[:space:]]*:[[:space:]]*//"; }
jl() { grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"([^\"\\\\]|\\\\.)*\"" | tail -n 1 | sed "s/^\"$1\"[[:space:]]*:[[:space:]]*//"; }
hit() { [ -z "$Q" ] && return 0; grep -qiF -- "$Q" "$@" 2>/dev/null; }
st() { stat -c '%Y %s' -- "$1" 2>/dev/null || echo '0 0'; }
one() { tr '\n\r\t' '   '; }
`;

// 各家：会话文件在哪、抽哪些字段 (输出：「@@ 修改时间 大小 路径」开头一个会话，下面每行「字段<Tab>值」)、怎么继续
const AGENTS = {
  // ~/.claude/projects/<目录>/<会话 id>.jsonl (子 Agent 的在更深一层，不算)；标题优先用 /rename 起的名字，再是自动起的标题，再是第一句话
  claude: {
    name: 'Claude Code', tested: true,
    script: String.raw`
cd "$HOME/.claude/projects" 2>/dev/null || exit 0
ls -t -- */*.jsonl 2>/dev/null | head -n $SCAN | while IFS= read -r f; do hit "$f" && echo "$f"; done | head -n $N | while IFS= read -r f; do
  printf '@@ %s %s\n' "$(st "$f")" "$f"
  printf 'cwd\t%s\n' "$(j cwd < "$f")"
  printf 'ctitle\t%s\n' "$(tail -c 2000000 -- "$f" | jl customTitle)"
  v=$(tail -c 2000000 -- "$f" | jl aiTitle); [ -n "$v" ] || v=$(j aiTitle < "$f")
  printf 'title\t%s\n' "$v"
  printf 'prompt\t%s\n' "$(grep -m 30 -E '"role":"user","content":"' -- "$f" | grep -v '"isMeta":true' | grep -vE '"content":"(<|Caveat)' | head -n 1 | j content)"
done`,
    resume: (id) => `claude --resume ${id}`,
  },
  // ~/.grok/sessions/<目录>/<会话 id>/summary.json (info.id / info.cwd / generated_title)，第一句话在 chat_history.jsonl 的 <user_query> 里
  grok: {
    name: 'Grok', tested: true,
    script: String.raw`
cd "$HOME/.grok/sessions" 2>/dev/null || exit 0
ls -t -- */*/summary.json 2>/dev/null | head -n $SCAN | while IFS= read -r f; do d=$(dirname -- "$f"); hit "$f" "$d/chat_history.jsonl" && echo "$f"; done | head -n $N | while IFS= read -r f; do
  d=$(dirname -- "$f"); m="$d/chat_history.jsonl"; [ -f "$m" ] || m=$f
  printf '@@ %s %s\n' "$(st "$m")" "$f"
  printf 'json\t%s\n' "$(head -c 65536 -- "$f" | one)"
  printf 'rawprompt\t%s\n' "$(grep -m1 -oE '<user_query>([^<]|<[^/])*' -- "$d/chat_history.jsonl" 2>/dev/null | head -n 1 | sed 's/^<user_query>//')"
done`,
    resume: (id) => `grok --resume ${id}`,
  },
  // ~/.codex/sessions/年/月/日/rollout-….jsonl：第一行 session_meta 里有 id 和 cwd，你说的话是 user_message；
  // 起过名字的在 ~/.codex/session_index.jsonl (thread_name)
  codex: {
    name: 'Codex',
    script: String.raw`
cd "$HOME/.codex/sessions" 2>/dev/null || exit 0
ls -t -- */*/*/rollout-*.jsonl 2>/dev/null | head -n $SCAN | while IFS= read -r f; do hit "$f" && echo "$f"; done | head -n $N | while IFS= read -r f; do
  printf '@@ %s %s\n' "$(st "$f")" "$f"
  l=$(head -n 1 -- "$f")
  printf 'id\t%s\n' "$(printf '%s' "$l" | j id)"
  printf 'cwd\t%s\n' "$(printf '%s' "$l" | j cwd)"
  printf 'prompt\t%s\n' "$(grep -m1 '"type":"user_message"' -- "$f" | j message)"
done
tail -n 3000 "$HOME/.codex/session_index.jsonl" 2>/dev/null | while IFS= read -r l; do printf 'idx\t%s\n' "$l"; done`,
    resume: (id) => `codex resume ${id}`,
  },
  // ~/.gemini/tmp/<项目>/chats/session-….json(l)；有 .project_root 的话就是原来的目录 (没有就只能在原来的目录里自己执行)
  gemini: {
    name: 'Gemini CLI',
    script: String.raw`
cd "$HOME/.gemini/tmp" 2>/dev/null || exit 0
ls -t -- */chats/session-*.json */chats/session-*.jsonl 2>/dev/null | head -n $SCAN | while IFS= read -r f; do hit "$f" && echo "$f"; done | head -n $N | while IFS= read -r f; do
  printf '@@ %s %s\n' "$(st "$f")" "$f"
  printf 'raw\t%s\n' "$(head -c 60000 -- "$f" | one)"
  r=$(dirname -- "$(dirname -- "$f")")
  [ -f "$r/.project_root" ] && printf 'cwdraw\t%s\n' "$(head -c 4096 -- "$r/.project_root" | one)"
done`,
    resume: (id) => `gemini --resume ${id}`,
  },
  // ~/.local/share/opencode/storage/session/<项目>/<会话 id>.json (title / directory；有 parentID 的是子会话，不算)。
  // 新版 OpenCode 存在 SQLite 里，这里读不到
  opencode: {
    name: 'OpenCode',
    script: String.raw`
D=$XDG_DATA_HOME; [ -n "$D" ] || D=$HOME/.local/share
cd "$D/opencode/storage/session" 2>/dev/null || exit 0
ls -t -- */*.json 2>/dev/null | head -n $SCAN | while IFS= read -r f; do grep -q '"parentID"' -- "$f" && continue; hit "$f" && echo "$f"; done | head -n $N | while IFS= read -r f; do
  printf '@@ %s %s\n' "$(st "$f")" "$f"
  printf 'json\t%s\n' "$(head -c 65536 -- "$f" | one)"
done`,
    resume: (id) => `opencode --session ${id}`,
  },
};

const str = (v) => (typeof v === 'string' ? v : '');
// 「"…"」(JSON 字符串) → 文字；坏了就原样
const unq = (v) => { if (!v) return ''; try { return str(JSON.parse(v)); } catch { return v; } };
// JSON 字符串里面的内容 (没有外面的引号)
const unesc = (v) => { if (!v) return ''; try { return str(JSON.parse(`"${v}"`)); } catch { return v; } };
const parseJson = (v) => { try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : null; } catch { return null; } };
const oneLine = (s, n = 200) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
// 你说的话：去掉 Grok 的 <user_query> 包装、开头的 <system-reminder> 之类
const cleanPrompt = (s) => oneLine(String(s || '').replace(/<\/?user_query>/g, '').replace(/^(\s*<[a-z-]+>[\s\S]*?<\/[a-z-]+>)+/i, ''));

// 脚本输出 → [{ path, mtime, size, f: {字段: [值…]} }]
function parseOut(text) {
  const out = [];
  const extra = []; // 不属于某个会话的行 (Codex 的起名索引)
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('@@ ')) {
      const m = /^@@ (\d+) (\d+) (.*)$/.exec(line);
      if (m) out.push(cur = { mtime: +m[1] * 1000, size: +m[2], path: m[3], f: {} });
      continue;
    }
    const i = line.indexOf('\t');
    if (i <= 0) continue;
    const k = line.slice(0, i), v = line.slice(i + 1);
    if (k === 'idx') { extra.push(v); continue; }
    if (cur) (cur.f[k] ||= []).push(v);
  }
  return { out, extra };
}
const field = (r, k) => (r.f[k] || [])[0] || '';

// 各家的一条会话 → { id, title, prompt, cwd }
function toSession(agent, r, ctx) {
  const base = posix.basename(r.path);
  switch (agent) {
    case 'claude': {
      const prompt = cleanPrompt(unq(field(r, 'prompt')));
      return { id: base.replace(/\.jsonl$/, ''), title: oneLine(unq(field(r, 'ctitle')) || unq(field(r, 'title'))), prompt, cwd: unq(field(r, 'cwd')) };
    }
    case 'grok': {
      const o = parseJson(field(r, 'json')) || {};
      const info = o.info && typeof o.info === 'object' ? o.info : {};
      return { id: str(info.id) || posix.basename(posix.dirname(r.path)), title: oneLine(str(o.generated_title) || str(o.session_summary)),
        prompt: cleanPrompt(unesc(field(r, 'rawprompt'))), cwd: str(info.cwd) };
    }
    case 'codex': {
      const id = unq(field(r, 'id')) || (/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i.exec(base) || [])[1] || '';
      return { id, title: oneLine(ctx.codexNames.get(id) || ''), prompt: cleanPrompt(unq(field(r, 'prompt'))), cwd: unq(field(r, 'cwd')) };
    }
    case 'gemini': {
      const raw = field(r, 'raw');
      const id = unq((/"sessionId"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(raw) || [])[1]) || base.replace(/^session-|\.jsonl?$/g, '');
      // 第一条你发的消息 (content 是文字，或者 [{ text }])
      const um = /"type"\s*:\s*"user"[\s\S]{0,400}?"(?:content|text)"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(raw);
      return { id, title: '', prompt: cleanPrompt(unq(um && um[1])), cwd: oneLine(field(r, 'cwdraw'), 4096) };
    }
    case 'opencode': {
      const o = parseJson(field(r, 'json')) || {};
      return { id: str(o.id) || base.replace(/\.json$/, ''), title: oneLine(str(o.title)), prompt: '', cwd: str(o.directory) };
    }
    default: return null;
  }
}

// 在目标主机上执行脚本，拿输出 (单独开一个通道：会话文件多时要跑几秒，不占常驻通道)
function execOut(sess, script) {
  return new Promise((resolve, reject) => {
    if (!sess.ssh || sess.status !== 'connected') return reject(new Error('会话不存在或已断开'));
    sess.ssh.exec(`sh -c ${shq(script)}`, (err, ch) => {
      if (err) return reject(new Error('在目标主机上执行命令失败：' + err.message));
      const chunks = [];
      let len = 0;
      const timer = setTimeout(() => { try { ch.close(); } catch {} }, TIMEOUT);
      ch.on('data', (d) => { if (len < OUT_MAX) { chunks.push(d); len += d.length; } });
      ch.stderr.resume();
      ch.on('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    });
  });
}

// 恢复命令：cd 到原来的目录再继续。Linux sh / Windows cmd / PowerShell 写法不一样 (PowerShell 5 没有 &&，用 ;)
function resumeCmd(shell, cwd, cmd) {
  if (!cwd) return cmd;
  if (shell === 'cmd') return `cd /d "${cwd.replace(/\//g, '\\')}" && ${cmd}`;
  if (shell === 'powershell') return `cd '${cwd.replace(/'/g, "''")}'; ${cmd}`;
  return `cd ${shq(cwd)} && ${cmd}`;
}

async function list(sess, agent, q, inMux) {
  const a = AGENTS[agent];
  if (!a) throw new Error('不认识的 Agent');
  const query = String(q || '').slice(0, 200).replace(/[\r\n]/g, ' ');
  // 终端里的 shell (决定恢复命令的写法)；SSH 默认是 cmd / PowerShell 的就是 Windows 主机，用 SFTP 读
  const shell = await sess.termShell(!!inMux).catch(() => 'sh');
  const win = sess.shellOf && sess.shellOf.base !== 'sh';
  let out, extra, partial = false;
  if (win) {
    ({ out, extra, partial } = await scanSftp(sess, agent, query));
  } else {
    const script = `Q=${shq(query)}; N=${MAX_LIST}; SCAN=${SCAN}\n${PRELUDE}${a.script}\n`;
    ({ out, extra } = parseOut(await execOut(sess, script)));
  }
  const ctx = { codexNames: new Map() };
  for (const l of extra) {
    const o = parseJson(l);
    if (o && str(o.id) && str(o.thread_name)) ctx.codexNames.set(o.id, o.thread_name);
  }
  const sessions = [];
  for (const r of out) {
    const x = toSession(agent, r, ctx);
    if (!x || !/^[\w.-]{1,200}$/.test(x.id)) continue; // id 要拼进命令：只认字母数字和 . _ -
    if (agent === 'claude' && !x.title && !x.prompt) continue; // 只有 /clear 之类命令、没说过话的会话 (Claude 自己的 --resume 列表也不显示)
    sessions.push({ ...x, mtime: r.mtime, size: r.size, cmd: resumeCmd(shell, x.cwd, a.resume(x.id)) });
  }
  sessions.sort((x, y) => y.mtime - x.mtime);
  return { agent, name: a.name, tested: !!a.tested, q: query, sessions, more: out.length >= MAX_LIST, partial };
}

// ---- Windows 主机：用 SFTP 读 (抽出和 sh 脚本一样的字段，后面共用 toSession)
const SFTP_BUDGET = 15000; // 搜索最多花这么久，超时就只给已经搜到的
const pr = (fn) => new Promise((resolve, reject) => fn((e, v) => (e ? reject(e) : resolve(v))));
// "字段":"…" 的值 (原样的 JSON 字符串)：第一个 / 最后一个
const jre = (k) => new RegExp(`"${k}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`, 'g');
const jfirst = (t, k) => { const m = jre(k).exec(t); return m ? m[1] : ''; };
const jlast = (t, k) => { let m, v = ''; const re = jre(k); while ((m = re.exec(t))) v = m[1]; return v; };
const oneLn = (t) => t.replace(/[\r\n\t]/g, ' ');

async function scanSftp(sess, agent, q) {
  const sftp = await sftpOf(sess);
  const home = await pr((cb) => sftp.realpath('.', cb));
  const J = (...x) => posix.join(home, ...x);
  const ls = (dir) => pr((cb) => sftp.readdir(dir, cb)).catch(() => []);
  // 读一段 (从 start 开始最多 len 字节)
  const readPart = async (file, start, len) => {
    const h = await pr((cb) => sftp.open(file, 'r', cb));
    try {
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const n = await new Promise((resolve, reject) => sftp.read(h, buf, got, len - got, start + got, (e, nr) => (e ? reject(e) : resolve(nr))));
        if (!n) break;
        got += n;
      }
      return buf.subarray(0, got).toString('utf8');
    } finally { sftp.close(h, () => {}); }
  };
  const head = (f, n = 65536) => readPart(f.path, 0, Math.min(n, f.size)).catch(() => '');
  const tail = (f, n = 262144) => readPart(f.path, Math.max(0, f.size - n), Math.min(n, f.size)).catch(() => '');
  const file = (dir, e) => ({ path: posix.join(dir, e.filename), mtime: (e.attrs.mtime || 0) * 1000, size: e.attrs.size || 0 });
  const isDir = (e) => e.attrs.isDirectory();
  const deadline = Date.now() + SFTP_BUDGET;
  let partial = false;
  // 文件里有没有搜索词 (不分大小写；分块读，块之间留一段重叠)
  const ql = q.toLowerCase();
  const has = async (f) => {
    if (!q) return true;
    const CH = 1 << 20;
    for (let at = 0; at < f.size; at += CH - 512) {
      if (Date.now() > deadline) { partial = true; return false; }
      const t = await readPart(f.path, at, Math.min(CH, f.size - at)).catch(() => '');
      if (t.toLowerCase().includes(ql)) return true;
    }
    return false;
  };
  // 候选文件按修改时间排，搜索时逐个看 (最多 SCAN 个)，留下最近的 MAX_LIST 个
  const pick = async (files, test = has) => {
    files.sort((x, y) => y.mtime - x.mtime);
    const keep = [];
    for (const f of files.slice(0, SCAN)) {
      if (keep.length >= MAX_LIST || (partial && q)) break;
      if (await test(f)) keep.push(f);
    }
    return keep;
  };
  const out = [], extra = [];
  const rec = (f, fields) => out.push({ path: f.path, mtime: f.mtime, size: f.size, f: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, [v]])) });

  if (agent === 'claude') {
    const root = J('.claude', 'projects'), files = [];
    for (const d of (await ls(root)).filter(isDir)) {
      for (const e of await ls(posix.join(root, d.filename))) if (!isDir(e) && e.filename.endsWith('.jsonl')) files.push(file(posix.join(root, d.filename), e));
    }
    for (const f of await pick(files)) {
      const h = await head(f), t = await tail(f);
      const line = h.split('\n').find((l) => /"role":"user","content":"/.test(l) && !l.includes('"isMeta":true') && !/"content":"(<|Caveat)/.test(l)) || '';
      rec(f, { cwd: jfirst(h, 'cwd'), ctitle: jlast(t, 'customTitle'), title: jlast(t, 'aiTitle') || jfirst(h, 'aiTitle'), prompt: jfirst(line, 'content') });
    }
  } else if (agent === 'grok') {
    const root = J('.grok', 'sessions'), files = [];
    for (const d of (await ls(root)).filter(isDir)) {
      for (const s2 of (await ls(posix.join(root, d.filename))).filter(isDir)) {
        const dir = posix.join(root, d.filename, s2.filename);
        const ents = await ls(dir);
        const sum = ents.find((e) => e.filename === 'summary.json'), chat = ents.find((e) => e.filename === 'chat_history.jsonl');
        if (sum) files.push({ ...file(dir, sum), ...(chat ? { mtime: (chat.attrs.mtime || 0) * 1000 } : {}), chat: chat && file(dir, chat) });
      }
    }
    for (const f of await pick(files, async (x) => (await has(x)) || (!!x.chat && await has(x.chat)))) {
      const ch = f.chat ? await head(f.chat) : '';
      rec(f, { json: oneLn(await head(f)), rawprompt: ((/<user_query>((?:[^<]|<[^/])*)/.exec(ch) || [])[1] || '') });
    }
  } else if (agent === 'codex') {
    const root = J('.codex', 'sessions'), files = [];
    for (const y of (await ls(root)).filter(isDir)) for (const m of (await ls(posix.join(root, y.filename))).filter(isDir)) {
      for (const d of (await ls(posix.join(root, y.filename, m.filename))).filter(isDir)) {
        const dir = posix.join(root, y.filename, m.filename, d.filename);
        for (const e of await ls(dir)) if (/^rollout-.*\.jsonl$/.test(e.filename)) files.push(file(dir, e));
      }
    }
    for (const f of await pick(files)) {
      const h = await head(f, 262144);
      const first = h.split('\n')[0] || '';
      const um = h.split('\n').find((l) => l.includes('"type":"user_message"')) || '';
      rec(f, { id: jfirst(first, 'id'), cwd: jfirst(first, 'cwd'), prompt: jfirst(um, 'message') });
    }
    const idx = (await ls(J('.codex'))).find((e) => e.filename === 'session_index.jsonl');
    if (idx) extra.push(...(await tail(file(J('.codex'), idx), 1 << 20)).split('\n').filter(Boolean));
  } else if (agent === 'gemini') {
    const root = J('.gemini', 'tmp'), files = [];
    for (const d of (await ls(root)).filter(isDir)) {
      const chats = posix.join(root, d.filename, 'chats');
      for (const e of await ls(chats)) if (/^session-.*\.jsonl?$/.test(e.filename)) files.push({ ...file(chats, e), proj: posix.join(root, d.filename, '.project_root') });
    }
    for (const f of await pick(files)) {
      const pr0 = await readPart(f.proj, 0, 4096).catch(() => '');
      rec(f, { raw: oneLn(await head(f, 60000)), ...(pr0 ? { cwdraw: oneLn(pr0) } : {}) });
    }
  } else if (agent === 'opencode') {
    const root = J('.local', 'share', 'opencode', 'storage', 'session'), files = [];
    for (const d of (await ls(root)).filter(isDir)) {
      for (const e of await ls(posix.join(root, d.filename))) if (e.filename.endsWith('.json')) files.push(file(posix.join(root, d.filename), e));
    }
    const heads = new Map();
    const notKid = async (f) => { const t = await head(f); heads.set(f.path, t); return !t.includes('"parentID"') && (await has(f)); };
    for (const f of await pick(files, notKid)) rec(f, { json: oneLn(heads.get(f.path) || '') });
  }
  return { out, extra, partial };
}

function registerAgentSessions(app) {
  app.post('/api/agent-sessions', async (req, res) => {
    const s = liveSession(String(req.body?.sid || ''));
    if (!s) return res.status(404).json({ error: '会话不存在或已断开' });
    try {
      res.json(await list(s, String(req.body?.agent || 'claude'), req.body?.q, req.body?.inMux));
    } catch (e) {
      res.status(400).json({ error: e.message || String(e) });
    }
  });
}

module.exports = { registerAgentSessions, list, AGENTS: Object.fromEntries(Object.entries(AGENTS).map(([k, v]) => [k, { name: v.name, tested: !!v.tested }])) };
