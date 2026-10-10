# Lot 1-20F — Pagination serveur des produits

État : **implémenté, testé et mesuré localement**, non commité, sur
`perf/phase-1-20f-products-pagination`. La branche part de `aadfc0e`
(1-20E commité, 1-20A à 1-20D compris). `stash@{0}` est conservé.

Aucun commit, push, déploiement ni service réel. Inchangés : cache des
signatures (1-20C), dispatcher (1-20B), relectures ciblées (1-20D),
pagination des ventes (1-20E), paiements.

## 1. Diagnostic

### Consommateurs de `GET /products` et de `useProducts`

| Consommateur | Usage avant | 1-20F |
|---|---|---|
| Page d'un rayon (`/app/catalog/[id]`, `useProducts`) | **tout le rayon** à chaque ouverture, à chaque signal produit et au rattrapage après reconnexion ; recherche **dans le navigateur** sur la liste chargée ; écrit le rayon complet dans le cache hors ligne | **adaptée** |
| Relecture ciblée après une vente (`GET /products?ids=`, 1-20D) | produits vendus affichés | inchangée (contrat et regroupement) |
| Ouverture de « Modifier » depuis l'Analyse (`?modifier=<id>`) | cherchait le produit dans la liste chargée | produit hors page lu seul (`ids=`) |
| Page des rayons (`/app/catalog`) | sections seulement ; navigateur hors ligne | inchangée (lecture du cache) |
| Fiche produit (`GET /products/:id`) | fiche et historique | inchangée |
| Sélecteurs de vente (`SaleFormDialog`, carte produit, ventes en attente) | produit déjà connu (carte, fiche, cache, outbox), **aucune liste** | inchangés |
| Indicateurs (tableau de bord, Analyse, classements) | agrégats serveur `/analytics/*`, jamais `GET /products` | inchangés |
| Corbeille (`/app/trash`) | `GET /trash` (route distincte) | inchangée, hors périmètre |
| `useObjects` / `fetchObjects` (catalogue entier) | **aucun appelant** (code mort) | inchangé, signalé |

### Tris, filtres, agrégats et actions réellement présents

- **Tri** : un seul, `createdAt` décroissant (serveur). Aucun tri au choix.
- **Filtres** : organisation, produits actifs (`deletedAt: null`), rayon
  éventuel. Aucun filtre de statut.
- **Recherche** : nom seulement ; `name.toLowerCase().includes(q.toLowerCase())`
  dès que `q.trim()` n'est pas vide : casse ignorée, **accents distingués**,
  texte tel que saisi (espaces internes compris).
- **Agrégats** : par produit (CA réel, bénéfice, unités vendues : déjà
  calculés sur **toutes** les ventes du produit, jamais sur une liste). Au
  niveau de la liste : seulement « le rayon contient-il des produits ? »
  (choix entre vide, sous-catalogues et produits). Aucun total affiché.
- **Sélection / actions groupées** : **aucune** sur la liste des produits
  (la corbeille a les siennes, sur une autre route). Rien à préserver ; je
  n'en ai pas ajouté.

### Trois périmètres distincts

| Périmètre | Source 1-20F |
|---|---|
| **Page visible** | `items` (24 produits au plus) |
| **Recherche et totaux** | tout le rayon autorisé, côté serveur (`total` recherche comprise, `scopeTotal` sans recherche) |
| **Hors ligne** | cache IndexedDB par organisation et utilisateur, alimenté par les réponses complètes et par la synchronisation dédiée (§ 4) |

## 2. Contrat API

`GET /products?limit=…` est le contrat **paginé explicite** : la présence de
`limit` le sélectionne. Sans `limit`, `GET /products` renvoie **le tableau
complet, inchangé** (anciens clients), et `ids=` (1-20D) reste un tableau.

| Paramètre | Règle |
|---|---|
| `limit` | entier de 1 à **100** (chiffres seulement), défaut web **24** ; absent → ancien contrat |
| `cursor` | curseur opaque de la page précédente (base64url de `[createdAt ISO, _id]`), ≤ 200 caractères ; illisible → **400** |
| `q` | 1 à 200 caractères, non vide après `trim` ; utilisé **tel que saisi** |
| `sectionId` | identifiant valide (400 sinon) ; absent → toute l'organisation |
| `ids` avec `limit`, `cursor` ou `q` sans `limit`, paramètre répété | **400** `INVALID_PRODUCT_PAGE` |

Réponse : `{ items, total, scopeTotal, nextCursor }`.

- `items` : même enveloppe que l'ancien contrat (`{ product, status, … }`),
  même projection selon les permissions.
- `total` : produits du périmètre (rayon **et** recherche) ;
  `scopeTotal` : rayon sans recherche (égal à `total` sans `q`).
- `nextCursor` : `null` sur la dernière page.

### Règles appliquées avant la pagination

- **Organisation** du contexte (jamais de la requête), produits actifs,
  rayon : même filtre que la liste existante.
- **Recherche** : `RegExp` construite sur le texte **échappé**, option `i`.
  Aucun motif fourni par le client n'est interprété (`.`, `*`, `[a-z]`,
  `^`, `\` sont littéraux, testés). Casse ignorée, accents distingués, comme
  avant (test e2e qui compare la recherche serveur à la règle du web
  1-20E sur 13 requêtes, dont `éCLAIR`, `eclair`, `a.b`, `.*`, `(lot)`,
  `' double'`).
- **Tri** : `createdAt` décroissant puis `_id` décroissant (départage
  déterministe des dates identiques, absent de l'ancien contrat).
- **Lecture bornée** : `limit + 1` documents au plus, comptage(s) par index.
  Jamais tout le rayon en mémoire.
- **Agrégats** : CA réel par produit sur toutes ses ventes (agrégation
  limitée aux produits renvoyés, comme le détail) ; totaux sur tout le
  périmètre.
- **Photos** : seules celles des produits renvoyés sont signées (e2e :
  5 produits → 5 appels de signature ; recherche vide → 0).

### Choix du curseur et champs de tri

Même choix qu'en 1-20E : coût indépendant de la profondeur et pages
stables.

- `createdAt` n'est **jamais modifié** (horodatage Mongoose présent depuis
  le premier schéma, `4393c9e` ; aucune migration n'insère de produits).
  Ni une vente, ni une modification, ni un déplacement, ni une restauration
  ne changent la place d'un produit dans le tri.
- Un produit **créé** n'apparaît qu'en tête ; un produit **restauré**
  revient à sa place d'origine ; un produit **déplacé** quitte le rayon
  (pages et totaux) et rejoint l'autre.
- La migration contrôle en lecture seule l'invariant (produits sans
  `createdAt`, attendu 0) et avertit sinon : un tel produit serait absent
  des pages au-delà de la première.

### Index et migration

`organizationId_1_sectionId_1_deletedAt_1_createdAt_-1__id_-1`, justifié
par les plans (`products-page-explain.js`) :

| Requête | Ancien index seul | Nouvel index |
|---|---|---|
| Rayon de 63 produits (plus grand du profil volumineux), page 1 | 63 documents, **tri en mémoire** | 25 documents, sans tri |
| Rayon de 2 000 produits, page 1 | 2 000 documents, tri en mémoire, 5 ms | **25** documents, 0 ms |
| Rayon de 2 000, page éloignée (curseur) | 2 000 documents, tri en mémoire | **26** documents, 1 ms |
| Rayon synthétique de 5 000, page 1 | 5 000 documents, tri en mémoire, 14 ms | **25** documents, 0 ms |
| Recherche (5 000) | 5 000 documents, 17 ms | 5 000 documents, 31 ms (voir limites) |
| Comptage (5 000) | 3,4 ms | 3,7 ms |

Migration idempotente `migrate:product-page-indexes`
(`create-product-page-indexes.js`), sur le modèle de 1-20E : no-op si la
clé exacte existe, aucun écrasement, ajoutée à la fin de
`PREDEPLOY_MIGRATIONS`. Index non déclaré dans le schéma ; sans lui, la
liste reste **correcte** (tri en mémoire du rayon).

Le test e2e `rate-limit-index` exigeait que la migration 1-18C soit la
dernière, ce que 1-20E avait déjà rendu faux. Il vérifie désormais l'ordre
utile (juste après celle de 1-18B).

## 3. Web

**Navigation** (`/app/catalog/[id]`) :

- page de 24 produits, total serveur (« 30 produits · page 2 ») ;
- en recherche : « 1 résultat sur 30 produits · page 1 » ;
- boutons « Première page / Précédents / Suivants » (EN : « First page /
  Previous / Next »), barre empilée sur mobile ; FR et EN.

**Recherche** : serveur, sur tout le rayon, après 300 ms sans frappe. La
barre reste affichée pendant la recherche. Le choix entre vide,
sous-catalogues et produits se fait sur `scopeTotal`, jamais sur la page
ni sur le résultat d'une recherche. Les sous-catalogues restent filtrés
localement (liste complète, inchangée).

**Vue et réponses périmées** (`useProducts`) :

- vue = session + rayon + recherche ; un changement revient à la page 1 ;
- une réponse d'une autre vue, d'une autre page ou d'une session révolue
  est ignorée ; l'ordre par produit de 1-20D s'applique dans la page ;
- au changement de page, l'indicateur est posé dans le même rendu
  (jamais le numéro d'une page avec les produits de la précédente).

**Temps réel** (« relecture complète » de 1-20D = **page affichée**) :

| Événement | Effet |
|---|---|
| Vente, modification ou annulation de vente (toute session) | relecture **ciblée** et regroupée des produits affichés (inchangée) ; un produit sorti de la vue déclenche la relecture de la page |
| Vente locale confirmée (`syncedVersion`) | idem, regroupée avec le signal |
| Création, modification, déplacement, restauration | relecture de la page et des totaux : un produit devenu éligible y apparaît s'il y a sa place, même s'il n'était pas affiché |
| Corbeille, purge | retrait immédiat, page complétée, totaux à jour, retrait du cache hors ligne |
| Reconnexion | page courante seulement, jamais les autres pages |

**Cohérence** :

- Création : en tête de la page 1 (insertion immédiate seulement si elle
  correspond à la recherche), jamais sur une page suivante. Hors de la page
  1, l'avis « La liste a changé depuis la première page » propose d'y
  revenir.
- Les curseurs des pages suivantes sont recalculés depuis la page relue :
  un produit remonté par une suppression n'apparaît pas deux fois.
- Page devenue vide : retour à la précédente.
- Produit purgé : jamais réintroduit par une réponse retenue.

## 4. Hors ligne

### Mécanisme existant

`stockmaster-offline-catalog` (IndexedDB), une partition
`userId:organizationId`, purgée à la déconnexion. Champs standard
seulement. Chaque **scope** (sections racine, sous-sections, produits d'un
rayon) est **remplacé** par une réponse complète. La page d'un rayon
écrivait son rayon complet après chaque chargement. Le stock indicatif
(1-11C.3) comparait les ventes confirmées à la date d'écriture du
snapshot.

### 1-20F

- **Réponse complète** (page 1 sans recherche ni page suivante, ou API
  antérieure) : remplacement du scope, comme avant. C'est le cas de tous
  les rayons de 24 produits au plus, la majorité des jeux mesurés.
- **Page partielle** : mise à jour **des seuls produits reçus**
  (`products-upsert`). Jamais une suppression des absents, jamais un rayon
  marqué synchronisé. Une version plus ancienne n'écrase jamais une plus
  récente.
- **Suppression explicite** sur signal (corbeille, purge, déplacement vers
  un autre rayon).
- **Synchronisation complète distincte** (`offline-section-sync.ts`) pour
  un rayon de plusieurs pages :
  - lancée à l'ouverture si le rayon n'a jamais été synchronisé ou date de
    plus de **15 min**, jamais à chaque ouverture ni événement ;
  - au plus une fois par intervalle et par onglet, même en échec ;
  - **bornée** : pages de 100, au plus 50 pages (5 000 produits). Au-delà,
    les produits lus sont conservés, le rayon n'est **pas** marqué
    synchronisé et le navigateur hors ligne affiche « Liste partielle » ;
  - **reprenable** : progression enregistrée après chaque page, reprise à
    la prochaine ouverture si elle a moins de 10 min (sinon recommencée).
    Elle s'arrête entre deux pages si le rayon est quitté ou la connexion
    perdue ;
  - publiée en une transaction à la fin : un produit relu par une page
    **après** le début de la synchronisation (créé ou vendu entre-temps)
    est conservé dans sa version plus récente.
- **Date de lecture serveur par produit** (`productLoadedAt`, nouvelle,
  facultative). Le navigateur hors ligne s'en sert pour le stock
  indicatif, à défaut de la date d'écriture. Une vente confirmée entre la
  lecture de deux pages n'est donc ni comptée deux fois ni oubliée (testé).
- **Recherche hors ligne** : le navigateur hors ligne n'en a pas, avant
  comme après. Rien n'est présenté comme une recherche complète.

### Données locales et compatibilité

Même `schemaVersion` (3) et même base : les champs ajoutés
(`productLoadedAt`, `scopeSyncedAt`, `pendingSyncs`) sont facultatifs.

- **Snapshot antérieur lu par le nouveau web** : utilisable. Date par
  produit à défaut de l'écriture, synchronisation une fois.
- **Snapshot 1-20F lu par un web antérieur** (retour arrière) : utilisable.
  Les champs ajoutés sont ignorés et abandonnés à sa prochaine écriture.
  Seule différence : un rayon jamais synchronisé, mais dont des pages ont
  été lues, y apparaît partiel sans mention.
- **Ventes en attente** : outbox séparée, intacte. Elles ne sont jamais
  mélangées à la liste.

## 5. Compatibilité et déploiement

| Cas | Comportement vérifié |
|---|---|
| Ancien web, nouvelle API | `GET /products` sans `limit` inchangé (e2e n° 1, `legacy-on-new` § 7), `ids=` inchangé |
| Nouveau web, ancienne API | l'API 1-20E **ignore** `limit`/`q` et renvoie le tableau complet (vérifié à l'exécution : `compat-old-api.json`) → le web le détecte (`legacy`), applique la recherche avec la même règle, affiche « 28 produits » **sans pagination** : résultat complet présenté comme complet, totaux exacts ; le cache hors ligne est remplacé comme avant |
| Coût du repli | celui de l'ancien web, plus une relecture complète à chaque recherche (après 300 ms sans frappe) tant que l'API n'est pas déployée |
| Échec d'une autre nature | message d'erreur, comme avant ; aucune bascule silencieuse |

**Ordre de déploiement :**

1. **Pré-déploiement** : `predeploy-migrations.js`, qui inclut
   `create-product-page-indexes.js`. Construction d'index sans
   interruption de l'API en service. Consulter l'avertissement éventuel
   « produits sans createdAt ».
2. **API**.
3. **Web**.

Web avant API : correct (repli complet). Migration non exécutée : correct,
tri en mémoire du rayon. **Anciens onglets** : ils relisent tout le rayon
jusqu'à leur rechargement (coût mesuré : identique à l'avant, § 7).

**Retour arrière : web, puis API.** L'index peut rester : inutilisé par
l'API antérieure, compatible, mais entretenu à chaque écriture de produit
(collection peu écrite). Pour le supprimer, `dropIndex` explicite et
vérifié de `organizationId_1_sectionId_1_deletedAt_1_createdAt_-1__id_-1`,
hors de ce lot. Les données locales restent lisibles (§ 4).

## 6. Vérifications

| Contrôle | Résultat |
|---|---|
| E2E `test/products-page.e2e-spec.ts` (nouveau) | **10 / 10** |
| E2E `product-field-permissions` (projection, `ids`), `sales-history` (1-20E), `rate-limit-index` | **49 / 49** avec le précédent |
| Unitaires `src/products/product-page.spec.ts` (nouveau), `products.controller.spec.ts` (+ 6), `src/products`, `src/sales`, `src/migrations` | **256 / 256** |
| Web `test:products-pagination` (nouveau, 13 cas), `test:catalog-refresh`, `test:coordinator`, `test:image-renewal` | **13 / 13, 13 / 13, 6 / 6, 6 / 6** |
| Web : `tsc`, ESLint, Prettier, `check-i18n` (0 problème), `i18n:coverage` (0 texte en dur) | OK |
| API : `tsc` (build), ESLint (0 erreur), Prettier des fichiers touchés | OK |

Les 10 scénarios e2e :

1. page par défaut, totaux, curseur ; ancien contrat et `ids` inchangés ;
2. parcours complet = ancien contrat, ordre exact, à 1, 7, 24 et 100 par
   page, 10 produits de **même date** ;
3. 17 paramètres invalides (400) ;
4. recherche identique à la règle du web 1-20E (13 requêtes) ; produit
   hors de la page 1 trouvé ; `scopeTotal` ;
5. isolation : autre organisation, rayon et curseur d'une autre
   organisation, organisation vide ;
6. projection : propriétaire (prix d'achat, stock initial, CA réel sur
   toutes les ventes = ancien contrat) ; vendeur (mêmes champs que l'ancien
   contrat, aucun champ restreint) ;
7. signatures des seuls produits renvoyés ;
8. vente puis annulation : stock exact, place inchangée ;
9. corbeille, restauration, déplacement et création pendant la
   navigation : page complétée, sans doublon ni produit supprimé ;
10. plans : nouvel index, sans tri, documents bornés ; page éloignée.

Les 13 cas web :

- règle de recherche ;
- page partielle sans suppression ;
- version plus ancienne ignorée ;
- réponse complète qui garde les produits relus après son début ;
- remplacement intégral pour un appel antérieur ;
- corbeille et déplacement ;
- snapshot antérieur ;
- synchronisation complète puis aucun nouvel essai avant l'intervalle ;
- interruption et reprise au curseur ;
- reprise expirée ;
- synchronisation bornée (tronquée, non marquée, pas de nouvel essai) ;
- ancienne API ;
- ventes locales, ni comptées deux fois ni oubliées, avec la date de
  chaque page.

### Recette navigateur

Méthode :

- recette locale (`recipe.js start` : web de production, API compilée) ;
- Playwright 1.57 et son Chromium, installation existante hors dépôt ;
- rayon de 30 produits (2 pages), dont « Éclair spécial » en page 2 ;
- propriétaire (bureau, FR), vendeur (mobile, EN) ; données de recette
  supprimées ensuite.

Résultat : **12 / 12** (`browser-recipe.json`).

| # | Contrôle | Résultat |
|---|---|---|
| B1 | « 30 produits · page 1 », 24 produits ; une requête `limit=24`, jamais la liste complète | OK |
| B1b | rayon de 2 pages : **une** synchronisation hors ligne (`limit=100`) | OK |
| B2 | page 2 : 6 produits, aucun de la page 1 | OK |
| B3 | recherche « éCLAIR » : produit de la page 2 trouvé, « 1 résultat sur 30 produits » | OK |
| B3b | « eclair » ne trouve pas « Éclair » (accents distingués, comme avant) | OK |
| B4 | vente d'une autre session : stock à 47 sans rechargement ; **une** relecture ciblée (`ids=`) | OK |
| B5 | produit affiché mis à la corbeille par une autre session : retiré, page complétée à 24, « 29 produits », aucun doublon | OK |
| B6 | IndexedDB : 29 produits du rayon, rayon synchronisé, supprimé absent, dates par produit | OK |
| B7 | coupure, vente manquée, reconnexion : **une** relecture `limit=24`, aucune autre page ni synchronisation ; stock à 45 | OK |
| B8 | hors ligne : `/app/catalog` puis rayon, 29 produits consultables, sans mention partielle | OK |
| B9 | bureau 1 280 px : aucun défilement horizontal | OK |
| B10 | vendeur, mobile 390 px, EN : « 29 products · page 1 », page 2 de 5 produits, aucun défilement horizontal | OK |

Captures : `catalog-desktop-fr.png`, `catalog-mobile-en.png`,
`catalog-offline-fr.png`.

## 7. Mesures avant / après

### Conditions

- **Témoin.** État 1-20E (`aadfc0e`, 1-20C et 1-20D compris).
  `make-baseline-dist.js` remplace `products.controller.ts`,
  `products.service.ts` et `predeploy-migrations.ts` : ni `limit`, ni
  index. Le web 1-20E est simulé (`CATALOG_MODE=legacy`) : une requête
  `GET /products?sectionId=` par ouverture. Ses pages et sa recherche ne
  coûtent aucune requête.
- **Nouveau code.** API 1-20F, index par les migrations de
  pré-déploiement. Web 1-20F simulé (`paged`), parcours **complet** par
  ouverture : première page, page suivante (si elle existe), recherche
  ciblée du dernier produit lu (hors première page).
  - **Synchronisation hors ligne** des rayons de plusieurs pages, mesurée à
    part (`catalog_sync`).
  - Comme dans le web, une fois par rayon et par VU. Comme chaque palier
    est un nouveau processus k6, elle a lieu **à chaque palier**, ce qui
    est plus défavorable que le web (une fois par 15 min).
- **Stack** neuve par mesure, mêmes données déterministes, exécutions
  séquentielles. k6 v2.3.0 (SHA-256 vérifié contre le fichier officiel),
  1 itération/s/VU.
  - **Froid** : 15 s, premières lectures, cache des signatures vide.
  - **Chaud** : 45 s, cache rempli.
- **Profils** :
  - standard (`current`) : rôles mélangés, 6 entreprises, rayons de 19 à
    28 produits ;
  - volumineux (`large`) : propriétaire de l'entreprise concentrée, 25
    rayons de 60 à 63 produits ;
  - **complémentaire** (`bigsection`) : même profil plus **un** rayon de
    2 000 produits (`LOAD_BIG_SECTION=2000`, sans vente), ouvert seul.
    Les jeux de référence ne contiennent aucun rayon dépassant 63
    produits ; c'est pourtant le cas que la pagination doit traiter.
- **Mémoire libre au départ** : 471 à 1 246 Mo (machine partagée).

### Ouverture d'un rayon, à cache chaud

Les colonnes « Reçu » et « CPU API » couvrent toute la fenêtre de 45 s,
synchronisation hors ligne comprise.

| Scénario | Variante | Reçu par ouverture (page / suivante / recherche) | Reçu en 45 s | Première page p50 / p95 / max ms | Suivante, recherche p95 ms | CPU API (cœurs) | Boucle p99 méd. / max ms | Signatures | Lectures MongoDB |
|---|---|---|---|---|---|---|---|---|---|
| standard, 1 VU | avant | 13 Ko | 0,60 Mo | 8,4 / 10,1 / 10,8 | — | 0,01 | 16,5 / 22 | 0 | 344 |
| | après | 14 / — / 1 Ko | 0,66 Mo | 8,9 / 13,4 / 23,7 | — / 10,4 | 0,03 | 16,5 / 26 | 37 | 687 |
| standard, 10 VU | avant | 15 Ko | 6,49 Mo | 45 / 94 / 192 | — | 0,10 | 16,7 / 63 | 887 | 2 459 |
| | après | 15 / (10 %) / 1 Ko | 7,19 Mo (dont 0,21 de synchro) | 42 / 94 / 209 | 98 / 106 | **0,19** | 17,1 / 58 | 915 | 6 347 |
| volumineux, 1 VU | avant | 51 Ko | 2,25 Mo | 16,5 / 42 / 53 | — | 0,04 | 16,6 / 48 | 540 | 379 |
| | après | **21** / 20 / 1 Ko | 2,92 Mo (dont **1,05 de synchro**) | **12,5 / 23 / 30** | 24 / 14 | 0,06 | 16,9 / **29** | 603 | 1 256 |
| grand rayon, 1 VU | avant | **1 669 Ko** | **73,4 Mo** | 93 / 122 / 142 | — | **0,14** | **35,4** / 66 | 0 | 434 |
| | après | **20** / 20 / 1 Ko | **3,48 Mo** (dont 1,63 de synchro, une fois) | **12,1 / 15 / 26** | 15 / 20 | **0,06** | **16,7** / 29 | 0 | 1 223 |

### Première ouverture, à cache froid (15 s, 1 VU)

| Scénario | Variante | Première page p50 / p95 / max ms | CPU API | Boucle p99 méd. / max ms | RSS max | Signatures calculées |
|---|---|---|---|---|---|---|
| standard | avant | 15 / 24 / 24 | 0,07 | 16,6 / 25 | 133 Mo | 153 |
| | après | 13 / 38 / 56 | 0,06 | 16,6 / 44 | 133 Mo | 116 |
| volumineux | avant | 37 / 49 / 51 | 0,07 | 19,8 / 77 | 136 Mo | 843 |
| | après | **22** / 45 / 85 | 0,10 | 19,6 / 71 | 138 Mo | 720 (dont synchro) |
| grand rayon | avant | 107 / **400** / **1 044** | **0,34** | 35,3 / **953** | **248 Mo** | 2 063 |
| | après | **12,5 / 31 / 62** | 0,15 (dont synchro) | **16,8 / 68** | **142 Mo** | 2 000 (synchro) |

### Lecture

- **Grand rayon (2 000 produits)**, la situation que ce lot doit traiter :
  - ouverture : 1 669 → **20 Ko** (− 99 %) ;
  - p95 à chaud : 122 → **15 ms** ; à froid : 400 → **31 ms** ;
  - retard de boucle max à froid : 953 → **68 ms**. Avant, chaque
    ouverture bloquait la boucle de l'API pour tous ses utilisateurs ;
  - CPU à chaud − 57 %, mémoire max − 106 Mo.

  La synchronisation hors ligne relit 1,63 Mo **une fois** (20 requêtes,
  p95 25 ms à chaud). Le web la fait au plus une fois par 15 min et par
  rayon, contre 1,67 Mo à **chaque** ouverture avant.
- **Profil volumineux (63 produits)** :
  - ouverture : 51 → **21 Ko**, p95 42 → **23 ms**, boucle max 48 →
    29 ms ;
  - le parcours complet (page, suivante, recherche) reçoit 42 Ko au lieu
    de 51 ;
  - sur 45 s, la synchronisation (25 rayons, une fois chacun) porte le
    volume à 2,92 Mo au lieu de 2,25 Mo, et le CPU de 0,04 à 0,06. C'est
    un coût de premier passage, pas un coût par ouverture : je le montre
    tel quel.
- **Profil standard (rayons de 19 à 28 produits)** : **aucun gain**.
  - Presque tous les rayons tiennent en une page : la première page est la
    liste complète.
  - La recherche, auparavant locale, devient une requête : à 10 VU, CPU
    0,10 → 0,19 cœur, lectures MongoDB × 2,6, p95 inchangé (94 ms).
  - C'est le prix de la recherche sur tout le rayon. Mon parcours mesure
    une recherche à **chaque** ouverture, ce qui majore ce coût.
- **Recherche** : 1 Ko et 10 à 20 ms au p95 dans tous les profils, quelle
  que soit la place du produit.
- **Signatures** : à cache chaud, seules celles des produits renvoyés (0
  sur le grand rayon, déjà en cache). La synchronisation en calcule pour
  des photos que le cache hors ligne ne garde pas (voir limites).

### Anciens onglets sur la nouvelle API (`legacy-on-new`, volumineux)

Avec la nouvelle API, le parcours de l'ancien web reste identique au
témoin :

| Variante | Reçu en 45 s | p50 / p95 ms | CPU API (cœurs) | Signatures |
|---|---|---|---|---|
| témoin | 2,25 Mo | 16,5 / 42 | 0,04 | 540 |
| anciens onglets, nouvelle API | 2,26 Mo | 16,2 / 46 | 0,04 | 540 |

L'ancien contrat n'est ni tronqué, ni ralenti, ni accéléré. Le gain vient
du nouveau web ; les anciens onglets gardent leur coût jusqu'à leur
rechargement.

## 8. Limites

- **Recherche linéaire dans le rayon.** Une sous-chaîne sans casse ne peut
  pas utiliser l'index. La recherche examine tous les produits du rayon :
  31 ms pour 5 000. C'était déjà le cas dans le navigateur, sur une liste
  entièrement téléchargée. Un index texte ou des n-grammes changeraient
  les règles de recherche ; ce n'est pas l'objet de ce lot.
- **Comptages.** Un comptage par requête, deux en recherche, linéaires
  sur les clés du rayon (≈ 4 ms pour 5 000). Le total et la page sont lus
  ensemble : une écriture concurrente peut décaler le total d'une unité
  jusqu'à la relecture suivante, que son propre événement déclenche.
- **Petits rayons.** Sans gain, et une requête de plus par recherche
  (§ 7).
- **Synchronisation hors ligne.**
  - Elle signe les photos des produits lus alors que le cache hors ligne
    ne les garde pas : 2 000 signatures au premier passage d'un grand
    rayon, à cache froid. Un contrat sans photo serait un nouveau
    paramètre d'API ; je ne l'ai pas ajouté.
  - Au-delà de 5 000 produits, le rayon reste partiel hors ligne, et
    l'interface l'indique.
  - Un rayon jamais ouvert en ligne n'est pas disponible hors ligne, comme
    avant.
- **Écart de 15 min au plus.** Hors ligne, un produit d'une page jamais
  affichée peut avoir jusqu'à 15 min de retard, ou être resté dans son
  ancien rayon après un déplacement non signalé à cet onglet. Avant, la
  copie avait l'âge de la dernière ouverture du rayon. Le stock indicatif
  reste exact vis-à-vis des ventes locales, grâce aux dates par produit.
- **Navigation séquentielle.** Pas de saut vers une page numérotée ni de
  « dernière page ». La position exacte n'est pas affichée.
- **Hors périmètre, signalés.** `GET /products` sans `limit` reste
  complet (ancien contrat). La corbeille (`GET /trash`) n'est pas
  paginée. `useObjects` / `fetchObjects` sont du code mort.
- **Mesures.** Une exécution par scénario, sur une machine partagée. Le
  parcours `paged` fait une page suivante et une recherche à chaque
  ouverture, plus que le web réel.

## 9. Reproduire

```bash
pnpm --filter api build
node api/test/load/make-baseline-dist.js --ref=aadfc0e \
  --files=src/products/products.controller.ts,src/products/products.service.ts,src/migrations/predeploy-migrations.ts
for p in current large bigsection; do
  for v in baseline new; do
    K6=<k6.exe> OUT=<dossier> bash api/test/load/compare-1-20f.sh $p $v
  done
done
K6=<k6.exe> OUT=<dossier> bash api/test/load/compare-1-20f.sh large legacy-on-new
rm -rf api/.load-dist-1-20a-baseline
pnpm --filter web test:products-pagination
```

Preuves : `docs/architecture/phase-1-20f-evidence/` (35 fichiers,
378 Ko) :

- par mesure : `cold.json`, `warm.json` (paliers, latences par étape,
  octets par étape, API, MongoDB), `explain.json`, `conditions.txt` ;
- `catalog-*-baseline/compat-old-api.json` ;
- `browser-recipe.json` et trois captures.

Les synthèses k6, les séries des échantillonneurs, les journaux, le
binaire k6 et le script de la recette navigateur restent hors du dépôt.

## 10. Fichiers

- **API** :
  - `src/products/product-page.ts` (nouveau : contrat, curseur, recherche,
    filtre, index, contrôle de l'invariant) ;
  - `src/products/products.service.ts` (`findPage`) ;
  - `src/products/products.controller.ts` (`limit`, `cursor`, `q`) ;
  - `src/migrations/create-product-page-indexes.ts` (nouveau),
    `predeploy-migrations.ts`, `package.json`
    (`migrate:product-page-indexes`).
- **Web** :
  - `src/hooks/use-products.ts` ;
  - `src/app/app/catalog/[id]/page.tsx` ;
  - `src/lib/api.ts` (`fetchProductsPage`, `PRODUCTS_PAGE_SIZE`) ;
  - `src/lib/product-search.ts` (nouveau) ;
  - `src/lib/offline-catalog-db.ts`, `src/lib/offline-section-sync.ts`
    (nouveau), `src/hooks/use-offline-catalog.ts` ;
  - `src/components/catalog/offline-catalog-browser.tsx` ;
  - `src/i18n/resources/{fr,en}/catalog.ts`.
- **Tests** :
  - `api/test/products-page.e2e-spec.ts` (nouveau),
    `api/src/products/product-page.spec.ts` (nouveau),
    `products.controller.spec.ts`, `api/test/rate-limit-index.e2e-spec.ts` ;
  - `web/scripts/test-products-pagination.mjs` (nouveau) et son script
    dans `web/package.json`.
- **Outils** :
  - `api/test/load/compare-1-20f.sh`, `products-page-explain.js`,
    `compat-probe.js` (nouveaux) ;
  - `k6/stockmaster.js` (scénario `catalogpage`), `run-campaign.js`
    (octets par étape), `load-seed.js` et `load-common.js`
    (`LOAD_BIG_SECTION`, facultatif) ;
  - `README.md`.
- **Preuves** : `docs/architecture/phase-1-20f-evidence/` (nouveau).

Nettoyage : stacks de charge, recette locale, leurs répertoires d'état, la
copie web de la recette et le témoin `api/.load-dist-1-20a-baseline` sont
supprimés. Les produits synthétiques (5 000) et ceux de la recette ont été
supprimés de leurs bases éphémères. Le MongoDB de développement (port
27018) et les processus préexistants n'ont pas été touchés.

La prochaine étape prévue est la migration vers Saspay ; aucun nouveau lot
d'optimisation n'est ouvert ici.
