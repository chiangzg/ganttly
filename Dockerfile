# syntax=docker/dockerfile:1
#
# ganttly self-hosted image (spec §14.2).
#
# Single container serving the Web bundle, REST API, MCP endpoint, SSE stream
# and instance discovery on one origin. Two stages:
#
#   builder — compiles the Web bundle (vite) and the server esbuild bundles
#             (dist/server.js + dist/migrate.js; production never runs tsx).
#   runtime — plain Node with production dependencies only. Migrations run as
#             a separate one-shot `docker compose run` service (spec §14.1),
#             not on server boot.
#
# Build:  docker build -t ganttly .
# Run:    see docker-compose.yml + .env.example at the repo root.

# ---- Stage 1: build ---------------------------------------------------------
FROM node:20-bookworm-slim AS builder
# Pin pnpm to the root packageManager field; plain npm-global install avoids
# corepack keyring flakiness in CI.
RUN npm install -g pnpm@9.15.9
WORKDIR /app

# Manifests first (lockfile importers must all exist for --frozen-lockfile);
# keeps the dependency layer cached across source-only changes.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/api-contract/package.json ./packages/api-contract/
COPY packages/calendar-data/package.json ./packages/calendar-data/
COPY packages/domain/package.json ./packages/domain/
COPY packages/gan-parser/package.json ./packages/gan-parser/
COPY packages/schema/package.json ./packages/schema/
COPY packages/tsconfig/package.json ./packages/tsconfig/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
RUN pnpm install --frozen-lockfile

# Sources (context pruned by .dockerignore).
COPY . .
RUN pnpm --filter @ganttly/web build \
 && pnpm --filter @ganttly/server build

# ---- Stage 2: runtime -------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3001 \
    WEB_DIST_DIR=/app/apps/web/dist \
    MIGRATIONS_FOLDER=/app/drizzle
RUN npm install -g pnpm@9.15.9
WORKDIR /app

# Same manifest layout as the builder so --frozen-lockfile resolves; prod deps
# of the server closure only (workspace deps of @ganttly/web are not installed).
# --ignore-scripts skips the root `prepare: husky` (husky is a devDep, absent
# here); native deps still load because sodium-native ships prebuilds and
# resolves them at require time — verified by the require() gate below, which
# fails the image build if any runtime dependency (native included) cannot load.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/api-contract/package.json ./packages/api-contract/
COPY packages/calendar-data/package.json ./packages/calendar-data/
COPY packages/domain/package.json ./packages/domain/
COPY packages/gan-parser/package.json ./packages/gan-parser/
COPY packages/schema/package.json ./packages/schema/
COPY packages/tsconfig/package.json ./packages/tsconfig/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @ganttly/server... \
 && cd apps/server \
 && node -e "require('@fastify/secure-session');require('@fastify/static');require('postgres');require('prom-client');require('ajv');require('fast-xml-parser')" \
 && cd /app \
 && npm uninstall -g pnpm \
 && npm cache clean --force

# Built artifacts only — no tsx, no TypeScript sources needed to serve.
# MIGRATIONS_FOLDER above points at the copied /app/drizzle SQL.
COPY --from=builder --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=builder --chown=node:node /app/apps/server/drizzle ./drizzle
COPY --from=builder --chown=node:node /app/apps/web/dist ./apps/web/dist

USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/server.js"]
