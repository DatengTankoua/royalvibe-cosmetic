# Phase 1-14D.1 — Audit des paiements et du renouvellement

Branche : `architecture/phase-1-14d1-payment-provider-audit`
Base : `6c7ddff` (phase 1-14C.2). Arbre propre au départ ; stash
`stash@{0}` (sauvegarde lint-staged) préservé, non touché.

**Audit documentaire uniquement.** Aucun code applicatif modifié, aucun
package, test, build, appel authentifié à un prestataire, paiement ou accès
à une base de données. Vérifications web effectuées le **2026-10-01**.

---

## 1. Synthèse

- Le socle 1-14B/C est réutilisable presque tel quel : registre append-only,
  idempotence `{ source, sourceReference }`, règle
  `début = max(heure serveur, fin de couverture)`, guard commercial à refus
  par défaut, échange du jeton limité, levée explicite du blocage de
  l'outbox.
- **Le service d'attribution n'accepte pas une transaction externe.**
  `grantSubscription` ouvre sa propre session, fige `source: manual` et ne
  peut donc pas marquer un paiement dans la même transaction. Il faut une
  refactorisation ciblée (§ 3.2).
- **Aucun prix n'existe côté serveur** : seuls `TERM_MONTHS` y figurent ;
  les montants sont dans `web/src/lib/subscription-offers.ts`.
- **Recommandation (à valider)** : CamPay comme premier prestataire, derrière
  un port `PaymentProvider` avec un adaptateur simulé pour les tests. La
  confirmation repose toujours sur une **lecture serveur du statut** auprès
  du prestataire ; la notification n'est qu'un déclencheur. Le choix dépend
  de votre statut marchand (§ 4.5).
- Aucun des deux prestataires ne documente de prélèvement récurrent Mobile
  Money : le modèle est un **paiement ponctuel renouvelable**.

---

## 2. Constats vérifiés dans le code

### 2.1 Registre `subscription_periods`

[subscription-period.schema.ts](../../api/src/subscriptions/schemas/subscription-period.schema.ts),
[subscription-period-indexes.ts](../../api/src/subscriptions/subscription-period-indexes.ts),
[subscription-terms.ts](../../api/src/subscriptions/subscription-terms.ts)

- Une attribution = un document ; aucune mise à jour ni suppression.
- `autoIndex: false` ; trois index **uniques** créés par migration et
  vérifiés au démarrage en production :
  1. `{ source, sourceReference }` — idempotence ;
  2. `{ organizationId, sequence }` — chaîne linéaire, sérialise les
     attributions concurrentes ;
  3. `{ organizationId }` partiel `kind: trial` — un seul essai.
- `SubscriptionSource` = `trial | manual`. Le validateur impose
  `kind === trial ⇔ source === trial` : une source `payment` de nature
  `subscription` est compatible **sans nouvel index**.
- `SUBSCRIPTION_REFERENCE_MAX_LENGTH = 200` : suffisant pour
  `payment:<ObjectId>`.
- `grantedBy` est interne, jamais exposé ; `payment:<provider>` y convient.

### 2.2 Service d'attribution — contrat réel

[subscriptions.service.ts](../../api/src/subscriptions/subscriptions.service.ts)

| Élément | Constat | Conséquence |
|---|---|---|
| `grantSubscription(input)` | Ouvre **sa propre** session + `withTransaction` (l. 175-181) | Impossible d'y inclure le marquage du paiement |
| `applyGrant` | Privé ; recherche et crée **en dur** `source: MANUAL` (l. 286, 331) | Une attribution par paiement serait confondue avec une attribution manuelle |
| Reprises | Boucle de 5 tentatives sur E11000 des index 1 et 2 | Mécanisme à conserver, mais autour de la transaction **complète** (paiement + période) |
| Rejeu | `assertSameRequest` compare organisation + durée | Réutilisable pour vérifier qu'un paiement rejoué correspond à la même période |
| Heure | `this.clock()` lu **dans** la transaction | Le début vaut l'heure de confirmation serveur, pas l'heure du paiement chez l'opérateur (cohérent avec la règle) |
| Essai | `grantTrial` accepte déjà une session externe | Modèle à suivre |

`getStateWithHistory` projette uniquement nature, durée, début et fin ;
l'historique des **périodes** n'expose ni source ni référence. Il doit rester
distinct de l'historique des **paiements**.

### 2.3 Guard commercial et jeton limité

[subscription-access.guard.ts](../../api/src/auth/guards/subscription-access.guard.ts),
[subscription-access.ts](../../api/src/subscriptions/subscription-access.ts),
[auth.module.ts](../../api/src/auth/auth.module.ts#L83-L87)

- Ordre global : `JwtAuthGuard → OrganizationGuard → SubscriptionAccessGuard
  → PermissionGuard → RolesGuard`.
- Refus par défaut ; exceptions : `@Public()`, `identity` (JWT `app` ou
  `subscription_limited`), `sale-replay` (`POST /sales`).
- Le jeton `subscription_limited` dure 15 min et n'ouvre jamais de route
  métier. Seul `POST /auth/subscription-access/complete` (corps vide strict)
  le convertit en JWT applicatif, après relecture de l'abonnement.
- La matrice des routes
  ([subscription-access-routes.spec.ts](../../api/src/subscriptions/subscription-access-routes.spec.ts))
  est calculée depuis les métadonnées : `identity` + `@OwnerOnly` = catégorie
  `owner-renewal`, aujourd'hui limitée à `GET /organizations/current/subscription`
  (`billing.identity`). Toute nouvelle route de paiement **fera échouer ce
  test** tant qu'il n'est pas mis à jour volontairement. C'est le
  comportement souhaité.

### 2.4 Interface web

- [subscription-offers.ts](../../web/src/lib/subscription-offers.ts) :
  une offre, quatre durées — 3 000 / 8 500 / 16 000 / 30 000 XAF. Le commentaire
  précise déjà que ces montants ne servent jamais à attribuer depuis le navigateur.
- [access/page.tsx](../../web/src/app/access/page.tsx#L119-L163) : « Vérifier »
  relit `/auth/context`, puis appelle l'échange `complete` uniquement si l'état
  est `active`, et redirige vers `/app`.
- [app/layout.tsx](../../web/src/app/app/layout.tsx#L493-L506) : avec un JWT
  applicatif et `canRecordSales`, `clearSubscriptionBlock` lève **uniquement**
  le blocage `subscription` de l'outbox, puis relance la synchronisation.
  Les blocages de permissions ou de corruption ne sont jamais levés par ce chemin.
- [offline-sales-sync.ts](../../web/src/lib/offline-sales-sync.ts#L293-L304) :
  un blocage commercial n'est jamais levé par un changement de jeton.

**La reprise après activation existe déjà.** Le paiement doit seulement
rendre l'abonnement `active` côté serveur ; le parcours existant fait le reste.

### 2.5 Configuration, limitation de débit, entrées

- `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` global :
  adapté à `POST …/payments { term }`. En revanche, un webhook dont le format
  est imposé par le prestataire ne doit pas passer par un DTO strict qui
  rejetterait ses champs inconnus : il faut un handler qui lit le corps brut
  et le valide lui-même.
- `ThrottlerModule.forRoot` unique, stockage **en mémoire** (par instance),
  `setHeaders: false` ; gardes par route (`AuthThrottlerGuard` par IP,
  invitation par utilisateur + organisation). Une fenêtre `payment-create`
  et une fenêtre `payment-webhook` devront être fusionnées dans ce même
  `forRoot`.
- **Observation hors périmètre, à corriger avant la mise en production
  du webhook** : le bloc `api` de [nginx.conf](../../nginx/nginx.conf#L50-L56)
  ne transmet ni `X-Forwarded-For` ni `X-Real-IP`, et
  `TRUST_PROXY_HOPS` vaut `0` par défaut dans `docker-compose.prod.yml`.
  En production Docker, `req.ip` vaut donc l'adresse du conteneur nginx :
  tous les clients partagent un même compteur IP.
- Aucun planificateur (cron) dans l'API ; les tâches opérateur passent par
  des scripts `dist/migrations/*.js` (`subscription:grant`).
- Production : `PUBLIC_APP_URL`, `WEB_URL` et `RESEND_API_KEY` existent. Aucune
  variable de paiement. Les secrets du prestataire devront être ajoutés
  sans valeur par défaut. Je n'ai lu aucune valeur `.env`.

---

## 3. Réutilisation et changements minimaux

### 3.1 Réutilisable tel quel

`computeRenewalStartsAt`, `computeSubscriptionEndsAt`, `computeSubscriptionState`,
les trois index, `SubscriptionPeriodIndexCheck`, `SUBSCRIPTION_CLOCK`,
`SubscriptionAccessGuard`, `OwnerOnly`, l'échange `complete`, la levée du
blocage de l'outbox, le catalogue d'affichage web et `formatFcfa`.

### 3.2 Changements minimaux nécessaires

1. `SubscriptionSource.PAYMENT = 'payment'`.
2. Extraire de `applyGrant` une méthode qui reçoit **la session de
   l'appelant et la source** :
   `applyGrantInSession({ organizationId, term, source, sourceReference, grantedBy }, session)`.
   `grantSubscription` (CLI) l'appelle avec `MANUAL` : comportement
   inchangé. La recherche d'idempotence filtre sur la source reçue.
3. Factoriser la boucle de reprises (E11000 `source_1_sourceReference_1` /
   `organizationId_1_sequence_1`) pour l'appliquer à la transaction de
   finalisation du paiement.
4. Le catalogue tarifaire serveur (§ 5.1).

Aucune modification de `computeSubscriptionState`, du guard ou de l'outbox.

---

## 4. Comparaison des prestataires

> Vérifié le 2026-10-01. « Non confirmé » = absent des sources officielles
> consultées.

### 4.1 Disponibilité des sources

- **CamPay** : documentation API officielle publiée sur Postman ; site
  officiel ; CGU (PDF) ; SDK Python officiel. Tout est accessible.
- **CinetPay** : le domaine de documentation historique
  `docs.cinetpay.com` **ne se résout pas** le 2026-10-01 (NXDOMAIN, vérifié
  par `nslookup` et `curl`). `cinetpay.com/pricing` et `/products/payments`
  renvoient HTTP 403 à un client automatisé. Les SDK **officiels** sur GitHub
  (`cinetpay/cinetpay-js`, `cinetpay/cinetpay-go`,
  `cinetpay/seamlessIntegration`) décrivent une **nouvelle API**
  (`api.cinetpay.co`, sandbox `api.cinetpay.net`, clé + mot de passe → JWT).
  Les extraits de l'ancienne API v2 (`api-checkout.cinetpay.com`, HMAC
  `x-token`) proviennent seulement des résultats de recherche.
  **CinetPay semble en cours de migration de plateforme.** Il faut
  confirmer directement auprès d'eux quelle API ouvrir pour un nouveau compte.

### 4.2 Tableau comparatif

| Critère | CamPay | CinetPay |
|---|---|---|
| Cameroun, XAF | Oui ; spécialisé Cameroun ; devise XAF | Oui ; `CM` et `XAF` dans les SDK officiels (`OM_CM`, `MTN_CM`) |
| Moyens de paiement | MTN MoMo et Orange Money ; le SDK mentionne `payment_options: MOMO,CARD` pour les liens (carte : non confirmé au Cameroun) | MTN, Orange ; cartes et Express Union selon des sources tierces : **non confirmé officiellement** |
| Ouverture : particulier / entrepreneur / société | **Non confirmé** : la CGU liste les activités interdites, pas les justificatifs ; inscription en ligne puis « once verified » | KYC requis selon des sources tierces ; liste officielle de justificatifs **non confirmée** |
| Frais documentés | Site officiel : collecte 2 %, retrait vers Mobile Money 1 %, virement bancaire 5 000 XAF forfait ; « by the next business day » | Page tarifs inaccessible (403) ; 2 % MTN / 2,2 % Orange selon une source tierce : **non confirmé** |
| Minimums / plafonds | Montant entier, décimales refusées (ER201) ; minimum non documenté | Nouvelle API : montant entier 100 à 2 500 000 (validation du SDK officiel) ; ancienne API : multiple de 5 (source secondaire) |
| Test sans paiement réel | Environnement `demo.campay.net` ; la collecte déclenche une **vraie** invite de code PIN sur le téléphone. Des sources non officielles évoquent un débit réel de 25 à 100 XAF : **non confirmé**, donc à traiter comme un paiement réel | Sandbox `api.cinetpay.net` (`sk_test_`) avec numéros de test simulés (succès, attente, échec). Ces numéros sont **documentés pour la Côte d'Ivoire seulement** ; Cameroun : non confirmé |
| Création | `POST /api/collect/` (invite USSD sur le téléphone du payeur) ou `POST /api/get_payment_link/` (page hébergée) | Initialisation → `paymentUrl` + jeton ; canaux `PUSH`, `OTP`, `QRCODE` |
| Idempotence de création | **Documentée** : « supports Idempotency on external_reference » | Code `TRANSACTION_EXIST` (1200) sur un `merchantTransactionId` déjà utilisé (1 à 30 caractères) |
| Statut | `GET /api/transaction/{reference}/` → `PENDING`, `SUCCESSFUL` ou `FAILED`, avec montant, devise, opérateur | `getStatus(paymentToken)` → `SUCCESS` 100 ; `FAILED` 2010 ; `INSUFFICIENT_BALANCE` 2005 ; `INITIATED` 2001, `PENDING` 2002, `EXPIRED` 2003 |
| Notification serveur | URL de rappel appelée sur `SUCCESSFUL` ou `FAILED`, en GET ou POST configurable | POST sur `notifyUrl` au statut final |
| Authentification de la notification | Champ `signature` = **JWT HS256 signé avec la clé webhook de l'application** | Nouvelle API : comparaison à temps constant d'un `notifyToken` **stocké par transaction**. Ancienne API : HMAC-SHA256 `x-token` sur une concaténation de champs. Dans les deux cas, le SDK impose ensuite une **revérification du statut** |
| Répétition des notifications | Non confirmé | Non confirmé ; le SDK recommande un cache de rejeu par transaction |
| Expiration | Non documentée | Statut `EXPIRED` (2003) ; durée non documentée ; le SDK le classe curieusement comme **non final** |
| Annulation / remboursement | Aucun endpoint de remboursement ; `withdraw` vers un numéro, activable dans les réglages, utilisable comme remboursement manuel (non confirmé comme procédure) | Remboursement non documenté ; transferts disponibles |
| Récurrence | Non documentée → paiement ponctuel | Non documentée → paiement ponctuel |
| Effort d'intégration | Faible : jeton d'API, 3 endpoints utiles, JWT standard | Moyen : migration de plateforme, identifiants par pays, JWT 23 h, deux générations d'API |

### 4.3 Intégration directe MTN / Orange

L'API MoMo de MTN propose un sandbox simulé, mais la mise en production
exige un KYC propre au pays, un contrat et la création d'un portefeuille
marchand. Orange Money exige un compte marchand séparé ; des sources
secondaires citent RCCM, NIU, statuts, RIB, etc. Il faudrait **deux
intégrations, deux contrats et deux réconciliations**. Ce n'est pas
pertinent à ce stade ; à reconsidérer seulement si le volume justifie
d'économiser l'intermédiaire.

### 4.4 Recommandation (non validée)

**CamPay en premier**, derrière un port `PaymentProvider` :

- spécialisé Cameroun, MTN et Orange, XAF ;
- frais publiés officiellement : 2 % ;
- idempotence documentée sur `external_reference` ;
- notification signée en JWT HS256, simple à vérifier correctement ;
- endpoint de statut simple : base de la confirmation serveur et de la
  récupération ;
- documentation stable et accessible, alors que celle de CinetPay est en
  migration (domaine hors service le jour de l'audit).

Réserves : sandbox non simulé (invite réelle), politique de répétition des
rappels et expiration non documentées. **Atténuation** : tous les tests
automatisés utilisent l'adaptateur simulé ; la confirmation ne dépend
jamais du rappel (lecture du statut + récupération).

**CinetPay en alternative** si : CamPay refuse votre statut, la carte bancaire
devient nécessaire, ou un sandbox simulé est exigé pour la recette. Le port
rend ce changement local à l'adaptateur.

### 4.5 Information manquante sur votre statut marchand

Ces réponses peuvent changer la recommandation :

1. Sous quelle forme encaisserez-vous : **particulier**, **entrepreneur
   individuel** (RCCM, NIU), ou **société** (statuts, RCCM, NIU, représentant légal) ?
2. Disposez-vous d'un **compte bancaire professionnel** ou seulement de
   portefeuilles Mobile Money ? Cela conditionne le reversement : 1 % vers
   Mobile Money ou 5 000 XAF par virement chez CamPay.
3. Avez-vous besoin d'une **facture conforme** (NIU, mentions légales, TVA
   éventuelle) ou un **reçu** suffit-il au démarrage ?

À demander par écrit à CamPay (et à CinetPay en parallèle) : justificatifs
exacts selon le statut, délai de validation, politique de répétition des
rappels, durée d'expiration d'une collecte, procédure de remboursement,
existence d'un mode démo **sans débit**.

---

## 5. Architecture proposée (sans implémentation)

### 5.1 Catalogue tarifaire serveur

`api/src/subscriptions/subscription-pricing.ts` (pur) :
`{ version: 1, currency: 'XAF', prices: { monthly: 3000, quarterly: 8500, semiannual: 16000, annual: 30000 } }`,
gelé, et testé contre `TERM_MONTHS`. **Autorité unique** : le montant d'un
paiement est lu ici, jamais dans la requête.

Cohérence avec la page publique : soit `GET /subscription/offers` public
(lecture seule, même source), soit un test de parité qui compare
`web/src/lib/subscription-offers.ts` au catalogue serveur. **Décision D4.**

### 5.2 Modèle `subscription_payments`

Document **mutable sous contraintes** (machine d'états monotone), distinct
du registre append-only des périodes.

| Champ | Rôle |
|---|---|
| `_id` | Identifiant interne |
| `organizationId` | **Contexte serveur** (`OrganizationGuard`) |
| `requestedBy` | `userId` du propriétaire, issu du JWT |
| `term`, `amount`, `currency: 'XAF'`, `pricingVersion` | Figés à la création depuis le catalogue serveur |
| `provider` | `campay` / `simulated` |
| `merchantReference` | Référence unique transmise au prestataire (`external_reference`), dérivée de `_id` |
| `providerReference` | Référence renvoyée par le prestataire |
| `status` | `created → pending → succeeded` ; `failed` ; `expired` ; `requires_review` |
| `open` | `true` tant que le paiement n'est pas final (index partiel) |
| `payerMsisdnMasked` | 4 derniers chiffres seulement (minimisation des données) |
| `grantedPeriodId` | Période attribuée, posée dans la même transaction que `succeeded` |
| `createdAt`, `expiresAt`, `confirmedAt`, `lastCheckedAt`, `checkCount`, `failureCode` | Suivi |

Index (migration dédiée + vérification fail-fast, même contrat que 1-14B) :

- unique `{ merchantReference }` ;
- unique partiel `{ provider, providerReference }` lorsque `providerReference` est une chaîne ;
- unique partiel `{ organizationId }` lorsque `open: true` : **un seul paiement
  ouvert par organisation**, ce qui évite les double-clics et la double
  facturation involontaire ;
- `{ organizationId, createdAt: -1 }` pour l'historique.

Dans le registre : `source: 'payment'`, `sourceReference: 'payment:<_id>'`.
L'index unique existant `{ source, sourceReference }` garantit **au plus une
période par paiement**, quel que soit le nombre de notifications.

### 5.3 Routes

Toutes owner-only, organisation issue du contexte, `Cache-Control: no-store`,
accessibles avec un jeton `subscription_limited` grâce à
`@AllowInactiveSubscription('identity')` + `@OwnerOnly('billing.pay')`
(nouvelle opération owner-only, jamais délégable ; **décision D5** :
nouvelle opération ou réutilisation de `billing.identity`).

| Route | Corps accepté | Effet |
|---|---|---|
| `POST /organizations/current/subscription/payments` | `{ term, payerPhone }` uniquement (`forbidNonWhitelisted`) | Crée le paiement depuis le catalogue, appelle le prestataire **hors transaction** ; renvoie `{ paymentId, status, amount, currency, term, expiresAt }` |
| `GET /organizations/current/subscription/payments/:id` | — | Statut **local** ; filtre `{ _id, organizationId }` (404 uniforme sinon) |
| `POST /organizations/current/subscription/payments/:id/refresh` | vide | Récupération à la demande : lecture du statut chez le prestataire, puis finalisation éventuelle. Limitée en débit |
| `GET /organizations/current/subscription/payments` | — | Historique des paiements, projection explicite |
| `POST /payments/webhooks/campay` | Brut, format du prestataire | `@Public()`, limité en débit par IP, corps petit, aucune donnée de session |

Les tests de matrice des routes passeront à 3 ou 4 routes
`owner-renewal` et à une route publique supplémentaire, avec une mise à jour
explicite.

Le vendeur et l'administrateur reçoivent un 403 via `PermissionGuard`.
L'organisation n'est jamais lue dans le corps : un `organizationId` forgé
est rejeté par la whitelist.

### 5.4 Confirmation : le statut serveur fait foi

```
notification ─┐
refresh ──────┼─► verifyAndFinalize(paymentId)
réconciliation┘        │
                       ├─ 1. lire le paiement local (hors transaction)
                       ├─ 2. GET statut chez le prestataire (réseau, HORS transaction)
                       ├─ 3. comparer : référence marchand, montant exact,
                       │     devise XAF, identifiant prestataire cohérent
                       │     ─ écart ⇒ requires_review, AUCUNE attribution
                       ├─ 4. SUCCESSFUL ⇒ transaction Mongo (sans réseau) :
                       │       a. CAS paiement {_id, status ∈ ouverts|failed|expired}
                       │          → succeeded, open:false, confirmedAt
                       │       b. applyGrantInSession(source payment,
                       │          ref payment:<id>, term du paiement)
                       │       c. grantedPeriodId
                       │     reprises bornées sur E11000 / conflit d'écriture
                       └─ 5. FAILED ⇒ failed (si non déjà succeeded)
```

- **Notification** : authentification selon le contrat du prestataire
  (CamPay : JWT HS256, algorithme imposé, `none` refusé, clé webhook en
  secret). Elle sert seulement à identifier `external_reference` et à
  déclencher l'étape 2. Son montant et son statut ne sont **jamais**
  utilisés tels quels. Une notification forgée mais bien signée ne peut
  donc rien activer sans un statut serveur concordant.
- Réponse au webhook : 2xx pour une référence connue et traitée, y compris
  un rejeu ; 401 pour une signature invalide ; 2xx sans effet pour une
  référence inconnue (aucune énumération). Le traitement est court ; en cas
  d'échec de lecture du statut, on répond 5xx pour provoquer une
  éventuelle nouvelle tentative (non confirmée) ; la réconciliation prendra
  le relais.

### 5.5 Double attribution, concurrence et retards

| Situation | Protection |
|---|---|
| Notifications répétées | Paiement déjà `succeeded` ⇒ no-op ; l'index `{source, sourceReference}` interdit une deuxième période |
| Deux notifications simultanées | Conflit d'écriture sur le même document de paiement dans la transaction ⇒ l'une recommence, relit `succeeded`, no-op |
| Notification + refresh + réconciliation | Même fonction `verifyAndFinalize`, mêmes garanties |
| Paiement concurrent d'une autre organisation | `{ organizationId, sequence }` sérialise chaque chaîne ; aucun lien entre organisations |
| Attribution manuelle CLI concurrente | Même index de séquence ; chaque attribution démarre à `max(now, couverture)` ; aucun temps perdu |
| **Échec tardif après succès** | `succeeded` est **terminal** : un `FAILED` ultérieur est journalisé (`requires_review` en annotation), sans retrait de période ni modification du registre |
| **Succès tardif après expiration locale** | `expired` et `failed` locaux peuvent passer à `succeeded` si le prestataire confirme : l'argent a été débité. La période commence à la confirmation |
| Montant ou devise discordant | `requires_review`, aucune attribution, traitement opérateur |

### 5.6 Récupération d'une notification perdue

1. **Refresh propriétaire** depuis l'interface : bouton « J'ai payé,
   vérifier ». Il est aussi déclenché automatiquement par sondage léger de
   **notre** API pendant l'écran d'attente.
2. **Réconciliation opérateur** : script `payments:reconcile`, sur le modèle
   de `subscription:grant`, qui parcourt les paiements `open`, ou
   `expired`/`failed` récents, plus vieux que N minutes, par lots bornés.
   Un passage automatique en processus pourra suivre ; il n'existe aucun
   cron aujourd'hui (**décision D6**).

### 5.7 Session expirée et reprise

L'activation est indépendante de toute session. Si le jeton limité de
15 min expire pendant la validation Mobile Money :

- le paiement aboutit quand même (notification, refresh ou réconciliation) ;
- à la reconnexion, le login trouve l'abonnement `active` et délivre
  directement un JWT applicatif (`loginForContext`) ;
- le layout lève le blocage `subscription` de l'outbox ; les ventes en
  attente sont rejouées et restent soumises à tous les refus métier
  (stock, permissions, idempotence `clientOperationId`).

### 5.8 Périodes, paiements, reçus, factures

| Objet | Source | Règle |
|---|---|---|
| Historique des périodes | `subscription_periods` (inchangé) | Droit d'accès ; aucune donnée de paiement |
| Historique des paiements | `subscription_payments` | Affiche « En attente », « Échoué », « Expiré », « Payé ». Un paiement non `succeeded` n'est **jamais** présenté comme payé |
| Reçu | Dérivé d'un paiement `succeeded` uniquement | Montant, durée, date de confirmation, référence prestataire ; numéro séquentiel |
| Facture | **Hors 1-14D.2** | Exige des mentions légales (§ 4.5, question 3) ; jamais générée « acquittée » sans paiement `succeeded` |

---

## 6. Découpage proposé

### Lot 1-14D.2 — API (premier lot)

1. `subscription-pricing.ts` + tests.
2. `SubscriptionSource.PAYMENT`, `applyGrantInSession`, factorisation des
   reprises ; tests de non-régression du CLI.
3. Schéma, index, migration et vérification de `subscription_payments`.
4. Port `PaymentProvider` (`initiate`, `fetchStatus`, `verifyNotification`) ;
   adaptateur **simulé** (scénarios : succès, attente, échec, montant
   discordant, statut indisponible) ; adaptateur CamPay **désactivé par
   défaut** et configuré seulement si les secrets sont présents.
5. `verifyAndFinalize`, routes § 5.3, webhook, fenêtres de limitation de
   débit, script `payments:reconcile`.
6. Matrice des routes mise à jour.

### Lot 1-14D.3 — Interface propriétaire

Choix de la durée (catalogue serveur), saisie du numéro, écran d'attente
avec sondage de notre API, succès → enchaînement « Vérifier » → `complete` →
`/app`. Historique des paiements dans l'espace Abonnement. Disponible sur
`/access` (jeton limité) et dans l'application.

### Lot 1-14D.4 — Documents et notifications

Reçus, email de confirmation (Resend), outillage `requires_review`,
facture si D3 est tranchée.

### Tests futurs (base éphémère, prestataire simulé, aucun réseau)

- montant, devise, `organizationId` ou `term` forgés dans le corps → 400, aucun paiement ;
- vendeur et administrateur → 403 sur toutes les routes de paiement ; un propriétaire d'une autre organisation → 404 ;
- statut `PENDING` ou `FAILED` → aucune période, accès toujours refusé ;
- notification à signature invalide, algorithme `none` ou clé erronée → 401, aucun effet ;
- notification valide mais statut serveur discordant (montant, devise, référence) → `requires_review`, aucune période ;
- dix notifications identiques en parallèle → une seule période, `replayed` cohérent ;
- notification + refresh + réconciliation concurrents → une seule période ;
- notification perdue → refresh ou `payments:reconcile` → période attribuée une fois ;
- `FAILED` après `succeeded` → période conservée ;
- succès après expiration locale → période attribuée, début = `max(now, couverture)` ;
- paiement confirmé pendant l'essai ou un abonnement actif → aucun temps perdu ;
- paiement confirmé après expiration du jeton limité → login direct en JWT applicatif ;
- reprise commerciale : outbox bloquée `subscription` → levée après activation, ventes rejouées une fois, aucune perte ; blocages `access_denied` et `corruption` intacts ;
- après paiement : ventes refusées pour stock insuffisant ou permission retirée → toujours refusées ;
- organisation suspendue administrativement + paiement réussi → accès toujours refusé (`Organization.status` reste prioritaire) ;
- un second paiement ouvert pour la même organisation → refus (index `open`) ;
- l'historique des périodes n'expose toujours ni source ni référence.

---

## 7. Décisions encore nécessaires

| # | Décision | Recommandation |
|---|---|---|
| D1 | Prestataire | CamPay, sous réserve de D2 |
| D2 | Statut marchand (particulier / entrepreneur / société) et justificatifs | À fournir (§ 4.5) |
| D3 | Reçu seul ou facture conforme | Reçu au départ |
| D4 | Exposition du catalogue au web | `GET /subscription/offers` public ou test de parité |
| D5 | Opération owner-only `billing.pay` dédiée | Oui, distincte de `billing.identity` |
| D6 | Réconciliation : script seul ou tâche en processus | Script d'abord |
| D7 | Collecte USSD (`collect`, numéro requis) ou lien hébergé | `collect` : parcours court, aucune redirection |
| D8 | Frais de 2 % absorbés ou répercutés | Absorbés : prix publics inchangés |
| D9 | Durée d'expiration locale d'un paiement ouvert | 15 min, alignée sur le jeton limité ; succès tardif toujours accepté |
| D10 | Politique de remboursement | Manuelle (opérateur), hors API |
| D11 | Correctif nginx `X-Forwarded-For` + `TRUST_PROXY_HOPS=1` | À traiter avant d'exposer le webhook |

---

## 8. Sources (consultées le 2026-10-01)

CamPay
- Documentation API (Postman) : https://documenter.getpostman.com/view/2391374/T1LV8PVA
- Site, tarifs : https://www.campay.net/en/
- CGU : https://campay.net/static/docs/CamPay_Terms_and_Conditions.pdf
- SDK Python officiel : https://github.com/CamPay/campay-python-sdk
- Guide de démarrage (blog officiel) : https://blog.campay.net/getting-started-with-campay-api-a-step%E2%80%90by%E2%80%90step-guide/

CinetPay
- SDK JS officiel (nouvelle API) : https://github.com/cinetpay/cinetpay-js
- SDK Go officiel : https://github.com/cinetpay/cinetpay-go
- Intégration seamless officielle : https://github.com/cinetpay/seamlessIntegration
- Ancienne documentation, **injoignable (NXDOMAIN)** : https://docs.cinetpay.com/api/1.0-fr/checkout/initialisation,
  https://docs.cinetpay.com/api/1.0-fr/checkout/notification,
  https://docs.cinetpay.com/api/1.0-en/checkout/hmac,
  https://docs.cinetpay.com/api/1.0-en/checkout/verification
- Tarifs, **HTTP 403** : https://cinetpay.com/pricing

MTN MoMo (alternative directe)
- https://momodevelopercommunity.mtn.com/momo-api-production-q-a-7/what-are-the-requirements-for-going-live-238

Les sources tierces (blogs, comparatifs) n'ont servi qu'à repérer des pistes ;
toute information qui n'en provient que de là est marquée « non confirmé ».

---

## 9. Fin d'audit

Arrêt avant toute intégration. Aucun commit ni push.
