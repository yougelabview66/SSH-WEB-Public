  // ------------------------------------------------------------ 右边栏：「项目」和「改动」(参考 Orca / VS Code；服务端见 lib/project.js、lib/git-changes.js)
  // 两个选项卡共用一个项目目录 (顶部那栏：空着 = 自动找 Agent 干活的目录 / 终端所在目录，也能手动填；是 git 仓库就用仓库根目录)。
  // 「项目」：文件夹树 (点开才读那一层，隐藏 .git，node_modules 之类变灰；改过的文件按 git 状态上色，里面有改动的文件夹带圆点)，
  //   点文件预览，「⋯」里发路径给 Agent / 复制路径 / 下载 / 看改动；顶部搜索框 = 快速打开 (按文件名模糊搜索，↑↓ 选、回车打开，
  //   最近打开的排前面；电脑上 Ctrl+Shift+P 直接跳到这里)。
  // 「改动」：改了哪些文件 (带增删行数)，点开看红绿对比；点一行写批注 (电脑上 Shift + 点 = 选一段)，「发给 Agent」整理成一段话填进输入框 (不发送)。
  // 电脑：展开时固定在右边 (终端变窄，左边缘拖动调宽度，拖的时候终端先不重排、松手再排)，最右边的「»」收起成右边缘一列图标 (点哪个展开到哪个)；
  // 手机：全屏，最右边是「×」关掉。
  // Agent 做完时 (状态变成「完成」) 右边栏开着就刷新
  const rightBar = $('#rightBar'), rightRail = $('#rightRail');
  const rbDir = $('.rb-dir input', rightBar), pfSearch = $('.pf-search input', rightBar), pfBody = $('.pf-body', rightBar), gpBody = $('.gp-body', rightBar);
  const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  let rbState = isTouch ? 'closed' : lsGet('sshweb.rbState', 'closed'); // open / collapsed / closed (手机上每次都从关着开始)
  let rbTab = lsGet('sshweb.rbTab', 'files');
  const rb = { s: null, seq: 0 }; // rb.s：右边栏现在显示的是哪个标签的项目
  let rbResizing = false; // 正在拖右边栏的宽度：终端先不跟着重排 (每动一下都重排、整屏重画会卡)，松手再排一次
  const gp = { data: null, file: null, diff: null, sel: null, lines: [] }; // 「改动」
  const gitNotes = new Map(); // 仓库 → [{ path, side, from, to, code, text }]
  const winPath = (p) => (/^\/[A-Za-z]:/.test(p) ? p.slice(1) : p); // 给 git / 显示用的路径 (Windows 去掉 SFTP 的前导 /)
  const relOf = (root, p) => (p.startsWith(root + '/') ? p.slice(root.length + 1) : p);

  $('#btnProj').addEventListener('click', () => { if (active?.sid) openRightBar('files'); });
  $('#btnGit').addEventListener('click', () => { if (active?.sid) openRightBar('git'); });
  rightRail.addEventListener('click', (e) => { const t = e.target.closest('[data-tab]'); if (t) openRightBar(t.dataset.tab); });

  function openRightBar(tab) {
    if (tab) setRbTab(tab);
    setRbState('open');
  }
  function setRbState(st) {
    rbState = st;
    if (!isTouch) lsSet('sshweb.rbState', st);
    applyRb();
    if (st === 'open') rbSync(true);
  }
  function setRbTab(tab) {
    rbTab = tab;
    lsSet('sshweb.rbTab', tab);
    applyRb();
    if (rbState === 'open' && rb.s) (tab === 'files' ? pfRender() : gpRender());
  }
  function applyRb() {
    const on = rbState === 'open' && !!active;
    rightBar.classList.toggle('hidden', !on);
    rightBar.classList.toggle('mobile', isTouch);
    rightRail.classList.toggle('hidden', !(rbState === 'collapsed' && active && !isTouch));
    rightBar.querySelectorAll('.rb-tabs [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === rbTab));
    rightBar.querySelectorAll('.rb-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.tab !== rbTab));
    if (!isTouch && !rbResizing) rightBar.style.width = Math.min(Math.max(+lsGet('sshweb.rbW', 440) || 440, 300), Math.round(innerWidth * 0.6)) + 'px'; // 拖着的时候不改回去
  }
  // 换了标签：右边栏跟着换成那个标签的项目
  function rbSync(force) {
    applyRb();
    if (rbState === 'closed' || !active) return;
    if (force || rb.s !== active) { rb.s = active; rbDir.value = active.projDir || ''; projLoad(); }
  }
  setInterval(() => rbSync(false), 500);

  // Agent 做完了：右边栏开着、是这个标签，就刷新 (改动列表、文件树)
  function gitOnState(s, m) {
    if (rbState === 'closed' || s !== rb.s || m.cls !== 'done') return;
    clearTimeout(rb.autoTimer);
    rb.autoTimer = setTimeout(() => projLoad(true), 800);
  }

  // 读项目信息 (目录、仓库根目录) 和改动列表；keep：刷新 (文件树保留展开的文件夹)
  async function projLoad(keep) {
    const s = rb.s, my = ++rb.seq;
    if (!s?.sid) { pfBody.innerHTML = gpBody.innerHTML = '<div class="gp-msg">这个标签没连上</div>'; return; }
    if (!keep || !s.proj) { pfBody.innerHTML = gpBody.innerHTML = '<div class="gp-msg">正在读取…</div>'; }
    try {
      const info = await api('POST', '/api/project/info', { sid: s.sid, dir: s.projDir || '' });
      if (my !== rb.seq || s !== rb.s) return;
      if (!s.proj || s.proj.root !== info.root) { s.pf = { open: new Set(), kids: new Map() }; s.allFiles = null; }
      s.proj = info;
      if (!s.projDir) rbDir.placeholder = winPath(info.root);
      $('.rb-src', rightBar).textContent = { agent: 'Agent 干活的目录', terminal: '终端所在的目录', home: '主目录', manual: '手动指定' }[info.source] || '';
      gp.data = info.isGit ? await api('POST', '/api/git/status', { sid: s.sid, dir: winPath(info.root) }) : { root: info.root, error: `${winPath(info.root)} 不是 git 仓库` };
      if (my !== rb.seq || s !== rb.s) return;
      gp.data.root = info.root; // 和文件树用同一种写法 (SFTP 路径)
      rightBar.querySelectorAll('.rb-count').forEach((b) => { b.textContent = gp.data.files?.length || ''; });
      rightRail.querySelectorAll('.rb-count').forEach((b) => { b.textContent = gp.data.files?.length || ''; });
      if (keep) { await Promise.all([...s.pf.kids.keys()].map((rel) => pfFetch(s, rel).catch(() => s.pf.kids.delete(rel)))); s.allFiles = null; } // 展开过的文件夹一起重新读
      if (gp.file) { const f = gp.data.files?.find((x) => x.path === gp.file.path); if (f) return gpOpenFile(f, true); gp.file = null; }
      pfRender(); gpRender();
    } catch (e) {
      if (my === rb.seq) pfBody.innerHTML = gpBody.innerHTML = `<div class="gp-msg err">读取失败：${esc(e.message)}<br><span class="hint">可以在上面填项目目录，回车</span></div>`;
    }
  }

  // ============ 项目：文件夹树 + 快速打开
  const gitStatusOf = () => {
    const m = new Map(), dirs = new Set();
    for (const f of gp.data?.files || []) {
      m.set(f.path, f.status);
      for (let i = f.path.indexOf('/'); i > 0; i = f.path.indexOf('/', i + 1)) dirs.add(f.path.slice(0, i));
    }
    return { m, dirs };
  };
  const STATUS = { modified: ['M', '修改'], added: ['A', '新增'], deleted: ['D', '删除'], renamed: ['R', '改名'], untracked: ['U', '未跟踪的新文件'], conflict: ['!', '有冲突'] };
  const abs = (s, rel) => (rel ? `${s.proj.root.replace(/\/$/, '')}/${rel}` : s.proj.root);
  // 线条图标 (lucide，同 Orca)：箭头、文件夹 / 打开的文件夹、按类型的文件图标
  const svg = (d) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const FILE = '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>';
  const ICON = {
    chev: svg('<path d="m9 18 6-6-6-6"/>'),
    folder: svg('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
    open: svg('<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>'),
    file: svg(FILE),
    code: svg(FILE + '<path d="m10 13-2 2 2 2"/><path d="m14 17 2-2-2-2"/>'),
    text: svg(FILE + '<path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>'),
    image: svg(FILE + '<circle cx="10" cy="12" r="2"/><path d="m20 17-1.296-1.296a2.41 2.41 0 0 0-3.408 0L9 22"/>'),
    json: svg(FILE + '<path d="M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1"/><path d="M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1"/>'),
  };
  const fileIcon = (name) => {
    const ext = (/\.([^.]+)$/.exec(name.toLowerCase()) || [])[1] || '';
    if (/^(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/.test(ext)) return ICON.image;
    if (/^(json|jsonc|json5|lock)$/.test(ext)) return ICON.json;
    if (/^(md|markdown|txt|log|rst|csv|tsv)$/.test(ext) || /^(readme|license|changelog)/i.test(name)) return ICON.text;
    if (/^(js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|kt|c|h|cpp|hpp|cc|cs|rb|php|sh|bash|zsh|ps1|bat|cmd|lua|swift|vue|svelte|html|css|scss|less|sql|yaml|yml|toml|ini|xml|conf)$/.test(ext)) return ICON.code;
    return ICON.file;
  };
  async function pfFetch(s, rel) {
    const r = await api('POST', '/api/project/ls', { sid: s.sid, path: abs(s, rel) });
    s.pf.kids.set(rel, r.entries);
  }
  async function pfRender() {
    const s = rb.s;
    if (!s?.proj || rbTab !== 'files') return;
    if (pfSearch.value.trim()) return pfSearchRender();
    if (!s.pf.kids.has('')) {
      try { await pfFetch(s, ''); } catch (e) { pfBody.innerHTML = `<div class="gp-msg err">读取失败：${esc(e.message)}</div>`; return; }
      if (s !== rb.s) return;
    }
    const { m, dirs } = gitStatusOf();
    const rows = [];
    const walk = (rel, depth) => {
      for (const e of s.pf.kids.get(rel) || []) {
        const p = rel ? `${rel}/${e.name}` : e.name, st = m.get(p);
        const open = e.dir && s.pf.open.has(p);
        rows.push(`<div class="pf-row${e.dir ? ' dir' : ''}${e.heavy ? ' heavy' : ''}${st ? ' st-' + st : ''}" data-rel="${esc(p)}" data-dir="${e.dir ? 1 : ''}" data-size="${e.size || 0}" style="padding-left:${6 + depth * 16}px">
          <span class="pf-chev${e.dir ? (open ? ' open' : '') : ' none'}">${ICON.chev}</span>${e.dir ? (open ? ICON.open : ICON.folder) : fileIcon(e.name)}<span class="pf-name">${esc(e.name)}</span>
          ${e.dir && dirs.has(p) ? '<span class="pf-dot" title="里面有改动"></span>' : ''}${st ? `<span class="pf-st" title="${esc(STATUS[st]?.[1] || st)}">${STATUS[st]?.[0] || '?'}</span>` : ''}
          ${e.dir ? '' : '<button type="button" class="pf-more" data-a="more" title="更多操作">⋯</button>'}</div>`);
        if (open) walk(p, depth + 1);
      }
    };
    walk('', 0);
    pfBody.innerHTML = rows.join('') || '<div class="gp-msg">空文件夹</div>'; // 根目录显示在顶部那栏里
  }

  // 模糊匹配：字母按顺序出现就算 (不分大小写)；文件名里、连着、在开头 / 分隔符后面的分数高，路径短的高，最近打开的加分
  function fuzzy(q, path, recent) {
    const p = path.toLowerCase(), nameAt = p.lastIndexOf('/') + 1;
    // 从 from 开始按顺序找每个字母；先在文件名里找，找不全再在整个路径里找
    const tryFrom = (from) => {
      const pos = [];
      let k = from, sc = 0, prev = -2;
      for (const ch of q) {
        const i = p.indexOf(ch, k);
        if (i < 0) return null;
        sc += 1 + (i === prev + 1 ? 5 : 0) + (i === 0 || '/_-. '.includes(p[i - 1]) ? 3 : 0) + (i >= nameAt ? 2 : 0);
        pos.push(i); prev = i; k = i + 1;
      }
      return { sc, pos };
    };
    const r = tryFrom(nameAt) || tryFrom(0);
    if (!r) return null;
    return { score: r.sc - path.length * 0.02 + (p.startsWith(q, nameAt) ? 10 : 0) + (recent ? 15 : 0), pos: r.pos };
  }
  const recentKey = (s) => 'sshweb.recentFiles:' + s.proj.root;
  const recentOf = (s) => { try { return JSON.parse(lsGet(recentKey(s), '[]')); } catch { return []; } };
  function addRecent(s, rel) { lsSet(recentKey(s), JSON.stringify([rel, ...recentOf(s).filter((x) => x !== rel)].slice(0, 30))); }

  let pfSel = 0, pfHits = [];
  async function pfSearchRender() {
    const s = rb.s, q = pfSearch.value.trim().toLowerCase();
    if (!q) return pfRender();
    if (!s.allFiles) {
      pfBody.innerHTML = '<div class="gp-msg">正在列出项目里的文件…</div>';
      try {
        const r = await api('POST', '/api/project/files', { sid: s.sid, root: s.proj.root, isGit: s.proj.isGit });
        if (s !== rb.s) return;
        s.allFiles = r;
      } catch (e) { pfBody.innerHTML = `<div class="gp-msg err">读取失败：${esc(e.message)}</div>`; return; }
      if (pfSearch.value.trim().toLowerCase() !== q) return pfSearchRender();
    }
    const rec = new Set(recentOf(s));
    const hits = [];
    for (const f of s.allFiles.files) { const h = fuzzy(q, f, rec.has(f)); if (h) hits.push({ f, ...h }); }
    hits.sort((a, b) => b.score - a.score);
    pfHits = hits.slice(0, 100);
    pfSel = Math.min(pfSel, Math.max(0, pfHits.length - 1));
    const { m } = gitStatusOf();
    const mark = (f, pos) => { const set = new Set(pos); return [...f].map((c, i) => (set.has(i) ? `<em>${esc(c)}</em>` : esc(c))).join(''); };
    pfBody.innerHTML = pfHits.map((h, i) => {
      const k = h.f.lastIndexOf('/'), st = m.get(h.f);
      const namePos = h.pos.filter((x) => x > k).map((x) => x - k - 1), dirPos = h.pos.filter((x) => x < k);
      return `<div class="pf-hit${i === pfSel ? ' sel' : ''}${st ? ' st-' + st : ''}" data-rel="${esc(h.f)}" data-i="${i}">
        ${fileIcon(h.f.slice(k + 1))}<span class="pf-name">${mark(h.f.slice(k + 1), namePos)}</span><span class="pf-dirp">${mark(h.f.slice(0, Math.max(0, k)), dirPos)}</span>
        ${st ? `<span class="pf-st">${STATUS[st]?.[0] || '?'}</span>` : ''}<button type="button" class="pf-more" data-a="more" title="更多操作">⋯</button></div>`;
    }).join('') || `<div class="gp-msg">没有名字像「${esc(q)}」的文件</div>`;
    if (s.allFiles.more) pfBody.insertAdjacentHTML('beforeend', '<div class="gp-msg hint">文件太多，只搜了前 5 万个</div>');
    pfBody.querySelector('.pf-hit.sel')?.scrollIntoView({ block: 'nearest' });
  }

  function pfPreview(rel, size) {
    const s = rb.s;
    addRecent(s, rel);
    const full = abs(s, rel);
    openPreview(s, full, size || 0, (p) => {
      const a = document.createElement('a');
      a.href = `/api/sftp/${s.sid}/download?path=${encodeURIComponent(p)}`;
      a.download = '';
      document.body.appendChild(a); a.click(); a.remove();
    });
  }

  // 「⋯」：一个文件能做的事
  let pfMenu = null;
  function closePfMenu() { pfMenu?.remove(); pfMenu = null; }
  function openPfMenu(row) {
    closePfMenu();
    const s = rb.s, rel = row.dataset.rel, full = abs(s, rel);
    const changed = gp.data?.files?.find((f) => f.path === rel);
    const el = pfMenu = document.createElement('div');
    el.className = 'pf-menu';
    el.innerHTML = `<button type="button" data-m="pv">预览</button><button type="button" data-m="agent">发路径给 Agent</button>
      <button type="button" data-m="copy">复制路径</button><button type="button" data-m="dl">下载</button>${changed ? '<button type="button" data-m="diff">看改动</button>' : ''}`;
    const r = row.getBoundingClientRect(), br = rightBar.getBoundingClientRect();
    el.style.top = (r.bottom - br.top) + 'px';
    rightBar.appendChild(el);
    el.addEventListener('click', async (e) => {
      const m = e.target.closest('[data-m]')?.dataset.m;
      if (!m) return;
      closePfMenu();
      if (m === 'pv') pfPreview(rel, +row.dataset.size);
      else if (m === 'agent') { if (!inputLocked(s)) { insertPaths(s, [winPath(full)]); if (isTouch) setRbState('closed'); } }
      else if (m === 'copy') await copyText(winPath(full));
      else if (m === 'dl') { const a = document.createElement('a'); a.href = `/api/sftp/${s.sid}/download?path=${encodeURIComponent(full)}`; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); }
      else if (m === 'diff') { setRbTab('git'); gpOpenFile(changed); }
    });
  }
  pfBody.addEventListener('contextmenu', (e) => { // 右键 = 「⋯」(同 Orca)
    const row = e.target.closest('.pf-row:not(.dir), .pf-hit');
    if (!row) return;
    e.preventDefault();
    openPfMenu(row);
    pfMenu.dataset.rel = row.dataset.rel;
  });
  document.addEventListener('pointerdown', (e) => { if (pfMenu && !pfMenu.contains(e.target) && !e.target.closest('[data-a=more]')) closePfMenu(); }, true);

  pfBody.addEventListener('click', async (e) => {
    const row = e.target.closest('.pf-row, .pf-hit');
    if (!row) return;
    if (e.target.closest('[data-a=more]')) return pfMenu?.dataset.rel === row.dataset.rel ? closePfMenu() : (openPfMenu(row), pfMenu && (pfMenu.dataset.rel = row.dataset.rel));
    const s = rb.s, rel = row.dataset.rel;
    if (row.dataset.dir) {
      if (s.pf.open.has(rel)) s.pf.open.delete(rel);
      else {
        s.pf.open.add(rel);
        if (!s.pf.kids.has(rel)) { try { await pfFetch(s, rel); } catch (err) { alert(err.message); s.pf.open.delete(rel); } }
      }
      return pfRender();
    }
    pfPreview(rel, +row.dataset.size);
  });
  // 搜索：打字时 (组完字) 筛选，↑↓ 选，回车打开，Esc 清空
  let pfTimer = 0, pfComposing = false;
  pfSearch.addEventListener('compositionstart', () => { pfComposing = true; });
  pfSearch.addEventListener('compositionend', () => { pfComposing = false; pfSel = 0; pfSearchRender(); });
  pfSearch.addEventListener('input', () => { if (pfComposing) return; clearTimeout(pfTimer); pfSel = 0; pfTimer = setTimeout(pfSearchRender, 120); });
  pfSearch.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!pfHits.length) return;
      pfSel = (pfSel + (e.key === 'ArrowDown' ? 1 : -1) + pfHits.length) % pfHits.length;
      pfSearchRender();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (pfHits[pfSel]) pfPreview(pfHits[pfSel].f, 0);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (pfSearch.value) { pfSearch.value = ''; pfRender(); } else pfSearch.blur();
    }
  });
  // Ctrl+Shift+P：打开右边栏的「项目」，光标到搜索框 (Ctrl+P 留给终端：上一条命令)
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.code !== 'KeyP' || !active?.sid) return;
    e.preventDefault();
    e.stopPropagation();
    openRightBar('files');
    pfSearch.focus();
    pfSearch.select();
  }, true);

  // ============ 改动：改了哪些文件、每个文件改了什么、批注
  const notesOf = () => (gp.data?.root ? (gitNotes.get(gp.data.root) || []) : []);
  function gpRender() {
    if (rbTab !== 'git' || !gp.data) return;
    if (gp.file && gp.diff) return gpRenderFile();
    gpRenderList();
  }
  function gpRenderList() {
    const d = gp.data;
    gpRenderNotes();
    if (d.error) { gpBody.innerHTML = `<div class="gp-msg err">${esc(d.error)}<br><span class="hint">可以在上面填项目目录，回车</span></div>`; return; }
    if (!d.files.length) { gpBody.innerHTML = `<div class="gp-msg">没有改动<br><span class="hint">${esc(winPath(d.root))} · ${esc(d.branch || '')}</span></div>`; return; }
    const notes = notesOf();
    gpBody.innerHTML = `<div class="gp-root hint"><b class="gp-branch">${esc(d.branch || '')}</b> · ${d.files.length} 个文件${d.more ? '（只列前面的）' : ''}</div>`
      + d.files.map((f, i) => {
        const [b, t] = STATUS[f.status] || ['?', f.status];
        const slash = f.path.lastIndexOf('/');
        const n = notes.filter((x) => x.path === f.path).length;
        return `<div class="gp-file" data-i="${i}" title="${esc(t)}${f.from ? '：' + esc(f.from) + ' → ' + esc(f.path) : ''}">
          <span class="gp-st st-${f.status}">${f.status === 'untracked' ? '新' : b}</span>
          <span class="gp-name"><b>${esc(f.path.slice(slash + 1))}</b><span class="gp-path">${esc(slash > 0 ? f.path.slice(0, slash) : '')}</span></span>
          ${n ? `<span class="gp-nb" title="${n} 条批注">✎${n}</span>` : ''}
          <span class="gp-cnt">${f.binary ? '二进制' : f.add != null ? `<i class="a">+${f.add}</i> <i class="d">−${f.del}</i>` : ''}</span>
        </div>`;
      }).join('');
  }

  async function gpOpenFile(f, keep) {
    const s = rb.s, my = ++rb.seq;
    gp.file = f;
    if (!keep) { gp.sel = null; gp.diff = null; gpBody.innerHTML = '<div class="gp-msg">正在读取…</div>'; }
    try {
      const r = await api('POST', '/api/git/diff', { sid: s.sid, root: winPath(gp.data.root), path: f.path, from: f.from || '', untracked: f.status === 'untracked' });
      if (my !== rb.seq || gp.file !== f) return;
      gp.diff = r;
      gpRenderFile();
    } catch (e) {
      if (my === rb.seq) gpBody.innerHTML = `<div class="gp-msg err">读取失败：${esc(e.message)}</div>`;
    }
  }

  // unified diff → 行：{ t: 'hunk' | 'add' | 'del' | 'ctx' | 'meta', o: 旧行号, n: 新行号, s: 文字 }
  function parseDiff(text) {
    const out = [];
    let o = 0, n = 0, inHunk = false;
    for (const l of text.split('\n')) {
      const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(l);
      if (h) { o = +h[1]; n = +h[2]; inHunk = true; out.push({ t: 'hunk', s: l }); continue; }
      if (!inHunk) continue;
      if (l.startsWith('+')) out.push({ t: 'add', n: n++, s: l.slice(1) });
      else if (l.startsWith('-')) out.push({ t: 'del', o: o++, s: l.slice(1) });
      else if (l.startsWith(' ')) out.push({ t: 'ctx', o: o++, n: n++, s: l.slice(1) });
      else if (l.startsWith('\\')) out.push({ t: 'meta', s: '（文件末尾没有换行）' });
    }
    return out;
  }

  function gpRenderFile() {
    const f = gp.file, r = gp.diff;
    gpRenderNotes();
    const [b, t] = STATUS[f.status] || ['?', f.status];
    const head = `<div class="gp-fhead"><button type="button" data-a="back" title="回到文件列表">← 返回</button>
      <span class="gp-st st-${f.status}" title="${esc(t)}">${f.status === 'untracked' ? '新' : b}</span><span class="gp-fpath">${esc(f.path)}</span></div>`;
    if (r.binary) { gpBody.innerHTML = head + '<div class="gp-msg">二进制文件，看不了文字对比</div>'; return; }
    const lines = gp.lines = parseDiff(r.diff);
    const all = notesOf(), notes = all.filter((x) => x.path === f.path);
    const sel = gp.sel;
    const inSel = (i) => sel && i >= Math.min(sel.a, sel.b) && i <= Math.max(sel.a, sel.b);
    let html = '';
    lines.forEach((l, i) => {
      if (l.t === 'hunk' || l.t === 'meta') { html += `<div class="gl ${l.t}">${esc(l.s)}</div>`; return; }
      const no = l.t === 'del' ? l.o : l.n;
      html += `<div class="gl ${l.t}${inSel(i) ? ' sel' : ''}" data-i="${i}"><span class="no">${no}</span><span class="sg">${l.t === 'add' ? '+' : l.t === 'del' ? '−' : ' '}</span><code>${esc(l.s) || ' '}</code></div>`;
      // 这一行上的批注 (批注挂在选中范围的最后一行下面)
      for (const x of notes) {
        if (x.side === (l.t === 'del' ? 'old' : 'new') && x.to === no) {
          html += `<div class="gp-note" data-n="${all.indexOf(x)}"><span class="gp-nr">${x.from === x.to ? `第 ${x.to} 行` : `第 ${x.from}–${x.to} 行`}</span>${esc(x.text)}<button type="button" data-a="delnote" title="删掉这条批注">✕</button></div>`;
        }
      }
      if (sel && i === Math.max(sel.a, sel.b)) {
        html += `<div class="gp-edit"><textarea rows="2" placeholder="写批注，比如：这里不要删 (Ctrl+Enter 添加)"></textarea>
          <div class="gp-ebtns"><span class="hint">${isTouch ? '' : '按住 Shift 再点一行可以选一段'}</span><span class="spacer"></span><button type="button" data-a="cancelnote">取消</button><button type="button" data-a="addnote" class="primary">添加批注</button></div></div>`;
      }
    });
    gpBody.innerHTML = head + (r.truncated ? '<div class="gp-msg hint">改动太大，只显示了前面一部分</div>' : '') + `<div class="gp-diff">${html || '<div class="gp-msg">没有文字改动（可能只是改了文件权限或改名）</div>'}</div>`;
    $('.gp-edit textarea', gpBody)?.focus({ preventScroll: true });
  }

  function gpRenderNotes() {
    const n = notesOf().length;
    $('.gp-notes', rightBar).classList.toggle('hidden', !n);
    $('.gp-ncount', rightBar).textContent = `批注 ${n} 条`;
  }

  // 批注整理成一段话 (路径相对仓库根目录)
  function gitNotesText(root, notes) {
    const lines = notes.map((x, i) => {
      const where = x.from === x.to ? `第 ${x.to} 行` : `第 ${x.from}–${x.to} 行`;
      const code = x.code.trim().slice(0, 60);
      return `${i + 1}. ${x.path} ${x.side === 'old' ? '删掉的' : ''}${where}${code ? `（${code}）` : ''}：${x.text}`;
    });
    return `请按下面的批注修改代码（路径相对 ${winPath(root)}）：\n${lines.join('\n')}`;
  }

  gpBody.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'back') { gp.file = null; gp.sel = null; gp.diff = null; return gpRenderList(); }
    if (a === 'cancelnote') { gp.sel = null; return gpRenderFile(); }
    if (a === 'addnote') return addNote();
    if (a === 'delnote') { notesOf().splice(+e.target.closest('.gp-note').dataset.n, 1); return gpRenderFile(); }
    const fileRow = e.target.closest('.gp-file');
    if (fileRow) return gpOpenFile(gp.data.files[+fileRow.dataset.i]);
    const line = e.target.closest('.gl[data-i]');
    if (line && !e.target.closest('.gp-edit')) {
      const i = +line.dataset.i, side = gp.lines[i].t === 'del' ? 'old' : 'new';
      // Shift + 点：和上次点的那行连成一段 (同一边：都是新文件的行，或者都是删掉的行)
      if (e.shiftKey && gp.sel && (gp.lines[gp.sel.a].t === 'del' ? 'old' : 'new') === side) gp.sel.b = i;
      else gp.sel = { a: i, b: i };
      getSelection()?.removeAllRanges();
      gpRenderFile();
    }
  });
  gpBody.addEventListener('keydown', (e) => {
    if (!e.target.matches('.gp-edit textarea')) return;
    e.stopPropagation(); // 打的字只进批注框
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addNote(); }
    else if (e.key === 'Escape') { e.preventDefault(); gp.sel = null; gpRenderFile(); }
  });
  function addNote() {
    const text = $('.gp-edit textarea', gpBody)?.value.trim();
    if (!text || !gp.sel) return;
    const a = Math.min(gp.sel.a, gp.sel.b), b = Math.max(gp.sel.a, gp.sel.b);
    const picked = gp.lines.slice(a, b + 1).filter((l) => l.t === 'add' || l.t === 'del' || l.t === 'ctx');
    const side = picked[0].t === 'del' ? 'old' : 'new';
    const nos = picked.filter((l) => (l.t === 'del') === (side === 'old')).map((l) => (side === 'old' ? l.o : l.n));
    const root = gp.data.root;
    if (!gitNotes.has(root)) gitNotes.set(root, []);
    gitNotes.get(root).push({ path: gp.file.path, side, from: Math.min(...nos), to: Math.max(...nos), code: picked[0].s, text });
    gp.sel = null;
    gpRenderFile();
  }

  // ============ 顶部按钮、项目目录、拖宽度
  rightBar.addEventListener('click', (e) => {
    const tab = e.target.closest('.rb-tabs [data-tab]');
    if (tab) return setRbTab(tab.dataset.tab);
    const a = e.target.closest('.rb-head [data-a], .gp-notes [data-a]')?.dataset.a;
    if (a === 'refresh') { if (rb.s) rb.s.allFiles = null; return projLoad(true); }
    if (a === 'collapse') return setRbState('collapsed');
    if (a === 'close') return setRbState('closed');
    if (a === 'clearnotes') {
      if (!confirm('清空这个仓库的所有批注？')) return;
      gitNotes.delete(gp.data?.root);
      return gpRender();
    }
    if (a === 'send') {
      const notes = notesOf(), s = rb.s;
      if (!notes.length || !s || inputLocked(s)) return; // 别的设备在用
      insertText(s, gitNotesText(gp.data.root, notes));
      gitNotes.delete(gp.data.root);
      if (isTouch) setRbState('closed'); // 手机上右边栏盖着输入栏：关掉才看得到
      else gpRender();
    }
  });
  // 项目目录：填了回车 = 用这个目录，清空回车 = 自动
  rbDir.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key !== 'Enter' || !rb.s) return;
    rb.s.projDir = rbDir.value.trim();
    gp.file = null; gp.diff = null;
    projLoad();
  });
  $('.rb-resize', rightBar).addEventListener('pointerdown', (e) => {
    if (isTouch || e.button !== 0) return;
    e.preventDefault();
    const h = e.currentTarget;
    h.setPointerCapture(e.pointerId);
    const x0 = e.clientX, w0 = rightBar.getBoundingClientRect().width;
    rightBar.classList.add('resizing');
    rbResizing = true;
    const move = (ev) => { rightBar.style.width = Math.min(Math.max(w0 - (ev.clientX - x0), 300), Math.round(innerWidth * 0.6)) + 'px'; };
    const up = () => {
      h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up);
      rightBar.classList.remove('resizing');
      rbResizing = false;
      lsSet('sshweb.rbW', Math.round(rightBar.getBoundingClientRect().width));
      if (active && !active.scrollView) active.fit.fit(); // 松手：终端按新宽度排一次
    };
    h.addEventListener('pointermove', move); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isTouch && rbState === 'open' && !document.querySelector('.fpreview')) setRbState('closed'); });
  applyRb();
