# Phase 1-11C.2 — Outbox IndexedDB et moteur de synchronisation des ventes

Base : `architecture/phase-1-11c1-sales-idempotency` @ `f4ed845`. Frontend uniquement, aucun package ajouté, aucun formulaire hors ligne (1-11C.3).

## Fichiers

- `lib/offline-sales-policy.ts` : fonctions pures (classification, backoff, Retry-After, expiration, stock indicatif).
- `lib/offline-sales-outbox-db.ts` : base, ajout vérifié, primitives du moteur.
- `lib/offline-sales-sync.ts` : verrou, passe FIFO, matrice, `stopOfflineSalesSync(timeoutMs)`.
- `hooks/use-offline-sales-sync.ts` (monté dans `app/app/layout.tsx`) ; `lib/api.ts` : `createSaleIdempotent`, `toSaleSyncOutcome`, intercepteurs durcis.

## Schéma

Base **séparée** `stockmaster-offline-sales-outbox`, **jamais** incluse dans `purgeAllOfflineData()`.

- **`operations`** (keyPath `clientOperationId`, index unique `by_partition_seq` sur `[partitionKey, seq]`) :
  - `schemaVersion: 1`, `partitionKey`, `userId`, `organizationId`, `seq` ;
  - `payload {productId, quantity, salePrice, buyerName?, buyerContact?, occurredAt}`, `display {productName, unitPriceHint}` ;
  - `status` (`pending | syncing | synced | conflict | abandoned`), `attempts`, `nextAttemptAt`, `lastError? {kind, code?, httpStatus?}`, `saleId?`, `createdAt`, `updatedAt`.
- **`meta`** (keyPath `partitionKey`) : `nextSeq`, `lease? {owner, expiresAt}`, `blocked? {reason, tokenFingerprint?, at}`.

**Ajout** (`enqueueOfflineSale`) :
- `readVerifiedIdentity(token)` doit correspondre à l'identité fournie ; payload validé ;
- `crypto.randomUUID()` et `occurredAt` (heure de saisie, UTC) sont figés une seule fois ; `seq` est attribué dans la même transaction ;
- au-delà de **200 non finalisées** (pending, syncing, conflict) : refus `limit`, aucune éviction ;
- `navigator.storage.persist()` en best effort.

## Partition et identité

- `partitionKey = ${userId}:${organizationId}`, issu **uniquement** du contexte serveur (`GET /auth/context`). Jamais l'empreinte du token : une reconnexion ne rend pas les ventes orphelines. Lecture, ajout et synchronisation exigent `readVerifiedIdentity(token)` identique au contexte.
- Le shell demande une passe dès que le pointeur d'identité est écrit.

## Verrou (un worker par partition)

1. **Web Locks** : `navigator.locks.request('stockmaster-sales-sync:<partition>', { ifAvailable: true })`.
2. **Repli** : bail IndexedDB transactionnel (`tabId` aléatoire, 30 s, renouvelé toutes les 10 s). Bail perdu → arrêt ; libération en `finally`.

## Worker (une passe)

- **Préconditions** : pas d'arrêt demandé, `navigator.onLine`, token présent et non expiré, identité vérifiée égale au contexte. Token, userId, orgId et partition sont capturés une seule fois.
- **File vide** : aucune base créée, aucun verrou, aucun réseau.
- **Sous verrou** : `syncing` → `pending` (partition courante uniquement) ; `pending` de plus de 14 jours → `conflict EXPIRED` (jamais envoyé) ; `synced` de plus de 7 jours → supprimé.
- **Boucle FIFO par `seq`** :
  - une tête de file en backoff bloque la suite ;
  - chaque opération est vérifiée (partition, userId, orgId, version), sinon `conflict corruption` et partition bloquée ;
  - token local revérifié juste avant chaque envoi ; `Authorization` = token **capturé**.

## Matrice

| Réponse | Effet | Suite |
|---|---|---|
| 201 | `synced` + `saleId` | continue |
| 409 `SALE_OPERATION_ALREADY_APPLIED` | `synced` (code conservé) | continue |
| 409 `IDEMPOTENCY_KEY_REUSED` / `_CONFLICT` | `conflict corruption`, partition bloquée | arrêt |
| 400 (stock, date, validation), 404 `PRODUCT_NOT_FOUND`, autre 4xx | `conflict` terminal | continue |
| Réseau / timeout (30 s) | `pending`, +1 tentative, backoff | arrêt de la passe |
| 5xx / 429 | idem, Retry-After respecté ; à 8 tentatives : `conflict SERVER_UNAVAILABLE` | arrêt, ou continue si conflit |
| 401 | `pending`, aucune tentative consommée | arrêt |
| 403 (`ORGANIZATION_ACCESS_DENIED` / `PERMISSION_DENIED`) | `pending`, aucune tentative, partition bloquée pour **ce** token | arrêt |
| Annulation locale | `pending`, rien de consommé | arrêt |

- **Backoff** : `2 s × 2^(n−1)`, jitter ±20 %, borné entre 2 s et 5 min ; reprogrammé à l'échéance (minimum 2 s), jamais de relance immédiate. **Déblocage 403** : automatique avec un **autre** token ; la corruption n'est jamais levée automatiquement (1-11C.3).

## Déclencheurs et cycle de session

- **Déclencheurs** : montage du shell, `online`, retour visible, BroadcastChannel `enqueued`, demande locale, échéance de backoff, intervalle de 60 s tant que le shell est monté. Pas de Background Sync ni de service worker.
- **Changement de session** : un événement `storage` sur la clé du token (autre onglet) annule la passe. Dans le même onglet, c'est la vérification avant chaque envoi.
- **`stopOfflineSalesSync(timeoutMs)`** : annule la passe et attend au plus `timeoutMs`. L'outbox n'est jamais supprimée, ni au logout ni au switch.
- **Axios** :
  - un `Authorization` explicite n'est jamais remplacé ;
  - le 401 global ne déconnecte que si la requête portait le token **courant** (un token périmé ne ferme plus la nouvelle session) ;
  - les autres appels sont inchangés.
- **Stock indicatif** : `computeIndicativeStock` = `max(0, remaining − Σ pending/syncing du produit)`. Aucune interface modifiée.

## Tests réels

- **Fonctions pures** : script Node temporaire (classification, bornes du backoff, Retry-After, expiration, stock) : OK.
- **Playwright temporaire** (scratchpad, hors Git) :
  - stack : `MongoMemoryReplSet`, migration 1-11C.1, API compilée, `next dev`, page harnais temporaire supprimée ensuite ;
  - suite exécutée 2 fois avec Web Locks et 1 fois avec Web Locks désactivé (bail IndexedDB) ;
  - **10 sur 10 à chaque exécution** :
    0. file vide : inactif, aucune base créée ;
    1. FIFO ;
    2. deux onglets : un seul POST par opération ;
    3. 201 perdue après commit : retry avec le même UUID, 1 vente, stock décrémenté une fois ;
    4. conflit de stock : l'opération suivante est envoyée ;
    5. switch dans l'autre onglet : annulation, aucun POST avec un JWT B, retour A avec JWT A ;
    6. 403 réel (membership suspendue) : bloquée, même token toujours bloqué, nouvelle session débloque ;
    6b. 401 : `pending`, arrêt ;
    7. limite 200 : refus sans éviction ;
    8. la purge du catalogue conserve l'outbox.
- **Validation** : `eslint` et `next build` OK, `git diff --check` propre.

## Limites

- `Retry-After` n'est lisible en cross-origin que si le CORS l'expose (`exposedHeaders`, backend hors périmètre). Sinon, repli sur le backoff.
- Les erreurs réseau comptent dans `attempts`. Le plafond de 8 ne s'applique qu'à une erreur serveur.
- Aucun test unitaire commité (pas d'infrastructure de test web).
- Reportés en 1-11C.3 : interface des conflits, déblocage de la corruption, export, appel de `stopOfflineSalesSync` au logout/switch.
