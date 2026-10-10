# Lot 1-20E — Pagination serveur de l'historique des ventes

État : **implémenté, testé et mesuré localement**, non commité, sur
`perf/phase-1-20e-sales-pagination`. La branche part de `57b1145` (1-20D
commité, 1-20A à 1-20C compris). `stash@{0}` est conservé.

Aucun commit, push, déploiement ni service réel. Inchangés : pagination des
produits, paiements, dispatcher, cache des signatures.

## 1. Diagnostic

### Consommateurs de `GET /sales`

| Consommateur | Usage | 1-20E |
|---|---|---|
| Page Ventes (`/app/sales`) | **tout** l'historique, à chaque ouverture et à chaque événement `sale:*`, confirmation de vente locale (`syncedVersion`) et reconnexion | **adaptée** |
| Analyse, tableau de bord | agrégations serveur (`/analytics/*`), jamais `GET /sales` | inchangés |
| Exports mensuels | `ReportsModule` côté serveur (requêtes propres, mois complet) | inchangés, périmètre complet conservé |
| Fiche produit | `GET /products/:id` (ventes du produit) | inchangée |
| Ventes hors ligne | `POST /sales` (outbox) | inchangées |
| Alias `/sales` (web) | redirection vers `/app/sales` | inchangé |

### Calculs dans le navigateur

La page Ventes n'a **aucun filtre, aucune recherche, aucun total ni aucune
action**. Elle affiche la liste, triée par `createdAt` décroissant côté
serveur, avec le montant de chaque ligne (quantité × prix). Aucun total ni
aucune recherche ne pouvaient donc devenir faux. Le seul agrégat dont la
pagination a besoin, le nombre de ventes, est calculé par le serveur sur
tout le périmètre autorisé. Je n'ai pas ajouté de nouveaux filtres.

### Coût mesuré avant

En profil volumineux, le propriétaire de l'entreprise de 30 000 ventes
charge **12,7 Mo** par ouverture de page, en ≈ 1,8 s (p50). Le plan
MongoDB est l'index `{organizationId, productId, createdAt}`, inadapté sans
produit : **30 000 documents examinés et un tri en mémoire**.

## 2. Contrat API

`GET /sales/history` est une route **nouvelle et explicite**. `GET /sales`
est **conservé tel quel** pour les anciens clients ; je ne l'ai pas tronqué.

| Paramètre | Règle |
|---|---|
| `limit` | entier de 1 à **100**, défaut **20** |
| `cursor` | curseur opaque renvoyé par la page précédente (base64url de `[createdAt ISO, _id]`), au plus 200 caractères ; illisible → **400 `INVALID_SALES_CURSOR`** |
| `productId` | facultatif (filtre existant de `GET /sales`) |
| autre paramètre | **400** (`forbidNonWhitelisted`) |

Réponse : `{ items, total, nextCursor }`.
- `items` : même forme que `GET /sales` (vendeur et produit peuplés).
- `total` : nombre de ventes du périmètre filtré autorisé, jamais de la page.
- `nextCursor` : `null` sur la dernière page.

### Choix : pagination par curseur (clé `createdAt` puis `_id`, décroissants)

- **Coût constant** quelle que soit la profondeur, mesuré au § 6 : 22
  documents examinés, que la page soit à 1 000 ou à 25 000 ventes de la
  tête. Un `skip` parcourrait toutes les ventes précédentes.
- **Pages stables pendant la navigation.** Une vente ajoutée n'apparaît
  qu'en tête, jamais en doublon ni en saut sur les pages suivantes, ce
  qu'un décalage par numéro de page ne garantit pas.
- **Navigation.** Le parcours existant (une liste chronologique) n'a besoin
  que de « plus récentes / précédentes / plus anciennes ». Je n'ai pas
  offert de saut direct à une page numérotée.

### Règles appliquées côté serveur avant la pagination

- **Organisation** du contexte, comme toute route.
- **Permissions** : `sales.view_all` donne toute l'organisation,
  `sales.view_own` les ventes du demandeur seulement (pages **et total**),
  et sinon **403**.
- **Filtre produit** éventuel.
- **Tri déterministe** `createdAt: -1, _id: -1`.
- **Lecture bornée.** `limit + 1` documents au plus pour détecter la page
  suivante, et un comptage par index. Jamais tout l'historique en mémoire.
- **Annulations, dates, montants** : règles inchangées. Une vente annulée
  est supprimée : absente des pages comme du total. `createdAt` est la date
  d'enregistrement, comme pour l'ancien tri. Les montants sont ceux de
  l'ancien contrat.
- **Forme du filtre de curseur.** `createdAt ≤ curseur` sert de borne
  d'index, et `$or` (`createdAt < curseur` ou `_id < curseur`) fait le
  départage. Une première version, avec le seul `$or`, parcourait l'index
  depuis la tête : 1 022 documents à la page 50. Je l'ai corrigée avant les
  mesures finales.

### Index et migration

Deux index sont justifiés par les plans (§ 6) :
- `organizationId_1_createdAt_-1__id_-1` (`view_all`) ;
- `organizationId_1_sellerId_1_createdAt_-1__id_-1` (`view_own`).

La migration est idempotente, comme celles du dépôt :
`migrate:sale-history-indexes` (`create-sale-history-indexes.js`).
- Elle ne fait rien si les clés exactes existent.
- Elle n'écrase rien : MongoDB lève une erreur si un index homonyme existe
  avec d'autres options.
- Elle est ajoutée à la fin de `PREDEPLOY_MIGRATIONS`.

Les index ne sont **pas** déclarés dans le schéma (pas de construction par
`autoIndex`), et aucune vérification ne bloque le démarrage. Sans ces
index, la route reste **correcte**, seulement plus lente (tri en mémoire).

## 3. Web

**Navigation** (`/app/sales`) :
- page de 20 ventes et total serveur (« 3 504 ventes · page 2 ») ;
- boutons « Plus récentes / Précédentes / Plus anciennes » ;
- barre repliée sur mobile ; FR et EN.

**Mise à jour de la page affichée seulement** :
- **Événements** (`sale:created / updated / deleted`, de n'importe quelle
  session) : regroupés par `useLiveRefresh` (400 ms) ; jamais les autres
  pages ; le total se met à jour.
- **Vente locale confirmée** (`syncedVersion`) : relecture silencieuse de
  la page.
- **Reconnexion** : rattrapage par `useLiveRefresh`, sur la page courante,
  sans tout l'historique.

**Garanties de cohérence** :
- **Ventes ajoutées pendant la navigation.** Les pages suivantes ne
  changent pas : le curseur porte la position. Hors de la première page, un
  avis « De nouvelles ventes ont été enregistrées » propose de revenir aux
  plus récentes.
- **Page devenue vide** (annulations) : retour à la page précédente.
- **Réponses périmées** : ignorées. Une réponse n'est appliquée que si la
  vue n'a pas changé (session, organisation, périmètre `all`/`own`, page,
  curseur), et dans l'ordre des requêtes. Un changement de session, de
  permissions ou d'organisation revient à la page 1.
- **Changement de page** : l'indicateur de chargement est posé dans le même
  rendu, sans jamais afficher le numéro d'une page avec les ventes de la
  précédente. La recette navigateur a révélé et fait corriger ce défaut.

**Ventes locales en attente** : elles ne sont pas mélangées à cette liste,
avant comme après (lien « Ventes en attente sur cet appareil »). Une vente
synchronisée n'apparaît qu'une fois, par le serveur.

**Limites de cohérence** :
- Le total et la page sont deux lectures de la même requête HTTP (comptage
  et page en parallèle). Une vente enregistrée entre les deux peut décaler
  le total d'une unité jusqu'à la relecture suivante, déclenchée par son
  propre événement.
- La position exacte (« ventes 21 à 40 ») n'est pas affichée : elle
  changerait à chaque nouvelle vente.

## 4. Compatibilité

| Cas | Comportement vérifié |
|---|---|
| Ancien web, nouvelle API | `GET /sales` inchangé (e2e n° 11) : historique complet, comme avant |
| Nouveau web, ancienne API | l'ancienne API répond **404** sur `/sales/history` (vérifié à l'exécution sur l'API 1-20D, `compat-old-api.json`) → le web relit **l'ancien contrat complet**, présenté comme complet (« 3 000 ventes », sans pagination) : **aucun total faux, aucun historique tronqué présenté comme complet** |
| Échec d'une autre nature | message d'erreur et « Réessayer », comme avant ; aucune bascule silencieuse |

**Ordre de déploiement :**

1. **Migration en pré-déploiement** (`predeploy-migrations.js`, qui inclut
   `create-sale-history-indexes.js`), exécutée avant l'activation de la
   nouvelle version, comme les autres migrations d'index. L'API en service
   continue de fonctionner pendant la construction des index.
2. **Démarrage de la nouvelle API.**
3. **Web.**

Cas particuliers :

- **Web déployé avant l'API.** Correct : le web retombe sur l'ancien
  contrat complet (404), avec son coût, tant que la nouvelle API n'est pas
  démarrée.
- **Migration non exécutée.** Les pages restent correctes, mais
  l'historique trie en mémoire.
- **Anciens onglets.** Ils continuent d'appeler `GET /sales` jusqu'à leur
  rechargement. Ce coût est conservé et mesuré (§ 6, `legacy-on-new`).

**Retour arrière : web, puis API.** Les deux index peuvent rester en place :
l'API antérieure ne les utilise pas, mais ils restent compatibles avec elle.
Ils ont cependant un coût permanent :

- ils occupent du stockage ;
- ils sont entretenus à chaque création, modification ou suppression de
  vente.

Pour l'éviter, il faut les supprimer explicitement, en dehors de ce lot,
avec une opération dédiée et vérifiée (`dropIndex` des noms
`organizationId_1_createdAt_-1__id_-1` et
`organizationId_1_sellerId_1_createdAt_-1__id_-1`).

## 5. Vérifications

| Contrôle | Résultat |
|---|---|
| E2E `test/sales-history.e2e-spec.ts` (nouveau) | **12 / 12** |
| Unitaires `src/sales/sale-history.spec.ts` (nouveau : curseur aller-retour, 5 curseurs invalides, index) et `sales.controller.spec.ts` (+ 2 : périmètre `own` / `all`, limite par défaut) ; `src/sales`, `src/migrations`, `src/products` | **229 / 229** |
| Web : `tsc`, ESLint, `check-i18n` (FR/EN, 1 323 clés, 0 problème), `i18n:coverage` (0 texte en dur) | OK |
| API : `tsc` (build), ESLint, Prettier des fichiers touchés | OK |

Les 12 scénarios e2e :

1. page par défaut ;
2. parcours complet identique à `GET /sales`, à 7, 20 et 100 par page, avec
   6 ventes de **même date** ;
3. 8 paramètres invalides (400) ;
4. organisation vide ;
5. isolation entre organisations, y compris avec un curseur venant d'une
   autre organisation ;
6. `view_own`, pages et total ;
7. filtre produit ;
8. vente créée puis annulée pendant la navigation ;
9. dernière page vidée ;
10. plan d'index (≤ 21 documents, aucun tri en mémoire) ;
11. page éloignée : clés examinées bornées par la page ;
12. ancien contrat inchangé.

### Recette navigateur

Méthode :
- recette locale (web de production, API compilée) ;
- Chromium de Playwright, avec une installation existante, hors dépôt ;
- données : 25 ventes de l'administrateur, 22 du vendeur.

Résultat : **13 / 13**.

| # | Contrôle | Résultat |
|---|---|---|
| E1 | propriétaire, bureau, FR : « 47 ventes · page 1 », 20 ventes ; une seule requête `GET /sales/history` (8,3 Ko), jamais `GET /sales` | OK |
| E2 | page 2 : 20 autres ventes, aucune de la page 1, même total | OK |
| E3 | vente d'une autre session pendant la page 2 : total à 48 sans rechargement, page stable, avis « nouvelles ventes » | OK |
| E4 | « Voir les plus récentes » : la nouvelle vente est en tête | OK |
| E5–E6 | dernière page : 3 pages et 8 ventes, « Plus anciennes » désactivé ; retour à la page précédente | OK |
| E7, E12 | bureau 1 280 px et mobile 390 px : aucun défilement horizontal | OK |
| E8–E9 | vendeur restreint, mobile, **EN** : « 23 sales · page 1 », seulement ses ventes | OK |
| E10 | annulation par le propriétaire : total du vendeur à jour (22) | OK |
| E11 | navigation mobile (« Older ») | OK |

Captures : `sales-desktop-fr.png`, `sales-mobile-en.png`.

## 6. Mesures avant / après

### Conditions

- **Témoin.** État 1-20D. `make-baseline-dist.js` remplace
  `sales.controller.ts`, `sales.service.ts` et `predeploy-migrations.ts`
  par leur version 1-20D : ni la nouvelle route, ni les index. La page
  1-20D est simulée par `GET /sales`.
- **Nouveau code.** API 1-20E, index créés par les migrations de
  pré-déploiement. La page 1-20E est simulée par `GET /sales/history`
  (première page et total, une seule requête comme dans le navigateur).
- **Stack.** Neuve à chaque mesure, mêmes données déterministes, file vide,
  exécutions séquentielles ; k6 v2.3.0 à 1 itération/s/VU, 45 s par palier.
- **Profil standard.** Rôles mélangés sur les 6 entreprises (propriétaires,
  administrateurs, vendeurs `view_own`).
- **Profil volumineux.** Propriétaire de l'entreprise concentrée
  (`TARGET=concentrated ROLES=owner`, 30 000 ventes). Une première série
  volumineuse, sans ce ciblage, mesurait un vendeur d'une autre entreprise ;
  elle est écartée.
- **Mémoire libre au départ** : 427 à 1 284 Mo, la machine étant partagée.

### Chargement de la page, total compris

| Scénario | Variante | Reçu (45 s) | Latence p50 / p95 / max ms | CPU API (cœurs) | Boucle p99 méd. / max ms | RSS max | Lectures MongoDB (moy.) |
|---|---|---|---|---|---|---|---|
| standard, 1 VU | avant | 14,2 Mo | 62 / 118 / 174 | 0,10 | 21 / 92 | 152 Mo | 1,08 ms |
| | après | **0,39 Mo** | **13 / 19 / 30** | 0,03 | 17 / 27 | 128 Mo | 0,45 ms |
| standard, 5 VU | avant | 113 Mo | 291 / 408 / 513 | 0,48 | 111 / 221 | 216 Mo | 1,70 ms |
| | après | **1,96 Mo** | **37 / 72 / 90** | **0,08** | **17** / 34 | 131 Mo | 0,44 ms |
| volumineux, 1 VU | avant | 305 Mo (24 chargements) | 1 839 / 2 270 / 2 573 | **1,23** | **817 / 1 205** | 402 Mo | 13,96 ms |
| | après | **0,40 Mo** (45 chargements) | **19 / 28 / 48** | **0,04** | **17 / 26** | 132 Mo | 1,34 ms |

- **Volumineux, avant.** Le témoin ne tient pas le rythme demandé (24
  chargements sur 45) : chaque ouverture bloque la boucle événementielle
  0,8 à 1,2 s pour **tous** les utilisateurs du processus.
- **Gain.** Volume reçu − 97 à − 99,9 %, latence p95 divisée par 6 à 80,
  CPU de l'API − 70 à − 97 %.

### Pages éloignées (nouveau contrat, 1 VU)

| Profil | Parcours | `sales_page_far` p50 / p95 / max ms |
|---|---|---|
| standard (8 000 ventes au plus) | 25 pages suivantes par itération (150 pages) | 11 / 15 / 50 |
| volumineux (30 000 ventes) | 50 pages suivantes par itération (300 pages) | 19 / 27 / 40 |

Plans MongoDB (`sales-history-explain.js`, entreprise de 30 000 ventes) :

| Requête | Avant (1-20D) | Après (1-20E) |
|---|---|---|
| `GET /sales` (tout, propriétaire) | index produit, **tri en mémoire**, 30 000 documents, 191–247 ms | nouvel index, sans tri, 30 000 documents, 58–61 ms |
| première page (propriétaire / vendeur) | — | 21 documents, 0–1 ms |
| page à 1 000 ventes de la tête | — | **22** documents, 2 ms |
| page à 25 000 ventes de la tête | — | **22** documents, 3 ms |
| comptage (total) | — | 10–11 ms (index) |

### Coût de l'ancien contrat conservé (`legacy-on-new`)

Avec la nouvelle API, sur le profil volumineux à 1 VU,
`GET /sales` coûte toujours :
- **2 018 ms au p50** et 2 371 ms au p95 ;
- 293 Mo reçus ;
- 1,32 cœur de CPU, boucle événementielle à 1 033 ms.

Le nouvel index retire le tri en mémoire côté MongoDB (247 → 61 ms), mais
l'essentiel du coût reste Node : hydratation, `populate` et sérialisation
de 30 000 ventes.

**Le gain vient du nouveau web**, pas de l'ancien endpoint. Les anciens
onglets restent coûteux jusqu'à leur rechargement.

## 7. Limites

- **Navigation séquentielle.** Pas de saut direct vers une page numérotée,
  ni de « dernière page », ni de recherche ou de filtre dans l'interface
  (aucun n'existait).
- **Total et page.** Deux lectures de la même requête : un écart d'une
  vente est possible pendant une écriture concurrente, corrigé à la
  relecture suivante.
- **Comptage linéaire.** Il examine les clés d'index du périmètre :
  ≈ 11 ms pour 30 000 ventes, ce qui reste raisonnable à cette échelle.
- **Ancien contrat.** `GET /sales` reste complet, pour la compatibilité.
  Son retrait éventuel, une fois tous les clients à jour, relève d'un autre
  lot.
- **Tri.** Toujours par date d'enregistrement (`createdAt`), comme avant,
  et non par date réelle de vente (`occurredAt`, ventes hors ligne).

## 8. Reproduire

```bash
pnpm --filter api build
node api/test/load/make-baseline-dist.js --ref=57b1145 \
  --files=src/sales/sales.controller.ts,src/sales/sales.service.ts,src/migrations/predeploy-migrations.ts
for p in current large; do
  for v in baseline new; do
    K6=<k6.exe> OUT=<dossier> bash api/test/load/compare-1-20e.sh $p $v
  done
done
K6=<k6.exe> OUT=<dossier> bash api/test/load/compare-1-20e.sh large legacy-on-new
rm -rf api/.load-dist-1-20a-baseline
```

Preuves : `docs/architecture/phase-1-20e-evidence/` (25 fichiers, 218 Ko) :
- paliers, pages éloignées et plans par mesure ;
- conditions ;
- `browser-recipe.json` et deux captures ;
- `compat-old-api.json`.

Les séries brutes, les synthèses k6 et le script de recette restent hors du
dépôt.

## 9. Fichiers

- **API** :
  - `src/sales/sale-history.ts` (nouveau : curseur, index, `ensure`) ;
  - `src/sales/dto/sales-history-query.dto.ts` (nouveau) ;
  - `src/sales/sales.service.ts` (`findHistoryPage`) ;
  - `src/sales/sales.controller.ts` (`GET /sales/history`) ;
  - `src/migrations/create-sale-history-indexes.ts` (nouveau) ;
  - `src/migrations/predeploy-migrations.ts` ;
  - `package.json` (`migrate:sale-history-indexes`).
- **Web** :
  - `src/app/app/sales/page.tsx` ;
  - `src/lib/api.ts` (`fetchSalesPage`, `SALES_PAGE_SIZE`) ;
  - `src/i18n/resources/{fr,en}/sales.ts`.
- **Tests** :
  - `api/test/sales-history.e2e-spec.ts` (nouveau) ;
  - `api/src/sales/sale-history.spec.ts` (nouveau) ;
  - `api/src/sales/sales.controller.spec.ts`.
- **Outils** :
  - `api/test/load/compare-1-20e.sh` et `sales-history-explain.js`
    (nouveaux) ;
  - `k6/stockmaster.js` (scénario `salespage`, `ROLES`) ;
  - `run-campaign.js` (volume reçu) ;
  - `README.md`.
- **Preuves** : `docs/architecture/phase-1-20e-evidence/` (nouveau).

Nettoyage : stacks de charge, recette locale, leur répertoire d'état, copie
web et témoin `api/.load-dist-1-20a-baseline` supprimés. Le MongoDB de
développement (port 27018) et les processus préexistants n'ont pas été
touchés.
