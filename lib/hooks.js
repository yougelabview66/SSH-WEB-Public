'use strict';
// Agent 钩子 (参考 Orca 的做法)：在目标主机上给 Claude Code / Grok / Codex / Gemini CLI / Antigravity / OpenCode 装上 SSH-WEB 的钩子，
// Agent 开始干活、要权限、问问题、做完、出错时，钩子把事件追加到目标主机的 ~/.cache/ssh-web/hook.log，
// SSH-WEB 借连着的 SSH 连接实时读 (见 session/hooks.js)：状态更准、推送写得出具体内容、安卓通知上能直接「允许 / 拒绝」(Claude Code)。
// 只在网页上点「安装」并确认后才改目标主机；原有的设置和你自己的钩子都保留，卸载只删 SSH-WEB 加的那几条。
// 除了 Claude Code，各 Agent 的配置写法和事件字段是照着 Orca 的代码写的，没有在真的 Agent 上测过 (面板里标「未实测」)

const { posix } = require('path');
const { liveSession } = require('./session');
const { sftpOf } = require('./sftp');
const { setInstalled } = require('./session/hooks');

const p = (fn) => new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));

// 钩子脚本：所有 Agent 共用，第一个参数是哪个 Agent (不写 = Claude Code)。只用 sh / grep / sed (目标主机上不一定有 jq / python)。
// 从 Agent 传来的事件里取出要用的字段 (各家字段名不一样，按 [统一的名字:别名…] 依次找，字符串原样保留转义，直接拼进输出的一行 JSON)；
// 找出事件属于 SSH-WEB 的哪个标签：在 tmux 里 = 挂在这个 tmux 会话上的客户端环境变量里的 LC_SSHWEB
// (同本地快速滚动找 pane 的办法)，不在 tmux 里 = 自己的 LC_SSHWEB。
// 只有 Agent 要求回话时才往外打印 (Gemini 要 {}；Antigravity 的 PreToolUse 要 {"decision":"ask"}，不回当成拒绝，ask = 照你自己的权限设置问你)，
// 其余什么都不输出 (Claude Code 有的事件会把钩子的输出当成给 Claude 的内容)，总是 exit 0
const HOOK_SH = `#!/bin/sh
# SSH-WEB 的 Agent 钩子 (由 SSH-WEB 安装；卸载请在 SSH-WEB 里点「⋯ 更多 → 钩子通知 → 卸载」)
# 把 Claude Code / Grok / Codex / Gemini / Antigravity / OpenCode 的事件追加到 ~/.cache/ssh-web/hook.log，SSH-WEB 实时读取 (主机状态、推送通知)
# 用法：hook.sh [Agent] [事件名]  (不写 Agent 是 Claude Code；事件名只有 Antigravity 用，它传来的内容里不带事件名)
agent=\${1:-claude}; event=$2
case "$agent:$event" in
  gemini:*) printf '{}\\n' ;;
  antigravity:PreToolUse) printf '{"decision":"ask"}\\n' ;;
  antigravity:Stop) printf '{"decision":""}\\n' ;;
  antigravity:*) printf '{}\\n' ;;
esac
in=$(head -c 65536 | tr '\\n\\r' '  ')
exec >/dev/null 2>&1
d="$HOME/.cache/ssh-web"; f="$d/hook.log"
mkdir -p "$d" || exit 0
get() { printf '%s' "$in" | grep -oE "\\"$1\\"[[:space:]]*:[[:space:]]*\\"([^\\"\\\\\\\\]|\\\\\\\\.)*\\"" | head -n 1 | sed 's/^"[^"]*"[[:space:]]*:[[:space:]]*//'; }
esc() { printf '%s' "$1" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g'; }
tabs=
if [ -n "$TMUX_PANE" ] && command -v tmux >/dev/null 2>&1; then
  s=$(tmux display -p -t "$TMUX_PANE" '#{session_id}')
  for c in $(tmux list-clients -F '#{client_pid}:#{session_id}'); do
    [ "\${c#*:}" = "$s" ] || continue
    t=$(tr '\\0' '\\n' < "/proc/\${c%%:*}/environ" | sed -n 's/^LC_SSHWEB=//p' | head -n 1)
    [ -n "$t" ] && tabs="$tabs $t"
  done
elif [ -n "$LC_SSHWEB" ]; then
  tabs=$LC_SSHWEB
fi
line="{\\"v\\":2,\\"t\\":$(date +%s),\\"agent\\":\\"$(esc "$agent")\\",\\"tabs\\":\\"$(esc "$tabs")\\",\\"pane\\":\\"$(esc "$TMUX_PANE")\\""
[ -n "$event" ] && line="$line,\\"hook_event_name\\":\\"$(esc "$event")\\""
for spec in hook_event_name:hookEventName:hook_type:hookType notification_type:notificationType message tool_name:toolName:name \\
  command:cmd:CommandLine file_path:filePath:path url question prompt:user_prompt:userPrompt \\
  last_assistant_message:lastAssistantMessage:prompt_response error error_details:errorDetails level reason; do
  k=\${spec%%:*}
  [ "$k" = hook_event_name ] && [ -n "$event" ] && continue
  v=
  for a in $(printf '%s' "$spec" | tr ':' ' '); do v=$(get "$a"); [ -n "$v" ] && break; done
  [ -n "$v" ] && line="$line,\\"$k\\":$v"
done
# Antigravity 步骤之间的 Stop (fullyIdle=false) 不算做完；子 Agent 的事件不算主会话的状态
printf '%s' "$in" | grep -qE '"(fullyIdle|fully_idle)"[[:space:]]*:[[:space:]]*false' && line="$line,\\"busy\\":true"
[ "$agent" != claude ] && printf '%s' "$in" | grep -qE '"(subagent_type|subagentType|agent_id)"[[:space:]]*:[[:space:]]*"[^"]' && line="$line,\\"child\\":true"
printf '%s}\\n' "$line" >> "$f"
[ "$(wc -c < "$f")" -gt 1048576 ] && mv -f "$f" "$f.1"
exit 0
`;

// OpenCode 不用钩子配置，用插件 (放进 ~/.config/opencode/plugins/ 自动加载)：把它的事件换成和别的 Agent 一样的几种，交给同一个 hook.sh
const OPENCODE_PLUGIN = `// SSH-WEB 的 OpenCode 状态插件 (由 SSH-WEB 安装；卸载请在 SSH-WEB 里点「⋯ 更多 → 钩子通知」)
// 把 OpenCode 开始干活、要权限、问问题、做完、出错交给 ~/.ssh-web/hook.sh，写进 ~/.cache/ssh-web/hook.log，SSH-WEB 实时读取
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(homedir(), '.ssh-web', 'hook.sh');
function send(ev) {
  try {
    const p = spawn('sh', [SCRIPT, 'opencode'], { stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', () => {});
    p.stdin.on('error', () => {});
    p.stdin.end(JSON.stringify(ev));
  } catch {}
}
const cut = (s) => String(s || '').slice(0, 2000);
const remember = (set, v) => { set.add(v); if (set.size > 500) set.delete(set.values().next().value); };

export const SshWebStatus = async () => {
  const child = new Set(); // 子会话 (子 Agent) 不算主会话的状态
  const role = new Map(); // 消息 id → user / assistant
  const seen = new Set(); // 报过的用户消息 / 工具调用
  let busy = false, lastText = '', failed = '';
  const done = () => {
    if (!busy) return;
    busy = false;
    send(failed ? { hook_event_name: 'StopFailure', error: cut(failed) } : { hook_event_name: 'Stop', last_assistant_message: cut(lastText) });
    failed = '';
  };
  return {
    event: async ({ event }) => {
      try {
        const t = event && event.type, pr = (event && event.properties) || {}, info = pr.info || {};
        if ((t === 'session.created' || t === 'session.updated') && info.id && info.parentID) remember(child, info.id);
        const sid = pr.sessionID || (pr.part && pr.part.sessionID) || info.sessionID;
        if (sid && child.has(sid)) return;
        if (t === 'message.updated' && info.id) {
          role.set(info.id, info.role);
          if (role.size > 500) role.delete(role.keys().next().value);
        } else if (t === 'message.part.updated') {
          const part = pr.part || {};
          if (part.type === 'text' && part.text) {
            const r = role.get(part.messageID);
            if (r === 'user' && !part.synthetic && !seen.has(part.messageID)) {
              remember(seen, part.messageID);
              busy = true; lastText = ''; failed = '';
              send({ hook_event_name: 'UserPromptSubmit', prompt: cut(part.text) });
            } else if (r === 'assistant') lastText = part.text;
          } else if (part.type === 'tool' && part.state && part.state.status === 'running' && part.callID && !seen.has(part.callID)) {
            remember(seen, part.callID);
            const inp = part.state.input || {};
            send({ hook_event_name: 'PreToolUse', tool_name: part.tool, command: inp.command, file_path: inp.filePath || inp.file_path, url: inp.url });
          }
        } else if (t === 'permission.asked' || t === 'permission.updated') {
          const m = pr.metadata || {};
          send({ hook_event_name: 'PermissionRequest', tool_name: pr.permission || pr.type || pr.tool, command: m.command || pr.title || (pr.patterns || []).join(' '), file_path: m.filepath || m.filePath });
        } else if (t === 'question.asked') {
          const q = (pr.questions || [])[0] || {};
          send({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', question: q.question || q.header || '' });
        } else if (t === 'session.status') {
          const st = pr.status && pr.status.type;
          if (st === 'busy' && !busy) { busy = true; send({ hook_event_name: 'UserPromptSubmit' }); }
          else if (st === 'idle') done();
        } else if (t === 'session.idle') {
          done();
        } else if (t === 'session.error') {
          const e = pr.error || {};
          if (e.name !== 'MessageAbortedError') failed = (e.data && e.data.message) || e.name || '出错了';
        }
      } catch {}
    },
  };
};
`;

const HOOK_CMD = 'sh "$HOME/.ssh-web/hook.sh"';
const isOurs = (h) => !!h && typeof h.command === 'string' && h.command.includes('.ssh-web/hook.sh');
// Claude Code 的 [事件, 匹配的工具]：问问题 (AskUserQuestion) 用 PreToolUse 看；工具用完 (PostToolUse) = 确认过了、接着在干活
const HOOK_EVENTS = [
  ['UserPromptSubmit'], ['PreToolUse', 'AskUserQuestion'], ['PermissionRequest', '*'], ['PostToolUse', '*'],
  ['Notification'], ['Stop'], ['StopFailure'], ['SessionEnd'],
];

// 各 Agent 的钩子写在哪、怎么写 (除 Claude Code 外照着 Orca)：
// kind = settings：合并进 Agent 自己的 JSON 设置 (和 Claude 一样的 hooks 结构)；own：SSH-WEB 自己的一个钩子文件，卸载直接删；
// bundle：Antigravity 的 hooks.json 里一个命名的分组；plugin：OpenCode 插件文件。
// events：[事件, 匹配的工具, 超时]；detect：主机上有这些路径之一就算装了这个 Agent (只用来排序、提示，没找到也可以装)
const AGENTS = [
  { id: 'claude', name: 'Claude Code', kind: 'settings', file: '.claude/settings.json', backup: true, cmd: HOOK_CMD, events: HOOK_EVENTS,
    detect: ['.claude'] },
  // Grok：~/.grok/hooks/*.json 都会加载，用自己的文件，不碰你写的；PreToolUse 看问问题 (ask_user_question 不走权限确认)
  { id: 'grok', name: 'Grok', kind: 'own', file: '.grok/hooks/sshweb-status.json', cmd: `${HOOK_CMD} grok`,
    events: [['SessionStart'], ['UserPromptSubmit'], ['Stop'], ['StopCancelled'], ['StopFailure'], ['SessionEnd'],
      ['PreToolUse', '.*'], ['PostToolUse', '.*'], ['PostToolUseFailure', '.*'], ['Notification']],
    detect: ['.grok'] },
  // Codex：~/.codex/hooks.json (顶层只能有 hooks / description，别的键 Codex 会整个文件不认)；Interrupt 的超时最多 3 秒。
  // 新加的钩子要在 Codex 里输入 /hooks 批准一次才生效
  { id: 'codex', name: 'Codex', kind: 'settings', file: '.codex/hooks.json', strict: true, cmd: `${HOOK_CMD} codex`,
    events: [['UserPromptSubmit'], ['PreToolUse'], ['PermissionRequest'], ['PostToolUse'], ['Stop'], ['Interrupt', null, 3]],
    detect: ['.codex'] },
  // Gemini CLI：~/.gemini/settings.json，超时的单位是毫秒；脚本要先回 {}
  { id: 'gemini', name: 'Gemini CLI', kind: 'settings', file: '.gemini/settings.json', cmd: `${HOOK_CMD} gemini`, timeout: 10000,
    events: [['BeforeAgent'], ['AfterAgent'], ['BeforeTool'], ['AfterTool'], ['Notification']],
    detect: ['.gemini/settings.json', '.gemini/oauth_creds.json', '.gemini/installation_id'] },
  // Antigravity：~/.gemini/config/hooks.json 里的「sshweb-status」分组；传来的内容不带事件名，命令里带上
  { id: 'antigravity', name: 'Antigravity', kind: 'bundle', file: '.gemini/config/hooks.json', bundle: 'sshweb-status',
    cmd: (ev) => `${HOOK_CMD} antigravity ${ev}`,
    events: [['PreInvocation'], ['PostInvocation'], ['Stop'], ['PreToolUse', '*'], ['PostToolUse', '*']],
    detect: ['.gemini/antigravity', '.gemini/antigravity-ide', '.gemini/antigravity-cli', '.gemini/config'] },
  { id: 'opencode', name: 'OpenCode', kind: 'plugin', file: '.config/opencode/plugins/sshweb-status.js',
    detect: ['.config/opencode', '.local/share/opencode'] },
];
const agentOf = (id) => AGENTS.find((a) => a.id === (id || 'claude'));
const cmdOf = (a, ev) => (typeof a.cmd === 'function' ? a.cmd(ev) : a.cmd);
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// 一个钩子定义里有没有 SSH-WEB 的 (Antigravity 的部分事件把 command 直接写在定义上)
const defIsOurs = (g) => isOurs(g) || (isPlain(g) && Array.isArray(g.hooks) && g.hooks.some(isOurs));
// 去掉一组定义里 SSH-WEB 的钩子 (别的原样保留；空了的定义删掉)
function stripDefs(groups) {
  return groups.map((g) => (isPlain(g) && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) } : g))
    .filter((g) => !isOurs(g) && !(isPlain(g) && Array.isArray(g.hooks) && !g.hooks.length));
}
function stripHooks(hooks) {
  const out = { ...hooks };
  for (const [ev, groups] of Object.entries(out)) {
    if (!Array.isArray(groups)) continue;
    const kept = stripDefs(groups);
    if (kept.length) out[ev] = kept; else delete out[ev];
  }
  return out;
}

// 去掉 SSH-WEB 加的钩子 (某个事件下没东西了就删掉这个事件)
function removeHooks(settings, agent = agentOf()) {
  const out = JSON.parse(JSON.stringify(settings || {}));
  const key = agent.kind === 'bundle' ? agent.bundle : 'hooks';
  if (!isPlain(out[key])) return out;
  out[key] = stripHooks(out[key]);
  if (!Object.keys(out[key]).length) delete out[key];
  return out;
}

// 加上 SSH-WEB 的钩子 (先去掉旧的，重复安装不会加出两份)
function addHooks(settings, agent = agentOf()) {
  const out = removeHooks(settings, agent);
  const key = agent.kind === 'bundle' ? agent.bundle : 'hooks';
  if (!isPlain(out[key])) out[key] = {};
  for (const [ev, matcher, timeout] of agent.events) {
    if (!Array.isArray(out[key][ev])) out[key][ev] = [];
    const hook = { type: 'command', command: cmdOf(agent, ev), timeout: timeout || agent.timeout || 10 };
    // Antigravity 不带匹配的事件把命令直接写在定义上
    out[key][ev].push(agent.kind === 'bundle' && !matcher ? hook : { ...(matcher ? { matcher } : {}), hooks: [hook] });
  }
  return out;
}

const hookCount = (settings, agent = agentOf()) => {
  const box = agent.kind === 'bundle' ? settings?.[agent.bundle] : settings?.hooks;
  return agent.events.filter(([ev]) => (Array.isArray(box?.[ev]) ? box[ev] : []).some(defIsOurs)).length;
};

// 目标主机上的路径 (主目录用 sftp 的 realpath('.') 得到)
async function paths(sftp) {
  const home = await p((cb) => sftp.realpath('.', cb));
  return { home, dir: posix.join(home, '.ssh-web'), script: posix.join(home, '.ssh-web', 'hook.sh') };
}
const fileOf = (P, a) => posix.join(P.home, a.file);

// 读 JSON 设置：没有这个文件 = 空设置；不是合法 JSON 就不动它 (抛错)
async function readSettings(sftp, file) {
  let text;
  try { text = String(await p((cb) => sftp.readFile(file, cb))); } catch (e) { if (e.code === 2) return { settings: {}, text: null }; throw e; }
  if (!text.trim()) return { settings: {}, text };
  let settings;
  try { settings = JSON.parse(text); } catch { throw new Error(`${file} 不是合法的 JSON，没有改动 (请先修好它)`); }
  if (!isPlain(settings)) throw new Error(`${file} 不是 JSON 对象，没有改动`);
  return { settings, text };
}
const readText = (sftp, file) => p((cb) => sftp.readFile(file, cb)).then(String, () => null);
const exists = (sftp, file) => p((cb) => sftp.stat(file, cb)).then(() => true, () => false);

// 写文件：先写临时文件再换上去 (写到一半断了原文件不受影响)
async function writeAtomic(sftp, file, data, mode) {
  const tmp = `${file}.sshweb-${Date.now().toString(36)}`;
  await p((cb) => sftp.writeFile(tmp, data, { mode }, cb));
  try {
    await p((cb) => sftp.ext_openssh_rename(tmp, file, cb));
  } catch {
    await p((cb) => sftp.unlink(file, cb)).catch(() => {});
    await p((cb) => sftp.rename(tmp, file, cb));
  }
}
// 逐级建目录 (已经有了不算错)
async function mkdirs(sftp, home, dir) {
  let cur = home;
  for (const part of posix.relative(home, dir).split('/').filter(Boolean)) {
    cur = posix.join(cur, part);
    await p((cb) => sftp.mkdir(cur, cb)).catch(() => {});
  }
}

// 一个 Agent 的安装情况：installed 全装上了、partial 只有一部分、outdated 装的插件是旧版本
async function agentStatus(sftp, P, a) {
  const file = fileOf(P, a);
  const present = (await Promise.all(a.detect.map((d) => exists(sftp, posix.join(P.home, d))))).some(Boolean);
  const base = { id: a.id, name: a.name, present, config: file, file: '~/' + a.file, tested: a.id === 'claude' };
  if (a.kind === 'plugin') {
    const text = await readText(sftp, file);
    return { ...base, installed: text != null, partial: false, outdated: text != null && text !== OPENCODE_PLUGIN };
  }
  try {
    const { settings } = await readSettings(sftp, file);
    const n = hookCount(settings, a);
    return { ...base, installed: n === a.events.length, partial: n > 0 && n < a.events.length, outdated: false };
  } catch (e) {
    return { ...base, installed: false, partial: false, outdated: false, error: e.message };
  }
}

async function status(sess) {
  const sftp = await sftpOf(sess);
  const P = await paths(sftp);
  const script = await readText(sftp, P.script);
  const scriptOk = script != null;
  const agents = await Promise.all(AGENTS.map((a) => agentStatus(sftp, P, a)));
  for (const a of agents) if (a.installed && !scriptOk) { a.installed = false; a.partial = true; }
  const claude = agents[0];
  // outdated：装的钩子脚本是旧版本 (SSH-WEB 更新后脚本多取了字段)，重新安装一下。
  // installed / partial / settings 是 Claude Code 的 (以前只有 Claude 时的字段)
  return { agents, scriptOk, outdated: scriptOk && script !== HOOK_SH,
    installed: claude.installed, partial: claude.partial, settings: claude.config };
}

async function install(sess, id) {
  const a = agentOf(id);
  if (!a) throw new Error('不认识的 Agent');
  const sftp = await sftpOf(sess);
  const P = await paths(sftp);
  const file = fileOf(P, a);
  // 先读：格式不对就什么都不改
  const cur = a.kind === 'plugin' || a.kind === 'own' ? null : await readSettings(sftp, file);
  if (cur && a.strict && Object.keys(cur.settings).some((k) => k !== 'hooks' && k !== 'description')) {
    throw new Error(`${file} 里有 hooks / description 以外的内容，${a.name} 会整个文件不认，没有改动`);
  }
  await mkdirs(sftp, P.home, P.dir);
  await mkdirs(sftp, P.home, posix.dirname(file));
  await writeAtomic(sftp, P.script, HOOK_SH, 0o755);
  await p((cb) => sftp.chmod(P.script, 0o755, cb)).catch(() => {});
  let backup = null;
  if (a.kind === 'plugin') {
    await writeAtomic(sftp, file, OPENCODE_PLUGIN, 0o644);
  } else if (a.kind === 'own') {
    await writeAtomic(sftp, file, JSON.stringify(addHooks({}, a), null, 2) + '\n', 0o644);
  } else {
    // 第一次装之前备份原来的设置 (之后再装不覆盖备份)
    if (cur.text != null) {
      backup = `${file}.bak-sshweb`;
      if (!(await exists(sftp, backup))) await p((cb) => sftp.writeFile(backup, cur.text, { mode: 0o600 }, cb));
    }
    await writeAtomic(sftp, file, JSON.stringify(addHooks(cur.settings, a), null, 2) + '\n', 0o600);
  }
  setInstalled(sess, true); // 这台主机从现在起只按钩子推送
  return { ok: true, agent: a.id, config: file, settings: file, backup };
}

async function uninstall(sess, id) {
  const a = agentOf(id);
  if (!a) throw new Error('不认识的 Agent');
  const sftp = await sftpOf(sess);
  const P = await paths(sftp);
  const file = fileOf(P, a);
  if (a.kind === 'plugin' || a.kind === 'own') {
    await p((cb) => sftp.unlink(file, cb)).catch(() => {});
  } else {
    const { settings, text } = await readSettings(sftp, file);
    if (text != null && hookCount(settings, a)) await writeAtomic(sftp, file, JSON.stringify(removeHooks(settings, a), null, 2) + '\n', 0o600);
  }
  // 别的 Agent 都没装了才删 hook.sh；删了以后终端响铃、看屏幕判断的状态照常推送
  const left = (await Promise.all(AGENTS.filter((x) => x !== a).map((x) => agentStatus(sftp, P, x)))).some((x) => x.installed || x.partial);
  if (!left) {
    await p((cb) => sftp.unlink(P.script, cb)).catch(() => {});
    setInstalled(sess, false);
  }
  return { ok: true, scriptRemoved: !left };
}

function registerHooks(app) {
  const route = (fn) => async (req, res) => {
    const s = liveSession(String(req.body?.sid || ''));
    if (!s) return res.status(404).json({ error: '会话不存在或已断开' });
    try {
      res.json(await fn(s, req.body?.agent && String(req.body.agent)));
    } catch (e) {
      res.status(400).json({ error: e.code === 3 ? '权限不足' : e.message || String(e) });
    }
  };
  app.post('/api/hooks/status', route(status));
  app.post('/api/hooks/install', route(install));
  app.post('/api/hooks/uninstall', route(uninstall));
}

module.exports = { registerHooks, HOOK_SH, HOOK_EVENTS, OPENCODE_PLUGIN, AGENTS, addHooks, removeHooks };
