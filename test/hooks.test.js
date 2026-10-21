'use strict';
// Claude Code 钩子通知：钩子脚本 (sh) 把事件写成一行 JSON；在网页上安装 / 卸载 (原来的设置和自己的钩子都保留、有备份、
// 格式不对不动)；事件按标签交给会话 —— 状态以钩子为准，推送写具体内容，要权限时通知带「允许 / 拒绝」；
// 点了只在还是那一次、确认框还在时才发按键 (tmux 里直接发给事件所在的 pane)
// @env PUSH_ALLOW_ANY_ENDPOINT=true NODE_TLS_REJECT_UNAUTHORIZED=0
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { Server, utils: { sftp: { OPEN_MODE, STATUS_CODE } } } = require('ssh2');
const WebSocket = require('ws');
const { BASE, ok, wait, run, launch, shot, hostKey, addHost } = require('./helpers');
// 等测试这边的条件成立 (最多 ms 毫秒)
const until = async (fn, ms) => { for (const end = Date.now() + ms; !fn() && Date.now() < end;) await wait(100); };
const { HOOK_SH, HOOK_EVENTS } = require('../lib/hooks');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-hk-')));
const settingsF = path.join(home, '.claude', 'settings.json');

// ---- 模拟推送服务：收下推送内容，按 Web Push 标准 (aes128gcm) 解密看推了什么
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-hkc-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
  '-keyout', path.join(certDir, 'k.pem'), '-out', path.join(certDir, 'c.pem')], { stdio: 'ignore' });
const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
const authSecret = crypto.randomBytes(16);
function decrypt(body) {
  const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPub]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdh.computeSecret(asPub), authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let i = pt.length - 1; while (i >= 0 && pt[i] === 0) i--; // 去掉填充 (最后一个非 0 字节是分隔符 0x02)
  return JSON.parse(pt.subarray(0, i).toString());
}
let pushed = [];
const pushSrv = https.createServer({ key: fs.readFileSync(path.join(certDir, 'k.pem')), cert: fs.readFileSync(path.join(certDir, 'c.pem')) }, (req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => { try { pushed.push(decrypt(Buffer.concat(chunks))); } catch (e) { pushed.push({ error: e.message }); } res.writeHead(201); res.end(); });
}).listen(0, '127.0.0.1');
fs.rmSync(certDir, { recursive: true, force: true });

// ---- 模拟 SSH 服务器：shell (记下输入) + SFTP (相对路径在 home 下) + exec (tail -F 读事件、常驻 sh 执行脚本)
let got = '', shellSt = null, tailCh = null, scripts = [], nextCode = 0;
new Server({ hostKeys: [hostKey()] }, (c) => {
  c.on('authentication', (ctx) => ctx.accept());
  c.on('ready', () => c.on('session', (acc) => {
    const s = acc();
    s.on('pty', (a) => a()); s.on('window-change', (a) => a && a());
    s.on('shell', (a) => { shellSt = a(); shellSt.write('$ '); shellSt.on('data', (d) => { got += d; }); });
    s.on('exec', (a, r, info) => {
      const ch = a();
      if (info.command.includes('tail -n 0 -F')) { // 先报装没装钩子 (有没有 ~/.ssh-web/hook.sh)，再一直开着
        tailCh = ch; tailCh.cmd = info.command;
        ch.write(fs.existsSync(path.join(home, '.ssh-web/hook.sh')) ? 'SSHWEB_HOOKS=1\n' : 'SSHWEB_HOOKS=0\n');
        return;
      }
      if (info.command === 'sh') { // 常驻通道：每段脚本跑完回结束标记和退出码
        ch.on('data', (d) => {
          const m = /printf '\\n%s %s\\n' '(__SSHWEB_[0-9a-f]+__)'/.exec(String(d));
          if (m) { scripts.push(String(d)); ch.write(`\n${m[1]} ${nextCode}\n`); }
        });
        return;
      }
      scripts.push(info.command); ch.exit(nextCode); ch.end();
    });
    s.on('sftp', (accept) => {
      const sf = accept();
      const hs = new Map(); let next = 1;
      const abs = (p) => path.resolve(home, p);
      const handle = (v) => { const h = Buffer.alloc(4); h.writeUInt32BE(next); hs.set(next++, v); return h; };
      const get = (h) => hs.get(h.readUInt32BE());
      const okr = (id) => sf.status(id, STATUS_CODE.OK);
      const err = (id, e) => sf.status(id, e && e.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE);
      const attrs = (st) => ({ mode: st.mode, uid: st.uid, gid: st.gid, size: st.size, atime: st.atimeMs / 1000 | 0, mtime: st.mtimeMs / 1000 | 0 });
      const fsFlags = (f) => (f & OPEN_MODE.READ && f & OPEN_MODE.WRITE ? fs.constants.O_RDWR : f & OPEN_MODE.WRITE ? fs.constants.O_WRONLY : fs.constants.O_RDONLY)
        | (f & OPEN_MODE.CREAT ? fs.constants.O_CREAT : 0) | (f & OPEN_MODE.TRUNC ? fs.constants.O_TRUNC : 0) | (f & OPEN_MODE.EXCL ? fs.constants.O_EXCL : 0);
      sf.on('REALPATH', (id, p) => { const r = abs(p); sf.name(id, [{ filename: r, longname: r, attrs: {} }]); });
      sf.on('STAT', (id, p) => { try { sf.attrs(id, attrs(fs.statSync(abs(p)))); } catch (e) { err(id, e); } });
      sf.on('LSTAT', (id, p) => { try { sf.attrs(id, attrs(fs.lstatSync(abs(p)))); } catch (e) { err(id, e); } });
      sf.on('FSTAT', (id, h) => { try { sf.attrs(id, attrs(fs.fstatSync(get(h).fd))); } catch (e) { err(id, e); } });
      sf.on('MKDIR', (id, p) => { try { fs.mkdirSync(abs(p)); okr(id); } catch (e) { err(id, e); } });
      sf.on('OPEN', (id, p, flags, a) => { try { sf.handle(id, handle({ fd: fs.openSync(abs(p), fsFlags(flags), a && a.mode ? a.mode & 0o777 : 0o644) })); } catch (e) { err(id, e); } });
      sf.on('READ', (id, h, off, len) => { const buf = Buffer.alloc(len); const n = fs.readSync(get(h).fd, buf, 0, len, off); if (!n) return sf.status(id, STATUS_CODE.EOF); sf.data(id, buf.subarray(0, n)); });
      sf.on('WRITE', (id, h, off, data) => { try { fs.writeSync(get(h).fd, data, 0, data.length, off); okr(id); } catch (e) { err(id, e); } });
      sf.on('CLOSE', (id, h) => { const f = get(h); if (f && f.fd != null) fs.closeSync(f.fd); hs.delete(h.readUInt32BE()); okr(id); });
      sf.on('RENAME', (id, a, b) => { if (fs.existsSync(abs(b))) return err(id); try { fs.renameSync(abs(a), abs(b)); okr(id); } catch (e) { err(id, e); } });
      sf.on('REMOVE', (id, p) => { try { fs.unlinkSync(abs(p)); okr(id); } catch (e) { err(id, e); } });
      sf.on('SETSTAT', (id, p, a) => { try { if (a.mode !== undefined) fs.chmodSync(abs(p), a.mode & 0o777); okr(id); } catch (e) { err(id, e); } });
    });
  }));
}).listen(2293, '127.0.0.1');

const J = (m, u, b) => fetch(BASE + u, { method: m, headers: { 'content-type': 'application/json' }, body: b && JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const ours = (st) => HOOK_EVENTS.map(([ev]) => (st.hooks?.[ev] || []).reduce((n, g) => n + (g.hooks || []).filter((h) => String(h.command).includes('.ssh-web/hook.sh')).length, 0));

run(async () => {
  // ---- 1. 钩子脚本本身：在本机用 sh 跑，输出一行能解析的 JSON，什么都不打印，退出码 0
  const sh = path.join(home, 'hook-test.sh'); fs.writeFileSync(sh, HOOK_SH);
  const fakeHome = path.join(home, 'fakehome'); fs.mkdirSync(fakeHome);
  const runHook = (json, env) => execFileSync('sh', [sh], { input: json, env: { HOME: fakeHome, PATH: '/usr/bin:/bin', ...env } }).toString();
  const out1 = runHook('{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"echo \\"hi\\" && ls C:\\\\tmp"}}', { LC_SSHWEB: 'tab-1' });
  const out2 = runHook('{\n  "hook_event_name": "Stop",\n  "last_assistant_message": "第一行\\n第二行"\n}', { LC_SSHWEB: 'tab-1' });
  const lines = fs.readFileSync(path.join(fakeHome, '.cache/ssh-web/hook.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok(out1 === '' && out2 === '' && lines.length === 2, '钩子脚本：不往外打印 (Claude Code 不会把它当成内容)，每个事件写一行');
  ok(lines[0].tabs === 'tab-1' && lines[0].hook_event_name === 'PermissionRequest' && lines[0].tool_name === 'Bash' && lines[0].command === 'echo "hi" && ls C:\\tmp',
    '钩子脚本：引号、反斜杠原样保留，带上所属标签: ' + JSON.stringify(lines[0]));
  ok(lines[1].hook_event_name === 'Stop' && lines[1].last_assistant_message === '第一行\n第二行', '钩子脚本：格式化过的多行 JSON 也认得出');
  runHook('{"hook_event_name":"UserPromptSubmit","prompt":"修复登录页的样式问题"}', { LC_SSHWEB: 'tab-1' });
  const lp = JSON.parse(fs.readFileSync(path.join(fakeHome, '.cache/ssh-web/hook.log'), 'utf8').trim().split('\n').pop());
  ok(lp.prompt === '修复登录页的样式问题', '钩子脚本：带上你让它做什么 (prompt，状态卡片上显示)');
  runHook('{"hook_event_name":"Stop"}', { LC_SSHWEB: 'stale', TMUX: '/tmp/none,1,0', TMUX_PANE: '%5' });
  const l3 = JSON.parse(fs.readFileSync(path.join(fakeHome, '.cache/ssh-web/hook.log'), 'utf8').trim().split('\n').pop());
  ok(l3.tabs === '' && l3.pane === '%5', '在 tmux 里：不用残留的 LC_SSHWEB (按挂在这个 tmux 会话上的客户端找)，带上 pane');

  // ---- 2. 网页上安装 / 卸载
  await addHost('HK', 2293);
  fs.mkdirSync(path.dirname(settingsF), { recursive: true });
  const original = { theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } };
  const originalText = JSON.stringify(original, null, 2);
  fs.writeFileSync(settingsF, originalText);
  const browser = await launch();
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  const dialogs = []; p.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await p.goto(BASE + '/'); await p.waitForSelector('#app:not(.hidden)');
  await p.locator('.host', { hasText: 'HK' }).first().click(); await p.waitForSelector('.tab.active .dot.ok'); await wait(800);
  await p.click('#btnMore'); await p.click('#btnHooks');
  const stateText = () => p.textContent('.hooksp .hk-state').catch(() => '');
  const waitState = async (re) => { for (let i = 0; i < 40 && !re.test(await stateText()); i++) await wait(200); };
  await waitState(/^(?!正在检查)/);
  ok(await p.textContent('.hooksp .hk-state') === '未安装', '「⋯ 更多 → Claude 钩子通知」：显示未安装');
  await p.click('.hooksp [data-a=install]');
  await waitState(/已安装/);
  let st = JSON.parse(fs.readFileSync(settingsF, 'utf8'));
  ok(dialogs.some((m) => m.includes('settings.json')) && await p.textContent('.hooksp .hk-state') === '✅ 已安装', '点「安装」先确认，装好后显示已安装');
  await p.screenshot({ path: shot('hooks-panel.png') });
  ok(st.theme === 'dark' && st.hooks.Stop.some((g) => g.hooks.some((h) => h.command === 'echo mine')) && ours(st).every((n) => n === 1),
    '安装：原来的设置和自己的钩子都在，每个事件加了一条 SSH-WEB 的钩子: ' + JSON.stringify(ours(st)));
  ok(st.hooks.PreToolUse.some((g) => g.matcher === 'AskUserQuestion') && st.hooks.PermissionRequest.some((g) => g.matcher === '*'), '安装：问问题看 PreToolUse(AskUserQuestion)、要权限看 PermissionRequest');
  ok(fs.readFileSync(path.join(home, '.claude/settings.json.bak-sshweb'), 'utf8') === originalText, '安装前备份了原来的 settings.json');
  const script = path.join(home, '.ssh-web/hook.sh');
  ok(fs.existsSync(script) && (fs.statSync(script).mode & 0o111) && fs.readFileSync(script, 'utf8') === HOOK_SH, '写入了 ~/.ssh-web/hook.sh (可执行)');
  // 装的是旧版本的钩子脚本：面板提示有更新
  fs.appendFileSync(script, '# old\n');
  await p.keyboard.press('Escape'); await wait(200);
  await p.click('#btnMore'); await p.click('#btnHooks'); await waitState(/有更新/);
  ok(/有更新/.test(await stateText()), '装的钩子脚本是旧版本：提示「钩子脚本有更新，点重新安装」');
  // 重新安装：不会多出一份
  dialogs.length = 0;
  await p.click('.hooksp [data-a=install]'); await wait(1500);
  st = JSON.parse(fs.readFileSync(settingsF, 'utf8'));
  ok(ours(st).every((n) => n === 1) && fs.readFileSync(script, 'utf8') === HOOK_SH && await stateText() === '✅ 已安装', '重新安装：还是每个事件一条，不重复，脚本换成新版本');
  // 卸载：回到原来的样子
  await p.click('.hooksp [data-a=uninstall]');
  await waitState(/^未安装$/);
  ok(JSON.stringify(JSON.parse(fs.readFileSync(settingsF, 'utf8'))) === JSON.stringify(original) && !fs.existsSync(script), '卸载：settings.json 回到原来的样子，hook.sh 删掉了');
  // settings.json 不是合法 JSON：不动它
  fs.writeFileSync(settingsF, '{ broken');
  await p.click('.hooksp [data-a=install]'); await wait(1500);
  ok(fs.readFileSync(settingsF, 'utf8') === '{ broken' && /不是合法的 JSON/.test(await p.textContent('.hooksp .hk-msg')), 'settings.json 格式不对：不改，提示先修好');
  await p.keyboard.press('Escape'); await wait(200);
  ok(!(await p.$('.hooksp')), 'Esc 关掉面板');
  await browser.close();

  // ---- 3. 事件 → 状态、推送、允许 / 拒绝 (用 WebSocket 直接开会话：没有页面在前台，才会推送)
  await J('POST', '/api/push/subscribe', { subscription: { endpoint: `https://127.0.0.1:${pushSrv.address().port}/dev`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') } } });
  const host = (await (await fetch(BASE + '/api/hosts')).json()).find((h) => h.name === 'HK');
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws');
  const states = [], details = []; ws.on('message', (m) => { try { const x = JSON.parse(m); if (x.type === 'state') { states.push(x.label); details.push(x.detail || ''); } } catch {} });
  const lastDetail = () => details[details.length - 1];
  await new Promise((r) => ws.on('open', r));
  // 第一个标签 (网页关了，会话还在后台) 已经在读这台主机的 hook.log：同一台主机只开一个通道，第二个标签的事件也从这里来
  const firstTail = tailCh;
  ws.send(JSON.stringify({ type: 'connect', hostId: host.id, title: 'HK2', cols: 80, rows: 24 }));
  await wait(2000);
  ok(!!firstTail && tailCh === firstTail && /\$HOME\/\.cache\/ssh-web\/hook\.log/.test(tailCh.cmd), '连上后用一个通道读这台主机的 hook.log (tail -F)，同一台主机只开一个');
  const sid = (await (await fetch(BASE + '/api/sessions')).json()).find((x) => x.title === 'HK2' && x.status === 'connected')?.id;
  const emit = (ev) => tailCh.write(JSON.stringify({ v: 1, t: 1, tabs: sid, pane: '', ...ev }) + '\n');
  const lastState = () => states[states.length - 1];
  const lastPush = () => pushed[pushed.length - 1];

  // 没装钩子的主机 (刚才卸载了)：终端响铃照常推送
  shellSt.write('\x07');
  await until(() => pushed.length >= 1, 5000);
  ok(pushed.length === 1 && pushed[0].body === '终端提示音', '没装钩子的主机：响铃照常推送');
  // 在网页上装了钩子：马上只按钩子推送 (还没收到任何钩子事件也一样)
  fs.writeFileSync(settingsF, '{}');
  const r0 = await J('POST', '/api/hooks/install', { sid });
  await wait(10500); // 离上一次响铃推送超过 10 秒 (不然本来就有「10 秒内不重复推」挡着，测不出来)
  shellSt.write('\x07'); await wait(1500);
  ok(r0.status === 200 && pushed.length === 1, '装了钩子 (还没收到事件)：响铃不再推送');
  pushed = [];

  // 别的标签的事件：不管
  tailCh.write(JSON.stringify({ v: 1, tabs: 'other-tab', hook_event_name: 'PermissionRequest', tool_name: 'Bash', command: 'x' }) + '\n'); await wait(600);
  ok(lastState() !== '待选择' && !pushed.length, '别的标签的事件不算到这个标签上');

  emit({ hook_event_name: 'UserPromptSubmit', prompt: '修复登录页的样式问题\n细节……' }); await wait(500);
  ok(lastState() === '运行中' && lastDetail() === '在做：修复登录页的样式问题', '开始干活 (UserPromptSubmit)：运行中，状态带上「在做：…」: ' + lastDetail());

  // 要权限 (不在 tmux 里)
  emit({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', command: 'npm test' });
  await until(() => pushed.length >= 1, 5000);
  let pu = lastPush();
  ok(lastState() === '待选择' && pu.title === 'HK2-1 · 待选择' && pu.body === '要执行命令：npm test', '要权限：待选择，推送写出要执行的命令: ' + JSON.stringify(pu));
  ok(Array.isArray(pu.actions) && pu.actions.map((a) => a.action).join() === 'allow,deny' && pu.seq === 1 && pu.sessionId === sid, '推送带「允许 / 拒绝」和这是第几次确认');
  ok(lastDetail() === '要执行命令：npm test', '要权限时状态上写着要执行什么');
  // 紧跟着的 permission_prompt 通知：不再推一次
  emit({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }); await wait(600);
  ok(pushed.length === 1, '紧跟着的「要权限」通知不重复推送');

  let r = await J('POST', `/api/sessions/${sid}/answer`, { choice: 'allow', seq: 99 });
  ok(r.status === 409, '序号对不上 (不是这一次)：不发按键');
  got = '';
  r = await J('POST', `/api/sessions/${sid}/answer`, { choice: 'allow', seq: 1 });
  ok(r.status === 409 && /看不到/.test(r.body.error) && got === '', '屏幕上看不到确认框：不发按键: ' + r.body.error);
  shellSt.write('\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n'); await wait(400);
  r = await J('POST', `/api/sessions/${sid}/answer`, { choice: 'allow', seq: 1 }); await wait(400);
  ok(r.status === 200 && got === '\r' && lastState() === '运行中', '确认框还在：「允许」发回车 (选中的 1. Yes)，回到运行中: ' + JSON.stringify(got));
  r = await J('POST', `/api/sessions/${sid}/answer`, { choice: 'allow', seq: 1 });
  ok(r.status === 409 && /已经处理过/.test(r.body.error), '再点一次：已经处理过了，不再发');
  shellSt.write('\x1b[2J\x1b[H$ '); // Claude Code 回答后会重画，确认框就没了

  // 在 tmux 里：直接发给事件所在的 pane
  scripts = [];
  emit({ hook_event_name: 'PermissionRequest', tool_name: 'Edit', file_path: 'src/a.js', pane: '%3' });
  await until(() => pushed.length >= 2, 5000);
  ok(lastPush().body === '要修改：src/a.js' && lastPush().seq === 2, '改文件的权限：推送写出文件: ' + lastPush().body);
  r = await J('POST', `/api/sessions/${sid}/answer`, { choice: 'deny', seq: 2 });
  const sc = scripts.join('\n');
  ok(r.status === 200 && sc.includes("p='%3'") && sc.includes('tmux send-keys -t "$p" Escape') && sc.includes('capture-pane'), 'tmux 里「拒绝」：先看那个 pane 上还有确认框，再给它发 Esc');
  emit({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', command: 'rm x', pane: '%3' });
  await until(() => pushed.length >= 3, 5000);
  nextCode = 7;
  r = await J('POST', `/api/sessions/${sid}/answer`, { choice: 'allow', seq: 3 });
  nextCode = 0;
  ok(r.status === 409 && /看不到/.test(r.body.error), 'tmux 里那个 pane 上已经没有确认框：不发');

  // 问问题：推送写出问题，不带按钮
  emit({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', question: '用哪个数据库？' });
  await until(() => pushed.length >= 4, 5000);
  ok(lastPush().body === '问你：用哪个数据库？' && !lastPush().actions, '问问题：推送写出问题，不带「允许 / 拒绝」');

  // 做完了 / 出错
  emit({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }); await wait(400);
  emit({ hook_event_name: 'Stop', last_assistant_message: '全部改好了，测试通过\n细节……' });
  await until(() => pushed.length >= 5, 5000);
  ok(lastState() === '完成' && lastPush().body === '做完了：全部改好了，测试通过' && lastPush().title === 'HK2-1 · 完成', '做完了 (Stop)：完成，推送附上回复的第一行: ' + lastPush().body);
  ok(lastDetail() === '做完了：全部改好了，测试通过', '做完了：状态上也写着回复的第一行');
  ws.send(JSON.stringify({ type: 'data', data: 'x' })); await wait(1500);
  ok(lastState() !== '完成', '往这个标签发了内容：「完成」算看过了');
  emit({ hook_event_name: 'StopFailure', error: 'rate_limit', error_details: 'API Error: 429 rate limited' });
  await until(() => lastPush()?.title === 'HK2-1 · 报错', 5000);
  ok(lastState() === '报错' && lastPush().body === 'API Error: 429 rate limited', '出错 (StopFailure)：报错，推送写出错误: ' + JSON.stringify([states.slice(-4), pushed.length, lastPush()]));
  // 收到过钩子事件以后：只按钩子推送 —— 响铃不推 (Claude Code 做完 / 要权限时也响铃，不然一件事推两次)，看屏幕判断的状态只显示不推
  let n0 = pushed.length;
  shellSt.write('\x07'); await wait(1500);
  ok(pushed.length === n0, '收到过钩子事件的标签：响铃不再推送「终端提示音」');
  ws.send(JSON.stringify({ type: 'data', data: 'y' })); await wait(800); // 「报错」算看过了，改看屏幕
  shellSt.write('\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n'); await wait(2000);
  ok(lastState() === '待选择' && pushed.length === n0, '看屏幕判断出的「待选择」只显示、不推送');
  // 实际的重复：Claude Code 做完时先响铃、钩子事件稍后才读到 —— 只推钩子的「完成」，不推「终端提示音」
  shellSt.write('\x1b[2J\x1b[H$ ');
  ws.send(JSON.stringify({ type: 'data', data: 'z' })); await wait(500);
  emit({ hook_event_name: 'UserPromptSubmit' });
  await wait(10500); // 离上一条推送超过 10 秒 (不然本来就有「10 秒内不重复推」挡着，测不出来)
  n0 = pushed.length;
  shellSt.write('\x07'); await wait(300);
  emit({ hook_event_name: 'Stop', last_assistant_message: '又做完了一件' });
  await until(() => pushed.length > n0, 5000); await wait(1000);
  ok(pushed.length === n0 + 1 && lastPush().body === '做完了：又做完了一件', '先响铃、后收到钩子的「做完了」：只推一条「完成」，不推「终端提示音」: ' + JSON.stringify(pushed.slice(n0).map((x) => x.body)));
  ok(!pushed.some((x) => x.error), '推送都能解密');

  // 页面上：电脑的状态悬浮窗、手机的状态卡片里，卡片下面一行写着在做什么 (▾ 标签列表只显示主机名和状态)
  const b2 = await launch();
  const dp = await (await b2.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await dp.goto(BASE + '/'); await dp.waitForSelector('#app:not(.hidden)'); await wait(2000);
  const card = await dp.evaluate(() => [...document.querySelectorAll('#hostFloat .dp-tab')].map((c) => [c.querySelector('.nm').textContent, c.querySelector('.dt')?.textContent || '']));
  ok(card.some(([n, d]) => n === 'HK2-1' && d === '做完了：又做完了一件'), '电脑：状态悬浮窗的卡片下面写着在做什么: ' + JSON.stringify(card));
  // 有在做什么时卡片竖着排、悬浮窗固定 400 宽；字很长也不变宽 (省略)
  const colBox = () => dp.evaluate(() => { const f = document.getElementById('hostFloat'), cs = [...f.querySelectorAll('.dp-tab')].map((c) => c.getBoundingClientRect()); return { w: Math.round(f.getBoundingClientRect().width), lefts: cs.map((c) => Math.round(c.left)), widths: cs.map((c) => Math.round(c.width)), stacked: cs.every((c, i) => !i || c.top >= cs[i - 1].bottom) }; });
  let cb = await colBox();
  ok(cb.w === 400 && cb.stacked && new Set(cb.lefts).size === 1 && new Set(cb.widths).size === 1, '电脑：有在做什么时主机卡片竖着一张一行、一样宽，悬浮窗宽 400: ' + JSON.stringify(cb));
  emit({ hook_event_name: 'Stop', last_assistant_message: '这是一段很长很长的回复'.repeat(8) }); await wait(1500);
  cb = await colBox();
  const ell = await dp.evaluate(() => { const d = [...document.querySelectorAll('#hostFloat .dt')].find((x) => x.textContent.includes('很长')); return !!d && d.scrollWidth > d.clientWidth; });
  ok(cb.w === 400 && ell, '电脑：在做什么很长时悬浮窗不变宽，那行字省略: ' + JSON.stringify(cb));
  await dp.screenshot({ path: require('./helpers').shot('hooks-detail-desk.png'), clip: { x: 840, y: 36, width: 440, height: 160 } });
  const mp = await (await b2.newContext({ ...require('./helpers').devices['Pixel 7'] })).newPage();
  await mp.goto(BASE + '/'); await mp.waitForSelector('#app:not(.hidden)'); await wait(1500);
  // 手机：状态卡片默认关着，「⋯ 更多 → 状态卡片」打开
  ok(await mp.isHidden('#hostFloat'), '手机：状态卡片默认关着 (会盖住一部分终端)');
  await mp.tap('#btnMore'); await mp.tap('#btnFloatM'); await wait(500);
  const list = await mp.evaluate(() => [...document.querySelectorAll('#hostFloat .dp-tab')].map((c) => [c.querySelector('.nm').textContent, c.querySelector('.dt')?.textContent || '']));
  // 横向占满屏幕 (两边各留 4px)，卡片一张一整行、左右边正好对齐 (当前标签的描边也不能凸出来)
  const fr = await mp.evaluate(() => { const r = document.getElementById('hostFloat').getBoundingClientRect(), c = document.querySelector('#hostFloat .dp-tab').getBoundingClientRect(); const cs = [...document.querySelectorAll('#hostFloat .dp-tab')].map((x) => { const b = x.getBoundingClientRect(), sh = getComputedStyle(x).boxShadow, w = /inset/.test(sh) || sh === 'none' ? 0 : 1; return [b.left - w, b.right + w]; });
    return r.left >= 0 && r.left <= 6 && r.right <= innerWidth && r.right >= innerWidth - 6 && c.width > innerWidth - 40 && cs.every(([l, rr]) => Math.abs(l - cs[0][0]) < 0.5 && Math.abs(rr - cs[0][1]) < 0.5); });
  ok(list.some(([n, d]) => n === 'HK2-1' && d.startsWith('做完了：这是一段很长')) && fr, '手机：「⋯ 更多 → 状态卡片」打开，横向占满屏幕，卡片下面也写着在做什么: ' + JSON.stringify(list));
  await mp.screenshot({ path: require('./helpers').shot('hooks-detail-mobile.png'), clip: { x: 0, y: 0, width: 412, height: 260 } });
  // 收起后不占满屏幕，只剩标题栏贴在右边；展开又占满
  await mp.tap('#hostFloat [data-a=min]'); await wait(500);
  const mn = await mp.evaluate(() => { const r = document.getElementById('hostFloat').getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(innerWidth - r.right), w: Math.round(r.width) }; });
  ok(mn.w < 250 && mn.l > 100 && mn.r >= 0 && mn.r <= 20, '手机：状态卡片收起后不占满屏幕，贴着右边: ' + JSON.stringify(mn));
  await mp.screenshot({ path: require('./helpers').shot('hooks-min-mobile.png'), clip: { x: 0, y: 0, width: 412, height: 120 } });
  await mp.tap('#hostFloat [data-a=min]'); await wait(500);
  const mx = await mp.evaluate(() => { const r = document.getElementById('hostFloat').getBoundingClientRect(); return r.left <= 6 && r.right >= innerWidth - 6; });
  ok(mx, '手机：再展开又横向占满屏幕');
  await mp.tap('#btnMore');
  ok(await mp.evaluate(() => document.getElementById('btnFloatM').classList.contains('on')), '手机：菜单里「状态卡片」打着勾 (开着)');
  const mw = await mp.evaluate(() => { const r = document.getElementById('morePop').getBoundingClientRect(), b = document.getElementById('btnHooks').getBoundingClientRect(); const t = document.createRange(); t.selectNodeContents(document.getElementById('btnHooks')); const x = t.getBoundingClientRect(); return { w: Math.round(r.width), mid: Math.abs((x.left + x.right) / 2 - (b.left + b.right) / 2) }; });
  ok(mw.w === 140 && mw.mid < 2, '手机：「⋯ 更多」菜单宽 140px，文字居中: ' + JSON.stringify(mw));
  await mp.screenshot({ path: require('./helpers').shot('hooks-more-mobile.png'), clip: { x: 0, y: 0, width: 412, height: 320 } });
  await mp.tap('#btnFloatM'); await wait(300);
  ok(await mp.isHidden('#hostFloat'), '手机：再点一次关掉');
  await b2.close(); await wait(500);

  // 钩子不是在网页上装的 (主机上已经有 hook.sh)：重新连上这台主机时认出来，同样只按钩子推送
  await J('POST', '/api/hooks/uninstall', { sid });
  fs.mkdirSync(path.join(home, '.ssh-web'), { recursive: true }); fs.writeFileSync(path.join(home, '.ssh-web/hook.sh'), HOOK_SH);
  ws.close();
  for (const x of await (await fetch(BASE + '/api/sessions')).json()) await fetch(BASE + '/api/sessions/' + x.id, { method: 'DELETE' });
  await wait(800);
  tailCh = null;
  const ws3 = new WebSocket(BASE.replace('http', 'ws') + '/ws');
  await new Promise((r) => ws3.on('open', r));
  ws3.send(JSON.stringify({ type: 'connect', hostId: host.id, title: 'HK3', cols: 80, rows: 24 }));
  await until(() => tailCh, 8000); await wait(800);
  n0 = pushed.length;
  shellSt.write('\x07'); await wait(1500);
  ok(!!tailCh && pushed.length === n0, '主机上已经有钩子：重新连上时认出来，响铃不推送');
  ws3.close();
  pushSrv.close();
  fs.rmSync(home, { recursive: true, force: true });
  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
});
