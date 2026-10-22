  // ------------------------------------------------------------ 延迟显示：网页 ↔ SSH-WEB、SSH-WEB ↔ 目标主机
  // 打字、方向键、tmux 滚动都要等一个来回，看这两个数字就知道慢在哪一段
  const latCls = (ms) => (ms < 80 ? 'g' : ms < 200 ? 'y' : 'r');
  const latEl = $('#lat'), latPop = $('#latPop');
  // 每段保留最近 3 次测量，显示中间值：刚打开页面时浏览器忙、偶尔一次网络抖动造成的尖峰不会显示出来
  function latSample(s, k, ms) {
    const a = ((s.latN ||= {})[k] ||= []);
    a.push(ms);
    if (a.length > 3) a.shift();
    const sorted = [...a].sort((x, y) => x - y);
    return sorted[Math.floor((sorted.length - 1) / 2)];
  }
  const latOk = (s, ms) => s.sid && Number.isFinite(ms);

  // 标签栏的信号：像苹果双卡一样上下两排，上排网页、下排 SSH
  function updateLat() {
    const s = active;
    latEl.classList.toggle('hidden', !s);
    if (!s) return closeLatPop();
    // 4 格：< 80ms 四格绿、< 140ms 三格黄、< 200ms 两格黄、更慢一格红；没测到全灰
    const set = (k, ms) => {
      const el = latEl.querySelector(`[data-k=${k}]`), okv = latOk(s, ms);
      el.dataset.q = okv ? latCls(ms) : 'na';
      el.dataset.n = !okv ? 0 : ms < 80 ? 4 : ms < 140 ? 3 : ms < 200 ? 2 : 1;
    };
    set('web', s.rtt);
    set('ssh', s.sshRtt);
    if (!latPop.classList.contains('hidden')) renderLatPop();
  }

  function renderLatPop() {
    const s = active;
    if (!s) return;
    const num = (ms) => (latOk(s, ms) ? `<b class="${latCls(ms)}">${ms} ms</b>` : '<b>–</b>');
    latPop.innerHTML = `
      <div class="lp-row"><span>网页</span>${num(s.rtt)}</div>
      <div class="lp-sub">浏览器 ↔ SSH-WEB（经过 Cloudflare 隧道 / 你的网络）</div>
      <div class="lp-row"><span>SSH</span>${num(s.sshRtt)}</div>
      <div class="lp-sub">SSH-WEB ↔ 目标主机</div>
      <div class="lp-tip">显示最近 3 次测量的中间值。打字、方向键都要等一个来回。<br>绿 &lt; 80ms，黄 &lt; 200ms，红更慢</div>`;
    const r = latEl.getBoundingClientRect();
    latPop.style.top = r.bottom + 6 + 'px';
    latPop.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
  }

  function closeLatPop() {
    latPop.classList.add('hidden');
    latEl.classList.remove('on');
  }

  latEl.addEventListener('mousedown', (e) => e.preventDefault()); // 不抢走输入框焦点
  latEl.addEventListener('click', () => {
    if (!latPop.classList.contains('hidden')) return closeLatPop();
    latPop.classList.remove('hidden');
    latEl.classList.add('on');
    renderLatPop();
    measureRtt(); // 打开时马上测一次最新的
  });
  // 点别处 / Esc 关闭
  document.addEventListener('pointerdown', (e) => {
    if (!latPop.classList.contains('hidden') && !latPop.contains(e.target) && !latEl.contains(e.target)) closeLatPop();
  }, true);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !latPop.classList.contains('hidden')) { closeLatPop(); e.stopPropagation(); e.preventDefault(); }
  }, true);
  window.addEventListener('resize', () => { if (!latPop.classList.contains('hidden')) renderLatPop(); });

  // 平时 10 秒测一次 (手机流量下少唤醒网络，省电)，打开详情卡片时 2 秒一次；切换标签时马上测
  let rttAt = -Infinity; // performance.now() 从页面打开时算起，初始值不能用 0
  function measureRtt() {
    if (active && active.sid && !document.hidden) {
      send(active, { type: 'ping', t: performance.now() });
      rttAt = performance.now();
    }
    updateLat();
  }
  setInterval(() => {
    // 打开详情卡片、或者刚连上还没攒够 3 次测量时 2 秒一次，其余 10 秒一次
    const pending = active && active.sid && !((active.latN?.web || []).length >= 3 && (active.latN?.ssh || []).length >= 3);
    const gap = latPop.classList.contains('hidden') && !pending ? 10000 : 2000;
    if (performance.now() - rttAt >= gap - 50) measureRtt();
  }, 1000);

  function updateSftpBtn() {
    $('#btnHistory').classList.toggle('hidden', !active);
    const monOpen = !!(active && active.mon && active.mon.open);
    $('#btnMon').classList.toggle('on', monOpen);
    $('#btnMore').classList.toggle('hidden', !active);
    $('#btnMore').classList.toggle('on', monOpen); // 监控收在「更多」里：开着时「更多」也高亮
    $('#btnFwd').disabled = $('#btnHooks').disabled = $('#btnSessions').disabled = $('#btnGit').disabled = $('#btnProj').disabled = !(active && active.sid);
    sessions.forEach(syncMonitor);
    const b = $('#btnSftp');
    b.classList.toggle('hidden', !active);
    b.disabled = !(active && active.sid);
    b.classList.toggle('on', !!(active && active.sftp && active.sftp.open));
  }

  $('#btnSftp').addEventListener('click', () => {
    const s = active;
    if (!s || !s.sid) return;
    if (!s.sftp) s.sftp = createSftp(s);
    s.sftp.toggle();
    updateSftpBtn();
  });

  // 上传一个文件到目标主机的 target (完整路径)：成功 'ok'，已存在且没让覆盖 'exists'，失败抛错；onProgress(已传, 总共)
  // (文件管理的上传、发给 Claude 的附件共用)
  function sftpPut(s, file, target, overwrite, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `/api/sftp/${s.sid}/upload?path=${encodeURIComponent(target)}${overwrite ? '&overwrite=1' : ''}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total); };
      xhr.onload = () => {
        if (xhr.status === 200) return resolve('ok');
        if (xhr.status === 409) return resolve('exists');
        let msg = 'HTTP ' + xhr.status;
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
        reject(new Error(msg));
      };
      xhr.onerror = () => reject(new Error('网络错误'));
      xhr.send(file);
    });
  }

  function createSftp(s) {
    const el = document.createElement('div');
    el.className = 'sftp';
    el.innerHTML = `
      <div class="sftp-bar">
        <button data-a="up" title="上级目录">↑</button>
        <input class="path" spellcheck="false">
        <button data-a="refresh" title="刷新">⟳</button>
      </div>
      <div class="sftp-bar">
        <button data-a="upload">⬆ 上传</button>
        <button data-a="mkdir">+ 文件夹</button>
        <button data-a="cd" title="终端切换到此目录">终端 cd</button>
        <span class="spacer"></span>
        <button data-a="close" title="关闭">×</button>
        <input type="file" multiple hidden>
      </div>
      <div class="sftp-list"></div>
      <div class="sftp-status"></div>`;
    const list = $('.sftp-list', el);
    const pathInput = $('.path', el);
    const fileInput = $('input[type=file]', el);
    const status = $('.sftp-status', el);
    const api2 = (m, action, body, q = '') => api(m, `/api/sftp/${s.sid}/${action}${q}`, body);

    const self = {
      open: false,
      path: '',
      seq: 0,
      toggle() {
        self.open = !self.open;
        if (self.open) {
          s.el.appendChild(el);
          if (!self.loaded) self.load('');
        } else {
          el.remove();
          focusTerm(s);
        }
      },
      async load(p) {
        if (!s.sid) { list.innerHTML = '<div class="sftp-msg">会话未连接</div>'; return; }
        list.innerHTML = '<div class="sftp-msg">加载中…</div>';
        const seq = ++self.seq; // 只采用最后一次请求的结果
        try {
          const r = await api2('GET', 'list', null, '?path=' + encodeURIComponent(p));
          if (seq !== self.seq) return;
          self.loaded = true;
          self.path = r.path;
          pathInput.value = showPath(r.path);
          render(r.items);
        } catch (e) {
          if (seq !== self.seq) return;
          list.innerHTML = `<div class="sftp-msg" style="color:var(--danger)">${esc(e.message)}</div>`;
        }
      },
    };

    let pvTimer = 0;
    function render(items) {
      list.innerHTML = '';
      if (!items.length) list.innerHTML = '<div class="sftp-msg">空目录（可拖拽文件到这里上传）</div>';
      items.forEach((it) => {
        const row = document.createElement('div');
        row.className = 'frow' + (it.isDir ? ' dir' : '');
        row.title = `${it.mode}  ${it.name}`;
        row.innerHTML = `<span class="ic">${it.isDir ? '📁' : it.type === 'link' ? '🔗' : '📄'}</span>
          <span class="fn"></span>
          <span class="meta">${it.isDir ? '' : fmtSize(it.size) + '<br>'}${fmtTime(it.mtime)}</span>
          <span class="fops">
            ${it.isDir ? '' : '<button data-op="pv" title="预览">👁</button>'}
            <button data-op="dl" title="${it.isDir ? '打包下载 (.tar.gz)' : '下载'}">⬇</button>
            <button data-op="mv" title="重命名 / 移动">✎</button>
            <button data-op="rm" title="删除">🗑</button>
          </span>`;
        $('.fn', row).textContent = it.name;
        const full = joinPath(self.path, it.name);
        row.addEventListener('click', async (e) => {
          const op = e.target.dataset.op;
          if (op === 'dl') return download(full);
          if (op === 'pv') return openPreview(s, full, it.size, download);
          // 点文件名 / 图标：预览。双击照旧下载：电脑上等一下看是不是双击 (不然第二下点到了预览上)
          if (!it.isDir && !op && e.target.closest('.fn, .ic')) {
            clearTimeout(pvTimer);
            if (e.detail <= 1) pvTimer = setTimeout(() => openPreview(s, full, it.size, download), isTouch ? 0 : 300);
            return;
          }
          if (op === 'mv') {
            const to = prompt('重命名 / 移动到：', full);
            if (!to || to === full) return;
            try { await api2('POST', 'rename', { from: full, to }); self.load(self.path); } catch (err) { alert(err.message); }
            return;
          }
          if (op === 'rm') {
            if (!confirm(`确定删除${it.isDir ? '文件夹（包括其中所有内容）' : ''}「${it.name}」？`)) return;
            setStatus2(`正在删除 ${it.name} …`);
            try { await api2('POST', 'delete', { path: full }); setStatus2(''); self.load(self.path); } catch (err) { setStatus2(''); alert(err.message); }
            return;
          }
          if (it.isDir && e.target.closest('.fn, .ic')) self.load(full);
        });
        row.addEventListener('dblclick', () => { clearTimeout(pvTimer); it.isDir ? self.load(full) : download(full); });
        list.appendChild(row);
      });
    }

    function download(p) {
      const a = document.createElement('a');
      a.href = `/api/sftp/${s.sid}/download?path=${encodeURIComponent(p)}`;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }

    function setStatus2(text, pct) {
      status.innerHTML = text ? `${esc(text)}${pct != null ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}` : '';
    }

    function putFile(file, target, overwrite) {
      return sftpPut(s, file, target, overwrite, (done, total) => setStatus2(`上传 ${file.name}  ${fmtSize(done)} / ${fmtSize(total)}`, (done / total) * 100));
    }

    async function upload(files) {
      const dir = self.path;
      let n = 0;
      for (const f of files) {
        const target = joinPath(dir, f.name);
        try {
          setStatus2(`上传 ${f.name}`, 0);
          let r = await putFile(f, target, false);
          if (r === 'exists') {
            if (!confirm(`「${f.name}」已存在，是否覆盖？`)) continue;
            r = await putFile(f, target, true);
          }
          n++;
        } catch (e) {
          alert(`上传 ${f.name} 失败：${e.message}`);
        }
      }
      setStatus2(n ? `已上传 ${n} 个文件` : '');
      if (self.path === dir) self.load(dir);
    }

    el.addEventListener('click', async (e) => {
      const a = e.target.dataset.a;
      if (a === 'up') self.load(parentPath(self.path));
      else if (a === 'refresh') self.load(self.path);
      else if (a === 'close') { self.toggle(); updateSftpBtn(); }
      else if (a === 'upload') fileInput.click();
      else if (a === 'cd') { // 服务端按终端里的 shell (Linux sh / Windows cmd / PowerShell) 给出命令
        try {
          const r = await api2('POST', 'cd', { path: self.path });
          send(s, { type: 'data', data: r.cmd + '\r' });
        } catch (err) { alert(err.message); }
        focusTerm(s);
      }
      else if (a === 'mkdir') {
        const name = prompt('新文件夹名称：');
        if (!name) return;
        try { await api2('POST', 'mkdir', { path: joinPath(self.path, name) }); self.load(self.path); } catch (err) { alert(err.message); }
      }
    });
    pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') self.load(sftpPath(pathInput.value.trim())); });
    fileInput.addEventListener('change', () => { upload([...fileInput.files]); fileInput.value = ''; });
    list.addEventListener('dragover', (e) => { e.preventDefault(); list.classList.add('drag'); });
    list.addEventListener('dragleave', () => list.classList.remove('drag'));
    list.addEventListener('drop', (e) => {
      e.preventDefault();
      list.classList.remove('drag');
      const files = [...e.dataTransfer.files];
      if (files.length) upload(files);
    });
    return self;
  }

