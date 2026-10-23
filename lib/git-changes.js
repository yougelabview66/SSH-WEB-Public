'use strict';
// 代码改动 (参考 Orca 的源代码管理 + AI 改动批注)：看目标主机上项目仓库里改了哪些文件、每个文件改了什么，
// 浏览器里在改动的行上写批注发回 Agent (见 public/app/66-git-changes.js)。只读：不暂存、不提交、不撤销。
// 项目目录：钩子报来的 Agent 工作目录 → tmux 窗格当前目录 → 这个标签里 shell 的当前目录 (Linux 读 /proc，Windows 用 shell 报的) → 主目录；也能手动指定。
// git 命令借 SSH 连接执行 (rawExec，不经过 sh：Windows 上由 cmd / PowerShell 执行)，几条连成一次 (Windows 开通道慢)

const { liveSession } = require('./session');

const MAX_FILES = 2000; // 改动 / 未跟踪的文件最多列这么多
const MAX_DIFF = 512 * 1024; // 单个文件的改动最多这么大，多了截断
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // 还没有提交的仓库：跟空树比

const run = (sess, cmd) => new Promise((resolve) => sess.rawExec(sess.ssh, cmd, resolve));
// 按 SSH 默认的 shell 给参数加引号；几条命令怎么连 (sh ; / cmd & / PowerShell ;)
const quoter = (base) => (base === 'sh' ? (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
  : base === 'powershell' ? (s) => `'${String(s).replace(/'/g, "''")}'` : (s) => `"${String(s).replace(/"/g, '')}"`);
const joiner = (base) => (base === 'cmd' ? ' & ' : ' ; ');

// 这个标签现在的项目目录 (找不到返回 '')；sess.projFromAgent 记下是不是 Agent 干活的目录。
// 钩子报的目录优先 (Claude Code / Gemini 报项目目录，别的报事件里的 cwd，见 session/hooks.js 的 onHook)：报过就一直用它，
// 直到 Agent 退出 (SessionEnd) 或者会话历史切到别的对话；不拿主机上找进程的结果推翻它 (以前在 Agent 的子进程 / 别的窗格里
// 找到的目录会来回顶掉钩子报的，右边栏一会儿跳到别的目录、一会儿跳回来)。
// 只有一种情况不再信它：主机上这个标签里一个 Agent 都找不到了 (被直接杀掉、没报 SessionEnd)，回到终端所在的目录。
// 钩子没报过 (没装钩子)：Linux 上在主机上找 —— 在 tmux 里看这个标签的 tmux 客户端所在会话里有没有 Agent 窗格 (先看正在看的那个)，
// 不在 tmux 里在 /proc 里找带标记的 Agent 进程；Windows 读不到别的进程的当前目录，用 shell 报的 (OSC 9;9 / OSC 7)
const AGENT_NAMES = 'claude|codex|gemini|grok|opencode';
async function projectDir(sess, base) {
  if (base !== 'sh') {
    sess.projFromAgent = !!sess.agentCwd;
    return sess.agentCwd || sess.termCwd || '';
  }
  // 认这个标签的进程：LC_SSHWEB=<标签>；常驻会话里是 SSHWEBD_SESSION=<会话> + 创建时间 (见 daemon.js 的 markerTest / markedPidsSh)。
  // AGENT：确定是 Agent 的目录；MAYBE：前台是 node (可能是 Gemini 等，也可能是开发服务)，不拿它推翻钩子报的
  const script = [
    'PATH="$PATH:/usr/local/bin:/opt/homebrew/bin"',
    'if command -v tmux >/dev/null 2>&1; then',
    `  for c in $(tmux list-clients -F '#{client_pid}:#{pane_id}' 2>/dev/null); do`,
    `    if ${sess.markerTest('"/proc/${c%%:*}/environ"')}; then`,
    '      t=${c#*:}',
    `      d=$(tmux display -p -t "$t" '#{pane_current_path}'); cmd=$(tmux display -p -t "$t" '#{pane_current_command}')`,
    `      case "$cmd" in ${AGENT_NAMES}) echo "AGENT $d";; node) echo "MAYBE $d";; *)`,
    // 正在看的不是 Agent：同一个 tmux 会话里别的窗格开着 Agent 就用它的
    `        tmux list-panes -s -t "$t" -F '#{pane_current_command} #{pane_current_path}' 2>/dev/null | while read -r n p; do case "$n" in ${AGENT_NAMES}) echo "AGENT $p"; break;; esac; done;;`,
    '      esac',
    '      echo "DIR $d"; exit 0',
    '    fi',
    '  done',
    'fi',
    sess.markedPidsSh(),
    'set -f', // 下面按空格拆命令行：里面的 * 等不要展开成文件名
    // 带标记的进程里：最新的 Agent 进程 (程序名是 claude 等，或者 node / bun 跑的 claude 等脚本；Claude Code 执行命令时的
    // 子进程命令行里带着 ~/.claude/shell-snapshots，不能算) 和最新的进程 (前台在跑的程序) 的当前目录
    'a=; b=',
    'for p in $pids; do',
    '  [ -r "/proc/$p/cmdline" ] || continue',
    '  b=$p',
    `  set -- $(tr '\\0' ' ' < "/proc/$p/cmdline" 2>/dev/null) ''; n0=\${1##*/}; n1=\${2##*/}`,
    `  case "$n0" in ${AGENT_NAMES}) a=$p;; node|nodejs|bun|deno) case "$n1" in ${AGENT_NAMES.split('|').map((n) => `${n}|${n}.*`).join('|')}) a=$p;;`,
    `    cli.js|cli.mjs|index.js) case "$2" in ${AGENT_NAMES.split('|').map((n) => `*/${n}*/*`).join('|')}) a=$p;; esac;; esac;; esac`,
    'done',
    // Agent 运行了多少秒 (/proc/<pid>/stat 第 22 项是开机后第几个时钟周期启动的)：和钩子最后一次报目录的时间比，按主机自己的钟算
    '[ -n "$a" ] && echo "AGENT $(readlink "/proc/$a/cwd")"',
    '[ -n "$b" ] && echo "DIR $(readlink "/proc/$b/cwd")"',
    'exit 0',
  ].join('\n');
  const r = await new Promise((resolve) => sess.rawExec(sess.ssh, `sh -c ${quoter('sh')(script)}`, resolve, 8000));
  const line = (k) => (r.out.split('\n').find((l) => l.startsWith(k + ' ')) || '').slice(k.length + 1).trim();
  const agent = line('AGENT'), maybe = line('MAYBE'), dir = line('DIR');
  // 钩子记的目录还在、主机上这个标签里却一个 Agent 都找不到了 (查得到进程才算数)：Agent 被直接杀掉、没报 SessionEnd，
  // 不再用 (不再通知网页，这次就按新的读)。会话历史刚切过去的不算 (新的 Agent 还没起来)
  if (sess.agentCwd && r.code === 0 && !agent && !maybe && dir && !sess.freshAgentCwd?.()) { sess.setAgentCwd?.('', true); sess.hookSid = null; }
  sess.projFromAgent = !!(sess.agentCwd || agent || maybe);
  return sess.agentCwd || agent || maybe || dir;
}

// porcelain v1 -z：「XY 路径\0」，改名 / 复制是「XY 新路径\0旧路径\0」
function parseStatus(out) {
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2), path = e.slice(3);
    const f = { path, xy };
    if (xy[0] === 'R' || xy[0] === 'C') f.from = parts[++i];
    f.status = xy === '??' ? 'untracked' : xy.includes('U') || xy === 'AA' || xy === 'DD' ? 'conflict'
      : xy.includes('D') ? 'deleted' : xy[0] === 'R' ? 'renamed' : xy.includes('A') ? 'added' : 'modified';
    files.push(f);
  }
  return files;
}
// numstat -z：「增\t删\t路径\0」，改名是「增\t删\t\0旧\0新\0」；二进制是「-\t-\t」
function parseNumstat(out) {
  const parts = out.split('\0'), m = new Map();
  for (let i = 0; i < parts.length; i++) {
    const t = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i]);
    if (!t) continue;
    let path = t[3];
    if (!path) { i++; path = parts[++i]; } // 改名：跳过旧路径，用新路径
    m.set(path, t[1] === '-' ? { binary: true } : { add: +t[1], del: +t[2] });
  }
  return m;
}

// 一次执行几条命令，用标记分开各自的输出
async function multi(sess, base, cmds) {
  const marks = cmds.map((_, i) => `__SSHWEB_G${i}__`);
  const all = cmds.map((c, i) => `${c}${joiner(base)}echo ${marks[i]}`).join(joiner(base));
  const r = await run(sess, base === 'sh' ? `sh -c ${quoter('sh')(all)}` : all);
  const res = [];
  let at = 0;
  for (const m of marks) {
    const j = r.out.indexOf(m, at);
    if (j < 0) { res.push(''); continue; }
    res.push(r.out.slice(at, j));
    at = j + m.length;
    at += /^ ?\r?\n/.exec(r.out.slice(at))?.[0].length || 0;
  }
  return res;
}

async function status(sess, dir) {
  const base = await sess.shellBase(sess.ssh);
  const q = quoter(base);
  let source = 'manual';
  if (!dir) {
    dir = await projectDir(sess, base);
    source = sess.projFromAgent && dir ? 'agent' : dir ? 'terminal' : 'home';
  }
  const at = dir || '.';
  const [top, branch, head] = await multi(sess, base, [
    `git -C ${q(at)} rev-parse --show-toplevel`,
    `git -C ${q(at)} rev-parse --abbrev-ref HEAD`,
    `git -C ${q(at)} rev-parse --verify -q HEAD`,
  ]);
  const root = top.trim().split(/\r?\n/).pop() || '';
  if (!root || /fatal|not a git|不是/i.test(top)) return { dir: at, source, error: `${dir || '主目录'} 不是 git 仓库（或者这台主机上没有 git）` };
  const against = head.trim() ? 'HEAD' : EMPTY_TREE;
  const [st, num] = await multi(sess, base, [
    `git -C ${q(root)} -c core.quotepath=off status --porcelain=v1 -z -uall`,
    `git -C ${q(root)} -c core.quotepath=off diff ${against} --numstat -z`,
  ]);
  const counts = parseNumstat(num);
  const files = parseStatus(st).slice(0, MAX_FILES).map((f) => ({ ...f, ...(counts.get(f.path) || {}) }));
  return { dir: at, source, root, branch: head.trim() ? branch.trim() : '(还没有提交)', files, more: parseStatus(st).length > MAX_FILES };
}

async function diff(sess, root, path, untracked, from) {
  const base = await sess.shellBase(sess.ssh);
  const q = quoter(base);
  const head = (await run(sess, `git -C ${q(root)} rev-parse --verify -q HEAD`)).out.trim();
  // 未跟踪的新文件：和空文件比 (整个文件算新增)
  const cmd = untracked ? `git -C ${q(root)} -c core.quotepath=off diff --no-index --no-color --no-ext-diff -- /dev/null ${q(path)}`
    : `git -C ${q(root)} -c core.quotepath=off diff ${head ? 'HEAD' : EMPTY_TREE} -M --no-color --no-ext-diff -U3 -- ${q(path)}${from ? ' ' + q(from) : ''}`; // 改名的带上旧路径，显示成改名
  const r = await run(sess, base === 'sh' ? `sh -c ${quoter('sh')(cmd)}` : cmd);
  let text = r.out.replace(/\r\n/g, '\n');
  const truncated = text.length > MAX_DIFF;
  if (truncated) text = text.slice(0, text.lastIndexOf('\n', MAX_DIFF) + 1);
  return { diff: text, binary: /^Binary files .* differ$/m.test(text), truncated };
}

function registerGitChanges(app) {
  const route = (fn) => async (req, res) => {
    const s = liveSession(String(req.body?.sid || ''));
    if (!s) return res.status(404).json({ error: '会话不存在或已断开' });
    try {
      res.json(await fn(s, req.body || {}));
    } catch (e) {
      res.status(400).json({ error: e.message || String(e) });
    }
  };
  app.post('/api/git/status', route((s, b) => status(s, String(b.dir || '').trim())));
  app.post('/api/git/diff', route((s, b) => {
    if (!b.root || !b.path) throw new Error('缺少参数');
    return diff(s, String(b.root), String(b.path), !!b.untracked, b.from ? String(b.from) : '');
  }));
}

module.exports = { registerGitChanges, status, diff, parseStatus, parseNumstat, projectDir, quoter, run };
