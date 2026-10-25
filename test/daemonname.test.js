'use strict';
// 常驻会话选择框里会话名称和「最后发送的一条消息」的读取 (agent-sessions.js 的 claudePeek)：
// 按 Agent 钩子报的对话 id 从 ~/.claude/projects 里读对话的标题 (优先 /rename 的、再自动起的) 和
// 你最后发送的一条消息 (跳过 caveat / 命令那些不是真说话的行) —— 同会话历史的读法。
// 不连真的 SSH：rawExec 就在本机临时目录里跑 sh (Git Bash 的 sh 也行，脚本同款)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ok, run } = require('./helpers');
const { claudePeek } = require('../lib/agent-sessions');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-dn-')));
const J = (o) => JSON.stringify(o);
const put = (f, text) => { const p = path.join(home, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

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
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
});
