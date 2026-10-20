  // ------------------------------------------------------------ 图片 / 文件发给 Claude
  // 电脑：文件拖到终端或下方输入框上，或者在输入框 / 终端里粘贴截图；手机：输入栏左边的 📎 从相册 / 文件里选。
  // 传到目标主机的 ~/.cache/ssh-web/uploads (见 lib/sftp.js attach-dir，7 天前的自动删)，路径填进输入框 (不发送)，
  // 接着写要 Claude 做什么再发；Claude Code 看到图片路径会自己去读
  let attaching = false;
  const pad2 = (n) => String(n).padStart(2, '0');

  // 目标主机上的文件名：时间-原名 (空格、引号等换成 _，填进输入框不用加引号)；粘贴的截图没有扩展名时按类型补上
  function attachName(f, n) {
    const d = new Date();
    const ts = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
    let name = (f.name || '').replace(/[\s'"`$\\|&;<>(){}[\]*?!#~/]/g, '_') || 'file';
    if (!/\.[A-Za-z0-9]+$/.test(name) && /^image\/(png|jpeg|gif|webp)$/.test(f.type)) name += '.' + f.type.slice(6).replace('jpeg', 'jpg');
    return `${ts}-${n > 1 ? n + '-' : ''}${name}`;
  }

  async function attachFiles(list) {
    const s = active;
    const files = [...list];
    if (!files.length || !s) return;
    if (!s.sid) return fontToast(s, '会话未连接，不能上传', 2000);
    if (inputLocked(s)) return; // 别的设备在用：先点「在本机继续」
    if (attaching) return fontToast(s, '上一批还在上传，请稍等', 1500);
    attaching = true;
    const paths = [];
    try {
      const { dir } = await api('POST', `/api/sftp/${s.sid}/attach-dir`);
      for (const [i, f] of files.entries()) {
        const label = `上传${files.length > 1 ? ` (${i + 1}/${files.length})` : ''} ${f.name || '图片'}`;
        const prog = (done, total) => fontToast(s, `${label}  ${total ? Math.round((done / total) * 100) : 0}%`, 120000);
        prog(0, 0);
        let n = 1, target = `${dir}/${attachName(f, n)}`;
        while ((await sftpPut(s, f, target, false, prog)) === 'exists') target = `${dir}/${attachName(f, ++n)}`; // 同一秒传了同名的
        paths.push(target);
      }
      fontToast(s, `已上传 ${paths.length} 个文件，路径已填进输入框`, 2500);
    } catch (e) {
      fontToast(s, '上传失败：' + e.message, 5000);
    } finally {
      attaching = false;
    }
    if (paths.length) insertPaths(s, paths);
  }

  // 路径填到光标处 (前面不是空白就隔一个空格，后面跟一个空格，接着打字)；
  // 下方输入框关着、连按两下 Alt 在终端里直接打字、命令模式时，直接打进终端 (按粘贴发，Claude Code 认得出是文件)
  function insertPaths(s, paths) {
    const text = paths.map((x) => (/[\s'"]/.test(x) ? shellQuote(x) : x)).join(' ') + ' ';
    const join = (v, at) => (at > 0 && !/\s/.test(v[at - 1]) ? ' ' : '') + text;
    if (s !== active) { s.draft = (s.draft || '') + join(s.draft || '', (s.draft || '').length); return; } // 传的时候切走了：放进那个标签的草稿
    if (cmdMode || (!isTouch && (!deskOn || termDirect))) { s.term.paste(text); return; }
    if (isTouch) {
      const v = mText(), at = Math.max(0, (mInput.selectionStart ?? v.length + 1) - 1);
      const ins = join(v, at);
      setMobileText(v.slice(0, at) + ins + v.slice(at), at + ins.length);
      return;
    }
    const v = dInput.value, a = dInput.selectionStart ?? v.length, b = dInput.selectionEnd ?? a;
    const ins = join(v, a);
    setDeskText(v.slice(0, a) + ins + v.slice(b));
    dInput.focus({ preventScroll: true });
    dInput.setSelectionRange(a + ins.length, a + ins.length);
  }

  // 拖文件：放到终端、下方输入框 / 手机输入栏上 = 发给 Claude；文件管理的列表自己处理 (上传到当前目录)；
  // 放到页面别处不处理 (不然浏览器会直接打开这个文件，离开 SSH-WEB)
  const attachZone = (t) => t?.closest?.('.term-box, #deskBar, #mobileBar');
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let dropHint = null;
  const setDropHint = (el) => {
    if (dropHint === el) return;
    dropHint?.classList.remove('drop-hint');
    dropHint = el;
    el?.classList.add('drop-hint');
  };
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e) || e.target.closest?.('.sftp-list')) return;
    e.preventDefault();
    const zone = active && attachZone(e.target);
    e.dataTransfer.dropEffect = zone ? 'copy' : 'none';
    setDropHint(zone || null);
  });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) setDropHint(null); });
  document.addEventListener('drop', (e) => {
    setDropHint(null);
    if (!hasFiles(e) || e.target.closest?.('.sftp-list')) return;
    e.preventDefault();
    if (active && attachZone(e.target)) attachFiles(e.dataTransfer.files);
  });

  // 粘贴截图 / 复制的文件 (剪贴板里只有文件、没有文字时)：在下方输入框、手机输入栏、终端里都算
  document.addEventListener('paste', (e) => {
    const cd = e.clipboardData;
    if (!cd || !cd.files.length || [...cd.types].includes('text/plain')) return;
    if (!active || !e.target.closest?.('#dInput, #mInput, .term-box')) return;
    e.preventDefault();
    e.stopImmediatePropagation(); // 不让 xterm / 输入框再按文字粘贴一次
    attachFiles(cd.files);
  }, true);

  // 手机：输入栏的 📎
  const mAttachFile = $('#mAttachFile');
  $('#mAttach').addEventListener('click', () => {
    if (!active?.sid || inputLocked(active)) return;
    mAttachFile.click();
  });
  mAttachFile.addEventListener('change', () => {
    attachFiles(mAttachFile.files);
    mAttachFile.value = '';
  });
