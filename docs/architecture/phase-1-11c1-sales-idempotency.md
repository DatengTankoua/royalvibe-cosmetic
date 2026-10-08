# Phase 1-11C.1 — Idempotence serveur des créations de ventes

Base : `architecture/phase-1-11b-offline-catalog` @ `2348947`. Serveur uniquement (aucun frontend/outbox).

## Contrat `POST /sales`

`CreateSaleDto` (whitelist + `forbidNonWhitelisted`) :

| Champ | Validation |
|---|---|
| `productId` | `@IsMongoId` |
| `quantity` | `@IsInt @Min(1)` (entier désormais obligatoire) |
| `salePrice` | `@IsNumber @Min(0)` (prix libre, inchangé) |
| `buyerName?`, `buyerContact?` | `@IsString @MaxLength(100)` |
| `clientOperationId?` | `@IsUUID('4')` — nouvelle clé d'idempotence |
| `occurredAt?` | ISO 8601 strict, UTC `Z` obligatoire |

`organizationId`, `sellerId`, `userId` : refusés (400) ; toujours issus du JWT/contexte serveur.

## Transaction (avec clé)

1. Normalisation explicite : `productId` minuscule, acheteur trimé ou `null`, `occurredAt` ISO ms ou `null`.
2. `requestHash` = SHA-256 hex de `[productId, quantity, salePrice, buyerName, buyerContact, occurredAt]` (ordre fixe, serveur uniquement, jamais journalisé ni renvoyé). L'heure serveur n'y entre jamais.
3. Chemin rapide `SaleOperation.findOne({organizationId, clientOperationId})` → `replay`.
4. Sinon validation de plage `occurredAt`, puis une transaction : **`SaleOperation` (1ʳᵉ écriture)** → `decrementStock` tenant → `Sale` (`_id = saleId` pré-généré, org/vendeur serveur, `occurredAt`) → audit `SOLD` (avec `clientOperationId`) → commit.
5. E11000 **de l'index idempotent uniquement** (`keyPattern` exact) → relecture `read('primary')` → `replay`. Tout autre E11000/erreur est relancé.
6. Après commit (chemin neuf seulement) : `populate('sellerId')` puis `emitToOrganization` une fois.

Sans clé : flux historique (aucune lecture `sale_operations`), avec `occurredAt` et `quantity` entière.

## Replay

Aucune écriture, aucun stock, aucun audit, aucun événement. Ordre des contrôles :

1. vendeur différent → **409 `IDEMPOTENCY_KEY_CONFLICT`** ({code, message} seulement, aucune donnée de vente) ;
2. hash différent → **409 `IDEMPOTENCY_KEY_REUSED`** ;
3. vente supprimée (`DELETE /sales/:id`) → **409 `SALE_OPERATION_ALREADY_APPLIED`** ;
4. sinon **201**, même `_id`, représentation **courante** de la vente (PATCH ultérieurs inclus), `sellerId` peuplé `name email` comme la réponse initiale.

Le rejeu passe avant la validation de plage de date : un rejeu tardif d'une clé appliquée aboutit. Guards (JWT, organisation, `sales.record`) toujours rejoués : membership révoquée/org suspendue → 403.

## Modèle et index

`SaleOperation` (collection `sale_operations`, `createdAt` seul, **aucun TTL**) : `organizationId`, `clientOperationId`, `sellerId`, `saleId`, `requestHash` (tous requis). Index unique exact `{ organizationId: 1, clientOperationId: 1 }` (non partiel, non sparse, sans collation). Collection dédiée : survit à la suppression physique d'une vente. Même UUID indépendant par organisation.

## Migration (jamais implicite)

- Schéma `autoIndex: false` : l'index n'est **jamais** créé au démarrage.
- Migration idempotente (no-op si présent, échec bruyant si conflit/doublons, URI jamais journalisée) :

```bash
pnpm --filter api build
MONGODB_URI=... pnpm --filter api migrate:sale-operations-index
```

- **Fail-fast** : `SaleOperationIndexCheck` (`onApplicationBootstrap`) vérifie en `NODE_ENV=production` (Dockerfile) l'index exact ; absent/mal configuré → l'API refuse de démarrer. **À exécuter avant le déploiement de cette phase.**
- Tests éphémères : `ensureSaleOperationIndex(connection)` explicite.

## occurredAt

Absent → heure serveur ; fourni → entre −14 jours et +5 minutes (bornes incluses), sinon **400 `SALE_DATE_OUT_OF_RANGE`**. Stocké sur `Sale` ; `createdAt` reste l'heure technique. Analytics : période `$or [{occurredAt: range}, {occurredAt: null, createdAt: range}]`, tendance mensuelle sur `$ifNull['$occurredAt','$createdAt']`. Aucune migration des ventes existantes (repli `createdAt`).

## Codes stables (messages historiques conservés)

| Code | HTTP |
|---|---|
| `PRODUCT_NOT_FOUND` | 404 (`Product <id> not found`) |
| `INSUFFICIENT_STOCK` | 400 (`Not enough stock. Available: N`, + `available`) |
| `SALE_DATE_OUT_OF_RANGE` | 400 |
| `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_KEY_CONFLICT`, `SALE_OPERATION_ALREADY_APPLIED` | 409 |

## Tests

- **Unitaires** : DTO (UUID v4, ISO UTC, entier, whitelist) ; hash canonique ; plage de date ; E11000 ciblé vs autre ; replay nominal/vendeur/hash/supprimée sans stock/audit/gateway ; ordre des écritures ; flux sans clé ; codes produit ; analytics ; vérification d'index et fail-fast.
- **E2E** `test/sales-idempotency.e2e-spec.ts` (replica set éphémère) :
  - index absent au boot puis migration « created » → « already-present » ;
  - 3 rejeux séquentiels et 5 concurrents → 1 vente, stock −q une fois, 1 audit, 1 émission, même `saleId`, aucun 5xx ;
  - rollback audit sans vente ni `SaleOperation` ;
  - stock insuffisant puis retry ;
  - A/B indépendants ; autre vendeur 409 sans fuite ;
  - vente supprimée → `ALREADY_APPLIED` ;
  - 403 révocation/suspension ; champs forgés 400 ;
  - `occurredAt` et repli analytics.

## Limites

- **Socket.IO** : au plus une émission dans le flux normal, best effort. Un crash entre le commit et l'émission ⇒ zéro événement, et le rejeu n'émet jamais. Les clients doivent se resynchroniser par lecture.
- Un échec de `populate` après commit renvoie 5xx ; le retry de la même clé renvoie la vente (201).
- 201 perdu puis accès révoqué : le client ne peut plus confirmer (403) ; traité en 1-11C.2/C.3.
- `UpdateSaleDto.quantity` reste `@IsNumber` (hors périmètre).

## Accès aux données

Aucun accès Atlas ni `localhost:27017` : tests sur `MongoMemoryReplSet` (garde anti-27017). La migration n'a été exécutée que contre la base éphémère (et à vide sans `MONGODB_URI` : refus propre). Aucun commit, aucun push.
