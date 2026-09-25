FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8888 \
    DATA_DIR=/data

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

COPY server.js ./
COPY lib ./lib
COPY public ./public
RUN mkdir -p /data


VOLUME ["/data"]
EXPOSE 8888

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1

CMD ["node", "server.js"]
