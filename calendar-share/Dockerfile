# Public calendar page — the only MediaOps piece meant to face the internet.
# Build from the repo root:  docker build -f calendar-share/Dockerfile -t mediaops-calendar-share .

# ── Build: just the calendar page (vite.share.config.ts) ────────────────────
FROM node:22-alpine AS builder
WORKDIR /build

COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json vite.share.config.ts tailwind.config.js postcss.config.js ./
COPY client/ client/
RUN npm run build:share

# ── Runtime: Node built-ins only, no node_modules at all ────────────────────
FROM node:22-alpine
WORKDIR /app

COPY calendar-share/server.mjs ./server.mjs
COPY --from=builder /build/dist-share ./public

# Unprivileged; the image ships its own `node` user.
USER node

ENV NODE_ENV=production \
    PORT=8991
EXPOSE 8991

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8991}/healthz" >/dev/null || exit 1

CMD ["node", "server.mjs"]
