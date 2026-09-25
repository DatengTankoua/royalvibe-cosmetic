# Phase 1-6B.2 — Acceptation atomique d'une invitation

**Branche** `architecture/phase-1-6b2-invitation-acceptance` · **Base** `ff36da4` (1-6B.1) — aucun commit, aucun push, aucun accès 27017/Atlas/Supabase.

## Endpoint
`POST /auth/invitations/accept` (`AuthController`, délègue à `OrganizationsService.acceptInvitation`) : **public** (`@Public()`), **rate-limité** (`AuthThrottlerGuard`, même stockage que login/register), **200 explicite** (`@HttpCode(200)`), **indépendant** de `PUBLIC_REGISTRATION_ENABLED`. Body strict `{ token, name?, password? }` — `forbidNonWhitelisted` rejette `role`/`organizationId`/`permissions`/`invitedById` (400 avant écriture).

## Transaction (`OrganizationsService.acceptInvitation`)
`connection.startSession()` → `withTransaction` : (1) réclame l'invitation par filtre **conditionnel unique** `{tokenHash, status:pending, expiresAt:{$gt:now}}` → `status:accepted, acceptedAt` (garde anti-concurrence) ; (2) charge l'Organization (même session) — absente/suspendue → même erreur ; (3) `UsersService.findByEmail(email, session)` — si absent, exige `name`+`password` (sinon 400 `ACCOUNT_DETAILS_REQUIRED`), hash bcrypt, crée le `User` rôle legacy **`seller`** (jamais `admin`, quel que soit `invitation.role`) ; (4) refuse toute Membership déjà existante, **même inactive** (409 `MEMBERSHIP_ALREADY_EXISTS`, aucune réactivation) ; (5) crée la Membership avec `role`/`permissions`/`organizationId`/`invitedById` **copiés exclusivement** de l'invitation ; (6) garde défensive finale (`countDocuments === 1`, même esprit que 1-6A). `endSession()` en `finally` systématique ; toute erreur abandonne **toute** la transaction (l'invitation redevient `pending`).

## Erreurs stables
`INVITATION_INVALID_OR_EXPIRED` (400, **générique** — inconnu/expiré/revoked/accepted/org absente-suspendue, jamais distingué) ; `ACCOUNT_DETAILS_REQUIRED` (400) ; `MEMBERSHIP_ALREADY_EXISTS` (409). **Correctif 1-6B.1** : `createInvitation` capture désormais l'E11000 concurrent de l'index partiel `{organizationId,email}` → 409 `INVITATION_ALREADY_PENDING` (jamais 500), avec test dédié.

## Réponse 200
`{ user:{_id,name,email}, organization:{_id,name,slug}, membership:{role,status} }` — aucun token/hash/permissions/invitedById.

## Fichiers (4 prod + 4 tests + 1 rapport)
Prod : `auth/dto/accept-invitation.dto.ts` (N), `auth/auth.controller.ts` (+route, +`OrganizationsService`), `organizations/organizations.service.ts` (+`acceptInvitation`, +correctif E11000, +`Connection`), `users/users.service.ts` (`findByEmail` + session optionnelle).
Tests : `auth/dto/accept-invitation.dto.spec.ts` (N), `auth/auth.controller.spec.ts` (+délégation), `organizations/organizations.service.spec.ts` (+describe `acceptInvitation`, mocks session ; +test E11000), `test/invitations.e2e-spec.ts` (+describe Acceptation, réplica réel).

## Matrice de tests (unitaires + E2E réel)
Nouveau user (triplet atomique, password haché, `role:seller`) ; user existant (aucune modification) ; invitation `admin` sans escalade (`User.role` reste `seller`) ; rôle/permissions/`invitedById` copiés exactement ; token inconnu/expiré/révoqué/déjà accepté → même 400, zéro écriture ; organisation absente/suspendue ; membership déjà existante (même révoquée) → 409, sans réactivation ; rollback après création User+Membership (garde finale falsifiée) → aucune trace, `endSession` toujours appelé ; acceptation concurrente (même token, réel replica set) → 1×200/1×400 ; émission concurrente (même org+email) → 1×201/1×409, jamais 500 ; endpoint public même si `PUBLIC_REGISTRATION_ENABLED=false` ; rate limit 429 (`AUTH_RATE_LIMIT_CODE`) ; login après acceptation → JWT `orgId` correct ; réponse sans donnée sensible ; champs interdits → 400.

## Résultats (une exécution chacune)
- `pnpm --filter api test` : **515/515**, 33 suites (baseline 494 + 21).
- `pnpm --filter api test:e2e` : **149/149**, 5 suites (baseline 136 + 13, dont les rollbacks/invariants simulés attendus loggés en ERROR).
- `pnpm --filter api exec eslint "{src,apps,libs,test}/**/*.ts"` : **0 erreur**, 2 warnings préexistants inchangés. `--fix` limité aux 8 fichiers de la phase.
- `pnpm --filter api build` : OK. `git diff --check` : OK (LF→CRLF Windows inoffensifs).

## Risques résiduels
- `User.role` reste temporairement l’autorité utilisée par les `RolesGuard` jusqu’à la phase 1-7. La Membership contient déjà le rôle organisationnel futur, mais il n’est pas encore consommé par les gardes. Ainsi, un membre invité comme admin reste traité comme seller par les routes protégées jusqu’à 1-7, sans escalade inter-organisation.
- Rate limiting mémoire non distribué (hérité 0B.6), désormais aussi sur cette route.
- Aucun email/Resend/frontend/`PermissionGuard` — hors périmètre.

Aucun commit, aucun push — en attente de validation.
