# Phase 1-15F — Temps réel des abonnements et paiements

Branche : `architecture/phase-1-15f-realtime-subscription-payments`, créée
depuis `architecture/phase-1-15e-concurrent-stock-updates` à
**`269ef80b83e35d631ca132c26e6eab96f6ff8c46`** (« fix(api): preserve stock
during concurrent product updates »), identique à `origin`. Au départ : arbre
et index propres ; `stash@{0}` (sauvegarde lint-staged `564a998`) présent et
**non touché**.

Rapports réutilisés : [1-15A](phase-1-15a-realtime-saas.md) (coordinateur,
ordre des réponses, rattrapage, validations isolées),
[1-15C](phase-1-15c-realtime-organization.md) (signaux `{}` après commit,
pont sans dépendance circulaire), [1-14D.2B](phase-1-14d2b-subscription-payments.md),
[1-14D.2C](phase-1-14d2c-owner-payment-ui.md),
[1-14D.2H](phase-1-14d2h-payment-local-recipe.md) (stack éphémère).

Aucun commit, push ni déploiement. Aucune base réelle, aucun service externe
(CamPay, e-mail, stockage) ; **aucun `.env` réel lu, déplacé ou modifié** :
suites API et build web uniquement par `recipe.js isolated`, recette sur la
stack D.2H. Aucune dépendance, lockfile inchangé. Le fournisseur de
production reste `UnavailablePaymentProvider` et le webhook reste désactivé
(`DISABLED_CAMPAY_WEBHOOK`) : fichiers non modifiés.

---

## 1. Audit

### 1.1 Écritures d'abonnement et de paiement

| Écriture                                                                                                     | Processus                                                                              | Frontière                                                                                                       | Avant 1-15F       |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------- |
| Création d'un paiement (`createPayment`) : réservation `initiating`, puis `pending` / `uncertain` / `failed` | **API** (`POST …/payments`)                                                            | `create` puis `updateOne` conditionnels, hors transaction ; appel prestataire hors transaction                  | aucun signal      |
| Vérification (`confirmPayment`) : `pending`, `failed`, `review`                                              | **API** (`POST …/:id/refresh`, webhook 1-14D.2F)                                       | `updateOne` conditionnels (filtre sur l'état)                                                                   | aucun signal      |
| Succès vérifié : période `payment` + `succeeded`                                                             | **API** (mêmes entrées)                                                                | **transaction** `runInGrantTransaction` (callback rejouable, rejeu complet sur collision) ; commit à son retour | aucun signal      |
| Date de consultation `lastCheckedAt`                                                                         | API                                                                                    | `updateOne`                                                                                                     | absente de la vue |
| Essai à la création de l'organisation (`grantTrial`)                                                         | API                                                                                    | transaction de l'appelant (organisation neuve, aucun membre connecté)                                           | sans objet        |
| Attribution manuelle (`subscription:grant`)                                                                  | **CLI, autre processus** (`createConnection`)                                          | transaction                                                                                                     | aucun signal      |
| Rapprochement opérateur (`subscription:reconcile-payment`)                                                   | **CLI, autre processus** (`createApplicationContext`, sans serveur HTTP ni passerelle) | transaction                                                                                                     | aucun signal      |

### 1.2 Lectures et écrans

| Route (droit)                                                                         | Source                                                      | Écran                                                     |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------- |
| `GET /organizations/current/subscription` (`billing.identity`, owner-only)            | `getStateWithHistory` : base seule                          | `SubscriptionManager` (aperçu, historique des périodes)   |
| `GET …/subscription/payments` et `GET …/payments/:id` (`billing.payment`, owner-only) | `listPayments` / `getPayment` : base seule (`paymentModel`) | `SubscriptionPaymentPanel` (paiement affiché, historique) |
| `POST …/payments/:id/refresh` (owner-only)                                            | **prestataire** (`fetchStatus`)                             | bouton « Vérifier le paiement » uniquement                |

Les deux lectures utilisées par le temps réel ne contactent **jamais** le
prestataire (vérifié dans `subscription-payments.service.ts` et
`subscriptions.service.ts` ; aucun accès à `PAYMENT_PROVIDER`).

| Situation                                                 | Socket            | Écran                                                     |
| --------------------------------------------------------- | ----------------- | --------------------------------------------------------- |
| Session applicative, abonnement actif                     | oui (shell)       | `/app/organization/subscription` (propriétaire seul)      |
| Session applicative bloquée (écran de blocage commercial) | **non** (1-14C.2) | `CommercialBlockScreen` → `SubscriptionManager` + panneau |
| Session limitée `/access`                                 | **non**           | idem, jeton limité explicite                              |

Aucun écran non propriétaire n'affiche l'abonnement ni les paiements en
session applicative : `billing.identity` et `billing.payment` sont
owner-only, jamais délégables.

### 1.3 Contrainte de modules

`OrganizationsModule` importe `SubscriptionsModule` ; `EventsModule` importe
les deux. `SubscriptionsModule` ne peut donc importer ni
`OrganizationsModule` (où vit `SocketRegistryService`) ni `EventsModule`.

## 2. Signaux serveur

### 2.1 Pont

`SubscriptionSignalsService` (nouveau, fourni et **exporté** par
`SubscriptionsModule`) ; `EventsGateway.afterInit` lui branche un émetteur
(même schéma que 1-15C) réduit à une seule opération :

- `toMember` → `emitToMember` (**nouveau**) : room `organization:<id>`,
  sockets à couverture d'abonnement valide, restreint aux sockets dont
  `organizationContext.userId` est l'utilisateur désigné par le service.

Aucune diffusion à toute l'organisation n'est possible depuis ce service.

Le modèle `OrganizationMembership` est enregistré en lecture dans
`SubscriptionsModule` (comme `Organization` l'était déjà) : aucun import de
module ajouté, aucun cycle.

### 2.2 Événements et destinataires

**Destinataires définitifs** : les deux signaux suivent le **même filtrage
serveur**.

| Signal                 | Payload | Destinataires (lus en base **au moment de l'émission**)                                                    |
| ---------------------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `subscription:changed` | `{}`    | sockets du **seul propriétaire actif** : `membership { role: owner, status: active }`, organisation active |
| `payments:changed`     | `{}`    | idem                                                                                                       |

Jamais un administrateur ni un autre membre, jamais un rôle porté par un
jeton ou figé au handshake : un administrateur non propriétaire ne reçoit
**aucun** des deux signaux. C'est cohérent avec les droits de lecture :
`billing.identity` (abonnement) et `billing.payment` (paiements) sont
owner-only et non délégables, donc seul le propriétaire a un écran qui
consomme ces signaux. Permissions et payloads inchangés.

Organisation suspendue ou introuvable → **aucun** signal (suspension
prioritaire). Jamais de montant, téléphone, référence, jeton, statut ni
identifiant dans un signal.

Révision : la première version de ce lot diffusait `subscription:changed` à
toute l'organisation (room) ; elle a été restreinte au propriétaire actif
(service, passerelle, unitaires, e2e, RT30, RT33 mis à jour).

### 2.3 Frontières de commit

| Chemin                                                                                             | Signal                                      | Moment                                                                                                                                              |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Création (`createPayment`)                                                                         | `payments:changed`                          | après l'insertion validée, en fin de traitement (`finally` autour de l'initiation), quelle que soit l'issue (`pending`, `uncertain`, `failed`, 503) |
| Rejeu même UUID, conflit, 409, refus 400/403                                                       | aucun                                       | aucune écriture                                                                                                                                     |
| `pending` / `failed` / `review`                                                                    | `payments:changed`                          | après l'`updateOne` conditionnel, **seulement s'il a appliqué** le changement                                                                       |
| Vérification sans changement, `lastCheckedAt` seule, échec tardif après succès (incident hors vue) | aucun                                       | —                                                                                                                                                   |
| Succès (`finalize`)                                                                                | `subscription:changed` + `payments:changed` | après le **retour** de `runInGrantTransaction` (commit extérieur), jamais dans son callback rejouable                                               |
| Succès déjà validé (rejeu)                                                                         | aucun                                       | —                                                                                                                                                   |
| Rollback, budget épuisé (`GRANT_TIMEOUT`, `GRANT_CONTENTION`), exception                           | aucun                                       | aucune écriture validée                                                                                                                             |

Best effort : `SubscriptionSignalsService` ne rejette jamais ; une panne de
lecture des destinataires ou d'émission est journalisée et n'altère pas la
réponse HTTP. Webhook (inactif en production) : même chemin
`confirmPayment`, donc mêmes signaux.

## 3. Relecture côté web

Réutilisation de `useLiveRefresh` (coordinateur 1-15A : regroupement 400 ms,
relectures sérialisées, rattrapage à chaque connexion du socket),
`useSocketSignals` et `createResponseOrder`. Aucun polling, aucune minuterie
sans signal.

**`SubscriptionManager`** (`subscription:changed`, session applicative) :
relecture silencieuse de `GET /organizations/current/subscription` ;
réponse ignorée si la portée (utilisateur, organisation, nature du jeton) a
changé ou si une réponse plus récente a été appliquée ; échec silencieux
(affichage conservé).

**`SubscriptionPaymentPanel`** (`payments:changed`, session applicative) :

- relecture de la première page d'historique et du paiement affiché, par les
  seules routes GET locales ; jamais `…/refresh` ;
- historique **fusionné** (pages déjà chargées par « Afficher plus »
  conservées, curseur inchangé dans ce cas) ;
- paiement ouvert créé ailleurs (autre onglet, autre appareil) : affiché, ce
  qui masque le formulaire ;
- protections :
  - **ancienne session ou organisation** : panneau remonté par clé
    (identité, nature du jeton) et pages remontées par le shell (1-15A) ;
  - **ancien paiement sélectionné** : la réponse par identifiant n'est
    appliquée que si ce paiement est toujours celui affiché ;
  - **lecture obsolète** : ordre des réponses ; et si une action de
    l'utilisateur (création, vérification, nouvel essai) ou le chargement
    initial a appliqué une réponse pendant la relecture, celle-ci est
    abandonnée puis **redemandée** ;
  - **`succeeded` absorbant** : une vue `succeeded` n'est jamais remplacée
    par un autre statut du même paiement (le serveur ne régresse jamais un
    succès) ;
- inchangés : marqueur de reprise (jamais écrit ni effacé par une
  relecture), UUID, verrou synchrone d'initiation, absence de relance
  automatique de collecte, aucun délai transformant un paiement en échec.

**Activation** : une relecture ne déclenche ni `onAccessRestore`, ni
relecture du contexte, ni échange de session, ni passe de l'outbox. Après un
succès, la reprise reste l'action explicite existante (« Vérifier mon
abonnement » → relecture du contexte ; en session limitée, échange
`complete`). La suspension reste prioritaire (contexte refusé, RT29 ;
échange refusé, D.2H 9).

## 4. Reconnexion, sessions sans socket, autres processus

- **Reconnexion** : rattrapage 1-15A — à chaque connexion du socket, chaque
  écran dont la dernière lecture appliquée a commencé avant relit (RT32).
- **Session limitée `/access` et écran de blocage commercial** : aucun socket
  (refus du handshake sans abonnement actif, 1-14C.1/C.2) ; aucune connexion
  métier ajoutée. Relecture disponible : « Vérifier le paiement »
  (consultation explicite), « Vérifier mon abonnement » / « Vérifier
  l'accès », rechargement de la page.
- **CLI (autre processus)** : le registre des sockets et l'émetteur vivent en
  mémoire du processus API ; une attribution manuelle ou un rapprochement
  exécutés par CLI **n'émettent rien** (`createConnection` ou
  `createApplicationContext` : aucune passerelle, émetteur absent). Rattrapage
  disponible : ouverture ou rechargement de la page, prochaine reconnexion
  du socket (si une lecture a été manquée entre-temps), actions explicites
  ci-dessus. Aucune infrastructure interprocessus ajoutée.
- **Engagement de commit incertain** : si le driver signale un dépassement
  de budget alors que le commit a en fait abouti, aucun signal n'est émis ;
  le prochain « Vérifier » rejoue le succès (sans signal, aucune écriture
  nouvelle). Les autres onglets se mettent à jour à la reconnexion ou à
  l'ouverture.

## 5. Preuves

### 5.1 API

`api/test/realtime-subscription-payments.e2e-spec.ts` (**nouveau**) : AppModule
réelle sur MongoMemoryReplSet, **vrais clients Socket.IO**, prestataire
simulé. Les absences sont prouvées sans délai : promesses d'émission
attendues, puis sentinelle diffusée à tous les sockets (ordre garanti par
connexion).

| #   | Preuve                                                                                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Création : deux onglets du propriétaire reçoivent exactement `payments:changed {}` ; admin et organisation B : **aucun** signal ; rejeu (même UUID), 409 et vérification refusée à l'admin (403) : aucun signal, 0 consultation                           |
| 2   | `pending` → `pending` : une consultation, aucun signal                                                                                                                                                                                                    |
| 3   | Succès : journal d'ordre « callback terminé → commit → émissions », période lue **à la réception** = 1 ; propriétaire `payments` + `subscription` (une fois chacun, `{}`), admin **aucun des deux**, B rien ; rejeu : 0 consultation, 0 signal, 1 période |
| 4   | Rollback forcé après les écritures du callback : 500, aucun appel d'émission, aucune période, paiement `pending`                                                                                                                                          |
| 5   | Échec confirmé : `payments:changed` au propriétaire seul, aucun `subscription:changed`                                                                                                                                                                    |
| 6   | Transfert de propriété puis succès : ancien propriétaire (jeton antérieur) 403 et **aucun** des deux signaux ; nouveau propriétaire : `payments:changed` et `subscription:changed`                                                                        |
| 7   | Organisation suspendue, succès confirmé par le chemin serveur (webhook) : période attribuée, **aucun** signal reçu                                                                                                                                        |
| 8   | Panne d'émission simulée : création 201, paiement persisté                                                                                                                                                                                                |

**Test de mutation** : un `subscriptionChanged` déplacé dans le callback de
la transaction fait échouer les tests 3, 4 et 6 (fichier restauré ensuite).

Unitaires : `subscription-signals.service.spec.ts` (**nouveau**, 8 tests :
sans passerelle ; pour **chacun** des deux signaux, propriétaire actif seul
avec le filtre `{ organizationId, role: owner, status: active }` et payload
`{}`, et aucun signal sans propriétaire actif ; organisation
suspendue/absente ; pannes non propagées) ; `events.gateway.spec.ts` (+2 :
l'émetteur branché n'expose que `toMember` et ne passe jamais par
`emitToOrganization` ; `emitToMember` filtré par utilisateur, organisation et
couverture).

Résultats après la restriction (environnement isolé) :
`isolated api-unit subscription-signals events.gateway` **2/2 suites,
27/27** ; `isolated api-e2e realtime-subscription-payments` **8/8**.

### 5.2 Navigateur (campagne `realtime`, stack D.2H)

| #    | Scénario                                                                                                                                  | Résultat observé                                                                                                                                                                                                                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RT29 | Propriétaire, deux onglets : paiement par l'UI dans l'onglet 1, succès vérifié dans l'onglet 1 ; puis organisation suspendue              | onglet 2 : `pending` puis `succeeded`, périodes 1 → 2 sans rechargement ; prestataire : 1 collecte, **1** consultation (le clic) ; onglet 2 : 0 POST, 0 `/auth/context`, aucun nouveau socket ; marqueur (UUID) identique ; 3 signaux `{}` ; « Vérifier mon abonnement » → **accès refusé** (suspension) |
| RT30 | Admin sur la page Abonnement, propriétaire B sur la sienne ; 409 et 403 ; succès chez A                                                   | refus : 0 signal, 0 relecture chez le propriétaire ; propriétaire A : `subscription:changed` reçu (chemin actif) ; admin : **0** `subscription:changed`, **0** `payments:changed`, **0** lecture abonnement/paiements ; B : 0 signal, 0 lecture, affichage inchangé                                      |
| RT31 | Paiement `uncertain` ; relecture déclenchée par `uncertain → pending` **retenue** par barrière ; succès vérifié dans la page ; libération | séquence affichée `uncertain → succeeded`, jamais `pending` ensuite ; historique `succeeded` ; consultations : 2 (API + clic)                                                                                                                                                                            |
| RT32 | Page hors ligne pendant succès + période                                                                                                  | au retour : `succeeded` et période rattrapés, sans rechargement ni POST, 0 appel au prestataire                                                                                                                                                                                                          |
| RT33 | Transfert de propriété en session ouverte, paiement du nouveau propriétaire puis succès vérifié                                           | ancien : page « réservée au propriétaire », **0** signal d'abonnement ou de paiement, 0 lecture ; nouveau : `pending` puis `succeeded`, périodes 1 → 2 sans rechargement, `payments:changed` et `subscription:changed` `{}` reçus                                                                        |

Première version (diffusion de `subscription:changed` à l'organisation) :
deux passages **5/5** et **5/5**. Après la restriction au propriétaire :
**RT29, RT30, RT33 : 3/3** (RT31 et RT32 non rejoués : propriétaire seul,
destinataires inchangés pour eux).

### 5.3 Régressions D.2H ciblées

Rejoués (comportements du panneau touchés : UUID, marqueur, verrou, conflit
entre onglets, nouvel essai, absence de relance et de polling, succès +
échange + suspension, changement de session, outbox, historique paginé) :
**2, 3a, 3c, 4, 5, 6, 8, 9, 10, 11, 12**. Non rejoués : 1 (droits d'accès au
panneau, inchangés), 3b (variante de 3a), 5b (variante de 5), 7 (montants
API), W1, R1, R2 (webhook et CLI : chemins serveur couverts par l'e2e, UI
inchangée). RT1–RT28 non rejoués (aucun fichier qu'ils exercent modifié hors
panneau ; coordinateur inchangé, 6/6).

Premier passage : 10/11, **scénario 6 en échec** : la création émet
désormais `payments:changed`, et la relecture locale regroupée (2 GET)
tombait dans les fenêtres où le scénario comptait **toutes** les requêtes de
paiement. Une première correction (« GET seuls autorisés pendant 30 min »)
ne détectait plus un polling GET ; elle est remplacée par un **budget de
lectures**.

**Assertions définitives du scénario 6** (code applicatif inchangé) :

- **Budget** : une lecture locale n'est admise qu'en réponse à un
  déclencheur observé dans la page. Par `payments:changed` reçu : au plus 1
  lecture de liste et 1 lecture du paiement affiché ; par
  `subscription:changed` : au plus 1 lecture de l'abonnement ; par socket
  ouvert (reconnexion) : au plus 1 de chaque (rattrapage). Déclencheurs
  comptés à partir des frames Socket.IO et des ouvertures de WebSocket ;
  lectures = `GET /organizations/current/subscription[/payments[/:id]]` de
  cette page uniquement.
- **Phase 0, chargement** : lecture initiale (1 liste, 1 abonnement), plus au
  plus un rattrapage par socket ouvert. Le socket du document peut se
  connecter après la lecture initiale (limite 1-15A). Mesuré, borné, puis
  page au repos (1,5 s sans requête).
- **Phase A, signal de la création** : exactement 1 `payments:changed`,
  0 `subscription:changed`, au moins une lecture de liste, budget respecté,
  une seule écriture (le POST de création).
- **Phase B, sans déclencheur** : juste après un ping Engine.IO, 30 s
  simulées, ce qui reste sous `pingInterval + pingTimeout` (45 s), donc sans
  reconnexion possible. Précondition vérifiée : 0 reconnexion, 0 signal.
  Puis **0 lecture et 0 écriture** : toute lecture serait périodique.
- **Phase C, attente prolongée** : 30 min simulées, plus `focus`,
  `visibilitychange` et `online`. 0 signal, **0 écriture**, lectures dans le
  budget des reconnexions observées, **0 collecte et 0 consultation** au
  prestataire simulé.
- **Sous-cas `uncertain`** (autre contexte, horloge réelle) : 1 signal, au
  moins 1 lecture de liste, budget respecté, seule écriture = la création ;
  puis fenêtre de 1,5 s sans aucun appel de paiement (inchangée).
- Les sous-cas 503, `review` et `unavailable` sont inchangés.

**Preuve que le budget détecte un polling GET** : deux mutations
temporaires du panneau (`setInterval` appelant `GET …/payments`), chacune sur
une stack reconstruite, panneau ensuite restauré à l'identique (`cmp`) :

| Mutation       | Résultat du scénario 6                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| polling 20 s   | **FAIL phase B** : `{"reads":{"list":1,…},"reconnects":0,"payments":0,"allowed":{"list":0,…},"within":false}`            |
| polling 10 min | **FAIL phase C** : `{"reads":{"list":2,"item":1,"subscription":1},"reconnects":1,"allowed":{"list":1,…},"within":false}` |

**Capture d'échec** : le harnais capture désormais **chaque page déclarée**,
dans son propre contexte : page principale, ainsi que `uncertain`, `review`
et `unavailable` via `watch`. Pour chacune : capture `fail-<id>-<label>.png`,
URL, extrait du texte affiché et 15 dernières requêtes avec statut HTTP ou
erreur réseau (`diagnostics` dans `results.json`). Vérifié par un échec
provoqué temporairement dans le sous-cas `unavailable`, avec un texte
attendu inexistant :

- `fail-6-unavailable.png` produit dans le bon contexte ;
- URL `/app/organization/subscription`, texte « Shop unavail… » ;
- requêtes `POST …/payments` → 503, puis la relecture locale `GET` ;
- pages `uncertain` et `review` signalées fermées.

Fichier restauré ensuite à l'identique. Aucun délai n'a été augmenté.

**Exécutions du scénario 6** :

| Version                              | Passages                                                                                                                                                                                                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Première correction (tour précédent) | 1 échec avant reformulation, puis 5/6 ; l'échec restant (`unavailable`, panneau jamais affiché en 20 s) n'a **pas** été reproduit                                                                                                                                                                           |
| Budget sans phase 0                  | 2/3 : un échec en phase A, `{"list":2,"item":1,"subscription":1}` pour 1 signal et 0 reconnexion. Une liste et un abonnement en trop, sans paiement : c'est le rattrapage du premier chargement, arrivé après le début de la phase A. Corrigé en le mesurant et en le bornant (phase 0), pas en le masquant |
| **Version finale**                   | **4/4** : phase 0 `{list 1, subscription 1}` pour 1 socket (3 passages) et `{list 2, subscription 2}` pour 1 socket (1 passage, rattrapage initial observé et admis par le budget) ; phase A `{list 1, item 1}` ; phase B 0 lecture ; phase C 1 reconnexion, `{list 1, item 1, subscription 1}`             |

L'échec ponctuel `unavailable` du tour précédent **reste de cause inconnue** :
aucune preuve ne l'explique. Il ne s'est pas reproduit, et la capture
visait alors la mauvaise page. Avec le harnais corrigé, une récidive
produira la capture et les requêtes de la bonne page.

## 6. Validations (état final, environnement isolé)

| Contrôle                                                                                              | Résultat                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recipe.js isolated api-unit`                                                                         | **71/71 suites, 1385/1385** ; aucune tentative d'accès à un `.env`                                                                                 |
| `recipe.js isolated api-e2e` (une fois, `maxWorkers: 1`)                                              | **27/27 suites, 590/590** ; `existsSync api\.env` bloqué 26 fois, jamais lu                                                                        |
| `recipe.js isolated web-build`                                                                        | compilé ; 3 `.env*` de `web/` écartés par leur nom, 0 dans la copie ; copie supprimée                                                              |
| `pnpm --filter api build` ; `npx tsc --noEmit -p tsconfig.build.json`                                 | OK ; 0 erreur                                                                                                                                      |
| Typage complet `tsc -p tsconfig.json` comparé à `269ef80` (copie temporaire sous `api/`, supprimée)   | 238 contre 239 ; **aucune erreur nouvelle** ; seule différence : l'artefact de chemin `subscription-pricing.spec.ts` propre à la copie (cf. 1-15C) |
| `pnpm --filter api exec eslint "{src,apps,libs,test}/**/*.ts"` (sans `--fix`)                         | 0 erreur, 2 avertissements préexistants                                                                                                            |
| `web : npx eslint .` (sans `--fix`) / `npx tsc --noEmit`                                              | 0 / 0                                                                                                                                              |
| `pnpm --filter web test:coordinator`                                                                  | 6/6                                                                                                                                                |
| `prettier --check` des fichiers modifiés ; `node --check` des scripts de recette ; `git diff --check` | OK (formatage appliqué à mes seuls fichiers, conformes sur la base) ; OK ; OK                                                                      |

Ces suites complètes datent de la première version ; elles restent valables
pour les chemins non touchés par la finalisation.

**Finalisation (restriction au propriétaire, scénario 6, capture)** —
vérifications limitées aux éléments touchés :

| Contrôle                                                                                          | Résultat                                                            |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `isolated api-unit subscription-signals events.gateway`                                           | 2/2 suites, **27/27** ; aucune tentative d'accès à un `.env`        |
| `isolated api-e2e realtime-subscription-payments`                                                 | **8/8** ; `existsSync api\.env` bloqué 1 fois, jamais lu            |
| `realtime RT29 RT30 RT33`                                                                         | **3/3**                                                             |
| `scenarios 6` (version finale)                                                                    | **4/4** (détail § 5.3)                                              |
| `npx tsc --noEmit -p tsconfig.build.json`                                                         | 0 erreur                                                            |
| Typage complet comparé à `269ef80`                                                                | 238 ; **aucune erreur nouvelle** (même seule différence d'artefact) |
| `eslint "{src,apps,libs,test}/**/*.ts"` (sans `--fix`)                                            | 0 erreur, 2 avertissements préexistants                             |
| web : `eslint src/components/subscription`, `tsc --noEmit` (panneau restauré après les mutations) | 0 / 0                                                               |
| `prettier --check` des fichiers touchés ; `node --check` des scripts ; `git diff --check`         | OK ; OK ; OK                                                        |

Commandes de recette :

```bash
pnpm --filter api build
node api/test/recipe/recipe.js start            # terminal dédié
node api/test/recipe/recipe.js realtime RT29 RT30 RT31 RT32 RT33 \
  --playwright=<dossier contenant node_modules/playwright> --chromium=<chrome.exe>
node api/test/recipe/recipe.js scenarios 2 3a 3c 4 5 6 8 9 10 11 12 --playwright=… --chromium=…
node api/test/recipe/recipe.js stop
node api/test/recipe/recipe.js isolated api-e2e realtime-subscription-payments
```

Playwright 1.62.1 et Chromium 1234 déjà présents sur la machine (aucune
installation). Nettoyage : stack arrêtée (ports 3200, 4200, 4298, 4299
libres, état et copie `.stockmaster-recipe-web/` supprimés), dossiers de
journal de garde de cette recette supprimés.

## 7. Fichiers

| Fichier                                                           | Changement                                                                                                                                               |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api/src/subscriptions/subscription-signals.service.ts`           | **Nouveau** : signaux `{}` au seul propriétaire actif (lu en base), best effort                                                                          |
| `api/src/subscriptions/subscription-signals.service.spec.ts`      | **Nouveau** : 8 tests                                                                                                                                    |
| `api/src/subscriptions/subscriptions.module.ts`                   | fournit/exporte le service ; modèle `OrganizationMembership` en lecture                                                                                  |
| `api/src/subscriptions/payments/subscription-payments.service.ts` | émissions après écriture validée ; helpers d'état renvoient « changé ou non » ; `finalize` renvoie son issue                                             |
| `api/src/events/events.gateway.ts`, `.spec.ts`                    | branchement de l'émetteur, `emitToMember` ; +2 tests                                                                                                     |
| `api/test/realtime-subscription-payments.e2e-spec.ts`             | **Nouveau** : 8 tests e2e avec sockets réels                                                                                                             |
| `web/src/components/subscription/subscription-manager.tsx`        | relecture sur `subscription:changed`, portée et ordre des réponses, rattrapage                                                                           |
| `web/src/components/subscription/subscription-payment-panel.tsx`  | relecture sur `payments:changed`, protections, fusion d'historique                                                                                       |
| `api/test/recipe/realtime-scenarios.js`, `recipe.js`              | RT29–RT33 et aides ; aide de la commande                                                                                                                 |
| `api/test/recipe/scenarios.js`                                    | scénario D.2H 6 : budget de lectures, phases 0/A/B/C (§ 5.3) ; harnais : pages surveillées (`watch`), statuts des requêtes, diagnostics d'échec par page |
| `docs/architecture/phase-1-15f-realtime-subscription-payments.md` | **Nouveau** : ce document                                                                                                                                |

Inchangés : `UnavailablePaymentProvider`, configuration du webhook,
contrôleurs et routes, permissions, schémas, CLI, rapprochement, outbox,
service worker, `env-guard.cjs`, `isolated-checks.js`, lockfile, `.env`.

## 8. Limites

- **Mono-processus** : écritures par CLI sans signal (§ 4) ; un déploiement
  multi-instance exigerait un adaptateur partagé (limite 1-7C inchangée).
- **Sessions sans socket** (limitée, blocage commercial) : aucune mise à jour
  automatique ; relecture par les actions explicites existantes.
- **Membres non propriétaires** : ne reçoivent aucun signal d'abonnement ni
  de paiement (aucun droit de lecture). Leur contexte d'accès n'est relu que
  par les mécanismes existants (ouverture, reconnexion, actions explicites).
- **Propre action** : l'onglet qui agit reçoit aussi le signal et relit
  (lectures locales, regroupées) — c'est ce qui a demandé l'ajustement du
  scénario D.2H 6.
- **Commit incertain** (budget dépassé après un commit effectif) : pas de
  signal (§ 4).
- **Relecture d'un paiement disparu** (404) : la relecture silencieuse est
  abandonnée, l'affichage conservé jusqu'à la prochaine action.
- **D.2H 6** : l'échec ponctuel `unavailable` du tour précédent reste de
  cause inconnue (§ 5.3) ; la capture vise désormais la bonne page.
- **Budget du scénario 6** : la phase B ne prouve l'absence de lecture
  périodique que pour une période ≤ 30 s ; au-delà, la phase C la détecte
  par dépassement du budget (vérifié à 10 min). Une lecture périodique qui
  coïnciderait à 400 ms près avec un rattrapage pourrait être regroupée par
  le coordinateur et échapper au comptage.
- Les scénarios RT29–RT33 n'ont pas été joués sur `269ef80` : sur la base,
  aucun signal n'existe et aucun écran n'écoute (audit du code), ils
  échoueraient dès la première attente de mise à jour.
