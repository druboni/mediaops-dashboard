# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /build

COPY package.json .
COPY tsconfig.json .
COPY vite.config.ts .
COPY tailwind.config.js .
COPY postcss.config.js .
COPY client/ client/

RUN npm install
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY server/ server/
COPY --from=builder /build/dist ./dist

RUN mkdir -p config

EXPOSE 8080
ENV NODE_ENV=production

CMD ["node", "server/index.js"]
