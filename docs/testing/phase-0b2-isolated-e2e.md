# Phase 0B.2 — Infrastructure E2E MongoDB totalement isolée

- **Date** : 2026-08-01
- **Branche** : `test/phase-0b2-isolated-e2e` (créée depuis `fa28341` — phase 0B.1 commitée ; `dev` non modifié)
- **Périmètre** : infrastructure de test uniquement. **Aucune vulnérabilité corrigée, aucun code de production modifié** (périmètre interdit respecté : ni contrôleurs, ni services, ni schémas, ni CORS, ni inscription, ni WebSockets, ni rôles, ni frontend, ni S3, ni abonnements, ni multi-tenant).
- **Statut** : commitée — la phase a été commitée après validation complète de l'infrastructure et des tests.

---

## 1. Dépendance et version installée

| Élément | Valeur |
|---|---|
| Dépendance | `mongodb-memory-server` (unique — aucune autre ajoutée) |
| Version (librairie npm) | **`11.2.0` — pin exact** en `devDependencies` de `api/package.json` (sans `^`), verrouillée dans le lockfile (+ `mongodb-memory-server-core@11.2.0` transitive) |
| Emplacement | `devDependencies` de `api/package.json` (workspace API uniquement) |
| Lockfile | `pnpm-lock.yaml` +261 lignes, version résolue verrouillée (vérifié : lignes 132/4160/4164/10052/10079/10081) |
| Gate pnpm builds | `pnpm-workspace.yaml` : le gate a posé le placeholder `mongodb-memory-server: set this to true or false` ; résolu en **`true`** uniquement pour cette dépendance (les autres gates inchangés : `bcrypt: false`, `sharp: true`, `unrs-resolver: true`) |
| Binaire MongoDB (test) | **MongoDB 8.2.6** (`mongod-x64-win32-8.2.6.exe`, 74,0 Mo) — **verrouillé explicitement** par la constante `E2E_MONGODB_BINARY_VERSION = '8.2.6'` dans `ephemeral-mongodb.ts`, et non laissé à la version par défaut de la lib |
| Cache du binaire | `node_modules/.cache/mongodb-memory-server/` — **ignoré par Git** (`.gitignore:2:node_modules/`, confirmé par `git check-ignore -v` ; aucun fichier `node_modules` n'est suivi ; localisé via le log debug de la lib : `Found binary in modulesCache`) |
| Téléchargement | le postinstall pnpm a téléchargé le binaire au moment de l'installation (**~53 s**), depuis la source officielle (`USE_HTTP=false` → TLS par défaut, **TLS non désactivé, certificats non contournés**) |
| Autres scripts/effets | husky `prepare` relancé (pré-existant, sans effet) ; aucun binaire système, aucune source non officielle, pas de Docker, pas d'Atlas, pas d'URI issue de `.env` |

## 2. Raison du choix de MongoMemoryReplSet

- L'application utilise **`@nestjs/mongoose`** (Mongoose 9) : un simple `MongoMemoryServer` (standalone) suffit fonctionnellement en local, mais **les tests transactionnels vente–stock–audit prévus (phase future) exigent un replica set** (transactions MongoDB impossibles en standalone). Choisir `MongoMemoryReplSet` dès maintenant **évitent une migration d'infra** plus tard.
- 1 seul membre : le coût (mémoire/taille binaire) est identique au standalone, avec le gain transactionnel.
- La lib gère de façon autonome : génération du keyfile pour le replset, ports TCP **dynamiques** (aucun conflit possible avec 27017), arrêt du processus (`SIGINT` propre), suppression du dossier de données.

## 3. Configuration du replica set

Définie dans `api/test/e2e/ephemeral-mongodb.ts` :

```ts
// Version du binaire MongoDB, pin explicite (test-only). Ne dépend ni d'un
// .env ni de la config de production.
const E2E_MONGODB_BINARY_VERSION = '8.2.6';

new MongoMemoryReplSet({
  binary: {
    version: E2E_MONGODB_BINARY_VERSION, // 8.2.6
  },
  replSet: {
    count: 1,
    dbName: 'inventory_saas_e2e',
    storageEngine: 'wiredTiger',
  },
});
```

- **1 membre**, **wiredTiger** (moteur par défaut de MongoDB 8), base **explicitement nommée `inventory_saas_e2e`** (l'`AppModule` ne passe pas de `dbName` — le nom vient du path de l'URI : `getUri(E2E_DB_NAME)`).
- **Version du binaire MongoDB = 8.2.6, verrouillée explicitement** par `binary.version` (vérifiée contre les types réels `MongoBinaryOpts extends BaseDryMongoBinaryOptions { version?: string }`). Deux versions sont donc distinctes et toutes deux verrouillées : la **librairie npm** (`mongodb-memory-server = 11.2.0`, pin exact) et le **binaire MongoDB** (`8.2.6`, pin dans le code d'infra).
- Adresse **locale uniquement** : la lib écoute sur `127.0.0.1:<port aléatoire>` (vérifié par les tests d'isolation).
- **Démarré avant `Test.createTestingModule(...).compile()`** : `replSet.start()` → `process.env.MONGODB_URI = getUri(dbName)` → compile (le factory `AppModule` lit `MONGODB_URI` via `ConfigService`, donc après la mise en place de l'URI).
- **`api/.env` jamais lu** : `@nestjs/config` ne surcharge **jamais** une clé déjà présente dans `process.env` (vérifié dans `@nestjs/config/dist/config.module.js` : `keys = Object.keys(config).filter(key => !(key in process.env))`). Les clés e2e sont fixées dans `process.env` **avant** `compile()`, donc décisives.
- **Secret JWT** : statique, réservé aux tests (`e2e-only-static-secret-not-production-use`), défini uniquement par l'infra E2E — ni `api/.env` lu, ni secret réel utilisé, ni secret journalisé (les logs ne sortent que `host:port` + base).

## 4. Mécanisme empêchant l'utilisation du port 27017

Garde `assertEphemeralUri(uri)` (`api/test/e2e/ephemeral-mongodb.ts`) — **fatale** (erreur → avantAll échoue → aucun test ne démarre) si l'URI :
1. **correspond exactement à l'URI de développement de référence** (`mongodb://localhost:27017/heyama`, issue de `.env.example`, jamais lue à l'exécution) ;
2. pointe sur le **port 27017** ;
3. porte un **hôte non local** (seuls `127.0.0.1`/`localhost`/`::1` acceptés) → refuse toute adresse distante ;
4. cible une **base autre qu'`/inventory_saas_e2e`** ;
5. contient des **identifiants** (username/password) ;
6. n'est pas parsable en `mongodb:`.

Point d'application : `validatedEphemeralUri(replSet) = assertEphemeralUri(replSet.getUri(E2E_DB_NAME))` — l'URI est **produite par l'instance éphémère** puis **validée** avant d'être injectée dans `process.env.MONGODB_URI`. En complément, les tests d'isolation (section 6) **revérifient à chaud** que la connexion Mongoose réellement ouverte ne contient aucun serveur `:27017` et que tous sont `127.0.0.1:`. Double assurance : refus statique à l'alimentation + vérification dynamique sur la connexion réelle.

## 5. Gestion du cycle de vie

**Stratégie retenue : démarrage/arrêt dans la suite** (et non `globalSetup`/`globalTeardown`). Raison documentée : `globalSetup`/`globalTeardown` s'exécutent dans un **contexte mémoire distinct** de celui des fichiers de test — une instance démarrée là ne serait pas partageable/rejoignable depuis le spec ni arrêtée de façon déterministe par celui-ci. Le singleton module (`getEphemeralMongo()`/`stopEphemeralMongoSafe()`) + `beforeAll`/`afterAll` dans un seul fichier de test contournent cette limite.

| Événement | Action |
|---|---|
| `beforeAll` (180 s) | `startEphemeralMongo()` → garde `validatedEphemeralUri` → fix des clés e2e de `process.env` → `Test.createTestingModule({imports:[AppModule]}).compile()` → reproduit les middlewares globaux de `main.ts` (`ValidationPipe` whitelist/forbidNonWhitelisted/transform + `HttpExceptionFilter` ; CORS exclu : hors périmètre et non pertinent E2E) → `app.init()` → fixtures (admin, seller) via l'API, admin élevé à `role=admin` **directement dans la base éphémère** (la logique d'inscription de production n'est pas modifiée ; le schéma pose `seller` par défaut). **Sur erreur : `stopEphemeralMongoSafe()` garanti dans le `catch`** (pas de mongod orphelin). |
| Chaque test | HTTP via `supertest` sur le serveur Nest réel (garde globale `JwtAuthGuard`+`RolesGuard`, pipes, DTOs, services, Mongoose **réels**). |
| `afterAll` (60 s) | `app.close()` (ferme NestJS et la connexion Mongoose de l'app), puis `stopEphemeralMongoSafe()` → **`replSet.stop({doCleanup:true, force:true})`** : `mongod` arrêté **et son dossier de données temporaire supprimé** (`force` garantit la suppression même hors `os.tmpdir`). Idempotent, tolérant à un mongod déjà mort — **exécuté même après un test en échec** (afterAll Jest est toujours exécuté). |

Vérifié après les runs : `tasklist /fi "imagename eq mongod.exe"` → **aucun processus résiduel**.

Exécution séquentielle : `api/package.json` `test:e2e` → `jest --config ./test/jest-e2e.json --maxWorkers=1` ; `api/test/jest-e2e.json` → `maxWorkers: 1`, `testTimeout: 300000` (timeout Jest couvre les hooks), aucun `watch`.

## 6. Tests E2E créés (16)

Remplace le « Hello World » de `api/test/app.e2e-spec.ts` (le test `/` GET n'a pas été conservé : `AppController.getHello` n'ayant pas d'annotation, il aurait renvoyé `Hello World!` — sans valeur de régression ; la santé est couverte par `/health`).

| Groupe | Tests |
|---|---|
| **1. Démarrage** | l'app NestJS démarre sur la base éphémère et répond `200` sur `/health` (le seul endpoint `@Public`) |
| **2. Authentification** | route protégée (`/analytics/overview`) **sans JWT → 401** ; une inscription de test écrit **uniquement dans la base éphémère** (réponse 201, `user.password` absent du body) ; la connexion avec les identifiants de test fonctionne et renvoie un token |
| **3. Analytics** | un **seller authentifié reçoit 403** sur `/analytics/overview` ; un **admin de test reçoit 200** (KPIs nuls : base vide) ; 403 sur **les 4 endpoints** analytics (it.each : overview, products/ranking, sellers/ranking, monthly) — **le fix 0B.1 (C-2) est revérifié de bout en bout avec les vraies gardes** |
| **4. Validation** | `DELETE /sales/not-an-object-id` (admin) → **400** + message `Invalid id` (le pipe `ParseObjectIdPipe` rejette avant le service) ; id hex-valide mais inexistant → **pas 400 ni 500** (le pipe laisse passer au service, qui répond 404 métier) ; `POST /sections` avec `name='   '` (admin) → **400** + message `must contain a non-whitespace character` (fix 0B.1 N-2 revérifié E2E) |
| **5. Isolation** | la base Mongoose est bien `inventory_saas_e2e` ; **aucun serveur connecté ne porte le port 27017** (tous `127.0.0.1:`) ; les données de test vivent dans la base éphémère (`users ≥ 3`, `products` vide) ; **aucune donnée ne persiste après l'arrêt** (dossier supprimé par `stop force` + suite reproductible, section 7) |

Note d'implémentation : `@nestjs/mongoose` crée sa **propre** connexion (`mongoose.createConnection`), pas la connexion globale `mongoose` — les fixtures et assertions d'isolation passent donc par le conteneur Nest (`getModelToken('User')`, `getConnectionToken()`). C'est ce qui a fait échouer le premier run (`MissingSchemaError` sur `mongoose.model('User')` global) avant correction.

Non effectués volontairement : tests S3 réel, WebSockets, transactions, Mobile Money, données RoyalVibe.

## 7. Résultats des deux exécutions E2E

| Exécution | Durée | Résultat |
|---|---|---|
| **1re exécution (GREEN)** | 5,303 s | **16/16 passés**, 1 suite |
| **2e exécution (reproductibilité)** | 5,083 s | **16/16 passés**, 1 suite — nouveau repliset (nouveau port), collections vides au départ (les asserts d'isolation `users ≥ 3` / `products = 0` repassent sur la base neuve, prouvant qu'**aucune donnée du 1er lancement n'est conservée**) |

**Après les runs** : `tasklist /fi "imagename eq mongod.exe"` → **0 processus mongod actif** (le 1er mongod est bien arrêté avant/pendant la 2e exécution).

*(Événement précédent, non comptabilisé : une 1re tentative e2e a échoué 13/13 sur `MissingSchemaError` — défaut de l'infrastructure de test décrite en section 6, corrigée sans toucher au périmètre ; aucun test n'a été affaibli/skip/only'd.)*

## 8. Temps du premier et du second lancement

| Étape | Durée |
|---|---|
| Téléchargement initial du binaire (postinstall pnpm, **1er jamais** de la machine) | **~54 s** (script `done in 53.8s`) |
| 1re exécution E2E (binaire déjà en cache) | **~8,5 s** (tentative infra, 0 test e2e validé — MissingSchemaError) |
| **1re exécution GREEN** | **5,3 s** |
| **2e exécution (reproductibilité)** | **5,1 s** |
| Démarrage repliset seul (sonde préalable) | **~1,7 s** |

Le premier lancement E2E réel (post-téléchargement) a donc coûté ~5 s ; le binaire est maintenant en cache → temps stables.

## 9. Fichiers créés et modifiés

**Créés (3) :**
| Fichier | Rôle |
|---|---|
| `api/test/e2e/ephemeral-mongodb.ts` | Infrastructure : `startEphemeralMongo` (1 membre, wiredTiger, base nommée), `stopEphemeralMongoSafe` (arrêt + suppression données, idempotent, safe), `validatedEphemeralUri` / `assertEphemeralUri` (garde 27017/distant/base/identifiants), `E2E_DB_NAME = 'inventory_saas_e2e'` |
| `api/test/app.e2e-spec.ts` | **Remplacé** (le Hello World inutile) : 16 tests E2E décrits en section 6 + fixes des middlewares globaux + fixtures |
| `docs/testing/phase-0b2-isolated-e2e.md` | Ce rapport |

**Modifiés (4) :**
| Fichier | Changement |
|---|---|
| `api/package.json` | `+ "mongodb-memory-server": "^11.2.0"` en `devDependencies` ; `test:e2e` → `jest --config ./test/jest-e2e.json --maxWorkers=1` |
| `api/test/jest-e2e.json` | `+ maxWorkers: 1`, `+ testTimeout: 300000` (délai premier téléchargement / hooks longs) |
| `pnpm-workspace.yaml` | `+ mongodb-memory-server: true` dans `allowBuilds` (résolution du placeholder pnpm pour cette dépendance uniquement) |
| `pnpm-lock.yaml` | +261 lignes (versions résolues/verrouillées) |

**Aucune** modification dans `api/src/**` (production), `web/**` (front), schémas, `.env`.

## 10. Résultats tests, lint et builds (étape 9)

| Commande | Résultat |
|---|---|
| `pnpm --filter api test` | **84/84 OK** (11 suites, ~6,6 s) — unitaires inchangées |
| `pnpm --filter api test:e2e` (×2) | **16/16 OK** (voir section 7) |
| `pnpm --filter api lint` | **exit 0** (0 errors ; 2 warnings restants dans les fichiers de test : types third-party, voir section 11) |
| `pnpm --filter api build` | **OK** (`nest build`) |
| `pnpm --filter web lint` | **exit 0** (front non modifié) |
| `pnpm --filter web build` | **OK** (Next 16.2.12 Turbopack, 10 routes) |
| `git diff --check` | **exit 0** (uniquement warnings CRLF pré-existants du repo Windows) |
| `git status --short` | 5 `M` (package.json, spec, jest-e2e.json, lockfile, workspace) + `?? api/test/e2e/` (1 fichier) |
| `git diff --stat` | +531/−17 sur 5 fichiers (lockfile dominant : +261) |
| `git diff` | revu en entier (config : package/jest/workspace ci-dessus ; spec : 279 lignes ; infra : nouvelle) |
| processus mongod après tests | **0** (vérifié par `tasklist`) |

## 11. Limites actuelles

1. **Couverture e2e encore pointue** : l'API démarre et les flux auth/analytics/validation sont couverts, mais **aucun test end-to-end de CRUD complet** (sections→produits→vente→stock→audit) ni du module trash ni d'`objects`/S3. La suite e2e reste 1 seul fichier séquentiel.
2. **2 warnings lint non bloquants** (exit 0) dans `api/test/` : `@typescript-eslint/no-unsafe-argument` sur (a) la `topology.description.servers` du client Mongoose et (b) le type `MongoMemoryReplSetOpts` résolu en `error-typed` par l'import des types `mongodb-memory-server`. Ils proviennent des **déclarations de types tierces** (la lib 11.x publie des types partiels sur Windows) ; les éliminer exigeant soit un cast trompeur, soit une dépendance de typage externe — hors périmètre (aucune nouvelle dépo). Ils ne sont pas dans `src/`.
3. **Aucun test transactionnel encore** : l'infra (`MongoMemoryReplSet`) le **permet dès maintenant** (base nommée + replset), mais la couverture transactionnelle vente–stock–audit attend la phase dédiée (la phase interdit de commencer de nouveaux périmètres).
4. **Binaire 8.2.6 verrouillé explicitement** (résolu en finalisation 0B.2) : la version du binaire MongoDB est désormais fixée par `E2E_MONGODB_BINARY_VERSION = '8.2.6'` (clé `binary.version`) et la librairie npm par le pin exact `11.2.0`. Le binaire est en local (`node_modules/.cache/mongodb-memory-server/`, ignoré par Git) — un `pnpm install` propre re-téléchargera le binaire 8.2.6 au premier postinstall (source officielle). Il reste un point de re-téléchargement réseau au premier `install` sur une machine neuve (voir Risque 1).
5. **Le `dbPath` du replset est un dossier temporaire auto-géré** ; la lib le supprime à l'arrêt (`force`), mais si le process Jest est tué brutalement (`SIGKILL`) le dossier temporaire peut subsister (pas de `finally` exécutable). Acceptable en pratique (l'OS nettoie `AppData/Local/Temp`).

## 12. Risques résiduels

1. **Diversité d'exécution** : la suite e2e passe sur la machine de dev. En CI (ou un autre OS), le binaire MongoDB doit être **re-téléchargé** au premier `pnpm install` (postinstall) ou mis en cache du pipeline ; si le CI bloque l'accès réseau, l'installation postinstall échouerait. **Mitigation** : documenter le cache du binaire CI ou fournir `MONGOMS_DOWNLOAD_MIRROR`.
2. **Aucune donnée E2E n'a encore validé le flux transactionnel** : le vrai risque des transactions vente–stock–audit (rollback partiel) n'est pas encore démontré vert/rouge.
3. **Le test `id valide mais inexistant → pas 400/500`** ne vérifie pas **le code exact** (404/404-business) — volontairement large pour ne pas coupler le test au code métier exact (le périmètre interdit n'autorise pas de modification de la logique de réponse). L'assertion `≠400 et ≠500` garantit que **le pipe laisse passer** (c'est l'essentiel : pas de court-circuit 400/500).
4. **Pinning des deux versions (résolu)** : la librairie npm est pinnée en exact (`11.2.0`, sans `^`) et le binaire MongoDB est pinné dans le code (`E2E_MONGODB_BINARY_VERSION = '8.2.6'`). Plus de dérive « version par défaut de la lib ». Le lockfile reste le verrou principal — à garder versionné.
5. **Aucun secret dans le repo** : le JWT e2e est statique mais **réservé aux tests** et non production ; il ne doit pas être copié hors du spec. (Risque faible mais à rappeler.)

## 13. Proposition de phase 0B.3 (suivante)

Propositions (à valider par l'utilisateur avant toute exécution ; aucune n'a démarré) :

1. **CORS (E-1)** : remplacer `origin: true` par une liste d'origines configurables (env), **+ test e2e** (réflexion des headers `Access-Control-Allow-Origin`) — directement testable avec cette infra e2e (plus besoin de front réel).
2. **Flux CRUD complet e2e** : sections → produits → vente (decrementStock) → audit (SOLD) → analytics, sur la base éphémère, couvrant le **cycle de vie réel** et préparant les tests transactionnels.
3. **Tests transactionnels vente–stock–audit** : le replset le permet désormais. Préparer un test qui force l'échec en milieu de transaction et **assert le rollback** (aucune donnée orpheline) — c'est le gain principal de `MongoMemoryReplSet`.
4. **Policy d'enregistrement / C-3** : (décision humaine requise) soit l'inscription publique restée `SELLER` par défaut + premier admin par script CLI versionné, soit l'inscription fermée par défaut + invitation. Couplable à cette infra e2e pour tester la politique.
5. **Cache CI du binaire MongoDB** : documenter/mettre en place le cache du binaire 8.2.6 pour la CI (le pin local `E2E_MONGODB_BINARY_VERSION` est déjà posé) afin d'éviter le re-téléchargement à chaque pipeline. Hors périmètre local de cette phase.

**Ordre suggéré** : 1 (CORS, petit) → 2 (CRUD e2e, solide) → 3 (transactions, valeur forte) → 4 (C-3, nécessite décision).

---

*Rapport rédigé à l'étape 10. **La phase a été commitée après validation complète de l'infrastructure et des tests** : le commit porte les 7 fichiers de la phase (5 modifiés, 2 créés). **Aucune donnée secrète ni fichier généré n'est commité.** **Aucune phase suivante n'a démarré.** Rien n'a été poussé.*
