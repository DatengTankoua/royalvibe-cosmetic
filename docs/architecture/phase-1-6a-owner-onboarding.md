# Phase 1-6A — Inscription atomique du propriétaire et de son organisation

**Branche** `architecture/phase-1-6a-owner-onboarding` · **Base** `be137e5` (1-5B) — aucun commit, aucun push, aucun accès 27017/Atlas.

## Contrat avant/après
- `POST /auth/register` **conservé** (pas de second endpoint). DTO strict `{ name, email, password, organizationName }` — tout champ inconnu (`organizationId`, `slug`, `role`, `permissions`, `status`, `currency`, `brandColor`, `ownerId`…) → 400 (`forbidNonWhitelisted`), avant toute logique.
- Avant : `AuthService.register` créait un `User` isolé (rôle `seller` par défaut). Après : onboarding **atomique** `User` (rôle legacy `admin`, jamais exposé) + `Organization` (branding/devise du schéma) + `OrganizationMembership` `owner` actif (`permissions: []`, `invitedById: null`).
- `PUBLIC_REGISTRATION_ENABLED` reste l'autorité finale (garde du contrôleur, avant le DTO/la transaction) : 403 `REGISTRATION_DISABLED` exact si différent de `'true'`. Aucune inscription seller/admin directe (invitation en 1-6B).

## Transaction (`AuthService.registerOwner`)
`connection.startSession()` → `session.withTransaction`: `UsersService.create(..., session)` (E11000 → conflit stable existant, message inchangé) → `OrganizationsService.createOwnerOrganization(name, ownerId, session)` (même session) qui crée l'Organization puis la Membership `owner`, et vérifie `countDocuments` (même session) qu'il existe **exactement 1** owner actif (garde défensive au-delà de l'index partiel `≤1`). `endSession()` dans un `finally` systématique. Toute erreur (Organization ou Membership) abandonne la transaction : rollback complet, aucune donnée partielle.

## Slug
`generateOrganizationSlug` (`organizations.service.ts`) : nom → diacritiques retirés, minuscules, `[0-9a-z-]` uniquement, tronqué à 60 + suffixe `crypto.randomBytes(4)` (8 hex, jamais `Math.random`), total ≤ 80 — jamais fourni par le client.

## Réponse 201
`{ user: { _id, name, email }, organization: { _id, name, slug, currency, status } }` — aucun token, hash, rôle legacy, permission ni `membershipId` (assertions exactes E2E + unitaires). Rate limiting : `AuthThrottlerGuard` (mêmes fenêtres/stockage que `/auth/login`, clé distincte par handler — contrat login intact).

## Fichiers (5 prod + 7 tests + 1 rapport)
Prod : `auth/dto/register.dto.ts`, `auth/auth.controller.ts` (garde throttler), `auth/auth.service.ts`, `organizations/organizations.service.ts`, `users/users.service.ts` (rôle + session).
Tests : `auth/dto/auth.dto.spec.ts`, `auth/auth.controller.spec.ts`, `auth/auth.service.spec.ts` (session mockée façon `sales.service.spec.ts`), `test/app.e2e-spec.ts` (+describe 14, `MongoMemoryReplSet` réel), `test/{socket,sales-transaction,multitenant-isolation}.e2e-spec.ts` (fixtures adaptées).

## Compatibilité fixtures E2E
`organizationName` ajouté partout où `/auth/register` est appelé. Les users de fixture multi-org (`app.e2e-spec.ts` admin/seller/multi, `sales-transaction.e2e-spec.ts` admin A/B) sont créés **directement** (bcrypt, hors `/auth/register`) pour ne pas leur attacher une organisation parasite qui fausserait la sélection multi-org ou l'auto-sélection mono-org (admin B) — bug détecté et corrigé pendant le développement (401 en cascade). `socket`/`multitenant-isolation` : logins toujours explicites, simple ajout du champ.

## Tests (describe 14, réplica réel — aucun mock de driver)
Flag désactivé → 403 + zéro écriture (3 collections) ; succès → 1 User/1 Organization/1 owner actif, réponse exacte, rôle legacy jamais exposé ; login suivant → JWT `orgId` correct ; échec Organization → rollback User (monkeypatch `create` façon audit 1-4C.1) ; échec Membership → rollback User+Organization ; email concurrent (`Promise.all`) → 1×201/1×400, zéro doublon ; champs interdits → 400 avant écriture ; seconde exécution même email → conflit, triplet initial intact ; rate limit → 429 `AUTH_RATE_LIMIT_CODE`.

## Résultats (une exécution chacun)
- `pnpm --filter api test` : **455/455**, 29 suites (baseline 439 + 16).
- `pnpm --filter api test:e2e` : **126/126**, 4 suites (baseline 117 + 9, dont les rollbacks simulés attendus loggés en ERROR).
- `pnpm --filter api exec eslint "{src,apps,libs,test}/**/*.ts"` : **0 erreur**, 2 warnings préexistants (mêmes lignes logiques, décalées). `--fix` limité aux 12 fichiers de la phase (écart documenté depuis 1-3A).
- `pnpm --filter api build` : OK. `git diff --check` : OK (LF→CRLF Windows inoffensifs).

## Risques résiduels
- Retry `withTransaction` sur E11000 concurrent dépend du comportement transitoire du driver (observé fiable sur `MongoMemoryReplSet`, test à 20 s de marge).
- Rate limiting mémoire (non distribué, hérité de 0B.6) désormais aussi sur `/auth/register`.
- Aucun abonnement/email/invitation/frontend/branding Stock Master — hors périmètre 1-6A.

Aucun commit, aucun push — en attente de validation.
