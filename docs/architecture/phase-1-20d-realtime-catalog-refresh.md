# Lot 1-20D — Relectures du catalogue après les ventes

État : **implémenté, testé et mesuré localement**, non commité, sur
`perf/phase-1-20d-realtime-catalog-refresh`. La branche part de `02715d4`
(1-20A à 1-20C commités, 1-20B compris). `stash@{0}` est conservé.

Aucun commit, push, déploiement ni service réel. Inchangés : pagination,
dispatcher, cache de signatures.

## 1. Diagnostic : parcours réel

| Étape | Avant (1-20C) |
|---|---|
| Serveur | création, modification, annulation → `sale:created / sale:updated / sale:deleted` vers toute la room de l'entreprise, avec `{ _id, productId }` seulement. Aucun `product:updated` sur une vente. Une modification ne peut pas changer de produit (`UpdateSaleDto` : quantité et prix) : ancien et nouveau produit sont le même. |
| Liste d'un rayon (`/app/catalog/[id]`, `useProducts`) | vente d'un produit affiché → relecture **complète** du rayon (`GET /products?sectionId=`), regroupée 400 ms et sérialisée (`useLiveRefresh`) |
| Auteur de la vente, même liste | **deux** relectures complètes : immédiate et **non silencieuse** (`syncedVersion`, indicateur de chargement), puis celle du signal `sale:created`, qu'il reçoit aussi |
| Fiche produit (`/app/catalog/products/[id]`) | signal du produit → `GET /products/:id` (fiche avec tout l'historique du produit). L'auteur la relisait **deux fois** (`onSaleRecorded={reload}` + signal) |
| Page des rayons (`/app/catalog`) | aucune liste de produits, aucune relecture sur une vente |
| Hors catalogue (hors périmètre) | la page Ventes relit `GET /sales` complet et la page Analyse ses indicateurs, à chaque vente |

Correction de 1-20A : la sonde temps réel de 1-20A relisait le catalogue
**entier** pour chaque vente et chaque socket. Le web ne relit que le
**rayon affiché**, et seulement si le produit vendu y figure. La
comparaison ci-dessous simule le vrai comportement, vérifié dans le
navigateur (§ 4).

## 2. Stratégie retenue : relecture ciblée regroupée

Je n'ai pas retenu un calcul « stock − quantité » à partir des événements.
Il serait fragile face aux doublons et au désordre, et les agrégats
réservés (chiffre d'affaires, unités vendues) dépendent des permissions de
chaque lecteur. Le serveur reste la source de vérité.

**API.** `GET /products` accepte un paramètre facultatif `ids` :
- jusqu'à 50 identifiants, séparés par des virgules et dédoublonnés ;
- **400** si le paramètre est vide, invalide, répété ou trop long ;
- même filtre que la liste : organisation du demandeur, produits actifs,
  rayon éventuel ;
- même projection selon ses permissions ;
- un produit absent de la réponse n'est plus visible dans cette vue.

**Web** (`useProducts`, pur dans `lib/catalog-refresh.ts`) :

- **Signal de vente.** Le produit concerné est ajouté à un ensemble en
  attente, et une relecture regroupée est demandée (`useLiveRefresh`
  existant : fenêtre de 400 ms jamais repoussée, une seule requête à la
  fois par liste). La relecture lit **ensemble** les produits en attente :
  une requête par fenêtre, jamais une par produit.
- **Relecture complète** (`planRefresh`) dans ces cas :
  - signaux produit (création, modification), comme avant ;
  - renouvellement d'une photo expirée ;
  - **rattrapage après reconnexion** (les événements manqués sont
    inconnus) ;
  - aucun produit désigné ;
  - plus de 50 produits.
- **Ordre des réponses, par produit.**
  - Une réponse ciblée plus ancienne n'écrase ni une plus récente, ni une
    liste complète plus récente.
  - Une liste complète plus ancienne n'écrase pas un produit relu depuis,
    et ne réintroduit pas un produit que la relecture ciblée a retiré.
  - Un produit retiré localement pendant la requête n'est jamais réinséré.
- **Remplacement complet du produit.** Un champ retiré de la projection
  (permission perdue) disparaît.
- **Stock indicatif** (ventes hors ligne, 1-11C.3). Chaque produit garde la
  date de sa dernière lecture serveur (`serverLoadedAtFor`). Une vente
  locale confirmée n'est donc ni comptée deux fois, ni oubliée.
- **Auteur de la vente.** La confirmation (`syncedVersion`) relit, de façon
  ciblée et regroupée avec le signal, les seuls produits affichés dont une
  vente confirmée n'est pas encore incluse dans leur lecture. L'indicateur
  de chargement disparaît.
- **Fiche produit.** `onSaleRecorded` rejoint le regroupement : une seule
  relecture de la fiche au lieu de deux.
- **Session révolue.** Aucune réponse d'une session précédente
  (`sessionVersion`) n'est appliquée.
- **Organisation.** L'interface ne permet pas d'en changer sans se
  déconnecter, ce qui démonte `/app`.

## 3. Compatibilité

| Cas | Comportement |
|---|---|
| Ancien onglet (web 1-20C) face à la nouvelle API | inchangé : il ne dit rien de `ids` et relit tout comme avant ; le contrat des événements n'est pas modifié |
| Nouveau web face à l'ancienne API (déploiement web avant API) | l'API ignore `ids` et renvoie la liste complète du rayon ; le web ne fusionne que les produits demandés : **résultat correct**, au coût d'une relecture complète (testé : « ancienne API ») |
| Repli vers une relecture complète | rattrapage, signaux produit, photo expirée, plus de 50 produits, ou (sans boucle) relecture ciblée en échec, les produits étant redemandés à la relecture suivante |

**Ordre de déploiement : API, puis web.** L'ordre inverse reste correct,
mais ne réduit rien tant que l'API n'est pas déployée.

**Retour arrière** : web, puis API (ou les deux). Aucune donnée n'est
concernée.

## 4. Vérification

### Tests

| Contrôle | Résultat |
|---|---|
| `web/scripts/test-catalog-refresh.mjs` (nouveau, `node:test`, 13 cas) — `pnpm --filter web test:catalog-refresh` | **13 / 13** : remplacement ciblé, remplacement complet (champ retiré), réponses désordonnées, liste ancienne contre relecture plus récente, liste plus récente faisant foi, liste périmée, produit retiré jamais réintroduit, ancienne API, produit retiré localement, doublons, bornes du plan, rafale de 10 ventes (relectures regroupées, aucune complète), rattrapage complet après reconnexion |
| Tests web existants (`test:coordinator`, `test:image-renewal`) | 6 / 6 et 6 / 6 |
| API unitaires `src/products`, `src/sales` | **220 / 220** (cas `ids` du contrôleur et du service ajoutés) |
| E2E `product-field-permissions` (+ 4 cas `ids`) | **23 / 23**, dont : |
| — projection | **identique** à la liste pour chaque niveau de permission ; aucun champ restreint pour le vendeur standard |
| — autre organisation | **liste vide**, aucune fuite d'existence |
| — rayon | le filtre de la vue s'applique |
| — paramètre invalide ou trop long | 400 |
| Web `tsc`, ESLint, Prettier ; API `tsc`, ESLint, Prettier | OK |

### Recette navigateur

Méthode :
- recette locale (`recipe.js start`, web de production et API compilée du
  nouveau code) ;
- Chromium de Playwright, avec une installation existante, hors dépôt ;
- deux sessions de la même entreprise sur un rayon de deux produits :
  A, vendeur, et B, propriétaire ;
- requêtes catalogue enregistrées.

Résultat : **12 / 12**.

| # | Contrôle | Résultat |
|---|---|---|
| R1 | vente par l'interface dans A → B voit 18 sans rechargement (591 ms) ; B : **1 relecture ciblée**, 0 complète ; A (auteur) : **1 relecture ciblée** (confirmation et signal regroupés), 0 complète | OK |
| R2 | rafale de 3 ventes sur deux produits → stocks finaux exacts chez B ; **une** relecture ciblée des deux produits | OK |
| R3 | annulation par le propriétaire → stock restauré chez A et B ; relecture ciblée seulement | OK |
| R4 | B hors ligne, deux ventes manquées, retour en ligne → **une** relecture complète (rattrapage), stocks exacts | OK |
| R5 | état final : A et B affichent le stock serveur | OK |

Ce comportement observé dans le navigateur (une requête regroupée par
fenêtre et par liste, rattrapage complet à la reconnexion) est celui que
simule la sonde `targeted`.

## 5. Comparaison avant / après

### Conditions

- **Témoin.** État 1-20C (1-20B compris). Côté API,
  `make-baseline-dist.js --files=…products.controller.ts,…products.service.ts`
  (sans `ids`, avec le cache de signatures 1-20C). Côté web, comportement
  1-20C simulé (`legacy`).
- **Nouveau code.** API 1-20D et web 1-20D simulé (`targeted`).
- **Simulateur.** `catalog-refresh-probe.js` : vrai client Socket.IO,
  origine web autorisée.
  - Chaque client affiche le premier rayon de son entreprise, et les ventes
    portent sur ses produits : **chaque vente concerne tous les clients de
    l'entreprise** (cas défavorable).
  - Chargement initial de chaque client avant la mesure, ce qui préchauffe
    le cache de signatures de façon identique.
- **Stack.** Neuve à chaque mesure, mêmes données (profil `current`), file
  vide, exécutions séquentielles.
- **Durées.** 30 s de ventes à 2 /s, fin bornée (≤ 15 s de repos).
- **Mémoire libre au départ** : 537 / 458 Mo (20 clients) et 458 / 557 Mo
  (120 clients). La machine est partagée.

### Résultats

| Scénario | Variante | Lectures complètes / ciblées | Octets reçus | CPU API (cœurs) | Boucle p99 méd. / max ms | Vente HTTP p50 / p95 ms | Vente → stock à jour chez le lecteur p50 / p95 ms | Stock final faux |
|---|---|---|---|---|---|---|---|---|
| 20 clients | avant | 354 / 0 | 6,0 Mo | 0,23 | 24 / 64 | 23 / 48 | 439 / 454 | 0 / 440 |
| | après | **0 / 290** | **0,23 Mo** | 0,17 | 24 / 69 | 25 / 51 | 435 / 451 | **0 / 440** |
| 120 clients | avant | 1 255 / 0 | 24,2 Mo | 0,48 | 24 / 98 | 58 / 270 | 540 / 685 | 0 / 2 910 |
| | après | **0 / 1 260** | **1,06 Mo** | 0,39 | 24 / 214 | **25 / 182** | 542 / **608** | **0 / 2 910** |

Ce qui change :

- **Lectures complètes** : supprimées sur ce parcours.
- **Nombre de requêtes** : inchangé, une par client et par fenêtre de
  regroupement, mais chacune ne porte que les produits vendus.
- **Volume transféré** : **− 96 %** dans les deux scénarios.
- **CPU de l'API** : − 19 à − 26 %.
- **Latence des ventes à 120 clients** : p50 de 58 à 25 ms, p95 de 270 à
  182 ms.

Ce qui ne change pas :

- **Délai d'affichage.** Il reste dominé par la fenêtre de regroupement de
  400 ms (inchangée). **Aucun gain n'est obtenu en retardant l'affichage.**
- **Exactitude.** Le stock final est exact partout, et l'intégrité est OK
  après les quatre mesures (stock, audit, notifications, vidange).
- **Refus.** 5 ventes sur 60 environ sont refusées (400) dans les deux
  variantes : le rayon contient les produits « Contention » du jeu de test,
  dont le stock est de 1. Ce sont des refus métier attendus.

**Le gain CPU est modeste.** Depuis 1-20C, la liste d'un rayon (≈ 20
produits) est déjà peu coûteuse. Le scénario problématique de 1-20A
(saturation, ventes à 30 s au p95) venait de la relecture du catalogue
**entier** sans cache de signatures. Le cache 1-20C et le comportement réel
du web l'avaient déjà levé. 1-20D retire les relectures complètes
restantes et leur volume.

**Le retard de boucle maximal à 120 clients est plus élevé** (214 contre
98 ms, un échantillon). La médiane est la même (24 ms). La mesure est
unique et ce pic n'a pas été expliqué.

## 6. Limites

- **Hors catalogue.** La page Ventes (`GET /sales` complet) et la page
  Analyse relisent toujours tout à chaque vente. Elles relèvent de la
  pagination et d'un lot séparé.
- **Fiche produit.** Elle relit toujours la fiche entière, historique
  compris, une fois par fenêtre.
- **Signaux produit.** Création, modification et photo restent des
  relectures complètes : comportement inchangé, hors périmètre.
- **Ventes concernant beaucoup de produits.** Au-delà de 50 produits dans
  une fenêtre, la relecture redevient complète.
- **Reconnexion.** Le rattrapage reste une relecture complète par liste
  montée, faute de journal d'événements.
- **Relecture ciblée en échec.** Ses produits ne sont relus qu'au signal
  suivant ou à la reconnexion. C'est le même comportement qu'une relecture
  complète silencieuse en échec.
- **Simulateur.** Il reproduit les requêtes observées dans le navigateur,
  mais ni le rendu, ni plusieurs listes montées dans un même onglet.

## 7. Reproduire

```bash
pnpm --filter api build
node api/test/load/make-baseline-dist.js --ref=02715d4 \
  --files=src/products/products.controller.ts,src/products/products.service.ts
for c in 20 120; do
  for v in baseline new; do
    OUT=<dossier> bash api/test/load/compare-1-20d.sh $c $v
  done
done
rm -rf api/.load-dist-1-20a-baseline
pnpm --filter web test:catalog-refresh
```

Preuves synthétiques : `docs/architecture/phase-1-20d-evidence/`, soit 13
fichiers (60 Ko) :
- `probe.json`, `integrity.json` et `conditions.txt` pour chacune des 4
  mesures ;
- `browser-recipe.json` (recette navigateur).

Le script de la recette navigateur, les journaux et les séries brutes
restent hors du dépôt.

## 8. Fichiers

- **API** :
  - `src/products/products.controller.ts` (`ids`, `parseProductIds`,
    `PRODUCT_IDS_MAX`) ;
  - `src/products/products.service.ts` (filtre `_id`).
- **Web** :
  - `src/lib/catalog-refresh.ts` (nouveau) ;
  - `src/hooks/use-products.ts` ;
  - `src/hooks/use-live-refresh.ts` (rattrapage signalé) ;
  - `src/hooks/use-sale-invalidation.ts` (produit transmis) ;
  - `src/lib/api.ts` (`fetchProductsByIds`) ;
  - `src/app/app/catalog/[id]/page.tsx` ;
  - `src/app/app/catalog/products/[id]/page.tsx`.
- **Tests** :
  - `api/src/products/products.controller.spec.ts`,
    `api/src/products/products.service.spec.ts` ;
  - `api/test/product-field-permissions.e2e-spec.ts` ;
  - `web/scripts/test-catalog-refresh.mjs` (nouveau) et son script dans
    `web/package.json`.
- **Outils** :
  - `api/test/load/catalog-refresh-probe.js` et
    `api/test/load/compare-1-20d.sh` (nouveaux) ;
  - `README.md`.
- **Preuves** : `docs/architecture/phase-1-20d-evidence/` (nouveau).

Nettoyage : les stacks de charge et la recette locale ont été arrêtées, et
leur répertoire d'état, la copie web de la recette et le témoin
`api/.load-dist-1-20a-baseline` ont été supprimés. Le MongoDB de
développement (port 27018) et les processus préexistants n'ont pas été
touchés.
