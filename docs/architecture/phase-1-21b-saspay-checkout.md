# Lot 1-21B — Liens de paiement SasPay et confirmation des abonnements

État : **implémenté et vérifié localement, désactivé par défaut**, non
commité, sur `feature/phase-1-21b-saspay-checkout` (depuis `c9e9792`, 1-20F).
Le rapport 1-21A (non suivi) et `stash@{0}` sont conservés.

Aucun commit, push, déploiement, paiement réel ni appel à SasPay. Aucun
secret dans le code, les rapports ou les journaux. La production reste
inchangée tant que `PAYMENT_PROVIDER_ACTIVE` vaut `none` (défaut).

## 1. Contrat SasPay utilisé

Sources : rapport 1-21A, <https://docs.saspay.me/> et
<https://docs.saspay.me/api-reference/openapi.json>.

| Route | Usage | Statut |
|---|---|---|
| `POST /checkout-sessions/` | création de la page : montant `"3000.00"`, `XAF`, `CM`, libellé, `customer_email`, `customer_name`, `return_url`, `metadata.merchantReference`, `expires_at` (+30 min) | documenté, **sans** `Idempotency-Key` |
| `GET /checkout-sessions/{id}/` | session enregistrée : `metadata`, montant, devise, `transaction`, `checkout_url` | documenté |
| `GET /checkout-sessions/{id}/status/` | statut revérifié auprès du gateway, `transaction_id` | documenté |
| `GET /payments/{id}/verify/` | transaction : `requested_amount`, `debited_amount`, `currency`, `flow_direction`, `transaction_type`, statut | documenté |
| `GET /checkout-sessions/?page=&page_size=` | recherche bornée après réponse perdue | documenté (pagination `next`) |
| Webhook `transaction.*` | HMAC-SHA256 hexadécimal de `"{timestamp}.{corps brut}"`, 300 s, en-têtes `X-Webhook-*` | documenté |

Enveloppe `{ success, data, code }` ou corps brut : les deux formes sont
acceptées (incohérence documentaire relevée en 1-21A).

**Non utilisés :**
- `POST /payments/softpay/` ;
- `POST /payments/{id}/retry/` (**aucune relance de débit**) ;
- les retraits.

## 2. Création du lien

- **Valeurs fixées par le serveur.** Montant et durée suivent les règles
  existantes (`getSubscriptionPrice`, en XAF). La référence est
  `SM<id>`. Le payeur est le compte **authentifié** (nom et e-mail
  vérifié, lus sur l'utilisateur, jamais dans le corps). Aucun numéro
  n'est demandé.
- **Réservation avant l'appel.** La tentative est réservée en base avant
  l'appel au fournisseur (inchangé). L'idempotence client
  (`clientOperationId` + empreinte) et l'index « un seul paiement ouvert »
  sont conservés. La session et sa page sont persistées
  (`providerReference`, `providerCheckoutUrl`). Un rejeu renvoie la même
  tentative et la même page.
- **Page autorisée.** Seule une page en HTTPS sur l'hôte documenté
  `https://pay.saspay.me`, sans identifiants, est acceptée. Sinon la
  tentative est incertaine.
- **URL de retour.** Elle vaut
  `PUBLIC_APP_URL/app/organization/subscription?payment=<id>`, et vient
  toujours de la configuration serveur.
- **Classement des réponses à la création :**

  | Réponse | État de la tentative |
  |---|---|
  | 400 / 422 | refus (`failed`, aucune session) |
  | 401 / 403 / 404 / 429, requête non transmise | indisponible (`failed`, 503, aucune session) |
  | 409, 5xx, réponse perdue, page refusée | **incertaine**, sans seconde session automatique |

- **Aucun secret côté navigateur.** La clé reste dans l'en-tête serveur.
  La vue n'expose que la page (`checkoutUrl`) d'un paiement ouvert.

## 3. Confirmation et rattachement

Le moteur de confirmation existant est réutilisé : transaction unique,
`periodId: null` conditionnel, index uniques. Avant toute attribution,
l'adaptateur établit, **par l'API SasPay** :

1. La session lue est celle **enregistrée**, et sa `metadata` porte
   **notre** référence.
2. La transaction est celle que **la session désigne** : route de statut et
   détail concordants, sinon incohérence. Elle est relue par `verify` avec
   le même identifiant, en `INBOUND` / `PAIEMENT`.
3. Les montants respectent la règle commerciale des frais absorbés (D8) :

   | Montant | Contrôle |
   |---|---|
   | demandé | égal au prix |
   | **débité** | égal au prix |
   | net | non contrôlé |

   Un débit supérieur (mode `ADD_ON`) conduit à une vérification, jamais
   à une attribution.
4. Devise identique, puis statut `SUCCESS`.

La transaction est **rattachée** dès qu'elle est connue
(`providerTransactionId`). Un nouvel index unique partiel
`provider_1_providerTransactionId_1` garantit qu'une transaction ne sert
jamais deux paiements : une collision conduit à une vérification.

Toute discordance conduit à `review`. Une confirmation répétée ou
concurrente n'attribue qu'une période. Un succès ne régresse jamais.

**Règles prudentes, tant que le bac à sable n'a pas tranché :**

| Situation SasPay | Paiement local |
|---|---|
| transaction `SUCCESS` (même après expiration) | `succeeded` (succès tardif accepté) |
| transaction `PENDING`, ou session ouverte sans transaction | `pending` |
| transaction échouée, page encore ouverte | `pending` (le payeur peut réessayer sur la même page) |
| page `EXPIRED` / `CANCELLED` sans succès | `uncertain` + incident `checkout_unresolved` : **ouvert**, toujours vérifiable, aucune nouvelle tentative libérée |
| réponses incohérentes ou correspondances multiples | `review` + incident `provider_inconsistent` |

**Procédure opérateur.** Le CLI de rapprochement existant reçoit une
option explicite, `--close-unresolved` :

- elle n'est acceptée que pour une page vérifiée close sans succès ;
- l'opérateur l'emploie après avoir obtenu de SasPay la confirmation
  qu'aucun débit n'a eu lieu, avec le motif `provider-checkout-closed` ;
- l'opération est auditée et idempotente, et le jeton de plan est lié à
  l'option ;
- le paiement est clôturé (`failed`), ce qui libère une nouvelle tentative.

## 4. Récupération après réponse perdue

`supportsMerchantReferenceLookup` vaut vrai pour SasPay.

- **Recherche bornée.** Liste des sessions **sans filtre d'état**, pages
  de 100, au plus **5 pages** et 20 s.
- **Sans résultat ou incomplète.** Ce n'est jamais une preuve d'absence :
  la tentative reste incertaine, sans réinitiation.
- **Plusieurs correspondances.** Elles ne sont jamais départagées : le
  paiement passe en vérification.
- **Une correspondance.** La session est adoptée **seulement après** la
  même vérification complète (§ 3). La page est alors réaffichée.

## 5. Webhook et rapprochement

La route dédiée est `POST /payments/webhooks/saspay` (publique, limitée
comme celle de CamPay). Elle répond 503 sans lecture tant que
`SASPAY_WEBHOOK_SECRET` est vide.

1. **Contrôles d'entrée.**
   - Corps brut, `application/json`, 64 Kio au plus.
   - Signature HMAC sur les **octets reçus**, comparée en temps constant.
   - Horodatage à ±300 s.
   - En-tête d'événement égal au corps.

   Tout échec renvoie 400, 401 ou 413, sans aucune lecture.
2. **Filtrage.** Hors `transaction.*`, ou `type` différent de `PAIEMENT` :
   accusé sans effet.
3. **Transaction déjà rattachée.** Vérification serveur (`refresh`),
   **jamais** une attribution directe. Le contenu de la notification n'est
   pas une preuve.
4. **Transaction pas encore rattachée.** Rapprochement **borné** : au plus
   3 paiements SasPay ouverts, avec une session connue, sans transaction,
   initiés depuis moins de 24 h, dans un budget de 10 s. Chaque
   vérification rattache la transaction que **sa** session désigne. Aucun
   balayage de tous les paiements ouverts.
5. **Accusé.** L'accusé n'est envoyé **qu'après traitement**. Sinon, la
   réponse est 503 (`Retry-After: 60`) : SasPay renvoie la notification
   (30 s, 5 min, 30 min, 2 h). Restent aussi le bouton « Vérifier », le
   retour du payeur et le CLI.

   Aucun journal d'événements n'a été ajouté : l'état durable est celui
   des paiements, et la reprise repose sur les renvois du fournisseur.
6. **Charge sortante.**
   - Les vérifications concurrentes d'un même paiement (`refresh`, retour,
     webhooks) sont **regroupées** dans le processus
     (`confirmPaymentShared`).
   - Les appels sortants sont plafonnés à 120 par minute et par
     processus. La limite documentée de SasPay est de 300 par minute et
     par compte.
   - Le moteur `confirmPayment` reste non regroupé : les tests de
     concurrence 1-14D l'exercent en vraie concurrence, ce qui prouve la
     garantie transactionnelle entre processus.

## 6. Prestataires et configuration

| Variable | Rôle |
|---|---|
| `PAYMENT_PROVIDER_ACTIVE` | `none` (défaut) ou `saspay` ; toute autre valeur, **`campay` compris**, est refusée |
| `SASPAY_ENVIRONMENT` | `sandbox` (`sk_test_…`) ou `live` (`sk_live_…`) ; un préfixe incohérent est refusé au démarrage, sans afficher de valeur ; `sandbox` est refusé en production |
| `SASPAY_SECRET_KEY` | secret, portée `PAYIN` ; présent seul (avec `none`), il permet de **confirmer** les paiements SasPay engagés |
| `SASPAY_WEBHOOK_SECRET` | secret de signature ; vide → webhook 503 |

- **Bac à sable.** Il est refusé en `NODE_ENV=production`, **même avec
  `none`**, c'est-à-dire même pour les seules confirmations. Un paiement
  de test attribuerait sinon un abonnement réel, par `refresh`, webhook
  ou CLI de rapprochement : les trois chargent ce câblage unique. Le
  démarrage échoue sans afficher de valeur. Une clé `live` avec `none`
  reste admise : les paiements LIVE engagés restent confirmables.

  **Correction de clôture.** La première version n'interdisait le bac à
  sable que comme prestataire *actif*. Avec `none` et une clé
  `sk_test_`, SasPay sandbox était enregistré comme prestataire de
  confirmation, et un test l'affirmait.

  Preuves :
  - `payment-providers.wiring.spec.ts` : la compilation des fabriques
    échoue dans ce cas ; en LIVE + `none`, les confirmations et le
    webhook restent actifs ; refresh, webhook et CLI n'ont pas d'autre
    source de confirmation ;
  - `payment-reconciliation-cli-process.e2e-spec.ts` : le CLI compilé,
    en production avec une clé sandbox, sort avec le code 1, sans
    écriture ni fuite de la clé.
- **Prestataire des nouvelles tentatives** (`PAYMENT_PROVIDER`), distinct
  de celui **enregistré sur chaque paiement**.
  - `PAYMENT_CONFIRMATION_PROVIDERS` contient SasPay dès que sa clé est
    configurée.
  - Chaque paiement est confirmé par **son** adaptateur, via
    `confirmationProviderFor`.
  - Un paiement `campay` n'est confirmé par aucun autre adaptateur (testé).
- **CamPay.** Son code et ses tests sont conservés. Il n'est jamais
  activé implicitement.
- **Faux SasPay.** Il existe seulement dans le code de test, comme
  transport injecté : aucune variable, route ni en-tête ne le sélectionne.
- **Documentation des variables.** Elles figurent dans `api/.env.example`
  et `.env.prod.example`, sans valeur. `docker-compose.prod.yml` les
  transmet avec `none` par défaut.

## 7. Interface (FR/EN, mobile et bureau)

- **Capacités.** `GET …/payments/capabilities` renvoie
  `hosted-checkout` ou `mobile-money`. Une API antérieure répond 404 : le
  web revient alors au formulaire Mobile Money existant.
- **Formulaire.** Choix de la durée et du montant (inchangés). En page
  hébergée, aucun champ numéro.
- **Après création.** Le bouton **« Continuer vers le paiement » /
  « Continue to payment »** ouvre la page **persistée**. Un rechargement,
  une reconnexion ou un retour ne créent jamais de nouvelle session.
- **Retour (`?payment=<id>`).**
  - Pour le paiement ouvert affiché : **une** vérification serveur, puis
    le paramètre est retiré de l'adresse.
  - Un identifiant arbitraire ne déclenche rien.

  Ni le paramètre, ni la redirection, ni la fermeture de la page ne
  prouvent un paiement.
- **États.** L'attente a un texte propre à la page hébergée. Les états
  succès, indisponibilité et vérification nécessaire sont les textes
  existants.
- **Conservé :** permissions (propriétaire seul), session limitée (`/access`),
  notifications et signaux temps réel.
- **Correction annexe.** Le message du panneau s'affichait deux fois
  (défaut préexistant, visible sur les captures) : il n'a plus qu'un
  emplacement.

## 8. Vérifications

| Contrôle | Résultat |
|---|---|
| Unitaires API (`src/subscriptions`, `src/common`, `src/migrations`), dont `saspay.spec.ts` (13 : configuration, signature, formats, création) et CLI `--close-unresolved` | **516 / 516** |
| Garde-fou bac à sable (clôture) : `payment-providers.wiring.spec.ts` (3) et unitaires `src/subscriptions` | **389 / 389** |
| E2E `payment-reconciliation-cli-process`, avec le cas « production + clé sandbox » | **15 / 15** |
| E2E `saspay-checkout` (nouveau) | **17 / 17** |
| E2E `saspay-confirmation-only` (nouveau, créations coupées) | **5 / 5** |
| E2E existants : `campay-payment-provider`, `campay-webhook`, `payment-reconciliation`, `payment-reconciliation-cli-process`, `subscription-payments-default-provider`, `realtime-subscription-payments` | **102 / 102** |
| E2E existants : `subscription-payments`, `member-activity-notifications`, `notification-center`, `subscription-access`, `subscriptions` | **119 / 119** |
| API : `tsc` (build), ESLint (0 erreur), Prettier | OK |
| Web : `tsc`, ESLint, `check-i18n` (0 problème), `i18n:coverage` (0 texte en dur) | OK |

### Scénarios e2e couverts

**Création :**
- page sans numéro, valeurs serveur, page autorisée, aucun secret
  renvoyé ;
- rejeu ;
- créations concurrentes : une seule session ;
- réponse perdue : incertaine, sans seconde session, puis session
  retrouvée par `metadata` et adoptée ;
- session introuvable ;
- 500 après création, refus 422, page d'un hôte non autorisé.

**Recherche :**
- correspondances multiples → `review` ;
- recherche bornée : exactement 5 pages lues, incertitude conservée.

**Confirmation :**
- succès vérifié et rejeu ;
- attente ;
- échec sur page ouverte ;
- page expirée → vérification, nouvelle tentative refusée ;
- succès tardif accepté.

**Discordances :**
- débit différent du prix ;
- devise ;
- `metadata` absente ;
- transaction désignée différemment ;
- transaction déjà rattachée à un autre paiement.

**Concurrence :** `refresh` ×5, webhooks ×3, moteur ×2 → une période.

**Webhook :**
- signature invalide, corps altéré, horodatage dépassé ;
- arrivée avant le rattachement ;
- rejeu ;
- transaction étrangère ;
- panne SasPay → 503 puis reprise ;
- base indisponible → 503 ;
- enveloppe absente.

**Opérateur :**
- plan bloqué par défaut ;
- clôture explicite appliquée, nouvelle tentative possible ;
- option refusée hors de son cas.

**Créations désactivées** (fichier `saspay-confirmation-only`) :
- 503 à la création ;
- capacités indisponibles ;
- paiements SasPay laissés par un processus précédent confirmés après
  redémarrage, réponse perdue comprise ;
- paiement CamPay jamais traité par SasPay ;
- webhook désactivé sans secret.

**Mises à jour de tests existants (justifiées) :**
- le test « fournisseur de production » vérifie la fabrique (défaut
  indisponible, `campay` refusé) ;
- index : 6, dont 5 uniques ;
- matrice des routes : `capabilities` (propriétaire) et webhook SasPay
  (public) ;
- liste des contrôleurs ;
- clé `checkoutUrl` dans la vue ;
- catalogue des messages d'erreur : 5 entrées manquantes depuis
  1-20D–1-20F, ajoutées.

### Recette navigateur

Méthode :
- recette locale `recipe.js start --provider=saspay` : vrai adaptateur,
  transport redirigé vers un faux SasPay local, webhook signé fictif ;
- Playwright + Chromium (installation existante, hors dépôt) ;
- page `pay.saspay.me` **interceptée**, aucun réseau externe.

Résultat : **9 / 9** (`browser-recipe.json`, hors dépôt).

| # | Contrôle |
|---|---|
| S1 | bureau FR : choix de la durée, aucun numéro, page créée par le serveur, « Continuer vers le paiement » (`https://pay.saspay.me/…`) |
| S2 | rechargement : même lien, aucune nouvelle session |
| S3 | retour sans paiement : **une** vérification, toujours en attente, paramètre retiré, aucune nouvelle session |
| S4 | vérification manuelle : un `refresh`, en attente |
| S5 | paiement simulé : webhook signé accepté, retour, **paiement confirmé**, abonnement prolongé (période visible) |
| S6 | adresse de retour arbitraire : aucune vérification ni session |
| S7 | bureau 1 280 px : aucun défilement horizontal |
| S8 | mobile 390 px, EN : « Continue to payment », échec sur la page → reste en attente, aucun défilement |
| S9 | aucun accès réseau externe |

## 9. Inconnues restantes et limites des simulations

À vérifier **en bac à sable** avec le compte existant (étape suivante) :

1. **Hôte de la page en bac à sable.** Il est documenté `pay.saspay.me`.
   S'il diffère, la création reste incertaine (page refusée) : il faudra
   ajouter l'hôte confirmé à `SASPAY_CHECKOUT_ORIGINS`.
2. **Transactions par session.** Une session peut-elle porter plusieurs
   transactions ? Le faux service suppose « la dernière tentative ».
   Un succès peut-il suivre `EXPIRED` ou `CANCELLED` (1-21A, B4) ?
3. **Frais absorbés.** Le compte doit être réglé en `DEDUCTED`
   (frais absorbés, D8) ; sinon chaque paiement part en vérification
   (`debited_amount` supérieur au prix).
4. **Enveloppe réelle** de chaque route (B3). Les deux formes sont
   acceptées.
5. **Webhook :**
   - code d'accusé attendu (2xx supposé) ;
   - absence d'identifiant d'événement (traitement idempotent) ;
   - `data.type` effectivement présent.
6. **Liste des sessions :** ordre réel (plus récentes d'abord supposé), et
   `metadata` présente dans la liste.
7. **Pages de retour en session limitée (`/access`).** Le retour vise
   `/app/organization/subscription`. Pour une entreprise bloquée, le
   payeur retrouve le paiement sur l'écran de blocage et le vérifie par le
   bouton, sans vérification automatique.

Le faux SasPay reproduit les **formes documentées**, pas le comportement
réel des opérateurs :
- délais et pannes réelles non reproduits ;
- montants de frais non reproduits ;
- authentification en deux étapes non reproduite ;
- renvois automatiques des webhooks non reproduits (seuls des renvois
  manuels le sont).

## 10. Configuration à effectuer ensuite (bac à sable, puis production)

1. **Tableau de bord SasPay :**
   - clé API `SANDBOX`, portée `PAYIN` ;
   - réglage des frais en **`DEDUCTED`** ;
   - webhook `https://<API>/payments/webhooks/saspay`, événements
     `transaction.success`, `transaction.failed` et
     `transaction.cancelled` ;
   - secret de signature à copier une seule fois.
2. **Déploiement non productif** (`NODE_ENV` différent de `production`) :
   - `SASPAY_ENVIRONMENT=sandbox` et les secrets ;
   - `PAYMENT_PROVIDER_ACTIVE=saspay` ;
   - `PUBLIC_APP_URL` exacte.

   Vérifier les points du § 9.
3. **Production**, sur autorisation explicite :
   - clé `LIVE` ;
   - `SASPAY_ENVIRONMENT=live` et `PAYMENT_PROVIDER_ACTIVE=saspay` ;
   - premier paiement au plus petit montant, rapproché.

## 11. Déploiement, compatibilité et retour arrière

**Ordre :**

1. **Pré-déploiement.** Lancer `predeploy-migrations.js`, dont
   `create-subscription-payment-indexes.js` crée l'index
   `provider_1_providerTransactionId_1`. Le démarrage de l'API le
   **vérifie**.
2. **API** (`none` par défaut : aucun changement visible).
3. **Web.**
4. **Activation**, plus tard, par configuration seulement.

**Compatibilité :**

| Cas | Comportement |
|---|---|
| Nouveau web, ancienne API | `capabilities` répond 404 → formulaire Mobile Money existant → 503 (inchangé) |
| Ancien onglet, nouvelle API (`none`) | inchangé (503) |
| Ancien onglet, nouvelle API (`saspay`) | le numéro est ignoré ; l'onglet n'affiche pas le lien, mais « Vérifier » fonctionne ; un rechargement charge le nouveau web. **Activer SasPay seulement après le déploiement du web** |
| Données | nouveaux champs facultatifs (`providerCheckoutUrl`, `providerTransactionId`, `payerPhoneMasked: null`) ; anciens documents inchangés |

**Retour arrière :**

1. `PAYMENT_PROVIDER_ACTIVE=none` : les créations répondent 503, mais les
   paiements SasPay engagés restent **confirmables** tant que la clé est
   présente.
2. Retour du code (web, puis API) : l'ancienne API ne sait pas confirmer
   un paiement `saspay` (503, état conservé). Il faut donc **clôturer
   d'abord** les paiements SasPay ouverts, par vérification ou CLI.
3. L'index supplémentaire peut rester (partiel, compatible). Rien n'est
   supprimé ni réinitié.

## 12. Brouillon des mises à jour de confidentialité (à ne pas publier avant l'activation)

> **Projet — non en vigueur.** Ces mentions ne doivent apparaître dans les
> documents publiés (`confidentialite`, `traitement-donnees`,
> `conditions-abonnement`) qu'au moment de l'activation réelle.

- **Prestataire de paiement des abonnements.** Les paiements
  d'abonnement en ligne sont traités par **SasPay**, service édité par
  **Payix LLC** (LLC du Nouveau-Mexique, États-Unis ; immatriculation
  RCCM au Bénin ; siège à Bohicon, Bénin), au moyen des opérateurs
  Mobile Money (MTN, Orange) et, le cas échéant, de leurs prestataires
  agréés.
- **Données transmises par Stock Master :**
  - nom et adresse e-mail du titulaire du compte qui paie ;
  - montant, devise, durée et référence du paiement (`SM…`) ;
  - pays (Cameroun) ;
  - adresse de retour vers Stock Master.

  Aucun mot de passe, code secret Mobile Money ni numéro de carte n'est
  saisi ni conservé par Stock Master.
- **Données saisies sur la page SasPay** (numéro Mobile Money, moyen de
  paiement) : elles sont traitées par SasPay et les opérateurs, selon
  leurs propres conditions.
- **Données conservées par Stock Master :**
  - identifiants de session et de transaction SasPay ;
  - statut, montants vérifiés et dates du paiement ;
  - adresse de la page de paiement tant que le paiement est ouvert.

  Elles servent à prouver l'abonnement et au rapprochement comptable.
- **Transfert hors du Cameroun.** Le prestataire est établi au Bénin et
  aux États-Unis : les données de paiement peuvent être traitées hors du
  Cameroun.
- **Finalité et base :** exécution du contrat d'abonnement ; obligations
  comptables.
- À compléter avec l'exploitant et SasPay : durée de conservation chez
  SasPay, contact du prestataire, et statut réglementaire (1-21A, B6).

## 13. Fichiers

- **API :**
  - `subscriptions/payments/payment-provider.ts` : `PAYMENT_CONFIRMATION_PROVIDERS`, `confirmationProviderFor`, `redirectUrl`, `unresolved`, `PaymentProviderInconsistencyError` ;
  - `payment-providers.wiring.ts` (nouveau) ;
  - `saspay/` (nouveau) : `saspay-config`, `saspay-transport`, `saspay-payment-provider`, `saspay-webhook-signature`, `saspay-webhook.service`, `saspay-webhook.controller`, `saspay.spec` ;
  - `subscription-payments.service.ts` : téléphone facultatif, payeur, retour, rattachement, `unresolved`, `confirmPaymentShared`, `capabilities` ;
  - `subscription-payments.controller.ts` et le DTO ;
  - `schemas/subscription-payment.schema.ts` et `subscription-payment-indexes.ts` ;
  - `payment-concordance.ts` ;
  - `reconciliation/*` : prestataire du paiement, `--close-unresolved` ;
  - `campay-payment-provider.ts` : numéro absent refusé sans envoi ;
  - `subscriptions.module.ts` ;
  - `common/i18n/error-messages.ts`.
- **Web :**
  - `components/subscription/subscription-payment-panel.tsx` ;
  - `lib/subscription-payments.ts` ;
  - `i18n/resources/{fr,en}/subscription.ts`.
- **Tests et recette :**
  - `api/test/e2e/fake-saspay.ts`, `saspay-checkout.e2e-spec.ts` et `saspay-confirmation-only.e2e-spec.ts` (nouveaux) ;
  - mises à jour justifiées (§ 8) ;
  - `api/test/recipe/saspay-sim.js` (nouveau), `boot-api.js`, `launcher.js`, `recipe-common.js` et `recipe.js` (mode `saspay`).
- **Configuration :** `api/.env.example`, `.env.prod.example`, `docker-compose.prod.yml` (variables sans valeur, `none` par défaut).

Nettoyage : la recette locale a été arrêtée, ce qui a supprimé sa copie
web et sa base éphémère. Les scripts de recette navigateur et les
captures restent hors du dépôt. Aucun service réel n'a été appelé.

L'étape suivante est la configuration et la vérification en bac à sable
avec le compte SasPay existant, puis une activation explicitement
autorisée.
