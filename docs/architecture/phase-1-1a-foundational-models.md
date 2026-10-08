# Phase 1-1A — Socle de données multi-tenant (modèles uniquement)

Statut : **GREEN** — aucun commit, aucun push. En attente de validation.

## 1. Contexte
- Branche : `architecture/phase-1-1a-models` (issue de `architecture/phase-1a-multitenancy-audit`).
- Base : commit `0165617` (rapport Phase 1A).
- Périmètre : socle de données **additif uniquement** — `Organization`,
  `OrganizationMembership`, rôles/statuts/permissions, `OrganizationsModule`.
  Aucun endpoint, service, garde, invitation, migration ni changement de
  comportement métier.

## 2. Fichiers (8 — plafond de la spec : 5 prod + 2 tests + 1 rapport)
| Fichier | Rôle |
|---|---|
| `api/src/organizations/permissions.ts` | Source de vérité : enums rôles/statuts/devise, 12 permissions délégables, défauts par rôle (matrice), opérations owner-only — les listes, la matrice et ses tableaux sont gelés (`Object.freeze`) |
| `api/src/organizations/schemas/organization.schema.ts` | Modèle `Organization` |
| `api/src/organizations/schemas/membership.schema.ts` | Modèle `OrganizationMembership` + 3 index |
| `api/src/organizations/organizations.module.ts` | `OrganizationsModule` (`MongooseModule.forFeature` uniquement) |
| `api/src/app.module.ts` | `+` import `OrganizationsModule` (+3 lignes) |
| `api/src/organizations/organization.schema.spec.ts` | Tests unitaires Organization + permissions |
| `api/src/organizations/membership.schema.spec.ts` | Tests unitaires Membership |
| `docs/architecture/phase-1-1a-foundational-models.md` | Ce rapport |

Non modifiés : `.env`, `package.json`, lockfiles, frontend, resources métier.

## 3. Modèle

### Organization
`name` (requis, trim, non vide, ≤ 100) · `slug` (requis, trim, minuscules,
≤ 80, `/^[0-9a-z-]+$/`, **unique — déclaré une seule fois** via `unique: true`,
vérifié par test) · `logoKey` (string | null, défaut null) · `brandColor`
(`#RRGGBB`, défaut `#b8960c`) · `currency` (`XAF` | `EUR`, défaut `XAF`,
**jamais `XOF`**) · `status` (`active` | `suspended`, défaut `active`).
`timestamps: true`. Ni `ownerId`, ni champ abonnement/facturation.

### OrganizationMembership
`organizationId` (ObjectId, ref `Organization`, requis) · `userId`
(ObjectId, ref `User`, requis) · `role` (`owner` | `admin` | `seller`,
défaut `seller`) · `permissions` (`DelegablePermission[]`, défaut `[]`,
**supplémentaires uniquement** — validation : valeurs délégables connues +
aucun doublon) · `status` (`active` | `suspended` | `revoked`, défaut
`active`) · `invitedById` (ObjectId ref `User` | null, défaut null) ·
`joinedAt` (Date, défaut : date courante). `timestamps: true`.
Aucun champ `active: boolean`, aucun `activeOrganizationId` (testé).

### Index (exactement 3, vérifiés via `schema.indexes()`)
1. `{ organizationId, userId }` **unique** — une membership par personne par org.
2. `{ userId, status }` — requêtes membres par utilisateur + statut.
3. `{ organizationId, role }` **unique partiel**
   (`partialFilterExpression: { role: 'owner', status: 'active' }`) —
   garantit **au maximum un owner actif** par organisation ; ne garantit
   **PAS** l'existence d'un owner (invariant « exactement un owner »
   applicatif, service + transaction, phases 1-6/1-7+).

## 4. Permissions (phase 1-1A)
- 12 permissions délégables : catalog.manage, products.manage, stock.adjust,
  sales.record, sales.view_own, sales.view_all, analytics.read, audit.read,
  trash.manage, branding.manage, members.invite, members.manage.
- Opérations **owner-only, non délégables** : ownership.transfer,
  organization.delete, billing.identity, owner.attribution.
- `membership.permissions` = **supplémentaires** uniquement (autorisation
  effective = rôle ∪ supplémentaires, phase 1-7) ; défauts par rôle :
  `owner` = `admin` = 12/12, `seller` = `sales.record` + `sales.view_own`.
- Aucune garde ni fonction d'autorisation.

## 5. RED → GREEN
- **RED** (avant mise en place) : modules introuvables (chemins d'import), puis
  causes d'implémentation : `permissions` en `Mixed` (sans schéma, sans
  casting) et `validateSync()` déprécié en Mongoose 9.
- **GREEN** : `await doc.validate()` choisi pour l'API non-dépréciée et tester
  naturellement les rejets asynchrones (`validateSync()` retourne
  `ValidationError | undefined`, ne rejette pas une promesse) ; `permissions`
  vers `[String]` + option `validate` (2 règles) car `Mixed` est sans schéma.
  Aucune assertion affaiblie ni sautée ; tests d'index = **déclaration**, pas
  unicité réelle.

## 6. Vérification finale (exécutée une fois, après ce nettoyage)
- Tests ciblés : **23/23** (Organization 8, permissions 6, Membership 9).
- Suite complète `pnpm --filter api test` : **221/221** (18 suites).
- ESLint `{src,apps,libs,test}/**/*.ts` : **0 erreur**, 2 warnings préexistants
  0B.2 (`test/app.e2e-spec.ts:286`, `test/e2e/ephemeral-mongodb.ts:67`).
- `git diff --check` : propre. `git status` : `M api/src/app.module.ts` (+3) +
  7 nouveaux (4 prod `organizations/`, 2 specs, 1 rapport) ; frontend /
  lockfiles intacts. `git rev-parse HEAD` : `0165617`.

## 7. Risques résiduels
- Unicité `slug` : déclaration de schéma seule — index réel au premier
  déploiement (aucune opération DB dans cette phase).
- Index owner partiel : maximum 1, pas exactement 1 — invariants applicatifs
  (phases 1-6/1-7+).
- Les validateurs `permissions` s'exécutent à `validate()`/`save`/`insert` ;
  aucune autre couche de protection n'existe encore (attendu avant 1-7).

## 8. Confirmations
- Aucune connexion MongoDB / Atlas / Supabase, aucune opération réseau.
- **Aucun commit, aucun push** — en attente de validation.
