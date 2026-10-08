# Phase 1-15B — Temps réel des sections et de la suppression définitive des produits

Branche : `architecture/phase-1-15b-realtime-sections-deletions`, créée
depuis `architecture/phase-1-15a-realtime-saas` à
**`468a6a9530b5bbd7b5d1553864f5df3df4438e50`** (« fix: synchronize SaaS
views and sessions in real time »), présent sur `origin`. Au départ : arbre
et index propres ; `stash@{0}` (sauvegarde lint-staged `564a998`) présent et
**non touché**.

Rapports lus : [1-15A](phase-1-15a-realtime-saas.md),
[1-14D.2H](phase-1-14d2h-payment-local-recipe.md).

Aucun commit, push ni déploiement. Aucune base réelle, aucun appel CamPay,
e-mail ou stockage réel. **Aucun `.env` réel lu, déplacé ou modifié** :
recette sur la stack éphémère D.2H, suites API et build web uniquement par
`recipe.js isolated` (§ 6). Aucune dépendance, lockfile inchangé.
`UnavailablePaymentProvider` et webhook désactivé : inchangés.

---

## 1. Audit avant correction

### 1.1 Opérations existantes

Aucune opération, permission ou règle de suppression n'a été ajoutée.

| Opération                                    | Route                            | Permission       | Écriture                                                                   | Transaction | Événement avant 1-15B                                                              |
| -------------------------------------------- | -------------------------------- | ---------------- | -------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------- |
| Créer une section (racine ou sous-catalogue) | `POST /sections`                 | `catalog.manage` | `create` (parent actif sans produit, nom unique)                           | non         | **aucun**                                                                          |
| Renommer / décrire                           | `PATCH /sections/:id`            | `catalog.manage` | `findOneAndUpdate $set`                                                    | non         | **aucun**                                                                          |
| Mettre à la corbeille                        | `DELETE /sections/:id`           | `catalog.manage` | `deletedAt = now`                                                          | non         | **aucun**                                                                          |
| Restaurer                                    | `PATCH /sections/:id/restore`    | `trash.manage`   | `deletedAt = null`                                                         | non         | **aucun**                                                                          |
| Supprimer définitivement                     | `DELETE /sections/:id/permanent` | `trash.manage`   | `findOneAndDelete` (aucune règle sur produits ni enfants, inchangé)        | non         | **aucun**                                                                          |
| Supprimer définitivement un produit          | `DELETE /products/:id/permanent` | `trash.manage`   | suppression de l'image (clé du commerce seulement) puis `findOneAndDelete` | non         | **aucun** (la corbeille émet `product:deleted`, la restauration `product:created`) |

Les écouteurs web `section:created` (qui attendait un document complet) et
`section:deleted` de `useSections` **n'avaient aucun émetteur** côté API.

### 1.2 Écrans concernés (fonctionnement réel)

| Écran                                        | Données de section / suppression                                                                                                                      | Comportement avant 1-15B                                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `/app/catalog` (liste racine, `useSections`) | sections racine, **filtre** « Rechercher un catalogue… » (client)                                                                                     | relue au chargement et au retour du réseau seulement                                                                  |
| `/app/catalog/[id]`                          | **en-tête** (nom, description, lien parent), **sous-catalogues** + filtre, cartes produit, boutons « Nouveau sous-catalogue » / produit selon le mode | en-tête et sous-catalogues lus une fois ; aucune indication si la section est mise à la corbeille ou supprimée        |
| `/app/trash` (`useTrash`, `trash.manage`)    | sections et produits de la corbeille                                                                                                                  | 1-15A : relue sur `product:deleted` / `product:created` ; **rien** pour les sections ni la suppression définitive     |
| Fiche produit                                | produit ouvert                                                                                                                                        | 1-15A : « placé dans la corbeille » sur `product:deleted` ; **rien** sur suppression définitive                       |
| Cartes produit (`useProducts`), Analyse      | produits                                                                                                                                              | produit déjà retiré à la mise à la corbeille ; Analyse non relue à la suppression définitive                          |
| Sélecteurs de section                        | —                                                                                                                                                     | **aucun** dans l'interface : un produit est créé dans la section de la page, la modification ne change pas de section |
| Catalogue hors ligne                         | snapshot écrit après chaque lecture réussie                                                                                                           | inchangé ; profite des relectures                                                                                     |

Permissions de lecture : `GET /sections*` ouvert à tout membre actif ;
`GET /trash` exige `trash.manage` (aucun appel sans).

### 1.3 Défauts reproduits avant correction

Stack D.2H, API et web compilés depuis **`468a6a9`** (aucun fichier
applicatif modifié au moment du build) ; campagne RT10–RT14 : **1/5**.

| #   | Scénario                                   | Premier échec observé                                                                                                                                                                                 |
| --- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | RT10 — sections d'un collègue              | la **création** d'une section racine n'apparaît pas dans la liste du collègue (15 s) ; les étapes suivantes (renommage, filtre, en-tête, corbeille, restauration, purge) n'ont donc pas été atteintes |
| E2  | RT11 — suppression définitive d'un produit | le produit **reste affiché dans la corbeille** de l'administrateur                                                                                                                                    |
| E3  | RT12 — réponses retenues puis purge        | aucune indication de suppression définitive sur la fiche ouverte (aucun signal)                                                                                                                       |
| E4  | RT13 — coupure puis reconnexion            | le **sous-catalogue créé pendant la coupure** n'apparaît pas après la reconnexion                                                                                                                     |
| —   | RT14 — seconde organisation                | passe (aucun événement n'existait)                                                                                                                                                                    |

## 2. Correctifs API

- `SectionsService` reçoit `EventsGateway` (`SectionsModule` importe
  `EventsModule` ; aucune dépendance circulaire). Après **chaque écriture
  réussie** :
  `section:created`, `section:updated`, `section:deleted` (corbeille),
  `section:restored`, `section:purged` (suppression définitive), payload
  **`{ _id, parentId }`** seul (jamais nom, description, organisation).
- `ProductsService.permanentDelete` émet **`product:purged` `{ _id }`**,
  distinct de `product:deleted` (corbeille), seulement si cette requête a
  réellement supprimé le document.
- Émission par `emitToOrganization` (room de l'organisation, couverture
  d'abonnement), **après** l'écriture, en best effort (`try/catch` +
  journal) : une panne d'émission ne produit jamais d'erreur HTTP. Aucune
  transaction concernée. Rooms, JWT, permissions, projections : inchangés.

## 3. Correctifs web

Réutilisation de `useLiveRefresh` / `createRefreshCoordinator` /
`createResponseOrder` (1-15A) : relecture silencieuse regroupée et
sérialisée, invalidation pendant un chargement conservée, rattrapage à
chaque connexion du socket, réponses périmées refusées ; les pages restent
remontées au changement d'utilisateur ou d'organisation (1-15A).

| Fichier                         | Changement                                                                                                                                                                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hooks/use-sections.ts`         | `SECTION_SIGNALS`, `readSectionSignal` ; liste relue si le signal concerne ce niveau (`parentId`) ou une section affichée ; ordre, rattrapage ; sections purgées jamais réaffichées. Les anciens écouteurs (document complet attendu) sont remplacés |
| `app/app/catalog/[id]/page.tsx` | en-tête et sous-catalogues relus sur les signaux concernant la section ou ses enfants ; bandeaux « Ce catalogue a été placé dans la corbeille. » (d'après `deletedAt` relu) et « Ce catalogue a été supprimé définitivement. »                       |
| `hooks/use-trash.ts`            | signaux de section et `product:purged` ; **pierres tombales** : un élément purgé est retiré aussitôt et filtré de toute réponse ultérieure                                                                                                           |
| Fiche produit                   | `product:purged` → « Ce produit a été supprimé définitivement. » (plus jamais « placé dans la corbeille ») ; toute réponse demandée avant l'événement est invalidée ; plus aucune relecture appliquée après une purge                                |
| `hooks/use-products.ts`         | `product:purged` → retrait + pierre tombale                                                                                                                                                                                                          |
| Analyse                         | `product:purged` ajouté aux signaux                                                                                                                                                                                                                  |
| `lib/api.ts`                    | `ApiSection.deletedAt` optionnel (déjà renvoyé par `GET /sections/:id`)                                                                                                                                                                              |

`serverLoadedAt`, UUID, idempotence, réservations et outbox : non touchés ;
aucun événement ne confirme une vente.

## 4. Preuves navigateur

Commande : `node api/test/recipe/recipe.js realtime [RT1..RT14] --playwright=<dir> --chromium=<exe>`.
RT1–RT9 et leurs assertions sont inchangés. Barrières `page.route`,
attentes sur effets visibles ; fenêtres bornées uniquement pour prouver
une absence.

| #    | Scénario                                                                                                                                                                                                                                                                                                                              | Résultat observé (code corrigé)                                                                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RT10 | 4 contextes (vendeur sur la liste racine, sur un parent, sur une section ; admin sur la corbeille) ; le propriétaire crée une section et un sous-catalogue, renomme une section pendant qu'un **filtre** est actif, la met à la corbeille ; l'admin la restaure, met un sous-catalogue à la corbeille puis le supprime définitivement | apparitions, entrée puis sortie des résultats filtrés, **en-tête** renommé, bandeau corbeille puis retiré, corbeille alimentée puis vidée ; aucun rechargement ; frames de section = exactement `_id, parentId` |
| RT11 | admin sur la corbeille, vendeur finances sur la fiche ouverte, vendeur standard sur `/app/trash` ; corbeille puis suppression définitive                                                                                                                                                                                              | produit retiré de la corbeille ; fiche « supprimé définitivement », plus « placé dans la corbeille » ; `product:purged` = `_id` seul ; sans `trash.manage` : 0 requête `/trash`                                 |
| RT12 | relecture de la fiche retenue (avant corbeille) et relecture de la corbeille retenue (produit en corbeille), puis purge, puis libération                                                                                                                                                                                              | **sentinelles `MutationObserver`** : le produit ne réapparaît **jamais, même brièvement**, ni dans la corbeille ni sur la fiche                                                                                 |
| RT13 | parent ouvert et corbeille ouverts, deux contextes hors ligne ; sous-catalogue créé, parent renommé, produit purgé pendant la coupure                                                                                                                                                                                                 | au retour : sous-catalogue, nouveau nom d'en-tête, corbeille vidée, sans rechargement                                                                                                                           |
| RT14 | seconde organisation (liste et corbeille ouvertes) ; création, renommage, corbeille de section et purge de produit dans A                                                                                                                                                                                                             | B : 0 frame `section:*`/`product:*`, 0 relecture `/sections` ni `/trash`, aucune donnée de A                                                                                                                    |

**Sensibilité de RT12 (mutation temporaire).** Avec les pierres tombales
de la corbeille et l'invalidation de la fiche neutralisées dans la seule
copie isolée (fichiers restaurés aussitôt, empreintes SHA-256 vérifiées),
RT12 **échoue 2 fois sur 2** : « corbeille : le produit n'est jamais
réapparu, même brièvement ». La première version de RT12 (contrôle à
1,5 s seulement) n'aurait pas vu cette réapparition transitoire : la
sentinelle a été ajoutée pour cela.

| Campagne                                    | Résultat                                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| RT10–RT14, `468a6a9` (référence)            | **1/5** (E1–E4)                                                                        |
| RT10–RT14, code corrigé                     | 5/5 au premier passage                                                                 |
| RT12 avec sentinelle, code corrigé / mutant | PASS / **FAIL ×2**                                                                     |
| RT1–RT14 complète, code corrigé             | **14/14 sur trois passages** (deux avant les dernières retouches, un sur l’état final) |
| `scenarios` D.2H                            | **18/18**, deux fois (dont l’état final)                                               |

## 5. Tests API ajoutés

- `sections.service.spec.ts` (+3) : chaque écriture réussie émet **une**
  fois, **après** l'écriture (`invocationCallOrder`), à l'organisation
  serveur, payload aux clés exactes `_id, parentId` ; **aucune émission**
  sur 404 (corbeille, restauration, modification, purge), nom en double,
  parent avec produits ; une émission qui lève ne fait pas échouer
  l'écriture.
- `products.service.spec.ts` (+1) : `product:purged` `{ _id }` seul, après
  `findOneAndDelete`, une fois ; rien si rien n'a été supprimé ou sur 404 ;
  panne d'émission sans erreur.

## 6. Validations (environnement isolé)

Suites API et build web **exclusivement** par `recipe.js isolated` (1-15A
§ 7.2 : environnement construit, garde préchargée jusque dans les workers
Jest, copie web sans `.env*`). Aucune commande standard chargeant les `.env`
réels n'a été utilisée.

| Contrôle (état final)                                                                           | Résultat                                                                                                                                                |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isolated api-unit`                                                                             | **69/69 suites, 1342/1342** (+4 tests 1-15B) ; aucune tentative d'accès à un `.env`                                                                     |
| `isolated api-e2e`                                                                              | **24/24 suites, 563/563** ; `existsSync api\.env` bloqué 23 fois, jamais lu                                                                             |
| `isolated web-build`                                                                            | compilé, 26 pages ; 3 `.env*` de `web/` écartés par leur nom, 0 dans la copie ; tentatives seulement dans la copie (fichiers absents) ; copie supprimée |
| `realtime` RT1–RT14                                                                             | **14/14**                                                                                                                                               |
| `scenarios` D.2H                                                                                | **18/18**                                                                                                                                               |
| `pnpm --filter web test:coordinator`                                                            | **6/6**                                                                                                                                                 |
| `pnpm --filter api build` ; `api : npx tsc --noEmit -p tsconfig.build.json`                     | OK ; 0                                                                                                                                                  |
| `pnpm --filter api exec eslint "{src,apps,libs,test}/**/*.ts"` (sans `--fix`)                   | 0 erreur, 2 avertissements préexistants (`test/app.e2e-spec.ts`, `test/e2e/ephemeral-mongodb.ts`)                                                       |
| `web : npx eslint .` (sans `--fix`) / `npx tsc --noEmit`                                        | 0 / 0                                                                                                                                                   |
| `npx jest src/sections src/products/products.service.spec.ts` (ciblé, pendant le développement) | 3 suites, 64/64                                                                                                                                         |
| `npx prettier --check` (fichiers modifiés et nouveaux) ; `node --check` ; `git diff --check`    | OK ; OK ; OK                                                                                                                                            |
| Lockfile                                                                                        | inchangé                                                                                                                                                |

**Exécution e2e intermédiaire en échec.** Une première exécution isolée des
e2e (lancée avant la dernière retouche de typage de `sections.service.ts`,
pendant que lint, typage et Prettier tournaient en parallèle : 557 s au lieu
d'environ 300) a donné **23/24 suites, 562/563** : dans
`subscription-payments.e2e-spec.ts` (1-14D.2B), « double clic : 5 envois
simultanés du même UUID », un des cinq envois n'a pas reçu 201. Ce code de
paiement n'est pas modifié par ce lot. **Non reproduit** : l'exécution
suivante, sans autre charge et sur l'état final, passe 24/24. Cause non
établie ; aucun lien identifié avec 1-15B.

**Ordre des dernières retouches.** Après les deux passages complets 14/14 :
formatage Prettier de `realtime-scenarios.js` et de la spec des sections,
puis correction de deux erreurs ESLint (assertions inutiles dans la spec ;
`String(...)` remplacé par `.toString()` typé sur des `ObjectId` dans
`sections.service.ts`, sortie identique). Toutes les validations du tableau
ci-dessus ont été **refaites après** ces retouches (API recompilée, nouvelle
copie web pour la recette).

## 7. Fichiers

| Fichier                                                        | Changement                                                                    |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `api/src/sections/sections.service.ts`                         | Émissions `section:*` `{ _id, parentId }` après écriture, best effort         |
| `api/src/sections/sections.module.ts`                          | Import de `EventsModule`                                                      |
| `api/src/sections/sections.service.spec.ts`                    | Passerelle simulée, +3 tests d'émission                                       |
| `api/src/products/products.service.ts`                         | `product:purged` `{ _id }` après suppression définitive                       |
| `api/src/products/products.service.spec.ts`                    | +1 test                                                                       |
| `web/src/hooks/use-sections.ts`                                | Signaux de section, relecture regroupée, rattrapage, pierres tombales         |
| `web/src/app/app/catalog/[id]/page.tsx`                        | En-tête et sous-catalogues relus, bandeaux corbeille / suppression définitive |
| `web/src/hooks/use-trash.ts`                                   | Signaux de section et de purge, pierres tombales                              |
| `web/src/app/app/catalog/products/[id]/page.tsx`               | État « supprimé définitivement », réponses en vol invalidées                  |
| `web/src/hooks/use-products.ts`                                | `product:purged`                                                              |
| `web/src/app/app/analytics/page.tsx`                           | `product:purged` dans les signaux                                             |
| `web/src/lib/api.ts`                                           | `ApiSection.deletedAt` optionnel                                              |
| `api/test/recipe/realtime-scenarios.js`                        | RT10–RT14, sentinelle de réapparition, aides de section (RT1–RT9 inchangés)   |
| `api/test/recipe/recipe.js`                                    | Aide de la commande `realtime`                                                |
| `docs/architecture/phase-1-15b-realtime-sections-deletions.md` | **Nouveau** : ce document                                                     |

Inchangés : schémas, DTO, routes, permissions, règles de suppression,
gateway, middleware Socket.IO, ventes, outbox, abonnements, paiements,
service worker, `env-guard.cjs`, `isolated-checks.js`, lockfile, `.env`.

## 8. Limites restantes

- **Le temps réel n'est pas terminé globalement.** Restent relus à
  l'ouverture seulement : membres, invitations, image de marque,
  abonnement, paiements (vérification manuelle inchangée).
- **Multi-instance hors périmètre** : rooms, registre des sockets et filtre
  de couverture restent en mémoire d'un seul processus.
- **Règles de suppression inchangées** : supprimer définitivement une
  section ne vérifie ni ses produits ni ses sous-catalogues (comportement
  existant, non modifié) ; les produits d'une section à la corbeille
  restent listés par l'API. Les écrans reflètent ces règles, ils ne les
  corrigent pas.
- **Section courante supprimée définitivement** : la page affiche le
  bandeau ; les produits déjà chargés restent visibles en dessous jusqu'à
  la navigation (l'API ne les supprime pas).
- **Une section à la corbeille** reste consultable par son URL directe
  (`GET /sections/:id` la renvoie) : la page l'indique par un bandeau.
- **Sentinelles** : prouvées sensibles pour la corbeille ; pour la fiche,
  la mutation a échoué d'abord sur la corbeille (assertion précédente),
  la sensibilité propre à la fiche n'est donc pas démontrée séparément.
- **Pierres tombales** en mémoire de la page : un rechargement complet
  repart des données serveur (qui n'ont plus l'élément).
