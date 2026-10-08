# Phase 1-12F — Dépendances vulnérables du runtime API

Branche `architecture/phase-1-12f-api-runtime-dependency-security`, base `a9746e4` (1-12E). Aucun commit, aucun push, aucun déploiement, aucune publication d'image. **Aucun accès à Atlas, Supabase ni au port hôte 27017 ; aucune donnée réelle** : tests sur `MongoMemoryReplSet` éphémère, démarrage Docker sur un `mongo:7` jetable (replica set mono-nœud) dans un réseau Docker `--internal`, sans port publié. Stash existant non touché.

## Décisions

| Sujet | Décision |
| --- | --- |
| engine.io | 6.6.9 → **6.6.11** (résolution transitive, plage `~6.6.0` de `socket.io@4.8.3`) |
| qs | 6.15.3 → **6.16.0** (résolution transitive, plages `^6.14.0` / `^6.15.2` / `^6.14.1`) |
| Méthode | `pnpm update -r --depth Infinity engine.io qs` : **lockfile seul**, aucun manifeste, aucun override, aucun ajout direct |
| Politique pnpm | Âge minimal de publication conservé (« Lockfile passes supply-chain policies ») ; `pnpm-workspace.yaml` inchangé |
| Dockerfiles, web, Socket.IO | Inchangés (transports, `allowRequest`, service worker, Multer, Sharp) |

## 1. Avis officiels (revalidés le 30/09/2026, API GitHub Advisories)

| Avis | Paquet | Sévérité | Publié | Vulnérable | Corrigé |
| --- | --- | --- | --- | --- | --- |
| GHSA-2gc4-cqfq-p2gv — Engine.IO Protocol Revision Mismatch DoS | engine.io | high (7.5) | 29/09/2026 | ≥ 6.6.0 < 6.6.10 | 6.6.10 |
| GHSA-4mjr-xmp4-gh2g — DoS via `isBuffer` contrôlé | qs | moderate (5.3) | 02/09/2026 | ≥ 2.2.5 < 6.16.0 | 6.16.0 |
| GHSA-x5fp-wj9c-mxmx — contournement `arrayLimit` (`a[]` + `comma`) | qs | moderate (3.7) | 02/09/2026 | ≥ 6.14.2 ≤ 6.15.3 | 6.16.0 |

Versions registre : engine.io 6.6.10 (03/09), 6.6.11 (24/09, `latest`) ; qs 6.16.0 (29/08, `latest`).

## 2. Graphe avant / après

`pnpm why` (une seule copie de chaque paquet dans tout le workspace) :

```
engine.io  ← socket.io@4.8.3 (~6.6.0) ← @nestjs/platform-socket.io@11.1.28 ← api
qs         ← express@5.2.1 (^6.14.0)          ← @nestjs/platform-express ← api
           ← body-parser@2.3.0 (^6.15.2)      ← express
           ← superagent@10.3.0 (^6.14.1)      ← supertest (dev API)
           ← express ← @modelcontextprotocol/sdk ← shadcn (web, CLI hors image)
```

Résolution Node **depuis les consommateurs** (`createRequire` en chaîne, pas depuis la racine), en local et dans l'image :

| Consommateur | Avant | Après |
| --- | --- | --- |
| `socket.io` → `engine.io` | 6.6.9 | **6.6.11** |
| `express` → `qs` | 6.15.3 | **6.16.0** |
| `body-parser` → `qs` | 6.15.3 | **6.16.0** |

Diff du lockfile : 2 entrées `packages`, 5 références `snapshots`, et `base64id` retiré des dépendances d'engine.io (le paquet reste, `socket.io` en dépend directement). Intégrités générées par pnpm.

**Pourquoi 6.6.11 et non 6.6.10** : `pnpm update` retient la dernière version de la plage du parent. Obtenir 6.6.10 exigerait un override, que le périmètre réserve au cas d'un parent imposant une version vulnérable, ce qui n'est pas le cas. 6.6.11 est un patch de la même plage : correctif de l'avis (6.6.10) + « refresh ping timeout on incoming packets ». Dépendances identiques à 6.6.10.

## 3. Exploitabilité observée

### Engine.IO — exploitable avant correctif

- `EventsGateway` garde les transports par défaut (polling + websocket, upgrades autorisés) ; le client web n'utilise que `websocket`, mais le serveur accepte le polling.
- `allowRequest` ne vérifie que l'en-tête `Origin` (égalité exacte), **falsifiable par un client non navigateur** ; en dev/test, l'absence d'`Origin` est tolérée.
- Le JWT n'est vérifié qu'à la connexion du namespace Socket.IO, **après** le handshake et l'upgrade Engine.IO. L'authentification ne protège donc pas le handshake.
- Démontré sur la base `a9746e4` : un client **sans token** ouvre une session v4 puis obtient **101** sur un upgrade `EIO=3` ou sans `EIO`. Le heartbeat forgé provoquant le crash n'a pas été envoyé.

### qs — non atteignable dans Stock Master

- **body-parser** (`urlencoded` étendu, activé par l'adaptateur Nest) : `qs.parse(body, { allowPrototypes: true, arrayLimit, depth, parameterLimit, strictDepth: true, … })`, **sans `comma`**.
- **Express 5** : query parser `simple` par défaut (module `querystring`), jamais redéfini dans l'API ; `qs` n'y sert qu'avec le parser `extended`.
- **Aucun appel à `qs.stringify`** dans l'image runtime (seuls `express` et `body-parser` requièrent `qs`) ; aucun import de `qs` dans `api/src` ni `api/test`.
- Aucun des deux scénarios (round-trip `parse → stringify`, `comma: true`) n'est donc atteignable. Correctif appliqué et testé de façon isolée sur la copie réellement chargée.

## 4. Tests ajoutés

### `api/test/socket.e2e-spec.ts` — § 9 (réutilise l'application, la base éphémère et les fixtures existantes)

| Test | Vérifie |
| --- | --- |
| 9.1 | Contrôle : session v4 (polling, sans token) + upgrade `EIO=4` → **101** |
| 9.2 ×2 | Upgrade `EIO=3` puis `EIO` absent sur session v4 → **400**, aucun crash |
| 9.3 | Après les refus : `/health` 200 ; connexion légitime `polling → websocket` (JWT valide), transport final `websocket` |
| 9.4 | Reconnexion comme le client web : ancien token (expiré) refusé `unauthorized`, token courant accepté |

Requêtes brutes `node:http` (aucune dépendance), délais bornés à 4 s, sockets détruits. Aucun heartbeat forgé : pas de risque pour le processus de test.

### `api/src/common/runtime-dependency-advisories.spec.ts` (unitaire)

- Gardes de version : `engine.io` chargé par `socket.io` ≥ 6.6.10 ; `qs` chargé par `express` et par `body-parser` ≥ 6.16.0.
- Charges des avis sur la copie de `body-parser` :
  - `qs.parse('a[constructor][isBuffer]=x&b=1', { allowPrototypes: true })` puis `stringify` → ne lève pas ;
  - `a[]=1,2,3,4` avec `{ comma: true, arrayLimit: 3, throwOnLimitExceeded: true }` → `RangeError` (témoin `a=1,2,3,4` idem, `a[]=1,2` accepté).

### Preuve que les tests détectent la vulnérabilité

Worktree temporaire sur `a9746e4` + nouveaux tests, `pnpm install --frozen-lockfile` :
- unitaire : **5/5 en échec** (versions ; `TypeError` au `stringify` ; pas de `RangeError`) ;
- e2e § 9 : **2 échecs**, `Expected 400 / Received 101` pour `EIO=3` et `EIO` absent.

Même worktree neuf avec le nouveau lockfile : installation `--frozen-lockfile` propre, politiques supply-chain OK, **5/5** unitaires et **5/5** e2e § 9. Worktrees retirés ensuite.

## 5. Non-régression Socket.IO et HTTP

Couverte par les suites existantes, toutes vertes :
- JWT valide → `connect` ; absent, falsifié, expiré, user supprimé → `unauthorized` (§ 1–2) ;
- origines (`allowRequest`, CORS long-polling) (§ 3–6) ;
- déconnexion serveur à l'expiration du JWT (§ 7) ;
- isolation des événements entre organisations, membership ou organisation suspendue (§ 8) ;
- reconnexion avec le token courant et transports polling/websocket (§ 9.3–9.4) ;
- validation HTTP et uploads protégés par `SafeFileInterceptor` (suites `organization-branding`, `app`, etc.).

## 6. Validation Docker réelle

`docker build --no-cache --platform=linux/amd64 -f api/Dockerfile -t heyama-api:1-12f .` : OK, Dockerfiles et `.dockerignore` **inchangés** depuis `a9746e4`.

| Contrôle | Résultat |
| --- | --- |
| Résolution depuis les consommateurs | `socket.io → engine.io 6.6.11`, `express → qs 6.16.0`, `body-parser → qs 6.16.0` |
| Copies dans le runtime | Une seule copie : `engine.io@6.6.11`, `qs@6.16.0` ; aucune version affectée |
| Écart avec l'image 1-12E | Exactement 2 paquets sur 200 : `engine.io 6.6.9 → 6.6.11`, `qs 6.15.3 → 6.16.0` |
| Dépendances de développement | 0 (jest, eslint, typescript, @nestjs/cli, @nestjs/testing, supertest, superagent, socket.io-client, mongodb-memory-server absents) |
| Utilisateur / Node / libc | `node` (1000), v22.17.1, musl |
| Sharp | 0.35.5, libvips 8.18.7, encodage WebP OK |
| Migration | `dist/migrations/create-sale-operations-index.js` présente ; exécutée sur la base éphémère : « index idempotent créé et vérifié » |

**Démarrage réel** (réseau `--internal`, `mongo:7 --replSet rs0` jetable, secret JWT aléatoire, S3 factice, `PUBLIC_REGISTRATION_ENABLED=true` uniquement pour créer l'utilisateur de la sonde) :

| Sonde | Résultat |
| --- | --- |
| Healthcheck Docker | `healthy` |
| `GET /health` | 200 |
| `POST /auth/register`, `POST /auth/login` (base éphémère) | 201, 201 |
| Connexion Socket.IO (long-polling, paquet `40` + auth) sans token / token invalide | `unauthorized` |
| Connexion Socket.IO avec JWT valide | connectée |
| Upgrade `EIO=4` (contrôle) | 101 |
| Upgrade `EIO=3` sur session v4 / `EIO` absent | **400 / 400** |
| Après les refus : `/health`, connexion Socket.IO JWT | 200, connectée |
| État du conteneur | `running`, 0 redémarrage, aucune erreur dans les journaux |

Un premier essai sur un `mongo:7` **autonome** renvoyait 500 à l'inscription : l'inscription utilise une transaction, qui exige un replica set (comme en dev et en e2e). Cela ne relève pas de l'image.

Image web non reconstruite : le graphe `web/` du lockfile ne change que via la CLI `shadcn`, absente de l'image standalone (1-12E : aucun `qs` dans l'image web).

## 7. Validation du dépôt

| Commande | Résultat |
| --- | --- |
| `pnpm --filter api test` | **49 suites, 792/792** (787 + 5 nouveaux) |
| `pnpm --filter api test:e2e` | **12 suites, 294/294** (289 + 5 nouveaux) |
| `pnpm --filter api exec eslint "{src,apps,libs,test}/**/*.ts"` | 0 erreur, 2 avertissements préexistants (`test/app.e2e-spec.ts:505`, `test/e2e/ephemeral-mongodb.ts:67`) ; une erreur Prettier dans le nouveau spec corrigée puis revérifiée |
| `pnpm --filter api build` | OK |
| `pnpm --filter web lint` / `exec tsc --noEmit` / `build` | OK / OK / OK — exécutés car le graphe du lockfile `web` change (`shadcn → @modelcontextprotocol/sdk → express → qs`), même hors image |
| `git diff --check` | Propre |

## 8. Audits avant / après

Mesures : avant 30/09/2026 14:07 UTC, après 30/09/2026 14:26 UTC.

| | Avant | Après |
| --- | --- | --- |
| `pnpm audit` (totaux) | 45 : 20 high, 21 moderate, 4 low | **42** : 19 high, 19 moderate, 4 low |
| `pnpm audit --prod` (totaux) | 37 : 14 high, 19 moderate, 4 low | **34** : 13 high, 17 moderate, 4 low |
| Identifiants GHSA distincts | 37 | 34 |

- **Corrigés (3)** : GHSA-2gc4-cqfq-p2gv (engine.io, 9 chemins dont 7 prod), GHSA-4mjr-xmp4-gh2g et GHSA-x5fp-wj9c-mxmx (qs, 21 chemins dont 16 prod, y compris `express → body-parser`).
- **Nouveaux** : aucun. Aucun chemin modifié sur les avis restants.
- **Restants dans les outils (34)** :
  - API, développement uniquement : `fast-uri` (`@nestjs/cli`, `@nestjs/schematics`, `ts-loader`), `js-yaml` (`eslint`, `@nestjs/cli`), `brace-expansion` (`@nestjs/cli`, `typescript-eslint`), `nanoid` (`@nestjs/cli`, `ts-loader`) ;
  - web, production du manifeste mais CLI : `shadcn` → `undici`, `hono`, `ip-address`, `fast-uri`, `js-yaml`, `brace-expansion`, `nanoid` ;
  - `nanoid` via `next` (compilé dans Next, aucun paquet `nanoid` dans l'image web 1-12E).
- **Restants dans les images runtime** : **aucun paquet des avis restants dans l'image API** `heyama-api:1-12f` ; image web inchangée depuis 1-12E (aucun des paquets signalés).

`pnpm audit` reste non nul (exit 1) : ce n'est pas « zéro vulnérabilité » à l'échelle du workspace, seulement dans le périmètre du runtime API.

## 9. Fichiers

| Fichier | Changement |
| --- | --- |
| `pnpm-lock.yaml` | `engine.io` 6.6.11, `qs` 6.16.0 |
| `api/test/socket.e2e-spec.ts` | § 9 : révision de protocole Engine.IO, transports, reconnexion |
| `api/src/common/runtime-dependency-advisories.spec.ts` | **Nouveau** : gardes de version et charges qs |
| `docs/architecture/phase-1-12f-api-runtime-dependency-security.md` | **Nouveau** : ce rapport |

Inchangés : manifestes (`package.json` racine, `api`, `web`), `pnpm-workspace.yaml`, Dockerfiles, `.dockerignore`, Compose, code applicatif, frontend.

## 10. Limites restantes

- Avis restants de l'outillage API et de la CLI `shadcn` (§ 8), hors runtime, à traiter dans une phase dédiée.
- `allowRequest` repose sur l'`Origin`, falsifiable hors navigateur : le handshake Engine.IO reste ouvert aux clients non authentifiés (comportement normal de Socket.IO) ; la protection contre cet avis vient du correctif engine.io, pas de l'authentification.
- Image locale `heyama-api:1-12f` conservée comme preuve, à supprimer manuellement après validation. Des répertoires de worktrees temporaires aux chemins trop longs pour Windows restent dans le scratchpad de session (hors dépôt, désenregistrés de Git).
