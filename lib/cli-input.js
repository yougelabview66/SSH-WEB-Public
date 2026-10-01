/**
 * 模拟终端 (Claude Code) 输入框里的内容：照着按键在一份副本上插入 / 删除 / 移动光标，
 * 用来判断「在里面打过字、还没删光也没发送」。服务端和网页共用这一份代码：
 * 服务端收得到所有设备的输入 (手机上打的字、刷新页面前打的字都算)，网页在本地先算一遍 (不用等来回)。
 *
 * 不知道内容变成了什么的操作 (↑ 翻历史、Tab 补全 / 填入推荐文字、→ 采用推荐文字、Ctrl+R 搜索历史后选中一条、
 * @ 文件列表里按回车选中、Claude Code 运行中按 Esc 打断 (可能把刚发的话放回输入框))：当作「有字」，直到回车 / Ctrl+C / Ctrl+L / Ctrl+U。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CliInput = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const SPACE = /\s/;
  const MAX = 4000; // 太长的内容不同步给网页，只记「有字」

  function create() {
    let text = '', cur = 0, unknown = false;
    let search = null; // Ctrl+R 搜索历史中：搜索前的样子 (Ctrl+C 取消时恢复)
    let prefix = false; // 刚按了 Ctrl+B (tmux 前缀键)：下一个键是给 tmux 的 (Ctrl+B D 断开…)，不进输入框

    const lineStart = () => text.lastIndexOf('\n', cur - 1) + 1;
    const lineEnd = () => { const i = text.indexOf('\n', cur); return i < 0 ? text.length : i; };
    const ins = (t) => { text = text.slice(0, cur) + t + text.slice(cur); cur += t.length; };
    const del = (a, b) => {
      a = Math.max(0, a); b = Math.min(text.length, b);
      if (b > a) { text = text.slice(0, a) + text.slice(b); cur = a; }
    };
    const wordLeft = () => { let i = cur; while (i > 0 && SPACE.test(text[i - 1])) i--; while (i > 0 && !SPACE.test(text[i - 1])) i--; return i; };
    const wordRight = () => { let i = cur; while (i < text.length && SPACE.test(text[i])) i++; while (i < text.length && !SPACE.test(text[i])) i++; return i; };
    // 往前删一个字：emoji 这类占两个编码单位的字一起删
    const backspace = () => { if (cur > 0) del(cur - (/[\udc00-\udfff]/.test(text[cur - 1]) && cur > 1 ? 2 : 1), cur); };
    const clear = () => { text = ''; cur = 0; unknown = false; search = null; };

    function key(seq) {
      switch (seq) {
        case '\x1b[A': case '\x1bOA': // ↑：多行里往上一行，第一行时翻出历史 (不知道是什么)
          if (lineStart() > 0) cur = lineStart() - 1; else unknown = true;
          break;
        case '\x1b[B': case '\x1bOB':
          if (lineEnd() < text.length) cur = lineEnd() + 1;
          break;
        case '\x1b[C': case '\x1bOC': // →：空的时候是采用推荐文字 (不知道是什么)
          if (!text && !unknown) unknown = true; else cur = Math.min(text.length, cur + 1);
          break;
        case '\x1b[D': case '\x1bOD': cur = Math.max(0, cur - 1); break;
        case '\x1b[H': case '\x1bOH': case '\x1b[1~': case '\x1b[7~': cur = lineStart(); break;
        case '\x1b[F': case '\x1bOF': case '\x1b[4~': case '\x1b[8~': cur = lineEnd(); break;
        case '\x1b[3~': del(cur, cur + (/[\ud800-\udbff]/.test(text[cur]) ? 2 : 1)); break; // Delete
        case '\x1b[1;5D': case '\x1b[1;3D': case '\x1bb': cur = wordLeft(); break;
        case '\x1b[1;5C': case '\x1b[1;3C': case '\x1bf': cur = wordRight(); break;
        case '\x1b\x7f': case '\x1b\b': del(wordLeft(), cur); break; // Alt+退格：删一个词
        case '\x1bd': del(cur, wordRight()); break;
        case '\x1b\r': ins('\n'); break; // Alt+回车：换行
        default: // 鼠标报告、焦点进出、功能键、单独的 Esc：和输入框内容无关
      }
    }

    // Ctrl+R 搜索历史时：打的字是搜索词，不进输入框；Esc / Tab = 把选中的放进输入框，回车 = 直接发送，Ctrl+C = 取消
    function searchKey(k) {
      if (k === '\r') clear();
      else if (k === '\x03') { ({ text, cur, unknown } = search); search = null; }
      else if (k === '\x1b' || k === '\t') { search = null; unknown = true; }
    }

    // opt.running：Claude Code 正在运行 (这时按 Esc 是打断，它可能把刚发的话放回输入框)
    function feed(d, opt = {}) {
      const before = text + '\0' + cur + unknown + !!search;
      if (d.startsWith('\x1b[200~')) {
        if (!search) ins(d.slice(6).replace(/\x1b\[201~$/, '').replace(/\r\n?/g, '\n'));
      } else {
        for (let i = 0; i < d.length; i++) {
          const c = d[i];
          if (c === '\x1b') {
            const seq = /^\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|O.|[\s\S])?/.exec(d.slice(i))[0];
            i += seq.length - 1;
            if (seq === '\x1b[M') i += 3; // 老式鼠标报告：后面跟 3 个字节
            else if (prefix && !/^\x1b\[[IO]$|^\x1b\[</.test(seq)) prefix = false; // tmux 前缀键后面的键 (焦点进出、鼠标报告不算)
            else if (search) searchKey(seq);
            else if (seq === '\x1b') { if (opt.running) unknown = true; }
            else key(seq);
          } else if (prefix) prefix = false; // tmux 前缀键后面的键
          else if (c === '\x02') prefix = true; // Ctrl+B：tmux 前缀键
          else if (search) searchKey(c);
          else if (c === '\x12') search = { text, cur, unknown }; // Ctrl+R：开始搜索历史
          else if (c === '\r') { if (/(^|\s)@\S*$/.test(text.slice(0, cur))) unknown = true; else clear(); } // 回车发送；@ 文件列表里是选中文件
          else if (c === '\x03' || c === '\x0c') clear(); // Ctrl+C、Ctrl+L
          else if (c === '\n') ins('\n'); // Ctrl+J：换行
          else if (c === '\x15') { if (unknown) clear(); else del(lineStart(), cur); } // Ctrl+U：删到行首
          else if (c === '\x0b') del(cur, lineEnd()); // Ctrl+K：删到行尾
          else if (c === '\x17' || c === '\b') del(wordLeft(), cur); // Ctrl+W、Ctrl+退格：删一个词
          else if (c === '\x7f') backspace();
          else if (c === '\x04') del(cur, cur + 1); // Ctrl+D
          else if (c === '\x01') cur = lineStart(); // Ctrl+A
          else if (c === '\x05') cur = lineEnd(); // Ctrl+E
          else if (c === '\x06') cur = Math.min(text.length, cur + 1); // Ctrl+F
          else if (c === '\t') unknown = true; // Tab：有字时补全、空的时候填入推荐文字，都不知道变成了什么
          else if (c >= ' ') ins(c);
        }
      }
      return before !== text + '\0' + cur + unknown + !!search;
    }

    return {
      feed,
      locked: () => unknown || text.length > 0 || !!search,
      get: () => (text.length > MAX ? { text: '', cur: 0, unknown: true, search: null } : { text, cur, unknown, search }),
      set: (st) => {
        text = String(st?.text || ''); cur = Math.min(Math.max(0, st?.cur | 0), text.length); unknown = !!st?.unknown;
        search = st?.search ? { text: String(st.search.text || ''), cur: st.search.cur | 0, unknown: !!st.search.unknown } : null;
      },
      clear,
    };
  }

  return { create };
});
