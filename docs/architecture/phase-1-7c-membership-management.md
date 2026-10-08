# Phase 1-7C — Gestion sécurisée des membres et transfert de propriété

**Branche** `architecture/phase-1-7c-membership-management` · **Base** `d7c6c7d` (1-7B) — aucun commit, aucun push, aucun accès 27017/Atlas/Supabase. Inclut la **correction ciblée** post-revue (0 warning ESLint résiduel dans le fixture e2e).

## Objectif
Ajouter la gestion des memberships (`members.manage`) et le transfert de propriété (`ownership.transfer`), puis invalider les sockets du membre modifié après commit.

## Endpoints
| Route | Permission | Contrat |
|---|---|---|
| `GET /organizations/members` | `@RequirePermissions(members.manage)` | Liste tenant uniquement ; vue minimale `{membershipId, user:{_id,name,email}, role, permissions, status, joinedAt}` — jamais `password`/`User.role`. |
| `PATCH /organizations/members/:id` | `@RequirePermissions(members.manage)` | DTO strict `{role?, permissions?, status?}` (whitelist ; `role` ∈ {admin,seller} ; `status` ∈ {active,suspended,revoked} ; permissions délégables uniques) ; 400 si body vide ; filtre `{_id, organizationId}` (étrangère/absente → 404) ; self-management et cible `owner` refusés (403) ; aucune réactivation implicite. |
| `POST /organizations/members/:id/transfer-ownership` | `@OwnerOnly(ownership.transfer)` | Cible tenant/active/différente du propriétaire ; transaction unique : ancien owner→admin/active, cible→owner/active, garde « exactement un owner actif » avant commit. |

## Anti-escalade (`OrganizationsService`)
Acteur ET cible sont **relus dans la transaction** (jamais le `organizationContext` HTTP, potentiellement obsolète). `owner` gère tout membre non-owner sans restriction. Un non-owner délégué `members.manage` ne peut agir que si :
- `effectivePermissions(cible ACTUELLE) ⊆ effectivePermissions(acteur)` ;
- `effectivePermissions(cible PROSPECTIVE, après application du DTO) ⊆ effectivePermissions(acteur)`.

Aucun droit ne provient de `User.role`/JWT/body/header. Refus permission → `403 PERMISSION_DENIED` ; refus métier (self, owner-cible) → codes stables dédiés (`SELF_MANAGEMENT_FORBIDDEN`, `OWNER_NOT_MANAGEABLE`) ; aucune existence inter-org révélée (filtre composite → même 404).

Nouveau dans `organizations/permissions.ts` : `effectivePermissions(role, permissions)` et `isPermissionSubset(subset, superset)` — `hasPermission` refactorée dessus (non-behaviorel).

## Sockets
`SocketRegistryService` (nouveau, **exporté par `OrganizationsModule`** — jamais l'inverse : `EventsModule` importe déjà `OrganizationsModule`, ce qui évite un cycle) : registre en mémoire `Map<orgId:userId, Set<Socket>>`.
- `EventsGateway.handleConnection`/`handleDisconnect` enregistrent/désenregistrent chaque socket.
- `OrganizationsService` appelle `disconnectMember(...)` **après** `session.endSession()` réussi uniquement — jamais avant commit, jamais sur rollback (une erreur levée dans la transaction n'atteint jamais ce point).
- Après transfert : ancien **et** nouveau owner sont déconnectés.
- HTTP reste protégé immédiatement par `OrganizationGuard` (indépendant du registre socket).
- **Limite mono-instance** documentée en commentaire : ce registre vit en mémoire du process ; un déploiement horizontal perdrait les sockets d'une autre instance — un adaptateur Redis (`@socket.io/redis-adapter`) + canal pub/sub seraient requis avant tout scaling horizontal.

## Correction ciblée (post-revue)
`createMember()` (fixture `test/membership-management.e2e-spec.ts`) lisait `user._id`/`membership._id` depuis le retour de `Model.create(doc)` — Mongoose infère ce retour avec un type d'erreur pour ce schéma, propagé jusqu'aux appels `transferOwnership(token, c1.membershipId)`/`c2.membershipId` (2 warnings `no-unsafe-argument`). Correctif : `userId`/`membershipId` générés en amont (`new Types.ObjectId()`), passés explicitement en `_id` à la création, jamais relus depuis le document ; interface `CreatedMemberFixture` typée en retour. Le cast `access_token as string` de ce même helper est remplacé par une lecture `unknown` + `typeof` + échec explicite (`throw`) si non-string. Aucun `any`, aucun `eslint-disable`, aucun changement fonctionnel des tests (mêmes comportements, mêmes assertions). Seul `test/membership-management.e2e-spec.ts` a été modifié.

## Fichiers (7 prod + 5 tests)
Prod : `organizations/permissions.ts` (+`effectivePermissions`, `isPermissionSubset`), `organizations/organizations.service.ts` (+`listMembers`/`updateMembership`/`transferOwnership`), `organizations/organizations.module.ts` (+contrôleur, +`SocketRegistryService`), `organizations/organization-members.controller.ts` (nouveau, route `organizations/members`), `organizations/socket-registry.service.ts` (nouveau), `organizations/dto/update-membership.dto.ts` (nouveau), `events/events.gateway.ts` (+register/unregister).
Tests : `organizations/organizations.service.spec.ts` (+listMembers/updateMembership/transferOwnership, anti-escalade, rollback), `organizations/organization-members.controller.spec.ts` (nouveau, métadonnées + data-flow), `organizations/socket-registry.service.spec.ts` (nouveau), `events/events.gateway.spec.ts` (+register/unregister), `test/membership-management.e2e-spec.ts` (nouveau, 12 tests, `MongoMemoryReplSet` réel + `socket.io-client` réel).

## Matrice de tests (e2e réel)
Liste A exclut B ; seller sans `members.manage` → 403 ; délégué `members.manage` gère un pair sans escalader (refus si la cible a déjà plus de droits, ou si la permission demandée dépasse les siennes) ; owner modifie librement rôle/permissions/statut ; self-management et cible-owner refusés (codes stables) ; cible étrangère = 404 identique à l'absente ; falsification `organizationId` dans le body → 400 (whitelist) ; suspension bloque HTTP immédiatement + refuse une nouvelle connexion socket (`unauthorized`) ; socket déjà connectée déconnectée après commit ; refus anti-escalade → membership et socket inchangées (aucun disconnect) ; transfert atomique (exactement un owner actif, ancien→admin, cible→owner) ; ex-owner ne peut plus retransférer (403, owner-only jamais délégable) ; transfert concurrent (org dédiée) → exactement une réussite.

## Résultats (une exécution chacune)
- `pnpm --filter api test` : **603/603**, 36 suites (baseline 569 + 34).
- `pnpm --filter api test:e2e` : **166/166**, 6 suites (baseline 154 + 12 ; comptes inchangés après la correction ; rollbacks/invariants simulés attendus loggés en ERROR).
- `pnpm --filter api exec eslint "{src,apps,libs,test}/**/*.ts"` : **0 erreur**, **2 warnings** (les 2 historiques préexistants uniquement — `test/membership-management.e2e-spec.ts` : **0 warning**).
- `pnpm --filter api build` : OK. `git diff --check` : OK (LF→CRLF Windows inoffensifs).

## Hors périmètre
Aucun email, frontend, branding. `User.role` non supprimé (reste physique, ne décide toujours rien). `RolesGuard`/`@Roles` non touchés. `stock.adjust`/`branding.manage` toujours sans nouvel endpoint (inchangé depuis 1-7B).

Aucun commit, aucun push — en attente de validation.
