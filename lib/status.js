'use strict';

// 主机状态：由服务端根据无界面终端的画面和输出节奏判断，推送给所有打开的网页；
// 状态变成完成 / 待选择 / 报错且没人在看时发推送通知 (手机切到后台也能收到)。
//
//   运行中 (run)  Claude Code 底部有「✻ Frosting… (12s · …)」转圈状态行；不是 Claude Code 时看输出是否持续
//   待选择 (bad)  选择框里当前选中的「❯ 1. …」、「Do you want to …」开头的行、行尾 [Y/n]
//   报错   (bad)  以 API Error 开头的行 (普通的「⎿ Error: …」是工具调用失败，Claude 会自己处理，不算)
//   完成   (done) 「✻ Worked for 1m 2s」(会推送)，或者持续输出停下来了 / 收到提示音 (只显示)；之后有人往这个标签发了内容就回到空闲
//   空闲   (idle)

// 只认整行的格式，不认句子中间提到的字样 (对话内容里常会出现这些词)
const CHOICE_RE = /^[\s│]*❯\s*\d+\.\s|^[\s│]*Do you want to |\[[Yy]\/[Nn]\]\s*$/m;
const ERROR_RE = /^[\s│]*(⎿\s*)?API Error\b/m;
const CLAUDE_RUN_RE = /^\s*[·✢✳✶✻✽*]\s+[A-Z][A-Za-zÀ-ɏ-]+…/m;
const CLAUDE_DONE_RE = /^\s*[·✢✳✶✻✽*]\s+(Baked|Brewed|Churned|Cogitated|Cooked|Crunched|Sautéed|Worked) for \d/m;

const ECHO_MS = 400; // 输入 / 调整大小后这么久以内的输出是回显、重绘，不算运行中
const RUN_WINDOW = 3000; // 最近 3 秒内持续有输出 (跨度超过 0.6 秒) = 运行中
const RUN_SPAN = 600;

// 屏幕上最后 20 行有字的内容：转圈状态行、选择框、API 报错都在最底部
// (下面还有输入框、自定义状态栏、tmux 状态栏，所以要看 20 行)；只看这一段，避免对话里早先的内容一直算数
function screenTail(term, max = 20) {
  const b = term.buffer.active, top = b.viewportY, out = [];
  for (let y = top + term.rows - 1; y >= top && out.length < max; y--) {
    const line = b.getLine(y)?.translateToString(true) || '';
    if (line.trim()) out.unshift(line);
  }
  return out.join('\n');
}

class StatusTracker {
  constructor() {
    this.outTimes = [];
    this.inputAt = 0;   // 最近一次输入 / 调整大小
    this.dataAt = 0;    // 最近一次输入 (有人往这个标签发了内容 = 看到了)
    this.alertAt = 0;   // 最近一次提示音
    this.doneAt = 0;    // 持续输出停下来的时间
    this.running = false;
    this.doneLineAt = 0; // 「Worked for …」第一次出现的时间
  }

  onOutput(now) {
    if (now - this.inputAt <= ECHO_MS) return;
    this.outTimes.push(now);
    if (this.outTimes.length > 30) this.outTimes.splice(0, this.outTimes.length - 30);
    if (this.isRunning(now)) { this.running = true; this.alertAt = this.doneAt = 0; } // 又开始干活了，之前的「完成」作废
  }

  onInput(now, isData) {
    this.inputAt = now;
    if (isData) { this.dataAt = now; this.alertAt = this.doneAt = 0; }
  }

  onBell(now) {
    this.alertAt = now;
  }

  // 只算提示音 0.5 秒之后的输出 (之前的是完成前的转圈)
  isRunning(now) {
    const since = this.alertAt ? this.alertAt + 500 : 0;
    const t = this.outTimes.filter((v) => now - v < RUN_WINDOW && v > since);
    return t.length >= 3 && t[t.length - 1] - t[0] > RUN_SPAN;
  }

  // 返回 { label, cls, why }；why 用在推送通知里
  evaluate(term, now) {
    const tail = screenTail(term);
    // 「Worked for …」第一次出现的时间：看不到这一行、或者又开始转圈了就清零，
    // 下次做完重新计时 (否则会拿上一次的时间，和之后发送内容的时间比，误判成空闲)
    if (!CLAUDE_DONE_RE.test(tail) || CLAUDE_RUN_RE.test(tail)) this.doneLineAt = 0;
    if (CLAUDE_RUN_RE.test(tail)) { this.running = true; return { label: '运行中', cls: 'run' }; }
    if (CHOICE_RE.test(tail)) { this.running = false; return { label: '待选择', cls: 'bad', why: '需要你选择' }; }
    if (ERROR_RE.test(tail)) {
      this.running = false;
      const line = (tail.match(/^.*API Error.*$/m) || [''])[0].replace(/^[\s│⎿]+/, '').slice(0, 120);
      return { label: '报错', cls: 'bad', why: line || 'API Error' };
    }
    if (CLAUDE_DONE_RE.test(tail)) {
      this.running = false;
      if (!this.doneLineAt) this.doneLineAt = now;
      return this.dataAt > this.doneLineAt ? { label: '空闲', cls: 'idle' } : { label: '完成', cls: 'done', why: '做完了' };
    }
    if (this.isRunning(now)) { this.running = true; return { label: '运行中', cls: 'run' }; }
    if (this.running) { this.running = false; this.doneAt = now; }
    // 按输出节奏 / 提示音判断的完成只显示、不推送 (tail -f 这类一阵一阵的输出会反复「完成」；提示音本身会推送)
    if (this.alertAt || this.doneAt) return { label: '完成', cls: 'done' };
    return { label: '空闲', cls: 'idle' };
  }
}

module.exports = { StatusTracker, screenTail, CHOICE_RE, ERROR_RE, CLAUDE_RUN_RE, CLAUDE_DONE_RE };
