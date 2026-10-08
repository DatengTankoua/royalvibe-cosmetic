# Phase 1-9C — Interface organisation : branding, membres et invitations

**Branche** `architecture/phase-1-9c-organization-administration-ui` · **Base** `65587bc` (1-9B) — aucun commit, aucun push, aucun accès Atlas/Supabase/27017, aucun package ajouté.

## Fichiers

Backend : `api/src/auth/auth.controller.ts` (+`GET /auth/context`), `api/src/auth/auth.controller.spec.ts` (+2 tests), `api/test/auth-context.e2e-spec.ts` (nouveau, 5 tests). **Correction sécurité** : `api/src/organizations/organizations.service.ts` (`createInvitation` — anti-escalade), `api/src/organizations/organizations.service.spec.ts` (+9 tests), `api/test/invitations.e2e-spec.ts` (+6 tests).

Frontend : `lib/api.ts` (+`updateOrganizationBranding`/`removeOrganizationLogo`/`fetchAuthContext`/`fetchMembers`/`updateMember`/`transferOwnership`/`fetchInvitations`/`createInvitation`/`revokeInvitation` + types associés), `lib/organization-permissions.ts` (nouveau, miroir des constantes backend), `lib/organization-errors.ts` (nouveau, traduction des codes métier), `contexts/organization-shell-context.tsx` (+`authContext`/`refreshShell`), `app/app/layout.tsx` (+chargement `GET /auth/context`, lien nav « Organisation » desktop/mobile, `refreshShell`), `app/app/organization/layout.tsx` (nouveau, onglets filtrés par permission), `app/app/organization/page.tsx` (nouveau, redirection), `app/app/organization/branding/page.tsx` (nouveau), `app/app/organization/members/page.tsx` (nouveau), `app/app/organization/invitations/page.tsx` (nouveau), `components/organization/permission-checkboxes.tsx`, `components/organization/edit-member-dialog.tsx`, `components/organization/create-invitation-dialog.tsx` (nouveaux).

## Préflight du contexte d'autorisation

Vérifié : le frontend n'avait aucune source fiable de rôle/permissions (`ApiUser.role` = `User.role` legacy `admin|seller`, explicitement hors périmètre pour les décisions d'autorisation). Ajout du plus petit endpoint possible : `GET /auth/context`, sans nouveau décorateur — lit exclusivement `request.organizationContext` (branché par `OrganizationGuard`, déjà global) et calcule `effectivePermissions` via la fonction existante `organizations/permissions.ts::effectivePermissions`. Réponse exacte :
```json
{ "userId", "organizationId", "role", "permissions", "effectivePermissions" }
```
Aucune donnée depuis body/query/header ; `membershipId` volontairement exclu de la réponse (hors contrat). N'a **pas** `@SkipOrganizationContext` : une organisation courante suspendue reçoit le même 403 uniforme `ORGANIZATION_ACCESS_DENIED` que toute autre route protégée (comportement volontaire — ce contexte n'a de sens que pour une organisation active résolue).

## Matrice permission → écran/action

| Écran / action | Permission requise | Lecture sans permission ? |
|---|---|---|
| Nav « Organisation » (lien) | aucune | toujours visible (membre actif) |
| `/app/organization/branding` — lecture | aucune (`OrganizationGuard` seul) | oui, tout membre actif |
| `/app/organization/branding` — édition (nom/couleur/logo) | `branding.manage` | non — formulaire remplacé par un message lecture seule |
| Onglet + `/app/organization/members` | `members.manage` | non — page bloquée avant toute requête |
| Édition membre (role/permissions/status) | `members.manage` | — |
| Transfert de propriété | rôle `owner` STRICT (`@OwnerOnly('ownership.transfer')`, jamais via `permissions`) | — |
| Onglet + `/app/organization/invitations` | `members.invite` | non — page bloquée avant toute requête |
| Création/révocation d'invitation | `members.invite` | — |

Masquage frontend (onglets, boutons) = UX uniquement ; chaque route backend reste gardée indépendamment (`PermissionGuard`/`OrganizationGuard`/`@OwnerOnly`, inchangés).

## CORRECTION SÉCURITÉ — anti-escalade serveur des invitations

**Chemin inspecté** : `OrganizationsController.create` (`POST /organizations/invitations`, classe décorée `@RequirePermissions('members.invite')`) → `OrganizationsService.createInvitation(organizationId, invitedById, dto)` → `this.invitationModel.create(...)`.

**Constat AVANT correction** (vérifié par lecture directe du code, pas supposé) : `PermissionGuard` vérifie uniquement que l'acteur possède la permission `members.invite` — il ne vérifie **jamais** que `dto.role`/`dto.permissions` (le rôle et les permissions à accorder à l'invité) restent un sous-ensemble des permissions effectives de l'acteur. `createInvitation` ne relisait aucune membership d'acteur et ne calculait aucun `effectivePermissions`/`isPermissionSubset` — contrairement à `updateMembership` (1-7C), qui a ce garde-fou. **Confirmé exploitable** : un `seller` avec uniquement `members.invite` délégué pouvait émettre une invitation `role=admin` (permissions par défaut = tout le délégable) ou greffer une permission qu'il ne possédait pas — élévation de privilèges confirmée empiriquement (voir « preuve rouge→vert » ci-dessous).

**Correction appliquée** dans `OrganizationsService.createInvitation` (AVANT toute lecture email/pending, donc avant toute écriture) :
1. Relit la membership ACTUELLE de l'acteur : `membershipModel.findOne({organizationId, userId: invitedById})` — jamais `organizationContext`/JWT/body (ceux-ci ne sont même plus passés au service pour le rôle/permissions de l'acteur).
2. Acteur absent ou `status !== active` → **403 `PERMISSION_DENIED`**.
3. `actorEffective = effectivePermissions(actor.role, actor.permissions)`.
4. Si `actor.role !== owner` : exige `actorEffective.has('members.invite')` (défense en profondeur contre un TOCTOU si l'acteur a perdu la permission entre la garde HTTP et l'exécution du service), sinon 403.
5. `invitedEffective = effectivePermissions(dto.role, dto.permissions ?? [])` doit être `⊆ actorEffective` via `isPermissionSubset()`, sinon **403 `PERMISSION_DENIED`**.
6. `owner` contourne cette borne (permissions effectives déjà l'ensemble complet — même convention que `updateMembership`).
7. Contrat HTTP de succès et cycle du token **inchangés** (aucune modification du contrôleur, de `CreateInvitationDto`, ni de la réponse `{invitation, token}`).

**Preuve exacte (tests, tous verts)** :
- Unitaires (`organizations.service.spec.ts`, describe `anti-escalade`) : owner→admin succès ; admin→seller dans ses droits succès ; seller délégué `members.invite` seul → `role=admin` → 403 `PERMISSION_DENIED`, `invitationModel.create` jamais appelé, `usersService.findByEmail` jamais appelé (refus AVANT toute autre logique) ; seller tente une permission non possédée → 403, zéro écriture ; seller invite un seller avec un sous-ensemble autorisé → succès ; acteur absent → 403 ; acteur inactif (suspendu) → 403 ; acteur sans `members.invite` → 403.
- E2E (`invitations.e2e-spec.ts`, describe `Anti-escalade des invitations (1-9C)`, requêtes **`supertest` brutes**, aucun frontend impliqué — preuve directe que le frontend n'est pas l'autorité) : seller délégué `members.invite` seul forge `role=admin` → 403, `invitationModel.countDocuments()` inchangé, aucune invitation créée pour cet email ; seller forge une permission non possédée (`members.manage`) → 403, zéro écriture ; seller invite un seller avec un sous-ensemble de ses propres permissions → 201 ; **isolation** : un utilisateur `admin` actif dans l'organisation B mais seulement `seller`+`members.invite` dans l'organisation A ne peut PAS exploiter son rôle B depuis le contexte HTTP de A (JWT = org A) → 403, prouvant que la relecture serveur filtre par `(organizationId, userId)` et non par `userId` seul ; contrôle positif : owner conserve la capacité normale d'inviter un admin (non régressé).
- **Preuve rouge→vert vérifiée** (pas une affirmation non testée) : `git stash push -- api/src/organizations/organizations.service.ts` (retire uniquement le correctif, conserve les nouveaux tests), puis `npx jest organizations.service.spec.ts -t "anti-escalade"` → **5 des 9 tests échouent réellement** sur le code d'avant correction (`seller délégué invite admin`, `seller délègue une permission non possédée`, `acteur sans members.invite`, `acteur absent`, `acteur inactif` — tous obtiennent un succès/`undefined` au lieu du 403 attendu), tandis que les 4 tests de contrôle positif (owner/admin/seller dans leurs droits) passaient déjà avant. `git stash pop` restaure le correctif → les 9 tests repassent au vert (confirmé par une seconde exécution). Ceci prouve à la fois que la vulnérabilité était réelle et que les tests la détectent effectivement (pas un faux positif de test mal conçu).

**Édition frontend vérifiée** : le commentaire dans `components/organization/permission-checkboxes.tsx` (« le backend refuse de toute façon tout dépassement ») était **exact pour l'édition de membres** (`updateMembership` avait déjà ce garde-fou) mais **inexact pour la création d'invitation** avant cette correction — il est maintenant vrai pour les deux usages du composant (édition de membre ET création d'invitation), chacun couvert par un test dédié ci-dessus. Aucune modification du composant n'était nécessaire (son comportement de bornage aux `effectivePermissions` de l'acteur était déjà correct côté UX ; seul le backend manquait la vérification miroir).

## Cycle invitation

1. `members.invite` → formulaire email + rôle (`admin`/`seller`, jamais `owner`) + permissions supplémentaires (checkboxes bornées aux `effectivePermissions` de l'acteur — anti-escalade UX, le backend refuse de toute façon tout dépassement via `isPermissionSubset`).
2. `POST /organizations/invitations` renvoie `{invitation, token}` — le lien `${origin}/auth/invitations/accept?token=...` est affiché **une seule fois**, avec bouton Copier (`navigator.clipboard`).
3. Fermeture/rechargement de la boîte de dialogue → état réinitialisé, **aucune tentative de reconstruction** du token (jamais persisté en localStorage/sessionStorage, jamais journalisé — vérifié : aucun `console.*`/stockage sur `token`).
4. Liste : badges rôle/statut (`pending`/`accepted`/`revoked`/`expired`) + permissions accordées ; révocation (`POST .../:id/revoke`) confirmée par `AlertDialog`, uniquement proposée si `status === "pending"`.

## Cycle logo / branding

1. Lecture (`GET /organizations/current`) : accessible à tout membre actif, formulaire remplacé par un message lecture seule si `branding.manage` absent.
2. Édition : `name`/`brandColor`/`logo` uniquement — aucun champ interdit (`slug`/`currency`/`status`/`logoKey`/`organizationId`) n'est jamais construit côté client (whitelist stricte déjà en place côté backend, `forbidNonWhitelisted`).
3. Aperçu logo (via `URL.createObjectURL`, révoqué au changement/démontage) + pastille de couleur en direct pendant la saisie.
4. `PATCH /organizations/current/branding` (multipart) puis `DELETE /organizations/current/logo` réutilisent les endpoints 1-8A tels quels.
5. Après succès : `refreshShell()` (nouveau — incrémente un compteur qui refait le triptyque `fetchCurrentOrganization`/`fetchActiveOrganizations`/`fetchAuthContext` sans recharger la page) — le header (nom, pastille couleur) et l'accès aux onglets se rafraîchissent immédiatement.

## Membres

- Vue strictement celle renvoyée par `GET /organizations/members` (`membershipId`, `user{_id,name,email}`, `role`, `permissions`, `status`, `joinedAt`) — aucun champ inventé.
- Édition (`PATCH /organizations/members/:id`) : rôle limité à `admin`/`seller` (jamais `owner`, cohérent avec `ASSIGNABLE_MEMBER_ROLES` backend), permissions bornées aux `effectivePermissions` de l'acteur, statut `active`/`suspended`/`revoked`.
- Bouton « Modifier » **absent** pour la ligne du propriétaire et pour la ligne de l'utilisateur courant (comparaison `member.user._id === authContext.userId`) — jamais de self-management proposé visuellement, en plus du refus serveur (`SELF_MANAGEMENT_FORBIDDEN`/`OWNER_NOT_MANAGEABLE`).
- Transfert de propriété : bouton visible uniquement si `authContext.role === "owner"`, cible active, non-soi, non-déjà-propriétaire ; confirmation explicite via `AlertDialog` avant l'appel `POST .../transfer-ownership`.
- Codes métier traduits (`lib/organization-errors.ts`) plutôt que le message générique « Accès refusé. » : `SELF_MANAGEMENT_FORBIDDEN`, `OWNER_NOT_MANAGEABLE`, `EMPTY_MEMBERSHIP_UPDATE`, `TRANSFER_TARGET_IS_CURRENT_OWNER`, `TRANSFER_TARGET_NOT_ACTIVE`, `MEMBER_ALREADY_ACTIVE`, `INVITATION_ALREADY_PENDING`, `EMPTY_BRANDING_UPDATE`, `PERMISSION_DENIED`.

## Isolation

- `GET /auth/context` : testé en e2e sur organisation active/membership suspendue (403 uniforme)/organisation courante suspendue après émission du JWT (403, cette route n'a pas `@SkipOrganizationContext`) ; jamais `membershipId` dans la réponse ; `effectivePermissions` vérifié = union rôle par défaut ∪ permissions accordées (cas owner = tout le délégable, cas seller+extra = défauts ∪ `analytics.read`, jamais de fuite d'une permission non accordée comme `members.manage`).
- Toutes les mutations organisation/membres/invitations réutilisent les routes 1-6B/1-7C/1-8A existantes, dont l'isolation tenant (`organizationId` exclusivement depuis `@CurrentOrganization()`) était déjà couverte par leurs specs respectives — aucune régression introduite (aucun de ces fichiers backend modifié).
- Frontend : aucun `organizationId` client libre (jamais construit/envoyé par aucun des nouveaux appels), aucune décision d'autorisation sur `User.role`, aucun `dangerouslySetInnerHTML`, aucun token d'invitation journalisé/persisté.

## Résultats

- Backend : unit **653/653** (38 suites, +2 pour `GET /auth/context`, +9 pour l'anti-escalade des invitations) ; e2e **205/205** (9 suites, +5 pour `auth-context.e2e-spec.ts`, +6 pour l'anti-escalade/isolation dans `invitations.e2e-spec.ts`) ; eslint api 0 erreur, **2 warnings** (tous deux historiques et inchangés — le warning introduit par mon propre `auth-context.e2e-spec.ts` a été corrigé : lecture de `res.body` comme `unknown` puis validation de forme via une fonction `asserts`, sans `any`/`eslint-disable`/assertion non sûre) ; `nest build` OK.
- Frontend : eslint web 0 erreur/0 warning ; `next build` OK — les 3 nouvelles routes (`/app/organization`, `/app/organization/branding`, `/app/organization/members`, `/app/organization/invitations`) compilent en pages statiques, aucune régression sur les routes existantes.
- `git diff --check` propre (seuls avertissements CRLF/LF, comme en 1-9B).
- Vérification manuelle : **revue structurée du code** (classes responsive, états loading/erreur/vide/succès, `overflow-x-auto` sur les onglets, `pb-[env(safe-area-inset-bottom)]` inchangé sur la nav mobile, 3 items `flex-1` dans la barre mobile) plutôt qu'un test live dans un navigateur — voir risques résiduels.

## Risques résiduels

- **Pas de test manuel en navigateur réel** : la contrainte « aucun accès Atlas/Supabase/27017 » a été interprétée comme excluant aussi de lancer `nest start`/`next dev` contre une base réelle (risque de toucher une instance non éphémère) ; la validation mobile/desktop s'appuie donc uniquement sur la revue du code et les classes Tailwind, pas sur un rendu observé. Recommandation : validation visuelle rapide avant merge (les e2e jest utilisent une Mongo éphémère, jamais testées via UI).
- En-tête desktop (`app/app/layout.tsx`) : l'ajout du lien « Organisation » à côté du nom d'organisation et du bouton de switch peut devenir chargé sur les largeurs `sm` étroites (640–768px) — pas de repli testé visuellement à cette largeur précise.
- `lib/organization-permissions.ts` est un miroir manuel de `api/src/organizations/permissions.ts::DELEGABLE_PERMISSIONS` (aucun endpoint n'expose ce catalogue complet, seulement les permissions accordées via `/auth/context`) — toute évolution future de la liste backend doit être répercutée manuellement ici.
- Le lien « Organisation » reste visible même quand `noActiveOrganization` est vrai (aucune organisation active) ; cliquer dessus affiche simplement le même message de repli déjà existant (aucune casse), mais ce n'est pas un masquage parfaitement cohérent — jugé mineur, non corrigé pour rester dans le périmètre strict de la demande.
- La correction anti-escalade ne modifie que `createInvitation` (chemin explicitement audité). `acceptInvitation`, `updateMembership` et `transferOwnership` n'ont pas été ré-audités dans le cadre de cette correction ciblée — `updateMembership`/`transferOwnership` avaient déjà leur propre garde-fou vérifié en 1-7C ; `acceptInvitation` ne fait que copier `role`/`permissions` déjà validés à l'émission de l'invitation (donc déjà bornés par cette correction), aucun risque résiduel identifié mais non ré-audité ligne à ligne dans cette session.

Aucun commit, aucun push — en attente de validation.
