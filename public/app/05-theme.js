  // ------------------------------------------------------------ 主题 (跟随系统 / 浅色 / 深色)
  const TERM_THEMES = {
    dark: {
      background: '#000000', foreground: '#e5e7eb', cursor: '#22c55e', cursorAccent: '#000000',
      selectionBackground: 'rgba(148,163,184,.35)',
    },
    // 浅色终端用 GitHub Light 的 ANSI 色板，白底上黄色 / 白色也能看清
    light: {
      background: '#ffffff', foreground: '#1f2328', cursor: '#16a34a', cursorAccent: '#ffffff',
      selectionBackground: 'rgba(9,105,218,.2)',
      black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#9a6700', blue: '#0969da',
      magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
      brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01',
      brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
    },
  };
  const systemLight = window.matchMedia('(prefers-color-scheme: light)');
  const themeMode = () => { try { return localStorage.getItem('sshweb.theme') || 'auto'; } catch { return 'auto'; } };
  const effectiveTheme = () => {
    const m = themeMode();
    return m === 'auto' ? (systemLight.matches ? 'light' : 'dark') : m;
  };
  const termTheme = () => TERM_THEMES[effectiveTheme()];

  function applyTheme() {
    const m = themeMode();
    if (m === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = m;
    const eff = effectiveTheme();
    document.querySelector('meta[name=theme-color]').content = eff === 'light' ? '#ffffff' : '#111827';
    $('#themeSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    for (const s of sessions) s.term.options.theme = termTheme();
    for (const s of sessions) if (s.mon && s.mon.redraw) s.mon.redraw();
    syncPipTheme();
  }

  $('#themeSeg').addEventListener('click', (e) => {
    const mode = e.target.dataset.mode;
    if (!mode) return;
    try { localStorage.setItem('sshweb.theme', mode); } catch {}
    applyTheme();
  });
  systemLight.addEventListener('change', () => { if (themeMode() === 'auto') applyTheme(); });
