# Phase 1-14A — Audit du socle d'abonnements

Base : `5fff2d0` (1-13B). Branche : `architecture/phase-1-14a-subscription-foundation-audit`.
Livrable documentaire uniquement : aucun code, package, migration, `.env` ni
fournisseur de paiement touché. Google et le nettoyage des réglages
Organisation restent hors périmètre.

Légende : **[FAIT]** déjà implémenté · **[ABSENT]** · **[INCOMPLET]** présent
mais incomplet · **[DÉCISION]** décision métier nécessaire.

## 1. Existant (preuves dans le code)

### 1.1 Feuille de route
- [INCOMPLET] `docs/audits/saas-transformation-audit.md` §« Phase 7 —
  Abonnements Mobile Money » prévoit un module `api/src/subscriptions/`
  (service + modèle + **webhook**), une collection `subscriptions`
  (`organizationId`, `plan`, `status`, `expiresAt`, `provider`, `providerId`)
  et des limites par plan (Q9). Cette esquisse mélange socle, fournisseur et
  quotas ; elle prévoit aussi un défaut `plan: free` (§ modèle) qui n'a jamais
  été implémenté. Elle ne trace pas les renouvellements (un seul `expiresAt`).
- [FAIT] `docs/architecture/phase-1-1a-foundational-models.md` §3 : Organization
  sans champ abonnement/facturation, choix délibéré.

### 1.2 Modèle Organization et statuts
- [FAIT] `api/src/organizations/schemas/organization.schema.ts` : `name`,
  `slug`, `logoKey`, `brandColor`, `currency`, `status` (`active | suspended`,
  défaut `active`). Aucun champ commercial.
- [ABSENT] Aucun code n'écrit `Organization.status` : seule la valeur par
  défaut est posée à la création (`createOwnerOrganization`,
  `organizations.service.ts`). La suspension n'est aujourd'hui possible que par
  une écriture directe en base. Le seul `target.status = …`
  (`organizations.service.ts:762`) concerne une **membership**.
- [ABSENT] Aucun rôle d'opérateur de plateforme. `User.role = admin` est le rôle
  legacy attribué à **chaque** propriétaire lors de l'inscription
  (`auth.service.ts:206`) : il ne peut donc pas servir à autoriser une
  activation.

### 1.3 Résolution du contexte actif
- [FAIT] `OrganizationsService.resolveActiveContext`
  (`organizations.service.ts:199-235`) : membership active **puis**
  organisation `active`, sinon 403 uniforme `ORGANIZATION_ACCESS_DENIED`.
  Elle est appelée par :
  - `OrganizationGuard` (global, `auth.module.ts:74-77`), à **chaque requête
    HTTP**, sans cache. Une suspension prend donc effet immédiatement côté
    serveur, malgré le JWT de 7 jours (`auth.module.ts:41`) ;
  - `AuthService.login` avec `organizationId`, et `switchOrganization`
    (`auth.service.ts:239-245`, `291-312`) ;
  - le middleware Socket.IO (`events/socket-auth.middleware.ts:224`).
- [FAIT] `listActiveOrganizations` (`organizations.service.ts:242-280`) filtre
  aussi les organisations `active`. Si aucune ne reste, `login` renvoie 403
  et aucun JWT (`auth.service.ts:258-262`).
- Conséquence : si une vérification d'abonnement était ajoutée dans
  `resolveActiveContext`, un commerce expiré ne pourrait **plus se connecter**,
  ni lire `/auth/context`, ni ouvrir un socket. Aucun écran de renouvellement
  ne serait alors atteignable.

### 1.4 Guards et permissions
- [FAIT] Ordre global : `JwtAuthGuard` → `OrganizationGuard` →
  `PermissionGuard` → `RolesGuard` (`auth.module.ts:66-77`).
  `PermissionGuard` lit uniquement `request.organizationContext`, sans accès
  DB (`permission.guard.ts`). Refus : 403 `PERMISSION_DENIED`.
- [FAIT] Opérations owner-only non délégables, dont `billing.identity`
  (`permissions.ts`, 1-1A §4). Aucune route ne l'utilise encore.
- [ABSENT] Aucun guard, décorateur ou code d'erreur lié à un abonnement.

### 1.5 Abonnements
- [ABSENT] Aucun modèle, route, configuration, variable d'environnement ou
  migration d'abonnement. `rg -i "subscription|abonnement|billing"` sur
  `api/src` et `web/src` ne trouve que `billing.identity`, les abonnements
  Socket/React et des commentaires.

### 1.6 Créations de produits et ventes
- [FAIT] `products.controller.ts` : `POST` et `DELETE` → `products.manage` ;
  `restore` et `permanent` → `trash.manage` ; `PATCH` contrôlé par champ dans
  le service (1-12H) ; `GET` sans permission (membre actif).
- [FAIT] `sales.controller.ts` : `POST`, `PATCH` et `DELETE` →
  `sales.record` ; `GET` avec scope own/all décidé dans le contrôleur.
- [FAIT] Idempotence : `SalesService.create` (`sales.service.ts:75-124`) et
  l'index unique `{organizationId, clientOperationId}`
  (`sale-operation-index.ts`). Un rejeu renvoie la même vente sans toucher au
  stock ni à l'audit. **Ce chemin s'exécute après les guards** : un rejeu
  refusé par un guard n'atteint jamais le service.
- [FAIT] Fenêtre de date : `occurredAt` doit dater d'au plus 14 jours
  (`sale-idempotency.ts:8`, `SALE_DATE_OUT_OF_RANGE`), sauf pour un rejeu
  déjà appliqué.

### 1.7 Hors ligne et outbox
- [FAIT] Outbox IndexedDB séparée, partitionnée par `userId:organizationId`
  (`offline-sales-outbox-db.ts:73`). Elle n'est pas purgée par
  `purgeAllOfflineData` (commentaire l.15). Au logout, il faut exporter ou
  confirmer s'il reste des ventes (`layout.tsx:408-450`,
  `logout-pending-dialog.tsx`).
- [FAIT] Rétention : `pending` de plus de 14 jours → `conflict EXPIRED`,
  jamais envoyé ni supprimé ; `synced` de plus de 7 jours → supprimé
  (`preparePartition`, `offline-sales-outbox-db.ts:420-455`).
- [FAIT] Export JSON/CSV depuis `PendingSalesPanel`
  (`pending-sales-panel.tsx:70-80`, `offline-sales-export.ts`). Il lit
  l'outbox locale et n'a besoin d'aucun appel serveur.
- [FAIT] Capacité de saisie hors ligne : un booléen `canRecordSales`, écrit
  seulement après un `GET /auth/context` réussi, lié à l'empreinte du token,
  avec un TTL de 72 h (`offline-sales-capability.ts`). Tout refus HTTP de
  `/auth/context` l'efface (`layout.tsx:380-392`, fail-closed).
- [INCOMPLET] **Blocage après 403** (`offline-sales-sync.ts:290-301`,
  `446-453`) : le 403 laisse l'opération `pending` (rien n'est perdu) et
  bloque la partition `access_denied` avec l'**empreinte du token courant**.
  Le blocage n'est levé que lorsqu'un **autre** token est présenté (nouveau
  login ou switch). Comme le JWT ne dépend pas de l'abonnement, un
  renouvellement côté serveur **ne débloque pas** l'appareil tant que
  l'utilisateur garde le même token, soit jusqu'à 7 jours. Le message affiché
  (« Reconnecte-toi… ») couvre ce cas, mais sans reprise automatique.
- [CONFIRMÉ] Tout 4xx autre que 401, 403, 409 idempotent et 429 est classé
  **conflit terminal**, et la file passe à l'opération suivante
  (`offline-sales-policy.ts:118-130`). Un refus d'abonnement en **402**, ou dans
  un autre 4xx, marquerait donc **toutes** les ventes en attente comme
  conflits, l'une après l'autre. Le refus doit rester un **403** ou recevoir un
  traitement dédié dans la politique.
- [FAIT] Synchronisation déclenchée seulement avec un `authContext` valide
  (`use-offline-sales-sync.ts:31`) : avec un `/auth/context` refusé, aucune
  boucle de requêtes.

## 2. Éléments manquants

1. Une source de vérité de l'abonnement par organisation, avec historique des
   périodes.
2. Un canal d'activation hors navigateur : il n'existe ni opérateur de
   plateforme, ni route d'administration.
3. Le calcul de l'état commercial (`actif` / `expiré` / `jamais souscrit`) à
   une date donnée.
4. La séparation entre refus administratif et refus commercial : codes
   d'erreur et traitement hors ligne.
5. Un mécanisme de reprise de l'outbox après un renouvellement, sans
   changement de token.
6. La politique d'accès après expiration ([DÉCISION], §5).

## 3. Modèle minimal proposé

### 3.1 Collection `subscription_periods` (registre en ajout seul)
Chaque activation ou renouvellement crée **un document**. Aucun document n'est
modifié ni supprimé : l'historique sert de trace de renouvellement.

| Champ | Type | Rôle |
|---|---|---|
| `organizationId` | ObjectId ref Organization, requis | propriétaire de l'abonnement (jamais un User) |
| `term` | `monthly \| quarterly \| semiannual \| annual`, requis | formule souscrite |
| `startsAt` | Date, requis | début de validité |
| `endsAt` | Date, requis, `> startsAt` | fin de validité, exclusive |
| `source` | `manual`, requis | source de l'activation ; enum étendu à la phase Mobile Money |
| `sourceReference` | string, requis, trim, borné | référence externe (n° de reçu, puis id de transaction fournisseur) |
| `grantedBy` | string, requis | identifiant de l'opérateur (CLI) ; jamais un userId du commerce |
| `previousPeriodId` | ObjectId \| null | chaînage du renouvellement |
| `createdAt` | timestamps | horodatage serveur |

Index :
- `{ organizationId: 1, endsAt: -1 }`, pour lire la période courante ;
- `{ source: 1, sourceReference: 1 }` **unique**, pour l'idempotence de
  l'activation : rejouer la même référence n'accorde pas deux fois la durée.

Ni prix, ni montant, ni devise, ni quota, ni essai, ni délai de grâce.
`Organization` reste **inchangé**.

### 3.2 État dérivé (jamais stocké)
`getSubscriptionState(organizationId, now)` renvoie l'une de ces valeurs :
- `active` : une période vérifie `startsAt ≤ now < endsAt` (expose `endsAt`
  et `term`) ;
- `expired` : il existe des périodes, mais toutes ont `endsAt ≤ now` ;
- `none` : aucune période.

`endsAt` se calcule en **mois calendaires UTC** (1, 3, 6, 12). En fin de
mois, la date est ramenée au dernier jour valide (31 janv. + 1 mois →
28/29 févr.). C'est un choix technique à tester, pas une règle commerciale.

### 3.3 État commercial ou suspension administrative
| | Suspension administrative | État commercial |
|---|---|---|
| Source | `Organization.status = suspended` (existant) | `subscription_periods` (nouveau) |
| Décidée par | opérateur, pour une raison hors paiement | dates et activations |
| Effet actuel | refus total via `resolveActiveContext` | aucun avant décision §5 |
| Code | `ORGANIZATION_ACCESS_DENIED` (uniforme, inchangé) | nouveau `SUBSCRIPTION_INACTIVE` (403) |

Règles :
- une expiration **n'écrit jamais** `Organization.status` ;
- un renouvellement **ne lève jamais** une suspension ;
- la suspension reste prioritaire, car elle est évaluée d'abord par
  `OrganizationGuard` ;
- le contrôle d'abonnement **ne va pas** dans `resolveActiveContext` (§1.3).
  Il prendra la forme d'un guard ou d'un décorateur distinct, appliqué route
  par route, après validation de la politique.

### 3.4 Activation non falsifiable
- Aucune route HTTP n'écrit dans `subscription_periods` en 1-14B.
- L'activation passe par un **script serveur** sur le modèle de
  `migrations/create-sale-operations-index.ts` (`MONGODB_URI` en
  environnement, URI jamais journalisée). Arguments : `organizationId`,
  `term`, `sourceReference`, `grantedBy`. Le serveur calcule `startsAt` et
  `endsAt`, jamais l'appelant.
- Le futur fournisseur Mobile Money ajoutera un `source` et un appelant
  (webhook vérifié) au **même** service `grantPeriod`. Le modèle n'a pas à
  changer.

## 4. Impacts sur l'accès et les ventes hors ligne

Aucune politique n'est choisie ici. Le tableau montre ce que chaque option
implique avec le code actuel.

| Zone | Si bloquée à l'expiration | Point d'attention |
|---|---|---|
| Connexion / sélection d'org | via `resolveActiveContext` | **À éviter** : plus de login, plus de `/auth/context`, aucun écran de renouvellement |
| Catalogue (`GET`) | guard sur `GET products/sections` | le cache hors ligne (72 h) reste lisible jusqu'à son TTL |
| Créations / modifications | guard sur `POST/PATCH/DELETE` | séparer produits et ventes si la décision les distingue |
| Ventes en ligne | guard sur `POST /sales` | doit être un **403**, sinon l'outbox convertit tout en conflits (§1.7) |
| Saisie hors ligne | indirect : `canRecordSales` vient de `/auth/context` | l'appareil **ne peut pas** voir une expiration avant sa prochaine réponse serveur. Une vente saisie hors ligne peut donc dater d'après l'expiration |
| Synchronisation | 403 → partition bloquée avec fingerprint | après renouvellement, **aucune reprise** sans nouveau token |
| Export des ventes en attente | jamais bloqué (local) | à préserver explicitement |

Invariants pour toute option :
- `userId`, `organizationId` et les ventes existantes ne sont jamais modifiés
  par un changement d'état commercial ;
- les opérations de l'outbox gardent leur `clientOperationId` et restent
  `pending` sur un refus d'abonnement. Il n'y a ni conflit, ni suppression ;
- **rejeu d'une vente déjà appliquée** : si une vente a été enregistrée avant
  l'expiration mais que sa réponse a été perdue, le guard renverra 403 au
  rejeu. Le serveur ne crée pas de doublon, mais le client ne peut pas le
  confirmer avant le renouvellement. Option à trancher en 1-14C : laisser le
  rejeu exact d'une clé existante passer avant le contrôle commercial ;
- **reprise sans boucle** : il faut lever le blocage `access_denied` quand un
  `GET /auth/context` réussit avec le même token (signal de reprise
  explicite), au lieu d'attendre un nouveau token. On garde le FIFO strict, le
  backoff d'au moins 2 s et un seul envoi par tête de file. L'idempotence
  serveur absorbe les rejeux ;
- **fenêtre de 14 jours** : une vente en attente depuis plus de 14 jours
  passe en `EXPIRED` côté client, et le serveur la refuse avec
  `SALE_DATE_OUT_OF_RANGE`. Une interruption plus longue rend donc ces ventes
  non synchronisables automatiquement, seulement exportables. Il s'agit d'une
  limite existante, à signaler au commerce, pas d'une suppression.

## 5. Décisions métier à soumettre (3 maximum)

1. **Politique après expiration.** Quelles zones du tableau §4 deviennent
   inaccessibles : aucune, écritures seulement (lecture et export conservés),
   ou ventes incluses ? Une vente saisie hors ligne **avant** l'expiration
   connue de l'appareil est-elle acceptée à la synchronisation ?
2. **Organisations existantes au moment de l'activation du contrôle.** Elles
   n'ont aucune période (`none`). Faut-il leur créer une période initiale
   (laquelle, par qui), ou les traiter comme expirées ? Aucun essai n'est
   proposé par défaut.
3. **Règle de renouvellement.** La nouvelle période commence-t-elle à
   `max(now, endsAt courant)` (on cumule le temps restant), ou à la date
   d'activation ?

### 5.1 Décisions validées (après audit, appliquées en 1-14B)

- **Essai** : chaque nouvelle organisation reçoit **un seul** essai de
  7 × 24 h, qui commence à sa création (heure serveur). Il est attribué dans
  la transaction d'inscription. Rejoindre une organisation n'en crée pas.
  Cette décision remplace la mention « ni essai » du §3.1 et la phrase
  « aucun essai n'est proposé par défaut » de la décision 2.
- **Organisations existantes** : ce sont uniquement des données locales de
  test. Il n'y a ni migration ni attribution rétroactive : elles restent
  `none`, et une période peut leur être attribuée manuellement par le script.
- **Renouvellement** : `startsAt = max(heure serveur, fin de la couverture
  déjà accordée)`. Un renouvellement anticipé cumule donc le temps restant ;
  une couverture terminée repart de maintenant.
- **Politique cible (1-14C)** : une expiration ou une absence d'abonnement
  bloquera **tous** les membres du commerce. Seul le propriétaire accédera
  au renouvellement. Les ventes en attente restent conservées.
- **1-14B n'active aucun blocage commercial.**

Le §6 ci-dessous est la proposition initiale. Le périmètre réalisé est
décrit dans `phase-1-14b-subscription-foundation.md` : il ajoute un `kind`
(`trial | subscription`), un `sequence` et un index d'essai unique.

## 6. Périmètre proposé — « 1-14B — Socle d'abonnement par organisation »

**Inclus (API uniquement, sans aucun blocage)**
- Schéma `SubscriptionPeriod` + 2 index (§3.1), enum `SubscriptionTerm`.
- `SubscriptionsService` : `getSubscriptionState(orgId, now)` (pur, horloge
  injectable), `computeEndsAt(startsAt, term)`, et `grantPeriod(…)`
  transactionnel et idempotent sur `{source, sourceReference}`, avec
  chaînage `previousPeriodId` selon la décision 3.
- Script CLI `migrations/grant-subscription-period.ts` et script
  `package.json` associé (sans dépendance), plus la création idempotente des
  index.
- Route de lecture `GET /organization/subscription`, réservée au propriétaire
  (opération owner-only, à confirmer en revue : réutiliser `billing.identity`
  ou en définir une). Elle renvoie `state`, `term` et `endsAt`, rien d'autre.
- Constante de code `SUBSCRIPTION_INACTIVE`, déclarée mais **non utilisée**
  pour l'instant.

**Exclus**
- Tout guard bloquant et toute modification de `resolveActiveContext`, du
  login, du switch ou des sockets (phase 1-14C, après décision 1).
- Toute modification frontend et de l'outbox (reprise après renouvellement :
  1-14C).
- Mobile Money : SDK, webhook, parcours de paiement (phase distincte).
- Déploiement, migration en production, prix, quotas, essai, grâce, factures,
  notifications.

## 7. Tests nécessaires pour 1-14B

**Schéma**
- champs requis ;
- enum `term` fermé ;
- `endsAt > startsAt` ;
- exactement les 2 index, dont l'unique `{source, sourceReference}` ;
- `Organization` inchangé (aucun nouveau champ).

**Calcul**
- `computeEndsAt` pour les 4 durées ;
- fins de mois (31 janv., 29 févr. bissextile, 31 août + 6 mois) ;
- UTC, indépendant du fuseau du processus.

**État**
- `none`, `active` et `expired` ;
- bornes exactes : `now = startsAt` → actif, `now = endsAt` → expiré ;
- plusieurs périodes, chevauchement après renouvellement ;
- isolation entre organisations.

**Activation**
- idempotence : même `sourceReference` → aucune seconde période,
  concurrence via E11000 ;
- `organizationId` inexistant → refus ;
- dates jamais fournies par l'appelant ;
- `grantedBy` requis ;
- chaînage `previousPeriodId` ;
- rollback complet en cas d'erreur.

**Séparation**
- une organisation `suspended` reste refusée même avec une période active ;
- une période expirée n'écrit jamais `Organization.status` ;
- `resolveActiveContext`, `login` et `switchOrganization` gardent le même
  comportement (tests existants, verts sans modification).

**Route de lecture**
- owner → 200 ; admin et seller → 403 `PERMISSION_DENIED` ;
- organisation tirée uniquement du contexte, jamais de
  `body`/`query`/`params` ;
- aucune route `POST`/`PATCH` d'abonnement exposée (test de surface).

**Non-régression**
- suites `sales` (idempotence), `products`, `auth` et `organizations`
  inchangées ;
- aucune dépendance ajoutée (`runtime-dependency-advisories.spec.ts`).

**Script**
- arguments invalides → code de sortie 1, sans écriture ;
- URI jamais journalisée.
