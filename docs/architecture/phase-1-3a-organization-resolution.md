# Phase 1-3A — Service de résolution organisationnelle

**Branche** `architecture/phase-1-3a-organization-resolution` · **Base** `e564cfd05be274492c3a9a05bbfef7070f573af6` (`architecture/phase-1-1b-tenant-fields`) — aucun commit, aucun push.

## Contrat du service

`api/src/organizations/organizations.service.ts` → `OrganizationsService` (provider + export de `OrganizationsModule`, aucun contrôleur).

```ts
resolveActiveContext(userId: string, organizationId: string): Promise<ResolvedOrganizationContext>
```

Flux : `isValidObjectId(userId/organizationId)` → `membershipModel.findOne({ userId, organizationId })` (couple exact) → refus si membership absente ou `status ≠ active` → `organizationModel.findById(organizationId)`** depuis la membership** (jamais l'ID client) → refus si org absente ou `status ≠ active` → contexte minimal `{ userId, organizationId, membershipId, role, permissions }` (ids en strings, **copie** des permissions, aucun document Mongoose). Sans calcul de permissions effectives, sans cache.

## Préflight ObjectId

`membership.organizationId` = `@Prop({ type: Types.ObjectId, ref: 'Organization' })` ; `membership.userId` = `@Prop({ type: Types.ObjectId, ref: 'User' })` — **aucun `Mixed`**, aucun arrêt, aucune correction.

## Refus uniformes

Tous les refus (2/3/4/5/6/7/8) → `ForbiddenException` : HTTP **403**, code **`ORGANIZATION_ACCESS_DENIED`**, message `"Accès à l'organisation refusé."` identique en toutes circonstances — ne révèle jamais l'existence/statut d'une organisation ou d'une membership. Aucune donnée sensible en log (aucun log). Convention existante suivie (`ForbiddenException({ code, message })`, cf. `REGISTRATION_DISABLED`).

## Matrice des tests (12 — `organizations.service.spec.ts`)

| # | Cas | Refus |
|---|-----|-------|
| 1 | contexte actif | — |
| 2 | userId invalide | 403 |
| 3 | organizationId invalide | 403 |
| 4 | membership absente (pas de recherche org) | 403 |
| 5 | membership suspendue (pas de recherche org) | 403 |
| 6 | membership révoquée (pas de recherche org) | 403 |
| 7 | organisation absente | 403 |
| 8 | organisation suspendue | 403 |
| 9 | filtre membership `{ userId, organizationId }` en ObjectId | — |
| 10 | org recherchée via l'ID de la membership (pas le paramètre) | — |
| 11 | code **et** message strictement identiques sur tous les refus | 403 |
| 12 | permissions retournées = copie (`not.toBe` + mutation isolée) | — |

RED : `Cannot find module './organizations.service'` (spec d'abord, 0/12) → GREEN : 12/12. Périmètre : 4 fichiers (3 nouveaux + `organizations.module.ts` modifié — statuts A/M dans les l.7–9 ci-dessous), aucun autre.

## Vérifications (1 seule exécution de chaque, ordre de la consigne)

| # | Commande | Résultat exact |
|---|----------|----------------|
| 1 | `npx jest src/organizations/organizations.service.spec.ts` (dans `api/`) | **12 passed** (1 suite / 2,1 s) |
| 2 | `pnpm --filter api test` | **20 suites, 241 passed** (baseline 229 + 12 — 11,5 s) |
| 3 | `pnpm --filter api test:e2e` | **3 suites, 53 passed** (baseline respectée — 21,7 s) |
| 4 | `npx eslint "{src,apps,libs,test}/**/*.ts"` — `api/`, **sans `--fix`** | **0 error, 2 warnings pré-existants** (`test/app.e2e-spec.ts:286`, `test/e2e/ephemeral-mongodb.ts:67`) ; rien à `organizations/` |
| 5 | `pnpm --filter api build` | **OK** (exit code 0) |
| 6 | `git diff --check` | OK — aucune erreur (4 warnings LF→CRLF inoffensifs, Windows) |
| 7 | `git status --short` | `A` ×3 (service, spec, rapport), `M` `organizations.module.ts` — aucun commit/push |
| 8 | `git diff --name-status` | `M organizations.module.ts · A organizations.service.spec.ts · A organizations.service.ts · A phase-1-3a-organization-resolution.md` |
| 9 | `git diff --stat` | module 12 ± · spec 309 + · service 88 + · rapport 67 + — **4 files, 467 insertions, 9 deletions** |
| 10 | `git rev-parse HEAD` | `e564cfd05be274492c3a9a05bbfef7070f573af6` (inchangé) |

Baselines attendues avant nouveaux tests : unitaires **229** ✓, **53** E2E ✓. Aucun test/build frontend.

> **Écart signalé (ESLint)** : le script npm `lint` du dépôt embarque `--fix` — incompatible avec la consigne « sans `--fix` ». La mesure (l.4) a donc été faite directement avec `eslint` (glob du dépôt, sans `--fix`). Un `eslint --fix` **limité aux 2 nouveaux fichiers de cette phase** a été effectué auparavant pour corriger le formatage Prettier et 2 assertions TypeScript inutibles du spec (pas de `--fix` sur les autres fichiers).

## Exclusions (hors périmètre, conformes)

Aucun endpoint, aucun JWT/guard/permission, aucun calcul de permissions effectives (1-7), aucun cache, aucune donnée créée, aucun contrôleur, aucun autre module/fichier modifié, aucune référence RoyalVibe, aucune migration, aucun test E2E nouveau.

## Décision (stabilisée)

**Démarrage production sur base vide** ; **aucune migration RoyalVibe** ; **migration 1-2 (branche 1-2A) abandonnée, jamais fusionnée**.
