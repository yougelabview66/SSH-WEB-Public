'use strict';
// 常驻会话选择框里 Agent 的标志、Windows 主机上 OpenCode 的完整对话 (历史视图)。不用开浏览器，直接调模块
const fs = require('fs');
const path = require('path');
const { ok } = require('./helpers');
const { AGENT_LIST, agentLabel } = require('../lib/agents');
const oc = require('../lib/agents/opencode');

(async () => {
  // 除了 Claude (名字里写 ✳)，每个 Agent 都画真实的标志：服务端去掉「简称：」告诉网页是谁，网页的 AGENT_LOGOS 里有它的 SVG
  const web = fs.readFileSync(path.join(__dirname, '../public/app/09-agents.js'), 'utf8');
  const logos = AGENT_LIST.filter((a) => a.id !== 'claude').map((a) => [a.id, a.logo === true, new RegExp(`\\n\\s*${a.id}: '<svg class="ag-logo"`).test(web)]);
  ok(logos.length === 5 && logos.every(([, l, w]) => l && w), 'Grok、Codex、Antigravity、OpenCode、Pi 都有标志 (服务端 logo + 网页 SVG): ' + JSON.stringify(logos));
  const got = [agentLabel('OpenCode：你好'), agentLabel('pi：你好'), agentLabel('Pi：你好'), agentLabel('Claude：改代码'), agentLabel('C:\\Users\\a')];
  ok(JSON.stringify(got) === JSON.stringify([{ name: '你好', agent: 'opencode' }, { name: '你好', agent: 'pi' }, { name: '你好', agent: 'pi' }, { name: '✳ 改代码', agent: '' }, { name: 'C:\\Users\\a', agent: '' }]),
    '「OpenCode：」「Pi：」去掉换成标志，以前记下的小写「pi：」也认得；Claude 还是 ✳，普通名字不动: ' + JSON.stringify(got));

  // Windows 主机：没有 sh / python3，用 opencode session list 挑对话 (目录不分大小写、/ 和 \ 一样)，再 opencode export
  const list = [{ id: 'ses_other', directory: 'D:\\x' }, { id: 'ses_mine', directory: 'C:\\Users\\Me' }];
  const exp = { info: { id: 'ses_mine' }, messages: [
    { info: { role: 'user' }, parts: [{ type: 'text', text: 'Windows 上的问题' }] },
    { info: { role: 'assistant' }, parts: [{ type: 'tool', tool: 'bash', state: { input: { command: 'dir' }, output: 'a.txt' } }, { type: 'text', text: 'Windows 上的回答' }] }] };
  const cmds = [];
  const exec = async (c) => { cmds.push(c); if (c.includes('session export')) throw new Error('旧版没有这个命令'); return c.includes('session list') ? 'note\r\n' + JSON.stringify(list) : JSON.stringify(exp); };
  const plain = (t) => t.replace(/\x1b\[[0-9;]*m/g, '');
  let t = plain(await oc.history.read({ sid: '', cwd: 'c:/users/me/', exec, win: true }));
  ok(t.includes('Windows 上的问题') && t.includes('Windows 上的回答') && t.includes('$ dir') && cmds.join('|') === 'opencode session list --format json -n 30|opencode session export ses_mine|opencode export ses_mine',
    'Windows：没有对话号按目录挑出对话，用 opencode export 读出完整对话: ' + JSON.stringify(cmds));
  cmds.length = 0;
  await oc.history.read({ sid: 'ses_known', cwd: '', exec, win: true });
  ok(cmds.join('|') === 'opencode session export ses_known|opencode export ses_known', 'Windows：有对话号直接导出 (先试 OpenCode 2 的 session export，旧版再用 export): ' + JSON.stringify(cmds));
  cmds.length = 0;
  await oc.history.read({ sid: 'a & del x', cwd: 'E:\\none', exec, win: true });
  ok(cmds.join('|') === 'opencode session list --format json -n 30|opencode session export ses_other|opencode export ses_other', '对话号不像样不拼进命令；目录对不上用最近的: ' + JSON.stringify(cmds));
  const bad = await oc.history.read({ sid: '', cwd: '', exec: async () => '[]', win: true }).then(() => 'ok', (e) => e.message);
  ok(bad === '没有对话', '一个对话都没有算失败 (网页把滚轮交回 OpenCode): ' + bad);

  // Windows 主机优先 SFTP 拷数据库到服务器上读 (不启动 opencode 命令，快)：主库没变不重拷，刚聊的在 -wal 里每次都拷
  const os = require('os');
  const { DatabaseSync } = require('node:sqlite');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-ocwin-'));
  const dbf = path.join(home, '.local/share/opencode/opencode.db');
  fs.mkdirSync(path.dirname(dbf), { recursive: true });
  const db = new DatabaseSync(dbf);
  db.exec(`pragma journal_mode=wal; pragma wal_autocheckpoint=0;
    create table session (id text primary key, parent_id text, directory text, title text, time_updated integer, time_archived integer);
    create table message (id text primary key, session_id text, time_created integer, data text);
    create table part (id text primary key, message_id text, session_id text, time_created integer, data text);`);
  const add = (sid, dir, t, mid, role, text) => {
    db.prepare('insert or replace into session values (?,?,?,?,?,null)').run(sid, null, dir, 't', t);
    db.prepare('insert into message values (?,?,?,?)').run(mid, sid, t, JSON.stringify({ role }));
    db.prepare('insert into part values (?,?,?,?,?)').run(mid + 'p', mid, sid, t, JSON.stringify({ type: 'text', text }));
  };
  add('ses_a', 'C:\\Users\\Me', 1, 'm1', 'user', '数据库里的问题');
  add('ses_b', 'D:\\other', 2, 'm2', 'user', '别的目录');
  db.exec('pragma wal_checkpoint(truncate)');
  const gets = [];
  const sftp = { stat: (f, cb) => fs.stat(f, (e, st) => cb(e, st && { size: st.size, mtime: Math.floor(st.mtimeMs / 1000) })),
    fastGet: (from, to, o, cb) => { if (typeof o === 'function') cb = o; else opts.push(o); gets.push(path.basename(from)); fs.copyFile(from, to, cb); } };
  const opts = []; // 后台预先拷时带的选项 (并发)
  const noExec = async (c) => { throw new Error('不该启动 opencode：' + c); };
  // 这条连接还没拷过数据库 (第一次要整个拷，慢的网络上好几分钟)：先用 opencode session export 导出这一条显示，数据库在后台拷着
  const cmds2 = [];
  const exp2 = { info: { id: 'ses_a' }, messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: '导出来的问题' }] }] };
  t = plain(await oc.history.read({ sftp, home, sid: 'ses_a', cwd: '', exec: async (c) => { cmds2.push(c); return JSON.stringify(exp2); }, win: true }));
  for (let i = 0; i < 40 && !gets.length; i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 200));
  ok(t.includes('导出来的问题') && cmds2.join('|') === 'opencode session export ses_a' && gets.join() === 'opencode.db' && opts[0]?.concurrency === 4,
    'Windows 第一次 (还没拷过数据库)：先用 opencode session export 导出这一条显示，不等整个数据库；数据库在后台慢慢拷过来 (只开 4 路，不占满 SFTP；-wal 是空的不拷): ' + JSON.stringify([cmds2, gets, opts]));
  gets.length = 0;
  t = plain(await oc.history.read({ sftp, home, sid: '', cwd: 'c:/users/me', exec: noExec, win: true }));
  ok(t.includes('数据库里的问题') && !t.includes('别的目录') && gets.length === 0, '拷过以后：在服务器上读数据库，按目录挑出对话，不启动 opencode、主库没变不重拷: ' + JSON.stringify(gets));
  add('ses_a', 'C:\\Users\\Me', 3, 'm3', 'assistant', '刚刚的回答'); // 只写进 -wal
  gets.length = 0;
  t = plain(await oc.history.read({ sftp, home, sid: 'ses_a', cwd: '', exec: noExec, win: true }));
  ok(t.includes('数据库里的问题') && t.includes('刚刚的回答') && gets.join() === 'opencode.db-wal', '再读：主库没变不重拷，只拷 -wal，刚聊的也读得到: ' + JSON.stringify(gets));
  t = plain(await oc.history.read({ sftp, home, sid: 'ses_a', cwd: '', exec: noExec, win: true }));
  ok(t.includes('刚刚的回答'), '连着读几次都对 (查询用另一份拷贝，缓存的 -wal 没被并掉)');
  // -wal 没变不再拷；只在末尾追加了就只读新增的那段 (SFTP 能按位置读时)，不整个重拷
  const reads = [];
  const sftp2 = Object.assign(sftp, { open: (f, m, cb) => fs.open(f, 'r', cb), close: (h, cb) => fs.close(h, cb), // 同一个 SFTP 连接 (缓存按连接记)
    read: (h, buf, off, len, pos, cb) => { reads.push([pos, len]); fs.read(h, buf, off, len, pos, (e, n) => cb(e, n)); } });
  gets.length = 0;
  t = plain(await oc.history.read({ sftp: sftp2, home, sid: 'ses_a', cwd: '', exec: noExec, win: true }));
  ok(gets.length === 0 && reads.length === 0 && t.includes('刚刚的回答'), '-wal 没变：不拷也不读: ' + JSON.stringify([gets, reads.length]));
  add('ses_a', 'C:\\Users\\Me', 4, 'm4', 'assistant', '追加的新回答');
  gets.length = 0;
  t = plain(await oc.history.read({ sftp: sftp2, home, sid: 'ses_a', cwd: '', exec: noExec, win: true }));
  ok(gets.length === 0 && reads.length >= 2 && reads.some(([pos]) => pos > 0) && t.includes('追加的新回答') && t.includes('刚刚的回答'),
    '-wal 只追加了：只读开头 32 字节核对和新增的那段，读出来的对话是全的: ' + JSON.stringify([gets, reads.slice(0, 4)]));
  db.close();
  fs.rmSync(dbf); fs.rmSync(dbf + '-wal', { force: true }); fs.rmSync(dbf + '-shm', { force: true });
  cmds.length = 0;
  await oc.history.read({ sftp, home, sid: 'ses_known', cwd: '', exec, win: true });
  ok(cmds.join('|') === 'opencode session export ses_known|opencode export ses_known', '没有数据库再用 opencode 命令导出 (先试 OpenCode 2 的 session export): ' + JSON.stringify(cmds));
  fs.rmSync(home, { recursive: true, force: true });

  // 会话列表 (Windows 主机)：这条连接第一次列、不是搜索 → 用 OpenCode 2 后台服务的接口列出全部顶层对话 (几秒)，不等拷数据库
  const mkX = (exec, q = '') => { const rows = []; return { rows, x: { q, MAX: 50, SCAN: 400, exec, home: '/C:/Users/me', sftp: { stat: (f, cb) => cb(new Error('no')) },
    J: (...a) => a.join('/'), push: (r) => rows.push(r), oneLn: (v) => v, filesIn: async () => [], subdirs: async () => [], pick: async () => [], collect: async () => {}, head: async () => '', has: async () => true } }; };
  const api = { data: [{ id: 'ses_n1', title: '修登录', location: { directory: 'C:\\p' }, time: { created: 1, updated: 5 } }, { id: 'bad id', title: 'x' }], cursor: {} };
  const ec = [];
  let m = mkX(async (c) => { ec.push(c); return 'note\n' + JSON.stringify(api); });
  await oc.sessions.sftp(m.x);
  const r0 = m.rows[0], j0 = r0 && JSON.parse(r0.f.json[0]);
  ok(ec[0] === 'opencode api session.list --param limit=50 --param parentID=null' && m.rows.length === 1 && r0.path.endsWith('opencode.db#ses_n1') && r0.mtime === 5 && j0.title === '修登录' && j0.directory === 'C:\\p',
    'Windows 会话列表第一次：用 OpenCode 2 后台服务的接口列出 (只要顶层对话，对话号不像样的不要)，不等拷数据库: ' + JSON.stringify([ec, m.rows]));
  ec.length = 0;
  m = mkX(async (c) => { ec.push(c); return JSON.stringify(api); }, '登录');
  await oc.sessions.sftp(m.x);
  ok(!ec.length, '搜索要查全部内容：不用接口 (照旧读数据库): ' + JSON.stringify(ec));
  m = mkX(async () => 'Error: unknown command "api"');
  await oc.sessions.sftp(m.x);
  ok(m.rows.length === 0, '旧版 OpenCode 没有 opencode api：照旧读数据库 (这里没有数据库，列表是空的，不报错)');
  process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
