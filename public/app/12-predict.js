  // ------------------------------------------------------------ 打字预测回显 (类似 mosh)
  // 网络慢时，在终端里打的字先在本地画出来 (带下划线 = 还没确认)，服务器回显到了且一致就换成真实的字，不一致马上撤掉。
  //  - 每行第一个字先「探测」：不显示，等服务器真的回显，确认程序会显示打的字、并找到真正的输入位置
  //    (普通 shell 就在终端光标处；Claude Code 这类自己画光标的程序，对比回显前后的屏幕找新出现这个字的格子)。
  //    输密码时服务器不回显，探测永远不成功，所以密码永远不会被显示出来
  //  - 只在行尾打字时预测；方向键 / 回车等会移动光标的键清掉预测；猜错了撤掉并暂停 5 秒
  //  - 自动模式：网页 + SSH 往返 >= 60ms 才预测
  const PRED_MIN_RTT = 60;
  let predMode = (() => { try { return localStorage.getItem('sshweb.predict') || 'auto'; } catch { return 'auto'; } })();
  const predOn = (s) => predMode === 'on' || (predMode === 'auto' && (s.rtt || 0) + (s.sshRtt || 0) >= PRED_MIN_RTT);
  const WIDE_RE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\ud800-\udbff]/;
  const charWidth = (ch) => (WIDE_RE.test(ch) ? 2 : 1);
  const predLimit = (s) => Math.max(400, 2.5 * ((s.rtt || 0) + (s.sshRtt || 0))); // 超过这么久还没回显 = 猜错了

  // list：已经预测、等待确认的字；next：下一个字的位置；sure：这一行已经确认过；probe：正在探测的第一个字
  const predState = (s) => (s.pred ||= { list: [], next: null, sure: false, probe: null, pauseUntil: 0, layer: null, cursor: null, timer: 0 });

  const cellText = (s, x, y) => {
    const b = s.term.buffer.active;
    return b.getLine(b.baseY + y)?.getCell(x)?.getChars() || '';
  };

  function snapScreen(s) {
    const b = s.term.buffer.active, rows = [];
    for (let y = 0; y < s.term.rows; y++) {
      const line = b.getLine(b.baseY + y), row = [];
      for (let x = 0; x < s.term.cols; x++) row.push(line?.getCell(x)?.getChars() || '');
      rows.push(row);
    }
    return rows;
  }

  // 探测的字回显到了哪里：先看终端光标处，再找屏幕上新出现这个字的格子 (只有一个才算，找到多个不确定就放弃)
  function findProbe(s, pr) {
    if (cellText(s, pr.guess.x, pr.guess.y) === pr.ch && pr.snap[pr.guess.y]?.[pr.guess.x] !== pr.ch) return pr.guess;
    const b = s.term.buffer.active;
    let found = null;
    for (let y = 0; y < s.term.rows; y++) {
      const line = b.getLine(b.baseY + y);
      for (let x = 0; x < s.term.cols; x++) {
        if (line?.getCell(x)?.getChars() === pr.ch && pr.snap[y]?.[x] !== pr.ch) {
          if (found) return null;
          found = { x, y };
        }
      }
    }
    return found;
  }

  function cellGeom(s) {
    const screen = s.box.querySelector('.xterm-screen');
    if (!screen) return null;
    const r = screen.getBoundingClientRect(), br = s.box.getBoundingClientRect();
    return { w: r.width / s.term.cols, h: r.height / s.term.rows, left: r.left - br.left, top: r.top - br.top };
  }

  function predClear(s, pause) {
    const p = predState(s);
    for (const x of p.list) x.el?.remove();
    p.list = [];
    p.probe = null;
    p.cursor?.remove();
    p.cursor = null;
    clearTimeout(p.timer);
    if (pause) { p.sure = false; p.next = null; p.pauseUntil = Date.now() + 5000; }
  }

  // 在 send() 里调用：所有发往终端的输入都经过这里
  function predictInput(s, data) {
    const p = predState(s);
    const b = s.term.buffer.active;
    // 回车：这一行结束，下一行的第一个字重新探测
    if (/[\r\n]/.test(data)) { p.sure = false; p.next = null; p.probe = null; return; }
    if (data === '\x7f' || data === '\b') {
      const last = p.list[p.list.length - 1];
      if (last) { // 撤销还没确认的预测
        last.el?.remove();
        p.list.pop();
        p.next = { x: last.x, y: last.y };
      } else if (p.sure && p.next && p.next.x > 0) { // 已确认的字：输入位置往回退一个字
        const line = b.getLine(b.baseY + p.next.y);
        let x = p.next.x - 1;
        if (x > 0 && line?.getCell(x)?.getWidth() === 0) x--;
        p.next = { x, y: p.next.y };
      }
      drawPredCursor(s);
      return;
    }
    // 方向键、Tab、Ctrl 组合、粘贴等：光标可能移动，清掉预测等服务器的画面
    if (/[\x00-\x1f\x7f]/.test(data) || data.length > 16) { predClear(s); p.sure = false; p.next = null; return; }
    if (!predOn(s) || Date.now() < p.pauseUntil || b.viewportY !== b.baseY || s.scrollView) { predClear(s); p.sure = false; p.next = null; return; }

    const chars = [...data];
    if (!p.sure) {
      // 探测中又打的字：记下来，探测成功后一起补上预测
      if (p.probe) { p.probe.after.push(...chars); return; }
      p.probe = { ch: chars[0], w: charWidth(chars[0]), t: Date.now(), snap: snapScreen(s), guess: { x: b.cursorX, y: b.cursorY }, after: chars.slice(1) };
      predSchedule(s);
      return;
    }
    addPreds(s, chars);
    predRender(s);
    predSchedule(s);
  }

  function addPreds(s, chars) {
    const p = predState(s);
    let pos = p.next;
    for (const ch of chars) {
      const w = charWidth(ch);
      // 只在行尾打字时预测：位置要是空的，也不会写到行末
      if (!pos || pos.x + w > s.term.cols - 1 || (cellText(s, pos.x, pos.y).trim() && !p.list.some((q) => q.x === pos.x && q.y === pos.y))) {
        predClear(s);
        p.sure = false;
        p.next = null;
        return;
      }
      p.list.push({ x: pos.x, y: pos.y, ch, w, t: Date.now(), el: null });
      pos = { x: pos.x + w, y: pos.y };
    }
    p.next = pos;
  }

  function predRender(s) {
    const p = predState(s), g = cellGeom(s);
    if (!g) return;
    if (!p.layer) {
      p.layer = document.createElement('div');
      p.layer.className = 'pred-layer';
      s.box.appendChild(p.layer);
    }
    const theme = termTheme();
    for (const x of p.list) {
      if (x.el) continue;
      x.el = document.createElement('span');
      x.el.className = 'pred-ch';
      x.el.textContent = x.ch;
      Object.assign(x.el.style, {
        left: g.left + x.x * g.w + 'px', top: g.top + x.y * g.h + 'px', width: x.w * g.w + 'px', height: g.h + 'px',
        lineHeight: g.h + 'px', fontFamily: s.term.options.fontFamily, fontSize: s.term.options.fontSize + 'px',
        color: theme.foreground, background: theme.background,
      });
      p.layer.appendChild(x.el);
    }
    drawPredCursor(s);
  }

  // 预测的字后面画一个光标 (真正的光标还停在服务器回显前的位置)
  function drawPredCursor(s) {
    const p = predState(s), g = cellGeom(s);
    if (!g || !p.layer || !p.next || !p.list.length) { p.cursor?.remove(); p.cursor = null; return; }
    if (!p.cursor) {
      p.cursor = document.createElement('span');
      p.cursor.className = 'pred-cursor';
      p.layer.appendChild(p.cursor);
    }
    Object.assign(p.cursor.style, {
      left: g.left + p.next.x * g.w + 'px', top: g.top + p.next.y * g.h + 'px', width: g.w + 'px', height: g.h + 'px',
      background: termTheme().cursor,
    });
  }

  // 服务器输出写进终端之后调用：核对探测和预测
  function predCheck(s) {
    const p = s.pred;
    if (!p) return;
    const now = Date.now();
    if (p.probe) {
      const pr = p.probe, at = findProbe(s, pr);
      if (at) {
        p.probe = null;
        p.sure = true;
        p.next = { x: at.x + pr.w, y: at.y };
        if (pr.after.length) { addPreds(s, pr.after); predRender(s); }
      } else if (now - pr.t > predLimit(s)) {
        p.probe = null; // 没有回显 (输密码、快捷键等)：不预测
      }
    }
    while (p.list.length) {
      const x = p.list[0];
      if (cellText(s, x.x, x.y) === x.ch) { // 回显到了，和预测一致：换成真实的字
        x.el?.remove();
        p.list.shift();
        continue;
      }
      if (now - x.t > predLimit(s)) { predClear(s, true); return; } // 猜错了：撤掉，暂停一会儿
      break;
    }
    drawPredCursor(s);
    predSchedule(s);
  }

  function predSchedule(s) {
    const p = predState(s);
    clearTimeout(p.timer);
    if (p.list.length || p.probe) p.timer = setTimeout(() => predCheck(s), 150);
  }

  // 侧边栏：打字预测 自动 / 开 / 关
  function applyPredMode() {
    $('#predSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === predMode));
  }
  $('#predSeg').addEventListener('click', (e) => {
    const mode = e.target.dataset.mode;
    if (!mode) return;
    predMode = mode;
    try { localStorage.setItem('sshweb.predict', mode); } catch {}
    applyPredMode();
    for (const s of sessions) { predClear(s); if (s.pred) { s.pred.sure = false; s.pred.next = null; } }
  });
  applyPredMode();

