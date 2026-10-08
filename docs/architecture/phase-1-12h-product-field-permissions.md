# Phase 1-12H — Permissions et visibilité des informations produit

Branche `architecture/phase-1-12h-product-field-permissions`, base `a6edefc` (1-12G). Aucun commit, aucun push, aucun déploiement. **Aucun accès à Atlas, Supabase ni au port hôte 27017 ; aucune donnée réelle** : tests sur `MongoMemoryReplSet` éphémère. Aucun paquet ajouté ni mis à jour (manifestes et lockfile inchangés, audit non relancé). Stash existant non touché.

## Décisions

| Sujet | Décision |
| --- | --- |
| Droits standard | `sales.record` et `sales.view_own` ajoutés par `effectivePermissions` à **tout** membre, quel que soit son rôle ; non retirables ; aucune migration |
| Nouvelles clés | `products.view_stock_details` (« Voir le détail du stock ») et `products.view_financials` (« Voir les coûts et résultats financiers ») |
| Administrateur | Droits complets et non réductibles (union rôle ∪ supplémentaires, inchangée) : cases cochées et verrouillées ; permissions envoyées `[]` |
| Projection | Module unique `api/src/products/product-projection.ts` ; un champ interdit est **absent** (jamais 0) |
| Agrégats | CA réel = agrégat serveur de **toutes** les ventes du produit dans l'organisation, indépendant du vendeur connecté |
| Diffusions | `product:*` : champs standard seuls ; `sale:created`, `sale:updated`, `sale:deleted` : `{ _id, productId }` |
| Actualisation (correctif) | Toute vente créée, modifiée ou supprimée invalide le produit affiché (cartes et fiche) : rechargement silencieux via l'API, regroupé, jamais hors ligne |
| Hors ligne | Snapshot v3 (standard seul) ; v2 invalidé par le mécanisme de version ; outbox jamais touchée |

## 1. Audit

- **Permissions** : `permissions.ts` (source unique) ; `effectivePermissions` = rôle ∪ `membership.permissions` ; `DEFAULT_PERMISSIONS_BY_ROLE` : owner/admin = toutes les délégables, seller = `sales.record` + `sales.view_own`. Contexte résolu uniquement pour une membership **active** dans une organisation **active** (`resolveActiveContext`, `OrganizationGuard`), jamais depuis `User.role`.
- **Produit** : `GET /products` et `GET /products/:id` renvoyaient le document Mongoose brut (`purchasePrice`, `initialQuantity`, `organizationId`, `__v`) et toutes les métriques à tout membre. `POST`, `DELETE`, `PATCH …/restore`, `DELETE …/permanent` et `/trash` renvoyaient aussi le document brut.
- **Socket.IO** : `product:created` (document brut), `product:updated` (document + métriques) et `sale:created` (vente peuplée : prix, vendeur, **acheteur et coordonnées**) diffusés à toute la room de l'organisation. `sale:created` n'avait aucun consommateur web.
- **Web** : fiche (9 métriques sans condition), carte (achat, stock « restant / initial », vendus, bénéfice **estimé**), modal et carte hors ligne (achat, stock initial), dialogue de modification (prix d'achat prérempli, « Vendu : 0 » par défaut), corbeille (prix d'achat).
- **Hors ligne** : snapshot IndexedDB v2 persistant `purchasePrice` et `initialQuantity`.
- **Audit (`audit.read`)** : les détails d'historique contiennent `purchasePrice`, `initialQuantity`, `added`.

### Diagnostic du complément (CA, bénéfice, marge faux)

`ProductsService.findOne` calculait `actualRevenue` en sommant la liste `sales` **déjà filtrée par le scope de l'historique** : `own` = uniquement les ventes du vendeur connecté. `actualProfit` retranchait ensuite `purchasePrice × unitsSold`, où `unitsSold` est une valeur **produit** (stock initial − stock restant). Pour un vendeur sans `sales.view_all`, le CA ne couvrait que ses ventes, le bénéfice mélangeait un CA partiel et des coûts globaux, et la marge était fausse. « Unités vendues » n'en dépendait pas (calcul par le stock). Les cartes affichaient une autre valeur, le « bénéfice estimé » (prix cible × vendus).

## 2. Matrice finale

| Information | Standard (tout membre) | `products.view_stock_details` | `products.view_financials` |
| --- | :---: | :---: | :---: |
| Nom, statut, prix de vente cible | ✓ | ✓ | ✓ |
| Stock restant (et stock indicatif hors ligne) | ✓ | ✓ | ✓ |
| Stock initial, unités vendues | | ✓ | |
| Prix d'achat unitaire, coût total d'achat | | | ✓ |
| CA réel, bénéfice réel, marge | | | ✓ |

| Rôle / délégation | Standard | Détail du stock | Finances |
| --- | :---: | :---: | :---: |
| Propriétaire | ✓ | ✓ | ✓ |
| Administrateur (droits complets) | ✓ | ✓ | ✓ |
| Vendeur sans délégation | ✓ | | |
| Vendeur + une ou deux permissions | ✓ | selon délégation | selon délégation |

Droits standard de tout membre actif : `sales.record`, `sales.view_own`. Jamais `sales.view_all`. Les deux permissions produit n'accordent ni `analytics.read`, ni `sales.view_all`, ni aucun droit de modification (testé). L'anti-escalade existante (`isPermissionSubset`) s'applique aux nouvelles clés : un vendeur `members.invite` ne peut accorder que ce qu'il possède.

**Administrateur** : `DEFAULT_PERMISSIONS_BY_ROLE.admin` contient toutes les délégables, nouvelles clés comprises, et l'union ne peut pas être réduite par `membership.permissions`. Dans les dialogues d'invitation et d'édition, le choix « Administrateur » affiche toutes les cases supplémentaires cochées et verrouillées, et envoie `permissions: []` (droits portés par le rôle). La sélection « Vendeur » est un état séparé, initialisé une fois et conservé lors d'un aller-retour Administrateur → Vendeur. Les cases « Enregistrer des ventes » et « Voir ses propres ventes » ne sont plus proposées. Les valeurs historiques stockées restent acceptées par l'API, sans effet.

## 3. Projections API et Socket.IO

`product-projection.ts` : `productVisibility(context)`, `toProductView` (allowlist : `_id`, `sectionId`, `name`, `imageUrl`, `salePrice`, `remainingQuantity`, `deletedAt`, `createdAt`, `updatedAt`, plus `initialQuantity` et `purchasePrice` selon les droits), `toProductMetricsView` (enveloppe `{ product, status, … }`), `projectAuditDetails`.

| Réponse | Projection |
| --- | --- |
| `GET /products`, `GET /products/:id`, `PATCH /products/:id` | Enveloppe `{ product, status, [unitsSold], [totalPurchaseCost, actualRevenue, actualProfit, margin] }` |
| `POST /products`, `DELETE /products/:id`, `PATCH …/restore`, `DELETE …/permanent`, `GET /trash` | Produit plat projeté |
| Historique d'audit de la fiche | `purchasePrice` retiré sans finances ; `initialQuantity`/`added` retirés sans détail du stock |
| `product:created`, `product:updated` | Enveloppe **standard** `{ product, status }`, quel que soit l'émetteur |
| `sale:created` | `{ _id, productId }` : jamais prix, vendeur, acheteur ni coordonnées |
| `sale:updated`, `sale:deleted` (correctif) | **Nouveaux**, même payload `{ _id, productId }`, émis **après commit** (best effort, aucun événement si la transaction échoue ou si la vente est introuvable) |
| `product:deleted` | Identifiant (inchangé) |

Temps réel conservé : le client fusionne les champs standard reçus. Un membre qui voit davantage relance ensuite un chargement **silencieux** via l'API autorisée (300 ms, sans état « Chargement… »).

**Correctif — actualisation après les ventes des collègues.** Avant, `sale:created` n'avait aucun consommateur et la modification ou la suppression d'une vente n'émettait rien : les cartes et la fiche d'un collègue restaient figées jusqu'au rechargement. Désormais :
- API : `sale:updated` et `sale:deleted` émis après commit, avec le même payload minimal que `sale:created` ;
- web : hook partagé `useSaleInvalidation` (`web/src/hooks/use-sale-invalidation.ts`) abonné aux trois événements. Il filtre sur les produits affichés et regroupe les événements rapprochés (400 ms, **un** rechargement). Il ne déclenche rien hors ligne (le socket y est déjà fermé, et `navigator.onLine` est revérifié au déclenchement) ;
- `useProducts` (cartes du catalogue) et la fiche produit rechargent **silencieusement** via l'API. L'API réapplique les permissions : stock restant pour tous, agrégats seulement avec `products.view_financials`, historique toujours scopé `own`/`all` ;
- aucune écriture : l'outbox et l'état de synchronisation des ventes locales ne sont jamais touchés.

**Agrégats** (`actualRevenueByProduct`) : un seul `$match { organizationId, productId ∈ ids }` + `$group Σ(salePrice × quantity)`, lu seulement pour `products.view_financials`, jamais sur une liste filtrée ou paginée. Formules conservées (1-7B) :
- CA réel = Σ prix **effectivement appliqués** × quantités ;
- bénéfice réel = CA réel − prix d'achat unitaire **courant** × unités vendues ;
- marge = bénéfice réel / CA réel × 100 (`null`, affichée « — », sans CA) ;
- coût total d'achat = prix d'achat × stock initial ;
- unités vendues = stock initial − stock restant.

Une vente modifiée compte avec ses valeurs courantes ; une vente supprimée (suppression physique, stock restauré) n'est plus comptée. Les ventes d'autres organisations sont exclues par `organizationId`.

`estimatedRevenue`/`estimatedProfit` ne sont plus renvoyés : la carte affiche désormais le **bénéfice réel**, calculé à la même source que la fiche, au lieu d'une estimation sur le prix cible.

**Web** : `web/src/lib/product-info.ts` est la source unique de rendu (fiche, cartes, modal hors ligne). Un champ n'est rendu que s'il est présent dans la réponse. Types rendus optionnels. Dialogue de modification : prix d'achat proposé seulement s'il est visible, « Vendu » seulement s'il est présent. Corbeille : prix d'achat conditionnel.

## 4. Catalogue hors ligne

- `OFFLINE_CATALOG_SCHEMA_VERSION` 2 → **3** ; allowlist : `_id`, `sectionId`, `name`, `salePrice`, `remainingQuantity`, `status`. `toOfflineCatalogProduct` recopie défensivement vers l'allowlist à l'écriture.
- Un snapshot v2 (pouvant contenir `purchasePrice`/`initialQuantity`) échoue `isSnapshotUsable` : il est purgé à la lecture et remplacé à l'écriture.
- Hors ligne, les deux permissions ne sont jamais supposées : seules les informations standard sont affichées, même pour un membre autorisé en ligne. Navigation interne, stock indicatif et ventes en attente sont inchangés.
- L'outbox (`stockmaster-offline-sales-outbox`, base distincte) n'est jamais touchée. Aucun cache de rôles ou de permissions ajouté.

## 5. Tests

**Unitaires (API)** : 30 tests nets ajoutés.
- `permissions.spec.ts` (nouveau) : droits standard pour owner, admin, seller et un rôle hors table ; liste client incapable de les retirer ; pas de `sales.view_all` ; groupes produit par défaut (owner/admin) ; aucune dérivation vers `analytics.read`, `sales.view_all` ou des droits de modification ; anti-escalade.
- `product-projection.spec.ts` (nouveau) : clés **exactes** pour les 4 combinaisons ; formules ; marge `null`.
- `products.service.spec.ts` : scope `own` + finances → CA = agrégat (9 000) alors que l'historique ne contient que 2 × 1 500 ; pipeline sans `sellerId` ; sans finances → aucune lecture d'agrégat, clés absentes ; détail du stock seul ; audit projeté ; liste = un seul agrégat ; diffusions create/update/restore sans champ restreint.
- `products.controller.spec.ts` : visibilité transmise pour chaque profil ; rôle hors table → scope `own` (droits standard).
- Adaptés : 14 permissions, `sale:created` minimal, visibilité passée à la corbeille ; le test « ni view_own ni view_all → 403 » est remplacé par la règle standard.

**E2E (API)** : `test/product-field-permissions.e2e-spec.ts` (nouveau, 17 tests) :
- droits standard d'une membership sans permission stockée ; **membership suspendue refusée** (vente et liste) ; édition `permissions: [...]` sans perte des droits standard ;
- **régression du complément** : A 2 × 1 500, B (finances) 3 × 2 000, plus une vente **forgée d'une autre organisation** sur le même `productId` (7 × 99 999, ignorée) → propriétaire et vendeur B : CA **9 000**, bénéfice 4 000, marge 44,4 %, identiques à la liste ; B ne voit que sa vente ; A sans agrégats ;
- modification (prix de A 1 500 → 1 000) → 8 000 ; suppression de la vente de B → 2 000, unités vendues 2 ;
- corbeille projetée ; Socket.IO réel : `product:updated` = `{ product, status }` standard, `sale:created` = `{ _id, productId }` ;
- invitation avec finances → acceptation → contexte conforme ; anti-escalade 403 ; clé inconnue 400 ; accorder puis retirer le détail du stock.

**Correctif (actualisation)** :
- unitaires : `sale:updated`/`sale:deleted` émis une fois, payload exact `{ _id, productId }`, **après** la fin de session ; aucun événement si l'audit échoue (rollback) ;
- e2e (2 tests ajoutés à la suite 1-12H, Socket.IO réel) : un collègue reçoit `sale:updated` puis `sale:deleted` avec les identifiants seuls ; CA rechargé −1 000 puis −3 000 ; l'historique de B ne contient jamais la vente de A ; aucune émission sur 404 (vente d'un autre vendeur).

`sales-transaction.e2e-spec.ts` : assertions `sale:created` alignées sur le payload minimal. Ventes idempotentes (`sales-idempotency.e2e-spec.ts`) : inchangées, vertes.

**Playwright** (temporaire hors dépôt ; API compilée sur `MongoMemoryReplSet` :4100 ; `next build` + `next start` :3100) : **9/9, deux exécutions consécutives**, couvrant les 10 scénarios (achat 777, initial 37, ventes 2 × 1 500 + 3 × 2 000 + 1 × 1 850) :

| # | Résultat observé |
| --- | --- |
| 1, 2 | Invitation et édition : « Administrateur » → toutes les cases (12) cochées et verrouillées, retour « Vendeur » = sélection conservée ; POST admin `{ role: "admin", permissions: [] }` ; « Enregistrer des ventes » / « Voir ses propres ventes » absents des deux dialogues |
| 3 | Vendeur standard : carte et fiche « Prix de vente cible 1 800 FCFA », « Stock restant 32 », sa vente 3 000 FCFA ; DOM (`page.content()`, attributs compris) sans aucun libellé ni valeur restreinte, sans la vente ni l'acheteur du collègue ; **réponses réseau** `/products*`, `/sales` sans aucune clé restreinte ; **frames Socket.IO** : `product:updated` standard (prix cible mis à jour en direct : 1 850 FCFA), `sale:created` = `_id`, `productId` |
| 4 | Détail du stock : « Stock initial 37 », « Unités vendues 6 » (tous vendeurs), aucune donnée financière dans le DOM ni les réponses |
| 5 | Finances : prix d'achat 777, coût total 28 749, **CA réel 10 850**, bénéfice 6 188, marge 57,0 % ; une seule vente listée (la sienne) ; pas de détail du stock ; carte « Bénéfice réel 6 188 FCFA » |
| 6 | Deux groupes : tout visible ; agrégats identiques à ceux du propriétaire |
| 7 | Finances accordées → rechargement : « CA réel 10 850 FCFA » ; retirées → absentes ; « Enregistrer une vente » toujours disponible |
| 8 | Invitation UI avec finances → lien → compte créé → connexion : finances visibles, pas de détail du stock ; contexte `sales.record`, `sales.view_own`, `products.view_financials` sans `sales.view_all` ni `analytics.read` |
| 9 | Hors ligne : carte et modal « Prix de vente cible 1 850 FCFA », « Stock indicatif 30 » (vente en attente) ; aucun prix d'achat, stock initial ni agrégat, y compris pour un membre autorisé en ligne |
| 10 | Snapshot v2 injecté avec `purchasePrice`/`initialQuantity` → purgé à la lecture hors ligne ; nouveau snapshot v3 (6 clés) ; opération d'outbox identique avant/après (même `clientOperationId`, `pending`) |

**Playwright — correctif, deux utilisateurs** (même stack, `refresh.e2e.js` hors dépôt) : **6/6, deux exécutions consécutives**. Produit : achat 777, initial 37 ; B (finances) a une vente de 1 × 2 000.

| # | Résultat observé |
| --- | --- |
| 1, 2 | A vend 2 × 1 500 (avec coordonnées acheteur) → sans rechargement de page, « Stock restant » passe de 36 à **34** sur la fiche de B (finances), sur les cartes et sur la fiche de B (standard) |
| 3 | B (finances) : « CA réel » 2 000 → **5 000 FCFA**, bénéfice **2 669 FCFA** (5 000 − 777 × 3) ; historique = sa seule vente (réponse rechargée : un seul `_id`) ; ni vente, ni acheteur, ni coordonnées de A |
| 4 | B (standard) : aucun libellé ni valeur financière dans le DOM ; réponses rechargées sans aucune clé financière ; tous les événements de vente reçus = exactement `_id`, `productId` |
| 5 | A modifie (1 500 → 1 000) → CA **4 000** ; A supprime → CA **2 000**, stock 36 (fiche et cartes, sans rechargement) |
| — | 4 ventes simultanées → **un seul** `GET /products/:id` de la fiche (regroupement) |
| 6 | Aucune requête d'écriture de B après la mise en place ; outbox de B identique ; B hors ligne : une vente de A ne déclenche **aucune** requête ; aucune erreur de page |

Non-régression : les 9 scénarios 1-12H ont été relancés 4 fois sur ce build. Une exécution a échoué une seule fois sur une assertion d'API directe du scénario 6 (agrégats absents dans une réponse lue par le script ; la partie interface du même scénario est passée). Ce n'est **pas reproduit** sur les 3 exécutions suivantes (9/9, réponse 200 complète tracée), sans erreur dans le journal API. Cause probable, non confirmée : une requête du script émise pendant le redémarrage de l'API qu'il déclenche juste avant pour remettre le rate limiting à zéro.

Artefacts de test, pas des défauts : le rate limiting existant (connexions et acceptations par IP) a été remis à zéro entre les groupes de scénarios, par redémarrage de l'API seule (base conservée) côté Playwright et par `ThrottlerStorage` côté e2e.

## 6. Validation du dépôt

| Commande | Résultat |
| --- | --- |
| `pnpm --filter api test` | **50 suites, 814/814** (1-12G : 48 / 784 ; correctif : assertions ajoutées aux tests existants) |
| `pnpm --filter api test:e2e` | **12 suites, 309/309** (1-12G : 11 / 290 ; 307 avant le correctif) |
| `eslint` API | 0 erreur, 2 avertissements préexistants (`test/app.e2e-spec.ts:505`, `test/e2e/ephemeral-mongodb.ts:67`) ; 2 erreurs (Prettier, assertion inutile) corrigées puis suites concernées relancées (176/176, 38/38) |
| `pnpm --filter api build` | OK |
| `pnpm --filter web lint` / `exec tsc --noEmit` / `build` | OK / OK / OK |
| `git diff --check` | Propre |

## 7. Fichiers

| Fichier | Changement |
| --- | --- |
| `api/src/organizations/permissions.ts` | 2 clés, `STANDARD_MEMBER_PERMISSIONS`, calcul central |
| `api/src/products/product-projection.ts` | **Nouveau** : projection, visibilité, audit |
| `api/src/products/products.service.ts` | Agrégat serveur, projections, diffusions standard |
| `api/src/products/products.controller.ts`, `api/src/trash/trash.controller.ts` | Visibilité depuis le contexte |
| `api/src/sales/sales.service.ts` | `sale:created` minimal ; `sale:updated`/`sale:deleted` après commit (correctif) |
| `api/src/**/*.spec.ts`, `api/test/*.e2e-spec.ts` | 2 specs unitaires et 1 suite e2e **nouvelles**, 6 specs adaptées |
| `web/src/lib/organization-permissions.ts` | Clés, libellés, droits standard, `roleGrantsAllPermissions` |
| `web/src/components/organization/*` | Cases supplémentaires, comportement Administrateur |
| `web/src/lib/product-info.ts` | **Nouveau** : rendu unique des informations produit |
| `web/src/lib/api.ts`, `web/src/hooks/use-products.ts` | Types optionnels, enveloppe, diffusions standard + rechargement silencieux ; invalidation par les ventes (correctif) |
| `web/src/hooks/use-sale-invalidation.ts` | **Nouveau** (correctif) : invalidation regroupée, jamais hors ligne |
| `web/src/app/app/catalog/**`, `web/src/components/products/*`, `web/src/components/catalog/offline-catalog-browser.tsx`, `web/src/app/app/trash/page.tsx` | Fiche, cartes, modal, dialogue, corbeille |
| `web/src/lib/offline-catalog-db.ts` | Schéma v3, allowlist standard |

Inchangés : manifestes, lockfile, schémas Mongo, DTO (validation par `DELEGABLE_PERMISSIONS`), migrations, service worker, outbox, analytics.

## 8. Limites

- **Contexte figé par session** : une modification des droits s'applique au prochain chargement du contexte (rechargement de page ou nouvelle connexion), comme pour les autres permissions. L'API applique toujours la membership relue à chaque requête.
- **Statut de stock** (« Stock faible » ≤ 20 % du stock initial) : reste standard ; il révèle un ordre de grandeur du rapport restant/initial, pas la valeur.
- **Bénéfice réel** : prix d'achat **courant** appliqué à toutes les unités vendues (formule historique, non modifiée) ; un changement de prix d'achat réévalue le passé.
- **Invalidation par les ventes** : ne concerne que le catalogue et la fiche produit ouverts. Les autres écrans (ventes, analytics, accueil) gardent leur comportement antérieur. Une vente survenue pendant une période hors ligne est reflétée au prochain chargement (et par le rechargement existant après synchronisation des ventes locales).
- **Prix d'achat en écriture** : un membre `stock.adjust` sans finances ne se voit plus proposer ce champ dans l'interface ; l'API l'accepte toujours (écriture sans lecture).
- **Analytics** (`analytics.read`) : inchangé, hors périmètre ; ses propres agrégats financiers restent soumis à cette permission.
- Historique d'audit : seuls les détails d'audit sont projetés ; les ventes affichées dans l'audit restent régies par `audit.read`.
