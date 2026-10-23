  // ------------------------------------------------------------ Agent 会话历史 (服务端见 lib/agent-sessions.js)
  // 「⋯ 更多 → 会话历史」弹窗，和「历史」面板里的「💬 会话历史」选项卡 (见 50-history.js) 用的是同一个部件 (agentSessionsView)：
  // 这台主机上 Claude Code / Grok / Codex / Gemini / OpenCode 以前的会话，按最近排；
  // 打字筛选列出来的 (标题、第一句话、目录)，回车或点「搜索」在全部会话内容里搜；「继续」在当前终端执行恢复命令，「复制」复制这条命令；
// 「删除」点两下：服务端先查有没有 Agent 在用 (钩子报的、主机上的进程、文件刚写过)，在用就问要不要强制，会话文件移到主机的 ~/.ssh-web/trash/
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
    if (e.key !== 'Escape' || !$('#dialog').classList.contains('hidden') || asEl?.classList.contains('tab-away')) return; // 上面开着确认框：Esc 只关确认框
    e.preventDefault();
    e.stopPropagation();
    closeAgentSessions();
  }

  function openAgentSessions(s) {
    closeAgentSessions();
    const el = asEl = document.createElement('div');
    el.className = 'overlay agentsp tab-panel';
    el.dataset.tab = s.id; // 手机上同性能监控 (见 tabPanels)
    el.innerHTML = `<div class="card wide as-card">
      <div class="hist-head"><h3>💬 会话历史</h3><button type="button" data-a="close" title="关闭 (Esc)" aria-label="关闭">×</button></div>
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
          <div class="as-btns"><button type="button" data-a="del" title="删除这个会话 (移到主机的 ~/.ssh-web/trash/，点两下)">删除</button>
            <button type="button" data-a="copy" title="复制恢复命令">复制</button>
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
      if (b.dataset.a === 'del') {
        // 点两下：第一下变成「确定删除？」(3 秒内再点)；服务端先查有没有 Agent 在用，在用就问要不要强制删除
        if (!b.classList.contains('danger')) {
          b.classList.add('danger'); b.textContent = '确定删除？';
          clearTimeout(b._t); b._t = setTimeout(() => { b.classList.remove('danger'); b.textContent = '删除'; }, 3000);
          return;
        }
        clearTimeout(b._t);
        const ag = agent, title = x.title || x.prompt || x.id, list0 = items;
        const del = async (force) => {
          b.disabled = true; b.textContent = force ? '正在删除…' : '正在检查…'; row.classList.add('dp-killing');
          const r = await fetch('/api/agent-sessions/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
            body: JSON.stringify({ sid: s.sid, agent: ag, id: x.id, force }) });
          const d = await r.json().catch(() => ({}));
          if (r.status === 401) showLogin();
          if (r.status === 409 && d.busy) return d;
          if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
          return d;
        };
        try {
          let d = await del(false);
          if (d.busy && !confirm(`「${title}」可能正被占用：\n· ${d.busy.join('\n· ')}\n\n还要删除吗？正在用它的 Agent 可能出错或者重新写出这个文件。`)) {
            b.disabled = false; b.classList.remove('danger'); b.textContent = '删除'; row.classList.remove('dp-killing');
            return;
          }
          if (d.busy) d = await del(true);
          if (items !== list0) return load(); // 删的时候列表换过了 (切了 Agent、刷新完了)：重新读
          items = items.filter((y) => y !== x);
          for (const [k, v] of asCache) if (k.endsWith('|' + ag)) asCache.set(k, { ...v, items: v.items.filter((y) => y.id !== x.id) });
          info.textContent = `已删除「${title}」，会话文件移到了主机的 ${d.trash}`;
          render();
        } catch (err) {
          b.disabled = false; b.classList.remove('danger'); b.textContent = '删除'; row.classList.remove('dp-killing');
          alert('删除失败：' + err.message);
        }
        return;
      }
      if (b.dataset.a === 'copy') {
        b.textContent = (await copyText(x.cmd)) ? '已复制' : '复制失败';
        setTimeout(() => { b.textContent = '复制'; }, 1500);
      } else if (b.dataset.a === 'resume') {
        // 先查这个对话有没有正在别处用 (别的标签里的 Agent、主机上的进程)：在用就同常驻会话的选择框一样问 —— 否 / 切到那个标签 / 是，仍然打开。
        // 查不了 (旧版服务、网络问题) 不拦，照常问一句
        if (b.disabled) return;
        const ag = agent, title = x.title || x.prompt || x.id;
        b.disabled = true; const t0 = b.textContent; b.textContent = '正在检查…';
        let busy = null;
        try { busy = await api('POST', '/api/agent-sessions/busy', { sid: s.sid, agent: ag, id: x.id }); } catch {}
        b.disabled = false; b.textContent = t0;
        if (busy?.busy?.length) {
          const tab = (busy.tabs || []).map((t) => sessions.find((y) => !y.closed && y.remoteId === t.tag)).find(Boolean);
          const r = await dialog('这个对话正在别处使用', `<p><b>${esc(title)}</b> ${esc(busy.busy.join('；'))}。要在这里也打开吗？</p>
            <p class="muted">两边同时开着同一个对话，都会往同一个会话文件里写，对话记录可能会乱。一般切过去接着用就行。</p>`,
          [{ label: '否', value: null, cancel: true }, ...(tab ? [{ label: '切到那个标签', value: 'go' }] : []), { label: '是，仍然打开', value: 'open', cls: 'danger' }]);
          if (r.value === 'go') { done(); if (!tab.closed) activate(tab); return; }
          if (r.value !== 'open') return;
        } else if (!confirm(`在当前终端执行：\n${x.cmd}\n\n这个标签里开着 Agent (Claude Code 等) 的话，会先退出它再执行。`)) return;
        // 服务端执行：标签里还开着 Agent 的话先退出它 (两下 Ctrl+C)，回到 shell 提示符再执行 (见 lib/agent-sessions.js)
        done();
        focusTerm(s);
        const name = `${(AS_AGENTS.find(([id]) => id === ag) || [, 'Claude'])[1]}：${title}`; // 常驻会话的选择框里显示
        api('POST', '/api/agent-sessions/resume', { sid: s.sid, cmd: x.cmd, name, cwd: x.cwd || '' }).catch((err) => alert(err.message));
      }
    });
    load();
    return { el, focus: () => input.focus() };
  }
