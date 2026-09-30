# syntax=docker/dockerfile:1
#
# Image API — build reproductible (phase 1-12E).
# Contexte de build : racine du dépôt (voir docker-compose.prod.yml).
#
# Image de base figée (tag + digest de l'index multi-arch) :
#   node:22.17.1-alpine3.22 — Node 22.17.1, Alpine 3.22.1, musl
#   index    sha256:5539840ce9d013fa13e3b9814c9353024be7ac75aca5db6d039504a56c04ea59
#   amd64    sha256:99351363debf40f3495cb7fc657a777334c3b21143e594dbfcc7de187439633c
# pnpm : version exacte du champ `packageManager` (pnpm@11.18.0) via corepack.
# Sharp : seuls les binaires linux/x64/musl sont installés (--os/--cpu/--libc),
# sans modifier pnpm-workspace.yaml (qui reste multiplateforme).

FROM node:22.17.1-alpine3.22@sha256:5539840ce9d013fa13e3b9814c9353024be7ac75aca5db6d039504a56c04ea59 AS pnpm
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY api/package.json api/
RUN corepack enable pnpm && corepack install

# ─── Build : dépendances complètes (lockfile figé) + compilation Nest ───────
FROM pnpm AS build
# Le binaire MongoDB de mongodb-memory-server (tests uniquement) n'est pas
# téléchargé dans l'image.
ENV MONGOMS_DISABLE_POSTINSTALL=1
RUN pnpm install --frozen-lockfile --filter api --os linux --cpu x64 --libc musl
COPY api/ api/
RUN pnpm --filter api build

# ─── Dépendances de production uniquement (même lockfile) ───────────────────
FROM pnpm AS prod-deps
# --ignore-scripts : le `prepare` racine (husky, devDependency) n'a pas sa
# place en production. Aucune dépendance de prod n'a de script d'installation
# nécessaire (sharp 0.35.5 n'en déclare pas ; binaires natifs via @img/*).
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter api --os linux --cpu x64 --libc musl

# ─── Runtime : minimal, sans pnpm ni sources, utilisateur non privilégié ────
FROM node:22.17.1-alpine3.22@sha256:5539840ce9d013fa13e3b9814c9353024be7ac75aca5db6d039504a56c04ea59 AS runtime
ENV NODE_ENV=production \
    PORT=4000
WORKDIR /app
# Layout pnpm conservé : api/node_modules pointe (liens symboliques) vers le
# store virtuel /app/node_modules/.pnpm. Fichiers en lecture seule pour `node`.
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=prod-deps /repo/api/node_modules ./api/node_modules
COPY --from=build /repo/api/dist ./api/dist
COPY api/package.json ./api/package.json
WORKDIR /app/api
USER node
EXPOSE 4000
# Route publique existante GET /health (aucun accès MongoDB, aucun secret).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main"]
