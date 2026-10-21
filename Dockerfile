FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8888 \
    DATA_DIR=/data

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force \
 && apk add --no-cache su-exec

COPY server.js ./
COPY lib ./lib
COPY public ./public
# Windows 常驻会话用的 sshwebd.exe (源码 github.com/yougelabview66/sshwebd，连接时传到 Windows 主机)
COPY vendor ./vendor
# 可选 PUID / PGID：用普通用户运行 (见 sshweb-entrypoint.sh)；官方 node 镜像已有 docker-entrypoint.sh，换个名字
COPY docker-entrypoint.sh /usr/local/bin/sshweb-entrypoint.sh
RUN chmod +x /usr/local/bin/sshweb-entrypoint.sh && mkdir -p /data


VOLUME ["/data"]
EXPOSE 8888

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/sshweb-entrypoint.sh"]
CMD ["node", "server.js"]
