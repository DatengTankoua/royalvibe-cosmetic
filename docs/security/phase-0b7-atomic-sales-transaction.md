# Phase 0B.7B — Transaction atomique VENTE–STOCK–AUDIT

**Problème corrigé.** `POST /sales` exécutait 3 écritures indépendantes
(création de la vente, `$inc` non gardé du stock, audit `SOLD`) : une panne
entre deux étapes pouvait laisser une vente sans décrément, un stock décrémenté
sans vente, ou un audit orphelin. Le `$inc` sans condition autorisait le stock
négatif en concurrence.

**Frontière transactionnelle.** `SalesService.create` ouvre
`connection.startSession()` (injection NestJS `@InjectConnection()`) puis
`session.withTransaction(fn)` : l'intérieur de `fn` regroupe exactement les 3
écritures ; `session.endSession()` est garanti dans `finally`. La même instance
`ClientSession` est transmise explicitement à chaque opération
(`transactionAsyncLocalStorage` : non utilisé — la session reste visible et
testable). Aucune opération parallèle dans la transaction (l'audit référence le
`saleId` de la vente créée).

**Méthode de décrémentation atomique.** `ProductsService.decrementStock` remplace
`findByIdAndUpdate` + `$inc` par `findOneAndUpdate` conditionnelle
`{ _id, deletedAt: null, remainingQuantity: { $gte: quantity } }` +
`{ $inc: { remainingQuantity: -quantity } }`, avec `session` et
`returnDocument: 'after'`. Aucune mise à jour ne correspondant au filtre
→ **relecture limitée aux produits ACTIFS** (`findOne({ _id, deletedAt: null },
null, { session })`, même session) : présent mais stock insuffisant → 400
`Not enough stock. Available: N` ; absent **ou déjà corbeillé** → 404
`Product ${id} not found` (messages identiques au comportement précédent —
un produit mis à la corbeille ne déclenche plus de « Not enough stock »).

**Comportement de rollback.** Tout rejet dans la transaction (produit absent,
stock insuffisant, échec de `saleModel.create` ou de `auditService.log` —
l'audit accepte désormais un `ClientSession` **optionnel**) abort la
transaction : aucune des trois écritures n'est conservée.

**Événement post-commit / document détaché.** Après `endSession()` (dans le
`finally`), garde explicite : si aucune vente n'a été créée, lève (invariant
interne). Le document créé est **détaché de la session close** via
`created.$session(null)` AVANT `populate` ; `sale:created` (Socket.IO) est émis
APRÈS le commit sur la vente peuplée. Un rollback n'émet aucun événement et ne
déclenche ni `$session` ni `populate`.

**Tests ajoutés.** Unitaires : `sales.service.spec.ts` (cycle de vie session,
même référence de session sur les 3 écritures, messages 404/400 conservés,
`$session(null)` avant `populate`, aucun populate/événement sur rollback) et
`products.service.spec.ts` (filtre `$gte`, session transmise, **relecture
ACTIVE `_id` + `deletedAt: null` en même session**, 400/404 exacts,
**produit corbeillé → 404**, mode sans session). E2E sur le
`MongoMemoryReplSet` 0B.2 : `test/sales-transaction.e2e-spec.ts` (succès,
insuffisant, rollback par panne d'audit injectée, concurrence 2 ventes du
dernier article, **produit corbeillé → 404 sans effet**, espion
`EventsGateway.emit`).

**Résultats.** Unitaires 198/198 — E2E 53/53 — ESLint 0 erreur et **2
warnings seulement, préexistants 0B.2** (`app.e2e-spec.ts:286`,
`ephemeral-mongodb.ts:67`) — **aucun nouveau warning issu de 0B.7B** —
`nest build` OK — `git diff --check` propre.

**Limite connue.** Le Docker de développement local tourne sur MongoDB
**standalone** (transactions impossibles) — corrigée séparément en **0B.7C**.
Production (Atlas) compatible. Aucun accès ni changement sur Atlas ni
Supabase ; photos de production hors périmètre.
