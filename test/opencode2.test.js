'use strict';
// OpenCode 2 (2.x，11-03 在真机 Windows 上升级到 2.2.5 实测)：
// - 数据库换了表：升级时旧对话迁到 session_v2 + session_message，之后只写新表 —— 会话历史、历史视图读新表
// - opencode export 没了，换成 opencode session export，导出的消息是 [{ type, text / content }]
// - 插件改跑在共用的后台服务里，旧插件不再加载：改认它报给终端的 OSC 7501 程序状态 (干活 / 要你确认 / 问你 / 做完 / 退出)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ok } = require('./helpers');
const oc = require('../lib/agents/opencode');
const SessionHooks = require('../lib/session/hooks');
const { dbList, dbQuery, exportMsgs, render, PY } = oc._test;
const plain = (t) => t.replace(/\x1b\[[0-9;]*m/g, '');
const J = JSON.stringify;

// ---- 数据库：OpenCode 2 的表 (旧表还在，但只剩升级前的；新对话只在新表里)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-oc2-'));
const dbf = path.join(dir, 'opencode.db');
{
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbf);
  db.exec(`create table session (id text primary key, parent_id text, directory text, title text, time_updated integer, time_archived integer);
    create table message (id text primary key, session_id text, time_created integer, data text);
    create table part (id text primary key, message_id text, session_id text, time_created integer, data text);
    create table session_v2 (id text primary key, parent_id text, directory text, title text, time_updated integer, time_archived integer);
    create table session_message (id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text);`);
  db.prepare('insert into session values (?,?,?,?,?,?)').run('ses_old', null, 'D:\\p', '升级前的旧表', 1000, null);
  const ses = (id, parent, d, title, t, arch) => db.prepare('insert into session_v2 values (?,?,?,?,?,?)').run(id, parent, d, title, t, arch);
  const msg = (sid, seq, type, data) => db.prepare('insert into session_message values (?,?,?,?,?,?,?)').run(`m_${sid}_${seq}`, sid, type, seq, seq, seq, J(data));
  ses('ses_new', null, 'C:/Users/me', 'OpenCode 2 的对话', 3000, null);
  msg('ses_new', 1, 'user', { text: '帮我看看 oc2-needle' });
  msg('ses_new', 2, 'assistant', { content: [{ type: 'reasoning', text: '想一想' }, { type: 'tool', name: 'shell', state: { status: 'completed', input: { command: 'echo hi' }, content: [{ type: 'text', text: 'hi\r\n' }] } }] });
  msg('ses_new', 3, 'assistant', { content: [{ type: 'text', text: '看完了' }] });
  msg('ses_new', 4, 'idle', { outcome: 'succeeded' });
  ses('ses_migrated', null, 'D:/p', '迁过来的旧对话', 2000, null);
  msg('ses_migrated', 1, 'user', { text: '旧对话的第一句' });
  ses('ses_kid', 'ses_new', 'C:/Users/me', '子会话', 4000, null);
  ses('ses_arch', null, 'C:/Users/me', '归档的', 5000, 4000);
  db.close();
}

const list = dbList(dbf, '', 30, 300);
ok(J(list.map((x) => [x.id, x.title, x.prompt])) === J([['ses_new', 'OpenCode 2 的对话', '帮我看看 oc2-needle'], ['ses_migrated', '迁过来的旧对话', '旧对话的第一句']]),
  '会话历史：有 session_v2 就读新表 (新对话、迁过来的旧对话都在)，第一句话从 session_message 取；子会话、归档的不列: ' + J(list));
ok(J(dbList(dbf, 'oc2-needle', 30, 300).map((x) => x.id)) === J(['ses_new']), '搜索：在新表的消息内容里搜');
let t = plain(render(dbQuery(dbf, 'ses_new', '')));
ok(t.includes('❯ 帮我看看 oc2-needle') && t.includes('◈ 执行命令') && t.includes('$ echo hi') && t.includes('│ hi') && t.includes('看完了') && t.includes('◆ 想一想'),
  '历史视图：读 session_message，你说的话、想法、命令 (shell) 和输出、回复都排出来: ' + J(t));
t = plain(render(dbQuery(dbf, '', 'd:\\p\\')));
ok(t.includes('旧对话的第一句'), '没有对话号：按目录在新表里找 (目录不分大小写、/ 和 \\ 一样)');

// Linux 主机上用 python3 读 (同样的规则)
let py = true;
try { execFileSync('python3', ['-c', 'import sqlite3']); } catch { py = false; }
if (py) {
  const out = execFileSync('python3', ['-I', '-c', PY, 'list', dbf, '30', '300', ''], { encoding: 'utf8' });
  ok(/ses_new/.test(out) && /ses_migrated/.test(out) && !/ses_old|ses_kid|ses_arch/.test(out) && out.includes('帮我看看 oc2-needle'), 'python3 读列表：同样读新表: ' + out);
  const h = JSON.parse(execFileSync('python3', ['-I', '-c', PY, 'history', dbf, 'ses_new', ''], { encoding: 'utf8' }));
  ok(plain(render(h)) === plain(render(dbQuery(dbf, 'ses_new', ''))), 'python3 读完整对话：和 Node 读的一样');
}

// opencode session export 导出的 (OpenCode 2)：messages 是 [{ type, … }]
t = plain(render(exportMsgs({ info: { id: 'ses_new' }, messages: [{ type: 'user', text: '导出的问题' }, { type: 'assistant', content: [{ type: 'text', text: '导出的回答' }] }, { type: 'idle' }] })));
ok(t.includes('❯ 导出的问题') && t.includes('导出的回答'), 'OpenCode 2 的导出格式也认得: ' + J(t));

// 删除：先试 OpenCode 2 的 session export，旧版再用 export
ok(/opencode session export ses_1 2>\/dev\/null \|\| opencode export ses_1/.test(oc.sessions.remove('ses_1', '/t')) && /\(opencode session export ses_1 2>nul \|\| opencode export ses_1\)/.test(oc.sessions.winRemove('ses_1', 'C:\\t')),
  '删除前导出：OpenCode 2 和旧版的命令都试');

// ---- OSC 7501 程序状态 → 钩子事件
const fake = () => {
  const evs = [];
  const P = SessionHooks.prototype;
  const s = { hookSid: null, onHook: (ev) => evs.push(ev), ocSid: P.ocSid, ocScreen: P.ocScreen, ocFinish: P.ocFinish, ocFlush: P.ocFlush, ocPromptLater: P.ocPromptLater, ocNotePrompt: P.ocNotePrompt, noteTask: P.noteTask };
  return { s, evs, feed: (body) => SessionHooks.prototype.onProgramStatus.call(s, body) };
};
const b64 = (x) => Buffer.from(x).toString('base64');
{
  const { s, evs, feed } = fake();
  s.hookSid = { id: 'ses_resumed', agent: 'opencode' }; // 「继续」时记下的对话号
  feed('?'); // 查询不是报告
  feed('state=idle:app=opencode');
  feed(`state=working:id=ses_abc:app=opencode:title=${b64('修登录')}`);
  feed(`state=working:app=opencode:title=${b64('修登录')}`);
  feed(`state=blocked:kind=permission:app=opencode:msg=${b64('Allow bash?')}`);
  feed('state=working:app=opencode');
  feed('state=clear:id=ses_abc');
  feed('state=idle:app=opencode');
  feed(`state=blocked:kind=question:app=opencode:msg=${b64('选哪个？')}`);
  feed('state=clear');
  const names = evs.map((e) => e.hook_event_name + (e.notification_type ? ':' + e.notification_type : ''));
  ok(J(names) === J(['SessionStart', 'UserPromptSubmit', 'Notification:permission_prompt', 'PostToolUse', 'Stop', 'Notification:elicitation_dialog', 'SessionEnd']),
    'OSC 7501：开起来 → 开始干活 → 要你确认 → 接着干 → 做完 → 问你 → 退出 (清掉根记录): ' + J(names));
  ok(evs.every((e) => e.agent === 'opencode') && evs[0].session_id === 'ses_resumed' && evs[1].session_id === 'ses_abc' && evs[1].prompt === '修登录',
    '事件算 OpenCode 的；对话号先用「继续」记下的，报了在忙的对话就用它的 (历史视图按它读)；状态卡片上写对话的标题');
  ok(evs[2].message === 'Allow bash?' && evs[5].message === '选哪个？', '要你确认、问你的内容 (base64) 解出来写进推送');
}
{
  const { evs, feed } = fake();
  feed('state=working:app=cargo');
  feed('state=clear');
  ok(evs.length === 0, '别的程序报的状态不管 (只认 app=opencode)');
}
// ---- Windows 上只拷数据库变了的块 (主机上 PowerShell 算每块的 MD5，见 opencode.js 的 blockSync)
(async () => {
  const { blockSync, BLOCKS_PS1, BLOCK } = oc._test;
  const crypto = require('crypto');
  const rdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-oc2b-')); // 当成主机的 C:/Users/me
  const remoteF = path.join(rdir, 'opencode.db'), localF = path.join(rdir, 'cache.db');
  const big = crypto.randomBytes(BLOCK * 5 + 1000);
  fs.writeFileSync(localF, big);
  const changed = Buffer.from(big); changed.fill(7, BLOCK * 2 + 10, BLOCK * 2 + 50); // 改了第 3 块
  fs.writeFileSync(remoteF, Buffer.concat([changed, Buffer.from('又多写了一点')])); // 末尾也长了
  const reads = [], writes = [], execs = [];
  const loc = (p) => path.join(rdir, p.replace(/^\/C:\/Users\/me\/?/, ''));
  const sftp = {
    readFile: (p, cb) => fs.readFile(loc(p), cb),
    writeFile: (p, d, cb) => { writes.push(p); fs.mkdirSync(path.dirname(loc(p)), { recursive: true }); fs.writeFile(loc(p), d, cb); },
    mkdir: (p, cb) => cb(),
    open: (p, m, cb) => cb(null, { fd: fs.openSync(loc(p), 'r') }),
    read: (h, buf, off, len, pos, cb) => { reads.push([pos, len]); cb(null, fs.readSync(h.fd, buf, off, len, pos)); },
    close: (h, cb) => { fs.closeSync(h.fd); cb(); },
  };
  const exec = async (cmd) => { // 照 blocks.ps1 的输出格式算 (本机没有 Windows PowerShell)
    execs.push(cmd);
    const files = [...cmd.matchAll(/"(C:\\[^"]+)"/g)].map((m) => m[1]).slice(1);
    const head = fs.existsSync(path.join(rdir, '.ssh-web', 'blocks.ps1')) ? 'V 3\r\n' : ''; // 写过脚本才有版本行 (没写过 = 主机上没有)
    return head + files.map((f) => { const b = fs.readFileSync(path.join(rdir, f.replace(/^C:\\Users\\me\\?/, ''))); const hs = []; for (let i = 0; i < b.length; i += BLOCK) hs.push(crypto.createHash('md5').update(b.subarray(i, i + BLOCK)).digest('hex').toUpperCase()); return ['F ' + b.length, ...hs].join('\r\n'); }).join('\r\n');
  };
  const c = {};
  const r = await blockSync({ sftp, home: '/C:/Users/me', exec }, c, [['/C:/Users/me/opencode.db', localF]]);
  ok(r === true && fs.readFileSync(localF).equals(fs.readFileSync(remoteF)), '只拷变了的块：拷完和主机上的一模一样');
  ok(J([...new Set(reads.map((x) => x[0] / BLOCK | 0))].sort()) === J([2, 5]) && reads.every((x) => x[1] <= 32768), '只读了改过的第 3 块和长出来的最后一块 (不是整个重拷；一段段并行读): ' + J(reads.length));
  ok(writes.length === 1 && /\.ssh-web\/blocks\.ps1$/.test(writes[0]) && execs.length === 2 && /-File "C:\\Users\\me\\\.ssh-web\\blocks\.ps1" "C:\\Users\\me\\opencode\.db"/.test(execs[0]) && BLOCKS_PS1.startsWith('\uFEFF') && BLOCKS_PS1.includes("'V 3'"),
    '主机上没有 blocks.ps1 (输出里没有版本行)：用 SFTP 写一次 (带 BOM) 再跑: ' + J([writes, execs]));
  await blockSync({ sftp, home: '/C:/Users/me', exec }, c, [['/C:/Users/me/opencode.db', localF]]);
  ok(writes.length === 1 && execs.length === 3, '主机上已经是这一版：直接跑，不重写、不先读文件');
  const bad = await blockSync({ sftp, home: '/C:/Users/me', exec: async () => 'F 5\r\n' }, c, [['/C:/Users/me/opencode.db', localF]]);
  ok(bad === false, '主机回的不对 (块数对不上)：算失败，调用的人整个重拷');
  fs.rmSync(rdir, { recursive: true, force: true });

  // ---- Windows 常驻会话：shell 报了回到提示符 (OSC 9;9)，看得见 PS 提示符 → 在跑的 Agent 退出了 (pi 的 SessionEnd 在 Windows 上送不出去)
  const gone = (agent, line, extra = {}) => new Promise((resolve) => {
    const calls = [];
    const s = { hookAgent: agent, termPending: 0, freshAgentCwd: () => false, promptShell: () => (/^PS [A-Za-z]:\\[^>]*>/.test(line) ? 'powershell' : null),
      term: { rows: 1, buffer: { active: { type: 'normal', baseY: 0, cursorY: 0, getLine: () => ({ translateToString: () => line }) } } },
      agentGone() { calls.push('gone'); }, ...extra };
    SessionHooks.prototype.onShellPrompt.call(s);
    setTimeout(() => resolve(calls.includes('gone')), 1700);
  });
  ok(await gone('pi', 'PS C:\\Users\\me> '), 'Windows：pi 退出后 shell 报了回到提示符、光标那行是 PS 提示符 → 当 pi 退出了');
  ok(!await gone('pi', ''), '开 pi 的命令也先报一次目录：光标停在命令下面的空行 (pi 还没画出来)，不算退出');
  ok(!await gone('claude', 'PS C:\\Users\\me> '), 'Claude Code 自己报退出：不管它');
  ok(!await gone('opencode', 'PS C:\\Users\\me> ', { agentStartAt: Date.now() }), '「继续」刚发出恢复命令 (20 秒内)：不算');
  done2();
})();
function done2() {
// Grok 跑了 Claude Code 配置里的钩子：同一个事件 grok、claude 各报一遍 (Windows 上的 Grok 1.0.73)，claude 那遍不要
{
  const { grokDup } = SessionHooks;
  ok(!grokDup({ agent: 'grok', session_id: 'g-1', hook_event_name: 'SessionStart' }) && grokDup({ agent: 'claude', session_id: 'g-1', hook_event_name: 'SessionStart' }),
    'Grok 报过的对话号：之后标成 claude 的同号事件是它的重复，不要');
  ok(!grokDup({ agent: 'claude', session_id: 'c-1', hook_event_name: 'Stop' }) && !grokDup({ agent: 'claude', hook_event_name: 'Stop' }) && !grokDup({ agent: 'pi', session_id: 'g-1' }),
    '真的 Claude Code (对话号不一样、没有对话号)、别的 Agent：照常');
}
// ---- OpenCode 2 的屏幕：你说的话、回复、被打断 (状态信号里只有对话标题)。照 2.2.5 实测的样子画 (带颜色)：
// 你说的话是和输入框同色 (75) 的「┃」框，工具输出是暗色 (232) 的「┃」框，回复后面一行页脚
const { Terminal } = require('@xterm/headless');
const C = (n, t) => `\x1b[38;5;${n}m${t}\x1b[0m`;
const userBox = (t) => [C(75, '  ┃'), C(75, '  ┃') + '  ' + t, C(75, '  ┃'), ''];
const toolBox = (cmd, out) => [C(232, '  ┃'), C(232, '  ┃') + '  ' + cmd, C(232, '  ┃'), C(232, '  ┃') + '  ' + out, C(232, '  ┃'), ''];
const inputBox = [C(75, '  ┃'), C(75, '  ┃'), C(75, '  ┃') + '  Build · DeepSeek V4.1 Flash (WorkBuddy) AiProxy', C(75, '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀'), '  ~/proj  7.1K (4%)  ctrl+p commands'];
const draw = (term, rows) => new Promise((r) => term.write('\x1b[2J\x1b[H' + rows.join('\r\n'), r));
const lines = (term) => require('../lib/status').screenLines(term);
(async () => {
  const term = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
  // 前一轮 (页脚在上面) + 这一轮：你说的话 → 工具 → 回复 → 页脚
  await draw(term, ['   修登录                +', ...userBox('上一个问题'), '     上一个回答', '     Build · DeepSeek · 2.1s · 3.0 tok/s', '',
    ...userBox('在终端执行 echo HELLO123 ，然后用一句话告诉我输出是什么'), ...toolBox('$ echo HELLO123', 'HELLO123'),
    '     + Thought · 351ms', '', '     输出是 HELLO123。', '', '     Build · DeepSeek V4.1 Flash (WorkBuddy) · 4.7s · 13.1 tok/s', '', ...inputBox]);
  let sc = oc.events.oscScreen(lines(term));
  ok(sc && sc.prompt === '在终端执行 echo HELLO123 ，然后用一句话告诉我输出是什么' && sc.reply === '输出是 HELLO123。' && sc.footer && !sc.interrupted,
    'OpenCode 2 屏幕：最近一条你说的话 (和输入框同色的框，工具输出的暗色框不算)、工具后面的回复 (跳过折起来的思考)、这一轮的页脚: ' + J(sc));
  // 还在回复 (这一轮没有页脚，上面那轮的页脚不算)
  await draw(term, [...userBox('上一个问题'), '     上一个回答', '     Build · DeepSeek · 2.1s · 3.0 tok/s', '', ...userBox('写一篇长文'), '     秋天来了', '', ...inputBox]);
  sc = oc.events.oscScreen(lines(term));
  ok(sc && sc.prompt === '写一篇长文' && !sc.footer && sc.reply === '秋天来了', '还在回复：这一轮还没有页脚 (上一轮的页脚不算): ' + J(sc));
  // 被打断
  await draw(term, [...userBox('写一篇长文'), '     秋天来了', '', '     Build · DeepSeek V4.1 Flash (WorkBuddy) · 7.7s · interrupted', '', ...inputBox]);
  sc = oc.events.oscScreen(lines(term));
  ok(sc && sc.footer && sc.interrupted, '页脚末尾「· interrupted」：被打断: ' + J(sc));
  ok(oc.events.oscScreen(lines(new Terminal({ cols: 80, rows: 10, allowProposedApi: true }))) === null, '认不出输入框 (不是 OpenCode 2 的界面)：不猜');

  // 接到状态信号上：开始干活时读你说的话；做完 / 打断等页脚画出来才报 (信号比页脚先到)
  const { s, evs, feed } = fake();
  s.term = term;
  feed('state=idle:app=opencode');
  // 信号到的时候对话区里还是上一轮 (先画的是输入框里打的字)：先报开始干活，你说的话等对话区画出来再补进「在做」
  s.ocLastPrompt = '上一轮的问题';
  await draw(term, [...userBox('上一轮的问题'), '     上一轮的回答', '     Build · DeepSeek · 1.0s · 2.0 tok/s', '', C(75, '  ┃') + '  只回复这个词：PEAR', ...inputBox.slice(1)]);
  feed(`state=working:app=opencode:title=${b64('New session - 2026-11-04T00:05:19.974Z')}`);
  const up = evs.find((e) => e.hook_event_name === 'UserPromptSubmit');
  ok(up && up.prompt === '', '开始干活：标题还是「New session - 日期」时不用标题: ' + J(up && up.prompt));
  await new Promise((r) => setTimeout(r, 400));
  ok(!s.hookTask, '对话区里还是上一轮的话：先不当成这一轮的 (等新的画出来): ' + J(s.hookTask));
  await draw(term, [...userBox('上一轮的问题'), '     上一轮的回答', '     Build · DeepSeek · 1.0s · 2.0 tok/s', '', ...userBox('只回复这个词：PEAR'), ...inputBox]);
  await new Promise((r) => setTimeout(r, 400));
  ok(s.hookTask === '只回复这个词：PEAR', '对话区画出这一轮你说的话：补进「在做」: ' + J(s.hookTask));
  feed('state=clear:id=ses_x');
  feed('state=idle:app=opencode');
  await new Promise((r) => setTimeout(r, 400));
  ok(!evs.some((e) => e.hook_event_name === 'Stop'), '收到 idle 但页脚还没画出来：先不报做完');
  feed('state=idle:app=opencode'); // 重复报同一个状态：不算，不提前报
  await draw(term, [...userBox('只回复这个词：PEAR'), '     PEAR', '     Build · DeepSeek · 2.9s · 1.4 tok/s', '', ...inputBox]);
  await new Promise((r) => setTimeout(r, 400));
  const stop = evs.find((e) => e.hook_event_name === 'Stop');
  ok(stop && stop.last_assistant_message === 'PEAR', '页脚画出来了：报做完，回复写进去: ' + J(stop));
  // 打断
  await draw(term, [...userBox('写一篇长文'), '', ...inputBox]);
  feed(`state=working:app=opencode:title=${b64('只回复 PEAR')}`);
  feed('state=idle:app=opencode');
  await draw(term, [...userBox('写一篇长文'), '     秋天来了', '     Build · DeepSeek · 7.7s · interrupted', '', ...inputBox]);
  await new Promise((r) => setTimeout(r, 400));
  ok(evs[evs.length - 1].hook_event_name === 'Interrupt', '页脚是「· interrupted」：报已中断 (不是做完): ' + J(evs.slice(-2).map((e) => e.hook_event_name)));
  // 等页脚的时候又开始干活：先按现在的屏幕把上一轮报掉，再报开始，顺序不乱
  await draw(term, [...userBox('t'), '', ...inputBox]); // 这一轮还没有页脚
  const n = evs.length;
  feed(`state=working:app=opencode:title=${b64('t')}`);
  feed('state=idle:app=opencode');
  feed(`state=working:app=opencode:title=${b64('t')}`);
  ok(J(evs.slice(n).map((e) => e.hook_event_name)) === J(['UserPromptSubmit', 'Stop', 'UserPromptSubmit']), '等页脚时又开始干活：先报上一轮做完再报开始: ' + J(evs.slice(n).map((e) => e.hook_event_name)));
  // 等太久页脚也没出来 (出错等)：2 秒后照样报做完
  const m = evs.length;
  feed('state=idle:app=opencode');
  await draw(term, [...userBox('t'), '', ...inputBox]);
  await new Promise((r) => setTimeout(r, 2400));
  ok(evs.slice(m).some((e) => e.hook_event_name === 'Stop'), '页脚一直没出来：2 秒后照样报做完');
  // 慢的机器上 (实测)：你说的话过了好几秒才画进对话区；回复的字比页脚还晚出来
  {
    const { s: s2, evs: e2, feed: f2 } = fake();
    const t2 = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
    s2.term = t2; s2.ocLastPrompt = '旧问题';
    await draw(t2, [...userBox('旧问题'), '     旧回答', '     Build · DeepSeek · 1.0s · 2.0 tok/s', '', ...inputBox]);
    f2('state=idle:app=opencode');
    f2(`state=working:app=opencode:title=${b64('标题')}`);
    await new Promise((r) => setTimeout(r, 2200));
    await draw(t2, [...userBox('旧问题'), '     旧回答', '     Build · DeepSeek · 1.0s · 2.0 tok/s', '', ...userBox('很晚才画出来的问题'), ...inputBox]);
    await new Promise((r) => setTimeout(r, 500));
    ok(s2.hookTask === '很晚才画出来的问题', '你说的话过了 2 秒多才画进对话区：照样补进「在做」: ' + J(s2.hookTask));
    f2('state=idle:app=opencode');
    await draw(t2, [...userBox('很晚才画出来的问题'), '', '', '     Build · DeepSeek · 3.0s · 2.8 tok/s', '', ...inputBox]);
    await new Promise((r) => setTimeout(r, 600));
    ok(!e2.some((e) => e.hook_event_name === 'Stop'), '页脚出来了、回复的字还没画出来：再等等，先不报做完');
    await draw(t2, [...userBox('很晚才画出来的问题'), '', '     晚到的回答', '     Build · DeepSeek · 3.0s · 2.8 tok/s', '', ...inputBox]);
    await new Promise((r) => setTimeout(r, 500));
    const st2 = e2.find((e) => e.hook_event_name === 'Stop');
    ok(st2 && st2.last_assistant_message === '晚到的回答', '回复的字画出来了：报做完，回复写进去: ' + J(st2));
  }
  {
    // Ctrl+C 退出时 OpenCode 2 不一定清它报的程序状态：别的办法认出它退出了 (回到 shell 提示符，见 checkAgentGone) 时一起清掉，
    // 不然「继续」会以为它还开着，对着 shell 按 Ctrl+C、/exit、Ctrl+D
    const P2 = SessionHooks.prototype;
    const g = { pstat: { app: 'opencode', state: 'idle' }, ocRound: {}, hook: { kind: 'done' }, hookSid: { id: 'ses_9' }, ocFlush: P2.ocFlush,
      noteDaemonAgent() {}, setAgentCwd() {}, setHookAgent() {}, updateState() {} };
    P2.agentGone.call(g);
    ok(g.pstat === null && g.ocRound === null && g.hook === null, '认出 OpenCode 退出了：它报的程序状态一起清掉');
  }
  // 插件：新旧 OpenCode 都能加载 —— default 里有 id、server() (1.x 用) 和 setup() (OpenCode 2 用)
  const pf = path.join(dir, 'plugin-check.mjs');
  fs.writeFileSync(pf, oc.hooks.plugin);
  const mod = await import('file://' + pf);
  ok(mod.default && mod.default.id === 'sshweb-status' && typeof mod.default.server === 'function' && typeof mod.default.setup === 'function'
    && Object.keys(mod).join() === 'default', '插件 export default { id, server, setup }：OpenCode 1.x 认 server()，OpenCode 2 认 id + setup()，没有别的导出');
  finish();
})();
function finish() {
const src = fs.readFileSync(path.join(__dirname, '../lib/session/index.js'), 'utf8');
ok(/registerOscHandler\(7501,[^\n]*onProgramStatus/.test(src), '终端输出里的 OSC 7501 交给 onProgramStatus');
fs.rmSync(dir, { recursive: true, force: true });
process.exit();
}
}
