# Worker image (D-53, docs/worker-host-runbook.md). Build context: repository root, platform linux/amd64.
# Contains no secrets: configuration arrives at run time from /etc/noteprep/worker.env on the host.
# Pins (linux/amd64 manifest digests, queried 2026-10-20 with `docker buildx imagetools inspect`):
#   node:24.13.1-bookworm-slim -> sha256:85a395c77b811fa7f5b5e4aa69cd6eb4c3b80c7f1a8e34704dc0ce061e5b404e
#   docker:29.8.2-cli          -> sha256:d329fa64f42e03248f9a6cb2e21b6d4aa4d76f5a80aa2ad7946d81fbf1860602
FROM docker:29.8.2-cli@sha256:d329fa64f42e03248f9a6cb2e21b6d4aa4d76f5a80aa2ad7946d81fbf1860602 AS dockercli

FROM node:24.13.1-bookworm-slim@sha256:85a395c77b811fa7f5b5e4aa69cd6eb4c3b80c7f1a8e34704dc0ce061e5b404e AS base
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

FROM base AS build
COPY prisma ./prisma
COPY prisma7.config.ts tsconfig.json ./
RUN pnpm install --frozen-lockfile
COPY src ./src
COPY worker ./worker
COPY scripts/build-worker.mjs ./scripts/build-worker.mjs
RUN pnpm worker:build

FROM base AS prod-deps
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
# Keep only the closure of the packages the bundle leaves external (see scripts/build-worker.mjs); the rest of the web app's
# dependencies (next, shadcn, ...) are not needed by the worker.
COPY scripts/copy-externals.mjs ./scripts/copy-externals.mjs
RUN node scripts/copy-externals.mjs node_modules /out/node_modules @prisma/client @prisma/adapter-pg pg

FROM node:24.13.1-bookworm-slim@sha256:85a395c77b811fa7f5b5e4aa69cd6eb4c3b80c7f1a8e34704dc0ce061e5b404e AS runtime
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY --from=prod-deps /out/node_modules ./node_modules
COPY --from=build /app/dist ./dist
ENV NODE_ENV=production HOME=/tmp DOCKER_CONFIG=/tmp/.docker \
    DOCKER_HOST=unix:///run/noteprep-runner/docker.sock WORKER_LIVENESS_FILE=/run/noteprep/alive
USER 10001:10001
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "/app/dist/worker/healthcheck.mjs", "/run/noteprep/alive", "120"]
ENTRYPOINT ["node", "--conditions=react-server", "--enable-source-maps", "/app/dist/worker/main.mjs"]
