'use strict';
// Grok 的历史视图 (lib/agents/grok.js 的 history)：全屏 (填充) 界面的完整对话不在终端历史里，往上滚时从它的会话文件
// ~/.grok/sessions/<目录>/<会话号>/chat_history.jsonl 读 (SFTP)，排成带颜色的对话放进历史视图；
// 找不到会话文件就把滚轮交还给 Grok；屏幕上是别的程序 (Claude Code 等) 时照旧抓终端历史
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Server, utils: { sftp: { STATUS_CODE } } } = require('ssh2');
const { BASE, ok, wait, launch, hostKey } = require('./helpers');
const { history } = require('../lib/agents/grok');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-gh-')));
const L = (o) => JSON.stringify(o);
const CHAT = [
  L({ type: 'system', content: '系统提示，不显示' }),
  L({ type: 'user', content: [{ type: 'text', text: '<system-reminder>插入的提醒，不显示</system-reminder>' }], synthetic_reason: 'system_reminder' }),
  L({ type: 'user', content: [{ type: 'text', text: '<user_query>\n第一个问题：检查系统\n</user_query>' }], prompt_index: 0 }),
  L({ type: 'reasoning', summary: [{ type: 'summary_text', text: '先看看系统' }], encrypted_content: 'xx' }),
  L({ type: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'run_terminal_command', arguments: L({ command: 'uptime', description: '看运行时间' }) }] }),
  L({ type: 'tool_result', tool_call_id: 'c1', content: Array.from({ length: 20 }, (_, i) => `输出第 ${i + 1} 行`).join('\n') }),
  L({ type: 'assistant', content: '系统正常，已运行 9 小时。' }),
  L({ type: 'user', content: [{ type: 'text', text: '<user_query>第二个问题：网络呢</user_query>' }], prompt_index: 1 }),
  L({ type: 'assistant', content: '网络也正常。' }),
].join('\n') + '\n';
const dir = path.join(home, '.grok', 'sessions', encodeURIComponent('/home/demo/proj'));
fs.mkdirSync(path.join(dir, 'sess-1'), { recursive: true });
fs.writeFileSync(path.join(dir, 'sess-1', 'chat_history.jsonl'), CHAT);

// 排版本身
const r = history.render(CHAT).replace(/\x1b\[[0-9;]*m/g, '');
ok(r.includes('❯ 第一个问题：检查系统') && r.includes('◆ 先看看系统') && r.includes('◈ run_terminal_command  看运行时间') && r.includes('$ uptime')
  && r.includes('输出第 12 行') && !r.includes('输出第 13 行') && r.includes('… 还有 8 行') && r.includes('系统正常，已运行 9 小时。')
  && r.indexOf('第一个问题') < r.indexOf('第二个问题') && !r.includes('系统提示') && !r.includes('插入的提醒'),
'会话记录排成对话：你的话、思考、工具 (命令和前 12 行输出)、回答，按顺序；系统提示和插入的提醒不显示');

let got = {};
const GROK = (r) => '\x1b[?1003h\x1b[?1006h\x1b[H\x1b[2J     ❯ 第二个问题：网络呢\r\n     网络也正常。'
  + `\x1b[${r - 2};1H  │ ❯ \x1b[${r};1H  Shift+Tab:mode  │  Ctrl+x:shortcuts`;
const CLAUDE = () => Array.from({ length: 40 }, (_, i) => `claude line ${i}`).join('\r\n') + '\r\n> ';
function serve(port, draw, withSessions) {
  got[port] = '';
  new Server({ hostKeys: [hostKey()] }, (c) => {
    c.on('authentication', (ctx) => ctx.accept());
    c.on('ready', () => c.on('session', (acc) => {
      const s = acc();
      let rows = 24;
      s.on('pty', (a, x, info) => { rows = info.rows; a(); });
      s.on('window-change', (a) => a && a());
      s.on('shell', (a) => { const st = a(); st.on('data', (d) => { got[port] += d; }); st.write(draw(rows)); });
      s.on('exec', (a) => { const ch = a(); ch.exit(3); ch.end(); }); // 没有 tmux
      s.on('sftp', (accept) => {
        const sf = accept();
        const root = withSessions ? home : fs.mkdtempSync(path.join(os.tmpdir(), 'sshweb-gh0-'));
        const hs = new Map(); let next = 1;
        const abs = (p) => path.resolve(root, p);
        const handle = (v) => { const h = Buffer.alloc(4); h.writeUInt32BE(next); hs.set(next++, v); return h; };
        const get = (h) => hs.get(h.readUInt32BE());
        const err = (id, e) => sf.status(id, e && e.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE);
        const attrs = (st) => ({ mode: st.mode, uid: 0, gid: 0, size: st.size, atime: st.atimeMs / 1000 | 0, mtime: st.mtimeMs / 1000 | 0 });
        sf.on('REALPATH', (id, p) => { const x = abs(p); sf.name(id, [{ filename: x, longname: x, attrs: {} }]); });
        sf.on('STAT', (id, p) => { try { sf.attrs(id, attrs(fs.statSync(abs(p)))); } catch (e) { err(id, e); } });
        sf.on('OPENDIR', (id, p) => { try { sf.handle(id, handle({ dir: abs(p), list: fs.readdirSync(abs(p)), done: false })); } catch (e) { err(id, e); } });
        sf.on('READDIR', (id, h) => {
          const d = get(h);
          if (!d || d.done) return sf.status(id, STATUS_CODE.EOF);
          d.done = true;
          sf.name(id, d.list.map((n) => ({ filename: n, longname: n, attrs: attrs(fs.statSync(path.join(d.dir, n))) })));
        });
        sf.on('OPEN', (id, p) => { try { sf.handle(id, handle({ fd: fs.openSync(abs(p), 'r') })); } catch (e) { err(id, e); } });
        sf.on('READ', (id, h, off, len) => { const buf = Buffer.alloc(len); const n = fs.readSync(get(h).fd, buf, 0, len, off); if (!n) return sf.status(id, STATUS_CODE.EOF); sf.data(id, buf.subarray(0, n)); });
        sf.on('CLOSE', (id, h) => { const f = get(h); if (f && f.fd != null) fs.closeSync(f.fd); hs.delete(h.readUInt32BE()); sf.status(id, STATUS_CODE.OK); });
      });
    }));
  }).listen(port, '127.0.0.1');
}
serve(2251, GROK, true); serve(2252, GROK, false); serve(2253, CLAUDE, true);

(async () => {
  for (const [name, port] of [['GH', 2251], ['GN', 2252], ['CH', 2253]]) {
    await fetch(BASE + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, host: '127.0.0.1', port, username: 'u', password: 'x', daemon: false }) });
  }
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const m = await ctx.newPage(); const errors = []; m.on('pageerror', (e) => errors.push(e.message));
  await m.goto(BASE + '/'); await m.waitForSelector('#app:not(.hidden)');
  const scrollUp = async (name, port) => {
    await m.locator('.host', { hasText: name }).first().click(); await wait(1500);
    const b = await m.locator('.term.active .xterm-screen').boundingBox();
    await m.mouse.move(b.x + b.width / 2, b.y + b.height / 2); got[port] = '';
    for (let i = 0; i < 2; i++) { await m.mouse.wheel(0, -200); await wait(150); }
    await wait(2500);
    return m.evaluate(() => document.querySelector('.term.active .ls-body')?.textContent ?? null);
  };

  const h = await scrollUp('GH', 2251);
  ok(h && h.includes('❯ 第一个问题：检查系统') && h.includes('◈ run_terminal_command') && h.includes('第二个问题：网络呢'),
    `Grok：往上滚，历史视图里是会话文件里的完整对话 (屏幕上只有最后一问一答) ${JSON.stringify((h || '').slice(0, 60))}`);
  await m.keyboard.press('Escape'); await wait(300);

  const n = await scrollUp('GN', 2252);
  ok(n == null && /\x1b\[<6[45];/.test(got[2252]), `Grok 找不到会话文件：不开历史视图，滚轮交还给 Grok (${JSON.stringify(got[2252].slice(0, 30))})`);

  const c = await scrollUp('CH', 2253);
  ok(c == null || !c.includes('第一个问题'), 'Claude Code (屏幕上不是 Grok)：不读 Grok 的会话文件');

  ok(errors.length === 0, '无页面错误 ' + errors.join('; '));
  await browser.close(); process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
