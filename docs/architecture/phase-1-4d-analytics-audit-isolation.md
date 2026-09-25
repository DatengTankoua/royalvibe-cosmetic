# Phase 1-4D — Isolation Analytics, Audit et corbeille

## Base et fichiers
- Base : `architecture/phase-1-4c2-sales-isolation` à `664c8ae`.
- Branche : `architecture/phase-1-4d-analytics-audit-isolation`.
- Production : contrôleur/service Analytics, service Audit, service Products.
- Tests : specs contrôleur/service Analytics, Audit, Products, Trash et E2E Sales.
- Total : 4 production + 6 tests + 1 rapport. Aucun schéma, index ou contrat HTTP modifié.

## Inventaire des accès
- Quatre routes Analytics appellent les quatre méthodes du service.
- `AuditService.findByProduct` a un seul appelant : `ProductsService.findOne`.
- `GET /trash` agrège uniquement `SectionsService.findTrashed` et `ProductsService.findTrashed`.
- Les écritures Audit existantes étaient déjà tenant-scopées et restent inchangées.

## Filtres et pipelines exacts
- Chaque méthode Analytics reçoit `organizationId` en premier argument depuis `@CurrentOrganization()`.
- Chaque pipeline Sales commence par `$match: { organizationId: new Types.ObjectId(organizationId), ...période }` avant tout `$group`.
- Overview Products : `find({ organizationId: ObjectId })`; calculs et format inchangés.
- Ranking Produits : `$lookup` corrélé sur `_id == $$productId` ET `organizationId == $$organizationId`.
- Lookup Users inchangé : User n’est pas une collection tenant.
- Audit : `findByProduct(organizationId, productId)` filtre exactement `{ organizationId: ObjectId, productId: ObjectId }`.
- Produit étranger/absent retourne le 404 Product existant avant toute lecture Sales/Audit.
- Corbeille : sections et produits reçoivent l’organisation du contexte; restore/purge inchangés.

## Preuves A/B
- Unitaires : arguments contrôleur, ObjectId réels, premier `$match`, période conservée, lookup Produit tenant, filtre Audit exact, deux ressources Trash tenant.
- E2E : les quatre réponses Analytics A sont intégralement identiques avant/après ajout d’un produit et d’une vente B.
- Ranking Produits A contient A et exclut B; les lignes ex aequo sont canonicalisées uniquement dans le test.
- Un audit B injecté sur l’identifiant Produit A est absent de l’historique retourné à A.
- Produit B lu par A : même statut/message 404 qu’un identifiant absent.
- Corbeilles sections/produits A et B strictement disjointes.
- Body/query/header `organizationId=B` n’altèrent ni Analytics, ni Audit, ni Trash A.
- Décorateurs de rôles inchangés; les tests admin/seller existants restent applicables.

## Validation finale
- `pnpm --filter api test` : **29/29 suites, 404/404 tests**.
- `pnpm --filter api test:e2e` : **3/3 suites, 103/103 tests**.
- `pnpm --filter api exec eslint "{src,apps,libs,test}/**/*.ts"` : **0 erreur, 2 avertissements préexistants** (`app.e2e-spec.ts`, `ephemeral-mongodb.ts`).
- `pnpm --filter api build` : **succès**.
- `git diff --check` : **succès**.

## Risques résiduels
- Permissions fines, rooms Socket.IO, S3, frontend, schémas/index et abonnements restent hors périmètre.
- Aucun commit, push, accès Atlas ou MongoDB `27017`.
