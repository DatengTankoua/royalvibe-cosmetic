# Phase 0B.1 — Autorisations et validation de l'API

- **Date** : 2026-08-01
- **Branche** : `security/phase-0b1-api-authorization` (créée depuis `dev`)
- **Point de contrôle 0A** : `de9ca18` — `test(api): establish security baseline` (7 fichiers, 1 699 insertions : 5 specs 0A + rapport d'audit + rapport socle de tests)
- **Périmètre** : 4 défauts autorisés uniquement. Hors périmètre (volontaire) : enregistrement public, CORS, WebSockets, transactions MongoDB, organisations/multi-tenant, S3, front-end, abonnements.
- **Règles respectées** : tests d'abord (RED avant GREEN), aucune dépendance ajoutée, aucun schéma/migration modifié, aucune écriture E2E (MongoDB de dev live sur 27017), aucun `.env` lu, aucun commit de la phase 0B.1 (en attente de validation utilisateur).

---

## 1. Vulnérabilités traitées

| # | Réf. audit | Défaut | Correction minimale |
|---|-----------|--------|--------------------|
| 1 | C-2 | Les 4 endpoints Analytics (KPIs, ranking produits **avec prix d'achat**, ranking vendeurs **avec e-mails + revenus de tous les vendeurs**, tendance mensuelle) étaient accessibles à tout utilisateur authentifié, y compris un vendeur concurrent. | `@UseGuards(RolesGuard)` + `@Roles(UserRole.ADMIN)` à la **classe** `AnalyticsController` (les 4 routes), plus la métadonnée vérifiée test par test. |
| 2 | N-1 (roles.guard) | Avec une route protégée par rôle et `request.user` absent, `RolesGuard` lançait `TypeError: Cannot read properties of undefined (reading 'role')` non gérée → `500` au lieu d'un refus contrôlé. En production, le `JwtAuthGuard` global (APP_GUARD précédant `RolesGuard`) masque le cas par un `401`, mais la garde elle-même n'était pas autonome. | `RolesGuard` refuse maintenant proprement : `if (!user \|\| !required.includes(user.role)) throw new ForbiddenException('Insufficient permissions')` → `403`. Aucun `TypeError` possible ; aucun comportement modifié quand aucun rôle n'est requis (`return true`). |
| 3 | N-2 | `CreateSectionDto.name` : `@IsNotEmpty` seul accepte la valeur `'   '` (espaces uniquement) → sections invisibles/cosmétique injectables. | `@Matches(/\S/, { message: 'name must contain a non-whitespace character' })` ajouté **sur ce champ uniquement** (pas de transformation/trim globale). |
| 4 | M-1 | `PATCH /sales/:id` et `DELETE /sales/:id` (admin) acceptaient n'importe quelle chaîne `:id` sans validation → `Mongoose CastError` → `500` sur identifiant invalide (et surface d'erreur incohérente). | `ParseObjectIdPipe` existant (déjà testé en 0A) appliqué au paramètre `id` des deux routes : `@Param('id', ParseObjectIdPipe)`. |

Défaut **C-3** (premier utilisateur non admin / README) : **non traité ici** — explicitement hors périmètre 0B.1, reporté.

## 2. Comportement avant / après

### 1. Analytics (C-2)
- **Avant** : `GET /analytics/overview`, `/analytics/products/ranking`, `/analytics/sellers/ranking`, `/analytics/monthly` — authentifié uniquement (JWT global), **aucune** restriction de rôle. Un vendeur voyait les e-mails, revenus, prix d'achat et KPIs de tous les vendeurs.
- **Après** : les 4 routes exigent `UserRole.ADMIN`. Un vendeur reçoit `403 Forbidden` (`ForbiddenException('Insufficient permissions')`) avant l'appel au service.

### 2. RolesGuard sans utilisateur (N-1)
- **Avant** : utilisateur absent + rôle requis → `TypeError` non gérée → `500` (masqué en production par le `401` du `JwtAuthGuard` global).
- **Après** : `403 Forbidden` contrôlé, sans `TypeError` (`assert not beInstanceOf(TypeError)` dans le test). Aucun rôle requis + utilisateur absent → `true` (inchangé).

### 3. Noms de sections vides (N-2)
- **Avant** : `@POST /sections` avec `name: '   '` → `201` (validation `IsNotEmpty` contournée par les espaces).
- **Après** : `400 BadRequest`, message `name must contain a non-whitespace character`. `''` et champ absent : refusés comme avant (`IsNotEmpty`).
- **Documenté dans un test** : les espaces *entourants* d'un nom valide ne sont **pas** supprimés par le DTO — `'  Parfums  '` passe la validation et le trim éventuel reste à la couche schéma (aucun changement de ce comportement imposé, aucune transformation globale risquant les autres DTO).

### 4. Identifiants MongoDB sur `/sales/:id` (M-1)
- **Avant** : `PATCH/DELETE /sales/<n'importe-quoi>` → le service recevait la chaîne brute → `CastError` → `500` (le service **était** appelé).
- **Après** : le pipe rejette **avant** le service : `400 BadRequest` — `Invalid id: …` (comportement unitairement testé sur `not-an-id`, `''`, `../../../etc/passwd`). Un id valide (hex 24 caractères) passe inchangé. Le metadata de route est aussi testé : les 2 routes déclarent bien `ParseObjectIdPipe` (lecture de `__routeArguments__`, clé NestJS réellement utilisée — vérifiée dans le code compilé `@nestjs/common@11.1.28`, pas supposée).

## 3. Fichiers modifiés

**Production (4) :**
| Fichier | Changement |
|---------|-----------|
| `api/src/analytics/analytics.controller.ts` | `+@UseGuards(RolesGuard)` `+@Roles(UserRole.ADMIN)` au niveau classe ; imports ; commentaire de justification. Routes inchangées. |
| `api/src/auth/guards/roles.guard.ts` | 1 ligne de condition : `if (!user \|\| !required.includes(user.role))` (+ commentaire). |
| `api/src/sections/dto/create-section.dto.ts` | `+@Matches(/\S/, …)` sur `name` (+ commentaire, + import `Matches`). |
| `api/src/sales/sales.controller.ts` | `@Param('id', ParseObjectIdPipe)` sur `update` et `remove` (+ import). |

**Tests (3) :**
| Fichier | Changement |
|---------|-----------|
| `api/src/auth/guards/roles.guard.spec.ts` | **Modifié** : pin « TypeError documenté » **remplacé** par (a) refus `ForbiddenException` sans `TypeError` quand `user` est absent et rôle requis, (b) aucun throw quand utilisateur absent et aucun rôle requis. Matrice : les 4 endpoints Analytics déplacés de `anyAuthRoute` (6 routes) vers `adminOnlyRoutes` (17 routes). Test C-2 : l'ancien test « documente la vulnérabilité, non corrigée » est **remplacé** par une assertion de la correction (métadonnée `= [ADMIN]` sur les 4 méthodes + la garde refuse un vendeur). |
| `api/src/auth/dto/auth.dto.spec.ts` | **Modifié** : le test « whitespace-only accepté (limitation documentée) » est **remplacé** par 4 assertions : `'Parfums'` accepté (0 erreur), `''` refusé, `'   '` refusé, champ absent refusé ; + 1 test documentant que les espaces entourants d'un nom valide ne sont pas trimmés. |
| `api/src/sales/sales.controller.spec.ts` | **Nouveau** : 5 tests — 2 sur la métadonnée de route réelle (les routes `update`/`remove` doivent déclarer `ParseObjectIdPipe`), 3 sur le comportement du pipe (id valide inchangé ; `not-an-id`, `''`, `../../../etc/passwd` → `BadRequestException`). |

**Documentation (1, ce rapport)** : `docs/security/phase-0b1-api-authorization.md`.

Surface totale (à l'étape de revue) : `git diff --stat` → 6 fichiers modifiés, `+94 / −39`, + 1 spec non trackée.

## 4. Tests ajoutés / modifiés

**RED (avant production, résultats conservés)** — suite API complète, échecs attendés uniquement sur les 4 corrections :
- `RolesGuard` : le test « refus propre sans user » échouait — `TypeError` reçue au lieu de `ForbiddenException` (confirmait le défaut N-1).
- Matrice `adminOnlyRoutes` : les 4 entrées analytics échouaient — `readRoles` renvoyait `undefined` au lieu de `[admin]` (confirmait C-2) ; le test C-2 échouait pour la même raison.
- `CreateSectionDto` : le test « refuse un nom uniquement d'espaces » échouait — 0 erreur de validation renvoyée (confirmait N-2).
- `SalesController` : les 2 tests de métadonnée échouaient — `ParseObjectIdPipe` absent des routes (confirmait M-1). Les 3 tests du pipe passaient déjà (pipe existant et testé en 0A).

Aucun échec inexpliqué : chaque test rouge correspondait exactement à l'un des 4 défauts à corriger.

**GREEN (après corrections)** : `pnpm --filter api test` → **84/84 tests, 11 suites, 0 échec** (84 = 73 de 0A + 1 nouvelle branche de refus de garde + tests C-2/DTO remplacés + 5 nouveaux tests du contrôleur sales). Aucun `skip`, `todo`, `only` ; aucune assertion affaiblie — les anciennes « pins » documentant les vulnérabilités ont été **remplacées par les assertions de la correction**, pas conservées.

Aucune écriture E2E (MongoDB de dev live sur 27017 — non isolable) : la vérification est unitaire, externes 100 % mockés (pas d'accès DB/S3/réseau).

## 5. Commandes exécutées (étape 6)

| Commande | Résultat |
|----------|----------|
| `git status --short` | 6 fichiers `M` (4 production + 2 specs) + 1 `??` (nouveau spec). Rien d'autre. |
| `git diff --check` | Exit 0 (uniquement les avertissements CRLF habituels du repo Windows, pré-existants) — aucune erreur de whitespace/conflict. |
| `pnpm --filter api test` | **84/84 OK** (11 suites, ~6 s) |
| `pnpm --filter api lint` | **Exit 0** (script officiel `eslint … --fix` — le `--fix` fait partie du script du projet ; l'étape 1 a déjà confirmé que le tree n'est pas modifié par lui) |
| `pnpm --filter api build` | **OK** (`nest build`, sans erreur) |
| `pnpm --filter web lint` | **Exit 0** (front non modifié — vérification par contrôle) |
| `pnpm --filter web build` | **OK** (Next.js 16.2.12 Turbopack, 10 routes, sans erreur — front non modifié) |
| `git diff --stat` / `git diff` | +94/−39 sur 6 fichiers ; contenu du diff revu ci-dessus dans la conversation (voir aussi `docs/security/phase-0b1-api-authorization.md` pour la version textuelle) |
| `git log --oneline -5` | Baseline intacte : `de9ca18` (dev) parent de la branche `security/phase-0b1-api-authorization` |

## 6. Résultats

- **4/4 défauts autorisés corrigés** par des changements minimaux, chacun verrouillé par un test écrit avant la correction (RED) et vert après (GREEN).
- **84/84 tests API** ; lints API + web verts ; builds API + web verts ; `git diff --check` propre.
- **Aucun** schéma modifié, **aucune** migration, **aucune** nouvelle dépendance, **aucun** changement front-end, **aucun** formatage hors fichiers de la phase, **aucune** écriture E2E, **aucun commit** de la phase 0B.1 (en attente de validation).

## 7. Risques résiduels

1. **Front-end non aligné (impact utilisateur immédiat)** : l'app web expose toujours le lien `/analytics` à un vendeur (le build confirme la route statique `/analytics`). Après ce changement, une requête vendeur → `403`. C'est le comportement **voulu** et sécurisant, mais l'UI vendeur affichera une erreur crue tant que la page n'est pas masquée pour le rôle `seller`. Report explicitement (front hors périmètre 0B.1).
2. **E2E non exécutable** : MongoDB de dev live sur 27017, aucune isolation de base de données de test possible → pas de test E2E de la 0B.1 ; couverture unitaire uniquement. Tout défaut d'intégration (ex. interaction JwtAuthGuard↔RolesGuard en production réelle) n'est vérifiable qu'en E2E ou en recette manuelle.
3. **`pnpm --filter api lint` contient `--fix`** dans le script du projet (choix pré-existant). Exécuté comme demandé aux étapes 1 et 6 ; l'état du tree a été re-vérifié après (`git status`/`git diff`) : aucun fichier non prévu modifié.
4. **Pas de trim dans le DTO** : `'  Parfums  '` reste valide (comportement documenté et testé). Le trim éventuel se fait au niveau schéma si implémenté ; ce risque cosmétique est assumé et tracé.
5. **Profondeur uniquement défensive sur N-1** : en production le `JwtAuthGuard` global renvoie du `401` avant le `RolesGuard` ; le `403` sans `TypeError` protège le cas dégénéré (ex. garde réutilisée localement sans JWT). RAS, mais la couverture E2E manque (voir risque 2).

## 8. Éléments reportés (explicitement non traités ici)

Conformément au périmètre validé, **rien n'a été touché** à :
- **C-3 / enregistrement public** : premier utilisateur ne devient pas admin ; la politique d'enregistrement (ouverte/fermée/invités) n'existe pas encore.
- **C-4 / WebSockets** : `EventsGateway` non protégé par rôle (le JWT global seul ne couvre pas les namespaces Socket.IO) — non modifié.
- **E-1 / CORS** : configuration CORS par défaut (toute origine) — non modifiée.
- **E-5 / transactions MongoDB** : aucun transactionnel (création de vente + décrément de stock multi-opérations) — non modifié.
- **Multi-tenant / organisations** : aucun `organizationId` — hors périmètre.
- **S3 / MinIO** : non modifié.
- **Front-end** : aucune modification (`web/` non modifié — lints/build de contrôle uniquement).
- **Abonnements / facturation** : hors périmètre.
- **Aucun commit** de la phase 0B.1 n'a été créé (contrainte explicite de l'utilisateur).

## 9. Proposition pour la phase 0B.2

Classée par sécurité × effort, toujours sans front ni multi-tenant :
1. **CORS (E-1)** : remplacer le `origin: true` / config par défaut par une liste d'origines autorisées configurable (env), et tester la réflexion des headers. (Correction de 1 fichier, `main.ts` + 1 spec.)
2. **C-3 + politique d'enregistrement** : soit (a) désactiver l'enregistrement public et provisionner le premier admin par script CLI idempotent (commande `nest` ou script node, versionné, sans secret en clair), soit (b) conserver l'enregistrement public mais figer le rôle à `SELLER` explicitement + documenter. À décider avec l'utilisateur.
3. **Rate limiting `/auth/*`** : limiter le nombre de tentatives de login/registration par IP (middleware NestJS sans dépendance supplémentaire possible, ou `express-rate-limit` si l'ajout de dépendance est validé).
4. **E2E isolable** : proposer à l'utilisateur l'ajout de `mongodb-memory-server` (dépendance dev uniquement, à valider) pour lever le blocage E2E et couvrir les flux auth→sales end-to-end.
5. *(Optionnel, à l'interface avec le périmètre front)* : masquer le lien `/analytics` côté web pour le vendeur — à engager uniquement dans une phase front dédiée (0B.2-web ou phase 2).

**Ordre recommandé** : 4 (débloquant) → 1 → 2 → 3 (le 2 exige la décision humaine : politique d'enregistrement).

---

*Rapport généré à la fin de l'étape 7 de la phase 0B.1. Aucun commit n'est créé : le diff et ce rapport sont présentés pour validation.*
