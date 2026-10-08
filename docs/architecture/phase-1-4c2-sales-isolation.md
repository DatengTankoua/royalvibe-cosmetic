# Phase 1-4C.2 — Isolation et atomicité des autres opérations Sales

## Base Git
- Base : `architecture/phase-1-4c1-atomic-sale-tenant` à `c453a29`.
- Branche : `architecture/phase-1-4c2-sales-isolation`.
- Aucun commit, push, accès Atlas ou MongoDB `27017`.

## Fichiers
- Production : `sales.controller.ts`, `sales.service.ts`, `products.service.ts`.
- Tests : specs Sales controller/service, spec Products service, E2E Sales transaction.
- Rapport : ce fichier. Total : 3 production + 4 tests + 1 rapport.

## Contrat tenant et filtres exacts
- Le contrôleur transmet `organizationContext.organizationId` en premier argument de `findAll`, `update` et `remove`.
- Liste : `{ organizationId }`, avec `productId` ajouté uniquement si fourni.
- Update/remove : `{ _id, organizationId }`; une vente étrangère reçoit le même `404 Sale <id> not found` que l’absente.
- `adjustStock` : `{ _id, organizationId }`, sans filtre `deletedAt` afin de préserver la restauration d’un produit corbeillé.
- Une absence produit reste silencieuse; le message de stock reste `Insufficient stock. Available: N`.
- Aucun `organizationId` de body/query/header n’est lu ou écrit.

## Ordre transactionnel
- Update : `startSession` → `withTransaction` → vente tenant → ajustement stock → `sale.save` → audit `SALE_UPDATED` → commit → `endSession` → détachement/populate.
- Remove : `startSession` → `withTransaction` → vente tenant → restauration stock → `sale.deleteOne` → audit `SALE_CANCELLED` → commit → `endSession`.
- Stock, vente et audit reçoivent la même `ClientSession`; l’échec d’audit est propagé et annule les écritures.
- Aucun effet externe n’est exécuté avant commit.

## Preuves
- Unitaires : filtres exacts, org du contexte en premier argument, session identique, 404 étranger, erreurs audit propagées.
- Products : filtre composite et session sur lecture/save; produit corbeillé accepté; absent et message historique préservés.
- E2E A/B : listes disjointes; PATCH/DELETE croisés en 404 sans stock, vente ou audit parasite.
- E2E update/delete A : seul le stock A change et seul l’audit A est écrit.
- E2E rollback update/remove : vente, stock et compte d’audits identiques avant/après la panne injectée.
- Falsification : body refusé 400; query/header B n’altèrent pas la vente A.

## Validation finale
- `pnpm --filter api test` : **26/26 suites, 398/398 tests**.
- `pnpm --filter api test:e2e` : **3/3 suites, 100/100 tests**.
- `pnpm --filter api exec eslint "{src,apps,libs,test}/**/*.ts"` : **0 erreur, 2 avertissements préexistants** (`app.e2e-spec.ts`, `ephemeral-mongodb.ts`).
- `pnpm --filter api build` : **succès**.
- `git diff --check` : **succès**.

## Risques résiduels
- Permissions seller, analytics, lecture Audit, rooms Socket.IO, frontend et schémas/index restent hors périmètre.
