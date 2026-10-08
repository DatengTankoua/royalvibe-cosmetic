# Phase 1-14C.2 — Offres publiques, espace Abonnement et gestion de l'accès commercial

Base : `f1dc288` (1-14C.1 commitée, HEAD vérifié, arbre propre au départ).
Branche : `architecture/phase-1-14c2-subscription-access-ui`.

**Héritage** : aucune modification non commitée de 1-14C.1. Tout le diff de
cette branche appartient à 1-14C.2.

**Inchangés** : service worker, migrations, modèles et règles d'attribution,
packages, lockfile, `.env`. Aucune route d'écriture n'a été ajoutée.

> **Déploiement conjoint obligatoire avec 1-14C.1.** L'API 1-14C.1 bloque
> l'accès commercial. Ce frontend est le seul à gérer le 403
> `SUBSCRIPTION_INACTIVE` au login, le jeton limité et la reprise. Il faut
> aussi les index `subscription_periods` (migration 1-14B) et la migration
> `sale_operations`.

## 1. Contrats intégrés et décisions

| Contrat (API 1-14C.1) | Intégration |
|---|---|
| Login → 403 `SUBSCRIPTION_INACTIVE` + `restrictedToken` + `access` | `AuthContext.login` ouvre une **session limitée** (`subscriptionInactive`) ; la page de connexion redirige vers `/access` |
| `GET /auth/context` → bloc `access` | Seuls `access.applicationAccess` et `access.canRecordSales` ouvrent l'accès et la saisie. Un 200 seul ne suffit plus |
| `POST /auth/subscription-access/complete` (jeton limité, corps vide) | Appelé uniquement par l'action « Vérifier », et seulement si le serveur indique `subscriptionState === 'active'` |
| 403 commercial sur une route métier (session ouverte) | Intercepteur Axios → écran de blocage, sans déconnexion |
| 503 `SUBSCRIPTION_STATUS_UNAVAILABLE` | « Vérification momentanément indisponible », sans accès accordé ni expiration annoncée |
| `GET /organizations/current/subscription` | Espace Abonnement du propriétaire, avec l'historique ajouté (§5) |

Décisions :
- **Une seule architecture d'authentification.** Le JWT applicatif reste en
  `localStorage` (inchangé). La session limitée est un état supplémentaire
  du même `AuthContext`.
- **Le droit de gestion vient du serveur** : `access.canRenew`, et le rôle
  de la membership renvoyé par `/auth/context` (`role === 'owner'`).
  Jamais `User.role`, un rôle legacy ou une permission déléguée.
- **Tarifs = présentation.** `web/src/lib/subscription-offers.ts` ne sert
  jamais à attribuer une période. La cohérence des économies est vérifiée
  au chargement du module.

## 2. Tarifs et page publique

Le module typé `subscription-offers.ts` est la source unique, réutilisée
par la page publique (`#tarifs`) et le renouvellement.

| Durée | Total | Économie |
|---|---:|---:|
| 1 mois | 3 000 FCFA | — |
| 3 mois | 8 500 FCFA | 500 FCFA |
| 6 mois | 16 000 FCFA | 2 000 FCFA |
| 12 mois | 30 000 FCFA | 6 000 FCFA — 2 mois offerts |

- Le montant affiché est le **total de la durée**. L'équivalent mensuel est
  indiqué comme tel (« soit … / mois en équivalent mensuel »).
- La page présente « 7 jours d'essai gratuit, sans carte bancaire ».
  L'offre est la même pour toutes les durées, par commerce, sans
  supplément par vendeur et sans prélèvement automatique.
- **CTA** : `NEXT_PUBLIC_REGISTRATION_ENABLED === "true"` affiche
  « Commencer l'essai gratuit » vers `/auth/register`. Sinon, la page
  affiche « Les inscriptions sont momentanément fermées » et un lien de
  connexion. Le flag n'est ni activé ni contourné.

## 3. Espace Abonnement (propriétaire)

- **Accès** : onglet « Abonnement » dans Organisation et route
  `/app/organization/subscription`, affichés uniquement si
  `authContext.role === 'owner'`. Pour un autre membre, la page affiche
  « réservée au propriétaire » **sans appeler l'API**.
- **Contenu** :
  - état (essai en cours, abonnement actif, expiré, aucun, période à venir) ;
  - période courante avec ses dates ;
  - fin de couverture continue ;
  - **temps restant informatif**, calculé à partir de `access.checkedAt`
    (heure serveur) et jamais utilisé comme autorisation ;
  - **historique des périodes**, sans montant.
- **Renouveler** : choix de la durée, puis affichage du montant total. La
  mention indique que « le paiement en ligne sera bientôt disponible ». Il
  n'y a ni bouton de paiement, ni faux succès, ni activation locale
  (paiement et factures en 1-14D).
- **« Vérifier mon abonnement »** relit le contexte et l'abonnement.

## 4. Sessions normales, limitées et bloquées

### Stockage des jetons
| Jeton | Stockage | Usage |
|---|---|---|
| JWT applicatif | `localStorage["heyama_token"]` (inchangé) | ajouté par l'intercepteur |
| Jeton limité | `sessionStorage["stockmaster_restricted_session"]` | en-tête **explicite** uniquement, jamais remplacé par l'intercepteur |

- Le jeton limité n'est jamais écrit dans la clé du JWT applicatif, ni en
  IndexedDB, ni en Cache Storage (vérifié, scénario 4).
- Un jeton limité expiré est ignoré. `/access` revient alors à
  `/auth/login?session=limitee-expiree`, avec le message « Votre accès
  temporaire a expiré ».
- Le jeton limité est supprimé à la déconnexion, après l'échange, et quand
  une session applicative est installée.

### Transitions
```
login ── actif ─────────────→ session applicative (/app)
  └─ 403 SUBSCRIPTION_INACTIVE → session limitée (/access)
        ├─ « Vérifier » : contexte (jeton limité) → état actif ?
        │     └─ oui → échange complete → JWT applicatif installé SI même jeton
        │              et même époque de session → /app
        └─ 401 / expiration → /auth/login?session=limitee-expiree
session applicative ── 403 commercial / contexte bloqué → écran de blocage
        (JWT conservé, refus mémorisé) ── « Vérifier » + accès serveur → reprise
        avec le MÊME JWT
```

- **Session limitée** (`/access`, hors du shell `/app`) :
  - aucun hook métier, navigation métier, appel de branding protégé,
    socket ni moteur de synchronisation ;
  - appels autorisés uniquement : `context`, `organizations` (nom),
    abonnement (propriétaire) et échange.
  - Le propriétaire voit l'écran Abonnement et le renouvellement. Les
    autres membres voient « Contactez le propriétaire pour renouveler »,
    « Vérifier l'accès » et « Se déconnecter ».
- **Session applicative bloquée** (shell `/app`) :
  - le contexte est lu **avant** toute page métier, qui n'est montée
    qu'une fois le contexte connu ;
  - si l'accès est bloqué : écran unique, sans socket, moteur, navigation,
    branding ni pages métier ;
  - **sans déconnexion ni suppression locale** : la capacité de saisie hors
    ligne est retirée, mais le JWT est conservé.
- **Mémoire du refus** (`lib/commercial-block.ts`, `localStorage`, deux
  identifiants, aucun jeton) : dès qu'un refus est connu pour un couple
  `userId:organizationId`, le repli hors ligne (cache, rechargement,
  coupure) ne rouvre plus l'interface. Le refus n'est effacé que par une
  validation serveur positive pour la même identité.
- **Réponses tardives** : l'`AuthContext` tient une **époque de session**,
  incrémentée à chaque login, logout, installation ou fin de session
  limitée. Un échange dont l'époque ou le jeton ont changé renvoie `stale`
  et n'installe rien.
- Les mécanismes existants `SESSION_REVOKED`, `EMAIL_NOT_VERIFIED` et le 401
  d'un ancien token ne changent pas : l'intercepteur ne réagit qu'au token
  courant.

## 5. Extension de lecture API

`GET /organizations/current/subscription` n'exposait pas l'historique. La
réponse de la **même route** est complétée par `periods` : un tableau de
`{ kind, term, startsAt, endsAt }`, de la plus récente à la plus ancienne.

- Lecture seule : `SubscriptionsService.getStateWithHistory`, une seule
  requête.
- Même protection propriétaire (`billing.identity`) et même exception
  commerciale.
- Aucune référence, opérateur, source, rang ni identifiant exposé.
- Aucune nouvelle route, aucune écriture, aucune migration, aucune règle
  d'attribution modifiée.
- Tests API : projections exactes mises à jour (`periods`) et nouveau test
  e2e d'historique (ordre, clés exactes, aucun champ interne, aucune
  écriture). Le refus admin/vendeur était déjà couvert (1-14B §3,
  1-14C.1 §4 et §8).

## 6. Outbox, hors ligne et Socket.IO

- **Capacité locale** : elle est écrite avec `canRecordSales =
  access.canRecordSales` (accord serveur). Un refus commercial l'efface.
  La saisie en ligne exige aussi `canRecordSalesFromContext` : une
  permission `sales.record` seule ne la rétablit jamais.
- **Nouveau motif de blocage `subscription`** :
  - un 403 `SUBSCRIPTION_INACTIVE` ou `SUBSCRIPTION_ACCESS_LIMITED` pendant
    un envoi laisse la vente `pending` (même UUID, payload, date et
    partition) et bloque la partition avec ce motif, **distinct** de
    `access_denied` (permissions, accès administratif) et de `corruption` ;
  - il **n'est jamais levé par un changement de token**.
- **Levée explicite** (`clearSubscriptionBlock`) : uniquement après un
  contexte serveur avec JWT applicatif, `applicationAccess` et
  `canRecordSales` vrais, pour la même identité vérifiée. Elle ne touche
  jamais `corruption` ni `access_denied`. Elle déclenche ensuite une passe,
  avec le même JWT.
- **Arrêt** : le moteur ne reçoit de contexte que si l'accès commercial est
  ouvert. Il n'y a ni Background Sync, ni nouvelle boucle rapide, ni
  suppression automatique. Un 503 reste un réessai selon la politique
  existante.
- **Consultation et export locaux** (`LocalPendingSales`) : les ventes non
  finalisées de l'identité courante sont lisibles en session bloquée ou
  limitée. La lecture exige le pointeur d'identité vérifié pour le jeton
  fourni. Il est écrit **à partir du contexte serveur** obtenu avec le
  jeton limité : aucun identifiant libre, aucune autre partition lue.
- **Socket** : `SocketProvider` n'est monté que si l'accès est ouvert,
  jamais avec un jeton limité. Une déconnexion serveur
  (`io server disconnect`) déclenche une relecture du contexte, sans
  boucle de reconnexion. Après reprise : une seule connexion avec le token
  courant.
- **Hors ligne** : le catalogue hors ligne est inchangé quand l'appareil ne
  connaît pas de blocage. Le service worker n'est pas modifié : `/access`
  n'est pas servi hors ligne.

## 7. Résultats réellement observés

**Stack éphémère** (scripts temporaires hors dépôt) : `MongoMemoryReplSet`
(jamais 27017), migrations `sale_operations` et `subscription_periods`, API
compilée avec expéditeur simulé, `next build` puis `next start`. Les
attributions sont faites par le **CLI réel**
`grant-subscription-period.js`. L'expiration est simulée par des dates
passées dans la base éphémère. Playwright 1.63 utilise le Chromium déjà
installé : aucun package ajouté.

| # | Scénario | Résultat |
|---|---|---|
| 1 | Tarifs, économies, essai, CTA (inscription ouverte) | ✅ 4 montants totaux, économies, mention d'essai, CTA → `/auth/register` |
| 1b | CTA avec inscription fermée (build `false`) | ✅ aucun CTA d'essai, message « fermées », lien de connexion |
| 2 | Propriétaire actif : essai → +3 mois (CLI) | ✅ « Essai gratuit en cours », historique 1 → 2 périodes, couverture prolongée, temps restant, 12 mois = 30 000 FCFA, aucun bouton de paiement ni écriture |
| 3 | Admin et vendeur | ✅ onglet absent, page « réservée au propriétaire », **aucun** appel GET abonnement |
| 4 | Login inactif | ✅ `/access`, jeton en `sessionStorage` seul (ni `localStorage`, ni IndexedDB, ni Cache Storage), aucun appel métier, aucun socket, en-tête explicite ; vendeur : « Contactez le propriétaire » |
| 5-7, 14 | Session ouverte puis expiration, coupure + rechargement, reprise | ✅ blocage sans déconnexion (JWT identique), outbox intacte (même UUID, `pending`, motif `subscription`), socket fermé ; API injoignable + rechargement : écran de blocage, pas de catalogue ; CLI + « Vérifier » : **même JWT**, vente synchronisée, 1 vente, stock 10 → 9, **1** socket après reprise, 2 `POST /sales` (403 puis 201) |
| 8 | Jeton limité, attribution, échange | ✅ 403 `SUBSCRIPTION_ACCESS_LIMITED` après attribution et avant échange ; un seul échange (jeton explicite) ; JWT installé, jeton limité retiré ; ancien jeton limité toujours refusé |
| 9 | Blocages conservés après renouvellement | ✅ `corruption` → conservé, `access_denied` → conservé, `subscription` → levé |
| 10 | 503 et jeton limité expiré | ✅ message neutre, aucun appel métier pendant le 503, reprise via « Réessayer » ; jeton expiré → connexion avec message |
| 11 | Échange tardif après changement de session (barrière `page.route`) | ✅ réponse 200 tardive de A ignorée ; JWT B conservé ; aucune session A installée |
| 12 | 201 perdue (`route.fetch` puis abandon), expiration, renouvellement | ✅ même UUID, 1 vente, stock 10 → 9, 1 opération serveur |
| 13 | Isolation | ✅ B ne voit aucune vente de A ; partition A conservée ; A en session limitée : consultation et export CSV, rien supprimé |
| 15 | Responsive, clavier, hors ligne | ✅ aucun débordement horizontal à 320/375/390/768/1024/1440 px sur `/`, Abonnement et `/access` ; « Renouveler » et sélection d'une durée au clavier, focus visible, boutons ≥ 44 px ; catalogue hors ligne inchangé |

Exécution complète en une passe : **12/12**, plus **1b**.

**Contrôle complémentaire : réponse tardive d'une session précédente**
(barrière `page.route` sur la première requête métier de A, `GET /sections`).
Aucun `sleep` : attente de l'événement `requestfinished` de cette requête,
puis vidage déterministe des micro-tâches et d'une image de rendu.
Après la retenue, toutes les transitions sont des navigations client :
la requête de A reste en vol pendant la bascule.

Déroulé :
1. B prépare une vraie vente synchronisée, puis se déconnecte.
2. A se connecte et sa requête est retenue.
3. A se déconnecte et B se reconnecte.
4. La réponse de A est libérée.

| # | Réponse libérée pour A | Résultat pour B (abonnement actif) |
|---|---|---|
| 16 | 403 `SUBSCRIPTION_INACTIVE` | ✅ ni écran de blocage, ni état « indisponible » ; JWT identique ; outbox identique (1 opération) ; aucun refus mémorisé (ni pour B, ni pour A) ; 0 relecture de `/auth/context` ; `GET /sales` 200 |
| 17 | 503 `SUBSCRIPTION_STATUS_UNAVAILABLE` | ✅ mêmes constats |

**Aucune modification applicative n'a été nécessaire** :
- la réaction au 403 commercial exige que le jeton de la requête soit le
  JWT courant (`bearerOf(...) === getToken()`), comme pour le 401 ;
- l'état « indisponible » ne dépend que de la lecture du contexte par le
  shell, dont l'effet est annulé au démontage de la session A.

Aucun test de mutation n'a été mené (retrait volontaire de la garde pour
prouver que le test échoue).

Corrections faites **dans le script de test** pendant la mise au point
(aucune dans le code livré) :
- casse des emails : l'API les normalise en minuscules ;
- attente asynchrone : un prédicat `async` est toujours « vrai » ;
- ordre de l'expiration avant le retour réseau ;
- websockets d'un document remplacé : Playwright n'émet pas leur `close`.

### Validations

| Commande | Résultat |
|---|---|
| `pnpm --filter web lint` | ✅ |
| `pnpm --filter web exec tsc --noEmit` | ✅ |
| `pnpm --filter web build` (configuration locale) | ✅ (`/access`, `/app/organization/subscription` statiques) |
| API `jest` (unitaires) | ✅ 61 suites, 1025 tests |
| API `pnpm run test:e2e` | ✅ 16 suites, 394 tests (dont le test d’historique) |
| API `eslint` (sans `--fix`) | ✅ 0 erreur, 2 avertissements préexistants |
| API `nest build` | ✅ |
| `git diff --check` | ✅ |

## 8. Limites

- **Sans réseau**, l'appareil ne découvre un blocage qu'à la prochaine
  réponse serveur. Le refus mémorisé ne protège qu'**après** qu'il a été
  connu une fois.
- **Session limitée** : un rechargement conserve le jeton dans l'onglet
  (`sessionStorage`), mais pas un nouvel onglet. Le jeton expire en
  15 minutes, puis il faut se reconnecter.
- **Hors ligne** : `/access` n'est pas servi par le service worker
  (inchangé). Les ventes en attente restent consultables via le catalogue
  hors ligne tant qu'aucun blocage n'est connu.
- **Pointeur d'identité** : la session limitée le réécrit avec l'empreinte
  du jeton limité, après validation serveur. Le repli hors ligne de
  l'ancienne session applicative n'est donc plus disponible, ce qui est
  cohérent puisque cette session est fermée.
- Le temps restant est indicatif (heure serveur de la dernière
  vérification).
- La sélection multi-organisation du login n'indique pas l'état commercial
  de chaque organisation (limite de l'API 1-14C.1).
- Un **F5 dans un vrai Chrome sans réseau** n'a pas été testé.
  Playwright simule la coupure par une API injoignable (même limite qu'en
  1-11C.3).

## 9. Reporté à 1-14D

Paiement Mobile Money, factures, moyens de paiement et historique des
paiements. L'écran Abonnement est prévu pour recevoir un bouton de paiement
réel à la place de la mention « bientôt disponible ».

## 10. Artefacts hors dépôt

- `scratchpad/pw14c2/` (session courante) : `stack.js`, `boot-api.js`,
  `lib.js`, `scenarios.js`, `cta-closed.js`, `results-*.json`, journaux
  `api.log`, `web.log`, `mail.jsonl` (emails simulés, base éphémère
  détruite).
- Playwright est réutilisé depuis le scratchpad 1-13B, avec le Chromium
  1234 déjà présent sous `AppData/Local/ms-playwright`.
- `web/.next` (ignoré par Git) contient le build final, fait avec la
  configuration locale par défaut.
- Services arrêtés : stack (fichier `STOP`, Mongo détruit) et `next start`
  du test 1b.
