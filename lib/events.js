'use strict';
// 各页面的事件连接：新建会话、标签顺序变化时通知所有打开的页面 (手机电脑同时开着时实时同步标签)
const eventSockets = new Set();

function broadcastEvent(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of eventSockets) if (ws.readyState === ws.OPEN) ws.send(msg);
}

module.exports = { eventSockets, broadcastEvent };
