  // ------------------------------------------------------------ GPU 渲染 (WebGL)
  // 整屏重画的程序 (Claude Code / top 等) 更流畅、更省电。只给当前标签启用：
  // 隐藏的标签本来就不绘制，且浏览器同时能用的 WebGL 数量有限。
  // 不支持 WebGL 或 GPU 上下文丢失 (手机切到后台时可能发生) 时退回默认渲染，回到前台再启用
  // 先检测再加载：插件在不支持的浏览器上加载失败时会残留在终端里，导致触摸滚动失效
  const webglSupported = (() => {
    try { return !!window.WebglAddon && !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
  })();
  let webglFails = webglSupported ? 0 : 3;
  let webglOkTimer = 0;

  function enableWebgl(s) {
    if (s.webgl || s.closed || webglFails >= 3) return;
    const addon = new WebglAddon.WebglAddon();
    try {
      // 切到后台、锁屏时浏览器回收 GPU 上下文是正常的，不算失败 (以前锁屏三次以后这个页面就再也不用 WebGL 了，只能刷新)；
      // 在前台用着时丢的才算，正常用一段时间后清零
      addon.onContextLoss(() => {
        if (!document.hidden) webglFails++;
        disableWebgl(s);
      });
      clearTimeout(webglOkTimer);
      webglOkTimer = setTimeout(() => { if (s.webgl === addon && webglFails < 3) webglFails = 0; }, 10 * 60 * 1000);
      s.term.loadAddon(addon);
      s.webgl = addon;
    } catch {
      try { addon.dispose(); } catch {}
      webglFails = 3;
    }
  }

  function disableWebgl(s) {
    if (!s.webgl) return;
    try { s.webgl.dispose(); } catch {}
    s.webgl = null;
  }
