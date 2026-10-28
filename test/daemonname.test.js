'use strict';
// 常驻会话选择框里会话名称和「最后发送的一条消息」的读取 (agent-sessions.js 的 claudePeek / claudePeekByCwd)：
// 按对话 id (或没报过 id 时按工作目录) 从 ~/.claude/projects 里读对话的标题 (优先 /rename 的、再自动起的) 和
// 你最后发送的一条消息 (跳过 caveat / 命令那些不是真说话的行) —— 同会话历史的读法。
// 不连真的 SSH：rawExec 就在本机临时目录里跑 sh (Git Bash 的 sh 也行，脚本同款)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ok, run } = require('./helpers');
const { claudePeek, claudePeekByCwd } = require('../lib/agent-sessions');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-dn-')));
const J = (o) => JSON.stringify(o);
const put = (f, text, ageMin) => {
  const p = path.join(home, f);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  if (ageMin != null) { const t = Date.now() / 1000 - ageMin * 60; fs.utimesSync(p, t, t); }
};

// 1111：先有一条 caveat (isMeta)、一条 /clear 命令，再是真正说的话；两个自动标题 (取最后一个)
put('.claude/projects/-srv-my-proj/11111111-1111-1111-1111-111111111111.jsonl', [
  J({ type: 'user', message: { role: 'user', content: '<local-command-caveat>Caveat: ...</local-command-cave>' }, isMeta: true, cwd: '/srv/my' }),
  J({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' }, cwd: '/srv/my' }),
  J({ type: 'user', message: { role: 'user', content: '修复登录页的样式 "引号" 问题' }, cwd: '/srv/my' }),
  J({ type: 'ai-title', aiTitle: '旧标题' }),
  J({ type: 'ai-title', aiTitle: '登录页样式修复' }),
].join('\n') + '\n');
// 2222：说过两条话 (取最后一条)，/rename 起的名字优先于自动标题
put('.claude/projects/-srv-other/22222222-2222-2222-2222-222222222222.jsonl', [
  J({ type: 'user', message: { role: 'user', content: '第一条' }, cwd: '/srv/other' }),
  J({ type: 'user', message: { role: 'user', content: '最后发送的一条消息' }, cwd: '/srv/other' }),
  J({ type: 'ai-title', aiTitle: '自动标题' }),
  J({ type: 'custom-title', customTitle: '我起的名字' }),
].join('\n') + '\n');
// 3333：只有 /clear、没说过话，也没起过标题
put('.claude/projects/-srv-other/33333333-3333-3333-3333-333333333333.jsonl', J({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } }) + '\n');

const fakeSess = {
  daemonOs: 'linux',
  ssh: {},
  rawExec: (ssh, cmd, cb, ms) => {
    const pr = spawn('sh', ['-c', cmd], { env: { ...process.env, HOME: home } });
    pr.stdin.on('error', () => {}); // 进程已经结束还有输入过来：EPIPE 是异步报的，try 接不住
    const chunks = [];
    let timer = setTimeout(() => { try { pr.kill('SIGKILL'); } catch {} }, ms || 3000);
    pr.stdout.on('data', (d) => chunks.push(d));
    pr.stderr.resume();
    pr.on('exit', (code) => { clearTimeout(timer); cb({ code, out: Buffer.concat(chunks).toString('utf8') }); });
  },
};

run(async () => {
  const peek = await claudePeek(fakeSess, [
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    '33333333-3333-3333-3333-333333333333',
    '99999999-no-such-file',
    'x; rm -rf /', // 不正常的 id：不进脚本 (防注入)
  ]);
  const a = peek.get('11111111-1111-1111-1111-111111111111');
  ok(a?.title === '登录页样式修复', `自动标题取最后一个: ${JSON.stringify(a?.title)}`);
  ok(a?.last?.includes('修复登录页的样式') && a.last.includes('引号'), `最后发送的一条消息 (caveat、/clear 不算): ${JSON.stringify(a?.last)}`);
  const b = peek.get('22222222-2222-2222-2222-222222222222');
  ok(b?.title === '我起的名字', `/rename 起的名字优先于自动标题: ${JSON.stringify(b?.title)}`);
  ok(b?.last === '最后发送的一条消息', `说过两条话取最后一条: ${JSON.stringify(b?.last)}`);
  const c = peek.get('33333333-3333-3333-3333-333333333333');
  ok(c && !c.title && !c.last, '没说过话、没起过标题的：都是空');
  ok(peek.size === 3 && !peek.has('99999999-no-such-file'), '没有会话文件的 id 不占条目');
  ok(peek.size === 3, '不正常的 id 被挡掉，没跑进脚本');
  const empty = await claudePeek({ daemonOs: 'windows', ssh: {}, rawExec: fakeSess.rawExec }, ['11111111-1111-1111-1111-111111111111']);
  ok(empty.size === 0, '不是 Linux 主机 (读不了 sh)：返回空，退回钩子报的');

  // ---- claudePeekByCwd：没报过对话 id 的 (钩子装之前开的会话)，按工作目录找
  // /srv/a 里两个对话：新的 (1 分钟前刚写过 = 正在聊的会话在用)，旧的 (3 小时前 = 闲置的那个会话最后用的)
  put('.claude/projects/-srv-a/aaaaaaaa-0000-0000-0000-000000000001.jsonl', [
    J({ type: 'user', message: { role: 'user', content: '新对话的问题' }, cwd: '/srv/a' }),
    J({ type: 'ai-title', aiTitle: '新对话' }),
  ].join('\n') + '\n', 1);
  put('.claude/projects/-srv-a/aaaaaaaa-0000-0000-0000-000000000002.jsonl', [
    J({ type: 'user', message: { role: 'user', content: '旧对话最后发的一条' }, cwd: '/srv/a' }),
    J({ type: 'ai-title', aiTitle: 'linux-persistent-session-tmux' }),
  ].join('\n') + '\n', 180);
  put('.claude/projects/-srv-b/bbbbbbbb-0000-0000-0000-000000000003.jsonl', J({ type: 'user', message: { role: 'user', content: '别的目录' }, cwd: '/srv/b' }) + '\n', 1);
  const now = Date.now();
  const byCwd = await claudePeekByCwd(fakeSess, [
    { id: 'S-just', cwd: '/srv/a', to: now }, // 一直有输出的：要最新的
    { id: 'S-idle', cwd: '/srv/a', to: now - 120 * 60000 }, // 2 小时前就没输出了：要当时在用的那个 (最新的太新，不算)
    { id: 'S-none', cwd: '/no/such/dir', to: now }, // 目录里没有对话
    { id: 'bad id; rm', cwd: '/srv/a', to: now }, // 不正常的会话号：挡掉
  ]);
  ok(byCwd.get('S-just')?.title === '新对话' && byCwd.get('S-just')?.last === '新对话的问题', `一直有输出的会话拿最新的: ${JSON.stringify(byCwd.get('S-just'))}`);
  ok(byCwd.get('S-idle')?.title === 'linux-persistent-session-tmux' && byCwd.get('S-idle')?.last === '旧对话最后发的一条', `闲置的会话拿它最后用的那个 (同目录最新的不算): ${JSON.stringify(byCwd.get('S-idle'))}`);
  ok(!byCwd.has('S-none') && byCwd.size === 2 && !byCwd.has('bad id; rm'), '没有对话的目录、不正常的会话号：都不占条目');
  // 同一目录两个会话、时间都接近：一个文件只能给一个会话，不能两个都显示成同一个名字
  const two = await claudePeekByCwd(fakeSess, [
    { id: 'S-a', cwd: '/srv/a', to: now },
    { id: 'S-b', cwd: '/srv/a', to: now },
  ]);
  ok(two.size === 2 && two.get('S-a').file !== two.get('S-b').file, `同一目录的两个会话分到不同的对话文件: ${JSON.stringify([...two].map(([k, v]) => [k, v.title]))}`);
  // 按对话 id 已经认出来的文件，不再按目录分给别人
  // 扫描输出里的路径是相对 ~/.claude/projects 的 (见 claudePeekByCwd 的 ls -t)
  // 同目录还有一个没被认出的文件，所以这个会话仍能拿到结果，但不能是那个已被认出的文件
  const skip = await claudePeekByCwd(fakeSess, [{ id: 'S-just', cwd: '/srv/a', to: now }], { knownFiles: new Set(['-srv-a/aaaaaaaa-0000-0000-0000-000000000001.jsonl']) });
  ok(skip.get('S-just')?.file !== '-srv-a/aaaaaaaa-0000-0000-0000-000000000001.jsonl', `已按对话 id 认出的文件不再分给别人 (拿到的是 ${JSON.stringify(skip.get('S-just')?.title)}): ${JSON.stringify(skip.get('S-just')?.file)}`);
  // 会话开了以后没开过 Agent：目录里只有会话开之前的旧对话 → 不算它的 (以前会显示成那个旧对话的名字)
  put('.claude/projects/-srv-c/dddddddd-0000-0000-0000-000000000005.jsonl', [
    J({ type: 'user', message: { role: 'user', content: '以前聊的' }, cwd: '/srv/c' }),
    J({ type: 'ai-title', aiTitle: '以前的对话' }),
  ].join('\n') + '\n', 180);
  const fresh = await claudePeekByCwd(fakeSess, [{ id: 'S-fresh', cwd: '/srv/c', to: now, from: now - 10 * 60000 }]);
  ok(!fresh.has('S-fresh'), `会话开之前就没再写过的对话不算这个会话的 (开了会话没开 Agent，不显示以前的对话名): ${JSON.stringify(fresh.get('S-fresh')?.title)}`);
  const inLife = await claudePeekByCwd(fakeSess, [{ id: 'S-life', cwd: '/srv/a', to: now, from: now - 10 * 60000 }]);
  ok(inLife.get('S-life')?.title === '新对话', `会话开了以后写过的照样认得: ${JSON.stringify(inLife.get('S-life')?.title)}`);
  // 文件第一行很长 (SessionStart 的钩子附件) 也要读到 cwd —— 以前整行截 2048 字节，cwd 在第 3500 字节就读不到
  const longLine = J({ type: 'attachment', attachment: { type: 'hook_success', pad: 'x'.repeat(3400) }, cwd: '/srv/long', sessionId: 'cccccccc-0000-0000-0000-000000000004' });
  put('.claude/projects/-srv-long/cccccccc-0000-0000-0000-000000000004.jsonl', [
    longLine,
    J({ type: 'ai-title', aiTitle: '长行会话' }),
  ].join('\n') + '\n', 1);
  const longOne = await claudePeekByCwd(fakeSess, [{ id: 'S-long', cwd: '/srv/long', to: now }]);
  ok(longOne.get('S-long')?.title === '长行会话', `cwd 在很长的第一行里也读得到 (以前截断读不到): ${JSON.stringify(longOne.get('S-long')?.title)}`);
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
});
