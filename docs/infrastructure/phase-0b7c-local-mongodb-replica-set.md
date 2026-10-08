# Phase 0B.7C — MongoDB local compatible avec les transactions

**Objectif.** Rendre le MongoDB de DEV local (Docker) compatible avec les
transactions multi-documents « VENTE–STOCK–AUDIT » (phase 0B.7B) grâce à un
replica set mono-nœud `rs0`. Production (Atlas) et Supabase Storage sont hors
périmètre et n'ont subi aucune modification.

## Topologie locale constatée
- **API locale** exécutée sur l'hôte Windows (`pnpm --filter api start:dev`),
  **infra** (Mongo + MinIO + Mongo Express) dans Docker Desktop.
- Service Compose `mongo` (image `mongo:7`) : `container_name` global fixe
  `heyama-mongo`, port hôte fixe `27017:27017`, volume nommé `mongo_data`
  (préfixé par le projet Compose : `heyama-test_mongo_data`),
  `restart: unless-stopped` — **standalone avant la phase**.
- `MongooseModule.forRootAsync` branché sur `MONGODB_URI`
  (`api/src/app.module.ts`).

## Changement
`docker-compose.yml` :
- `command: mongod --replSet rs0 --bind_ip_all` (MongoDB 7 conservé) ;
- nom de conteneur et port hôte paramétrables
  (`MONGO_SERVICE_CONTAINER_NAME`, `MONGO_SERVICE_HOST_PORT`) avec **défauts
  stables** (`heyama-mongo` / `27017`) : la DEV réelle est inchangée, et le
  smoke test isolé peut injecter nom + port propres au projet Compose
  (`-p heyama_phase0b7c_smoke`) sans collision ;
- nouveau service **`mongo-rs-init`** : exécution ponctuelle et idempotente du
  script `scripts/mongo/init-replica-set.js` (bind mount lecture seule,
  `restart: "no"`).
- **healthcheck du service `mongo`** : `mongosh --quiet --host 127.0.0.1 --port
  27017 --eval "quit(db.adminCommand({ ping: 1 }).ok ? 0 : 1)"`
  (interval 2 s, timeout 5 s, retries 45, start_period 5 s). Healthy dès que le
  listener accepte `ping` — **avant comme après** l'initiation de `rs0`, sans
  écriture, sans secret.
- **`mongo-rs-init` conditionné par** `depends_on: mongo` avec
  `condition: service_healthy` : l'ECONNREFUSED de la première connexion
  mongosh est impossible (le script n'est exécuté qu'après connexion
  réussie). Ordre garanti : `mongo` démarre → healthy → `mongo-rs-init`
  `Exited (0)` → `mongo-express`.
- **`mongo-express`** : `ME_CONFIG_MONGODB_URL: mongodb://mongo:27017/?replicaSet=rs0`
  (même réseau Docker, résout `mongo` ; plus de `directConnection`) ;
  `depends_on: mongo-rs-init` avec
  `condition: service_completed_successfully` (démarrage **après** l'init, ne
  dépend plus directement de `mongo`) ; nom de conteneur et port hôte
  paramétrables (`MONGO_EXPRESS_CONTAINER_NAME` / `MONGO_EXPRESS_HOST_PORT`)
  avec défauts inchangés (`heyama-mongo-express` / `8081`).

## Script d'initialisation (`scripts/mongo/init-replica-set.js`)
1. attend que le nœud accepte les connexions (erreurs réseau transitoires
   tolérées, délai borné 90 s) ;
2. détecte un `setName` inattendu → échec explicite ;
3. `rs.initiate()` **uniquement si la configuration est absente**
   (volume vierge) ; sinon « rien à faire » ;
4. attend l'état `PRIMARY` de `rs0` (délai borné) ;
5. `exit 0` au succès, `exit 1` en échec (conteneur `Exited (1)`, pas de
   redémarrage) ; aucune donnée métier créée.
Le membre est déclaré sous l'alias Docker `mongo:27017` (réseau du projet,
stable au redémarrage). Redémarrer la stack ne réinitialise ni ne supprime les
données : la configuration persiste dans le volume `mongo_data`.

**Connexion initiale.** `mongosh <uri> script.js` se connecte à l'hôte AVANT
d'exécuter le JavaScript : une indisponibilité survenant à ce stade échappe au
script. La boucle JavaScript ne gère donc QUE les erreurs transitoires de
`db.hello()` après le démarrage de mongosh — la **connexion initiale est
protégée par le healthcheck Compose** (`depends_on: mongo` avec
`condition: service_healthy`).

## Incident de première activation (non masqué)
Lors de la conversion du volume réel, la **1re exécution** de `mongo-rs-init`
a échoué en `Exited (1)` avec `ECONNREFUSED` : mongod — recréé en `--replSet`
sur le volume existant — n'avait pas encore rouvert son listener quand mongosh
a cherché à se connecter **avant** de charger le script (le healthcheck
n'existait pas encore). Les données du volume restaient intactes (mongod
`Up`, données relues en 75 documents). Une **relance manuelle** de
`mongo-rs-init` a permis de valider la conversion. La cause racine (pas de
garde côté Compose) a été corrigée par l'ajout du healthcheck + la condition
`service_healthy` : **un démarrage ne doit plus jamais exiger de relance
manuelle**.

## URI locales
- **API sur l'hôte Windows** (`api/.env.example`, à recopier dans `api/.env`) :
  `mongodb://localhost:27017/heyama?replicaSet=rs0&directConnection=true`
- **API dans Docker** (réseau Compose) :
  `mongodb://mongo:27017/heyama?replicaSet=rs0&directConnection=true`
Aucune URI Atlas dans Git ; `.env.prod` et `docker-compose.prod.yml` intacts.

## Validation effectuée
- `docker compose config` : OK (défauts DEV inchangés : `heyama-mongo`,
  `27017`, `heyama-test_mongo_data`) ;
- **isolation démontrée** pour le smoke : conteneur
  `heyama_phase0b7c_smoke-mongo`, volume `heyama_phase0b7c_smoke_mongo_data`,
  réseau `heyama_phase0b7c_smoke_default`, port hôte `27018` ;
- `db.hello()` sur l'instance smoke : `setName=rs0`,
  `isWritablePrimary=true` ;
- **smoke transactionnel réel** (base temporaire
  `inventory_saas_replica_smoke`, driver `mongodb@7.5.0` du repo) :
  `startSession` → `startTransaction` → `insertOne` → `abortTransaction` →
  document **absent** après rollback (`countAfterAbort=0`) ;
- **2e exécution de l'initialiseur** : « déjà configurée — rien à faire »,
  `exit 0` ;
- **test de race condition après le correctif 0B.7C (volume réel converti,
  unique recréation `up -d --force-recreate mongo mongo-rs-init
  mongo-express`)** :
  `mongo` → **healthy** (healthcheck `ping` local) → `mongo-rs-init`
  **`Exited (0)` à sa 1re et seule exécution** (logs : « `rs0` déjà
  configurée — rien à faire » → « `isWritablePrimary=true` — exit 0 »,
  **aucun `ECONNREFUSED`**, ~0,7 s d'exécution) → `mongo-express` démarré,
  HTTP **200**, sans erreur MongoDB ; `db.hello()` : `setName=rs0`,
  `isWritablePrimary=true` ; volume inchangé ; comptes exacts 75 documents /
  6 collections. **Aucune relance manuelle n'a été nécessaire.**
- **validation Mongo Express** (projet temporaire `heyama_phase0b7c_me_smoke`,
  port hôte `8082`/`mongod` sur `27018`) : ordre observé
  `mongo` → `mongo-rs-init` **`Exited (0)`** → `mongo-express` démarré
  (0,1 s après, via `service_completed_successfully`) ; état **Running**,
  logs sans erreur de connexion MongoDB (« Mongo Express server listening
  at http://0.0.0.0:8081 ») ; endpoint HTTP `http://localhost:8082/` →
  **200** ;
- nettoyage scoped `docker compose -p heyama_phase0b7c_smoke down -v
  --remove-orphans` puis `... -p heyama_phase0b7c_me_smoke down -v
  --remove-orphans` : volumes `heyama-test_*` **présents après** ; aucun
  conteneur `heyama_phase0b7c_*` restant ; `heyama-mongo` et
  `heyama-mongo-express` **Up 2 days** (projet réel intact).

## Risques résiduels
- Le conteneur API existant `royalvibe-api` (image `heyama-test-api`,
  pas de `royalvibe-mongo` correspondant à `docker-compose.prod.yml`) pointe
  sur Atlas ou sur le MongoDB local : à confirmer avant le prochain
  `docker compose up` de DEV.
- `mongo-rs-init` échoue proprement (exit 1) si l'initialisation échoue : le
  conteneur reste `Exited (1)`, `mongo-express` ne démarre pas (condition
  `service_completed_successfully`) et la situation reste visible dans
  `docker ps` — pas d'échec masqué.
- Le volume local `heyama-test_mongo_data` existant passe de standalone à
  replica set au premier `docker compose up` après le commit : les données
  sont conservées ; un snapshot conseillé avant ce `up` (hors périmètre).
