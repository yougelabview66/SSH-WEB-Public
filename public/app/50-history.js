  // ------------------------------------------------------------ 历史命令
  // 按回车时记下光标所在行，等回显到达 (光标换行) 后读取这一行，去掉提示符得到命令。
  // 这样 Tab 补全、↑ 调出的历史命令都能正确记录；vim 等全屏程序 (备用缓冲区) 内不记录。
  function histHostLabel(h) {
    return h.connType === 'cloudflare' ? `${h.username}@${h.host}` : `${h.username}@${h.host}:${h.port || 22}`;
  }

  function readLogicalLine(buf, row) {
    let start = row;
    while (start > 0 && buf.getLine(start)?.isWrapped) start--;
    let end = row;
    while (buf.getLine(end + 1)?.isWrapped) end++;
    let text = '';
    for (let i = start; i <= end; i++) text += buf.getLine(i)?.translateToString(i === end) || '';
    return text;
  }

  // 提示符以 $ # % > ❯ 加空格结尾，取第一个提示符之后的内容
  function extractCommand(line) {
    const m = /^.*?[$#%>❯]\s(.*)$/.exec(line || '');
    if (!m) return '';
    if (m[1].startsWith(' ')) return ''; // 以空格开头不记录 (同 bash HISTCONTROL=ignorespace)
    return m[1].trim();
  }

  function beginCapture(s) {
    const b = s.term.buffer.active;
    if (b.type === 'alternate' || !s.sid) return;
    const row = b.baseY + b.cursorY;
    if (s.capture) {
      // 上一次回车没有产生新行 (如 read -s 密码输入)，丢弃；否则先结算
      if (s.capture.row === row) cancelCapture(s);
      else finishCapture(s);
    }
    s.capture = { row, snap: readLogicalLine(b, row) };
    s.capture.timer = setTimeout(() => {
      const bb = s.term.buffer.active;
      if (bb.type !== 'alternate' && bb.baseY + bb.cursorY === row) cancelCapture(s);
      else finishCapture(s);
    }, 3000);
  }

  function cancelCapture(s) {
    if (s.capture) clearTimeout(s.capture.timer);
    s.capture = null;
  }

  // 每次输出写入后调用：光标还在这条命令行 (含自动换行的续行) 上就更新快照，真正换到新行后记录
  function checkCapture(s) {
    const c = s.capture;
    if (!c) return;
    const b = s.term.buffer.active;
    if (b.type === 'alternate') return finishCapture(s);
    const cur = b.baseY + b.cursorY;
    if (cur === c.row || (cur > c.row && b.getLine(cur)?.isWrapped)) {
      c.snap = readLogicalLine(b, c.row);
      return;
    }
    finishCapture(s);
  }

  function finishCapture(s) {
    const c = s.capture;
    if (!c) return;
    s.capture = null;
    clearTimeout(c.timer);
    // 执行 clear 等命令可能清掉这一行，此时用按回车时的快照
    const cmd = extractCommand(readLogicalLine(s.term.buffer.normal, c.row)) || extractCommand(c.snap);
    if (cmd) api('POST', '/api/history', { cmd, host: s.histHost }).catch(() => {});
  }

  const histPanel = $('#history');
  let histItems = [];
  let favItems = [];
  // 记住上次看的选项卡 (这台设备上)：下次打开历史面板还在那里 (比如一直用「💬 会话历史」)
  const HIST_TABS = ['fav', 'hist', 'agents'];
  let histTab = (() => { try { const t = localStorage.getItem('sshweb.histTab'); return HIST_TABS.includes(t) ? t : 'fav'; } catch { return 'fav'; } })();

  const fmtAgo = (t) => {
    const d = (Date.now() - t) / 1000;
    if (d < 60) return '刚刚';
    if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
    if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
    if (d < 86400 * 30) return Math.floor(d / 86400) + ' 天前';
    return new Date(t).toLocaleDateString();
  };

  // 先显示面板 (读到过就先显示上次的)，历史 / 收藏在后台读；「💬 会话历史」选项卡不等它们，马上开始读
  let histLoaded = false, histErr = '', histSeq = 0;
  async function openHistory() {
    if (active) histPanel.dataset.tab = active.id; // 手机上同性能监控 (见 tabPanels)
    histPanel.classList.remove('hidden');
    tabPanels(); // 在别的标签上打开过：面板还带着 tab-away (手机上不显示)，要按现在的标签重新判断
    histAgentsFor = null; // 会话历史每次打开都重新读
    $('#histSearch').value = '';
    $('#favInput').value = '';
    $('#histAll').checked = !active;
    if (isTouch) mInput.blur();
    histErr = '';
    renderHistory();
    if (!isTouch) $('#histSearch').focus();
    const my = ++histSeq;
    try {
      const [h, f] = await Promise.all([api('GET', '/api/history'), api('GET', '/api/favorites')]);
      if (my !== histSeq) return;
      [histItems, favItems] = [h, f];
      histLoaded = true;
    } catch (e) {
      if (my !== histSeq) return;
      histErr = e.message;
    }
    if (!histPanel.classList.contains('hidden') && histTab !== 'agents') renderHistory();
  }

  function closeHistory() {
    histPanel.classList.add('hidden');
    if (active) focusTerm(active);
  }

  const showAll = () => $('#histAll').checked || !active;
  const isFav = (cmd) => favItems.some((f) => f.cmd === cmd);

  function visibleItems() {
    const q = $('#histSearch').value.trim().toLowerCase();
    const all = showAll();
    const match = (cmd) => !q || cmd.toLowerCase().includes(q);
    if (histTab === 'fav') {
      // 收藏: 所有主机通用的 + 当前主机专用的
      return favItems.filter((f) => (all || !f.host || f.host === active.histHost) && match(f.cmd));
    }
    return histItems.filter((h) => (all || h.host === active.histHost) && match(h.cmd));
  }

  // 执行 / 填入到当前终端
  function useCommand(cmd, op) {
    if (!active || !active.sid) return;
    closeHistory();
    if (inputLocked(active)) return; // 别的设备在用 (见 42-owner.js)
    // 执行：回车和命令一起马上发出，服务端等命令显示出来再写回车 (同 submitText)；回显到了会记入历史 (次数 +1、移到最前)
    send(active, { type: 'data', data: cmd, echo: op === 'run' });
    if (op === 'run') { beginCapture(active); send(active, { type: 'data', data: '\r', gap: ENTER_GAP }); }
  }

  async function toggleFav(cmd) {
    const f = favItems.find((x) => x.cmd === cmd);
    if (f) {
      await api('DELETE', '/api/favorites/' + f.id);
      favItems = favItems.filter((x) => x !== f);
    } else {
      favItems.push(await api('POST', '/api/favorites', { cmd, host: '' }));
    }
  }

  // 「💬 会话历史」选项卡：Agent 以前的会话 (部件见 64-agent-sessions.js)，换了标签 / 重新打开面板时重新读
  let histAgentsFor = null;
  function renderAgentsTab() {
    const box = $('#histAgents');
    const on = histTab === 'agents';
    for (const x of ['#histSearch', '#histList', '#favAdd', '#histClear', '.hist-search label.check']) histPanel.querySelector(x).classList.toggle('hidden', on || (x === '#favAdd' && histTab !== 'fav'));
    box.classList.toggle('hidden', !on);
    if (!on) return false;
    if (!active?.sid) { box.innerHTML = '<div class="sftp-msg">先连上一台主机，才能看它上面的会话</div>'; histAgentsFor = null; return true; }
    if (histAgentsFor !== active) {
      histAgentsFor = active;
      box.innerHTML = '';
      box.appendChild(agentSessionsView(active, closeHistory).el);
    }
    return true;
  }

  function renderHistory() {
    histPanel.querySelectorAll('.htabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === histTab));
    if (renderAgentsTab()) return;
    $('#favAdd').classList.toggle('hidden', histTab !== 'fav');
    const list = $('#histList');
    const items = visibleItems();
    const all = showAll();
    const clear = $('#histClear');
    clear.classList.toggle('hidden', histTab !== 'hist');
    clear.textContent = all ? '清空全部' : '清空本主机';
    clear.disabled = !items.length;
    list.innerHTML = '';
    if (!histLoaded) { // 第一次还没读到：读不到就显示原因 (读到过的话读失败了也接着显示上次的)
      clear.disabled = true;
      list.innerHTML = histErr ? `<div class="sftp-msg" style="color:var(--danger)">${esc(histErr)}</div>` : '<div class="sftp-msg">加载中…</div>';
      return;
    }
    if (!items.length) {
      list.innerHTML = histTab === 'fav'
        ? '<div class="sftp-msg">还没有收藏的命令<br><span class="hint">在上面输入框添加，或在「历史」里点 ☆ 收藏</span></div>'
        : '<div class="sftp-msg">暂无历史命令<br><span class="hint">在终端里执行过的命令会记录在这里</span></div>';
      return;
    }
    items.forEach((h) => {
      const fav = histTab === 'fav';
      const row = document.createElement('div');
      row.className = fav ? 'hrow fav' : 'hrow';
      if (fav) row.dataset.id = h.id;
      row.innerHTML = `${fav ? '' : `<button data-op="star" class="star${isFav(h.cmd) ? ' on' : ''}" title="收藏">${isFav(h.cmd) ? '★' : '☆'}</button>`}
        <div class="hmain" title="点击执行"><div class="cmd"></div><div class="hmeta"></div></div>
        <button data-op="fill" title="填入终端，不执行">填入</button>
        <button data-op="run" class="primary" title="执行">执行</button>
        <button data-op="del" class="del" title="${fav ? '取消收藏' : '删除'}">✕</button>`;
      $('.cmd', row).textContent = h.cmd;
      if (fav) {
        // 适用范围: 点击在「所有主机」和「仅当前主机」之间切换
        const scope = document.createElement('button');
        scope.className = 'scope';
        scope.dataset.op = 'scope';
        scope.textContent = h.host ? `仅 ${h.host}` : '所有主机';
        scope.title = '点击切换适用范围';
        $('.hmeta', row).appendChild(scope);
      } else {
        $('.hmeta', row).textContent = [all ? h.host : '', fmtAgo(h.time), h.count > 1 ? `${h.count} 次` : '']
          .filter(Boolean).join(' · ');
      }
      row.addEventListener('click', async (e) => {
        if (Date.now() < favDragUntil) return; // 刚拖动完，不当作点击 (点击会执行命令)
        const op = e.target.dataset.op || (e.target.closest('.hmain') ? 'run' : '');
        try {
          if (op === 'star') { await toggleFav(h.cmd); return renderHistory(); }
          if (op === 'scope') {
            const host = h.host ? '' : (active ? active.histHost : '');
            Object.assign(h, await api('PUT', '/api/favorites/' + h.id, { host }));
            return renderHistory();
          }
          if (op === 'del') {
            if (fav) {
              await api('DELETE', '/api/favorites/' + h.id);
              favItems = favItems.filter((x) => x.id !== h.id);
            } else {
              await api('DELETE', '/api/history/' + h.id);
              histItems = histItems.filter((x) => x.id !== h.id);
            }
            return renderHistory();
          }
        } catch (err) { return alert(err.message); }
        if (op === 'run' || op === 'fill') useCommand(h.cmd, op);
      });
      list.appendChild(row);
    });
  }

  // 收藏拖动排序：电脑按住拖动，手机长按后拖动 (同侧边栏主机)。
  // 列表按主机 / 搜索筛选时，只调整显示出来的这几条的相对顺序，隐藏的收藏留在原位
  const histListEl = $('#histList');
  let favDrag = null;
  let favDragUntil = 0;

  function beginFavDrag() {
    if (!favDrag) return;
    favDrag.started = true;
    favDrag.el.classList.add('dragging');
    histListEl.classList.add('drag-active');
    if (favDrag.touch) navigator.vibrate?.(15);
  }

  function moveFavDrag(y) {
    const el = favDrag.el;
    const prev = el.previousElementSibling;
    const next = el.nextElementSibling;
    const mid = (x) => { const r = x.getBoundingClientRect(); return r.top + r.height / 2; };
    if (prev && y < mid(prev)) histListEl.insertBefore(el, prev);
    else if (next && y > mid(next)) histListEl.insertBefore(el, next.nextSibling);
    const r = histListEl.getBoundingClientRect();
    if (y < r.top + 30) histListEl.scrollTop -= 10;
    else if (y > r.bottom - 30) histListEl.scrollTop += 10;
  }

  async function endFavDrag() {
    if (!favDrag) return;
    clearTimeout(favDrag.timer);
    const d = favDrag;
    favDrag = null;
    if (!d.started) return;
    d.el.classList.remove('dragging');
    histListEl.classList.remove('drag-active');
    favDragUntil = Date.now() + 400;
    const shown = [...histListEl.querySelectorAll('.hrow.fav')].map((x) => x.dataset.id);
    // 显示出来的收藏按新顺序依次填回它们原来占的位置
    const slots = favItems.map((f, i) => (shown.includes(f.id) ? i : -1)).filter((i) => i >= 0);
    const next = favItems.slice();
    slots.forEach((slot, k) => { next[slot] = favItems.find((f) => f.id === shown[k]); });
    if (next.every((f, i) => f === favItems[i])) return;
    favItems = next;
    try {
      await api('PUT', '/api/favorites/order', { ids: favItems.map((f) => f.id) });
    } catch (e) {
      alert('保存顺序失败：' + e.message);
    }
  }

  histListEl.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.hrow.fav');
    if (!el || e.target.closest('button') || e.button > 0) return;
    favDrag = { el, startX: e.clientX, startY: e.clientY, started: false, touch: e.pointerType !== 'mouse' };
    if (favDrag.touch) favDrag.timer = setTimeout(beginFavDrag, 350);
  });
  window.addEventListener('pointermove', (e) => {
    if (!favDrag) return;
    if (!favDrag.started) {
      const moved = Math.max(Math.abs(e.clientX - favDrag.startX), Math.abs(e.clientY - favDrag.startY));
      if (favDrag.touch) { if (moved > 8) endFavDrag(); return; } // 长按前就移动了 = 在滚动列表
      if (moved < 5) return;
      beginFavDrag();
    }
    moveFavDrag(e.clientY);
  });
  window.addEventListener('pointerup', endFavDrag);
  window.addEventListener('pointercancel', endFavDrag);
  histListEl.addEventListener('touchmove', (e) => { if (favDrag && favDrag.started) e.preventDefault(); }, { passive: false });
  histListEl.addEventListener('contextmenu', (e) => { if (e.target.closest('.hrow.fav')) e.preventDefault(); });

  histPanel.querySelectorAll('.htabs button').forEach((b) => b.addEventListener('click', () => {
    histTab = b.dataset.tab;
    try { localStorage.setItem('sshweb.histTab', histTab); } catch {}
    renderHistory();
  }));
  $('#favAdd').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cmd = $('#favInput').value.trim();
    if (!cmd) return;
    try {
      const item = await api('POST', '/api/favorites', { cmd, host: '' });
      if (!favItems.some((x) => x.id === item.id)) favItems.push(item);
      $('#favInput').value = '';
      renderHistory();
    } catch (err) { alert(err.message); }
  });
  $('#btnHistory').addEventListener('click', openHistory);
  $('#histClose').addEventListener('click', closeHistory);
  $('#histSearch').addEventListener('input', renderHistory);
  $('#histAll').addEventListener('change', renderHistory);
  histPanel.addEventListener('mousedown', (e) => { if (e.target === histPanel) closeHistory(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !histPanel.classList.contains('hidden') && $('#dialog').classList.contains('hidden')) closeHistory(); // 开着确认框：Esc 只关它
  });
  $('#histClear').addEventListener('click', async () => {
    const all = showAll();
    if (!confirm(all ? '清空所有主机的历史命令？(收藏不受影响)' : `清空 ${active.histHost} 的历史命令？(收藏不受影响)`)) return;
    try {
      await api('DELETE', '/api/history' + (all ? '' : '?host=' + encodeURIComponent(active.histHost)));
      histItems = all ? [] : histItems.filter((h) => h.host !== active.histHost);
      renderHistory();
    } catch (err) { alert(err.message); }
  });

