# Phase 1-14D.2C — Interface propriétaire de paiement

Branche : `architecture/phase-1-14d2c-owner-payment-ui`
Base : `b3a4f10` (1-14D.2B). Rapports préalables :
[1-14D.2A](phase-1-14d2a-payment-foundation.md),
[1-14D.2B](phase-1-14d2b-subscription-payments.md).

Lot **frontend uniquement**. Il n'y a eu aucun commit, push, déploiement,
paiement ou email réel. Aucun package n'a été ajouté et le lockfile n'a pas
changé. L'API, les migrations, Docker et nginx sont inchangés. Je n'ai lu la
valeur d'aucun `.env`.

> **Le prestataire de production reste indisponible.** En production, l'API
> injecte `UnavailablePaymentProvider` (1-14D.2B) : toute création renvoie
> `503 PAYMENT_SERVICE_UNAVAILABLE`, et l'interface affiche « Le paiement en
> ligne est indisponible pour le moment », sans faux succès. Seuls les tests
> injectent un prestataire simulé, côté API et hors dépôt.

Hors périmètre : adaptateur CamPay, webhook, réconciliation, outils
opérateur, reçus, factures, remboursements.

### Changement préexistant identifié

`web/src/app/app/organization/layout.tsx`, signalé en fin de 1-14D.2B,
déplace l'onglet « Hors connexion » **après** « Abonnement » dans la
sous-navigation Organisation. Il est **inclus dans le commit de base
`b3a4f10`**. Il ne figure donc plus parmi les modifications en attente. Ce
lot ne le touche pas.

---

## 1. Parcours

| Contexte | Session | Composant | Après succès |
|---|---|---|---|
| Espace Abonnement `/app/organization/subscription` | JWT applicatif | `SubscriptionManager` → `SubscriptionPaymentPanel` | `onVerify` existant : relecture du contexte du shell |
| Shell `/app` bloqué commercialement | JWT applicatif (accès bloqué) | `CommercialBlockScreen` → idem | `verifyCommercialAccess` existant : levée du blocage et de l'outbox commerciale |
| Renouvellement `/access` | `subscription_limited` (jeton explicite) | `CommercialBlockScreen` → idem | `verify` existant : contexte, puis échange `POST /auth/subscription-access/complete`, puis `/app` |

- Le panneau n'est affiché que si le serveur indique le **propriétaire
  réel** : `authContext.role === "owner"` dans l'espace Abonnement,
  `access.canRenew` sur `/access` et sur l'écran de blocage. `User.role`
  n'est jamais utilisé. Les contrôles API (`billing.payment`, owner-only)
  restent déterminants.
- L'identité du marqueur et la clé de remontage du panneau
  (`userId:organizationId:limited|app`) proviennent du contexte serveur. Un
  changement d'organisation, d'utilisateur ou de session remonte le
  panneau : aucune donnée du contexte précédent n'est conservée, et les
  réponses tardives d'un panneau démonté sont ignorées.
- Après `succeeded`, le panneau appelle `onAccessRestore`, c'est-à-dire le
  `onVerify` **existant**. Aucun raccourci d'authentification n'a été
  ajouté.

## 2. Contrats utilisés

Vérifiés dans le code de 1-14D.2B (`SubscriptionPaymentView`, contrôleur,
erreurs) ; aucun champ ni endpoint inventé.

| Appel | Fonction web | Déclencheur |
|---|---|---|
| `POST /organizations/current/subscription/payments` `{ term, payerPhone, clientOperationId }` | `createSubscriptionPayment` | Bouton « Payer … » (une fois par clic) |
| `GET …/payments/:id` | `fetchSubscriptionPayment` | Chargement (paiement connu), 409 `PAYMENT_ALREADY_PENDING`, « Nouvel essai » |
| `POST …/payments/:id/refresh` (corps vide) | `refreshSubscriptionPayment` | **Uniquement** le bouton « Vérifier le paiement » |
| `GET …/payments?limit=5&before=` | `listSubscriptionPayments` | Chargement et « Afficher plus » |

La projection affichée est celle de l'API : statut, durée, **montant
total figé**, téléphone masqué, référence et dates serveur. Le catalogue web
ne sert qu'au formulaire, avant toute création.

## 3. Création et reprise sans seconde collecte

1. **Une intention = un UUID v4** (`crypto.randomUUID`, avec un repli sur
   `getRandomValues`), écrit dans le marqueur **avant** l'envoi.
2. **Double clic** : un verrou synchrone (`useRef`) s'ajoute au bouton
   désactivé ; l'état React, lui, est asynchrone. Il n'y a **aucune
   relance automatique** du POST.
3. **Réponse perdue** (aucune réponse, 5xx inattendu) : l'intention reste
   **verrouillée**, avec le même UUID et la même durée.
   - Au rechargement, si le serveur avait créé le paiement, il est
     **retrouvé dans l'historique** (unique paiement ouvert) et affiché,
     sans second POST.
   - Sinon, le formulaire affiche la durée verrouillée et demande de
     **ressaisir le même numéro** (jamais conservé), puis rejoue le même
     UUID. L'API répond `replayed: true` si la demande avait abouti.
   - Aucun nouvel UUID n'est généré automatiquement après un timeout ou une
     erreur réseau.
4. **`PAYMENT_ALREADY_PENDING`** (autre onglet ou appareil) : cet UUID n'a
   rien créé et il est abandonné. Le paiement indiqué par l'API est relu et
   affiché, sans nouvelle collecte.
5. **`PAYMENT_OPERATION_CONFLICT`** : le conflit est affiché (« Saisissez
   exactement le même numéro »), sans contourner l'idempotence ; l'intention
   est conservée.
6. **Refus définitif d'une intention nouvelle** (400, 401, 403) : rien n'a
   été créé et l'UUID est abandonné. Une intention **rejouée** reste
   verrouillée.
7. **Après `failed`** : « Nouvel essai » est une action explicite. Elle
   **relit d'abord le paiement côté serveur**. Si le statut a changé
   (`review`, etc.), l'état relu l'emporte. Sinon l'intention est effacée et
   le formulaire s'ouvre ; la prochaine soumission créera un nouvel UUID.

## 4. Stockage minimal (`web/src/lib/payment-intent.ts`)

- Clé `localStorage` `stockmaster_payment_intents`, au plus 20 entrées, **une
  par utilisateur + organisation**.
- Champs **exclusivement** : `userId`, `organizationId`,
  `clientOperationId` (UUID v4 ou `null`), `term`, `paymentId` (ou `null`),
  `savedAt`. Chaque entrée est validée à la lecture ; une entrée portant un
  champ inconnu est ignorée.
- **Jamais** de téléphone, de jeton, de montant ni de statut. Ce n'est
  **jamais une preuve de paiement** : l'état affiché vient toujours d'une
  lecture serveur. Le stockage est considéré comme non fiable ; s'il est
  absent, le paiement ouvert est retrouvé par l'historique serveur.
- Le marqueur est effacé à la lecture d'un `succeeded` ou lors d'un nouvel
  essai.
- Le téléphone ne transite que dans le corps de la création ; le champ est
  vidé après la réponse. Le panneau ne contient aucun `console.*`.

## 5. États présentés

| Statut | Libellé | Actions | Nouvelle collecte |
|---|---|---|---|
| `initiating` | Demande en cours | Vérifier le paiement | Non |
| `pending` | En attente de paiement (rappel : aucun code secret demandé) | Vérifier le paiement | Non |
| `uncertain` | Résultat à vérifier | Vérifier le paiement | Non |
| `review` | Vérification nécessaire | Vérifier le paiement | Non |
| `failed` | Échec confirmé | Nouvel essai (relecture serveur) | Après action explicite |
| `succeeded` | Paiement confirmé | Accéder à mon commerce / Vérifier mon abonnement | — |

- Une création acceptée **n'active pas** l'abonnement : « L'abonnement sera
  actif une fois le paiement confirmé ».
- Aucun timeout navigateur, délai ni JWT expiré ne transforme un paiement en
  échec : seul le statut serveur compte.
- **Aucun polling** ni vérification au focus, à la visibilité ou au retour
  réseau. Le seul minuteur réactive les boutons après `Retry-After`, sans
  appel réseau.
- `PAYMENT_CONFIRMATION_PENDING` : « Paiement en cours de confirmation.
  Vérifiez de nouveau dans un instant », sans changement d'état.
- Erreurs gérées explicitement : 401 (session expirée ; en session limitée,
  « votre paiement sera retrouvé »), 403 (accès refusé, par exemple une
  suspension), 409 (deux cas), 429 (`Retry-After`, boutons désactivés),
  503 (prestataire, statut ou confirmation indisponibles), 404.
- **Hors connexion** : un bandeau indique que la création et la
  vérification nécessitent Internet, et les boutons sont désactivés.
- Interface : formulaire réduit à l'offre (sélecteur existant), au
  téléphone (`type="tel"`) et au montant total affiché dans le bouton de
  confirmation « Payer 3 000 FCFA ». Le PIN n'est jamais demandé. Les
  statuts sont annoncés (`role="status"`, `aria-live`), les erreurs en
  `role="alert"`. Boutons de 44 px, navigation au clavier, mise en page
  mobile.

## 6. Cache, outbox et service worker

- Les appels de paiement sont des appels Axios **directs** : jamais
  l'outbox des ventes, jamais IndexedDB.
- Les réponses de l'API portent `Cache-Control: no-store` (1-14D.2B).
  Aucun en-tête de requête n'a été ajouté : un `Cache-Control` en requête
  déclencherait un preflight CORS refusé par la liste blanche.
- Le service worker (`public/sw.js`) ne traite jamais les requêtes
  cross-origin (l'API), ni `/app`, ni `/api`, ni les méthodes autres que
  GET. Il n'a pas été modifié.
- L'outbox métier n'est ni vidée ni modifiée par le paiement. Sa reprise
  passe par le mécanisme existant (`clearSubscriptionBlock` après accès
  applicatif rétabli), vérifié au scénario 11.

---

## 7. Tests

### Outillage

Le web ne dispose d'aucun script de test (`package.json` : `dev`, `build`,
`start`, `lint`). Comme en 1-14C.2, la validation fonctionnelle utilise
**Playwright 1.63 déjà présent hors dépôt** (dossier temporaire d'une
session antérieure ; rien n'a été installé), avec Chromium 1234 déjà
présent, contre une stack locale **éphémère** :

- `MongoMemoryReplSet` (garde anti-27017) et les trois migrations
  compilées ;
- l'API compilée lancée comme `main.ts`, avec deux remplacements de **test**
  injectés par `overrideProvider` : l'expéditeur d'emails simulé et le
  **prestataire de paiement simulé** (même contrat que
  `test/e2e/simulated-payment-provider.ts`, piloté par un serveur de
  contrôle local `127.0.0.1:4299`) ;
- le web de production, construit avec `NEXT_PUBLIC_API_URL` pointant vers
  l'API de test (variables de processus explicites).

Artefacts hors dépôt (scratchpad de session) : `pw14d2c/stack.js`,
`boot-api.js`, `lib.js`, `scenarios.js`, `results-all.json`,
`mobile-360-pending.png`. Aucun simulateur ni mode fictif n'existe dans le
code web livré.

### Scénarios (campagne complète, une seule exécution : **15/15 PASS**)

| # | Scénario | Résultat |
|---|---|---|
| 1 | Propriétaire actif (`/app`) et limité (`/access`) : paiement `pending` ; admin, vendeur, vendeur limité : aucun panneau ni appel de paiement | ✅ |
| 2 | Trois clics dans le même tick : **1 POST**, UUID du marqueur identique au corps envoyé, 1 collecte | ✅ |
| 3a | Réponse perdue (paiement créé) puis rechargement : paiement relu par l'historique, **aucun second POST** | ✅ |
| 3b | Réponse perdue et historique indisponible : durée verrouillée, téléphone à ressaisir, **même UUID et même durée** rejoués, `replayed`, 1 collecte | ✅ |
| 3c | Requête jamais arrivée : même UUID au nouvel envoi. Marqueur limité à ses 6 champs, **sans téléphone ni jeton**, portée utilisateur + organisation ; aucun téléphone ni jeton dans la console | ✅ |
| 4 | Deux onglets : B reçoit 409 `PAYMENT_ALREADY_PENDING` et affiche le paiement de A (même référence, durée serveur) ; 1 paiement, 1 collecte | ✅ |
| 5 | Après `failed` : aucun formulaire automatique ; « Nouvel essai » relit le serveur (un `review` relu l'emporte) ; après rechargement, nouvel essai explicite, **nouvel UUID**, 2 collectes | ✅ |
| 5b | Nouvel essai immédiat : `GET` puis formulaire, ancienne intention abandonnée | ✅ |
| 6 | `pending` après **30 min simulées** et événements focus/visibilité/en ligne : aucun appel ; 503 `PAYMENT_CONFIRMATION_PENDING` : message, **aucune relance** ; `uncertain` et `review` : aucun formulaire ni nouvel essai ; 503 du prestataire à la création : message, aucun paiement présenté, aucun libellé de succès | ✅ |
| 7 | Montant **figé** modifié en base (15 999) : la carte et l'historique affichent la valeur de l'API, pas le catalogue (16 000) | ✅ |
| 8 | **2 h simulées** et focus répétés : 0 refresh, 0 consultation prestataire ; un clic : 1 refresh | ✅ |
| 9 | `/access` : succès, puis « Vérifier le paiement », puis **un** `POST /auth/subscription-access/complete`, puis `/app` (JWT installé, jeton limité et marqueur effacés). Organisation suspendue : 403, message, reste sur `/access`, aucun échange tenté, suspension inchangée | ✅ |
| 10 | A propriétaire de A et admin de B. Organisation B : aucun parcours, référence de A absente. Utilisateur B : historique vide. Réauthentification de A sur A : **paiement retrouvé** | ✅ |
| 11 | Vente hors ligne en attente, puis expiration, puis paiement dans l'écran de blocage : l'outbox ne contient **que la vente**. Succès : accès rétabli, vente **synchronisée**, une vente serveur | ✅ |
| 12 | Historique de 5 éléments puis « Afficher plus » (7 au total, fin de pagination) ; 429 avec `Retry-After` : message puis reprise manuelle ; clavier seul (Entrée, Espace, saisie, Entrée) ; **360 px sans débordement horizontal** ; statut `aria-live` ; 401 en session limitée : message, état inchangé | ✅ |

### Validations

| Commande | Résultat |
|---|---|
| `pnpm --filter web lint` (ESLint, sans `--fix`) | ✅ code 0, aucune erreur ni avertissement |
| `npx tsc --noEmit` (web) | ✅ code 0 |
| `NEXT_PUBLIC_API_URL=http://localhost:4200 NEXT_PUBLIC_REGISTRATION_ENABLED=true pnpm --filter web build` (build de test) | ✅ |
| `pnpm --filter web build` (build final, configuration locale) | ✅ `/access` et `/app/organization/subscription` statiques |
| Scénarios Playwright (`node scenarios.js`) | ✅ 15/15 |
| Suites API | Non relancées : aucun fichier API modifié |
| `git diff --check` | ✅ (voir sortie finale) |

Le dernier changement, purement textuel (mention « paiements et factures
… ultérieurement » de l'aperçu), est postérieur à la campagne Playwright.
Il est couvert par le lint, le typage et le build finaux, mais n'a pas été
rejoué dans le navigateur.

### Défauts constatés pendant la mise au point

**Applicatif (corrigé)**

- Si l'historique des paiements ne répondait pas au chargement, le panneau
  s'arrêtait sans exploiter le marqueur. Une intention sans réponse n'était
  alors pas proposée au rejeu (scénario 3b). Le chargement continue
  désormais avec le marqueur.
- L'aperçu de l'abonnement annonçait encore que les paiements seraient
  disponibles « ultérieurement » : texte mis à jour.

**Tests (corrigés dans le harnais, aucune assertion affaiblie)**

- `dblclick` de Playwright attend un bouton réactivé : il est remplacé par
  trois `click()` dans le même tick, ce qui est plus strict.
- `getByText(..., { exact: false })` ignore la casse et trouvait « …une
  fois le paiement confirmé » : il est remplacé par l'absence de tout
  élément `succeeded` et de tout libellé exact de succès.
- Le scénario 5 supposait qu'un paiement `failed` cessait d'être courant
  après rechargement. Le comportement réel, voulu, exige « Nouvel essai »
  avec une relecture serveur ; l'assertion vérifie maintenant cette
  relecture.

## 8. Limites

- **CamPay** : aucun adaptateur. En production, le paiement reste
  indisponible (503, message utile). La recherche par référence marchand
  reste **non confirmée** chez CamPay ; le simulateur n'en est pas une
  preuve.
- Le marqueur vit dans `localStorage` : un autre navigateur ou un stockage
  effacé ne peut pas rejouer une intention **sans réponse** dont la requête
  n'a jamais atteint le serveur. Rien n'est perdu (aucun paiement créé) ;
  un paiement créé est toujours retrouvé par l'historique.
- Les paiements `uncertain` et `review` dépendent d'un traitement
  opérateur, dont l'outillage reste à faire. L'interface ne permet aucune
  nouvelle collecte en attendant.
- Il n'existe pas d'outil de test web dans le dépôt : les scénarios
  Playwright sont des artefacts hors dépôt, à reconstruire pour une future
  campagne.
- L'« attente prolongée » est simulée par l'horloge Playwright
  (`clock.fastForward`). Les 15 minutes du jeton limité restent celles du
  serveur.
- La sélection d'organisation multi-comptes n'a été testée qu'avec une
  adhésion insérée directement en base éphémère (flux d'invitation hors
  sujet).

## 9. Fichiers

Modifiés :

| Fichier | Nature |
|---|---|
| `web/src/components/subscription/subscription-manager.tsx` | La mention « bientôt disponible » est remplacée par `SubscriptionPaymentPanel` ; prop `identity` |
| `web/src/components/subscription/commercial-block-screen.tsx` | Transmet l'identité vérifiée au gestionnaire |
| `web/src/app/app/organization/subscription/page.tsx` | Identité issue du contexte serveur |
| `web/src/components/subscription/subscription-overview.tsx` | Mention des paiements mise à jour |

Nouveaux :

| Fichier | Rôle |
|---|---|
| `web/src/lib/subscription-payments.ts` | Client des 4 routes, classification des erreurs, UUID v4 |
| `web/src/lib/payment-intent.ts` | Marqueur minimal de reprise |
| `web/src/components/subscription/subscription-payment-panel.tsx` | Parcours : formulaire, statut, vérification, nouvel essai, historique |
| `docs/architecture/phase-1-14d2c-owner-payment-ui.md` | Ce document |

Inchangés : API, migrations, `package.json`, lockfile, `public/sw.js`,
Docker, nginx, `.env`.
