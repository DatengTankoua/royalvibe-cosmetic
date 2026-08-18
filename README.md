# RoyalVibe Cosmétiques & Bijoux — Application de gestion

Application collaborative de gestion des ventes pour **RoyalVibe Cosmétiques & Bijoux**.
Produits achetés en Europe (€) et revendus en Afrique (FCFA/XOF).

---

## Sommaire

1. [Fonctionnalités](#fonctionnalités)
2. [Stack technique](#stack-technique)
3. [Prérequis](#prérequis)
4. [Démarrage rapide](#démarrage-rapide-dev)
5. [Structure du monorepo](#structure-du-monorepo)
6. [Rôles utilisateurs](#rôles-utilisateurs)
7. [Commandes utiles](#commandes-utiles)
8. [Déploiement production](#déploiement-production)
9. [CI/CD et rollback](#cicd-et-rollback)

---

## Fonctionnalités

- **Catalogue produits** organisé par sections (catégories hiérarchiques)
- **Suivi des ventes** avec historique complet et journal d'audit immuable
- **Corbeille** : suppression douce avec restauration ou suppression définitive
- **Analytique** : KPIs globaux, classements produits/vendeurs, tendance mensuelle, filtre par mois
- **Convertisseur EUR ↔ FCFA** intégré (taux fixe officiel : 1 EUR = 655,957 XOF)
- **Notifications temps réel** via WebSocket (Socket.IO) à chaque création/modification
- **PWA** installable sur Android, iOS et desktop
- Authentification JWT (register / login) avec deux rôles : Admin et Vendeur

## Stack technique

| Couche | Technologie |
|---|---|
| API | NestJS 11 · TypeScript · Mongoose · `@nestjs/jwt` · Socket.IO |
| Web | Next.js 16 (App Router) · React 19 · TypeScript 5 · Tailwind CSS · `@base-ui/react` |
| Base de données | MongoDB 7 |
| Stockage images | MinIO (S3-compatible) en dev, remplaçable par AWS S3 / Supabase en prod |
| Reverse proxy | Nginx (prod uniquement) |
| Monorepo | pnpm workspaces |
| Qualité | Husky + lint-staged + ESLint + Prettier |

## Prérequis

| Outil | Version minimale | Installation |
|---|---|---|
| Node.js | 22+ | [nodejs.org](https://nodejs.org) |
| pnpm | 11+ | `corepack enable` |
| Docker Desktop | — | [docker.com](https://www.docker.com/products/docker-desktop) |
| Git | — | [git-scm.com](https://git-scm.com) |

## Démarrage rapide (dev)

### 1 · Cloner le dépôt

```bash
git clone <repo-url>
cd heyama-test
```

### 2 · Installer les dépendances

```bash
pnpm install
```

### 3 · Démarrer MongoDB et MinIO

```bash
docker compose up -d
```

Services lancés :
- **MongoDB** → `mongodb://localhost:27017`
- **MinIO (S3)** → `http://localhost:9000`
- **MinIO Console** → `http://localhost:9001` (admin : `minioadmin` / `minioadmin123`)
- **Mongo Express** → `http://localhost:8081`

### 4 · Créer le bucket MinIO

1. Ouvrir [http://localhost:9001](http://localhost:9001)
2. Se connecter avec `minioadmin` / `minioadmin123`
3. **Buckets → Create Bucket** → nom : `heyama-objects`
4. Aller dans le bucket → **Access Policy** → passer en `public`

> Cette étape est nécessaire pour que les images des produits soient accessibles publiquement.

### 5 · Configurer les variables d'environnement

```bash
cp api/.env.example api/.env       # Les valeurs par défaut fonctionnent avec docker-compose.yml
cp web/.env.example web/.env.local # NEXT_PUBLIC_API_URL=http://localhost:4000
```

### 6 · Lancer les serveurs de développement

Dans deux terminaux séparés :

```bash
# Terminal 1 — API NestJS (http://localhost:4000)
pnpm --filter api start:dev

# Terminal 2 — Web Next.js (http://localhost:3000)
pnpm --filter web dev
```

Ou depuis les dossiers respectifs :

```bash
cd api && pnpm start:dev
cd web && pnpm dev
```

### 7 · Créer le premier compte Admin

L'API étant lancée, créer un compte via `curl` ou [Postman](https://www.postman.com) :

```bash
curl -X POST http://localhost:4000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name": "Admin", "email": "admin@example.com", "password": "motdepasse"}'
```

> Le premier utilisateur enregistré aura le rôle `admin` par défaut. Modifiable directement en base via Mongo Express.

---

## Structure du monorepo

```
heyama-test/
├── api/                        # Backend NestJS
│   ├── src/
│   │   ├── auth/               # JWT, guards, stratégies Passport
│   │   ├── users/              # Schéma User, rôles Admin/Seller
│   │   ├── sections/           # Catégories hiérarchiques (CRUD admin)
│   │   ├── products/           # Catalogue + métriques calculées
│   │   ├── sales/              # Enregistrement ventes, décrémentation stock
│   │   ├── audit/              # Journal immuable de chaque modification
│   │   ├── analytics/          # Agrégations MongoDB : KPIs, classements
│   │   ├── events/             # Passerelle WebSocket (Socket.IO)
│   │   ├── s3/                 # Upload/suppression images (MinIO/S3)
│   │   └── trash/              # Suppression douce + restauration
│   ├── .env.example
│   └── Dockerfile
├── web/                        # Frontend Next.js
│   ├── src/
│   │   ├── app/                # Pages Next.js App Router
│   │   ├── components/         # Composants UI réutilisables
│   │   ├── hooks/              # useProducts, useSections, useSocket, useTrash…
│   │   └── lib/                # api.ts, auth.ts, currency.ts, utils.ts
│   ├── .env.example
│   └── Dockerfile
├── nginx/nginx.conf            # Reverse proxy (prod)
├── docker-compose.yml          # Infra dev (MongoDB + MinIO)
├── docker-compose.prod.yml     # Stack complète de production
├── .github/workflows/
│   ├── deploy.yml              # Déploiement automatique + rollback auto
│   └── rollback.yml            # Rollback manuel (workflow_dispatch)
└── pnpm-workspace.yaml
```

## Rôles utilisateurs

| Rôle | Permissions |
|---|---|
| **Admin** | CRUD complet : sections, produits, consultation analytics |
| **Seller** | Enregistrement des ventes uniquement |

## Commandes utiles

```bash
# Lancer toute l'infra dev (MongoDB + MinIO)
docker compose up -d

# Arrêter l'infra dev
docker compose down

# Installer toutes les dépendances du monorepo
pnpm install

# Lancer l'API en dev (http://localhost:4000)
pnpm --filter api start:dev

# Lancer le web en dev (http://localhost:3000)
pnpm --filter web dev

# Linter les deux packages
pnpm lint

# Formatter tout le monorepo
pnpm format

# Build de l'API
pnpm --filter api build

# Build du web
pnpm --filter web build

# Tests API
pnpm --filter api test
pnpm --filter api test:e2e
```

## Déploiement production

La production utilise `docker-compose.prod.yml` qui orchestre : MongoDB, MinIO, API NestJS, Next.js et Nginx.

### Variables d'environnement production

Créer un fichier `.env.prod` à la racine :

```env
MONGO_USER=royalvibe
MONGO_PASSWORD=<mot-de-passe-fort>
JWT_SECRET=<chaine-aleatoire-256-bits>
WEB_URL=https://royalvibe.tondomaine.com
API_URL=https://api.royalvibe.tondomaine.com
S3_PUBLIC_URL=https://s3.royalvibe.tondomaine.com
MINIO_USER=<minio-admin>
MINIO_PASSWORD=<minio-mot-de-passe-fort>
```

### Commande de déploiement

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

### Nginx

Éditer `nginx/nginx.conf` pour remplacer `royalvibe.tondomaine.com` par votre domaine réel et placer les certificats SSL dans `nginx/certs/`.

## CI/CD et rollback

Le dossier `.github/workflows/` contient deux workflows GitHub Actions :

| Fichier | Déclencheur | Description |
|---|---|---|
| `deploy.yml` | Push sur `main` | Build + deploy + health check + **rollback automatique** si health check échoue |
| `rollback.yml` | Manuel (`workflow_dispatch`) | Rollback vers un SHA précis ou vers `HEAD~1` |

### Secrets GitHub requis

Configurer dans **Settings → Secrets and variables → Actions** :

| Secret | Description |
|---|---|
| `SSH_HOST` | IP ou domaine du serveur de production |
| `SSH_USER` | Utilisateur SSH (ex : `ubuntu`) |
| `SSH_PRIVATE_KEY` | Clé privée SSH complète |
| `DEPLOY_PATH` | Chemin du projet sur le serveur (ex : `/home/ubuntu/royalvibe`) |
| `HEALTH_URL` | URL testée après déploiement (ex : `https://royalvibe.tondomaine.com`) |

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
