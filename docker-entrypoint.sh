#!/bin/sh
# 用法见 Dockerfile：ENTRYPOINT，CMD 为 node server.js
# (占位密码「请修改为强密码」由 server.js 启动时拒绝，见 lib/auth.js)
# 可选：设置 PUID / PGID 时，把 /data 交给这个用户，再用这个用户身份运行 (不用 root)。
# 不设置时和以前一样以 root 运行，已有的部署不受影响。
set -e

DATA="${DATA_DIR:-/data}"

if [ -n "$PUID" ] && [ "$(id -u)" = "0" ]; then
  case "$PUID$PGID" in
    *[!0-9]*) echo "PUID / PGID 必须是数字: PUID=$PUID PGID=$PGID" >&2; exit 1 ;;
  esac
  PGID="${PGID:-$PUID}"
  mkdir -p "$DATA"
  # 有任何文件的所有者不对 (比如以前用 root 运行时创建的) 才整体改一遍
  if [ -n "$(find "$DATA" \( ! -user "$PUID" -o ! -group "$PGID" \) -print | head -n 1)" ]; then
    chown -R "$PUID:$PGID" "$DATA"
  fi
  exec su-exec "$PUID:$PGID" "$@"
fi

exec "$@"
