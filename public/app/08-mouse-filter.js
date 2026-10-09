  // ------------------------------------------------------------ 终端里的鼠标点击 (tmux 开着鼠标时)
  // tmux 开着鼠标时，点击终端的鼠标上报原样交给 tmux，由 tmux 判断单击 / 拖动 / 双击，两种会误判：
  //  - 点击时手抖：按下到松开之间鼠标哪怕只挪过一个字符格的边界，也被当成拖动 —— 进复制模式选中一两个字、
  //    松开就复制 (覆盖剪贴板里原来的内容，右下角闪一下「回到实时画面」)。
  //    加拖动阈值 (同系统的拖动判定)：按住左键后挪动不到 DRAG_PX 不上报移动，tmux 看到的就是单击
  //  - 连点两下 (比如想点一下输入框多点了一下)：tmux 当成双击，选中一个词并复制 (同样覆盖剪贴板)。
  //    实时画面里不要双击选词：和上一次交给 tmux 的按下间隔不到 DBL_MS 的这一下 (按下 / 松开) 不上报，
  //    tmux 只看到单击 (它判定双击是 300ms，多留余量防网络抖动把两下挤到一起)。想选字就拖动，
  //    或者滚轮往上翻开历史界面 (那里双击选词、三击选行照常能用)。扣下的这一下要是拖动起来了，补发按下照常拖动
  const DRAG_PX = 5;
  const DBL_MS = 500;
  let mousePress = null; // 左键按在终端里：{ x, y, moved, swallow (这一下不交给 tmux), held (扣下的按下上报) }
  let lastPressAt = 0;   // 上一次交给 tmux 的左键按下
  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !e.target.closest?.('.term-box')) { mousePress = null; return; }
    const now = Date.now();
    mousePress = { x: e.clientX, y: e.clientY, moved: false, swallow: now - lastPressAt < DBL_MS, held: '' };
    if (!mousePress.swallow) lastPressAt = now;
  }, true);
  // 捕获阶段：xterm 在自己的 mousemove 里同步发出上报，这里要先把「挪够了没有」算好
  window.addEventListener('mousemove', (e) => {
    if (mousePress && !mousePress.moved && Math.hypot(e.clientX - mousePress.x, e.clientY - mousePress.y) >= DRAG_PX) mousePress.moved = true;
  }, true);
  window.addEventListener('mouseup', (e) => {
    if (e.button !== 0 || !mousePress) return;
    if (mousePress.moved) dragEndAt = Date.now();
    // xterm 在后面的监听里才发出松开上报：等这次事件处理完再清掉，松开上报还要按这一下的情况过滤
    const p = mousePress;
    setTimeout(() => { if (mousePress === p) mousePress = null; });
  }, true);
  // 正在终端里拖动选字 (或刚松开：tmux 复制完退出复制模式要一个来回)。tmux 开鼠标时选字是靠进复制模式实现的，
  // 这时不算「在看历史」，不显示「回到实时画面」(见 updateCopyModeBtn)
  let dragEndAt = 0;
  const selectingText = () => !!mousePress?.moved || Date.now() - dragEndAt < 1500;

  // 鼠标上报 → { cb: 按键值, up: 是不是松开 }；不是鼠标上报返回 null。
  // SGR 编码 ESC[<按键;列;行M (松开是 m)；旧式编码 (X10 等，走 onBinary) ESC [ M 后面三个字节，第一个是 32 + 按键值 (按键值 3 = 松开)
  function parseMouse(data, binary) {
    if (binary) {
      if (data.length !== 6 || !data.startsWith('\x1b[M')) return null;
      const cb = data.charCodeAt(3) - 32;
      return { cb, up: (cb & 3) === 3 && !(cb & 32) };
    }
    const m = /^\x1b\[<(\d+);\d+;\d+([Mm])$/.exec(data);
    return m ? { cb: +m[1], up: m[2] === 'm' } : null;
  }
  // 过滤这一次鼠标上报：返回要发出去的内容，空串 = 不发 (见上面 DRAG_PX / DBL_MS)
  function filterMouse(data, binary = false) {
    const p = mousePress;
    if (!p) return data;
    const m = parseMouse(data, binary);
    if (!m || (m.cb & 64)) return data;                 // 不是鼠标上报，或者是滚轮
    if (m.cb & 32) {                                     // 按住移动
      if ((m.cb & 3) !== 0) return data;                 // 不是左键
      if (!p.moved) return '';                           // 手抖
      if (p.held) { const h = p.held; p.held = ''; p.swallow = false; lastPressAt = Date.now(); return h + data; } // 扣下的这一下拖动起来了
      return p.swallow ? '' : data;
    }
    if (m.up) return p.swallow ? '' : data;              // 松开
    if ((m.cb & 3) !== 0) return data;                   // 按下的不是左键
    if (p.swallow) { p.held = data; return ''; }         // 连点的第二下：先扣着
    return data;
  }
