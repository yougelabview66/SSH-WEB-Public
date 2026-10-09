'use strict';
/**
 * 输入栏发送时，回车等程序把文字显示出来再写：
 * 程序一次读到「文字 + 回车」会当成粘贴，回车变成换行、消息发不出去 (Claude Code 等)。显示出来了说明它已经读走了文字，
 * 这时写回车一定是单独的一次读取 —— 程序空闲时几毫秒就显示了，比固定等 50ms 快；正忙 (重画、流式输出) 时会等它读完，
 * 固定等多久都不保险。判断「显示出来了」：画面上这段文字的结尾出现的次数比写之前多了。
 *
 * 文字在屏幕上可能被折行、被输入框的边框隔开 (Claude Code 的 │)，所以比较时去掉空白和制表符；
 * 多行内容 Claude Code 可能显示成「[Pasted text #1 +3 lines]」，这个标记的数量变多了也算。
 * 显示出来的样子和原文不一样 (光标挪过、程序自己排版) 时还有一招：光标前面紧挨着的正好是文字的最后几个字
 * (shell、行编辑器都是这样)，写之前不是、现在是了，也算。都认不出来时由调用方按「输出停下来了」兜底 (见 server.js)
 */

const TAIL = 12; // 拿文字最后这么多个字比较
const CURSOR_TAIL = 3; // 光标前面要对上的字数
const STRIP = /[\s─-╿]/g; // 空白和制表符 (│ ─ ╭ 等)
const PASTED = '[Pastedtext';

/** 要找的结尾；文字全是空白时返回 null (没法判断，退回固定间隔) */
function echoKey(text) {
  const plain = String(text).replace(/\x1b\[20[01]~/g, '').replace(STRIP, '');
  if (!plain) return null;
  return {
    tail: plain.slice(-TAIL),
    end: plain.slice(-CURSOR_TAIL),
    pasted: /[\r\n]/.test(String(text).replace(/\x1b\[20[01]~/g, '').trim()),
  };
}

/** 无界面终端当前画面 (可见的那几行) 拼成一串，去掉空白和制表符 */
function screenText(term) {
  const b = term.buffer.active;
  let out = '';
  for (let y = b.viewportY; y < b.viewportY + term.rows; y++) out += b.getLine(y)?.translateToString(true) || '';
  return out.replace(STRIP, '');
}

/** 光标所在这一行、光标前面的字 (去掉空白和制表符) */
function beforeCursor(term) {
  const b = term.buffer.active;
  return (b.getLine(b.baseY + b.cursorY)?.translateToString(true, 0, b.cursorX) || '').replace(STRIP, '');
}

/** 光标前面紧挨着的正好是文字的最后几个字 (最多 CURSOR_TAIL 个；这一行光标前面字少就比这么多) */
function cursorAfter(term, end) {
  const before = beforeCursor(term);
  const k = Math.min(CURSOR_TAIL, before.length, end.length);
  return k > 0 && before.slice(-k) === end.slice(-k);
}

function count(hay, needle) {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** 画面上能证明「显示出来了」的东西各有多少个；写文字前记一次，之后变多了就是显示出来了 */
function echoMarks(term, key) {
  const s = screenText(term);
  return {
    tail: count(s, key.tail),
    pasted: key.pasted ? count(s, PASTED) : 0,
    cursor: cursorAfter(term, key.end),
  };
}

function echoed(term, key, base) {
  const now = echoMarks(term, key);
  return now.tail > base.tail || now.pasted > base.pasted || (now.cursor && !base.cursor);
}

module.exports = { echoKey, echoMarks, echoed, screenText };
