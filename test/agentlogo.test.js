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
  const exec = async (c) => { cmds.push(c); return c.includes('session list') ? 'note\r\n' + JSON.stringify(list) : JSON.stringify(exp); };
  const plain = (t) => t.replace(/\x1b\[[0-9;]*m/g, '');
  let t = plain(await oc.history.read({ sid: '', cwd: 'c:/users/me/', exec, win: true }));
  ok(t.includes('Windows 上的问题') && t.includes('Windows 上的回答') && t.includes('$ dir') && cmds.join('|') === 'opencode session list --format json -n 30|opencode export ses_mine',
    'Windows：没有对话号按目录挑出对话，用 opencode export 读出完整对话: ' + JSON.stringify(cmds));
  cmds.length = 0;
  await oc.history.read({ sid: 'ses_known', cwd: '', exec, win: true });
  ok(cmds.join('|') === 'opencode export ses_known', 'Windows：有对话号直接导出: ' + JSON.stringify(cmds));
  cmds.length = 0;
  await oc.history.read({ sid: 'a & del x', cwd: 'E:\\none', exec, win: true });
  ok(cmds.join('|') === 'opencode session list --format json -n 30|opencode export ses_other', '对话号不像样不拼进命令；目录对不上用最近的: ' + JSON.stringify(cmds));
  const bad = await oc.history.read({ sid: '', cwd: '', exec: async () => '[]', win: true }).then(() => 'ok', (e) => e.message);
  ok(bad === '没有对话', '一个对话都没有算失败 (网页把滚轮交回 OpenCode): ' + bad);
  process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
