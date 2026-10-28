  // ------------------------------------------------------------ 通用对话框
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let dialogQueue = Promise.resolve();
  let curDialog = null;

  // 同一会话的验证在其他设备上完成时，关闭本地弹窗
  function dismissDialog(tag) {
    if (curDialog && curDialog.tag === tag) curDialog.dismiss();
  }

  // buttons: [{ label, value, cls, submit }]，返回 { value, form }；被 dismiss 时返回 { dismissed: true }。
  // onBody(body, finish)：内容里自己的按钮 (列表里点一行等) 也能关掉对话框。内容区是同一个元素，点击用 body.onclick
  // (关掉时清掉)，不要 addEventListener：不然上一个对话框的监听留着，点一下会去关上一个对话框
  function dialog(title, html, buttons, tag, onBody) {
    const run = () => new Promise((resolve) => {
      const dlg = $('#dialog');
      const f = $('#dialogForm');
      $('#dialogTitle').textContent = title;
      $('#dialogBody').innerHTML = html;
      const acts = $('#dialogActions');
      acts.innerHTML = '';
      const finish = (value, dismissed) => {
        curDialog = null;
        $('#dialogBody').onclick = null;
        dlg.classList.add('hidden');
        f.onsubmit = null;
        document.removeEventListener('keydown', onKey, true);
        resolve({ value, form: f, dismissed });
        // 调用方读完填的值后清掉内容：验证码 / 密码不留在页面里，密码框也不留 (手机上页面里有密码框时，
        // 点任何输入框都会弹「密码」填充栏)；已经打开了下一个对话框就不动
        setTimeout(() => { if (!curDialog) $('#dialogBody').innerHTML = ''; });
      };
      curDialog = { tag, dismiss: () => finish(null, true) };
      const onKey = (e) => {
        if (e.key === 'Escape' && !dlg.classList.contains('hidden')) {
          e.stopPropagation();
          finish(buttons.find((b) => b.cancel)?.value ?? null);
        }
      };
      buttons.forEach((b) => {
        const el = document.createElement('button');
        el.type = b.submit ? 'submit' : 'button';
        el.textContent = b.label;
        if (b.cls) el.className = b.cls;
        if (!b.submit) el.onclick = () => finish(b.value);
        acts.appendChild(el);
      });
      f.onsubmit = (e) => {
        e.preventDefault();
        finish(buttons.find((b) => b.submit)?.value);
      };
      document.addEventListener('keydown', onKey, true);
      onBody?.($('#dialogBody'), finish);
      dlg.classList.remove('hidden');
      // 焦点：有输入框给输入框；没有就给主按钮。危险的按钮 (结束会话、仍然打开…) 不默认聚焦，免得电脑上一个回车就执行了，
      // 只有危险按钮时聚焦取消
      (f.querySelector('input') || f.querySelector('#dialogActions button.primary') || f.querySelector('#dialogActions button:not(.danger)'))?.focus();
    });
    const p = dialogQueue.then(run);
    dialogQueue = p.catch(() => {});
    return p;
  }

  // keyboard-interactive / TOTP 验证码
  async function promptDialog(m, tag) {
    let html = '';
    if (m.instructions) html += `<p class="muted" style="white-space: pre-line">${esc(m.instructions)}</p>`;
    m.prompts.forEach((pr, i) => {
      const isCode = /code|otp|token|verif|验证/i.test(pr.prompt);
      html += `<label>${esc(pr.prompt)}<input name="a${i}" type="${pr.echo ? 'text' : 'password'}" autocomplete="${isCode ? 'one-time-code' : 'off'}"${isCode ? ' inputmode="numeric"' : ''}></label>`;
    });
    const r = await dialog(m.title || '服务器要求验证', html, [
      { label: '取消', value: false, cancel: true },
      { label: '确定', value: true, cls: 'primary', submit: true },
    ], tag);
    if (r.dismissed) return undefined;
    if (!r.value) return null;
    return m.prompts.map((_, i) => r.form.elements['a' + i].value);
  }

  // 常驻会话：有没人接着的会话时问接哪个 (同会话历史的样子)。点一行或「接上」接上，「删除」点两下结束它
  // (里面的程序会关掉)，「新建会话」开新的，「退出」关掉这个标签。还有别的连接的 (别的标签、断电断网前留下的旧连接等)
  // 标明在哪，点它先问要不要强制连接：是 / 切到那个标签 / 否 (回到列表)；点「删除」问要不要强制删除。都在同一个弹窗里换内容，
  // 不关掉重开：删除时调 onKill(id, force) 告诉服务端，弹窗留着，服务端结束后再发来的列表原地刷新 (dpOpen.update)。
  // 返回 { id } / { id, share } / { id: '' } 新建 / { go: 标签 } 切过去 / null 退出；在别的设备上答了返回 undefined
  let dpOpen = null; // 开着 (或者排着队) 的常驻会话选择框 { tag, update }
  async function daemonPickDialog(m, tag, onKill) {
    let cur = m, body = null, confirming = null;
    const acts = () => $('#dialogActions');
    // 带上是哪个标签 (几个标签同时问时分得清) 和主机上守护程序的版本
    const pickTitle = () => `接上常驻会话${cur.tab ? `（${cur.tab}）` : ''}${cur.ver ? ` · sshwebd v${cur.ver}` : ''}`;
    // 每一行怎么认出是哪个会话：命过名的「主机名-名字」，没有就会话名称 / 最新消息 / 路径 / 会话号
    // (同「💬 会话历史」卡片：没标题时拿第一句话当标题)
    const idText = (x) => x.tab || x.name || x.title || x.msg || x.cwd || `会话 ${x.id}`;
    // 每行 (同「💬 会话历史」卡片的样式)：会话名称 → 最新一次对话内容 → 项目工作路径 → 工作时间；
    // 胶囊跟在工作时间后面 (与这行文字居中对齐)：命过名显示会话自己的「主机名-名字」，没命过显示接上后默认的「主机名-序号」
    const listHtml = () => {
      const list = cur.sessions || [];
      const rows = list.map((x) => `<div class="as-row dp-row${x.busy ? ' dp-busy' : ''}" data-id="${esc(x.id)}">
        <div class="as-main"><div class="as-title">${esc(x.name || x.title || x.msg || x.cwd || `会话 ${x.id}`)}</div>
          ${x.msg && (x.name || x.title) ? `<div class="as-prompt">${esc(x.msg)}</div>` : ''}
          ${(x.name || x.title || x.msg) && x.cwd ? `<div class="as-prompt">${esc(x.cwd)}</div>` : ''}<div class="as-meta dp-when"><span class="dp-when-t">${esc(x.when)}</span>${x.tab || x.tabDef ? `<span class="dp-name" title="${esc(x.tab || x.tabDef)}">${esc(x.tab || x.tabDef)}</span>` : ''}</div>
          ${x.busy ? `<div class="dp-used">正在${esc(x.busy)}里使用中</div>` : ''}</div>
        <div class="as-btns"><button type="button" data-a="pick" class="primary">接上</button><button type="button" data-a="kill">删除</button></div></div>`).join('');
      return (cur.note ? `<p class="dp-note">${esc(cur.note)}</p>` : '')
        + (rows ? '<p class="muted">这台主机上有还在运行的常驻会话，点一个接上，或者新建一个：</p>'
          : '<p class="muted">这台主机上没有别的常驻会话了：点「新建会话」开一个，或者「退出」关掉这个标签。</p>')
        + `<div class="as-list dp-list">${rows}</div>`;
    };
    const showList = () => {
      confirming = null;
      if (!body) return;
      body.innerHTML = listHtml();
      acts().classList.remove('hidden');
      $('#dialogTitle').textContent = pickTitle();
    };
    // 还有别的连接：同一个弹窗里换成确认，问要不要强制连接 (这个浏览器里就有接着它的标签的话可以直接切过去)
    const showConfirm = (x) => {
      const other = sessions.find((y) => !y.closed && y.remoteId && x.tags?.includes(y.remoteId));
      confirming = { x, other };
      $('#dialogTitle').textContent = '这个会话还有别的连接';
      body.innerHTML = `<p><b>${esc(idText(x))}</b> 还有连接：正在${esc(x.busy)}里使用中。要强制连接吗？</p>
        <p class="muted">强制连接后两边显示同一个终端，在哪边打字都一样；断电、断网前留下的旧连接已经没人在用，连上没有影响。</p>
        <div class="actions dp-confirm"><button type="button" data-c="back">否</button>${other ? '<button type="button" data-c="go">切到那个标签</button>' : ''}<button type="button" data-c="share" class="primary">是，强制连接</button></div>`;
      acts().classList.add('hidden');
      body.querySelector('[data-c=share]').focus();
    };
    // 还有连接的会话点「删除」：同一个弹窗里问要不要强制删除
    const showKillConfirm = (x) => {
      confirming = { x, kill: true };
      $('#dialogTitle').textContent = '这个会话还有连接';
      body.innerHTML = `<p><b>${esc(idText(x))}</b> 还有连接：正在${esc(x.busy)}里使用中。要强制删除吗？</p>
        <p class="muted">删除会结束这个会话，里面运行的程序 (比如 Claude Code) 会关掉，接着它的标签也会一起关掉。</p>
        <div class="actions dp-confirm"><button type="button" data-c="back">否</button><button type="button" data-c="kill" class="danger">是，强制删除</button></div>`;
      acts().classList.add('hidden');
      body.querySelector('[data-c=back]').focus();
    };
    // 删除发给服务端：弹窗不关，这一行显示「正在结束…」，等服务端发来新列表
    const kill = (id, force) => {
      onKill(id, force);
      if (confirming) showList();
      const row = [...body.querySelectorAll('.dp-row')].find((r) => r.dataset.id === id);
      const btn = row?.querySelector('[data-a=kill]');
      if (btn) { btn.disabled = true; btn.textContent = '正在结束…'; row.classList.add('dp-killing'); }
    };
    // 确认的时候按 Esc：回到列表 (不是退出)。window 上的捕获比对话框挂在 document 上的先收到
    const onEsc = (e) => { if (e.key === 'Escape' && confirming) { e.stopPropagation(); e.preventDefault(); showList(); } };
    window.addEventListener('keydown', onEsc, true);
    dpOpen = { tag, update: (m2) => { cur = m2; if (!confirming) showList(); } };
    try {
      const r = await dialog(pickTitle(), '', [
        { label: '退出', value: null, cancel: true },
        { label: '新建会话', value: { id: '' }, cls: 'primary', submit: true },
      ], tag, (b, finish) => {
        body = b;
        showList();
        b.onclick = (e) => {
          const c = e.target.closest('[data-c]');
          if (c) {
            if (c.dataset.c === 'share') return finish({ id: confirming.x.id, share: true });
            if (c.dataset.c === 'kill') return kill(confirming.x.id, true);
            if (c.dataset.c === 'go') return finish({ go: confirming.other });
            return showList();
          }
          const row = e.target.closest('.dp-row');
          if (!row) return;
          const btn = e.target.closest('button');
          const x = (cur.sessions || []).find((y) => y.id === row.dataset.id);
          if (btn?.dataset.a === 'kill') {
            if (btn.disabled) return;
            if (x?.busy) return showKillConfirm(x); // 还有连接：问要不要强制删除
            // 删除要再点一次确认：里面还在跑的程序会被关掉
            if (!btn.classList.contains('danger')) { btn.classList.add('danger'); btn.textContent = '确定删除？'; return; }
            return kill(row.dataset.id, false);
          }
          if (x?.busy) return showConfirm(x);
          finish({ id: row.dataset.id });
        };
      });
      if (r.dismissed) return undefined;
      return r.value;
    } finally {
      window.removeEventListener('keydown', onEsc, true);
      if (dpOpen?.tag === tag) dpOpen = null;
      acts().classList.remove('hidden');
    }
  }

  // 主机指纹确认
  async function hostkeyDialog(m, tag) {
    let html;
    let buttons;
    if (m.status === 'changed') {
      html = `<div class="warn-box"><b>⚠ 警告：主机指纹已变化！</b><br>
        可能是服务器重装 / 更换了密钥，也可能正在遭受中间人攻击。除非你确认服务器端确实换了密钥，否则不要继续。</div>
        <div>主机：<b>${esc(m.host)}</b></div>
        <div class="muted" style="margin-top:8px">已保存的指纹：</div><pre>${esc(m.oldKeyType)} ${esc(m.oldFingerprint)}</pre>
        <div class="muted">当前服务器指纹：</div><pre>${esc(m.keyType)} ${esc(m.fingerprint)}</pre>`;
      buttons = [
        { label: '取消连接', value: false, cls: 'primary', cancel: true },
        { label: '更新指纹并连接', value: true, cls: 'danger' },
      ];
    } else {
      html = `<div>首次连接 <b>${esc(m.host)}</b>，请核对服务器指纹：</div>
        <pre>${esc(m.keyType)} ${esc(m.fingerprint)}</pre>
        <div class="hint">可在服务器上执行 <code>ssh-keygen -lf /etc/ssh/ssh_host_${esc(String(m.keyType).replace(/^ssh-|^ecdsa-sha2-.*/, (x) => x.startsWith('ecdsa') ? 'ecdsa' : ''))}_key.pub</code> 对比</div>`;
      buttons = [
        { label: '取消', value: false, cancel: true },
        { label: '信任并连接', value: true, cls: 'primary', submit: true },
      ];
    }
    const r = await dialog(m.status === 'changed' ? '主机指纹不匹配' : '确认主机指纹', html, buttons, tag);
    if (r.dismissed) return null;
    return !!r.value;
  }

  // 已信任指纹管理
  async function knownHostsDialog() {
    const list = await api('GET', '/api/known-hosts');
    const html = list.length ? list.map((k, i) => `
      <div class="known-row"><div class="info"><div>${esc(k.key.replace(/^cf:/, '☁ '))}</div>
      <div class="fp">${esc(k.keyType)} ${esc(k.fingerprint)}</div>
      <div class="fp">${esc(new Date(k.addedAt).toLocaleString())}</div></div>
      <button type="button" data-del="${i}">删除</button></div>`).join('')
      : '<p class="muted">暂无已信任的主机</p>';
    const p = dialog('已信任的主机指纹', html, [{ label: '关闭', value: null, cls: 'primary', cancel: true }]);
    $('#dialogBody').querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        const k = list[+b.dataset.del];
        if (!confirm(`删除 ${k.key} 的指纹？下次连接将重新确认。`)) return;
        await api('DELETE', '/api/known-hosts?key=' + encodeURIComponent(k.key));
        b.closest('.known-row').remove();
      };
    });
    await p;
  }
  $('#btnKnown').addEventListener('click', () => knownHostsDialog().catch((e) => alert(e.message)));

  // ------------------------------------------------------------ SFTP 文件管理
  const fmtSize = (n) => {
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
  };
  const fmtTime = (t) => {
    const d = new Date(t);
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const joinPath = (dir, name) => (dir.endsWith('/') ? dir : dir + '/') + name;
  const parentPath = (p) => p.replace(/\/[^/]+\/?$/, '') || '/';
  // Windows 的 SFTP (OpenSSH) 路径是 /D:/xxx：显示时去掉盘符前面的 /；手动输入的 D:/xxx 发给服务端前补回去
  const showPath = (p) => (/^\/[A-Za-z]:/.test(p) ? p.slice(1) : p);
  const sftpPath = (p) => (/^[A-Za-z]:/.test(p) ? '/' + p : p);
  const shellQuote = (x) => `'${x.replace(/'/g, `'\\''`)}'`;

