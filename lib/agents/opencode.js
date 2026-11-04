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

const SshWebStatus = async ({ directory } = {}) => {
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

// 新旧 OpenCode 都要能加载：1.x 认 default 里的 server()；OpenCode 2 要 default 里有 id 和 setup() —— 它的插件跑在共用的后台服务里、
// 接口全换了，这里什么都不做 (状态由 SSH-WEB 认它报给终端的 OSC 7501)，只是让它加载成功、不弹「Plugin failed」
export default { id: 'sshweb-status', server: SshWebStatus, setup: async () => {} };
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
# OpenCode 2 (2.x 升级时把旧的对话都迁过去了，之后只写新表)：session_v2 + session_message (type = user / assistant / …，内容在 data)
V2 = bool(c.execute("select 1 from sqlite_master where type='table' and name='session_v2'").fetchone())
S = 'session_v2' if V2 else 'session'
def v2_msg(t, d):
    if t == 'user':
        return {'role': 'user', 'parts': [{'type': 'text', 'text': d['text']}] if d.get('text') else []}
    if t != 'assistant':
        return None
    parts = []
    for p in d.get('content') or []:
        if not isinstance(p, dict):
            continue
        k = p.get('type')
        if k == 'text' and p.get('text'):
            parts.append({'type': 'text', 'text': p['text']})
        elif k == 'reasoning' and p.get('text'):
            parts.append({'type': 'reasoning', 'text': p['text'][:600]})
        elif k == 'tool':
            st = p.get('state') if isinstance(p.get('state'), dict) else {}
            out = ''.join(x.get('text') or '' for x in (st.get('content') or []) if isinstance(x, dict)) or str(st.get('error') or st.get('output') or '')
            parts.append({'type': 'tool', 'tool': p.get('name', ''), 'input': st.get('input') or {}, 'title': st.get('title') or '', 'output': out[:4000]})
    return {'role': 'assistant', 'parts': parts}
def first_prompt(sid):
    if V2:
        for (md,) in c.execute("select data from session_message where session_id=? and type='user' order by seq limit 5", (sid,)).fetchall():
            if J(md).get('text'):
                return J(md)['text'][:2000]
        return ''
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
    rows = c.execute('select id, title, directory, time_updated from ' + S + ' where parent_id is null and time_archived is null order by time_updated desc limit ?', (scan if q else n,)).fetchall()
    like = '%' + q.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'
    k = 0
    for sid, title, d, tu in rows:
        if q and not (q.lower() in (title or '').lower() or q.lower() in (d or '').lower()
                      or c.execute("select 1 from " + ('session_message' if V2 else 'part') + " where session_id=? and data like ? escape '\\' limit 1", (sid, like)).fetchone()):
            continue
        print('@@ %d 0 %s#%s' % ((tu or 0) // 1000, db, sid))
        print('json\t' + json.dumps({'id': sid, 'title': title or '', 'directory': d or '', 'prompt': first_prompt(sid)}, ensure_ascii=False))
        k += 1
        if k >= n:
            break
elif mode == 'history':
    sid, cwd = sys.argv[3], sys.argv[4]
    if sid and not c.execute('select 1 from ' + S + ' where id=?', (sid,)).fetchone():
        sid = ''
    if not sid:
        r = c.execute('select id from ' + S + ' where parent_id is null and directory=? order by time_updated desc limit 1', (cwd,)).fetchone()
        r = r or c.execute('select id from ' + S + ' where parent_id is null order by time_updated desc limit 1').fetchone()
        sid = r[0] if r else ''
    msgs = []
    if V2:
        for t, md in c.execute('select type, data from session_message where session_id=? order by seq', (sid,)).fetchall():
            m = v2_msg(t, J(md))
            if m:
                msgs.append(m)
        print(json.dumps(msgs[-400:], ensure_ascii=False))
        sys.exit(0)
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
const TOOL_NAMES = { bash: '执行命令', shell: '执行命令', read: '读文件', write: '写文件', edit: '改文件', list: '列目录', glob: '找文件', grep: '搜索', webfetch: '读网页', websearch: '搜网页', todowrite: '待办', task: '子任务', question: '问你' };
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

// OpenCode 2 的一条消息 (session_message 的 type + data；opencode session export 导出的也是这个样子) → render() 用的样子。
// user：{ text }；assistant：{ content: [{ type: text / reasoning / tool (name、state.input、state.content) }] }；别的 (idle、system …) 不显示
function v2Msg(type, d) {
  if (!d || typeof d !== 'object') return null;
  if (type === 'user') return { role: 'user', parts: d.text ? [{ type: 'text', text: str(d.text) }] : [] };
  if (type !== 'assistant') return null;
  return { role: 'assistant', parts: (Array.isArray(d.content) ? d.content : []).map((c) => {
    if (!c || typeof c !== 'object') return null;
    if (c.type === 'text' && c.text) return { type: 'text', text: str(c.text) };
    if (c.type === 'reasoning' && c.text) return { type: 'reasoning', text: str(c.text).slice(0, 600) };
    if (c.type !== 'tool') return null;
    const st = c.state && typeof c.state === 'object' ? c.state : {};
    const out = (Array.isArray(st.content) ? st.content : []).map((x) => str(x?.text)).join('') || String(st.error || st.output || '');
    return { type: 'tool', tool: str(c.name), input: st.input || {}, title: str(st.title), output: out.slice(0, 4000) };
  }).filter(Boolean) };
}
// opencode export 导出的 { info, messages: [{ info: { role }, parts }] } 换成 render() 用的样子 (parts 和数据库里的一样)；
// OpenCode 2 (opencode session export) 的 messages 是 [{ type, … }]，见 v2Msg
function exportMsgs(d) {
  const all = Array.isArray(d?.messages) ? d.messages : [];
  if (all.some((m) => m && typeof m.type === 'string' && !m.info)) {
    const msgs = all.map((m) => v2Msg(m?.type, m)).filter(Boolean);
    if (!msgs.length) throw new Error('没有对话');
    return msgs;
  }
  const msgs = all.map((m) => ({ role: m?.info?.role, parts: (Array.isArray(m?.parts) ? m.parts : []).map((p) => {
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
  // OpenCode 2 是 opencode session export (没有 opencode export 了)，旧版只有 opencode export
  return jsonOf(await exec(`opencode session export ${id}`).catch(() => '').then((o) => (/[[{]/.test(o) ? o : exec(`opencode export ${id}`))));
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
// OpenCode 2 的数据库 (有 session_v2 表)：2.x 升级时把旧的对话都迁过去了，之后只写新表，读新表就行
const isV2 = (db) => !!db.prepare("select 1 from sqlite_master where type='table' and name='session_v2'").get();
function dbQuery(file, sid, cwd) {
  const db = new sqlite.DatabaseSync(file);
  try {
    const one = (sql, ...a) => db.prepare(sql).get(...a);
    const J = (v) => { try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
    const S = isV2(db) ? 'session_v2' : 'session';
    let id = sid && one(`select id from ${S} where id=?`, sid) ? sid : '';
    if (!id) {
      const norm = (v) => String(v || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
      const rows = db.prepare(`select id, directory from ${S} where parent_id is null order by time_updated desc limit 200`).all();
      id = (rows.find((r) => cwd && norm(r.directory) === norm(cwd)) || rows[0])?.id || '';
    }
    if (S === 'session_v2') {
      const msgs = db.prepare('select type, data from session_message where session_id=? order by seq').all(id).map((r) => v2Msg(r.type, J(r.data))).filter(Boolean);
      if (!msgs.length) throw new Error('没有对话');
      return msgs.slice(-400);
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
// 会话历史列表 (同上面 PY 的 list)：最近的主会话 [{ id, title, directory, prompt, tu }]；
// 有搜索词时在标题、目录、全部消息内容里搜 (LIKE，英文不分大小写)
function dbList(file, q, n, scan) {
  const db = new sqlite.DatabaseSync(file);
  try {
    const J = (v) => { try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
    const v2 = isV2(db);
    const msgs = db.prepare(v2 ? "select data from session_message where session_id=? and type='user' order by seq limit 5" : 'select id, data from message where session_id=? order by time_created limit 30');
    const partsOf = v2 ? null : db.prepare('select data from part where message_id=? order by time_created');
    const firstPrompt = (sid) => {
      if (v2) { for (const m of msgs.all(sid)) { const t = J(m.data).text; if (t) return str(t).slice(0, 2000); } return ''; }
      for (const m of msgs.all(sid)) {
        if (J(m.data).role !== 'user') continue;
        for (const r of partsOf.all(m.id)) { const p = J(r.data); if (p.type === 'text' && !p.synthetic && p.text) return str(p.text).slice(0, 2000); }
      }
      return '';
    };
    const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%', ql = q.toLowerCase();
    const inParts = db.prepare(`select 1 from ${v2 ? 'session_message' : 'part'} where session_id=? and data like ? escape '\\' limit 1`);
    const out = [];
    for (const r of db.prepare(`select id, title, directory, time_updated from ${v2 ? 'session_v2' : 'session'} where parent_id is null and time_archived is null order by time_updated desc limit ?`).all(q ? scan : n)) {
      if (q && !(str(r.title).toLowerCase().includes(ql) || str(r.directory).toLowerCase().includes(ql) || inParts.get(r.id, like))) continue;
      out.push({ id: str(r.id), title: str(r.title), directory: str(r.directory), prompt: firstPrompt(r.id), tu: Number(r.time_updated) || 0 });
      if (out.length >= n) break;
    }
    return out;
  } finally { db.close(); }
}
// -wal：刚聊的都在这里。平时只在末尾追加 (SQLite 把它并回主库后从头重写，开头 32 字节里的 salt 会变)：
// 没变 (大小、修改时间一样) 不拷；比上次大、开头没变只拷新增的那段；别的情况整个重拷。
// 以前每次打开历史视图都整个拷一遍，-wal 几 MB、主机又走隧道时要等好几秒 (11-03 用户说还是慢)
// 一段一段并行读 (每段 32KB，同时最多 16 段)：隧道一来一回要零点几秒，一段读完再读下一段，256KB 就要好几秒 (11-03 真机)
function readRange(sftp, file, start, len) {
  return new Promise((resolve, reject) => sftp.open(file, 'r', (e, h) => {
    if (e) return reject(e);
    const CH = 32768, buf = Buffer.alloc(len), offs = [];
    for (let o = 0; o < len; o += CH) offs.push(o);
    let i = 0, active = 0, end = len, failed = null;
    const finish = () => { sftp.close(h, () => {}); if (failed) reject(failed); else resolve(buf.subarray(0, end)); };
    const piece = (o, at, n) => sftp.read(h, buf, at, n, start + at, (e2, got) => {
      if (e2 || !got) { if (e2) failed = failed || e2; else end = Math.min(end, at); active--; return next(); }
      if (got < n) return piece(o, at + got, n - got); // 读到的比要的少：接着读这一段剩下的
      active--; next();
    });
    const next = () => {
      while (!failed && active < 16 && i < offs.length) { const o = offs[i++]; active++; piece(o, o, Math.min(CH, len - o)); }
      if (!active && (failed || i >= offs.length)) finish();
    };
    if (!len) return finish();
    next();
  }));
}
async function syncWal(sftp, c, remote, local, stat, get) {
  const st = await stat(remote);
  if (!st || !st.size) { c.wal = null; return false; }
  const sig = `${st.size}:${st.mtime}`;
  if (c.wal?.sig === sig && fs.existsSync(local)) return true;
  try {
    if (c.wal && st.size > c.wal.size && fs.existsSync(local) && typeof sftp.open === 'function') {
      const head = await readRange(sftp, remote, 0, 32);
      if (head.length === 32 && head.equals(c.wal.head)) {
        const add = await readRange(sftp, remote, c.wal.size, st.size - c.wal.size);
        if (add.length === st.size - c.wal.size) {
          fs.appendFileSync(local, add);
          c.wal = { sig, size: st.size, head };
          return true;
        }
      }
    }
  } catch {}
  c.wal = null;
  if (!(await get(remote, local).then(() => true, () => false))) return false;
  const fd = fs.openSync(local, 'r'), head = Buffer.alloc(32);
  try { fs.readSync(fd, head, 0, 32, 0); } finally { fs.closeSync(fd); }
  c.wal = { sig, size: st.size, head };
  return true;
}
// ---- 只拷变了的块：OpenCode 2 的数据库加 -wal 有几十 MB (后台服务一直开着，-wal 也不小)，每聊一句两个都变，
// 整个重拷走隧道要几十秒 (11-03 真机：会话列表 41 秒)。SQLite 一次只改几页：在主机上用 PowerShell 算每 64KB 一块的 MD5，
// 和服务器上缓存的那份比，只拷对不上的块。主机上的小脚本 blocks.ps1 用 SFTP 写一次 (不用 -EncodedCommand：Windows Defender 会报)
const BLOCK = 64 * 1024;
const BLOCKS_VER = 3; // 输出的第一行「V 版本」：主机上的脚本是旧的 (或者没有) 就重写一遍再跑，不用每次先读一遍文件
const BLOCKS_PS1 = `﻿# SSH-WEB：文件每 64KB 一块的 MD5 (只拷变了的块用，见 SSH-WEB 的 lib/agents/opencode.js)。每个文件输出「F 大小」再一行一个
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$files)
'V ${BLOCKS_VER}'
$md5 = [Security.Cryptography.MD5]::Create(); $buf = New-Object byte[] ${BLOCK}
foreach ($f in $files) {
  try { $s = [IO.File]::Open($f, 'Open', 'Read', 'ReadWrite, Delete') } catch { 'F -1'; continue }
  try {
    'F ' + $s.Length
    while ($true) {
      $n = 0; while ($n -lt $buf.Length) { $r = $s.Read($buf, $n, $buf.Length - $n); if ($r -le 0) { break }; $n += $r }
      if ($n -le 0) { break }
      [BitConverter]::ToString($md5.ComputeHash($buf, 0, $n)).Replace('-', '')
      if ($n -lt $buf.Length) { break }
    }
  } finally { $s.Dispose() }
}
`;
const md5Blocks = (file) => {
  const out = [], fd = fs.openSync(file, 'r'), buf = Buffer.alloc(BLOCK);
  try { for (let at = 0; ; at += BLOCK) { const n = fs.readSync(fd, buf, 0, BLOCK, at); if (!n) break; out.push(require('crypto').createHash('md5').update(buf.subarray(0, n)).digest('hex').toUpperCase()); if (n < BLOCK) break; } }
  finally { fs.closeSync(fd); }
  return out;
};
// pairs：[[主机上的路径 (SFTP 写法), 服务器上的缓存]]，缓存都要已经有了。成功返回 true (失败的话调用的人整个重拷)
async function blockSync({ sftp, home, exec }, c, pairs) {
  if (!exec || !pairs.length || !/^\/[A-Za-z]:/.test(home)) return false;
  const win = (p) => p.slice(1).replace(/\//g, '\\');
  const script = posix.join(home, '.ssh-web', 'blocks.ps1');
  if (pairs.some(([r]) => /["%]/.test(r))) return false;
  const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${win(script)}" ${pairs.map(([r]) => `"${win(r)}"`).join(' ')}`;
  let out = await exec(cmd).catch(() => '');
  if (!String(out).split(/\r?\n/).some((l) => l.trim() === `V ${BLOCKS_VER}`)) { // 主机上没有这个脚本 / 是旧版：写一遍再跑
    await new Promise((r) => sftp.mkdir(posix.dirname(script), () => r()));
    await new Promise((res, rej) => sftp.writeFile(script, BLOCKS_PS1, (e) => (e ? rej(e) : res())));
    out = await exec(cmd);
  }
  const files = [];
  for (const l of String(out).split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
    if (l.startsWith('V ')) continue;
    if (l.startsWith('F ')) files.push({ size: Number(l.slice(2)), hs: [] });
    else if (files.length && /^[0-9A-F]{32}$/.test(l)) files[files.length - 1].hs.push(l);
  }
  if (files.length !== pairs.length || files.some((f) => !(f.size >= 0) || f.hs.length !== Math.ceil(f.size / BLOCK))) return false;
  for (let k = 0; k < pairs.length; k++) {
    const [remote, local] = pairs[k], { size, hs } = files[k];
    const mine = md5Blocks(local);
    const diff = hs.map((h, i) => (mine[i] === h ? -1 : i)).filter((i) => i >= 0);
    const got = await Promise.all(diff.map(async (i) => { // 几块一起拷 (每块里面也是并行读的)
      const len = Math.min(BLOCK, size - i * BLOCK), b = await readRange(sftp, remote, i * BLOCK, len);
      return b.length === len ? b : null;
    }));
    if (got.some((b) => !b)) return false;
    const fd = fs.openSync(local, 'r+');
    try {
      diff.forEach((i, k) => fs.writeSync(fd, got[k], 0, got[k].length, i * BLOCK));
      fs.ftruncateSync(fd, size);
    } finally { fs.closeSync(fd); }
  }
  return true;
}
// 拷数据库 (见上面)，拷出来的一份交给 fn 查，查完删掉
// gentle：后台预先拷 (见 warmDb)，并发只开 4 路 —— 默认 64 路会把这条 SSH 连接的 SFTP 占满，
// 慢的网络上要拷好几分钟，这期间别的 Agent 的会话列表、文件管理都排着队 (11-04 真机：pi 的会话列表从 6 秒变成 73 秒)
async function withDb({ sftp, home, exec, gentle }, fn) {
  if (!sqlite || !sftp || !home) throw new Error('读不了');
  const c = cacheDir(sftp);
  const job = c.busy.then(async () => {
    const remote = posix.join(home, '.local/share/opencode/opencode.db');
    const stat = (f) => new Promise((r) => sftp.stat(f, (e, st) => r(e ? null : st)));
    const get = (from, to) => new Promise((res, rej) => (gentle ? sftp.fastGet(from, to, { concurrency: 4 }, (e) => (e ? rej(e) : res())) : sftp.fastGet(from, to, (e) => (e ? rej(e) : res()))));
    const [st, wst] = await Promise.all([stat(remote), stat(remote + '-wal')]); // 一起问 (隧道一来一回要零点几秒)
    if (!st) throw new Error('没有数据库');
    const main = path.join(c.dir, 'main.db'), wal = path.join(c.dir, 'main.wal');
    const sig = `${st.size}:${st.mtime}`;
    // 缓存过、又变了的：只拷变了的块 (主库、-wal 一起算，一次 PowerShell)；不行再走下面的整个拷 / -wal 追加
    const wsig = wst?.size ? `${wst.size}:${wst.mtime}` : '';
    const pairs = [];
    if (sig !== c.sig && c.sig && fs.existsSync(main)) pairs.push([remote, main]);
    if (wsig && c.wal && c.wal.sig !== wsig && fs.existsSync(wal)) pairs.push([remote + '-wal', wal]);
    if (pairs.length && await blockSync({ sftp, home, exec }, c, pairs).catch(() => false)) {
      if (pairs.some(([r]) => r === remote)) c.sig = sig;
      if (pairs.some(([r]) => r !== remote)) {
        const fd = fs.openSync(wal, 'r'), head = Buffer.alloc(32);
        try { fs.readSync(fd, head, 0, 32, 0); } finally { fs.closeSync(fd); }
        c.wal = { sig: wsig, size: wst.size, head };
      }
    }
    if (sig !== c.sig || !fs.existsSync(main)) { c.sig = ''; await get(remote, main); c.sig = sig; }
    const hasWal = await syncWal(sftp, c, remote + '-wal', wal, (f) => (f === remote + '-wal' ? Promise.resolve(wst) : stat(f)), get);
    const q = path.join(c.dir, 'q.db');
    for (const f of [q, q + '-wal', q + '-shm']) fs.rmSync(f, { force: true });
    fs.copyFileSync(main, q);
    if (hasWal) fs.copyFileSync(wal, q + '-wal');
    try { return fn(q); } finally { for (const f of [q, q + '-wal', q + '-shm']) fs.rmSync(f, { force: true }); }
  });
  c.busy = job.catch(() => {});
  return job;
}
const winDbRead = ({ sftp, home, exec, sid, cwd }) => withDb({ sftp, home, exec }, (q) => dbQuery(q, sid, cwd));
// 这条连接拷过数据库没有 (之后只拷变了的块，快)
const dbCached = (sftp) => !!DB_CACHE.get(sftp)?.sig;
// 在后台先把数据库拷过来 (第一次要整个拷：OpenCode 2 的库加 -wal 几十 MB，走手机网络 / 中转时要好几分钟)，下次直接读
const warmDb = (x) => { if (sqlite && x.sftp && x.home && !dbCached(x.sftp) && !warming.has(x.sftp)) { warming.add(x.sftp); withDb({ ...x, gentle: true }, () => 0).catch(() => {}).finally(() => warming.delete(x.sftp)); } };
const warming = new WeakSet(); // 正在后台拷的 (同一条连接只拷一份)
// OpenCode 2 的后台服务直接列出全部顶层对话 (一条命令，几秒；本机 0.6 秒)，不用拷数据库。没有第一句话 (标题是它自己起的)。
// 旧版没有 opencode api：抛错，照旧读数据库
async function apiList(exec, n) {
  const o = jsonOf(await exec(`opencode api session.list --param limit=${n | 0 || 50} --param parentID=null`));
  if (!Array.isArray(o?.data)) throw new Error('不是 OpenCode 2');
  return o.data.filter((x) => /^ses_[\w]+$/.test(x?.id || '')).map((x) => ({
    id: x.id, title: str(x.title), directory: str(x.location?.directory), prompt: '', tu: Number(x.time?.updated || x.time?.created) || 0 }));
}

module.exports = {
  id: 'opencode', name: 'OpenCode', short: 'OpenCode', tested: true, // OpenCode 1.19.5 实测过
  proc: ['opencode'],
  noEndEvent: true, // 退出时不报事件：终端回到 shell 提示符就算退出了 (见 lib/session/hooks.js 的 checkAgentGone)
  logo: true, // 常驻会话选择框里名字前面画它的标志 (SVG，见 public/app/09-agents.js 的 AGENT_LOGOS)

  // ---- 钩子：插件文件 (内容见上面的 PLUGIN；版本不一样算「旧版本」，重新安装覆盖)
  // ---- OpenCode 2 的屏幕 (状态信号 OSC 7501 只带对话标题，你说的话、回复、是不是被打断从屏幕上读，见 session/hooks.js 的 onProgramStatus)。
  // 最下面是输入框：一串「┃」，底边「╹▀▀▀」；上面是对话。你说的话是和输入框同色的「┃」框，工具输出是暗色的「┃」框 (实测 2.2.5)；
  // 每条回复后面一行页脚「Build · 模型 · 4.7s · 13.1 tok/s」，被打断的是「Build · 模型 · 7.7s · interrupted」。
  // lines：每行 { t: 字, fg: 第一个字的颜色 } (见 lib/status.js 的 screenLines)；认不出输入框返回 null
  events: {
    oscScreen(lines) {
      const BOX = /^\s*┃/, FOOT = /^\s+\S.*·\s*(\d+m\s*)?\d+(\.\d+)?s(\s*·.*)?\s*$/;
      let bot = -1;
      for (let i = lines.length - 1; i >= 0; i--) if (/^\s*╹▀/.test(lines[i].t)) { bot = i; break; }
      if (bot < 1 || !BOX.test(lines[bot - 1].t)) return null;
      const inFg = lines[bot - 1].fg;
      let top = bot - 1;
      while (top > 0 && BOX.test(lines[top - 1].t)) top--; // 输入框的顶
      // 最近一条你说的话：输入框上面、和输入框同色的最后一个「┃」框
      let ue = -1;
      for (let i = top - 1; i >= 0; i--) if (BOX.test(lines[i].t) && lines[i].fg === inFg) { ue = i; break; }
      let us = ue;
      while (us > 0 && BOX.test(lines[us - 1].t) && lines[us - 1].fg === inFg) us--;
      const prompt = ue < 0 ? '' : lines.slice(us, ue + 1).map((l) => l.t.replace(/^\s*┃\s?/, '').trim()).filter(Boolean).join(' ');
      // 它下面的页脚 (上面的是以前几轮的)
      let foot = -1;
      for (let i = top - 1; i > ue; i--) if (!BOX.test(lines[i].t) && FOOT.test(lines[i].t)) { foot = i; break; }
      // 回复：最后一个框 (你说的话 / 工具) 后面、页脚前面的字
      const end = foot >= 0 ? foot : top;
      let start = ue + 1;
      for (let i = end - 1; i > ue; i--) if (BOX.test(lines[i].t)) { start = i + 1; break; }
      // 屏幕上折行的接回一段、段落之间换行；跳过折起来的思考「+ Thought · 351ms」
      const paras = [];
      let cur = [];
      for (const l of lines.slice(start, end)) {
        const t = l.t.trim();
        if (t && !/^([+\-−▸▾]\s*)?(Thought|Thinking)\b/.test(t)) { cur.push(t); continue; }
        if (cur.length) paras.push(cur.join(' '));
        cur = [];
      }
      if (cur.length) paras.push(cur.join(' '));
      const reply = paras.join('\n');
      return { prompt, reply, footer: foot >= 0, interrupted: foot >= 0 && /·\s*interrupted\s*$/.test(lines[foot].t) };
    },
  },

  hooks: {
    kind: 'plugin', file: '.config/opencode/plugins/sshweb-status.js', plugin: PLUGIN,
    tip: '装的是插件（plugins 目录里的 sshweb-status.js）；OpenCode 2 不用插件报状态（认它报给终端的状态信号），插件只是加载时不报错',
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
    async sftp(x) { // Windows 主机：新版的数据库拷到服务器上读 (同历史视图，见上面的 withDb)，旧版的 JSON 用 SFTP 读
      const db = x.J('.local', 'share', 'opencode', 'opencode.db');
      const dx = { sftp: x.sftp, home: x.home, exec: x.exec };
      // 这条连接第一次列 (还没拷过数据库)、不是搜索：先用 OpenCode 2 的后台服务列出来 (几秒)，数据库在后台拷着，之后读数据库 (带第一句话)。
      // 以前第一次要等整个数据库拷完，走手机网络 / 中转时好几分钟 (11-04 真机)。搜索要查全部内容，还是读数据库
      let rows = !x.q && x.exec && !dbCached(x.sftp) ? await apiList(x.exec, x.MAX).catch(() => null) : null;
      if (rows) warmDb(dx);
      else rows = await withDb(dx, (q) => dbList(q, x.q, x.MAX, x.SCAN)).catch(() => []);
      for (const r of rows) x.push({ path: `${db}#${r.id}`, mtime: r.tu, size: 0, f: { json: [x.oneLn(JSON.stringify({ id: r.id, title: r.title, directory: r.directory, prompt: r.prompt }))] } });
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
    // OpenCode 2 导出是 opencode session export、导入是 opencode session import；旧版是 opencode export / import
    remove: (id, trash) => `mkdir -p '${trash}' && cd '${trash}' && { opencode session export ${id} 2>/dev/null || opencode export ${id} 2>/dev/null; } > session.json; `
      + `echo '用 opencode session import session.json (旧版 opencode import session.json) 可以找回这个会话' > 怎么找回.txt; opencode session delete ${id} >/dev/null 2>&1 && echo DELETED`,
    // Windows 主机 (SSH 默认 cmd 或 PowerShell，都交给 cmd 跑)：trash 是 C:\… 的写法，不带空格 (见 agent-sessions.js 的 removeSession)
    winRemove: (id, trash) => `cmd /c "(opencode session export ${id} 2>nul || opencode export ${id}) > ${trash}\\session.json && opencode session delete ${id} && echo DELETED"`,
  },

  // ---- 完整对话 (历史视图用)：OpenCode 是全屏界面 (没有关掉的设置)，终端历史里只有最后一屏；从数据库读完整的对话。
  // 主机上没有 python3：用它自己的命令 —— 没有对话号先 opencode session list 按目录挑 (挑不到用最近的)，再 opencode export 导出
  // (导出的是 { info, messages: [{ info: { role }, parts }] }，parts 和数据库里的一样)。没有对话号时按目录找、再不行用最近的对话
  history: {
    async read({ sftp, home, sid, cwd, run, exec, win }) {
      if (win) {
        // 还没拷过数据库 (第一次要整个拷，慢的网络上好几分钟)：先用 opencode 命令导出这一条对话来显示，数据库在后台拷着，之后读数据库 (快)
        if (!dbCached(sftp) && exec) {
          warmDb({ sftp, home, exec });
          const ex = await winExport({ sid, cwd, exec }).catch(() => null);
          let msgs = [];
          try { msgs = ex ? exportMsgs(ex) : []; } catch {}
          if (msgs.length) return render(msgs);
        }
        return render(await winDbRead({ sftp, home, exec, sid, cwd }).catch(async () => exportMsgs(await winExport({ sid, cwd, exec }))));
      }
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
printf 'EXPORT\\n'; opencode session export "$s" 2>/dev/null || opencode export "$s" 2>/dev/null`);
      const msgs = out.startsWith('EXPORT\n') ? exportMsgs(JSON.parse(out.slice(7))) : JSON.parse(out);
      if (!Array.isArray(msgs) || !msgs.length) throw new Error('没有对话');
      return render(msgs);
    },
  },
};

// 测试用 (test/opencode2.test.js)
module.exports._test = { dbList, dbQuery, exportMsgs, v2Msg, render, PY, blockSync, BLOCKS_PS1, BLOCK, withDb, readRange, apiList, dbCached };
