# Phase 1-14B — Socle d'abonnement par organisation et essai de 7 jours

Base : `5fff2d0`. Branche : `architecture/phase-1-14b-subscription-foundation`.
Audit préalable : `phase-1-14a-subscription-foundation-audit.md` (§5.1 :
décisions validées).

Périmètre : socle API, essai automatique et outils serveur. **Aucun blocage
commercial n'est activé.** Aucun fichier `web/`, service worker,
Dockerfile, `.env`, package ou lockfile n'est modifié. `api/package.json`
reçoit seulement deux scripts. `Organization` (schéma et `status`) est
inchangé.

## 1. Modèle

### 1.1 Collection `subscription_periods` (ajout seul)
`api/src/subscriptions/schemas/subscription-period.schema.ts`. Une
attribution crée un document. Aucune période n'est modifiée ni supprimée.

| Champ | Règle |
|---|---|
| `organizationId` | ObjectId requis : l'abonnement appartient à l'organisation |
| `sequence` | entier ≥ 1, rang dans la chaîne de l'organisation (essai = 1) |
| `kind` | `trial \| subscription` |
| `term` | `monthly \| quarterly \| semiannual \| annual` pour un abonnement, `null` pour l'essai (validé) |
| `startsAt`, `endsAt` | `[startsAt, endsAt)`, `endsAt > startsAt` (validé), calculés serveur |
| `source` | `trial \| manual`, cohérent avec `kind` (validé) |
| `sourceReference` | clé d'idempotence, trim, 1 à 200 caractères ; essai : `trial:<organizationId>` |
| `grantedBy` | opérateur (CLI) ou `system` ; interne, jamais exposé |
| `previousPeriodId` | maillon précédent, `null` pour le rang 1 |
| `createdAt` | horodatage (pas d'`updatedAt` : ajout seul) |

Ni prix, ni quota, ni facture, ni intégration de paiement.
`autoIndex: false`.

### 1.2 Index (tous uniques, créés uniquement par la migration)
`api/src/subscriptions/subscription-period-indexes.ts`

| Nom | Clé | Rôle |
|---|---|---|
| `source_1_sourceReference_1` | `{ source, sourceReference }` | idempotence des attributions |
| `organizationId_1_sequence_1` | `{ organizationId, sequence }` | chaîne linéaire : deux attributions ne peuvent pas prendre le même rang |
| `organizationId_1_single_trial` | `{ organizationId }` partiel `{ kind: 'trial' }` | un seul essai par organisation, quelle que soit la référence |

`describeSubscriptionPeriodIndexProblem` refuse un index absent, non unique,
sparse, avec TTL ou collation, une clé dans un autre ordre, ou un filtre
partiel différent. La migration n'écrase jamais un index incompatible.
`SubscriptionPeriodIndexCheck` bloque le démarrage avec
`NODE_ENV=production` si les index manquent. Le contrat est le même que
pour `sale_operations`.

## 2. Essai

- Un seul chemin de création d'organisation en production :
  `AuthService.registerOwner` → `OrganizationsService.createOwnerOrganization`.
  Les autres créations trouvées par `rg` sont des fixtures de test.
- `SubscriptionsService.grantTrial(organizationId, session)` est appelé
  dans `createOwnerOrganization` après l'invariant du propriétaire, avec la
  **même session**. Il n'y a pas de transaction imbriquée : un rollback ne
  laisse ni organisation, ni utilisateur, ni période.
- Durée : exactement 7 × 24 h à partir de l'heure serveur (horloge injectée).
  La vérification d'email reste obligatoire et ne décale pas ce début.
- Pas de second essai : contrôle dans le service (`TRIAL_ALREADY_GRANTED`)
  et index partiel en base.
- Login, invitation, acceptation, branding et renouvellement n'écrivent
  jamais l'essai. Rejoindre une organisation n'en crée pas.
- **Hors périmètre** : aucune règle « un essai par utilisateur ». La création
  répétée de nouvelles organisations pour cumuler des essais n'est pas
  traitée ici. Elle reste encadrée par l'inscription publique
  (`PUBLIC_REGISTRATION_ENABLED`), la vérification d'email et le rate
  limiting existants.

## 3. Attribution et renouvellement

`SubscriptionsService.grantSubscription({ organizationId, term,
sourceReference, grantedBy })` est appelé uniquement par le code serveur et
le script CLI. **Aucune route HTTP n'écrit d'abonnement**, et
`User.role = admin` ne donne aucun pouvoir.

- `startsAt = max(heure serveur, max(endsAt) de l'organisation)`. La
  couverture inclut les périodes futures (abonnement acheté pendant l'essai).
- `endsAt` : 1, 3, 6 ou 12 mois calendaires UTC. Le jour est ramené au
  dernier jour valide du mois (31 janv. + 1 mois → 28/29 févr.) et l'heure
  UTC est conservée. Conséquence voulue : une chaîne mensuelle commencée un
  31 se poursuit le 28 ou le 30 suivant.
- Organisation inexistante → `ORGANIZATION_NOT_FOUND`. Entrées invalides →
  `INVALID_INPUT`. Dans les deux cas, aucune écriture.
- Une organisation suspendue reçoit la période, mais son `status` n'est
  jamais modifié.

### 3.1 Idempotence
Clé : `{ source: 'manual', sourceReference }`.
- Même organisation et même durée → même période, `replayed: true`, aucune
  durée ajoutée.
- Autre organisation ou autre durée → `SUBSCRIPTION_REFERENCE_CONFLICT`,
  aucune écriture.
- La comparaison canonique porte sur l'organisation, la nature et la durée.
  Elle ne dépend jamais de l'heure calculée au rejeu. `grantedBy` n'en fait
  pas partie : un autre opérateur qui rejoue le même reçu obtient la même
  période.
- Seuls les E11000 des index `source_1_sourceReference_1` et
  `organizationId_1_sequence_1`, reconnus par leur clé exacte, déclenchent
  une reprise. Tout autre E11000, y compris celui de l'essai, est relancé.

### 3.2 Concurrence
La sérialisation est **persistée en base** par la contrainte de chaînage
`{ organizationId, sequence }`. Il n'y a ni verrou en mémoire ni collection
de contrôle. Chaque tentative est une transaction qui :
1. relit la référence (rejeu) ;
2. vérifie l'organisation ;
3. lit le dernier maillon et la fin de couverture ;
4. insère au rang `n + 1`.

Deux transactions concurrentes qui visent le même rang se heurtent :
- soit par un write conflict, rejoué par `withTransaction` du driver ;
- soit par un E11000 sur le rang, rejoué par une nouvelle transaction qui
  relit la chaîne. Ce second cas est borné à `MAX_GRANT_ATTEMPTS = 5`, puis
  `GRANT_CONTENTION`.

Preuves observées sur le replica set éphémère :
- avec les index, 4 attributions simultanées donnent les rangs 1 à 5, une
  chaîne jointive et une couverture cumulée complète. Il y a eu
  **10 insertions tentées pour 4 attributions** : 6 collisions absorbées ;
- **sans les index** (exécution filtrée sans migration), le même test
  échoue : rangs `[1, 2, 2, 2, 2]`, soit une branche. Une lecture suivie
  d'une insertion dans une transaction ne suffit donc pas, et l'index est
  bien le mécanisme de sérialisation. C'est pourquoi le démarrage en
  production et le script vérifient les index avant toute attribution ;
- une insertion directe d'un rang déjà pris est refusée par la base
  (E11000 `{ organizationId, sequence }`).

## 4. Lecture de l'état

`computeSubscriptionState(periods, now)` (pur) et
`SubscriptionsService.getState(organizationId)` (horloge
`SUBSCRIPTION_CLOCK`, remplaçable uniquement par `overrideProvider` dans
les tests ; aucune variable ni aucun paramètre client).

| État | Condition |
|---|---|
| `none` | aucune période |
| `active` | une période vérifie `startsAt ≤ now < endsAt` |
| `scheduled` | aucune période active, mais une période future existe (jamais d'accès avant `startsAt`) |
| `expired` | toutes les périodes sont terminées |

La vue distingue la **période courante** (`kind`, `term`, dates) de la
**fin de couverture continue** `coverageEndsAt`, qui inclut les périodes
futures jointives et s'arrête au premier trou.

Route `GET /organizations/current/subscription` (`SubscriptionsController`) :
- organisation issue uniquement du contexte `OrganizationGuard` ;
- `@OwnerOnly('billing.identity')`, opération owner-only existante et non
  délégable. Admin et vendeur reçoivent 403 `PERMISSION_DENIED`, quelles
  que soient leurs permissions supplémentaires et leur rôle legacy ;
- projection : `state`, `currentPeriod { kind, term, startsAt, endsAt }`,
  `coverageEndsAt`, `nextPeriodStartsAt`. Jamais de référence, d'opérateur,
  d'identifiant, de rang ni de hash ;
- organisation suspendue : 403 `ORGANIZATION_ACCESS_DENIED`, inchangé.

## 5. Commandes

Prérequis : `pnpm --filter api build`. Les scripts tournent depuis `dist/`
avec les dépendances existantes. Ils ne journalisent jamais l'URI et
renvoient le code de sortie 1 en cas d'échec.

```sh
# 1. Index — idempotent, à exécuter AVANT tout démarrage en production
MONGODB_URI=... pnpm --filter api migrate:subscription-period-indexes

# 2. Attribution manuelle (dates calculées par le service)
MONGODB_URI=... pnpm --filter api subscription:grant -- \
  --organization-id=<24 hex> --term=monthly|quarterly|semiannual|annual \
  --reference=<n° de reçu> --operator=<identifiant opérateur>
```

Le script de l'étape 2 refuse :
- un argument manquant, inconnu ou dupliqué, dont toute tentative de
  fournir une date (`--starts-at`, etc.) ;
- l'absence de `MONGODB_URI` ;
- des index absents ;
- une organisation inconnue.

Il affiche `{ result: granted | already-granted, organizationId, term,
startsAt, endsAt }`.

### 5.1 Tests manuels sur l'environnement local (non exécutés ici)
- **Nouvelle organisation avec essai** : exécuter l'étape 1 une fois sur la
  base locale, puis s'inscrire depuis `/auth/register`
  (`PUBLIC_REGISTRATION_ENABLED=true`) et confirmer l'email. L'essai est
  visible pour le propriétaire via
  `GET /organizations/current/subscription`.
- **Commerces locaux existants** : ils restent `none` (aucune attribution
  rétroactive). Après l'étape 1, lancer l'étape 2 avec l'`_id` de
  l'organisation et une référence unique (ex. `LOCAL-<slug>-1`).

Aucune de ces opérations n'a été exécutée sur les données locales pendant
l'implémentation.

## 6. Fichiers

- Nouveaux : `api/src/subscriptions/` (module, service, contrôleur,
  horloge, règles pures, schéma, index, 3 specs),
  `api/src/migrations/create-subscription-period-indexes.ts`,
  `api/src/migrations/grant-subscription-period.ts`,
  `api/test/subscriptions.e2e-spec.ts`.
- Modifiés :
  - `organizations.service.ts` (appel `grantTrial`) ;
  - `organizations.module.ts` (import `SubscriptionsModule`) ;
  - `organizations.service.spec.ts` (stub du nouveau provider, aucun bypass
    en production) ;
  - `api/package.json` (2 scripts) ;
  - rapport 1-14A (§5.1).

## 7. Résultats réellement exécutés

Toutes les exécutions ont eu lieu sur `MongoMemoryReplSet` éphémère
(garde anti-27017), sans email réel ni fournisseur de paiement.

| Étape | Commande | Résultat |
|---|---|---|
| Tests ciblés unitaires | `jest src/subscriptions` | 3 suites, 59 tests ✅ |
| Tests ciblés e2e | `jest --config test/jest-e2e.json test/subscriptions.e2e-spec.ts` | 1 suite, 28 tests ✅ (scripts `dist/` compris) |
| Unitaires API | `jest` | 58 suites, 972 tests ✅ |
| E2E API | `pnpm run test:e2e` | 15 suites, 376 tests ✅ |
| Lint API | `eslint "{src,apps,libs,test}/**/*.ts"` (sans `--fix`) | 0 erreur, 2 avertissements préexistants (`app.e2e-spec.ts`, `ephemeral-mongodb.ts`, non modifiés) |
| Build API | `nest build` | ✅ |
| Diff | `git diff --check` | ✅ |

Couverture e2e (`api/test/subscriptions.e2e-spec.ts`) :
- **Index** : absents au démarrage ; migration créée puis rejouée sans
  changement ; index de même clé non unique refusé, jamais écrasé.
- **Essai** :
  - exactement 7 × 24 h à l'heure serveur, `Organization` inchangée ;
  - rollback de l'inscription si l'essai échoue ;
  - rollback après l'essai dans la même transaction ;
  - second essai refusé par le service et par l'index ;
  - un essai distinct par organisation ;
  - début inchangé malgré une vérification d'email différée ;
  - invitation, acceptation, reconnexion et branding sans effet sur l'essai.
- **Lecture** :
  - projection exacte pour le propriétaire ;
  - query et en-tête d'organisation ignorés ;
  - état `expired` exactement à `endsAt` ;
  - admin (avec permissions supplémentaires et rôle legacy `admin`) et
    vendeur → 403 ;
  - sans JWT → 401 ;
  - `POST`, `PATCH`, `PUT` et `DELETE` → 404.
- **Renouvellement** : pendant l'essai, plusieurs renouvellements anticipés,
  pendant un abonnement, après expiration. La chaîne reste linéaire.
- **Idempotence** :
  - rejeu séquentiel (autre heure, autre opérateur) → même période ;
  - même référence pour une autre organisation ou une autre durée →
    conflit, aucune écriture ;
  - 6 rejeux concurrents → une seule période.
- **Concurrence** :
  - 4 attributions simultanées → cumul complet et chaîne jointive ;
  - rang déjà pris refusé par la base.
- **Isolation, suspension, absence de blocage** :
  - isolation entre organisations ;
  - suspension conservée et toujours refusée (403
    `ORGANIZATION_ACCESS_DENIED`) ;
  - organisations `expired` et `none` : `/auth/context`, `GET /products` et
    `POST /sections` restent autorisés.
- **Scripts compilés** :
  - migration rejouée ; sans URI → code 1 ;
  - attribution réussie, puis rejouée ;
  - organisation suspendue inchangée ;
  - arguments manquants ou inconnus, date fournie, durée invalide,
    organisation inconnue, absence d'URI → code 1 sans écriture ;
  - URI et `host:port` jamais présents dans la sortie.

Unitaires : règles pures (4 durées, fins de mois, années bissextiles, UTC
indépendant de `TZ`, bornes, `scheduled`, couverture continue et trous),
validation des index, classification E11000, validateurs du schéma,
`Organization` inchangée, surface du contrôleur (GET seul, `billing.identity`)
et analyse des arguments du CLI.

## 8. Limites et périmètre de 1-14C

Limites de 1-14B :
- aucun blocage commercial : une organisation `none` ou `expired` garde
  tous ses accès (prouvé en e2e) ;
- aucun frontend ;
- les organisations locales existantes restent `none` ;
- en dehors de la production, la vérification fail-fast des index est
  désactivée (comme pour `sale_operations`). Le script vérifie toutefois les
  index avant d'écrire, et aucune route n'appelle `grantSubscription` ;
- l'état repose sur l'horloge du serveur ; l'appareil hors ligne ne voit
  aucun changement avant sa prochaine réponse serveur (1-14A §4).

À conserver explicitement pour 1-14C :
1. **Blocage du commerce pour tous** ses membres si l'abonnement est expiré
   ou absent. Le refus est un **403** à code dédié
   (`SUBSCRIPTION_INACTIVE`), jamais un autre 4xx, qui ferait passer
   l'outbox en conflits (1-14A §1.7).
2. **Parcours de renouvellement réservé au propriétaire** ; la lecture
   d'état reste accessible même quand le commerce est bloqué.
3. **Protection des sessions déjà ouvertes** : le contrôle ne passe pas par
   `resolveActiveContext`. Login, switch et `/auth/context` restent
   possibles pour que le propriétaire puisse renouveler. Après expiration, l’accès à l’application est bloqué pour tous, y compris les sessions déjà ouvertes. L’identification permet uniquement au propriétaire d’accéder au parcours de renouvellement. Les administrateurs et vendeurs restent bloqués. Les ventes en attente sont conservées et exportables.
4. **Conservation et export des ventes en attente** : aucune suppression ;
   l'export local reste toujours disponible.
5. **Reprise après activation sans changement obligatoire de JWT** : levée
   explicite du blocage `access_denied` de l'outbox, FIFO, backoff,
   idempotence serveur, rejeu exact des ventes déjà appliquées.
6. **Un succès de `/auth/context` seul ne lève pas un blocage commercial ou
   de permissions** : la reprise exige un signal serveur explicite de
   l'état commercial actif et des droits requis.

Mobile Money (SDK, webhook, parcours de paiement) et le déploiement
restent des phases distinctes. Ils réutiliseront `grantSubscription` avec
une nouvelle `source`.
