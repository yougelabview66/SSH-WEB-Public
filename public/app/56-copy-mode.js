  // ------------------------------------------------------------ 回到实时画面 (tmux 复制模式 / Claude Code 全屏模式往上翻着)
  // 用不了本地滚动时滚轮交给 tmux，进入 tmux 自己的复制模式 (pane 右上角有 [5/300] 这样的位置标记，
  // 第一个数是离最底下几行)：同样显示「回到实时画面」，点了发 q 退出复制模式。
  // 返回离最底下的行数，不在复制模式返回 -1
  function tmuxCopyOffset(s) {
    const b = s.term.buffer.active;
    if (b.type !== 'alternate' || s.scrollView) return -1;
    const m = /\[(\d+)\/\d+\]\s*$/.exec(b.getLine(b.viewportY)?.translateToString(true) || '');
    return m ? +m[1] : -1;
  }
  // 在复制模式里 (不管停在哪)：发送前要先退出，不然发的字被复制模式吃掉 (见 leaveTmuxCopyMode)
  const tmuxInCopyMode = (s) => tmuxCopyOffset(s) >= 0;
  // 在看历史 (显示「回到实时画面」)：tmux 开鼠标时拖动选字也是进复制模式实现的 (松开就复制并退出)，
  // 停在当前画面、位置是 [0/N] —— 那是在选字不是在看历史，不显示 (以前选字时这个按钮会闪一下)。
  // 只看位置不够：滚轮刚滚第一格 (只进复制模式还没滚)、Ctrl+B [ 手动进的也是 [0/N]，所以 [0/N] 时看是不是正在拖动选字
  function tmuxScrolledUp(s) {
    const off = tmuxCopyOffset(s);
    return off > 0 || (off === 0 && !selectingText());
  }
  // Claude Code 全屏模式 (/tui fullscreen) 自己接管滚轮，往上翻时输入框上方显示
  // 「Jump to bottom (ctrl+end) ↓」/「3 new messages (ctrl+end) ↓」：同样显示「回到实时画面」，点了发 Ctrl+End
  const CC_PILL = /(^|\s)(Jump to bottom|\d+ new messages?)(( \([^)]*\))? ↓|: \S.{0,24} to scroll)(\s|$)/;
  function claudeScrolledUp(s) {
    const b = s.term.buffer.active;
    if (b.type !== 'alternate' || s.scrollView) return false;
    for (let y = b.viewportY + s.term.rows - 1; y >= b.viewportY; y--) { // 提示在下半部分，从下往上找
      if (CC_PILL.test(b.getLine(y)?.translateToString(true) || '')) return true;
    }
    return false;
  }
  const EXIT_KEYS = { tmux: ['q', '退出 tmux 复制模式 (发送 q)'], claude: ['\x1b[1;5F', '回到 Claude Code 最新的对话 (发送 Ctrl+End)'] };
  function updateCopyModeBtn(s) {
    const mode = !s.sid ? null : tmuxScrolledUp(s) ? 'tmux' : claudeScrolledUp(s) ? 'claude' : null;
    if (mode && !s.copyBtn) {
      s.copyBtn = document.createElement('button');
      s.copyBtn.className = 'ls-close tmux-exit';
      s.copyBtn.textContent = '回到实时画面 ✕';
      s.copyBtn.addEventListener('mousedown', (e) => e.preventDefault());
      s.copyBtn.addEventListener('click', () => {
        const mode = s.copyBtn.dataset.mode;
        send(s, { type: 'data', data: EXIT_KEYS[mode][0], tmux: mode === 'tmux' }); // q 是给 tmux 的，不算打进输入框的字
        focusTerm(s);
      });
      s.box.appendChild(s.copyBtn);
    }
    if (!s.copyBtn) return;
    if (mode && (s.copyBtn.classList.contains('hidden') || !s.copyBtn.style.height)) fitExitBtn(s.copyBtn);
    s.copyBtn.classList.toggle('hidden', !mode);
    if (mode && s.copyBtn.dataset.mode !== mode) { s.copyBtn.dataset.mode = mode; s.copyBtn.title = EXIT_KEYS[mode][1]; }
  }
  setInterval(() => { if (active && !document.hidden) updateCopyModeBtn(active); }, 300); // 页面在后台不跑 (手机省电)
