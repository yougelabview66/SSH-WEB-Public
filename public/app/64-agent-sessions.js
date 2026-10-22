  // ------------------------------------------------------------ Agent 会话历史 (服务端见 lib/agent-sessions.js)
  // 「⋯ 更多 → 会话历史」弹窗，和「历史」面板里的「💬 会话历史」选项卡 (见 50-history.js) 用的是同一个部件 (agentSessionsView)：
  // 这台主机上 Claude Code / Grok / Codex / Gemini / OpenCode 以前的会话，按最近排；
  // 打字筛选列出来的 (标题、第一句话、目录)，回车或点「搜索」在全部会话内容里搜；「继续」在当前终端执行恢复命令，「复制」复制这条命令
  let asEl = null;
  const AS_AGENTS = [['claude', 'Claude'], ['grok', 'Grok'], ['codex', 'Codex'], ['gemini', 'Gemini'], ['opencode', 'OpenCode']];
  const AS_TESTED = ['claude', 'grok'];
  // 上次读到的会话列表 (主机 + Agent → { items, info })：再打开时先显示它，后台再刷新
  const asCache = new Map();

  $('#btnSessions').addEventListener('click', () => { if (active?.sid) openAgentSessions(active); });

  function closeAgentSessions() {
    if (!asEl) return;
    asEl.remove();
    asEl = null;
    document.removeEventListener('keydown', asKey, true);
  }
  function asKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closeAgentSessions();
  }

  function openAgentSessions(s) {
    closeAgentSessions();
    const el = asEl = document.createElement('div');
    el.className = 'overlay agentsp';
    el.innerHTML = `<div class="card wide as-card">
      <div class="hist-head"><h3>💬 会话历史</h3><button type="button" data-a="close" title="关闭 (Esc)">×</button></div>
    </div>`;
    const view = agentSessionsView(s, closeAgentSessions);
    $('.as-card', el).appendChild(view.el);
    el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('[data-a=close]')) closeAgentSessions(); });
    document.addEventListener('keydown', asKey, true);
    document.body.appendChild(el);
    if (!isTouch) view.focus();
  }

  // 会话历史部件：返回 { el, focus }。done = 点了「继续」以后关掉外面的面板
  function agentSessionsView(s, done) {
    const el = document.createElement('div');
    let agent = (() => { try { return localStorage.getItem('sshweb.asAgent') || 'claude'; } catch { return 'claude'; } })();
    if (!AS_AGENTS.some(([id]) => id === agent)) agent = 'claude';
    let items = [], q = '', seq = 0;
    el.className = 'as-view';
    el.innerHTML = `<div class="as-tabs">${AS_AGENTS.map(([id, n]) => `<button type="button" data-agent="${id}">${n}</button>`).join('')}</div>
      <div class="as-search"><input type="search" placeholder="筛选标题、第一句话、目录 · 回车搜全部内容" enterkeyhint="search" spellcheck="false" autocomplete="off" autocapitalize="off"><button type="button" data-a="search" class="primary" title="在全部会话内容里搜 (回车)">搜索</button></div>
      <div class="as-info hint"></div>
      <div class="as-list"></div>`;
    const list = $('.as-list', el), info = $('.as-info', el), input = $('.as-search input', el);
    const host = s.baseTitle || s.title;
    const filtered = () => {
      const f = input.value.trim().toLowerCase();
      return !f || q ? items : items.filter((x) => [x.title, x.prompt, x.cwd].some((v) => (v || '').toLowerCase().includes(f)));
    };
    const render = () => {
      el.querySelectorAll('.as-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.agent === agent));
      const shown = filtered();
      list.innerHTML = shown.map((x) => `<div class="as-row" data-i="${items.indexOf(x)}">
          <div class="as-main"><div class="as-title">${esc(x.title || x.prompt || '(没有标题)')}</div>
            ${x.title && x.prompt ? `<div class="as-prompt">${esc(x.prompt)}</div>` : ''}
            <div class="as-meta">${esc(x.cwd || '目录不明')} · ${fmtAgo(x.mtime)} · ${fmtSize(x.size)}</div></div>
          <div class="as-btns"><button type="button" data-a="copy" title="复制恢复命令">复制</button>
            <button type="button" data-a="resume" class="primary" title="${esc(x.cmd)}">继续</button></div>
        </div>`).join('') || `<div class="as-empty">${q ? `没有找到含「${esc(q)}」的会话` : input.value.trim() ? '没有符合的会话（回车或点「搜索」在全部内容里搜）' : '这台主机上没找到这个 Agent 的会话'}</div>`;
    };
    const load = async () => {
      const my = ++seq;
      const key = `${s.hostId || host}|${agent}`, old = !q && asCache.get(key);
      if (old) { // 先显示上次的，后台刷新
        items = old.items;
        info.textContent = old.info + ' · 正在刷新…';
        render();
      } else {
        info.textContent = q ? `正在搜索「${q}」…` : '正在读取…';
        list.innerHTML = '';
      }
      try {
        const r = await api('POST', '/api/agent-sessions', { sid: s.sid, agent, q });
        if (my !== seq) return;
        items = r.sessions;
        info.textContent = `${host} · ${q ? `含「${q}」的 ` : '最近 '}${items.length} 个会话${r.more ? '（只列最近的）' : ''}${r.partial ? '（搜索超时，只搜了最近的一部分）' : ''}`
          + (AS_TESTED.includes(agent) ? '' : ' · 未实测：照着 Orca 的做法读的，有问题告诉我');
        if (!q) asCache.set(key, { items, info: info.textContent });
        render();
      } catch (e) {
        if (my === seq) { info.textContent = '读取失败：' + e.message; if (!old) { items = []; render(); } }
      }
    };
    input.addEventListener('input', () => {
      if (q) { q = ''; load(); return; } // 改了搜索词：回到最近的会话，按新词筛选
      render();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); q = input.value.trim(); load(); }
    });
    el.addEventListener('click', async (e) => {
      if (e.target.closest('[data-a=search]')) { q = input.value.trim(); return load(); }
      const tab = e.target.closest('.as-tabs [data-agent]');
      if (tab) {
        agent = tab.dataset.agent;
        try { localStorage.setItem('sshweb.asAgent', agent); } catch {}
        q = ''; input.value = ''; items = [];
        return load();
      }
      const b = e.target.closest('[data-a]'), row = e.target.closest('.as-row');
      if (!b || !row) return;
      const x = items[+row.dataset.i];
      if (!x) return;
      if (b.dataset.a === 'copy') {
        b.textContent = (await copyText(x.cmd)) ? '已复制' : '复制失败';
        setTimeout(() => { b.textContent = '复制'; }, 1500);
      } else if (b.dataset.a === 'resume') {
        // 服务端执行：标签里还开着 Agent 的话先退出它 (两下 Ctrl+C)，回到 shell 提示符再执行 (见 lib/agent-sessions.js)
        if (!confirm(`在当前终端执行：\n${x.cmd}\n\n这个标签里开着 Agent (Claude Code 等) 的话，会先退出它再执行。`)) return;
        done();
        focusTerm(s);
        api('POST', '/api/agent-sessions/resume', { sid: s.sid, cmd: x.cmd }).catch((err) => alert(err.message));
      }
    });
    load();
    return { el, focus: () => input.focus() };
  }
