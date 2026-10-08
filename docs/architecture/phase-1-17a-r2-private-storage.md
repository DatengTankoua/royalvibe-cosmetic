# Lot 1-17A — Stockage privé Cloudflare R2 (photos produit et logos)

État : **commité (`a7e74f3`) ; essai R2 réel réussi (11/11, §8) ;
complément §10 (RT7, Compose/MinIO) non commité**. Aucun push ni
déploiement. Railway et MongoDB réels non modifiés ;
seul l'essai opérateur a écrit puis supprimé un objet de test dans R2 ; aucun
`.env` lu ; bucket jamais ouvert au public. Quotas, sauvegardes et protections antibot : lots séparés.

## 0. Base

- Branche `architecture/phase-1-16h-stock-master-brand-cleanup`, HEAD
  `d9a0b1e`, arbre propre au départ, index vide, `stash@{0}` conservé.
- Dépendance ajoutée (autorisée) : `@aws-sdk/s3-request-presigner@3.1100.0`,
  même version que `@aws-sdk/client-s3` installé ; elle réutilise
  `@aws-sdk/core` et `signature-v4-multi-region` déjà présents au lockfile.

## 1. Modèle de référence

| Donnée | Avant | Après |
|---|---|---|
| Photo produit | `imageUrl` obligatoire = URL publique | `imageKey` + `imageStorage` (référence durable) ; `imageUrl` facultatif = **ancienne** URL conservée telle quelle, jamais fabriquée ni convertie |
| Logo | `logoKey` seul | `logoKey` + `logoStorage` |
| Réponse API | URL publique | URL GET **signée** recalculée à chaque réponse (jamais en base) |

- **Identité du stockage** (`S3Service.storage`) = hôte (+ chemin) de
  `S3_ENDPOINT` + `S3_BUCKET` (ex.
  `<ACCOUNT_ID>.eu.r2.cloudflarestorage.com/stockmaster-prod`). Lecture et
  suppression exigent la **même identité** : un changement de fournisseur,
  de compte, de juridiction ou de bucket ne peut jamais lire ni supprimer un
  objet d'un autre stockage.
- Un `logoKey` existant sans `logoStorage` (antérieur à R2) a un stockage
  **inconnu** : jamais signé (le shell affiche les initiales), jamais
  supprimé (`retained`).
- Une ancienne `imageUrl` http(s) est renvoyée telle quelle (elle désigne son
  propre stockage) ; elle n'est jamais supprimée par l'API. Un remplacement
  de photo écrit `imageKey`/`imageStorage` et laisse `imageUrl` en place.

## 2. Lecture privée

- Signature côté serveur seulement (`S3Service.signedReadUrl`), pour une
  référence **déjà lue en base dans l'organisation du demandeur** (filtres
  `organizationId` existants, droits relus à chaque requête par les gardes) ;
  contrôle supplémentaire du **préfixe exact**
  `organizations/<orgId du contexte>/products|branding/`. Aucune route ne
  signe une clé fournie par le client.
- Couverture : liste et détail produit, corbeille (`trash.manage`), branding
  (`GET /organizations/current`), réponses de création/modification/
  restauration, événements temps réel `product:created|updated` (room de
  l'organisation). Le classement d'Analyse ne transporte plus d'URL de photo
  (non affichée).
- Durée explicite : `S3_SIGNED_URL_TTL_SECONDS` (60–3600, défaut 900), date
  réelle de signature (aucun arrondi).
- **Un lien copié reste utilisable par quiconque le détient jusqu'à son
  expiration** (y compris par un membre retiré ou après déconnexion) ;
  l'expiration n'efface pas les copies déjà téléchargées ni le cache du
  navigateur.

## 3. Web

- `components/products/stored-image.tsx` (carte, fiche, corbeille, ancienne
  carte « objet ») et `TenantLogo` : lien absent ou non chargeable →
  remplacement (jamais d'image cassée) ; échec mémorisé **par lien**, donc
  réinitialisé quand la source change.
- Renouvellement **borné** (`lib/image-renewal.ts`, `useImageRenewal`) : un
  échec demande la relecture authentifiée des écrans montés via leur
  `useLiveRefresh` existant (regroupée, sérialisée, jamais hors ligne) ; même
  image (lien sans signature) : au plus une demande par 5 min ; toutes
  images : au plus une demande par 10 s ; aucun rechargement de page, aucun
  cache persistant ajouté.
- Échec de suppression d'un fichier : avertissement explicite (corbeille,
  branding), jamais présenté comme effacé. Libellés FR/EN.
- Déconnexion, changement d'organisation (remontage des pages) et file des
  ventes hors connexion inchangés ; images toujours absentes hors connexion.

## 4. Upload et suppression

- Photos produit (`products/product-image-validation.ts`) : JPEG/PNG/WebP
  statiques, contrôle Sharp réel (signature, cohérence MIME, format détecté,
  décodage complet strict), 5 Mo, ≤ 6000 px de côté, ≤ 24 Mpx ; clé
  `<uuid>.<ext>` serveur, `ContentType` du format détecté. Codes stables
  `PRODUCT_IMAGE_*`, messages FR/EN au catalogue d'erreurs. Logos : contrat et
  messages inchangés (deux fonctions seulement exportées pour réutilisation).
- Échec après upload (écriture MongoDB, nom en double, section absente…) :
  le nouvel objet est supprimé **seulement s'il n'est référencé par aucun
  document** (`isImageReferenced` / `isLogoReferenced`) ; vérification
  impossible → objet conservé et journalisé.
- Remplacement : ancien objet supprimé **après** l'écriture. Purge : la
  transaction MongoDB d'abord, puis le fichier, hors transaction (inversé par
  rapport à avant). Sort renvoyé `storageCleanup` :
  `deleted | not_needed | retained | failed` ; `failed` = objet orphelin
  journalisé, la mutation reste réussie.
- Module `objects` (orphelin, jamais monté) : création refusée (410), plus
  aucune URL publique fabriquée.

## 5. Configuration (service API, Railway)

| Variable | Action | Valeur cible |
|---|---|---|
| `S3_ENDPOINT` | modifier | endpoint **exact** du bucket, juridiction comprise : `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` ou `https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com` |
| `S3_REGION` | modifier | `auto` |
| `S3_BUCKET` | modifier | `stockmaster-prod` |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | modifier (secrets) | `<R2_ACCESS_KEY_ID>` / `<R2_SECRET_ACCESS_KEY>` |
| `S3_FORCE_PATH_STYLE` | modifier | `false` — **confirmé par l'essai réel** (virtual-hosted) |
| `S3_SIGNING_ENDPOINT` | **ne pas définir** (R2) | endpoint unique ; réservé à Docker Compose/MinIO (§10.2) |
| `S3_SIGNED_URL_TTL_SECONDS` | facultatif | absent = 900 |
| `S3_CHECKSUM_MODE` | **ne pas définir** | comportement par défaut du SDK **accepté par R2** (essai réel) |
| `S3_PUBLIC_URL` | **supprimer après la bascule** | n'est plus lue par l'API ; noter sa valeur hors du dépôt (inspection §6 et retour arrière) |

Vérifié localement (sans réseau) : avec le SDK 3.1100, `PutObject` envoie
`x-amz-sdk-checksum-algorithm: CRC32` et `x-amz-checksum-crc32` ; une URL GET
signée porte `x-amz-checksum-mode=ENABLED`. La documentation R2 indique un
support partiel de ces en-têtes ; **l'essai réel (§8) confirme qu'ils sont
acceptés** (envoi et lecture signée réussis sans option). Région signée :
`auto/s3`.

Vercel : rien d'obligatoire (images `unoptimized`, aucune CSP `img-src`).
Docker Compose/MinIO : endpoint de signature distinct, voir §10.2.

## 6. Références existantes (lecture seule)

`api/test/storage/inspect-storage-references.mongosh.js` : comptages par
catégorie (clé + stockage, ancienne URL par hôte, base Supabase, corbeille,
préfixe incohérent), logos avec/sans stockage, collection `objects`. Aucune
écriture, aucune URL ni clé affichée. À lancer par l'opérateur avec un
utilisateur `read` ou sur une copie :

```bash
mongosh "<URI_LECTURE_SEULE>" --quiet \
  --eval 'var LEGACY_PUBLIC_BASE="<ancienne S3_PUBLIC_URL>/"' \
  --file api/test/storage/inspect-storage-references.mongosh.js
```

Fichiers sources absents (stockage annoncé vide) : rien n'est converti ni
supprimé ; anciennes photos → remplacement à l'écran, anciens logos →
initiales ; un nouvel envoi crée une référence R2. Si des fichiers existent,
une copie vers R2 (même clé, puis `imageKey`/`logoStorage` renseignés après
vérification) relève d'un lot distinct.

## 7. Ordre de bascule et retour arrière

1. Inspection §6 (opérateur) ; noter hors dépôt les valeurs S3 actuelles.
2. **Essai R2 réel** (opérateur, avant tout déploiement) — **fait, 11/11** :
   `api/test/storage/r2-operator-trial.js` — code livré, préfixe d'organisation
   fictive, objets supprimés à la fin, aucun MongoDB. Vérifie envoi, lecture
   signée, octets et `Content-Type`, refus sans signature, refus d'une clé
   modifiée, expiration (65 s), suppression puis 404. Rejouer si besoin avec
   `S3_FORCE_PATH_STYLE=true` ou `S3_CHECKSUM_MODE=when_required`.
3. Variables Railway §5, puis déploiement de ce lot (les deux ensemble : ce
   code ne fabrique aucune URL publique).
4. Contrôles en production : envoi d'une photo, affichage, objet présent dans
   `stockmaster-prod`, même clé sans signature → 403, logo, purge.
5. Après stabilisation : supprimer `S3_PUBLIC_URL`.

**Retour arrière réaliste** — remettre les anciennes variables ne suffit pas :

- les produits et logos créés pendant la période R2 n'ont pas d'URL
  publique (`imageUrl` absente, `logoKey` sans fichier chez l'ancien
  fournisseur) : l'ancien code les affiche sans image / avec initiales ;
- l'ancien code exige `imageUrl` à la création (aucune écriture existante
  n'est revalidée par les mises à jour atomiques) ;
- les objets R2 restent en place (rien n'est supprimé).

Procédure : préférer une **correction en avant**. Sinon : redéployer le
commit précédent avec les anciennes variables ; lister les références R2 de la
période avec l'inspection §6 (`stockage` = identité R2) ; accepter des images
manquantes pour ces produits ou copier ces objets vers l'ancien stockage
(lot distinct) ; au retour sur R2, les références redeviennent lisibles telles
quelles.

## 8. Validation

**Simulée** (aucun service réel) :

| Contrôle | Résultat |
|---|---|
| Unitaires API (`recipe.js isolated api-unit --runInBand`, commande CI isolée des `.env`) | 85/85 suites, **1582/1582** |
| E2E ciblés (branding, isolation, purge, socket, droits produits) | 5/5, **144/144** |
| E2E surfaces modifiées (app, analyse, export mensuel, concurrence stock, transactions, centre de notifications) | 6/6, **140/140** |
| ESLint API complet ; `tsc -p tsconfig.build.json` ; `nest build` | 0 erreur (2 avertissements préexistants) ; 0 ; OK |
| Web : `tsc --noEmit`, `eslint src`, `test:i18n`, `test:image-renewal` (6/6), Prettier (fichiers modifiés) | OK |
| `isolated web-build` | `ok: true`, `problems: []`, `envFilesInCopy: 0` |
| Stockage simulé rendu **privé** (`storage-sim.js` : signature SigV4 recalculée, expiration) | signé 200 ; sans signature, clé d'une autre org, signature falsifiée, expiré → 403 ; supprimé → 404 |
| Contrôle navigateur ciblé (recette, TTL 60 s, script hors dépôt) | **33/33** : photo invalide 400 sans envoi ; URL signée ; sans signature 403 ; doublon après upload → objet nettoyé ; B → 404 et aucun lien de A ; lien expiré 403 puis **une** relecture et lien neuf sans rechargement ; fichier absent → remplacement, aucune boucle ; remplacement vu en temps réel par un collègue, ancien objet supprimé ; corbeille conserve, purge supprime ; logo signé affiché ; aucune image dans le cache du service worker ; déconnexion ; 0 erreur |
| Recette temps réel | RT18, RT19, RT22, RT25, RT27 : PASS |
| `r2-operator-trial.js` contre le stockage simulé (mécanique du script) | 11/11 |
| Inspection §6 sur MongoDB éphémère (données fictives) | classification correcte, données inchangées, aucune URL ni clé affichée |

**RT7 (vente hors connexion)** : instabilité initialement constatée, cause
démontrée et corrigée au §10.1 (défaut de l'utilitaire de test, pas de
l'application).

**Réel — essai opérateur R2** (`r2-operator-trial.js`, lancé par l'opérateur
depuis PowerShell, identifiants saisis masqués et retirés de la session
ensuite ; bucket `stockmaster-prod`, endpoint du compte avec sa juridiction,
`S3_REGION=auto`, `S3_FORCE_PATH_STYLE=false`, sans `S3_CHECKSUM_MODE`) :
**11/11, code de sortie 0**.

| Contrôle | Résultat réel |
|---|---|
| Photo contrôlée par le code livré | OK |
| Envoi `PutObject` (sommes de contrôle par défaut du SDK) | accepté, clé `organizations/000000000000000000000000/products/<uuid>.jpg` |
| Lecture par URL signée ; `Content-Type` ; octets | HTTP 200 ; `image/jpeg` ; identiques |
| Même objet sans signature | refusé, **HTTP 400** (réponse de R2 à une requête anonyme ; aucun accès) |
| Clé modifiée dans un lien signé | refusée, HTTP 403 |
| Lien expiré (60 s, attente 65 s) | refusé, HTTP 403 |
| Suppression puis lecture | `deleted`, puis HTTP 404 (aucun objet d'essai restant) |

Conséquences : `S3_FORCE_PATH_STYLE=false` et absence de `S3_CHECKSUM_MODE`
retenus pour Railway (§5) ; adressage virtual-hosted et certificat de
`stockmaster-prod.<compte>…r2.cloudflarestorage.com` opérationnels.

**Non exécuté** : inspection des références de production (§6, à faire par
l'opérateur) ; affichage par un navigateur depuis R2 en production
(contrôles §7, étape 4) ; aucune connexion à MongoDB de production ;
campagnes complètes non relancées ; Docker Compose/MinIO et nginx réels
(§10.3).

## 9. Fichiers

API : `s3/s3.service.ts` (+ specs, dont `s3.service.signing.spec.ts`),
`products/product-image-validation.ts` (+ spec),
`products/product-image-upload.interceptor.ts`, `products.controller.ts`,
`products.service.ts`, `product-projection.ts`, `schemas/product.schema.ts`,
`organizations/organization-branding.controller.ts`,
`organizations.service.ts`, `schemas/organization.schema.ts`,
`logo/logo-validation.ts` (exports), `objects/*`,
`analytics/analytics.service.ts`, `common/i18n/error-messages.ts`, specs et
e2e associés, `package.json`, `pnpm-lock.yaml`.

Recette et outils : `test/recipe/storage-sim.js` (privé ; vérification
selon l'en-tête `Host` reçu, §10.2), `recipe-common.js` (TTL, endpoint de
signature), `realtime-scenarios.js` (clé d'un lien signé), `lib.js`
(`outboxOps`, §10.1),
`test/storage/r2-operator-trial.js`,
`test/storage/inspect-storage-references.mongosh.js`.

Web : `components/products/stored-image.tsx`, `lib/image-renewal.ts`,
`hooks/use-image-renewal.ts`, `scripts/test-image-renewal.mjs`,
`package.json`, `lib/api.ts`, `hooks/use-products.ts`, `hooks/use-trash.ts`,
pages catalogue/fiche/corbeille/branding, `app/app/layout.tsx`,
`brand/tenant-logo.tsx`, `objects/object-card.tsx`, ressources i18n FR/EN.

Documentation : `README.md`, `api/README.md`, `api/.env.example`,
`.env.prod.example`, `docker-compose.prod.yml`, ce rapport.

## 10. Complément — RT7 et Docker Compose/MinIO (non commité)

Base : HEAD `a7e74f3` (lot 1-17A commité par l'utilisateur, en avance d'un
commit sur `origin`), arbre propre, index vide, `stash@{0}` conservé.

### 10.1 RT7 : cause démontrée, défaut du SCÉNARIO

Instrumentation hors dépôt (script d'init Playwright : noms de bases et de
stores, étapes, erreurs natives `name/message` ; aucun contenu de vente ni
jeton) puis reproduction déterministe.

- **Mécanisme** : l'utilitaire de test `L.outboxOps(page)` ouvrait
  `indexedDB.open('stockmaster-offline-sales-outbox')` **sans version**. Si
  l'application n'avait pas encore créé la file (première vente du
  contexte), cette ouverture **créait la base en version 1, sans store**.
  L'application l'ouvrait ensuite en version 1 : succès **sans**
  `upgradeneeded`, donc sans stores, puis
  `IDBDatabase.transaction(['operations','meta'])` levait
  **`NotFoundError` — « One of the specified object stores was not found »**
  (étape : création de la transaction d'écriture) → « Stockage local
  indisponible : vente non enregistrée. ». L'utilitaire ne refermait pas non
  plus sa connexion.
- **Pourquoi intermittent** : course entre la boucle d'attente du scénario
  (qui sonde la file juste après « Confirmer la vente ») et la première
  ouverture par l'application ; l'ordre dépend de la charge de la machine.
  Les échecs observés (code d'avant et d'après 1-17A) sont groupés dans un
  même créneau de forte activité ; la mémoire n'est pas en cause (4/4 réussis
  avec 0,3 Go libres).
- **Preuve** : sondage de l'utilitaire AVANT la vente → **3/3 échecs**,
  séquence `open (sans version) → upgrade 0→1 (utilitaire)` puis
  `open v1 → success (sans upgrade) → tx:create NotFoundError`.
- **Correctif (cause)** : `api/test/recipe/lib.js`, `outboxOps` — si
  `upgradeneeded` survient (la base n'existe pas), la transaction de version
  est **annulée** : la base n'est pas créée et l'utilitaire répond « aucune
  opération » ; la connexion de lecture est toujours refermée. Aucun code
  applicatif modifié, aucun retry, délai, effacement ni test désactivé.
- **Application** : elle ouvre toujours ses bases avec une version ; aucune
  autre ouverture sans version dans `web/src`. Stockage réellement
  inutilisable (base vide forcée) : seul « Stockage local indisponible :
  vente non enregistrée. » s'affiche, jamais « Vente enregistrée ».

Vérifications (recette locale, simulée) :

| Contrôle | Résultat |
|---|---|
| Sondage AVANT la vente, après correctif | séquence : `open (sans version) → AbortError` (base non créée), puis l'application crée ses stores (`upgrade 0→1`) |
| Parcours complet ×4 (sondage avant la vente) : vente hors connexion → rechargement → reconnexion | 4/4 : opération présente après rechargement (même `clientOperationId`), **1** vente serveur, stock 25 → **22**, opération `synced` |
| RT7 réel | 5/5, plus 3/3 avec CPU ralenti ×12 ; puis 1/1 sur pile à endpoint unique |

Observation sans correction (hors cause) : `openDb` de la file rejette
après 2 s (`OPEN_TIMEOUT_MS`) sans fermer une ouverture native qui
aboutirait plus tard ; aucun lien démontré avec RT7.

### 10.2 Docker Compose/MinIO : URL signées pour l'hôte du navigateur

- **API** : `S3_SIGNING_ENDPOINT` (facultatif, origine http(s) sans chemin,
  sinon refus au démarrage). Envois et suppressions : `S3_ENDPOINT`
  (interne). URL GET : signées **directement** pour `S3_SIGNING_ENDPOINT`,
  jamais réécrites. L'identité durable (`storage`) reste calculée sur
  `S3_ENDPOINT` : changer l'hôte du navigateur ne rend aucune référence
  illisible. Absent (R2) : un seul client, comportement inchangé.
- **`docker-compose.prod.yml`** :
  `S3_SIGNING_ENDPOINT: https://${S3_HOSTNAME:?…}` (variable existante
  `S3_HOSTNAME`, aucune nouvelle variable de composition ; absente → refus
  explicite de `docker compose config`). Console MinIO publiée sur
  `127.0.0.1:9001` seulement (tunnel SSH pour l'administrer) ; API S3 de
  MinIO jamais publiée.
- **`nginx/nginx.conf`, vhost `s3.`** : lecture seule
  (`limit_except GET HEAD { deny all; }`), `proxy_pass http://minio:9000;`
  sans URI (chemin et requête signés transmis tels quels),
  `proxy_set_header Host $http_host;` (hôte exact signé),
  `client_max_body_size 1m`. Bucket privé (aucune politique anonyme).
- **Configuration exacte** (`.env` de la composition) :
  `S3_HOSTNAME=s3.<domaine>` (DNS et certificat de ce vhost),
  `MINIO_USER`/`MINIO_PASSWORD` ; bucket `stockmaster-objects` à créer
  (console via tunnel, ou `mc mb`).

Vérifications **simulées** (pas de MinIO ni de nginx) : stockage simulé
vérifiant la signature selon l'en-tête `Host` reçu, relais local imitant le
vhost (GET/HEAD seulement, `Host` conservé, URI inchangée), recette lancée
avec un endpoint interne et un endpoint de signature distincts :

| Contrôle | Résultat |
|---|---|
| Contrôle navigateur via le relais | **36/36** : lien signé pour l'hôte public ; ce lien présenté à l'hôte interne → 403 ; méthode autre que GET/HEAD → 403 ; sans signature 403 ; isolation entre organisations ; expiration puis lien neuf ; fichier absent sans boucle ; photo et logo affichés ; purge |
| Endpoint unique (R2) inchangé | navigateur 33/33 ; RT7, RT18, RT22 réussis ; unitaires S3 33/33 (dont 4 nouveaux cas d'endpoint de signature) |
| `docker compose -f docker-compose.prod.yml config` (client seul) | valide ; `S3_SIGNING_ENDPOINT=https://s3.stock-master.app` ; console `127.0.0.1:9001` |

### 10.3 Limites réellement restantes

- **Docker indisponible** sur cette machine (moteur Docker Desktop : erreur
  500, puis commandes sans réponse) : MinIO, nginx réel (`nginx -t`), TLS du
  vhost `s3.`, résolution DNS et vérification de signature par MinIO derrière
  nginx **non exécutés**. La voie Compose/MinIO n'est **pas validée** ; seule
  sa logique l'est, par simulation.
- `docker-compose.yml` (développement) publie toujours la console et l'API
  MinIO sur l'hôte local (inchangé, usage local).
- Inspection des références de production et contrôles post-déploiement R2
  (§6, §7) toujours à faire par l'opérateur.
- Observation `OPEN_TIMEOUT_MS` (§10.1) non traitée.

### 10.4 Contrôles du complément

Unitaires API (commande CI isolée) : 85/85 suites, **1590/1590** ; e2e
branding et isolation : 87/87 ; ESLint et `tsc -p tsconfig.build.json` :
0 erreur ; syntaxe des scripts de recette : OK.

Fichiers : `api/src/s3/s3.service.ts`, `s3.service.signing.spec.ts`,
`api/test/recipe/lib.js`, `storage-sim.js`, `recipe-common.js`,
`docker-compose.prod.yml`, `nginx/nginx.conf`, `.env.prod.example`,
`api/.env.example`, `api/README.md`, ce rapport.
