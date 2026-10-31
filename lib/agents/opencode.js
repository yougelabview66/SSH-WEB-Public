'use strict';
// OpenCode：装的是一个插件 (~/.config/opencode/plugins/sshweb-status.js)；会话在 ~/.local/share/opencode/storage/session/<项目>/<会话 id>.json。
// 新版 OpenCode 存在 SQLite 里，会话历史读不到。没在真的 OpenCode 上测过
const { posix } = require('path');
const { str, parseJson, field, oneLine } = require('./util');

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

module.exports = {
  id: 'opencode', name: 'OpenCode', short: 'OpenCode',

  // ---- 钩子：插件文件 (内容见上面的 PLUGIN；版本不一样算「旧版本」，重新安装覆盖)
  hooks: {
    kind: 'plugin', file: '.config/opencode/plugins/sshweb-status.js', plugin: PLUGIN,
    detect: ['.config/opencode', '.local/share/opencode'],
  },

  // ---- 会话历史：title / directory；有 parentID 的是子会话，不算
  sessions: {
    mark: '/opencode/storage/session/',
    script: String.raw`
D=$XDG_DATA_HOME; [ -n "$D" ] || D=$HOME/.local/share
cd "$D/opencode/storage/session" 2>/dev/null || exit 0
ls -t -- */*.json 2>/dev/null | head -n $SCAN | while IFS= read -r f; do grep -q '"parentID"' -- "$f" && continue; hit "$f" && echo "$f"; done | head -n $N | while IFS= read -r f; do
  printf '@@ %s %s\n' "$(st "$f")" "$PWD/$f"
  printf 'json\t%s\n' "$(head -c 65536 -- "$f" | one)"
done`,
    async sftp(x) {
      const files = await x.filesIn(await x.subdirs([x.J('.local', 'share', 'opencode', 'storage', 'session')]), (n) => n.endsWith('.json'));
      const heads = new Map();
      const notKid = async (f) => { const t = await x.head(f); heads.set(f.path, t); return !t.includes('"parentID"') && (await x.has(f)); };
      await x.collect(await x.pick(files, notKid), async (f) => ({ json: x.oneLn(heads.get(f.path) ?? await x.head(f)) }));
    },
    parse(r) {
      const o = parseJson(field(r, 'json')) || {};
      return { id: str(o.id) || posix.basename(r.path).replace(/\.json$/, ''), title: oneLine(str(o.title)), prompt: '', cwd: str(o.directory) };
    },
    resume: (id) => `opencode --session ${id}`,
    // 删除时一起移走：消息目录
    items: (file, id) => [file, posix.join(posix.dirname(posix.dirname(posix.dirname(file))), 'message', id)],
  },
};
