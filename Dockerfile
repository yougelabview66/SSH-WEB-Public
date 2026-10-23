# 常驻会话用的 sshwebd：从 sshwebd/ 的源码编 Windows 版和 Linux 版 (连接时传到主机)
FROM golang:1.27-alpine AS sshwebd
WORKDIR /src
COPY sshwebd/go.mod sshwebd/go.sum ./
RUN go mod download
COPY sshwebd/*.go ./
# version.txt：版本号 (传到主机上的文件名带上它，见 lib/session/daemon.js)
RUN CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o /out/sshwebd.exe . \
 && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o /out/sshwebd-linux-amd64 . \
 && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "-s -w" -o /out/sshwebd-linux-arm64 . \
 && CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 go build -trimpath -ldflags "-s -w" -o /out/sshwebd-linux-armv7 . \
 && sed -n 's/^var version = "\(.*\)"$/\1/p' main.go > /out/version.txt && test -s /out/version.txt

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
COPY --from=sshwebd /out/ ./sshwebd/
# 可选 PUID / PGID：用普通用户运行 (见 sshweb-entrypoint.sh)；官方 node 镜像已有 docker-entrypoint.sh，换个名字
COPY docker-entrypoint.sh /usr/local/bin/sshweb-entrypoint.sh
RUN chmod +x /usr/local/bin/sshweb-entrypoint.sh && mkdir -p /data


VOLUME ["/data"]
EXPOSE 8888

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/sshweb-entrypoint.sh"]
CMD ["node", "server.js"]
