# Audit SaaS — RoyalVibe Cosmétiques & Bijoux

> **Date** : 17 septembre 2026
> **Branch / commit** : `dev` · `257109e` (clean)
> **Périmètre** : audit technique et sécurité, **aucune modification de code, de données, d'environnement**.
> **Méthode** : lecture système du monorepo (`api/`, `web/`, infra, CI), sans exécuter de commande qui pourrait muter le code ou la base.
> **Référence** : aucun fichier `AGENTS.md` / `QWEN.md` / `CLAUDE.md` présent à la racine du projet (les seules occurrences sont dans `node_modules/`, sans rapport).

---

## 1. Résumé exécutif

L'application est **mono-entreprise de bout en bout**. Aucune donnée, aucun endpoint, aucun événement temps réel, aucune image et aucun index MongoDB n'est scindé par organisation. La transformation multi-tenant est **structurellement possible** mais constitue un **changement à impact global** sur :

- les 6 collections MongoDB (aucune n'a actuellement `organizationId`),
- le schéma JWT (rôle figé 7 jours, sans révocation, sans `organizationId`),
- les 26 endpoints API (aucun filtre `organizationId`),
- le gateway Socket.IO (émissions broadcast, CORS `*`, **aucune validation du token côté serveur**),
- le stockage S3 (bucket public, clés `UUID-originalname`, sans préfixe `organizations/`),
- le frontend (routes à migrer sous `/app`, `manifest`/`sw`/logo à rebranding).

Deux constats **surprenants** ont été identifiés :

1. **Le module `objects` (collection) est orphelin** : `ObjectsModule` est défini dans `api/src/objects/objects.module.ts` mais **n'est jamais importé dans `AppModule`**. Les 3 endpoints `GET/POST/DELETE /objects` sont donc **inaccessibles**. Le module est résiduel (d'un prototype initial d'"objects manager") et peut être retiré avant la phase 0.
2. **Le README annonce qu'"le premier utilisateur enregistré aura le rôle `admin` par défaut"** mais **le code ne l'implémente pas** : `UserRole` a un `default: UserRole.SELLER` en ligne directe et `AuthService.register()` ne vérifie pas le nombre de users existants. Le premier utilisateur est donc `seller` en pratique, contrairement à la doc. Ce comportement est **non vérifié dans la base** (aucun moyen d'inspecter l'état de production sans y accéder).

Deux vulnérabilités majeures **avant** la multi-entreprise :
- **Lecture des analytics par n'importe quel utilisateur connecté (y compris `seller`)** — `analytics.controller.ts` n'exige aucun rôle ; un vendeur peut lire KPIs, classements produits et classements **vendeurs** (donc email + revenue de ses collègues).
- **`CORS` `app.enableCors({ origin: ... ?? true })`** : si `CORS_ORIGIN` est vide, toutes les origines sont autorisées (cross-site data leakage via CORS).

Aucune modification n'a été effectuée ; ce document est le seul livrable.

---

## 2. Architecture observée

### 2.1 Monorepo

```
heyama-test/                       pnpm-workspace.yaml (api + web)
├── api/                           NestJS 11 · TS 5.7 · Mongoose · @nestjs/jwt · socket.io
│   ├── src/
│   │   ├── main.ts                bootstrap (CORS, ValidationPipe, HttpExceptionFilter)
│   │   ├── app.module.ts          AppModule (imports tous les modules)
│   │   ├── app.controller.ts      GET / (Hello World) · GET /health  [public]
│   │   ├── auth/                  AuthService/Controller/Strategy, guards, decorators
│   │   ├── users/                 user.schema.ts (rôle enum), users.service.ts
│   │   ├── sections/              CRUD admin · soft delete
│   │   ├── products/              CRUD admin · S3 · audit · events
│   │   ├── sales/                 POST (tous) · PATCH/DELETE (admin)
│   │   ├── analytics/             4 aggregates
│   │   ├── audit/                 AuditService (écriture uniquement, pas de controller)
│   │   ├── trash/                 GET /trash (admin)
│   │   ├── events/                EventsGateway (socket.io)
│   │   ├── s3/                    S3Service
│   │   ├── objects/               ⚠ orphelin (voir §1)
│   │   └── common/                ParseObjectIdPipe, HttpExceptionFilter
│   ├── test/                      app.e2e-spec.ts (1 test)
│   └── .env.example
├── web/                           Next.js 16 · React 19 · Tailwind v4 · @base-ui · recharts
│   ├── src/
│   │   ├── app/                   App Router (page /, /auth/login, /auth/register, /products/[id], /sections/[id], /objects/[id] redirect, /sales, /analytics, /corbeille)
│   │   ├── components/            UI (alert-dialog, dialog, …) + sections + products + currency + layout (navbar, pwa-register)
│   │   ├── contexts/              AuthProvider (localStorage)
│   │   ├── hooks/                 use-socket, use-sections, use-products, use-objects (legacy), use-trash
│   │   └── lib/                   api.ts (axios), auth.ts (localStorage), currency.ts, utils.ts
│   ├── public/                    sw.js, logo.jpg, icon-192/152.png
│   └── .env.example               NEXT_PUBLIC_API_URL
├── docker-compose.yml             mongo:27017 + minio:9000/9001 + mongo-express:8081
├── docker-compose.prod.yml        mongo + minio + api + web + nginx, tous en nom royalvibe-*
├── nginx/nginx.conf               3 vhosts : royalvibe / api.royalvibe / s3.royalvibe
├── .env.prod.example              domaines royalvibe-*.tondomaine.com, comptes royalvibe_*
└── .github/workflows/
    ├── ci.yml                     pnpm install + lint + test + build (api & web)
    ├── deploy.yml                 health check + auto-rollback
    └── rollback.yml               rollback manuel (workflow_dispatch)
```

### 2.2 Dépendances frontend → API

- **HTTP** : `web/src/lib/api.ts` (axios, `baseURL: process.env.NEXT_PUBLIC_API_URL`). Interceptor d'auth (Bearer) + interceptor de 401 (`clearAuth` + redirect `/auth/login`).
- **WebSocket** : `web/src/hooks/use-socket.ts` → `io(NEXT_PUBLIC_API_URL, { auth: { token } })`. Le token est envoyé dans l'en-tête d'auth de la connexion **mais le gateway côté serveur ne le lit pas** (voir §7).
- **Images** : `web/public/logo.jpg` + 2 icônes. L'`<Image>` des produits pointe vers l'URL S3 (`unoptimized`).
- **Aucune importation de données SaaS** n'est prévue ; l'app est une PWA installable avec `start_url: "/"`.

### 2.3 Environnement

| Variable | Dev (`.env.example`) | Prod (`docker-compose.prod.yml`) |
|---|---|---|
| `PORT` | `4000` | `4000` |
| `MONGODB_URI` | `mongodb://localhost:27017/heyama` | `mongodb://mongo:27017/royalvibe?authSource=admin` |
| `JWT_SECRET` | `change-me-in-production-use-a-long-random-string` | `${JWT_SECRET}` (env var) |
| `CORS_ORIGIN` | `http://localhost:3000` | `${WEB_URL}` |
| `S3_ENDPOINT` | `http://localhost:9000` | `http://minio:9000` |
| `S3_BUCKET` | `heyama-objects` | `royalvibe-objects` |
| `S3_PUBLIC_URL` | *(undefined → dérivé de `endpoint/bucket`)* | `${S3_PUBLIC_URL}` |
| `S3_FORCE_PATH_STYLE` | `true` | `"true"` |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | `${API_URL}` (build-time) |

⚠ `CORS_ORIGIN` vide → `app.enableCors({ origin: true })` (`main.ts:9`) ; **toutes les origines sont autorisées** quand la variable n'est pas définie (risque CORS élevé, voir §8).

La **base de prod est nommée `royalvibe`** ; le **bucket prod est `royalvibe-objects`**. À la transformation, ces deux points doivent être **indifférents** (pas de valeur de marque dans le code, dans les `server_name` nginx oui).

### 2.4 Documentation

- `README.md` (racine) : exhaustif pour l'état mono-tenant ; **obsolète** dès la phase 0 (multi-tenant).
- `api/README.md` : référence API complète, **précaution** : la section "Référence API" documente un module `objects` qui n'existe pas en production (module orphelin non importé) ; la mention "12 mois" pour la tendance mensuelle est en fait une agrégation sur **toutes** les périodes (`.aggregate` sans `$match`).
- `web/README.md` : structure du frontend.
- **Aucune documentation** sur : l'`AuditLog` (schema), `TrashController`, `EventsGateway`, `S3Service`, les roles `seller` vs `admin` au-delà de la matrice basique, la politique de rétention des ventes, la gestion des données personnelles (pas de PDS/RGPD), le plan de test.

---

## 3. Table des routes frontend

| Route | Fichier | Accès | Protégée par | Appels API | Notes |
|---|---|---|---|---|---|
| `/` | `app/page.tsx` | **Tout le monde en UI** mais redirect login | Auth context (`useEffect` redirect) | `GET /sections` | Catalogue de sections (racine) |
| `/auth/login` | `app/auth/login/page.tsx` | Public | — | `POST /auth/login` | Form |
| `/auth/register` | `app/auth/register/page.tsx` | **Public** | — | `POST /auth/register` | Form, rôle = `seller` (par défaut DB) |
| `/analytics` | `app/analytics/page.tsx` | Tout login | Auth context (role non vérifié) | `GET /analytics/*` × 5 | KPIs, classements, tendance, produits épuisés |
| `/sales` | `app/sales/page.tsx` | Tout login | Auth context | `GET /sales` · `POST /sales` (via dialogs) | Liste + saisie (vendeur) |
| `/sections/[id]` | `app/sections/[id]/page.tsx` | Tout login | Auth context | `GET /sections/:id` · `GET /sections?parentId=` · `GET /products?sectionId=` · CRUD admin | Sous-sections / produits |
| `/products/[id]` | `app/products/[id]/page.tsx` | Tout login | Auth context | `GET /products/:id` · sales + audit | Vue détail, historique d'audit |
| `/corbeille` | `app/corbeille/page.tsx` | **Admin only** (front) | `user.role === "admin"` | `GET /trash` · restore / permanent | Bulk + individuel |
| `/objects/[id]` | `app/objects/[id]/page.tsx` | Legacy | — | — | Redirect → `/products/[id]` |

**Mécanismes de protection des pages** (frontend uniquement) :
- `useAuth()` + `useEffect(() => { if (!user) router.push("/auth/login"); })` sur chaque page client.
- `user.role === "admin"` côté client (ex. : corbeille) — **contournable en UI** (devtools) mais pas côté serveur car les endpoints admin ont bien `Roles(UserRole.ADMIN)` (voir §4). **Le frontend n'est pas une couche de sécurité ; seuls les guards NestJS font foi.**

**Navbar** : `/` + `/analytics` + `/sales` (si connecté) + `/corbeille` (si admin) + convertisseur EUR↔FCFA. Pas de garde-fou serveur.

**Routes à déplacer sous `/app`** : `/` (catalogue), `/analytics`, `/sales`, `/sections/[id]`, `/products/[id]`, `/corbeille`, `/objects/[id]` → `/app/...`. La page `/` devient la page commerciale publique (landing). Les pages d'auth restent à la racine.

---

## 4. Table des endpoints API

Règle globale : `JwtAuthGuard` + `RolesGuard` via `APP_GUARD`. `@Public()` pour les 3 routes publiques listées ci-dessous. Le `RolesGuard` n'est **ré-appelé** (`@UseGuards(RolesGuard)`) que sur les routes admin ; pour les routes sans `@Roles()`, le guard passe (rôle non requis).

| Méthode | Route | Auth | Rôle | Service | Risque / notes |
|---|---|---|---|---|---|
| GET | `/` | `@Public()` | — | `AppController` | Hello World |
| GET | `/health` | `@Public()` | — | `AppController` | Health check CI |
| POST | `/auth/register` | `@Public()` | — | `AuthService.register` | **Rôle `seller` par défaut ; aucun contrôle** |
| POST | `/auth/login` | `@Public()` | — | `AuthService.login` | Bearer, bcrypt compare |
| GET | `/auth/me` | JWT | — | `AuthController.me` | Renvoie le user (sans password) |
| GET | `/sections` | JWT | **aucun** | `SectionsService.findAll` | Tout login peut lire les sections |
| GET | `/sections/:id` | JWT | **aucun** | `SectionsService.findOne` | Id arbitraire |
| POST | `/sections` | JWT | `admin` | `SectionsService.create` | 409 si nom dupliqué sous le même parent |
| PATCH | `/sections/:id` | JWT | `admin` | `SectionsService.update` | Unicité nom (parent) |
| PATCH | `/sections/:id/restore` | JWT | `admin` | `SectionsService.restore` | `deletedAt: null` |
| DELETE | `/sections/:id` | JWT | `admin` | `SectionsService.remove` | Soft delete |
| DELETE | `/sections/:id/permanent` | JWT | `admin` | `SectionsService.permanentDelete` | **Suppression dure** |
| GET | `/products` | JWT | **aucun** | `ProductsService.findAll` | Tout login peut lire le catalogue + métriques |
| GET | `/products/:id` | JWT | **aucun** | `ProductsService.findOne` | Inclut **ventes** + **audit logs** (emails des acteurs !) |
| POST | `/products` | JWT | `admin` | `ProductsService.create` + S3 | FileInterceptor + `image/*` MIME, 5 Mo max |
| PATCH | `/products/:id` | JWT | `admin` | `ProductsService.update` | Audit `PRICE_CHANGED`, `NAME_CHANGED`, `STOCK_CHANGED`, `SECTION_CHANGED` |
| PATCH | `/products/:id/restore` | JWT | `admin` | `ProductsService.restore` | Emit `product:created` |
| DELETE | `/products/:id` | JWT | `admin` | `ProductsService.remove` | Soft delete + audit `DELETED` |
| DELETE | `/products/:id/permanent` | JWT | `admin` | `ProductsService.permanentDelete` | **Suppression dure + `s3.deleteFile`** |
| POST | `/sales` | JWT | **aucun** | `SalesService.create` | Tout login peut créer une vente → decrement stock + audit `SOLD` |
| GET | `/sales` | JWT | **aucun** | `SalesService.findAll` | Tout login peut lire **toutes** les ventes |
| PATCH | `/sales/:id` | JWT | `admin` | `SalesService.update` | ⚠ `:id` **sans `ParseObjectIdPipe`** → 500 sur id invalide au lieu de 400 |
| DELETE | `/sales/:id` | JWT | `admin` | `SalesService.remove` | ⚠ `:id` **sans `ParseObjectIdPipe`** (idem) |
| GET | `/analytics/overview` | JWT | **aucun** | `AnalyticsService.getOverview` | ⚠ Tout login peut lire les KPIs globaux |
| GET | `/analytics/products/ranking` | JWT | **aucun** | `AnalyticsService.getProductsRanking` | ⚠ Tout login |
| GET | `/analytics/sellers/ranking` | JWT | **aucun** | `AnalyticsService.getSellersRanking` | ⚠ Email + revenue de tous les vendeurs |
| GET | `/analytics/monthly` | JWT | **aucun** | `AnalyticsService.getMonthlyTrend` | ⚠ Tout login (pas de `month` param malgré la doc) |
| GET | `/trash` | JWT | `admin` | `SectionsService.findTrashed` + `ProductsService.findTrashed` | Liste globale des produits + sections supprimés |

**Endpoints inaccessibles (module orphelin `objects`)** : `POST/GET/DELETE /objects` — `ObjectsModule` n'est **pas importé** dans `AppModule`, donc jamais compilé ; les routes ne répondent pas 404 mais **ne sont pas montées**. Le module reste dans le code source (`api/src/objects/*`) et les tests existent. Le frontend ne l'utilise plus (les hooks `useObjects/…/fetchObjects` sont des **re-exports legacy** pointant vers `fetchProducts`, et `ApiObject = ApiProduct`).

### 4.1 Routes publiques vs privées

| Type | Routes |
|---|---|
| Publiques (sans JWT) | `GET /`, `GET /health`, `POST /auth/register`, `POST /auth/login` |
| Privées (JWT) | Tout le reste (sections, products, sales, analytics, trash) |

### 4.2 Comportement du premier utilisateur inscrit

**Non vérifié dans la base**. Le code (`user.schema.ts:33` `default: UserRole.SELLER` + `auth.service.ts:register` sans check de nombre d'users) implémente **`seller` par défaut** pour tous. Le README dit `admin` pour le premier — **contradiction code/README** (voir §1).

---

## 5. Table des collections MongoDB

Schémas lus dans `api/src/**/schemas/*.schema.ts`. **Aucun schéma ne porte d'`organizationId`.**

| Collection | Champs | Index (déclarés) | `select:false` | Constraints | Données à qualifier `organizationId` | Risques migration |
|---|---|---|---|---|---|---|
| `users` | `_id`, `name`, `email`, `password` (hash bcrypt), `role` (`admin`/`seller`), `createdAt`, `updatedAt` | `email` **unique** (Mongoose auto) | `password` | `name` trim 100, `password` hash bcrypt cost 10 | **`email` : unique global → pas d'`email` dupliqué entre organisations** | Si on veut permettre le même email dans 2 organisations, il faut `unique: { email, organizationId }` → index composé (à créer en migration + backfill) |
| `sections` | `_id`, `name`, `description`, `parentId` (`ObjectId` ref `Section`), `deletedAt`, `createdAt`, `updatedAt` | `parentId` (ref) — **pas d'index Mongoose** | — | `name` trim, `deletedAt` default `null` | `name`, `parentId` (hiérarchie), `deletedAt` | Pas d'index sur `name` ou `parentId` → requêtes `findAll` et `assertUniqueName` (regex `^name$ i`) **O(n)** |
| `products` | `_id`, `sectionId` (ref `Section`), `name`, `imageUrl`, `purchasePrice`, `salePrice`, `initialQuantity`, `remainingQuantity`, `deletedAt`, `createdAt`, `updatedAt` | `sectionId` (ref) — **pas d'index Mongoose** | — | `name` trim 200, prices `min:0`, qty `min:1/0` | Tous les champs + `imageUrl` (S3 à re-prefixer) | Pas d'index `sectionId` ; métriques calculées en JS à chaque `find` (voir `withMetrics`) ; `imageUrl` doit migrer vers `organizations/{organizationId}/…` |
| `sales` | `_id`, `productId` (ref `Product`), `productName` (snapshot), `quantity`, `salePrice`, `sellerId` (ref `User`), `buyerName`, `buyerContact`, `createdAt` | **Aucun** (Mongoose n'en crée pas) | — | `quantity min:1`, `salePrice min:0` | Tous les champs | Snapshot `productName` mais **pas** `purchasePrice` ni `sectionId` (si le produit est supprimé, on perd le prix d'achat) ; `sellerId` doit être dans la même org |
| `auditLogs` | `_id`, `productId` (ref `Product`), `action` (enum 9), `actorId` (ref `User`), `details` (`Object`), `createdAt` | **Aucun** | — | `action` enum 9 | Tous les champs | **Pas de `sellerId`** ni `deletedAt` → le journal n'est pas partitionné par vente/section, seulement par produit ; `actorId` doit être dans la même org ; si produit détruit, le journal reste orphelin |
| `objects` ⚠ | `_id`, `title`, `description`, `imageUrl`, `createdAt` | Aucun | — | `title`/`description` trim | Tous | **Collection orphelin** : module non importé → collection potentiellement vide ; si elle contient des données résiduelles, elles devront être nettoyées ; le `S3 deleteFile` y est lié |

**Pas de collections** : `organizations` (à créer), `subscriptions` (à terme), `sessions` (pas de refresh token), `invites` (pas d'invitation), `logos` (pas d'upload de logo), `currencies` (devises codées en dur, voir §8).

**`deletedAt`** (soft delete) : présent sur `sections` et `products`. Tous les `find` filtrent par `deletedAt: null` sauf `findTrashed()`. La **corbeille est admin only** (GET `/trash`). La suppression définitive (`/permanent`) supprime d'abord le fichier S3 puis le document `product` ; les `sales` et `auditLogs` y restant (voir produit supprimé) — c'est voulu (`productName` snapshot).

---

## 6. Matrice des permissions actuelles

| Opération | Public | `seller` | `admin` | Notes |
|---|---|---|---|---|
| `GET /`, `GET /health`, `POST /auth/login`, `POST /auth/register` | ✅ | ✅ | ✅ | Inscription publique |
| `GET /auth/me` | ❌ | ✅ | ✅ | |
| `GET /sections`, `GET /sections/:id` | ❌ | ✅ | ✅ | **Lecture ouverte** à tout login |
| `POST/PATCH/DELETE /sections*` | ❌ | ❌ | ✅ | Soft delete, restore, permanent |
| `GET /products`, `GET /products/:id` | ❌ | ✅ | ✅ | **Lecture + audit + ventes** pour tout login |
| `POST/PATCH/DELETE /products*` | ❌ | ❌ | ✅ | |
| `POST /sales` | ❌ | ✅ | ✅ | **Tout logged-in user** peut enregistrer une vente |
| `GET /sales` | ❌ | ✅ | ✅ | **Toutes** les ventes de l'app |
| `PATCH/DELETE /sales/:id` | ❌ | ❌ | ✅ | ⚠ `:id` sans `ParseObjectIdPipe` |
| `GET /analytics/*` ×4 | ❌ | ✅ | ✅ | **Critique** : tout login peut voir KPIs + classements (emails des vendeurs) |
| `GET /trash` | ❌ | ❌ | ✅ | |
| `POST /products` (multipart) | ❌ | ❌ | ✅ | |
| `DELETE /products/:id/permanent` | ❌ | ❌ | ✅ | Supprime le fichier S3 |

Le **rôle est figé dans le JWT** (7 jours, aucune révocation). Si un admin dégrade un seller, le JWT reste valide avec l'ancien rôle jusqu'à expiration. **Aucune API pour changer de rôle** (pas de `PATCH /users/:id` — le `UsersService` a un `findAll` non utilisé).

---

## 7. WebSocket (Socket.IO)

**Fichier** : `api/src/events/events.gateway.ts`

- Gateway global `@WebSocketGateway({ cors: { origin: '*' } })`.
- **Aucune validation du token Socket.IO** : le client envoie `auth: { token }` (`web/src/hooks/use-socket.ts:9`) mais le gateway ne lit ni `socket.handshake.auth.token` ni n'applique de middleware d'authentification. Le `RolesGuard`/`JwtAuthGuard` HTTP ne s'applique pas sur la connexion Socket.IO.
- **Aucune room** : `emit` → `this.server.emit(event, payload)` = **broadcast global** à tous les sockets connectés.
- Événements émis : `product:created` (produit complet enrichi), `product:updated`, `product:deleted` (id), `sale:created` (vente complete). Helpers legacy `object:created`, `object:deleted` (inutilisés en prod car module orphelin).

**Risque multi-tenant** : si deux organisations partagent la même API, **chaque vente/produit créé dans l'org A est poussé en temps réel à tous les sockets connectés, y compris ceux des utilisateurs de l'org B**. La stratégie doit être : (a) ajouter un **middleware d'auth Socket.IO** (vérifier `socket.handshake.auth.token`, `jwt.verify`), puis (b) `socket.join('org:<organizationId>')` et n'émeter que dans la room. Le `emit` devra devenir `this.server.to('org:' + organizationId).emit(...)`.

---

## 8. Images et S3

**Fichier** : `api/src/s3/s3.service.ts`

| Aspect | État | Risque |
|---|---|---|
| Validation MIME | `fileFilter` : `file.mimetype.startsWith('image/')` | MIME seulement, **pas de verification de magic bytes** ; un fichier `.svg` avec `image/svg+xml` passe le filtre ; un malware SVG (SVG + JS inline) est un risque XSS |
| Taille max | `5 * 1024 * 1024` (5 Mo) via `limits.fileSize` | OK |
| Path/S3 key | `` `${randomUUID()}-${file.originalname}` `` | **`originalname` non sanitisée** (espaces, `../`, `/`, accents), `UUID` aléatoire OK ; **pas de préfixe `organizations/{organizationId}/`** ; le **bucket est partagé** entre toutes les organisations futures |
| Bucket public | `S3_FORCE_PATH_STYLE=true`, MinIO en policy `public` | **Toute URL est publique** : `https://…/heyama-objects/<uuid>-<name>` ; **aucune signature/expiration** |
| Déletion | `deleteFile(imageUrl)` : split `${this.bucket}/` | **Fragile** : si l'URL ne contient pas le sous-champ `${bucket}/` (ex : `S3_PUBLIC_URL` Supabase en prod = `https://proj.supabase.co/storage/v1/object/public/heyama-objects/`), `key = undefined` → `return` silencieux → **le fichier S3 n'est PAS supprimé**. Voir test `s3.service.spec.ts:20-76` qui code `heyama-objects` dans l'URL de test |
| CORS | `app.enableCors({ origin: corsOrigin })` avec `corsOrigin = process.env.CORS_ORIGIN?.split(',') ?? true` ; **si `CORS_ORIGIN` est vide, `origin: true` → tout est autorisé** | Risque élevé en prod si variable mal remplie |
| `images.remotePatterns` | `web/next.config.ts` : `localhost:9000` + `process.env.S3_HOSTNAME ?? localhost` | Fonctionnel pour MinIO/Supabase ; le hostname prod est configuré via `S3_HOSTNAME` |

**Adaptation multi-tenant** : `uploadFile` devra accepter `organizationId` et construire `${randomUUID()}` sous `organizations/{organizationId}/…`. `deleteFile(imageUrl)` devra extraire la clé **robustement** (split sur le segment du bucket, regex, ou stocker la clé S3 dans le DB plutôt que l'URL). Les URLs publiques devront éventuellement passer par un endpoint signé (ou bucket privé) si les données de produit deviennent confidentielles entre organisations.

**Images orphelines** : la suppression définitive d'un produit (`permanentDelete`) appelle `s3Service.deleteFile` puis `product.deleteOne()` ; si `deleteFile` échoue silencieusement (cas cité), le fichier S3 reste accessible en public.

---

## 9. Frontend (détail)

| Aspect | État |
|---|---|
| Routes | `/` (auth required, client), `/auth/login`, `/auth/register`, `/analytics`, `/sales`, `/sections/[id]`, `/products/[id]`, `/corbeille` (admin only), `/objects/[id]` (redirect → `/products/[id]`) |
| Protection pages | Client-only (`useAuth` + `useEffect` redirect) |
| Auth context | `web/src/contexts/auth-context.tsx` — `AuthProvider` avec `login`, `register`, `logout`; user en `localStorage` (`heyama_user`) |
| Stockage token | `web/src/lib/auth.ts` — `localStorage`, clés `heyama_token` / `heyama_user` (**JWS en plaintext ; risque XSS** si l'app est injectée) |
| Interceptor 401 | `web/src/lib/api.ts:31-44` — `clearAuth` + redirect `/auth/login` (hors `/auth/*`) |
| Navigation | `web/src/components/layout/navbar.tsx` — desktop top + mobile bottom ; masquage corbeille selon `user.role === "admin"` (client) |
| Chaines RoyalVibe | Fichiers : `layout.tsx` (title, og:title, appleWebApp), `manifest.ts` (nom, short_name, description), `navbar.tsx` (alt, texte), `auth/login/page.tsx`, `auth/register/page.tsx` |
| Logo | `web/public/logo.jpg` + `icon-192.png`/`icon-152.png` — **royalvibe spécifique** |
| Manifest PWA | `start_url: "/"`, `display: standalone`, `theme_color: "#b8960c"`, icon 192 + logo.jpg |
| Cache du service worker | `web/public/sw.js` : `CACHE = "royalvibe-v1"` ; **`cache-first` pour toutes les GET same-origin** (hors `/api` et navigate) — voir §8.3 ci-dessous |
| Risque cache SW | Le service worker cache les réponses HTML des pages Next.js (qui ne sont pas des APIs) ; si l'app sert à la fois des pages publiques et privées depuis le même origin (après migration sous `/app`), le SW pourrait **servir une page privée en cache** hors-ligne |
| Routes à déplacer sous `/app` | `/` (catalogue), `/analytics`, `/sales`, `/sections/[id]`, `/products/[id]`, `/corbeille`, `/objects/[id]` ; **`/` devient la landing commerciale publique** |

### 9.1 Service worker et données privées

Le SW `web/public/sw.js` fait **`cache-first`** sur les demandes GET same-origin. Concrètement :

1. L'utilisateur visite `/` (catalogue, nécessite login).
2. Le HTML de la page est stocké dans `cache.royalvibe-v1`.
3. Hors-ligne (ou après un logout sur une autre tab), la même URL peut **servir le HTML ancien** — **mais le HTML n'a pas les données privées** (celles-ci viennent de l'API XHR, qui n'est pas caché car `url.pathname.startsWith("/api")` est exclu du cache). **Risque limité** si les pages sont de simples shells qui fetchent via axios, ce qui est le cas ici. **Tout de même à surveiller** après la migration sous `/app` : si un endpoint est servi par Next.js (page data), il pourrait être mis en cache.
4. Le `OFFLINE_URL = "/"` fallback : hors-ligne, une navigation vers `/app/analytics` (ex.) renvoie la page `/` en cache — ce qui est une page **qui exige un login** → redirige en login → cohérent.

### 9.2 Token en `localStorage`

Le JWT (7 jours) est en `localStorage`. **Risque XSS** : toute injection XSS dans l'app peut lire le token et se connecter à l'API. Les bonnes pratiques en 2026 préconisent `httpOnly` cookies (mais l'app est SPA Next.js avec `axios` ; cookie + `withCredentials` est possible) ou refresh-token en storage sécurisé. À arbitrer en phase 1.

### 9.3 Couleur et branding

`#b8960c` (or) est codé en dur dans :
- `web/src/app/manifest.ts:13` (`theme_color`)
- `web/src/app/layout.tsx:42` (`viewport.themeColor`)
- (Pas de `primary` dans `globals.css` visible ; le `primary` Tailwind est probablement défini dans un thème ; à vérifier en phase 0.)

La couleur doit devenir personnalisable par organisation (thème SaaS) ou rester une identifiant générique SaaS.

---

## 10. Vulnérabilités et risques

Classement : **Critique** > **Élevé** > **Moyen** > **Faible**. `Non vérifié` : point qui ne peut pas être vérifié dans le code/l'infra sans accès à la base.

### 10.1 Critique

| ID | Risque | Preuve |
|---|---|---|
| C-1 | **Aucune isolation multi-tenant** : aucune donnée n'est scindée par organisation ; toute lecture/écriture/analytique/WS est globale | §4, §5, §7 |
| C-2 | **Lecture des Analytics par n'importe quel utilisateur connecté (y compris `seller`)** : KPIs globaux, classements produits (prix d'achat/vente), classements **vendeurs (emails + revenue de tous les vendeurs)** | `analytics.controller.ts:1-34` (pas de `@Roles`) |
| C-3 | **Le premier utilisateur n'est PAS `admin` en pratique** (contradiction code/README) | `user.schema.ts:33 default: SELLER` + `auth.service.ts` sans count ; le README dit `admin` |
| C-4 | **Socket.IO sans authentification** + **`cors: origin '*'`** + **`emit` broadcast** : tout socket connecté reçoit tous les événements de tous les tenants (après multi-tenant) | `events.gateway.ts:8-14` |

### 10.2 Élevé

| ID | Risque | Preuve |
|---|---|---|
| E-1 | **`CORS_ORIGIN` vide → `origin: true` (toute origine)** : cross-site data leakage | `main.ts:9` |
| E-2 | **Inscription publique sans contrôle** : quiconque peut créer un compte `seller` et lire sections/produits/ventes/analytics ; post-multi-tenant, quiconque peut créer un tenant sans invitation | `POST /auth/register` + `register.dto.ts` (validation minimale) |
| E-3 | **Images S3 publiques + `originalname` non sanitisée + pas de signature URL** + **`deleteFile` silencieux en cas de key inconnue** : fichiers orphelins + XSS SVG possible via `image/svg+xml` MIME | `s3.service.ts:47-66` ; `products.controller.ts:24-37` |
| E-4 | **Pas d'id `organizationId` dans le JWT** ; rôle figé 7 jours sans révocation ; si un admin change le rôle d'un user, le JWT reste valide | `auth.service.ts:sign` |
| E-5 | **Pas de transaction MongoDB** : `SalesService.create` en 3 étapes (`saleModel.create` → `decrementStock` → `auditService.log`), sans `session.withTransaction` ; si `decrementStock` échoue après `create`, la vente existe mais le stock n'est pas décrémenté → incohérence de stock | `sales.service.ts:25-49` |
| E-6 | **Email unique global** : même email ne peut exister dans 2 organisations ; à arbitrer avant la phase 1 | `user.schema.ts:24 unique: true` |
| E-7 | **Pas de rate-limiting** sur `/auth/register` ou `/auth/login` → brute force possible | Aucun `throttler` / `rate-limit` dans l'API |
| E-8 | **Pas de validation du rôle sur les opérations WebSocket** | §7 |

### 10.3 Moyen

| ID | Risque | Preuve |
|---|---|---|
| M-1 | `PATCH/DELETE /sales/:id` **sans `ParseObjectIdPipe`** → `CastError` → `HttpExceptionFilter` renvoie un 500 au lieu de 400 (fuite de type) | `sales.controller.ts:35-46` vs `sections.controller.ts:45` (présent) |
| M-2 | **Pas d'index Mongoose** sur `sectionId` (products), `productId` (sales/auditLogs), `sellerId` (sales), `parentId` (sections) → requêtes lentes dès la croissance | Schémas Mongoose (pas d'`@Index`) |
| M-3 | **Token `localStorage`** (pas `httpOnly`) → exfiltration XSS | `web/src/lib/auth.ts` |
| M-4 | **Pas de test e2e** multi-route (1 seul test e2e : `GET /`) ; pas de test pour le `RolesGuard`, pas de test pour l'isolation future | `api/test/app.e2e-spec.ts:9-20` |
| M-5 | **Service worker `cache-first` sur GET same-origin** : après migration sous `/app`, risque de servir du HTML privé en cache (voir §9.1) | `web/public/sw.js:23-45` |
| M-6 | **Pas de refresh token / pas de rotation de JWT** ; pas de révocation | `auth.service.ts` |
| M-7 | **`AuditLog` non partitionné par section/vente** ; si produit supprimé, l'audit reste orphelin (intentionnel, mais à documenter) | `audit-log.schema.ts` |
| M-8 | **Pas de `PDS` / anonymisation / suppression** des données `buyerName` / `buyerContact` (RGPD), pas de suppression de compte | `sale.schema.ts:24-27` |
| M-9 | **Module `objects` orphelin** (module non importé) : code mort + tests + collection résiduelle potentiellement existante en base (non vérifié) | `app.module.ts` sans `ObjectsModule` |
| M-10 | **Deux stacks de déploiement divergentes** : `docker-compose.prod.yml` (self-hosted) **et** GitHub Actions (Railway + Vercel) ; la documentation cite les deux sans indiquer lequel est utilisé en prod réel (non vérifié) | `.github/workflows/deploy.yml` + `docker-compose.prod.yml` |
| M-11 | **`web/next.config.ts` sans `output: "standalone"`** alors que le `Dockerfile` web attend `.next/standalone` → le build Docker échouerait (le commentaire dit "uniquement pour Docker" mais la directive est **commentée**). **Non vérifié si le Dockerfile est encore utilisé** (Vercel est mentionné dans le README) | `next.config.ts:3` + `web/Dockerfile:20` |

### 10.4 Faible

| ID | Risque | Preuve |
|---|---|---|
| F-1 | `JWT_SECRET` par défaut `change-me-in-production-use-a-long-random-string` dans `.env.example` (le `.env.prod.example` le remplace par `CHANGE_MOI_…`) — si un déploiement se base sur le `.env.example`, un secret faible est utilisé | `api/.env.example:7` |
| F-2 | `Mongo Express` en dev exposé sans auth (`ME_CONFIG_BASICAUTH: "false"`) — **dev seulement** (non exposé en `docker-compose.prod.yml`) | `docker-compose.yml:21-32` |
| F-3 | `MinIO` en dev : `minioadmin / minioadmin123` — dev seulement | `docker-compose.yml:16-17` |
| F-4 | Pas de `Content-Security-Policy` dans `nginx.conf` (pas de CSP header) | `nginx/nginx.conf:1-10` |
| F-5 | `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })` est **bon**, mais **pas de `maxNesting`** ; pas de risque majeur en l'état | `main.ts:11-15` |
| F-6 | Le `HttpExceptionFilter` renvoie le `path` et le timestamp — info leakage mineure (peut aider un attaquant à mapper les routes) | `http-exception.filter.ts:42-44` |
| F-7 | Pas de `Helmet`-equivalent (NestJS n'applique pas `helmet` par défaut) — pas de `X-Content-Type-Options` / `X-Frame-Options` côté API (les headers sont sur nginx mais pas sur Railway si nginx n'est pas) | `main.ts` |

---

## 11. Manques de tests

| Surface | État actuel | Manque |
|---|---|---|
| Unitaires API | 5 fichiers spec : `app.controller.spec.ts`, `events.gateway.spec.ts`, `objects.service.spec.ts`, `objects.controller.spec.ts`, `s3.service.spec.ts` | Pas de test pour `auth.service` (register/login/rôle default/sanitize), `users.service`, `sections.service` (soft delete, unique name), `products.service` (métriques, audit, S3), `sales.service` (décrue de stock, ajustement), `analytics.service` (4 aggregates), `audit.service`, `trash` (controller), `ParseObjectIdPipe`, `HttpExceptionFilter`, `JwtStrategy` (recherche user) |
| E2E API | 1 test : `GET /` (Hello World) | Pas de test pour `/auth/*`, `/sections/*`, `/products/*`, `/sales/*`, `/analytics/*`, `/trash` ; pas de test de rôles (sellers ne peuvent pas modifier un produit, etc.) ; pas de test d'isolation multi-tenant (n'existe pas, à écrire en phase 1) |
| WebSocket | `events.gateway.spec.ts` : "should be defined" | Pas de test de connexion / déconnexion / événement / room |
| Frontend | **0 test** (aucun `*.test.tsx`, pas de test runner configuré) | Pas de test de composants, pas de test de route, pas de test de `auth-context`, pas de test de `api.ts` (interceptor 401) |
| CI | `ci.yml` : lint + test + build (api), lint + build (web) | Le `pnpm test` de l'API passe sans coverage ; le web n'a pas de test étape |
| Charge / performance | — | Pas de test ; les agrégations et `withMetrics` (calcul en JS) pourront être un problème dès 1k+ produits |

**Tests indispensables avant la transformation multi-tenant** :
- E2E de `POST /auth/register` → rôle par défaut (verre brisé du §1/C-3)
- E2E de chaque route protégée par rôle (sellers vs admin)
- E2E de la décrémentation de stock (cas limite : stock insuffisant, vente invalide)
- Unit tests de `s3.service` avec `S3_PUBLIC_URL` Supabase (split `deleteFile`)
- **E2E d'isolation multi-tenant** (après la phase 1) : un user de l'org A ne peut pas lire / écrire / analyser / voir les événements de l'org B.

---

## 12. Éléments codés en dur pour RoyalVibe / heyama

### 12.1 `RoyalVibe` (35 occurrences)

| Fichier | Occurrences |
|---|---|
| `nginx/nginx.conf` | `server_name royalvibe.tondomaine.com` ×4, `api.royalvibe.tondomaine.com` ×2, `s3.royalvibe.tondomaine.com` ×2 |
| `docker-compose.prod.yml` | `container_name: royalvibe-*` ×5 ; `MONGO_INITDB_DATABASE: royalvibe` ; `MONGODB_URI: …/royalvibe?authSource=admin` ; `S3_BUCKET: royalvibe-objects` |
| `.env.prod.example` | `WEB_URL=https://royalvibe.tondomaine.com` ; `API_URL=https://api.royalvibe.tondomaine.com` ; `S3_PUBLIC_URL=https://s3.royalvibe.tondomaine.com` ; `S3_HOSTNAME=s3.royalvibe.tondomaine.com` ; `MONGO_USER=royalvibe_admin` ; `MINIO_USER=royalvibe_minio` |
| `README.md` | Titre + intro |
| `api/README.md` | Titre + intro + `docker build -t royalvibe-api ./api` |
| `web/README.md` | Titre + intro + `docker build … -t royalvibe-web` |
| `web/src/app/manifest.ts` | `name: "RoyalVibe Cosmétiques & Bijoux"`, `short_name: "RoyalVibe"`, `description` |
| `web/src/app/layout.tsx` | `title`, `applicationName`, `appleWebApp.title`, `openGraph.title` |
| `web/src/app/auth/login/page.tsx` | `alt="RoyalVibe"`, heading |
| `web/src/app/auth/register/page.tsx` | `alt="RoyalVibe"`, heading |
| `web/src/components/layout/navbar.tsx` | `alt="RoyalVibe"`, texte navbar |
| `web/public/sw.js` | `CACHE = "royalvibe-v1"` (nommage de cache — non critique mais à changer pour éviter le cache résiduel) |

### 12.2 `heyama` (18 occurrences)

| Fichier | Occurrences |
|---|---|
| `package.json` (racine) | `name: "heyama-test"`, description |
| `README.md` | `cd heyama-test`, `heyama-objects` (bucket dev) |
| `docker-compose.yml` | `container_name: heyama-mongo`, `heyama-minio`, `heyama-mongo-express` |
| `web/src/lib/auth.ts` | `TOKEN_KEY = "heyama_token"`, `USER_KEY = "heyama_user"` (clés localStorage) |
| `api/src/s3/s3.service.spec.ts` | 6 occurrences de `heyama-objects` dans les tests |
| `api/README.md` | Table des variables (`heyama`, `heyama-objects`) |

### 12.3 Devises et taux

| Fichier | Éléments |
|---|---|
| `web/src/lib/currency.ts` | `EUR_TO_XOF = 655.957` (ligne 2) ; `fmtXof` → `" FCFA"` ; `fmtEur` → `€` |
| `web/src/components/currency/currency-converter.tsx` | Convertisseur EUR ↔ FCFA ; mention "Parité fixe FCFA zone UEMOA / Banque de France" |
| `web/src/components/products/create-product-dialog.tsx` | "Prix d'achat (FCMA)", `≈ EUR` via `fmtEur` |
| `web/src/components/products/update-product-dialog.tsx` | "Prix d'achat (FCFA)", "Prix de vente (FCMA)" |
| `web/src/components/products/record-sale-dialog.tsx` | "Prix de vente réel (FCFA)" |
| `web/src/components/products/edit-sale-dialog.tsx` | "Prix de vente (FCFA)" |
| `web/src/app/analytics/page.tsx` | `fmtXof` (affichages) |
| `web/src/app/corbeille/page.tsx` | `fmtXof` (affichages) |
| `web/src/app/sales/page.tsx` | `fmtXof` (affichages) |
| `README.md` | "FCMA/XOF", "1 EUR = 655,957 XOF" |
| `api/` | **Aucune référence à EUR/XOF/FCXA** dans le code NestJS — les prix sont des nombres bruts (sans devise) |

### 12.4 Couleur et logo

| Fichier | Éléments |
|---|---|
| `web/src/app/manifest.ts` | `theme_color: "#b8960c"` |
| `web/src/app/layout.tsx` | `viewport.themeColor: "#b8960c"` |
| `web/public/logo.jpg` | Logo RoyalVibe |
| `web/public/icon-192.png`, `icon-152.png` | Icônes RoyalVibe |

### 12.5 Autres

- Le `S3_BUCKET` est `heyama-objects` en dev, `royalvibe-objects` en prod → à standardiser par organisation (`saas-{organizationId}` ou partage avec préfixe).
- `MONGODB_URI` dev `heyama`, prod `royalvibe` → à renommer au déploiement.

---

## 13. Proposition de transformation en phases

> Principes : (1) **Aucune phase ne brise la compatibilité API** avant d'être validée en e2e. (2) Chaque phase est réversible. (3) Le **changement de schema MongoDB** est la seule opération irréversible : il doit se faire hors-peak, avec **snapshot/backup avant** et **migration idempotente**. (4) Les **valeur de données** (ex : bucket S3) sont migrées par étapes, pas en big-bang.

### Phase 0 — Stabilisation et nettoyage (sans impact utilisateur)

**Objectifs** : fermer les failles critiques actuelles (C-2, C-3, E-1, E-5), clarifier le code mort, ajouter la couverture test minimum, aligner les env variables.
- Corriger `C-2` : ajouter `@Roles(UserRole.ADMIN)` sur `analytics.controller.ts` (ou `admin + owner` post multi-tenant).
- Corriger `C-3` : soit implémenter le `admin` du premier user (logique `usersService.count() === 0 → admin`), soit corriger le README.
- Corriger `E-1` : `app.enableCors({ origin: corsOrigin })` avec fallback **`[]` (refuser tout)** ou défaut explicite, pas `true`.
- Corriger `E-5` : encapsuler `sale + stock + audit` dans une **transaction MongoDB** (`mongoose.startSession`, `withTransaction`).
- Retirer ou **importer** le module `objects` (décision : supprimer `api/src/objects/` + tests + collection résiduelle après vérification).
- Ajouter un `rate-limit` sur `/auth/*` (ex : `@nestjs/throttler` — **ajoute une dépendance**, à arbitrer).
- Ajouter `ParseObjectIdPipe` sur `sales.controller.ts:35` et `:46`.
- Ajouter des **index Mongoose** : `sectionId` (products), `productId` (sales, auditLogs), `sellerId` (sales), `parentId` (sections).
- **Tests** : e2e `/auth/register` (rôle default), e2e de chaque route par rôle, unit tests de `s3.service.deleteFile` cas Supabase URL, unit tests de `products.service` métriques.
- **Documentation** : corriger `api/README.md` (supprimer `objects`), clarifier le déploiement (Railway/Vercel vs docker-compose).

**Fichiers** : `api/src/analytics/analytics.controller.ts`, `api/src/auth/auth.service.ts` ou `api/src/users/users.service.ts`, `api/src/main.ts`, `api/src/sales/sales.service.ts`, `api/src/sales/sales.controller.ts`, `api/src/objects/*` (retiré), `api/src/*-schemas` (+ index), `api/test/*`, `README.md`, `api/README.md`, `.env*.example`.

### Phase 1 — Modèle multi-tenant (schema + migration) — **IRREVERSIBLE**

**Objectifs** : créer la collection `organizations`, ajouter `organizationId` à `users`, `sections`, `products`, `sales`, `auditLogs`, `objects` (si conservé). **Backup MongoDB + S3 avant migration.**
- New collection `organizations` : `_id`, `name`, `slug`, `logoKey` (S3), `currency` (default `XOF`), `themeColor` (default `#b8960c`), `plan` (default `free`), `createdAt`.
- Modifier `user.schema.ts` : `organizationId` (ref `Organization`, required) + index composé `{ email, organizationId }` **unique** **et** supprimer l'index unique sur `email` seul.
- Modifier `section.schema.ts`, `product.schema.ts`, `sale.schema.ts`, `audit-log.schema.ts` : `organizationId` (ref, required).
- **Migration idempotente** : (1) insert org "royalvibe" ; (2) backfill `organizationId` sur chaque user/section/product/sale/auditLog depuis l'org royalvibe ; (3) créer les index composés `{ organizationId, … }` ; (4) supprimer l'index unique global `email` ; (5) re-attacher les refs `parentId`/`sectionId`/`productId`/`sellerId`/`actorId` (elles restent ObjectId, pas de changement).
- **Migration S3** (option 2a/2b) : soit (2a) prefixer chaque clé en `organizations/{organizationId}/…` via une job, soit (2b) **conservation** des clés existantes + ajout des clés nouvelles avec préfixe. À arbitrer (recommandé : 2b en phase 1, 2a en phase 4).
- **Validation** : vérifier que tous les documents ont un `organizationId` (pas de `null`).
- **Rollback** : désindexer + supprimer `organizationId` des documents + supprimer l'index `{ email, organizationId }` + réindexer `email` unique. (Long mais faisable en lecture seule sur l'API.)

**Fichiers** : `api/src/organizations/organization.schema.ts` (nouveau), `api/src/organizations/organizations.module.ts` (nouveau), `api/src/users/schemas/user.schema.ts`, `api/src/sections/schemas/section.schema.ts`, `api/src/products/schemas/product.schema.ts`, `api/src/sales/schemas/sale.schema.ts`, `api/src/audit/schemas/audit-log.schema.ts`, `api/src/app.module.ts`, `scripts/migrations/001-add-organizationid.ts` (nouveau).

### Phase 2 — Auth multi-tenant (inscription + organisation + JWT)

**Objectifs** : (1) le `register` crée une organisation et son **premier user est `admin` de cette organisation** ; (2) les utilisateurs existants sont mappés ; (3) le JWT contient `organizationId` ; (4) les invites de sellers ; (5) le `auth/me` renvoie l'organisation (logo, nom, devise).
- New controller `POST /auth/organizations` (ou `POST /organizations` public) : crée org + user admin.
- New controller `POST /organizations/:id/invites` (admin) : crée un `invite` (email + rôle, token JWT court) et envoie un email (à terme, pas de SMTP dans l'app en l'état ; **hors scope phase 2** — voir §14 non résolus).
- Modifier `JwtStrategy.validate` : vérifier que le user est **actif** et que son `organizationId` existe, renvoyer le document.
- Modifier `AuthService.sign` : ajouter `organizationId` dans le payload.
- Modifier `AuthController.me` : retourner `{ user, organization: { _id, name, slug, logoUrl, currency, themeColor } }`.
- **Routes publiques** : `POST /auth/register` devient `POST /auth/register` (org + admin) — **le register simple est retiré** (les sellers sont invités).
- **Frontend** : `/auth/register` devient la page "Créer mon entreprise" (nom d'org, slug, devise, logo, name/email/password du admin). `/auth/login` reste.
- **Middleware global** : `OrganizationGuard` (après `JwtAuthGuard`) qui lit `organizationId` du JWT + le met dans `request.context.organizationId` ; **toutes les queries Mongoose** devront filtrer par `organizationId` (via une helper `scopedQuery(this.model, organizationId)`).
- **Rollback** : retirer le guard + le champ `organizationId` du JWT (les endpoints continuent à tourner en mono-tenant sur l'org royalvibe). Les données restent.

**Fichiers** : `api/src/auth/auth.service.ts`, `api/src/auth/auth.controller.ts`, `api/src/auth/strategies/jwt.strategy.ts`, `api/src/auth/guards/organization.guard.ts` (nouveau), `api/src/organizations/organizations.controller.ts` (nouveau), `api/src/main.ts`, `api/src/users/schemas/user.schema.ts`, `web/src/app/auth/register/page.tsx`, `web/src/app/auth/login/page.tsx`, `web/src/lib/api.ts`, `web/src/contexts/auth-context.tsx`, `web/src/lib/auth.ts`.

### Phase 3 — Isolation des données (scopes de queries + audit + corbeille)

**Objectifs** : toutes les lectures/écritures/analytics/audit/trash sont **filtrées par `organizationId`**.
- `sections.service.ts` : `findAll`, `findOne`, `create`, `update`, `remove`, `restore`, `permanentDelete` — **scope par org**.
- `products.service.ts` : idem (scope par org) — `decrementStock` / `adjustStock` **scope par org**.
- `sales.service.ts` : idem.
- `analytics.service.ts` : idem (4 agrégations avec `$match: { organizationId }`).
- `audit.service.ts` : idem (log + findByProduct).
- `trash.controller.ts` : idem.
- **Validation des relations** : à la création d'un produit (sectionId), vendre (productId), etc. — vérifier que la référence est dans la **même** organisation (sinon 404, pas 403, pour ne pas révéler l'existence de l'objet).
- **Tests e2e** : chaque op × chaque rôle × chaque organisation — **un user de l'org A ne peut rien lire/voir/modifier de l'org B**.
- **Rollback** : les données restent scindées ; retirer les scope = lecture globale (état de la phase 1).

**Fichiers** : `api/src/sections/sections.service.ts`, `api/src/products/products.service.ts`, `api/src/sales/sales.service.ts`, `api/src/analytics/analytics.service.ts`, `api/src/audit/audit.service.ts`, `api/src/trash/trash.controller.ts`, `api/test/e2e/*.e2e-spec.ts`.

### Phase 4 — Stockage S3 par organisation + suppression

**Objectifs** : clés S3 préfixées `organizations/{organizationId}/…` ; suppression robuste (clé stockée dans le champ `imageKey` du schema plutôt que l'URL) ; signature d'URL (optionnel).
- Modifier `S3Service.uploadFile(file, organizationId, originalName)` → key `${organizationId}/${randomUUID()}`.
- Nouveau champ `imageKey` dans `product.schema.ts` (stocke la clé S3) + `imageUrl` calculée (dérivée).
- Modifier `S3Service.deleteFile(imageKey)` → `DeleteObjectCommand({ Bucket, Key: imageKey })` (plus de parse d'URL).
- **Migration des clés existantes** : job qui renomme toutes les clés `<uuid>-<name>` → `organizations/royalvibe/<uuid>-<name>` (copy + delete, hors-peak).
- **Vérification d'orphan** : après suppression produit, vérifier que la clé S3 est bien supprimée (log).
- **Rollback** : les clés restent préfixées (état post-migration) ; le champ `imageKey` reste.

**Fichiers** : `api/src/s3/s3.service.ts`, `api/src/products/products.controller.ts`, `api/src/products/schemas/product.schema.ts`, `scripts/migrations/002-migrate-s3-keys.ts` (nouveau).

### Phase 5 — WebSocket par organisation

**Objectifs** : (1) auth Socket.IO (vérifier `handshake.auth.token`); (2) `socket.join('org:' + organizationId)`; (3) `emit(orgId, event, payload)` uniquement dans la room.
- Modifier `EventsGateway` : méthode `handleConnection(client, next)` (ou middleware) vérifie `client.handshake.auth.token` (JWT verify) et joine la room.
- Remplacer `this.server.emit(event, payload)` par `this.server.to('org:' + organizationId).emit(event, payload)` ; les services doivent passer `organizationId`.
- **Tests** unit + e2e : connexion sans token → refuse ; 2 users de 2 orgs → pas de propagation.
- **Rollback** : retirer l'auth + les rooms (état de la phase 0).

**Fichiers** : `api/src/events/events.gateway.ts`, `api/src/events/events.module.ts`, `api/src/**/services.ts` (passage `organizationId`), `web/src/hooks/use-socket.ts` (déjà `auth: { token }`).

### Phase 6 — Frontend multi-tenant (`/app` + branding + PWA)

**Objectifs** : (1) basculer les routes sous `/app` ; (2) `/` devient la page commerciale publique (landing) ; (3) branding paramétrable par organisation (logo, couleur, devise) ; (4) PWA : `start_url: "/app"`, `manifest` dynamique par org, SW versionné par org (ou `Cache` neutre) ; (5) `auth-context` porte `organization` ; (6) conversion de devise **paramétrable** (non plus `655.957` codé).
- `web/src/app/page.tsx` : nouvelle landing (page statique publique).
- `web/src/app/[[...slug]]/page.tsx` : layout `/app/*` avec `Navbar` (qui lit `organization`).
- Migrations de pages : `/analytics` → `/app/analytics`, etc.
- `manifest.ts` : `start_url: "/app"`, name = `organization.name` (dynamic via API).
- `sw.js` : `CACHE = "saas-v1"`, exclude `/api` (déjà le cas), **ne plus mettre en cache que les assets statiques** (pas le HTML de pages privées).
- `currency.ts` : `EUR_TO_XOF` devint **chargé depuis l'API** (champ `currency` + taux configurable par org ou global); le `fmtXof` devient `fmtCurrency(amount, org.currency, org.locale)`.
- **Logo / couleur** : chargés depuis `auth/me` (`organization.logoUrl`, `organization.themeColor`) ; injectés via un `ThemeProvider` CSS vars.
- **Rollback** : rétrograder les routes (alias `/` → `/app`), restaurer le manifest `start_url: "/"`.

**Fichiers** : `web/src/app/**/*`, `web/src/components/layout/navbar.tsx`, `web/src/contexts/auth-context.tsx`, `web/src/lib/api.ts`, `web/src/lib/currency.ts`, `web/src/lib/utils.ts`, `web/public/sw.js`, `web/public/manifest.webmanifest` (ou `manifest.ts` dynamique).

### Phase 7 — Abonnements Mobile Money (post-SaaS)

**Objectifs** : (1) `subscription` dans l'org (plan, statut, renouvellement) ; (2) integration Mobile Money (Orange/MTN/Flutterwave/Hubtel) — **hors scope de cet audit** ; (3) limites par plan (nb de sellers, nb de produits, rétention de l'audit).
- Nouveau module `api/src/subscriptions/` (service + model + webhook).
- Nouveau champ `subscriptions` (coll. `subscriptions` : `organizationId`, `plan`, `status`, `expiresAt`, `provider`, `providerId`).
- **Risque** : les `limits` doivent être appliquées dans les guards (ex : `SellerCountGuard`) ; la **surcharge de test** est ici.

**Fichiers** : `api/src/subscriptions/*` (nouveau), `api/src/main.ts` (guard), `web/src/components/billing/*` (nouveau).

### Phase 8 — Déploiement et CI/CD

**Objectifs** : (1) unifier la **stratégie de déploiement** (Vercel + Railway **ou** self-hosted, pas les deux) ; (2) fixer `web/next.config.ts` (`output: "standalone"` si Docker) ou retirer le Dockerfile ; (3) `API_HEALTH_URL` / `WEB_HEALTH_URL` ; (4) **plan de rollback** (§14).
- **Fichiers** : `web/next.config.ts`, `web/Dockerfile`, `api/Dockerfile`, `.github/workflows/*`, `nginx/nginx.conf`, `docker-compose.prod.yml`.

---

## 14. Fichiers probablement concernés par chaque phase

| Phase | Fichiers (créés/fixés) | Fichiers (à supprimer) |
|---|---|---|
| 0 | `api/src/analytics/analytics.controller.ts`; `api/src/auth/auth.service.ts` (+ `users.service.ts` pour `count`); `api/src/main.ts`; `api/src/sales/{sales.service.ts, sales.controller.ts}`; `api/src/**/schemas/*.schema.ts` (+ index); `api/test/*.e2e-spec.ts`; `README.md`, `api/README.md` | `api/src/objects/*` (5 files) |
| 1 | `api/src/organizations/organization.schema.ts` (new); `api/src/organizations/organizations.module.ts` (new); `api/src/users/schemas/user.schema.ts`; `api/src/sections/schemas/section.schema.ts`; `api/src/products/schemas/product.schema.ts`; `api/src/sales/schemas/sale.schema.ts`; `api/src/audit/schemas/audit-log.schema.ts`; `api/src/app.module.ts`; `scripts/migrations/001-add-organizationid.ts` (new) | — |
| 2 | `api/src/auth/{auth.service.ts, auth.controller.ts, strategies/jwt.strategy.ts, guards/organization.guard.ts}` (new); `api/src/organizations/organizations.controller.ts` (new); `api/src/users/schemas/user.schema.ts`; `api/src/main.ts`; `web/src/app/auth/register/page.tsx`; `web/src/contexts/auth-context.tsx`; `web/src/lib/{api.ts, auth.ts}` | — |
| 3 | `api/src/sections/sections.service.ts`; `api/src/products/products.service.ts`; `api/src/sales/sales.service.ts`; `api/src/analytics/analytics.service.ts`; `api/src/audit/audit.service.ts`; `api/src/trash/trash.controller.ts`; `api/test/e2e/isolation.e2e-spec.ts` (new) | — |
| 4 | `api/src/s3/s3.service.ts`; `api/src/products/products.controller.ts`; `api/src/products/schemas/product.schema.ts`; `scripts/migrations/002-migrate-s3-keys.ts` (new) | `api/src/s3/s3.service.spec.ts` (réécriture) |
| 5 | `api/src/events/events.gateway.ts`; `api/src/events/events.module.ts`; `api/src/**/services.ts` (passage `organizationId`); `web/src/hooks/use-socket.ts` | — |
| 6 | `web/src/app/page.tsx` (landing); `web/src/app/**/page.tsx` (migrations de routes, alias) ; `web/src/components/layout/navbar.tsx`; `web/src/contexts/auth-context.tsx`; `web/src/lib/{api.ts, currency.ts, utils.ts}` ; `web/src/app/manifest.ts` ; `web/public/sw.js` ; `web/src/components/currency/currency-converter.tsx` | — |
| 7 | `api/src/subscriptions/*` (nouveau) ; `api/src/main.ts` (guards) ; `web/src/components/billing/*` (nouveau) | — |
| 8 | `web/next.config.ts` ; `web/Dockerfile` ; `api/Dockerfile` ; `.github/workflows/*` ; `nginx/nginx.conf` ; `docker-compose.prod.yml` ; `.env.prod.example` | (dépend du choix) |

---

## 15. Questions non résolues

| # | Question | Impact |
|---|---|---|
| Q1 | **Qui détient l'identité du tenant** ? Le gérant crée son entreprise → `email` unique par org ou unique global ? (Voir §10.2/E-6 et §15/Phase 1) | Bloquant phase 1 |
| Q2 | **Le register public existe-il encore** ? Multi-tenant, le seul chemin "créer un compte" est "créer une organisation" — mais les **vendeurs** ne peuvent pas s'inscrire eux-mêmes (ils sont **invités**) ? | Bloquant phase 2 |
| Q3 | **Invitations des vendeurs** : par email SMTP ou par lien d'invitation (`inviteUrl`) ? (Aucune infrastructure mail dans l'app en l'état) | Bloquant phase 2 |
| Q4 | **Coexistence des données existantes** : les ventes/produits/sections existants de RoyalVibe sont importés dans l'org "royalvibe" (première entreprise cliente) ; le **nom d'org** est-il `RoyalVibe Cosmétiques & Bijoux` ou juste `RoyalVibe` ? Le **slug** doit-il être `royalvibe` ? | Bloquant phase 1 |
| Q5 | **Migration des données existantes** : backup + migration **hors-peak** avec freeze écriture ; ou **zéro-downtime** (dual-write) ? | Bloquant phase 1 |
| Q6 | **Bucket S3 partagé ou par org** ? partagé = moins de coûts mais risque de leak inter-tenant si `organizationId` est absent de la clé ; par org = N bucket mais isolement fort | Bloquant phase 2 |
| Q7 | **Devises multiples** : chaque org peut avoir sa devise (XOF, EUR, MAD, …) ? Le taux est-il **fixe** ou **par org** ? Où stocker (champ `currency` + `exchangeRate` dans org) ? | Bloquant phase 6 |
| Q8 | **Couleur / thème par org** : champ `themeColor` dans l'org + CSS vars (à arbitrer : couleur primaire + couleur secondaire + typographie) | Phase 6 |
| Q9 | **Limites par plan** : nb de sellers / nb de produits / historique d'audit / rétention ventes / stockage images | Phase 7 |
| Q10 | **RGPD** : droit à l'oubli des `buyerName` / `buyerContact` (champs sensibles) ; suppression de compte / org | Phase 7 (compliance) |
| Q11 | **Environnement de prod réel** : Vercel + Railway (selon `.github/workflows`) **ou** self-hosted (selon `docker-compose.prod.yml`) ? Les deux existent dans le code repo ; lequel est utilisé en prod ? (Non vérifié) | Phase 8 |
| Q12 | **JWT vs cookie** : conserver localStorage (XSS) ou passer en `httpOnly` cookie ? Si cookie, `SameSite=Lax`/`Strict` et `withCredentials` pour l'axios ? | Phase 2 |
| Q13 | **Validation du rôle `seller`** : le vendeur peut-il **voir** les ventes des autres vendeurs ? (Aujourd'hui `GET /sales` retourne **tout**, sans filtre `sellerId`) | Phase 3 |
| Q14 | **Corbeille** : la corbeille est-elle globale ou par organisation ? (Aujourd'hui globale, post-multi-tenant par org ?) | Phase 3 |
| Q15 | **`auditLog`** : à combien de temps l'audit est-il conservé ? (Aucune retenue en l'état) | Phase 7 |

---

## 16. Conditions préalables avant la première modification

Avant de toucher à `user.schema.ts` (phase 1), les conditions ci-dessous doivent être **remplies** :

1. **Décision sur Q1, Q2, Q4, Q6** (identité du tenant, register, nom de l'org première, bucket partagé) — sans ces décisions, la phase 1 est impossible.
2. **Snapshot / backup MongoDB complet** de la base de prod (`mongodump` ou Atlas export) + date/heure documentée.
3. **Snapshot / listing S3** des clés du bucket `royalvibe-objects` (avant migration de phase 4).
4. **Backup du code** : tag git `audit-saas-v0.1` sur le commit `257109e` ; **branch** `feat/saas-transformation` créé.
5. **Environnement de staging** : un second déploiement Railway/Vercel (ou VM) sur le snapshot MongoDB + S3, pour tester la **migration 001** hors de prod.
6. **Freeze des écritures** (optionnel, recommandé) : avant la migration 001, faire un `read-only` temporaire de la base (pause API) pour éviter les écritures en cours de migration.
7. **Validation du plan de test e2e** : la liste de tests de la section 11 doit être acceptée.
8. **Accès aux variables d'environment de prod** (Railway/Vercel) — pour pouvoir exécuter la migration et le rollback, le `JWT_SECRET` de prod doit être connu (le `.env.prod.example` est un template, pas les valeurs réelles — **les valeurs réelles ne sont pas dans ce repo**).
9. **Réversibilité** : chaque migration (001, 002) a une `down()` écrite et testée sur staging.
10. **Communication aux utilisateurs** : annonce de dégradation / temps d'indisponibilité (si freeze écriture) — à planifier avec l'opérateur.

---

## 17. Stratégie de rollback (proposition)

Principes généraux :
- **Aucune étape ne modifie les données** tant que la migration suivante n'est pas validée en staging.
- **Un seul chemin de rollback** par phase, documenté et **testé manuellement** sur staging.
- **Les données** (MongoDB + S3) **sont préservées** : le rollback est un retour sur l'API + le frontend, **pas** un `DROP`.

### Par phase

| Phase | Rollback |
|---|---|
| 0 | `git revert` de la phase 0 ; pas de migration de données. Les guards et indices sont réversibles par `git revert`. |
| 1 (schema multi-tenant) | **IRREVERSIBLE pour les index** : (a) désactiver les index composés `{ organizationId, … }` (drop), (b) réactiver l'index unique global `email` (**attention** : si un user a été créé avec un `email` dupliqué post-migration, la ré-indexation échouera — vérifier en staging), (c) supprimer (pas désindexer) le champ `organizationId` des documents, (d) supprimer la collection `organizations` (ou la vider). Les clés S3 ne sont pas touchées. |
| 2 (auth multi-tenant) | `git revert` du code (JWT repasse sans `organizationId`) ; les données restantes (org, invites) **sont conservées**. Le register repasse en `seller` (comportement de la phase 0). Le `OrganizationGuard` est retiré. |
| 3 (isolation) | `git revert` du scope par org dans les services ; les données sont déjà scindées, l'absence de filtre revient à l'état mono-tenant **sur un seul org** (pas de leak tant qu'il n'y a qu'une org). |
| 4 (S3) | Les clés sont déjà préfixées ; **rollback = réparer `imageKey` + `imageUrl`** (référence l'ancien format) — les clés S3 **ne sont pas renommées en retour** (coût + risque). |
| 5 (WebSocket) | `git revert` du middleware Socket.IO + suppression des rooms ; le broadcast repart en global. |
| 6 (frontend `/app`) | **Aliasing** : conserver les routes anciennes en **redirect** vers `/app` (pas de suppression), rollback = **reverser l'alias**. Manifest repasse en `start_url: "/"`. SW repasse en `royalvibe-v1` (ou `saas-v1` si déjà versionné). Couleur repasse à `#b8960c` global. |
| 7 (Mobile Money) | `git revert` du module `subscriptions` + des guards. Les données `subscriptions` restent. |
| 8 (CI/CD) | `git revert` du workflow ; le `docker-compose.prod.yml` reste. |

### Procédure d'urgence (rollback global)

Si un **incident majeur** survient (ex : data leak, corruption de la migration 001) :
1. **Stopper les écritures** API (reverse proxy → 503) — **5 min**.
2. **Restaurer le snapshot MongoDB** de phase 0 (`mongorestore` sur la base de prod) — **15 min** (dépend de la taille de la base).
3. **`git checkout audit-saas-v0.1`** et **redeploy** (Railway + Vercel) — **10 min**.
4. **Vérifier** : `GET /health`, `POST /auth/login` (admin), `GET /sections`, `GET /analytics/*`.
5. **Informer** les utilisateurs (SMS / e-mail) ; **post-mortem** à J+1.

> **Attention** : la restauration d'un snapshot **perd les écritures** faites entre le snapshot et l'incident. C'est le compromis du rollback. C'est pourquoi le snapshot doit être **fréquent** (jour) pendant la période de transformation.

---

## 18. Résumé final

- **Dossier analysé** : `api/src/**` (60 fichiers), `web/src/**` (45 fichiers), `web/public/**`, `nginx/`, `.github/workflows/`, `docker-compose*.yml`, `README.md`, `api/README.md`, `web/README.md`, `.env*.example`, `package.json`, `pnpm-workspace.yaml`, `next.config.ts`, `tsconfig.json`, `Dockerfile` (×2), `pnpm-lock.yaml` (lecture des clés de marque uniquement).
- **Commandes non-destructives exécutées** : 5 × `dir /b /s <chemin>` (listage de fichiers), plusieurs `Glob`, lecture de fichiers. **Aucune commande de build, de test, de lint, de migration, de git, de déploiement.**
- **Fichier créé** : `docs/audits/saas-transformation-audit.md` (ce document).
- **5 risques les plus importants** :
  1. **C-1** : aucune isolation multi-tenant (aucune donnée, endpoint, WS, S3 ou index n'est scindé par organisation).
  2. **C-2** : lecture des Analytics (KPIs + classements vendeurs, y compris emails et revenues) par n'importe quel utilisateur connecté (y compris `seller`) — `analytics.controller.ts` sans `@Roles`.
  3. **C-4** : Socket.IO **non authentifié** + **`cors: origin '*'`** + **broadcast global** (après multi-tenant, les tenants se voient mutuellement).
  4. **E-1** : `CORS_ORIGIN` vide → `origin: true` → all origins autorisées (cross-site leakage).
  5. **E-5** : **Pas de transaction MongoDB** sur `sale+stock+audit` → si `decrementStock` échoue après `sale.create`, le stock n'est pas décrémenté mais la vente existe (perte de cohérence / de revenus).
- **Questions nécessitant une décision humaine** (les 5 prioritaires — voir §15) :
  - **Q1** : email unique par organisation ou unique global ?
  - **Q2** : le register public existe-il encore post-multi-tenant (création d'org uniquement) ?
  - **Q4** : nom d'organisation et slug de la première entreprise cliente (RoyalVibe → "royalvibe") ?
  - **Q6** : bucket S3 partagé (1 seul) ou par organisation (N buckets) ?
  - **Q11** : environnement de prod réel (Vercel + **ou** self-hosted) — les deux existent dans le repo.

*Aucune modification de code, de donnée, d'environnement ou de déploiement n'a été effectuée. Ce rapport est le seul livrable de cette session.*
