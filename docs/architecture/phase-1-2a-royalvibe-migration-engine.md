# Phase 1-2A — Moteur idempotent de migration RoyalVibe (testé localement)

Statut : **GREEN** — aucun commit/push, en attente de validation. Base :
branche `architecture/phase-1-2a-royalvibe-migration-engine` (issue de
`phase-1-1b-tenant-fields`), HEAD de base `e564cfd`.

## 1. Fichiers (3 nouveaux — plafond 4, aucun existant modifié)
`api/src/migrations/royalvibe-migration.ts` (moteur) ;
`api/test/royalvibe-migration.e2e-spec.ts` (14 tests E2E) ; ce rapport.

## 2. Contrat du moteur
Une `Connection` Mongoose DÉJÀ OUVERTE + mode `'dryRun' | 'apply'` ; jamais
d'ouverture, jamais de `MONGODB_URI`, aucun secret/URI dans le résultat.
Résultat : `status` (`success`|`blocked`|`rolledBack`), org détectée/prévue,
propriétaire, `roleCounts`, `plan`/`modified` (4 ressources), `memberships`,
`warnings`, `blocks`.

## 3. Préflight (avant toute écriture ; refait EN transaction)
1. `franck@royalvibe.com` : exactement un compte (0 ou >1 → blocage) ;
2. rôles historiques tous `admin`/`seller` (inconnus listés → blocage) ;
3. `royalvibe` absente ou strictement compatible (name/slug/XAF/`#b8960c`/
   active) — sinon blocage ;
4. org étrangère DÉTENTRICE de données ou `organizationId` orpheline →
   blocage ; org sans données → avertissement ;
5. plan = docs `organizationId` nuls/absents (filtre `null` matche l'absent) ;
6. sur org cible : chaque membership existante active + user existant,
   non-propriétaire à rôle = rôle historique (admin→admin, seller→seller),
   owner actif uniquement pour le propriétaire ; suspension/révocation/
   orpheline/rôle-incompatible → blocage ; **au plus 1 doc par couple
   `(organizationId, userId)`** — doublon bloquant, détecté en application
   (l'index unique 1-1A est seulement déclaré, non garanti sur Atlas : on ne
   dépend pas de lui) ; aucune rétrogradation ni réactivation silencieuse ;
7. refs `parentId`/`sectionId`/`productId`/`sellerId`/`actorId` strictement
   `ObjectId`/`null`/absentes (lean) — sinon blocage, rien converti (dette
   `Mixed` 1-1B AUDITÉE seulement).

## 4. `apply` — ordre transactionnel (une `ClientSession`, `withTransaction`)
re-préflight (bloc → abort) → org créée (tableau + session) ou réutilisée
(même `_id`) → memberships absentes créées (`ordered: true`) → promotion owner
(seulement si non owner actif) → `updateMany({ organizationId: null }, $set
orgId)` × 4 (SEULS les docs nuls/absents — jamais d'écrasement) → invariants
STRICTS avant commit : 1 owner actif ; memberships actives = nb users ; par
ressource, même session : `totalDocuments = rattachés` (égalité stricte) + 0
nuls/absents + 0 `organizationId` différents (`$nin: [null, orgId]`). Tout
écart → throw → abort intégral ; `endSession` toujours (`finally`).

## 5-7. Dry-run, idempotence, rollback (preuves)
- Dry-run (T1) : 9 vérifications + plan `{3,2,2,2}`, `modified` = 0, snapshot
  brut des 7 collections (sort `_id`, JSON) strictement identique avant/après.
- Idempotence (T3) : 2ᵉ `apply` — même `_id` d'org, 0 membership créée,
  0 modification, 1 owner actif.
- Rollback (T8) : panne injectée APRÈS toutes les écritures, sur le
  `countDocuments` de session de l'invariant « 1 owner actif » (dernière op :
  après org, memberships, promotion, les 4 `updateMany`), via espionnage ciblé
  des instances de requête (`.op` + `.options.session`) + suivi des 4
  `updateMany` (AUCUn hook moteur — motif 0B.7B). Preuve d'ordre :
  `updateMany:0..3` AVANT `FAIL:ownerCheck`. `rolledBack`, snapshot avant=après
  (comptes ET contenu), 0 org/membership, `{ $ne: null }` = 0 par ressource.

## 8. Matrice des tests (T = test du spec)
| Scénario | Test |
|---|---|
| dry-run | T1 |
| apply (4 ressources + corbeille) | T2 |
| owner unique & mapping admin/seller | T2 |
| idempotence | T3 |
| propriétaire absent | T4 |
| rôle historique inconnu | T5 |
| org étrangère / orpheline | T6 |
| référence BSON invalide | T7 |
| rollback après écritures (ordre + total) | T8 |
| memberships incompatibles (rôle/suspension/révocation/orpheline) | T9a ×4 |
| propriétaire déjà owner actif | T9b |
| doublon `(organizationId, userId)` — index unique 1-1A non garanti | T9c |

## 9. Résultats (mesurés, état final)
- E2E cibles : **14/14** ; E2E complète : **67/67** (4 suites — les 2 lignes
  ERROR = pannes simulées du spec `sales-transaction`) ; Unitaires : **229/229** ;
- ESLint `src/**`+`test/**` : **0 erreur**, 2 warnings 0B.2 préexistants ;
  build `nest build` **OK** ; `mongod` résiduel : AUCUN ; `git diff --check` :
  propre ; `git rev-parse HEAD` : `e564cfd`.

## 10. Limites et risques
- **Index** : tous les index nouveaux 1-1A/1-1B sont seulement DÉCLARÉS, non
  garantis sur Atlas. 1-2B devra **vérifier ou créer de façon contrôlée**
  l'ensemble : unique `Organization.slug` ; les 3 index `OrganizationMembership`
  (unique `(organizationId,userId)` ; `(userId,status)` ; partiel ≤ 1 owner
  actif) ; les 4 index tenant métier. **Pas de `syncIndexes()` en production**
  (peut supprimer des index exotiques/non attendus) — choix de 1-2B. Le moteur
  de 1-2A ne dépend d'AUCUN index (garanties appliquées en application).
- Atlas (1-2B) rejouera le dry-run réel avant bascule `apply`.
- `User.role` inchangé (retiré par phase dédiée) ; la dette `Mixed` des 5 champs
  BSON est uniquement auditée/bloquante ici.
- **Confirmation** : aucun Atlas/Supabase/base réelle/`.env` touché — seule base
  : repl set éphémère (garde `validatedEphemeralUri`) ; aucun commit/push ; 1-2B
  non entamée.
