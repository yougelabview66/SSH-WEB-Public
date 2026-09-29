// 尽早应用手动选择的主题，避免页面先闪一下深色 (在 <head> 里同步加载)
try { var t = localStorage.getItem('sshweb.theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) {}
