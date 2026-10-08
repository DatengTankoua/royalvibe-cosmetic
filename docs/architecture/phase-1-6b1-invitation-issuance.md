# Phase 1-6B.1 — Émission sécurisée des invitations

**Branche** `architecture/phase-1-6b1-invitation-issuance` · **Base** `42ab897` (1-6A) — aucun commit, aucun push, aucun accès 27017/Atlas.

## Modèle `OrganizationInvitation` + index
`organizationId`/`email` (normalisé lower/trim)/`role` (`admin`|`seller`, jamais `owner`)/`permissions` (délégables uniquement, sans doublon, mêmes règles que la membership)/`tokenHash` (**`select:false`**, unique)/`invitedById`/`status` (`pending|accepted|revoked|expired`)/`expiresAt`/`acceptedAt` (null). **3 index** : `{tokenHash}` unique (prop) ; `{organizationId,status,createdAt:-1}` (liste) ; `{organizationId,email}` unique **partiel** (`status:'pending'`). **Aucun TTL** — les invitations expirées sont conservées, marquées `expired` seulement.

## Endpoints (`OrganizationsController`, nouveau — `organizations/invitations`)
`POST /organizations/invitations` (body strict `{email, role, permissions?}`, 201 `{invitation, token}`) · `GET /organizations/invitations` (200, tableau, jamais `tokenHash`) · `POST /organizations/invitations/:id/revoke` (200 explicite, `ParseObjectIdPipe`). `organizationId` provient **exclusivement** de `@CurrentOrganization()` — jamais du body/query/header (prouvé E2E, falsification sans effet).

## Autorisation (temporaire, avant `PermissionGuard` 1-7)
`assertOwner()` local au contrôleur : `context.role !== OrganizationRole.OWNER` → 403 `{code:'OWNER_ONLY'}`. Admin/seller refusés sur les 3 routes ; sans JWT → 401 (guard global, avant le contrôleur).

## Cycle du token
`randomBytes(32).toString('base64url')` renvoyé **une seule fois** (POST) ; seul `sha256(token)` hex est stocké (`tokenHash`, jamais sélectionné). Expiration **72h**, calculée serveur via un paramètre `now: Date` (horloge testable, jamais `Date.now()` en dur dans le service).

## Règles refusées
Email déjà membre **actif** de l'org → 409 `MEMBER_ALREADY_ACTIVE` (lookup via `UsersService.findByEmail`, **jamais** de création/lecture Membership hors ce contrôle). Invitation `pending` non expirée même (org,email) → 409 `INVITATION_ALREADY_PENDING`. `pending` **expirée** → marquée `expired` (`save()`) puis réémission acceptée. Rôle `owner`/permission inconnue ou owner-only/permission dupliquée → **400 DTO** (`IsIn`/`ArrayUnique`, avant toute écriture — aucun champ organisationnel accepté, `forbidNonWhitelisted`). Révocation étrangère/absente/déjà traitée → **même 404** (`findOneAndUpdate` filtré `{_id,organizationId,status:pending}`).

## Preuves A/B (réplica réel, `MongoMemoryReplSet`)
2 organisations créées via l'onboarding atomique 1-6A ; owner A n'obtient jamais les invitations de B (liste), ne peut jamais révoquer une invitation de B (404 identique à « absente ») ; falsification `organizationId` (query+header) sans effet, l'org stockée reste celle du JWT ; hash SHA-256 vérifié exact contre le token brut renvoyé.

## Fichiers (6 prod + 5 tests + 1 rapport)
Prod : `permissions.ts` (+`InvitationStatus`), `schemas/invitation.schema.ts` (N), `dto/create-invitation.dto.ts` (N), `organizations.service.ts` (+3 méthodes), `organizations.controller.ts` (N), `organizations.module.ts` (wiring `UsersModule`+contrôleur+schéma).
Tests : `schemas/invitation.schema.spec.ts` (N), `dto/create-invitation.dto.spec.ts` (N), `organizations.service.spec.ts` (+describe invitations, DI étendue), `organizations.controller.spec.ts` (N), `test/invitations.e2e-spec.ts` (N).

## Résultats (une exécution chacun)
- `pnpm --filter api test` : **494/494**, 32 suites (baseline 455 + 39).
- `pnpm --filter api test:e2e` : **136/136**, 5 suites (baseline 126 + 10, nouveau fichier `invitations.e2e-spec.ts`).
- `pnpm --filter api exec eslint "{src,apps,libs,test}/**/*.ts"` : **0 erreur**, 2 warnings préexistants inchangés. `--fix` limité aux 11 fichiers de la phase.
- `pnpm --filter api build` : OK. `git diff --check` : OK (LF→CRLF Windows inoffensifs).

## Risques résiduels
- `PermissionGuard` générique (1-7) remplacera `assertOwner()` — code temporaire assumé.
- Aucun email/Resend/acceptation/User/Membership créés — hors périmètre 1-6B.1 (1-6B.2 suivant).
- Rate limiting non appliqué à ces routes (non requis par la consigne, à revoir si abus constaté).

Aucun commit, aucun push — en attente de validation.
