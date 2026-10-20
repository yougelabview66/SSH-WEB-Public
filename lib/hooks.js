'use strict';
// Claude Code 钩子 (参考 Orca 的做法)：在目标主机的 ~/.claude/settings.json 里装上 SSH-WEB 的钩子，
// Claude Code 开始干活、要权限、问问题、做完、出错时，钩子把事件追加到目标主机的 ~/.cache/ssh-web/hook.log，
// SSH-WEB 借连着的 SSH 连接实时读 (见 session/hooks.js)：状态更准、推送写得出具体内容、安卓通知上能直接「允许 / 拒绝」。
// 只在网页上点「安装」并确认后才改目标主机；原有的设置和你自己的钩子都保留，卸载只删 SSH-WEB 加的那几条

const { posix } = require('path');
const { liveSession } = require('./session');
const { sftpOf } = require('./sftp');
const { setInstalled } = require('./session/hooks');

const p = (fn) => new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));

// 钩子脚本：只用 sh / grep / sed (目标主机上不一定有 jq / python)。
// 从 Claude Code 传来的事件里取出要用的字段 (字符串原样保留转义，直接拼进输出的一行 JSON)；
// 找出事件属于 SSH-WEB 的哪个标签：在 tmux 里 = 挂在这个 tmux 会话上的客户端环境变量里的 LC_SSHWEB
// (同本地快速滚动找 pane 的办法)，不在 tmux 里 = 自己的 LC_SSHWEB。
// 什么都不输出、总是 exit 0：不影响 Claude Code (有的事件会把钩子的输出当成给 Claude 的内容)
const HOOK_SH = `#!/bin/sh
# SSH-WEB 的 Claude Code 钩子 (由 SSH-WEB 安装；卸载请在 SSH-WEB 里点「⋯ 更多 → 钩子通知 → 卸载」)
# 把 Claude Code 的事件追加到 ~/.cache/ssh-web/hook.log，SSH-WEB 实时读取 (主机状态、推送通知)
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
line="{\\"v\\":1,\\"t\\":$(date +%s),\\"tabs\\":\\"$(esc "$tabs")\\",\\"pane\\":\\"$(esc "$TMUX_PANE")\\""
for k in hook_event_name notification_type message tool_name command file_path url question prompt last_assistant_message error error_details; do
  v=$(get "$k")
  [ -n "$v" ] && line="$line,\\"$k\\":$v"
done
printf '%s}\\n' "$line" >> "$f"
[ "$(wc -c < "$f")" -gt 1048576 ] && mv -f "$f" "$f.1"
exit 0
`;

const HOOK_CMD = 'sh "$HOME/.ssh-web/hook.sh"';
const isOurs = (h) => !!h && typeof h.command === 'string' && h.command.includes('.ssh-web/hook.sh');
// [事件, 匹配的工具]：问问题 (AskUserQuestion) 用 PreToolUse 看；工具用完 (PostToolUse) = 确认过了、接着在干活
const HOOK_EVENTS = [
  ['UserPromptSubmit'], ['PreToolUse', 'AskUserQuestion'], ['PermissionRequest', '*'], ['PostToolUse', '*'],
  ['Notification'], ['Stop'], ['StopFailure'], ['SessionEnd'],
];

// 去掉 SSH-WEB 加的钩子 (别的原样保留；某个事件下没东西了就删掉这个事件)
function removeHooks(settings) {
  const out = JSON.parse(JSON.stringify(settings || {}));
  if (!out.hooks || typeof out.hooks !== 'object' || Array.isArray(out.hooks)) return out;
  for (const [ev, groups] of Object.entries(out.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups.map((g) => (g && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) } : g))
      .filter((g) => !(g && Array.isArray(g.hooks) && !g.hooks.length));
    if (kept.length) out.hooks[ev] = kept; else delete out.hooks[ev];
  }
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return out;
}

// 加上 SSH-WEB 的钩子 (先去掉旧的，重复安装不会加出两份)
function addHooks(settings) {
  const out = removeHooks(settings);
  if (!out.hooks || typeof out.hooks !== 'object' || Array.isArray(out.hooks)) out.hooks = {};
  for (const [ev, matcher] of HOOK_EVENTS) {
    if (!Array.isArray(out.hooks[ev])) out.hooks[ev] = [];
    out.hooks[ev].push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: HOOK_CMD, timeout: 10 }] });
  }
  return out;
}

const hookCount = (settings) => HOOK_EVENTS.filter(([ev]) => (settings?.hooks?.[ev] || []).some((g) => g?.hooks?.some?.(isOurs))).length;

// 目标主机上的路径 (主目录用 sftp 的 realpath('.') 得到)
async function paths(sftp) {
  const home = await p((cb) => sftp.realpath('.', cb));
  return { home, claudeDir: posix.join(home, '.claude'), settings: posix.join(home, '.claude', 'settings.json'),
    backup: posix.join(home, '.claude', 'settings.json.bak-sshweb'), dir: posix.join(home, '.ssh-web'), script: posix.join(home, '.ssh-web', 'hook.sh') };
}

// 读 settings.json：没有这个文件 = 空设置；不是合法 JSON 就不动它 (抛错)
async function readSettings(sftp, file) {
  let text;
  try { text = String(await p((cb) => sftp.readFile(file, cb))); } catch (e) { if (e.code === 2) return { settings: {}, text: null }; throw e; }
  if (!text.trim()) return { settings: {}, text };
  try { return { settings: JSON.parse(text), text }; } catch { throw new Error(`${file} 不是合法的 JSON，没有改动 (请先修好它)`); }
}

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

async function status(sess) {
  const sftp = await sftpOf(sess);
  const P = await paths(sftp);
  const { settings } = await readSettings(sftp, P.settings);
  const script = await p((cb) => sftp.readFile(P.script, cb)).then(String, () => null);
  const scriptOk = script != null;
  const n = hookCount(settings);
  // outdated：装的钩子脚本是旧版本 (SSH-WEB 更新后脚本多取了字段)，重新安装一下
  return { installed: scriptOk && n === HOOK_EVENTS.length, partial: n > 0 && n < HOOK_EVENTS.length, scriptOk, outdated: scriptOk && script !== HOOK_SH, settings: P.settings };
}

async function install(sess) {
  const sftp = await sftpOf(sess);
  const P = await paths(sftp);
  const { settings, text } = await readSettings(sftp, P.settings); // 先读：格式不对就什么都不改
  for (const dir of [P.dir, P.claudeDir]) await p((cb) => sftp.mkdir(dir, cb)).catch(() => {});
  await writeAtomic(sftp, P.script, HOOK_SH, 0o755);
  await p((cb) => sftp.chmod(P.script, 0o755, cb)).catch(() => {});
  // 第一次装之前备份原来的 settings.json (之后再装不覆盖备份)
  let backup = null;
  if (text != null) {
    const had = await p((cb) => sftp.stat(P.backup, cb)).then(() => true, () => false);
    if (!had) await p((cb) => sftp.writeFile(P.backup, text, { mode: 0o600 }, cb));
    backup = P.backup;
  }
  await writeAtomic(sftp, P.settings, JSON.stringify(addHooks(settings), null, 2) + '\n', 0o600);
  setInstalled(sess, true); // 这台主机从现在起只按钩子推送
  return { ok: true, settings: P.settings, backup };
}

async function uninstall(sess) {
  const sftp = await sftpOf(sess);
  const P = await paths(sftp);
  const { settings, text } = await readSettings(sftp, P.settings);
  if (text != null && hookCount(settings)) await writeAtomic(sftp, P.settings, JSON.stringify(removeHooks(settings), null, 2) + '\n', 0o600);
  await p((cb) => sftp.unlink(P.script, cb)).catch(() => {});
  setInstalled(sess, false); // 卸载了：终端响铃、看屏幕判断的状态照常推送
  return { ok: true };
}

function registerHooks(app) {
  const route = (fn) => async (req, res) => {
    const s = liveSession(String(req.body?.sid || ''));
    if (!s) return res.status(404).json({ error: '会话不存在或已断开' });
    try {
      res.json(await fn(s));
    } catch (e) {
      res.status(400).json({ error: e.code === 3 ? '权限不足' : e.message || String(e) });
    }
  };
  app.post('/api/hooks/status', route(status));
  app.post('/api/hooks/install', route(install));
  app.post('/api/hooks/uninstall', route(uninstall));
}

module.exports = { registerHooks, HOOK_SH, HOOK_EVENTS, addHooks, removeHooks };
