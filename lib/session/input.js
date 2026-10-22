'use strict';
// 会话：把浏览器发来的按键 / 文字写进 SSH (输入栏发送时回车排队等回显、终端输入框内容同步)。方法挂到 Session 上 (见 index.js)
const echoWait = require('../echo-wait');

// 输入栏发送的回车：文字显示出来马上写，最多等这么久 (同以前的固定间隔，见 write)
const ECHO_SILENT_MS = 50;

class SessionInput {
  // 网页从输入栏发送：文字 (echo) 和回车 (gap) 分两条发来，回车要和文字分开写进终端 —— 程序一次读到两样会当成粘贴，
  // 回车变成换行、消息发不出去。回车先排队，等程序把文字显示出来 (说明已经读走了) 马上写 (见 lib/echo-wait.js)：
  //   - 显示出来了：马上写 (程序空闲时十几毫秒，比固定等 50ms 快)
  //   - gap (50ms) 到了还没显示 (正忙、输密码这类不显示的)：照写，同以前 —— 等显示出来再写更稳，但 Claude Code
  //     对话长了重画一次要几百毫秒，每条消息都慢半拍
  // 网页那边不计时 (浏览器正忙会把计时拖长，网络抖动也可能把两条挤到一起)。等的期间后面来的内容排在回车后面，顺序不变；
  // 终端尺寸变化也排到回车之后 (见 resize)
  // tmux：给 tmux 的按键 (退出复制模式的 q)，不是打进程序输入框的字，不算进 this.cli
  write(data, autoFrom, fromWs, { gap = 0, echo = false, tmux = false } = {}) {
    // 终端自动应答 (程序问光标位置之类) 不排队：程序可能正等着这个回答才能把文字显示出来
    if (this.writeQueue && !autoFrom) { this.writeQueue.push([data, autoFrom, fromWs, tmux]); return; }
    if (gap > 0 && !autoFrom) {
      const e = this.echoWait;
      const wait = e ? 0 : (this.lastWriteAt || 0) + Math.min(gap, 500) - Date.now();
      if (e || wait > 0) {
        this.writeQueue = [[data, autoFrom, fromWs, tmux]];
        this.enterGap = Math.min(gap, 500);
        if (e) this.checkEcho();
        else this.queueTimer = setTimeout(() => this.releaseQueue(), wait);
        return;
      }
    }
    const key = echo && !autoFrom ? echoWait.echoKey(data) : null;
    const base = key ? echoWait.echoMarks(this.term, key) : null;
    if (!autoFrom && !gap && this.echoWait) { clearTimeout(this.echoWait.timer); this.echoWait = null; } // 打了别的：上一段的回显不用等了
    this.writeNow(data, autoFrom, fromWs, !!key, tmux);
    if (gap > 0) this.enterAt = Date.now();
    if (key) {
      clearTimeout(this.echoWait?.timer);
      this.echoWait = { key, base, at: Date.now(), timer: null };
    }
  }

  // 排着队的回车能不能写了 (输出写进无界面终端后、计时到了都会来问)
  checkEcho() {
    const e = this.echoWait;
    if (!e || !this.writeQueue) return;
    const age = Date.now() - e.at;
    const gap = this.enterGap || ECHO_SILENT_MS;
    if (age >= gap || echoWait.echoed(this.term, e.key, e.base)) return this.releaseQueue();
    clearTimeout(e.timer);
    e.timer = setTimeout(() => this.checkEcho(), gap - age);
  }

  releaseQueue() {
    clearTimeout(this.queueTimer);
    clearTimeout(this.echoWait?.timer);
    this.echoWait = null;
    const q = this.writeQueue || [];
    this.writeQueue = null;
    for (const [d, a, w, t] of q) this.writeNow(d, a, w, false, t);
    this.enterAt = Date.now();
    this.applyHeldResize();
  }

  // autoFrom：终端自动应答来自哪个浏览器 (不是用户打的字)。几台设备同时开着时每台都会回答同一个询问，
  // 0.5 秒内来自不同设备的相同应答只转发一次；自动应答不算输入，不影响主机状态
  // holdCli：输入栏发送的文字，回车紧跟着就来 —— 「终端输入框里有字」这个中间状态先不告诉网页
  // (网页据此决定点终端时光标去哪：收到了会以为还在终端里编辑，回车写进去之前点终端光标不回下方输入框)
  writeNow(data, autoFrom, fromWs, holdCli = false, tmux = false) {
    if (!this.stream) return;
    if (autoFrom) {
      const now = Date.now(), last = this.lastAuto;
      if (last && last.data === data && last.ws !== autoFrom && now - last.t < 500) return;
      this.lastAuto = { data, ws: autoFrom, t: now };
      this.stream.write(data);
      return;
    }
    this.stream.write(data);
    this.lastWriteAt = Date.now();
    // Linux 常驻会话里敲了 tmux：提示一次不用再开 (开着也没问题，见 daemon.js 的 hintTmux)
    if (this.daemonId && this.daemonOs === 'linux' && typeof data === 'string' && /[\r\n]/.test(data)
      && /^\s*tmux(\s|$)/.test(this.cli.get().text + data.split(/[\r\n]/)[0])) this.hintTmux();
    // 二进制 (旧式鼠标点击，见 ws.js) 不是打进输入框的字：以前也拿去分析，报错后主机状态也没更新
    const changed = !tmux && typeof data === 'string' && this.cli.feed(data, { running: this.state.cls === 'run' });
    clearTimeout(this.cliTimer);
    if (holdCli && changed) this.cliHeld = true;
    if (holdCli) this.cliTimer = setTimeout(() => this.syncCli(), 1000); // 回车一直没来 (断线等)：还是要同步
    else if (changed || this.cliHeld) this.syncCli();
    this.tracker.onInput(Date.now(), true); // 有人往这个标签发了内容：回显不算运行中，「完成」算已经看到了
    // 按了回车 (发命令 / 发消息)：铃铛判断「之后有没有新的事」用。鼠标上报 (tmux 里滚轮、点击) 和焦点进出
    // (切标签时 Claude Code 要的 ESC[I / ESC[O) 里没有回车，不会算进来
    if (typeof data === 'string' && /[\r\n]/.test(data.replace(/\x1b\[<[\d;]+[Mm]|\x1b\[M[\s\S]{3}/g, ''))) this.sentAt = Date.now();
    this.scheduleState();
  }

  syncCli() {
    clearTimeout(this.cliTimer);
    this.cliHeld = false;
    this.broadcast({ type: 'cli', ...this.cli.get() });
  }
}

module.exports = SessionInput;
