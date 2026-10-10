'use strict';
// 会话：终端尺寸「谁在用听谁的」(多台设备开着同一个会话)，发送时尺寸变化排到回车之后。方法挂到 Session 上 (见 index.js)
//
// 使用者 (owner) 是最后连上的设备：打开 / 刷新页面、断线重连 (页面在前台时)，终端按它的尺寸排版，马上生效；
// 其他设备上一直显示「正在 xx 上使用 · 在本机继续」，它们的尺寸不再改排版 (不会来回换、整屏重画)。
// 使用者关掉页面 / 断线了也不自动换 (提示留着)：在别的设备上点那个提示、切到这个标签、或者在上面打字发送才换。
// 页面在后台时断线重连不抢 (口袋里锁屏的手机)；原来就是使用者的页面重连回来还是使用者 (见 adoptOwner)
const { clampSize } = require('./util');

const RESIZE_AFTER_ENTER = 150; // 回车写进去后，终端尺寸变化再晚这么久 (留给程序处理回车)

class SessionSize {
  // 终端尺寸听使用者的：ws 是发来尺寸的浏览器，claim = 这台设备要当使用者 (连上时页面在前台、切到这个标签、点了「在本机继续」)。
  // 别的设备是使用者时，其他设备发来的尺寸只记下来不生效。在一台设备上打字 (write) 也会让它成为使用者
  // (网页上被锁住的一端不会发出输入，要先点「在本机继续」，见 public/app/42-owner.js)
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
      if (!claim && this.owner && this.owner !== ws) return;
      this.setOwner(ws);
    }
    this.applySize(cols, rows);
  }

  // 换使用者，告诉每台设备现在是不是它在用、在哪台设备上用 (网页据此显示「正在 xx 上使用」)
  setOwner(ws) {
    if (this.owner === ws) return;
    this.owner = ws;
    this.ownerAway = false;
    for (const c of this.clients) this.sendTo(c, this.ownerMsg(c));
  }

  // 使用者的页面断线重连回来 (换了一条连接，页面还是那个)：还是它，不用等它在前台。连上时 (先于 resize / attach) 调用
  adoptOwner(ws) {
    if (!this.owner || this.owner === ws || !ws.pageId || this.owner.pageId !== ws.pageId || this.clients.has(this.owner)) return;
    this.owner = ws;
    this.ownerAway = false;
    for (const c of this.clients) this.sendTo(c, this.ownerMsg(c)); // 其他设备上「手机已断开」改回「正在手机上使用」
  }

  // online：使用者的页面还连着 (关掉 / 锁屏断线了也还是它在用，其他设备上提示「手机已断开」，见 detach)
  ownerMsg(ws) {
    return { type: 'owner', mine: this.owner === ws, device: this.owner?.device || '', online: !this.ownerAway };
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
