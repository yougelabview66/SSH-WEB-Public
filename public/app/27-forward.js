  // ------------------------------------------------------------ 端口预览 (服务端见 lib/forward.js)
  // 目标主机上本机才能访问的网页 (Claude Code 跑起来的开发服务等) 借这个标签的 SSH 连接转发，在浏览器新标签页里打开。
  // 入口在顶栏「⋯ 更多」的菜单里。
  // 默认隔离 (沙箱)；某个端口的应用因此报错时可以打开「完整模式」，每台设备按端口记住
  const fwdFull = (() => { try { return JSON.parse(localStorage.getItem('sshweb.fwdFull')) || {}; } catch { return {}; } })();
  const saveFwdFull = () => { try { localStorage.setItem('sshweb.fwdFull', JSON.stringify(fwdFull)); } catch {} };
  let fwdEl = null;

  $('#btnFwd').addEventListener('click', () => { if (active?.sid) openForward(active); });

  function closeForward() {
    if (!fwdEl) return;
    fwdEl.remove();
    fwdEl = null;
    document.removeEventListener('keydown', fwdKey, true);
  }
  function fwdKey(e) {
    if (e.key !== 'Escape' || fwdEl?.classList.contains('tab-away')) return; // 在别的标签上藏着：不管
    e.preventDefault();
    e.stopPropagation(); // Esc 只关面板，不发给终端
    closeForward();
  }

  async function openForward(s) {
    closeForward();
    const el = fwdEl = document.createElement('div');
    el.className = 'overlay fwd tab-panel';
    el.dataset.tab = s.id; // 手机上同性能监控 (见 tabPanels)
    el.innerHTML = `<div class="card wide fwd-card">
      <div class="hist-head"><h3>🌐 端口预览</h3><button type="button" data-a="close" title="关闭 (Esc)" aria-label="关闭">×</button></div>
      <div class="hint">目标主机上本机才能访问的网页（比如 Claude Code 跑起来的开发服务），通过这个标签的 SSH 连接转发，在浏览器新标签页里打开。</div>
      <div class="fwd-list"><div class="sftp-msg">正在查看目标主机上在监听的端口…</div></div>
      <form class="fwd-add" autocomplete="off">
        <input type="number" min="1" max="65535" inputmode="numeric" placeholder="其他端口，如 5173">
        <button type="submit" class="primary">打开</button>
      </form>
      <div class="fwd-msg"></div>
      <div class="hint fwd-note">默认隔离：预览的网页拿不到 SSH-WEB 的登录状态、碰不到你的主机，但它自己的 localStorage / cookie 用不了。
        应用因此报错时可以给这个端口勾上「完整模式」——那样预览的网页能以你的身份操作 SSH-WEB（开会话、发命令），
        只对自己写的、信得过依赖的项目打开。<br>
        资源用绝对路径（以 / 开头）的开发服务要设置前缀，例如 Vite：<code>npx vite --base 前缀/</code>，前缀写在每个端口下面。</div>
    </div>`;
    const list = $('.fwd-list', el), msg = $('.fwd-msg', el), input = $('.fwd-add input', el);
    el.addEventListener('click', (e) => {
      if (e.target === el || e.target.closest('[data-a=close]')) return closeForward();
      const row = e.target.closest('.fwd-row');
      if (row && e.target.closest('[data-open]')) openPort(s, +row.dataset.port, msg);
    });
    el.addEventListener('change', (e) => {
      const row = e.target.closest('.fwd-row');
      if (!row || !e.target.matches('[data-full]')) return;
      if (e.target.checked) fwdFull[row.dataset.port] = true; else delete fwdFull[row.dataset.port];
      saveFwdFull();
    });
    $('.fwd-add', el).addEventListener('submit', (e) => {
      e.preventDefault();
      const port = parseInt(input.value, 10);
      if (!(port >= 1 && port <= 65535)) { msg.textContent = '端口要在 1–65535 之间'; return; }
      openPort(s, port, msg);
    });
    document.addEventListener('keydown', fwdKey, true);
    document.body.appendChild(el);
    if (!isTouch) input.focus({ preventScroll: true });
    try {
      const { ports } = await api('POST', '/api/forward/ports', { sid: s.sid });
      if (fwdEl !== el) return;
      const shown = ports.filter((x) => x.port !== 22); // SSH 本身不用预览
      list.innerHTML = shown.length ? '' : '<div class="sftp-msg">目标主机上没找到在监听的端口，可以在下面直接输入端口</div>';
      for (const x of shown) {
        const row = document.createElement('div');
        row.className = 'fwd-row';
        row.dataset.port = x.port;
        row.innerHTML = `<div class="fwd-main"><b>${x.port}</b> <span class="fwd-meta"></span><div class="fwd-prefix"><code></code></div></div>
          <label class="check" title="不隔离：应用能用 localStorage / cookie，也能以你的身份操作 SSH-WEB"><input type="checkbox" data-full> 完整模式</label>
          <button type="button" class="primary" data-open>打开</button>`;
        $('.fwd-meta', row).textContent = [x.proc, x.addr].filter(Boolean).join(' · ');
        $('code', row).textContent = x.prefix;
        $('[data-full]', row).checked = !!fwdFull[x.port];
        list.appendChild(row);
      }
    } catch (e) {
      if (fwdEl === el) list.innerHTML = `<div class="sftp-msg">${esc(e.message)}，可以在下面直接输入端口</div>`;
    }
  }

  // 先同步开一个空白窗口 (等接口回来再开会被浏览器当成弹窗拦掉)，拿到地址再跳过去；拦掉了就在面板里给个链接
  async function openPort(s, port, msg) {
    const w = window.open('', '_blank');
    msg.textContent = '';
    try {
      const r = await api('POST', '/api/forward', { sid: s.sid, port, full: !!fwdFull[port] });
      if (w) {
        w.opener = null; // 预览的网页不能反过来操作 SSH-WEB 这个页面
        w.location.href = r.url;
      } else {
        msg.innerHTML = `浏览器拦住了新窗口，<a target="_blank" rel="noopener noreferrer"></a>`;
        const a = $('a', msg);
        a.href = r.url;
        a.textContent = `点这里打开 ${port} 端口的预览`;
      }
      if (!fwdEl?.querySelector(`.fwd-row[data-port="${port}"]`)) msg.append(document.createTextNode(` 前缀：${r.prefix}`));
    } catch (e) {
      w?.close();
      msg.textContent = '打不开：' + e.message;
    }
  }
