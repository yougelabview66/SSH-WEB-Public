'use strict';
// 会话接口：后台会话列表、标签顺序、为 tmux 开启鼠标、关闭会话 (都要登录，见 http.js)
const { sessions, liveSession } = require('./session');
const { broadcastEvent } = require('./events');
const { str } = require('./ssh-target');

function registerSessions(app) {
  app.get('/api/sessions', (req, res) => {
    res.json([...sessions.values()].sort((a, b) => a.order - b.order).map((s) => s.info()));
  });

  // 保存标签顺序
  app.put('/api/sessions/order', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    ids.forEach((id, i) => { const s = sessions.get(String(id)); if (s) s.order = i; });
    broadcastEvent({ type: 'order', ids: [...sessions.values()].sort((a, b) => a.order - b.order).map((x) => x.id), pageId: str(req.body?.pageId) });
    res.json({ ok: true });
  });

  // 为 tmux 开启鼠标 (滑动 / 滚轮查看历史)：用单独的 exec 通道执行，不影响终端画面
  app.post('/api/sessions/:id/tmux-mouse', (req, res) => {
    const s = liveSession(req.params.id);
    if (!s) return res.status(404).json({ error: '会话未连接' });
    const cmd = 'command -v tmux >/dev/null 2>&1 || { echo NO_TMUX; exit 0; }; '
      + 'tmux list-sessions >/dev/null 2>&1 || { echo NO_SERVER; exit 0; }; '
      + 'tmux set -g mouse on && echo OK';
    s.ssh.exec(cmd, (err, stream) => {
      if (err) return res.status(500).json({ error: err.message });
      let out = '';
      const timer = setTimeout(() => stream.close(), 8000);
      stream.on('data', (d) => { out += d; });
      stream.stderr.on('data', (d) => { out += d; });
      stream.on('close', () => {
        clearTimeout(timer);
        if (res.headersSent) return;
        if (/\bOK\b/.test(out)) return res.json({ ok: true });
        if (out.includes('NO_TMUX')) return res.status(400).json({ error: '目标主机上没有安装 tmux' });
        if (out.includes('NO_SERVER')) return res.status(400).json({ error: '没有检测到正在运行的 tmux' });
        res.status(500).json({ error: out.trim().slice(0, 200) || '执行失败' });
      });
    });
  });

  // 通知上点了「允许 / 拒绝」(Claude Code 要权限，钩子报的)：seq 对得上、确认框还在才发按键 (见 session/hooks.js)
  app.post('/api/sessions/:id/answer', (req, res) => {
    const s = liveSession(req.params.id);
    if (!s) return res.status(404).json({ error: '会话未连接' });
    const choice = req.body?.choice;
    if (choice !== 'allow' && choice !== 'deny') return res.status(400).json({ error: 'choice 只能是 allow / deny' });
    s.answerPerm(choice, Number(req.body?.seq), (err) => (err ? res.status(409).json({ error: err }) : res.json({ ok: true })));
  });

  app.delete('/api/sessions/:id', (req, res) => {
    const s = sessions.get(req.params.id);
    if (s) s.terminate();
    res.json({ ok: true });
  });
}

module.exports = { registerSessions };
