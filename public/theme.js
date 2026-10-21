// 尽早应用手动选择的主题，避免页面先闪一下深色 (在 <head> 里同步加载)
try { var t = localStorage.getItem('sshweb.theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) {}
// iPhone 从主屏幕以 App 方式打开 (全屏)、有底部小横条的机型 (屏幕长边 ≥ 812)：标记一下，输入栏底部给小横条让出 34px (见 style.css 的 .ios-app)。
// 不用 viewport-fit=cover + 安全区：那样状态栏会盖在页面上 (iOS 加磨砂，挡住主机标签)
try { if (navigator.standalone && Math.max(screen.width, screen.height) >= 812) document.documentElement.classList.add('ios-app'); } catch (e) {}
