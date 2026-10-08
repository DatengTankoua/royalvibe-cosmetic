# Phase 1-1B — Champ `organizationId` rétrocompatible + index tenant

Statut : **GREEN** — aucun commit, aucun push. En attente de validation.
Base : `architecture/phase-1-1b-tenant-fields` (issue de
`architecture/phase-1-1a-models`), HEAD de base `b76b165`
« feat(api): add foundational multi-tenant models ».

## 1. Fichiers (6 — plafond : 4 prod + 1 test + 1 rapport)
1. `api/src/sections/schemas/section.schema.ts` (M : champ + index)
2. `api/src/products/schemas/product.schema.ts` (M : champ + index)
3. `api/src/sales/schemas/sale.schema.ts` (M : champ + index)
4. `api/src/audit/schemas/audit-log.schema.ts` (M : champ + index)
5. `api/src/organizations/tenant-resource-schemas.spec.ts` (new, 8 tests)
6. ce rapport. Non modifiés : DTO, contrôleurs, services, auth/JWT,
memberships 1-1A, analytics, WebSockets, S3/Supabase, frontend, `.env`,
dépendances/lockfile, Docker, migrations, module `objects`.

## 2. Champ `organizationId` (identique dans les 4 schémas)
```ts
@Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Organization',
       default: null, required: false })
organizationId: Types.ObjectId | null;
```
Optionnel, jamais fourni par le client, sans `index`/`immutable`/`select`,
sans valeur codée en dur. **Dette préexistante documentée, non corrigée ici** :
`parentId`, `sectionId`, `productId`, `sellerId`, `actorId` (mêmes `@Prop({
type: Types.ObjectId })` pré-1-1B) sont résolus en `Mixed` par
`DefinitionsFactory` de `@nestjs/mongoose@11.0.4`. `organizationId` prend
`MongooseSchema.Types.ObjectId` (frontière d'isolation : type résolument
`ObjectId`) ; correctif de la dette = phase dédiée + tests de non-régression.

## 3. Index tenant (déclarés seulement — non créés, non vérifiés sur Atlas)
| Ressource | Index (ordre exact) |
|---|---|
| Section | `{ organizationId: 1, parentId: 1, deletedAt: 1 }` |
| Product | `{ organizationId: 1, sectionId: 1, deletedAt: 1 }` |
| Sale | `{ organizationId: 1, productId: 1, createdAt: -1 }` |
| AuditLog | `{ organizationId: 1, productId: 1, action: 1, createdAt: -1 }` |

`createdAt: -1` prouvé en lecture seule : `sales.service.ts:123`,
`audit.service.ts:58` (`.sort({ createdAt: -1 })`). Non uniques ; aucun
index existant supprimé ni modifié (aucun n'existait avant).

## 4. RED → GREEN
- **RED** : 8 échecs / 8 — `path('organizationId')` undefined + 0 index
  tenant par ressource.
- **GREEN** : 8 passés / 8 — aucune assertion affaiblie/sautée
  (pas de `skip`/`todo`/`only`/`eslint-disable`). Ordre des clés vérifié
  **sans tri préalable** (séquence déclarée) ; registre `new Mongoose()` en
  mémoire, sans connexion ni `syncIndexes()`/`createIndexes()`.
- `MongooseSchema.Types.ObjectId` prouvé d'abord (sonde éphémère,
  supprimée) : `instance === 'ObjectId'` et
  `options.type === MongooseSchema.Types.ObjectId`, avant application aux 4.

## 5. Résultats (mesurés, chacun une fois)
- Unitaires cibles : **8/8** ; **229/229** (19 suites) = 221 + 8 nouveaux.
- E2E **53/53** (3 suites) — erreurs affichées = pannes **simulées**
  (test transaction) ; sans `mongod` actif avant/après.
- ESLint `{src,apps,libs,test}/**/*.ts` : **0 erreur**, 2 warnings 0B.2
  préexistants ; build **OK** (exit 0) ; `git diff --check` propre (CRLF).
  `git rev-parse HEAD` : `b76b165`. Aucun commit, aucun push.

## 6. Exclusions & preuve de non-modification
- Aucune migration, aucun filtrage par organisation, aucune autorisation
  multi-tenant, aucune modification de comportement applicatif (les flux
  actuels écrivent sans `organizationId` → `null` ; docs existants valides) ;
  migration RoyalVibe (1-2) non entamée.
- Tests existants non modifiés : `git diff --numstat` sur les specs 1-1A
  renvoie **vide** ; `git status --short` = `M` ×4 schémas + 2 nouveaux ;
  diff = insertions uniquement sur les 4 schémas.
- Aucune donnée RoyalVibe consultée ni modifiée ; aucune base locale/Atlas/
  Supabase ; aucune dépendance ajoutée ; lockfile intact.
- **Risque résiduel** : les 4 index sont déclarés mais **non créés ni
  vérifiés sur Atlas** — reportés à la migration (1-2).
