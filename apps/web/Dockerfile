# GeoGlobe web app: static build served by unprivileged nginx, which also reverse-proxies
# /api (HTTP + the agent WebSocket) to the API so the browser stays same-origin.
# Build from the REPO ROOT (the app depends on workspace packages):
#   docker build -f apps/web/Dockerfile -t geoglobe/web .

FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# Manifests first so `pnpm install` is cached across source-only changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/scene-schema/package.json packages/scene-schema/
COPY packages/layer-adapters/package.json packages/layer-adapters/
COPY packages/tool-contracts/package.json packages/tool-contracts/
RUN pnpm install --frozen-lockfile

COPY packages ./packages
COPY apps/web ./apps/web

# Relative by default: same-origin through the nginx proxy below. For a CDN-hosted
# frontend, pass the API's public URL instead (and set GEOGLOBE_CORS_ORIGINS on the API).
ARG VITE_API_URL=/api
ENV VITE_API_URL=${VITE_API_URL}
RUN pnpm --filter @geoglobe/web build && pnpm --filter @geoglobe/web size

FROM nginxinc/nginx-unprivileged:1.27-alpine
# The image renders /etc/nginx/templates/*.template with envsubst at startup (only
# variables that are actually set are substituted, so nginx's own $vars are safe).
COPY apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
ENV API_UPSTREAM=http://api:8000
EXPOSE 8080
