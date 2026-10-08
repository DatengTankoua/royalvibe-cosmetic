# Phase 1-12C — Validation des noms et sécurisation des logos tenant

Branche `architecture/phase-1-12c-name-logo-validation`, base `ace723c` (feat(web): redesign tenant dashboard home).

Historique de la phase :
1. **Audit, puis blocage** : aucune bibliothèque de décodage d'image n'était une dépendance directe de l'API.
2. **Validation** de `sharp@0.35.5` en version exacte.
3. **Implémentation.**

Aucun accès Atlas, Supabase ni production. Aucun commit, aucun push.

## 1. Audit initial

### Nom utilisateur — chemins d'écriture

| Flux | Fichiers | Avant 1-12C |
| --- | --- | --- |
| `POST /auth/register` | `auth/dto/register.dto.ts`, `auth.service.ts` `createOwnerUser` → `UsersService.create` | `@MaxLength(100)` sans trim préalable : `"   "` passait le DTO. |
| `POST /auth/invitations/accept` (nouveau compte) | `auth/dto/accept-invitation.dto.ts`, `organizations.service.ts` → `UsersService.create` | Idem. |
| Autres | — | Aucun (pas de modification de profil ; `scripts/mongo` ne contient que `init-replica-set.js`). |
| Schéma `User.name` | `users/schemas/user.schema.ts` | `required, trim`, **aucune longueur max**. |

### Nom d'organisation — chemins d'écriture

| Flux | Fichiers | Avant 1-12C |
| --- | --- | --- |
| `POST /auth/register` | `register.dto.ts` (`organizationName`), `OrganizationsService.createOwnerOrganization` | `@MaxLength(100)` sans trim préalable. |
| `PATCH /organizations/current/branding` | `update-branding.dto.ts`, `OrganizationsService.updateBranding` | `@MaxLength(100)` **avant** trim ; trim en service. |
| Schéma `Organization.name` | `organizations/schemas/organization.schema.ts` | `trim, minLength 1, maxlength 100`. |

Les seuls `save()` sur des documents Organization sont ceux du branding (`updateBranding`, `removeLogo`). Il n'y a aucun `save()` sur un document User.

### Logo tenant — avant 1-12C

- **Filtre** : uniquement `file.mimetype.startsWith('image/')`, soit le MIME **déclaré par le client**. SVG, JPEG, GIF et texte déclaré `image/png` étaient acceptés.
- **Taille** : limite de 5 Mio.
- **Stockage** : clé `…/<uuid>-<originalname assaini>` ; `ContentType` = MIME client, ce qui permettait de servir un SVG actif.
- **Déjà conformes** : cycle remplacement/suppression, frontière `allowedPrefix + '/'`, non-exposition de `logoKey`.

## 2. Dépendance

| Point | Résultat |
| --- | --- |
| Avant | Aucune bibliothèque d'image directe dans l'API. `sharp@0.34.5` présent **seulement** de façon transitive via `next` (web). |
| Ajout validé | `pnpm --filter api add sharp@0.35.5 --save-exact` → `"sharp": "0.35.5"`. Seuls `api/package.json` et `pnpm-lock.yaml` changent. |
| `pnpm --filter api why sharp` | `sharp@0.35.5 └── api@0.0.1 (dependencies)` — 1 version. |
| `pnpm --filter web why sharp` | `sharp@0.34.5 └─┬ next@16.2.12 └── web` — **inchangé** (package web non modifié). |
| Local (win32) | libvips 8.18.7, libpng 1.6.58, libwebp 1.6.0. |
| Docker | Voir § 7. |

## 3. Contrats finaux

### Noms

`api/src/common/validation/name-rules.ts` est la source unique : organisation **20**, utilisateur **20**.

- **DTO** (`register.name`, `register.organizationName`, `acceptInvitation.name`, `branding.name`) : `@Transform(trimString)` **avant** validation, `@IsString`, `@IsNotEmpty` (espaces seuls refusés), `@MaxLength`. HTTP 400 avec un message simple (« Le nom de l'organisation doit contenir entre 1 et 60 caractères. » / « Le nom doit contenir entre 1 et 80 caractères. »).
- **Persistance** : `ValidationPipe({ transform: true })`, donc la valeur trimée est celle persistée. Unicode et accents autorisés. Longueur en unités `String.length`, comme l'attribut HTML `maxLength`.
- **Défense en profondeur** :
  - schémas `User.name` (`minlength 1, maxlength 80`) et `Organization.name` (`maxlength 60`) ;
  - contrôle explicite en service (`INVALID_BRANDING_NAME`) ;
  - affectations explicites, aucun spread, aucune troncature silencieuse.
- **Whitelist stricte** : inchangée (`forbidNonWhitelisted`), testée.
- **Frontend** (`web/src/lib/name-limits.ts`) : `maxLength` 60/80 et indication « N caractères maximum. » sur l'inscription, l'acceptation d'invitation et le branding. Le backend reste l'autorité.

### Logo (organisation uniquement)

`api/src/organizations/logo/logo-validation.ts`, appelé par le contrôleur **avant** tout appel S3 ou DB :

1. Fichier présent et non vide → sinon `LOGO_INVALID_FILE`.
2. Taille ≤ 2 Mio :
   - limite Multer à 2 Mio : un fichier plus gros n'est jamais bufferisé en entier ;
   - `LogoUploadInterceptor` convertit le 413 générique de Multer en `LOGO_TOO_LARGE` ;
   - contrôle répété dans le validateur.
3. Extension `.png` / `.webp`, casse ignorée. `originalname` ne sert **qu'à** ce contrôle.
4. MIME déclaré `image/png` / `image/webp`.
5. Signature réelle :
   - PNG : 8 octets officiels ;
   - WebP : `RIFF` + `WEBP` aux octets 8–11 ;
   - autre contenu → `LOGO_INVALID_FILE`.
6. Cohérence extension / MIME / signature, sinon `LOGO_INVALID_FORMAT`.
7. Ouverture Sharp avec **`limitInputPixels: 2048 × 2048`** dès l'ouverture et **`failOn: 'warning'`**.
   - `metadata()` : format détecté par le contenu, `png` ou `webp` **uniquement**, et égal à la signature, donc à l'extension et au MIME.
   - Dimensions **issues de Sharp** : ≤ 2048 × 2048, sinon `LOGO_INVALID_DIMENSIONS`. Le dépassement de la limite de pixels est reconnu à l'ouverture (message documenté de Sharp, couvert par un test).
8. Décodage **complet** via `stats()`, qui parcourt tous les pixels sans produire ni conserver d'image. Un fichier corrompu → `LOGO_INVALID_FILE`.

**Défense en profondeur Sharp** (API documentée) :
- `sharp.block({ operation: ['VipsForeignLoad'] })` puis `unblock` de `VipsForeignLoadPngBuffer` et `VipsForeignLoadWebpBuffer` : aucun autre chargeur libvips (SVG, HEIF, TIFF, GIF, JPEG…) n'est exécutable dans le processus API ;
- `sharp.cache(false)` : aucun cache d'opérations.

**Stockage** (`S3Service.uploadValidatedImage`) :
- clé `organizations/<orgId>/branding/<uuid>.<png|webp>`, sans nom client ;
- `ContentType` fixé depuis le format **détecté** ;
- octets stockés **identiques** à ceux reçus : aucune transformation, aucune nouvelle version ;
- référence au contenu relâchée dans le contrôleur après l'envoi (`file.buffer` vidé en `finally`).

`uploadStoredFile` / `uploadFile` (produits) sont inchangés.

**Cycle S3** (inchangé, testé) :
- remplacement : validation → upload → mutation DB → échec DB : suppression du nouveau ; succès : suppression de l'ancien **après** la mutation ;
- suppression : DB à `null`, puis objet supprimé ;
- frontière `allowedPrefix + '/'` conservée.

**Erreurs** (`{ code, message }`, convention existante) :

| Code | HTTP | Message |
| --- | --- | --- |
| `LOGO_INVALID_FORMAT` | 400 | Le logo doit être une image PNG ou WebP. |
| `LOGO_TOO_LARGE` | 413 | Le logo ne doit pas dépasser 2 Mo. |
| `LOGO_INVALID_DIMENSIONS` | 400 | Le logo ne doit pas dépasser 2048 × 2048 pixels. |
| `LOGO_INVALID_FILE` | 400 | Fichier image vide, corrompu ou illisible. |

Aucune stack, clé S3, chemin local, signature ni contenu n'est exposé ou journalisé (testé).

**Frontend** : `accept="image/png,image/webp,.png,.webp"`, indication « PNG ou WebP, 2 Mo et 2048 × 2048 pixels maximum. », pré-contrôle de confort de la taille. Les messages d'erreur backend sont affichés tels quels.

## 4. Compatibilité historique

Aucune migration ni réécriture.
- **Nom d'organisation au-delà de 20 caractères** : `updateBranding` et `removeLogo` sauvegardent avec **`validateModifiedOnly: true`**. Un nom historique inchangé n'est donc pas revalidé ; seul un **nouveau** nom est soumis à la limite.
- **Utilisateurs** : aucune écriture ultérieure de `User` n'existe ; la lecture n'est pas affectée.
- **Affichage** : tronqué visuellement avec `title` complet (1-12A) ; l'API renvoie la valeur complète.

Testé en e2e :
- organisation de 100 caractères lue complète ;
- `brandColor` seule → 200, nom intact ;
- logo seul puis suppression → 200, nom intact ;
- nouveau nom de 61 caractères → 400 ;
- utilisateur de 100 caractères : connexion et `/auth/me` OK.

Côté navigateur (Playwright) : organisation B au nom historique de 83 caractères écrit en base. Son changement de couleur via HTTP → 200, affichage tronqué sans débordement de 320 à 1 280 px.

## 5. Fichiers

| Fichier | Changement |
| --- | --- |
| `api/package.json`, `pnpm-lock.yaml` | `sharp` 0.35.5 exact (API uniquement). |
| `api/src/common/validation/name-rules.ts` (+ spec) | **Nouveau** : limites 20/20, trim, messages. |
| `api/src/auth/dto/register.dto.ts`, `accept-invitation.dto.ts`, `organizations/dto/update-branding.dto.ts` | Trim + 1–20 / 1–20. |
| `api/src/users/schemas/user.schema.ts`, `organizations/schemas/organization.schema.ts` | `maxlength` 20 / 20. |
| `api/src/organizations/organizations.service.ts` | Contrôle explicite du nom, `validateModifiedOnly` sur les deux sauvegardes de branding. |
| `api/src/organizations/logo/logo-validation.ts` (+ spec) | **Nouveau** : contrat logo complet (Sharp). |
| `api/src/organizations/logo/logo-upload.interceptor.ts` | **Nouveau** : Multer 2 Mio → `LOGO_TOO_LARGE`. |
| `api/src/organizations/organization-branding.controller.ts` (+ spec) | Validation avant S3/DB, upload canonique, buffer relâché. |
| `api/src/s3/s3.service.ts` | `uploadValidatedImage` (clé UUID + extension canonique, `ContentType` serveur). |
| `api/test/organization-branding.e2e-spec.ts` | Fixtures réelles, 1-12C : noms, historique, logo, cycle S3, isolation, produits. |
| `web/src/lib/name-limits.ts` | **Nouveau** : miroir des limites. |
| `web/src/app/auth/register/page.tsx`, `auth/invitations/accept/page.tsx`, `app/organization/branding/page.tsx` | `maxLength`, indications, `accept` PNG/WebP. |

## 6. Résultats (exécutions réelles)

| Vérification | Résultat |
| --- | --- |
| Tests unitaires API (`jest`) | **46 suites, 763/763** — dont `logo-validation` 20, `name-rules` 11, contrôleur de branding 14. |
| E2E API (`jest-e2e`, `MongoMemoryReplSet`) | **12 suites, 264/264** — dont `organization-branding` 51. |
| eslint API | 0 erreur (2 avertissements préexistants dans `test/app.e2e-spec.ts` et `test/e2e/ephemeral-mongodb.ts`, non modifiés). |
| eslint web + `tsc` web | OK. |
| TypeScript API (`tsconfig.build.json`) | OK ; aucune erreur dans les sources de production. |
| `nest build` | OK. |
| `next build` | OK. |
| Playwright 1-12A contre la nouvelle API (`next build` + `next start`) | **16/16** : logo 36 × 36, logo cassé → initiales, contrastes, hors ligne, isolation A/B, nom historique. |
| `pnpm audit` | 45 (5 low, 18 moderate, 20 high, 2 critical), **identique** à l'audit du lockfile de base `ace723c` : **0 différence**. Sharp 0.35.5 n'introduit aucun avis. |
| `git diff --check` | Propre. |

Premières exécutions, corrigées avant le résultat final :

- **Unitaires, 19/20.** Le cas 2049 × 2049 renvoyait `LOGO_INVALID_FILE` au lieu de `LOGO_INVALID_DIMENSIONS`, car Sharp 0.35 applique la limite de pixels dès `metadata()`. **Correctif applicatif** : mapping de l'erreur de limite de pixels.
- **E2E : erreurs de test uniquement.**
  - le contrôle de fuite interceptait le champ public `path` ;
  - conventions HTTP existantes à respecter : acceptation d'invitation = 200, login = 201 ;
  - intitulés `it.each` mal formatés ;
  - `async` sans `await` relevés par eslint.
- **Unitaire contrôleur, 3 échecs** : il testait l'ancien flux (faux octets, `uploadStoredFile`). Il a été adapté aux fixtures réelles, avec deux nouveaux cas (fichier invalide → zéro S3/DB ; buffer relâché).
- **Playwright 1-12A.** Cinq assertions visaient l'ancien accueil, retiré en 1-12B (logo 80 px, bouton « Accéder au catalogue ») ; elles ciblent désormais l'accueil 1-12B. Une mesure 7a prise pendant la transition de couleur de 150 ms donnait 2,77 ; elle vaut 4,85 une fois la transition terminée.

### Tests couverts (sections 8 et 9 de la demande)

**Noms** :
- organisation 20 → OK, 21 → 400 ;
- utilisateur 20 → OK, 21 → 400 ;
- trim persistant (vérifié en base) ; espaces seuls → 400 sans compte créé ;
- Unicode et accents (É, Ñ, 李) ;
- inscription, acceptation d'invitation avec nouveau compte, branding ;
- whitelist stricte ;
- documents historiques lisibles, modification indépendante autorisée.

**Logos** (fixtures PNG/WebP/JPEG/GIF réelles générées par Sharp en mémoire, SVG textuel, aucun réseau) :
- **Acceptés** :
  - PNG et WebP valides ;
  - `LOGO.PNG` → clé `.png`, nom client absent de la clé ;
  - exactement 2048 × 2048 (PNG et WebP).
- **Refusés** :
  - PNG renommé `.webp`, MIME falsifié, texte `image/png`, vide, tronqué, IDAT corrompu, WebP corrompu ;
  - plus de 2 Mio → 413 ;
  - largeur 2049, hauteur 2049, 2049 × 2049 ;
  - SVG, JPEG et GIF, déclarés tels quels ou déguisés.
- **Chaque refus e2e** : zéro appel au client S3, `logoKey` et `updatedAt` inchangés en base, aucune fuite interne.
- **Cycle S3** :
  - échec DB → nouveau fichier supprimé, ancien conservé ;
  - succès → l'ancien est supprimé alors que la DB pointe **déjà** vers le nouveau ;
  - suppression inchangée ;
  - isolation A/B (préfixe de B seulement).
- **Produits** : JPEG toujours accepté via `uploadFile`, clé et `ContentType` historiques, jamais le contrat logo.
- **Shell 1-12A** : logo ou initiales (Playwright 16/16).

## 7. Validation Docker (image API réelle, `api/Dockerfile`)

| Étape | Résultat |
| --- | --- |
| Build de référence avant Sharp (`heyama-api:1-12c-before`, même base `ace723c`) | OK. |
| Build après (`heyama-api:1-12c-after`) | OK, aucune étape `apk`. |
| `node -e "import('sharp')"` dans le conteneur | `ESM import OK 0.35.5`. |
| Plateforme | `linux x64`, **libc `musl`** (detect-libc), Node v20.20.2, `@img/sharp-linuxmusl-x64` présent. |
| Décodage dans le conteneur via le **code compilé** `dist/organizations/logo/logo-validation.js` | PNG → `{format: png, contentType: image/png}` ; WebP → `{format: webp, contentType: image/webp}` ; PNG tronqué → 400 `LOGO_INVALID_FILE` ; 2049 × 1 → 400 `LOGO_INVALID_DIMENSIONS` ; JPEG déguisé → 400 `LOGO_INVALID_FILE`. |
| Taille de l'image | Contenu 92,1 Mo → **109,2 Mo** (+17,2 Mo) ; disque 521 → 578 Mo. |
| `node_modules` | 249 → **287 Mo** (+38 Mo). |

Répartition des +38 Mo de `node_modules` :
- **utile, environ 21 Mo** : `sharp-libvips-linuxmusl-x64` 19 Mo, `sharp-linuxmusl-x64`, `sharp`, `@img/colour` ;
- **inutile, environ 19 Mo** : la variante glibc (`sharp-libvips-linux-x64` 18 Mo, `sharp-linux-x64`), installée parce que `pnpm install` n'est pas filtré par libc.

## 8. Risques résiduels

- **Multer 2.2.0 (API), préexistant et hors périmètre.** Les avis s'appliquent à **tous** les uploads, y compris le logo :
  - GHSA-wc9g-mqfw-jrwm (high, DoS par noms de champs) ;
  - GHSA-qfvm-cv95-jqjf (high, fuite de descripteurs sur upload interrompu) ;
  - GHSA-535w-7cp7-47q4 (high) ;
  - GHSA-3pph-fpjx-jg34 (moderate) ;
  - GHSA-qvfw-j98x-7q72 (low ; le logo n'utilise plus de `fileFilter`).

  Mise à jour de Multer (≥ 2.4.0) recommandée dans une phase dédiée.
- **Dockerfile** :
  - installation sans lockfile et avec les devDependencies (préexistant) ;
  - binaires glibc de Sharp embarqués inutilement (environ 19 Mo) : filtrer par libc via `supportedArchitectures.libc = ['musl']` (configuration pnpm), hors fichiers autorisés ici.
- **Surface native Sharp/libvips** : suivre les avis de sécurité (versions 0.35.x). La version exacte impose une mise à jour volontaire.
- **`failOn: 'warning'`** : strict. Un PNG exporté avec un profil ICC défectueux sera refusé (`LOGO_INVALID_FILE`) ; il suffit de le réexporter.
- **Détection de la limite de pixels** : repose sur le message documenté de Sharp (`exceeds pixel limit`). Un test échouera si une mise à jour le change.
- **Limites de longueur** en unités UTF-16 : un emoji compte pour 2, comme dans le navigateur.
- **Anciens objets S3** (clés `<uuid>-<nom>`) : conservés tels quels jusqu'au prochain remplacement ou à la prochaine suppression.
- **Transition de couleur (1-12B)** : contraste intermédiaire pendant 150 ms lors du premier chargement de la couleur tenant, sans effet une fois stabilisé.

### Risque hors périmètre, documenté séparément : Sharp transitif du frontend

`web` → `next@16.2.12` → **`sharp@0.34.5`**, sous deux avis **high** :
- GHSA-f88m-g3jw-g9cj : libvips, CVE-2026-33327, -33328, -35590 et -35591 ;
- GHSA-rgj7-g3m4-5g8c : libheif.

Ils concernent l'optimiseur d'images de Next (`/_next/image`). Le shell et les logos utilisent `unoptimized`, mais la route reste servie par `next start`.

Ni la dépendance web ni sa version ne sont modifiées ici, conformément à la consigne. Une mise à jour de `next`, ou un override pnpm validé, relève d'une phase dédiée.
