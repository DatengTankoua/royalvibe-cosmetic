# Phase 1-14C.1 — Contrôle des abonnements et accès limité côté API

Base : `d1f5f00` (1-14B commitée, HEAD vérifié).
Branche : `architecture/phase-1-14c1-subscription-access-api`.

Cette phase concerne **uniquement l'API**. Aucun fichier `web/`, service
worker, Dockerfile, `.env`, package ou lockfile n'est modifié.
`Organization.status` et les périodes déjà attribuées ne sont pas touchés,
et aucune route HTTP n'accorde d'abonnement.

> **Livraison couplée** : cette API doit être livrée avec le frontend
> 1-14C.2. Le frontend actuel ne gère ni le 403 `SUBSCRIPTION_INACTIVE` au
> login, ni le jeton limité, ni l'échange de reprise.

## 1. Règles appliquées

| Situation | Effet |
|---|---|
| Essai ou abonnement `active` | Accès habituel selon les permissions réelles |
| `expired`, `none` ou `scheduled` | Accès métier refusé à **tous** les membres, sessions déjà ouvertes comprises |
| Organisation suspendue, membership révoquée | Refus administratif prioritaire et inchangé (403 `ORGANIZATION_ACCESS_DENIED`) |
| Renouvellement | Lecture d'état réservée au propriétaire réel ; aucune activation par HTTP |
| Ventes en attente | Conservées : l'API ne supprime rien et la confirmation des ventes déjà appliquées reste possible |
| Après activation | Un JWT applicatif encore valide retrouve ses accès sans reconnexion ; un jeton limité doit passer par l'échange |

## 2. Audit ciblé (constats)

- **Émission des JWT** :
  - `AuthService.login` signe avec la version lue en même temps que les
    identifiants ;
  - `switchOrganization` signe avec la version validée du JWT appelant,
    revérifiée en base (1-13B) ;
  - payload d'origine : `{ sub, orgId, ver }`, durée 7 jours.
- **JwtStrategy** : `sub` et `orgId` sont stricts. À chaque requête, elle
  vérifie la version de session, l'email vérifié et l'utilisateur en base.
  Le principal porte `sessionVersion`.
- **Guards globaux** (avant cette phase) : `Jwt` → `Organization` →
  `Permission` → `Roles`. Seules `switch-organization` et `organizations`
  sautent la résolution du contexte (`@SkipOrganizationContext`).
- **Socket.IO** :
  - le middleware du handshake contrôle JWT, `exp`, utilisateur, version,
    email et `resolveActiveContext` ;
  - un timer coupe le socket à l'expiration du JWT ;
  - le registre en mémoire ferme les sessions révoquées ;
  - toutes les émissions passent par `EventsGateway.emitToOrganization`, en
    best effort après le commit.
- **Ventes** : le rejeu idempotent (`SalesService.replay`) s'exécute **dans
  le service**, après les guards. Un refus au guard empêcherait donc la
  confirmation d'une vente déjà appliquée. D'où l'exception `sale-replay`
  traitée par le service (§6).
- **Projections** :
  - `/auth/me` renvoie des champs explicites ;
  - `/auth/context` renvoie les permissions réelles ;
  - l'abonnement est lisible par le propriétaire seul (1-14B).

## 3. Types de jetons

Claim **signé** `accessScope`
(`api/src/subscriptions/subscription-access.ts`) :

| Valeur | Émis par | Durée | Usage |
|---|---|---|---|
| `app` | login, switch et échange, si l'abonnement est actif | 7 jours (inchangé) | accès applicatif, soumis au contrôle commercial **à chaque requête** |
| `subscription_limited` | login ou switch si l'abonnement est inactif (`restrictedToken`) | **15 min** | identification, lecture du blocage, renouvellement (propriétaire), échange ; jamais d'accès métier, même après activation |
| *(absent)* | JWT antérieurs à 1-14C.1 | restant | traité comme `app`, contrôle commercial compris |
| présent mais inconnu ou mal typé | — | — | **401** HTTP et refus Socket.IO, sans aucune conversion |

Les validations existantes sont conservées : signature, `exp`, email
vérifié, `authVersion` (claim `ver`), membership et organisation.

## 4. Matrice des routes

Cette matrice est **calculée depuis les métadonnées réelles** des
contrôleurs par `subscription-access-routes.spec.ts`. Le test échoue si une
exception est ajoutée ou retirée sans mise à jour.

| Catégorie | Routes | JWT accepté | Contrôle commercial |
|---|---|---|---|
| **Publique** | `GET /health`, `POST /auth/register`, `/auth/login`, `/auth/invitations/accept`, `/auth/email-verification/{request,confirm}`, `/auth/password-reset/{request,confirm}` | aucun | aucun (login : §5) |
| **Identification et état** (`@AllowInactiveSubscription('identity')`) | `GET /auth/me`, `GET /auth/context`, `GET /auth/organizations`, `POST /auth/switch-organization`, `POST /auth/subscription-access/complete` | `app` ou `subscription_limited` | aucun au guard ; switch et complete l'appliquent eux-mêmes |
| **Renouvellement propriétaire** | `GET /organizations/current/subscription` (`identity` + `@OwnerOnly('billing.identity')`) | `app` ou limité | aucun ; propriétaire réel uniquement |
| **Confirmation de vente** (`sale-replay`) | `POST /sales` | `app` uniquement | inactif → rejeu d'une clé déjà appliquée seulement |
| **Métier** (refus par défaut) | tout le reste : `/products/*`, `/sections/*`, `/sales/*` (hors création), `/analytics/*`, `/trash/*`, `/objects/*`, `GET /organizations/current`, `/organizations/current/{branding,logo}`, `/organizations/members/*`, `/organizations/invitations/*` | `app` uniquement | `active` exigé |

**Ordre des guards globaux** : `JwtAuthGuard` → `OrganizationGuard` →
**`SubscriptionAccessGuard`** → `PermissionGuard` → `RolesGuard`. Les tests
unitaires vérifient cet ordre.
- La suspension et la révocation (`OrganizationGuard`) restent prioritaires.
- Le refus commercial précède les permissions : il est identique pour tous
  les membres et ne révèle pas leurs droits.
- Les permissions réelles ne sont **pas modifiées** pour représenter
  l'expiration.
- Aucune exception n'ouvre le branding, les membres, les invitations ou les
  données métier (vérifié par test).

Codes de refus du guard :

| Cas | Statut et code |
|---|---|
| Jeton limité, principal sans portée, route sans contexte et sans exception | 403 `SUBSCRIPTION_ACCESS_LIMITED` |
| Abonnement non actif | 403 `SUBSCRIPTION_INACTIVE` (jamais 402, jamais 401) |
| Lecture du registre impossible | **503** `SUBSCRIPTION_STATUS_UNAVAILABLE` : accès refusé, jamais présenté comme une expiration |

## 5. Contrats de réponse

### Login (`POST /auth/login`)
- Ordre des contrôles :
  1. identifiants ;
  2. email vérifié (1-13A) ;
  3. organisation (sélection multi-organisation inchangée) ;
  4. abonnement.

  Un mauvais mot de passe garde le **401 générique** : aucun état commercial
  n'est révélé avant la validation des identifiants.
- Abonnement actif : contrat habituel `{ access_token, user }`, JWT
  `accessScope: 'app'`.
- Abonnement inactif : **403**, `Cache-Control: no-store`.

```json
{
  "statusCode": 403, "error": "Forbidden",
  "code": "SUBSCRIPTION_INACTIVE",
  "message": "L'abonnement de ce commerce n'est pas actif.",
  "restrictedToken": "<JWT accessScope=subscription_limited, 15 min>",
  "access": {
    "subscriptionState": "expired",
    "applicationAccess": false,
    "coverageEndsAt": "…",
    "checkedAt": "…",
    "canRenew": true
  },
  "path": "/auth/login", "timestamp": "…"
}
```

- `canRenew` est vrai **uniquement** si la membership a le rôle `owner`.
  Les permissions supplémentaires et le rôle legacy `User.role = admin` n'y
  changent rien. Les admins et vendeurs reçoivent aussi un jeton limité
  (identification, préparation de l'export local), sans droit de
  renouvellement.
- **Multi-organisation** : la sélection est inchangée. Une organisation
  expirée ne bloque pas une autre organisation active du même utilisateur.

### Switch (`POST /auth/switch-organization`)
- Un jeton limité reçoit 403 `SUBSCRIPTION_ACCESS_LIMITED` : il ne change
  jamais d'organisation.
- Organisation cible inactive : 403 `SUBSCRIPTION_INACTIVE`, avec un
  `restrictedToken` pour la cible.
- La version de session du JWT appelant est **revérifiée après toutes les
  lectures**, et la signature utilise cette version validée, jamais une
  version relue.

### Contexte (`GET /auth/context`)
`no-store`. Les champs existants sont inchangés (permissions **réelles**).
Un bloc est ajouté :

```json
"access": {
  "subscriptionState": "active|expired|none|scheduled",
  "applicationAccess": true,
  "coverageEndsAt": "…|null",
  "checkedAt": "<heure serveur>",
  "canRenew": false,
  "tokenScope": "app|subscription_limited",
  "canRecordSales": true
}
```

- `canRecordSales` est **faux** dès que l'accès est bloqué, même si
  `sales.record` figure dans `effectivePermissions`.
- Un 200 sur cette route ne signifie donc **pas** que le commerce est
  accessible.

### Reprise (`POST /auth/subscription-access/complete`)
- Exige un **jeton limité** ; avec un JWT applicatif → 400
  `RESTRICTED_TOKEN_REQUIRED`.
- Corps **vide** obligatoire. Tout champ (organizationId, rôle, statut,
  date, paiement) → 400 `UNEXPECTED_BODY`.
- Revalidations :
  - compte, email et version (`JwtStrategy`) ;
  - membership et organisation (`OrganizationGuard`) ;
  - abonnement actif (relu) ;
  - **version de session après toutes les lectures**.
- Abonnement actif : 200 `{ access_token }` (JWT `app`, `no-store`), signé
  avec la **version validée du jeton limité**.
- Abonnement inactif : 403 `SUBSCRIPTION_INACTIVE`, sans aucun jeton.
- Un ancien jeton limité **reste limité** après l'échange.

### En-têtes
- `Cache-Control: no-store` sur :
  - le login ;
  - `me`, `context`, `organizations`, `switch-organization`,
    `subscription-access/complete` ;
  - la lecture d'abonnement ;
  - **toute erreur** `SUBSCRIPTION_*` (via `HttpExceptionFilter`).
- Les codes existants (`ORGANIZATION_ACCESS_DENIED`, `PERMISSION_DENIED`,
  `SESSION_REVOKED`, `EMAIL_NOT_VERIFIED`) ne changent pas.

## 6. Ventes et idempotence

`POST /sales` porte l'exception `sale-replay`. Le JWT applicatif, la
membership et `sales.record` restent exigés. Le contrôleur transmet
`newWritesAllowed = (décision du guard active)`. Sans décision, la valeur
est fausse (fail-closed).

Quand l'abonnement est inactif (`SalesService.create`) :
- **sans `clientOperationId`** : 403 `SUBSCRIPTION_INACTIVE`, aucune
  écriture ;
- **clé inconnue** : 403 avant toute écriture ;
- **clé déjà enregistrée** : le **même `replay()`** qu'en mode actif
  s'applique, sans logique dupliquée :
  - autre vendeur → 409 `IDEMPOTENCY_KEY_CONFLICT` ;
  - payload canonique différent → 409 `IDEMPOTENCY_KEY_REUSED` ;
  - vente supprimée → 409 `SALE_OPERATION_ALREADY_APPLIED` ;
  - sinon la vente existante, sans stock, audit ni événement.

Garanties complémentaires :
- `occurredAt` fourni par le client n'intervient que dans la comparaison
  canonique : il ne contourne jamais l'expiration.
- La requête Mongo n'utilise que le DTO validé (`clientOperationId`
  UUID v4).
- La fenêtre de 14 jours et le rejeu tardif restent inchangés en mode
  actif.

## 7. Socket.IO et sessions ouvertes

- **Handshake** (`socket-auth.middleware.ts`) :
  - une portée autre que `app` est refusée **avant toute requête DB** ;
  - après `resolveActiveContext`, `getAccessDecision` est lue : un état
    inactif ou une erreur de lecture donne le refus générique
    `unauthorized` ;
  - les contrôles JWT, `exp`, email, `authVersion` et membership sont
    conservés.
- **Sockets ouverts** (`scheduleSocketSubscriptionCheck`) :
  - un timer est programmé à la fin de couverture connue ;
  - l'état est **relu côté serveur** à l'échéance :
    - couverture prolongée → mise à jour et reprogrammation ;
    - sinon, ou en cas de lecture impossible → `disconnect(true)` ;
  - le délai est borné à 2³¹−1 ms (relecture intermédiaire) ;
  - le timer est `unref()` et nettoyé à la déconnexion, y compris pendant
    une relecture en cours ;
  - le timer d'expiration du JWT et la révocation après réinitialisation
    (1-13B) ne changent pas.
- **Émissions** : `emitToOrganization` n'envoie qu'aux sockets dont la
  couverture connue n'est pas échue (heure serveur, sans lecture DB). Un
  socket bloqué ne reçoit donc plus de données métier, même avant que son
  timer ne le ferme.
  - Aucune émission lors d'un rejeu de vente.
  - Les appelants gardent leur `try/catch` après commit : une émission
    échouée ne transforme jamais une vente enregistrée en échec.

## 8. Tests réellement exécutés

Tous les tests ont tourné sur `MongoMemoryReplSet` éphémère (garde
anti-27017), avec l'expéditeur simulé, l'horloge injectée et des
**barrières** pour les courses (aucun `sleep` d'ordonnancement).

| Étape | Résultat |
|---|---|
| Unitaires ciblés (guard, claims, filtre, matrice, sockets, stratégie) | ✅ |
| E2E ciblé `test/subscription-access.e2e-spec.ts` | 17 tests ✅ |
| Unitaires API (`jest`) | 61 suites, 1025 tests ✅ |
| E2E API (`pnpm run test:e2e`) | 16 suites, 393 tests ✅ |
| ESLint API (sans `--fix`) | 0 erreur, 2 avertissements préexistants (`app.e2e-spec.ts`, `ephemeral-mongodb.ts`, non modifiés) |
| Build API (`nest build`) | ✅ |
| `git diff --check` | ✅ |

Couverture e2e (numérotation du cahier des charges) :
1. Accès habituel pendant l'essai, puis pendant un abonnement payant.
2. `expired`, `scheduled` (horloge avant le début de l'essai) et `none` :
   11 routes métier refusées pour le propriétaire, l'admin et le vendeur.
3. Login propriétaire inactif : 403, corps exact, jeton de 15 min, `me`,
   `context` et lecture d'abonnement accessibles. 3bis : un mauvais mot de
   passe ne révèle rien.
4. Admin et vendeur inactifs : jeton limité, aucun accès métier, lecture
   d'abonnement refusée.
5. Ancien JWT applicatif après expiration : 403 métier, `me` et `context`
   lisibles, `canRecordSales` faux malgré `sales.record`.
6. et 7. Jeton limité : switch interdit, échange refusé tant que
   l'abonnement est inactif. Après activation, l'ancien JWT applicatif est
   réutilisable et le jeton limité reste limité. Échange : corps forgé et
   JWT applicatif refusés, puis 200 ; l'ancien jeton limité reste limité.
8. Aucune élévation par les permissions supplémentaires ni par le rôle
   legacy.
9. Multi-organisation : sélection inchangée, organisation active
   accessible, switch vers l'organisation expirée → jeton limité.
10. et 11. Rejeu après expiration :
    - même vente renvoyée, codes 409 conservés ;
    - nouvelle clé, absence de clé ou date client ancienne → 403 ;
    - jeton limité → 403 ;
    - **compteurs ventes, stock, audit et opérations identiques, aucune
      émission**.
12. Sockets :
    - handshake refusé (abonnement expiré, jeton limité) ;
    - socket ouvert fermé à l'échéance après relecture ;
    - renouvellement avant l'échéance → socket conservé et événement
      `sale:created` reçu.
13. Révocation et email non vérifié prioritaires (aucun jeton limité).
    `authVersion` : jeton limité antérieur → 401. Suspension prioritaire
    malgré un abonnement actif.
14. Réinitialisation concurrente, ordonnée par barrière sur la lecture
    commerciale :
    - login : JWT émis puis refusé (401) ;
    - switch : 401 sans JWT ;
    - échange : 401 sans JWT.
15. Claims `accessScope` forgés (`APP`, `admin`, nombre, `null`, tableau,
    objet) : 401 HTTP et socket refusé. Organisation, état et en-têtes
    clients ignorés. Aucune route d'écriture d'abonnement (404).
16. Projections et journaux :
    - `no-store` sur 7 réponses ;
    - aucun champ interne (`sourceReference`, `grantedBy`, `trial:`,
      `sequence`, `authVersion`, `password`, `membershipId`) ;
    - stdout et stderr capturés : ni jeton, ni mot de passe, ni secret, ni
      URI.

Fixtures existantes : `test/e2e/subscription-fixtures.ts` crée les index,
puis attribue **explicitement** une période annuelle (via le service réel,
référence `e2e-fixture:<id>`) aux organisations créées directement en base
par 8 suites. Il n'y a aucun bypass `NODE_ENV=test` dans le code de
production. La suite 1-14B a été adaptée : son test « aucun blocage »
devient « blocage commercial », et un test fige son horloge pendant
l'essai.

## 9. Limites

- **Requêtes déjà autorisées** : une requête qui a passé le guard juste
  avant l'échéance se termine normalement. Il n'y a ni verrou ni
  revérification transactionnelle de l'abonnement dans les écritures
  métier.
- **Hors ligne** : un appareil sans réseau ne découvre le blocage qu'à sa
  prochaine réponse serveur. Il n'existe **aucune révocation instantanée**
  hors réseau. Les ventes saisies hors ligne restent en attente : elles
  seront confirmées si elles avaient déjà été appliquées, et refusées en
  403 (conservées côté client) sinon.
- **Sockets** : le registre et le filtre d'émission sont **mono-instance**
  (même limite que 1-7C/1-13B). La fermeture à l'échéance dépend du timer du
  processus qui détient le socket.
- **Jeton limité** : 15 minutes, non révocable individuellement (seulement
  via `authVersion`). Il permet de lister les organisations actives de
  l'utilisateur (`GET /auth/organizations`), comme un JWT applicatif.
- **Sélection multi-organisation** : la liste n'indique pas l'état
  commercial de chaque organisation. Le blocage n'apparaît qu'au choix.
- Un échec de lecture du registre au login donne 503 : ni JWT, ni jeton
  limité.

## 10. Contrats à intégrer dans 1-14C.2 (frontend et outbox)

1. **Login** : traiter le 403 `SUBSCRIPTION_INACTIVE` comme un état, pas une
   erreur. Conserver `restrictedToken` **séparément** du JWT applicatif,
   sans jamais le promouvoir. Afficher l'écran de blocage selon `access`.
2. **Renouvellement** réservé à `access.canRenew` (propriétaire réel) ; les
   autres membres voient un message sans action.
3. **Reprise** : après activation, `POST /auth/subscription-access/complete`
   avec le jeton limité, corps vide, puis remplacement par l'`access_token`
   reçu. Un JWT applicatif existant n'a pas besoin d'échange.
4. **Ne plus déduire l'accès de `/auth/context` seul** : utiliser
   `access.applicationAccess` et **`access.canRecordSales`** pour la
   capacité de saisie hors ligne, au lieu de `effectivePermissions`.
5. **Outbox** :
   - un 403 `SUBSCRIPTION_INACTIVE` ou `SUBSCRIPTION_ACCESS_LIMITED` garde
     les ventes `pending` (déjà le cas pour tout 403) ;
   - lever le blocage `access_denied` sur un **signal serveur explicite**
     (`access.applicationAccess === true` avec un JWT `app`), jamais sur un
     simple 200 de `/auth/context` ;
   - la consultation et l'export locaux restent disponibles avec un jeton
     limité ;
   - un 503 `SUBSCRIPTION_STATUS_UNAVAILABLE` relève du réessai
     (`status >= 500`), jamais d'un conflit.
6. **Sockets** : un `unauthorized` ou une déconnexion serveur après
   expiration ne doit pas boucler. La reconnexion attend l'accès
   applicatif.
7. **Sessions ouvertes** : un JWT applicatif peut recevoir 403
   `SUBSCRIPTION_INACTIVE` à tout moment. Il faut basculer vers l'écran de
   blocage sans déconnecter ni supprimer de données locales.
