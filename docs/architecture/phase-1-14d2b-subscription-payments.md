# Phase 1-14D.2B — Demandes de paiement et moteur de confirmation

Branche : `architecture/phase-1-14d2b-subscription-payments`
Base : `d8225ac` (1-14D.2A). Rapports préalables :
[audit 1-14D.1](phase-1-14d1-payment-provider-audit.md),
[socle 1-14D.2A](phase-1-14d2a-payment-foundation.md). Stash `stash@{0}`
préservé.

Lot **serveur uniquement**. Il n'y a eu aucun commit, push, déploiement,
paiement ou email réel. Aucun package n'a été ajouté. Le lockfile, le
frontend, Docker, nginx et les `.env` n'ont pas changé ; `api/package.json`
reçoit uniquement le script de migration.

Hors périmètre : adaptateur CamPay réel, webhook public, réconciliation
planifiée, interface, remboursements, reçus et factures.

---

## 1. Vue d'ensemble

```
POST /payments ─► rejeu ? ─► prestataire disponible ? ─► paiement ouvert ?
                  (local)        (sinon 503, 0 écriture)    (sinon 409)
                     │
                     ▼
            insertion `initiating` (tarif FIGÉ, référence marchand)
            = réservation atomique (index uniques)
                     │
                     ▼  UN SEUL appel réseau, hors transaction
         accepted → pending │ rejected → failed │ incertain → uncertain
                                                │ non transmis → failed + 503

POST /:id/refresh ─► confirmPayment(id)   (point d'entrée UNIQUE, réutilisable
                     │                      par les futurs webhook/scripts)
                     ├─ succeeded / review local → aucun réseau
                     ├─ fetchStatus (hors transaction) ─ erreur → 503, état conservé
                     ├─ concordance (références, montant brut, devise) ─ écart → review
                     ├─ pending → pending │ failed → failed (jamais après succès)
                     └─ succeeded → runInGrantTransaction :
                          relire, revérifier, attribuer `payment:<id>`,
                          marquer `succeeded` + période (écriture conditionnelle vérifiée)
```

---

## 2. Modèle `subscription_payments`

[subscription-payment.schema.ts](../../api/src/subscriptions/payments/schemas/subscription-payment.schema.ts)

| Champ | Contrat |
|---|---|
| `organizationId`, `requestedBy` | Contexte serveur (`OrganizationGuard`, `sub` du JWT) ; immuables |
| `clientOperationId` | UUID v4 en minuscules, généré par le client ; immuable |
| `requestFingerprint` | HMAC-SHA256 de `[v1, demandeur, durée, téléphone normalisé]`, avec une clé **dérivée** du secret serveur (séparation de domaine). Ce n'est jamais un hash nu, car l'espace des numéros est trop petit. Jamais exposé |
| `term`, `amount`, `currency`, `pricingVersion` | Figés à la création depuis le catalogue serveur (1-14D.2A) ; immuables |
| `provider`, `merchantReference` | Immuables. Référence : `SM` + id en hexadécimal (26 caractères) |
| `providerReference` | Renseignée à l'acceptation ou à la récupération |
| `status`, `open` | Voir § 3 |
| `payerPhoneMasked` | `+237 6•• ••• •56` ; le numéro en clair n'est **jamais** stocké ni journalisé |
| `periodId` | Période attribuée, posée dans la transaction de confirmation |
| `incidentCode` | Code générique : `initiation_rejected`, `initiation_uncertain`, `provider_unavailable`, `provider_mismatch`, `late_failure_after_success` |
| `initiatedAt`, `confirmedAt`, `failedAt`, `lastCheckedAt`, `createdAt`, `updatedAt` | Dates serveur |

Ne sont jamais stockés : PIN, jeton, secret ou réponse brute du prestataire.

### Index

[subscription-payment-indexes.ts](../../api/src/subscriptions/payments/subscription-payment-indexes.ts)

| # | Nom | Clé | Contrainte |
|---|---|---|---|
| 1 | `organizationId_1_clientOperationId_1` | `{ organizationId, clientOperationId }` | unique |
| 2 | `merchantReference_1` | `{ merchantReference }` | unique |
| 3 | `provider_1_providerReference_1` | `{ provider, providerReference }` | unique, partiel `providerReference: { $type: 'string' }` |
| 4 | `organizationId_1_single_open_payment` | `{ organizationId }` | unique, partiel `open: true` |
| 5 | `organizationId_1__id_-1` | `{ organizationId, _id: -1 }` | historique paginé |

- Le schéma est en `autoIndex: false` : aucune création au démarrage. Aucun
  TTL n'est toléré, même sur un index supplémentaire, et aucune suppression
  automatique n'a lieu.
- **Migration** : `pnpm --filter api build`, puis
  `MONGODB_URI=... pnpm --filter api migrate:subscription-payment-indexes`.
  Elle est idempotente. Tous les index requis sont **validés avant toute
  création** : un index de même clé mal configuré fait échouer la migration
  (code 1) sans créer ni remplacer quoi que ce soit.
- **Production** : `SubscriptionPaymentIndexCheck` refuse le démarrage
  (`NODE_ENV=production`) si un index est absent ou diffère de la
  définition exacte (clé, ordre, unicité, filtre partiel, sparse, TTL,
  collation).

---

## 3. États

| État | `open` | Sens | Sortie possible |
|---|---|---|---|
| `initiating` | oui | Demande persistée, droit d'initier réservé | `pending`, `failed`, `uncertain`, `review` |
| `pending` | oui | Collecte acceptée par le prestataire, en attente du payeur | `succeeded`, `failed`, `review` |
| `uncertain` | oui | Issue de l'initiation inconnue : jamais réinitié, jamais déclaré échoué | `pending`, `succeeded`, `failed`, `review` via une récupération par référence marchand |
| `review` | inchangé | Discordance : traitement opérateur, aucune attribution | aucune (hors opérateur) |
| `succeeded` | non | **Terminal** : période attribuée | aucune |
| `failed` | non | Refus confirmé, initiation rejetée ou requête jamais transmise | `succeeded` uniquement sur un succès **vérifié** (renversement chez l'opérateur, argent débité) |

`OPEN` bloque toute nouvelle collecte pour l'organisation (index 4). **Aucun
délai ne ferme un paiement** : quinze minutes écoulées ou un JWT expiré ne
prouvent pas l'échec. Ce lot n'a ni minuterie, ni sondage, ni boucle réseau.

---

## 4. Prestataire injectable

[payment-provider.ts](../../api/src/subscriptions/payments/payment-provider.ts) — jeton `PAYMENT_PROVIDER`.

```ts
interface PaymentProvider {
  readonly name: string;                         // stocké dans `provider`
  readonly available: boolean;                   // false → 503, aucun réseau
  readonly supportsMerchantReferenceLookup: boolean;
  readonly idempotentInitiation: boolean;        // jamais exploité dans ce lot
  initiate(req): Promise<{ outcome: 'accepted'; providerReference } | { outcome: 'rejected' }>;
  fetchStatus(lookup): Promise<ProviderPaymentStatus | null>;  // null = introuvable
}
// Erreurs d'initiation : PaymentProviderUnavailableError (certainement non transmise)
//                        PaymentProviderUncertainError  (issue inconnue)
```

- **Production** : `UnavailablePaymentProvider` (`available: false`). Toute
  nouvelle initiation ou consultation répond
  `503 PAYMENT_SERVICE_UNAVAILABLE` **avant** toute écriture et tout appel
  réseau. Les lectures locales et le rejeu d'une opération existante restent
  disponibles.
- **Tests** : [SimulatedPaymentProvider](../../api/test/e2e/simulated-payment-provider.ts),
  injecté **uniquement** par `overrideProvider`. Aucune variable de
  production, route, corps ni en-tête ne peut sélectionner un mode simulé.
  Il simule l'attente, le succès, le refus, une réponse perdue après
  création, une incertitude sans création, une requête non transmise, un
  statut indisponible ou introuvable, des champs discordants et des
  réponses obsolètes. Des barrières déterministes ordonnent les appels
  concurrents.
- Un paiement créé par un autre prestataire que celui injecté n'est jamais
  consulté (503).

### Prérequis du futur adaptateur (à vérifier, jamais présumés)

1. Lever `PaymentProviderUnavailableError` **seulement** si la requête n'a
   certainement pas atteint le prestataire ; tout le reste (timeout, réponse
   perdue, 5xx après envoi) doit lever `PaymentProviderUncertainError`.
2. `supportsMerchantReferenceLookup = true` seulement si l'API permet de
   retrouver une transaction par **notre** référence marchand. Chez CamPay,
   le statut se consulte par la référence CamPay ; la recherche par
   `external_reference` reste **non confirmée** (cf. 1-14D.1). Sans cette
   capacité, une initiation incertaine reste `uncertain` jusqu'à un
   traitement opérateur.
3. `idempotentInitiation = true` seulement si une seconde initiation avec la
   même référence est **garantie** sans seconde collecte. Ce lot ne relance
   jamais une initiation.
4. Renvoyer les valeurs **brutes** : montant numérique entier sans
   conversion silencieuse, devise, références. La concordance est vérifiée
   côté serveur.
5. Ne jamais journaliser le téléphone, un jeton, un secret ou la réponse
   brute. Les identifiants seront fournis par des secrets d'environnement
   sans valeur par défaut. L'adaptateur reste désactivé sans eux.
6. Respecter la référence marchand de 26 caractères (`SM…`, alphanumérique).

---

## 5. Routes propriétaire

[subscription-payments.controller.ts](../../api/src/subscriptions/payments/subscription-payments.controller.ts)

| Route | Corps / requête | Réponse |
|---|---|---|
| `POST /organizations/current/subscription/payments` | `{ term, payerPhone, clientOperationId }` strict | 201 `{ …vue, replayed }` |
| `GET /organizations/current/subscription/payments/:paymentId` | — | 200 vue (lecture locale) |
| `POST /organizations/current/subscription/payments/:paymentId/refresh` | corps vide strict (`UNEXPECTED_BODY`) | 200 vue |
| `GET /organizations/current/subscription/payments` | `?limit=1..50&before=<id>` | 200 `{ items, nextCursor }` |

Vue : `paymentId, reference, status, term, amount, currency,
payerPhoneMasked, createdAt, initiatedAt, confirmedAt, failedAt`. Elle
n'expose jamais l'empreinte, le `clientOperationId`, la référence
prestataire, le demandeur, l'organisation ni la période.

- **Propriétaire réel uniquement** : nouvelle opération owner-only
  `billing.payment` (`PermissionGuard` exige `membership.role === owner`,
  jamais délégable, jamais `User.role`). L'admin et le vendeur reçoivent
  403 `PERMISSION_DENIED`.
- **JWT applicatif ou `subscription_limited`** : exception commerciale
  `identity` limitée à ce contrôleur. La matrice des routes
  ([subscription-access-routes.spec.ts](../../api/src/subscriptions/subscription-access-routes.spec.ts))
  liste explicitement les 4 routes `owner-renewal`.
- Les contrôles de compte, d'email vérifié, de version de session, de
  membership et de suspension restent ceux des gardes globaux, sans
  changement.
- **Validation** : la `ValidationPipe` globale refuse tout champ en plus
  (montant, devise, organisation, demandeur, prestataire, statut…). Le
  téléphone est normalisé côté serveur (mobile camerounais `6XXXXXXXX`,
  préfixes `237`, `+237` ou `00237`, séparateurs tolérés), sinon
  `400 INVALID_PAYER_PHONE`.
- **Isolation** : toutes les lectures sont filtrées par l'organisation
  courante. Un id invalide, inexistant ou appartenant à une autre
  organisation donne le même `404 PAYMENT_NOT_FOUND`.
- **`Cache-Control: no-store`** : un intercepteur le pose avant le handler,
  ce qui couvre aussi ses erreurs ; les réponses 429 le portent également.
- **Limitation de débit** : deux fenêtres nommées dans le
  `ThrottlerModule.forRoot()` **unique** existant (même stockage mémoire),
  avec un tracker utilisateur + organisation :
  `subscription-payment-write` (création et refresh, 10 par 60 s, blocage
  60 s) et `subscription-payment-read` (lectures, 60 par 60 s, blocage
  30 s). Le refus est un `429 PAYMENT_RATE_LIMITED` avec `Retry-After`.
  `AuthController` et la création d'invitations excluent explicitement ces
  fenêtres, et réciproquement.

Codes stables : `PAYMENT_SERVICE_UNAVAILABLE`, `PAYMENT_STATUS_UNAVAILABLE`,
`PAYMENT_ALREADY_PENDING` (+ `paymentId` du paiement ouvert),
`PAYMENT_OPERATION_CONFLICT`, `PAYMENT_NOT_FOUND`, `INVALID_PAYER_PHONE`,
`UNKNOWN_SUBSCRIPTION_TERM`, `UNEXPECTED_BODY`, `PAYMENT_RATE_LIMITED`.

---

## 6. Initiation, rejeu et opérations incertaines

1. **Rejeu d'abord**, en lecture seule et sans réseau. Une même organisation
   avec le même UUID, le même demandeur et la même demande normalisée
   renvoie le même paiement, aux tarifs figés (`replayed: true`). C'est vrai
   même si le prestataire est indisponible et même après un changement de
   catalogue. Un UUID déjà utilisé pour une autre demande renvoie
   `409 PAYMENT_OPERATION_CONFLICT`, sans effet.
2. Prestataire indisponible : `503`, aucune écriture.
3. Un paiement est déjà ouvert : `409 PAYMENT_ALREADY_PENDING`.
4. **Persistance avant tout effet externe** : la demande et la référence
   marchand sont insérées en `initiating`. L'insertion **est** la
   réservation : les index 1 et 4 garantissent qu'au plus une insertion
   réussit. Un double clic concurrent perd sur l'index 1 et rejoue ; une
   autre demande concurrente perd sur l'index 4 et reçoit 409. **Une
   requête, une initiation.**
5. Un seul appel `initiate`, hors de toute transaction :
   - `accepted` → `pending` (écriture conditionnelle sur l'état et la
     référence) ;
   - `rejected` → `failed` (`initiation_rejected`) ;
   - requête certainement non transmise → `failed`
     (`provider_unavailable`), puis 503 : aucune collecte n'a pu exister ;
   - **issue inconnue** → `uncertain` (`initiation_uncertain`). Le paiement
     reste ouvert, avec la même référence. Il n'est **jamais** relancé et
     aucune nouvelle référence n'est générée.
6. **Récupération** : le refresh d'un paiement `initiating` ou `uncertain`
   consulte le prestataire par référence marchand, si l'adaptateur le
   permet. Une transaction trouvée adopte sa référence prestataire puis
   suit le cycle normal. Si elle est introuvable, ou si la capacité
   n'existe pas, l'état est conservé et la collecte reste bloquée jusqu'à
   un traitement opérateur.

---

## 7. Confirmation atomique et garanties

`SubscriptionPaymentsService.confirmPayment(paymentId)` est le point
d'entrée **unique**, réutilisable par le refresh et les futurs webhook et
scripts.

1. Lecture locale. Si le paiement est déjà `succeeded`, c'est un rejeu sans
   réseau ; s'il est en `review`, il reste inchangé.
2. Consultation du prestataire **hors transaction**. Si elle échoue :
   `503 PAYMENT_STATUS_UNAVAILABLE`, état conservé (seul `lastCheckedAt`
   est mis à jour lorsque la réponse arrive).
3. **Concordance stricte** : la référence marchand doit être égale, la
   référence prestataire égale si elle est déjà connue, le montant un
   **nombre entier** égal au montant figé, sans conversion, et la devise
   égale. En cas d'écart : `review` (`provider_mismatch`), aucune
   attribution, collecte toujours bloquée.
4. `pending` → `pending` ; `failed` → `failed` (seulement depuis un état
   ouvert).
5. `succeeded` → `runInGrantTransaction` (socle 1-14D.2A), **sans réseau**
   dans le callback :
   - relecture du paiement dans la session ; s'il est déjà `succeeded`,
     c'est un rejeu ; s'il n'est pas finalisable (`review`), rien n'est
     fait ;
   - **revérification** des valeurs figées contre le résultat vérifié ;
   - `grantSubscriptionInSession({ source: 'payment', sourceReference: 'payment:<id>', grantedBy: 'payment:<provider>' })` ;
   - `updateOne({ _id, status: <lu>, periodId: null }, { succeeded, open: false, periodId, confirmedAt })`,
     dont le `modifiedCount === 1` est **vérifié**. Sinon la transaction
     est annulée : aucune période sans paiement marqué.

| Situation | Résultat |
|---|---|
| Confirmations répétées ou concurrentes | Une seule période (index `{source, sourceReference}` + statut relu dans la transaction) |
| Échec après l'attribution, dans la transaction | Rollback commun ; la confirmation suivante attribue une seule fois |
| Succès après un délai local (minutes, jours, essai expiré) | Accepté ; `début = max(heure serveur, fin de couverture)` |
| Refus confirmé | Aucune attribution ; `failed` |
| Succès vérifié après un refus | `succeeded` + période (argent débité) |
| Échec arrivé après un succès (réponse désordonnée) | Aucune régression ni retrait de période ; incident `late_failure_after_success` |
| Discordance | `review`, aucune attribution ni nouvelle collecte |
| Référence prestataire déjà portée par un autre paiement | `review` |
| Budget transactionnel épuisé ou contention persistante | `503 PAYMENT_CONFIRMATION_PENDING`, état inchangé ; confirmation ultérieure idempotente |

Le paiement ne modifie aucun rôle, aucune permission ni
`Organization.status` : une organisation suspendue reste refusée après
paiement. à l’expiration, aucune écriture n’est validée.

### Budget transactionnel global : 30 secondes

La phase transactionnelle d'une confirmation dispose d'un **budget unique de
30 s** (`PAYMENT_CONFIRMATION_BUDGET_MS`). Il couvre les reprises
applicatives et les reprises automatiques du driver.

**Mécanisme vérifié dans les versions installées** (Mongoose 9.9.0, driver
MongoDB 7.5.0) :

- `ClientSession.withTransaction(fn, { timeoutMS })` crée un contexte CSOT
  (`session.timeoutContext`). Chaque opération exécutée avec cette session
  en hérite (`TimeoutContext.create` renvoie `session.timeoutContext`) :
  lectures et écritures Mongoose du callback, `commitTransaction` et
  reprises internes (`TransientTransactionError`,
  `UnknownTransactionCommitResult`). La boucle de reprise du driver utilise
  ce même temps restant, au lieu de sa fenêtre par défaut de 120 s.
- Mongoose ne réécrit pas `session.withTransaction` : nous appelons celui du
  driver, et les opérations de modèle passent par le driver avec la session.
- À l'expiration, le driver lève `MongoOperationTimeoutError` et **annule
  la transaction** (`abortTransaction`) : aucune écriture n'est validée.
  C'est une annulation réelle, pas un `Promise.race` qui laisserait les
  écritures continuer en arrière-plan.

**Application** (`runInGrantTransaction(work, { budgetMs })`) :

1. L'échéance est calculée **une seule fois** sur une horloge monotone
   injectable (`SUBSCRIPTION_MONOTONIC_CLOCK`, `performance.now()`).
2. Chaque tentative reçoit uniquement le **temps restant** comme
   `timeoutMS`. Aucune tentative ne réinitialise le budget.
3. S'il reste moins d'une milliseconde, **aucune nouvelle tentative** n'est
   lancée et `GRANT_TIMEOUT` est levée. `timeoutMS: 0`, qui signifie « sans
   limite » pour le driver, n'est jamais transmis.
4. Une expiration CSOT du driver devient `GRANT_TIMEOUT`, sans reprise.
5. Le plafond de **5 tentatives** et le ciblage des collisions (index
   d'idempotence et de séquence des périodes) sont conservés, puis
   `GRANT_CONTENTION`.
6. Sans `budgetMs` (attribution manuelle, script CLI), aucun `timeoutMS`
   n'est transmis : le comportement de 1-14D.2A est inchangé.

**À l'épuisement** (`GRANT_TIMEOUT` ou `GRANT_CONTENTION`) : réponse
temporaire stable `503 PAYMENT_CONFIRMATION_PENDING`. Il n'y a aucun
changement d'état, jamais de classement en `failed`, ni nouvelle collecte
ni nouvelle référence. Une confirmation ultérieure dispose d'un nouveau
budget, relit le paiement et retrouve un éventuel commit déjà validé
(rejeu, sans appel au prestataire ni seconde période).

**Délais de nettoyage** :

- l'`abortTransaction` émis par le driver après expiration dispose de son
  propre délai (`timeoutMS` rafraîchi pour l'annulation, d'après
  `sessions.js`). La réponse 503 peut donc arriver jusqu'à environ un
  budget de tentative **après** l'échéance dans le pire cas. Le serveur a
  cependant déjà refusé toute nouvelle opération de la transaction ;
- si l'annulation n'atteint pas le serveur (coupure), la transaction
  orpheline est abandonnée par MongoDB au bout de
  `transactionLifetimeLimitSeconds` (60 s par défaut). Elle n'est jamais
  validée sans commit ;
- seules les opérations MongoDB sont bornées. Le callback ne contient
  aucune attente hors base ni appel réseau (contrat de `work`).

La consultation du statut chez le prestataire, faite **avant** la
transaction, n'entre pas dans ce budget ; le futur adaptateur devra borner
ses appels HTTP. Une consultation en échec renvoie 503 et n'est jamais
relancée automatiquement.

### Réponses concurrentes tardives

Toutes les écritures hors transaction sont **conditionnelles** sur l'état
courant. `succeeded` n'apparaît dans aucun filtre de transition :

| Réponse tardive | Écriture tentée | Effet sur un paiement `succeeded` |
|---|---|---|
| Statut `pending` obsolète (consultation lente) | `recordPending` : filtre `status ∈ {initiating, uncertain}` | Aucune : ni régression, ni réouverture, période conservée |
| Initiation `accepted` arrivant après une confirmation | `recordPending` : filtre `status = initiating` | Aucune ; référence prestataire identique, sinon `review` (impossible depuis `succeeded`) |
| Statut `failed` obsolète | `recordFailure` : filtre sur les états ouverts | Aucune ; incident `late_failure_after_success` consigné |
| Discordance tardive | `markReview` : filtre sur les états finalisables | Aucune |

Chaque cas est couvert par un test e2e à barrières déterministes (§ 8).

---

## 8. Tests

### Ajoutés

- [payment-request.spec.ts](../../api/src/subscriptions/payments/payment-request.spec.ts) :
  normalisation et masquage du téléphone, empreinte HMAC, références, DTO
  stricts (champs forgés, UUID v4, bornes de l'historique), fournisseur par
  défaut.
- [subscription-payment-indexes.spec.ts](../../api/src/subscriptions/payments/subscription-payment-indexes.spec.ts) :
  définitions exactes et index absents, non uniques, à unicité inattendue,
  à filtre partiel différent ou absent, à ordre de clé inversé, avec TTL ;
  identification des collisions.
- [subscription-payments.e2e-spec.ts](../../api/test/subscription-payments.e2e-spec.ts) :
  migration compilée (configuration incompatible, puis deux exécutions),
  accès (propriétaire avec JWT applicatif ou jeton limité ; admin, vendeur,
  absence de JWT, suspension, session révoquée), validation et isolation
  A/B, projection, `no-store`, pagination, tarifs figés après changement de
  catalogue, double clic, demandes concurrentes, UUID incohérent, réponse
  perdue, incertitude, absence de recherche, requête non transmise, statut
  indisponible, attente au-delà de 15 minutes, dix confirmations
  concurrentes, rollback commun, refus puis renversement, réponse
  désordonnée, concordance (7 variantes), accès rétabli par l'échange
  `complete`, suspension prioritaire, limitation de débit ; puis, à la
  reprise : réponses tardives `pending` et `accepted` après succès (§ 8),
  budget épuisé sans nouvelle tentative, commit validé dont la réponse est
  perdue, expiration CSOT réelle du driver (§ 12).
- [subscription-payments-default-provider.e2e-spec.ts](../../api/test/subscription-payments-default-provider.e2e-spec.ts) :
  fournisseur par défaut (configuration de production). Il est dans un
  fichier séparé parce que Passport enregistre la stratégie `jwt` dans un
  singleton global : il faut une seule application Nest par processus de
  test.

### Modifiés

- `subscription-access-routes.spec.ts` : 4 routes `owner-renewal` ajoutées,
  avec l'opération `billing.payment` vérifiée.
- `subscriptions.service.spec.ts` (1-14D.2A) : 8 tests du budget global
  (temps restant transmis, aucune tentative après épuisement, jamais
  `timeoutMS: 0`, expiration CSOT, plafond de 5 tentatives conservé,
  budgets invalides, absence de `timeoutMS` pour l'attribution manuelle).
- `organization.schema.spec.ts` : la liste owner-only inclut `billing.payment`.

### Résultats réels

Exécutées le 2026-10-02 sur la branche, sur le replica set éphémère
uniquement (`MongoMemoryReplSet`, garde anti-27017). Prestataire simulé
injecté par les tests ; aucun paiement, email ou appel CamPay.

| Contrôle | Commande | Résultat |
|---|---|---|
| Build (actualisation de `dist/`, dont la migration) | `pnpm --filter api build` | Réussi |
| E2E ciblés | `jest --config ./test/jest-e2e.json --maxWorkers=1 test/subscription-payments.e2e-spec.ts test/subscription-payments-default-provider.e2e-spec.ts` | **2 suites, 50 tests verts** (48 + 2) |
| Migration compilée sur la base éphémère (dans l'e2e) | `node dist/migrations/create-subscription-payment-indexes.js` en sous-processus | Index de même clé non unique : code 1, `merchantReference_1 : unicité inattendue`, **aucune autre création**, index d'origine conservé ; puis exécution n° 1 : `index créés et vérifiés` ; exécution n° 2 : `déjà présents` ; `ensure` en processus : `already-present` ; sans URI : code 1 ; l'URI n'apparaît jamais dans la sortie |
| Unitaires API complets | `npx jest` | **65 suites, 1 119 tests verts** |
| E2E API complets | `npx jest --config ./test/jest-e2e.json --maxWorkers=1` | **19 suites, 459 tests verts** (226 s) |
| ESLint API, sans `--fix` | `npx eslint "{src,test}/**/*.ts"` | 0 erreur, 2 avertissements **préexistants** dans des fichiers non modifiés (`test/app.e2e-spec.ts`, `test/e2e/ephemeral-mongodb.ts`) |
| Typage de production | `npx tsc --noEmit -p tsconfig.build.json` | Code 0, aucune erreur |
| Build API final | `pnpm --filter api build` | Réussi |

Nouveaux tests unitaires : `payment-request.spec.ts` 36,
`subscription-payment-indexes.spec.ts` 13, `subscriptions.service.spec.ts`
27 (dont 8 nouveaux), `subscription-access-routes.spec.ts` 6.

Prettier a été appliqué **uniquement** aux fichiers de ce lot. Aucun build
web ni Docker n'a été lancé.

### Défauts constatés et corrigés

**Défauts applicatifs**

1. **Migration** : `ensureSubscriptionPaymentIndexes` pouvait créer des
   index absents **avant** de rencontrer un index mal configuré plus loin
   (création partielle). Désormais, tous les index requis et l'absence de
   TTL sont validés avant toute création.
2. **Confirmation non bornée** : la phase transactionnelle pouvait durer
   jusqu'à 5 × 120 s (fenêtre par défaut du driver). Elle est remplacée par
   le budget global de 30 s décrit au § 7.
3. **Erreurs d'attribution renvoyées en 500** : `GRANT_CONTENTION` (et le
   nouveau `GRANT_TIMEOUT`) sont des `SubscriptionGrantError`, pas des
   exceptions HTTP. Ils sont désormais traduits en
   `503 PAYMENT_CONFIRMATION_PENDING`, temporaire, sans changement d'état.

**Défauts de tests**

1. **Deux applications Nest dans le même processus** : Passport garde la
   stratégie `jwt` dans un singleton global. La seconde application avait
   remplacé la stratégie de la première, et sa fermeture coupait la
   connexion utilisée ensuite, d'où des 500 en cascade
   (`MongoNotConnectedError` dans `JwtStrategy.validate`). Le scénario du
   fournisseur par défaut a été déplacé dans son propre fichier e2e. Aucun
   défaut de production.
2. Une attente erronée sur le téléphone `+-237…` : il est en réalité
   normalisé sans ambiguïté (tolérance voulue). Le cas a été remplacé par
   `++237…`, qui est refusé.
3. Des typages `any` de supertest déclenchaient des avertissements ESLint :
   les helpers acceptent désormais `unknown`, convertis explicitement.
4. `dist/` datait d'avant la correction de la migration : il a été
   reconstruit avant l'e2e.

Aucune garde n'a été désactivée et aucune assertion affaiblie.

**Incidents d'exécution** (session précédente)

- Le contrôle d'autorisation des commandes est resté indisponible pendant
  5 tentatives consécutives (Bash puis PowerShell). Les commandes
  concernées (build, e2e ciblés, suites complètes) ont toutes été
  réexécutées lors de cette reprise ; les résultats ci-dessus en
  proviennent.
- Un heredoc contenant des apostrophes a été mal analysé par le shell
  (aucune modification appliquée). Les scripts d'édition sont désormais
  passés par des fichiers temporaires.

### Limites restantes

- **CamPay** : la recherche d'une transaction par **notre** référence
  marchand reste **non confirmée**. Le simulateur la fournit, mais **ne
  prouve pas** que CamPay l'offre. Sans elle, un paiement `uncertain` ne
  peut être levé que par un opérateur, pour qui aucun outil n'existe encore.
- Les paiements `review` exigent un traitement opérateur (outillage à venir).
- La consultation du statut chez le prestataire est hors du budget
  transactionnel : le futur adaptateur devra borner ses appels HTTP.
- Le test d'expiration CSOT réelle repose sur un dépassement temporel
  (attente de 400 ms pour un budget de 150 ms) : son issue est
  déterministe, mais il s'appuie sur une durée réelle. Les autres scénarios
  concurrents utilisent des barrières.
- Le stockage de limitation de débit reste en mémoire (une seule instance
  d'API, comme pour les fenêtres existantes).
- `createdAt` et `updatedAt` sont posés par Mongoose à l'heure système. Les
  dates métier (`initiatedAt`, `confirmedAt`, `failedAt`, périodes)
  utilisent l'horloge serveur injectable.
- `tsc -p tsconfig.json` (specs comprises) signale toujours des erreurs de
  typage **préexistantes** dans des specs non modifiés, hors périmètre.


---

## 9. Fichiers

Modifiés :

| Fichier | Nature |
|---|---|
| `api/package.json` | Script `migrate:subscription-payment-indexes` uniquement |
| `api/src/auth/auth.controller.ts` | `@SkipThrottle` des fenêtres de paiement |
| `api/src/auth/auth.module.ts` | Fenêtres de paiement dans le `forRoot` unique |
| `api/src/organizations/organizations.controller.ts` | Création d'invitations : exclusion des fenêtres de paiement |
| `api/src/organizations/permissions.ts` | Opération owner-only `billing.payment` |
| `api/src/organizations/organization.schema.spec.ts` | Liste owner-only attendue |
| `api/src/subscriptions/subscription-access-routes.spec.ts` | Matrice des routes |
| `api/src/subscriptions/subscriptions.module.ts` | Modèle, service, contrôleur, prestataire par défaut, vérification des index, horloge monotone |
| `api/src/subscriptions/subscriptions.service.ts` | Budget global (`budgetMs`, horloge monotone, `GRANT_TIMEOUT`, `isGrantTimeout`) ; manuel inchangé |
| `api/src/subscriptions/subscriptions.service.spec.ts` | Tests du budget |
| `api/src/subscriptions/subscription-clock.ts` | `SUBSCRIPTION_MONOTONIC_CLOCK` |

Nouveaux :

- `api/src/common/subscription-payment-rate-limiting.ts`
- `api/src/migrations/create-subscription-payment-indexes.ts`
- `api/src/subscriptions/payments/` : `payment-provider.ts`,
  `payment-request.ts`, `payment-errors.ts`,
  `dto/subscription-payment.dto.ts`,
  `schemas/subscription-payment.schema.ts`,
  `subscription-payment-indexes.ts`, `subscription-payments.service.ts`,
  `subscription-payments.controller.ts`, `payment-request.spec.ts`,
  `subscription-payment-indexes.spec.ts`
- `api/test/e2e/simulated-payment-provider.ts`
- `api/test/subscription-payments.e2e-spec.ts`
- `api/test/subscription-payments-default-provider.e2e-spec.ts`
- `docs/architecture/phase-1-14d2b-subscription-payments.md`

Hors de ce lot : `web/src/app/app/organization/layout.tsx` apparaît
modifié dans l'arbre de travail. Ce changement est **préexistant** à la
reprise ; il n'a été ni produit, ni lu, ni modifié par ce lot. Le
frontend, le lockfile, Docker, nginx et les `.env` n'ont pas été modifiés
par ce lot.
