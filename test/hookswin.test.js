'use strict';
// Windows 主机 (SSH 默认 cmd，没有 sh)：钩子装的是 PowerShell 版 (hook.ps1 + 读事件的 watch.ps1)，钩子命令用 powershell -File；
// 读事件跑 watch.ps1 (装之前没有就不读，装好马上开)；事件里没有标签 (Windows 的 SSH 不传 LC_SSHWEB) 就交给这台主机最近有人操作的标签；
// 以前装过的 sh 版钩子条目重新安装时换掉；卸载删干净
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Server, utils: { sftp: { OPEN_MODE, STATUS_CODE } } } = require('ssh2');
const WebSocket = require('ws');
const { BASE, ok, wait, run, launch, hostKey, addHost } = require('./helpers');
const { HOOK_PS1, WATCH_PS1 } = require('../lib/hooks');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-hw-')));
const HOME = '/C:/Users/me';
const settingsF = path.join(home, '.claude', 'settings.json');
const until = async (fn, ms) => { for (const end = Date.now() + ms; !fn() && Date.now() < end;) await wait(100); };

// ---- 模拟 Windows 的 SSH：exec 走 cmd (认不出 sh 命令)，SFTP 的主目录是 /C:/Users/me
let watchCh = null, watchCmds = [];
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { const st = a(); st.write('C:\\Users\\me>'); st.on('data', () => {}); });
    s.on('exec', (a, r, info) => {
      const ch = a(), cmd = info.command;
      const out = (t, code) => { if (t) ch.write(t); ch.exit(code); ch.end(); };
      if (cmd === 'echo %OS%;$env:OS') return out('Windows_NT;$env:OS\r\n', 0);
      if (cmd.includes('watch.ps1')) { // cmd 的 if exist：有 watch.ps1 就一直读，没有报一行 0 就退出
        watchCmds.push(cmd);
        if (!fs.existsSync(path.join(home, '.ssh-web/watch.ps1'))) return out('SSHWEB_HOOKS=0\r\n', 0);
        watchCh = ch; ch.write('SSHWEB_HOOKS=1\r\n');
        return;
      }
      ch.stderr.write(`'${cmd.split(' ')[0]}' is not recognized as an internal or external command,\r\n`);
      out('', 1);
    });
    s.on('sftp', (accept) => {
      const sf = accept();
      const hs = new Map(); let next = 1;
      const loc = (p) => { const r = p === '.' || p === '' ? HOME : p; return path.join(home, r.startsWith(HOME) ? r.slice(HOME.length) : '/nope'); };
      const handle = (v) => { const h = Buffer.alloc(4); h.writeUInt32BE(next); hs.set(next++, v); return h; };
      const get = (h) => hs.get(h.readUInt32BE());
      const okr = (id) => sf.status(id, STATUS_CODE.OK);
      const err = (id, e) => sf.status(id, e && e.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE);
      const attrs = (st) => ({ mode: st.mode, uid: 0, gid: 0, size: st.size, atime: st.atimeMs / 1000 | 0, mtime: st.mtimeMs / 1000 | 0 });
      const fsFlags = (f) => (f & OPEN_MODE.READ && f & OPEN_MODE.WRITE ? fs.constants.O_RDWR : f & OPEN_MODE.WRITE ? fs.constants.O_WRONLY : fs.constants.O_RDONLY)
        | (f & OPEN_MODE.CREAT ? fs.constants.O_CREAT : 0) | (f & OPEN_MODE.TRUNC ? fs.constants.O_TRUNC : 0) | (f & OPEN_MODE.EXCL ? fs.constants.O_EXCL : 0);
      sf.on('REALPATH', (id, p) => { const r = p === '.' ? HOME : p.replace(/\/+$/, ''); sf.name(id, [{ filename: r, longname: r, attrs: {} }]); });
      sf.on('STAT', (id, p) => { try { sf.attrs(id, attrs(fs.statSync(loc(p)))); } catch (e) { err(id, e); } });
      sf.on('LSTAT', (id, p) => { try { sf.attrs(id, attrs(fs.lstatSync(loc(p)))); } catch (e) { err(id, e); } });
      sf.on('FSTAT', (id, h) => { try { sf.attrs(id, attrs(fs.fstatSync(get(h).fd))); } catch (e) { err(id, e); } });
      sf.on('MKDIR', (id, p) => { try { fs.mkdirSync(loc(p)); okr(id); } catch (e) { err(id, e); } });
      sf.on('OPEN', (id, p, flags) => { try { sf.handle(id, handle({ fd: fs.openSync(loc(p), fsFlags(flags), 0o644) })); } catch (e) { err(id, e); } });
      sf.on('READ', (id, h, off, len) => { const buf = Buffer.alloc(len); const n = fs.readSync(get(h).fd, buf, 0, len, off); if (!n) return sf.status(id, STATUS_CODE.EOF); sf.data(id, buf.subarray(0, n)); });
      sf.on('WRITE', (id, h, off, data) => { try { fs.writeSync(get(h).fd, data, 0, data.length, off); okr(id); } catch (e) { err(id, e); } });
      sf.on('CLOSE', (id, h) => { const f = get(h); if (f && f.fd != null) fs.closeSync(f.fd); hs.delete(h.readUInt32BE()); okr(id); });
      sf.on('RENAME', (id, a, b) => { if (fs.existsSync(loc(b))) return err(id); try { fs.renameSync(loc(a), loc(b)); okr(id); } catch (e) { err(id, e); } });
      sf.on('REMOVE', (id, p) => { try { fs.unlinkSync(loc(p)); okr(id); } catch (e) { err(id, e); } });
      sf.on('SETSTAT', (id) => okr(id)); sf.on('FSETSTAT', (id) => okr(id));
    });
  }));
}).listen(2311, '127.0.0.1');

const J = (m, u, b) => fetch(BASE + u, { method: m, headers: { 'content-type': 'application/json' }, body: b && JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const PS_CMD = 'powershell -NoProfile -ExecutionPolicy Bypass -File "C:/Users/me/.ssh-web/hook.ps1"';

run(async () => {
  // 以前在这台 Windows 主机上装过 sh 版 (用不了)：设置里有旧条目、有 hook.sh，还有你自己的钩子
  fs.mkdirSync(path.dirname(settingsF), { recursive: true }); fs.mkdirSync(path.join(home, '.ssh-web'));
  fs.writeFileSync(path.join(home, '.ssh-web/hook.sh'), '#!/bin/sh\n');
  fs.writeFileSync(settingsF, JSON.stringify({ hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'sh "$HOME/.ssh-web/hook.sh"' }] }, { hooks: [{ type: 'command', command: 'echo mine' }] }],
  } }, null, 2));
  await addHost('HW', 2311);
  const browser = await launch();
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  const dialogs = []; p.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'HW' }).first().click(); await p.waitForSelector('.tab.active .dot.ok'); await wait(1500);
  ok(watchCmds.length === 1 && watchCmds[0].startsWith('if exist "%USERPROFILE%\\.ssh-web\\watch.ps1" (powershell -NoProfile -ExecutionPolicy Bypass -File') && !watchCh,
    '连上 Windows 主机 (cmd)：读事件跑 watch.ps1 (cmd 的写法)，还没装就不一直读: ' + watchCmds[0]);

  await p.click('#btnMore'); await p.click('#btnHooks');
  const CL = '.hooksp .hk-row[data-agent=claude]';
  const stateText = () => p.textContent(CL + ' .hk-state').catch(() => '');
  const waitState = async (re) => { for (let i = 0; i < 40 && !re.test(await stateText()); i++) await wait(200); };
  await waitState(/^(?!正在检查)/);
  ok(/一部分/.test(await stateText()) && await p.textContent('.hooksp .hk-sname') === '~/.ssh-web/hook.ps1',
    '面板：以前装的 sh 版算只装了一部分 (没有 hook.ps1)，写的是 hook.ps1: ' + await stateText());
  await p.click(CL + ' [data-a=install]');
  await waitState(/已安装/);
  const st = JSON.parse(fs.readFileSync(settingsF, 'utf8'));
  const cmds = Object.values(st.hooks).flat().flatMap((g) => g.hooks || []).map((h) => h.command);
  ok(dialogs.some((m) => m.includes('~/.ssh-web/hook.ps1')) && await stateText() === '✅ 已安装', '安装：确认框写的是 hook.ps1，装好显示已安装');
  ok(cmds.includes('echo mine') && !cmds.some((x) => x.startsWith('sh ')) && cmds.filter((x) => x !== 'echo mine').every((x) => x === PS_CMD),
    '设置：旧的 sh 条目换成 powershell -File "C:/Users/me/.ssh-web/hook.ps1"，你自己的钩子保留: ' + JSON.stringify([...new Set(cmds)]));
  ok(fs.readFileSync(path.join(home, '.ssh-web/hook.ps1'), 'utf8') === HOOK_PS1 && fs.readFileSync(path.join(home, '.ssh-web/watch.ps1'), 'utf8') === WATCH_PS1,
    '写入 hook.ps1 和 watch.ps1');
  await until(() => watchCh, 5000);
  ok(!!watchCh && watchCmds.length === 2, '装好马上开始读事件 (不用重新连接)');
  await p.click('.hooksp [data-a=close]');
  const pageSid = (await (await fetch(BASE + '/api/sessions')).json()).find((x) => x.title === 'HW')?.id;

  // ---- 事件：Windows 的事件里没有标签 → 交给这台主机最近有人操作的标签；行尾 \r\n、开头 BOM 也认得
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws');
  const states = []; ws.on('message', (m) => { try { const x = JSON.parse(m); if (x.type === 'state') states.push([x.label, x.detail || '']); } catch {} });
  await new Promise((r) => ws.on('open', r));
  const host = (await (await fetch(BASE + '/api/hosts')).json()).find((h) => h.name === 'HW');
  ws.send(JSON.stringify({ type: 'connect', hostId: host.id, title: 'HW2', cols: 80, rows: 24 }));
  await wait(2000);
  ws.send(JSON.stringify({ type: 'data', data: 'x' })); await wait(300); // 这个标签刚有人操作
  const emit = (ev, pre = '') => watchCh.write(pre + JSON.stringify({ v: 2, t: 1, agent: 'claude', tabs: '', pane: '', ...ev }) + '\r\n');
  emit({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', command: 'npm test', cwd: 'D:\\proj' }, '\uFEFF');
  await until(() => states.some(([l]) => l === '待选择'), 3000);
  const last = states[states.length - 1] || [];
  ok(last[0] === '待选择' && last[1] === '要执行命令：npm test', '没有标签的事件交给最近操作的标签：待选择「要执行命令：npm test」: ' + JSON.stringify(last));
  emit({ hook_event_name: 'Stop', last_assistant_message: '改好了' });
  await until(() => states[states.length - 1]?.[0] === '完成', 3000);
  ok(states[states.length - 1]?.[1] === '做完了：改好了', '做完：完成「做完了：改好了」');

  // ---- 钩子脚本本身：本机有 PowerShell (pwsh / SSHWEB_PWSH) 就真的跑一遍
  const pwsh = process.env.SSHWEB_PWSH || ['pwsh', 'powershell'].find((x) => { try { execFileSync('sh', ['-c', `command -v ${x}`], { stdio: 'ignore' }); return true; } catch { return false; } });
  if (pwsh) {
    const ps1 = path.join(home, 'hook-test.ps1'); fs.writeFileSync(ps1, HOOK_PS1);
    const fake = path.join(home, 'fakeprofile');
    const runPs = (args, json) => execFileSync(pwsh, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, ...args], { input: json, env: { ...process.env, USERPROFILE: fake, LC_SSHWEB: 'tab-9' } }).toString();
    const o1 = runPs([], '{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"echo \\"中文\\" && dir C:\\\\x"},"cwd":"D:\\\\proj"}');
    const o2 = runPs(['gemini'], '{"hook_event_name":"AfterAgent","prompt_response":"全部完成"}');
    const lines = fs.readFileSync(path.join(fake, '.cache/ssh-web/hook.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    ok(o1 === '' && lines[0].tabs === 'tab-9' && lines[0].command === 'echo "中文" && dir C:\\x' && lines[0].cwd === 'D:\\proj',
      'hook.ps1：不往外打印，中文 / 引号 / 反斜杠原样保留: ' + JSON.stringify(lines[0]));
    ok(o2.trim() === '{}' && lines[1].agent === 'gemini' && lines[1].last_assistant_message === '全部完成', 'hook.ps1：Gemini 先回 {}');
  } else console.log('  (本机没有 PowerShell，跳过 hook.ps1 实跑；设 SSHWEB_PWSH=路径 可以跑)');

  // ---- 卸载：hook.sh / hook.ps1 / watch.ps1 都删掉
  const un = await J('POST', '/api/hooks/uninstall', { sid: pageSid, agent: 'claude' });
  ok(un.status === 200 && un.body.scriptRemoved && !['hook.sh', 'hook.ps1', 'watch.ps1'].some((f) => fs.existsSync(path.join(home, '.ssh-web', f))),
    '卸载：hook.sh / hook.ps1 / watch.ps1 都删了');
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  ws.close();
  await browser.close();
  for (const x of await (await fetch(BASE + '/api/sessions')).json()) await fetch(BASE + '/api/sessions/' + x.id, { method: 'DELETE' });
  fs.rmSync(home, { recursive: true, force: true });
});
