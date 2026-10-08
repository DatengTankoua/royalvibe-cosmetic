# Phase 1-12E — Builds Docker reproductibles

Branche `architecture/phase-1-12e-reproducible-docker-builds`, base `14eb3fd` (1-12D). Aucun commit, aucun push, aucun déploiement, aucun registre Docker distant. **Aucun accès à Atlas, Supabase ni au port 27017 ; aucune donnée réelle** : les tests E2E utilisent `MongoMemoryReplSet` éphémère, le démarrage réel des conteneurs un `mongo:7` jetable sur un réseau Docker isolé, sans port publié. Aucun package applicatif ajouté ; `pnpm-lock.yaml` et `pnpm-workspace.yaml` inchangés.

## Décisions définitives de la phase

| Sujet | Décision |
| --- | --- |
| Image de base | `node:22.17.1-alpine3.22@sha256:5539840c…ea59`, **même référence** dans tous les stages API et web. |
| pnpm | `pnpm@11.18.0` exact via `corepack install` (champ `packageManager`), jamais `pnpm@latest` ni `npm install`. |
| Installation | Lockfile racine, `--frozen-lockfile`, contexte Docker = **racine du dépôt** pour les deux images. |
| Sharp | Binaires `linuxmusl-x64` uniquement, via `--os linux --cpu x64 --libc musl` **sur la ligne de commande Docker** ; `pnpm-workspace.yaml` reste multiplateforme. |
| Runtime API | `pnpm install --prod --ignore-scripts --filter api` (layout pnpm conservé), **pas** `pnpm deploy`. |
| Standalone Next | Activé **uniquement** si `DOCKER_BUILD=true` (défini dans le stage de build Docker) ; Vercel inchangé. |
| Arguments de build web | `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_REGISTRATION_ENABLED` (défaut `false`), `S3_HOSTNAME`. Aucun secret en `ARG`. |
| Utilisateur | `node` (uid 1000) dans les deux images runtime, sans pnpm ni sources. |
| Healthcheck | API : route publique existante `GET /health` ; web : contrôle local du port. Aucun package, aucun secret, aucun accès MongoDB. |
| Versions Nest | Laissées telles que dans le lockfile (`common`/`core` 11.1.28, `platform-express` 11.2.6) ; aucune uniformisation esthétique. |
| `TRUST_PROXY_HOPS` | Défaut `0`, **à mesurer avant le déploiement** (voir §7). |

## 1. Audit initial (base `14eb3fd`)

### Versions

| | Local / CI | Ancien `api/Dockerfile` | Ancien `web/Dockerfile` |
| --- | --- | --- | --- |
| Node | 22.17.1 (CI : 22) | `node:20-alpine` | `node:20-alpine` |
| pnpm | 11.18.0 (`packageManager`) | `pnpm@9` | `pnpm@latest` (non reproductible) |
| Docker | 29.4.3 | — | — |

### Problèmes constatés

1. **`api/Dockerfile` installait sans lockfile** : seul `api/package.json` était copié, puis `pnpm install --node-linker=hoisted`. Les `@nestjs/*` déployés pouvaient donc être la dernière 11.x du jour et non les versions testées (11.1.28 / 11.2.6 dans le lockfile).
2. L'image API embarquait **tout** `node_modules`, devDependencies comprises (jest, mongodb-memory-server…), et tournait en **root**.
3. **Contexte web `./web`** : `pnpm-lock.yaml` (racine) absent, d'où l'échec du `COPY`.
4. **Node 20** alors que pnpm 11 exige Node ≥ 22.
5. **`.next/standalone` attendu** alors que `output: "standalone"` était commenté.
6. **Binaires Sharp** : le lockfile référence 26 paquets `@img/sharp-*` (darwin, win32, wasm, toutes les variantes Linux) ; seul `linuxmusl-x64` est utile.
7. **Fuite possible de secrets** : `.dockerignore` racine limité à `node_modules`, `.next`, `dist`, `.git` ; aucun `.dockerignore` dans `web/`. Avec le contexte `./web`, `web/.env.local` (qui contient `VERCEL_OIDC_TOKEN`) et `web/.vercel/` auraient été copiés dans le stage de build.

### Contexte et fichiers sensibles présents sur disque (non suivis par Git)

`.env.prod`, `api/.env`, `api/.env.local`, `web/.env.local`, `web/.env.development.local`, `web/.vercel/`. Seuls les noms de variables ont été relevés, jamais les valeurs.

### Variables

- **Build web (publiques, inlinées par `next build`)** : `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_REGISTRATION_ENABLED`, `S3_HOSTNAME` (lu par `next.config.ts` pour `images.remotePatterns`).
- **Runtime API uniquement** : `MONGODB_URI`, `JWT_SECRET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `RESEND_API_KEY` (secrets) ; `CORS_ORIGIN`, `EMAIL_FROM`, `PUBLIC_APP_URL`, `PUBLIC_REGISTRATION_ENABLED`, `TRUST_PROXY_HOPS`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE`, `S3_PUBLIC_URL`, `PORT`, `NODE_ENV`.
- **Compose uniquement (`.env.prod`)** : `MONGO_USER`, `MONGO_PASSWORD`, `MINIO_USER`, `MINIO_PASSWORD`, `JWT_SECRET`.

### CI

`ci.yml` : Node 22, `pnpm install --frozen-lockfile`, aucun build Docker. `deploy.yml` / `rollback.yml` : Vercel. Aucun workflow ne construit d'image.

## 2. Image de base figée

Digest relevé sur l'image réellement téléchargée (`docker pull --platform linux/amd64`, puis `docker buildx imagetools inspect`) :

| Élément | Valeur |
| --- | --- |
| Tag | `node:22.17.1-alpine3.22` |
| Digest (index multi-arch, utilisé dans `FROM`) | `sha256:5539840ce9d013fa13e3b9814c9353024be7ac75aca5db6d039504a56c04ea59` |
| Manifeste linux/amd64 | `sha256:99351363debf40f3495cb7fc657a777334c3b21143e594dbfcc7de187439633c` |
| Node | v22.17.1 |
| Alpine | 3.22.1 |
| libc | musl (x86_64) |
| Architecture | linux/amd64 |
| corepack | 0.33.0 |

La référence est écrite en dur dans chaque `FROM` (pas d'`ARG`), pour qu'aucun `--build-arg` ne puisse la dé-figer.

## 3. Dockerfiles

### `api/Dockerfile`

| Stage | Rôle |
| --- | --- |
| `pnpm` | Copie `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `api/package.json` ; `corepack enable pnpm && corepack install`. |
| `build` | `MONGOMS_DISABLE_POSTINSTALL=1` (pas de binaire MongoDB de test) ; `pnpm install --frozen-lockfile --filter api --os linux --cpu x64 --libc musl` ; copie `api/` ; `pnpm --filter api build`. |
| `prod-deps` | `pnpm install --frozen-lockfile --prod --ignore-scripts --filter api --os linux --cpu x64 --libc musl`. |
| `runtime` | Image de base nue ; copie `/repo/node_modules` (store virtuel `.pnpm`), `api/node_modules` (liens symboliques), `api/dist`, `api/package.json` ; `USER node` ; `WORKDIR /app/api` ; `CMD ["node", "dist/main"]`. |

**Pourquoi pas `pnpm deploy`** : `pnpm install --prod --filter api` est une méthode pnpm officielle, lit le même lockfile, conserve le layout pnpm sans copie manuelle et a été validée par le démarrage réel du conteneur (§6).

**Pourquoi `--ignore-scripts` en production** : le script racine `prepare` appelle `husky`, devDependency absente en `--prod`, ce qui faisait échouer l'installation. Aucune dépendance de production n'a de script d'installation nécessaire : `sharp@0.35.5` n'en déclare aucun (binaires natifs fournis par `@img/*`). Le fonctionnement réel de Sharp est vérifié dans l'image.

### `web/Dockerfile`

| Stage | Rôle |
| --- | --- |
| `build` | Même installation pnpm ; `pnpm install --frozen-lockfile --filter web --os linux --cpu x64 --libc musl` ; copie `web/` ; `ARG` publics ; `DOCKER_BUILD=true` ; `pnpm --filter web build`. |
| `runtime` | Copie `.next/standalone` → `/app`, `.next/static` → `/app/web/.next/static`, `public` → `/app/web/public` ; `HOSTNAME=0.0.0.0`, `PORT=3000` ; `USER node` ; `WORKDIR /app/web` ; `CMD ["node", "server.js"]`. |

### Structure standalone observée (non supposée)

Avec `outputFileTracingRoot` = racine du dépôt, le build produit :

```
/app
├── node_modules/        # store pnpm tracé (.pnpm/…)
└── web/
    ├── .next/
    ├── node_modules/
    ├── package.json
    ├── public/
    └── server.js        # serveur Next
```

Le serveur est donc bien dans `.next/standalone/web/server.js`, et le Dockerfile démarre exactement cette structure.

## 4. `next.config.ts`

```ts
const isDockerBuild = process.env.DOCKER_BUILD === "true";

const nextConfig: NextConfig = {
  ...(isDockerBuild
    ? {
        output: "standalone" as const,
        outputFileTracingRoot: path.join(__dirname, ".."),
      }
    : {}),
  images: { … }, // inchangé
};
```

`DOCKER_BUILD` n'est défini que dans le stage `build` de `web/Dockerfile`. Un `pnpm --filter web build` local (chemin Vercel) ne produit **pas** de dossier `.next/standalone`.

## 5. Protection des secrets

### `.dockerignore` racine

Exclut explicitement : `.env`, `.env.*`, `**/.env`, `**/.env.*`, `**/.vercel`, `**/.vercel/**`, `node_modules`, `**/node_modules`, `.next`, `**/.next`, `dist`, `**/dist`, `coverage`, `**/coverage`, `*.tsbuildinfo`, `*.log`, `.git`, ainsi que `.github`, `.husky`, `.claude`, `docs`, `nginx`. Aucun `node_modules` Windows ne peut entrer dans une image.

### Vérifications après build

- **`docker history --no-trunc`** : aucun `ARG`, aucune variable secrète dans les couches runtime (les `ARG` publics restent dans le stage de build, non livré).
- **`docker inspect`** : variables configurées = `PATH`, `NODE_VERSION`, `YARN_VERSION`, `NODE_ENV`, `PORT` (+ `NEXT_TELEMETRY_DISABLED`, `HOSTNAME` pour le web). Aucun secret.
- **Système de fichiers** : aucun fichier `.env*`, `.vercel` ni `.tsbuildinfo` provenant du contexte.
- **Recherche des valeurs** : chaque valeur locale de `.env.prod`, `api/.env*` et `web/.env*.local` (≥ 12 caractères) a été recherchée dans `/app`, `/home`, `/root`, `/tmp` et `/etc` des **quatre** images, à l'intérieur des conteneurs, valeurs transmises par stdin et **jamais affichées ni écrites sur disque**. Résultat : absentes, notamment `VERCEL_OIDC_TOKEN`, `JWT_SECRET`, identifiants Mongo et MinIO. Seule correspondance : la valeur locale de `CORS_ORIGIN` (`http://localhost:…`, publique), présente dans le fallback de développement de `origin.helpers.js` et dans la documentation d'`express`, `accepts` et `@types/node`. Aucun fichier ne contient d'affectation `JWT_SECRET=`, `RESEND_API_KEY=` ni `VERCEL_OIDC_TOKEN`.

## 6. Vérifications dans les images

| | API | Web |
| --- | --- | --- |
| OS / arch | linux/amd64 | linux/amd64 |
| `process.version` | v22.17.1 | v22.17.1 |
| libc | musl | musl |
| Utilisateur effectif | `node` (1000) | `node` (1000) |
| pnpm dans le runtime | absent | absent |
| Versions | `@nestjs/common` 11.1.28, `core` 11.1.28, `platform-express` 11.2.6, `websockets` 11.1.28, `platform-socket.io` 11.1.28, `throttler` 6.7.0, `mongoose` (Nest) 11.0.4, `mongoose` 9.9.0, `multer` 2.4.0, `sharp` 0.35.5 | `next` 16.3.6, `react` 19.2.4, `react-dom` 19.2.4, `sharp` 0.35.5 (résolu via Next) |
| Binaires `@img` | `sharp-linuxmusl-x64`, `sharp-libvips-linuxmusl-x64` (+ `@img/colour`, JS pur) | idem |
| Sharp réel | encodage/décodage WebP OK, libvips 8.18.7 | encodage WebP OK, libvips 8.18.7 |
| Taille (`docker inspect`) | 75,5 Mo | 70,4 Mo |

**Toutes les versions sont exactement celles de `pnpm-lock.yaml`.**

### Démarrage réel (réseau Docker isolé, `mongo:7` jetable, valeurs factices)

- **API sans migration** : refus de démarrer avec `SaleOperationIndexError` (index `sale_operations` absent). Comportement voulu.
- **Migration depuis l'image** : `node dist/migrations/create-sale-operations-index.js` → « index idempotent créé et vérifié », exit 0. Les migrations compilées sont donc bien présentes.
- **API après migration** : `healthy` ; `GET /health` → 200 `{"status":"ok"}` ; `POST /auth/register` avec corps vide → 400 (validation) ; « Nest application successfully started ».
- **Web** : `healthy`, « Next.js 16.3.6 — Ready ».
- **Templates email** : aucun fichier, le contenu est construit dans `resend-email.service.ts` et compilé dans `dist`.
- **Dépendances workspace** : ni `api` ni `web` ne dépendent d'un autre paquet du workspace.

### Reproductibilité (second build `--no-cache`)

| | Build A vs build B |
| --- | --- |
| Web | Même ensemble de paquets `.pnpm`, fichiers **identiques** hors `.next` (1 694 fichiers). |
| API | Même ensemble de paquets, `dist/` et dépendances **identiques octet pour octet** (13 152 fichiers). Seuls diffèrent `node_modules/.modules.yaml` et `node_modules/.pnpm-workspace-state-v1.json` (métadonnées pnpm horodatées). |
| Digests finaux | Différents (horodatages, `BUILD_ID` Next) — accepté. |

## 7. Compose

### `docker-compose.prod.yml`

- **`api`** : contexte `.` (déjà), ajout des variables runtime manquantes, **sans aucune valeur secrète** :

  ```yaml
  RESEND_API_KEY: ${RESEND_API_KEY:-}
  EMAIL_FROM: ${EMAIL_FROM:-}
  PUBLIC_APP_URL: ${PUBLIC_APP_URL:-}
  PUBLIC_REGISTRATION_ENABLED: ${PUBLIC_REGISTRATION_ENABLED:-false}
  TRUST_PROXY_HOPS: ${TRUST_PROXY_HOPS:-0}
  ```

  Les trois variables email restent optionnelles : sans elles, `ResendEmailService` renvoie `manual` et l'API démarre. `${VAR:?}` n'est pas utilisé, faute de politique existante dans ce Compose ; l'API bloque déjà le démarrage sans `JWT_SECRET` (`getOrThrow`), sans `CORS_ORIGIN` valide en production, ou sans la migration.
- **`web`** : contexte `.`, `dockerfile: web/Dockerfile`, trois `build.args` publics. Le bloc runtime `environment: NEXT_PUBLIC_API_URL` a été **supprimé** : la valeur est inlinée au build, la conserver au runtime laissait croire qu'un redémarrage suffisait à la changer.

### `TRUST_PROXY_HOPS` — checklist de déploiement

`.env.prod.example` contient désormais `TRUST_PROXY_HOPS=0` avec la consigne :

> À mesurer avant le déploiement. Utiliser 1 uniquement si l'API est exclusivement accessible à travers un unique proxy nginx de confiance et n'est pas directement exposée.

Choisir `1` sans avoir confirmé tous les chemins réseau affaiblirait la confiance accordée à `X-Forwarded-For`. Ce point ne bloque pas la reproductibilité des images.

### `.env.prod.example`

Ajout des noms `RESEND_API_KEY`, `EMAIL_FROM`, `PUBLIC_APP_URL` (valeurs vides) et de `TRUST_PROXY_HOPS=0` décommenté.

## 8. Résultats (exécutions réelles)

| Commande / contrôle | Résultat |
| --- | --- |
| `pnpm --filter api test` | **48 suites, 787/787** |
| `pnpm --filter api test:e2e` | **12 suites, 289/289** |
| `pnpm --filter api exec eslint "{src,apps,libs,test}/**/*.ts"` | 0 erreur, 2 avertissements préexistants (`no-unsafe-argument`, `test/app.e2e-spec.ts:505`, `test/e2e/ephemeral-mongodb.ts:67`, fichiers non modifiés) |
| `pnpm --filter api build` | OK |
| `pnpm --filter web lint` | OK |
| `pnpm --filter web exec tsc --noEmit` | OK |
| `pnpm --filter web build` | OK, sans `.next/standalone` |
| `pnpm audit` | **45** (0 critical, 20 high, 21 moderate, 4 low), exit 1 — voir ci-dessous |
| `git diff --check` | Propre |
| `docker compose config --quiet` | OK |
| `docker compose -f docker-compose.prod.yml --env-file .env.prod.example config --quiet` | OK |
| Build Docker API et web `--no-cache` ×2 | OK ×2 |

### `pnpm audit`

Le lockfile est **identique** à 1-12D (32 avis à la clôture de 1-12D) : la hausse à 45 correspond à des avis publiés depuis, pas à un changement de dépendances. `pnpm audit --prod` : 37 (0 critical, 14 high, 19 moderate, 4 low).

Paquets vulnérables **réellement présents dans les images** :

| Image | Paquet | Sévérité | Corrigé en | Origine |
| --- | --- | --- | --- | --- |
| API | `engine.io` 6.6.9 | high | 6.6.10 | `socket.io` (runtime) |
| API | `qs` 6.15.3 | moderate | 6.16.0 | `express` (runtime) |
| Web | aucun | — | — | — |

Les autres avis concernent l'outillage de développement (`@nestjs/cli`, `jest`, `eslint` : `fast-uri`, `js-yaml`, `brace-expansion`, `nanoid`) ou la CLI `shadcn` (`undici`, `hono`, `ip-address`), absents des images. Leur correction modifierait le lockfile et relève d'une phase dédiée.

## 9. Fichiers

| Fichier | Changement |
| --- | --- |
| `.dockerignore` | Exclusions explicites des secrets, artefacts et outillage |
| `api/Dockerfile` | Réécrit : image figée, pnpm 11.18.0, lockfile, Sharp musl, runtime prod non root, healthcheck `/health` |
| `web/Dockerfile` | Réécrit : contexte racine, image figée, standalone observé, `ARG` publics, non root, healthcheck port |
| `web/next.config.ts` | Standalone conditionnel `DOCKER_BUILD=true` |
| `docker-compose.prod.yml` | Contexte web racine, `build.args` publics, variables API manquantes, suppression de l'`environment` web |
| `.env.prod.example` | Noms email, `TRUST_PROXY_HOPS=0` et consigne |
| `docs/architecture/phase-1-12e-reproducible-docker-builds.md` | **Nouveau** : ce document |

Inchangés : `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `package.json` (racine, `api`, `web`), `docker-compose.yml`, workflows CI.

## 10. Risques résiduels

- **`engine.io` 6.6.9 et `qs` 6.15.3** dans le runtime API : à corriger dans une phase de dépendances dédiée.
- **`TRUST_PROXY_HOPS`** : défaut `0`, à mesurer avant tout déploiement derrière nginx.
- **npm et yarn** restent présents dans les images runtime (fournis par l'image de base, jamais utilisés) ; les retirer exigerait un `rm -rf` sous `/usr/local`.
- **Téléchargement de pnpm** par corepack au build : version exacte et signature vérifiée par corepack, mais dépendance au registre npm pendant le build.
- **Mise à jour de l'image de base** : le digest figé ne reçoit plus les correctifs Alpine/Node ; toute montée de version doit être explicite (nouveau tag + digest vérifié).
- **Migration obligatoire** avant le premier démarrage de l'API (`node dist/migrations/create-sale-operations-index.js` dans l'image, pnpm n'y étant pas disponible).
- **Images locales de validation** (`heyama-{api,web}:1-12e-{a,b}`) : à supprimer manuellement après le commit.
