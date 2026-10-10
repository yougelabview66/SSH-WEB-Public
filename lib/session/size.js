'use strict';
// 会话：终端尺寸「谁在用听谁的」(多台设备开着同一个会话)，发送时尺寸变化排到回车之后。方法挂到 Session 上 (见 index.js)
//
// 一个标签同一时间只有一台设备在用 (owner)，终端按它的屏幕排版；其他设备锁住：镜像只看 (按它的行列缩放显示)、不能输入。
// 最先用的客户端锁定这个标签 (新建会话的那台)：别的设备打开 / 切到这个标签都锁着，只有点弹窗里的「在本机继续」才接管 (claim = true)。
// 使用者关掉页面 / 断线了也不自动换 (弹窗提示「xx 已断开」)；它自己刷新 / 重新打开 / 断线重连回来还是它 (见 adoptOwner)
const { clampSize } = require('./util');

const RESIZE_AFTER_ENTER = 150; // 回车写进去后，终端尺寸变化再晚这么久 (留给程序处理回车)

class SessionSize {
  // 终端尺寸听使用者的：ws 是发来尺寸的浏览器。claim：true = 接管 (点了「在本机继续」)；
  // 'auto' = 没有使用者时才当 (打开页面)；false = 只报告这台设备的尺寸。
  // 别的设备是使用者时，其他设备发来的尺寸只记下来不生效。打字不会换使用者
  // (网页上被锁住的一端也不会发出输入，要先点「在本机继续」，见 public/app/42-owner.js)
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
      if (this.owner && this.owner !== ws && claim !== true) return;
      this.setOwner(ws);
    }
    this.applySize(cols, rows);
  }

  // 换使用者，告诉每台设备现在是不是它在用、在哪台设备上用 (网页据此锁住 / 解锁)
  setOwner(ws) {
    if (this.owner === ws) return;
    this.owner = ws;
    this.sendOwner();
  }

  sendOwner() {
    for (const c of this.clients) this.sendTo(c, this.ownerMsg(c));
  }

  // 使用者回来了 (换了一条连接)：还是它，不用再点。连上时 (先于 resize / attach) 调用
  //   - 同一个页面断线重连 (pageId 一样)：旧连接可能还没发现断了，照样认
  //   - 同一台设备 (同一个浏览器，deviceId 一样) 刷新 / 重新打开页面：旧页面已经关了才认 (同时开着两个窗口时另一个还锁着)
  adoptOwner(ws) {
    const o = this.owner;
    if (!o || o === ws) return;
    const samePage = ws.pageId && o.pageId === ws.pageId;
    const sameDevice = ws.deviceId && o.deviceId === ws.deviceId && !this.clients.has(o);
    if (!samePage && !sameDevice) return;
    this.owner = ws;
    this.clients.add(ws); // 先算进来 (马上就 attach)：其他设备上「xx 已断开」改回「正在 xx 上使用」
    this.sendOwner();
  }

  // mine：是不是这台在用；online：使用者的页面还连着；cols / rows：终端现在的尺寸 (锁住的一端按它镜像显示)
  ownerMsg(ws) {
    const o = this.owner;
    return { type: 'owner', mine: o === ws, device: o?.device || '', online: !o || this.clients.has(o), cols: this.cols, rows: this.rows };
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
    for (const c of this.clients) if (c !== this.owner) this.sendTo(c, { type: 'tsize', cols, rows }); // 锁住的一端跟着改镜像
  }
}

module.exports = SessionSize;
