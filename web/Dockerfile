# syntax=docker/dockerfile:1
#
# Image web (Next.js standalone) — build reproductible (phase 1-12E).
# Contexte de build : racine du dépôt (voir docker-compose.prod.yml).
#
# Image de base figée (tag + digest de l'index multi-arch) :
#   node:22.17.1-alpine3.22 — Node 22.17.1, Alpine 3.22.1, musl
#   index    sha256:5539840ce9d013fa13e3b9814c9353024be7ac75aca5db6d039504a56c04ea59
#   amd64    sha256:99351363debf40f3495cb7fc657a777334c3b21143e594dbfcc7de187439633c
# pnpm : version exacte du champ `packageManager` (pnpm@11.18.0) via corepack.
# Sharp : seuls les binaires linux/x64/musl sont installés (--os/--cpu/--libc),
# sans modifier pnpm-workspace.yaml (qui reste multiplateforme).

FROM node:22.17.1-alpine3.22@sha256:5539840ce9d013fa13e3b9814c9353024be7ac75aca5db6d039504a56c04ea59 AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY web/package.json web/
RUN corepack enable pnpm && corepack install
RUN pnpm install --frozen-lockfile --filter web --os linux --cpu x64 --libc musl
COPY web/ web/

# Variables PUBLIQUES uniquement (inlinées par `next build`). Aucun secret
# n'est transmis comme ARG. L'inscription publique reste fermée par défaut.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_REGISTRATION_ENABLED=false
ARG S3_HOSTNAME
# DOCKER_BUILD=true active `output: "standalone"` (next.config.ts) dans ce
# stage uniquement ; les builds Vercel ne le définissent pas.
ENV DOCKER_BUILD=true \
    NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_REGISTRATION_ENABLED=$NEXT_PUBLIC_REGISTRATION_ENABLED \
    S3_HOSTNAME=$S3_HOSTNAME
RUN pnpm --filter web build

# ─── Runtime : serveur standalone, sans pnpm ni sources ─────────────────────
FROM node:22.17.1-alpine3.22@sha256:5539840ce9d013fa13e3b9814c9353024be7ac75aca5db6d039504a56c04ea59 AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
# outputFileTracingRoot = racine du dépôt : le serveur est émis dans
# .next/standalone/web/server.js (structure observée après build).
COPY --from=build /repo/web/.next/standalone ./
COPY --from=build /repo/web/.next/static ./web/.next/static
COPY --from=build /repo/web/public ./web/public
WORKDIR /app/web
USER node
EXPOSE 3000
# Contrôle local du port (aucune route ajoutée, aucun package).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "require('net').connect(+(process.env.PORT||3000),'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"]
CMD ["node", "server.js"]
