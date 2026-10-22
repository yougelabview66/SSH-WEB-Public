  // ------------------------------------------------------------ 右边栏：「项目」和「改动」(参考 Orca / VS Code；服务端见 lib/project.js、lib/git-changes.js)
  // 两个选项卡共用一个项目目录 (顶部那栏：空着 = 自动找 Agent 干活的目录 / 终端所在目录，也能手动填；是 git 仓库就用仓库根目录)。
  // 「项目」：文件夹树 (点开才读那一层，隐藏 .git，node_modules 之类变灰；改过的文件按 git 状态上色，里面有改动的文件夹带圆点)，
  //   点文件预览，「⋯」里发路径给 Agent / 复制路径 / 下载 / 看改动；顶部搜索框 = 快速打开 (按文件名模糊搜索，↑↓ 选、回车打开，
  //   最近打开的排前面；电脑上 Ctrl+Shift+P 直接跳到这里)。
  // 「改动」：改了哪些文件 (带增删行数)，点开看红绿对比；点一行写批注 (电脑上 Shift + 点 = 选一段)，「发给 Agent」整理成一段话填进输入框 (不发送)。
  // 电脑：展开时固定在右边 (终端变窄，左边缘拖动调宽度，拖的时候终端先不重排、松手再排)，最右边的「»」收起成右边缘一列图标 (点哪个展开到哪个)；
  // 手机：全屏，最右边同样是「»」收起 (手机上没有右边缘那列图标，收起就是关掉，从「⋯ 更多」再打开)。
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
  // 右边栏最宽：窗口的 60%，而且给中间的终端留 360px (左边主机列表开着时也算上，不然顶栏按钮挤到右边栏上)
  function rbMax() {
    const sb = $('#sidebar'), sw = getComputedStyle(sb).position === 'fixed' ? 0 : sb.getBoundingClientRect().width;
    return Math.max(300, Math.min(Math.round(innerWidth * 0.6), Math.round(innerWidth - sw - 360)));
  }
  function applyRb() {
    const on = rbState === 'open' && !!active;
    rightBar.classList.toggle('hidden', !on);
    rightBar.classList.toggle('mobile', isTouch);
    rightRail.classList.toggle('hidden', !(rbState === 'collapsed' && active && !isTouch));
    rightBar.querySelectorAll('.rb-tabs [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === rbTab));
    rightBar.querySelectorAll('.rb-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.tab !== rbTab));
    if (!isTouch && !rbResizing) rightBar.style.width = Math.min(Math.max(+lsGet('sshweb.rbW', 440) || 440, 300), rbMax()) + 'px'; // 拖着的时候不改回去
  }
  // 这个标签里 Agent 干活的目录变了 (会话历史切了对话、Agent 退出了、钩子报了新目录)：右边栏开着、没手动指定目录就重新读
  function rbAgentCwd(s) {
    if (rbState === 'closed' || rb.s !== s || s.projDir) return;
    projLoad();
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
  // 图标：展开箭头是线条图标；文件夹、文件按类型画成彩色的 (参考 Antigravity / VS Code 的资源管理器)
  const svg = (d) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const ICON = { chev: svg('<path d="m9 18 6-6-6-6"/>') };
  const fi = (body, cls = '') => `<svg class="fi${cls}" viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
  // 字母 / 符号图标 (M↓、JS、{} …)
  const T = (t, c, size = 8.6) => fi(`<text x="8" y="${8 + size * 0.36}" text-anchor="middle" font-size="${size}" font-weight="700" fill="${c}" font-family="Segoe UI,Helvetica,Arial,sans-serif">${t}</text>`);
  const G = {
    git: fi('<path d="M8 1.3 14.7 8 8 14.7 1.3 8Z" fill="#f05033"/><path d="M6.2 5.3 10 9.1M8 7.2v3.6" stroke="#fff" stroke-width="1.1" fill="none"/><circle cx="8" cy="10.9" r="1" fill="#fff"/><circle cx="10.2" cy="9.3" r="1" fill="#fff"/>'),
    rss: fi('<circle cx="4" cy="12" r="1.6" fill="#e37933"/><path d="M2.6 7.6a5.8 5.8 0 0 1 5.8 5.8M2.6 3.6a9.8 9.8 0 0 1 9.8 9.8" stroke="#e37933" stroke-width="1.7" fill="none" stroke-linecap="round"/>'),
    node: fi('<path d="M8 1.6 13.6 4.8v6.4L8 14.4 2.4 11.2V4.8Z" fill="none" stroke="#3fb984" stroke-width="1.5"/><path d="M8 5.2v5.6M5.6 6.6 8 5.2l2.4 1.4" stroke="#3fb984" stroke-width="1.3" fill="none"/>'),
    react: fi('<g fill="none" stroke="#61dafb" stroke-width="1"><ellipse cx="8" cy="8" rx="6.6" ry="2.6"/><ellipse cx="8" cy="8" rx="6.6" ry="2.6" transform="rotate(60 8 8)"/><ellipse cx="8" cy="8" rx="6.6" ry="2.6" transform="rotate(120 8 8)"/></g><circle cx="8" cy="8" r="1.3" fill="#61dafb"/>'),
    image: (c) => fi(`<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6" fill="none" stroke="${c}" stroke-width="1.4"/><circle cx="5.6" cy="6.3" r="1.3" fill="${c}"/><path d="m2.6 12.4 3.8-3.8 2.4 2.4 1.8-1.8 3 3" fill="none" stroke="${c}" stroke-width="1.3" stroke-linejoin="round"/>`),
    lines: (c) => fi(`<path d="M3 4h10M3 7h10M3 10h10M3 13h6" stroke="${c}" stroke-width="1.4" stroke-linecap="round"/>`),
    table: fi('<rect x="2" y="2.8" width="12" height="10.4" rx="1.2" fill="none" stroke="#8dc149" stroke-width="1.3"/><path d="M2 6.3h12M2 9.7h12M6.4 2.8v10.4" stroke="#8dc149" stroke-width="1.1"/>'),
    gear: (c) => fi(`<circle cx="8" cy="8" r="2.2" fill="none" stroke="${c}" stroke-width="1.5"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4" stroke="${c}" stroke-width="1.5" stroke-linecap="round"/>`),
    db: fi('<ellipse cx="8" cy="4" rx="5" ry="2" fill="none" stroke="#e8a33d" stroke-width="1.3"/><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" fill="none" stroke="#e8a33d" stroke-width="1.3"/>'),
    zip: fi('<rect x="3" y="1.8" width="10" height="12.4" rx="1.4" fill="none" stroke="#d4a24c" stroke-width="1.3"/><path d="M8 2v1.4M8 4.6V6M8 7.2v1.4" stroke="#d4a24c" stroke-width="1.4"/><rect x="6.6" y="9.4" width="2.8" height="2.6" rx=".6" fill="#d4a24c"/>'),
    lock: fi('<rect x="3.2" y="7" width="9.6" height="7" rx="1.4" fill="#9da5b4"/><path d="M5.3 7V5.2a2.7 2.7 0 0 1 5.4 0V7" fill="none" stroke="#9da5b4" stroke-width="1.5"/>'),
    docker: fi('<path d="M1.6 8.6h11.2c.9 0 1.4-.6 1.6-1.2.4.1.8.4 1 .8-.6.4-1 .5-1.4.5-.9 2.6-3.4 4.6-7 4.6-3.1 0-4.9-1.8-5.4-4.7Z" fill="#2496ed"/><path d="M3.4 6.2h1.8v1.8H3.4zM5.6 6.2h1.8v1.8H5.6zM7.8 6.2h1.8v1.8H7.8zM5.6 4h1.8v1.8H5.6zM7.8 4h1.8v1.8H7.8z" fill="#2496ed"/>'),
    file: fi('<path d="M4 1.8h5.2L12.6 5.2v8.2a.8.8 0 0 1-.8.8H4a.8.8 0 0 1-.8-.8V2.6a.8.8 0 0 1 .8-.8Z" fill="none" stroke="#9da5b4" stroke-width="1.2"/><path d="M9 1.8v3.6h3.6" fill="none" stroke="#9da5b4" stroke-width="1.2"/>'),
  };
  // Markdown：M 加向下的箭头 (字太小画不清，用线条画)
  G.md = (c) => fi(`<path d="M1.6 11.4V4.6l2.7 3.3L7 4.6v6.8M11.6 4.6v6.4M9.4 9l2.2 2.3L13.8 9" fill="none" stroke="${c}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`);
  const EXT = {
    md: G.md('#519aba'), markdown: G.md('#519aba'), mdx: G.md('#f9ac00'),
    json: T('{}', '#cbcb41', 10.5), jsonc: T('{}', '#cbcb41', 10.5), json5: T('{}', '#cbcb41', 10.5),
    js: T('JS', '#cbcb41'), mjs: T('JS', '#cbcb41'), cjs: T('JS', '#cbcb41'), ts: T('TS', '#3178c6'), mts: T('TS', '#3178c6'), cts: T('TS', '#3178c6'),
    jsx: G.react, tsx: G.react, vue: T('V', '#41b883', 11), svelte: T('S', '#ff3e00', 11),
    html: T('&lt;&gt;', '#e37933', 9.5), htm: T('&lt;&gt;', '#e37933', 9.5), css: T('#', '#519aba', 12), scss: T('#', '#f55385', 12), sass: T('#', '#f55385', 12), less: T('#', '#5b8bd8', 12),
    py: T('PY', '#4b8bbe'), go: T('GO', '#00add8'), rs: T('RS', '#dea584'), java: T('J', '#e76f00', 11), kt: T('K', '#a97bff', 11), c: T('C', '#519aba', 11), h: T('H', '#a074c4', 11),
    cpp: T('C++', '#519aba', 7.2), cc: T('C++', '#519aba', 7.2), hpp: T('H++', '#a074c4', 7.2), cs: T('C#', '#9b4f96'), rb: T('RB', '#cc342d'), php: T('php', '#a074c4', 7.2),
    lua: T('LUA', '#51a0cf', 6.8), swift: T('SW', '#f05138'), dart: T('DT', '#00b4ab'),
    sh: T('&gt;_', '#8dc149', 9.5), bash: T('&gt;_', '#8dc149', 9.5), zsh: T('&gt;_', '#8dc149', 9.5), fish: T('&gt;_', '#8dc149', 9.5),
    ps1: T('&gt;_', '#519aba', 9.5), psm1: T('&gt;_', '#519aba', 9.5), bat: T('&gt;_', '#cbcb41', 9.5), cmd: T('&gt;_', '#cbcb41', 9.5),
    yml: T('YML', '#a074c4', 6.8), yaml: T('YML', '#a074c4', 6.8), toml: G.gear('#6d8086'), ini: G.gear('#6d8086'), conf: G.gear('#6d8086'), cfg: G.gear('#6d8086'), properties: G.gear('#6d8086'), env: G.gear('#cbcb41'),
    xml: G.rss, sql: G.db, db: G.db, sqlite: G.db,
    png: G.image('#a074c4'), jpg: G.image('#a074c4'), jpeg: G.image('#a074c4'), gif: G.image('#a074c4'), webp: G.image('#a074c4'), bmp: G.image('#a074c4'), ico: G.image('#cbcb41'), avif: G.image('#a074c4'), svg: G.image('#ffb13b'),
    txt: G.lines('#9da5b4'), log: G.lines('#9da5b4'), rst: G.lines('#9da5b4'), csv: G.table, tsv: G.table, pdf: T('PDF', '#e44d26', 6.8),
    zip: G.zip, gz: G.zip, tgz: G.zip, tar: G.zip, '7z': G.zip, rar: G.zip, xz: G.zip, lock: G.lock,
    exe: G.gear('#9da5b4'), dll: G.gear('#9da5b4'), so: G.gear('#9da5b4'), mod: T('GO', '#00add8'), sum: T('GO', '#6d8086'),
  };
  const NAME = {
    'package.json': G.node, 'package-lock.json': G.node, 'yarn.lock': G.lock, 'pnpm-lock.yaml': G.lock,
    dockerfile: G.docker, '.dockerignore': G.docker, makefile: G.gear('#e37933'), license: T('©', '#cbcb41', 11), 'license.md': T('©', '#cbcb41', 11),
    '.editorconfig': G.gear('#6d8086'), '.npmrc': G.gear('#cb3837'), '.nvmrc': G.node, 'tsconfig.json': T('TS', '#3178c6'),
  };
  const fileIcon = (name) => {
    const n = name.toLowerCase(), ext = (/\.([^.]+)$/.exec(n) || [])[1] || '';
    if (NAME[n]) return NAME[n];
    if (/^\.git(ignore|attributes|modules|keep)?$/.test(n)) return G.git;
    if (/^docker-compose.*\.ya?ml$|^compose\.ya?ml$|^dockerfile\./.test(n)) return G.docker;
    if (/^\.env(\.|$)/.test(n)) return G.gear('#cbcb41');
    if (/^readme/.test(n) && !ext) return T('i', '#519aba', 11);
    return EXT[ext] || G.file;
  };
  // 文件夹：灰色线条，常见的 (src、node_modules、assets …) 右下角带个彩色小圆点
  const DIRC = {
    src: '#e37933', source: '#e37933', app: '#e37933', node_modules: '#8bc34a', assets: '#26a69a', images: '#26a69a', img: '#26a69a', icons: '#26a69a', static: '#26a69a', public: '#26a69a', media: '#26a69a',
    test: '#e44d26', tests: '#e44d26', __tests__: '#e44d26', spec: '#e44d26', e2e: '#e44d26', docs: '#519aba', doc: '#519aba', lib: '#a074c4', vendor: '#a074c4', components: '#26a69a',
    scripts: '#8dc149', bin: '#8dc149', tools: '#8dc149', dist: '#d4a24c', build: '#d4a24c', out: '#d4a24c', target: '#d4a24c', config: '#6d8086', '.config': '#6d8086',
    '.git': '#f05033', '.github': '#9da5b4', '.vscode': '#3794ff', '.claude': '#d97757', data: '#cbcb41', styles: '#f55385', css: '#f55385',
  };
  const FOLDER = '<path d="M1.8 3.4c0-.5.4-.9.9-.9h3.5l1.5 1.6h5.6c.5 0 .9.4.9.9v7.6c0 .5-.4.9-.9.9H2.7a.9.9 0 0 1-.9-.9Z" fill="none" stroke="currentColor" stroke-width="1.2"/>';
  const FOLDER_OPEN = '<path d="M1.8 12.4V3.4c0-.5.4-.9.9-.9h3.5l1.5 1.6h4.9c.5 0 .9.4.9.9v1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M1.8 12.4 3.6 7.4c.1-.4.5-.6.9-.6h10c.4 0 .7.4.6.8l-1.6 4.9c-.1.3-.4.5-.8.5H2.6Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>';
  const folderIcon = (name, open) => {
    const c = DIRC[name.toLowerCase()];
    return fi((open ? FOLDER_OPEN : FOLDER) + (c ? `<circle cx="12.4" cy="12.2" r="3.1" fill="var(--panel)"/><circle cx="12.4" cy="12.2" r="2.2" fill="${c}"/>` : ''), ' dir');
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
          <span class="pf-chev${e.dir ? (open ? ' open' : '') : ' none'}">${ICON.chev}</span>${e.dir ? folderIcon(e.name, open) : fileIcon(e.name)}<span class="pf-name">${esc(e.name)}</span>
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
    if (a === 'collapse') return setRbState(isTouch ? 'closed' : 'collapsed');
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
    const max = rbMax(), move = (ev) => { rightBar.style.width = Math.min(Math.max(w0 - (ev.clientX - x0), 300), max) + 'px'; };
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
