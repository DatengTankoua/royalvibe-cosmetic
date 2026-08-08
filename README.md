# RoyalVibe Cosmétiques & Bijoux — Application de gestion

Application collaborative de gestion des ventes pour **RoyalVibe Cosmétiques & Bijoux**.
Produits achetés en Europe (€) et revendus en Afrique (FCFA/XOF).

## Fonctionnalités

- **Catalogue produits** organisé par sections (catégories)
- **Suivi des ventes** avec historique complet et trail d'audit
- **Rôles** : Admin (gestion complète) · Vendeur (enregistrement des ventes)
- **Analytique** : KPIs, classements produits/vendeurs, tendance mensuelle, filtrage par mois
- **Convertisseur EUR ↔ FCFA** intégré (taux fixe officiel 1 EUR = 655,957 XOF)
- **Notifications temps réel** via WebSocket (Socket.IO)
- **PWA** installable sur Android, iOS et desktop
- Authentification JWT (register / login)

## Stack

| Couche | Techno |
|---|---|
| API | NestJS 11, Mongoose, `class-validator`, `@nestjs/jwt`, Socket.IO |
| Web | Next.js (App Router), React 19, TypeScript 5, Tailwind CSS, `@base-ui/react` |
| Base de données | MongoDB 7 |
| Stockage images | MinIO (S3-compatible, dev) |
| Infra dev | Docker Compose |
| Monorepo | pnpm workspaces |

## Prérequis

- Node.js 22+
- pnpm (`corepack enable`)
- Docker Desktop

## Démarrage rapide (dev)

```bash
git clone <repo-url>
cd heyama-test

# 1. Démarrer MongoDB et MinIO
docker compose up -d

# 2. Créer le bucket MinIO
# Ouvre http://localhost:9001 (minioadmin / minioadmin123)
# Crée un bucket nommé heyama-objects et passe-le en accès public (lecture)

# 3. Variables d'environnement API
cp api/.env.example api/.env
# Vérifie/modifie les valeurs si besoin

# 4. Variables d'environnement Web
cp web/.env.example web/.env.local
# NEXT_PUBLIC_API_URL=http://localhost:4000

# 5. Installer les dépendances
pnpm install

# 6. Lancer les deux serveurs
pnpm --filter api start:dev   # NestJS sur http://localhost:4000
pnpm --filter web dev         # Next.js sur http://localhost:3000
```

## Structure du monorepo

```
├── api/              # Backend NestJS
│   └── src/
│       ├── auth/     # JWT, guards, stratégies
│       ├── users/    # Gestion des utilisateurs
│       ├── sections/ # Catégories de produits
│       ├── products/ # Catalogue + métriques
│       ├── sales/    # Enregistrement des ventes
│       ├── audit/    # Historique immuable
│       ├── analytics/# Agrégations MongoDB
│       ├── events/   # Passerelle WebSocket
│       └── s3/       # Upload images (MinIO/S3)
├── web/              # Frontend Next.js
│   └── src/
│       ├── app/      # Pages (App Router)
│       ├── components/
│       ├── hooks/    # useProducts, useSections, useSocket
│       └── lib/      # api.ts, auth.ts, currency.ts
├── docker-compose.yml          # Dev
├── docker-compose.prod.yml     # Production
└── nginx/nginx.conf            # Reverse proxy prod
```

## Production

Voir [docker-compose.prod.yml](docker-compose.prod.yml) et [nginx/nginx.conf](nginx/nginx.conf).

```bash
cp .env.prod.example .env.prod
# Remplis tous les secrets dans .env.prod
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

Consulte la section **Production** dans [api/README.md](api/README.md) pour les détails.

# → Buckets → Create bucket → name it "heyama-objects"
# → Bucket → Anonymous access → add a "readonly" policy on prefix "*"
#   (so uploaded images are publicly viewable from the browser)

# 3. Install dependencies
pnpm install

# 4. Configure environment variables
cp api/.env.example api/.env
cp web/.env.example web/.env.local
# defaults already match the docker-compose services, no edits needed for local dev

# 5. Run the API and the web app (two terminals)
pnpm --filter api start:dev   # http://localhost:4000
pnpm --filter web dev         # http://localhost:3000
```

Open http://localhost:3000, create an object with an image — it appears
instantly (via Socket.IO) on every open tab, including the one you're not
using.

## Environment variables

See `api/.env.example` and `web/.env.example` for the full list. Local
defaults are pre-wired to the `docker-compose.yml` services (MongoDB on
`27017`, MinIO on `9000`).

## Project structure

```
api/    NestJS REST API + WebSocket gateway
web/    Next.js frontend
```

## Scripts

From the repo root:

```bash
pnpm lint     # lint api + web
pnpm format   # prettier --write on the whole repo
```

Per package:

```bash
pnpm --filter api test    # jest unit tests
pnpm --filter api build   # nest build
pnpm --filter web build   # next build
```

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs lint, tests and build for
`api` and `web` on every push/PR to `main`/`dev`.
