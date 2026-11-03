# syntax=docker/dockerfile:1

# ---- stage 1: build workspaces + web bundle --------------------------------
FROM node:22-bookworm AS build
WORKDIR /app

# Manifests first so dependency layers cache across source changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/adapter/package.json packages/adapter/
COPY packages/gateway/package.json packages/gateway/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN npm run build
# Drop dev deps (vite, vitest, ...) — the runtime keeps fastify, sqlite, tsx.
RUN npm prune --omit=dev

# ---- stage 2: slim runtime --------------------------------------------------
FROM node:22-bookworm-slim AS runtime
# Defaults only — every ENV below is overridable at runtime (platform
# variables / `docker run -e`). The mock demo's "Simulate payment" button needs
# NODE_ENV != production AND OPENTILL_DEV_PUBLIC_SIMULATE=true set that way.
ENV NODE_ENV=production
WORKDIR /app

# gosu: lets the entrypoint drop from root to `node` after fixing volume
# ownership (Railway mounts volumes root-owned).
RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/* \
  && gosu nobody true
COPY docker/entrypoint.sh /usr/local/bin/opentill-entrypoint
RUN chmod 0755 /usr/local/bin/opentill-entrypoint

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/adapter ./packages/adapter
COPY --from=build /app/packages/gateway ./packages/gateway
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/apps/web/dist ./apps/web/dist

# SQLite lives on a volume; owned by the unprivileged node user. The image
# runs as `node`; a platform that starts it as root (RAILWAY_RUN_UID=0) gets
# the entrypoint's chown-then-drop path instead.
RUN mkdir -p /data && chown node:node /data
USER node
ENV OPENTILL_DB_PATH=/data/opentill.db \
    HOST=0.0.0.0 \
    PORT=8080

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["opentill-entrypoint"]
CMD ["./node_modules/.bin/tsx", "packages/gateway/src/main.ts"]
