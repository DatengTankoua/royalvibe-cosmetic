# Phase 0B.3 — Authentification Socket.IO et contrôle des origines

- **Date** : 2026-08-19 (corrections ciblées du 2026-08-19 — timer de déconnexion à `exp`, export module, dépendance frontend, comptes de fichiers)
- **Branche** : `security/phase-0b3-websocket-auth` (issue de `test/phase-0b2-isolated-e2e`, HEAD `4ec19c6` — `test(api): add isolated replica-set e2e infrastructure`)
- **Périmètre** : verrouillage complet des connexions Socket.IO (JWT du handshake + contrôle strict des origines + **déconnexion forcée à l'expiration du JWT**) en réutilisant les variables existantes (`JWT_SECRET`, `CORS_ORIGIN`). Hors périmètre (volontaire) : multi-tenant / rooms par organisation (reporté), modification des événements métier, CORS HTTP global (`main.ts` inchangé), politique d'inscription, refresh token, cookie JWT, ventes/transactions MongoDB, aucun commit (en attente de validation utilisateur).
- **Règles respectées** : inspection du code des versions installées avant toute édition (aucune supposition), tests d'abord avec cycle RED/GREEN démontré, aucune assertion affaiblie, aucun skip/todo/only, aucun secret dans le diff, aucun commit.
- **Bilan fichiers** : **6 nouveaux + 8 modifiés = 14 fichiers au total** (fichiers nouveaux rendus visibles dans `git diff` par `git add -N` — intent-to-add, pas un commit) — table complète §14.

---

## 1. Vulnérabilité traitée

| # | Réf. audit | Défaut | Correction minimale |
|---|-----------|--------|--------------------|
| C-4 / E-2 (WebSockets) | Audit initial | Le `EventsGateway` acceptait **toute** connexion Socket.IO : `@WebSocketGateway({ cors: { origin: '*' } })`, **aucun** contrôle d'authentification du handshake, aucune vérification du JWT, aucun contrôle d'origine. Un attaquant (a) pouvait se connecter sans identité et recevoir **tous** les événements (`object:created`, `object:deleted` — données de vente : prix, e-mails clients), (b) depuis n'importe quel site web (origines `*`) en exfiltrant les flux en direct au travers d'un `WebSocket` malveillant, (c) le long-polling recevait la réflexion CORS `*`. | Deux verrous complémentaires, tous testés (unité + E2E) : (1) **middleware d'authentification du handshake** (`io.use`, installé dans `afterInit`) — token lu UNIQUEMENT dans `socket.handshake.auth.token`, vérifié avec le MÊME `JwtService` que l'auth HTTP, utilisateur re-vérifié, principal minimal attaché ; (2) **contrôle des origines** par `allowRequest` (engine.io, handshake + upgrade **WebSocket**) + `cors.origin` delegate (long-polling), égalité EXACTE sur `CORS_ORIGIN`, refuser en production. |

## 2. Avant / après

| Aspect | Avant | Après |
|--------|-------|-------|
| Connexion sans token | Connecté, reçoit tous les événements | `connect_error` `unauthorized` ; aucun socket de namespace créé |
| JWT falsifié (autre secret) | Connecté (aucune vérification) | `connect_error` `unauthorized` (générique) |
| JWT expiré | Connecté si le client l'envoyait | `connect_error` `unauthorized` (générique) |
| User supprimé (JWT valide) | Connecté | `connect_error` `unauthorized` (générique) |
| JWT valide (seller/admin) | — | `connect` ; `socket.data.user = { sub, email, role }` |
| Origine non autorisée (origine `*`) | Connecté (WebSocket + polling) | Refus au niveau **transport** (`allowRequest`, `Server#verify`) — pas de `connect_error` JWT |
| Origine autorisée + JWT valide | — | `connect` |
| `Origin` absente | Connecté | Toléré en **dev/test** (documenté, testé §4) ; **refusé** en production (couvert en unitaire, rapport §8.2) |
| CORS long-polling | `Access-Control-Allow-Origin: *` | Origine exacte autorisée réfléchie (200) ; origine inconnue → aucun header + `403` |
| `CORS_ORIGIN` chargée | au boot | **à la volée** pour chaque requête (`cors.origin` / `allowRequest` sont des fonctions lisant `process.env`) |

## 3. Stratégie d'authentification du handshake

- **Middleware Socket.IO** (`io.use`) installé UNE fois dans `afterInit` sur le `Server` fourni par NestJS. Ordre vérifié dans le code installé (`@nestjs/core@11.1.28` `nest-application.js` : `init()` → `registerModules()` → `registerWsModule()` → création du serveur Socket.IO + `afterInit` émis par un `ReplaySubject` — **avant** `listen()` et avant tout client) : le middleware est en place **avant toute connexion possible**.
- Rejet du middleware → packet `CONNECT_ERROR` → le client reçoit `connect_error` (message = `err.message`). Acceptation → le namespace s'établit et le socket apparaît dans `namespace.sockets`.
- `next()` est appelé **exactement une fois** dans tous les cas (garde interne `done`) — testé unitairement, y compris double-appel et throw dans `verifyAsync`.
- **Après acceptation** : le middleware programme `socket.disconnect(true)` à l'échéance du token (`scheduleSocketDisconnectAtExpiry`, §15.1) — le socket ne survit jamais à l'expiration du JWT.

## 4. Source du token

- `socket.handshake.auth[SOCKET_AUTH_TOKEN_KEY]` (`SOCKET_AUTH_TOKEN_KEY = 'token'`) — **source unique** : aucune query string, aucun header, aucun `userId`/`role` fourni par le client, aucun payload décodé sans vérification, aucun autre secret (testé : absent / vide / non-string → refus).
- Le client web envoie déjà `auth: { token }` (aucun changement de format requis — Étape 9 : l'ajustement concerne uniquement **quand** connecter/déconnecter).

## 5. Vérification JWT

- `JwtService.verifyAsync(token)` — **MÊME instance que l'auth HTTP** : le `JwtModule.registerAsync` (secret `JWT_SECRET`, `signOptions: { expiresIn: '7d' }`) est importé par `AuthModule` et **ré-exporté par sa classe** : `exports: [AuthService, JwtModule]` (pas d'objet dynamique `JWT_MODULE` ré-exporté). *Nécessité NestJS vérifiée dans la version installée (@nestjs/core 11.1.28) : `validateExportedProvider` n'autorise l'export que d'un provider local **ou de la classe** d'un module importé — pour un module dynamique, `ModuleCompiler.extractMetadata` fixe le metatype de l'import à `toExport.module` (la classe `JwtModule`), donc exporter la classe passe alors que l'export direct de `JwtService` (provider du module importé) lèverait `UnknownExportException`. Le consommateur (`EventsModule` → `EventsGateway`) reçoit `JwtService` de façon transitive — même secret que l'auth HTTP.*
- Vérification **signature + expiration** via le service installé (pas de re-implémentation, pas d'`jsonwebtoken` direct) ; structure minimale du payload contrôlée : `{ sub, email, role }` strings non vides (payload incomplet → refus générique). Le payload vérifié porte aussi `exp` (secondes epoch) — source du timer de déconnexion (§15.1).

## 6. Vérification de l'existence de l'utilisateur

- `UsersService.findById(sub)` (MÊME politique/idempotence que `JwtStrategy.validate`) ; user inconnus/supprimés → refus **générique** `unauthorized` (le client ne distingue jamais expiré / falsifié / supprimé / absent).
- Le principal attaché est **construit par sélection explicite** (jamais de document Mongoose, jamais de `password`, jamais du token, jamais de `_id`), même si le document porterait ces champs.

## 7. Contenu de `socket.data.user`

```ts
{ sub: string; /* ObjectId.toString() */ email: string; role: string }
```

- Jamais `password`, jamais le token, jamais le document complet (tests unitaires §10 + schéma `password: { select: false }` renforce en profondeur).
- Consommation par les événements métier : **inchangée** (aucun `@SubscribeMessage` modifié ; la diffusion reste globale — §12).

## 8. Stratégie des origines

- **Variable unique : `CORS_ORIGIN`** (déjà présente pour le CORS HTTP) — comma-separated d'origines http/https strictes. Parser pur `api/src/events/origin.helpers.ts` (testable, réutilisable par 0B.4) :
  - protocole `http:`/`https:` uniquement ; pas de chemin / query / fragment / `user:pass@` ; slash final normalisé ; wildcard `*` et `*.domaine` **refusés** ; doublons retirés ; valeur vide ignorée.
  - **Égalité EXACTE** sur l'allowlist (jamais `endsWith`, jamais sous-domaine — refus vérifiés : `https://sub.royalvibe-cosmetic.vercel.app`, `https://royalvibe-cosmetic.vercel.app.attacker.com`, http≠https, port différent).
- **Deux mécanismes, tous deux installés via les options du décorateur `@WebSocketGateway`** (vérifiés dans socket.io 4.8.3 / engine.io 6.6.9) :
  - `allowRequest` (engine.io) — lu par `Server#verify` pour **chaque** handshake ET **upgrade de transport** → couvre le transport **WebSocket** (l'option `cors` seule ne porte que le long-polling). Égalité exacte ; `Origin` absent → **refus en production**, toléré en dev/test. Lecture de l'en-tête par les types installés (Host/Referer **jamais** consultés).
  - `cors` (`origin` = delegate function, package `cors@2.8.6`) — long-polling : réfléchit l'`Origin` exacte autorisée (`Access-Control-Allow-Origin`), `false` → aucun en-tête + refus (`403` via `FORBIDDEN`) par `verify` si l'origine n'est pas dans l'allowlist.
- **`Origin` absent** : refus en production, toléré en dev/test — comportement **explicitement documenté** (test E2E §4 le prouve en `NODE_ENV=test` ; la garde production est couverte en unitaire `events.gateway.spec.ts`).
- **Aucun hardcoding** dans le Gateway : la valeur est **totalement** lue depuis `process.env.CORS_ORIGIN` à chaque requête (test E2E §5 : changer l'env entre deux connexions inverse le comportement sans redémarrage).

## 9. Changements frontend (Étape 9)

- **Vérifié** : `web/src/hooks/use-socket.ts` envoyait déjà `auth: { token }` (token du localStorage `heyama_token`) — aucun changement de format.
- **Ajustement minimal** (`use-socket.ts`) : l'effet se reconduit sur l'IDENTITÉ du user — **dépendance primitive stable** (`user?._id ?? null`) et non l'objet `user` complet (une référence reconstruite à contenu identique ne doit PAS couper le socket) —
  - `user` absent (non connecté, **ou après logout**) → **pas de socket** ; le cleanup de l'effet (`disconnect()`) **déconnecte** la connexion existante au logout ;
  - `user` présent (après login/register) → **nouvelle connexion authentifiée** avec le token courant ;
  - re-login du **même** user (référence `user` reconstruite) → dépendance inchangée, **pas de re-création de socket** ; re-login d'un **autre** user (`_id` différent) → reconnexion ;
  - le token n'est **jamais journalisé** ; pas de refresh, pas de changement du stockage du token, pas de refactor du provider, les consommateurs (`use-objects.ts`, `use-products.ts`, `use-sections.ts`) gèrent déjà `socket === null` et se ré-abonnent au changement d'instance (dépendance `[socket]`).
- Lint + build web : verts.

## 10. Dépendances

- `socket.io-client@4.8.3` — **dépendance dev exacte** de `api` (n'était que dépendance de `web` ; pas de `^` — verrouillé version par version). Majeure identique au serveur (`socket.io@4.8.3`), aucune déduplication ni nouveau binaire.
- **`pnpm why socket.io-client` (avant/après)** : `socket.io-client@4.8.3 └─ api@0.0.1 (devDependencies) └─ web@0.1.0 (dependencies)` — **1 seule version** dans l'arborescence, partagée api/web.
- **`pnpm-lock.yaml`** : +3 lignes (specifier `4.8.3` + version `4.8.3(supports-color@8.1.1)` pour l'importer `api`). Aucune autre entrée du lockfile modifiée.

## 11. Tests unitaires (écriture d'abord)

Cycle RED/GREEN démontré : les specs sont écrites AVANT le code, les échecs observés à chaque itération (voir historique des erreurs §13), puis GREEN. **Aucun skip / todo / only.** Fichiers :

| Spec | Coverage |
|------|----------|
| `api/src/events/origin.helpers.spec.ts` (N) | ~40 tests — parser : URL exactes http/https, virgules, espaces, slash final, refus (chemin/query/fragment/userinfo/wildcard/`*.vercel.app`/`ws:`/`ftp:`/imparsable/sans hôte), doublons retirés, vide/undefined/null → throw en prod / fallback `LOCAL_DEV_ORIGINS` en dev-test ; allowlist : égalité exacte, refus sous-domaine/suffixe/http≠https/port, `corsDelegate` |
| `api/src/events/socket-auth.middleware.spec.ts` (N) | 28 tests — source unique du token (absent/''/non-string via `it.each`) ; refus expiré / signature invalide / autre secret / payload incomplet ×4 / `sub` non-string ×3 / user supprimé (findById appelé avec l'ID, non exposé dans le log) ; acceptation + principal `socket.data.user = {sub,email,role}` (pas de `password`/`token`/`_id`) ; `next()` exactement une fois (y compris throw) ; `password` du document jamais exposé ; **timer de déconnexion à `exp` avec fake timers (10 tests)** : déclenchement `disconnect(true)` exactement à `exp` (jamais avant) ; `unref()` vérifié (handle `hasRef() === false`) ; `exp` absent/string/null/NaN/Infinity → aucun timer (via `it.each`) ; `exp` dépassée → délai 0, déclenchement immédiat ; cleanup `clearTimeout` sur `disconnect` client (pas de fuite ni de double appel) ; délai calculé depuis `exp` du payload vérifié |
| `api/src/events/events.gateway.spec.ts` (M) | 8 tests — métadonnées du décorateur (`cors.origin` = function ≠ `*` ; `allowRequest` = function) ; relecture `CORS_ORIGIN` à la volée ; `afterInit` installe le middleware 1× ; dev pas de throw sans `CORS_ORIGIN` ; production : throw si `CORS_ORIGIN` absente OU wildcard |

**Résultat** : `jest` → **155/155 tests, 13 suites, 0 échec** (avant corrections : 145 — +10 tests du timer ; aucun test ne régressait).

## 12. Tests E2E Socket.IO (`api/test/socket.e2e-spec.ts`, N — 17 tests)

Infrastructure : MongoDB éphémère (`MongoMemoryReplSet`, infra 0B.2 réutilisée — binaire pinné `8.2.6`, base `inventory_saas_e2e`, garde `validatedEphemeralUri`), `AppModule` complet, applicatif **port éphémère**, **vrai `socket.io-client`** avec `transports: ['websocket']` (le contrôle d'origine est vérifié **sur le transport WebSocket**, pas seulement le long-polling), `extraHeaders: { origin }` (mécanisme du `ws` : header d'upgrade), fixtures users + tokens forgés avec le MÊME `JwtService` (expiré `expiresIn: -10`, falsifié `{ secret: WRONG }`, **court `expiresIn: 6` signé juste avant le test §7**). **Aucun skip / todo / only.**

| # | Scénario (WebSocket réel) | Résultat |
|---|---------------------------|----------|
| 0 | Socket.IO attaché au même HTTP serveur ; 0 socket au boot ; tokens valides | ✓ |
| 1.1 | Sans token | `connect_error 'unauthorized'`, aucun socket de namespace |
| 1.2 | Falsifié (autre secret) | `connect_error 'unauthorized'`, aucun socket |
| 1.3 | Expiré (`exp` dépassé, secret correct) | `connect_error 'unauthorized'`, aucun socket |
| 1.4 | User supprimé (deleteOne de la base éphémère, JWT valide) | `connect_error 'unauthorized'', aucun socket |
| 2.1/2.2 | Seller **et** admin valides (origine autorisée) | `connect`, exactement +1 socket puis retour à 0 |
| 3.1 | Origine non autorisée + **JWT valide** | **Refused au niveau transport** (`allowRequest`) — pas de `connect_error 'unauthorized'` (preuve qu'il s'agit d'un refus d'origine, pas du middleware JWT), aucun socket |
| 3.2 | Origine autorisée + JWT valide | `connect` (couplage origine + auth) |
| 4 | `Origin` **absent** (comportement dev/test **explicitement documenté** : toléré en `NODE_ENV=test`, refus en prod — unitaires) | `connect` (comportement dev) |
| 5 | `CORS_ORIGIN` changée entre deux requêtes | L'ancienne origine est refusée, la nouvelle acceptée (relecture à la volée) |
| 6.1/6.2 | Long-polling (`Get /socket.io`) | `Access-Control-Allow-Origin` réfléchi (200) si autorisée ; **absent** + 403 si non autorisée |
| 7.1 | Token **court** (`expiresIn: 6`, signé juste avant) | `connect` (+1 socket) puis **déconnexion FORCÉE par le serveur à `exp`** (timer du middleware, reason client `io server disconnect`), compteur de retour à la base |

**RED démontré** : avec le gateway **original** de `4ec19c6` (`origin: '*'`, sans auth), la même suite échoue sur tout ce qui doit être refusé — 1.1–1.4 (les clients **se connectent**), 3.1, 5.1, 6.1/6.2 (`*` et 200) — 8 échecs sur 16 ; les connexions valides passent. GREEN : 17/17 avec le gateway durci — exécuté ci-dessous **une seule fois sur la validation finale** (32/32 ×2 lors du cycle initial 0B.3, y compris 2 passes consécutives).

**Nettoyage** : tous les clients `disconnect()` + `removeAllListeners`, `app.close()` (connexion Mongoose + serveur Socket.IO), `stopEphemeralMongoSafe()` (mongod stop + doCleanup + force) — même après échec (try/catch dans `beforeAll`/`afterAll`).

## 13. Résultats des commandes exécutées (validation finale — 6 corrections)

| Commande | Résultat |
|----------|----------|
| `pnpm --filter api test` | **155/155 OK** (13 suites, ~18 s) |
| `pnpm --filter api test:e2e` | **33/33 OK** — **une seule exécution** (`socket.e2e-spec` **17** dont §7.1 déconnexion à exp + `app.e2e-spec` 16, ~23 s) |
| `pnpm --filter api lint` | **0 errors** ; 2 warnings **déjà présents** non touchés (`app.e2e-spec.ts:261`, `ephemeral-mongodb.ts:67`) ; 0 warning issu des fichiers 0B.3 |
| `pnpm --filter api build` | **OK** (`nest build`, exit 0) |
| `pnpm --filter web lint` | **OK** (0 warning) |
| `pnpm --filter web build` | **OK** (Next.js 16.2.12 Turbopack, 10 routes, exit 0) |
| `git diff --check` | exit 0 (uniquement les warnings CRLF d'avertissement) |
| `git diff --name-status` | **8 M + 6 A** (A = intent-to-add `git add -N`, pas un commit) = **14 fichiers** |
| `git diff --stat` | 2358 insertions(+) / 14 deletions(−) sur 14 fichiers |
| `tasklist /fi "imagename eq mongod.exe"` | 0 processus mongod résiduel |
| Secrets dans le diff | **Aucun** : seules les constantes de test statiques (`…-not-production`, `e2e-local`) ; `JWT_SECRET`/`CORS_ORIGIN` ne contiennent aucun secret réel |

> Historique (cycles précédents) : avant les corrections — `pnpm --filter api test` 145/145 (13 suites) ; `pnpm --filter api test:e2e` 32/32 ×2 ; lint 0 errors (2 warnings pré-existants) ; builds OK.

## 14. Fichiers modifiés / ajoutés — **6 nouveaux + 8 modifiés = 14 au total**

Les fichiers nouveaux sont rendus visibles dans `git diff` via `git add -N` (intent-to-add — **pas un commit**).

**Nouveaux (6) :**
| Fichier | Contenu |
|---------|---------|
| `api/src/events/origin.helpers.ts` (N) | `parseCORSOrigin`, `buildOriginAllowlist`, `OriginConfigError`, `LOCAL_DEV_ORIGINS`, `OriginEnvironment` |
| `api/src/events/origin.helpers.spec.ts` (N) | ~40 tests du parser/allowlist |
| `api/src/events/socket-auth.middleware.ts` (N) | `installSocketAuthMiddleware` (middleware `io.use`) + `scheduleSocketDisconnectAtExpiry` (timer `unref()` à `exp`) + `createAllowRequest` (factory engine.io) + types `SocketPrincipal`/`SocketMiddlewareNext` |
| `api/src/events/socket-auth.middleware.spec.ts` (N) | 28 tests : middleware + **timer de déconnexion à `exp` (fake timers)** |
| `api/test/socket.e2e-spec.ts` (N) | 17 tests E2E (WebSocket réels, infra 0B.2) dont **§7 déconnexion après expiration** |
| `docs/security/phase-0b3-websocket-auth.md` (N) | ce rapport |

**Modifiés (8) :**
| Fichier | Changement |
|---------|-----------|
| `api/src/auth/auth.module.ts` | **`exports: [AuthService, JwtModule]`** (classe) — l'instance `JwtModule.registerAsync(…)` reste dans `imports` ; **pas** d'objet dynamique `JWT_MODULE` réexporté — même `JwtService`/secret que l'auth HTTP |
| `api/src/events/events.gateway.ts` | options du décorateur (`cors.origin` delegate + `allowRequest` fonction, lues à la volée), constructeur `JwtService`/`UsersService`, `afterInit` (garde production `CORS_ORIGIN` + installation du middleware), docblock (diffusion globale + **déconnexion à `exp` — timer**) |
| `api/src/events/events.module.ts` | `imports: [AuthModule, UsersModule]` (accès au middleware) |
| `api/src/events/events.gateway.spec.ts` | 8 tests : options du décorateur + `afterInit` + garde production |
| `web/src/hooks/use-socket.ts` | **dépendance primitive stable** (`user?._id ?? null`) ; connect sur login / disconnect sur logout |
| `.env.prod.example` | section `CORS_ORIGIN` |
| `api/package.json` | `socket.io-client: 4.8.3` (dev exact) |
| `pnpm-lock.yaml` | +3 |

## 15. Risques résiduels

1. **Durée de vie du socket vs expiration du JWT (Étape 8 — RÉGLÉ)** : les tokens web durent **7 jours** (`JwtModule`, `signOptions.expiresIn: '7d'`). La vérification a lieu **uniquement au handshake** (comportement standard de Socket.IO) ; **le socket ne survit PAS à l'expiration du token** : `scheduleSocketDisconnectAtExpiry` programme `socket.disconnect(true)` à `exp` (champ standard du payload vérifié, secondes epoch) — timer `unref()` (ne maintient pas le process/le run Jest), nettoyé via `clearTimeout` sur `disconnect` client (pas de fuite, pas de double appel). `exp` absent/invalid → aucun timer, aucun crash. Couvert par 10 tests unitaires (fake timers : déclenchement exact à `exp`, `unref` vérifié, `it.each` sur les `exp` invalides, cleanup) + E2E §7.1 (token `expiresIn: 6`, déconnexion forcée serveur, reason client `io server disconnect`, compteur de retour à la base). Le re-login reste le seul chemin de connexion à nouveau (pas de re-vérification périodique, pas de refresh — hors périmètre).
2. **`Origin` absent toléré en dev/test** (par conception : clients Node sans en-tête navigateur). En production ce cas est refusé + `CORS_ORIGIN` obligatoire au démarrage — couvert unitaire, non exécutable E2E (l'app tournerait en `NODE_ENV=production` et rejetterait le boot sans `CORS_ORIGIN` valide — le spec E2E tourne volontairement en `test`).
3. **`fetch`/undici ne peuvent pas forcer un header `Origin` testable** (fetch spec : header interdit) — la réflexion long-polling est testée via `node:http` avec header explicite ; un navigateur réel impose son propre `Origin` (le cas de production réel). Aucune incidence sur la sécurité côté serveur.
4. **Profondeur du refus d'origine sur WebSocket** : le refus est **au transport** (400 brut + `socket.destroy()` selon engine.io) — le client ne reçoit ni `connect_error 'unauthorized'` ni le reason ; c'est le comportement voulu (pas de révélation) mais les journaux côté serveur n'identifient pas la cause (pas de log d'origine rejetée, volontaire — aucune fuite des en-têtes).
5. **E2E = comportement d'isolation** : la suite E2E Socket.IO partage un mongod éphémère avec `app.e2e-spec.ts` (maxWorkers=1, suite séquentielle) ; les fixtures sont isolées par e-mails `*-socket-e2e@royalvibe.test` ; aprèsEach/afterAll nettoient (clients → app → mongod).
6. **Lint `--fix` (pré-existant)** : le script `pnpm --filter api lint` contient `--fix` (choix pré-existant du projet, déjà tracé au rapport 0B.1). Aucun fichier 0B.3 n'a été modifié par le pass `--fix` (vérifié par `git status` avant/après).

## 16. Diffusion globale encore présente (multi-tenant insuffisant)

L'émission des événements métier (`object:created` / `object:deleted`) reste **globale** : `this.server.emit(...)` diffuse à **TOUS** les utilisateurs authentifiés connectés à l'unique entreprise actuelle. Après cette phase, seuls les utilisateurs **authentifiés** reçoivent les événements (gain de sécurité immédiat : fin de la lecture anonyme), mais il n'y a **aucune room par organisation** — ce qui devient insuffisant dès la 2ᵉ organisation (le vendeur A verrait les événements de l'entreprise B). **Report explicite (non fait, non périmètre 0B.3)** : rooms `organization:${organizationId}` + `socket.data.user` enrichi d'un `organizationId` + `socket.join` au handshake à la phase multi-tenant. Aucun événement métier modifié ; aucun `@SubscribeMessage` modifié.

## 17. Configuration requise avant déploiement

- **`CORS_ORIGIN` (obligatoire en production)** : lista comma-separated d'origines exactes du frontend, ex. `CORS_ORIGIN=https://royalvibe-cosmetic.vercel.app` (voir `.env.prod.example` mis à jour — section dédiée, **sans secret**, valeur d'exemple commentée « à adapter avant déploiement »). En production, l'application **refuse de démarrer** si `CORS_ORIGIN` est absente/invalidée (wildcard, chemin, `ws:`,…) ; en dev/test le fallback `LOCAL_DEV_ORIGINS` (localhost:3000 / 127.0.0.1:3000) s'applique.
- `JWT_SECRET` : inchangé (déjà en production), le handshake Socket.IO le réutilise.
- `NODE_ENV=production` : actif, la garde + le refus d'`Origin` absent s'appliquent.

## 18. Suivi

- Aucun commit ; branch `security/phase-0b3-websocket-auth` ; rien de poussé.
- `git diff` : 14 fichiers (8 `M` + 6 `A` intent-to-add) — voir §13/§14.

## 19. Proposition pour la phase 0B.4

1. **CORS HTTP global strict** (rapport 0B.1 E-1) : réutiliser `origin.helpers.ts` (`parseCORSOrigin` + `allowRequest`-style) dans `main.ts` (`app.enableCors({ origin: … })`) — la helper est déjà conçue pour ; 1 fichier `main.ts` + 1 spec + E2E sur HTTP.
2. **Re-vérification périodique du JWT socket (évolution, optionnel)** : le timer de déconnexion à `exp` est **déjà implémenté** (correction 0B.3 — §15.1) ; seule une re-vérification *périodique* (avant `exp`, ex. au refresh token) reste un sujet de phase suivante.
3. **Rate limiting `/auth/*`** (report 0B.1) : sans dépendance supplémentaire possible (middleware NestJS) ou `express-rate-limit`.
4. **Rooms multi-tenant** (report §16) : `organization:${organizationId}` + `join` au handshake + `socket.data.organizationId` — à engager **après** la phase d'organisation/multi-tenant (hors périmètre immédiat).

**Ordre recommandé** : 1 (réutilisation immédiate de la helper) → 2 (décision) → 3.

---

*Rapport généré à la fin de l'étape 15 de la phase 0B.3, mis à jour après les 6 corrections ciblées (0B.3 : export `AuthModule`, timer de déconnexion à `exp` implémenté, dépendance primitive `use-socket`, comptes de fichiers, `git add -N`). Aucun commit n'est créé : le diff complet et ce rapport sont présentés pour validation — la décision §15.1 est **réglée** (timer de déconnexion à expiration implémenté et testé).*
