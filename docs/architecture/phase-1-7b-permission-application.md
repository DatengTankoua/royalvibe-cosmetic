# Phase 1-7B — Application des permissions aux routes métier

**Branche** `architecture/phase-1-7b-permission-application` · **Base** `14c81a8` (1-7A) — aucun commit, aucun push, aucun accès 27017/Atlas/Supabase. Inclut la **correction ciblée** post-revue (historique Sales scoping, remap trash.manage, permissions dynamiques `update` produit).

## Objectif
Remplacer l'autorisation métier fondée sur `User.role` par `@RequirePermissions`/`@OwnerOnly` + `organizationContext` sur les contrôleurs Sections, Products, Sales, Analytics, Trash et Organizations (invitations). `User.role` reste physiquement en base mais ne décide plus aucun droit métier ; `RolesGuard`/`@Roles` restent enregistrés (compatibilité) mais aucune route métier n'en dépend plus.

## Mapping route → permission (état final)
| Contrôleur | Routes | Permission |
|---|---|---|
| Sections | POST/PATCH (update)/DELETE (soft) | `catalog.manage` |
| Sections | `PATCH :id/restore`, `DELETE :id/permanent` | `trash.manage` (remappé — corrige un contournement : `catalog.manage` seule permettait déjà la purge) |
| Products | `POST`, `DELETE` (soft) | `products.manage` |
| Products | `PATCH :id` | **dynamique** : `products.manage` si champ descriptif (`name`/`sectionId`/image), `stock.adjust` si champ stock/prix (`purchasePrice`/`salePrice`/`additionalStock`), les deux si mélange, `products.manage` par défaut si DTO vide sans image |
| Products | `PATCH :id/restore`, `DELETE :id/permanent` | `trash.manage` (remappé, même correctif que Sections) |
| Products | `GET :id` — historique ventes (`sales`) | `sales.view_all` (org complète) sinon `sales.view_own` (filtre `sellerId` courant) sinon **aucune vente lue** |
| Products | `GET :id` — `auditLogs` | `audit.read` ; **absent** → aucune lecture d'audit (jamais interrogé, jamais vidé après coup) |
| Sales | `POST` | `sales.record` |
| Sales | `GET` / `PATCH`/`DELETE :id` | `sales.record` (mutations) + scope (ci-dessous) |
| Analytics | toutes (décorateur de classe) | `analytics.read` |
| Trash | `GET` (décorateur de classe) | `trash.manage` |
| Organizations/invitations | create/findAll/revoke (décorateur de classe) | `members.invite` |

## Correction ciblée (post-revue)
1. **Historique Sales de `GET /products/:id`** — `ProductsService.findOne` accepte désormais un `SalesHistoryScope` (`all`/`own`/`none`) et un `includeAudit: boolean` calculés par le contrôleur via `hasPermission`. `sales.view_all` → toutes les ventes org du produit ; `sales.view_own` → filtre Mongo `sellerId = ctx.userId` (jamais les ventes d'un autre vendeur, même en mémoire) ; aucune des deux → **le service n'exécute AUCUNE requête `Sale.find`**. Idem pour `auditLogs` : `audit.read` absent → `AuditService.findByProduct` n'est **jamais appelé** (avant : toujours interrogé puis vidé après coup dans le contrôleur — fuite de requête + incohérence). Effet de bord positif : `actualRevenue`/`actualProfit` (dérivés de `sales`) sont maintenant eux aussi bornés au scope visible.
2. **Sections/Products `restore`/`permanentDelete`** remappés de `catalog.manage`/`products.manage` vers `trash.manage` : un membre délégué uniquement sur le catalogue ne peut plus purger/restaurer (contournement fermé). Le soft-delete (`DELETE :id`) reste `catalog.manage`/`products.manage`.
3. **`UpdateProductDto` inspecté** : contient `additionalStock` (stock) ET `purchasePrice`/`salePrice` (prix, groupés avec le stock par la matrice audit 1A §3 « stock.adjust (stock + prix) »), plus `name`/`sectionId` (descriptif). `ProductsController.update` calcule dynamiquement la ou les permissions requises selon les champs réellement présents dans le body (+ upload d'image traité comme descriptif) — jamais de métadonnée statique unique possible ici. `stock.adjust` a donc désormais un endpoint réel (n'est plus une permission « morte »).
4. **Formulation alignée** : l'historique des ventes (`sales`) et `auditLogs` sont systématiquement décrits comme **« jamais interrogés »** quand le scope/la permission manque — jamais « absents » de la réponse (le champ existe toujours, vide `[]`).

## Scope own/all (Sales, `SalesController`)
Décidé en contrôleur (OU entre deux permissions à comportement différent, inexprimable par une métadonnée `@RequirePermissions` unique) :
- `GET /sales` : `sales.view_all` → toute l'organisation ; sinon `sales.view_own` → filtre `sellerId = ctx.userId` ; ni l'une ni l'autre → 403 `PERMISSION_DENIED` (branche défensive, inatteignable avec les 3 rôles actuels).
- `PATCH/DELETE /sales/:id` : `sales.record` requis ; sans `sales.view_all`, `scopeSellerId` optionnel ajouté au filtre → vente d'un autre vendeur indistinguable de l'absente (404).

## Helper partagé (`organizations/permissions.ts`)
- `hasPermission(context, permission)` : `DEFAULT_PERMISSIONS_BY_ROLE[role].includes(p) || context.permissions.includes(p)` (défensif `?? []`).
- `PERMISSION_DENIED_RESPONSE` : corps 403 uniforme partagé avec `PermissionGuard` (1-7A).

## Fichiers (9 prod + 9 tests)
Prod : `organizations/permissions.ts`, `organizations/organizations.controller.ts`, `sections/sections.controller.ts`, `products/products.controller.ts`, `products/products.service.ts` (+`SalesHistoryScope`, `findOne` scope-aware), `sales/sales.controller.ts`, `sales/sales.service.ts`, `analytics/analytics.controller.ts`, `trash/trash.controller.ts`.
Tests : `auth/guards/roles.guard.spec.ts`, `organizations/organizations.controller.spec.ts`, `products/products.controller.spec.ts` (scope ventes + gate audit + permissions dynamiques `update`), `products/products.service.spec.ts` (scope `all`/`own`/`none`, audit non interrogé), `sales/sales.controller.spec.ts`, `sales/sales.service.spec.ts`, `test/app.e2e-spec.ts` (+trash seller 403 ; +délégation `catalog.manage` sans/avec `trash.manage`), `test/invitations.e2e-spec.ts`, `test/socket.e2e-spec.ts`.

## Matrice de tests (extraits pertinents à la correction)
`GET /products/:id` : seller par défaut ne voit que ses propres ventes dans l'historique (2 sellers de la même org, vérifié service + contrôleur) ; scope `none` → zéro requête `Sale.find` ; `audit.read` absent → zéro requête `AuditService.findByProduct` ; restore/purge Sections avec `catalog.manage` seul → 403 `PERMISSION_DENIED`, avec `trash.manage` ajouté (même token, résolution fraîche par requête) → 200 ; `PATCH /products/:id` : champ descriptif seul → `products.manage` suffit ; champ stock/prix seul → `stock.adjust` suffit (sans `products.manage`) ; mélange → les deux requis ; DTO vide sans image → retombe sur `products.manage`.

## Résultats (une exécution chacune)
- `pnpm --filter api test` : **569/569**, 34 suites (baseline 556 + 13).
- `pnpm --filter api test:e2e` : **154/154**, 5 suites (baseline 153 + 1 ; rollbacks/invariants simulés attendus loggés en ERROR).
- `pnpm --filter api exec eslint "{src,apps,libs,test}/**/*.ts"` : **0 erreur**, 2 warnings préexistants inchangés (fichiers e2e hors périmètre).
- `pnpm --filter api build` : OK. `git diff --check` : OK (LF→CRLF Windows inoffensifs).

## Risques résiduels / hors périmètre
- `members.manage`, `branding.manage` restent inutilisées : aucun endpoint correspondant n'existe encore. `stock.adjust` est désormais utilisée (correction 3).
- `GET` catalogue (sections/produits) reste ouvert à tout membre actif, conformément à la matrice §3 de l'audit 1A.
- Aucune opération owner-only n'a de route dédiée créée dans cette phase (aucune route factice).
- `RolesGuard`/`@Roles` restent enregistrés globalement pour compatibilité, sans dépendance active d'aucune route métier.

Aucun commit, aucun push — en attente de validation.
