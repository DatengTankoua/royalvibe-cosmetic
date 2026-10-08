# Phase 1-8A — Branding d'organisation et logo tenant

**Branche** `architecture/phase-1-8a-organization-branding` · **Base** `760f8e1` (1-7C) — aucun commit, aucun push, aucun accès 27017/Atlas/Supabase.

## Décision de marque
Produit global **Stock Master**. Palette plateforme (frontend futur) : bleu foncé `#062B5C`, orange `#FF6A00`, blanc `#FFFFFF`. `Organization.brandColor` reste une **unique** couleur d'accent personnalisable (aucun second champ) ; défaut changé `#b8960c` → `#FF6A00` (production vide, aucune migration).

## Endpoints (`organization-branding.controller.ts`, nouveau)
| Route | Permission | Contrat |
|---|---|---|
| `GET /organizations/current` | aucune (tout membre actif) | `{_id,name,slug,brandColor,currency,status,logoUrl}` — jamais `logoKey`. |
| `PATCH /organizations/current/branding` | `@RequirePermissions(branding.manage)` | multipart ; DTO strict `{name?,brandColor?}` (whitelist globale rejette `slug/currency/status/logoKey/organizationId` → 400) ; `name` trim/non-vide/≤100 ; `brandColor` `#RRGGBB` strict ; logo image optionnel ; body vide sans logo → 400. |
| `DELETE /organizations/current/logo` | `@RequirePermissions(branding.manage)` | `logoKey` → `null`, supprime uniquement l'ancien objet tenant. |

`organizationId` exclusivement `CurrentOrganization` (jamais body/query/header).

## Stockage — `S3Service` étendu (Products intact)
`uploadFile`/`deleteFile` **conservés inchangés** (comportement identique, refactorés en interne). Ajouts : `uploadStoredFile()` → `{key,url}` ; `publicUrlForKey(key)` (URL déterministe, aucun réseau) ; `deleteStoredKey(key, allowedPrefix)` (frontière `allowedPrefix + '/'`, jamais un `startsWith` nu — clé B/legacy/voisine refusée). Préfixe exact : `organizations/<organizationId>/branding`.

## Cycle logo (`OrganizationBrandingController`, même convention que `ProductsController`)
Upload AVANT mutation DB → DB échoue : nouveau fichier supprimé, erreur repropagée ; DB réussit : ancien logo supprimé APRÈS sauvegarde. `DELETE` : DB à `null` avant nettoyage. Nom de fichier sanitizé (mécanisme 1-5B, inchangé).

## Service (`OrganizationsService` +`getCurrent`/`updateBranding`/`removeLogo`)
Filtre exact `{_id: organizationId}` (l'Organization EST le tenant). Champs mis à jour explicitement (jamais de spread du DTO). Retourne `{organization, previousLogoKey}` — le contrôleur décide du nettoyage S3 (hors transaction Mongo, comme Products). `logoUrl` dérivée de `logoKey` via `S3Service.publicUrlForKey` (injecté), jamais recalculée depuis une entrée cliente.

## Fichiers (6 prod + 6 tests + rapport)
Prod : `s3/s3.service.ts`, `organizations/schemas/organization.schema.ts` (défaut couleur), `organizations/dto/update-branding.dto.ts` (nouveau), `organizations/organizations.service.ts`, `organizations/organization-branding.controller.ts` (nouveau), `organizations/organizations.module.ts`.
Tests : `s3/s3.service.spec.ts`, `organizations/organization.schema.spec.ts`, `organizations/dto/update-branding.dto.spec.ts` (nouveau), `organizations/organizations.service.spec.ts`, `organizations/organization-branding.controller.spec.ts` (nouveau), `test/organization-branding.e2e-spec.ts` (nouveau, 16 tests, S3Service **espionné** — jamais un provider overridé, même convention que `multitenant-isolation.e2e-spec.ts` — aucun réseau réel).

## Matrice de tests couverte
Lecture minimale + `logoUrl` calculée, `logoKey` jamais exposée ; **seller sans `branding.manage` → `GET` 200 (vue minimale) ; `PATCH`/`DELETE` 403 `PERMISSION_DENIED`** (aucune permission sur `GET`, ni au niveau classe ni méthode) ; seller délégué `branding.manage` → 200 sur les 3 routes, dans SON org uniquement ; falsification `organizationId/logoKey/slug/status/currency` → 400 (whitelist globale) ; couleur invalide et nom vide → 400 ; upload réussi (clé tenant exacte) puis ancienne supprimée après DB ; échec DB → nouveau logo supprimé, ancien conservé (unit `organization-branding.controller.spec.ts`) ; `DELETE` logo tenant + no-op si déjà `null` ; clé B/legacy/préfixe voisin jamais supprimée (`S3Service` unit) ; deux organisations isolées (e2e) ; défaut `#FF6A00` (schema + e2e) ; **membership suspendue APRÈS émission du token → 403 sur les 3 routes ; organisation suspendue → 403 sur `GET`** (`OrganizationGuard`, relecture à chaque requête, jamais un contrôle au seul login).

## Résultats
- Exécution initiale (une fois chacune) : `pnpm --filter api test` **640/640** (38 suites) ; `pnpm --filter api test:e2e` **186/186** (7 suites) ; eslint **0 erreur/2 warnings historiques** ; build OK ; `git diff --check` OK.
- Correction ciblée — commandes **ciblées uniquement** (pas de passe complète relancée) :
  `pnpm --filter api test -- organization-branding.controller.spec` → **12/12**.
  `pnpm --filter api test:e2e -- organization-branding.e2e-spec` → **20/20** (16 + 4 nouveaux).

## Correction ciblée (post-revue)
Le contrôleur était **déjà conforme** (aucun `@RequirePermissions` de classe, `GET` non décoré, `PATCH`/`DELETE` seuls sous `branding.manage`) : seul ce rapport affirmait à tort un 403 sur `GET` pour un seller non délégué (corrigé ci-dessus). Aucun fichier de production modifié. Tests ajoutés : assertion classe (aucune métadonnée héritée), `GET`/`DELETE` délégué (`organization-branding.controller.spec.ts`), garde `OrganizationGuard` sur membership/organisation suspendues après émission du token (`organization-branding.e2e-spec.ts`, +4 tests).

## Hors périmètre
Aucun frontend, email, abonnement. Aucune modification de permissions existantes (`branding.manage` préexistait depuis 1-1A). Aucun second champ couleur. `Products`/stockage 1-5B intacts (tests verts, `uploadFile`/`deleteFile` inchangés).

Aucun commit, aucun push — en attente de validation.
