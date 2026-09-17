# Rapport socle de tests — Phase 0A

> **Date** : 17 septembre 2026
> **Branche** : `dev` — **Commit inspecté** : `257109e` (working tree clean au départ, à l'exception de `docs/` non suivi créé par l'audit précédent)
> **Périmètre** : vérification de l'état réel des tests, établissement de l'état initial (builds OK), création d'un socle de tests unitaires **sans aucun changement du code de production**.
> **Règles respectées** : aucun fichier de `api/src` ni `web/src` de production modifié ; aucun schéma MongoDB modifié ; aucune migration lancée ; aucune donnée modifiée ; aucune valeur `.env` lue ni affichée ; aucun `--fix` ESLint (les formats des nouveaux fichiers ont été faits avec `prettier --write` **uniquement sur les 5 fichiers de teste créés par cette session** — voir §13) ; aucun commit ; aucune dépendance installée (`pnpm install --frozen-lockfile` → « Already up to date ») ; aucun E2E en écriture (base locale MongoDB en écoute) ; aucun `test.skip` / `test.todo` / `--force` / `|| true`.

---

## 1. Branche et commit inspectés

| Élément | Valeur |
|---|---|
| Branche courante | `dev` |
| Commit HEAD | `257109e` — `feat: update currency labels to use 'FCFA' instead of 'XOF' for clarity` |
| État au départ | `git status --short` → `?? docs/` uniquement (le rapport d'audit de la session précédente) |
| Node.js | `v22.17.1` |
| pnpm | `11.18.0` |

## 2. État initial de Git

- `git status --short` : `?? docs/`
- `git branch --show-current` : `dev`
- `git rev-parse --short HEAD` : `257109e`

## 3. Liste exacte des fichiers de test trouvés

Recherche en lecture seule (`git ls-files` filtré + glob `*.spec.ts` / `*.{test,spec}.{ts,tsx}` + recherche de configs `jest.config.*` / `vitest.config.*` / `playwright.config.*` / `cypress.config.*`) :

**Unitaires API (Jest, config inline dans `api/package.json` — `rootDir: "src"`, `testRegex: ".*\\.spec\\.ts$"`) :**

1. `api/src/app.controller.spec.ts`
2. `api/src/events/events.gateway.spec.ts`
3. `api/src/objects/objects.controller.spec.ts`
4. `api/src/objects/objects.service.spec.ts`
5. `api/src/s3/s3.service.spec.ts`

**E2E API (Jest, `api/test/jest-e2e.json` — `rootDir: "."`, `testRegex: ".*.e2e-spec.ts$"`) :**

6. `api/test/app.e2e-spec.ts`

**Frontend :** aucun fichier de test (aucun `*.test.tsx`, `*.spec.tsx`, aucun runner configuré, aucun script `test` dans `web/package.json`).

**Configs de test :** `jest` inline dans `api/package.json` (unitaires) ; `api/test/jest-e2e.json` (e2e). Aucun `jest.config.*`, `vitest.config.*`, `playwright.config.*` ou `cypress.config.*` au projet.

**Dépendances de test présentes dans `api/package.json`** (déjà déclarées, rien n'a été installé) : `jest ^30.0.0`, `ts-jest ^29.2.5`, `supertest ^7.0.0`, `@types/jest`, `@types/supertest`, `@nestjs/testing ^11.1.1`, `@types/supertest`, `typescript`, plus en runtime `reflect-metadata` (dépendance de `@nestjs/common`).

## 4. Conclusion sur la contradiction avec l'audit précédent

**Il n'y a pas de contradiction.** Le rapport d'audit (`docs/audits/saas-transformation-audit.md`) est **exact sur ce point** : 5 fichiers de tests unitaires existent bien, plus 1 spéc E2E. Ils sont **fonctionnels** : la baseline exécutée avant toute création (`pnpm --filter api test` sur le commit `257109e`) donne :

```
Test Suites: 5 passed, 5 total
Tests:       13 passed, 13 total
Time:        24.564 s
```

Aucun fichier de test n'a été « supposé disparu » ; le ressenti « aucun test exploitable » vient probablement du fait que la baseline ne couvre que : 1 test racine `Hello World`, 1 assertion « should be defined » du gateway, 5 tests du module `objects` (orphelin dans `AppModule`) et 4 tests du `S3Service` (URLs et key). **Aucun test ne couvrait l'authentification, les rôles, les ventes, le stock, l'audit, la validation ou les analytics.** C'est ce vide qui est comblé par la presente phase.

## 5. Outils de test déjà présents

| Outil | Présence | Notes |
|---|---|---|
| Jest 30 | ✅ `api` (config inline `package.json`) | unitaires (`api/test` pour l'e2e via `jest-e2e.json`) |
| ts-jest 29 | ✅ `api` | transform `^.+\\.(t|j)s$` |
| supertest 7 | ✅ `api` (devDependency + `@types/supertest`) | utilisé par le seul test e2e |
| @nestjs/testing 11 | ✅ `api` | modules de test injectifs |
| reflect-metadata | ✅ (dep trans. Nest) | nécessaires aux décorateurs DTO |
| Vitest / Playwright / Cypress | ❌ absents | **non ajoutés** (pas de justification : la stack API tourne déjà sous Jest avec la CI) |
| Frontend | ❌ aucun runner | à arbitrer pour une phase dédiée (Jest+Testing Library ou Vitest — hors périmètre de cette phase) |

## 6. Dépendances manquantes

**Aucune** pour le socle unitaire : tout le nécessaire était déjà déclaré (`jest`, `ts-jest`, `supertest`, `@nestjs/testing`, `class-validator`, `class-transformer`, `reflect-metadata`, `bcryptjs`, `mongoose`). Aucune dépendance n'a été installée.

**Pour une éventuelle phase E2E future** (non exécutée ici) il faudra soit :
- `mongodb-memory-server` (devDependency `api` — spin-up éphémère, **pas encore justifié/validé**), ou
- un conteneur MongoDB dédié tests dans `docker-compose.yml` (`name: heyama-mongo-test` + `MONGODB_URI` de test dédiée), à ajouter — **aucune des deux solutions n'a été configurée ni validée**.

## 7. Commandes exécutées et résultats

Toutes non destructives ; aucune modification de l'environnement, des données ou de la base.

| # | Commande | Sortie | Durée (indiquée par l'outil) | Résultat |
|---|---|---|---|---|
| 1 | `git status --short` / `git branch --show-current` / `git rev-parse --short HEAD` | 0 | n/m | `dev` / `257109e` / `?? docs/` |
| 2 | `node --version` / `pnpm --version` | 0 | n/m | `v22.17.1` / `11.18.0` |
| 3 | `git ls-files \| findstr …` (recherche fichiers tests) | 0 | n/m | 7 fichiers listés au §3 |
| 4 | `pnpm install --frozen-lockfile` | 0 | 3.2 s | « Already up to date », lockfile conforme |
| 5 | `pnpm --filter api exec eslint "src/**/*.ts" "test/**/*.ts"` (baseline) | 0 | n/m | propre **avant** toute création |
| 6 | `pnpm --filter web exec eslint .` (baseline) | 0 | n/m | propre |
| 7 | `pnpm --filter api build` (baseline) | 0 | <1 min (non mesurée) | `nest build` OK |
| 8 | `pnpm --filter web build` (baseline) | 0 | ~20 s (compile 10.1 s + TS 6.2 s) | OK ; warning non critique : `metadataBase` absent (Next.js) |
| 9 | `pnpm --filter api test` (baseline) | 0 | 24.564 s | **13/13** sur 5 suites |
| 10 | `netstat -ano \| findstr ":27017" \| findstr "LISTENING"` (vérification isolement E2E) | 0 | n/m | **MongoDB local EN ÉCOUTE** sur 27017 → E2E en écriture **bloqué** (voir §12) |
| 11 | `pnpm --filter api test` (nouvelle base + specs) | 0 | 6.272 s | **73/73** sur 10 suites |
| 12 | `pnpm --filter api exec eslint "src/**/*.ts" "test/**/*.ts"` (après corrections) | 0 | n/m | propre |
| 13 | `pnpm exec prettier --write <5 nouveaux spec>` | 0 | ~210 s cumulées (ms/fichier affichées) | uniquement les 5 fichiers créés par cette session |
| 14 | `pnpm --filter api exec jest --listTests` | 0 | n/m | 10 fichiers détectés |
| 15 | `node -e …` (debug `forbidNonWhitelisted` sur `dist` compilé) | 0 | n/m | lecture seule |

**Pas de build ni test échoué sans documentation préalable** : l'unique échec intermédiaire (première exécution des nouveaux specs : 24 erreurs) provenait exclusivement des specs créés pendant cette session (IDs ObjectId mal formés, format `getResponse()` de Nest 11, lecture de métadonnées au mauvais endroit, typo du nom de contrainte) — chacun a été corrigé dans le spec, jamais dans le code de production. Le défaut de lint des specs (78 problèmes au premier run) a été corrigé à la main + Prettier sur ces seuls fichiers (voir §7/notes).

## 8. État des builds

| Build | Résultat | Notes |
|---|---|---|
| `api` (`nest build`) | ✅ | aucune erreur |
| `web` (`next build`) | ✅ | warning : `metadataBase` non défini (métadates OpenGraph) — non bloquant, noté pour la phase SaaS (les URLs d'images OG seraient relatives) |
| Lint API | ✅ | sans `--fix` |
| Lint Web | ✅ | `eslint .` (le script `pnpm lint` du web n'a pas de `--fix`) |
| Tests unitaires API | ✅ | 73/73 |

## 9. Tests créés et comportements couverts

**5 nouveaux fichiers, 60 nouveaux tests** (baseline 13 → total **73**). Aucun ne touche MongoDB réelle, S3 réel ou service externe : tout est mocké (`UsersService`, `JwtService`, `getModelToken(Sale.name)`, `ProductsService`, `AuditService`, `EventsGateway`).

| Fichier | Tests | Comportements couverts |
|---|---|---|
| `api/src/auth/auth.service.spec.ts` | 7 | register : refus e-mail déjà utilisé (400, pas de création) ; JWT présent ; **password jamais présent dans le user renvoyé** ; comportement actuel du rôle (défaut `seller`, §10/C-3 épinglé) ; hash bcrypt réel (le mot de passe en clair n'est jamais stocké). login : refus email inconnu ; refus mauvais mot de passe (bcrypt réel) ; **message générique identique** (pas d'énumération d'users par type d'erreur) ; password jamais retourné sur succès |
| `api/src/auth/guards/roles.guard.spec.ts` | 29 | logique du guard : refuse le seller sur op. admin (403) ; autorise l'admin ; absence de `@Roles` = « tout user authentifié » ; **contrat non authentifié épinglé** (un `user: undefined` provoque un `TypeError` → 500, masqué en prod par l'ordre des guards `JwtAuthGuard`→`RolesGuard`). Matrice réelle lue via `Reflect.getMetadata` sur le handler (mécanisme réel de `SetMetadata` Nest 11) : 13 routes admin-only confirmées ; 10 routes sans rôle confirmées ; **défaut C-2 documenté et épinglé** (analytics accessibles au `seller`) |
| `api/src/sales/sales.service.spec.ts` | 8 | création vente : snapshot `productName`, `sellerId` ObjectId, **appels attendus au service de stock** (`decrementStock(productId, qty)`) ; montants (qty × prix) ; **refus stock insuffisant** sans effet de bord (pas de persistance, pas d'audit, pas de décrue) ; **audit `SOLD`** avec acteur = vendeur et détails ; update : delta de stock = `ancien − nouveau` (+2 si 4→2, −3 si 2→5), prix seul sans impact sur le stock ; remove : **restauration complète du stock** + audit `SALE_CANCELLED` |
| `api/src/common/pipes/parse-object-id.pipe.spec.ts` | 5 | ID ObjectId valide accepté tel quel ; chaîne vide refusée (400) ; identifiant non hexadécimal refusé ; 24 caractères non hexadécimaux refusés ; traversée de chemin refusée |
| `api/src/auth/dto/auth.dto.spec.ts` | 11 | `RegisterDto` : email manquant/malformé, mot de passe <6, payload valide, **champs inconnus refusés** (`forbidNonWhitelisted` via l'option de production) ; `LoginDto` : email manquant, mdp court ; `CreateSaleDto` : qty 0, prix négatif, `productId` invalide ; `CreateProductDto` : `sectionId` manquant, quantité 0 ; `CreateSectionDto` : nom vide refusé — **limitation épinglée** : un nom « whitespace-only » passe `@IsNotEmpty` |

**Répartition par domaine demandé** : authentification ✅ (4/4 + bcp), autorisations ✅ (non-auth + seller/admin + lectures ouvertes), ventes/stock ✅ (montant + refus + appels stock + audit), validation ✅ (pipe ObjectId + 5 DTO).

## 10. Tests réussis et échoués

| Exécution | Resultat |
|---|---|
| Baseline (commit `257109e`, avant création) : `pnpm --filter api test` | ✅ 13/13 |
| Première exécution des nouveaux specs (intermédiaire, non conservée) : 24 échecs — tous dans les specs de cette session (IDs ObjectId 25 caractères au lieu de 24, shape `getResponse()` Nest 11, lecture de métadonnées au mauvais endroit, typo `forbidNonWhitelisted` vs `whitelistValidation`). **Aucun ne concernait le code de production** — corrigé dans les specs |
| Exécution finale : `pnpm --filter api test` | ✅ **73/73** (10 suites) |

**Aucun test de sécurité attendue n'a été « échoué par non-correction » : la stratégie imposée par les règles a été suivie —** les défauts existants sont **documentés et épinglés par des tests qui passent** (ils codifient le comportement actuel pour rendre tout futur changement intentionnel). Exemples : le test « DEFECT (C-2)… » **passe** en certifiant qu'aucun `@Roles` n'existe sur les 4 endpoints analytics ; le test « documents the current role behaviour… seller » **passe** en fixant le défaut de l'audit C-3.

## 11. Défauts de sécurité révélés (confirmés par ce socle, non corrigés)

| Réf audit | Défaut | Épinglé par |
|---|---|---|
| C-2 | `GET /analytics/*` accessibles à **tout user connecté, y compris `seller`** : KPIs globaux + classement vendeurs (email + revenu de CHAQUE vendeur) | `roles.guard.spec.ts` (test « DEFECT (C-2… ») — lecture réelle des métadonnées `@Roles` (absentes) + guard passant pour vendeur |
| C-3 | Le premier utilisateur inscrit obtient **`seller`** (défaut du schéma), et **non pas `admin`** comme le dit le README | `auth.service.spec.ts` (test « documents the current role behaviour… ») |
| N-1 (nouveau, mineur) | `RolesGuard` seul sans `user` (ex. : si `JwtAuthGuard` était désactivé) provoque un **`TypeError` → 500** au lieu d'un 403 propre ; en production l'ordre global des guards masque le cas | `roles.guard.spec.ts` (test « documents the unauthenticated contract… ») |
| N-2 (nouveau, mineur) | `CreateSectionDto.name : @IsNotEmpty()` accepte un nom exclusivement composés d'espaces | `auth.dto.spec.ts` (test « but not a whitespace-only one… ») |
| E-5 (audit) | Pas de transaction MongoDB sur `sale.create` (ventes + stock + audit) : une panne entre `saleModel.create` et `decrementStock` laisse une vente incohérente avec le stock | non testable en unit (concerne le chemin de persistance réel) — **à traiter en E2E dès que la base isolée existe** |

Positif confirmé : le message d'échec de login est **identique** pour email inconnu et mauvais mot de passe (pas d'énumération). `forbidNonWhitelisted` + `whitelist` sont bien effectifs sur les DTO (testé).

## 12. Possibilité de lancer les E2E

**Non — bloqué.** Conditions vérifiées :

- Le port **27017 est écouté** (MongoDB local en cours d'exécution, PID 44252/45900).
- L'URI de développement `mongodb://localhost:27017/heyama` (selon `.env.example`) fait référence à une base de développement, **dont le contenu n'est pas garanti vide** (données RoyalVibe possibles) — **critère 3 non vérified** : « ne contient aucune donnée RoyalVibe ».
- La base n'est pas éphémère et son nom ne signale pas qu'elle est test.

**Conséquence** : aucun E2E en écriture (`app.e2e-spec.ts` est en lecture seule mais `AppModule` connecte à `MONGODB_URI` réel au boot ; je n'ai donc pas lancé `pnpm --filter api test:e2e` non plus pour la même raison).

**Les deux solutions proposées (à arbitrer, non configurées) :**
1. **`mongodb-memory-server`** (devDependency `api`) : base éphémère in-process, zéro état résiduel, mais ajoute une dépendance et un binaire MongoDB téléchargé à l'installation.
2. **Conteneur MongoDB dédié tests** dans `docker-compose.yml` (ex. service `mongo-test`, port `27018`, volume dédié, `MONGODB_URI_TEST=mongodb://localhost:27018/heyama_tests`) + script `test:e2e` qui attend que le service soit prêt. Aucun impact sur la base dev : l'invariance est structurelle (nom de base, port, volume).

## 13. Fichiers créés ou modifiés (liste exacte)

**Créés (non suivis par git — à valider/committer par l'utilisateur) :**
1. `api/src/auth/auth.service.spec.ts` — 7 tests
2. `api/src/auth/guards/roles.guard.spec.ts` — 29 tests
3. `api/src/sales/sales.service.spec.ts` — 8 tests
4. `api/src/common/pipes/parse-object-id.pipe.spec.ts` — 5 tests
5. `api/src/auth/dto/auth.dto.spec.ts` — 11 tests
6. `docs/testing/test-foundation-report.md` — ce rapport

**Modifiés : 0.** Aucun fichier de production (`api/src/**/*.ts` hors `*.spec.ts`), aucun schéma, aucun `package.json`, aucun `Dockerfile`, aucun workflow, aucun `.env` n'a été touché. `package.json` n'a pas besoin de modification : les scripts `test`, `test:watch`, `test:cov` et `test:e2e` existent déjà dans `api/package.json` (étape 4 satisfaite sans action).

**Note sur le lint** : les 5 specs ont d'abord échoué au lint (78 problèmes : formatage Prettier + 5 violations de règles). Conformément aux règles, il n'y a pas eu de `eslint --fix` sur l'ensemble du code ; les violations de règles (assertions inutiles, `this` aliased, variables non typées `any`) ont été corrigées à la main dans les specs, et `prettier --write` a été appliqué **exclusivement** sur les 5 fichiers créés par cette session.

## 14. `git diff --stat` final

```text
git diff --stat HEAD
(empty — aucun fichier suivi est modifié)

git status --short
?? api/src/auth/auth.service.spec.ts
?? api/src/auth/dto/auth.dto.spec.ts
?? api/src/auth/guards/roles.guard.spec.ts
?? api/src/common/pipes/parse-object-id.pipe.spec.ts
?? api/src/sales/sales.service.spec.ts
?? docs/
```

## 15. Proposition de prochaine étape

Sous réserve de validation (phase 0A clôturée, 73/73 vert, lint vert, builds verts, zéro production touché) :

1. **Phase 0B** — Correction des vulnérabilités critiques (C-2 analytics `@Roles(ADMIN)`, C-3 registre premier user / README, E-1 CORS par défaut fermé, E-5 transactions MongoDB, E-7 rate-limiting auth, M-1 `ParseObjectIdPipe` sur `/sales/:id`), en s'appuyant sur le socle de tests pour vérifier chaque correction sans regression. Les tests de défaut (C-2, C-3) deviendront alors les « tests d'acceptation » de la correction.
2. **En parallèle (à arbitrer)** : choix entre mongodb-memory-server et conteneur test dédié pour débloquer l'E2E (y compris le test d'isolement E2E exigé par la checklist de l'audit).

Aucune des deux étapes n'a été exécutée en l'attente de la validation.

---

*Commandes non exécutées exprès (consignes) : `git commit`, `pnpm add …`, `docker compose up` (rien de nouveau), `pnpm --filter api test:e2e`, `eslint --fix` global, toute migration. Les valeurs `.env` / `.env.local` n'ont pas été lues ni affichées. *
