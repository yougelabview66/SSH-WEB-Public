'use strict';
// 会话：终端尺寸「谁在用听谁的」(多台设备开着同一个会话)，发送时尺寸变化排到回车之后。方法挂到 Session 上 (见 index.js)
//
// 一个标签同一时间只有一台设备在用 (owner)，终端按它的屏幕排版；其他设备锁住：镜像只看 (按它的行列缩放显示)、不能输入。
// 先来先用：别的设备打开 / 切到这个标签时，使用者还在用 (见 ownerBusy)，那台就锁着，点「在本机继续」才接管 (claim = true)；
// 使用者确定不在用了 (关掉页面 / 断线锁屏 / 页面到后台 / 切到别的标签 / 5 分钟没动)，等 OWNER_IDLE_MS 没回来，
// 换给正在看这个标签的设备 (见 scheduleHandover)。打开 / 切过来时使用者已经不在用，直接接管 (claim = 'auto')
const { clampSize } = require('./util');

const RESIZE_AFTER_ENTER = 150; // 回车写进去后，终端尺寸变化再晚这么久 (留给程序处理回车)
const OWNER_IDLE_MS = 5000; // 使用者不在用了，等这么久 (可能在刷新页面、马上切回来) 再换给正在看的设备

class SessionSize {
  // 终端尺寸听使用者的：ws 是发来尺寸的浏览器。claim：true = 要接管 (点了「在本机继续」、重新连接)；
  // 'auto' = 使用者不在用就接管 (打开页面、页面在前台时重连、切到这个标签)；false = 只报告这台设备的尺寸。
  // 别的设备是使用者时，其他设备发来的尺寸只记下来 (换给它时用) 不生效。在一台设备上打字 (write) 也会让它成为使用者
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
      if (this.owner && this.owner !== ws && (!claim || (claim === 'auto' && this.ownerBusy()))) return;
      this.setOwner(ws);
    }
    this.applySize(cols, rows);
  }

  // 使用者还在用：页面连着、正在看这个标签 (页面在前台、是当前标签)、5 分钟内动过。还没报告过 (刚连上) 的算在用
  ownerBusy() {
    const o = this.owner;
    return !!o && this.clients.has(o) && o.watching !== false && !o.idle;
  }

  // 换使用者，告诉每台设备现在是不是它在用、在哪台设备上用 (网页据此锁住 / 解锁)
  setOwner(ws) {
    if (this.owner === ws) return;
    this.owner = ws;
    this.ownerIdleAt = 0;
    clearTimeout(this.handoverTimer);
    this.sendOwner();
  }

  sendOwner() {
    this.lastBusy = this.ownerBusy();
    for (const c of this.clients) this.sendTo(c, this.ownerMsg(c));
  }

  // 使用者的页面断线重连回来 (换了一条连接，页面还是那个)：还是它，不用等它在前台。连上时 (先于 resize / attach) 调用
  adoptOwner(ws) {
    if (!this.owner || this.owner === ws || !ws.pageId || this.owner.pageId !== ws.pageId || this.clients.has(this.owner)) return;
    this.owner = ws;
    this.ownerIdleAt = 0;
    clearTimeout(this.handoverTimer);
    this.clients.add(ws); // 先算进来 (马上就 attach)：其他设备上「手机已断开」改回「正在手机上使用」
    this.sendOwner();
  }

  // 浏览器报告它在不在看这个标签 (见 ws.js 的 watching)，或者断开了 (detach)：使用者不在用了就准备换人；
  // 有设备开始看、使用者早就不在用了，马上换给它
  watchChanged() {
    const busy = this.ownerBusy();
    if (busy !== this.lastBusy) this.sendOwner(); // 其他设备上提示「手机在用」/「手机没在用」
    if (busy || !this.owner) { this.ownerIdleAt = 0; clearTimeout(this.handoverTimer); return; }
    if (!this.ownerIdleAt) this.ownerIdleAt = Date.now();
    clearTimeout(this.handoverTimer);
    this.handoverTimer = setTimeout(() => this.handover(), Math.max(0, this.ownerIdleAt + OWNER_IDLE_MS - Date.now()));
  }

  // 换给正在看这个标签的设备 (最近开始看的)
  handover() {
    if (this.ownerBusy()) return;
    let next = null;
    for (const c of this.clients) {
      if (c !== this.owner && c.watching && !c.idle && c.size && (!next || (c.watchAt || 0) > (next.watchAt || 0))) next = c;
    }
    if (!next) return; // 没人在看：等有人看 / 打开时再换
    this.setOwner(next);
    this.applySize(next.size.cols, next.size.rows);
  }

  // mine：是不是这台在用；busy：使用者还在用 (不然锁住的一端会自动接管)；online：使用者的页面还连着；
  // cols / rows：终端现在的尺寸 (锁住的一端按它镜像显示)
  ownerMsg(ws) {
    const o = this.owner;
    return { type: 'owner', mine: o === ws, device: o?.device || '', online: !o || this.clients.has(o), busy: this.ownerBusy(), cols: this.cols, rows: this.rows };
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
