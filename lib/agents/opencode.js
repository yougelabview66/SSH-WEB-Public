'use strict';
// OpenCode：装的是一个插件 (~/.config/opencode/plugins/sshweb-status.js)；会话新版在 ~/.local/share/opencode/opencode.db (SQLite)，
// 旧版在 ~/.local/share/opencode/storage/session/<项目>/<会话 id>.json。钩子、会话历史、历史视图在 OpenCode 1.19.5 上实测过
const fs = require('fs');
const os = require('os');
const path = require('path');
const { posix } = path;
const { str, unq, parseJson, field, oneLine, cleanPrompt } = require('./util');
const { C, BAR, markdown } = require('./transcript');

// OpenCode 不用钩子配置，用插件 (放进 ~/.config/opencode/plugins/ 自动加载)：把它的事件换成和别的 Agent 一样的几种，交给同一个 hook.sh
const PLUGIN = `// SSH-WEB 的 OpenCode 状态插件 (由 SSH-WEB 安装；卸载请在 SSH-WEB 里点「⋯ 更多 → 钩子通知」)
// 把 OpenCode 开始干活、要权限、问问题、做完、出错交给 ~/.ssh-web/hook.sh，写进 ~/.cache/ssh-web/hook.log，SSH-WEB 实时读取
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const WIN = process.platform === 'win32';
const SCRIPT = join(homedir(), '.ssh-web', WIN ? 'hook.ps1' : 'hook.sh');
function send(ev) {
  try {
    const p = WIN ? spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, 'opencode'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
      : spawn('sh', [SCRIPT, 'opencode'], { stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', () => {});
    p.stdin.on('error', () => {});
    p.stdin.end(JSON.stringify(ev));
  } catch {}
}
const cut = (s) => String(s || '').slice(0, 2000);
const remember = (set, v) => { set.add(v); if (set.size > 500) set.delete(set.values().next().value); };

export const SshWebStatus = async ({ directory } = {}) => {
  const child = new Set(); // 子会话 (子 Agent) 不算主会话的状态
  const role = new Map(); // 消息 id → user / assistant
  const seen = new Set(); // 报过的用户消息 / 工具调用
  let busy = false, lastText = '', failed = '', aborted = false, cur = ''; // cur：在聊的主会话 (报给 SSH-WEB 当对话号，历史视图按它读完整对话)
  const post = (ev) => send(Object.assign(ev, cur ? { session_id: cur } : {}, directory ? { cwd: directory } : {}));
  const done = () => {
    if (!busy) return;
    busy = false;
    post(aborted ? { hook_event_name: 'Interrupt' } : failed ? { hook_event_name: 'StopFailure', error: cut(failed) } : { hook_event_name: 'Stop', last_assistant_message: cut(lastText) });
    failed = ''; aborted = false;
  };
  return {
    event: async ({ event }) => {
      try {
        const t = event && event.type, pr = (event && event.properties) || {}, info = pr.info || {};
        if ((t === 'session.created' || t === 'session.updated') && info.id && info.parentID) remember(child, info.id);
        const sid = pr.sessionID || (pr.part && pr.part.sessionID) || info.sessionID;
        if (sid && child.has(sid)) return;
        if (sid) cur = sid;
        if (t === 'message.updated' && info.id) {
          role.set(info.id, info.role);
          if (role.size > 500) role.delete(role.keys().next().value);
        } else if (t === 'message.part.updated') {
          const part = pr.part || {};
          if (part.type === 'text' && part.text) {
            const r = role.get(part.messageID);
            if (r === 'user' && !part.synthetic && !seen.has(part.messageID)) {
              remember(seen, part.messageID);
              busy = true; lastText = ''; failed = ''; aborted = false;
              post({ hook_event_name: 'UserPromptSubmit', prompt: cut(part.text) });
            } else if (r === 'assistant') lastText = part.text;
          } else if (part.type === 'tool' && part.state && part.state.status === 'running' && part.callID && !seen.has(part.callID)) {
            remember(seen, part.callID);
            const inp = part.state.input || {};
            post({ hook_event_name: 'PreToolUse', tool_name: part.tool, command: inp.command, file_path: inp.filePath || inp.file_path, url: inp.url });
          }
        } else if (t === 'permission.asked' || t === 'permission.updated') {
          const m = pr.metadata || {};
          post({ hook_event_name: 'PermissionRequest', tool_name: pr.permission || pr.type || pr.tool, command: m.command || pr.title || (pr.patterns || []).join(' '), file_path: m.filepath || m.filePath });
        } else if (t === 'question.asked') {
          const q = (pr.questions || [])[0] || {};
          post({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', question: q.question || q.header || '' });
        } else if (t === 'session.status') {
          const st = pr.status && pr.status.type;
          if (st === 'busy' && !busy) { busy = true; post({ hook_event_name: 'UserPromptSubmit' }); }
          else if (st === 'idle') done();
        } else if (t === 'session.idle') {
          done();
        } else if (t === 'session.error') {
          const e = pr.error || {};
          if (e.name === 'MessageAbortedError') aborted = true; // 你按 Esc 打断的
          else failed = (e.data && e.data.message) || e.name || '出错了';
        }
      } catch {}
    },
  };
};
`;

// 主机上查 SQLite 用的 python (只读打开；python3 自带 sqlite3)：
//   list <db> <N> <SCAN> <搜索词>：最近的主会话，每个输出「@@ 更新时间 0 db#id」和 json (id / title / directory / 你说的第一句话)；
//     有搜索词时在标题、目录、全部消息内容里搜 (LIKE，英文不分大小写)
//   history <db> <会话 id> <目录>：这个会话的全部消息 (JSON)；没给会话 id 就用这个目录里最近的
// 消息 message.data 里有 role；内容在 part.data：text (synthetic 是系统加的)、reasoning、tool (state.input / output / error)
const PY = String.raw`
import sys, json, sqlite3
mode, db = sys.argv[1], sys.argv[2]
c = sqlite3.connect('file:' + db + '?mode=ro', uri=True, timeout=5)
def J(s):
    try:
        v = json.loads(s)
        return v if isinstance(v, dict) else {}
    except Exception:
        return {}
def first_prompt(sid):
    for mid, md in c.execute('select id, data from message where session_id=? order by time_created limit 30', (sid,)).fetchall():
        if J(md).get('role') != 'user':
            continue
        for (pd,) in c.execute('select data from part where message_id=? order by time_created', (mid,)).fetchall():
            p = J(pd)
            if p.get('type') == 'text' and not p.get('synthetic') and p.get('text'):
                return p['text'][:2000]
    return ''
if mode == 'list':
    n, scan, q = int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
    rows = c.execute('select id, title, directory, time_updated from session where parent_id is null and time_archived is null order by time_updated desc limit ?', (scan if q else n,)).fetchall()
    like = '%' + q.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'
    k = 0
    for sid, title, d, tu in rows:
        if q and not (q.lower() in (title or '').lower() or q.lower() in (d or '').lower()
                      or c.execute("select 1 from part where session_id=? and data like ? escape '\\' limit 1", (sid, like)).fetchone()):
            continue
        print('@@ %d 0 %s#%s' % ((tu or 0) // 1000, db, sid))
        print('json\t' + json.dumps({'id': sid, 'title': title or '', 'directory': d or '', 'prompt': first_prompt(sid)}, ensure_ascii=False))
        k += 1
        if k >= n:
            break
elif mode == 'history':
    sid, cwd = sys.argv[3], sys.argv[4]
    if not sid:
        r = c.execute('select id from session where parent_id is null and directory=? order by time_updated desc limit 1', (cwd,)).fetchone()
        r = r or c.execute('select id from session where parent_id is null order by time_updated desc limit 1').fetchone()
        sid = r[0] if r else ''
    msgs = []
    for mid, md in c.execute('select id, data from message where session_id=? order by time_created', (sid,)).fetchall():
        parts = []
        for (pd,) in c.execute('select data from part where message_id=? order by time_created', (mid,)).fetchall():
            p = J(pd)
            t = p.get('type')
            if t == 'text' and p.get('text') and not p.get('synthetic'):
                parts.append({'type': 'text', 'text': p['text']})
            elif t == 'reasoning' and p.get('text'):
                parts.append({'type': 'reasoning', 'text': p['text'][:600]})
            elif t == 'tool':
                st = p.get('state') if isinstance(p.get('state'), dict) else {}
                parts.append({'type': 'tool', 'tool': p.get('tool', ''), 'input': st.get('input') or {}, 'title': st.get('title') or '',
                              'output': str(st.get('output') or st.get('error') or '')[:4000]})
        msgs.append({'role': J(md).get('role'), 'parts': parts})
    print(json.dumps(msgs[-400:], ensure_ascii=False))
`;

// 完整对话 → 带颜色的文字 (同 Grok 的排法，见 grok.js 的 render)
const RESULT_LINES = 12;
const TOOL_NAMES = { bash: '执行命令', read: '读文件', write: '写文件', edit: '改文件', list: '列目录', glob: '找文件', grep: '搜索', webfetch: '读网页', websearch: '搜网页', todowrite: '待办', task: '子任务', question: '问你' };
function render(msgs) {
  const out = [];
  const blank = () => { if (out.length && out[out.length - 1] !== '') out.push(''); };
  for (const m of msgs) {
    for (const p of Array.isArray(m.parts) ? m.parts : []) {
      if (m.role === 'user' && p.type === 'text') {
        if (out.length) { blank(); out.push(`${C.dim}${'━'.repeat(40)}${C.off}`); }
        str(p.text).trim().split('\n').forEach((l, i) => out.push(`${C.bold}${i ? '  ' : '❯ '}${l}${C.off}`));
        out.push('');
      } else if (p.type === 'reasoning') {
        out.push(`${C.dim}◆ ${oneLine(p.text, 160)}${C.off}`);
      } else if (p.type === 'tool') {
        const a = p.input && typeof p.input === 'object' ? p.input : {};
        const what = str(a.description) || str(a.filePath) || str(a.path) || str(a.pattern) || str(a.url) || str(a.query) || (a.command ? '' : str(p.title));
        out.push(`${C.cyan}◈ ${TOOL_NAMES[p.tool] || p.tool}${what ? `${C.off}  ${oneLine(what, 300)}` : ''}${C.off}`);
        if (a.command) out.push(`${BAR} ${C.dim}$ ${oneLine(a.command, 1000)}${C.off}`);
        const lines = str(p.output).replace(/\s+$/, '').split('\n').filter((l, i, all) => all.length > 1 || l);
        for (const l of lines.slice(0, RESULT_LINES)) out.push(`${BAR} ${C.dim}${l}${C.off}`);
        if (lines.length > RESULT_LINES) out.push(`${BAR} ${C.dim}… 还有 ${lines.length - RESULT_LINES} 行${C.off}`);
      } else if (p.type === 'text') {
        blank(); out.push(...markdown(str(p.text).trim())); out.push('');
      }
    }
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}

// opencode export 导出的 { info, messages: [{ info: { role }, parts }] } 换成 render() 用的样子 (parts 和数据库里的一样)
function exportMsgs(d) {
  const msgs = (Array.isArray(d?.messages) ? d.messages : []).map((m) => ({ role: m?.info?.role, parts: (Array.isArray(m?.parts) ? m.parts : []).map((p) => {
    const st = p?.state && typeof p.state === 'object' ? p.state : {};
    if (p?.type === 'text' && !p.synthetic) return { type: 'text', text: str(p.text) };
    if (p?.type === 'reasoning') return { type: 'reasoning', text: str(p.text).slice(0, 600) };
    if (p?.type === 'tool') return { type: 'tool', tool: str(p.tool), input: st.input || {}, title: str(st.title), output: String(st.output || st.error || '').slice(0, 4000) };
    return null;
  }).filter(Boolean) }));
  if (!msgs.length) throw new Error('没有对话');
  return msgs;
}
// 输出里的 JSON (前面可能夹着别的提示)：从第一个 { 或 [ 开始
const jsonOf = (out) => JSON.parse(String(out).slice(Math.max(0, String(out).search(/[[{]/))));
// Windows 主机 (读不了数据库时，见下面的 winDbRead)：没有 sh / python3，用 OpenCode 自己的命令 (exec 直接交给主机上的 cmd / PowerShell 执行)。
// 没有对话号先 opencode session list 按目录挑 (目录不分大小写、\ 和 / 一样)，挑不到用最近的，再 opencode export 导出
async function winExport({ sid, cwd, exec }) {
  if (!exec) throw new Error('读不了');
  let id = /^[\w-]+$/.test(sid || '') ? sid : '';
  if (!id) {
    const list = jsonOf(await exec('opencode session list --format json -n 30'));
    const norm = (v) => String(v || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    const hit = (Array.isArray(list) ? list : []).filter((x) => /^[\w-]+$/.test(x?.id || ''));
    id = (hit.find((x) => cwd && norm(x.directory) === norm(cwd)) || hit[0])?.id;
    if (!id) throw new Error('没有对话');
  }
  return jsonOf(await exec(`opencode export ${id}`));
}

// ---- Windows 主机直接读数据库：每次启动 opencode 命令要好几秒 (session list + export 两次，Windows 上更慢)，
// 改成 SFTP 把 opencode.db 和 opencode.db-wal 拷到服务器上，用 Node 自带的 SQLite (node:sqlite，Node 22.5 起有) 读。
// 主库只在 OpenCode 把记录并进去时才变，按大小和修改时间缓存 (每个 SSH 连接一份，连接断了删掉)；
// 刚聊的在 -wal 里，每次都重新拷 (一般不大)。每次查询另拷一份再打开 (SQLite 关库时会把 -wal 并进主库，不能动缓存的那份)。
// 读不了 (Node 太旧、没有数据库、拷到一半的坏文件) 再用 opencode 命令
let sqlite = null;
try { sqlite = require('node:sqlite'); } catch {}
const DB_CACHE = new WeakMap(); // sftp → { dir, sig, busy }
let cacheRoot = '';
function cacheDir(sftp) {
  let c = DB_CACHE.get(sftp);
  if (c) return c;
  if (!cacheRoot) {
    cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-opencode-'));
    process.once('exit', () => { try { fs.rmSync(cacheRoot, { recursive: true, force: true }); } catch {} });
  }
  c = { dir: fs.mkdtempSync(path.join(cacheRoot, 'h-')), sig: '', busy: Promise.resolve() };
  DB_CACHE.set(sftp, c);
  sftp.once?.('close', () => { try { fs.rmSync(c.dir, { recursive: true, force: true }); } catch {} });
  return c;
}
function dbQuery(file, sid, cwd) {
  const db = new sqlite.DatabaseSync(file);
  try {
    const one = (sql, ...a) => db.prepare(sql).get(...a);
    const J = (v) => { try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
    let id = sid && one('select id from session where id=?', sid) ? sid : '';
    if (!id) {
      const norm = (v) => String(v || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
      const rows = db.prepare('select id, directory from session where parent_id is null order by time_updated desc limit 200').all();
      id = (rows.find((r) => cwd && norm(r.directory) === norm(cwd)) || rows[0])?.id || '';
    }
    const partsOf = db.prepare('select data from part where message_id=? order by time_created');
    const msgs = db.prepare('select id, data from message where session_id=? order by time_created').all(id).map((m) => ({ role: J(m.data).role, parts: partsOf.all(m.id).map((r) => {
      const p = J(r.data), st = p.state && typeof p.state === 'object' ? p.state : {};
      if (p.type === 'text' && p.text && !p.synthetic) return { type: 'text', text: str(p.text) };
      if (p.type === 'reasoning' && p.text) return { type: 'reasoning', text: str(p.text).slice(0, 600) };
      if (p.type === 'tool') return { type: 'tool', tool: str(p.tool), input: st.input || {}, title: str(st.title), output: String(st.output || st.error || '').slice(0, 4000) };
      return null;
    }).filter(Boolean) }));
    if (!msgs.length) throw new Error('没有对话');
    return msgs.slice(-400);
  } finally { db.close(); }
}
async function winDbRead({ sftp, home, sid, cwd }) {
  if (!sqlite || !sftp || !home) throw new Error('读不了');
  const c = cacheDir(sftp);
  const job = c.busy.then(async () => {
    const remote = posix.join(home, '.local/share/opencode/opencode.db');
    const stat = (f) => new Promise((r) => sftp.stat(f, (e, st) => r(e ? null : st)));
    const get = (from, to) => new Promise((res, rej) => sftp.fastGet(from, to, (e) => (e ? rej(e) : res())));
    const st = await stat(remote);
    if (!st) throw new Error('没有数据库');
    const main = path.join(c.dir, 'main.db'), wal = path.join(c.dir, 'main.wal');
    const sig = `${st.size}:${st.mtime}`;
    if (sig !== c.sig || !fs.existsSync(main)) { c.sig = ''; await get(remote, main); c.sig = sig; }
    const hasWal = !!(await stat(remote + '-wal')) && await get(remote + '-wal', wal).then(() => true, () => false);
    const q = path.join(c.dir, 'q.db');
    for (const f of [q, q + '-wal', q + '-shm']) fs.rmSync(f, { force: true });
    fs.copyFileSync(main, q);
    if (hasWal) fs.copyFileSync(wal, q + '-wal');
    try { return dbQuery(q, sid, cwd); } finally { for (const f of [q, q + '-wal', q + '-shm']) fs.rmSync(f, { force: true }); }
  });
  c.busy = job.catch(() => {});
  return job;
}

module.exports = {
  id: 'opencode', name: 'OpenCode', short: 'OpenCode', tested: true, // OpenCode 1.19.5 实测过
  proc: ['opencode'],
  logo: true, // 常驻会话选择框里名字前面画它的标志 (SVG，见 public/app/09-agents.js 的 AGENT_LOGOS)

  // ---- 钩子：插件文件 (内容见上面的 PLUGIN；版本不一样算「旧版本」，重新安装覆盖)
  hooks: {
    kind: 'plugin', file: '.config/opencode/plugins/sshweb-status.js', plugin: PLUGIN,
    tip: '装的是插件（plugins 目录里的 sshweb-status.js）',
    detect: ['.config/opencode', '.local/share/opencode'],
  },

  // ---- 会话历史。新版 (实测 1.19.5) 存在 SQLite：~/.local/share/opencode/opencode.db (session / message / part 三张表)，
  // 在主机上用 python3 自带的 sqlite3 只读查 (见上面的 PY)；没有 python3 用 opencode session list (没有第一句话、只按标题搜)；
  // 旧版每个会话一个 JSON：storage/session/<项目>/<会话 id>.json。有 parentID / parent_id 的是子会话，不算。
  // 存在数据库里的会话，路径记成「数据库#会话 id」(删除、查占用见 agent-sessions.js 的 inBox)
  sessions: {
    mark: '/opencode/',
    script: String.raw`
D=$XDG_DATA_HOME; [ -n "$D" ] || D=$HOME/.local/share
db="$D/opencode/opencode.db"
if [ -f "$db" ] && command -v python3 >/dev/null 2>&1 && python3 -c 'import sqlite3' 2>/dev/null; then
  python3 -I -c "$OCPY" list "$db" "$N" "$SCAN" "$Q"
elif [ -f "$db" ] && command -v opencode >/dev/null 2>&1; then
  opencode session list --format json -n "$SCAN" 2>/dev/null | awk -v db="$db" -v q="$Q" -v n="$N" '
    function val(s) { sub(/^[^:]*:[[:space:]]*/, "", s); sub(/,[[:space:]]*$/, "", s); return s }
    /"id":/ { id = val($0); gsub(/"/, "", id) } /"title":/ { t = val($0) } /"updated":/ { u = val($0) + 0 }
    /"directory":/ { d = val($0); if ((q == "" || index(tolower(t), tolower(q))) && k < n + 0) { k++; printf "@@ %d 0 %s#%s\ntitle\t%s\ncwd\t%s\n", u / 1000, db, id, t, d } }'
fi
cd "$D/opencode/storage/session" 2>/dev/null || exit 0
ls -t -- */*.json 2>/dev/null | head -n $SCAN | while IFS= read -r f; do grep -q '"parentID"' -- "$f" && continue; hit "$f" && echo "$f"; done | head -n $N | while IFS= read -r f; do
  printf '@@ %s %s\n' "$(st "$f")" "$PWD/$f"
  printf 'json\t%s\n' "$(head -c 65536 -- "$f" | one)"
done`,
    env: { OCPY: PY }, // 脚本里用的 python 程序 (agent-sessions.js 把它放进环境变量)
    async sftp(x) { // Windows 主机：只读得了旧版的 JSON (SQLite 用 SFTP 读不了)
      const files = await x.filesIn(await x.subdirs([x.J('.local', 'share', 'opencode', 'storage', 'session')]), (n) => n.endsWith('.json'));
      const heads = new Map();
      const notKid = async (f) => { const t = await x.head(f); heads.set(f.path, t); return !t.includes('"parentID"') && (await x.has(f)); };
      await x.collect(await x.pick(files, notKid), async (f) => ({ json: x.oneLn(heads.get(f.path) ?? await x.head(f)) }));
    },
    parse(r) {
      const o = parseJson(field(r, 'json'));
      const inDb = r.path.includes('#'), id0 = inDb ? r.path.slice(r.path.lastIndexOf('#') + 1) : posix.basename(r.path).replace(/\.json$/, '');
      if (!o) return { id: id0, title: oneLine(unq(field(r, 'title'))), prompt: '', cwd: unq(field(r, 'cwd')) }; // opencode session list
      return { id: str(o.id) || id0, title: oneLine(str(o.title)), prompt: cleanPrompt(str(o.prompt)), cwd: str(o.directory) };
    },
    resume: (id) => `opencode --session ${id}`,
    // 删除：旧版一起移走消息目录；数据库里的先导出一份到回收站 (opencode import 能找回)，再用 opencode 自己的命令删
    items: (file, id) => [file, posix.join(posix.dirname(posix.dirname(posix.dirname(file))), 'message', id)],
    remove: (id, trash) => `mkdir -p '${trash}' && cd '${trash}' && opencode export ${id} > session.json 2>/dev/null; `
      + `echo '用 opencode import session.json 可以找回这个会话' > 怎么找回.txt; opencode session delete ${id} >/dev/null 2>&1 && echo DELETED`,
  },

  // ---- 完整对话 (历史视图用)：OpenCode 是全屏界面 (没有关掉的设置)，终端历史里只有最后一屏；从数据库读完整的对话。
  // 主机上没有 python3：用它自己的命令 —— 没有对话号先 opencode session list 按目录挑 (挑不到用最近的)，再 opencode export 导出
  // (导出的是 { info, messages: [{ info: { role }, parts }] }，parts 和数据库里的一样)。没有对话号时按目录找、再不行用最近的对话
  history: {
    async read({ sftp, home, sid, cwd, run, exec, win }) {
      if (win) return render(await winDbRead({ sftp, home, sid, cwd }).catch(async () => exportMsgs(await winExport({ sid, cwd, exec }))));
      if (!run) throw new Error('读不了');
      const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
      const out = await run(`D=$XDG_DATA_HOME; [ -n "$D" ] || D=$HOME/.local/share; db="$D/opencode/opencode.db"
if [ -f "$db" ] && command -v python3 >/dev/null 2>&1 && python3 -c 'import sqlite3' 2>/dev/null; then
  exec python3 -I -c ${q(PY)} history "$db" ${q(sid)} ${q(cwd)}
fi
command -v opencode >/dev/null 2>&1 || exit 3
s=${q(sid)}
[ -n "$s" ] || s=$(opencode session list --format json -n 30 2>/dev/null | awk -v d=${q(cwd)} '
  /"id":/ { i = $0; sub(/^[^:]*:[[:space:]]*"/, "", i); sub(/".*$/, "", i); if (f == "") f = i }
  /"directory":/ { x = $0; sub(/^[^:]*:[[:space:]]*"/, "", x); sub(/"[[:space:]]*,?[[:space:]]*$/, "", x); if (x == d && m == "") m = i }
  END { print (m != "" ? m : f) }')
[ -n "$s" ] || exit 4
printf 'EXPORT\\n'; opencode export "$s" 2>/dev/null`);
      const msgs = out.startsWith('EXPORT\n') ? exportMsgs(JSON.parse(out.slice(7))) : JSON.parse(out);
      if (!Array.isArray(msgs) || !msgs.length) throw new Error('没有对话');
      return render(msgs);
    },
  },
};
