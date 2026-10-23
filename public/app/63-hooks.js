  // ------------------------------------------------------------ Agent 钩子通知 (服务端见 lib/hooks.js、lib/session/hooks.js)
  // 「⋯ 更多」里打开：给当前标签的主机按 Agent 安装 / 卸载钩子 (Claude Code / Grok / Codex / Gemini CLI / Antigravity / OpenCode)。
  // 装上后状态更准、推送写得出具体内容，Claude Code 要权限时安卓通知上能直接「允许 / 拒绝」
  let hooksEl = null;

  $('#btnHooks').addEventListener('click', () => { if (active?.sid) openHooks(active); });

  function closeHooks() {
    if (!hooksEl) return;
    hooksEl.remove();
    hooksEl = null;
    document.removeEventListener('keydown', hooksKey, true);
  }
  function hooksKey(e) {
    if (e.key !== 'Escape' || hooksEl?.classList.contains('tab-away')) return; // 在别的标签上藏着：不管
    e.preventDefault();
    e.stopPropagation();
    closeHooks();
  }

  // 每个 Agent 装好后还要做的事 / 和 Claude Code 不一样的地方
  const HOOK_TIPS = {
    claude: '要权限时安卓通知上能直接「允许 / 拒绝」',
    codex: '装好后要在 Codex 里输入 /hooks 批准一次才生效',
    gemini: '会先回 {} 给 Gemini（它要求的）',
    antigravity: '用工具前回「ask」：照你自己的权限设置问你，不会自动允许',
    opencode: '装的是插件（plugins 目录里的 sshweb-status.js）',
  };

  async function openHooks(s) {
    closeHooks();
    const el = hooksEl = document.createElement('div');
    const host = s.baseTitle || s.title;
    el.className = 'overlay hooksp tab-panel';
    el.dataset.tab = s.id; // 手机上同性能监控 (见 tabPanels)
    el.innerHTML = `<div class="card wide hooks-card">
      <div class="hist-head"><h3>🔔 钩子通知</h3><button type="button" data-a="close" title="关闭 (Esc)" aria-label="关闭">×</button></div>
      <div class="hk-host"><span class="hk-name"></span> · <span class="hk-script">正在检查…</span></div>
      <div class="hint hk-note">装上后，Agent 开始干活、要权限、问问题、做完、出错时会直接告诉 SSH-WEB：主机状态更准，
        推送写得出具体内容（比如「要执行命令：npm test」「做完了：……」）。<br>
        会改这台主机上对应 Agent 的设置（原来的设置和你自己的钩子都保留，第一次安装前备份为 <code>…bak-sshweb</code>），
        并写入 <code class="hk-sname">~/.ssh-web/hook.sh</code>。装好后新开的 Agent 才生效，已经开着的要退出重开。<br>
        标「未实测」的是照着 Orca 的做法写的，还没在真的 Agent 上试过，有问题把 <code>~/.cache/ssh-web/hook.log</code> 发给我。</div>
      <div class="hk-rows"></div>
      <div class="hk-msg"></div>
    </div>`;
    $('.hk-name', el).textContent = host;
    const rows = $('.hk-rows', el), msg = $('.hk-msg', el), scriptEl = $('.hk-script', el);
    let busy = false, sname = 'hook.sh'; // Windows 主机装的是 hook.ps1 (PowerShell 版)
    const refresh = async () => {
      try {
        const r = await api('POST', '/api/hooks/status', { sid: s.sid });
        if (hooksEl !== el) return;
        sname = r.win ? 'hook.ps1' : 'hook.sh';
        $('.hk-sname', el).textContent = `~/.ssh-web/${sname}`;
        scriptEl.textContent = !r.scriptOk ? '还没装钩子脚本' : r.outdated ? '钩子脚本有更新' : '钩子脚本已装好';
        // 主机上有的 Agent 排前面 (Claude Code 一直在第一个)
        const list = [...r.agents].sort((a, b) => (b.id === 'claude') - (a.id === 'claude') || b.present - a.present);
        rows.innerHTML = list.map((a) => {
          const on = a.installed || a.partial;
          const state = a.error ? `⚠️ ${a.error}`
            : a.installed ? ((r.outdated || a.outdated) ? '✅ 已安装 · 钩子脚本有更新，点「重新安装」' : '✅ 已安装')
              : a.partial ? '⚠️ 只装了一部分，建议重新安装' : a.present ? '未安装' : '未安装 · 主机上没找到';
          return `<div class="hk-row${a.present || on ? '' : ' absent'}" data-agent="${esc(a.id)}" data-file="${esc(a.file)}" data-name="${esc(a.name)}">
            <div class="hk-info"><div><b>${esc(a.name)}</b>${a.tested ? '' : '<span class="hk-tag">未实测</span>'}</div>
              <div class="hk-state">${esc(state)}</div>
              <div class="hk-tip">${esc(a.file)}${HOOK_TIPS[a.id] ? ' · ' + esc(HOOK_TIPS[a.id]) : ''}</div></div>
            <div class="hk-btns">${on ? '<button type="button" data-a="uninstall">卸载</button>' : ''}
              <button type="button" data-a="install"${on ? '' : ' class="primary"'}>${on ? '重新安装' : '安装'}</button></div>
          </div>`;
        }).join('');
      } catch (e) {
        if (hooksEl === el) { scriptEl.textContent = '检查失败'; msg.textContent = e.message; }
      }
    };
    const run = async (what, row) => {
      if (busy) return;
      const { agent, file, name } = row.dataset;
      const ask = what === 'install'
        ? `要在「${host}」上安装 ${name} 的钩子吗？\n会修改 ${file}${agent === 'opencode' || agent === 'grok' ? '' : '（第一次安装前备份为 .bak-sshweb）'}，并写入 ~/.ssh-web/${sname}。`
        : `要从「${host}」上卸载 SSH-WEB 的 ${name} 钩子吗？\n只删 SSH-WEB 加的条目，其他设置不动。`;
      if (!confirm(ask)) return;
      busy = true;
      rows.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      msg.textContent = what === 'install' ? `正在安装 ${name}…` : `正在卸载 ${name}…`;
      try {
        const r = await api('POST', `/api/hooks/${what}`, { sid: s.sid, agent });
        if (hooksEl !== el) return;
        msg.textContent = what === 'install'
          ? `${name} 已安装${r.backup ? `（原来的设置备份在 ${r.backup}）` : ''}。新开的 ${name} 生效，已经开着的要退出重开。${agent === 'codex' ? '在 Codex 里输入 /hooks 批准一次。' : ''}`
          : `${name} 已卸载。已经开着的退出重开后就不再报事件。${r.scriptRemoved ? `别的 Agent 都没装了，${sname} 也删了。` : ''}`;
      } catch (e) {
        if (hooksEl === el) msg.textContent = (what === 'install' ? '安装失败：' : '卸载失败：') + e.message;
      }
      busy = false;
      refresh();
    };
    el.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (e.target === el || a === 'close') closeHooks();
      else if (a === 'install' || a === 'uninstall') run(a, e.target.closest('.hk-row'));
    });
    document.addEventListener('keydown', hooksKey, true);
    document.body.appendChild(el);
    if (!isTouch) $('[data-a=close]', el).focus({ preventScroll: true }); // 焦点离开下方输入框：打的字、回车不会发到后面的终端
    refresh();
  }
