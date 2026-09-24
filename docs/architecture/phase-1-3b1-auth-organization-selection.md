# Phase 1-3B.1 — Connexion multi-organisation et JWT organisationnel

Base : branche `architecture/phase-1-3a-organization-resolution`, HEAD `fd90436` (1-3A, commit utilisateur).
Branche : `architecture/phase-1-3b1-auth-organization-selection`.
**Non déployable seul** : 1-3B.2 (résolution d'organisation des routes métier) puis 1-4 suivent ; le rôle
provient toujours de `User.role` (RolesGuard inchangé, jusqu'à 1-7). Périmètre validé : **8 prod / 9 tests / 1 rapport**.

## 1. Contrat `/auth/login` (POST, **201 confirmé** — code + E2E)
DTO : `email`, `password`, `organizationId?` (`@IsOptional` + `@IsMongoId`) ; champ inconnu → 400.
Identifiants invalides → 401 inchangé (aucune requête organisationnelle).
- **A** — 0 org active → 403 uniforme `{ code: ORGANIZATION_ACCESS_DENIED, message: "Accès à l'organisation refusé." }`.
- **B** — 1 org, pas de choix → auto-sélection + JWT.
- **C** — plusieurs, pas de choix → **201 sans JWT**, corps `organizationSelectionRequired: true` +
  `organizations: [{ organizationId, name }]` triées par `name` puis `organizationId` (déterministe) ; jamais de
  permissions/membershipId ; jamais de token temporaire.
- **D** — `organizationId` fourni → `resolveActiveContext()` (1-3A) puis JWT : `orgId` = org résolue de la
  membership (jamais l'id client tel quel).

## 2. Contrat JWT
Payload signé **exclusivement** `{ sub, orgId }` (7 jours, JwtModule inchangé) : `email`/`role` **retirés**.
`JwtStrategy.validate` : **validation STRICTE d'ObjectId (string + 24 hex, jamais de cast — aucun
`isValidObjectId`) sur `sub` ET `orgId` AVANT toute requête DB** (anti-`CastError` 500) ; user TOUJOURS
chargée depuis la base ; 401 contrôlée sinon. Le rôle servi aux gardes vient du **document User** (historique
`User.role` conservé jusqu'à 1-7). Socket.IO (0B.3, middleware ajusté) : même validation stricte
avant DB ; principal `socket.data.user = { sub, orgId, email, role }` — sub/orgId du JWT vérifié, email/role
**exclusivement du document User DB** (claims token ignorés) ; `orgId` attaché pour la future isolation par rooms.

## 3. `/auth/switch-organization` (POST, **200 explicite**)
DTO `SwitchOrganizationDto { organizationId }` (`@IsMongoId` obligatoire). JWT requis. `sub` exclusif de
`@CurrentUser()` (jamais du body → `userId` en body = 400). Re-vérification `resolveActiveContext` → nouveau
JWT `{ sub identique, orgId nouveau }`. Aucune écriture persistante ; ancien token valide (E2E) ; inaccessibles
→ 403 uniforme. **Register** (201 inchangé) : corps désormais `{ user }`, sans token (l'inscrit n'appartient à
aucune org) ; hash bcrypt stocké, `password` absente ; garde 403 `REGISTRATION_DISABLED` inchangée.

## 4. `OrganizationsService.listActiveOrganizations`
Memberships **actives** de l'utilisateur → organisations **actives** uniquement, résolues DEPUIS la
membership (`findById(membership.organizationId)`), vue minimale `{ organizationId, name }`, **triee par `name`
puis `organizationId`** (critère secondaire explicite — indépendant de l'ordre Mongo et de la stabilité du tri
JS), sans cache, ids stringifiés. `resolveActiveContext` : préflight **strict** (string + 24 hex) des deux ids.

## 5. Fichiers
**Production (8)** : `src/auth/{auth.service.ts, auth.controller.ts, auth.module.ts, dto/login.dto.ts,
dto/switch-organization.dto.ts (N), strategies/jwt.strategy.ts}`, `src/events/socket-auth.middleware.ts`,
`src/organizations/organizations.service.ts`.
**Test (9)** : `src/auth/{auth.service.spec.ts, auth.controller.spec.ts, dto/auth.dto.spec.ts,
strategies/jwt.strategy.spec.ts (N)}`, `src/events/socket-auth.middleware.spec.ts`,
`src/organizations/organizations.service.spec.ts` (9e autorisé, tests directs `listActiveOrganizations`),
`test/{app.e2e-spec.ts, socket.e2e-spec.ts, sales-transaction.e2e-spec.ts}`. + **1 rapport** (ce fichier).

## 6. Matrice de tests unitaires
1-12 AuthService (register `{ user }` sans token / refus cred. sans req. org / A / B / C corps stable +
absence de clés sensibles / D valide / D inaccessible / payload signé exact sans email-role / switch sub
appelant / switch inaccessible), 13-17 JwtStrategy (valide, rôle du doc DB malgré role falsifié dans le
token ; `it.each` sub/orgId absents/invalides/vides/non-string → 401 sans requête DB ; user absente),
**18 JwtStrategy ObjectId STRICT : 18 cas ×2 champs (nombre, booléen, objet, tableau, null, absent, chaîne
vide, 12 caractères non-hex, 24 caractères dont un non-hex) → 401 AVANT toute requête DB**, 19-20 DTO,
21-23 Controller, **24 Socket ObjectId STRICT : 18 cas ×2 → refus `unauthorized` AVANT toute requête DB
(`findById` jamais appelé), principal non attaché**, **25-34 Organizations `listActiveOrganizations`
(11 tests directs : filtre `{ userId, status: active }` en ObjectId + exclusion other-user ; lookup org via
membership ; membres suspendues/révoquées exclues ; org absente/suspendue exclue ; résultat minimal exact ;
aucune key sensible ; tri par nom ; départage `organizationId` sur noms égaux (entrée inversée → sortie stable) ;
source non mutée ; zéro accessible → `[]` sans recherche org)**. RED→GREEN documenté.

## 7. E2E — adaptations + 8 nouveaux cas (`app.e2e-spec.ts` §9)
3 fixtures adaptées (app : orgs A/B + memberships + user multi ; socket : org unique + memberships, login avec
orgId ; sales-transaction : org + membership owner, auto-sélection). Fixtures : `new Types.ObjectId(...)` à
l'écriture (une chaîne hex brute n'est pas castée en ObjectId par Mongoose à l'insertion) + membership créée
AVANT le login concerné. 8 cas : login mono-org 201 + payload `{ sub, orgId }` sans email/role + `exp-iat`
∈ [6j, 8j] ; liste multi (corps exact, ordre par nom) ; login avec org choisie ; org inaccessible 403 uniforme ;
switch A→B (200, même sub, ancien token vivant via `/auth/me`) ; switch sans JWT 401 ; switch inaccessible 403 ;
`userId` en body → 400. `clearThrottle` avant chaque cas (§9, garde 10/60 s).

## 8. Résultats mesurés (une exécution chacun, ordre spec)
| # | Commande | Résultat |
|---|---|---|
| 1 | jest ciblées phase (6 specs) | **159 passed / 6 suites** |
| 2 | `pnpm --filter api test` | **322 passed / 21 suites** (baseline 274 + 48 : 18 Jwt strict + 18 socket strict + 12 `listActiveOrganizations`) |
| 3 | `pnpm --filter api test:e2e` | **61 passed / 3 suites** (inchangé ; les 2 ERROR loguées de la suite sales-transaction sont les échecs simulés ATTENDUS) |
| 4 | `npx eslint "{src,apps,libs,test}/**/*.ts"` | **0 erreur** ; 2 warnings préexistants (`app.e2e-spec.ts:378`, `ephemeral-mongodb.ts:67`) — `--fix` appliqué **uniquement** sur les fichiers de la phase (écart documenté, cf. 1-3A) |
| 5 | `pnpm --filter api build` | **OK** (exit 0) |
| 6 | `git diff --check` | exit 0 — aucun défaut (9 warnings LF→CRLF inoffensifs, Windows) |
| 7 | `git status --short` | `M` ×15 + `A` (intent-to-add) ×3 — 8 prod + 9 test + rapport, sans aucun autre fichier |
| 8 | `git diff --name-status` | identique : 18 entrées = 8 prod (7 M + 1 A) + 9 test (8 M + 1 A) + 1 rapport (A) |
| 9 | `git diff --stat` | 18 files, **+1641 / −214** |
| 10 | `git rev-parse HEAD` | `fd90436694c7b47ba947cb1dfa5631d21752b711` (inchangé) |

## 9. Limites / rappels
Frontend inchangé ; aucune dépendance ajoutée ; RolesGuard inchangé ; pas de Redis ni de session serveur ;
aucun utilitaire partagé créé (validation stricte répétée localement dans les 3 fichiers, comme demandé) ;
le JWT ne porte plus de rôle ; rate limiting mémoire (Redis obligatoire avant mise à l'échelle) ; décision
1-2A abandonnée (jamais fusionnée). **Aucun commit, aucun push.**
