# Phase 1-14D.2D — Adaptateur CamPay sans activation réelle

Branche : `architecture/phase-1-14d2d-campay-adapter`
Base : `be2b415` (1-14D.2C). Rapports préalables :
[1-14D.1](phase-1-14d1-payment-provider-audit.md),
[1-14D.2B](phase-1-14d2b-subscription-payments.md).

Lot **serveur uniquement** : adaptateur et tests HTTP simulés. Il n'y a eu
aucun commit, push, déploiement, paiement, email ni appel authentifié à
CamPay. Aucun package n'a été ajouté et le lockfile n'a pas changé. Le
frontend, Docker, nginx et les migrations sont inchangés. Je n'ai lu la
valeur d'aucun `.env`.

> **Le fournisseur de production reste `UnavailablePaymentProvider`.**
> `CamPayPaymentProvider` n'est injecté par aucun module. Aucune variable,
> route, corps ni en-tête ne le sélectionne. Un test vérifie que
> `SubscriptionsModule` enregistre toujours le fournisseur indisponible, et
> qu'aucun fichier de production hors de `campay/` n'importe l'adaptateur.

Hors périmètre : webhook, réconciliation, outils opérateur, retraits,
remboursements et documents commerciaux.

### Changement préexistant identifié

`web/src/components/subscription/subscription-payment-panel.tsx` était
modifié dans l'arbre de travail **avant** ce lot : un second bloc
`payment-message` est ajouté après le formulaire. Il est hors périmètre,
préservé et ni lu ni modifié au-delà de son identification.

---

## 1. Sources officielles (consultées le 2026-10-02)

| Source | Version | Usage |
|---|---|---|
| Documentation HTTP liée par [campay.net](https://www.campay.net/en/) : [collection Postman « CamPay API »](https://documenter.getpostman.com/view/2391374/T1LV8PVA) | JSON public de la collection téléchargé (`documenter.gw.postman.com/api/collections/2391374/T1LV8PVA`) | Endpoints, corps, exemples de réponses, codes d'erreur |
| [SDK Python officiel](https://github.com/CamPay/campay-python-sdk) | `src/campay/sdk.py`, commit `268868443d` (2026-01-08) | Origines `DEV`/`PROD`, forme des requêtes, traitement des erreurs |

Aucun domaine CamPay n'a été contacté, y compris `demo.campay.net`. Le SDK
n'a été ni installé ni copié.

## 2. Contrat vérifié

| Élément | Constat officiel | Usage dans l'adaptateur |
|---|---|---|
| Origines | SDK : `https://demo.campay.net` (`DEV`), `https://www.campay.net` (`PROD`) | Constantes `CAMPAY_ORIGINS` ; environnement `demo` ou `production` ; jamais une URL fournie par un client |
| Authentification | `POST /api/token/` `{ username, password }` → `200 { token, expires_in }`, `expires_in` **en secondes** (exemple : 3600). Jeton à placer dans `Authorization: Token <token>`. Un « permanent access token » existe aussi | Jeton temporaire, gardé **en mémoire** jusqu'à `expires_in − 60 s`. Il est oublié après un 401. Le jeton permanent n'est pas utilisé |
| Initiation | `POST /api/collect/` `{ amount: "entier", currency: "XAF", from: "2376…", description, external_reference }` → `200 { reference (UUID4), ussd_code, operator }`. « When you initiate a transaction, the default status is PENDING » | Une réponse 200 avec une `reference` UUID donne `accepted` : **collecte créée et en attente, jamais un succès** |
| Statut | `GET /api/transaction/{reference}/` avec la **référence CamPay** → `{ reference, external_reference, status: PENDING / SUCCESSFUL / FAILED, amount (ex. 2.0), currency, operator, code, operator_reference, description, external_user, reason, phone_number, endpoint }` | Consultation uniquement par la référence CamPay |
| Non-blocage | `initCollect` (SDK) renvoie la réponse de `/collect/`, alors que `collect` et `disburse` **sondent le statut en boucle** (`time.sleep(3)`) | Seule l'initiation non bloquante est reproduite ; aucun sondage |
| Erreurs | Collection : codes `ER101` (téléphone invalide), `ER102` (opérateur non supporté), `ER201` (montant décimal), `ER301` (solde, retraits). SDK : un statut HTTP différent de 200 donne `FAILED` avec le champ `message`. | Voir § 4 : la **structure** des corps d'erreur n'est pas documentée |

### Non confirmé, donc non utilisé

1. **Récupération par `external_reference`** : aucun endpoint documenté.
   `/api/history/` renvoie `reference_uuid` mais pas `external_reference`.
   Donc `supportsMerchantReferenceLookup = false`, et notre référence
   marchand n'est **jamais** transmise à `/api/transaction/`.
2. **Garantie d'idempotence** : la documentation de `/collect/` se
   contredit. D'un côté : « idempotency on external_reference … you will get
   the results of the first request ». De l'autre, juste après : « A valid
   and unique UUID4 … A request with a duplicate UUID will be rejected ».
   Donc `idempotentInitiation = false`, et l'adaptateur ne relance jamais
   une collecte.
3. **Format d'`external_reference`** : la même phrase évoque un UUID4.
   Notre référence marchand persistée (1-14D.2B) vaut `SM` suivi de 24
   caractères hexadécimaux, ce qui **n'est pas un UUID4**. L'adaptateur
   transmet la référence persistée, comme exigé. Si CamPay exigeait un
   UUID4, chaque initiation serait refusée, puis classée **incertaine**
   (§ 4) : rien n'est activé à tort, mais le parcours serait inutilisable.
   **Bloquant avant activation** (§ 8).
4. **Structure des corps d'erreur** : où figurent les codes `ER1xx`, et
   quels statuts HTTP sont utilisés ? Rien ne prouve qu'un refus garantit
   l'absence de collecte. **Aucun refus n'est donc tenu pour définitif**.
5. **Statuts autres** que `PENDING`, `SUCCESSFUL` ou `FAILED` (expiration,
   annulation) : non documentés, donc considérés comme inconnus.
6. Format exact du **montant renvoyé** : l'exemple montre `2.0`, soit un
   nombre JSON. La documentation de la requête accepte « integer or
   string ».

## 3. Adaptateur

[campay-payment-provider.ts](../../api/src/subscriptions/payments/campay/campay-payment-provider.ts),
[campay-transport.ts](../../api/src/subscriptions/payments/campay/campay-transport.ts)

- `new CamPayPaymentProvider({ environment, username, password, transport?, monotonic? })`.
  Aucun appel réseau à la construction. Identifiants **explicites**, sans
  valeur par défaut, refusés s'ils sont vides. Ils sont conservés dans des
  champs privés `#`, invisibles à `JSON.stringify` et à `Object.keys`.
- Transport de production : `fetch` natif de Node 22, la même version qu'en
  production (`node:22.17.1`), selon la convention de `ResendEmailSender`.
  Les redirections sont refusées (`redirect: 'error'`) et l'annulation se
  fait par `AbortSignal`. Le corps de réponse est borné à 64 Kio. En test,
  le transport est injecté.
- Initiation : montant **figé** envoyé en chaîne d'entier, téléphone
  normalisé (`237` + 9 chiffres), référence marchand **persistée avant
  l'appel** (1-14D.2B), description de 1-14D.2B. Avant tout appel, un
  montant non entier ou hors de la plage sûre, une devise autre que XAF ou
  un téléphone non normalisé donnent « indisponible », sans aucun appel.
- Rien n'est journalisé. Les erreurs ont des messages génériques ; les
  objets d'erreur HTTP bruts ne sont jamais propagés.

## 4. Délais et classification des erreurs

### Budget de 10 s par méthode

`initiate` et `fetchStatus` ont chacune une **échéance unique** de
`CAMPAY_CALL_BUDGET_MS = 10 000 ms`, calculée sur l'horloge monotone
injectable. Elle couvre l'authentification **et** l'appel métier.

- Chaque appel HTTP reçoit uniquement le **temps restant** : un
  `setTimeout(remaining)` déclenche `AbortController.abort()`, ce qui annule
  réellement la requête undici. Ce n'est pas un `Promise.race`.
- S'il reste moins d'une milliseconde avant la collecte, elle n'est pas
  envoyée.
- **Aucun retry**, ni de collecte ni de jeton.
- **Annuler côté client ne prouve pas que CamPay n'a pas exécuté la
  collecte** : une collecte annulée est classée **incertaine**.

### Initiation

| Situation | Classe | Résultat 1-14D.2B |
|---|---|---|
| Demande locale invalide | Collecte non envoyée | `PaymentProviderUnavailableError` → paiement `failed` (`provider_unavailable`), 503 |
| Échec ou expiration de l'authentification (non-200, transport, corps illisible, jeton absent) | Collecte **non envoyée** | idem |
| Budget épuisé avant la collecte | Non envoyée | idem |
| Transport `not-sent` (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `UND_ERR_CONNECT_TIMEOUT`) | Non envoyée | idem |
| Collecte envoyée puis annulation à l'échéance, connexion réinitialisée, redirection, corps illisible, erreur inconnue | **Incertaine** | `PaymentProviderUncertainError` → `uncertain`, même référence, collecte bloquée |
| Collecte : HTTP différent de 200 (dont 400 avec `ER1xx`, 401, 5xx) | **Incertaine** (aucune preuve officielle d'absence de collecte) | idem ; après un 401, le jeton est oublié |
| Collecte : 200 sans `reference` UUID ou illisible | **Incertaine** | idem |
| Collecte : 200 avec `reference` UUID | `accepted` (référence en minuscules) | `pending`, **aucune attribution** |

`rejected`, le refus définitif, n'est jamais produit dans ce lot (§ 2,
point 4).

### Consultation

Toute erreur lève `CamPayStatusUnavailableError`, qui devient
`503 PAYMENT_STATUS_UNAVAILABLE` : **aucune activation, état conservé**.
C'est le cas pour une recherche par référence marchand (refusée **sans
appel**), une référence CamPay non UUID (aucun appel, pas d'injection de
chemin), une authentification impossible, un transport en échec ou annulé,
un HTTP différent de 200, un corps qui n'est pas un objet, un `status`
absent ou inconnu (y compris en minuscules ou une clé héritée comme
`toString`), et une `reference` absente ou invalide.

## 5. Statuts et conversions

| CamPay | Interne |
|---|---|
| `PENDING` | `pending` |
| `SUCCESSFUL` | `succeeded` |
| `FAILED` | `failed` |
| autre | indisponible (aucune activation) |

Valeurs **reçues**, jamais complétées par la demande locale :

- `providerReference` : `reference` en minuscules (UUID insensible à la
  casse), la même forme qu'à l'initiation ;
- `merchantReference` : `external_reference`, ou `null` s'il est absent ou
  vide ;
- `currency` : la chaîne reçue, sinon `null` ;
- **montant** (`parseCamPayJson` puis `parseCamPayAmount`), conversion
  **exacte, validée sur la représentation d'origine** :
  - `JSON.parse` convertit chaque nombre JSON en `Number` et **arrondit
    avant tout contrôle** : `3000.0000000000000001` et
    `2999.9999999999999999` deviennent tous deux `3000`, un entier « sûr ».
    Un contrôle d'entier après conversion ne suffit donc pas ;
  - le statut est analysé depuis le **texte** de la réponse. Le reviver de
    `JSON.parse` reçoit en troisième argument le texte source de chaque
    primitive (« JSON.parse source text access », V8 ≥ 11.4 ; disponible
    sous Node 22.17.1, la version de l'image de production). Le littéral
    d'origine du `amount` **de premier niveau** est conservé le temps de
    l'analyse, puis abandonné : il n'est ni stocké, ni journalisé, ni
    renvoyé ;
  - un **nombre JSON** n'est accepté que si son littéral d'origine est un
    entier exact, `/^(0|[1-9]\d*)(?:\.0+)?$/` (chiffres, éventuellement
    suivis de `.0…0`, comme `3000.0` de l'exemple officiel `2.0`). La valeur
    est reconstruite depuis la **partie entière du texte**, puis contrôlée
    dans la plage sûre et comparée à la valeur analysée ;
  - une **chaîne** d'entier décimal canonique (`/^(0|[1-9]\d*)$/`, dans la
    plage sûre) est acceptée, puisque le contrat admet « integer or
    string » ;
  - tout le reste donne `null`, sans arrondi ni troncature : décimal même
    infime (`3000.0000000000000001`, `2999.9999999999999999`, `3000.5`),
    exposant (`3e3`, `30000e-1`), signe (`-0`, `-3000`), zéro de tête,
    espace, au-delà de 2^53 − 1, `"3000.0"` en chaîne, tableau, objet,
    booléen, absent ;
  - **échec fermé** : si le runtime ne fournit pas le texte source, tout
    montant numérique donne `null`, donc `review` et aucune attribution.
    Un test vérifie que le texte source est disponible sous le runtime
    utilisé ;
  - clé `amount` dupliquée : c'est la dernière valeur et **sa** source qui
    comptent (sémantique de `JSON.parse`).

La concordance de 1-14D.2B tranche ensuite. Un montant ou une devise
`null`, une référence marchand ou CamPay discordante, ou un montant
différent du montant figé donnent `review`, sans aucune attribution.

## 6. Confirmation

Elle est inchangée : c'est le moteur **unique** de 1-14D.2B. Le statut est
lu par `fetchStatus` **hors transaction** ; si tout concorde,
`runInGrantTransaction` (budget de 30 s, sans réseau dans le callback)
attribue la période `source: payment`, avec `payment:<id>` et
`grantedBy: payment:campay`, et marque le paiement `succeeded`. Un rejeu ne
fait aucun appel et n'ajoute aucune période. Aucun nouvel accès
d'activation n'a été créé.

---

## 7. Tests

### Ajoutés

- [campay-payment-provider.spec.ts](../../api/src/subscriptions/payments/campay/campay-payment-provider.spec.ts) :
  106 tests sur un **faux transport**, avec horloge monotone et minuteurs
  Jest simulés.
  - **Construction** : aucun appel réseau, capacités désactivées,
    configuration invalide refusée, identifiants invisibles, origines HTTPS.
  - **Authentification** : payload exact, en-tête `Token`, cache jusqu'à
    `expires_in − 60 s` puis renouvellement, `expires_in` absent ou invalide.
  - **Initiation** : payload exact, aucun sondage ; demande invalide sans
    appel ; authentification impossible sans collecte ; `not-sent` donne
    indisponible ; 9 cas après envoi donnent incertain (dont `ER101` et
    `ER102`), sans seconde collecte ; 401.
  - **Budget** : authentification de 4 s, collecte annulée **exactement** à
    6 s (pas à 5,999 s) puis incertaine ; budget consommé par
    l'authentification, donc collecte jamais envoyée ; jeton bloqué annulé
    à 10 s ; consultation annulée au reste du budget.
  - **Statut** : recherche marchand sans appel, référence invalide sans
    appel, 3 statuts officiels avec l'exemple du contrat, champs absents non
    substitués, 8 corps inexploitables, 4 statuts HTTP, **29 littéraux de
    montant bruts** (dont `3000.0000000000000001` et
    `2999.9999999999999999`), montant absent, échec fermé sans texte
    source, disponibilité du texte source, `amount` imbriqué ou dupliqué.
  - **Montants bruts via le transport `fetch` réel** et un serveur HTTP
    local : `3000.0000000000000001` et `2999.9999999999999999` donnent
    `null`, `3000.0` et `3000` donnent `3000`.
  - **Sécurité** : aucun identifiant, jeton ni téléphone dans les erreurs ;
    aucun appel `console.*` pendant tout le fichier.
  - **Transport `fetch` réel**, contre un serveur HTTP **local**
    (127.0.0.1) : redirection refusée, annulation effective d'une requête
    suspendue, connexion refusée classée `not-sent`, classification des
    codes undici.
  - **Production** : `SubscriptionsModule` injecte `UnavailablePaymentProvider` ;
    aucun import de l'adaptateur hors de `campay/`.
- [campay-payment-provider.e2e-spec.ts](../../api/test/campay-payment-provider.e2e-spec.ts) :
  19 tests sur le replica set éphémère. L'adaptateur **réel** y est branché
  sur un faux transport, injecté par `overrideProvider` (test uniquement).
  - Initiation : payload exact, `external_reference` égale à la référence
    **persistée**, `pending` sans période ni consultation.
  - Réponse perdue après collecte : `uncertain`, même référence, rejeu sans
    seconde collecte, 409 sur une nouvelle demande, refresh **sans aucun
    appel CamPay** (pas de fausse récupération).
  - Jeton expiré puis authentification en échec : 503, collecte jamais
    envoyée. Un 400 `ER102` après envoi donne `uncertain`.
  - Succès vérifié : période `payment` atomique, rejeu sans appel ni
    seconde période. `FAILED` donne `failed`, sans période.
  - 6 discordances et une référence CamPay discordante donnent `review`.
  - Statut inconnu, HTTP 500 ou transport en échec donnent 503 avec l'état
    conservé.
  - Aucune donnée sensible dans les réponses publiques ni dans la console.

Les fixtures (identifiants, jetons, références) sont **fictives**.

### Résultats réels

Exécutés le 2026-10-02 (puis réexécutés après la correction de précision
des montants, résultats ci-dessous), uniquement sur le replica set éphémère et sur de
faux transports. Le seul serveur HTTP réel est local (127.0.0.1), pour le
transport `fetch`.

| Contrôle | Commande | Résultat |
|---|---|---|
| Tests ciblés de l'adaptateur | `npx jest src/subscriptions/payments/campay` | **106/106** |
| E2E ciblé | `npx jest --config ./test/jest-e2e.json test/campay-payment-provider.e2e-spec.ts` | **19/19** |
| Build API | `pnpm --filter api build` | Réussi |
| Unitaires API complets | `npx jest` | **66 suites, 1 225 tests verts** |
| E2E API complets | `npx jest --config ./test/jest-e2e.json --maxWorkers=1` | **20 suites, 478 tests verts** (201 s) |
| ESLint API, sans `--fix` | `npx eslint "{src,test}/**/*.ts"` | 0 erreur ; 2 avertissements **préexistants** dans des fichiers non modifiés (`test/app.e2e-spec.ts`, `test/e2e/ephemeral-mongodb.ts`) |
| Typage de production | `npx tsc --noEmit -p tsconfig.build.json` | Code 0 |

Prettier a été appliqué uniquement aux fichiers de ce lot. Aucune
validation web ni Docker n'a été lancée.

### Défauts constatés pendant la mise au point

**Applicatif — précision des montants (corrigé après revue)**

- Défaut signalé en revue : le contrôle « entier sûr » s'appliquait
  **après** `JSON.parse`, qui avait déjà arrondi le littéral. Reproduit :
  avec l'ancienne logique, `3000.0000000000000001` et
  `2999.9999999999999999` donnaient tous deux `3000`. Le moteur de
  1-14D.2B les aurait jugés concordants et aurait attribué une période
  pour 3 000 XAF.
- Correction : validation de la **représentation lexicale d'origine**
  avant conversion (§ 5). Les deux littéraux donnent maintenant `null`,
  donc `review`, sans aucune attribution. `3000.0` reste accepté.
- Nouveaux tests :
  - 29 littéraux bruts en unitaire ;
  - 4 corps bruts via le **transport `fetch` réel** et un **serveur HTTP
    local** ;
  - 3 parcours e2e complets sur la base éphémère (transport réel et
    serveur local, puis moteur de confirmation et registre des périodes) :
    les deux littéraux donnent `review` sans période, `3000.0` donne
    `succeeded` avec une période ; rien de la réponse brute n'est stocké.

**Applicatif (corrigé avant les tests)**

- La référence CamPay devait être normalisée **de la même façon** à
  l'initiation et à la consultation (minuscules), sinon une simple
  différence de casse aurait mis le paiement en `review`.
- La table des statuts acceptait les clés héritées (`status: "toString"`).
  Seules ses clés propres sont désormais acceptées.

**Tests (corrigés, aucune assertion affaiblie)**

- `tokenOk(undefined)` déclenchait la valeur par défaut du paramètre
  (3600) : le corps est maintenant construit sans `expires_in`.
- L'instance partagée de l'e2e gardait le jeton en cache d'un test à
  l'autre. Une horloge monotone pilotable fait expirer le jeton, ce qui
  vérifie aussi l'expiration de bout en bout.
- Le contrôle « aucun fichier de production n'importe l'adaptateur »
  détectait aussi une simple mention en commentaire. Il porte désormais sur
  les imports et les `require`.
- Deux remarques ESLint (comparaison d'enum, assertion inutile) ont été
  corrigées.

## 8. Prérequis avant activation réelle (lots suivants)

1. **Compte marchand CamPay accepté** (statut particulier, KYC) et
   identifiants de production fournis par des secrets d'environnement,
   sans valeur par défaut.
2. **Confirmation écrite de CamPay** sur :
   - le format exigé pour `external_reference` (UUID4 ou libre) ; si un
     UUID4 est requis, faire évoluer la référence marchand de 1-14D.2B
     **avant** toute activation ;
   - la sémantique exacte des doublons d'`external_reference` (résultat
     d'origine ou rejet) ;
   - la structure des erreurs (`ER101`, `ER102`, `ER201`) et la garantie
     qu'elles impliquent l'absence de collecte, pour pouvoir classer ces
     cas en refus définitif ;
   - une éventuelle recherche par `external_reference` ;
   - la durée d'expiration d'une collecte `PENDING` et les autres statuts.
3. **Récupération des opérations incertaines** : réconciliation (par
   exemple via `/api/history/` si le rapprochement est confirmé) ou
   procédure opérateur.
4. **Traitement opérateur** des paiements `uncertain` et `review` (outil et
   procédure).
5. **Notifications** : webhook authentifié (JWT HS256 avec la clé webhook
   de l'application), qui sert seulement de déclencheur de
   `confirmPayment`.
6. **Proxys** : nginx doit transmettre `X-Forwarded-For` et
   `TRUST_PROXY_HOPS` être configuré (1-14D.1, D11). La sortie HTTPS vers
   `www.campay.net` doit être autorisée.
7. **Activation explicite** : un câblage de production volontaire de
   `PAYMENT_PROVIDER`, revu, avec un essai réel limité sur le compte
   marchand.

## 9. Limites

- Tant que les points 2 et 3 du § 8 ne sont pas levés, une initiation
  incertaine ne peut être résolue que par un opérateur.
- La classification `not-sent` repose sur les codes d'erreur undici de
  connexion ; tout autre échec est considéré comme incertain.
- Le jeton est en mémoire **par instance** d'API : chaque instance
  s'authentifie séparément.
- Les statuts CamPay non documentés sont traités comme inconnus (503) et
  aucun paiement n'est clos sur eux.

## 10. Fichiers

Nouveaux :

| Fichier | Rôle |
|---|---|
| `api/src/subscriptions/payments/campay/campay-payment-provider.ts` | Adaptateur, conversion du montant, projection des statuts |
| `api/src/subscriptions/payments/campay/campay-transport.ts` | Transport injectable, transport `fetch` de production, classification |
| `api/src/subscriptions/payments/campay/campay-payment-provider.spec.ts` | 106 tests unitaires |
| `api/test/campay-payment-provider.e2e-spec.ts` | 19 tests e2e |
| `docs/architecture/phase-1-14d2d-campay-adapter.md` | Ce document |

Aucun fichier existant de l'API n'a été modifié : ni le contrat
`PaymentProvider`, ni le moteur de confirmation, ni le module, ni les
migrations. Le frontend, Docker, nginx, `package.json`, le lockfile et les
`.env` sont inchangés.

Hors lot : `web/src/components/subscription/subscription-payment-panel.tsx`
reste modifié dans l'arbre de travail par un changement **préexistant**,
préservé.
