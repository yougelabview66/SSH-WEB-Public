'use strict';
// pi (pi-coding-agent，命令 pi)：装的是一个扩展 (~/.pi/agent/extensions/sshweb-status.ts)；会话在 ~/.pi/agent/sessions/--<目录>--/<时间>_<会话 id>.jsonl。
// pi 没有钩子配置，状态靠扩展里 pi.on(事件) 拿。实测 pi 1.4.0
const { posix } = require('path');
const { str, parseJson, field, oneLine, cleanPrompt } = require('./util');

// 扩展：把 pi 的事件换成和别的 Agent 一样的几种，交给同一个 hook.sh (同 OpenCode 的插件)。
// 开始干活 = before_agent_start (你发的话)；用工具 = tool_call；做完 = agent_settled (agent_end 之后还可能重试、压缩、接着干，
// 不算做完，见 pi 的 docs/extensions.md)；扩展弹的确认框 (ui_prompt_start / end) 算要你确认。pi 自己没有权限确认、没有问问题的工具
const EXTENSION = `// SSH-WEB 的 pi 状态扩展 (由 SSH-WEB 安装；卸载请在 SSH-WEB 里点「⋯ 更多 → 钩子通知」)
// 把 pi 开始干活、用工具、弹确认框、做完、出错交给 ~/.ssh-web/hook.sh，写进 ~/.cache/ssh-web/hook.log，SSH-WEB 实时读取
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const WIN = process.platform === 'win32';
const SCRIPT = join(homedir(), '.ssh-web', WIN ? 'hook.ps1' : 'hook.sh');
function send(ev) {
  try {
    const p = WIN ? spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, 'pi'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
      : spawn('sh', [SCRIPT, 'pi'], { stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', () => {});
    p.stdin.on('error', () => {});
    p.stdin.end(JSON.stringify(ev));
  } catch {}
}
const cut = (s) => String(s || '').slice(0, 2000);
const textOf = (m) => (typeof m?.content === 'string' ? m.content
  : (Array.isArray(m?.content) ? m.content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('\\n') : ''));

export default function (pi) {
  let sid = '', busy = false, lastText = '', failed = '';
  const note = (ctx) => { try { sid = String(ctx?.sessionManager?.getSessionId?.() || sid || ''); } catch {} };
  const post = (ev) => send({ ...ev, session_id: sid, cwd: process.cwd() });
  pi.on('session_start', (e, ctx) => {
    note(ctx);
    post({ hook_event_name: 'SessionStart', source: e?.reason === 'resume' ? 'resume' : (e?.reason || 'startup') });
  });
  pi.on('before_agent_start', (e, ctx) => {
    note(ctx);
    busy = true; lastText = ''; failed = '';
    post({ hook_event_name: 'UserPromptSubmit', prompt: cut(e?.messageType === 'user' ? e.prompt : '') });
  });
  pi.on('tool_call', (e, ctx) => {
    if (!e || e.parentToolCallId) return; // 别的工具 (codemode 脚本) 里调的不算
    note(ctx);
    const i = e.input || {};
    post({ hook_event_name: 'PreToolUse', tool_name: e.toolName, command: i.command, file_path: i.path || i.file_path, url: i.url });
  });
  pi.on('ui_prompt_start', (e, ctx) => {
    note(ctx);
    post({ hook_event_name: 'PermissionRequest', tool_name: 'pi', command: cut(e?.title || '') });
  });
  pi.on('ui_prompt_end', (e, ctx) => {
    note(ctx);
    if (busy) post({ hook_event_name: 'PostToolUse' });
  });
  pi.on('message_end', (e) => {
    const m = e?.message;
    if (!m || m.role !== 'assistant') return;
    const t = textOf(m);
    if (t) lastText = t;
    if (m.stopReason === 'error') failed = m.errorMessage || '出错了';
    else if (t) failed = '';
  });
  pi.on('agent_settled', (e, ctx) => {
    note(ctx);
    if (!busy) return;
    busy = false;
    if (e?.aborted) post({ hook_event_name: 'Interrupt' });
    else if (failed) post({ hook_event_name: 'StopFailure', error: cut(failed) });
    else post({ hook_event_name: 'Stop', last_assistant_message: cut(lastText) });
    failed = '';
  });
  pi.on('session_shutdown', () => { post({ hook_event_name: 'SessionEnd' }); });
}
`;

// 会话文件第一行 { type: 'session', id, cwd, … }；你说的话是 { type: 'message', message: { role: 'user', content: 文字或 [{ type: 'text', text }] } }；
// 起的名字 (/name、--name) 是 { type: 'session_info', name }，以最后一条为准
// 一行 (可能截断了) 里第一段文字
function textOfLine(line) {
  if (!line) return '';
  const o = parseJson(line);
  if (o) {
    const c = o.message?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter((x) => x && x.type === 'text').map((x) => str(x.text)).join(' ');
    return '';
  }
  const m = /"(?:content|text)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(line); // 截断了：取第一段文字，尽量解出转义
  const raw = m ? m[1].replace(/\\u[0-9a-fA-F]{0,3}$|\\$/, '') : '';
  try { return JSON.parse(`"${raw}"`); } catch { return raw; }
}

module.exports = {
  id: 'pi', name: 'Pi', short: 'Pi', tested: true, // pi 1.4.0 在 SSH-WEB 里实测过
  proc: ['pi'],
  // 终端里认它 (会话历史「继续」前要不要先退出它，见 agent-sessions.js 的 AGENT_SCREEN_RE)：pi 的输入框前面没有 > ❯，
  // 底部状态栏一直有上下文用量「0.0%/128k (auto)」。退出照通用的两下 Ctrl+C (实测 250ms 内两下能退；/exit 在 pi 里会当成一句话发给模型)
  screen: /\d%\/\d+(\.\d+)?[kM]\b/,

  // ---- 钩子：扩展文件 (内容见上面的 EXTENSION；内容不一样算「旧版本」，重新安装覆盖)。
  // 顺带在 ~/.pi/agent/settings.json 设 "tuiMode": "regular" (见 hooks.js 的 jsonSet)：pi 默认全屏 (终端的备用屏幕、开着鼠标)，
  // 聊过的内容不进终端历史，进不了历史视图 (实测 pi 1.4.0：默认 alt=1 mouse=1，regular 后 alt=0 mouse=0)
  hooks: {
    kind: 'plugin', file: '.pi/agent/extensions/sshweb-status.ts', plugin: EXTENSION,
    tip: '装的是扩展（extensions 目录里的 sshweb-status.ts）；同时在 ~/.pi/agent/settings.json 设 "tuiMode": "regular"：不全屏，聊过的内容进终端历史，能进历史视图',
    json: { file: '.pi/agent/settings.json', key: 'tuiMode', value: 'regular' },
    detect: ['.pi/agent'],
  },

  // ---- 会话历史 (格式见上面)：fork 出来的会话 (parentSession) 也列，是单独的一个会话
  sessions: {
    mark: '/.pi/agent/sessions/',
    script: String.raw`
cd "$HOME/.pi/agent/sessions" 2>/dev/null || exit 0
ls -t -- */*.jsonl 2>/dev/null | head -n $SCAN | while IFS= read -r f; do hit "$f" && echo "$f"; done | head -n $N | while IFS= read -r f; do
  printf '@@ %s %s\n' "$(st "$f")" "$PWD/$f"
  printf 'head\t%s\n' "$(head -n 1 -- "$f" | head -c 20000 | one)"
  printf 'user\t%s\n' "$(grep -m1 -E '"role"[[:space:]]*:[[:space:]]*"user"' -- "$f" | head -c 20000 | one)"
  printf 'name\t%s\n' "$(grep -E '"type"[[:space:]]*:[[:space:]]*"session_info"' -- "$f" | tail -n 1 | head -c 4000 | one)"
done`,
    async sftp(x) {
      const files = await x.filesIn(await x.subdirs([x.J('.pi', 'agent', 'sessions')]), (n) => n.endsWith('.jsonl'));
      await x.collect(await x.pick(files), async (f) => {
        const lines = (await x.head(f, 262144)).split('\n');
        const info = (await x.tail(f, 262144)).split('\n').filter((l) => /"type"\s*:\s*"session_info"/.test(l)).pop() || '';
        const user = lines.find((l) => /"role"\s*:\s*"user"/.test(l)) || '';
        return { head: x.oneLn((lines[0] || '').slice(0, 20000)), user: x.oneLn(user.slice(0, 20000)), name: x.oneLn(info.slice(0, 4000)) };
      });
    },
    parse(r) {
      const h = parseJson(field(r, 'head')) || {};
      const id = str(h.id) || (/_([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i.exec(posix.basename(r.path)) || [])[1] || '';
      const info = parseJson(field(r, 'name'));
      return { id, title: oneLine(str(info?.name)), prompt: cleanPrompt(textOfLine(field(r, 'user'))), cwd: str(h.cwd) };
    },
    resume: (id) => `pi --session ${id}`,
  },
};
