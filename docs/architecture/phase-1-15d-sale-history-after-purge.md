# Phase 1-15D — Conservation de l'historique après purge des produits et catégories

Branche : `architecture/phase-1-15d-sale-history-after-purge`, créée depuis
`architecture/phase-1-15c-realtime-organization` à
**`af6eb6addaacad3813f4d01439cb478fd546d211`** (« fix: synchronize
organization members invitations and branding »), identique sur `origin`.
Au départ : arbre et index propres ; `stash@{0}` (sauvegarde lint-staged
`564a998`) présent et **non touché**. Aucune branche 1-15D préexistante.

Règle de ce lot : la suppression définitive des produits et des catégories
de la corbeille reste possible, fichiers compris. **Aucun blocage** des
catégories non vides n'est ajouté ; le comportement actuel des catégories
est conservé ; aucune suppression en cascade n'est introduite.

Aucun commit, push ni déploiement. Aucune base réelle ; aucun appel externe
réel. **Aucun `.env` réel lu, déplacé ou modifié** : suites API et build
web uniquement par `recipe.js isolated`. Aucune dépendance, lockfile
inchangé. `UnavailablePaymentProvider` et webhook désactivé : inchangés ;
parcours de paiement non touché.

---

## 1. Audit avant correction

### 1.1 Ce qu'une vente enregistrait déjà

| Champ                                              | Origine                                                             | Après purge du produit                        |
| -------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------- |
| `productId`                                        | DTO, vérifié dans la transaction (produit actif du tenant)          | conservé (référence orpheline)                |
| `productName`                                      | **serveur** : `decrementStock` renvoie le produit, même transaction | conservé — **garantie existante, réutilisée** |
| `quantity`, `salePrice`, `occurredAt`, `createdAt` | DTO validé / serveur                                                | conservés                                     |
| coût d'achat                                       | **absent** : les analyses lisaient le produit courant               | **perdu**                                     |

Le nom envoyé par un client est refusé (`ValidationPipe` global
`whitelist` + `forbidNonWhitelisted` : 400 ; `normalizeCreateSale` ne
retient que les champs connus). Les ventes antérieures à l'instantané du
nom n'ont pas de `productName`.

### 1.2 Chemins de purge

- **Produit** (`DELETE /products/:id/permanent`, `trash.manage`) : lecture
  composite tenant (404 sinon) → `s3Service.deleteFile` de l'image →
  `findOneAndDelete` → `product:purged` best effort. Aucune écriture sur les
  ventes. Le statut corbeille n'est pas exigé (comportement conservé).
- **Catégorie** (`DELETE /sections/:id/permanent`) : supprime la section
  seule ; ses produits gardent un `sectionId` orphelin, ne sont ni
  supprimés ni mis à la corbeille. Aucun fichier. **Conservé tel quel.**
- Journal d'audit : jamais supprimé ; `created` (nom, prix d'achat),
  `name_changed`, `price_changed`, `section_changed`, `deleted` (nom au
  passage en corbeille). Ordre exact des écritures : §4.2.

### 1.3 Lectures et agrégations

| Lecture                                | Dépendance au produit présent                                                                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /sales` (`view_all` / `view_own`) | `populate('productId','name')` → `null` après purge ; aucune vente écartée                                                                                       |
| Écran Ventes                           | affichait le nom **actuel** du produit s'il existait, sinon `productName`, sinon « — »                                                                           |
| `analytics/overview`                   | CA et unités : ventes seules ; coût des ventes : **produits courants** `(initial − restant) × prix d'achat` → coût du produit purgé **disparu**, bénéfice gonflé |
| `analytics/products/ranking`           | `$lookup` avec `preserveNullAndEmptyArrays` (aucune vente écartée) ; prix d'achat absent → **0**, stock absent → **0** ; nom `$first` arbitraire                 |
| `analytics/sellers/ranking`, `monthly` | ventes seules (indépendantes du produit)                                                                                                                         |
| Fiche produit (historique)             | produit requis par nature ; hors sujet après purge                                                                                                               |

Aucun filtre ni jointure n'écartait une vente ; les défauts portaient sur
les **noms** et les **chiffres**.

### 1.4 Défauts reproduits avant correction

Stack D.2H, API compilée depuis **`af6eb6a`** et web de `af6eb6a`, stockage
simulé 1-15C ; nouveaux scénarios RT22–RT28 : **0/7**. Chaque échec est
survenu à l'étape attendue, après des étapes préalables réussies (image
réellement présente puis supprimée du stockage simulé, ventes listées,
bénéfice correct avant purge).

| #   | Scénario                  | Premier échec observé sur `af6eb6a`                                                                  |
| --- | ------------------------- | ---------------------------------------------------------------------------------------------------- |
| D1  | RT22 — vente puis purge   | bénéfice du produit purgé : **800** au lieu de 600 (coût remplacé par 0) ; stock affiché 0           |
| D2  | RT23 — renommage          | la 1re vente affiche le nom **actuel** (« Après ») au lieu du nom enregistré (« Avant »)             |
| D3  | RT24 — vente ancienne     | aucun nom préservé à la purge (ni enregistré ni dernier connu) ; écran : « — »                       |
| D4  | RT25 — catégorie          | purge de catégorie conforme ; purge du produit ensuite : bénéfice 800 (D1)                           |
| D5  | RT26 — concurrence        | (a) refus 404 sans vente : **déjà correct** ; (b) vente validée avant la purge : aucun coût conservé |
| D6  | RT27 — isolation, droits  | vente ancienne du vendeur sans nom après purge                                                       |
| D7  | RT28 — purges antérieures | aucun outil de rattrapage (binaire absent)                                                           |

## 2. Données conservées

`Sale` (champs ajoutés, tous optionnels, aucun index, aucune migration) :

| Champ                  | Contenu                                                                | Exposition                                                                                         |
| ---------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `productName`          | **inchangé** : nom enregistré par le serveur au moment de la vente     | inchangée                                                                                          |
| `lastKnownProductName` | **dernier nom connu** du produit, figé à sa purge (ou reconstruit, §4) | `GET /sales` (nom de produit, déjà visible des vendeurs)                                           |
| `lastKnownUnitCost`    | prix d'achat unitaire que les analyses utilisaient jusqu'à la purge    | **`select: false`** : jamais renvoyé par `/sales` ; lu par les seules agrégations `analytics.read` |
| `lastKnownSource`      | `purge` ou `audit` ; sa présence rend l'opération idempotente          | `GET /sales`                                                                                       |

Ni copie du document produit, ni image, ni URL. Identité : `productId`
conservé et seule clé de regroupement (deux produits homonymes restent
distincts). `productName` et `lastKnownProductName` sont **distincts** :
le premier est le nom au moment de la vente, le second le dernier nom
connu ; aucun des deux n'est fourni par un client.

## 3. Purge d'un produit

`ProductsService.permanentDelete` :

1. lecture composite tenant (404 sinon, aucun appel au stockage) ;
2. **suppression du fichier** (`s3Service.deleteFile`), **avant et hors**
   de toute transaction — ordre existant conservé : un échec ultérieur
   laisse le produit en place, la purge reste relançable, aucun fichier
   orphelin ;
3. **transaction** : `findOneAndDelete` composite, puis `updateMany` des
   ventes du produit (même organisation, `lastKnownSource` absent) :
   `lastKnownProductName`, `lastKnownUnitCost`, `lastKnownSource: 'purge'`,
   valeurs lues dans le document supprimé. `productName` jamais touché ;
   puis, dans la même session, somme des quantités vendues et, **si elle
   diffère** de `initial − restant`, écriture d'un écart figé
   (`purged_stock_adjustments`, §5.1) ;
4. après commit : `product:purged` (inchangé, `{ _id }` seul).

Concurrence : une vente écrit le même document produit (décrément du stock)
dans sa transaction. Les deux transactions se heurtent (conflit
d'écriture) ; le pilote rejoue celle qui perd. Une vente validée avant la
suppression est donc couverte par l'`updateMany` ; une vente qui arrive
après ne trouve plus le produit (404, rollback complet : ni vente, ni
audit `sold`, ni trace idempotente). Le callback ne contient aucun appel au
stockage ; UUID, idempotence, stock, outbox et émissions après commit sont
inchangés.

**Catégories** : aucun changement de code.

## 4. Ventes anciennes

| Situation                        | Traitement                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Sans nom, produit encore présent | affichée sous le nom actuel (mention « nom non enregistré lors de la vente ») ; à la purge, dernier nom et coût figés (§3) |
| Produit purgé **avant** 1-15D    | CLI explicite `sales:backfill-product-history` (§4.1)                                                                      |
| Aucune trace exploitable         | **laissée intacte**, signalée par le CLI ; affichée « (nom non conservé) », bénéfice `null`                                |

### 4.1 CLI de rattrapage

`api/src/migrations/backfill-sale-product-history.ts` (logique :
`api/src/sales/sale-history-backfill.ts`) :

```
MONGODB_URI=... pnpm --filter api sales:backfill-product-history -- [--organization-id=<id>]          # simulation
MONGODB_URI=... pnpm --filter api sales:backfill-product-history -- [--organization-id=<id>] --apply
```

- Cible : ventes sans `lastKnownSource` dont le produit n'existe plus dans
  la même organisation.
- Sources : journal d'audit du produit et noms enregistrés par ses autres
  ventes, fusionnés chronologiquement ; **seules les valeurs confirmées
  peuvent être figées** (§4.2). Écrit `lastKnown*` avec
  `lastKnownSource: 'audit'` — **jamais** `productName`.
- Simulation par défaut ; `--apply` explicite ; filtre d'idempotence répété
  dans l'écriture ; connexion sans `autoIndex` ni `autoCreate`.
- Sortie JSON : `candidates`, `recoverable`, `unrecoverable`, `updated`,
  `unrecoverableSaleIds`, `nameUnknownSaleIds`, `costUnknownSaleIds` ;
  jamais l'URI, un nom ni un prix. Codes : 0, 1 (erreur), 2 (arguments).
- **Jamais lancé automatiquement**, ni au démarrage, ni par une migration ;
  exécuté ici uniquement sur les bases éphémères (e2e et recette). Aucune
  utilisation réelle.

### 4.2 Sources fiables et tentatives

Ordre réel des écritures dans `ProductsService` :

| Trace                     | Écrite                                                                                                                       | Prouve                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `created`                 | **après** `productModel.create` réussi                                                                                       | nom et prix d'achat **enregistrés** |
| `deleted`                 | **après** la mise à la corbeille réussie ; nom relu dans le document renvoyé                                                 | nom **enregistré**                  |
| `productName` d'une vente | dans la transaction de vente, lu dans le produit                                                                             | nom **enregistré** à cet instant    |
| `name_changed`            | **avant** `product.save()` ; la suite d'`update` peut encore lever (section cible absente → 404) ou l'enregistrement échouer | une **tentative** (`to`) seulement  |
| `price_changed`           | idem, après `name_changed` ; détails cumulés (nom et prix)                                                                   | une **tentative** seulement         |
| `section_changed`         | idem ; détails cumulés de toute la modification                                                                              | une **tentative** seulement         |

Règle du rattrapage (`confirmedLastKnown`) : la dernière valeur
**confirmée** est retenue, sauf si une **tentative de valeur différente**
la suit ; le champ est alors laissé **inconnu** et signalé
(`nameUnknownSaleIds`, `costUnknownSaleIds`). Les valeurs `from` ne
décident jamais : chacune est journalisée avec sa propre tentative. À
instant égal, une trace d'audit est placée après une vente (choix
prudent).

Conséquences exactes :

- **Nom** : confirmé par `created`, `deleted` ou une vente. Un renommage
  n'est retenu que s'il est suivi d'une mise à la corbeille ou d'une vente
  nommée ; sinon le nom est inconnu.
- **Prix d'achat** : seule `created` le confirme. Le journal ne permet
  **jamais** de confirmer un changement de prix ; dès qu'une tentative de
  prix existe après la création, le coût reste **inconnu**, et le bénéfice
  correspondant s'affiche « — ».
- **Aucune valeur confirmée** : vente intacte, `unrecoverableSaleIds`.

### 4.3 Défaut reproduit et correction

Version précédente du rattrapage : dernière valeur valide du journal,
tentatives comprises. Régression e2e (vraie route `PATCH /products/:id`) :
nom `Nom refusé…` et prix `999` journalisés, puis refus 404 (section
absente) **avant** l'enregistrement ; vente ; corbeille ; purge ancienne
simulée ; rattrapage. Avant correction : **`lastKnownUnitCost: 999`**
figé (échec observé `Expected path: not "lastKnownUnitCost"`, reçu 999).
Après : nom réel confirmé par `deleted`, coût inconnu et signalé ; sans
corbeille, aucune valeur figée (vente irrécupérable) ; produit jamais
modifié : nom et prix de `created`. RT28 refait le même refus par
l'interface de la recette : nom refusé jamais affiché.

## 5. Lectures et analyses

- **`GET /sales`** : inchangé (périmètres `view_own` / `view_all`) ; porte
  désormais `lastKnownProductName` et `lastKnownSource` ; jamais le coût.
- **Écran Ventes** : nom **enregistré à la vente** d'abord, puis nom actuel,
  puis dernier nom connu ; mentions « Produit supprimé », « nom non
  enregistré lors de la vente », « Désormais : X » (produit renommé) ;
  « (nom non conservé) » si aucun nom n'existe.
- **Classement produits** : groupe par `productId` ; nom = produit courant,
  sinon dernier nom figé, sinon nom de la vente la plus récente, sinon
  `null` ; `productDeleted` ; stock `null` pour un produit supprimé ;
  bénéfice : règle existante pour un produit présent, coût figé pour un
  produit supprimé, **`null` si un coût manque** (jamais 0).
- **Vue d'ensemble** : coût des ventes = règle existante (produits courants)
  **+** coût figé des ventes de produits supprimés **+** écarts figés à la
  purge (§5.1) ; toutes périodes, comme la règle existante. Bénéfice et
  marge `null` si un coût manque. Capital investi, nombre de produits, stock
  faible, épuisés : inchangés (reflètent les suppressions). Résultat :
  bénéfice identique avant et après une purge (§5.1).
- **Écran Analyses** : « — » pour un chiffre inconnu (bénéfice, marge,
  restant), mention « Coût d'achat inconnu (produits supprimés) », badge
  « supprimé ».
- Tendance mensuelle, classement vendeurs : inchangés (déjà indépendants du
  produit).

Permissions, projections financières, isolation : inchangées ; aucun
nouveau signal temps réel (`product:purged` existant suffit).

### 5.1 Conservation du bénéfice global

Contribution d'un produit au coût des ventes de la vue d'ensemble :

- **présent** (règle existante, inchangée) :
  `prix d'achat × (stock initial − stock restant)` ;
- **supprimé** : `Σ (quantité × coût figé)` de ses ventes, avec
  `coût figé = prix d'achat à la purge`, soit `prix × Σ quantités`.

Égalité si `initial − restant = Σ quantités vendues`. Opérations de stock
existantes :

| Opération                                               | `initial − restant` | `Σ quantités`   |
| ------------------------------------------------------- | ------------------- | --------------- |
| création (`initial = restant`)                          | 0                   | 0               |
| vente (`$inc` atomique, même transaction)               | `+q`                | `+q`            |
| modification de vente (`adjustStock`, même transaction) | `+(nouv − anc)`     | `+(nouv − anc)` |
| annulation de vente (`adjustStock`, même transaction)   | `−q`                | `−q`            |
| ajout de stock (`initial += n`, `restant += n`)         | inchangé            | inchangé        |

**Séquentiellement, l'égalité est garantie.** Elle ne l'est pas en
concurrence : `update` lit le produit hors transaction puis `save()`
écrit des valeurs **absolues** de stock ; une vente validée entre la
lecture et l'enregistrement d'un ajout de stock est écrasée (écriture
perdue, comportement existant). Des données anciennes peuvent aussi
diverger.

**Défaut reproduit** (e2e, organisation dédiée, barrière posée sur la trace
`stock_changed`) : produit 20 à 100, vente de 2 ; ajout de 5 retenu ; vente
de 3 validée ; ajout libéré → stock enregistré `25 / 23` (au lieu de
`25 / 20`). Vue d'ensemble : CA 2000, coût `100 × (25 − 23) = 200`,
bénéfice **1800** ; après purge, coût `100 × 5 = 500` : bénéfice **1500**.

**Correction** : dans la transaction de purge, l'écart
`units = (initial − restant) − Σ quantités` est calculé dans la même
session ; s'il est non nul, `PurgedStockAdjustment`
`{ organizationId, productId, unitCost, units }` est écrit (collection
`purged_stock_adjustments`, aucun nom, aucune image). La vue d'ensemble
ajoute `Σ unitCost × units` de l'organisation. Après purge : `500 − 300 =
200`, bénéfice **1800**, identique. Les ventes modifiées ou annulées
après la purge font évoluer la contribution comme l'aurait fait
`adjustStock`. La règle comptable n'est pas changée : la contribution
reste celle du stock, conservée à l'identique. Aucun coût inconnu n'est
remplacé par zéro (un coût de vente manquant rend toujours le bénéfice
`null`). L'écriture perdue elle-même n'est pas corrigée ici (§9).

Preuves : e2e « opérations séquentielles » (vente, modification,
annulation, ajout de stock, vente : `initial − restant = 8 = Σ`, bénéfice
inchangé, **aucun** écart écrit) et e2e « écriture perdue » (écart `−3`
écrit au prix 100, bénéfice et marge inchangés) ; specs unitaires (écart
calculé dans la session, rien si nul, ajout à la vue d'ensemble filtré par
organisation). Le classement par produit, lui, suit déjà les ventes
(`prix × Σ quantités`) avant comme après purge : inchangé.

## 6. Preuves

### 6.1 API

- `products.service.spec.ts` (+5, 2 adaptés) : fichier supprimé avant la
  transaction ; historique figé dans la même session ; `productName`
  jamais réécrit ; filtre d'idempotence ; aucun historique si le document a
  déjà disparu ; échec de transaction propagé, session fermée, aucune
  émission ; produit étranger : ni stockage, ni session, ni écriture ;
  écart de stock : aucun s'il est nul, figé dans la session sinon.
- `analytics.service.spec.ts` (+5) : écart figé ajouté au coût (tenant
  vérifié) ; coût figé intégré au bénéfice, tenant
  vérifié dans le `$lookup` ; coût inconnu → `null` ; résultat inchangé sans
  produit supprimé ; regroupement par identifiant, stock `null`, aucun 0 de
  substitution.
- `sale-history-backfill.spec.ts` (nouveau, 11) : valeurs confirmées par
  `created`, `deleted` ou une vente ; tentative refusée jamais retenue ;
  prix jamais confirmé après une tentative ; `section_changed` cumulé ;
  `from` jamais décisif ; valeurs invalides ; aucune invention ; arguments.
- `test/sale-history-purge.e2e-spec.ts` (nouveau, 11, replica set éphémère) :
  purge (nom, chiffres, bénéfice, inventaire courant, tendance) ;
  renommage, nom client refusé ; vente ancienne et non-écrasement ;
  catégorie sans cascade ; isolation et droits ; **concurrence ordonnée
  par barrières** — (a) vente en transaction puis purge : vente 201,
  historique figé ; (b) purge en transaction puis vente : 404, aucune
  vente, aucun audit `sold`, aucune trace idempotente ; rattrapage
  (simulation sans écriture, autre organisation sans effet, reconstruction,
  cas impossible, rejeu sans effet) ; **modification journalisée puis
  refusée** (vraie route) suivie d'une purge ancienne et du rattrapage ;
  **conservation du bénéfice** (opérations séquentielles ; écriture perdue
  reproduite par barrière).

### 6.2 Navigateur (recette, stockage simulé 1-15C)

RT1–RT21 et leurs assertions inchangés. Produits créés par `POST /products`
(image PNG réellement envoyée au stockage simulé).

| #    | Scénario                                                                                                                      | Résultat observé (code corrigé)                                                                                                                                                                                                                                                            |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RT22 | Vente, écran Analyses ouvert, purge                                                                                           | clé absente du stockage, image 404 ; vente nommée, sans coût ; ligne : 2 / 800 / 600 / « — » + « supprimé » en temps réel, sans rechargement ; bénéfice global identique ; capital et nombre de produits diminués                                                                          |
| RT23 | Vente, renommage, vente ; purge ; homonyme recréé                                                                             | chaque vente sous son nom ; un groupe par identifiant ; deux groupes homonymes distincts                                                                                                                                                                                                   |
| RT24 | Vente ancienne (nom retiré), produit présent, puis purge                                                                      | nom actuel avant ; après : `lastKnownProductName`, source `purge`, `productName` absent ; mention à l'écran ; chiffres conservés                                                                                                                                                           |
| RT25 | Purge de la catégorie puis du produit                                                                                         | produit inchangé (pas de cascade), image conservée, classement identique ; puis image supprimée, historique intact                                                                                                                                                                         |
| RT26 | Vente depuis la fiche, barrières `page.route`                                                                                 | (a) requête retenue avant le serveur, purge, libération : 404, 0 vente ; (b) vente validée, réponse retenue, purge : vente conservée, nom et coût figés                                                                                                                                    |
| RT27 | Vendeur standard, organisation B ouverte                                                                                      | purge de B : 404, image intacte ; vendeur : sa seule vente, nommée, sans coût ; analyses 403 ; B : 0 signal, 0 vente ni groupe de A, nom de A jamais affiché                                                                                                                               |
| RT28 | Produit tracé (création, renommage, prix, **modification refusée**, corbeille) et produit sans trace, purgés « à l'ancienne » | vrai CLI compilé : simulation 2 candidates / 1 / 1, aucune écriture ; application : nom confirmé par la corbeille, **prix non confirmé signalé** (aucun coût figé), 1 irrécupérable ; rejeu : 0 ; écran : nom + mention, « (nom non conservé) », bénéfice « — », nom refusé jamais affiché |

Les barrières navigateur ordonnent des **requêtes** ; l'entrelacement à
l'intérieur des transactions est prouvé par l'e2e (§6.1).

## 7. Validations (première passe)

Suites API et build web **exclusivement** par `recipe.js isolated`. Les
campagnes lourdes ont été lancées l'une après l'autre, jamais superposées.

| Contrôle                                                                        | Résultat                                                                                         |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| RT22–RT28, `af6eb6a` (référence)                                                | **0/7** (D1–D7)                                                                                  |
| RT22–RT28, code corrigé                                                         | 7/7 au premier passage                                                                           |
| `realtime` RT1–RT28, campagne complète sur l'état final                         | **28/28**                                                                                        |
| `scenarios` D.2H                                                                | **18/18**                                                                                        |
| `isolated api-e2e sale-history-purge` (ciblé, pendant le développement)         | 8/8 (une erreur de test corrigée : filtre `productId` non converti, cf. §8)                      |
| `isolated api-unit`                                                             | **70/70 suites, 1366/1366** (+1 suite, +14 tests) ; aucune tentative d'accès à un `.env`         |
| `isolated api-e2e`                                                              | **25/25 suites, 571/571** (+1 suite, +8 tests) ; `existsSync api\.env` bloqué 24 fois, jamais lu |
| `isolated web-build`                                                            | compilé, 26 pages ; 3 `.env*` de `web/` écartés par leur nom, 0 dans la copie ; copie supprimée  |
| `pnpm --filter web test:coordinator`                                            | **6/6**                                                                                          |
| `pnpm --filter api build` ; `tsc --noEmit -p tsconfig.build.json`               | OK ; **0 erreur**                                                                                |
| Typage complet `tsc --noEmit -p tsconfig.json`, comparé à `af6eb6a`             | 238 / 238 (+1 artefact de copie côté `af6eb6a`, comme en 1-15C) ; **aucune erreur nouvelle**     |
| `pnpm --filter api exec eslint "{src,apps,libs,test}/**/*.ts"` (sans `--fix`)   | 0 erreur, 2 avertissements préexistants                                                          |
| `web : npx eslint .` / `npx tsc --noEmit`                                       | 0 / 0                                                                                            |
| `prettier --check` ; `node --check` des scripts de recette ; `git diff --check` | OK ; OK ; OK                                                                                     |
| Lockfile                                                                        | inchangé                                                                                         |

Typage complet : même méthode qu'en 1-15C (copie de `src`, `test` et
`tsconfig.json` de `af6eb6a` placée temporairement sous `api/`, supprimée
ensuite ; comparaison par fichier et code d'erreur, lignes ignorées).
L'erreur supplémentaire côté référence est l'artefact connu
(`subscription-pricing.spec.ts`, chemin relatif vers `web/` depuis le
dossier temporaire). Les erreurs de `makeSession` dans
`products.service.spec.ts` sont préexistantes et identiques.

Après les campagnes, seuls deux scripts de recette
(`realtime-scenarios.js`, `isolated-checks.js`) ont été reformatés par
Prettier (mise en page uniquement) ; `node --check` repasse, campagnes non
relancées.

**Outillage** : `recipe.js isolated api-unit|api-e2e` accepte désormais des
motifs de chemins de tests (caractères de chemin uniquement, validés),
transmis à Jest ; garde et environnement construit inchangés.

### 7.1 Finalisation (rattrapage fiable, conservation du bénéfice)

Ordre : tests ciblés par le filtre `isolated`, puis élargissement selon les
fichiers modifiés (API seule ; `web/` inchangé dans cette passe, donc pas
de nouveau build web ; D.2H non concerné : ni purge ni analyses).

| Contrôle                                                                     | Résultat                                                                    |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `isolated api-e2e sale-history-purge`, **avant** correction                  | 2 échecs : coût refusé `999` figé ; bénéfice 1800 → 1500 à la purge         |
| idem après correction                                                        | **11/11**                                                                   |
| `isolated api-unit products.service analytics.service sale-history-backfill` | 3/3 suites, **63/63**                                                       |
| `realtime` RT8, RT11–RT13, RT22–RT28 (purge, analyses, CLI)                  | **11/11**                                                                   |
| `isolated api-unit` complet                                                  | **70/70 suites, 1373/1373** ; aucune tentative d'accès à un `.env`          |
| `isolated api-e2e` complet                                                   | **25/25 suites, 574/574** ; `existsSync api\.env` bloqué 24 fois, jamais lu |
| `pnpm --filter api build` ; `tsc --noEmit -p tsconfig.build.json`            | OK ; 0 erreur                                                               |
| Typage complet comparé à `af6eb6a`                                           | 238 / 238 (+1 artefact de copie) ; **aucune erreur nouvelle**               |
| `eslint` API (sans `--fix`)                                                  | 0 erreur, 2 avertissements préexistants                                     |
| `prettier --check`, `node --check`, `git diff --check`                       | OK                                                                          |
| Lockfile                                                                     | inchangé                                                                    |

Les campagnes de la première passe (RT1–RT28 complète 28/28, D.2H 18/18,
build web) restent valables pour les fichiers non modifiés depuis.

## 8. Fichiers

| Fichier                                                                        | Changement                                                                                                      |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `api/src/sales/schemas/sale.schema.ts`                                         | `lastKnownProductName`, `lastKnownUnitCost` (`select: false`), `lastKnownSource` ; commentaire de `productName` |
| `api/src/products/products.service.ts`                                         | `permanentDelete` transactionnel, `preserveSaleHistory`, `preserveStockContribution` ; connexion injectée       |
| `api/src/products/schemas/purged-stock-adjustment.schema.ts`                   | **Nouveau** : écart de stock figé à la purge                                                                    |
| `api/src/products/products.module.ts`, `api/src/analytics/analytics.module.ts` | modèle `PurgedStockAdjustment` enregistré                                                                       |
| `api/src/analytics/analytics.service.ts`                                       | coût figé et écarts dans la vue d'ensemble ; classement : nom, `productDeleted`, `null`                         |
| `api/src/sales/sale-history-backfill.ts`                                       | **Nouveau** : valeurs confirmées seulement (`confirmedLastKnown`), rattrapage, arguments                        |
| `api/src/migrations/backfill-sale-product-history.ts`                          | **Nouveau** : CLI opérateur                                                                                     |
| `api/package.json`                                                             | script `sales:backfill-product-history` (aucune dépendance)                                                     |
| `api/src/products/products.service.spec.ts`                                    | connexion et modèle de test, +5 tests, 2 adaptés                                                                |
| `api/src/analytics/analytics.service.spec.ts`                                  | +5 tests                                                                                                        |
| `api/src/sales/sale-history-backfill.spec.ts`                                  | **Nouveau** : 11 tests                                                                                          |
| `api/test/sale-history-purge.e2e-spec.ts`                                      | **Nouveau** : 11 tests (replica set, barrières, 3 organisations)                                                |
| `web/src/lib/api.ts`                                                           | types `ApiSale`, `AnalyticsOverview`, `ProductRanking`                                                          |
| `web/src/app/app/sales/page.tsx`                                               | nom historique, mentions                                                                                        |
| `web/src/app/app/analytics/page.tsx`                                           | « — » pour l'inconnu, badge « supprimé »                                                                        |
| `api/test/recipe/realtime-scenarios.js`                                        | RT22–RT28 et aides (RT1–RT21 inchangés) ; RT28 : modification refusée, coût non confirmé                        |
| `api/test/recipe/recipe.js`, `isolated-checks.js`                              | aide `realtime` RT1–RT28 ; motifs de tests pour `isolated`                                                      |
| `docs/architecture/phase-1-15d-sale-history-after-purge.md`                    | **Nouveau** : ce document                                                                                       |

Inchangés : routes, DTO, permissions, sections (code), `S3Service`,
`SalesService`, outbox, temps réel, abonnements, paiements, service worker,
`env-guard.cjs`, lockfile, `.env`.

Erreur de test corrigée pendant le développement : dans l'e2e, un filtre
`countDocuments({ productId: '<chaîne>' })` ne trouvait rien, le chemin
`productId` du schéma ne convertissant pas les chaînes (dette documentée
dans `sale.schema.ts`, préexistante) ; corrigé par un `ObjectId` explicite
dans le test.

## 9. Limites restantes

- **Rattrapage (ventes de produits purgés avant 1-15D)** :
  - non exécuté sur une base réelle ; tant qu'il ne l'est pas, ces ventes
    restent sans nom ni coût figés et le bénéfice global s'affiche « — » ;
  - **prix d'achat** : confirmé seulement par `created` ; tout changement
    de prix journalisé ensuite rend le coût **inconnu** (le journal ne
    prouve jamais qu'un changement de prix a abouti) ;
  - **nom** : un renommage n'est retenu que confirmé par une corbeille ou
    une vente nommée postérieures ; sinon inconnu ; produit purgé sans
    corbeille ni vente nommée après sa dernière tentative : nom inconnu ;
  - sans trace confirmée : vente intacte, « (nom non conservé) », bénéfice
    « — » ; aucune source supplémentaire n'existe après la purge ;
  - valeurs reconstruites = **dernières valeurs confirmées**, pas le nom au
    moment de la vente ;
  - écart de stock (§5.1) **inconnaissable** pour une purge antérieure : la
    contribution reconstruite suit les quantités vendues ; une divergence
    stock/ventes antérieure à cette purge n'est pas récupérable ;
  - un renommage concurrent (deux modifications simultanées du même
    produit) peut rendre une confirmation par corbeille antérieure à une
    tentative tardive : le champ est alors inconnu, jamais faux.
- **Écriture perdue sur le stock** (ajout de stock concurrent d'une vente,
  `update` + `save()` absolu) : défaut existant, **non corrigé** ici (hors
  périmètre) ; seule sa conséquence sur la conservation du bénéfice à la
  purge est neutralisée. Le stock affiché du produit reste faux dans ce
  cas.
- **Ventes déjà marquées avant la purge** (`lastKnownSource` posé alors que
  le produit existe : n'arrive pas par l'application) : l'écart est calculé
  en unités au prix de purge.
- **Coût figé = dernier prix d'achat** : c'est la règle des analyses
  existantes (prix courant) ; un prix modifié entre deux ventes n'est pas
  historisé par vente. Le coût global reste « toutes périodes » même avec
  un filtre de mois (règle existante, inchangée).
- **`purged_stock_adjustments`** : collection sans index (lecture filtrée
  par organisation, une ligne par purge divergente seulement) ; créée
  implicitement à la première écriture, dans une transaction (MongoDB
  ≥ 4.4).
- **Vendeur supprimé** : `sellers/ranking` écarte toujours les ventes d'un
  utilisateur absent (`$unwind` strict, hors périmètre).
- **Date affichée** sur l'écran Ventes : `createdAt` (existant) ; les
  analyses utilisent `occurredAt` (inchangé).
- **Purge hors corbeille** : l'API permet toujours la purge d'un produit non
  corbeillé (comportement existant conservé) ; la concurrence avec une
  vente est couverte par la transaction.
- **Multi-instance** et temps réel global : inchangés (cf. 1-15C).
