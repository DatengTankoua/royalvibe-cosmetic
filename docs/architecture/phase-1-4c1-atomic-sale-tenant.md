# Phase 1-4C.1 — Vente atomique et tenant (Sales)

## 1. Base Git
- Branche : `architecture/phase-1-4c1-atomic-sale-tenant`
- Base commit : `f614f10` (phase 1-4B Products catalogue, HEAD de la branche
  1-4B, nettoyé du worktree avant ouverture de la branche 1-4C.1)

## 2. Ordre transactionnel — avant / après

### Avant (0B.7B, phase courante)
1. `session.withTransaction {`
2. `productsService.decrementStock(productId, qty, session)` (filtre sans org)
3. `saleModel.create([{productId, …}], { session })` (sans org en doc)
4. `auditService.log(productId, SOLD, sellerId, …, session)` (sans org en doc)
5. `}` → commit
6. Post-commit : `$session(null)` → `populate('sellerId')` → `emit`

### Après (1-4C.1)
1. `session.withTransaction {`
2. `productsService.decrementStock(organizationId, productId, qty, session)`
   → filtre atomique `{_id, organizationId, deletedAt:null, remainingQuantity:{$gte:qty}}`
3. `saleModel.create([{organizationId, productId, …}], { session })`
4. `auditService.log(organizationId, productId, SOLD, sellerId, …, session)`
5. `}` → commit
6. Post-commit : `$session(null)` → `populate('sellerId')` → `emit`

Ordre et structure **inchangés** ; seul le tenant est ajouté.

## 3. Fichiers modifiés (4 prod + 5 tests + 1 rapport = 10)
- `api/src/sales/sales.service.ts` (signature create + org en vente + 3 audit)
- `api/src/sales/sales.controller.ts` (`@CurrentOrganization` sur POST seul)
- `api/src/products/products.service.ts` (`decrementStock` tenant + 6 audit)
- `api/src/audit/audit.service.ts` (signature log org obligatoire)
- `api/src/sales/sales.service.spec.ts` (12 + 6 nouveaux blocs tenant)
- `api/src/sales/sales.controller.spec.ts` (3 nouveaux cas transmission tenant)
- `api/src/products/products.service.spec.ts` (bloc 0B.7B + bloc 1-4C.1)
- `api/src/audit/audit.service.spec.ts` (nouveau, 3 cas)
- `api/test/sales-transaction.e2e-spec.ts` (2 orgs A/B + bloc 6, 5 cas)
- Ce rapport

## 4. Signatures tenant
- `SalesService.create(organizationId: string, dto: CreateSaleDto, sellerId: string)`
- `ProductsService.decrementStock(organizationId: string, productId: string, quantity: number, session?: MongooseSession)`
- `AuditService.log(organizationId: string, productId, action, actorId, details? = {}, session?)`
- `SalesController.create(dto, user, organizationContext)` → transmet
  `organizationContext.organizationId`

## 5. Filtres Mongo exacts
- `decrementStock` (atomic) :
  `findOneAndUpdate({_id, organizationId, deletedAt:null, remainingQuantity:{$gte:qty}}, {$inc:{remainingQuantity:-qty}}, {returnDocument:'after', session})`
- Relecture d'échec (même session) :
  `findOne({_id, organizationId, deletedAt:null}, null, {session})`
- `saleModel.create` : doc porte `organizationId` (1er champ)
- `auditModel.create` : doc porte `organizationId` (1er champ)

## 6. Preuve de session unique
`sales.service.spec.ts` — `makeSessionFixture().session` (réf unique), comparée
par `toBe` sur les 3 écritures : `decrementStock.mock.calls[0][3]`,
`saleModel.create.mock.calls[0][1].session`, `audit.log.mock.calls[0][5]` —
les trois référencent la même instance.

## 7. Vente + Audit tenant dans la transaction
Le même `organizationId` est : (a) passé à `decrementStock` (org du filtre
atomique), (b) écrit dans le document de la VENTE, (c) écrit dans le document
d'AUDIT `SOLD`. Le tenant ne provient que du `@CurrentOrganization()`
(branché par `OrganizationGuard`), jamais du DTO.

## 8. Rollback et concurrence
- Rollback (echec d'audit injectée en E2E, même session) : stock restauré,
  zéro vente, zéro audit, zéro événement (`sale:created`).
- Concurrence (`Promise.all` de 2 POST distinctes) : un 201 + un 400
  « Not enough stock. Available: 0 », stock final 0, une vente, un audit.

## 9. Matrice des tests
- Unitaires : 6 nouveaux bloc 1-4C.1 `sales.service.spec.ts` + 3 nouveaux
  `sales.controller.spec.ts` + 3 bloc 1-4C.1 `products.service.spec.ts` + 3
  nouveaux `audit.service.spec.ts` (nouveau fichier).
- E2E : 5 nouveaux cas « 6. Isolation multi-tenant » + assertions `org`
  ajoutées aux blocs 1 et 4 existants (vente et audit portent A).

## 10. Résultats ciblés (développement) + déviation
- Unit ciblées 4 suites → **52/52** ; E2E `sales-transaction` → **11/11**
- Déviation ESLint : LOCAL `npx eslint --fix` sur les 6 fichiers de phase
  uniquement (préttier + 1 `no-unnecessary-type-assertion`), jamais global.

## 11. Résidus identifiés
- `adjustStock(productId, delta)` : **non tenant** (résiduel 1-4C.2, hors
  périmètre).
- `sales.controller.findAll/update/remove` : **non tenant** (résiduel 1-4C.2).
- `sales.service.update/remove` : appels `auditService.log` avec
  `sale.organizationId?.toString() ?? ''` (chemins hors périmètre 1-4C.1)
  — documenté au code.
- `AuditService.findByProduct` : lecture non-tenant (résiduel 1-4D).
- Broadcast Socket.IO « sale:created » reste global (pas de room par tenant)
  — risque de fuite cross-tenant au déploiement, à traiter dans 1-5.

## 12. Confirmation
Aucun commit, aucun push, aucun accès à MongoDB réel (27017) ni Atlas.
Aucune dépendance ajoutée. Arrêt sur instruction avant validation.
