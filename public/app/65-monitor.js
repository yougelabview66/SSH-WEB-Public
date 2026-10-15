  // ------------------------------------------------------------ 性能监控
  const MON_INTERVAL = 2000;
  const MON_POINTS = 60; // 图表保留 60 个点 (约 2 分钟)

  const fmtBytes = (n, digits = 1) => {
    if (n == null || isNaN(n)) return '-';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? Math.round(n) : n.toFixed(n < 10 ? digits : 0)) + ' ' + u[i];
  };
  const fmtRate = (n) => (n == null ? '-' : fmtBytes(n) + '/s');
  const fmtPct = (n) => (n == null ? '-' : n.toFixed(n < 10 ? 1 : 0) + '%');
  const fmtUptime = (sec) => {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return d ? `${d} 天 ${h} 小时` : h ? `${h} 小时 ${m} 分` : `${m} 分钟`;
  };
  const meterClass = (pct) => (pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : '');

  $('#btnMon').addEventListener('click', () => {
    const s = active;
    if (!s) return;
    if (!s.mon) s.mon = createMonitor(s);
    s.mon.open = !s.mon.open;
    if (s.mon.open) { s.el.insertBefore(s.mon.el, s.el.firstChild); s.mon.loadAudit(); }
    else { s.mon.el.remove(); focusTerm(s); }
    updateSftpBtn();
    requestAnimationFrame(() => s.fit.fit());
  });

  // 只为「页面可见 + 当前标签 + 面板打开 + 已连接」的会话采集，其他暂停。
  // 每次开始采集换一个编号：上一次的采集还没回来时停了又开始 (切走又切回标签)，旧的回来后不再接着采
  // (以前会多出一条采集循环，采集频率翻倍)
  function syncMonitor(s) {
    const m = s.mon;
    if (!m) return;
    const want = m.open && s === active && !!s.sid && !s.closed && !document.hidden;
    if (want && !m.running) {
      m.running = true;
      m.poll(++m.gen);
    } else if (!want && m.running) {
      m.running = false;
      clearTimeout(m.timer);
    }
  }

  // ------------------------------------------------------------ 连接日志 (审计日志里这个会话的记录，见 lib/audit.js)
  const AUDIT_EV = {
    'ssh-open': '新建会话', 'ssh-attach': '新设备 / 新来源打开', 'ssh-reconnect': '重新连接', 'ssh-ok': '已连上主机',
    'ssh-fail': '连接失败', 'ssh-end': '连接断开', 'ssh-close': '关闭会话',
  };
  const auditHost = (hp) => String(hp || '').replace(/:\d+$/, ''); // 「地址:端口」里的地址
  const auditTime = (t) => {
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, '0');
    const hms = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    return d.toDateString() === new Date().toDateString() ? hms : `${d.getMonth() + 1}-${d.getDate()} ${hms}`;
  };
  const fmtSecs = (n) => (n < 60 ? `${n} 秒` : n < 3600 ? `${Math.round(n / 60)} 分钟` : `${(n / 3600).toFixed(1)} 小时`);
  // 归属地：内网 / 国家 地区 城市 · 运营商
  const geoText = (g) => (!g ? '' : g.local ? '内网'
    : [g.country, g.region !== g.city ? g.region : '', g.city].filter(Boolean).join(' ') + (g.isp ? ' · ' + g.isp : ''));
  // 出口 IP 是不是代理：归属地服务认定是代理 / VPN，或者请求头里声明经过了代理 → 是；只是机房 IP → 可能；查不到归属地 → 未知
  function proxyOf(x, g) {
    const why = [];
    if (g?.proxy) why.push('代理 / VPN IP');
    else if (g?.hosting) why.push('机房 IP');
    if (x.claimed?.length) why.push('请求头声明经过 ' + x.claimed.join(', '));
    const v = g?.proxy || x.claimed?.length ? '是' : g?.hosting ? '可能' : g ? '否' : '未知';
    return { v, cls: v === '是' ? 'bad' : v === '可能' ? 'warn' : '', text: v + (why.length ? ' · ' + why.join('；') : '') };
  }
  // 和磁盘一行一样：左边名称、右边数值
  const kv = (k, v, cls = '') => `<div class="sec-t kv"><span>${k}</span><span class="val ${cls}">${esc(v)}</span></div>`;

  function auditRow(x, geo, geoip) {
    const noGeo = geoip ? '查不到' : '未开启 (GEOIP=off)';
    let h = `<div class="arow"${x.ua ? ` title="${esc(x.ua)}"` : ''}><div class="sec-t ah">`
      + `<span class="mnt">${esc((AUDIT_EV[x.ev] || x.ev) + (x.device ? ' · ' + x.device : ''))}</span><span class="val">${esc(auditTime(x.t))}</span></div>`;
    if (x.ev === 'ssh-ok') {
      // SSH-WEB 到主机这一段：直连记的是主机 IP；Cloudflare 隧道记的是 Cloudflare 边缘节点
      const remote = auditHost(x.out?.remote);
      const g = geo[remote];
      if (x.route === 'cloudflare') {
        h += kv('主机', x.target) + kv('代理', '是 · Cloudflare 隧道 ' + (x.via || ''), 'warn');
        if (remote) h += kv('边缘节点', remote + (geoText(g) ? ' · ' + geoText(g) : ''));
      } else {
        h += kv('主机 IP', remote ? x.out.remote + (geoText(g) ? ' · ' + geoText(g) : '') : x.target) + kv('代理', '否 · 直连');
      }
      if (x.out?.local) h += kv('本机', x.out.local);
    } else if (x.ip) {
      // 谁打开的：出口 IP、归属地、是否代理，经过哪些代理到 SSH-WEB (连接 IP 是最后一跳)
      const g = geo[x.ip];
      const p = proxyOf(x, g);
      const hops = (x.path || []).slice(1);
      h += kv('主机', x.target) + kv('出口 IP', x.ip) + kv('归属地', geoText(g) || noGeo) + kv('代理', p.text, p.cls)
        + kv('连接 IP', hops.length ? `${x.peer} (经 ${x.cf ? 'Cloudflare → ' : ''}${hops.join(' → ')})` : `${x.peer} (直连)`);
    } else if (x.ev === 'ssh-close' && x.reason === 'idle') {
      h += kv('原因', '无人查看太久，自动关闭');
    }
    if (x.ev === 'ssh-fail') h += kv('原因', x.reason || '', 'bad');
    if (x.ev === 'ssh-end' && x.secs != null) h += kv('时长', fmtSecs(x.secs));
    return h + '</div>';
  }

  function createMonitor(s) {
    const el = document.createElement('div');
    el.className = 'mon';
    el.innerHTML = `
      <div class="mon-head"><span class="mh">性能监控</span><button data-a="close" title="关闭">×</button></div>
      <div class="sub m-os"></div>
      <div class="sub m-up"></div>
      <div class="sec"><div class="sec-t"><b>连接日志</b><span class="ptabs"><button class="m-aref">刷新</button></span></div>
        <div class="m-alist"><div class="note">正在加载…</div></div></div>
      <div class="m-body"><div class="note" style="margin-top:14px">正在采集…</div></div>
      <div class="err m-err"></div>`;
    const m = { el, open: false, running: false, gen: 0, timer: null, hist: [], iface: '', procSort: 'cpu', last: null };

    el.querySelector('[data-a=close]').onclick = () => $('#btnMon').click();
    $('.m-aref', el).onclick = () => m.loadAudit();

    // 连接日志：打开面板时加载，开着时每 15 秒刷新一次 (跟着性能采集)
    m.loadAudit = async () => {
      m.auditAt = Date.now();
      const sid = s.sid;
      const list = $('.m-alist', el);
      if (!sid) return;
      try {
        const d = await api('GET', '/api/audit/session/' + encodeURIComponent(sid));
        if (sid !== s.sid) return;
        const top = list.scrollTop;
        list.innerHTML = !d.enabled ? '<div class="note">审计日志已关闭 (AUDIT_LOG=off)</div>'
          : d.entries.map((x) => auditRow(x, d.geo, d.geoip)).join('') || '<div class="note">还没有记录</div>';
        list.scrollTop = top;
      } catch (e) {
        list.innerHTML = `<div class="note">${esc(e.message)}</div>`;
      }
    };

    const live = (gen) => m.running && gen === m.gen;
    m.poll = async (gen) => {
      if (!live(gen)) return;
      const sid = s.sid;
      if (Date.now() - (m.auditAt || 0) > 15000) m.loadAudit();
      try {
        const d = await api('GET', '/api/monitor/' + sid);
        if (!live(gen) || sid !== s.sid) return;
        $('.m-err', el).textContent = '';
        m.last = d;
        m.hist.push({ t: d.time, ifaces: d.ifaces });
        if (m.hist.length > MON_POINTS) m.hist.shift();
        render(d);
      } catch (e) {
        if (!live(gen)) return;
        $('.m-err', el).textContent = e.message;
      }
      if (live(gen)) m.timer = setTimeout(() => m.poll(gen), MON_INTERVAL);
    };

    function netOf(ifaces) {
      if (!m.iface) {
        let rx = 0, tx = 0, ok = false;
        for (const i of ifaces) if (i.rxRate != null) { rx += i.rxRate; tx += i.txRate; ok = true; }
        return ok ? { rx, tx } : { rx: null, tx: null };
      }
      const i = ifaces.find((x) => x.name === m.iface);
      return i ? { rx: i.rxRate, tx: i.txRate } : { rx: null, tx: null };
    }

    function render(d) {
      $('.mh', el).textContent = d.hostname || '性能监控';
      $('.m-os', el).textContent = [d.os, d.kernel].filter(Boolean).join(' · ');
      $('.m-up', el).textContent = `运行 ${fmtUptime(d.uptime)} · 负载 ${d.load.map((x) => x.toFixed(2)).join(' ')}`;
      const body = $('.m-body', el);
      if (!body.dataset.built) build(body);

      const c = d.cpu;
      $('.v-cpu', el).textContent = fmtPct(c.usage);
      setMeter($('.b-cpu', el), c.usage);
      $('.n-cpu', el).textContent = `${c.cores} 核 · 用户 ${fmtPct(c.user)} · 系统 ${fmtPct(c.system)} · IO等待 ${fmtPct(c.iowait)}`
        + (d.temp != null ? ` · ${d.temp.toFixed(0)}°C` : '');
      $('.n-cpu', el).title = c.model;

      const mp = d.mem.total ? (d.mem.used / d.mem.total) * 100 : 0;
      $('.v-mem', el).textContent = `${fmtBytes(d.mem.used)} / ${fmtBytes(d.mem.total)}`;
      setMeter($('.b-mem', el), mp);
      $('.n-mem', el).textContent = `已用 ${fmtPct(mp)} · 缓存 ${fmtBytes(d.mem.cache)}`;
      const swapSec = $('.s-swap', el);
      swapSec.hidden = !d.mem.swapTotal;
      if (d.mem.swapTotal) {
        const sp = (d.mem.swapUsed / d.mem.swapTotal) * 100;
        $('.v-swap', el).textContent = `${fmtBytes(d.mem.swapUsed)} / ${fmtBytes(d.mem.swapTotal)}`;
        setMeter($('.b-swap', el), sp);
      }

      // 网卡选择
      const sel = $('.m-iface', el);
      const names = d.ifaces.map((i) => i.name);
      if (sel.dataset.names !== names.join(',')) {
        sel.dataset.names = names.join(',');
        sel.innerHTML = '<option value="">全部网卡</option>' + names.map((n) => `<option>${esc(n)}</option>`).join('');
        sel.value = names.includes(m.iface) ? m.iface : '';
      }
      const net = netOf(d.ifaces);
      $('.v-rx', el).textContent = '下载 ' + fmtRate(net.rx);
      $('.v-tx', el).textContent = '上传 ' + fmtRate(net.tx);
      drawChart();

      $('.v-io', el).textContent = `读 ${fmtRate(d.io.readRate)} · 写 ${fmtRate(d.io.writeRate)}`;

      $('.m-disks', el).innerHTML = d.disks.map((k) => {
        const pct = k.total ? (k.used / k.total) * 100 : 0;
        return `<div class="dsk" title="${esc(k.fs)}"><div class="sec-t"><span class="mnt">${esc(k.mount)}</span>
          <span class="val">${fmtBytes(k.used)} / ${fmtBytes(k.total)} · ${fmtPct(pct)}</span></div>
          <div class="meter thin"><i class="${meterClass(pct)}" style="width:${Math.min(pct, 100)}%"></i></div></div>`;
      }).join('') || '<div class="note">无</div>';

      renderProcs(d);
    }

    function renderProcs(d) {
      const list = m.procSort === 'cpu' ? d.topCpu : d.topMem;
      $('.n-proc', el).textContent = `${d.procCount} 个进程`;
      $('.m-procs tbody', el).innerHTML = list.map((p) => `<tr title="PID ${p.pid}">
        <td>${esc(p.name)}</td><td>${p.cpu == null ? '-' : fmtPct(p.cpu)}</td><td>${fmtBytes(p.mem, 0)}</td></tr>`).join('');
    }

    function setMeter(i, pct) {
      i.style.width = Math.min(Math.max(pct || 0, 0), 100) + '%';
      const cls = meterClass(pct || 0);
      i.classList.toggle('warn', cls === 'warn');
      i.classList.toggle('crit', cls === 'crit');
    }

    function build(body) {
      body.dataset.built = '1';
      body.innerHTML = `
        <div class="sec"><div class="sec-t"><b>CPU</b><span class="val v-cpu"></span></div>
          <div class="meter"><i class="b-cpu"></i></div><div class="note n-cpu"></div></div>
        <div class="sec"><div class="sec-t"><b>内存</b><span class="val v-mem"></span></div>
          <div class="meter"><i class="b-mem"></i></div><div class="note n-mem"></div></div>
        <div class="sec s-swap"><div class="sec-t"><b>交换</b><span class="val v-swap"></span></div>
          <div class="meter"><i class="b-swap"></i></div></div>
        <div class="sec"><div class="sec-t"><b>网络</b><select class="m-iface" title="选择网卡"></select></div>
          <div class="net-legend"><span class="v-rx" style="--c:var(--dl)"></span><span class="v-tx" style="--c:var(--ul)"></span></div>
          <div class="chart-wrap"><canvas class="m-chart"></canvas><div class="chart-tip" hidden></div></div></div>
        <div class="sec"><div class="sec-t"><b>磁盘 IO</b><span class="val v-io"></span></div></div>
        <div class="sec"><div class="sec-t"><b>磁盘</b></div><div class="m-disks"></div></div>
        <div class="sec"><div class="sec-t"><b>进程</b><span class="note n-proc" style="margin:0"></span>
          <span class="ptabs"><button data-sort="cpu" class="on">CPU</button><button data-sort="mem">内存</button></span></div>
          <table class="ptable m-procs"><colgroup><col class="n"><col class="c"><col class="m"></colgroup>
          <thead><tr><th>名称</th><th>CPU</th><th>内存</th></tr></thead><tbody></tbody></table></div>`;
      $('.m-iface', el).onchange = (e) => { m.iface = e.target.value; if (m.last) render(m.last); };
      el.querySelectorAll('.ptabs button').forEach((b) => {
        b.onclick = () => {
          m.procSort = b.dataset.sort;
          el.querySelectorAll('.ptabs button').forEach((x) => x.classList.toggle('on', x === b));
          if (m.last) renderProcs(m.last);
        };
      });
      const cv = $('.m-chart', el);
      cv.addEventListener('pointermove', (e) => { m.hover = e.offsetX; drawChart(); });
      cv.addEventListener('pointerleave', () => { m.hover = null; drawChart(); });
    }

    // 网速折线图：下载蓝 / 上传橙，2px 线，y 轴从 0 开始，悬停显示数值
    function drawChart() {
      const cv = $('.m-chart', el);
      if (!cv) return;
      const w = cv.clientWidth, h = cv.clientHeight, dpr = window.devicePixelRatio || 1;
      if (!w) return;
      if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const pts = m.hist.map((p) => ({ t: p.t, ...netOf(p.ifaces) }));
      const max = Math.max(1024, ...pts.map((p) => Math.max(p.rx || 0, p.tx || 0))) * 1.15;
      const top = 14, bottom = h - 2;
      const y = (v) => bottom - ((v || 0) / max) * (bottom - top);
      const x = (i) => w - (pts.length - 1 - i) * (w / (MON_POINTS - 1));
      const css = getComputedStyle(el);
      // 网格与刻度 (弱化)
      ctx.strokeStyle = css.getPropertyValue('--border').trim();
      ctx.lineWidth = 1;
      for (const f of [0, 0.5, 1]) {
        const gy = Math.round(bottom - f * (bottom - top)) + 0.5;
        ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
      }
      ctx.fillStyle = css.getPropertyValue('--muted') || '#94a3b8';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(fmtRate(max), 2, 10);
      const line = (key, color) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        let started = false;
        pts.forEach((p, i) => {
          if (p[key] == null) { started = false; return; }
          if (!started) { ctx.moveTo(x(i), y(p[key])); started = true; } else ctx.lineTo(x(i), y(p[key]));
        });
        ctx.stroke();
      };
      line('rx', css.getPropertyValue('--dl').trim());
      line('tx', css.getPropertyValue('--ul').trim());

      const tip = $('.chart-tip', el);
      if (m.hover == null || !pts.length) { tip.hidden = true; return; }
      const i = Math.round((pts.length - 1) - (w - m.hover) / (w / (MON_POINTS - 1)));
      const p = pts[Math.min(Math.max(i, 0), pts.length - 1)];
      const px = x(pts.indexOf(p));
      ctx.strokeStyle = css.getPropertyValue('--muted').trim();
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(px) + 0.5, top); ctx.lineTo(Math.round(px) + 0.5, bottom); ctx.stroke();
      for (const [k, col] of [['rx', '--dl'], ['tx', '--ul']]) {
        if (p[k] == null) continue;
        ctx.fillStyle = css.getPropertyValue(col).trim();
        ctx.strokeStyle = css.getPropertyValue('--panel').trim() || '#111827';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(px, y(p[k]), 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      const ago = Math.round((Date.now() - p.t) / 1000);
      tip.innerHTML = `<div class="note" style="margin:0 0 2px">${ago <= 1 ? '现在' : ago + ' 秒前'}</div>
        <div style="--c:var(--dl)">下载 ${fmtRate(p.rx)}</div><div style="--c:var(--ul)">上传 ${fmtRate(p.tx)}</div>`;
      tip.hidden = false;
      // 默认在十字线右侧，放不下就放左侧
      const tw = tip.offsetWidth;
      tip.style.left = (px + 8 + tw > w ? Math.max(px - tw - 8, 0) : px + 8) + 'px';
    }

    m.redraw = drawChart;
    return m;
  }

