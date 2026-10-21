'use strict';
// Windows 主机 (SSH 默认 cmd / PowerShell，没有 sh) 的会话历史：改用 SFTP 读会话文件 (只读开头和结尾一段)，
// 全文搜索分块读；恢复命令按终端里的 shell 写 (cmd：cd /d "D:\目录" && …，PowerShell：cd 'D:\目录'; …)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Server, utils: { sftp: { OPEN_MODE, STATUS_CODE } } } = require('ssh2');
const { BASE, ok, wait, run, launch, hostKey, addHost } = require('./helpers');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-aw-')));
const HOME = '/C:/Users/me';
const put = (f, text, ageMin) => {
  const p = path.join(home, f);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  const t = Date.now() / 1000 - ageMin * 60;
  fs.utimesSync(p, t, t);
};
const J = (o) => JSON.stringify(o);
const ID = 'aaaaaaaa-1111-2222-3333-444444444444';
// Claude：600KB 以上，自动标题在最后，搜索词在中间 (只读头尾时读不到，要分块搜)
const filler = [];
for (let i = 0; i < 3000; i++) filler.push(J({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(200) + (i === 1500 ? ' needle-in-middle ' : '') }] } }));
put(`.claude/projects/D--proj-x/${ID}.jsonl`, [
  J({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' }, cwd: 'D:\\proj x' }),
  J({ type: 'user', message: { role: 'user', content: '帮我修 Windows 上的问题' }, cwd: 'D:\\proj x', sessionId: ID }),
  ...filler,
  J({ type: 'ai-title', aiTitle: 'Windows 修复' }),
].join('\n') + '\n', 5);
put('.grok/sessions/D%3A%5Cg/gk-01/summary.json', J({ info: { id: 'gk-01', cwd: 'D:\\g' }, generated_title: 'Grok 在 Windows' }), 9);
put('.grok/sessions/D%3A%5Cg/gk-01/chat_history.jsonl', J({ type: 'user', content: '<user_query>Grok 你好</user_query>' }) + '\n', 9);

// shell：SSH 默认的命令行 (单独开通道执行命令时)；prompt：终端屏幕上的提示符 (终端里可能又进了别的 shell)
function server(port, shell, prompt) {
  new Server({ hostKeys: [hostKey()] }, (c) => {
    c.on('authentication', (ctx) => ctx.accept());
    c.on('ready', () => c.on('session', (acc) => {
      const s = acc();
      s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
      s.on('shell', (a) => a().write(prompt));
      s.on('exec', (a, r, info) => {
        const ch = a(), cmd = info.command;
        const out = (t, code) => { if (t) ch.write(t); ch.exit(code); ch.end(); };
        if (cmd === 'echo %OS%;$env:OS') return out(shell === 'cmd' ? 'Windows_NT;$env:OS\r\n' : '%OS%\r\nWindows_NT\r\n', 0);
        ch.stderr.write(`'${cmd.split(' ')[0]}' is not recognized as an internal or external command,\r\n`);
        out('', 1);
      });
      s.on('sftp', (accept) => {
        const sf = accept();
        const hs = new Map(); let next = 1;
        // /C:/Users/me/… ↔ 本机临时目录
        const loc = (p) => { const r = p === '.' || p === '' ? HOME : p; return r.startsWith(HOME) ? path.join(home, r.slice(HOME.length)) : null; };
        const handle = (v) => { const h = Buffer.alloc(4); h.writeUInt32BE(next); hs.set(next++, v); return h; };
        const get = (h) => hs.get(h.readUInt32BE());
        const attrs = (st) => ({ mode: st.mode, uid: 0, gid: 0, size: st.size, atime: st.atimeMs / 1000 | 0, mtime: st.mtimeMs / 1000 | 0 });
        const nf = (id) => sf.status(id, STATUS_CODE.NO_SUCH_FILE);
        sf.on('REALPATH', (id, p) => { const r = p === '.' ? HOME : p.replace(/\/+$/, ''); sf.name(id, [{ filename: r, longname: r, attrs: {} }]); });
        sf.on('STAT', (id, p) => { try { sf.attrs(id, attrs(fs.statSync(loc(p)))); } catch { nf(id); } });
        sf.on('LSTAT', (id, p) => { try { sf.attrs(id, attrs(fs.lstatSync(loc(p)))); } catch { nf(id); } });
        sf.on('OPENDIR', (id, p) => { const l = loc(p); if (!l || !fs.existsSync(l) || !fs.statSync(l).isDirectory()) return nf(id); sf.handle(id, handle({ dir: l, done: false })); });
        sf.on('READDIR', (id, h) => {
          const d = get(h);
          if (!d || d.done) return sf.status(id, STATUS_CODE.EOF);
          d.done = true;
          sf.name(id, fs.readdirSync(d.dir).map((n) => ({ filename: n, longname: n, attrs: attrs(fs.statSync(path.join(d.dir, n))) })));
        });
        sf.on('OPEN', (id, p, flags) => { const l = loc(p); if (!l || !(flags & OPEN_MODE.READ)) return sf.status(id, STATUS_CODE.FAILURE); try { sf.handle(id, handle({ fd: fs.openSync(l, 'r') })); } catch { nf(id); } });
        sf.on('READ', (id, h, off, len) => { const buf = Buffer.alloc(len); const n = fs.readSync(get(h).fd, buf, 0, len, off); if (!n) return sf.status(id, STATUS_CODE.EOF); sf.data(id, buf.subarray(0, n)); });
        sf.on('FSTAT', (id, h) => { try { sf.attrs(id, attrs(fs.fstatSync(get(h).fd))); } catch { nf(id); } });
        sf.on('CLOSE', (id, h) => { const f = get(h); if (f && f.fd != null) fs.closeSync(f.fd); hs.delete(h.readUInt32BE()); sf.status(id, STATUS_CODE.OK); });
      });
    }));
  }).listen(port, '127.0.0.1');
}
server(2301, 'cmd', 'C:\\Users\\me>'); server(2302, 'powershell', 'PS C:\\Users\\me> '); server(2303, 'cmd', 'PS C:\\Users\\me> ');

run(async () => {
  await addHost('AWC', 2301); await addHost('AWPS', 2302); await addHost('AWMIX', 2303);
  const browser = await launch();
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  for (const h of ['AWPS', 'AWMIX']) { await p.locator('.host', { hasText: h }).first().click(); await p.waitForSelector('.tab.active .dot.ok'); await wait(500); }
  await p.locator('.host', { hasText: 'AWC' }).first().click(); await p.waitForSelector('.tab.active .dot.ok'); await wait(800);
  const sids = await (await fetch(BASE + '/api/sessions')).json();
  const sidOf = (t) => sids.find((x) => x.title === t).id;
  const api = (title, agent, q) => fetch(BASE + '/api/agent-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: J({ sid: sidOf(title), agent, q }) }).then((r) => r.json());

  let r = await api('AWC', 'claude');
  const c = r.sessions[0] || {};
  ok(r.sessions.length === 1 && c.title === 'Windows 修复' && c.prompt === '帮我修 Windows 上的问题' && c.cwd === 'D:\\proj x',
    'Windows 主机 (cmd)：用 SFTP 读出 Claude 会话，标题在文件末尾也读得到 (只读头尾): ' + J(c));
  ok(c.cmd === `cd /d "D:\\proj x" && claude --resume ${ID}`, 'cmd：恢复命令 cd /d "D:\\目录" && claude --resume: ' + c.cmd);
  r = await api('AWC', 'claude', 'NEEDLE-in-middle');
  ok(r.sessions.length === 1 && !r.partial, '全文搜索：文件中间的字也搜得到 (分块读，不分大小写)');
  r = await api('AWC', 'claude', 'not-there-zzz');
  ok(r.sessions.length === 0, '搜不到的词：没有结果');
  r = await api('AWC', 'grok');
  ok(r.sessions.length === 1 && r.sessions[0].title === 'Grok 在 Windows' && r.sessions[0].prompt === 'Grok 你好' && r.sessions[0].cmd === 'cd /d "D:\\g" && grok --resume gk-01', 'Grok 会话也读得到: ' + J(r.sessions[0]));
  r = await api('AWPS', 'claude');
  ok(r.sessions[0]?.cmd === `cd 'D:\\proj x'; claude --resume ${ID}`, "PowerShell：恢复命令 cd 'D:\\目录'; claude --resume (PowerShell 5 没有 &&): " + r.sessions[0]?.cmd);
  r = await api('AWMIX', 'claude');
  ok(r.sessions[0]?.cmd === `cd 'D:\\proj x'; claude --resume ${ID}`, "SSH 默认 cmd、终端里开的是 PowerShell (提示符 PS …>)：按 PowerShell 写: " + r.sessions[0]?.cmd);
  // 第二次打开：文件没变，不再读文件内容 (只列目录)，结果一样
  const t0 = Date.now(); r = await api('AWC', 'claude'); const dt = Date.now() - t0;
  ok(r.sessions[0]?.title === 'Windows 修复', `第二次读：用记住的结果 (${dt}ms)`);
  // 页面上也列得出来
  await p.click('#btnMore'); await p.click('#btnSessions'); await p.waitForSelector('.agentsp .as-row', { timeout: 15000 });
  ok(await p.textContent('.agentsp .as-row .as-title') === 'Windows 修复', '页面：会话历史里列出 Windows 主机上的会话');
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close();
  fs.rmSync(home, { recursive: true, force: true });
});
