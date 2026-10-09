# Stock Master — Application de gestion

Application collaborative de gestion des ventes et du stock pour **Stock Master**.

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
| Stockage images | MinIO (S3-compatible) en dev · Supabase Storage en prod |
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
3. **Buckets → Create Bucket** → nom : `stockmaster-objects`
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

Les services sont déployés séparément sur des plateformes managées :

| Service | Plateforme | Déclencheur |
|---|---|---|
| `web/` (Next.js) | Vercel | Push sur `main` (intégration GitHub native) |
| `api/` (NestJS) | Railway | Push sur `main` (intégration GitHub native) |
| Base de données | MongoDB Atlas | Managé |
| Stockage images | Supabase Storage | Managé |

### Variables d'environnement production

À configurer dans les dashboards Railway et Vercel :

**Railway (API)** :
```env
PORT=4000
MONGODB_URI=<uri-atlas>
JWT_SECRET=<chaine-aleatoire-256-bits>
CORS_ORIGIN=https://<votre-domaine-vercel>.vercel.app
S3_ENDPOINT=https://<ACCOUNT_ID>.<jurisdiction>.r2.cloudflarestorage.com
S3_REGION=auto
S3_ACCESS_KEY=<r2-access-key-id>
S3_SECRET_KEY=<r2-secret-access-key>
S3_BUCKET=stockmaster-prod
S3_FORCE_PATH_STYLE=false
TZ=Africa/Douala
```

`TZ` (1-16D) fixe le calendrier des mois : bornes de l'Analyse, de
l'historique mensuel exportable et du bilan mensuel. Au lancement au
Cameroun : `Africa/Douala` (UTC+1, sans heure d'été). Sans `TZ`, le fuseau du
conteneur s'applique (UTC sur `node:22-alpine`). Un nom inconnu bloque le
démarrage de l'API (sinon Node basculerait silencieusement en UTC) ; le
fuseau effectif est journalisé au démarrage (« Fuseau des bornes
mensuelles »). Changer `TZ` ne modifie aucune date enregistrée (toutes en
UTC) : seul le rattachement d'une vente proche de minuit à un mois change.
À définir dans Railway **avant** l'ouverture (configuration Railway actuelle
non consultée par le lot 1-16D).

**Vercel (Web)** :
```env
NEXT_PUBLIC_API_URL=https://<votre-service>.railway.app
```

### Migrations à exécuter avant l'activation d'une version

**Règle : une migration requise par une version s'exécute AVANT que cette
version de l'API ne reçoive du trafic.** Railway et Vercel déploient
automatiquement à chaque push sur `main` : sans précaution, la nouvelle API
peut démarrer avant ses index. Deux façons de garantir l'ordre :

1. **Recommandé : la « Pre-deploy Command » de Railway** (service API,
   Settings → Deploy). Elle s'exécute après la construction de l'image et
   **avant** le démarrage du nouveau déploiement, avec les variables du
   service (donc `MONGODB_URI`). Si elle sort avec un code non nul, elle
   n'est pas relancée et **le déploiement ne se poursuit pas** : la version
   en service reste active. Elle s'exécute à chaque déploiement ; toutes les
   migrations sont idempotentes (sans effet si l'index exact existe).
   Source : documentation Railway « Pre-deploy Command » et « Config as
   code » (`deploy.preDeployCommand`), consultée le 7 octobre 2026.
2. À défaut, depuis un poste ou un job contrôlé, **avant la fusion sur
   `main`**, avec l'URI de la base de production (jamais commitée).

#### Commande exacte depuis l'image de production

L'image `api/Dockerfile` ne contient **pas** pnpm (étape `runtime`) : les
scripts `pnpm --filter api migrate:*` n'y fonctionnent pas. Les programmes
compilés sont dans `/app/api/dist/migrations/` (dossier de travail de
l'image : `/app/api`), avec les seules dépendances de production. Les chemins
absolus ci-dessous fonctionnent quel que soit le dossier de lancement.

Pre-deploy Command (une seule commande, sans shell) :

```
node /app/api/dist/migrations/predeploy-migrations.js
```

Elle lance dans l'ordre, et s'arrête au premier échec :

| Migration | Depuis | Pourquoi elle est requise |
|---|---|---|
| `create-sale-operations-index.js` | 1-11C.1 | Vérifiée au démarrage en production : sans elle, l'API ne démarre pas |
| `create-subscription-period-indexes.js` | 1-14B | Idem |
| `create-subscription-payment-indexes.js` | 1-14D.2B | Idem |
| `create-subscription-payment-reconciliation-indexes.js` | 1-14D.2G | Requise par le CLI de rapprochement (`--apply`) |
| `create-push-notification-indexes.js` | 1-16A | Vérifiée au démarrage en production, même avec `WEB_PUSH_ENABLED=false` |
| `create-support-request-indexes.js` | 1-16C.1 | Index TTL `createdAt_1_ttl` (`expireAfterSeconds = 2592000`, 30 jours) du registre `support_requests`. Non bloquante au démarrage : sans elle, l'assistance fonctionne mais le registre n'expire jamais |
| `create-legal-acceptance-indexes.js` | 1-16C.2 | Collections `legal_acceptances` et `legal_document_versions`, index `{ userId, acceptedAt }`. Non bloquante au démarrage |
| `create-invitation-account-token-index.js` | 1-18B | Index partiel `accountTokenHash_1` de `organizationinvitations` (lien de création de compte d'un invité). Migration d'index uniquement, aucune donnée. Index de performance, non bloquant au démarrage ; aussi déclaré dans le schéma (mêmes nom et options), donc compatible avec `autoIndex`. Lecture seule : `--check` |

**Échec partiel :** chaque migration s'exécute à part et s'arrête au premier
échec. Les index déjà créés par les étapes précédentes **restent en place**
(rien n'est annulé, aucun index ni aucune donnée n'est supprimé
automatiquement). Ces index sont compatibles avec la version en service ; il
suffit de corriger la cause puis de relancer, les étapes déjà faites étant
sans effet.

Pour la seule migration de l'assistance :
`node /app/api/dist/migrations/create-support-request-indexes.js`.
Chaque migration échoue sans rien écraser si un index homonyme a une autre
configuration, ou si des doublons empêchent un index unique : le
déploiement est alors interrompu, à analyser avant de recommencer. Les outils
opérateur (`subscription:grant`, rapprochement, rattrapage d'historique) ne
sont **jamais** lancés par le pré-déploiement.

Réglages conseillés dans Railway :

- **Pre-deploy Timeout** : une valeur explicite (par exemple 300 secondes ;
  sans réglage, aucune limite) pour qu'une connexion bloquée fasse échouer
  le déploiement au lieu de le suspendre ;
- si l'accès réseau d'Atlas est limité par adresse IP, vérifier que le
  pré-déploiement y a accès comme l'API.

**Limites, à vérifier dans le tableau de bord Railway** (configuration non
présente dans le dépôt : ni `railway.json` ni `railway.toml`). La commande
dépend du constructeur et des chemins réels de l'image ; elle a été testée
avec les seules dépendances de production installées depuis le lockfile, mais
**ni l'image Docker ni Railway n'ont été vérifiés** (rapport 1-16C.2). Ces
chemins supposent que le service est construit avec `api/Dockerfile` et la racine du
dépôt comme contexte (`RAILWAY_DOCKERFILE_PATH=api/Dockerfile`, ou
équivalent). Avec un autre constructeur (Railpack), le dossier de l'image
diffère : depuis le dossier `api` du service, utiliser
`node dist/migrations/predeploy-migrations.js`.

#### Vérification en lecture seule

Sans aucune création ni lecture de données (liste des index uniquement ;
sortie 1 si l'index est absent ou différent) :

```
node /app/api/dist/migrations/create-support-request-indexes.js --check
# Attendu : « support_requests : index createdAt_1_ttl présent, createdAt,
#            expireAfterSeconds=2592000 (lecture seule). »
node /app/api/dist/migrations/create-legal-acceptance-indexes.js --check
```

Équivalent `mongosh`, en lecture seule :
`db.support_requests.getIndexes()` doit contenir
`{ key: { createdAt: 1 }, name: "createdAt_1_ttl", expireAfterSeconds: 2592000 }`.

#### Depuis un poste (dépôt cloné)

```bash
pnpm --filter api build
MONGODB_URI=<uri-atlas> pnpm --filter api migrate:predeploy
MONGODB_URI=<uri-atlas> node api/dist/migrations/create-support-request-indexes.js --check
```

Les autres migrations du dépôt (`migrate:*` dans `api/package.json`) sont
décrites dans les rapports de leurs lots (`docs/architecture/`).

### Documents juridiques versionnés (1-16C.2)

Les conditions d'utilisation, les conditions d'abonnement et la politique de
confidentialité sont acceptées (ou présentées) à l'inscription et à la
création d'un compte par invitation. Leur texte affiché est archivé dans
`api/src/legal/archive/` avec son empreinte. **Toute modification du texte
affiché** (y compris un prix ou une coordonnée rendus dans ces pages) exige
une nouvelle version dans `web/src/lib/legal/site-identity.ts`, puis :

```bash
node api/test/recipe/recipe.js isolated web-build --legal-archive=write --published-at=AAAA-MM-JJ
```

Le build vérifié (`isolated web-build`, et l'étape de la CI web) échoue tant
que le texte affiché diffère de l'archive de sa version. Une version archivée
n'est jamais réécrite. L'invite des comptes existants dans l'application
reste désactivée tant que `LEGAL_ACCEPTANCE_PROMPT_ENABLED` n'est pas
exactement `true` (variable du service API).

## CI/CD et rollback

Le dossier `.github/workflows/` contient deux workflows GitHub Actions :

| Fichier | Déclencheur | Description |
|---|---|---|
| `deploy.yml` | Fin de déploiement Railway/Vercel (`deployment_status`) | Health check API + Web → **rollback automatique** si l'un échoue |
| `rollback.yml` | Manuel (`workflow_dispatch`) | Rollback ciblé : `web`, `api`, ou `both` |

### Secrets GitHub requis

Configurer dans **Settings → Secrets and variables → Actions** :

| Secret | Description |
|---|---|
| `RAILWAY_TOKEN` | Railway → votre projet → Settings → Tokens |
| `VERCEL_TOKEN` | vercel.com → Account Settings → Tokens |
| `VERCEL_ORG_ID` | Champ `orgId` dans `web/.vercel/project.json` |
| `VERCEL_PROJECT_ID` | Champ `projectId` dans `web/.vercel/project.json` |
| `API_HEALTH_URL` | URL du endpoint `/health` de l'API Railway |
| `WEB_HEALTH_URL` | URL de production du frontend Vercel |

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
