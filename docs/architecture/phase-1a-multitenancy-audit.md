# PHASE 1A — Audit & conception du socle multi-tenant

> **Date** : 21 septembre 2026 · **rév. 2** — décisions D1–D10 validées et intégrées
> **Branche / HEAD** : `architecture/phase-1a-multitenancy-audit` · `cd166d46ff058ef84b96e181f4bf523ca1777e93` (tag `phase-0b-complete`)
> **Périmètre** : audit d'architecture & plan de migration **uniquement — AUCUN modèle, endpoint, migration, écran ou dépendance créé / modifié.**
> **Méthode** : lecture système en lecture seule (`api/src/**`, `web/src/**`, infra, CI), sans exécuter de build/test/install, sans accéder à Atlas/Supabase/`.env` réel.
> **Référence** : `docs/audits/saas-transformation-audit.md` (17/09, commit `257109e`) — précède les phases 0B ; ce rapport actualise les constats 0B.3–0B.7 (Socket auth, CORS, inscription fermée, rate-limit, transaction ventes, replica set local).
> **Décisions** : les décisions D1–D10 (§8) sont **validées** ; le modèle cible, les permissions, la migration, le découpage des phases et le statut reflètent cet état.

**Légende** : `CONSTAT` = code observé ; `RECO` = recommandation ; `VALIDÉ` = décision humaine enregistrée. Les renvois « contrainte N » désignent les 11 contraintes fonctionnelles du cahier des charges Phase 1A.

---

## 1. État actuel

**Constat global** : l'API est **mono-tenant de bout en bout**. Aucun champ `organizationId`/`tenant`/`owner`/`companyId` n'existe dans les 6 schémas ni dans les agrégations ; la multi-tenancy n'apparaît que dans des commentaires de roadmap (`api/src/events/events.gateway.ts:56-57`, `api/src/auth/auth.controller.ts:24` — « inscription du gérant (OWNER), création de son organisation »).

Rôles existants : `UserRole = { ADMIN:'admin', SELLER:'seller' }` (`api/src/users/schemas/user.schema.ts:7-10`). Aucun `OWNER`. Aucun système de permissions au-delà des rôles.

### 1.1 Collections MongoDB (6)

| Collection | Propriétaire implicite | Références | Endpoints | Isolation | Risque fuite inter-entreprises | Modification requise |
|---|---|---|---|---|---|---|
| `users` | AUCUN (1 seul user « monde ») | `Sale.sellerId`→User, `AuditLog.actorId`→User | `POST /auth/login`·`/auth/register`·`GET /auth/me` | **Non** — `email` **unique global** (`user.schema.ts:18`), aucun champ org. | Élevé : `role` figé par compte, pas d'appartenance org. | Appartenance **indirecte** (via memberships) ; `email` unique global **conservé** (VALIDÉ D2) : 1 personne = 1 compte, multi-appartenance via `OrganizationMembership`. |
| `sections` | AUCUN (catalogue partagé) | `Section.parentId`→Section (auto), `Product.sectionId`→Section | `GET/POST/PATCH/DELETE /sections*`, `GET /trash` | **Non** — lecture ouverte à tout login (`sections.controller.ts:31-39`). | Élevé : hiérarchie de sections partagée ; unicité nom par parent en app (`sections.service.ts:22-41`). | `organizationId` + index composé `{organizationId, parentId, deletedAt}` ; scoping des queries. |
| `products` | AUCUN (catalogue partagé) | `Product.sectionId`→Section ; `Sale.productId`→Product ; `AuditLog.productId`→Product | `GET/POST/PATCH/DELETE /products*`, `GET /trash` | **Non** — lecture ouverte + `imageUrl` **sans préfixe org** (`product.schema.ts:13-14`). | Critique : catalogue + métriques + `imageUrl` publics à tout login ; clé de stockage plate. | `organizationId` + index `{organizationId, sectionId, deletedAt}` ; clé `organizations/{orgId}/…` + `imageKey` en base (§4). |
| `sales` | **`sellerId` → User** (seul lien ressource→user) | `Sale.productId`→Product, `Sale.sellerId`→User | `POST /sales` (tout auth), `GET /sales` (tout auth), `PATCH/DELETE` (admin), `GET /analytics/*` | **Non** — `GET /sales` renvoie **toutes** les ventes de **tous** les vendeurs (`sales.service.ts:126-134`). | Critique : ventes + `buyerName`/`buyerContact` (PII) visibles par tout auth. | `organizationId` + index `{organizationId, productId, createdAt}` ; scoping `$group`/`$match` ; split `sales.view_own`/`view_all` (§3). |
| `auditlogs` | AUCUN (journal global) | `AuditLog.productId`→Product, `AuditLog.actorId`→User | Exposé via `GET /products/:id` (populate `actorId`) + `GET /analytics/sellers/ranking` | **Non** — journal non partitionné par org ; `details` non typé. | Élevé : emails des acteurs + email du vendeur dans les populates. | `organizationId` + index `{organizationId, productId, action, createdAt}`. |
| `objects` ⚠ **orphelin** | AUCUN | AUCUN | `POST/GET/DELETE /objects` — **module `ObjectsModule` ABSENT de `AppModule`** (`app.module.ts:18-36`) → routes **non exposées** | Non | Faible (code mort) mais collection résiduelle en base. | **Conservé** (VALIDÉ D4) : pas de retrait pendant les phases de modélisation ; nettoyage **séparé, non prioritaire (phase 1-10)**, **après** vérification de la collection de production ; aucune suppression de collection automatique. |

**Index MongoDB** : aucun index simple/composé au-delà de `_id` et `email` (unique). `deletedAt`, `sectionId`, `productId`, `sellerId`, `actorId` **non indexés** → requêtes `findAll`/`assertUniqueName` (`^name$` i) en **O(n)**. (CONSTAT — grep `index/unique` : 0 hits hors specs.)

**`deletedAt`** : présent **uniquement** sur `products` et `sections`. `findAll` filtre `deletedAt:null` ; `findTrashed` = `{deletedAt:{$ne:null}}` tri `-1` ; `restore` remet `deletedAt:null` **sans re-check d'unicité** (nom occupé possible). Suppression physique : `permanentDelete` (suppression fichier puis `deleteOne`), **sans cascade** sur `sales`/`auditlogs`. (CONSTAT — `products.service.ts:232-266`, `sections.service.ts:104-127`.)

### 1.2 Endpoints critiques (CONSTAT — `@Roles` réelles)

- **Lecture ouverte à tout login (seller inclus)** : `GET /sections*`, `GET /products*` (+ métriques + audit + emails), `GET /sales` (toutes ventes), `POST /sales` (vendeur = token courant).
- **`@Roles(ADMIN)`** : mutations `sections`/`products`/`sales`, `GET /trash` (class-level `trash.controller.ts:10`), `GET /analytics/*` (class-level `analytics.controller.ts:11` — corrigé phase 0B.1/audit C-2, mais **sans filtrage org**).
- **Aucun filtre par utilisateur courant** : `@CurrentUser()` injecte le doc user (rechargé à chaque requête, `jwt.strategy.ts:27-29`) ; son `_id` sert **uniquement** à `actorId`/`sellerId`, jamais à filtrer une lecture.
- **Auth** : registration fermée par défaut (`PUBLIC_REGISTRATION_ENABLED`, 0B.5) ; rate-limit `POST /auth/login` (0B.6 : 10/60s + 30/15min, 429 `AUTH_RATE_LIMITED` + `Retry-After`, `TRUST_PROXY_HOPS` strict).
- **JWT** : payload constaté `sub` + `email` + `role` + `exp` (`auth.service.ts:56-61`), `expiresIn:'7d'`, **aucun `organizationId`**, **aucune révocation** → cible (§4.1) : claims métier `sub` + `orgId`, claims standards `iat`/`exp` conservés, `email` et `role` retirés du payload métier ; durée actuelle de 7 jours conservée tant qu'une autre politique n'est pas décidée ; rôle effectif issu de la membership.

### 1.3 Socket.IO (CONSTAT — post 0B.3)

- **Auth du handshake** : JWT vérifié `jwtService.verifyAsync` (`socket-auth.middleware.ts:113-133`), `exp` futur strict, re-`findById(sub)` (user supprimé → refus), `socket.data.user = {sub,email,role}`. Déconnexion forcée à l'`exp` du JWT. Origines = allowlist stricte `CORS_ORIGIN` (0B.4).
- **Mais AUCUNE room** : `this.server.emit(event, payload)` = **BROADCAST GLOBAL à tous les sockets** (`events.gateway.ts:167`), zéro `socket.join`/`.to()`. Événements : `product:created/updated/deleted`, `sale:created` (after commit). **Risque critique post-multi-tenant** : chaque tenant recevrait les événements de tous.
- Commentaire du code : « Les événements restent diffusés à TOUS les utilisateurs authentifiés de l'unique entreprise actuelle — insuffisant après l'arrivée d'un 2ᵉ tenant (rooms `organization:{id}` à la phase multi-tenant). » (`events.gateway.ts:54-57`)

### 1.4 Stockage fichiers (CONSTAT — `s3.service.ts:37-62`)

- En production, le stockage est **Supabase Storage** (VALIDÉ D9) ; la couche API est agnostique (client S3).
- Clé : `` `${randomUUID()}-${file.originalname}` `` — **pas de préfixe org/user**, pas de timestamp. URL publique directe.
- `deleteFile(imageUrl)` : `split(`${this.bucket}/`)[1]` → **no-op silencieux si le pattern ne matche pas** ; la clé est **déduite d'une URL** (vulnérable). **Aucune présignation.**
- **Bucket partagé** futur entre tous les tenants → sans préfixe `organizations/{orgId}/`, impossible d'isoler/lister par tenant.

### 1.5 Frontend (CONSTAT)

- Token JWT en `localStorage` (`heyama_token`, `web/src/lib/auth.ts:1,14`) ; **pas de refresh token** ; **garde 100 % client-side** (`useEffect` + redirect, `page.tsx:39-43`) ; 401 → interceptor `clearAuth` + `replace('/auth/login')` (`api.ts:106-121`).
- Modèle user frontend : `{_id, name, email, role:'admin'|'seller'}` — **aucun champ tenant/organization** ; aucun `organizationId`/`userId` expédié en paramètres API (seuls `sectionId`, `parentId`, `productId`, `month`).
- Logo : `web/public/logo.jpg` (local) + icônes, thème `#b8960c` codé en dur (`manifest.ts:12`, `layout.tsx:44`).

---

## 2. Modèle cible

### 2.1 Comparaison des options

| Option | Avantages | Inconvénients | Verdict |
|---|---|---|---|
| **A. `organizationId` directement dans `User`** (1 user = 1 org) | Simple, 1 query. | **Bloquant** : interdit « une personne appartenant à plusieurs organisations » (contrainte 4) ; pas d'invites, pas de changement d'org active, pas de révocation. | ❌ Écartée — rejetée par la décision **D1**. |
| **B. `Organization` + `OrganizationMembership`** (1 user multi-org via memberships) | Multi-appartenance, invitations, choix de l'org active, suspension/révocation, permissions par membership, pas d'escalade. | + 2 collections + champs `organizationId` dérivés sur les données ; complexité de requête (scoping). | ✅ **VALIDÉ (D1)**. |

**Modèle validé (D1)** : l'option **B** seule satisfait les 6 exigences (multi-membres/entreprise, user multi-entreprises, permissions personnalisables, invitations, changement d'organisation active, absence d'escalade). Le backend reste l'autorité : le `organizationId` effectif est **fourni par le serveur** (JWT validé contre la membership à chaque requête, §4.1) ; le client peut **demander** une organisation mais ne l'impose jamais.

### 2.2 Champs minimaux

**`Organization`** (nouvelle collection `organizations`)
| Champ | Type | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `name` | string (100) | Nom affiché (contrainte 9). |
| `slug` | string unique | Identifiant stable ; 1ʳᵉ org : `royalvibe` (VALIDÉ D6). |
| `logoKey` | string\|null | Clé de stockage du logo (contrainte 9) ; `null` = logo par défaut. |
| `brandColor` | string (hex) | **Une seule couleur au départ** (VALIDÉ D7) ; palette = évolution future reportée. |
| `currency` | enum (`XOF`,`EUR`,…) | **Par organisation, `XOF` par défaut** (VALIDÉ D6) — multi-pays/devises (contrainte 11). |
| `status` | enum (`active`,`suspended`) | Suspendue sans suppression. |
| `createdAt`/`updatedAt` | Date | timestamps. |

**`OrganizationMembership`** (collection `organizationmemberships`)
| Champ | Type | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `organizationId` | ref Organization | |
| `userId` | ref User | |
| `role` | enum (`owner`,`admin`,`seller`) | **`owner` distinct de `admin`** (VALIDÉ D10) ; `owner` non délégable en pratique (ops exclusives §3). |
| `permissions` | string[] (défaut par rôle) | Droits délégables (contrainte 6) ; matrice §3. |
| `status` | enum (`active`,`suspended`,`revoked`) (défaut `active`) | Une personne peut avoir **plusieurs memberships `active`** (plusieurs orgs, multi-appareils/sessions). **Pas** de champ « une seule membership active » — la proposition initiale `active: boolean` est **rejetée** (empêchait 2 orgs simultanées). |
| `invitedById` | ref User\|null | Piste d'audit de l'invitation. |
| `joinedAt` | Date | |
| Index 1 | `{ organizationId: 1, userId: 1 }` **unique** | Une seule membership par (org, user). |
| Index 2 | `{ userId: 1, status: 1 }` | Recherche des memberships d'un user. |
| Index 3 (partiel unique) | `{ organizationId: 1, role: 1 }` avec filtre `{ role: 'owner', status: 'active' }` | **Au plus un owner actif par organisation.** **Transfert de propriété (VALIDÉ)** : le propriétaire actuel est **rétrogradé vers `admin` avec `status:'active'`** ; le nouveau membre est **promu `owner` avec `status:'active'`** ; les **deux changements sont effectués dans une même transaction** (les autres sessions ne voient que l'état avant ou après). La **suspension/révocation de l'ancien propriétaire n'a lieu que si elle est explicitement demandée après le transfert**. L'index unique partiel garantit qu'il existe au maximum un owner actif par organisation. L'invariant applicatif et la transaction de transfert garantissent qu'il en reste exactement un à l'issue de l'opération. |

**`OrganizationInvitation`** (collection `organizationinvitations`) — **schéma créé en phase 1-6 (Invitations)**, pas en 1-1A
| Champ | Type | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `organizationId` | ref Organization | |
| `email` | string (normalisé lower) | Invitation par email. |
| `role` | enum (`admin`,`seller`) | **Pas `owner`** (contrainte 8). |
| `permissions` | string[] (défaut) | Permissions de départ de l'invité. |
| `invitedById` | ref User | |
| `tokenHash` | string (sha256 hex) | Token aléatoire stocké **uniquement en hash** ; le clair n'est **jamais** stocké ni transmis en base. |
| `tokenExpiresAt` | Date | Expiration (`expired`). |
| `status` | enum (`pending`,`accepted`,`revoked`,`expired`) | Cycle de vie. |
| `acceptedAt` / `revokedAt` | Date\|null | Traces de consommation/révocation. |
| Index | `{ tokenHash: 1 }` **unique** ; `{ organizationId: 1, email: 1 }` **unique partiel** (filtre `status: 'pending'`) | 1 invitation `pending` par (org, email). |

**Usage unique (VALIDÉ)** : pas de champ `singleUse` (il dupliquerait l'état). L'usage unique est garanti par la transition **atomique** `status: pending → accepted` (recherche-mise-à-jour conditionnée sur `status: 'pending'`), le **refus si le statut n'est plus `pending`** (doublon/expirée/révoquée) et les horodatages `acceptedAt`/`revokedAt`.

**Évolution de `User`** : `email` **unique global conservé** (VALIDÉ D2) ; le champ `role` de `User` reste en l'état pendant la transition (guards 0B). `User.role` devient **obsolète** lorsque les permissions par membership font autorité. Son **retrait physique est reporté** à une phase de nettoyage après migration complète du backend et du frontend. **Aucun champ `activeOrganizationId`** : une préférence ergonomique éventuelle plus tard (`lastOrganizationId`) est simple indicateur de dernière org utilisée et **n'accorde jamais d'accès** — jamais source d'autorisation (§4.1).

---

## 3. Permissions

Matrice initiale **déduite des endpoints réellement présents** (CONSTAT §1.2). Le backend est l'autorité ; le frontend ne masque que l'ergonomie.

| Permission | `owner` | `admin` | `seller` | Endpoints concrets |
|---|---|---|---|---|
| `catalog.manage` (sections CRUD/restore/perm) | ✅ | ✅ | ❌ | `POST/PATCH/DELETE /sections*` |
| `products.manage` (CRUD + images) | ✅ | ✅ | ❌ | `POST/PATCH/DELETE /products*` |
| `stock.adjust` (stock + prix) | ✅ | ✅ | ❌ | `PATCH /products/:id` (prix/qty) |
| `sales.record` (créer une vente) | ✅ | ✅ | ✅ | `POST /sales` (`sellerId` = user courant) |
| `sales.view_own` (consulter **ses** ventes) | ✅ | ✅ | ✅ **par défaut** | `GET /sales` filtré `sellerId = ctx.userId` |
| `sales.view_all` (consulter les ventes de l'org) | ✅ | ✅ | **déléguable** (par un détenteur de la permission) | `GET /sales` sur toute l'organisation |
| `analytics.read` (KPI + rankings) | ✅ | ✅ | ❌ | `GET /analytics/*` |
| `audit.read` (journal) | ✅ | ✅ | ❌ | via `GET /products/:id` + `/analytics` |
| `trash.manage` (restore/perm) | ✅ | ✅ | ❌ | `GET /trash`, `*/restore`, `*/permanent` |
| `branding.manage` (nom + logo) | ✅ | ✅ (VALIDÉ D8 : **délégable**) | ❌ | routes branding (1-8) |
| `members.invite` (inviter des membres) | ✅ | ✅ | ❌ | routes invitations (1-6) |
| `members.manage` (suspension/révocation, rôles) | ✅ | ✅ (pas du rôle `owner`) | ❌ | routes memberships |
| **Opérations NON délégables (`owner` exclusif, contrainte 8)** | ✅ | ❌ | ❌ | **transfert de propriété, suppression de l'organisation, identité de facturation, attribution du rôle `owner`** |

**Règle d'anti-escalade** : un membre ne peut attribuer qu'une permission qu'il **possède** (vérifié au serveur : permissions transmises ⊆ permissions du donneur), sauf `owner` qui délègue l'ensemble des droits délégables. `owner` est **unique actif** par org (index partiel unique, §2.2) et ne se change que par **transfert en transaction** (l'ancien owner → `admin` actif, le nouveau → `owner` actif, §2.2).

**VALIDÉ D3** : un vendeur voit **ses propres ventes par défaut** ; les permissions `sales.view_own` et `sales.view_all` sont **séparées** et `sales.view_all` **peut être déléguée**. **VALIDÉ D8** : `branding.manage` est une **permission délégable**, non réservée au propriétaire.

---

## 4. Isolation des données

Stratégie **défense en profondeur** côté serveur. Objectif : zéro fuite inter-entreprises ; le **client ne contrôle jamais l'`organizationId`** utilisé.

| Vecteur d'attaque (exigence) | Mécanisme serveur |
|---|---|
| **1. Client qui envoie lui-même un `organizationId`** | `organizationId` **jamais lu du body/query ni imposé** : le JWT signé contient `orgId`, et le `OrganizationGuard` global re-vérifie à chaque requête la membership (§4.1). Tout `organizationId` transmis dans un DTO est **absent du DTO** et rejeté (`forbidNonWhitelisted`). |
| **2. Consulter une ressource d'une autre org en connaissant son ID** | Requêtes Mongoose **scoping obligatoire `{ organizationId: ctx.orgId, _id: id }`** via helper `scopedQuery(model, ctx)` ; doc absent **ou** d'une autre org → **404 (pas 403)** pour ne pas révéler l'existence des ressources d'autrui. |
| **3. Analytics d'une autre entreprise** | Les 4 agrégations (`overview`, `products/ranking`, `sellers/ranking`, `monthly`) commencent par `$match: { organizationId: ctx.orgId }` + `$lookup` scoping par org. |
| **4. Recevoir les événements Socket.IO d'autrui** | `socket.join('organization:' + ctx.orgId)` au handshake (orgId issu de la membership validée dans `socket.data`) ; émission `this.server.to('organization:'+orgId).emit(...)` au lieu de `server.emit`. Refus de connexion sans membership active ; **déconnexion immédiate en cas de suspension/révocation** (§4.2). |
| **5. Accéder aux photos/clés de stockage d'autrui** | **Bucket Supabase Storage partagé** (VALIDÉ D5) avec clés **préfixées** `organizations/{orgId}/{uuid}-{name}`. Ce préfixe fournit une **séparation logique** et simplifie la gestion, mais **ne garantit aucune confidentialité si le bucket est public** : images volontairement publiques → URL publique acceptable ; fichiers **confidentiels futurs** → bucket **privé + URLs signées**. Les suppressions utilisent une **`imageKey` stockée en base et scoping par organisation** ; **aucun nom de clé n'est déduit d'une URL reçue du client** (fin du `split` vulnérable, §1.4). |
| **6. Restaurer depuis la corbeille d'autrui** | `restore`/`permanentDelete`/`findTrashed` scoping `{ organizationId: ctx.orgId }` (corbeille **par organisation**). |

### 4.1 Sélection de l'organisation active (VALIDÉ)

Le champ `active` de la membership (et tout `activeOrganizationId`) est **rejeté** comme source d'autorisation. Stratégie cible :

1. Le **JWT signé porte les claims métier `sub` (ID user) et `orgId`** ; les **claims standards de sécurité `iat` et `exp` sont conservés** ; `email` et `role` sont **retirés du payload métier** ; la **durée actuelle de 7 jours est conservée** tant qu'une autre politique de token n'est pas décidée. **La vérification stricte de `exp` (HTTP et handshake Socket.IO) et la déconnexion Socket.IO à l'expiration restent obligatoires.**
2. Si l'utilisateur possède **une seule membership active**, le login **sélectionne automatiquement** cette organisation.
3. S'il en possède **plusieurs**, il **choisit** une organisation (au login/premier usage).
4. Un **endpoint de changement d'organisation** **vérifie membership ET organisation côté serveur** (§4.1 point 5) puis **émet un nouveau JWT signé** pour l'org choisie.
5. **À chaque requête**, le backend **vérifie simultanément** : `userId = JWT.sub`, `organizationId = JWT.orgId`, la **membership est trouvée**, **`membership.status === 'active'`**, l'organisation **existe** et **`organization.status === 'active'`** (lecture fraîche en base — le claim ne fait pas foi).
6. Le contexte serveur reçoit ensuite `organizationId`, le **rôle** et les **permissions** (§3) ; les services n'y accèdent que via ce contexte.
7. Les **DTO métier ne peuvent jamais définir ni modifier `organizationId`** (champ absent des DTO + `ValidationPipe forbidNonWhitelisted`).

**Nuance (VALIDÉ)** : le client peut **demander** de sélectionner une organisation (login, switch), mais il ne peut **jamais imposer directement** l'organisation utilisée lors d'une écriture — le serveur valide la membership **avant** de signer le contexte (nouveau JWT) et à chaque requête. Un `lastOrganizationId` éventuel (préférence ergonomique, future) ne fait que mémoriser le dernier choix ; **il n'accorde aucun accès**.

**Organisation suspendue (VALIDÉ)** : une organisation avec `status: 'suspended'` est **refusée** par la résolution du contexte, **sauf futurs endpoints explicitement autorisés pour facturation/réactivation** (non implémentés dans ce plan).

### 4.2 Règles de sécurité de la mise en production (VALIDÉ)

- **Interdiction d'activation** : il est interdit d'activer plusieurs organisations tant que ces éléments ne sont **pas tous opérationnels** :
  1. contexte organisationnel (1-3A/B) ;
  2. filtrage HTTP de **toutes** les ressources (1-4) ;
  3. Analytics scoping (1-4) ;
  4. corbeille par org (1-4) ;
  5. WebSocket **par room** (1-5) ;
  6. stockage **par préfixe organisationnel** (1-5).
- Les phases **1-3A (service de résolution), 1-3B (intégration auth/contexte) et 1-4 (scoping)** peuvent rester des **commits révisables séparément**, mais elles **forment une seule unité de déploiement multi-tenant** : elles ne doivent **pas** être déployées séparément comme fonctionnalité.
- **Règle de production** : aucun **onboarding d'une deuxième organisation** et aucune **création de tenant** ne sont autorisés **avant la validation de l'isolation HTTP, WebSocket et stockage** (fin de 1-5).
- **WebSockets** : une **suspension/révocation de membership déconnecte les sockets concernés immédiatement**, sans attendre l'expiration du JWT de 7 jours (signal de déconnexion émis côté serveur à la mutation du status).

### 4.3 Index composés tenant (à créer en 1-1B/1-2)

- `organizationmemberships` : `{organizationId,userId}` unique ; `{userId,status}` ; partiel unique `{organizationId,role}` filtre `{role:'owner',status:'active'}`.
- `organizationinvitations` (créées en 1-6) : `{tokenHash:1}` unique ; `{organizationId:1,email:1}` unique partiel filtre `{status:'pending'}`.
- `sections` : `{organizationId,parentId,deletedAt}`.
- `products` : `{organizationId,sectionId,deletedAt}`.
- `sales` : `{organizationId,productId,createdAt}`.
- `auditlogs` : `{organizationId,productId,action,createdAt}`.
- `users` : l'index unique global `email` est **conservé** (D2). Ni `activeOrganizationId` ni `lastOrganizationId` ne sont indispensables (reporté).

---

## 5. Migration de RoyalVibe

**Principe** : RoyalVibe **devient la première organisation** (VALIDÉ D6 : `RoyalVibe`, slug `royalvibe`, devise `XOF`) ; son **propriétaire est le compte existant `franck@royalvibe.com`** (VALIDÉ). L'identité du propriétaire n'était bloquante que pour cette migration (1-2), **pas** pour les schémas 1-1A. Migration **idempotente** ; aucun script n'est créé/exécuté dans cette phase (plan seul).

**Gel des écritures (VALIDÉ — NON optionnel)** : les écritures sont **bloquées** pendant le backfill et le basculement. Deux stratégies :
- **(a) Fenêtre de maintenance** — écritures bloquées pendant toute l'opération. **RECO pour la première migration** : plus simple et plus sûre pour le volume actuel ;
- **(b) Dual-write** correctement **testé avant** le backfill (plus complexe, non requis au volume actuel).

**Séquence minimale** :

| # | Étape | Contrôle / idempotence |
|---|---|---|
| 1 | **Snapshot Atlas** de la base de production | préalable obligatoire |
| 2 | **Inventaire des objets Supabase Storage** (clés existantes) | préalable obligatoire |
| 3 | **Activation de la maintenance** (écritures bloquées) | stratégie (a) VALIDÉ RECO |
| 4 | **Création de l'organisation `RoyalVibe`** (`slug:'royalvibe'`, `currency:'XOF'`, `brandColor:'#b8960c'`) | upsert sur `slug` (pas de doublon) |
| 5 | **Création de la membership `owner`** pour `franck@royalvibe.com` (`status:'active'`) | upsert unique `{organizationId,userId}` |
| 6 | **Création des autres memberships** (users existants → `seller`/`admin`, `active`) | upsert idempotent |
| 7 | **Backfill des `organizationId`** sur `sections`, `products`, `sales`, `auditlogs` (`{organizationId:{$exists:false}}` → org) | rejouable ; dry-run préalable **sur le snapshot** (étape 3′ : compteurs par collection avant maintenance) |
| 8 | **Vérification des références et orphelins** : zéro doc sans `organizationId` ; `sellerId`/`actorId`/`sectionId`/`productId`/`parentId` tous **∈ même org** | lecture seule |
| 9 | **Déploiement du contexte + scoping** (1-3A + 1-3B + 1-4 **en unité**) | gate §4.2 |
| 10 | **Smoke tests** (`/health`, login owner, sections/produits/ventes/analytics/corbeille/socket) | — |
| 11 | **Réouverture des écritures** | — |

**Photos existantes (VALIDÉ D5)** : **conservation** des URLs/clés actuelles (`{uuid}-{name}`) pour les fichiers existants ; **préfixe `organizations/royalvibe/`** pour tous les nouveaux uploads. Job de renommage (copy + delete) optionnel et reportable (non bloquant, hors-peak).

**Rollback (VALIDÉ)** :
- Tant qu'**une seule organisation** existe, un **retour contrôlé au code mono-tenant** reste envisageable (désactiver guard/scopes) : aucune fuite possible sans 2ᵉ org — mais les données `organizationId` restent en place.
- **Dès qu'une deuxième organisation contient des données, désactiver les guards/scopes est INTERDIT.**
- Après l'arrivée d'un 2ᵉ tenant, le rollback doit **conserver l'isolation** ou **restaurer un snapshot cohérent** (celui de l'étape 1).
- Le rollback ne touche jamais les données (`organizationId` conservés) ; il s'agit de code/index uniquement.

---

## 6. Compatibilité future hors-ligne (sans implémenter)

Décisions que le modèle multi-tenant **ne doit pas bloquer** :

| Aspect | Décision à prévoir |
|---|---|
| **Idempotency keys / identifiants client** | Chaque écriture porte une `clientMutationId` + scoping `(organizationId)` serveur ; dédoublonnage par `(orgId, clientMutationId)` unique. |
| **Versionnement des ressources** | Champ `version` incrémenté (optimistic) sur `products`/`sections`/`sales`. |
| **Détection des conflits** | Comparaison `version` serveur vs client ; 409 `VERSION_CONFLICT` si divergence. |
| **File locale d'opérations** | Queue client hors-ligne ; replay **idempotent** et **scoping par org** à chaque flush. |
| **Synchronisation différée des photos** | Upload à la reconnexion sous `organizations/{orgId}/` ; `imageKey` résolu côté serveur. |
| **Appartenance org fixée côté serveur** | `organizationId` **toujours assigné par le serveur** (déduit de la membership validée), jamais transmis/édité par le client. |

> Aucune de ces décisions n'exige de nouveau modèle dès maintenant ; elles **contrainent** les designs de permissions (stables), d'`orgId` (fixé serveur) et des clés d'écriture (idempotentes).

---

## 7. Plan d'implémentation (phases futures)

Chaque phase : **objectifs · fichiers · tests · dépendances · risques · condition d'arrêt**. Comptage **honnête** des fichiers de production (les specs/tests ne sont pas comptés) ; aucune phase ne déclare `≤7` si sa liste en contient davantage → subdivision. Aucune n'est exécutée ici.

### 7.1 Phase 1-1A — Modèles fondamentaux
- **Objectifs** : schémas `Organization` + `OrganizationMembership` (rôles `owner|admin|seller`, `status: active|suspended|revoked`, 3 index §2.2/§4.3) ; **enum stable des permissions** (§3) ; module `Organizations` (enregistrement des modèles). **Aucun endpoint, aucun schéma Invitation, aucun retrait de `objects`, aucune modification du comportement.**
- **Fichiers (5 prod)** : `organizations/schemas/organization.schema.ts` (new) ; `organizations/schemas/membership.schema.ts` (new) ; `organizations/permissions.ts` (new) ; `organizations/organizations.module.ts` (new) ; `app.module.ts`.
- **Tests** : unit schémas (enums, index, contraintes uniques) ; aucun e2e (pas d'endpoint).
- **Dépendances** : aucune.
- **Risques** : aucune rupture (code purement additif ; `User.email`/`User.role` intactes).
- **Condition d'arrêt** : build + lint 0 erreur + unit verts.

### 7.2 Phase 1-1B — Champs tenant rétrocompatibles
- **Objectifs** : ajout de `organizationId` **optionnel** (nullable, avant migration) sur `sections`, `products`, `sales`, `auditlogs` + index tenant nécessaires (§4.3) ; **aucune modification du comportement** des endpoints (champ non peuplé).
- **Fichiers (4 prod)** : `sections/schemas/section.schema.ts` ; `products/schemas/product.schema.ts` ; `sales/schemas/sale.schema.ts` ; `audit/schemas/audit-log.schema.ts`.
- **Tests** : unit schémas ; les tests existants (unit + e2e) **inchangés** et doivent rester verts → preuve de rétrocompatibilité.
- **Dépendances** : 1-1A.
- **Risques** : création d'index en ligne sur collections (volumes faibles → sans impact notable).
- **Condition d'arrêt** : tests existants 100 % verts sans modification.

### 7.3 Phase 1-2 — Migration RoyalVibe
- **Objectifs** : script de migration **idempotent** (§5, étapes 4–8) + **dry-run sur snapshot** ; propriétaire `franck@royalvibe.com` ; **fenêtre de maintenance** (gel des écritures non optionnel).
- **Fichiers (2 prod + 1 test)** : `scripts/migrations/001_add_organizations.ts` (new) ; `scripts/migrations/001_add_organizations.down.ts` (new) ; 1 test d'intégration sur snapshot.
- **Tests** : dry-run (compteurs par collection, orphelins) ; idempotence (2 exécutions = même état) ; **rollback testé sur le snapshot**.
- **Dépendances** : 1-1B.
- **Risques** : irréversibilité des index → **snapshot Atlas avant** + rollback vérifié ; durée de maintenance limitée.
- **Condition d'arrêt** : 0 orphelin + 0 erreur + rollback vérifié sur le snapshot.

### 7.4 Phase 1-3A — Service de résolution organisationnelle
- **Objectifs** : service central de **résolution du contexte organisationnel** — charge la **membership** (`{userId, organizationId}`) et l'**organisation**, et **vérifie les deux statuts** (`membership.status === 'active'` ET `organization.status === 'active'`) ; retourne le contexte `{ organizationId, role, permissions }` ou refuse. Sert de base réutilisable au guard, au JWT et au switch.
- **Fichiers (2 prod)** : `organizations/organizations.service.ts` (new — `resolveContext(userId, orgId)`, vérification des 2 statuts) ; `organizations/organizations.module.ts` (déjà créé en 1-1A — export du service).
- **Tests** : **unitaires** (service : membership validée+org active → contexte OK ; membership inactive → refus ; org suspendue → refus ; org inexistante → refus ; membership absente → refus).
- **Dépendances** : 1-2.
- **Risques** : double lecture DB par résolution → à mettre en `findOne` combiné / cache court si besoin.
- **Condition d'arrêt** : unit verts couvrant les 5 cas de refus.

### 7.5 Phase 1-3B — Intégration Auth et contexte
- **Objectifs** : JWT signé **claims métier `sub` + `orgId`** (§4.1 — `email`/`role` retirés du payload métier, `iat`/`exp` conservés, 7 j conservés) ; login avec **sélection automatique (1 membership active) ou choix (plusieurs)** ; **endpoint de changement d'organisation** (validation via le service 1-3A + **nouveau JWT signé**) ; `OrganizationGuard` global re-vérifiant à **chaque requête** via le service 1-3A (`sub`/`orgId`/2 statuts) ; décorateur `@CurrentOrg()` ; **`GET /auth/me` et le changement d'organisation restent dans `AuthController`** (pas de `OrganizationsController` créé pour `/me`).
- **Fichiers (6 prod)** : `auth/strategies/jwt.strategy.ts` ; `auth/auth.service.ts` (sign + sélection/switch) ; `auth/auth.controller.ts` (`/me` + switch) ; `auth/auth.module.ts` (wiring guard) ; `auth/guards/organization.guard.ts` (new) ; `auth/decorators/current-org.decorator.ts` (new).
- **Tests** : e2e guard (pas de membership active ou org suspendue → refus) ; e2e switch (auto si 1 membership, endpoint si plusieurs → nouveau JWT) ; unit JWT sign/verify.
- **Dépendances** : 1-2, 1-3A.
- **Risques** : `orgId` du JWT obsolète si la membership est suspendue entre 2 requêtes → **la vérification en base fait foi à chaque requête** (pas le claim) ; déconnexions WS traitées en 1-5.
- **Condition d'arrêt** : e2e : login → `orgId` + contexte résolu ; membership/org suspendue → refus immédiat ; switch → nouveau JWT valide.
- **Exclusions publiques (VALIDÉ)** : les endpoints **publics** (`POST /auth/login`, et à l'avenir l'acceptation d'invitation, etc.) sont **explicitement exclus du `OrganizationGuard`** (via `@Public` / métadonnée) — le contexte organisationnel ne s'applique qu'aux routes protégées.
- **Note déploiement (VALIDÉ §4.2)** : **1-3A, 1-3B et 1-4 sont des commits révisables séparément, mais forment une seule unité de déploiement multi-tenant** (jamais déployés séparément comme fonctionnalité).

### 7.6 Phase 1-4 — Isolation des requêtes
- **Objectifs** : scoping `{organizationId: ctx.orgId}` sur **toutes** les requêtes (sections/produits/ventes/audit) + `GET /sales` scoping par org (le split `view_own`/`view_all` est appliqué en 1-7) + analytics `$match` + corbeille par org + **validation même-organisation** des références entrantes (404 inter-org).
- **Fichiers (6 prod)** : `sections/sections.service.ts` ; `products/products.service.ts` ; `sales/sales.service.ts` ; `analytics/analytics.service.ts` ; `audit/audit.service.ts` ; `trash/trash.controller.ts`.
- **Tests** : **e2e d'isolation** (new, 2 orgs A/B) : zéro fuite en lecture/écriture/analytics/corbeille/références ; 404 inter-org.
- **Dépendances** : 1-3A, 1-3B.
- **Risques** : **le plus risqué** — toute requête oubliée = fuite → grille de test exhaustive par endpoint.
- **Condition d'arrêt** : e2e d'isolation 100 % verts.

### 7.7 Phase 1-5 — Isolation WebSocket + stockage
- **Objectifs** : rooms `organization:{orgId}` + émission `.to(room)` ; **préfixe Supabase Storage `organizations/{orgId}/`** (nouvelles clés) ; champ `imageKey` stocké en base ; `deleteFile` par `imageKey` (plus jamais de clé déduite d'une URL) ; **déconnexion des sockets lors d'une suspension/révocation de membership** (§4.2).
- **Fichiers (5 prod)** : `events/events.gateway.ts` ; `events/socket-auth.middleware.ts` (orgId dans `socket.data` + `join` room) ; `s3/s3.service.ts` (paramètre org + génération/suppression par clé) ; `products/schemas/product.schema.ts` (`imageKey`) ; `products/products.service.ts` (stockage/suppression par clé).
- **Tests** : e2e WS (new) : 2 sockets (2 orgs) → zéro propagation ; révocation → déconnexion immédiate ; S3 : clé préfixée + suppression robuste (réécriture de la spec S3).
- **Dépendances** : 1-4.
- **Risques** : renommage optionnel des clés existantes (copy+delete) hors-peak (reportable).
- **Condition d'arrêt** : aucune room ne reçoit l'événement d'une autre org ; aucune clé déduite d'une URL client.

### 7.8 Phase 1-6 — Invitations
- **Objectifs** : **schéma `OrganizationInvitation` créé ici** (pas en 1-1A) : email normalisé, rôle `admin|seller` (pas `owner` — contrainte 8), `tokenHash` sha256 (jamais en clair en base), expiration, statuts `pending/accepted/revoked/expired`, **usage unique par transition atomique `pending → accepted`** (`acceptedAt`/`revokedAt`), index `{tokenHash:1}` unique + `{organizationId:1,email:1}` unique partiel (`pending`). Acceptation = création du user si absent + membership `active`.
- **Fichiers (6 prod)** : `organizations/schemas/invitation.schema.ts` (new) ; `organizations/organizations.controller.ts` (routes invitations) ; `organizations/organizations.service.ts` (cycle de vie) ; `organizations/invitations.dto.ts` (new) ; `auth/auth.controller.ts` (endpoint d'acceptation) ; `users/users.service.ts` (création user + liaison membership).
- **Tests** : e2e (new) : invite → accepte → membership ; token réutilisé → refus ; expirée/révoquée → refus ; 2ᵉ invite `pending` même org+email → 409.
- **Dépendances** : 1-4.
- **Risques** : token en clair (interdit) → hash uniquement ; emails dupliqués → contrainte partiale.
- **Condition d'arrêt** : cycle de vie complet + usage unique + aucun token clair stocké.

### 7.9 Phase 1-7 — Permissions

Le système de permissions doit **également protéger les routes d'organisation, de memberships et d'invitations** (routes de `organizations.controller`). Comptage honnête : **périmètre initial = 3 fichiers d'infrastructure + 6 contrôleurs + 1 schéma `User` = 10 fichiers** ; le **retrait de `User.role` étant reporté** (retrait physique, cf. §2.2), le **périmètre réellement implémenté en 1-7 est de 9 fichiers**, d'où le découpage en deux sous-phases : **1-7A = 3 fichiers** (infrastructure) et **1-7B = 6 fichiers** (application aux contrôleurs). Le champ historique `User.role` **reste temporairement présent mais marqué obsolète et n'est plus une source d'autorisation** ; **son retrait physique est reporté à une phase de nettoyage** après migration complète du backend **et** du frontend.

#### 7.9a Phase 1-7A — Infrastructure permissions
- **Objectifs** : `PermissionsGuard` (global, fait foi) + décorateur `@RequiresPermission(...)` + wiring `APP_GUARD` dans `AuthModule` ; anti-escalade (`perm ⊆ permissions du donneur`). Ne modifie aucun contrôleur.
- **Fichiers (3 prod)** : `auth/guards/permissions.guard.ts` (new) ; `auth/decorators/permissions.decorator.ts` (new) ; `auth/auth.module.ts` (wiring).
- **Tests** : unit guard (permission présente/absente/délégable/escalade refusée) ; e2e smoke (aucun endpoint encore protégé).
- **Dépendances** : 1-3B.
- **Risques** : hiérarchie garde → le guard permission fait foi ; `@Roles` conservé seulement en transition.
- **Condition d'arrêt** : unit verts ; comportement des routes existantes **inchangé**.

#### 7.9b Phase 1-7B — Application des permissions
- **Objectifs** : applique la matrice §3 aux contrôleurs **métier** (`sections`, `products`, `sales`, `analytics`, `trash`) **ET** au contrôleur d'organisation (routes organization / memberships / invitations) ; **split `sales.view_own`/`sales.view_all`** (seller défaut = `sellerId = ctx.userId` ; `view_all` déléguée) ; **4 opérations non délégables `owner`** ; `User.role` **marqué obsolète** (non retiré — retrait reporté, cf. 1-10/phase de nettoyage).
- **Fichiers (6 prod)** : `sections/sections.controller.ts` ; `products/products.controller.ts` ; `sales/sales.controller.ts` ; `analytics/analytics.controller.ts` ; `trash/trash.controller.ts` ; `organizations/organizations.controller.ts`.
- **Tests** : e2e (new) par rôle × permission : seller sans `products.manage` → 403 ; seller défaut → ses ventes (`view_own`) ; `view_all` déléguée → ventes org ; ops owner exclusives refusées à l'admin ; routes d'organisation protégées par permission.
- **Dépendances** : 1-4, 1-6, 1-7A.
- **Risques** : oublis de routes (surtout `organizations.controller`) → grille exhaustive ; hiérarchie garde.
- **Condition d'arrêt** : matrice §3 vérifiée endpoint par endpoint (métier + organisation) ; pas d'escalade démontrée en e2e.

### 7.10 Phase 1-8 — Branding
- **Objectifs** : `brandColor` **unique par org** (VALIDÉ D7) + logo (`logoKey`) ; upload/choix sous permission `branding.manage` (**délégable — D8** : non réservée au propriétaire) ; `GET /auth/me` renvoie `{ user, organization:{ name, logoUrl, brandColor, currency } }`.
- **Fichiers (4 prod)** : `organizations/organizations.controller.ts` ; `organizations/organizations.service.ts` ; `s3/s3.service.ts` (upload logo préfixé) ; `auth/auth.controller.ts` (`/me`).
- **Tests** : e2e (new) : upload logo → clé `organizations/{orgId}/` ; `/me` correct par org ; délégué `branding.manage` (admin ✅ avec permission, ❌ sans).
- **Dépendances** : 1-5, 1-7.
- **Risques** : XSS SVG via `image/svg+xml` → **interdire le SVG** ou vérifier les magic bytes (RECO).
- **Condition d'arrêt** : logo par org isolé + `/me` cohérent + délégation respectée.

### 7.11 Phase 1-9 — Adaptation frontend
- **Objectifs** : routes métier sous `/app` ; `/` = landing publique (post-login → **directement l'application**, contrainte 10) ; `auth-context` porte l'organisation (nom, logo, couleur, devise) ; navigation pilotée par permissions ; **UI de changement d'organisation** quand plusieurs memberships actives ; manifest/SW dynamiques (cacher **uniquement les assets statiques**) ; devise chargée depuis l'API.
- **Comptage honnête** : ~15 fichiers de production au total → **divisé en 3 sous-phases** :
  - **F1 — routes + garde (8 prod, divisé en F1a/F1b de 4)** : `app/page.tsx` (landing) ; `app/analytics/page.tsx` ; `app/sales/page.tsx` ; `app/corbeille/page.tsx` ; `app/sections/[id]/page.tsx` ; `app/products/[id]/page.tsx` ; `contexts/auth-context.tsx` ; `app/layout.tsx`.
  - **F2 — branding & PWA (4 prod)** : `components/layout/navbar.tsx` ; `app/manifest.ts` ; `public/sw.js` ; `lib/api.ts` (client org-aware).
  - **F3 — switch d'org + devise (4 prod)** : composant de switch (new) ; `lib/currency.ts` ; pages (intégration du switch + permission nav) ; `components/currency/currency-converter.tsx`.
- **Tests** : e2e navigateur (login → `/app` direct, pas de page marketing) ; switch d'org → nouveau JWT serveur ; branding correct par org.
- **Dépendances** : 1-3B, 1-7, 1-8.
- **Risques** : SW `cache-first` servant du HTML privé → statiques seuls ; token `localStorage` (choix reporté, non bloquant).
- **Condition d'arrêt** : post-login → application directe + branding par org + navigation par permissions.

### 7.12 Phase 1-10 (non prioritaire) — Nettoyage `objects`
- **Objectifs (VALIDÉ D4)** : **audit en lecture seule** de la collection de production `objects` (présence/volume via snapshot) ; **seulement si** vide ou orphelin confirmé : retrait de `api/src/objects/**` (5 fichiers) + tests associés. **Aucune suppression de collection automatique** ; le nettoyage ne s'exécute qu'**après** vérification.
- **Fichiers (si exécutée)** : 5 fichiers supprimés, 0 créé (suppression de 2 specs).
- **Dépendances** : 1-2 (après vérification de la collection de production).
- **Condition d'arrêt** : collection vérifiée (inventaire documenté) + code retiré + tests verts.

**Ordre & dépendances** : `1-1A → 1-1B → 1-2 → 1-3A → 1-3B → 1-4 → {1-5, 1-6} → 1-7A → 1-7B → 1-8 → 1-9` ; `1-10` indépendante, non prioritaire. **1-3A, 1-3B et 1-4 : commits révisables séparément, déployés en unité unique de déploiement multi-tenant** (§4.2). Chaque phase est **committée et validée** avant la suivante.

---

## 8. Décisions validées (21/09)

| # | Décision (VALIDÉ) | Répercussion dans le plan |
|---|---|---|
| **D1** | Modèle **`Organization` + `OrganizationMembership`** | §2, phases 1-1A |
| **D2** | **Email utilisateur unique global** (1 personne = 1 compte ; multi-appartenance via memberships) | §2.2, §4.3 (index conservé) |
| — | **Propriétaire RoyalVibe : compte existant `franck@royalvibe.com`** | §5 (étape 5) — n'était bloquant que pour 1-2, pas pour les schémas 1-1A |
| **D3** | Un vendeur voit **ses propres ventes par défaut** ; **`sales.view_own` / `sales.view_all` séparés** ; **`sales.view_all` délégable** | §3, phase 1-7 |
| **D4** | **Pas de retrait de `objects`** pendant la création des modèles : code actuel conservé ; phase de nettoyage **séparée, non prioritaire (1-10)** **après** vérification de la collection de production ; **aucune suppression de collection automatique** | §1.1, 1-1A (inchangée), 7.12 |
| **D5** | **Bucket Supabase Storage partagé** avec préfixe `organizations/{organizationId}/` (séparation logique uniquement si bucket public ; privé + URLs signées pour les fichiers confidentiels) | §1.4, §4 (vecteur 5), 1-5 |
| **D6** | **Devise par organisation, `XOF` par défaut** ; 1ʳᵉ organisation **`RoyalVibe`**, slug **`royalvibe`** | §2.2, §5 |
| **D7** | **Une seule `brandColor`** au départ (palette = évolution future) | §2.2 (reporté) |
| **D8** | **`branding.manage` : permission délégable**, non réservée au propriétaire | §3, 1-8 |
| **D9** | **Production actuelle** : API NestJS sur **Railway**, frontend sur **Vercel**, **MongoDB Atlas**, fichiers sur **Supabase Storage** ; `docker-compose.prod.yml` = **ancien/secondaire**, **pas de cible de migration Atlas** | §5 (snapshot/inventaire sur Atlas & Supabase), 1-2 (staging = snapshot Atlas) |
| **D10** | **Rôle `owner` distinct de `admin`** (trois rôles : `owner`/`admin`/`seller`) | §2.2, §3, 1-7 |

**Points reportés (non bloquants)** : palette `brandColor` au-delà d'une couleur (D7) ; `lastOrganizationId` préférence ergonomique future ; stockage du JWT côté client (`localStorage` vs cookie `httpOnly`) — évolution future ; bucket privé + URLs signées pour fichiers confidentiels (D5, au besoin) ; nettoyage `objects` (1-10, non prioritaire).

---

## 9. Statut

Les décisions structurantes sont **maintenant levées** : D1–D10 validées + identité du propriétaire établie. Le modèle peut être cristallisé immédiatement en 1-1A (5 fichiers additifs, zéro risque de rupture). Les seuls points laissés en suspens sont des **choix non bloquants** d'ergonomie ou d'évolution future (liste §8).

**Phase suivante exacte (à valider — non exécutée ici)** :
```
**PHASE 1-1A — Modèles fondamentaux multi-tenant**
Schémas Organization + OrganizationMembership (status active|suspended|revoked)
+ rôles owner|admin|seller + enum stable des permissions + module Organizations.
Aucun endpoint, aucun schéma Invitation, aucun retrait de objects, aucun
changement de comportement. 5 fichiers de production.
Branche proposée : architecture/phase-1-1a-models   (base : cd166d4)
```

---

*Aucun fichier de production n'a été modifié ; aucun modèle/endpoint/dépendance créé ; aucun accès Atlas/Supabase ; aucun test/build/lint exécuté ; aucun commit/push/tag. Ce rapport est le seul livrable de la phase 1A.*

READY — Phase suivante : Phase 1-1A, modèles fondamentaux multi-tenant.
