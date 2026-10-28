'use strict';
/**
 * 后台会话：SSH 连接由服务端持有，浏览器只是「挂载」上来查看和操作。
 * 关闭浏览器 / 断网后会话继续在后台运行；重新打开时用无界面终端 (@xterm/headless) 的序列化结果还原画面。
 *
 * 这个文件是核心 (挂载 / 输出转发 / 流控 / 主机状态 / 通知)，其余按职责拆在同目录下，方法都挂到 Session 上：
 *   input.js  —— 写入按键 / 文字 (输入栏发送时回车等回显)
 *   size.js   —— 终端尺寸听正在用的设备
 *   ssh.js    —— 建立 / 断开 SSH 连接 (直连 / Cloudflare 隧道、指纹校验、验证码)
 *   remote.js —— 在目标主机上测延迟、抓 tmux 历史
 *   daemon.js —— 常驻会话 (Windows) (sshwebd)
 */
const crypto = require('crypto');
const { Terminal: HeadlessTerminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { useCellWidth } = require('../../public/cellwidth');
const CliInput = require('../cli-input');
const { StatusTracker } = require('../status');
const { SCROLLBACK, DAEMON_AUTO_RECONNECT } = require('../config');
const { clampSize } = require('./util');
const { saveTabName, saveDaemonInfo } = require('../store');
const { hostKey } = require('./hooks');

// 终端输出流控: 几毫秒内的零碎输出合并成一帧发送；
// 浏览器积压超过 HIGH (网速慢 + 大量输出) 时暂停读取 SSH，降到 LOW 以下再继续，避免数据堆在服务端内存
const OUTPUT_FLUSH_MS = 4;
const WS_HIGH = 1024 * 1024;
const WS_LOW = 256 * 1024;
const TERM_HIGH = 4 * 1024 * 1024; // 无界面终端来不及解析的数据上限
const STUCK_MS = 15000; // 积压一直不减少 (网络已断但还没检测到)，断开这个浏览器，它会自动重连并拿到最新画面
// 每个会话保留最近这么多原始输出：浏览器断线重连时只补发断开期间的输出，不用重发整个画面快照
const REPLAY_MAX = 1024 * 1024;
const REPLAY_SMALL = 64 * 1024; // 补发量小于此值直接补发，不再序列化快照比较大小

// 所有后台会话 id -> Session；SFTP / 监控复用已连接会话的 SSH 连接
const sessions = new Map();
// 最近关掉的会话 id：别的设备断线期间 (手机锁屏) 标签被关掉了，它重连时告诉它「已关闭」，直接关掉标签，
// 不显示「后台会话已不存在 (服务可能重启过)」+「重新连接」(点了会把别人关掉的会话又开起来)
const closedIds = new Set();
const CLOSED_MAX = 500;
// 完成通知 (Web Push)，启动时由 server.js 设置 (见 lib/push.js)
let push = { send: async () => {} };
const setPush = (p) => { push = p; };

class Session {
  constructor(cfg, meta) {
    this.id = crypto.randomUUID();
    this.cfg = cfg; // 含凭据，只保存在内存中，用于重新连接
    this.title = String(meta.title || `${cfg.username}@${cfg.host}`).slice(0, 100);
    this.n = Math.min(Math.max(parseInt(meta.n, 10) || 1, 1), 999); // 标签序号
    this.suffix = typeof meta.suffix === 'string' && meta.suffix.trim() ? meta.suffix.replace(/\s+/g, ' ').trim().slice(0, 100) : ''; // 「主机名-」后面自定义显示的部分 (见 rename)
    this.renamed = !!this.suffix; // 改过名：恢复常驻会话 / 继续对话时不再自动覆盖
    // 网页带着刚改、还没送到的名字连上 (服务重启期间改的名等，清掉的也算)：接上常驻会话时记到会话上 (见 daemon.js)。
    // 只是恢复标签带着的名字不记：那可能是以前还原出来的旧名字，记了会盖掉别处后来改的
    this.nameUnsaved = !!meta.suffixNew;
    // 现在显示的名字是什么时候命的 (0 = 不知道：恢复的标签带着的)。恢复会话时和记着的比，谁新用谁 (见 newestName)
    this.nameAt = meta.suffixNew ? Date.now() : 0;
    this.histHost = String(meta.histHost || '').slice(0, 300);
    this.hostId = meta.hostId || null;
    this.daemonId = typeof meta.daemonId === 'string' ? meta.daemonId.slice(0, 64) : null; // 接着的常驻会话 (见 daemon.js)；服务重启后标签照原样接回去
    this.daemonOff = null; // 常驻会话的输出收到第几个字节了
    this.daemonCreated = Number(meta.daemonAt) || 0; // 常驻会话的创建时间 (会话号会重复用，按它认是不是原来那个)
    this.clientIp = meta.clientIp;
    this.cols = clampSize(meta.cols, 80);
    this.rows = clampSize(meta.rows, 24);
    this.created = Date.now();
    this.detachedAt = Date.now();
    this.order = Date.now();
    this.status = 'closed';
    this.clients = new Set();
    this.term = new HeadlessTerminal({ cols: this.cols, rows: this.rows, scrollback: SCROLLBACK, allowProposedApi: true });
    useCellWidth(this.term); // 和网页里的终端按同一份规则算字宽，快照 / 历史才对得上
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
    this.ssh = this.stream = this.tunnel = null;
    this.pending = null;
    this.timer = null;
    this.sftpPromise = null;
    this.monPrev = null;
    this.attempt = 0;
    this.lastAlert = 0;
    this.flushTimer = null;
    this.flowTimer = null; // 暂停读取 SSH 期间轮询积压
    this.termPending = 0;
    this.outBytes = 0; // 累计输出字节数，浏览器用它告诉服务端自己收到了哪里
    this.replay = []; // 最近的输出块
    this.replayLen = 0;
    // 主机状态 (运行中 / 完成 / 待选择 / 报错 / 空闲)，见 lib/status.js
    this.tracker = new StatusTracker();
    this.cli = CliInput.create(); // 终端输入框里的内容 (所有设备的输入都算)，网页据此决定点终端时光标去哪
    this.state = { label: '空闲', cls: 'idle' };
    this.hook = null; // Claude Code 钩子报来的状态 (见 hooks.js)，比看屏幕准
    this.hookSeq = 0; // 每次要确认 / 问问题加一：通知上的「允许 / 拒绝」要对得上是哪一次
    this.hookSeenAt = 0; // 最近一次收到钩子事件 (收到过就只按钩子推送，见 usingHooks)
    this.hookTask = ''; // 最近一次让 Agent 做的事 (状态卡片上的「在做：…」)
    this.stateTimer = null;
    this.statePushAt = 0;
    // 通知 (标签上的 🔔)：seq 第几条新通知，ack 看过了第几条 (任何设备正在看这个标签就算看过，见 ackNotice)。
    // 只有两种算一条：Agent 的状态变成完成 / 待选择 / 报错 (同推送)；终端提示音，而且上一条之后在这个标签里按过回车
    // (命令跑完了)。看过以后什么都没发生又响的提示音 (Claude Code 做完一阵子没人理会再提醒一次) 不算
    this.notice = { seq: 0, ack: 0 };
    this.noticeAt = 0;
    this.noticeFrom = '';
    this.sentAt = 0; // 最近一次在这个标签里按回车 (发命令 / 发消息，见 input.js)
    // 提示音 / 通知序列 → 完成通知 (Claude Code、printf '\a' 等)
    this.term.onBell(() => this.alert('终端提示音'));
    this.term.parser.registerOscHandler(9, (d) => {
      if (d.startsWith('9;')) this.termCwd = d.slice(2).replace(/^"|"$/g, ''); // OSC 9;9：shell 报的当前目录 (Windows Terminal 的写法)
      else if (!/^\d+;/.test(d)) this.alert(d); // OSC 9;4;… 是进度条，不是通知
      return true;
    });
    // OSC 7 file://主机/路径：shell 报的当前目录 (Windows 的 /D:/x 写成 D:\x)
    this.term.parser.registerOscHandler(7, (d) => {
      try {
        const p = decodeURIComponent(new URL(d).pathname);
        this.termCwd = /^\/[A-Za-z]:/.test(p) ? p.slice(1).replace(/\//g, '\\') : p;
      } catch {}
      return true;
    });
    this.term.parser.registerOscHandler(777, (d) => {
      const [kind, title, ...body] = d.split(';');
      if (kind === 'notify') this.alert(body.join(';') || title, body.length ? title : '');
      return true;
    });
  }

  // 有设备的网页在前台 (没最小化、浏览器是当前窗口) 时不推送；同一会话 10 秒内最多推送一次；
  // 2 分钟内已经按主机状态推送过 (完成 / 待选择 / 报错) 就不再重复推送提示音；
  // 这台主机装了钩子 / 这个标签收到过钩子事件 (见 hooks.js)：只按钩子推送，提示音不再推 (Claude Code 做完 / 要权限时也会响铃，不然推两次)
  alert(message, title) {
    const now = Date.now();
    // 提示音算不算一条新通知：上一条之后按过回车才算 (命令跑完了)；否则是同一件事的提醒，不挂铃铛
    if (this.sentAt > this.noticeAt) this.newNotice(now, 'bell', message);
    this.tracker.onBell(now);
    this.scheduleState();
    if (this.usingHooks()) return;
    // 刚按状态推送过、而且之后还没人操作过：提示音多半是同一件事，不重复推送
    if (now - this.lastAlert < 10000 || (now - this.statePushAt < 120000 && this.tracker.dataAt < this.statePushAt)) return;
    if (this.someoneFront()) return;
    this.lastAlert = now;
    const name = this.tabName();
    push.send({
      title: title ? `${name} · ${title}` : name,
      body: String(message || '终端提示音').slice(0, 200),
      tag: this.id,
      sessionId: this.id,
    }).catch(() => {});
  }

  // 输出 / 输入之后稍等一下再判断 (无界面终端解析是异步的)，另外每秒整体判断一次 (见下面的定时器)
  scheduleState() {
    if (!this.stateTimer) this.stateTimer = setTimeout(() => { this.stateTimer = null; this.updateState(); }, 300);
  }

  updateState() {
    if (this.status !== 'connected') return;
    const now = Date.now();
    const st = this.hookState(now) || this.tracker.evaluate(this.term, now); // 装了 Claude Code 钩子：以钩子为准 (见 hooks.js)
    const detail = st.detail || '';
    if (st.label === this.state.label && st.seq === this.state.seq) {
      // 状态没变，只是「在做什么」变了 (又用了个工具)：更新显示，不推送
      if (detail !== (this.state.detail || '')) { this.state = st; this.broadcast({ type: 'state', label: st.label, cls: st.cls, detail }); }
      return;
    }
    const prev = this.state;
    this.state = st;
    this.broadcast({ type: 'state', label: st.label, cls: st.cls, detail });
    // 事情已经处理掉了：Agent 接着干活了、从「完成」「待选择」变成别的 (在别的设备上看过 / 回答过)，之前的通知算看过
    if (st.cls === 'run' || ((prev.cls === 'done' || prev.cls === 'bad') && st.cls !== prev.cls)) this.ackNotice();
    // 推送：刚进入待选择 / 报错；或者 Claude Code 从运行中变成完成 (why 只有这几种情况才有)。
    // 用钩子推送的标签只推钩子给的状态，看屏幕判断出来的只显示不推 (同上面的提示音)
    if (st.why && (st.cls === 'bad' || prev.cls === 'run') && (st.hook || !this.usingHooks())) {
      // 刚因为提示音记过一条：同一件事 (Claude Code 做完 / 要权限时提示音和钩子各来一次)
      if (!(this.noticeFrom === 'bell' && now - this.noticeAt < 3000)) this.newNotice(now, 'state', `${st.label}：${st.why}`);
      this.notifyState(st);
    }
  }

  // 一条新通知：有设备正在看这个标签就直接算看过 (不挂铃铛)。日志里记下原因，铃铛不对时 docker logs 能查
  newNotice(now, from, why) {
    this.notice.seq++;
    this.noticeAt = now;
    this.noticeFrom = from;
    const seen = [...this.clients].some((ws) => ws.watching);
    if (seen) this.notice.ack = this.notice.seq;
    console.log(`[${new Date(now).toISOString()}] 通知 ${this.tabName()} #${this.notice.seq} ${from === 'bell' ? '提示音' : '状态'}：${String(why || '').slice(0, 80)}${seen ? ' (正在看，不挂铃铛)' : ''}`);
    this.broadcast({ type: 'notice', ...this.notice });
  }

  // 有设备看了这个标签 (切过去 / 回到前台 / 点开通知)：之前的通知都算看过，所有设备的铃铛一起去掉
  ackNotice() {
    if (this.notice.ack >= this.notice.seq) return;
    this.notice.ack = this.notice.seq;
    this.broadcast({ type: 'notice', ...this.notice });
  }

  // 有设备的网页正在前台 (看得到右上角的主机状态)：不用推送；老版本网页没有 front，按正在看这个标签算
  someoneFront() {
    return [...this.clients].some((ws) => (ws.front ?? ws.watching));
  }

  // Claude Code 要权限 (钩子报的)：通知上带「允许 / 拒绝」(安卓 Chrome 支持，点了见 answerPerm)
  notifyState(st) {
    const now = Date.now();
    if (this.someoneFront()) return;
    // 同一种状态 10 秒内只推一次；换了状态 (刚要过权限、接着做完了) 和新的一次确认 / 提问照推
    if (now - this.lastAlert < 10000 && st.label === this.lastPushLabel && !st.seq) return;
    this.lastAlert = this.statePushAt = now;
    this.lastPushLabel = st.label;
    push.send({
      title: `${this.tabName()} · ${st.label}`, body: st.why, tag: this.id, sessionId: this.id,
      ...(st.perm && { seq: st.seq, actions: [{ action: 'allow', title: '允许' }, { action: 'deny', title: '拒绝' }] }),
    }).catch(() => {});
  }

  info() {
    const c = this.cfg;
    return {
      id: this.id, title: this.title, n: this.n, histHost: this.histHost, status: this.status,
      ...(this.suffix && { suffix: this.suffix }),
      connType: c.connType, created: this.created, order: this.order, clients: this.clients.size,
      // 服务器重启后用于重新创建会话 (不含凭据)
      params: {
        ...(this.hostId ? { hostId: this.hostId } : { host: c.rawHost, port: c.port, username: c.username, connType: c.connType, cfClientId: c.cfClientId, winDaemon: !!c.winDaemon }),
        ...(this.daemonId && { daemonId: this.daemonId, ...(this.daemonCreated && { daemonAt: this.daemonCreated }) }),
      },
    };
  }

  // 标签显示的名字：改过是「主机名-自定义」，没改是「主机名-序号」
  tabName() {
    return `${this.title}-${this.suffix || this.n}`;
  }

  // 给标签命名 (网页「⋯ 更多 → 命名标签」)：只改「主机名-」后面显示的部分 (空 = 恢复按序号)，主机名称不动。
  // 所有设备上接着的标签跟着改，刷新 / 重新打开网页也用新名字。
  // 顺手记下来：接着常驻会话的按会话记 (重开主机接上这个会话时还原，见 daemon.js)，
  // 里面 Agent 正在聊的对话按对话记 (会话历史里「继续」时还原，见 agent-sessions.js)。
  // persist=false：只改显示、不记 (继续失败时把名字还回去、别的标签改了同一个会话的名字)。
  // persist='daemon'：接上 / 继续时自动还原记着的名字 —— 只记到这个标签现在接着的常驻会话上 (选择框里显示的跟标签一致)，
  // 对话上的不再记一遍 (名字就是从那儿来的)。at：这个名字是什么时候命的 (还原的是记着的时间)
  rename(suffix, persist = true, at = Date.now()) {
    const t = String(suffix || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    this.nameAt = at;
    if (t !== this.suffix) {
      this.suffix = t;
      this.renamed = !!t;
      this.broadcast({ type: 'renamed', suffix: t });
    }
    if (!persist) return;
    const dKey = this.daemonId && this.daemonCreated ? this.daemonKey(this.daemonId, this.daemonCreated) : '';
    // 还没接上常驻会话 (选会话的弹窗开着、正在重连)：接上时再记到真正接上的那个会话上 (见 daemon.js)
    this.nameUnsaved = !dKey || this.status !== 'connected';
    const sid = this.saveName(t, dKey, persist !== 'daemon', at);
    if (persist !== true) return;
    // 你命的名：同一个常驻会话 / 同一个对话在别的标签里开着的，也马上换成这个名字
    for (const x of sessions.values()) {
      if (x === this || x.status === 'closed') continue;
      const same = (dKey && x.daemonId && x.daemonCreated && x.daemonKey(x.daemonId, x.daemonCreated) === dKey) || (sid && x.hookSid?.id === sid && hostKey(x) === hostKey(this));
      if (same) x.rename(t, false, at);
    }
  }

  // 恢复会话时用哪个名字：现在标签上的、记着的几个 ({ title, at }，没记过是 null) 里最后命的那个。
  // 返回比标签上的新的那条，标签上的最新就返回 null
  newestName(...recs) {
    let best = null;
    for (const r of recs) if (r && r.at > (best ? best.at : this.nameAt)) best = r;
    return best;
  }

  // 把命的名记到常驻会话 (dKey) 和里面 Agent 正在聊的对话上。对话：钩子报过的；标签刚接上常驻会话、Agent 还没再报事件时
  // 用会话记着的 (见 daemon.js 的 daemonAgentSid) —— 以前这时改的名没记到对话上，「继续」时还原成改之前的名字
  // 返回记到的对话 id。清掉 (改回按序号显示) 也记：空名字 + 时间，恢复时不会被更早的名字还原回来
  saveName(t, dKey, conv = true, at = Date.now()) {
    const sid = conv && (this.hookSid?.id || this.daemonAgentSid?.());
    if (dKey) saveDaemonInfo(dKey, { title: t, titleAt: at }); // 常驻会话的信息卡：记命名的后缀 (目录等由 noteDaemonAgent 记)
    if (sid) saveTabName('conv', `${hostKey(this)}|${sid}`, t, at);
    return sid || '';
  }

  // 先发出排队中的终端输出，保证控制消息和输出的先后顺序不变
  sendTo(ws, obj) {
    this.flushWs(ws);
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  broadcast(obj) {
    for (const ws of this.clients) this.sendTo(ws, obj);
  }

  // 终端输出：写入无界面终端 (用于还原) 并转发给所有挂载的浏览器
  output(buf) {
    const len = buf.length;
    this.outAt = Date.now(); // 最近一次有输出 (会话历史「继续」等 Agent 退干净再发命令，见 agent-sessions.js)
    this.outBytes += len;
    this.replay.push(buf);
    this.replayLen += len;
    while (this.replayLen - this.replay[0].length >= REPLAY_MAX) this.replayLen -= this.replay.shift().length;
    this.termPending += len;
    this.term.write(buf, () => { this.termPending -= len; if (this.echoWait && this.writeQueue) this.checkEcho(); });
    // 连接过程中的提示、远端欢迎信息、tmux 首次重画不算「运行中」
    if (this.status === 'connected' && Date.now() - this.connectedAt > 1500) {
      this.tracker.onOutput(Date.now());
      this.scheduleState();
    }
    for (const ws of this.clients) {
      if (ws.lite) continue; // 还没看过的后台标签：不收画面 (见 attach)
      if (ws.syncBuf) ws.syncBuf.push(buf);
      else (ws.outQ ||= []).push(buf);
    }
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), OUTPUT_FLUSH_MS);
    if (!this.flowTimer && this.overHigh()) this.pause();
  }

  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const ws of this.clients) this.flushWs(ws);
  }

  flushWs(ws) {
    const q = ws.outQ;
    if (!q || !q.length) return;
    ws.outQ = null;
    if (ws.readyState === ws.OPEN) ws.send(q.length === 1 ? q[0] : Buffer.concat(q), { binary: true });
  }

  overHigh() {
    if (this.termPending > TERM_HIGH) return true;
    for (const ws of this.clients) if (ws.bufferedAmount > WS_HIGH) return true;
    return false;
  }

  // 暂停读取 SSH (远端程序会被阻塞，和真实终端的流控一样)，积压消化后恢复
  pause() {
    if (!this.stream) return;
    this.stream.pause();
    this.stream.stderr.pause();
    const now = Date.now();
    this.flowTimer = setInterval(() => {
      const t = Date.now();
      let low = this.termPending < TERM_HIGH / 4;
      for (const ws of this.clients) {
        const b = ws.bufferedAmount;
        if (b <= WS_LOW) continue;
        if (ws.lastBuf === undefined || b < ws.lastBuf) ws.lastProgress = t;
        ws.lastBuf = b;
        if (t - (ws.lastProgress || now) > STUCK_MS) {
          ws.terminate(); // close 事件里会 detach
          continue;
        }
        low = false;
      }
      if (low) this.resume();
    }, 50);
  }

  resume() {
    clearInterval(this.flowTimer);
    this.flowTimer = null;
    for (const ws of this.clients) ws.lastBuf = ws.lastProgress = undefined;
    if (this.stream) {
      this.stream.resume();
      this.stream.stderr.resume();
    }
  }

  line(text) {
    this.output(Buffer.from(text + '\r\n'));
  }

  // 从第 from 字节到当前的输出；已经不在保留范围内返回 null
  since(from) {
    if (!Number.isSafeInteger(from) || from > this.outBytes || from < this.outBytes - this.replayLen) return null;
    let skip = from - (this.outBytes - this.replayLen);
    const parts = [];
    for (const b of this.replay) {
      if (skip >= b.length) { skip -= b.length; continue; }
      parts.push(skip ? b.subarray(skip) : b);
      skip = 0;
    }
    return Buffer.concat(parts);
  }

  // from: 浏览器已收到的字节数 (断线重连时)，能补发就只补发缺的部分，否则发整个画面快照。
  // lite：打开页面时在后台、还没看过的标签 —— 先只发状态 (主机状态、提示音、谁在用…)，不发画面和之后的输出，
  // 切过去时网页再要 (sync，见 sendScreen)。以前打开页面每个标签都马上收一份快照 (最多 5000 行)，标签多时又慢又费流量
  attach(ws, from, lite = false) {
    this.clients.add(ws);
    ws.session = this;
    this.probeSsh(); // 网页刚挂上来 (断网后重连、刷新)：看一眼 SSH 还通不通，不通就别显示一个看着恢复了、其实连不上的终端
    // 常驻会话断着、也没在等下一轮重试 (自动重试用完了)：用户回来打开了，立即再试一次，连不上右下角再点按钮
    if (this.status === 'closed' && this.daemonId && !this.autoReTimer && DAEMON_AUTO_RECONNECT) this.autoReconnect(0);
    // 挂上来时还在连接中 (弹窗选会话、正在连)：连上以后再探测一次 —— 网络半开时连接看着建立成功了、
    // 其实已经死了，没人再查它就一直挂着 (画面停住、打字没反应，也没有按钮，只能刷新页面)
    if (this.status !== 'connected' && !this.probeWhenUp) {
      this.probeWhenUp = setInterval(() => {
        if (this.status === 'connected') { this.stopProbeWhenUp(); this.probeSsh(); }
        else if (this.status === 'closed' || !this.clients.size) this.stopProbeWhenUp();
      }, 5000);
      this.probeWhenUp.unref?.();
    }
    this.sendTo(ws, { type: 'attached', session: this.info() });
    if (lite) {
      ws.lite = true;
      this.sendMeta(ws);
      return;
    }
    this.sendScreen(ws, from, true);
  }

  // 发画面：能补发就只补发缺的部分 (from 之后的输出)，否则发快照；meta：接着发状态 (刚挂上来时)
  sendScreen(ws, from, meta = false) {
    ws.lite = false;
    // 先缓存这期间的新输出，等快照发出后再补发，保证不丢不重
    ws.syncBuf = [];
    const offset = this.outBytes;
    const delta = from === undefined ? null : this.since(from);
    this.term.write('', () => {
      const snap = delta && delta.length <= REPLAY_SMALL ? null : this.serializer.serialize() + this.extraModes();
      if (delta && (snap === null || delta.length < Buffer.byteLength(snap))) {
        this.sendTo(ws, { type: 'resume', bytes: delta.length });
        if (delta.length && ws.readyState === ws.OPEN) ws.send(delta, { binary: true });
      } else {
        this.sendTo(ws, { type: 'snapshot', data: snap, offset });
      }
      const buf = ws.syncBuf || [];
      ws.syncBuf = null;
      for (const b of buf) if (ws.readyState === ws.OPEN) ws.send(b, { binary: true });
      if (meta) this.sendMeta(ws);
    });
  }

  // 状态：连接状态、延迟、主机状态、终端输入框内容、谁在用、等着回答的问题
  sendMeta(ws) {
    this.sendTo(ws, { type: 'status', status: this.status, sid: this.status === 'connected' ? this.id : null });
    if (this.sshRtt !== undefined) this.sendTo(ws, { type: 'lat', ssh: this.sshRtt });
    this.sendTo(ws, { type: 'state', label: this.state.label, cls: this.state.cls, detail: this.state.detail || '' });
    this.sendTo(ws, { type: 'notice', ...this.notice });
    this.sendTo(ws, { type: 'cli', ...this.cli.get() });
    if (this.owner) this.sendTo(ws, this.ownerMsg(ws));
    if (this.pending) this.sendTo(ws, { type: this.pending.type, ...this.pending.payload });
    if (this.winPty) this.sendTo(ws, { type: 'winpty', on: true });
  }

  // SerializeAddon 不保存鼠标编码 (SGR 等) 和光标隐藏状态，这里补上：
  // 否则恢复后 tmux / Claude Code 的滚轮事件会用旧编码发送，程序收不到
  extraModes() {
    let out = '';
    try {
      const core = this.term._core;
      const enc = { SGR: '\x1b[?1006h', SGR_PIXELS: '\x1b[?1016h', URXVT: '\x1b[?1015h', UTF8: '\x1b[?1005h' };
      out += enc[core.coreMouseService.activeEncoding] || '';
      if (core.coreService.isCursorHidden) out += '\x1b[?25l';
    } catch {}
    return out;
  }

  detach(ws) {
    if (!this.clients.delete(ws)) return;
    if (!this.clients.size) this.detachedAt = Date.now();
    // 使用者关掉页面 / 断线了：还是它 (见 size.js)，其他设备上弹窗改成「xx 已断开」，点了才接管
    if (this.owner === ws) this.sendOwner();
  }

  // Windows 主机 (SSH 默认的 shell 是 cmd / PowerShell)：终端在 Windows 那边隔着 ConPTY，缩放时 ConPTY 自己重排、整屏重画，
  // 浏览器里的终端再按自己的方式重新折行就对不上 (文字错乱，再缩放一次才好)。开 xterm 的 windowsPty：不自己重新折行、
  // 行数变多时按 ConPTY 的习惯处理 (VS Code 连 Windows 终端也是这样)；服务端的后台终端和浏览器都开
  async detectWinPty() {
    const ssh = this.ssh;
    if (!ssh || this.winPty) return;
    const base = await this.shellBase(ssh).catch(() => 'sh');
    if (base === 'sh' || this.ssh !== ssh) return;
    this.winPty = true;
    try { this.term.options.windowsPty = { backend: 'conpty' }; } catch {}
    this.broadcast({ type: 'winpty', on: true });
  }

  setStatus(status) {
    this.status = status;
    if (status === 'connected') { this.autoRe = 0; clearTimeout(this.autoReTimer); }
    if (status === 'connected') { this.connectedAt = Date.now(); this.tracker = new StatusTracker(); this.hook = null; this.cli.clear(); this.broadcast({ type: 'cli', ...this.cli.get() }); this.watchHooks(); }
    if (status === 'connected') this.detectWinPty();
    this.broadcast({ type: 'status', status, sid: status === 'connected' ? this.id : null });
  }

  // 用户关闭标签：彻底结束
  terminate() {
    this.status = 'closed';
    clearTimeout(this.autoReTimer);
    this.closeConn();
    sessions.delete(this.id);
    closedIds.add(this.id);
    if (closedIds.size > CLOSED_MAX) closedIds.delete(closedIds.values().next().value);
    this.broadcast({ type: 'terminated' });
    for (const ws of this.clients) ws.session = null;
    this.clients.clear();
    clearTimeout(this.flushTimer);
    // 排着队的回车、等回显的计时：不然到点了还去读已经释放的无界面终端
    clearTimeout(this.queueTimer); clearTimeout(this.echoWait?.timer); clearTimeout(this.cliTimer);
    this.writeQueue = null; this.echoWait = null;
    this.replay = [];
    this.term.dispose();
  }
}

// 其余方法按职责拆在别的文件里，挂到 Session 上
for (const part of [require('./input'), require('./size'), require('./ssh'), require('./remote'), require('./hooks'), require('./daemon')]) {
  for (const name of Object.getOwnPropertyNames(part.prototype)) {
    if (name !== 'constructor') Object.defineProperty(Session.prototype, name, Object.getOwnPropertyDescriptor(part.prototype, name));
  }
}

// 已连接的会话 (SFTP / 监控 / tmux 鼠标借用它的 SSH 连接)；没连上返回 null
const liveSession = (sid) => {
  const s = sessions.get(sid);
  return s && s.status === 'connected' && s.ssh ? s : null;
};

module.exports = { Session, sessions, closedIds, liveSession, setPush };
