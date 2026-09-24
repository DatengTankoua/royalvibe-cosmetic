# Phase 1-3B.2 — Garde et contexte organisationnel HTTP

Terminée, en attente de validation. Aucune donnée réelle, aucun accès 27017.

## 1. Base git — 2. Fichiers

Branche `architecture/phase-1-3b2-http-organization-context` ; HEAD base
`a223d8d003640c514ac2203ee6bb450cf3c1ee28` (1-3B.1), non modifié, aucun
commit/push.
- Production (4) : `organization.guard.ts` (NOUVEL),
  `current-organization.decorator.ts` (NOUVEL), `auth.module.ts`
  (enregistrement global), `jwt.strategy.ts` (retourne un NOUVEAU principal
  explicite `{ _id, name, email, role, organizationId }` — jamais un document
  Mongoose muté ; `organizationId` = claim `orgId` vérifié du JWT,
  exclusivement ; `password` absent). `organizations.service.ts` non modifié.
- Tests (2) : `organization.guard.spec.ts` (NOUVEL, 10 cas) ;
  `app.e2e-spec.ts` (+8 cas §10, fixtures restaurés, sans `sleep`).

## 3. Ordre final des gardes (source : `AuthModule`)

`JwtAuthGuard → OrganizationGuard → RolesGuard` (trois `APP_GUARD`, ordre des
providers) : sans JWT → 401 ; membership/org inactives → 403 org ; contexte
valide → RolesGuard puis contrôleur.

## 4. Contrat exact

- Garde : non-HTTP (Socket.IO) → passe ; `@Public()` → passe (MÊME clé
  `IS_PUBLIC_KEY`) ; sinon `sub = user._id.toString()`, `orgId =
  user.organizationId` (principal explicite de `JwtStrategy`, claim strictement
  validé avant toute requête) ; `resolveActiveContext()` UNE fois, résultat
  branché sur `request.organizationContext` ; principal absent/incomplet →
  401 contrôlée (jamais 500) ; le 403 (`ORGANIZATION_ACCESS_DENIED`) remonte
  sans transformation ; `request.user` jamais muté.
- Décorateur : renvoie UNIQUEMENT `request.organizationContext`
  (`ResolvedOrganizationContext`), pas de `any`, pas de re-lookup DB ; contrat
  de `/auth/me` inchangé (pas de consommation cette phase).

## 5. Preuve — le client ne détermine jamais l'organisation

- Zéro lecture de `body`/`headers`/`query`/`params` par la garde (pas même
  `Authorization`, déjà vérifiée par JwtAuthGuard).
- `sub` = document User de la base ; `orgId` = claim signé validé strictement
  (string + 24 hex) AVANT la requête DB, porté par le principal explicite.
- Unitaires 3,6 : appel exact UNE fois malgré falsifications
  (`toHaveBeenCalledWith(USER_ID, ORG_A_ID)`).
- E2E H : `organizationId` falsifiée (body + headers + query) → 200 avec
  l'utilisateur signé ; E2E B–E : ni org ni statut forcibles par la requête.

## 6. Matrice ajoutée

- Unitaires (10) : non-HTTP ; `@Public` sans résolution ; appel exact UNE fois ;
  contexte attaché (même instance) ; `request.user` intact ; falsifications
  ignorées ; principal absent/incomplet → 401 (avant service) ; 403 non
  transformé (même instance) ; décorateur → contexte exact ; ordre lu dans la
  config du module. + 1 assertion `jwt.strategy.spec` (`organizationId`).
- E2E (8) : (A) actives → `/auth/me` 200 ; (B)–(E) membership suspendue /
  révoquée / supprimée (restauration brute, même `_id`) + org suspendue → 403
  code + message exacts ; (F) sans JWT → 401 pas 403 ; (G) `/auth/login`
  public, contrat 1-3B.1 intact (non exposé `password`/`organizationId`) ;
  (H) org falsifiée jamais substituée.

## 7. Comptes finaux — 8. ESLint / build / Git

- Unitaires : **332 passed / 22 suites** (base 322/21 ; +10).
- E2E : **69 passed / 3 suites** (base 61/3 ; +8).
- ESLint (sans `--fix`) : 0 erreur, 2 warnings pré-existants. Build : OK.
- `git diff --check` : OK. `git rev-parse HEAD` :
  `a223d8d003640c514ac2203ee6bb450cf3c1ee28`.

## 9. Limites résiduelles — 10. Confirmation

- Non déployable seule avant 1-4 : aucun filtrage des requêtes MongoDB métier
  (Sections/Products/Sales/Analytics/…) ; contexte branché mais non consumé ;
  `@CurrentOrganization()` pas encore utilisé sur une route. Écart assumé :
  `jwt.strategy.ts` modifié au lieu d'un 4e fichier pur org.
- Aucun commit, aucun push, aucune donnée réelle, aucun accès 27017, aucun
  changement frontend, aucune dépendance ajoutée. En attente de « je valide ».
