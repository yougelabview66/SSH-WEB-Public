'use strict';
// Agent 会话历史：「⋯ 更多 → 会话历史」列出目标主机上 Claude Code / Grok / Codex / Gemini / OpenCode 以前的会话 (标题、第一句话、目录、时间)，
// 打字筛选、回车搜全部内容，「继续」在当前终端执行恢复命令 (cd 到原来的目录 && claude --resume <id>)，「复制」复制命令。
// 模拟的 SSH 服务器收到命令就在本机用 sh 真的跑 (HOME 指向放着各家会话文件的临时目录)，测的是真的脚本
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { Server } = require('ssh2');
const { BASE, ok, wait, run, launch, shot, hostKey, addHost, devices } = require('./helpers');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-as-')));
const put = (f, text, ageMin) => {
  const p = path.join(home, f);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  const t = Date.now() / 1000 - ageMin * 60;
  fs.utimesSync(p, t, t);
};
const J = (o) => JSON.stringify(o);
const CWD = "/srv/my proj's";
// Claude：自动起的标题、/rename 起的名字、只有命令没说过话的 (不列)、子 Agent 的 (更深一层，不列)
put('.claude/projects/-srv-my-proj/11111111-1111-1111-1111-111111111111.jsonl', [
  J({ type: 'user', message: { role: 'user', content: '<local-command-caveat>Caveat: ...</local-command-caveat>' }, isMeta: true, cwd: CWD }),
  J({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' }, cwd: CWD }),
  J({ type: 'user', message: { role: 'user', content: '修复登录页的样式 "引号" 问题' }, cwd: CWD, sessionId: '11111111-1111-1111-1111-111111111111' }),
  J({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '改好了，用到了 zebra-unique-word' }] }, cwd: CWD }),
  J({ type: 'ai-title', aiTitle: '旧标题' }),
  J({ type: 'ai-title', aiTitle: '登录页样式修复' }),
].join('\n') + '\n', 30);
put('.claude/projects/-srv-other/22222222-2222-2222-2222-222222222222.jsonl', [
  J({ type: 'user', message: { role: 'user', content: '第二个会话' }, cwd: '/srv/other' }),
  J({ type: 'ai-title', aiTitle: '自动标题' }),
  J({ type: 'custom-title', customTitle: '我起的名字' }),
].join('\n') + '\n', 10);
put('.claude/projects/-srv-other/33333333-3333-3333-3333-333333333333.jsonl', J({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' }, cwd: '/srv/other' }) + '\n', 5);
put('.claude/projects/-srv-other/22222222-2222-2222-2222-222222222222/subagents/agent-a1.jsonl', J({ type: 'user', message: { role: 'user', content: '子 Agent' } }) + '\n', 1);
// Grok
put('.grok/sessions/%2Fsrv%2Fg/0198a-grok-id/summary.json', J({ info: { id: '0198a-grok-id', cwd: '/srv/g' }, generated_title: 'Grok 修 bug', updated_at: '2026-10-20T10:00:00Z' }), 20);
put('.grok/sessions/%2Fsrv%2Fg/0198a-grok-id/chat_history.jsonl', J({ type: 'user', content: '<user_info>os</user_info>' }) + '\n' + J({ type: 'user', content: '<user_query>帮我修复 Grok 那边的问题</user_query>' }) + '\n', 20);
// Codex
put('.codex/sessions/2026/10/20/rollout-2026-10-20T10-00-00-0199b3c4-aaaa-bbbb-cccc-123456789abc.jsonl', [
  J({ timestamp: '2026-10-20T10:00:00Z', type: 'session_meta', payload: { id: '0199b3c4-aaaa-bbbb-cccc-123456789abc', cwd: '/srv/c', base_instructions: { text: 'x'.repeat(5000) } } }),
  J({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>...</environment_context>' }] } }),
  J({ type: 'event_msg', payload: { type: 'user_message', message: 'Codex 帮我写测试' } }),
].join('\n') + '\n', 40);
put('.codex/session_index.jsonl', J({ id: '0199b3c4-aaaa-bbbb-cccc-123456789abc', thread_name: 'Codex 写测试' }) + '\n', 40);
// Gemini (格式化过的整个 JSON)
put('.gemini/tmp/abc123/chats/session-2026-10-20T10-00-1a2b3c.json', JSON.stringify({ sessionId: 'gem-0001', projectHash: 'abc123', messages: [{ type: 'user', content: 'Gemini 你好' }, { type: 'gemini', content: '你好' }] }, null, 2), 50);
put('.gemini/tmp/abc123/.project_root', '/srv/gem\n', 50);
// OpenCode：子会话 (有 parentID) 不列
put('.local/share/opencode/storage/session/proj1/ses_main1.json', J({ id: 'ses_main1', title: 'OpenCode 会话', directory: '/srv/oc', time: { created: 1, updated: 2 } }), 60);
put('.local/share/opencode/storage/session/proj1/ses_kid1.json', J({ id: 'ses_kid1', parentID: 'ses_main1', title: '子会话', directory: '/srv/oc' }), 59);

let got = '';
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { const st = a(); st.write('$ '); st.on('data', (d) => { got += d; }); });
    s.on('exec', (a, r, info) => {
      const ch = a();
      if (info.command.includes('hook.log') || info.command === 'sh') return; // 读钩子事件、常驻通道：不管
      // 像 OpenSSH：命令交给用户的 shell (sh -c) 执行
      const p = execFile('sh', ['-c', info.command], { env: { HOME: home, PATH: process.env.PATH }, encoding: 'buffer', maxBuffer: 1 << 26 }, () => {});
      p.stdout.on('data', (d) => ch.write(d));
      p.on('close', (code) => { ch.exit(code || 0); ch.end(); });
    });
  }));
}).listen(2296, '127.0.0.1');

run(async () => {
  await addHost('AS', 2296);
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  const dialogs = []; p.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'AS' }).first().click(); await p.waitForSelector('.tab.active .dot.ok'); await wait(800);
  const sid = (await (await fetch(BASE + '/api/sessions')).json())[0].id;
  const api = (agent, q) => fetch(BASE + '/api/agent-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: J({ sid, agent, q }) }).then((r) => r.json());

  // ---- 接口：各家都读得出来
  let r = await api('claude');
  const c1 = r.sessions.find((x) => x.id.startsWith('1111')), c2 = r.sessions.find((x) => x.id.startsWith('2222'));
  ok(r.sessions.length === 2 && r.sessions[0] === c2, 'Claude：列出 2 个会话 (只有命令没说过话的、子 Agent 的不列)，最近的在前: ' + J(r.sessions.map((x) => x.id)));
  ok(c1.title === '登录页样式修复' && c1.prompt === '修复登录页的样式 "引号" 问题' && c1.cwd === CWD, 'Claude：标题用最新的自动标题，第一句话跳过命令和提示，取到目录: ' + J(c1));
  ok(c1.cmd === `cd '/srv/my proj'\\''s' && claude --resume 11111111-1111-1111-1111-111111111111`, 'Claude：恢复命令 cd 到原来的目录 (带引号也不出错) 再 claude --resume: ' + c1.cmd);
  ok(c2.title === '我起的名字', 'Claude：/rename 起的名字优先');
  r = await api('claude', 'ZEBRA-unique');
  ok(r.sessions.length === 1 && r.sessions[0].id.startsWith('1111'), '搜索：在全部内容里找 (回复里的字也算，不分大小写)');
  r = await api('grok');
  ok(r.sessions.length === 1 && r.sessions[0].title === 'Grok 修 bug' && r.sessions[0].prompt === '帮我修复 Grok 那边的问题' && r.sessions[0].cmd === "cd '/srv/g' && grok --resume 0198a-grok-id",
    'Grok：summary.json 的标题和目录，第一句话从 <user_query> 里取: ' + J(r.sessions[0]));
  r = await api('codex');
  ok(r.sessions.length === 1 && r.sessions[0].title === 'Codex 写测试' && r.sessions[0].prompt === 'Codex 帮我写测试' && r.sessions[0].cmd === "cd '/srv/c' && codex resume 0199b3c4-aaaa-bbbb-cccc-123456789abc",
    'Codex：id 和目录在第一行，起的名字在 session_index，第一句话是 user_message: ' + J(r.sessions[0]));
  r = await api('gemini');
  ok(r.sessions.length === 1 && r.sessions[0].prompt === 'Gemini 你好' && r.sessions[0].cmd === "cd '/srv/gem' && gemini --resume gem-0001", 'Gemini：sessionId、第一句话、.project_root 里的目录: ' + J(r.sessions[0]));
  r = await api('opencode');
  ok(r.sessions.length === 1 && r.sessions[0].title === 'OpenCode 会话' && r.sessions[0].cmd === "cd '/srv/oc' && opencode --session ses_main1", 'OpenCode：标题和目录，子会话不列: ' + J(r.sessions));
  r = await api('nope');
  ok(!!r.error, '不认识的 Agent：报错');

  // ---- 页面
  await p.click('#btnMore'); await p.click('#btnSessions');
  await p.waitForSelector('.agentsp .as-row');
  const titles = () => p.$$eval('.agentsp .as-row .as-title', (xs) => xs.map((x) => x.textContent));
  ok(J(await titles()) === J(['我起的名字', '登录页样式修复']) && /最近 2 个会话/.test(await p.textContent('.agentsp .as-info')), '「⋯ 更多 → 会话历史」：默认 Claude，按最近列出来');
  await p.screenshot({ path: shot('agent-sessions.png') });
  await p.fill('.agentsp .as-search input', '登录'); await wait(200);
  ok(J(await titles()) === J(['登录页样式修复']), '打字：筛选列出来的 (标题、第一句话、目录)');
  await p.fill('.agentsp .as-search input', 'zebra'); await wait(200);
  ok(/回车/.test(await p.textContent('.agentsp .as-list')), '筛选不到：提示回车在全部内容里搜');
  await p.press('.agentsp .as-search input', 'Enter'); await wait(1500);
  ok(J(await titles()) === J(['登录页样式修复']) && /含「zebra」/.test(await p.textContent('.agentsp .as-info')), '回车：在全部会话内容里搜到');
  await p.fill('.agentsp .as-search input', '引号'); await p.click('.agentsp [data-a=search]'); await wait(1500);
  ok(J(await titles()) === J(['登录页样式修复']) && /含「引号」/.test(await p.textContent('.agentsp .as-info')), '点「搜索」按钮：同样在全部内容里搜');
  await p.click('.agentsp .as-row [data-a=copy]'); await wait(300);
  ok(await p.evaluate(() => navigator.clipboard.readText()) === c1.cmd, '「复制」：复制恢复命令');
  got = '';
  await p.click('.agentsp .as-row [data-a=resume]'); await wait(800);
  ok(dialogs.some((m) => m.includes(c1.cmd)) && got === c1.cmd + '\r' && !(await p.$('.agentsp')), '「继续」：确认后在当前终端执行恢复命令，面板关掉: ' + J(got));
  // 换 Agent，记住选的
  await p.click('#btnMore'); await p.click('#btnSessions'); await p.waitForSelector('.agentsp .as-row');
  await p.click('.agentsp .as-tabs [data-agent=grok]'); await wait(1500);
  ok(J(await titles()) === J(['Grok 修 bug']), '切到 Grok：列出 Grok 的会话');
  await p.click('.agentsp .as-tabs [data-agent=codex]'); await wait(1500);
  ok(/未实测/.test(await p.textContent('.agentsp .as-info')), '没实测过的 Agent 标「未实测」');
  await p.click('.agentsp .as-tabs [data-agent=grok]'); await wait(1000);
  await p.keyboard.press('Escape'); await wait(200);
  ok(!(await p.$('.agentsp')), 'Esc 关掉');
  await p.click('#btnMore'); await p.click('#btnSessions'); await wait(1500);
  ok(await p.evaluate(() => document.querySelector('.agentsp .as-tabs .on')?.dataset.agent) === 'grok', '再打开：还是上次选的 Grok');
  await p.keyboard.press('Escape');

  // ---- 「历史」面板里的「💬 会话历史」选项卡：同样的会话列表，「继续」后关掉历史面板
  await p.click('#btnHistory'); await wait(500);
  const tabs = await p.$$eval('#history .htabs button', (xs) => xs.map((x) => x.textContent.trim()));
  ok(J(tabs) === J(['★ 收藏', '🕘 历史', '💬 会话历史']), '历史面板：「🕘 历史」右边有「💬 会话历史」: ' + J(tabs));
  await p.click('#history .htabs [data-tab=agents]'); await p.waitForSelector('#histAgents .as-row');
  const hv = await p.evaluate(() => ({ list: getComputedStyle(document.getElementById('histList')).display, search: getComputedStyle(document.getElementById('histSearch')).display,
    titles: [...document.querySelectorAll('#histAgents .as-row .as-title')].map((x) => x.textContent) }));
  ok(hv.list === 'none' && hv.search === 'none' && J(hv.titles) === J(['Grok 修 bug']), '切到「💬 会话历史」：命令列表藏起来，显示 Agent 会话 (记得上次选的 Grok): ' + J(hv));
  await p.screenshot({ path: shot('history-agents.png') });
  await p.click('#histAgents .as-tabs [data-agent=claude]'); await p.waitForSelector('#histAgents .as-row'); await wait(500);
  got = ''; dialogs.length = 0;
  await p.click('#histAgents .as-row [data-a=resume] >> nth=1'); await wait(800);
  ok(got === c1.cmd + '\r' && await p.isHidden('#history'), '在历史面板里点「继续」：在终端执行恢复命令，历史面板关掉: ' + J(got));
  await p.click('#btnHistory'); await wait(500);
  ok(await p.evaluate(() => document.querySelector('#history .htabs .on')?.dataset.tab) === 'fav' && await p.isVisible('#favAdd'), '再打开历史面板：默认在「★ 收藏」(不记上次的选项卡)');
  await p.click('#history .htabs [data-tab=hist]'); await wait(300);
  ok(await p.isVisible('#histList') && await p.isVisible('#histSearch') && await p.isHidden('#histAgents'), '切回「🕘 历史」：命令列表回来了');
  await p.keyboard.press('Escape'); await wait(300);

  // ---- 手机：面板在屏幕里
  const m = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
  m.on('pageerror', (e) => errors.push(e.message));
  await m.goto(BASE + '/'); await m.waitForSelector('#app:not(.hidden)'); await wait(1500);
  if (await m.isVisible('.term.active .owner-notice button')) { await m.tap('.term.active .owner-notice button'); await wait(800); }
  await m.tap('#btnMore'); await m.tap('#btnSessions'); await m.waitForSelector('.agentsp .as-row');
  const mb = await m.evaluate(() => { const c = document.querySelector('.as-card').getBoundingClientRect(), b = document.querySelector('.as-row [data-a=resume]').getBoundingClientRect(); return { l: c.left, r: c.right, w: innerWidth, br: b.right }; });
  ok(mb.l >= 0 && mb.r <= mb.w && mb.br <= mb.r, '手机：面板和「继续」按钮都在屏幕里: ' + J(mb));
  await m.screenshot({ path: shot('agent-sessions-mobile.png') });
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close();
  fs.rmSync(home, { recursive: true, force: true });
});
