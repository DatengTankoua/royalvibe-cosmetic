# Lot 1-21A — Étude de migration CamPay → SasPay

État : **étude seulement**. Aucun code applicatif modifié, aucun commit,
push, déploiement, paiement, appel transactionnel ni compte fournisseur.
Branche `perf/phase-1-20f-products-pagination` (1-20F commité, `c9e9792`),
arbre propre, `stash@{0}` conservé.

## 0. Constat préalable : CamPay n'a jamais été actif en production

Le code et l'historique Git montrent qu'aucun paiement CamPay n'a pu être
créé en production :

- `SubscriptionsModule` injecte `UnavailablePaymentProvider` comme
  `PAYMENT_PROVIDER` depuis `b3a4f10` (1-14D.2B). Ce fournisseur renvoie 503
  **avant toute écriture** (`createPayment`, étape 2).
- Le webhook CamPay est désactivé (`DISABLED_CAMPAY_WEBHOOK`). Aucune
  variable d'environnement ne l'active.
- `CamPayPaymentProvider` n'est instancié que par la recette locale
  (`api/test/recipe/boot-api.js`) et par les tests, contre un faux CamPay.
- Les rapports 1-14D.2D, 1-14D.2F et 1-14D.2G le disent explicitement.

Il n'y a donc normalement **ni historique ni paiement CamPay en attente**.
La transition (§ 5) reste écrite comme si c'était le cas : la collection
`subscription_payments` doit être vérifiée en production (lecture seule)
avant l'activation.

## 1. Identification de SasPay

Consultation du **2026-10-11**. Services voisins à ne pas confondre :
**SasaPay** (portefeuille au Kenya, Viewtech Ltd) et **SAASPAY** (outil de
facturation). Le service retenu est **SasPay** :

| Élément | Constat | Source |
|---|---|---|
| Site, tableau de bord, documentation | `saspay.me`, `app.saspay.me`, `docs.saspay.me` ; API `https://api.saspay.me/api/v1` | doc, site |
| Exploitant | **Payix LLC** : LLC du Nouveau-Mexique (USA), RCCM Bénin `RB/ABY/25 A 33151`, siège Bohicon (Bénin) ; contact des mentions légales : une adresse Gmail personnelle | mentions légales (14 août 2026) |
| Nature déclarée | « SasPay n'est pas un établissement de paiement » ; les fonds seraient encaissés et conservés par des « prestataires de paiement officiels et agréés ». Pourtant, la documentation se présente comme « agrégateur » et expose soldes, portefeuille, retraits et transferts | mentions légales, CGU (10 oct. 2026), doc |
| Cameroun | `CM`, devise **XAF**, réseaux `mtn_cm` (MTN MoMo) et `orange_cm` (Orange Money), `eu_mobile_cm` inactif. Catalogue public `GET /countries/` : `CM`, XAF, `is_active: true` | page Formats ; `/countries/` (public, sans clé, lecture seule) |
| Montants | chaînes décimales (`"3000.00"`), devise ISO à 3 lettres ; aucun flottant | OpenAPI, AGENTS.md |
| Frais affichés (Cameroun) | « Dès 1,75 % », sur des transactions de 200 à 9 999 999 FCFA ; aucun abonnement. Tarif réel par réseau : `GET /pricing/my-rates/` (authentifié) | site, doc |
| Qui paie les frais | `fee_charge_mode` `ADD_ON` (client) ou `DEDUCTED` (marchand). La valeur envoyée par l'API est **ignorée silencieusement** sauf option `ALLOW_CLIENT_OVERRIDE` du compte | doc checkout |
| Compte et KYC | email vérifié, marchand créé `kyc_status: NONE`, `is_active: false` ; dossier KYC (exemple documenté : `BUSINESS`, RCCM, IFU), validation manuelle par SasPay, **puis** création de clés | page Compte |
| Particulier | les CGU mentionnent un compte « particulier ou entreprise » (pièce d'identité, selfie). La documentation n'expose que l'exemple `BUSINESS` | CGU, page Compte |
| Environnements | clés `sk_test_` (`SANDBOX`, « sans argent réel ») et `sk_live_` (`LIVE`) ; portée `PAYIN` / `PAYOUT` / `BOTH`. Secret affiché une seule fois | page Compte |
| Retraits | `POST /payouts/initialize/` (IP en liste blanche), demandes de retrait et méthodes réservées au tableau de bord. Frais de retrait du Cameroun non publiés (visibles dans `my-rates`) ; « versements instantanés » est une promesse commerciale | doc, site |
| Gel des fonds | suspension et gel des fonds et retraits possibles pendant des vérifications | CGU |
| Limite de débit | 300 requêtes/min par compte | Introduction |

### Confirmé, absent ou à faire confirmer

| Sujet | État |
|---|---|
| Cameroun, XAF, MTN et Orange en encaissement | **confirmé** (documentation, catalogue public). Réseaux actifs réels : `GET /networks/` (authentifié) |
| API REST, authentification, statuts, webhooks signés | **confirmé** (OpenAPI 3.1 publiée, déclarée « source de vérité ») |
| Accès **production** pour un particulier | **à confirmer** : affirmé par les CGU, non démontré. Le KYC est validé à la main ; aucune activation n'est garantie |
| Clé de test **avant** KYC, comportement du bac à sable (succès, échec, numéros) | **absent** de la documentation |
| Frais réels au Cameroun, frais, délais et plafonds de retrait | **partiel** : « dès 1,75 % » ; le reste via le tableau de bord |
| Titulaire des fonds, contrat, statut réglementaire | **contradictoire**, à confirmer avant tout encaissement réel |
| Maturité du service | catalogue créé en août 2026, CGU du 10 octobre 2026 : service récent |

## 2. Intégration existante

| Élément | Implémentation actuelle | Dépend de CamPay ? |
|---|---|---|
| Tarif et durée | `subscription-pricing.ts` : XAF entiers (3 000 / 8 500 / 16 000 / 30 000), version figée au paiement | non |
| Création | `SubscriptionPaymentsService.createPayment` : rejeu par `clientOperationId` + empreinte, **un seul paiement ouvert** par organisation (index unique), réservation `initiating` **avant** l'appel réseau, un seul appel | non |
| Référence interne | `merchantReferenceFor` : `SM` + identifiant (26 caractères), immuable | non |
| Contrat prestataire | `PaymentProvider` : `initiate`, `fetchStatus`, `supportsMerchantReferenceLookup`, `idempotentInitiation`, erreurs `Unavailable` (non transmis) / `Uncertain` (peut-être créé) | non (interface générique) |
| Concordance | `paymentConcordanceMismatches` : référence marchand, référence prestataire, montant **entier** exact, devise ; sinon `review` | non, mais exige que le prestataire **renvoie notre référence** |
| Confirmation | `confirmPayment` : relit le statut chez le prestataire ; attribution + `succeeded` dans **une** transaction (`grantAndMarkSucceededInSession`, `periodId: null` conditionnel, `payment:<id>` unique) ; budget de 30 s ; jamais `failed` après un succès | non, sauf `payment.provider !== this.provider.name` → 503 |
| Webhook | `campay-webhook.*` : route `/payments/webhooks/campay`, signature propre à CamPay, désactivé ; la notification n'est qu'un **signal** (`locateProviderNotification` → `confirmPayment`) | **oui** (format, signature, route) |
| Rapprochement opérateur | `payment-reconciliation.service.ts` + CLI : même vérification, journal d'audit | non, sauf injection unique `PAYMENT_PROVIDER` |
| Adaptateur | `campay/campay-payment-provider.ts`, `campay-transport.ts` | **oui** |
| Interface web | `subscription-payment-panel.tsx` : numéro de téléphone, push USSD, bouton « Vérifier le paiement », signaux temps réel ; **aucune redirection** | partiellement (parcours USSD sans page hébergée) |
| Notifications | outbox push « paiement confirmé » dans la transaction d'attribution ; signaux 1-15F | non |
| Documents juridiques | `conditions-abonnement` mentionne « CamPay désactivé » ; aucun prestataire déclaré comme sous-traitant | à mettre à jour à l'activation |

**Réutilisable tel quel** : tarification, réservation, idempotence
client, index uniques, concordance, attribution atomique, notifications,
signaux, historique, rapprochement (une fois rendu multi-prestataire).
**Propre à CamPay** : l'adaptateur, le transport, le format et la
signature du webhook. **Structurel** : un seul `PAYMENT_PROVIDER` injecté,
qui empêche de traiter deux prestataires à la fois.

## 3. Contrat SasPay (sources officielles uniquement)

| Sujet | Documenté |
|---|---|
| Authentification | `Authorization: Bearer sk_test_…/sk_live_…`, backend uniquement |
| Enveloppe | `{ success, data, code }` / `{ success: false, error: { message, code }, code }` |
| Encaissement direct | `POST /payments/softpay/` : `amount`, `currency`, `country`, `customer{email, first_name, last_name, phone}`, `network`, `description`, `metadata`, `fee_charge_mode`, `otp`. Réponse : `id`, `status`, `checkout_url`. Si `checkout_url` est non vide (Orange Money notamment), **il faut rediriger** : aucun push. `Idempotency-Key` pris en charge |
| Checkout hébergé | `POST /checkout-sessions/` : `amount`, `currency`, `customer_email`, `customer_name`, `customer_phone`, `country`, `description`, `return_url`, `metadata`, `fee_charge_mode`, `expires_at`. Réponse : `id`, `slug`, `checkout_url`, `metadata`, `status`, `transaction`. **Pas** d'`Idempotency-Key` (une session ne débite rien tant qu'elle n'est pas payée) |
| Consultation | `GET /checkout-sessions/{id}/` (avec `metadata`) ; `GET /checkout-sessions/{id}/status/` (revérifie le gateway : `status`, `transaction_id`, `transaction_status`) ; `GET /checkout-sessions/?status=` (paginé) ; `GET /payments/{id}/verify/` (revérifie si `PENDING` : `requested_amount`, `debited_amount`, `net_amount`, `fee_charge_mode`, `currency`, `status`, `reference`, `external_reference`) ; `POST /checkout-sessions/{id}/cancel/` (si `PENDING`) |
| Références | SasPay : `id` (UUID) et `reference` (`TXN-…`) ; gateway : `external_reference`. Marchand : **aucun champ dédié** ; `metadata` libre, renvoyé par les sessions de checkout (pas documenté dans la réponse `verify`) |
| États | transaction : `PENDING`, `SUCCESS`, `FAILED` (`CANCELLED` jamais atteint) ; session : `PENDING`, `PAID`, `EXPIRED`, `CANCELLED` |
| Erreurs | 400, 401, 403, 404, 409 (idempotence, état terminal), 410 (session expirée), 422 (`invalid_method`, `no_route_available`…), 429 |
| Relance | `POST /payments/{id}/retry/` relance un paiement `FAILED` sur la même transaction, **à ne jamais appeler automatiquement** |
| Webhooks | événements `transaction.created/success/failed/cancelled`. En-têtes `X-Webhook-Signature` (HMAC-SHA256 hexadécimal de `"{timestamp}.{corps brut}"`), `X-Webhook-Timestamp` (tolérance de 5 min), `X-Webhook-Event`. Données : `id`, `reference`, `status`, `amount`, `fee`, `charged`, `net_amount`, `currency`, `country`, `network`, `msisdn`, **sans** `metadata` ni référence marchand. 5 tentatives (immédiat, 30 s, 5 min, 30 min, 2 h), 15 s par tentative, puis échec définitif (renvoi manuel). Aucun identifiant d'événement documenté. Création et secret depuis le tableau de bord seulement |
| Réponse perdue | softpay : rejouer la **même** `Idempotency-Key` et le même corps renvoie la réponse d'origine (durée de rétention non documentée). Checkout : retrouver la session par `GET /checkout-sessions/?status=PENDING` et sa `metadata` |

**Incohérences de la documentation, à traiter de façon défensive :**

- `/countries/` est documenté comme un tableau brut, mais répond avec
  l'enveloppe (constaté) ; les exemples `softpay`, `verify` et `checkout`
  sont montrés sans enveloppe.
- L'introduction cite `POST /payments/softpay/initialize/`, la
  spécification `POST /payments/softpay/`.
- L'exemple softpay conseille de sonder `GET /payments/{id}/`, qui
  n'existe pas (la route est `…/verify/`).

## 4. Intégration proposée (lot 1-21B)

### Choix : checkout hébergé plutôt que softpay

| Critère | Checkout hébergé | Softpay |
|---|---|---|
| Réponse perdue | sans débit possible (le client n'a pas l'URL) ; session retrouvable par `metadata` puis annulable | débit possible ; dépend de `Idempotency-Key`, de durée de rétention inconnue |
| Référence marchand renvoyée | **oui** (`metadata` de la session) | non documentée |
| Orange Money | page hébergée de toute façon | `checkout_url` à suivre aussi |
| Parcours | redirection (change la décision D7 de 1-14D.1) | numéro saisi chez nous, mais redirection selon l'opérateur |

Recommandation : **checkout hébergé** en `XAF`, `country: "CM"`, avec
`metadata: { merchantReference }`, `description` comportant la référence,
`return_url` vers `/app/…/subscription?payment=<id>` et `expires_at`
d'environ 30 min. Le retour navigateur ne prouve rien : il déclenche
seulement un `refresh` serveur.

### Garanties et mise en œuvre

| Exigence | Mise en œuvre |
|---|---|
| Montant et durée serveur | inchangé (`getSubscriptionPrice`, figé au paiement) ; montant envoyé `"3000.00"` construit à partir de l'entier |
| Activation sur preuve serveur | `fetchStatus` lit `GET /checkout-sessions/{id}/` (`metadata`, `amount`, `currency`, `transaction`), puis `/status/`, puis `GET /payments/{tx}/verify/`. `succeeded` **seulement** si `SUCCESS` relu |
| Montant, devise, rattachement | `merchantReference` = `metadata.merchantReference` de **notre** session ; `providerReference` = identifiant de session stocké ; montant entier = `requested_amount` **et** `debited_amount` égaux au prix (frais absorbés, D8 : compte réglé en `DEDUCTED`), sinon montant non concordant → `review` ; devise `XAF` |
| Pas de double abonnement | inchangé : confirmation transactionnelle unique, `periodId: null` conditionnel, index uniques ; webhook rejoué ou concurrent → rejeu sans effet |
| Aucun nouveau débit automatique | aucun appel à `retry`, aucune nouvelle session pour un paiement ouvert ; `uncertain` reste ouvert jusqu'à la preuve ou à l'opérateur |
| Reprise | réponse perdue à la création → `uncertain`, puis recherche de la session par `metadata` (`supportsMerchantReferenceLookup`) : adoptée si trouvée, sinon reste incertaine. Webhook manqué → bouton « Vérifier » et CLI de rapprochement. Redémarrage → état en base |
| Échec | `failed` seulement si la session est `EXPIRED` ou `CANCELLED` **et** qu'aucune transaction n'est `SUCCESS` ni `PENDING` (relu). Une transaction `FAILED` dans une session encore `PENDING` laisse le paiement en attente (« Réessayer » sur la page SasPay) |
| Webhook | nouvelle route `/payments/webhooks/saspay` : corps brut (`rawBody` déjà actif), HMAC en temps constant, horodatage de 5 min, puis simple **signal** : `confirmPayment` des paiements SasPay ouverts concernés (ou de tous, bornés et regroupés, la donnée n'ayant pas de référence marchand), réponse 200 après traitement, 503 temporaire sinon |
| Test / production | `SASPAY_ENVIRONMENT=sandbox|live` ; refus au démarrage d'un préfixe de clé qui ne correspond pas (`sk_test_` / `sk_live_`) ; secrets `SASPAY_SECRET_KEY`, `SASPAY_WEBHOOK_SECRET` côté serveur seulement, jamais journalisés ; clé de portée `PAYIN` |
| Données personnelles | `customer_email` et `customer_name` obligatoires : ceux du propriétaire. SasPay (Payix LLC) devient destinataire : déclaration dans les documents juridiques avant l'activation |

### Changements de contrat interne (minimaux)

- `PaymentInitiationResult` accepté + `redirectUrl` facultatif, persisté
  (`providerCheckoutUrl`) et exposé au seul payeur ; le web affiche
  « Continuer vers le paiement » et y redirige.
- Le numéro de téléphone devient facultatif pour un prestataire à page
  hébergée (pré-remplissage), avec une empreinte de requête sans numéro
  dans ce cas.
- **Registre de prestataires** à la place de l'injection unique :
  `providers.get(payment.provider)` pour `confirmPayment`, le webhook et
  le rapprochement ; un prestataire **actif** pour les nouvelles
  initiations (`PAYMENT_PROVIDER_ACTIVE`, défaut `none` = indisponible).

## 5. Transition et retour arrière

- **Rattachement** : `subscription_payments.provider` existe déjà,
  immuable ; les paiements SasPay portent `saspay`.
- **CamPay** : aucun paiement attendu (§ 0). Avant l'activation, compter en
  lecture seule les paiements par `provider` et par `status`. S'il en
  existe :
  - ils restent rattachés à `campay` ;
  - ils sont confirmés par le registre, si l'adaptateur CamPay a des
    identifiants, ou par le CLI de rapprochement ;
  - jamais par SasPay.

  L'adaptateur, le webhook désactivé et leurs tests sont **conservés** dans
  1-21B ; leur suppression est un lot ultérieur, une fois ce constat fait.
- **Retour arrière** : `PAYMENT_PROVIDER_ACTIVE=none`. Les nouvelles
  tentatives répondent 503, mais les paiements SasPay ouverts restent
  confirmables (registre et webhook maintenus tant que la clé est
  présente). Rien n'est réinitié ni supprimé. Revenir en arrière dans le
  code (web puis API) garde les documents : `provider: "saspay"` reste lisible
  par l'ancien code, qui répond 503 au rafraîchissement sans perdre l'état.
  Il faut donc fermer les paiements ouverts avant un retour arrière du
  code.

## 6. Inconnues

| # | Inconnue | Bloquante pour |
|---|---|---|
| B1 | Activation **production** effective pour le statut de l'exploitant de Stock Master (particulier ou entreprise) : KYC accepté, `is_active: true` | **activation** |
| B2 | Clé `sk_test_` disponible avant KYC ; moyen de provoquer succès, échec et attente dans le bac à sable | **recette réelle** (pas le code) |
| B3 | Enveloppe réelle de chaque réponse (`softpay`, `checkout`, `verify`) | activation (le code la tolère dans les deux formes) |
| B4 | Une session produit-elle une ou plusieurs transactions (« Réessayer ») ; une transaction peut-elle réussir après `EXPIRED` ou `CANCELLED` | activation (règle d'échec du § 4) |
| B5 | Réglage du compte en `DEDUCTED` (frais absorbés) et frais réels sur `mtn_cm` / `orange_cm` | activation (sinon tout part en `review`) |
| B6 | Titulaire légal des fonds, contrat, retrait vers le Cameroun (moyen, frais, délais, plafonds), conditions de gel | **décision commerciale** avant tout encaissement réel |
| B7 | Code HTTP attendu pour l'accusé de réception du webhook, et absence d'identifiant d'événement | non bloquant (traitement idempotent) |
| B8 | Durée de rétention d'`Idempotency-Key` | non bloquant (softpay non retenu) |

## 7. Fichiers probablement concernés (1-21B)

- **API** :
  - `subscriptions/payments/payment-provider.ts` (`redirectUrl`, registre) ;
  - `subscription-payments.service.ts` (registre, téléphone facultatif,
    URL persistée) ;
  - `schemas/subscription-payment.schema.ts` (`providerCheckoutUrl`) ;
  - `payment-request.ts` (empreinte) ;
  - `reconciliation/payment-reconciliation.service.ts` ;
  - `subscriptions.module.ts` ;
  - nouveau `payments/saspay/` : adaptateur, transport, configuration,
    signature, contrôleur et service du webhook ;
  - `payment-webhook-paths.ts`.
- **Web** :
  - `components/subscription/subscription-payment-panel.tsx` (redirection,
    retour, numéro facultatif) ;
  - `lib/subscription-payments.ts` ;
  - i18n FR/EN.
- **Juridique** : `conditions-abonnement`, confidentialité et traitement
  des données (destinataire SasPay / Payix LLC).
- **Tests et recette** : faux SasPay local (sur le modèle du faux CamPay
  de `api/test/recipe/`), simulateur e2e.

## 8. Tests simulés (aucun appel à SasPay)

1. **Adaptateur** :
   - enveloppe présente ou absente ;
   - montants `"3000.00"` acceptés, `"3000.50"` et nombres refusés ;
   - correspondance des états session et transaction ;
   - `metadata` absente ou étrangère → discordance ;
   - `debited_amount` différent du prix → `review` ;
   - 401, 404, 409, 410, 422, 429, 5xx et délai dépassé → `Unavailable`
     ou `Uncertain`.
2. **Création** :
   - succès → URL de redirection ;
   - réponse perdue → `uncertain`, puis session retrouvée par `metadata`
     et adoptée ;
   - session introuvable → reste incertaine, aucune seconde session.
3. **Confirmation** :
   - `PAID` + `SUCCESS` → une seule période ;
   - `FAILED` dans une session `PENDING` → attente ;
   - `EXPIRED` avec transaction `PENDING` → attente ;
   - succès après `EXPIRED` → attribution ;
   - discordance de montant, de devise ou de référence → `review`.
4. **Webhook** :
   - signature invalide ou altérée → 401 ;
   - horodatage hors tolérance → refus ;
   - corps re-sérialisé refusé ;
   - doublons et livraisons concurrentes → une seule attribution ;
   - événement pour un paiement inconnu → 200 sans effet ;
   - base indisponible → 503 temporaire.
5. **Configuration** :
   - `sk_live_` en bac à sable et l'inverse → refus au démarrage ;
   - secret absent → prestataire indisponible ;
   - aucun secret dans les journaux.
6. **Transition** :
   - paiement `campay` ouvert jamais traité par SasPay ;
   - `PAYMENT_PROVIDER_ACTIVE=none` → 503 à la création, confirmation
     SasPay toujours possible ;
   - aucune réinitiation.
7. **Recette locale** :
   - faux SasPay ;
   - navigateur : redirection, retour, « Vérifier », signal temps réel ;
   - mobile et bureau, FR et EN.

## 9. Étapes

1. **1-21B, code et tests simulés** : registre de prestataires, adaptateur
   SasPay (checkout), webhook, interface de redirection, documents
   juridiques en brouillon. Production inchangée (`none`).
2. **Bac à sable** (après B2) : clé `sk_test_`, webhook de test
   (`webhook.test`), vérification de B3 à B5.
3. **Préalables à l'activation** : B1, B5 et B6 confirmés par écrit ;
   comptage des paiements par prestataire ; secrets de production posés ;
   webhook créé dans le tableau de bord, en `transaction.success` /
   `failed` / `cancelled`.
4. **Activation** : déploiement API puis web ; `PAYMENT_PROVIDER_ACTIVE=saspay` ;
   premier paiement réel au plus petit montant, vérifié par le
   rapprochement.
5. **Retour arrière** : `none`, paiements ouverts terminés par
   confirmation ou rapprochement, jamais réinitiés (§ 5).

## 10. Sources (consultées le 2026-10-11)

- Documentation SasPay : <https://docs.saspay.me/> ; index
  <https://docs.saspay.me/llms.txt> ; OpenAPI
  <https://docs.saspay.me/api-reference/openapi.json>.
- Pages de documentation :
  - [Démarrage rapide](https://docs.saspay.me/quickstart)
  - [Compte et KYC](https://docs.saspay.me/account-setup)
  - [Introduction](https://docs.saspay.me/api-reference/introduction)
  - [Paiements](https://docs.saspay.me/api-reference/payments)
  - [Softpay](https://docs.saspay.me/api-reference/payments/softpay)
  - [Checkout](https://docs.saspay.me/api-reference/payments/checkout-create)
  - [Statut de session](https://docs.saspay.me/api-reference/payments/checkout-status)
  - [Vérifier](https://docs.saspay.me/api-reference/payments/verify)
  - [Relancer](https://docs.saspay.me/api-reference/payments/retry)
  - [Transactions](https://docs.saspay.me/api-reference/transactions)
  - [Webhooks](https://docs.saspay.me/api-reference/webhooks)
  - [Formats et réseaux](https://docs.saspay.me/api-reference/reference/formats)
  - [Mes tarifs](https://docs.saspay.me/api-reference/reference/my-rates)
  - [AGENTS.md](https://docs.saspay.me/ai/agents-md)
  - [WooCommerce](https://docs.saspay.me/plugins/woocommerce)
- Site, mentions légales et CGU : <https://saspay.me/> (application
  monopage : textes lus dans le bundle public),
  `/mentions-legales` (14 août 2026), `/conditions-utilisation`
  (10 octobre 2026).
- Catalogue public : `GET https://api.saspay.me/api/v1/countries/`
  (sans clé, lecture seule).
- Écartés (homonymes) : SasaPay (Kenya), SAASPAY.

## Conclusion

**Implémentation possible avec la documentation disponible** pour le lot
1-21B (adaptateur par checkout hébergé, webhook signé, registre de
prestataires, interface, tests simulés). La documentation suffit pour
toutes les garanties du § 4 : référence marchand via `metadata`,
vérification serveur, signature, reprise.

L'**activation en production** reste subordonnée à des informations
manquantes, à obtenir du fournisseur et vérifier en bac à sable :

- B1 : accès production effectif pour le statut de l'exploitant ;
- B4 : nombre de transactions par session et succès après expiration ;
- B5 : frais absorbés (`DEDUCTED`) sur MTN et Orange Cameroun ;
- B6 : titulaire des fonds et conditions de retrait vers le Cameroun ;
- B2 et B3 : bac à sable et enveloppe réelle des réponses.
