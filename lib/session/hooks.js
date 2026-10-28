'use strict';
// 会话：读 Agent 钩子报来的事件 (Claude Code / Grok / Codex / Gemini / Antigravity / OpenCode，钩子见 lib/hooks.js)，
// 按事件给出主机状态、推送具体内容、在通知上直接允许 / 拒绝 (Claude Code)。
// 方法挂到 Session 上 (见 index.js)。
//
// 每台主机只开一个通道读 (挑一个连着的标签，执行 tail -F ~/.cache/ssh-web/hook.log)，这个标签断了换另一个接手；
// 没装钩子的主机文件不存在，tail 就一直等着，不创建任何文件。每行事件里带着它属于哪些标签 (LC_SSHWEB)，交给对应的会话

const { CHOICE_RE, screenTail } = require('../status');

const watchers = new Map(); // 主机 → { sess, ch, buf, at }
const installed = new Map(); // 主机 → 装没装钩子 (有没有 ~/.ssh-web/hook.sh，Windows 是 hook.ps1)：装了就只按钩子推送
const hostKey = (s) => s.hostId || s.histHost || s.title;
const allSessions = () => require('./index').sessions; // 运行时再取 (index.js 也引用这个文件)

// 读事件的命令：先报一行装没装钩子 (SSHWEB_HOOKS=1 / 0)，再一直读事件。
// Windows 主机 (默认 shell 是 cmd / PowerShell)：跑装钩子时写的 watch.ps1 (见 lib/hooks.js)；没装就只报一行 0 然后退出
const WATCH_CMD = {
  // 装了钩子的先把事件文件建好：不然第一条事件连文件一起出现，tail -n 0 -F 发现新文件时从末尾读，这一条就丢了
  sh: 'if [ -f "$HOME/.ssh-web/hook.sh" ] || [ -f "$HOME/.ssh-web/hook.ps1" ]; then echo SSHWEB_HOOKS=1; mkdir -p "$HOME/.cache/ssh-web" && : >> "$HOME/.cache/ssh-web/hook.log"; else echo SSHWEB_HOOKS=0; fi; exec tail -n 0 -F "$HOME/.cache/ssh-web/hook.log" 2>/dev/null',
  cmd: 'if exist "%USERPROFILE%\\.ssh-web\\watch.ps1" (powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\\.ssh-web\\watch.ps1") else (echo SSHWEB_HOOKS=0)',
  powershell: 'if (Test-Path "$env:USERPROFILE\\.ssh-web\\watch.ps1") { powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\\.ssh-web\\watch.ps1" } else { \'SSHWEB_HOOKS=0\' }',
};

function startWatch(s) {
  const key = hostKey(s);
  if (watchers.has(key) || s.status !== 'connected' || !s.ssh) return;
  const w = { sess: s, ch: null, buf: '', at: Date.now(), win: false };
  watchers.set(key, w);
  const gone = () => watchers.get(key) !== w || s.status !== 'connected';
  s.shellBase(s.ssh).catch(() => 'sh').then((base) => {
    if (gone()) { if (watchers.get(key) === w) watchers.delete(key); return; }
    w.win = base !== 'sh';
    s.ssh.exec(WATCH_CMD[base] || WATCH_CMD.sh, (err, ch) => {
      if (err || gone()) {
        try { ch && ch.close(); } catch {}
        if (watchers.get(key) === w) watchers.delete(key);
        return;
      }
      w.ch = ch;
      ch.stderr.resume();
      ch.on('data', (d) => {
        w.buf += d;
        let i;
        while ((i = w.buf.indexOf('\n')) >= 0) {
          const line = w.buf.slice(0, i).replace(/^\uFEFF/, '').replace(/\r$/, ''); // Windows 的行尾 \r\n、开头可能有 BOM
          w.buf = w.buf.slice(i + 1);
          const m = /^SSHWEB_HOOKS=([01])$/.exec(line.trim());
          if (m) { installed.set(key, m[1] === '1'); w.hooks = m[1] === '1'; } else routeHookLine(line, key, w.win);
        }
        if (w.buf.length > 1 << 20) w.buf = '';
      });
      ch.on('close', () => {
        if (watchers.get(key) !== w) return;
        watchers.delete(key);
        if (w.win && w.hooks === false) return; // Windows 没装钩子：不用等着读 (装的时候会重开，见 rewatch)
        // tail 一开就退出 (目标主机上用不了)：过一会儿再试，不来回重开
        if (Date.now() - w.at < 5000) setTimeout(() => handoff(key), 60000).unref();
        else handoff(key);
      });
    });
  });
}

// 重开这台主机读事件的通道 (Windows 主机刚装上钩子：之前没有 watch.ps1)
function rewatch(s) {
  const key = hostKey(s), w = watchers.get(key);
  if (w) { watchers.delete(key); try { w.ch && w.ch.close(); } catch {} }
  startWatch(s);
}

function handoff(key) {
  if (watchers.has(key)) return;
  const next = [...allSessions().values()].find((x) => x.status === 'connected' && x.ssh && hostKey(x) === key);
  if (next) startWatch(next);
}

function stopWatch(s) {
  for (const [key, w] of watchers) {
    if (w.sess !== s) continue;
    watchers.delete(key);
    try { w.ch && w.ch.close(); } catch {}
    handoff(key);
  }
}

function routeHookLine(line, key, win) {
  let ev;
  try { ev = JSON.parse(line); } catch { return; }
  if (!ev || typeof ev !== 'object' || typeof ev.hook_event_name !== 'string') return;
  const sessions = allSessions();
  // 常驻会话里的事件 (daemon = 会话编号)：交给这台主机上现在接着这个会话的标签 (tabs 是第一次开它的那个标签，换了标签接上就对不上)
  const daemons = String(ev.daemon || '').split(/\s+/).filter(Boolean);
  let hit = daemons.length ? [...sessions.values()].filter((x) => x.daemonId && daemons.includes(String(x.daemonId)) && hostKey(x) === key) : [];
  if (!hit.length) hit = String(ev.tabs || '').split(/\s+/).filter(Boolean).map((id) => sessions.get(id)).filter(Boolean);
  // Windows 的 SSH 不传 LC_SSHWEB (没开常驻会话时)：从 SSH 连进来的终端里开的 Agent (钩子脚本标了 ssh) 交给这台主机连着的标签
  // (几个的话给最近有人操作的那个)；主机上自己开的终端里的 Agent 不是网页上的标签，不交给谁 (不推送)。
  // 旧版钩子脚本 (v2) 分不出来，照旧交给标签 (重新安装钩子后就分得出了)
  // 常驻会话的标签不算：它里面开的 Agent 一定带着 SSHWEBD_SESSION，没带的不是它的
  if (!hit.length && win && (ev.ssh === true || !(ev.v >= 3))) {
    const mine = [...sessions.values()].filter((x) => x.status === 'connected' && hostKey(x) === key && !x.daemonId)
      .sort((a, b) => (b.tracker?.dataAt || 0) - (a.tracker?.dataAt || 0));
    if (mine[0]) hit.push(mine[0]);
  }
  for (const x of hit) x.onHook(ev);
}

// 推送里写的内容
const short = (s, n = 120) => {
  const t = String(s || '').split('\n').map((x) => x.trim()).find(Boolean) || '';
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
// 各家的工具名 → 做什么 (Claude 的 Bash / Edit…，Gemini 的 run_shell_command…，Codex 的 exec_command…，OpenCode 的 bash / edit…)
const TOOL_VERB = {
  Bash: '执行', Edit: '修改', MultiEdit: '修改', Write: '写入', NotebookEdit: '修改', Read: '读取', WebFetch: '访问', WebSearch: '搜索',
  bash: '执行', shell: '执行', run_shell_command: '执行', run_command: '执行', exec_command: '执行', shell_command: '执行', execute: '执行', Execute: '执行',
  edit: '修改', edit_file: '修改', replace: '修改', apply_patch: '修改', write: '写入', write_file: '写入', Create: '写入', create: '写入',
  read: '读取', read_file: '读取', web_fetch: '访问', webfetch: '访问', FetchUrl: '访问', web_search: '搜索', google_web_search: '搜索', websearch: '搜索',
};
function permText(ev) {
  const what = short(ev.command || ev.file_path || ev.url || '', 100);
  const verb = TOOL_VERB[ev.tool_name];
  if (verb && what) return `要${verb}${verb === '执行' && ev.command ? '命令' : ''}：${what}`;
  return `要使用 ${ev.tool_name || '工具'}${what ? '：' + what : ''}`;
}
const AGENT_NAME = { claude: 'Claude', grok: 'Grok', codex: 'Codex', gemini: 'Gemini', antigravity: 'Antigravity', opencode: 'OpenCode' };
// 事件名统一成小写下划线 (Grok 可能是 userPromptSubmit / user_prompt_submit)
const evName = (v) => String(v || '').trim().replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase();
// 问你问题的工具 (各家名字不一样)；Antigravity 的 ask_permission 算要权限
const isAskTool = (n) => ['askuserquestion', 'requestuserinput', 'askquestion'].includes(String(n || '').replace(/[^a-z0-9]/gi, '').toLowerCase());
// Grok 的提醒：每次用工具前都会发一条「tool permission requested」(不管要不要你确认)，不算；文字像在问你的才算要权限
const grokRoutine = (ev) => evName(ev.notification_type) === 'permission_prompt' && String(ev.message || '').trim().toLowerCase() === 'tool permission requested'
  && (!ev.level || String(ev.level).trim().toLowerCase() === 'info');
const askyText = (m) => /permission|approv|allow|confirm|needs your|requires your|feedback|clarify|question/i.test(String(m || ''));

const AGENT_GRACE = 10000; // 会话历史刚切过去的目录先信它这么久 (新的 Agent 还没起来)
// d 在 root 里面 (或者就是它)；Windows 的路径不分大小写、\ 和 / 一样
const insideDir = (d, root) => {
  if (!root) return false;
  const n = (x) => (/^[A-Za-z]:|\\/.test(x) ? x.replace(/\\/g, '/').toLowerCase() : x).replace(/\/+$/, '');
  const a = n(d), b = n(root);
  return a === b || a.startsWith(b + '/');
};
const HOOK_RUN_STALE = 10 * 60 * 1000; // 「运行中」这么久没有新事件、屏幕上也不像在跑：不再信钩子
const HOOK_MAX = 6 * 3600 * 1000;

class SessionHooks {
  // Agent 干活的目录变了：记下，右边栏 (项目文件 / 代码改动) 开着就重新读 (见 66-right-bar.js 的 rbAgentCwd)
  // fresh：会话历史刚切过去 (新的 Agent 还没起来)，先信它一会儿，主机上暂时找不到 / 对不上 Agent 也不清掉 (见 git-changes.js 的 projectDir)
  setAgentCwd(cwd, quiet, fresh) {
    this.agentCwdAt = Date.now(); // 最后一次报的时间 (每个钩子事件都报一次)：比主机上的 Agent 启动得早，说明是上一个 Agent 报的
    this.agentFresh = fresh ? this.agentCwdAt : 0;
    if ((this.agentCwd || '') === cwd) return;
    this.agentCwd = cwd;
    if (!quiet) this.broadcast({ type: 'agent-cwd' });
  }
  // 会话历史刚切过去还没多久 (新的 Agent 还没报事件)
  freshAgentCwd() { return !!this.agentFresh && Date.now() - this.agentFresh < AGENT_GRACE; }

  watchHooks() { startWatch(this); }
  unwatchHooks() { stopWatch(this); }

  // 这个标签用钩子推送：这台主机装了钩子，或者收到过钩子事件。是的话终端响铃、看屏幕判断的状态都不再推送
  // (Claude Code 做完 / 要权限时自己也会响铃，不然一件事推两次)
  usingHooks() { return !!this.hookSeenAt || installed.get(hostKey(this)) === true; }

  // 收到这个标签的一条钩子事件。各家 Agent 的事件先换成同一套：开始干活 / 在用工具 / 要权限 / 问问题 / 做完 / 出错 / 退出
  onHook(ev) {
    const now = Date.now();
    const agent = AGENT_NAME[ev.agent] ? ev.agent : 'claude';
    if (ev.child) return; // 子 Agent 的事件不算主会话的状态
    this.hookSeenAt = now; // 这个标签有 Agent 装了钩子：以后只按钩子推送 (见 index.js 的 alert / updateState)
    // Agent 干活的目录 (右边栏的项目 / 改动默认看这个仓库，见 lib/git-changes.js)：先用项目目录 (Agent 启动时的目录)，
    // 没有才用事件里的 cwd (Agent 在里面 cd 到别处会跟着变)。会话历史刚切过去时，退出的旧 Agent 晚到的事件 (旧目录) 不算
    const dir = (typeof ev.proj === 'string' && ev.proj) || (typeof ev.cwd === 'string' && ev.cwd) || '';
    if (typeof ev.session_id === 'string' && ev.session_id) {
      this.hookSid = { id: ev.session_id, at: now }; // 这个标签里 Agent 在用的对话 (删除会话历史前查，见 agent-sessions.js)
      this.noteDaemonAgent?.({ sid: ev.session_id, ended: false }); // 常驻会话：接上这个会话时按它里面的对话还原标签改过的名字 (见 daemon.js)
      this.noteConvTab?.(); // 对话记下这个标签命的名 (会话历史的胶囊、「继续」时还原，见 session/index.js)
    }
    if (dir && !(this.freshAgentCwd() && !insideDir(dir, this.agentCwd))) {
      this.setAgentCwd(dir);
      this.noteDaemonAgent?.({ cwd: dir }); // 常驻会话：接会话的选择框里显示它 (见 daemon.js)
    }
    // 不是 Claude 的在说明前面写上是谁 (「Codex · 做完了：…」)
    const who = (t) => (agent === 'claude' || !t ? t : `${AGENT_NAME[agent]} · ${t}`);
    const set = (kind, extra = {}) => {
      if (extra.why) extra.why = who(extra.why);
      this.hook = { kind, at: now, agent, pane: String(ev.pane || ''), ...extra };
    };
    const tool = () => ({ tool: short(ev.command || ev.file_path || ev.url || '', 60), toolName: ev.tool_name || '' });
    const done = () => {
      const msg = short(ev.last_assistant_message, 100);
      if (msg) this.noteDaemonAgent?.({ last: msg }); // 常驻会话：选择框里显示最新一次对话内容 (Agent 的回复)
      set('done', { why: msg ? `做完了：${msg}` : '做完了' });
    };
    switch (evName(ev.hook_event_name)) {
      case 'user_prompt_submit': case 'before_agent': case 'pre_invocation': { // 开始干活：记下你让它做什么 (状态卡片上显示「在做：…」)
        const prompt = String(ev.prompt || '').replace(/^\s*<user_query>([\s\S]*?)(<\/user_query>)?\s*$/, '$1'); // Grok 把你的话包在 <user_query> 里
        // 系统消息 (后台任务通知、<system-reminder> 之类) 不是你让它做的事：不当成任务、也不参与名称和「最新消息」
        const sysMsg = /^\s*<(task-notification|system-reminder|local-command|command-name|command-message)\b/.test(prompt);
        this.hookTask = sysMsg ? '' : short(prompt, 80);
        // 常驻会话：选择框里只更新「最新发送的消息」。
        // 名称不跟着每一句话改 —— 以前这里每来一句话就把 name 换成「Claude：这句话」，会话名称看着就是
        // 你刚打的最后一句 (还会被 <task-notification> 这类系统消息顶掉)。名称优先从主机的会话文件里读
        // (见 agent-sessions.js 的 claudePeek)，读不到才用这里的兜底：只在还没有名称时记第一次说的话
        // 记兜底名：只在还没有名称时记第一次说的话。换了对话 (会话号变了) 就重新记一次 ——
        // 以前这个标记一旦设上就再也不重置，/clear 后开新对话兜底名还停在旧的那句
        if (this.hookTask && (!this.hookNameSet || this.hookNameSid !== ev.session_id)) {
          this.hookNameSet = true;
          this.hookNameSid = ev.session_id;
          this.noteDaemonAgent?.({ name: `${AGENT_NAME[agent] || 'Claude'}：${this.hookTask}`, last: this.hookTask });
        } else if (this.hookTask) this.noteDaemonAgent?.({ last: this.hookTask });
        set('run');
        break;
      }
      case 'pre_tool_use': case 'before_tool':
        if (isAskTool(ev.tool_name)) set('ask', { why: ev.question ? `问你：${short(ev.question, 100)}` : '有问题要你回答', seq: ++this.hookSeq });
        else if (agent === 'antigravity' && ev.tool_name === 'ask_permission') set('perm', { why: '需要你确认', seq: ++this.hookSeq });
        else if (agent !== 'claude') set('run', tool()); // Claude 的 PreToolUse 只装了问问题的
        else return;
        break;
      case 'post_tool_use': case 'after_tool': case 'post_tool_use_failure':
        set('run', tool());
        break;
      case 'post_invocation':
        set('run');
        break;
      case 'permission_request':
        set('perm', { why: permText(ev), seq: ++this.hookSeq });
        break;
      case 'notification': {
        const type = evName(ev.notification_type);
        // 要权限：一般 PermissionRequest 刚报过 (写得更具体)，那就不用它的
        if (agent === 'grok') {
          if (grokRoutine(ev) || !askyText(ev.message)) return;
          set('perm', { why: short(ev.message) || '需要你确认', seq: ++this.hookSeq });
        } else if (type === 'permission_prompt' || type === 'tool_permission') {
          if (this.hook?.kind === 'perm' && now - this.hook.at < 5000) return;
          set('perm', { why: short(ev.message) || '需要你确认', seq: ++this.hookSeq });
        } else if (type === 'elicitation_dialog') {
          set('ask', { why: short(ev.message) || '有问题要你回答', seq: ++this.hookSeq });
        } else return;
        break;
      }
      case 'stop':
        if (ev.busy) { set('run'); break; } // Antigravity 步骤之间的 Stop：还没做完
        done();
        break;
      case 'after_agent':
        done();
        break;
      case 'stop_cancelled': case 'interrupt':
        set('done', { why: '已中断' });
        break;
      case 'stop_failure':
        set('error', { why: short(ev.error_details || ev.error, 160) || 'API 出错' });
        break;
      case 'session_end':
        this.hook = null;
        if (!ev.session_id || this.hookSid?.id === ev.session_id) this.hookSid = null; // Agent 退出了：不再算它在用这个对话
        this.noteDaemonAgent?.({ ended: true }); // 常驻会话也记下：之后改名不再记到这个对话上 (见 daemon.js 的 daemonAgentSid)
        // Agent 退出了：它的目录不再算项目目录 (切到别的对话时右边栏不再停在旧目录)。
        // 会话历史切过去时退出的那个旧 Agent 的 SessionEnd 会晚到，不能清掉刚切过去的目录
        if (!this.freshAgentCwd()) this.setAgentCwd('');
        break;
      default:
        return;
    }
    this.updateState();
  }

  // 钩子给出的状态；没有 / 过期了返回 null (改看屏幕)。待选择 / 完成 / 报错在有人往这个标签发过内容后就算处理了
  hookState(now) {
    const h = this.hook;
    if (!h) return null;
    const answered = this.tracker.dataAt > h.at;
    if ((h.kind !== 'run' && answered) || now - h.at > HOOK_MAX
      || (h.kind === 'run' && now - h.at > HOOK_RUN_STALE && this.tracker.evaluate(this.term, now).cls !== 'run')) {
      this.hook = null;
      // 交还给看屏幕判断：钩子管着的这段时间屏幕判断没在跑，它记着的「刚才在运行」是很早以前的，
      // 不清掉会一接手就当成刚跑完、又显示「完成」
      this.tracker.running = false;
      this.tracker.doneAt = 0;
      return null;
    }
    // detail：状态卡片上那一行「在做什么」
    switch (h.kind) {
      case 'run': {
        const detail = this.hookTask ? `在做：${this.hookTask}` : h.tool ? `刚用了 ${h.toolName}：${h.tool}` : '';
        return { label: '运行中', cls: 'run', detail, hook: true };
      }
      // 通知上的「允许 / 拒绝」只给 Claude Code (别家的确认框按键不一样，没法确认按了是什么)
      case 'perm': return { label: '待选择', cls: 'bad', why: h.why, detail: h.why, perm: (h.agent || 'claude') === 'claude', seq: h.seq, hook: true };
      case 'ask': return { label: '待选择', cls: 'bad', why: h.why, detail: h.why, seq: h.seq, hook: true };
      case 'done': return { label: '完成', cls: 'done', why: h.why, detail: h.why, hook: true };
      case 'error': return { label: '报错', cls: 'bad', why: h.why, detail: h.why, hook: true };
      default: return null;
    }
  }

  // 通知上点了「允许 / 拒绝」：确认框还在 (还是那一次、没人处理过、屏幕上还看得到) 才发 回车 (选中的「1. Yes」) / Esc (No)。
  // 在 tmux 里直接发给事件所在的 pane (不管这个标签现在显示的是不是它)
  answerPerm(choice, seq, cb) {
    const h = this.hook;
    if (!h || h.kind !== 'perm' || h.seq !== seq || this.tracker.dataAt > h.at) return cb('这个确认已经处理过了');
    if ((h.agent || 'claude') !== 'claude') return cb('只有 Claude Code 的确认能在通知上直接回答');
    const done = () => {
      this.tracker.onInput(Date.now(), true);
      this.hook = choice === 'allow' ? { kind: 'run', at: Date.now(), pane: h.pane } : null;
      this.updateState();
      cb(null);
    };
    const pane = /^%\d+$/.test(h.pane) ? h.pane : '';
    if (pane) {
      const key = choice === 'allow' ? 'Enter' : 'Escape';
      const script = `p='${pane}'; tmux capture-pane -p -t "$p" | tail -n 30 | grep -qE 'Do you want|❯ *[0-9]+\\.' || exit 7; tmux send-keys -t "$p" ${key}`;
      return this.runScript(script, (r) => {
        if (!r) return cb('在目标主机上执行命令失败');
        if (r.code === 7) return cb('目标主机上已经看不到这个确认框 (可能已经处理过了)');
        if (r.code !== 0) return cb('发送按键失败');
        done();
      });
    }
    if (!CHOICE_RE.test(screenTail(this.term))) return cb('终端上已经看不到这个确认框 (可能已经处理过了)');
    this.writeNow(choice === 'allow' ? '\r' : '\x1b', null, null);
    done();
  }
}

module.exports = SessionHooks;
// 网页上安装 / 卸载了钩子 (见 lib/hooks.js)：马上按新的来，不用等重新连接
module.exports.setInstalled = (s, on) => installed.set(hostKey(s), !!on);
module.exports.rewatch = rewatch;
module.exports.hostKey = hostKey;
