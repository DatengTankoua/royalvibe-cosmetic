# Phase 1-4E — Portail E2E transversal d'isolation multi-tenant

## Base et fichiers
- Base : `architecture/phase-1-4d-analytics-audit-isolation` à `db1046b`.
- Branche : `test/phase-1-4e-multitenant-isolation-gate`.
- Nouveau : `api/test/multitenant-isolation.e2e-spec.ts`.
- Nouveau : ce rapport. Aucun fichier de production, aucune dépendance.

## Fixture autonome
- `MongoMemoryReplSet` 8.2.6 via `validatedEphemeralUri`; port aléatoire local, jamais `27017`.
- Un même admin membre actif de A et B; deux JWT réels obtenus par deux logins avec l'organisation explicite.
- Sections et produits actifs/corbeillés A/B, ventes et audits A/B, tous avec de vrais `ObjectId`.
- Produits insérés dans la collection éphémère avec `imageUrl: null`; aucun stockage S3.
- `afterAll` ferme Nest puis appelle `stopEphemeralMongoSafe`, y compris après erreur de bootstrap.

## RED / GREEN
- RED initial : bootstrap refusé par la validation Mongoose car `imageUrl` est requis; ce n'était pas une fuite.
- Correction test-only : insertion directe des fixtures `imageUrl: null` dans la collection éphémère.
- GREEN ciblé : **1/1 suite, 10/10 tests**. Aucune correction production nécessaire.

## Matrice couverte
- Listes Sections/Products A excluent B; lectures essentielles rejouées avec B prouvent la symétrie.
- GET/PATCH/DELETE/restore/permanent Section B par A : 404 équivalent à absent et document B inchangé après chaque appel.
- Même matrice Produit B; état B inchangé après chaque appel et `S3Service.deleteFile` jamais appelé.
- GET Sales A exclut B; création A sur produit B : 404, stock/ventes/audits/événements inchangés.
- PATCH/DELETE vente B par A : 404 équivalent à absent; vente, stock et audits inchangés après chaque appel.
- Les quatre réponses Analytics A sont identiques après ajout d'un produit et d'une vente B; aucun id/nom B exposé.
- Historique Audit A exclut un audit B frauduleux portant le `productId` A.
- Trash A contient seulement sections/produits A; Trash B confirme la symétrie.
- `organizationId=B` dans body : 400; query/header : ignorés, réponses A inchangées.
- Ordres des rankings et listes canonicalisés seulement dans le test; aucun `sleep`, `skip` ou `todo`.

## Validation finale
- `pnpm --filter api test` : **29/29 suites, 404/404 tests**.
- `pnpm --filter api test:e2e` : **4/4 suites, 113/113 tests**.
- `pnpm --filter api exec eslint "{src,apps,libs,test}/**/*.ts"` : **0 erreur, 2 avertissements préexistants** (`app.e2e-spec.ts`, `ephemeral-mongodb.ts`).
- `pnpm --filter api build` : **succès**.
- `git diff --check` : **succès**.
- Processus `mongod` résiduel : **aucun**.

## Limites
- Rooms Socket.IO et stockage S3 restent bloquants jusqu'a la phase 1-5; ils ne sont pas testés ici.
- Permissions membership restent hors périmètre (phase 1-7).
- Aucun commit, push, accès Atlas ou MongoDB `27017`.
