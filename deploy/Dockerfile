# Ward server and web images (design.md §11.1). Build from the repo root:
#   docker compose build      (targets: server, web)
FROM node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS base
RUN corepack enable
WORKDIR /src
COPY . .

# Server: production deps only. The workspace stays as is, because Node runs the TypeScript sources directly
# and will not strip types inside node_modules, so @wdb/shared must stay a symlink to packages/shared.
FROM base AS server-build
RUN pnpm install --frozen-lockfile --prod --filter @wdb/server...

FROM node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS server
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
# The server never runs npm, npx or corepack; removing them drops the base image's npm CVEs from the runtime.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
# The backup service writes here as `node`; a new named volume takes this ownership.
RUN mkdir /backups && chown node:node /backups
COPY --from=server-build /src/node_modules /app/node_modules
COPY --from=server-build /src/packages/shared /app/packages/shared
COPY --from=server-build /src/apps/server /app/apps/server
WORKDIR /app/apps/server
USER node
EXPOSE 3000
CMD ["node", "src/main.ts"]

FROM base AS web-build
RUN pnpm install --frozen-lockfile --filter @wdb/web... && pnpm --filter @wdb/web build

# Caddy serves the built app and proxies /api to the server (SEC-1 to SEC-3).
# Exception to the 14-day release-age rule (owner approved 2026-11-12): 2.11.9 (released 2026-11-05) fixes Go stdlib,
# x/net and go-jose HIGH findings present in 2.11.7. One x/net finding remains; see .trivyignore.yaml.
FROM caddy:2.11.9-alpine@sha256:0bbb055bda6793c999bde78b1b5ce3e89f829fb031af2cf50056ea1246559fee AS web
# Patched Alpine packages (brotli, curl), and no curl at all: nothing here needs it.
RUN apk upgrade --no-cache && apk del --no-cache curl
COPY --from=web-build /src/apps/web/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
