# Phase 1-14D.2A — Socle serveur des paiements

Branche : `architecture/phase-1-14d2a-payment-foundation`
Base : `6c7ddff` (phase 1-14C.2). Rapport préalable :
[phase-1-14d1-payment-provider-audit.md](phase-1-14d1-payment-provider-audit.md)
(toujours non commité, conservé tel quel). Stash `stash@{0}` préservé.

Premier lot d'implémentation, **serveur uniquement** : catalogue tarifaire
et attribution dans une transaction externe. Aucun commit, push,
déploiement, paiement réel, package, lockfile, fichier frontend, Dockerfile
ou `.env` modifié. Aucune route HTTP ajoutée.

Hors périmètre (lots suivants) : collection `subscription_payments`, routes
propriétaire, adaptateur simulé, webhook, réconciliation, CamPay.

---

## 1. Catalogue tarifaire serveur

[subscription-pricing.ts](../../api/src/subscriptions/subscription-pricing.ts) — module pur, sans I/O.

| Durée | Mois | Montant total |
|---|---:|---:|
| `monthly` | 1 | 3 000 XAF |
| `quarterly` | 3 | 8 500 XAF |
| `semiannual` | 6 | 16 000 XAF |
| `annual` | 12 | 30 000 XAF |

Contrat :

- `SUBSCRIPTION_PRICING_VERSION = 1`, `SUBSCRIPTION_PRICING_CURRENCY = 'XAF'`.
- `SUBSCRIPTION_PRICES_XAF` est gelé. `getSubscriptionPrice(term)` renvoie un
  objet gelé `{ term, months, amount, currency, pricingVersion }`. Les mois
  viennent de `TERM_MONTHS`, il n'existe aucune seconde table de durées.
- Le montant est le **prix total facturé au client**, avant déduction des
  frais du prestataire.
- La seule entrée est la durée. Toute valeur qui n'est pas exactement une
  durée connue lève `SubscriptionPricingError` (`UNKNOWN_SUBSCRIPTION_TERM`) :
  casse différente, espaces, nombres, objets, `__proto__`… Aucune fonction
  n'accepte de montant.
- Au chargement du module, le démarrage échoue si une durée n'a pas de prix,
  si un prix n'a pas de durée, ou si un montant n'est pas un entier positif.

**Parité avec le web** :
[subscription-pricing.spec.ts](../../api/src/subscriptions/subscription-pricing.spec.ts)
importe le **vrai module** `web/src/lib/subscription-offers.ts`. Ce module
exécute aussi sa propre vérification de cohérence. Le test compare ensuite
durées, ordre, mois, montants totaux et prix mensuel de référence. Seul ce
test importe le module web : le code de production de l'API ne l'importe
jamais, et `tsconfig.build.json` exclut les `*.spec.ts`.

---

## 2. Attribution dans une transaction externe

[subscriptions.service.ts](../../api/src/subscriptions/subscriptions.service.ts),
[subscription-terms.ts](../../api/src/subscriptions/subscription-terms.ts)

### 2.1 Source `payment`

- `SubscriptionSource.PAYMENT = 'payment'`. Le schéma
  `subscription_periods` utilise directement l'enum : `payment` est accepté
  sans modification du schéma. Le validateur existant
  (`kind === trial ⇔ source === trial`) impose qu'une attribution `payment`
  soit de nature `subscription`.
- `GrantableSubscriptionSource = manual | payment` et
  `isGrantableSubscriptionSource`. `trial` reste impossible en dehors de
  `grantTrial`.
- **Aucun index modifié** : l'index unique existant `{ source, sourceReference }`
  garantit au plus une période par référence **et par source**.

### 2.2 Contrat réutilisable

```ts
grantSubscriptionInSession(
  input: {
    organizationId: string;              // 24 hex
    term: string;                        // monthly | quarterly | semiannual | annual
    source: 'manual' | 'payment';
    sourceReference: string;             // 1..200, trim
    grantedBy: string;                   // 1..100, trim
  },
  session: MongooseSession,              // transaction ACTIVE de l'appelant
): Promise<GrantedPeriodView>            // { periodId, organizationId, sequence, term, startsAt, endsAt, replayed }

runInGrantTransaction<T>(
  work: (session: MongooseSession) => Promise<T>,
): Promise<T>
```

`grantSubscriptionInSession` :

- exige `session.inTransaction()`, sinon `TRANSACTION_REQUIRED` est levée
  avant toute lecture ;
- n'ouvre, ne valide et n'annule aucune transaction ; toutes ses lectures et
  écritures passent par `session` ;
- recherche l'idempotence sur **exactement** `{ source, sourceReference }` ;
- en cas de rejeu de la même demande (organisation + nature + durée),
  renvoie la période existante avec `replayed: true`, sans écriture ;
- si la demande diffère, lève `SUBSCRIPTION_REFERENCE_CONFLICT`. L'erreur
  remonte et la transaction de l'appelant est annulée ;
- sinon : `startsAt = max(heure serveur, fin de couverture déjà accordée)`,
  mois calendaires UTC ramenés au dernier jour valide,
  `sequence = dernier rang + 1`, `previousPeriodId` chaîné ;
- ne capture **aucune** erreur de base de données : un E11000 remonte tel quel.

`runInGrantTransaction` :

- chaque tentative utilise une **nouvelle session et une nouvelle
  transaction** ;
- après une collision `source_1_sourceReference_1` ou
  `organizationId_1_sequence_1`, il rejoue **le callback complet**, donc
  l'écriture de l'appelant **et** l'attribution ensemble. Il fait au plus
  `MAX_GRANT_ATTEMPTS = 5` tentatives, puis lève `GRANT_CONTENTION` ;
- toute autre erreur est relancée telle quelle après annulation, sans
  reprise : index d'essai, index de l'appelant, erreur métier, erreur
  quelconque ;
- la session est fermée à chaque tentative ;
- seul le résultat de la dernière exécution validée est renvoyé, y compris
  quand `withTransaction` rejoue le callback après une erreur transitoire.

**Obligations du callback `work`** :

- utiliser la session reçue pour toutes ses opérations ;
- ne jamais capturer une erreur de base pour continuer à écrire, car la
  transaction est déjà annulée côté serveur ;
- n'effectuer aucun appel réseau ni effet externe, puisqu'il peut être
  rejoué. La consultation du statut chez le prestataire se fera **avant**
  la transaction (lot suivant).

### 2.3 Attribution manuelle (CLI) : contrat inchangé

`grantSubscription(input)` recopie explicitement les quatre champs
`organizationId`, `term`, `sourceReference` et `grantedBy`, et fixe
`source: manual`. Une `source` glissée dans l'objet est ignorée (test
unitaire). La validation a lieu avant toute session, puis l'appel passe par
`runInGrantTransaction(grantSubscriptionInSession)`. Le script
`subscription:grant` n'a pas été modifié et n'expose aucun paramètre de
source. Résultats, codes d'erreur et idempotence sont identiques ; seule
différence interne, la vérification `assertSameRequest` d'un rejeu
s'exécute désormais **dans** la transaction, qui ne contient alors que des
lectures. L'effet est le même : conflit et aucune écriture.

### 2.4 Usage prévu au lot suivant (non implémenté)

```ts
const status = await provider.fetchStatus(ref);          // réseau, HORS transaction
await subscriptions.runInGrantTransaction(async (session) => {
  const payment = await payments.findOne({ _id }, { session });
  if (payment.status === 'succeeded') return replay(payment);
  const period = await subscriptions.grantSubscriptionInSession(
    { organizationId, term, source: 'payment', sourceReference: `payment:${_id}`, grantedBy: 'payment:campay' },
    session,
  );
  await payments.updateOne({ _id, status: { $ne: 'succeeded' } }, { $set: { status: 'succeeded', grantedPeriodId: period.periodId } }, { session });
  return period;
});
```

---

## 3. Garanties transactionnelles démontrées

| Garantie | Preuve |
|---|---|
| Paiement et période annulés ensemble | e2e § 3 : une erreur après l'attribution et le marquage ne laisse ni période ni marquage ; la finalisation suivante réussit une seule fois |
| Écriture de l'appelant annulée si l'attribution refuse | e2e § 3 (`ORGANIZATION_NOT_FOUND`) et § 4 (`SUBSCRIPTION_REFERENCE_CONFLICT`) : le témoin reste `pending` |
| Aucune transaction propre | unitaire : pas de `startSession` ; e2e : session hors transaction → `TRANSACTION_REQUIRED`, aucune écriture |
| Rejeu sans nouvelle période | e2e § 4 : même `periodId`, mêmes dates, même rang, à une heure différente |
| `manual` et `payment` indépendants | e2e § 4 : même référence sous les deux sources → deux périodes, chacune idempotente, conflit propre à sa source |
| Concurrence sans durée perdue | e2e § 5 : 4 paiements + 1 manuel simultanés → rangs 1 à 6, périodes jointives, fin = essai + 5 mois ; chaque témoin pointe vers sa propre période |
| Concurrence d'un même paiement | e2e § 5 : 6 finalisations → 1 période, 1 marquage |
| Reprise de la transaction complète | unitaire : nouvelle session à chaque tentative ; e2e : 14 exécutions du callback pour 4 finalisations, avec des témoins exacts |
| Ciblage des collisions | unitaire + e2e § 6 : les collisions de l'index d'essai et de l'index de l'appelant sont relancées après **1** exécution, sans aucune écriture |
| Borne des reprises | unitaire : 5 tentatives puis `GRANT_CONTENTION`, 5 sessions fermées |

---

## 4. Tests

### Fichiers ajoutés

- [subscription-pricing.spec.ts](../../api/src/subscriptions/subscription-pricing.spec.ts) :
  tarifs, devise, version, durées invalides, immuabilité, absence de montant
  libre, parité avec le web.
- [subscriptions.service.spec.ts](../../api/src/subscriptions/subscriptions.service.spec.ts) :
  ciblage des collisions, reprises, bornes, fermeture des sessions,
  `TRANSACTION_REQUIRED`, source refusée, source `manual` figée pour le CLI.
- [subscription-payment-foundation.e2e-spec.ts](../../api/test/subscription-payment-foundation.e2e-spec.ts) :
  15 tests sur le replica set éphémère (garde anti-27017). L'appelant est
  simulé par une collection de **fixture** `e2e_payment_witnesses` ; ce
  n'est pas le futur modèle `subscription_payments`.

Les e2e existants (`subscriptions`, `subscription-access`) couvrent toujours
l'essai, le CLI compilé et le blocage commercial, sans modification.

### Résultats réels

Exécutés le 2026-10-01 sur la branche, après stabilisation des changements.

| Validation | Commande | Résultat |
|---|---|---|
| Tests ciblés (pendant l'implémentation) | `jest src/subscriptions` | 7 suites, 125 tests, tous verts |
| E2E ciblé | `jest --config test/jest-e2e.json test/subscription-payment-foundation.e2e-spec.ts` | 15/15 ; 4 finalisations simultanées = 14 exécutions du callback (reprises réelles) |
| Unitaires API complets | `pnpm --filter api test` (`jest`) | **63 suites, 1 059 tests, tous verts** |
| E2E API complets | `jest --config ./test/jest-e2e.json --maxWorkers=1` | **17 suites, 409 tests, tous verts** (170,8 s) |
| ESLint API, sans `--fix` | `eslint "{src,test}/**/*.ts"` | 0 erreur ; 2 avertissements préexistants dans des fichiers non modifiés (`test/app.e2e-spec.ts`, `test/e2e/ephemeral-mongodb.ts`) |
| Build API | `nest build` | Réussi |
| Typage de production | `tsc --noEmit -p tsconfig.build.json` | Aucune erreur |

Prettier a été appliqué **uniquement** aux fichiers de ce lot.
`tsc -p tsconfig.json`, qui inclut les specs, signale des erreurs de typage
**préexistantes** dans des specs non modifiés (`auth.*.spec.ts`,
`subscriptions.e2e-spec.ts`…). ts-jest les transpile sans contrôle de type ;
elles sont hors périmètre et n'ont pas été touchées.

---

## 5. Fichiers modifiés

| Fichier | Nature |
|---|---|
| `api/src/subscriptions/subscription-terms.ts` | `SubscriptionSource.PAYMENT`, `GrantableSubscriptionSource`, `isGrantableSubscriptionSource` |
| `api/src/subscriptions/subscriptions.service.ts` | `runInGrantTransaction`, `grantSubscriptionInSession`, `isRetryableGrantCollision`, `TRANSACTION_REQUIRED` ; `grantSubscription` délègue à ces deux méthodes ; `applyGrant` utilise la source reçue |
| `api/src/subscriptions/subscription-pricing.ts` | nouveau : catalogue tarifaire |
| `api/src/subscriptions/subscription-pricing.spec.ts` | nouveau |
| `api/src/subscriptions/subscriptions.service.spec.ts` | nouveau |
| `api/test/subscription-payment-foundation.e2e-spec.ts` | nouveau |
| `docs/architecture/phase-1-14d2a-payment-foundation.md` | ce document |

Fichiers inchangés : schéma et index `subscription_periods`, migrations,
script CLI, contrôleurs, guards, frontend, Docker, `package.json` et lockfile.
