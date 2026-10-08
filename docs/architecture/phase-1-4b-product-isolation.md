# Phase 1-4B — Isolation multi-tenant du catalogue Produits

Terminée, en attente de validation. Aucune donnée réelle, aucun accès 27017.
Catalogue + corbeille Produits sécurisés ; transaction vente–stock (1-4C) intacte.

## 1. Base git — 2. Inventaire des accès Produits

Branche `architecture/phase-1-4b-product-isolation` (base `b4df052`, 1-4A).
Audit `rg` : catalogue (`create/findAll/findOne/update/remove/findTrashed/restore/
permanentDelete`) appelé UNIQUEMENT par `products.controller` / `trash.controller` ;
`SalesService` n'appelle QUE `decrementStock`/`adjustStock` (§10) ; `deleteFile` via `permanentDelete`, `uploadFile` via le contrôleur.

## 3. Fichiers modifiés — 4. Signatures catalogue tenant

Production (3 ≤ 3) : `products.controller.ts` — `@CurrentOrganization()` sur les
7 routes, `productsService.<op>(organizationContext.organizationId, …)` en 1er
argument (`@CurrentUser()` conservé pour actorId ; S3 inchangé) ; TS pré-emptés
`import type { ResolvedOrganizationContext }` (TS1272) +
`@Query('sectionId') sectionId = undefined` (TS1016) ; `products.service.ts` —
`organizationId: string` = 1er paramètre OBLIGATOIRE de chaque op ; AUCUN
`findById`/`findByIdAndUpdate`/`findByIdAndDelete` en chemin tenant
(`adjustStock` §10 conserve `findById`) ; `trash.controller.ts` — partie produits
→ `findTrashed(organizationId)` (sections 1-4A). Tests (3 ≤ 3) :
`products.service.spec.ts` (+14), `products.controller.spec.ts` (NEW, 7),
`app.e2e-spec.ts` (+10, §13).

## 5. Filtres Mongo exacts par opération

Tenant = `new Types.ObjectId(ctx.organizationId)`, jamais `isValidObjectId` ; étrangère = même 404 que l'absente (pas de fuite).
- create : liste de champs EXPLICITE (pas de spread du DTO) → org tenant ; section
  `findOne({_id, organizationId, deletedAt:null})` → 404 `Section {id} not found` ;
  sous-sections `countDocuments({organizationId, parentId, deletedAt:null})` → 400 ;
  unicité `findOne({name:RegExp, organizationId, [_id:{$ne}]})` (nom unique PAR ORG).
- findAll `find({organizationId, deletedAt:null, [sectionId]})` + tri ;
  findTrashed `find({organizationId, deletedAt:{$ne:null}})` + tri ;
  findOne `findOne({_id, organizationId})` → 404 (sales/audit non lus si absent).
- remove / restore : `findOneAndUpdate({_id, organizationId},
  {$set:{deletedAt}}, {returnDocument:'after'})` → 404.
- permanentDelete : `findOne({_id, organizationId})` (imageUrl) → 404 AVANT S3 →
  `deleteFile(imageUrl)` → `findOneAndDelete({_id, organizationId})`.

## 6. Validation section — 7. Images S3 + corbeille

update : relecture `findOne({_id, organizationId})` ; si `sectionId` change :
`findOne({_id, organizationId, deletedAt:null})` sur la NOUVELLE section
(étrangère → 404, rien sauvegardé) ; `save()` — `organizationId` jamais assignée,
jamais le DTO brut ; audit/metrics/émition inchangés. S3 : clés/Supabase/
`S3Service` inchangés (1-5) ; `deleteFile` jamais appelé sur ressource non
localisée tenant. Limitation E2E documentée : endpoint S3 éphémère mort
(`127.0.0.1:65535`) → `uploadFile` échoue avant le service → création prouvée par
les tests UNITAIRES (org serveur + section tenant) ; le 400 body `organizationId`
reste E2E (`forbidNonWhitelisted` avant l'image). `GET /trash` filtre les Produits
par `organizationId` (sections : 1-4A).

## 8. Matrice des tests (21 unitaires ; 10 tests E2E couvrant les 12 comportements requis)

Unitaires (21 = 14 service + 7 contrôleur) : create org serveur (falsification
runtime ignorée) ; section étrangère/absente → 404 sans création ; sous-sections →
400 ; list/unicité tenant ; findOne composite + 404 invisible ; update composite +
section étrangère + org jamais altérée + save unique ; remove/restore `$set` tenant +
404 ; permanentDelete S3 si localisé (étranger → 404, `deleteFile` jamais) ;
contrôleur transmet UNIQUEMENT l'org du `@CurrentOrganization()` (body non propagé).
E2E (10, §13) : A/B listes exclues (+ `?sectionId`) ; lecture/PATCH/DELETE/restore/
purge B → 404 strictement égal à l'absent (doc B inchangée) ; body `organizationId:B`
→ 400 non persistée ; A vers section B → 404 + `sectionId` inchangé ; corbeilles
A/B disjointes ; même nom A/B indépendant ; org falsifiée (query/header) ignorée ;
seller 200/403 ; cycle admin 404→PATCH→DELETE→restore→purge. Fixtures
`productModel().create` (ObjectId réels), cleanup `_id` exact en `finally`, sans `sleep`.

## 9. Résultats — 10. Chemin Sales résiduel (à éliminer en 1-4C)

Passage unique (§14) : unitaires 376/25 (+21 / base 355/24) ; E2E 88/3 (+10 /
base 78/3) ; ESLint 0 erreur + 2 warnings préexistants (`app.e2e-spec.ts:389`
décalé de +2 ; `ephemeral-mongodb.ts:67`) ; build OK ; averts. `new: true` E2E
préexistants (1-4A) ; `--fix` LOCAL limité (3 tests, TS1272).
Chemins `ProductsService` conservés INTACTS en 1-4B (sans tenant) car consommés par
`SalesService` — à éliminer AVANT tout déploiement : `decrementStock(productId,
quantity, session?)` — `sales.service.ts:51` (create, transaction : filtre
`{_id, deletedAt:null, remainingQuantity:{$gte}}` SANS org, relecture sans tenant) ;
`adjustStock(productId, delta)` — `sales.service.ts:140` (update) et `:171` (remove),
`findById` SANS tenant.
1-4C : org signée par la transaction, tenant sur les deux, filtrage atomique
stock/vente/audit. `ProductsService` n'est PAS « totalement sécurisé » tant que
1-4C n'est pas faite (aucun paramètre tenant optionnel, ni `skip`/`todo`).

## 11. Confirmation

Aucun commit/push/donnée réelle/27017/frontend/dépendance/schéma/index/S3Service/JWT/guard
modifié. Dépendance Sales : NON modifiée (réservée à 1-4C). En attente de « je valide ».
