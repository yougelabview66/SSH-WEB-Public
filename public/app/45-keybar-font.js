  // ------------------------------------------------------------ 自定义按键栏
  const KEY_DEFS = {
    history: { label: '历史', k: 'history' }, esc: { label: 'Esc', k: 'esc' }, tab: { label: 'Tab', k: 'tab' },
    shift: { label: 'Shift', mod: 'shift' }, ctrl: { label: 'Ctrl', mod: 'ctrl' }, alt: { label: 'Alt', mod: 'alt' },
    up: { label: '↑', k: 'up' }, down: { label: '↓', k: 'down' }, left: { label: '←', k: 'left' }, right: { label: '→', k: 'right' },
    bs: { label: '⌫', k: 'bs' }, home: { label: 'Home', k: 'home' }, end: { label: 'End', k: 'end' },
    pgup: { label: 'PgUp', k: 'pgup' }, pgdn: { label: 'PgDn', k: 'pgdn' },
    '^c': { label: '^C', k: '^c', desc: '中断' }, '^d': { label: '^D', k: '^d', desc: '退出' },
    '^z': { label: '^Z', k: '^z', desc: '挂起' }, '^l': { label: '^L', k: '^l', desc: '清屏' },
    copy: { label: '复制', k: 'copy' }, paste: { label: '粘贴', k: 'paste' },
    // 以下默认不显示，可以在设置里添加
    enter: { label: 'Enter', k: 'enter', desc: '回车' },
    escesc: { label: 'Esc Esc', k: 'escesc', desc: 'Claude Code 撤回' },
    '^b': { label: '^B', k: '^b', desc: 'tmux 前缀' }, '^r': { label: '^R', k: '^r', desc: '搜索历史' },
    '^a': { label: '^A', k: '^a', desc: '行首' }, '^e': { label: '^E', k: '^e', desc: '行尾' },
    '^u': { label: '^U', k: '^u', desc: '删到行首' }, '^w': { label: '^W', k: '^w', desc: '删一个词' },
    '^k': { label: '^K', k: '^k', desc: '删到行尾' },
  };
  for (let i = 1; i <= 12; i++) KEY_DEFS['f' + i] = { label: 'F' + i, k: 'f' + i };
  for (const ch of ['|', '/', '-', '~', '\\', '*', '&', '>', '<', '$', "'", '"', ':', ';', '_', '=', '`', '!', '#', '@', '%', '(', ')', '[', ']', '{', '}']) {
    KEY_DEFS['t:' + ch] = { label: ch, t: ch };
  }
  // 默认 = 原来的按键和顺序
  const DEFAULT_KEYS = ['history', 'esc', 'tab', 'shift', 'ctrl', 'alt', 'up', 'down', 'left', 'right', 'bs',
    'home', 'end', 'pgup', 'pgdn', 't:|', 't:/', 't:-', 't:~', '^c', '^d', '^z', '^l', 'copy', 'paste'];
  let keybar = { keys: DEFAULT_KEYS.slice(), custom: {} };

  // 自定义按键内容的转义: \r \n \t \e \\ \xHH \uHHHH
  function decodeSeq(str) {
    return str.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[rnte\\])/g, (m, c) => {
      if (c[0] === 'x' || c[0] === 'u') return String.fromCharCode(parseInt(c.slice(1), 16));
      return { r: '\r', n: '\n', t: '\t', e: '\x1b', '\\': '\\' }[c];
    });
  }

  const keyDef = (id, cfg = keybar) => KEY_DEFS[id] || (cfg.custom[id] && { label: cfg.custom[id].label, seq: cfg.custom[id].seq, desc: cfg.custom[id].seq });

  function renderKeyBar() {
    const box = $('#mobileBar .mkeys');
    box.innerHTML = '';
    for (const id of keybar.keys) {
      const d = keyDef(id);
      if (!d) continue;
      const b = document.createElement('button');
      b.textContent = d.label;
      if (d.k) b.dataset.k = d.k;
      else if (d.t) b.dataset.t = d.t;
      else if (d.mod) { b.dataset.mod = d.mod; b.classList.toggle('on', !!mods[d.mod]); }
      else if (d.seq != null) { b.dataset.seq = decodeSeq(d.seq); b.title = d.seq; }
      box.appendChild(b);
    }
    const set = document.createElement('button');
    set.className = 'kset';
    set.dataset.a = 'kset';
    set.title = '自定义按键栏';
    set.textContent = '⚙';
    box.appendChild(set);
  }

  async function loadKeybar() {
    try {
      const st = await api('GET', '/api/settings');
      if (st.keybar && Array.isArray(st.keybar.keys)) keybar = { keys: st.keybar.keys, custom: st.keybar.custom || {} };
    } catch {}
    renderKeyBar();
  }

  let keyEdit = null;
  function openKeysEditor() {
    keyEdit = { keys: keybar.keys.slice(), custom: { ...keybar.custom } };
    $('#kcLabel').value = '';
    $('#kcSeq').value = '';
    renderKeysEditor();
    mInput.blur();
    $('#keysPanel').classList.remove('hidden');
  }

  function renderKeysEditor() {
    const cur = $('#keysCur');
    cur.innerHTML = '';
    keyEdit.keys.forEach((id, i) => {
      const d = keyDef(id, keyEdit);
      if (!d) return;
      const row = document.createElement('div');
      row.className = 'krow';
      row.innerHTML = `<span class="kl"></span><span class="kd"></span>
        <button data-op="up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button data-op="down" ${i === keyEdit.keys.length - 1 ? 'disabled' : ''}>↓</button>
        <button data-op="del">✕</button>`;
      $('.kl', row).textContent = d.label;
      $('.kd', row).textContent = d.desc || '';
      row.addEventListener('click', (e) => {
        const op = e.target.dataset.op;
        const k = keyEdit.keys;
        if (op === 'up' && i > 0) [k[i - 1], k[i]] = [k[i], k[i - 1]];
        else if (op === 'down' && i < k.length - 1) [k[i + 1], k[i]] = [k[i], k[i + 1]];
        else if (op === 'del') k.splice(i, 1);
        else return;
        renderKeysEditor();
      });
      cur.appendChild(row);
    });
    const avail = $('#keysAvail');
    avail.innerHTML = '';
    const ids = [...DEFAULT_KEYS, ...Object.keys(KEY_DEFS), ...Object.keys(keyEdit.custom)];
    for (const id of [...new Set(ids)]) {
      if (keyEdit.keys.includes(id)) continue;
      const d = keyDef(id, keyEdit);
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = d.label;
      b.title = d.desc || '';
      b.onclick = () => { keyEdit.keys.push(id); renderKeysEditor(); };
      avail.appendChild(b);
    }
  }

  $('#keysCustom').addEventListener('submit', (e) => {
    e.preventDefault();
    const label = $('#kcLabel').value.trim();
    const seq = $('#kcSeq').value;
    if (!label || !seq) return alert('请填写名称和发送内容');
    const id = 'c:' + Math.random().toString(36).slice(2, 10);
    keyEdit.custom[id] = { label, seq };
    keyEdit.keys.push(id);
    $('#kcLabel').value = '';
    $('#kcSeq').value = '';
    renderKeysEditor();
  });
  $('#keysReset').addEventListener('click', () => {
    if (!confirm('恢复默认按键和顺序？自定义按键也会被删除。')) return;
    keyEdit = { keys: DEFAULT_KEYS.slice(), custom: {} };
    renderKeysEditor();
  });
  $('#keysCancel').addEventListener('click', () => $('#keysPanel').classList.add('hidden'));
  $('#keysSave').addEventListener('click', async () => {
    // 不在按键栏里的自定义按键一起删除
    const custom = {};
    for (const id of keyEdit.keys) if (keyEdit.custom[id]) custom[id] = keyEdit.custom[id];
    try {
      await api('PUT', '/api/settings/keybar', { keys: keyEdit.keys, custom });
      keybar = { keys: keyEdit.keys, custom };
      clearMods();
      renderKeyBar();
      $('#keysPanel').classList.add('hidden');
    } catch (err) { alert('保存失败：' + err.message); }
  });
  $('#keysPanel').addEventListener('mousedown', (e) => { if (e.target.id === 'keysPanel') $('#keysPanel').classList.add('hidden'); });

  // ------------------------------------------------------------ 终端字体大小 (手机双指捏合 / 侧边栏 A- A+)
  const FONT_MIN = 8;
  const FONT_MAX = 28;
  const defaultFont = () => (window.innerWidth < 760 ? 12 : 14);
  let fontSize = (() => { try { return parseInt(localStorage.getItem('sshweb.fontSize'), 10) || defaultFont(); } catch { return defaultFont(); } })();

  function setFontSize(n, save = true) {
    n = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n)));
    if (n !== fontSize) {
      fontSize = n;
      for (const x of sessions) x.term.options.fontSize = n;
      if (active) syncSize(active);
    }
    if (save) { try { localStorage.setItem('sshweb.fontSize', String(n)); } catch {} }
    $('#fontLabel').textContent = String(fontSize);
  }
  $('#fontDec').addEventListener('click', () => setFontSize(fontSize - 1));
  $('#fontInc').addEventListener('click', () => setFontSize(fontSize + 1));

  function fontToast(s, text, ms) {
    let t = s.box.querySelector('.font-toast');
    if (!t) { t = document.createElement('div'); t.className = 'font-toast'; s.box.appendChild(t); }
    t.textContent = text;
    clearTimeout(t.timer);
    t.timer = setTimeout(() => t.remove(), ms || 800);
  }

  function updateMobileBar() {
    $('#mobileBar').classList.toggle('hidden', !(isTouch && active));
    $('#deskBar').classList.toggle('hidden', !(!isTouch && active && deskOn));
    $('#btnInput').classList.toggle('hidden', !(!isTouch && active));
    $('#btnInput').classList.toggle('on', deskOn);
    syncDeskMode();
    applyDeskPos();
    updateHostFloat();
    syncLsBars();
    if (cmdMode && cmdMode.s !== active) setCmdMode(false);
    // 每个标签有自己的草稿
    const draft = active?.draft || '';
    if (dInput.value !== draft) { dInput.value = draft; autosizeDesk(); }
    if (mText() !== draft) setMobileText(draft);
  }

  // iOS 键盘弹出时不会缩小页面，用 visualViewport 调整高度，让输入栏始终在键盘上方
  // 只在键盘弹出 (可视区域比页面矮) 时固定高度，其余时候交回给 CSS 的 100%，不会停在过时的高度上
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const onVV = () => {
      const h = Math.round(vv.height), full = document.documentElement.clientHeight;
      // 双指放大页面 (电脑触控板、手机) 时可视区域也会变小，那不是键盘弹出，不固定高度
      const want = h > 0 && h < full - 1 && vv.scale <= 1.01 ? h + 'px' : '';
      if (app.style.height !== want) app.style.height = want;
      window.scrollTo(0, 0);
      if (active) {
        active.fit.fit();
        active.term.refresh(0, active.term.rows - 1);
      }
    };
    vv.addEventListener('resize', onVV);
    // 从后台回来 / 旋转屏幕：键盘可能在后台收起了，浏览器却没通知 (或报的是过时的高度)，
    // 主动重新算几次 (有的浏览器回到前台后过一会儿才更新可视区域)
    // 最后按这台设备的尺寸同步一次：你回到这台设备上用了，排版就按它的
    const resync = () => { onVV(); setTimeout(onVV, 150); setTimeout(() => { onVV(); if (active) syncSize(active); }, 500); };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) resync(); });
    window.addEventListener('pageshow', resync);
    window.addEventListener('focus', resync);
    window.addEventListener('orientationchange', resync);
  }

