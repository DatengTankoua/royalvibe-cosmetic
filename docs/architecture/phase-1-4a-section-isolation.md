# Phase 1-4A — Isolation multi-tenant des Sections

Terminée, en attente de validation. Aucune donnée réelle, aucun accès 27017.
Première consommation business de `@CurrentOrganization()`.

## 1. Base git — 2. Inventaire des accès Section

Branche `architecture/phase-1-4a-section-isolation` créée ; HEAD de base
`1301732` (1-3B.2), non modifié. Appels Section : les 7 routes de
`sections.controller` → `SectionsService` + `GET /trash` → `findTrashed()`
globale. `ProductsService` ne lit les sections que par `countDocuments`
(vérif `SECTION_HAS_SUBSECTIONS`) — **aucune écriture Section hors
`SectionsService`**, aucun `populate` sur Section.

## 3. Fichiers modifiés — 4. Nouvelles signatures publiques

Production (3 ≤ 4) :
- `sections.controller.ts` : `@CurrentOrganization()` sur les 7 routes ;
  le service reçoit UNIQUEMENT `organizationContext.organizationId`
  (jamais DTO/query/headers) ; routes, statuts, rôles, formats inchangés.
  Contraintes TS : `import type` (TS1272) et `parentId = undefined` (TS1016).
- `sections.service.ts` : `organizationId: string` = 1er paramètre OBLIGATOIRE
  de chaque opération publique : `create, findAll, findTrashed, findOne,
  update, remove, restore, permanentDelete` (aucune surcharge sans org).
- `trash.controller.ts` : `findTrashed(org)` ; la partie Products restera
  non filtrée jusqu'à 1-4D (exclusion explicite).
Tests (3 ≤ 3) : `sections.service.spec.ts` (NOUVEL, 17 cas),
`sections.controller.spec.ts` (NOUVEL, 6 cas), `app.e2e-spec.ts` (+9 cas, §11).

## 5. Filtres MongoDB exacts par opération

Tenant = `new Types.ObjectId(ctx.organizationId)` (claim vérifié ; jamais
`isValidObjectId`). `findById/findByIdAndUpdate/findByIdAndDelete` : AUCUNE
occurrence en chemin tenant.
- create : `create({name, description, parentId, organizationId: tenant})`
  (whitelist serveur — un `organizationId` falsifié en body/runtime est
  ignoré) ; parent : `findOne({_id, organizationId, deletedAt:null})` ;
  produits : `countDocuments({sectionId, deletedAt:null, organizationId})` ;
  unicité de nom : `findOne({name:RegExp, parentId, organizationId[, _id:{$ne}]})`
- findAll : `find({organizationId, deletedAt:null, parentId})` + tri inchangé
- findTrashed : `find({organizationId, deletedAt:{$ne:null}})` + tri inchangé
- findOne : `findOne({_id, organizationId})` → 404 exact
- update : relecture `findOne({_id, organizationId})` + unicité tenant +
  `findOneAndUpdate({_id, organizationId}, {$set:{name?, description?}}, {new:true})`
  — jamais le DTO brut, `organizationId` jamais dans `$set`
- remove / restore : `findOneAndUpdate({_id, organizationId}, {$set:{deletedAt}}, {new:true})`
- permanentDelete : `findOneAndDelete({_id, organizationId})`

Une section étrangère = même 404 `Section {id} not found` que l'absente.

## 6. Parents/enfants — 7. Suppression/restauration/corbeille

Parent : `findOne({_id, organizationId, deletedAt:null})` — un parent étranger
ou corbeillé est **indistinguable d'un parent absent** (404, rien n'est créé).
Enfants via `?parentId=` : filtrés par `organizationId` (E2E : B ne voit RIEN
sur un parent A). Soft-delete/restore/purge et corbeille Section filtrées.

## 8. Matrice

Unitaires (23 = 17 service + 6 contrôleur) : création org serveur ; falsification
org (body/runtime) jamais enregistrée ; list/unicité tenant ; recherche composite
`{_id, organizationId}` ; étrangère → 404 ; update/delete/restore/purge filtrés ;
parent tenant (étranger → 404 sans création) ; contrôleur transmet QUE l'org du
`@CurrentOrganization()` (body falsifié non propagé).
E2E (9, §11) : A/B listes mutuellement exclues (+ `?parentId` isolé) ; lecture
section B par A → 404 strictement égal à l'absente (aucune donnée exposée) ;
PATCH section B → 404 + doc inchangée ; DELETE/restore/purge B → 3 × 404 +
doc intact (relecture après chaque opération) ; création A `organizationId=A`.
`organizationId:B` dans le body → 400 + non persistée (A et B) ; parent B → 404
+ rien créé ; même nom A/B indépendant ; seller lecture 200 / écriture 403,
cycle admin 201→200→200 (rôles et statuts historiques). Nettoyage `_id` exact,
aucun `sleep`.

## 9. Résultats — 10. Risques résiduels

- Unitaires : **355 passed / 24 suites** (base 332/22 ; +23).
- E2E : **78 passed / 3 suites** (base 69/3 ; +9).
- ESLint (sans `--fix`) : 0 erreur ; 2 warnings préexistants
  (`app.e2e-spec.ts:387` — warning existant décalé de +2 lignes par les 2
  imports ajoutés, était :385 ; `ephemeral-mongodb.ts:67`). Écart : `--fix`
  LOCAL limité aux 5 fichiers de la phase (contrainte `import type` + reformat).
- Build : OK.
- Risques 1-4B/1-4D : `ProductsService` non filtré (dont
  `countDocuments` sans tenant dans `create` → `SECTION_HAS_SUBSECTIONS` peut
  compter les sous-sections étrangères) ; corbeille Products non filtrée.

## 11. Confirmation

Aucun commit, aucun push, aucune donnée réelle, aucun accès 27017 ni changement frontend, aucune dépendance, aucun schéma/index modifié. En attente de « je valide ».
