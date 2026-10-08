# Phase 1-14D.2F — Webhook CamPay, sans activation de production

Branche : `architecture/phase-1-14d2f-campay-webhook`
Base : **`e38d0887f68baef5dd24a5abf4512a4756658238`** (« test(api): add
Railway proxy observation tooling », 1-14D.2E.1). Au départ, l'arbre et
l'index étaient propres. Le stash `stash@{0}` (sauvegarde lint-staged) est
préservé.

Rapports préalables : [1-14D.2B](phase-1-14d2b-subscription-payments.md)
(moteur de confirmation), [1-14D.2D](phase-1-14d2d-campay-adapter.md)
(adaptateur), [1-14D.2E.1](phase-1-14d2e1-railway-proxy-validation.md)
(frontière Railway non vérifiée).

Ce lot ne contient aucun commit, push ou déploiement. Il ne modifie pas la
configuration Railway, ne fait aucun appel CamPay authentifié, n'utilise
aucun secret réel et n'ajoute aucune dépendance (lockfile inchangé). Aucun
`.env` n'a été lu.

> **Production inchangée.** Le fournisseur reste `UnavailablePaymentProvider`.
> Le webhook est **désactivé** (`DISABLED_CAMPAY_WEBHOOK`) : il répond 503
> sans lire les paramètres, sans base ni prestataire. Aucune variable
> d'environnement, query, corps ni en-tête ne l'active ; seuls les tests de
> ce lot l'activent, par `overrideProvider`.

**Statut : non déclaré compatible avec CamPay.** Les composants
indépendants sont réalisés et testés, mais plusieurs éléments du contrat
restent indémontrables (§ 1.3).

---

## 1. Contrat officiel

### 1.1 Sources (consultées le 2026-10-03)

| Source | Version | Contenu webhook |
|---|---|---|
| [Documentation HTTP « CamPay API »](https://documenter.getpostman.com/view/2391374/T1LV8PVA) | JSON public de la collection (`documenter.gw.postman.com/api/collections/2391374/T1LV8PVA`, 53 716 octets), item « Webhook or Callback » | Seule description du webhook |
| [SDK Python officiel](https://github.com/CamPay/campay-python-sdk) | commit `268868443d` (2026-01-08), `src/campay/sdk.py` et `README.md` | **Aucune** occurrence de `webhook`, `signature`, `jwt`, `HS256`, `callback` ou `decode` : le SDK ne traite pas les notifications |

Aucun domaine CamPay n'a été contacté pour une opération (seuls les
documents publics ci-dessus ont été téléchargés).

### 1.2 Ce qui est documenté

Citations de l'item « Webhook or Callback » :

| Élément | Texte officiel | Conséquence |
|---|---|---|
| Déclenchement | « Your callback url will be notified when a transaction is SUCCESSFUL or FAILED. » | Notification de fin de transaction uniquement |
| Méthode | « You can set if your callback url should expect a GET or POST request. » GET : « expect a request with the following parameters » ; POST : « expect a request with following JSON data » | Deux routes, **mêmes noms de champs** ; GET en query, POST en corps JSON |
| Champs | `status` (« SUCCESSFUL » ou « FAILED »), `reference` (« A valid UUID4 »), `amount`, `currency`, `operator`, `code`, `operator_reference`, `signature`, `endpoint` (« collect » ou « withdraw »), `external_reference`, `external_user`, `extra_first_name`, `extra_last_name`, `extra_email`, `phone_number`, `redirect_url`, `failure_redirect_url`, `description`, `reason` | Liste fermée exploitée pour la concordance (§ 3.3) |
| Signature | `signature` : « jwt token. You can validate this request that is coming from CamPay by using your app webhook key to validate the jwt token ». « Use HS256 algorithm to decode. » | Signature **dans les paramètres** (pas dans un en-tête) ; JWT ; HS256 ; clé webhook de l'application |

L'hypothèse de D.2D (« JWT HS256 avec la clé webhook de l'application ») est
**confirmée** sur ces trois points, et sur eux seulement.

### 1.3 Ce qui n'est pas documenté (rien n'a été inventé)

| Question | Constat | Traitement dans ce lot |
|---|---|---|
| **Contenu signé** (claims) | Non documenté. Les seuls JWT de signature visibles sont dans les **exemples de réponse « Mass Payout: Status »** (retraits, pas collectes) : en-tête `{"alg":"HS256","app":"Test","typ":"JWT"}` ; contenus **tronqués ou altérés**, non décodables. Seuls des fragments apparaissent (`{"iat":1781…`, `{"iat":1781265404,"nb…`, une fin `…ource":"CamPay"}`) | Aucun claim exigé. Les claims portant le **nom d'un champ documenté** doivent concorder avec le paramètre reçu ; tous les autres paramètres sont **non protégés** (§ 3.3) |
| Lien entre la signature et la notification | Non documenté ; les fragments ci-dessus suggèrent des claims temporels, sans champ de transaction | La signature prouve au mieux qu'un jeton a été émis avec la clé ; elle **ne lie pas** prouvablement le statut, le montant ni la référence. La notification n'est donc qu'un **déclencheur** |
| Durée de vie, horodatage, anti-rejeu | Non documentés | `exp` et `nbf` appliqués **s'ils existent** (RFC 7519), avec une tolérance locale de 30 s ; aucune durée maximale inventée ; aucun en-tête temporel |
| Réponse attendue par CamPay | Non documentée (aucun exemple de réponse dans l'item) | Contrat local (§ 3.5) ; à faire confirmer |
| Reprises (nombre, calendrier, condition) | Non documentées | **Aucune reprise n'est supposée** (§ 6) |
| En-têtes, type de contenu POST, adresses sources | Non documentés | POST exige `application/json` (« JSON data ») ; aucune liste d'adresses |
| Types JSON du POST | L'exemple n'existe qu'en GET (chaînes) ; `reason` vaut `null` dans la query d'exemple | POST : chaînes, nombres et `null` admis pour les champs non exploités ; champs exploités en chaîne |
| Exemple de `reference` | La valeur d'exemple est `xyz`, contrairement à « A valid UUID4 » | UUID exigé (forme documentée) |
| Format de la clé webhook | Non documenté | Clé traitée comme chaîne UTF-8 (16 à 512 caractères) |

À ne pas confondre : les JWT `{"typ":"JWT","alg":"HS256","uid":2}` /
`{iat, nbf, exp}` des autres exemples sont des **jetons d'accès API**
(`/api/token/`), pas des signatures de webhook.

---

## 2. Architecture

```
GET|POST /payments/webhooks/campay   (@Public, aucun JWT applicatif)
  │
  ├─ PaymentWebhookThrottlerGuard   fenêtre `payment-webhook`, tracker req.ip (Express)
  │                                 ← après les parseurs HTTP (corps déjà analysé),
  │                                   AVANT le traitement métier : paramètres, signature, base, prestataire
  ├─ désactivé (défaut) ─────────────► 503 PAYMENT_WEBHOOK_DISABLED
  ├─ paramètres stricts ─────────────► 400 / 413
  ├─ signature HS256 + concordance ──► 401
  ├─ endpoint ≠ collect ─────────────► 200 (accusé, rien)
  ├─ locateProviderNotification (lecture seule, référence CamPay PERSISTÉE)
  │     ├─ found     → confirmPayment(id)   (moteur unique 1-14D.2B)
  │     │               statut RELU chez CamPay, concordance exacte,
  │     │               attribution atomique (30 s), sans réseau en transaction
  │     │               ├─ ok (tout état)            → 200 { received: true }
  │     │               └─ indisponible / budget / … → 503 RETRY_LATER (état conservé)
  │     ├─ not-ready → 503 RETRY_LATER (paiement `initiating` sans référence)
  │     └─ unknown   → 200 (aucune écriture)
```

| Fichier | Rôle |
|---|---|
| [campay-webhook-signature.ts](../../api/src/subscriptions/payments/campay/campay-webhook-signature.ts) | Vérification HS256 (`crypto`), contraintes temporelles, concordance claims ↔ paramètres |
| [campay-webhook-payload.ts](../../api/src/subscriptions/payments/campay/campay-webhook-payload.ts) | Lecture stricte GET/POST, bornes, détection des doublons sur le corps brut |
| [campay-webhook.config.ts](../../api/src/subscriptions/payments/campay/campay-webhook.config.ts) | Jeton `CAMPAY_WEBHOOK_CONFIG`, `DISABLED_CAMPAY_WEBHOOK`, contrôle de la clé |
| [campay-webhook.service.ts](../../api/src/subscriptions/payments/campay/campay-webhook.service.ts) | Orchestration ; codes et réponses stables |
| [campay-webhook.controller.ts](../../api/src/subscriptions/payments/campay/campay-webhook.controller.ts) | Routes publiques GET/POST, `no-store`, `Retry-After` |
| [campay-provider-name.ts](../../api/src/subscriptions/payments/campay/campay-provider-name.ts) | `CAMPAY_PROVIDER_NAME` partagé par l'adaptateur et le webhook |
| [payment-webhook-paths.ts](../../api/src/subscriptions/payments/payment-webhook-paths.ts) | Préfixe des routes de notification (masquage de la query) |
| [application-options.ts](../../api/src/common/application-options.ts) | `rawBody: true`, partagé par `main.ts` et les e2e |

Le webhook **n'importe ni l'adaptateur ni le transport** : il appelle
seulement `SubscriptionPaymentsService`, qui utilise le fournisseur injecté
(`UnavailablePaymentProvider` en production). Un test le vérifie.

## 3. Contrôles

### 3.1 Désactivation (défaut de production)

- `SubscriptionsModule` : `{ provide: CAMPAY_WEBHOOK_CONFIG, useValue: DISABLED_CAMPAY_WEBHOOK }`
  (objet gelé `{ enabled: false }`).
- Désactivé, le service répond **avant** de lire `req.query` ou le corps
  (vérifié par un accesseur espion). Il n'y a ni requête MongoDB ni appel
  au prestataire.
- Les fichiers du webhook ne lisent **aucune** variable d'environnement
  (test). Dans l'e2e de production, `CAMPAY_WEBHOOK_KEY` et
  `CAMPAY_WEBHOOK_ENABLED` définis à l'exécution, `?enabled=true` et un
  en-tête `X-Webhook-Enabled` restent sans effet.

### 3.2 Authentification

- **Clé distincte** : `assertUsableWebhookKey` refuse une clé absente, hors
  bornes, entourée d'espaces, ou **égale à `JWT_SECRET`**, la seule clé de
  signature des jetons de connexion. L'application ne démarre pas si le
  webhook est activé avec une telle clé. Le message d'erreur ne contient
  jamais la clé.
- **Vérification cryptographique** : HMAC-SHA256 recalculé sur
  `en-tête.contenu`, puis comparé en temps constant (`timingSafeEqual`)
  **avant** toute lecture des claims.
- **Algorithme explicite** : `alg` doit valoir exactement `HS256`. Sont
  refusés `none`, `HS384`, `HS512` (même signés avec la bonne clé), `RS256`,
  `ES256`, `hs256`, ainsi qu'un `typ` autre que `JWT` et tout `crit`.
- **Forme stricte** : trois segments base64url **canoniques** (sans
  remplissage, bits de bourrage nuls), 4 096 caractères au plus.
- **Temps** : `exp` et `nbf` sont appliqués **s'ils existent** (tolérance de
  30 s, choix local). `exp`, `nbf` et `iat` doivent être numériques s'ils
  sont présents. Sans `exp`, un jeton ancien reste valide : rien ne
  documente une durée de vie, et le rejeu est neutralisé par le rôle de
  simple déclencheur (§ 4).
- **JWT de connexion** : signé avec `JWT_SECRET`, il échoue sur la
  signature (unitaire et e2e, avec un vrai `access_token` issu de
  `/auth/login`). Inversement, une signature webhook présentée comme
  `Bearer` sur une route propriétaire donne 401.

### 3.3 Concordance et champs non protégés

Si un claim porte le nom d'un **champ documenté**, le paramètre reçu doit
exister et lui être égal. Pour `reference` (UUID), la comparaison ignore la
casse ; un nombre et sa forme en chaîne sont considérés égaux (`3000` et
`"3000"`). Un claim inexploitable (objet, tableau) entraîne un refus. Toute
discordance donne 401.

**Non protégés** : tous les paramètres absents des claims. Avec les seuls
éléments documentés, il faut supposer que **c'est le cas de tous**, y
compris `status`, `amount`, `reference` et `external_reference`. C'est
pourquoi aucun d'eux ne sert de preuve.

### 3.4 Validation des paramètres

| Règle | Valeur |
|---|---|
| Source unique | GET : query seule, corps interdit. POST : JSON seul, query interdite |
| Type de contenu POST | `application/json` |
| Doublons | GET : valeur tableau refusée. POST : clés de premier niveau relues sur le **corps brut** (`req.rawBody`), doublons refusés, y compris via une séquence d'échappement (`reference`) ; et nombre de clés brutes égal à celui de l'objet analysé (double contrôle) |
| Clés | `^[a-z_]{1,64}$` : `reference[]`, `Reference` et `a.b` sont refusées ; les clés inconnues bien formées sont ignorées |
| Bornes | URL ≤ 8 Kio ; corps POST ≤ 8 Kio (413) ; 40 clés au plus ; valeurs ≤ 512 caractères ; signature ≤ 4 096 |
| Types | GET : chaînes. POST : chaîne, nombre fini ou `null` ; objet, tableau et booléen refusés |
| Champs exploités | `signature` : chaîne non vide ; `reference` : UUID ; `endpoint` et `external_reference` : chaînes |
| Indice marchand | `external_reference` n'est retenu que s'il a la forme exacte d'une référence 1-14D.2B (`SM` + 24 hexadécimaux **majuscules**). Il n'est **jamais** une preuve (§ 4) |

`rawBody: true` est ajouté au bootstrap (`main.ts`). Nest conserve alors
le corps brut des requêtes JSON et urlencoded, dans la limite par défaut des
parseurs (100 Kio). Aucune autre route ne le lit. Sans corps brut, un POST
est refusé (échec fermé).

### 3.5 Réponses (contrat local, non garanti par CamPay)

| Cas | Statut | Corps |
|---|---|---|
| Traité (quel que soit l'état final), rejeu, inconnu, `endpoint` ≠ `collect` | 200 | `{ "received": true }` |
| Désactivé | 503 | `PAYMENT_WEBHOOK_DISABLED` |
| Paramètres invalides | 400 | `PAYMENT_WEBHOOK_INVALID` |
| Trop volumineux | 413 | `PAYMENT_WEBHOOK_TOO_LARGE` |
| Signature ou concordance | 401 | `PAYMENT_WEBHOOK_UNAUTHORIZED` |
| Temporaire : statut CamPay indisponible, budget HTTP ou de confirmation épuisé, contention, notification précoce, base indisponible | 503 + `Retry-After: 60` | `PAYMENT_WEBHOOK_RETRY_LATER` |
| Limitation | 429 + `Retry-After` | `PAYMENT_WEBHOOK_RATE_LIMITED` |

Toutes les réponses portent `Cache-Control: no-store`, et aucune ne contient
d'état de paiement ni de donnée reçue.

### 3.6 Confidentialité

- **Aucune journalisation** dans le webhook (aucun `Logger`, aucun
  `console`) ; les erreurs inattendues donnent 503 sans détail. Les e2e
  vérifient qu'aucun appel console ne contient la clé webhook, une
  signature envoyée, le téléphone ou le jeton CamPay.
- **Défaut corrigé** : le filtre global (`HttpExceptionFilter`) renvoyait
  `path: request.url`. Un refus du webhook en GET (par exemple un 429)
  aurait donc recopié dans la réponse la query complète : signature,
  téléphone et URL de redirection. Pour les routes `/payments/webhooks/`, il
  ne renvoie désormais que le chemin, et pose `no-store`. Les autres routes
  sont inchangées.
- **Complément (variantes de chemin, JSON malformé)** : voir § 3.8.

### 3.7 Limitation dédiée

- Fenêtre `payment-webhook` dans le `ThrottlerModule.forRoot()` **unique** :
  60 requêtes par 60 s, blocage de 60 s. Le tracker est celui **par défaut**
  de `@nestjs/throttler` 6.7, `normalizeIp(req.ip)`, c'est-à-dire l'adresse
  calculée par Express selon `trust proxy` (0B.6, D.2E). Aucun en-tête de
  transfert n'est lu.
- Elle est évaluée par une garde de contrôleur : **après les parseurs HTTP**
  de l'application (le corps JSON ou urlencoded est déjà lu et analysé par
  les middlewares Nest, dans la limite de 100 Kio, et un corps malformé est
  rejeté à ce stade, sans consommer le quota), mais **avant le traitement
  métier** du handler : validation des paramètres, signature, base et
  prestataire.
- **Défaut corrigé (trouvé par l'e2e)** : la clé de stockage par défaut
  inclut le nom du handler, si bien que GET et POST avaient chacun leur
  compteur (limite effective doublée). `generateKey` est surchargée en
  `payment-webhook:<adresse>`.
- Exclusions symétriques : `SKIP_PAYMENT_THROTTLERS` (auth, invitations)
  inclut la nouvelle fenêtre, ainsi que les exclusions du contrôleur
  propriétaire. Le webhook exclut toutes les autres fenêtres.
- Les routes propriétaire conservent leurs gardes et leurs limites.

### 3.8 Variantes de chemin et erreurs des parseurs (complément)

Vérifié avec les options de bootstrap de `main.ts` (`API_APPLICATION_OPTIONS`)
et le filtre global réellement utilisé (`HttpExceptionFilter`), dans
l'application de test activée et dans la configuration de production.

| Vérification | Constat avant correction | Correction |
|---|---|---|
| `/PAYMENTS/WEBHOOKS/CAMPAY` et `/Payments/Webhooks/Campay/` | Le routeur Express est **insensible à la casse** et tolère le slash final : ces chemins atteignent le webhook. Les réponses écrites par le contrôleur (401, 503) étaient propres. Mais la détection du filtre (`startsWith('/payments/webhooks/')`) tenait compte de la casse : le **429** de la garde **recopiait toute la query** (signature et téléphone factices, référence marchand). **Reproduit** | `isPaymentWebhookPath` compare en minuscules, comme le routeur. **Le routage n'est pas modifié** : sa sensibilité à la casse reste celle d'Express pour toutes les routes |
| `/payments/webhooks/campay/` (slash final, minuscules) | Déjà propre (401, 503, 429) | — |
| JSON malformé (tronqué, virgule manquante, jeton nu, premier caractère, déchet final), rejeté par `express.json` **avant le contrôleur** | Nest convertit la `SyntaxError` du parseur en `BadRequestException(err.message)`, transmise au filtre global. Le message V8 **cite un extrait du corps** (ex. `Unexpected token 'B', ..."ignature":BODYSECRET"... is not valid JSON`). Sur les variantes en majuscules, `no-store` était également absent. **Reproduit** (e2e, et sonde Nest minimale avec les mêmes options et le même filtre) | Pour les routes de notification, le filtre ne reprend un message **que s'il porte un code `PAYMENT_WEBHOOK_*`** (messages génériques du webhook) ; sinon, message générique selon le statut (400 : « Notification de paiement invalide. »). Aucun champ supplémentaire n'est recopié |
| Journaux | Aucun appel console contenant un marqueur (le filtre traite l'exception, sans journal) | — |

Les autres routes gardent exactement la réponse précédente (`message`,
champs supplémentaires, `path: request.url`).

Non couvert par ce complément : un corps de plus de 100 Kio est refusé par
le parseur (`PayloadTooLargeError`, qui n'est pas une `HttpException`)
et passe par le filtre par défaut de Nest, dont le message fixe ne contient
aucune donnée reçue. Ce cas n'a pas été testé.

## 4. Traitement : un déclencheur, jamais une preuve

1. Le paiement est retrouvé **uniquement** par sa référence CamPay
   **persistée** (`{ provider: 'campay', providerReference }`, index unique
   1-14D.2B), en lecture seule.
2. `confirmPayment(paymentId)` est le moteur **unique** de 1-14D.2B. Le
   statut y est relu par l'adaptateur (`GET /api/transaction/{reference}/`,
   budget HTTP de 10 s), puis soumis à la concordance exacte (référence
   marchand, référence CamPay, montant brut validé lexicalement en D.2D,
   devise), à l'attribution atomique dans `runInGrantTransaction` (budget de
   30 s, aucun réseau dans la transaction) et aux règles inchangées de
   `uncertain` et `review`.
3. Le statut, le montant, la devise et les références **annoncés** par le
   callback ne sont **jamais** utilisés. Un callback « SUCCESSFUL » alors
   que CamPay répond `PENDING` n'attribue rien. Un callback « FAILED » ne
   déclare jamais l'échec : seul le statut relu peut le faire.
4. **Callback inconnu** : accusé 200, sans création de paiement, de collecte
   ni de référence, et sans appel CamPay.
5. **Callback précoce** (arrivé avant l'enregistrement de la réponse
   d'initiation) : si l'indice `external_reference`, non prouvé, désigne un
   paiement CamPay encore `initiating` sans référence, la réponse est
   **503 temporaire**, sans aucune écriture. L'indice ne sert qu'à choisir
   la réponse ; aucune référence n'est adoptée.
6. Une réponse temporaire ne modifie jamais l'état : jamais `failed`,
   jamais de nouvelle collecte. Les reprises restent possibles, par une
   nouvelle notification ou par une vérification manuelle par le
   propriétaire.

### Limites de récupération (aucune reprise CamPay supposée)

- Si CamPay ne renvoie pas une notification précoce, le paiement passe
  `pending` dès l'enregistrement de la réponse d'initiation. Une
  **vérification manuelle par le propriétaire** (l'interface D.2C ne fait
  aucun polling automatique) le confirme ensuite.
- Si l'initiation devient `uncertain` (réponse perdue), la notification
  **ne lève pas** l'incertitude. Elle porte peut-être la référence CamPay,
  mais l'adopter reviendrait à créer une référence à partir d'un callback,
  ce qui est exclu. Le paiement reste bloqué jusqu'à un traitement
  opérateur (§ 7).
- Sans indice marchand bien formé, un callback précoce est
  indiscernable d'un inconnu : il reçoit 200, et seule une vérification
  manuelle par le propriétaire récupère le paiement.

## 5. Tests

### 5.1 Contrat CamPay ou simulation interne

| Catégorie | Ce qui est exercé |
|---|---|
| **Contrat CamPay** (documenté) | `signature` = JWT HS256 vérifié avec la clé webhook. Signature produite par une **implémentation indépendante** (`jsonwebtoken` via `JwtService`), avec les en-têtes des exemples officiels (`app`, `uid`) et des claims `iat`/`nbf`/`exp`. Notification GET avec les paramètres de l'exemple officiel, et POST JSON avec les mêmes champs |
| **Simulations internes** | Faux transport CamPay (statuts officiels de D.2D), barrières, horloges monotones décalables, fautes injectées, bornes, réponses, tolérance d'horloge, détection des doublons, limitation. Ces tests **ne prouvent pas** le comportement réel de CamPay : réponse attendue, reprises, claims réels |

Clés, jetons, références et téléphone sont **fictifs**.

### 5.2 Fichiers

- [campay-webhook.spec.ts](../../api/src/subscriptions/payments/campay/campay-webhook.spec.ts), 26 tests :
  - **signature** : accepte une implémentation indépendante ; refuse une
    mauvaise clé, un contenu ou un en-tête falsifié, une signature
    tronquée, `alg: none`, HS384, HS512, RS256, ES256, `hs256`, un JWT de
    connexion, une forme non canonique (bits de bourrage, remplissage,
    `+`), un `typ` ou un `crit`, un contenu non objet et des claims
    temporels mal typés ; `exp`/`nbf` à la limite de la tolérance ;
    absence de durée maximale ;
  - **concordance** : liste vide sans claim de transaction, égalité
    exacte, discordances, claim absent côté paramètres ;
  - **paramètres** : exemple officiel GET, POST avec nombres et `null`,
    doublons GET et POST (dont l'échappement), clés non canoniques,
    objets imbriqués, champs obligatoires, bornes, sources concurrentes,
    type de contenu, corps brut absent, corps trop gros,
    `topLevelJsonKeys` ;
  - **configuration** : clé refusée (dont l'égalité avec `JWT_SECRET`,
    message sans la clé), module désactivé, aucune variable
    d'environnement ; désactivé sans lecture ni dépendance ; signature
    vérifiée **avant** la base.
- [campay-webhook.e2e-spec.ts](../../api/test/campay-webhook.e2e-spec.ts),
  32 tests : application réelle avec les options de `main.ts`, adaptateur
  CamPay réel sur faux transport, replica set éphémère, webhook activé par
  injection :
  - **authentification** : signature absente, vide, contenu falsifié,
    signature modifiée, mauvaise clé, HS384, expirée, en GET et en POST ;
    JWT de connexion ; claims discordants puis concordants ;
  - **paramètres** : query dupliquée, clé JSON dupliquée, types,
    opérateur `$ne`, UUID invalide, POST avec query, urlencoded, corps et
    URL surdimensionnés ;
  - **traitement** : succès vérifié (une période, rejeux GET et POST sans
    appel) ; SUCCESSFUL ou FAILED annoncés alors que CamPay reste PENDING ;
    discordances réelles de montant, montant décimal, devise, référence
    marchand et référence CamPay (`review`) ; callback inconnu ; retrait ;
    callback **précoce** à barrière (503, aucune écriture, puis traitement
    normal) ; `uncertain` non adopté ;
  - **concurrence et reprises** : webhook contre vérification manuelle par le propriétaire (route `refresh`) à
    barrière ; trois notifications concurrentes ; notification tardive
    après succès ; prestataire indisponible (transport, HTTP 500) puis
    succès ; **budget HTTP de l'adaptateur** épuisé (consultation
    réellement annulée) puis succès ; **budget de confirmation de 30 s**
    épuisé puis une seule période ; **commit validé retrouvé** sans
    seconde attribution ni appel ;
  - **limitation** : 60 requêtes puis 429 sur GET **et** POST, sans effet
    de `X-Forwarded-For` ni de `X-Real-IP`, aucun appel CamPay, réponse
    sans query ; routes propriétaire indépendantes et contrôles d'accès
    inchangés ;
  - **complément** (§ 3.8) : trois variantes de chemin
    (`/PAYMENTS/WEBHOOKS/CAMPAY`, slash final, casse mixte), chacune en 401,
    503 temporaire et 429, avec signature et téléphone factices en query ;
    cinq JSON malformés sur deux variantes. Le texte **brut** de chaque
    réponse ne contient ni marqueur, ni fragment (`BODYSEC`, `ignature`,
    `699000`), ni `?` ; `no-store` présent ; journaux sans marqueur.
- [subscription-payments-default-provider.e2e-spec.ts](../../api/test/subscription-payments-default-provider.e2e-spec.ts),
  +2 tests, configuration de production : webhook désactivé, GET et POST
  avec query, en-tête et variables d'environnement forcés, 503 sans
  `findOne`, `findById` ni `fetchStatus`, document inchangé ; variantes de
  chemin (503 désactivé) et JSON malformé (400 générique), sans marqueur
  dans les réponses ni les journaux. Les options de bootstrap de `main.ts`
  y sont désormais appliquées.
- Modifiés :
  - [campay-payment-provider.spec.ts](../../api/src/subscriptions/payments/campay/campay-payment-provider.spec.ts) :
    le garde-fou « aucun import hors de `campay/` » visait **tout** module
    `campay`. Il cible désormais l'**adaptateur** et son **transport**,
    son intention réelle, puisque le webhook inactif doit être enregistré
    par `SubscriptionsModule`. Un test ajouté vérifie que le webhook
    n'importe ni l'un ni l'autre ;
  - [subscription-access-routes.spec.ts](../../api/src/subscriptions/subscription-access-routes.spec.ts) :
    les deux routes publiques sont ajoutées à la matrice.

### 5.3 Tests de mutation (manuels, code restauré)

| Mutation | Détectée par |
|---|---|
| HMAC non comparé | 3 tests unitaires |
| `alg` non contrôlé | 2 tests unitaires |
| `exp` ignoré | 1 test unitaire |
| Contrôle des doublons JSON retiré | **Survit seul** : le second contrôle (nombre de clés) les détecte aussi. Les deux retirés : 1 test unitaire |
| Clé de throttling par handler (défaut de la bibliothèque) | e2e « limite » |
| Indice marchand en minuscules | e2e « callback précoce » |

## 6. Résultats

Exécutés le 2026-10-03, sur le replica set éphémère et de faux transports
uniquement. Le filtre global ayant changé (§ 3.8), tous les contrôles API
ont été **relancés** après le complément ; les chiffres ci-dessous sont
ceux de cette dernière exécution.

| Contrôle | Commande | Résultat |
|---|---|---|
| Unitaires ciblés | `npx jest src/subscriptions/payments/campay src/subscriptions/subscription-access-routes.spec.ts` | **139/139** : `campay-webhook.spec.ts` 26, adaptateur 107 (dont 1 nouveau), matrice des routes 6 |
| E2E ciblés | `npx jest --config ./test/jest-e2e.json --maxWorkers=1 test/campay-webhook.e2e-spec.ts test/subscription-payments-default-provider.e2e-spec.ts` | **2 suites, 36 tests** (32 + 4), sortie propre sans `--forceExit` |
| Build API | `pnpm --filter api build` | Réussi |
| Typage de production | `npx tsc --noEmit -p tsconfig.build.json` | Code 0 |
| Unitaires API complets | `npx jest` | **68 suites, 1 295 tests verts** |
| E2E API complets | `npx jest --config ./test/jest-e2e.json --maxWorkers=1` | **22 suites, 524 tests verts** (220 s) |
| ESLint API, sans `--fix` | `npx eslint "{src,test}/**/*.ts"` | 0 erreur ; 2 avertissements **préexistants** (`test/app.e2e-spec.ts`, `test/e2e/ephemeral-mongodb.ts`) |
| `git diff --check` | suivis et nouveaux fichiers | Aucune erreur |

`tsc -p tsconfig.json` (specs comprises) signale toujours des erreurs
**préexistantes** dans des specs non modifiés (D.2B § 8). Aucune ne
provient des fichiers de ce lot. Prettier a été appliqué aux seuls
fichiers du lot.

### Défauts constatés

**Applicatifs (corrigés)**

1. Réponse d'erreur recopiant la query du webhook (`path: request.url`),
   trouvée à la relecture du filtre global (§ 3.6).
2. Indice marchand attendu en minuscules, alors que `merchantReferenceFor`
   produit des majuscules : un callback précoce aurait reçu 200 au lieu
   de 503 (trouvé par l'e2e).
3. Compteur de limitation distinct pour GET et POST (trouvé par l'e2e).
4. **Complément** : query recopiée par le 429 sur les variantes de chemin
   en majuscules (détection du filtre sensible à la casse, contrairement au
   routeur). Reproduit par l'e2e (2 variantes sur 3 en échec).
5. **Complément** : extrait du corps JSON malformé dans le message d'erreur
   (message du parseur), et `no-store` absent sur les variantes en
   majuscules. Reproduit par l'e2e (5 cas) et une sonde Nest minimale.

**Tests (corrigés, aucune assertion affaiblie)**

- `jsonwebtoken` retire `iat` avec `noTimestamp` : l'option n'est
  appliquée que si le contenu n'a pas d'`iat`.
- `jest.restoreAllMocks()` effaçait les appels console avant leur
  vérification : l'ordre est inversé.
- La barrière du test précoce attendait par `setImmediate` (trop court) et
  pouvait laisser une requête suspendue, d'où un `afterAll` bloqué : attente
  bornée dans le temps et libération garantie (`finally`).
- L'en-tête `app` des exemples officiels, absent du type `JwtHeader`, passe
  par un objet typé dans l'e2e.
- Remarques ESLint `unbound-method` sur les mocks : mocks séparés.
- Complément : le premier contrôle ne cherchait que le marqueur **complet**,
  alors que le message V8 le tronque. Les fragments (`BODYSEC`,
  `ignature`, `699000`) sont désormais contrôlés.

## 7. Prérequis d'activation encore ouverts

1. **Confirmation écrite de CamPay** sur : les claims de la signature
   (champs de transaction signés ou non, `exp`), la réponse attendue
   (statut et corps), la politique de reprise (nombre, délais, statuts
   déclenchant une reprise), les adresses sources, les types JSON en POST
   et un **exemple réel signé** sur le compte de démonstration. Sans ces
   éléments, le webhook n'est pas déclaré compatible.
2. **Railway** (D.2E.1, **non vérifié**) : sans réglage `trust proxy`
   validé, `req.ip` vaut l'adresse de l'edge, et **toutes les notifications
   partagent le compteur `payment-webhook`**. Un tiers pourrait l'épuiser et
   retarder les notifications légitimes (sans effet sur les paiements :
   la vérification manuelle par le propriétaire reste disponible). Aucune liste d'adresses CamPay ne peut
   être appliquée sans adresses documentées et sans `req.ip` fiable.
3. **Journalisation des signatures par les proxys** : en GET, la signature,
   le téléphone, l'e-mail et les URL de redirection figurent dans l'URL,
   donc potentiellement dans les journaux d'accès de l'edge Railway, d'un
   CDN, de nginx (`docker-compose.prod.yml`) ou d'outils d'observabilité.
   **Configurer l'application CamPay en POST**, vérifier les journaux de
   chaque proxy, et considérer toute signature journalisée comme
   rejouable (déclencheur seulement, mais quota consommé).
4. **`external_reference`** (D.2D § 8) : CamPay pourrait exiger un UUID4,
   alors que la référence marchand vaut `SM` + 24 hexadécimaux. Si elle
   évolue, adapter l'indice du callback précoce (`MERCHANT_REFERENCE`).
5. **Récupération des paiements `uncertain`** : réconciliation (par
   exemple via `/api/history/`, si le rapprochement est confirmé) ou
   procédure et outil opérateur ; le webhook ne lève pas l'incertitude.
6. **Traitement opérateur** des paiements `review`.
7. **Clé webhook** fournie par un secret d'environnement, sans valeur par
   défaut et distincte de `JWT_SECRET`, puis **câblage de production
   explicite et revu** de `CAMPAY_WEBHOOK_CONFIG` et de `PAYMENT_PROVIDER`.
   Ce lot ne l'introduit pas.
8. Stockage de limitation partagé avant toute réplication horizontale
   (limite connue depuis 0B.6).

## 8. Procédure locale reproductible

Depuis `api/`, avec Node 22 et les dépendances déjà installées (aucune
installation requise) :

```bash
pnpm --filter api build
npx jest src/subscriptions/payments/campay/campay-webhook.spec.ts
npx jest --config ./test/jest-e2e.json --maxWorkers=1 \
  test/campay-webhook.e2e-spec.ts test/subscription-payments-default-provider.e2e-spec.ts
```

Les e2e démarrent un replica set MongoDB éphémère (`MongoMemoryReplSet`,
garde anti-27017). Aucune variable d'environnement réelle, aucun réseau
CamPay. Pour signer une notification de test à la main (clé fictive) :

```js
const { JwtService } = require('@nestjs/jwt');
const now = Math.floor(Date.now() / 1000);
new JwtService().sign(
  { iat: now, nbf: now, exp: now + 3600 },
  { secret: '<clé webhook FICTIVE ≥ 16 caractères>', algorithm: 'HS256' },
);
```

Le webhook reste désactivé dans toute application démarrée par `main.ts`.

## 9. Limites

- Le contrat est partiel (§ 1.3) : les choix de réponse et la tolérance
  d'horloge sont locaux.
- Sans claim `exp`, une signature capturée reste rejouable. Elle ne peut
  que redéclencher une vérification idempotente, mais consomme le quota.
- Le corps brut est conservé pour toutes les requêtes JSON et urlencoded
  (au plus 100 Kio chacune) ; seul le webhook le lit.
- La concordance des claims compare des formes canoniques simples. Une
  sémantique CamPay plus riche (montant décimal en chaîne, par exemple)
  serait refusée par prudence (401).
- La détection des doublons POST relit le texte JSON avec un analyseur de
  premier niveau (objets plats attendus).

## 10. Fichiers

Nouveaux :

| Fichier | Rôle |
|---|---|
| `api/src/subscriptions/payments/campay/campay-webhook-signature.ts` | Signature HS256, temps, concordance |
| `api/src/subscriptions/payments/campay/campay-webhook-payload.ts` | Paramètres stricts |
| `api/src/subscriptions/payments/campay/campay-webhook.config.ts` | Configuration désactivée, contrôle de la clé |
| `api/src/subscriptions/payments/campay/campay-webhook.service.ts` | Orchestration |
| `api/src/subscriptions/payments/campay/campay-webhook.controller.ts` | Routes GET/POST |
| `api/src/subscriptions/payments/campay/campay-provider-name.ts` | Nom du fournisseur |
| `api/src/subscriptions/payments/campay/campay-webhook.spec.ts` | 26 tests unitaires |
| `api/src/subscriptions/payments/payment-webhook-paths.ts` | Préfixe des routes de notification, détection insensible à la casse, messages génériques |
| `api/src/common/application-options.ts` | `rawBody` partagé |
| `api/test/campay-webhook.e2e-spec.ts` | 32 tests e2e |
| `docs/architecture/phase-1-14d2f-campay-webhook.md` | Ce document |

Modifiés :

| Fichier | Nature |
|---|---|
| `api/src/main.ts` | `NestFactory.create(AppModule, API_APPLICATION_OPTIONS)` |
| `api/src/common/filters/http-exception.filter.ts` | Routes de notification (toute casse) : chemin sans query, `no-store`, message seulement s'il est propre au webhook |
| `api/src/common/subscription-payment-rate-limiting.ts` | Fenêtre `payment-webhook`, exclusion, `PaymentWebhookThrottlerGuard` |
| `api/src/subscriptions/subscriptions.module.ts` | Contrôleur, service, garde, configuration désactivée |
| `api/src/subscriptions/payments/subscription-payments.service.ts` | `locateProviderNotification` (lecture seule) ; commentaire |
| `api/src/subscriptions/payments/subscription-payments.controller.ts` | Exclusion de la fenêtre `payment-webhook` |
| `api/src/subscriptions/payments/campay/campay-payment-provider.ts` | `name = CAMPAY_PROVIDER_NAME` (même valeur `campay`) |
| `api/src/subscriptions/payments/campay/campay-payment-provider.spec.ts` | Garde-fou ciblé sur l'adaptateur et le transport ; test du webhook |
| `api/src/subscriptions/subscription-access-routes.spec.ts` | Deux routes publiques |
| `api/test/subscription-payments-default-provider.e2e-spec.ts` | Options de `main.ts` ; 2 tests du webhook désactivé |

Inchangés : le contrat `PaymentProvider`, le moteur de confirmation (hors
ajout de la lecture), les migrations et index, `package.json`, le lockfile,
le frontend, Docker, nginx, les `.env` et la configuration Railway.
