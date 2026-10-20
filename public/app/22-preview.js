  // ------------------------------------------------------------ 文件预览 (文件管理里点文件名 / 👁)
  // 图片直接显示，文本 / 代码按等宽字显示，Markdown 简单排版，PDF 交给浏览器在新标签页打开。
  // 服务端按 inline=1 给预览 (见 lib/sftp.js：文件里的脚本不会在 SSH-WEB 的网址下执行)
  const PREVIEW_IMG = /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i;
  const PREVIEW_MD = /\.(md|markdown|mdx)$/i;
  const PREVIEW_TEXT_MAX = 2 * 1024 * 1024; // 同服务端：再大网页里显示不动
  let previewEl = null, previewSess = null;

  function closePreview() {
    if (!previewEl) return;
    previewEl.remove();
    previewEl = null;
    document.removeEventListener('keydown', previewKey, true);
    if (previewSess && previewSess === active) focusTerm(previewSess);
  }
  function previewKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation(); // Esc 只关预览，不发给终端
    closePreview();
  }

  // size：文件大小 (列表里有)；download：下载这个文件
  async function openPreview(s, file, size, download) {
    const url = `/api/sftp/${s.sid}/download?inline=1&path=${encodeURIComponent(file)}`;
    if (/\.pdf$/i.test(file)) { window.open(url, '_blank', 'noopener'); return; }
    closePreview();
    const name = file.split('/').pop();
    const el = previewEl = document.createElement('div');
    previewSess = s;
    el.className = 'overlay fpreview';
    el.innerHTML = `<div class="card fp-card">
      <div class="fp-head"><span class="fp-name"></span>
        <button type="button" data-a="dl">⬇ 下载</button><button type="button" data-a="close" title="关闭 (Esc)">×</button></div>
      <div class="fp-body"><div class="sftp-msg">加载中…</div></div></div>`;
    const nameEl = $('.fp-name', el), body = $('.fp-body', el);
    nameEl.textContent = name;
    nameEl.title = file;
    el.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (e.target === el || a === 'close') closePreview();
      else if (a === 'dl') download(file);
    });
    document.addEventListener('keydown', previewKey, true);
    document.body.appendChild(el);
    $('[data-a=close]', el).focus({ preventScroll: true }); // 焦点离开输入框：打的字不会跑到终端里
    const msg = (t) => { if (previewEl === el) body.innerHTML = `<div class="sftp-msg">${esc(t)}</div>`; };

    if (PREVIEW_IMG.test(file)) {
      const img = new Image();
      img.className = 'fp-img';
      img.alt = name;
      img.onload = () => { if (previewEl === el) { body.classList.add('img'); body.replaceChildren(img); } };
      img.onerror = () => msg('图片打不开（格式不支持或文件已损坏）');
      img.src = url;
      return;
    }
    if (size > PREVIEW_TEXT_MAX) return msg(`文件太大（${fmtSize(size)}），请下载后查看`);
    try {
      const r = await fetch(url);
      if (!r.ok) {
        let m = 'HTTP ' + r.status;
        try { m = (await r.json()).error || m; } catch {}
        throw new Error(m);
      }
      const buf = new Uint8Array(await r.arrayBuffer());
      if (previewEl !== el) return;
      if (buf.subarray(0, 8192).includes(0)) return msg('二进制文件，不能预览，请下载后查看');
      const text = new TextDecoder().decode(buf);
      let view;
      if (PREVIEW_MD.test(file)) {
        view = document.createElement('div');
        view.className = 'fp-md';
        view.innerHTML = renderMarkdown(text);
      } else {
        view = document.createElement('pre');
        view.className = 'fp-text';
        view.textContent = text;
      }
      body.replaceChildren(view);
    } catch (e) {
      msg('预览失败：' + e.message);
    }
  }

  // 简单的 Markdown 排版：所有文字先转义 (文件里的 HTML 原样显示成文字，不会执行)，
  // 再认标题、列表、引用、代码块、表格、分隔线，行内的代码 / 粗体 / 斜体 / 删除线 / 链接
  function mdInline(t) {
    return t.split(/(`[^`]+`)/).map((part, i) => {
      if (i % 2) return `<code>${esc(part.slice(1, -1))}</code>`;
      return esc(part)
        .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt) => `🖼 ${alt}`) // 图片多是相对路径，显示不了，只留说明
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => (/^(https?:|mailto:)/i.test(href)
          ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>` : label))
        .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (m, a, b) => `<strong>${a ?? b}</strong>`)
        .replace(/(^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*(?!\w)/g, '$1<em>$2</em>')
        .replace(/~~(.+?)~~/g, '<del>$1</del>');
    }).join('');
  }

  function renderMarkdown(src) {
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    const isTableSep = (l) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l);
    const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => mdInline(c.trim()));
    const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
    const blockStart = (l, next) => /^\s*(```|~~~)/.test(l) || /^#{1,6}\s/.test(l) || /^\s*>/.test(l) || LIST_RE.test(l)
      || /^\s*([-*_])(\s*\1){2,}\s*$/.test(l) || (l.includes('|') && next != null && isTableSep(next));
    for (let i = 0; i < lines.length;) {
      const l = lines[i];
      let m;
      if ((m = l.match(/^\s*(```|~~~)/))) { // 代码块：原样显示
        const code = [];
        for (i++; i < lines.length && !lines[i].trim().startsWith(m[1]); i++) code.push(lines[i]);
        i++;
        out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      } else if (!l.trim()) {
        i++;
      } else if ((m = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) {
        out.push(`<h${m[1].length}>${mdInline(m[2])}</h${m[1].length}>`);
        i++;
      } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) {
        out.push('<hr>');
        i++;
      } else if (l.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = cells(l);
        const rows = [];
        for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]));
        out.push(`<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>`
          + rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('') + '</tbody></table>');
      } else if (/^\s*>/.test(l)) {
        const quote = [];
        for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`);
      } else if (LIST_RE.test(l)) {
        const ordered = /\d/.test(l.match(LIST_RE)[2]);
        const items = [];
        for (; i < lines.length; i++) {
          const li = lines[i].match(LIST_RE);
          if (li) {
            const [, ind, , text] = li;
            const task = text.match(/^\[([ xX])\]\s+(.*)$/); // 任务列表 - [ ] / - [x]
            const body = task ? `${task[1] === ' ' ? '☐' : '☑'} ${mdInline(task[2])}` : mdInline(text);
            items.push(`<li style="margin-left:${Math.floor(ind.replace(/\t/g, '    ').length / 2) * 1.2}em">${body}</li>`);
          } else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) {
            items[items.length - 1] = items[items.length - 1].replace(/<\/li>$/, ` ${mdInline(lines[i].trim())}</li>`); // 接着上一项
          } else break;
        }
        out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      } else {
        const para = [];
        for (; i < lines.length && lines[i].trim() && (!para.length || !blockStart(lines[i], lines[i + 1])); i++) para.push(lines[i].trim());
        out.push(`<p>${para.map(mdInline).join(' ')}</p>`);
      }
    }
    return out.join('\n');
  }
