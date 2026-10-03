# Phase 1-14D.2G — Rapprochement des paiements par CLI opérateur

Branche : `architecture/phase-1-14d2g-payment-reconciliation-cli`
Base : **`1cd7d236b5444752f72c21e4e467ae241998aa4c`** (« feat(api): add
disabled CamPay subscription webhook », 1-14D.2F). Au départ, l'arbre et
l'index étaient propres ; le stash `stash@{0}` (sauvegarde lint-staged) est
préservé.

Rapports lus : [1-14D.2B](phase-1-14d2b-subscription-payments.md) (moteur
de confirmation), [1-14D.2D](phase-1-14d2d-campay-adapter.md) (adaptateur,
montants lexicaux), [1-14D.2F](phase-1-14d2f-campay-webhook.md) (webhook).

Ce lot ne contient aucun commit, push, déploiement ni changement Railway.
Il n'active ni le fournisseur ni le webhook, ne fait aucun appel CamPay réel
et n'ajoute aucune dépendance (lockfile inchangé ; `api/package.json` reçoit
seulement deux scripts).

> **Production inchangée.** Le fournisseur injecté reste
> `UnavailablePaymentProvider` : avec lui, le CLI peut **inspecter**, mais
> toute simulation ou application est **bloquée** (`provider-unavailable`),
> sans appel au prestataire ni mutation. Le webhook reste désactivé. Aucune route
> HTTP ni aucun droit propriétaire n'est ajouté.

### Incident pendant les tests (signalé)

**Exception à « bases éphémères uniquement ».** Un essai de ce lot ne s'est
**pas** limité à une base éphémère. Une première version du test du binaire
réel lançait le CLI avec `api/` comme répertoire courant. Ce CLI importait
alors `AppModule` **avant** de vérifier `MONGODB_URI`, et le
`ConfigModule` de l'application charge **automatiquement** le fichier
`.env` du répertoire courant. Dans le cas « `MONGODB_URI` absent », le
processus a donc utilisé la base désignée par `api/.env`.

Je n'ai **pas consulté manuellement** `api/.env` (ni avant, ni après) et
j'ignore quelle base il désigne. Mais ce fichier a bien été **chargé
automatiquement** par le processus de test. Conformément à la consigne,
cette base n'a pas été consultée après coup.

**Opérations établies** (déduites du code exécuté et du résultat observé) :

- ouverture d'une connexion MongoDB vers la base de `api/.env` ;
- démarrage d'un contexte Nest complet, `NODE_ENV` absent (donc sans les
  vérifications d'index de production) ;
- commande `inspect` sur un identifiant aléatoire : `findById` sur
  `subscription_payments`, qui n'a trouvé aucun document (code de sortie
  3, observé) ;
- aucune écriture **métier** : `inspect` n'insère, ne modifie et ne
  supprime aucun document, et aucun `--apply` n'a été lancé.

**Créations de schéma possibles** (non observées sur cette base) : à cette
version, Mongoose utilisait ses options **par défaut**, `autoCreate: true`
et `autoIndex: true`. Au démarrage, chaque modèle compilé pouvait donc :

- **créer sa collection** si elle était absente. C'est vrai même pour les
  schémas en `autoIndex: false`, dont la nouvelle collection d'audit
  `subscription_payment_reconciliations`, qui ne pouvait pas exister
  avant ce lot ;
- **créer ses index** déclarés si `autoIndex` n'était pas désactivé pour
  ce schéma.

Reproduction **locale** avec le même code (options par défaut, `NODE_ENV`
absent), sur une base éphémère **vide** : un seul `inspect` a créé les
collections `organizations`, `subscription_payment_reconciliations`,
`subscription_payments`, `subscription_periods` et `users` (index
`_id` seul lors de cet essai). La liste dépend de la durée du processus et
de l'état préalable de la base.

**Impact encore inconnu** : quelles collections ou index existaient déjà
sur la base de l'incident, et donc ce qui a réellement été créé (au moins
probablement la collection vide `subscription_payment_reconciliations`,
si la base n'avait jamais vu ce lot). Ces créations éventuelles sont des
**métadonnées vides**, sans document. **À vérifier de votre côté**, sur la
base désignée par `api/.env` : la présence et la date de création de
`subscription_payment_reconciliations` (vide), et d'éventuelles
collections ou index inattendus.

**Corrections**

1. Le CLI valide les arguments, **puis** `MONGODB_URI` dans
   l'environnement du processus, **avant** tout chargement de l'application
   (import différé). Un `.env` local ne peut plus désigner la base.
2. Le CLI désactive `autoIndex` **et** `autoCreate` sur l'instance
   Mongoose (partagée avec `@nestjs/mongoose`), **avant** le chargement de
   l'application et quel que soit `NODE_ENV`. Les créations de schéma
   restent dans les migrations explicites. L'API, qui est un autre
   processus, garde son comportement.
3. Les autres effets d'initialisation du contexte ont été vérifiés. Ils
   n'écrivent rien dans MongoDB : politique Sharp du processus, compteurs
   de limitation en mémoire, gateway Socket.IO construite sans écoute,
   expéditeur d'e-mails et client S3 sans appel à la construction,
   vérifications d'index de production en **lecture** (`listIndexes`).
4. Les tests du binaire s'exécutent dans des répertoires temporaires, sur
   la base éphémère, avec les preuves décrites au § 4.

---

## 1. Commandes

Prérequis : `pnpm --filter api build`, puis l'environnement de l'API.
`MONGODB_URI` doit être fourni par l'environnement du processus (un `.env`
est ignoré pour cette variable), et `JWT_SECRET` et `CORS_ORIGIN` sont
requis en `NODE_ENV=production`, comme pour l'API. En production, le
démarrage vérifie aussi les index de production. **Aucune collection ni
aucun index n'est créé au démarrage du CLI**, quel que soit `NODE_ENV` :
ils doivent provenir des migrations. Sur une base non migrée,
`inspect` et la simulation répondent « introuvable », et `--apply` est
refusé faute d'index (code 1).

```bash
# Index de l'audit (une fois, avant tout --apply)
MONGODB_URI=... pnpm --filter api migrate:subscription-payment-reconciliation-indexes

# Inspection locale (aucun appel au prestataire)
pnpm --filter api subscription:reconcile-payment -- inspect --payment-id=<id>

# Simulation (DÉFAUT) : consultation en lecture, aucune écriture
pnpm --filter api subscription:reconcile-payment -- reconcile --payment-id=<id> [--reference=<uuid CamPay>]

# Application EXPLICITE du plan simulé
pnpm --filter api subscription:reconcile-payment -- reconcile --payment-id=<id> [--reference=<uuid>] \
  --apply --plan=<jeton> --operation-id=<uuid v4> --operator=<identifiant> \
  --reason=provider-statement|customer-evidence|support-ticket|review-investigation|uncertain-initiation \
  [--ticket=<référence>]
```

Les arguments sont **stricts** : ils sont tous de la forme `--clé=valeur`,
avec `--apply` comme seul drapeau sans valeur, et tout argument inconnu,
dupliqué ou vide est refusé. Les options d'application ne sont acceptées
qu'avec `--apply`. Le motif est une **liste fermée**. L'identifiant
d'opération est un UUID v4 canonique, en minuscules. **Aucun drapeau ne
choisit le prestataire** : `--provider=…`, `--simulate` et `--env=…` sont
refusés, et le fournisseur est celui injecté par `AppModule`.

| Code de sortie | Sens |
|---|---|
| 0 | Inspection, simulation prête, application faite ou rejouée |
| 1 | Erreur inattendue (message générique : jamais l'URI ni de détail) |
| 2 | Arguments invalides (avant toute connexion) |
| 3 | Paiement introuvable |
| 4 | **Bloqué** : aucune preuve concordante, statut non rapprochable, référence en conflit, fournisseur indisponible, consultation impossible |
| 5 | Plan obsolète (aucune mutation ; le plan courant est affiché) |
| 6 | Identifiant d'opération déjà utilisé avec d'autres paramètres |
| 7 | Résultat de commit inconnu : **rejouer la même opération** |

### Exemple simulé (forme réelle de la sortie, valeurs fictives)

```json
{
  "command": "reconcile",
  "mode": "simulation",
  "plan": {
    "decision": "ready",
    "action": "succeed",
    "paymentId": "6ac12b82afbbef5dbbb7c744",
    "before": { "status": "uncertain", "open": true, "providerReference": null },
    "consultedReference": "52984167-5b52-453b-b953-7e67a3d0dcc2",
    "referenceAttach": true,
    "verified": {
      "state": "succeeded",
      "providerReference": "52984167-5b52-453b-b953-7e67a3d0dcc2",
      "merchantReference": "SM6AC12B82AFBBEF5DBBB7C744",
      "amount": 3000,
      "currency": "XAF"
    },
    "after": { "status": "succeeded", "open": false, "grantsPeriod": true },
    "planToken": "5c17580cc6b4fe845bb2e7c7d1aca168"
  }
}
```

Sur une discordance, la sortie est un plan
`{ "decision": "blocked", "reason": "mismatch", "mismatches": ["amount"],
"verified": { … "amount": null … } }` avec le code 4. Aucune sortie
n'affiche le téléphone (même masqué), l'empreinte de la demande, le
`clientOperationId`, un jeton, une signature ni la réponse brute.

## 2. Règles de décision

Un **plan** est calculé à chaque simulation et **recalculé** à chaque
application : relecture du paiement, puis reconsultation du prestataire.

1. **Statut** : seuls `uncertain` et `review` sont rapprochables. Tout autre
   statut donne `status-not-reconcilable`.
2. **Fournisseur** : il doit être disponible et être celui du paiement.
   Sinon, `provider-unavailable`, sans appel au prestataire ; c'est toujours le cas
   en production.
3. **Référence consultée** :
   - si une référence CamPay est **persistée**, c'est elle qui est
     consultée. Une candidate différente donne
     `reference-differs-from-persisted` ; une persistée n'est **jamais**
     remplacée ;
   - sinon, la **candidate** fournie par l'opérateur est consultée (simple
     indice, UUID normalisé). Sans elle : `reference-required` ;
   - si la candidate est déjà portée par un autre paiement :
     `reference-already-attached`, **sans** consultation.
4. **Consultation** : uniquement `fetchStatus({ by: 'provider' })`, hors
   transaction, avec le budget HTTP de 10 s de l'adaptateur. Il n'y a aucune
   recherche par référence marchand, aucun autre endpoint et aucune
   initiation. Un échec donne `provider-status-unavailable`.
5. **Concordance exacte** (`paymentConcordanceMismatches`, la fonction
   unique désormais partagée avec le moteur D.2B) : la référence CamPay
   renvoyée doit être égale à la référence consultée, et la référence
   marchand, le montant (nombre entier sûr, validé lexicalement par D.2D,
   `null` sinon) et la devise doivent concorder. Tout écart donne
   `mismatch`, avec la liste des champs, **sans mutation** : l'état et la
   référence sont conservés, y compris pour un `review`.
6. **Action déduite du statut vérifié** (jamais saisie) :

   | Statut vérifié | Action | Effet atomique |
   |---|---|---|
   | `SUCCESSFUL` | `succeed` | Rattachement éventuel, attribution `source: payment`, `sourceReference: payment:<id>`, `grantedBy: payment:campay` (fonction du moteur unique `grantAndMarkSucceededInSession`), `succeeded`, `open: false`, `periodId` |
   | `PENDING` | `mark-pending` | Rattachement éventuel, `pending`, paiement **ouvert**, aucune période. Le cycle normal (refresh, webhook) reprend |
   | `FAILED` | `fail` | Rattachement éventuel, `failed`, `open: false`, `failedAt`, aucune période |

   Un `review` issu d'un paiement **déjà fermé** (`open: false`) ne peut
   jamais être rouvert en `pending` (`closed-review-cannot-reopen`).
7. **Jeton de plan** : empreinte (SHA-256, 32 hexadécimaux) du paiement, de
   l'état avant, de la référence consultée, de l'action et des faits
   vérifiés. Il est déterministe. `--apply` exige le **même** jeton ;
   sinon : code 5 et plan courant affiché, sans mutation. Dans la
   transaction, les préconditions (statut, `open`, référence, absence de
   période, concordance) sont **revérifiées** ; tout écart donne aussi un
   plan obsolète.

**Décision `review` + `FAILED`.** Le moteur automatique ne fait jamais
sortir un paiement de `review`. Le rapport D.2B prévoit la sortie
« hors opérateur » ; ce CLI est cette sortie. Une fermeture n'a lieu
qu'avec une concordance **complète**, selon la sémantique de fermeture
existante (`failed`, `open: false`, jamais après un succès). Un `review`
discordant reste bloqué.

Interdits : collecte, suppression de paiement, modification du tarif,
remboursement, levée de suspension, modification des rôles ou des droits,
attribution manuelle (`source: manual`).

## 3. Atomicité, reprises et audit

- **Réseau hors transaction** ; la mutation du paiement, l'éventuelle
  période et l'**audit** sont écrits dans **une** transaction
  (`runInGrantTransaction`, budget de 30 s, reprises et plafond
  inchangés).
- **Identifiant d'opération** (`--operation-id`) : recherché **avant**
  toute consultation.
  - Même identifiant et mêmes paramètres : le résultat enregistré est
    renvoyé (`replayed`), sans appel au prestataire. L'empreinte couvre le
    paiement, la référence candidate, l'opérateur, le motif, le ticket et
    le jeton.
  - Identifiant réutilisé avec d'autres paramètres : code 6, aucune
    mutation.
  - Course entre deux exécutions du même identifiant : l'index unique
    départage les écritures, et le perdant se replie sur le rejeu.
- **Commit inconnu** (`GRANT_TIMEOUT`/`GRANT_CONTENTION`) : code 7. Un
  rejeu avec le même identifiant retrouve l'audit validé, sans seconde
  période ni appel au prestataire. Si rien n'a été validé, le rejeu recommence le
  plan.
- **Autorisation** : elle repose **uniquement** sur l'accès privilégié à
  l'environnement d'exécution (accès au conteneur, secrets, base de
  production). `--operator` est un identifiant **déclaré**, conservé pour
  l'audit ; il n'authentifie personne.
- **Audit** dans la collection `subscription_payment_reconciliations`,
  un document par mutation, dans la même transaction. Ses champs :
  `operationId`, `requestFingerprint` (empreinte des paramètres CLI),
  `operatorId`, `reasonCode`, `reasonTicket`, `paymentId`,
  `organizationId`, `planToken`, `action`, `consultedReference`,
  `referenceAttached`, `beforeStatus`, `beforeProviderReference`,
  `afterStatus`, `afterProviderReference`, `afterPeriodId`, les faits
  vérifiés (`verifiedState`, `verifiedProviderReference`,
  `verifiedMerchantReference`, `verifiedAmount`, `verifiedCurrency`),
  `result: 'applied'` et `appliedAt` (horloge serveur). Le schéma est
  `strict: 'throw'` et tous ses champs sont immuables. Il ne contient
  jamais de téléphone, de jeton, de signature, de secret ni de corps brut.
- **Index** (migration explicite
  `migrate:subscription-payment-reconciliation-indexes`) : `operationId_1`
  (unique) et `paymentId_1__id_-1`. Tous sont validés **avant** toute
  création ; une configuration incompatible n'est jamais écrasée ; aucun
  TTL ; `autoIndex: false`. Le CLI vérifie ces index et ceux des paiements
  **avant** toute mutation.
- **Moteur D.2B** : deux extractions internes, sans changement de
  comportement. `paymentConcordanceMismatches` remplace le corps de
  `concordant`, et `grantAndMarkSucceededInSession` est extraite de
  `finalize`. Les routes propriétaire et le webhook suivent les mêmes
  règles qu'avant. Les comparateurs d'index (`describeOne`, `sameValue`)
  sont simplement exportés.

## 4. Tests

| Fichier | Contenu |
|---|---|
| [payment-reconciliation-cli.spec.ts](../../api/src/subscriptions/payments/reconciliation/payment-reconciliation-cli.spec.ts) (42) | Protection de démarrage (`autoIndex`/`autoCreate` désactivés ; ordre arguments → `MONGODB_URI` → protection → chargement ; aucun import statique d'`AppModule`) ; arguments valides et 20 cas refusés ; aucun drapeau de prestataire, point d'entrée sur `AppModule` sans surcharge ; codes de sortie 0/1/2/3/4/5/6/7 ; erreur inattendue sans URI ni détail ; concordance (9 discordances) ; index d'audit (absent, unicité, TTL) ; E11000 ciblé ; aucun contrôleur ajouté |
| [payment-reconciliation.e2e-spec.ts](../../api/test/payment-reconciliation.e2e-spec.ts) (25) | Couche CLI réelle sur le service injecté, adaptateur CamPay réel sur faux transport, base éphémère : voir ci-dessous |
| [payment-reconciliation-cli-process.e2e-spec.ts](../../api/test/payment-reconciliation-cli-process.e2e-spec.ts) (14) | **Binaire réel** (`dist/`) en sous-processus, câblage de l'application sans surcharge (`UnavailablePaymentProvider`), base éphémère uniquement, répertoires temporaires. Voir « Preuves d'absence d'écriture » ci-dessous |

**Preuves d'absence d'écriture (binaire réel)**

- **Observation** : profileur MongoDB de niveau 2 sur chaque base cible.
  Toutes les commandes du processus, identifié par son `appName`, sont
  relevées, et **aucune** ne doit écrire : `create`, `createIndexes`,
  `insert`, `update`, `delete`, `findAndModify`, `drop*`,
  `collMod`, `renameCollection`. Les collections et index sont aussi
  photographiés **avant et après**.
- **Témoin positif** : un processus Mongoose aux options par défaut, sur une
  base vide, crée bien collection et index, et le même contrôle le
  **détecte** (`create`, `createIndexes`).
- **Base vide** (collections et index absents), avec `NODE_ENV` absent,
  `development` puis `production` : `inspect`, simulation et `--apply`.
  Codes obtenus : 3/3/1 hors production (application refusée faute
  d'index) et 1/1/1 en production (démarrage refusé faute d'index). Dans
  tous les cas : **aucune** collection, **aucun** index, **aucune**
  commande d'écriture. Hors production, des lectures sont bien observées.
- **Base migrée**, dans les trois configurations : `inspect` 0, simulation
  4 et `--apply` 4 (`provider-unavailable`), paiement inconnu 3.
  Schéma, document et collection d'audit inchangés, aucune commande
  d'écriture, aucune fuite d'URI ni de secret.
- **Régression de l'incident** : un `.env` factice dans le répertoire
  courant pointe vers la base éphémère **à travers un proxy TCP compteur**,
  et `MONGODB_URI` est absent de l'environnement du processus. Pour
  `inspect`, la simulation et `--apply` : code 1 (« MONGODB_URI
  requis »), **zéro connexion** au proxy, base jamais créée. **Témoin** :
  la même URI fournie explicitement passe par le proxy (connexions
  comptées), toujours sans écriture.
- Arguments invalides (dont `--provider=campay` et `--provider=simulated`) :
  code 2, sans connexion.
- **Mutation** : sans l'appel `disableImplicitSchemaWrites()`, les
  **6** scénarios « base vide » et « base migrée » échouent, y compris en
  production : le démarrage crée alors des collections et des index. Le
  code a été restauré et reconstruit. |

Scénarios e2e (simulations internes ; aucun ne prouve le comportement réel
de CamPay) :

- inspection et simulation sans écriture (photographie identique) et
  jeton déterministe ;
- autre prestataire : bloqué, aucun appel ;
- `uncertain` sans référence + `SUCCESSFUL` : rattachement, période
  `payment`, audit complet, historique visible à l'inspection ;
- `review` concordant (succès) puis `review` discordant (bloqué même avec
  un jeton quelconque) ;
- `PENDING`, puis reprise du cycle normal par le refresh ; `FAILED` sur
  `uncertain` et `review`, avec nouvelle demande possible ; `review` fermé
  jamais rouvert ;
- références étrangère, déjà rattachée (sans consultation), réponse sur une
  autre référence, indisponible, différente de la persistée ;
- montants `3000.0000000000000001`, `2999.9999999999999999`, `3000.5`,
  `3e3`, `"3000.0"` et absent (bloqués), `3000.0` et `"3000"` (acceptés) ;
  devise et référence marchand absentes ;
- plan obsolète (code 5, plan courant) ; identifiant rejoué sans appel au prestataire,
  puis réutilisé avec un autre motif, un autre opérateur ou un autre
  paiement (code 6) ;
- **concurrence à barrières** : deux opérateurs (un appliqué, l'autre
  obsolète ; une période, un audit) ; opérateur contre webhook et refresh
  propriétaire (le `review` reste hors du cycle automatique pendant la
  consultation) ; après un `mark-pending`, deux webhooks concurrents
  donnent une seule période ;
- **rollback** : échec de l'écriture d'audit dans la transaction, donc ni
  rattachement, ni période, ni audit ; le rejeu applique ;
- **commit validé, résultat perdu** : code 7, puis rejeu `replayed` sans
  appel ni seconde période ;
- aucune route de rapprochement (404) ; routes propriétaire et contrôles
  d'accès inchangés.

### Défauts constatés pendant la mise au point

- **Applicatif** : chargement du `.env` et ordre des vérifications du CLI
  (incident ci-dessus, corrigé).
- **Applicatif** : créations implicites de collections et d'index au
  démarrage du contexte (options Mongoose par défaut). Corrigé par
  `disableImplicitSchemaWrites()`, et prouvé par profileur, photographies
  et mutation.
- **Test** : la garde e2e n'accepte que la base `inventory_saas_e2e`.
  Les bases par scénario sont dérivées de l'URI **validée** (même hôte
  éphémère).
- **Test** : sur une base vide, `--apply` est refusé faute d'index
  (code 1), et non « introuvable ». Les codes attendus sont précisés par
  commande.
- **Applicatif** : le contexte Nest gardait le processus actif après la
  sortie. Le processus se termine désormais explicitement, après vidage des
  flux.
- **Test** : un contrôle confondait l'empreinte d'opération de l'audit
  (attendue) avec l'empreinte HMAC du paiement (interdite). Il vérifie
  désormais l'absence de la **valeur** de cette dernière.
- **Test** : le binaire en production exige tous les index de production,
  y compris celui des ventes. Le test exécute les quatre migrations.
- **Typage et lint** : rétrécissement de type du plan, champs vérifiés non
  nullables dans l'audit (valeurs revérifiées dans la session), assertion
  inutile. Tout est corrigé, sans assertion de test affaiblie.

## 5. Résultats

Exécutés le 2026-10-03 sur des bases éphémères et de faux transports, **à
l'exception** de l'essai décrit dans « Incident pendant les tests »
(chargement automatique de `api/.env`). Les résultats ci-dessous
proviennent de la dernière exécution, après correction, sur bases
éphémères uniquement.

| Contrôle | Commande | Résultat |
|---|---|---|
| Unitaires ciblés | `npx jest src/subscriptions` | **360/360** (dont 42 nouveaux) |
| E2E ciblés | `npx jest --config ./test/jest-e2e.json --maxWorkers=1 test/payment-reconciliation.e2e-spec.ts test/payment-reconciliation-cli-process.e2e-spec.ts` | **25 + 14** verts (binaire réel : sortie propre sans `--forceExit`) |
| Build API | `pnpm --filter api build` | Réussi |
| Typage de production | `npx tsc --noEmit -p tsconfig.build.json` | Code 0 |
| Unitaires API complets | `npx jest` | **69 suites, 1 337 tests verts** |
| E2E API complets | `npx jest --config ./test/jest-e2e.json --maxWorkers=1` | **24 suites, 563 tests verts** (441 s) |
| ESLint API, sans `--fix` | `npx eslint "{src,test}/**/*.ts"` | 0 erreur ; 2 avertissements **préexistants** (`test/app.e2e-spec.ts`, `test/e2e/ephemeral-mongodb.ts`) |
| `git diff --check` | suivis et nouveaux fichiers | Aucune erreur |

Prettier a été appliqué aux seuls fichiers du lot.

## 6. Limites

- **Cas sans preuve concordante : bloqués.** Une initiation `uncertain`
  dont la référence CamPay est inconnue de l'opérateur ne peut pas être
  rapprochée, faute de recherche par référence marchand confirmée
  (D.2D § 2).
- La preuve repose sur le statut renvoyé par l'adaptateur. En production,
  il est indisponible tant que le fournisseur n'est pas activé
  explicitement (lot ultérieur). Le CLI est donc pour l'instant **inactif**
  en production, hors inspection.
- L'identité de l'opérateur est déclarative ; la sécurité dépend de
  l'accès à l'environnement d'exécution.
- Un `review` fermé avec un statut CamPay `PENDING` reste bloqué
  (réouverture interdite).
- Le CLI démarre un contexte complet (`AppModule`) et exige donc
  l'environnement et les index de production de l'API.
- Comme l'API, le `ConfigModule` lit un éventuel `.env` du répertoire
  courant pour les variables **autres** que `MONGODB_URI`. Exécuter le CLI
  depuis un répertoire maîtrisé.
- L'API elle-même conserve les options Mongoose par défaut (`autoCreate`,
  `autoIndex` pour les schémas qui ne le désactivent pas) : comportement
  existant, hors périmètre de ce lot.
- L'impact réel de l'incident sur la base de `api/.env` reste à vérifier
  par vous (voir ci-dessus).
- Le stockage de limitation et les budgets sont inchangés ; aucune
  réplication horizontale n'est prise en compte.

## 7. Fichiers

Nouveaux :

| Fichier | Rôle |
|---|---|
| `api/src/subscriptions/payments/payment-concordance.ts` | Concordance stricte partagée |
| `api/src/subscriptions/payments/reconciliation/payment-reconciliation.service.ts` | Inspection, plan, application |
| `api/src/subscriptions/payments/reconciliation/payment-reconciliation-cli.ts` | Arguments, codes de sortie |
| `api/src/subscriptions/payments/reconciliation/subscription-payment-reconciliation.schema.ts` | Audit |
| `api/src/subscriptions/payments/reconciliation/subscription-payment-reconciliation-indexes.ts` | Index d'audit |
| `api/src/subscriptions/payments/reconciliation/payment-reconciliation-cli.spec.ts` | 42 tests unitaires |
| `api/src/migrations/reconcile-subscription-payment.ts` | Point d'entrée du CLI (validation, protection de démarrage, chargement différé) |
| `api/src/migrations/create-subscription-payment-reconciliation-indexes.ts` | Migration des index d'audit |
| `api/test/payment-reconciliation.e2e-spec.ts` | 25 tests e2e |
| `api/test/payment-reconciliation-cli-process.e2e-spec.ts` | 14 tests du binaire réel (profileur, photographies, `.env`, mutation) |
| `docs/architecture/phase-1-14d2g-payment-reconciliation-cli.md` | Ce document |

Modifiés :

| Fichier | Nature |
|---|---|
| `api/src/subscriptions/payments/subscription-payments.service.ts` | Concordance déléguée ; `grantAndMarkSucceededInSession` extraite (même comportement) ; type `PaymentRecord` exporté |
| `api/src/subscriptions/payments/subscription-payment-indexes.ts` | `IndexDescription`, `sameValue`, `describeOne` exportés |
| `api/src/subscriptions/subscriptions.module.ts` | Modèle d'audit, `PaymentReconciliationService` (aucun contrôleur) |
| `api/package.json` | Scripts `subscription:reconcile-payment` et `migrate:subscription-payment-reconciliation-indexes` |

Inchangés : les routes, les contrôleurs, le webhook, l'adaptateur,
`PaymentProvider`, les migrations existantes, le lockfile, le frontend,
Docker, nginx, la configuration Railway et les `.env` (non consultés manuellement ; voir l'incident pour le chargement automatique de `api/.env`).
