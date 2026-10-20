  // ------------------------------------------------------------ Claude Code 钩子通知 (服务端见 lib/hooks.js、lib/session/hooks.js)
  // 「⋯ 更多」里打开：给当前标签的主机安装 / 卸载钩子。装上后状态更准、推送写得出具体内容、安卓通知上能直接「允许 / 拒绝」
  let hooksEl = null;

  $('#btnHooks').addEventListener('click', () => { if (active?.sid) openHooks(active); });

  function closeHooks() {
    if (!hooksEl) return;
    hooksEl.remove();
    hooksEl = null;
    document.removeEventListener('keydown', hooksKey, true);
  }
  function hooksKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closeHooks();
  }

  async function openHooks(s) {
    closeHooks();
    const el = hooksEl = document.createElement('div');
    const host = s.baseTitle || s.title;
    el.className = 'overlay hooksp';
    el.innerHTML = `<div class="card wide hooks-card">
      <div class="hist-head"><h3>🪝 Claude 钩子通知</h3><button type="button" data-a="close" title="关闭 (Esc)">×</button></div>
      <div class="hk-host"><span class="hk-name"></span> · <span class="hk-state">正在检查…</span></div>
      <div class="hint hk-note">装上后，Claude Code 开始干活、要权限、问问题、做完、出错时会直接告诉 SSH-WEB：主机状态更准，
        推送写得出具体内容（比如「要执行命令：npm test」「做完了：……」），安卓手机的通知上可以直接点「允许 / 拒绝」。<br>
        会改这台主机上的 <code>~/.claude/settings.json</code>（原来的设置和你自己的钩子都保留，第一次安装前备份为
        <code>settings.json.bak-sshweb</code>），并写入 <code>~/.ssh-web/hook.sh</code>。<br>
        装好后新开的 Claude Code 才生效，已经开着的要退出重开。</div>
      <div class="hk-msg"></div>
      <div class="actions"><button type="button" data-a="uninstall" class="hidden">卸载</button><button type="button" data-a="install" class="primary" disabled>安装</button></div>
    </div>`;
    $('.hk-name', el).textContent = host;
    const state = $('.hk-state', el), msg = $('.hk-msg', el), bIn = $('[data-a=install]', el), bUn = $('[data-a=uninstall]', el);
    const refresh = async () => {
      try {
        const r = await api('POST', '/api/hooks/status', { sid: s.sid });
        if (hooksEl !== el) return;
        state.textContent = r.installed ? '✅ 已安装' : r.partial ? '⚠️ 只装了一部分，建议重新安装' : '未安装';
        bIn.textContent = r.installed || r.partial ? '重新安装' : '安装';
        bIn.disabled = false;
        bUn.classList.toggle('hidden', !(r.installed || r.partial || r.scriptOk));
      } catch (e) {
        if (hooksEl === el) { state.textContent = '检查失败'; msg.textContent = e.message; bIn.disabled = false; }
      }
    };
    const run = async (what) => {
      const ask = what === 'install'
        ? `要在「${host}」上安装 Claude Code 钩子吗？\n会修改 ~/.claude/settings.json（第一次安装前备份为 settings.json.bak-sshweb），并写入 ~/.ssh-web/hook.sh。`
        : `要从「${host}」上卸载 SSH-WEB 的 Claude Code 钩子吗？\n只删 SSH-WEB 加的条目，其他设置不动。`;
      if (!confirm(ask)) return;
      bIn.disabled = true;
      msg.textContent = what === 'install' ? '正在安装…' : '正在卸载…';
      try {
        const r = await api('POST', `/api/hooks/${what}`, { sid: s.sid });
        if (hooksEl !== el) return;
        msg.textContent = what === 'install'
          ? `已安装${r.backup ? `（原来的设置备份在 ${r.backup}）` : ''}。新开的 Claude Code 生效，已经开着的要退出重开。`
          : '已卸载。已经开着的 Claude Code 退出重开后就不再报事件。';
      } catch (e) {
        if (hooksEl === el) msg.textContent = (what === 'install' ? '安装失败：' : '卸载失败：') + e.message;
      }
      refresh();
    };
    el.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (e.target === el || a === 'close') closeHooks();
      else if (a === 'install' || a === 'uninstall') run(a);
    });
    document.addEventListener('keydown', hooksKey, true);
    document.body.appendChild(el);
    refresh();
  }
