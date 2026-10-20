'use strict';
// 会话：读 Claude Code 钩子报来的事件 (钩子见 lib/hooks.js)，按事件给出主机状态、推送具体内容、在通知上直接允许 / 拒绝。
// 方法挂到 Session 上 (见 index.js)。
//
// 每台主机只开一个通道读 (挑一个连着的标签，执行 tail -F ~/.cache/ssh-web/hook.log)，这个标签断了换另一个接手；
// 没装钩子的主机文件不存在，tail 就一直等着，不创建任何文件。每行事件里带着它属于哪些标签 (LC_SSHWEB)，交给对应的会话

const { CHOICE_RE, screenTail } = require('../status');

const watchers = new Map(); // 主机 → { sess, ch, buf, at }
const installed = new Map(); // 主机 → 装没装钩子 (有没有 ~/.ssh-web/hook.sh)：装了就只按钩子推送
const hostKey = (s) => s.hostId || s.histHost || s.title;
const allSessions = () => require('./index').sessions; // 运行时再取 (index.js 也引用这个文件)

function startWatch(s) {
  const key = hostKey(s);
  if (watchers.has(key) || s.status !== 'connected' || !s.ssh) return;
  const w = { sess: s, ch: null, buf: '', at: Date.now() };
  watchers.set(key, w);
  // 先报一行装没装钩子 (SSHWEB_HOOKS=1 / 0)，再一直读事件
  const cmd = 'if [ -f "$HOME/.ssh-web/hook.sh" ]; then echo SSHWEB_HOOKS=1; else echo SSHWEB_HOOKS=0; fi; exec tail -n 0 -F "$HOME/.cache/ssh-web/hook.log" 2>/dev/null';
  s.ssh.exec(cmd, (err, ch) => {
    if (err || watchers.get(key) !== w || s.status !== 'connected') {
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
        const line = w.buf.slice(0, i);
        w.buf = w.buf.slice(i + 1);
        const m = /^SSHWEB_HOOKS=([01])$/.exec(line.trim());
        if (m) installed.set(key, m[1] === '1');
        else routeHookLine(line);
      }
      if (w.buf.length > 1 << 20) w.buf = '';
    });
    ch.on('close', () => {
      if (watchers.get(key) !== w) return;
      watchers.delete(key);
      // tail 一开就退出 (目标主机上用不了)：过一会儿再试，不来回重开
      if (Date.now() - w.at < 5000) setTimeout(() => handoff(key), 60000).unref();
      else handoff(key);
    });
  });
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

function routeHookLine(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return; }
  if (!ev || typeof ev !== 'object' || typeof ev.hook_event_name !== 'string') return;
  const sessions = allSessions();
  for (const id of String(ev.tabs || '').split(/\s+/).filter(Boolean)) sessions.get(id)?.onHook(ev);
}

// 推送里写的内容
const short = (s, n = 120) => {
  const t = String(s || '').split('\n').map((x) => x.trim()).find(Boolean) || '';
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const TOOL_VERB = { Bash: '执行', Edit: '修改', MultiEdit: '修改', Write: '写入', NotebookEdit: '修改', Read: '读取', WebFetch: '访问', WebSearch: '搜索' };
function permText(ev) {
  const what = short(ev.command || ev.file_path || ev.url || '', 100);
  const verb = TOOL_VERB[ev.tool_name];
  if (verb && what) return `要${verb}${ev.tool_name === 'Bash' ? '命令' : ''}：${what}`;
  return `要使用 ${ev.tool_name || '工具'}${what ? '：' + what : ''}`;
}

const HOOK_RUN_STALE = 10 * 60 * 1000; // 「运行中」这么久没有新事件、屏幕上也不像在跑：不再信钩子
const HOOK_MAX = 6 * 3600 * 1000;

class SessionHooks {
  watchHooks() { startWatch(this); }
  unwatchHooks() { stopWatch(this); }

  // 这个标签用钩子推送：这台主机装了钩子，或者收到过钩子事件。是的话终端响铃、看屏幕判断的状态都不再推送
  // (Claude Code 做完 / 要权限时自己也会响铃，不然一件事推两次)
  usingHooks() { return !!this.hookSeenAt || installed.get(hostKey(this)) === true; }

  // 收到这个标签的一条钩子事件
  onHook(ev) {
    const now = Date.now();
    this.hookSeenAt = now; // 这个标签有 Agent 装了钩子：以后只按钩子推送 (见 index.js 的 alert / updateState)
    const set = (kind, extra = {}) => { this.hook = { kind, at: now, pane: String(ev.pane || ''), ...extra }; };
    switch (ev.hook_event_name) {
      case 'UserPromptSubmit':
      case 'PostToolUse':
        set('run');
        break;
      case 'PreToolUse':
        if (ev.tool_name === 'AskUserQuestion') set('ask', { why: ev.question ? `问你：${short(ev.question, 100)}` : '有问题要你回答', seq: ++this.hookSeq });
        break;
      case 'PermissionRequest':
        set('perm', { why: permText(ev), seq: ++this.hookSeq });
        break;
      case 'Notification':
        // 要权限：一般 PermissionRequest 刚报过 (写得更具体)，那就不用它的
        if (ev.notification_type === 'permission_prompt') {
          if (this.hook?.kind === 'perm' && now - this.hook.at < 5000) return;
          set('perm', { why: short(ev.message) || '需要你确认', seq: ++this.hookSeq });
        } else if (ev.notification_type === 'elicitation_dialog') {
          set('ask', { why: short(ev.message) || '有问题要你回答', seq: ++this.hookSeq });
        } else return;
        break;
      case 'Stop': {
        const msg = short(ev.last_assistant_message, 100);
        set('done', { why: msg ? `做完了：${msg}` : '做完了' });
        break;
      }
      case 'StopFailure':
        set('error', { why: short(ev.error_details || ev.error, 160) || 'API 出错' });
        break;
      case 'SessionEnd':
        this.hook = null;
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
    switch (h.kind) {
      case 'run': return { label: '运行中', cls: 'run', hook: true };
      case 'perm': return { label: '待选择', cls: 'bad', why: h.why, perm: true, seq: h.seq, hook: true };
      case 'ask': return { label: '待选择', cls: 'bad', why: h.why, seq: h.seq, hook: true };
      case 'done': return { label: '完成', cls: 'done', why: h.why, hook: true };
      case 'error': return { label: '报错', cls: 'bad', why: h.why, hook: true };
      default: return null;
    }
  }

  // 通知上点了「允许 / 拒绝」：确认框还在 (还是那一次、没人处理过、屏幕上还看得到) 才发 回车 (选中的「1. Yes」) / Esc (No)。
  // 在 tmux 里直接发给事件所在的 pane (不管这个标签现在显示的是不是它)
  answerPerm(choice, seq, cb) {
    const h = this.hook;
    if (!h || h.kind !== 'perm' || h.seq !== seq || this.tracker.dataAt > h.at) return cb('这个确认已经处理过了');
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
