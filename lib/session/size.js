'use strict';
// 会话：终端尺寸「谁在用听谁的」(多台设备开着同一个会话)，发送时尺寸变化排到回车之后。方法挂到 Session 上 (见 index.js)
const { clampSize } = require('./util');

const RESIZE_AFTER_ENTER = 150; // 回车写进去后，终端尺寸变化再晚这么久 (留给程序处理回车)

class SessionSize {
  // 终端尺寸听「正在用的设备」的：ws 是发来尺寸的浏览器，claim = 用户正在这台设备上 (页面在前台且有焦点)。
  // 别的设备正在用时，后台设备自动发来的尺寸 (断线重连、恢复画面等) 只记下来不生效，免得把正在用的设备的排版改掉；
  // 在一台设备上打字 (write) 也会让它成为使用者
  resize(cols, rows, ws, claim = true) {
    cols = clampSize(cols, 0);
    rows = clampSize(rows, 0);
    if (!cols || !rows) return;
    // 输入栏刚发送 (回车还在排队，或刚写进去)：发送后输入栏变矮、终端变高，这个尺寸变化要排在回车之后，
    // 再留 RESIZE_AFTER_ENTER 给程序处理回车 —— 不然 Claude Code 先整屏重画 (对话长时一秒多) 才处理回车
    const hold = this.writeQueue ? Infinity : (this.enterAt || 0) + RESIZE_AFTER_ENTER - Date.now();
    if (hold > 0) {
      (this.heldResize ||= new Map()).set(ws || null, [cols, rows, claim]);
      if (hold !== Infinity) { clearTimeout(this.resizeTimer); this.resizeTimer = setTimeout(() => this.applyHeldResize(), hold); }
      return;
    }
    if (ws) {
      ws.size = { cols, rows };
      if (!claim && this.owner && this.owner !== ws && this.clients.has(this.owner)) return;
      if (!claim && !this.owner && this.handoverTimer) return; // 使用者刚关掉页面 (可能在刷新)：后台设备自动发来的尺寸先不接管
      this.owner = ws;
    }
    this.applySize(cols, rows);
  }

  applyHeldResize() {
    clearTimeout(this.resizeTimer);
    if (!this.heldResize || this.writeQueue) return; // 回车还在排队：写进去时 (releaseQueue) 再来
    const wait = (this.enterAt || 0) + RESIZE_AFTER_ENTER - Date.now();
    if (wait > 0) { this.resizeTimer = setTimeout(() => this.applyHeldResize(), wait); return; }
    const held = this.heldResize;
    this.heldResize = null;
    for (const [ws, [cols, rows, claim]] of held) if (!ws || this.clients.has(ws)) this.resize(cols, rows, ws, claim);
  }

  applySize(cols, rows) {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.tracker.onInput(Date.now(), false); // 调整大小引起的重绘不算运行中
    this.term.resize(cols, rows);
    if (this.stream) this.stream.setWindow(rows, cols, 0, 0);
  }
}

module.exports = SessionSize;
