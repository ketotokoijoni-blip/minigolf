# Puttipeli production image (DESIGN §14.2, D9): multi-stage, one Node process serving the static client build and the
# WebSocket endpoint. Build stage: `npm ci` (lockfile-driven, all workspaces) -> `npm run build` -> `npm prune --omit=dev`.
# Runtime stage copies the pruned node_modules (only `ws` + the @puttipeli/* workspace links remain) and the two `dist`
# folders. No `npm install` happens in the runtime stage.
#
#   docker build -t puttipeli --build-arg BUILD_ID=$(git rev-parse --short HEAD) .
#   docker run --rm -p 8080:8080 -e PUBLIC_ORIGIN=http://127.0.0.1:8080 puttipeli

FROM node:24-alpine AS build
ARG BUILD_ID=docker
# BUILD_ID is baked into both bundles (client __BUILD__ via vite.config.ts, server via build.mjs). NODE_ENV must NOT be
# set to production in this stage: `npm ci` would then skip the devDependencies (vite, esbuild, typescript) the build needs.
ENV BUILD_ID=$BUILD_ID
WORKDIR /app
# Manifests first so the dependency layer is cached independently of source changes. The workspace package.json files
# are required: `npm ci` refuses to run when a workspace listed in the lockfile is missing.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/client/package.json packages/client/
COPY packages/server/package.json packages/server/
RUN npm ci --no-audit --no-fund
# Sources (filtered by .dockerignore: no node_modules, dist, .git, docs, e2e, markdown).
COPY . .
# vite build (client) + esbuild bundle (server, `ws` external), then drop every devDependency. @playwright/test is a
# root devDependency: it has no install scripts and downloads no browsers under `npm ci`, and prune removes it here.
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-alpine
# BUILD_ID is repeated as a runtime variable: the client bundle has it baked in, but the server's config.ts reads
# env.BUILD_ID at run time (its esbuild `define` does not reach it), so /api/stats and `welcome` take it from here.
ARG BUILD_ID=docker
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    PUBLIC_DIR=/app/packages/client/dist \
    BUILD_ID=$BUILD_ID
WORKDIR /app
# Root manifest + pruned node_modules (ws, and @puttipeli/* symlinks pointing at ../../packages/*).
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
# The workspace package.json files make the symlink targets exist and give the server bundle its "type": "module".
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/client/package.json ./packages/client/
COPY --from=build /app/packages/client/dist ./packages/client/dist
COPY --from=build /app/packages/server/package.json ./packages/server/
COPY --from=build /app/packages/server/dist ./packages/server/dist
USER node
EXPOSE 8080
# Shell form so ${PORT} expands when the port is overridden at run time; busybox wget ships with alpine.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8080}/healthz" || exit 1
CMD ["node", "packages/server/dist/index.js"]
