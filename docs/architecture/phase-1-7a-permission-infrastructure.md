# Phase 1-7A — Infrastructure des permissions organisationnelles

**Branche** `architecture/phase-1-7a-permission-infrastructure` · **Base** `adf7f3b` (1-6B.2) — aucun commit, aucun push, aucun accès 27017/Atlas/Supabase. Commit **non déployable seul** avant 1-7B (aucune route métier ne porte encore les nouveaux décorateurs).

## Objectif
Poser la garde d'autorisation fondée **uniquement** sur `request.organizationContext` (membership résolue par `OrganizationGuard`, 1-3B.2), sans modifier les routes métier ni `RolesGuard`/`@Roles` existants.

## Décorateurs (`auth/decorators/permissions.decorator.ts`)
- `@RequirePermissions(...permissions: DelegablePermission[])` — **toutes** les permissions listées sont requises (ET, jamais OU).
- `@OwnerOnly(operation: OwnerOnlyOperation)` — `operation` doit appartenir à `OWNER_ONLY_OPERATIONS` (1-1A).

## `PermissionGuard` (`auth/guards/permission.guard.ts`)
- Non-HTTP (Socket.IO) / `@Public()` / route sans métadonnée `@RequirePermissions`/`@OwnerOnly` → laisse passer **sans lire** le contexte.
- Permissions effectives = `DEFAULT_PERMISSIONS_BY_ROLE[context.role] ∪ context.permissions`.
- `@OwnerOnly` vérifie **exclusivement** `context.role === OWNER` — jamais via `context.permissions`, même si une valeur y est injectée (ces opérations ne sont AUCUNE permission délégable, par construction 1-1A).
- Contexte absent sur une route protégée par métadonnée → refus contrôlé, jamais 500.
- Refus toujours 403 uniforme : `{ code: 'PERMISSION_DENIED', message: 'Permission insuffisante.' }`.
- Aucune requête DB, aucune lecture de `User.role`/JWT/`body`/`query`/`params`/`headers` ; aucune mutation de `organizationContext`.

## Ordre `APP_GUARD` (`auth/auth.module.ts`)
`JwtAuthGuard → OrganizationGuard → PermissionGuard → RolesGuard` (contractuel, asserté par tests unitaires).

## Fichiers (3 prod + 2 tests)
Prod : `auth/decorators/permissions.decorator.ts` (N), `auth/guards/permission.guard.ts` (N), `auth/auth.module.ts` (+`PermissionGuard` dans `APP_GUARD`, commentaire d'ordre mis à jour).
Tests : `auth/guards/permission.guard.spec.ts` (N, 16 cas), `auth/guards/organization.guard.spec.ts` (assertion d'ordre `APP_GUARD` étendue à 4 gardes).

## Matrice de tests
Route sans métadonnée (passe sans lire le contexte) ; permission par défaut owner/admin/seller ; permission supplémentaire seller (hors défaut) ; permission manquante → 403 ; plusieurs permissions (une manquante refuse, toutes présentes autorise) ; owner-only autorisée au owner ; owner-only refusée à admin **même avec la valeur injectée dans `permissions`** ; contexte absent sur route protégée → 403 contrôlé (jamais `TypeError`/500) ; `@Public()` avec métadonnées de permission ; contexte non-HTTP ; aucune mutation de `organizationContext` (snapshot avant/après) ; aucune dépendance à `request.user` (absent de la requête simulée) ; ordre `APP_GUARD` exact (4 gardes).

## Résultats (une exécution chacune)
- `pnpm --filter api test` : **531/531**, 34 suites (baseline 515 + 16).
- `pnpm --filter api test:e2e` : **149/149**, 5 suites (inchangé — rollbacks/invariants simulés attendus loggés en ERROR).
- `pnpm --filter api exec eslint "{src,apps,libs,test}/**/*.ts"` : **0 erreur**, 2 warnings préexistants inchangés (fichiers e2e hors périmètre).
- `pnpm --filter api build` : OK. `git diff --check` : OK (LF→CRLF Windows inoffensifs).

## Limite avant 1-7B
Aucune route métier ne porte encore `@RequirePermissions`/`@OwnerOnly` : ce commit introduit l'infrastructure de contrôle mais ne change **aucun** comportement d'autorisation effectif. `RolesGuard`/`@Roles` restent l'autorité active jusqu'au câblage des routes en 1-7B.

Aucun commit, aucun push — en attente de validation.
