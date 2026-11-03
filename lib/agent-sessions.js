'use strict';
// Agent 会话历史：列出目标主机上 Claude Code / Grok / Codex / Antigravity / OpenCode / pi 以前的会话，
// 搜索，点「继续」在终端里执行恢复命令 (cd 到原来的目录 && claude --resume <id> 等)。
// 会话文件可能很大 (Claude 一个会话十几 MB)：在目标主机上用 sh / grep 只抽出标题、目录、第一句话、时间，不把文件传回来。
// Windows 主机 (cmd / PowerShell，没有 sh)：改用 SFTP，每个文件只读开头和结尾一段，抽出同样的字段；全文搜索分块读、有时间上限
// 除了 Claude Code 和 Grok，各家的会话格式是照着各家的文档写的，没在真的 Agent 上测过

const { posix } = require('path');
const { liveSession, sessions } = require('./session');
const { hostKey } = require('./session/hooks');
const { sftpOf } = require('./sftp');
const { screenTail, CLAUDE_RUN_RE, CLAUDE_DONE_RE } = require('./status');
const { tabNamesOf } = require('./store');
const { AGENT_LIST, procCase, agentById } = require('./agents');
const { unq, oneLine } = require('./agents/util');

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

// 各家：会话文件在哪、抽哪些字段 (输出：「@@ 修改时间 大小 路径」开头一个会话，下面每行「字段<Tab>值」)、怎么继续。
// 每个 Agent 一个文件，见 lib/agents/ 里各自的 sessions 一节 (script / sftp / parse / resume / hide / items / mark)
const AGENTS = Object.fromEntries(AGENT_LIST.filter((a) => a.sessions).map((a) => [a.id, { name: a.name, tested: !!a.tested, ...a.sessions }]));

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

async function list(sess, agent, q) {
  const a = AGENTS[agent];
  if (!a) throw new Error('不认识的 Agent');
  const query = String(q || '').slice(0, 200).replace(/[\r\n]/g, ' ');
  // 终端里的 shell (决定恢复命令的写法)；SSH 默认是 cmd / PowerShell 的就是 Windows 主机，用 SFTP 读
  const shell = await sess.termShell().catch(() => 'sh');
  const win = sess.shellOf && sess.shellOf.base !== 'sh';
  let out, extra, partial = false;
  if (win) {
    ({ out, extra, partial } = await scanSftp(sess, agent, query));
  } else {
    // a.env：脚本要用的大段内容 (OpenCode 查 SQLite 的 python 程序)，放进变量
    const env = Object.entries(a.env || {}).map(([k, v]) => `${k}=${shq(v)}\n`).join('');
    const script = `Q=${shq(query)}; N=${MAX_LIST}; SCAN=${SCAN}\n${env}${PRELUDE}${a.script}\n`;
    ({ out, extra } = parseOut(await execOut(sess, script)));
  }
  const ctx = a.context ? a.context(extra) : {}; // 不属于某个会话的行 (Codex 的起名索引)
  const sessions = [];
  // 聊这个对话时标签的名字 (「继续」时还原，见 resumeInTerminal)：列表里显示成「主机名-名字」胶囊 (主机名用现在的)；
  // 没命过名的、以前的对话 (没记过) 不显示
  const named = tabNamesOf('conv');
  for (const r of out) {
    const x = a.parse(r, ctx); // 各家的一条会话 → { id, title, prompt, cwd }
    if (!x || !/^[\w.-]{1,200}$/.test(x.id)) continue; // id 要拼进命令：只认字母数字和 . _ -
    remember(sess, agent, x.id, r.path); // 删除时按这个找 (只有命令没说过话的 Claude 会话也记，不列出来)
    if (a.hide?.(x)) continue; // 不列出来的 (Claude：只有 /clear 之类命令、没说过话的)
    const tab = named[`${hostKey(sess)}|${x.id}`]?.title;
    sessions.push({ ...x, mtime: r.mtime, size: r.size, cmd: resumeCmd(shell, x.cwd, a.resume(x.id)), ...(tab && { tab: `${sess.title}-${tab}` }) });
  }
  sessions.sort((x, y) => y.mtime - x.mtime);
  return { agent, name: a.name, tested: !!a.tested, q: query, sessions, more: out.length >= MAX_LIST, partial };
}

// ---- Windows 主机：用 SFTP 读 (抽出和 sh 脚本一样的字段，后面共用各家的 parse)
const SFTP_BUDGET = 15000; // 搜索最多花这么久，超时就只给已经搜到的
const pr = (fn) => new Promise((resolve, reject) => fn((e, v) => (e ? reject(e) : resolve(v))));
// "字段":"…" 的值 (原样的 JSON 字符串)：第一个 / 最后一个
const jre = (k) => new RegExp(`"${k}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`, 'g');
const jfirst = (t, k) => { const m = jre(k).exec(t); return m ? m[1] : ''; };
const jlast = (t, k) => { let m, v = ''; const re = jre(k); while ((m = re.exec(t))) v = m[1]; return v; };
const oneLn = (t) => t.replace(/[\r\n\t]/g, ' ');

// 一次最多同时做 n 件 (SFTP 请求可以并行，一个个排队等太慢)，结果按原来的顺序
async function mapLimit(arr, n, fn) {
  const out = new Array(arr.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, arr.length) }, async () => {
    while (i < arr.length) { const k = i++; out[k] = await fn(arr[k], k); }
  }));
  return out;
}
// 读过的会话文件抽出的字段：主机 + 路径 → { mtime, size, fields }；文件没变 (修改时间、大小一样) 就不再读
const fieldCache = new Map();
const FIELD_CACHE_MAX = 1500; // 长期运行下别无限涨 (每条最多一个 head 的大小)

async function scanSftp(sess, agent, q) {
  const sftp = await sftpOf(sess);
  const home = await pr((cb) => sftp.realpath('.', cb));
  const hostKey = sess.hostId || sess.histHost || sess.title;
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
  // 一层层列目录 (同一层的并行列)：dirs → 下一层的子目录
  const subdirs = async (dirs) => (await mapLimit(dirs, 8, async (d) => (await ls(d)).filter(isDir).map((e) => posix.join(d, e.filename)))).flat();
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
  // 候选文件按修改时间排；搜索时并行看最近的 SCAN 个，留下最近的 MAX_LIST 个
  const pick = async (files, test = has) => {
    files.sort((x, y) => y.mtime - x.mtime);
    if (!q && test === has) return files.slice(0, MAX_LIST);
    const cand = files.slice(0, SCAN);
    const ok = await mapLimit(cand, 8, (f) => test(f));
    return cand.filter((f, i) => ok[i]).slice(0, MAX_LIST);
  };
  // 抽字段 (文件没变就用记住的)，结果按顺序放进 out
  const out = [], extra = [];
  const collect = async (files, make) => {
    const fields = await mapLimit(files, 8, async (f) => {
      const key = `${hostKey}|${f.path}`, c = fieldCache.get(key);
      if (c && c.mtime === f.mtime && c.size === f.size) return c.fields;
      const v = await make(f);
      fieldCache.delete(key);
      // 上限 = head 一次读的大小：正常抽出来的字段到不了这个数 (不改变行为)，只是防着特别大的值把内存吃光
      const small = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' && x.length > 65536 ? x.slice(0, 65536) : x]));
      fieldCache.set(key, { mtime: f.mtime, size: f.size, fields: small });
      if (fieldCache.size > FIELD_CACHE_MAX) fieldCache.delete(fieldCache.keys().next().value);
      return v;
    });
    files.forEach((f, i) => out.push({ path: f.path, mtime: f.mtime, size: f.size, f: Object.fromEntries(Object.entries(fields[i]).map(([k, v]) => [k, [v]])) }));
  };
  // 一批目录里符合名字的文件
  const filesIn = async (dirs, test, more = () => ({})) => (await mapLimit(dirs, 8, async (d) => (await ls(d)).filter((e) => !isDir(e) && test(e.filename)).map((e) => ({ ...file(d, e), ...more(d, e) })))).flat();

  // 各家在哪、抽哪些字段：见 lib/agents/ 里各自的 sessions.sftp (用上面这些工具)
  // sftp / home / q / push：不是一个个文件的 (OpenCode 的 SQLite 数据库)，自己读、自己放进结果
  await AGENTS[agent].sftp({ J, ls, file, subdirs, filesIn, mapLimit, pick, has, collect, head, tail, readPart, jfirst, jlast, oneLn, extra,
    sftp, home, q, MAX: MAX_LIST, SCAN, push: (row) => out.push(row) });
  return { out, extra, partial };
}

// 「继续」：在这个标签的终端里执行恢复命令。标签里还开着 Agent (Claude Code / Codex / Grok …) 时，命令会打进它的输入框：
// 先按两下 Ctrl+C 退出它 (这几家都是这样退出)，等光标那一行变回 shell 的提示符再执行；退不出来就不执行，让人手动退出
// 各 Agent 模块里可以再写自己的 screen (界面上一直有的字，比如 pi 底部状态栏的上下文用量「0.0%/128k」)，合进来一起认
const AGENT_SCREEN_RE = new RegExp([/\? for shortcuts|esc to interrupt|ctrl\+c again|ctrl\+c to exit|⏵⏵|shift\+tab to cycle|type your message|send ⏎|context left/.source,
  ...AGENT_LIST.filter((a) => a.screen).map((a) => a.screen.source)].join('|'), 'i');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function cursorLine(sess) {
  const b = sess.term?.buffer?.active;
  return (b && b.getLine(b.baseY + b.cursorY)?.translateToString(true).trim()) || '';
}
// 光标下面的几行 (Agent 的输入行下面是它的状态行；shell 的提示符下面是空的)
function belowCursor(sess) {
  const b = sess.term?.buffer?.active, out = [];
  if (!b) return '';
  for (let y = b.cursorY + 1; y < sess.term.rows; y++) out.push(b.getLine(b.baseY + y)?.translateToString(true) || '');
  return out.join('\n');
}
// Agent 的界面还在：光标在它的输入行上 (以 > › ❯ │ 开头)，或者光标那行 / 下面有它的状态行
const agentAtCursor = (sess) => /^[>›❯│]/.test(cursorLine(sess)) || AGENT_SCREEN_RE.test(cursorLine(sess) + '\n' + belowCursor(sess));
function agentOnScreen(sess) {
  const t = screenTail(sess.term);
  return AGENT_SCREEN_RE.test(t) || CLAUDE_RUN_RE.test(t) || CLAUDE_DONE_RE.test(t);
}
// 光标那一行像 shell 的提示符：Windows 的 PS D:\x> / D:\x>；Linux 等以 $ # % ❯ ➜ > 结尾 (Agent 自己的输入行以 > › ❯ │ 开头，不算)。
// Windows 主机只认 PS D:\x> / D:\x>：全屏的 Agent (OpenCode) 在 Windows 上也是普通画面，界面上以 > 结尾的行会被当成提示符
const winHost = (sess) => !!sess.shellOf && sess.shellOf.base !== 'sh';
// Windows 常驻会话：提示符显示前 shell 先报目录 (OSC 9;9，见 session/index.js 的 promptRow)，光标还在那一行就是停在提示符上
// (自己配置的提示符也认得)；有程序画了界面，光标就到别的行去了
function atPromptRow(sess) {
  const b = sess.term?.buffer?.active;
  return sess.promptRow != null && !!b && b.type === 'normal' && b.baseY + b.cursorY === sess.promptRow;
}
function atShellPrompt(sess) {
  if (sess.promptShell() !== null) return true;
  if (winHost(sess)) return atPromptRow(sess);
  const l = cursorLine(sess);
  return l.length < 300 && !/^[>›❯│]/.test(l) && /[$#%❯➜>]$/.test(l);
}
// Agent 退干净、shell 接手了：界面没了、终端安静下来，光标那一行是提示符 (认不出提示符的话多等一会儿)。
// 只看界面没了不够：Agent 退出时先清掉界面、过一会儿才真的退出，这期间发的命令会被丢掉。
// Windows 主机一定要看到提示符：OpenCode 闲着时也不出声，安静 2 秒就算的话命令会打进它的输入框 (11-03 实测)
function shellReady(sess) {
  const quiet = Date.now() - (sess.outAt || 0);
  return !agentAtCursor(sess) && !sess.termPending && quiet >= 800 && (atShellPrompt(sess) || (quiet >= 2000 && !winHost(sess)));
}
async function resumeInTerminal(sess, cmd, name, cwd, id = '', agent = '') {
  if (name) sess.noteDaemonAgent?.({ name }); // 常驻会话：接会话的选择框里显示这个对话的名称 (见 daemon.js)
  // 记下这个标签在用这个对话 (不等钩子来事件)：以后给它命名会记到这个对话上 (见 session/index.js 的 rename)。
  // 标签名换成这个对话的：聊它时标签命过名 → 用那个名字；没命过 (清掉的也算) → 清掉，标签按「主机名-序号」显示。
  // 接着常驻会话的也记到会话上 (再开标签时选择框里显示的跟标签一致)
  const prevSid = sess.hookSid; // 失败时回滚用
  const prevSuffix = sess.suffix, prevAt = sess.nameAt; // 名字也一起回滚
  let setAt = null; // 这次改了标签名的时间：回滚时认得出来
  if (id) {
    sess.hookSid = { id, at: Date.now(), agent }; // agent：哪个 Agent 的对话 (历史视图只拿同一个 Agent 的对话号去读，见 session/hooks.js 的 agentSid)
    sess.resumeGuard = { id, at: Date.now() }; // 退出的旧 Agent 晚到的事件 (旧对话号) 不算 (见 session/hooks.js)
    setAt = sess.adoptConvName(id, true); // 同一个常驻会话开在别的标签里的也跟着换 (见 session/index.js)
  }
  // 这次「继续」没成功 (退不出 Agent 等)：把 hookSid 和标签名都还回去 —— 以前失败也留着，这个标签
  // 在别的标签眼里一直「正在用这个对话」(6 小时)，删那个对话时会误报占用；名字也会停在没接上的那个。
  // 等的这几秒里又改过名的 (时间对不上) 就不动，用后来改的
  const rollback = () => {
    sess.hookSid = prevSid || null;
    sess.resumeGuard = null;
    if (setAt !== null && sess.nameAt === setAt) { sess.rename(prevSuffix, 'daemon', prevAt); sess.spreadName(prevSuffix, prevAt); } // 常驻会话记的、别的标签也还回去
  };
  // 要继续的对话在哪个目录：右边栏 (项目文件 / 代码改动) 马上换过去，不等新的 Agent 第一次报钩子事件
  const switchDir = () => { if (cwd) { sess.setAgentCwd?.(cwd, false, true); sess.noteDaemonAgent?.({ cwd }); } };
  // 要先退出的：钩子说 Agent 还在；光标停在 Agent 的输入行上 (> › ❯ │ 开头，Grok 这种界面上没有特别的字也认得)；
  // 屏幕上有 Agent 的界面、光标那行又不是 shell 的提示符。都不是：普通 shell，直接执行
  // 恢复命令发出去了：退出时不报事件的 Agent (OpenCode / Codex / Antigravity) 马上记成这个标签在跑的 Agent，
  // 不等它的钩子事件，历史视图马上读对的 Agent；它们回到 shell 提示符就自动清掉 (见 session/hooks.js 的 checkAgentGone)。
  // Claude / Grok / pi 自己报开始和退出，不提前记 (起不来的话会一直挂着)
  const started = () => { switchDir(); if (agentById(agent)?.noEndEvent) { sess.agentStartAt = Date.now(); sess.setHookAgent?.(agent); } };
  // Windows 主机还要看得出停在 shell 提示符上：OpenCode 的钩子不一定报、手机上屏幕也认不出它，以前当成普通 shell 直接发，命令打进了它的输入框 (11-03 实测)
  if (!sess.hook && !agentAtCursor(sess) && !(agentOnScreen(sess) && !atShellPrompt(sess)) && (!winHost(sess) || atShellPrompt(sess))) { sess.write(cmd + '\r'); started(); return { quit: false }; }
  // 退出：两下 Ctrl+C (Claude Code / Codex / Grok 都这样退出)，不行再来一次，再试 /exit、Ctrl+D。
  // 每一步之后等 shell 真的接手 (见 shellReady) 再发命令；3 秒了 Agent 的界面还在就换下一招
  const steps = [['\x03', '\x03'], ['\x03', '\x03'], ['\x15/exit\r'], ['\x04', '\x04']];
  for (const keys of steps) {
    for (const k of keys) { sess.write(k); await sleep(250); }
    for (let t = 0; t < 30; t++) {
      await sleep(200);
      if (shellReady(sess)) { sess.write(cmd + '\r'); started(); return { quit: true }; }
      if (t >= 15 && agentAtCursor(sess)) break;
    }
  }
  rollback();
  throw new Error('没能退出这个标签里正在运行的 Agent，请先手动退出 (比如输入 /exit)，再点「继续」');
}

// ---- 删除：会话文件移到主机的 ~/.ssh-web/trash/ (不直接删，删错了能找回)，删除前查有没有 Agent 正在用它
// 列出来的会话 → 会话文件在主机上的路径 (删除时按这个找，不信网页传来的路径)
const paths = new Map(); // 主机|Agent|会话 id → 路径 (SFTP 的写法)
const PATHS_MAX = 5000;
function remember(sess, agent, id, file) {
  const k = `${hostKey(sess)}|${agent}|${id}`;
  paths.delete(k);
  paths.set(k, file);
  if (paths.size > PATHS_MAX) paths.delete(paths.keys().next().value);
}
// 只认各家会话目录里面的路径 (各家的 sessions.mark)
const safePath = (agent, f) => typeof f === 'string' && !!AGENTS[agent] && f.includes(AGENTS[agent].mark) && !/(^|\/)\.\.(\/|$)/.test(f);
// 一个会话要移走的东西 (不存在的跳过)：各家的 sessions.items (Claude 另有同名目录、Grok 是整个会话目录、OpenCode 另有消息目录)，没写的就是这个文件
const itemsOf = (agent, file, id) => AGENTS[agent]?.items?.(file, id) || [file];
// 存在一个共用文件里的会话 (OpenCode 新版的 SQLite)：路径记成「文件#会话 id」。删除用各家的 sessions.remove (它自己的命令)，
// 查占用时不看文件的修改时间 (共用的文件谁都在写)
const inBox = (f) => f.includes('#');

// 有没有 Agent 正在用这个会话：钩子报来的 (哪个标签里的 Agent 在用它)、主机上命令行里带着会话 id 的进程 (claude --resume <id> 等)、
// 会话文件刚写过 (按主机自己的钟算)。返回原因，没有返回 []
const RECENT_S = 60;
// 这台主机上哪些标签里的 Agent 正在用这个对话 (钩子报的会话号；Agent 退出时清掉，见 session/hooks.js)：[{ tag, name }]
// except：要在里面继续的那个标签 (和它接着同一个常驻会话的标签也算它自己：是同一个终端，继续时会先退出里面的 Agent)
function tabsUsing(sess, id, except) {
  const now = Date.now();
  const same = (x) => x === except || (except?.daemonId && x.daemonId === except.daemonId && x.daemonCreated === except.daemonCreated);
  return [...sessions.values()].filter((x) => !same(x) && x.status === 'connected' && hostKey(x) === hostKey(sess)
    && x.hookSid?.id === id && now - x.hookSid.at < 6 * 3600 * 1000).map((x) => ({ tag: x.id, name: x.tabName() }));
}
async function busyOf(sess, agent, id, file, except) {
  const why = [];
  const tabs = tabsUsing(sess, id, except); // 钩子报的 (下面在主机上核对一下那个标签里 Agent 还在不在)
  // 会话 id 拆成两段拼起来：查进程的脚本自己的命令行里不能出现完整的 id (不然查到自己)
  const half = Math.ceil(id.length / 2), p1 = id.slice(0, half), p2 = id.slice(half);
  const base = await sess.shellBase(sess.ssh);
  let out = '';
  if (base === 'sh') {
    // 每个进程再带上它的标签标记 (LC_SSHWEB / SSHWEBD_SESSION)：没装钩子也认得出是哪个标签在用
    const script = [
      `ID=$(printf %s ${shq(p1)} ${shq(p2)}); echo "NOW $(date +%s)"`,
      // grep 一次读完所有进程的命令行 (进程多时不慢)；grep 自己的命令行里也有 id，跳过 (它退出后读不到了也跳过)
      `grep -lsF -- "$ID" /proc/[0-9]*/cmdline 2>/dev/null | while IFS= read -r f; do`,
      '  p=${f#/proc/}; p=${p%/cmdline}; [ "$p" = "$$" ] && continue',
      `  c=$(tr '\\0' ' ' < "$f" 2>/dev/null); [ -n "$c" ] || continue`,
      '  case "$c" in grep\\ *) continue;; esac',
      `  m=$(tr '\\0' '\\n' < "/proc/$p/environ" 2>/dev/null | grep -E '^(LC_SSHWEB|SSHWEBD_SESSION|SSHWEBD_STARTED)=' | tr '\\n' ' ')`,
      '  echo "PROC $p $(printf %s "$c" | cut -c1-80)"; [ -n "$m" ] && echo "MARK $p $m"',
      'done',
      // 带着标签标记的 Agent 进程 (程序名是各 Agent 的 proc，或者 node 跑的它们)：核对钩子报的标签里 Agent 还在不在。
      // 只在钩子说有标签在用时才查；先用一个 grep 挑出带标记的进程 (一个个读环境变量，进程多时要好几秒)
      ...(tabs.length ? [
      `grep -lsaE 'LC_SSHWEB=|SSHWEBD_SESSION=' /proc/[0-9]*/environ 2>/dev/null | while IFS= read -r e; do`,
      `  m=$(tr '\\0' '\\n' < "$e" 2>/dev/null | grep -E '^(LC_SSHWEB|SSHWEBD_SESSION|SSHWEBD_STARTED)=' | tr '\\n' ' '); [ -n "$m" ] || continue`,
      '  p=${e#/proc/}; p=${p%/environ}',
      `  set -f; set -- $(tr '\\0' ' ' < "/proc/$p/cmdline" 2>/dev/null) ''; set +f; n0=\${1##*/}; n1=\${2##*/}`,
      `  case "$n0" in ${procCase.names}) ;; node|nodejs|bun|deno) case "$n1" in ${procCase.scripts}) ;; cli.js|cli.mjs|index.js) case "$2" in ${procCase.dirs}) ;; *) continue;; esac;; *) continue;; esac;; *) continue;; esac`,
      '  echo "LIVE $p $m"',
      'done'] : []),
    ].join('\n');
    out = (await new Promise((resolve) => sess.rawExec(sess.ssh, `sh -c ${shq(script)}`, resolve, 10000))).out;
  } else {
    // Windows：PowerShell 从标准输入读脚本 (同 monitor.js，命令行里没有 id)
    const ps = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `$id = '${p1}' + '${p2}'`,
      "'NOW ' + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()",
      "Get-CimInstance Win32_Process -Property ProcessId, Name, CommandLine | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($id) -and $_.ProcessId -ne $PID } | ForEach-Object { 'PROC ' + $_.ProcessId + ' ' + $_.Name }",
    ].join('; ');
    out = await new Promise((resolve) => {
      if (!sess.ssh || sess.status !== 'connected') return resolve('');
      sess.ssh.exec('powershell -NoProfile -NonInteractive -Command -', (err, ch) => {
        if (err) return resolve('');
        let text = '';
        const timer = setTimeout(() => { try { ch.close(); } catch {} }, 15000);
        ch.on('data', (d) => { if (text.length < 1 << 20) text += d; });
        ch.stderr.resume();
        ch.on('close', () => { clearTimeout(timer); resolve(text); });
        ch.end(ps + '\r\n');
      });
    });
  }
  const procs = new Map(); // pid → { text, marks }
  for (const l of out.split(/\r?\n/)) {
    let m = /^PROC (\d+) (.*)$/.exec(l.trim());
    if (m) { procs.set(m[1], { text: m[2].trim().slice(0, 80), marks: {} }); continue; }
    m = /^MARK (\d+) (.*)$/.exec(l.trim());
    if (m && procs.has(m[1])) for (const kv of m[2].trim().split(/\s+/)) { const i = kv.indexOf('='); if (i > 0) procs.get(m[1]).marks[kv.slice(0, i)] = kv.slice(i + 1); }
  }
  // 按进程的标签标记认出是哪个标签 (没装钩子时)：标记对得上这台 SSH-WEB 上连着这台主机的标签
  const mine = (x, mk) => (x.daemonId ? mk.SSHWEBD_SESSION === String(x.daemonId) && (!x.daemonStarted || !mk.SSHWEBD_STARTED || mk.SSHWEBD_STARTED === String(x.daemonStarted))
    : !mk.SSHWEBD_SESSION && mk.LC_SSHWEB === x.id);
  // 钩子说在用、但那个标签里已经没有 Agent 进程了：Agent 退出时没报 (Codex / Antigravity / OpenCode 没有退出的事件)，不算。
  // Agent 开在 tmux 里的 (钩子报了 pane)：进程上没有标签的标记，认不出，照旧算；Windows 查不了，照旧算
  if (base === 'sh') {
    const live = [];
    for (const l of out.split(/\r?\n/)) {
      const m = /^LIVE \d+ (.*)$/.exec(l.trim());
      if (!m) continue;
      const mk = {};
      for (const kv of m[1].trim().split(/\s+/)) { const i = kv.indexOf('='); if (i > 0) mk[kv.slice(0, i)] = kv.slice(i + 1); }
      live.push(mk);
    }
    for (let i = tabs.length - 1; i >= 0; i--) {
      const x = sessions.get(tabs[i].tag);
      if (x && !x.hook?.pane && !live.some((mk) => mine(x, mk))) tabs.splice(i, 1);
    }
  }
  for (const t of tabs) why.push(`正在标签「${t.name}」里使用中 (${AGENTS[agent].name})`);
  const others = [];
  for (const { text, marks } of procs.values()) {
    if (except && mine(except, marks)) continue; // 这个标签自己里面的 (继续时会先退出它)
    const owner = [...sessions.values()].find((x) => x.status === 'connected' && hostKey(x) === hostKey(sess) && mine(x, marks));
    if (owner) { if (!tabs.some((t) => t.tag === owner.id)) { tabs.push({ tag: owner.id, name: owner.tabName() }); why.push(`正在标签「${owner.tabName()}」里使用中 (${AGENTS[agent].name})`); } continue; }
    others.push(`主机上的进程 ${text} 正在用它`);
  }
  why.push(...others);
  const hostNow = parseInt((/^NOW (\d+)/m.exec(out) || [])[1], 10);
  const sftp = await sftpOf(sess);
  const st = await pr((cb) => sftp.stat(file.split('#')[0], cb)).catch(() => null);
  if (!st) throw new Error('会话文件已经不在了 (可能已经删过了)');
  const ago = hostNow - (st.mtime || 0);
  if (!why.length && !inBox(file) && hostNow && ago >= 0 && ago < RECENT_S) why.push(`会话文件 ${ago} 秒前还在写入，可能有 Agent 正在用它`);
  return { why, tabs };
}
// 会话文件在主机上的路径 (列出来时记下的；服务重启过就重新列一次)
async function fileOf(sess, agent, id) {
  if (!AGENTS[agent]) throw new Error('不认识的 Agent');
  if (!/^[\w.-]{1,200}$/.test(id)) throw new Error('会话 id 不对');
  const k = `${hostKey(sess)}|${agent}|${id}`;
  if (!paths.get(k)) await list(sess, agent, '');
  const file = paths.get(k);
  if (!file) throw new Error('这台主机上没找到这个会话 (可能已经删过了)');
  return file;
}

async function removeSession(sess, agent, id, force) {
  const file = await fileOf(sess, agent, id);
  if (!safePath(agent, file)) throw new Error('会话文件不在这个 Agent 的会话目录里，不删');
  if (!force) {
    const { why } = await busyOf(sess, agent, id, file);
    if (why.length) return { busy: why };
  }
  const sftp = await sftpOf(sess);
  const home = await pr((cb) => sftp.realpath('.', cb));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const trash = posix.join(home, '.ssh-web', 'trash', `${stamp}-${agent}-${id}`);
  for (const d of [posix.join(home, '.ssh-web'), posix.join(home, '.ssh-web', 'trash'), trash]) await pr((cb) => sftp.mkdir(d, cb)).catch(() => {});
  const shown = /^\/[A-Za-z]:/.test(trash) ? trash.slice(1).replace(/\//g, '\\') : trash.replace(home, '~');
  if (inBox(file)) { // 共用文件里的会话：交给它自己的删除命令 (先导出一份到回收站)
    const win = sess.shellOf && sess.shellOf.base !== 'sh';
    if (!(win ? AGENTS[agent].winRemove : AGENTS[agent].remove)) throw new Error('这个会话存在共用的数据库里，删不了');
    if (win && /[\s"&|<>^%!]/.test(shown)) throw new Error(`回收站路径里有空格或特殊字符，删不了：${shown}`);
    if (win) await pr((cb) => sftp.writeFile(posix.join(trash, '怎么找回.txt'), '用 opencode import session.json 可以找回这个会话\r\n', cb)).catch(() => {});
    const out = win ? (await new Promise((resolve) => sess.rawExec(sess.ssh, AGENTS[agent].winRemove(id, shown), resolve, 30000))).out || ''
      : await execOut(sess, AGENTS[agent].remove(id, trash));
    if (!/DELETED/.test(out)) throw new Error('删除失败：' + (out.trim().slice(-200) || '没有输出'));
    paths.delete(`${hostKey(sess)}|${agent}|${id}`);
    return { ok: true, trash: shown };
  }
  const moved = [], failed = [];
  for (const src of itemsOf(agent, file, id)) {
    if (!(await pr((cb) => sftp.stat(src, cb)).catch(() => null))) continue;
    try {
      await pr((cb) => sftp.rename(src, posix.join(trash, posix.basename(src)), cb));
      moved.push(src);
    } catch (e) {
      // 以前只有「一个都没移动成功」才报错，第二个及以后的失败被吞掉、仍然回 ok ——
      // 网页上说「已删除」，其实消息目录 / 子 Agent 目录还留在主机上，对话下次还会出现在列表里。
      // 现在记下来，全部试完再一起报 (已经移走的留在 trash 里，原位置写在 原来的位置.txt，能找回)
      failed.push(`${src}：${e.message}`);
    }
  }
  if (!moved.length) throw new Error(`移动会话文件失败 (可能正被 Agent 占用)：${failed[0] || '没有可移动的文件'}`);
  if (failed.length) {
    await pr((cb) => sftp.writeFile(posix.join(trash, '原来的位置.txt'), moved.join('\n') + '\n', cb)).catch(() => {});
    throw new Error(`有一部分没移走 (已移走的在 ${trash})：${failed.join('；')}`);
  }
  await pr((cb) => sftp.writeFile(posix.join(trash, '原来的位置.txt'), moved.join('\n') + '\n', cb)).catch(() => {});
  paths.delete(`${hostKey(sess)}|${agent}|${id}`);
  for (const k of fieldCache.keys()) if (k.endsWith('|' + file)) fieldCache.delete(k);
  return { ok: true, trash: shown };
}

function registerAgentSessions(app) {
  // 「继续」之前：这个对话有没有正在别处用 (别的标签里的 Agent、主机上的进程、文件刚写过)。
  // 这个标签自己里面开着它不算 (继续时会先退出它)。tabs：在用它的标签 (网页上可以直接切过去)
  app.post('/api/agent-sessions/busy', async (req, res) => {
    const s = liveSession(String(req.body?.sid || ''));
    if (!s || s.status !== 'connected') return res.status(404).json({ error: '会话不存在或已断开' });
    try {
      const agent = String(req.body?.agent || ''), id = String(req.body?.id || '');
      const { why, tabs } = await busyOf(s, agent, id, await fileOf(s, agent, id), s);
      res.json({ busy: why, tabs });
    } catch (e) {
      res.status(400).json({ error: e.message || String(e) });
    }
  });

  app.post('/api/agent-sessions/delete', async (req, res) => {
    const s = liveSession(String(req.body?.sid || ''));
    if (!s || s.status !== 'connected') return res.status(404).json({ error: '会话不存在或已断开' });
    try {
      const r = await removeSession(s, String(req.body?.agent || ''), String(req.body?.id || ''), req.body?.force === true);
      res.status(r.busy ? 409 : 200).json(r);
    } catch (e) {
      res.status(400).json({ error: e.message || String(e) });
    }
  });

  app.post('/api/agent-sessions/resume', async (req, res) => {
    const s = liveSession(String(req.body?.sid || ''));
    if (!s || s.status !== 'connected') return res.status(404).json({ error: '会话不存在或已断开' });
    const cmd = String(req.body?.cmd || '').replace(/[\r\n]/g, ' ').slice(0, 2000);
    if (!cmd.trim()) return res.status(400).json({ error: '没有要执行的命令' });
    try {
      res.json(await resumeInTerminal(s, cmd, String(req.body?.name || '').replace(/\s+/g, ' ').slice(0, 120), String(req.body?.cwd || '').slice(0, 4096), String(req.body?.id || '').slice(0, 64), /^[a-z]{2,20}$/.test(req.body?.agent || '') ? req.body.agent : ''));
    } catch (e) {
      res.status(409).json({ error: e.message });
    }
  });

  app.post('/api/agent-sessions', async (req, res) => {
    const s = liveSession(String(req.body?.sid || ''));
    if (!s) return res.status(404).json({ error: '会话不存在或已断开' });
    try {
      res.json(await list(s, String(req.body?.agent || 'claude'), req.body?.q));
    } catch (e) {
      res.status(400).json({ error: e.message || String(e) });
    }
  });
}

// 常驻会话的选择框用 (见 lib/session/daemon.js)：按对话 id 从 ~/.claude/projects 里读对话的标题
// (优先 /rename 起的名字、再自动起的标题，同上面列出的规则) 和你最后发送的一条消息 —— 同会话历史的读法，
// 比钩子报的准 (钩子的会话名称只是最近一次让 Agent 做的事的前几十个字)。在主机上跑一段 sh，返回
// Map<id, { title, last }>；不是 Linux 主机 / 没有会话文件 = 空 (退回钩子报的)
async function claudePeek(sess, ids) {
  const map = new Map();
  const list = ids.filter((x) => /^[\w-]{1,128}$/.test(x)).join(' '); // 只放正常的会话 id 进脚本
  if (!list || !sess.ssh || sess.daemonOs !== 'linux') return map;
  const find = String.raw`
cd "$HOME/.claude/projects" 2>/dev/null || exit 0
for id in ${list}; do
  f=$(ls -t -- */"$id".jsonl 2>/dev/null | head -n 1)
  printf '%s\t%s\n' "$id" "$f"
done`;
  const r = await new Promise((resolve) => sess.rawExec(sess.ssh, `sh -c ${shq(find)}`, resolve, 15000));
  const files = new Map(); // 对话 id → 会话文件
  for (const l of String(r?.out || '').split('\n')) {
    const m = /^([\w-]{1,128})\t(\S+\.jsonl)$/.exec(l.trim());
    if (m) files.set(m[1], m[2]);
  }
  if (!files.size) return map;
  const detail = await claudePeekFiles(sess, [...files.values()]);
  for (const [id, f] of files) { const v = detail.get(f); if (v) map.set(id, { ...v, file: f }); }
  return map;
}

// 没装钩子 / 没报过对话 id 的常驻会话：按它的工作目录在 ~/.claude/projects 里找正在聊的对话 ——
// 列最新的会话文件、读每个文件自己带的 cwd 字段来认目录 (目录名是编码过的，反而不准)，在「这个目录里、
// 最后修改不晚于这个会话最后输出 (加 5 分钟)、不早于这个会话开的时候 (from)」的文件中挑修改时间和这个会话最后输出最接近的那个
// (正在聊的对话文件一直在写，mtime 就在最后一次输出附近)。会话开之前就没再写过的是以前的对话 —— 以前不看这个，
// 开了个会话没开 Agent，选择框里也显示成这个目录里以前聊过的对话。
// 一个文件只分给一个会话：按「差多少」从近到远全局分配，先到先得 —— 以前每个会话各自 find 第一个命中的，
// 同一目录几个会话会一起抢到最新那个文件，显示成同一个名字。按对话 id 已经认出来的文件 (opts.knownFiles /
// opts.knownSids) 不再分给别人。返回 Map<常驻会话号, { title, last }>；同 claudePeek，读不到就是空
async function claudePeekByCwd(sess, wants, opts = {}) {
  const map = new Map();
  const list = wants.filter((w) => w && w.cwd && w.to && /^[\w-]{1,64}$/.test(w.id || ''));
  if (!list.length || !sess.ssh || sess.daemonOs !== 'linux') return map;
  const knownFiles = opts.knownFiles || new Set();
  const knownSids = opts.knownSids || new Set();
  // 主机端只找「第一行带 cwd 的那条」(字面量匹配，值在这里用 JS 正则取，转义由 unq 解开)。
  // 以前这里把整行截到 2048 字节：cwd 在 SessionStart 那条长行里第 3500 字节，一大半文件直接读不到目录 →
  // 这些会话永远退回钩子记的名字，看着就是「时准时不准」。现在放宽到 64KB 整行读，cwd / sessionId 都在里面
  const scan = String.raw`
cd "$HOME/.claude/projects" 2>/dev/null || exit 0
ls -t -- */*.jsonl 2>/dev/null | head -n 120 | while IFS= read -r f; do
  printf '@@\t%s\t%s\t%s\n' "$(stat -c %Y -- "$f" 2>/dev/null)" "$(head -c 65536 -- "$f" 2>/dev/null | grep -m1 -F '"cwd":"' | head -c 65536)" "$f"
done`;
  const r = await new Promise((resolve) => sess.rawExec(sess.ssh, `sh -c ${shq(scan)}`, resolve, 15000));
  const rows = [];
  for (const l of String(r?.out || '').split('\n')) {
    const m = /^@@\t(\S+)\t(.*)\t(\S+\.jsonl)$/.exec(l);
    if (!m) continue;
    const cm = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(m[2]); // 文件开头带的原始目录
    const sm = /"sessionId":"([\w-]{1,128})"/.exec(m[2]); // 这个文件是哪个对话
    rows.push({ at: (+m[1] || 0) * 1000, cwd: cm ? unq(`"${cm[1]}"`) : '', sid: sm ? sm[1] : '', file: m[3] });
  }
  // 候选：目录对上、修改时间在这个会话开了以后、不晚于它最后输出 (+5 分钟)。按「和最后输出差多少」从近到远排，
  // 再全局分配 (一个文件只给一个会话)
  const pairs = [];
  for (const w of list) {
    for (const x of rows) {
      if (!x.at || x.cwd !== w.cwd || x.at > w.to + 5 * 60000 || x.at < (w.from || 0) - 1000) continue;
      if (knownFiles.has(x.file) || (x.sid && knownSids.has(x.sid))) continue;
      pairs.push({ id: w.id, file: x.file, d: Math.abs(x.at - w.to) });
    }
  }
  pairs.sort((a, b) => a.d - b.d);
  const picked = new Map(), taken = new Set();
  for (const p of pairs) {
    if (picked.has(p.id) || taken.has(p.file)) continue;
    picked.set(p.id, p.file);
    taken.add(p.file);
  }
  if (!picked.size) return map;
  const detail = await claudePeekFiles(sess, [...new Set(picked.values())]);
  for (const [id, f] of picked) { const v = detail.get(f); if (v) map.set(id, { ...v, file: f }); }
  return map;
}

// 上面的两个都走这里：给一批 ~/.claude/projects 里的文件，读每个的对话标题和你最后发送的一条消息。
// 主机端只做「找行」(字面量匹配，不玩转义字符类 —— 有的 grep 对它有毛病)，值在这里用 JS 正则取
async function claudePeekFiles(sess, files) {
  const map = new Map();
  if (!files.length || !sess.ssh || sess.daemonOs !== 'linux') return map;
  const script = String.raw`
cd "$HOME/.claude/projects" 2>/dev/null || exit 0
for f in ${files.map(shq).join(' ')}; do
  [ -f "$f" ] || continue
  b=$(tail -c 2000000 -- "$f")
  t=$(printf '%s\n' "$b" | grep -F '"customTitle"' | tail -n 1)
  [ -n "$t" ] || t=$(printf '%s\n' "$b" | grep -F '"aiTitle"' | tail -n 1)
  [ -n "$t" ] || t=$(grep -m1 -F '"aiTitle"' -- "$f")
  m=$(printf '%s\n' "$b" | grep -F '"role":"user","content":"' | grep -v -F '"isMeta":true' | grep -vE '"content":"(<|Caveat)' | tail -n 1)
  printf '@@\t%s\t%s\t%s\n' "$f" "$t" "$m"
done`;
  const r = await new Promise((resolve) => sess.rawExec(sess.ssh, `sh -c ${shq(script)}`, resolve, 15000));
  // 一行里取 "字段":"值" 的值 (值是带转义的 JSON 字符串，unq 解开)
  const val = (line, key) => {
    const m = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`).exec(line || '');
    return m ? oneLine(unq(`"${m[1]}"`)) : '';
  };
  for (const l of String(r?.out || '').split('\n')) {
    const m = /^@@\t(\S+)\t(.*)$/.exec(l);
    if (!m) continue;
    const [tline, mline] = m[2].split('\t'); // 会话文件一行一条，里面不会出现真的制表符 (都是转义的)
    map.set(m[1], { title: val(tline, 'customTitle') || val(tline, 'aiTitle'), last: val(mline, 'content') });
  }
  return map;
}

module.exports = { registerAgentSessions, list, claudePeek, claudePeekByCwd, agentAtCursor, atShellPrompt, resumeInTerminal, AGENTS: Object.fromEntries(Object.entries(AGENTS).map(([k, v]) => [k, { name: v.name, tested: !!v.tested }])) };
