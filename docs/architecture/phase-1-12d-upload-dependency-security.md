# Phase 1-12D — Durcissement des dépendances d'upload et des images

Branche `architecture/phase-1-12d-upload-dependency-security`, base `fd2872c` (1-12C). Aucun commit, aucun push. **Aucun accès à Atlas, Supabase ni au port 27017 ; aucune donnée réelle** : tous les tests utilisent `MongoMemoryReplSet` éphémère et un S3 simulé.

## Décisions définitives de la phase

| Sujet | Décision |
| --- | --- |
| Noms | **Utilisateur et organisation limités à 20 caractères** (après trim, espaces seuls refusés), frontend et backend. |
| Formats de logo acceptés | **PNG, WebP statique, JPEG** (`.jpg`, `.jpeg`). |
| Clé S3 d'un JPEG | Toujours `<uuid>.jpg`, **y compris pour un fichier client `.jpeg`**. |
| Formats refusés | SVG, GIF (même statique), WebP animé ou multi-page, AVIF, HEIC/HEIF, TIFF, BMP, ICO, JPEG XL, tout autre format. |
| APNG | **Limite acceptée** : Sharp/libvips ne détecte pas l'animation APNG ; aucun parseur maison. Les PNG animés ne sont donc **pas** tous refusés. |
| Politique Sharp | Centralisée, idempotente, appliquée **une fois au bootstrap Nest** pour tout le processus API. |
| Multer / Next.js | `multer@2.4.0`, `@nestjs/platform-express@11.2.6`, limites multipart durcies, `next@16.3.6`. |
| Dockerfiles | Non corrigés dans 1-12D, reportés à **1-12E — Builds Docker reproductibles**. |

## 1. Audit initial (base `fd2872c`)

### Versions et origine (`pnpm-lock.yaml`)

| Paquet | Version | Origine |
| --- | --- | --- |
| `multer` | 2.2.0 | Directe (`api` → `^2.2.0`) et via `@nestjs/platform-express@11.1.28` (`multer: 2.2.0` exact). |
| `@nestjs/platform-express` | 11.1.28 | Directe (`api` → `^11.0.1`) ; pair optionnel de `@nestjs/core`. |
| `busboy` / `append-field` | 1.6.0 / 1.0.0 | Via `multer`. |
| `next` | 16.2.12 | Directe (`web`, exacte). |
| `sharp` | 0.35.5 (directe, `api`) ; 0.34.5 (transitive, `web` → `next@16.2.12`, `^0.34.5`) | — |
| `@img/sharp-*` | 0.34.5 + libvips 1.2.4 ; 0.35.5 + libvips 1.3.4 | Binaires natifs optionnels. |

Dernières versions stables (registre npm, 30/09/2026) :
- **multer** : `multer@2.4.0` (`3.0.0-alpha.2` écartée).
- **platform-express** : `@nestjs/platform-express@11.2.6` (dernière 11.x, dépend de `multer 2.4.0`).
- **next 16.2.x** : aucun patch après 16.2.12.
- **next 16.3.x** : `next@16.3.4` et suivantes exigent `sharp ^0.35.4` et `postcss 8.5.23`.

### Exploitabilité dans Stock Master

Multer utilise la mémoire partout (aucun `diskStorage`). Les gardes JWT, organisation et permission sont globales et passent **avant** les intercepteurs d'upload.

| Avis | Paquet | Corrigé en | Exploitable dans Stock Master |
| --- | --- | --- | --- |
| GHSA-wc9g-mqfw-jrwm (high) — crash par noms de champs | multer < 2.3.0 | 2.3.0 | Oui, par un membre authentifié autorisé. |
| GHSA-535w-7cp7-47q4 (high) — index de tableau, CPU | multer < 2.3.0 | 2.3.0 **opt-in** | Oui, par un membre authentifié autorisé. |
| GHSA-qfvm-cv95-jqjf (high), GHSA-3pph-fpjx-jg34 (moderate) | multer | 2.3.0 / 2.4.0 | Non (`diskStorage` uniquement). |
| GHSA-qvfw-j98x-7q72 (low) | multer < 2.3.0 | 2.3.0 | Non (`fileFilter` synchrones ou absents). |
| GHSA-2xp9-vwfh-vxw4 (**critical**) — RCE, optimiseur d'images | next < 16.3.3 | 16.3.3 | Oui : `/_next/image` servi par `next start`. |
| GHSA-p293-qw3h-jr36 (**critical**) — RCE sous Windows | next < 16.3.3 | 16.3.3 | Seulement si hébergement Windows. |
| GHSA-f88m-g3jw-g9cj, GHSA-rgj7-g3m4-5g8c (high) | sharp 0.34.5 (web) | 0.35.0 / 0.35.4 | Via `/_next/image`. |
| GHSA-6g55, -r28c, -fxqj, -qx2v | postcss 8.4.31 (via `next`) | 8.5.23 | Outil de build. |

Base : `pnpm audit` = **45** (2 critical, 20 high, 18 moderate, 5 low).

## 2. Noms : 20 / 20

- **Source unique backend** : `api/src/common/validation/name-rules.ts` → `ORGANIZATION_NAME_MAX_LENGTH = 20`, `USER_NAME_MAX_LENGTH = 20`.
- **Frontend** : `web/src/lib/name-limits.ts`, mêmes valeurs. Un test API relit ce fichier et **échoue si les deux divergent**.
- **Règle** : trim **avant** validation et avant le calcul de longueur ; 1 à 20 caractères ; espaces seuls refusés ; Unicode et accents autorisés ; 400 sinon, sans troncature silencieuse. Messages :
  - « Le nom de l'organisation doit contenir entre 1 et 20 caractères. » ;
  - « Le nom doit contenir entre 1 et 20 caractères. ».
- **Appliquée à** :
  - `POST /auth/register` (`name`, `organizationName`) ;
  - `POST /auth/invitations/accept` (`name`, lorsqu'un compte est créé) ;
  - `PATCH /organizations/current/branding` (`name`) ;
  - DTO, contrôle explicite en service, schémas Mongoose `User.name` et `Organization.name` (`maxlength: 20`).
- **Compatibilité historique** (aucune migration) :
  - un nom existant de plus de 20 caractères reste lisible ;
  - les sauvegardes de branding ne revalident que les chemins modifiés (`validateModifiedOnly`) : une ancienne organisation au nom long peut changer **uniquement** sa couleur, remplacer son logo ou le supprimer ;
  - un **nouveau** nom reste soumis à la limite de 20 ;
  - testé en e2e (nom de 100 caractères) et dans le navigateur (nom de 30 caractères, couleur seule enregistrée, nom intact).
- **Formulaires web** (inscription, acceptation d'invitation, branding) : `maxLength={…}` via les constantes partagées (aucun nombre magique), indication « 20 caractères maximum. ».

## 3. Logo : PNG, WebP statique, JPEG

`api/src/organizations/logo/logo-validation.ts`, entièrement **avant** tout appel S3 ou MongoDB.

| Format | Extensions | MIME déclaré | Format Sharp | `Content-Type` S3 | Extension canonique |
| --- | --- | --- | --- | --- | --- |
| PNG | `.png` | `image/png` | `png` | `image/png` | `.png` |
| WebP | `.webp` | `image/webp` | `webp` | `image/webp` | `.webp` |
| JPEG | `.jpg`, `.jpeg` | `image/jpeg` (exactement) | `jpeg` | `image/jpeg` | **`.jpg`** |

Ordre de validation :
1. fichier présent et non vide ;
2. taille ≤ 2 Mio (413 `LOGO_TOO_LARGE`) ;
3. extension ;
4. MIME déclaré ;
5. signature réelle : PNG 8 octets ; WebP `RIFF`/`WEBP` ; JPEG `FF D8 FF`, simple indice ;
6. cohérence extension / MIME / signature ;
7. format détecté par Sharp (ouverture avec `limitInputPixels = 2048 × 2048`, `failOn: 'warning'`) ;
8. **décodage complet et strict** (`stats()`) ;
9. dimensions ≤ 2048 × 2048 ;
10. une seule page/frame (`pages`, `delay`).

La signature JPEG ne suffit jamais : Sharp doit réellement ouvrir et décoder le fichier.

**Stockage** :
- clé `organizations/<orgId>/branding/<uuid>.<png|webp|jpg>`, sans nom client ;
- `ContentType` fixé depuis le format **détecté** ;
- octets stockés **identiques** à ceux reçus (aucun ré-encodage) ;
- `logoKey` jamais exposée ; `logoUrl` dérivée de la clé serveur ;
- cycle inchangé : remplacement → suppression de l'ancien **après** la mutation DB ; échec DB → suppression du nouveau fichier, ancien conservé ;
- isolation par préfixe tenant.

Images produits inchangées.

**Codes d'erreur** (inchangés, jamais de message Sharp ni libvips) :

| Code | HTTP |
| --- | --- |
| `LOGO_TOO_LARGE` | 413 |
| `LOGO_INVALID_FORMAT` | 400 (message « Le logo doit être une image PNG, WebP ou JPEG. ») |
| `LOGO_INVALID_DIMENSIONS` | 400 |
| `LOGO_INVALID_FILE` | 400 |

**Refus démontrés** :
- **Contenu non conforme** : fichier texte déclaré `image/jpeg`, PNG renommé `.jpg`, WebP renommé `.jpeg`, JPEG tronqué, JPEG corrompu (données de scan altérées).
- **Déclarations incohérentes** : mauvais MIME (`image/png`, `image/jpg`), mauvaise extension (`.png`, `.jfif`), polyglotte JPEG + PNG déclaré PNG.
- **Limites** : JPEG 2049 × 1 et 2049 × 2049, JPEG > 2 Mio.
- **Formats hors liste** : SVG, GIF, AVIF, HEIC/HEIF, TIFF, BMP, ICO, JPEG XL, déclarés tels quels (`LOGO_INVALID_FORMAT`) ou déguisés en JPEG (`LOGO_INVALID_FILE`).

**Frontend** :
- politique centralisée dans `web/src/lib/logo-upload-policy.ts` (seul appelant : la page Branding) : `LOGO_ACCEPT = "image/png,image/webp,image/jpeg,.png,.webp,.jpg,.jpeg"`, `LOGO_MAX_BYTES` (2 Mio), `LOGO_HELP_TEXT = "PNG, WebP non animé ou JPEG, 2 Mo maximum."` ;
- `web/src/lib/name-limits.ts` ne contient plus que les limites de noms.

## 4. Logos animés et APNG

- **WebP animé** ou toute image dont Sharp expose plusieurs pages ou frames : refus, sans aucun appel S3 ou DB. Réponse :

  `400 { code: "LOGO_INVALID_FILE", message: "Le logo doit être une image PNG ou WebP statique valide." }`
- **APNG : limite acceptée pour 1-12D.** Sur une vraie APNG à 2 frames (fixture de test assemblée à partir de vraies images PNG), libvips 8.18.7 renvoie `pages: undefined` et décode la première frame. L'APNG **n'est donc pas refusée**.
  - Aucun parseur PNG maison, aucune dépendance APNG.
  - Test de **caractérisation** (`logo-animation.spec.ts`) : il échouera dès qu'une version de Sharp/libvips exposera l'animation APNG, ce qui permettra alors d'activer le refus par métadonnées.

## 5. Politique Sharp centralisée

- `api/src/common/image/sharp-security-policy.ts` → `configureSharpSecurityPolicy()`, **idempotente** : le premier appel seul configure.
  - `sharp.cache(false)` ;
  - `sharp.block({ operation: ['VipsForeignLoad'] })` ;
  - `sharp.unblock` de **`VipsForeignLoadPngBuffer`, `VipsForeignLoadWebpBuffer`, `VipsForeignLoadJpegBuffer`** uniquement.
- `api/src/common/image/image-security.module.ts` : provider `SharpSecurityPolicyInitializer` (`OnApplicationBootstrap`) dans `ImageSecurityModule`, importé par `AppModule`.
  - Appliquée au bootstrap de **chaque** application Nest (production, E2E via `app.init()`), avant toute requête ; ne dépend pas de `main.ts`.
- **Plus aucun effet de bord** à l'import de `logo-validation.ts`, aucun appel `block`, `unblock` ni `cache` dans `validateLogoFile`, aucun changement de politique par requête.
- **Portée : tout le processus API.** Une future fonctionnalité nécessitant un autre format devra modifier **explicitement** cette allowlist et ses tests.
- **Tests** :
  - double appel → une seule configuration (espions sur l'instance de Sharp réellement utilisée) ;
  - allowlist exacte ;
  - import de `logo-validation.ts` sans modification de Sharp ;
  - provider appliqué à `app.init()` et pas avant ;
  - PNG, WebP et JPEG lisibles ; SVG, GIF, AVIF, HEIF et TIFF bloqués ;
  - reconfiguration sans effet ;
  - validations parallèles.
  - Les effets réels sont idempotents, donc indépendants de l'ordre des tests.

## 6. Multer et Next.js (conservés tels que validés)

- **Multer** :
  - `multer@2.4.0` et `@nestjs/platform-express@11.2.6` ;
  - `SafeFileInterceptor` (limites officielles Multer `fieldNameSize` 100, `fields` 20, `files` 1, `fieldNestingDepth` 0, `fieldArrayIndexLimit` 0 ; 400 stable pour toute `MulterError` non convertie par Nest), appliqué aux 4 routes multipart ;
  - la charge GHSA-535w passe de 171 à 188 s de CPU à **400 en 0,1 à 0,2 s**.
- **Next.js** :
  - `next@16.3.6` exact : même `sharp@0.35.5` que l'API côté web, `postcss 8.5.23` ;
  - `next@16.3.7` **non retenue** : son âge de publication imposait des exceptions `minimumReleaseAgeExclude` ;
  - `pnpm-workspace.yaml` **inchangé**.

## 7. Dockerfiles (exception documentée, reportée à 1-12E)

- **`web/Dockerfile` réel : cassé pour des raisons préexistantes**, indépendantes de 1-12D et de la version de Next :
  - contexte compose `./web` sans `pnpm-lock.yaml`, d'où l'échec au `COPY` ;
  - `output: "standalone"` commenté alors que l'image l'attend ;
  - `pnpm@latest` (11.x) exige Node ≥ 22 alors que l'image est `node:20-alpine`.
- **Validation web équivalente** (`node:22-alpine`, `pnpm install --frozen-lockfile --filter web...`) : Next 16.3.6 → Sharp 0.35.5, libc musl, seuls les binaires `linuxmusl`, redimensionnement PNG → WebP OK. Elle **confirme Next/Sharp mais ne remplace pas** un build du Dockerfile réel.
- **`api/Dockerfile` n'utilise pas le lockfile** : les versions déployées peuvent dériver des versions testées (constaté pour `@nestjs/*` 11.2.6 en Docker contre 11.1.28 en local, sauf `platform-express`). Il embarque aussi les binaires Sharp glibc inutiles.
- Ces points seront traités en **1-12E — Builds Docker reproductibles**.

## 8. Résultats (exécutions réelles)

| Commande / contrôle | Résultat |
| --- | --- |
| `pnpm --filter api test` | **48 suites, 787/787** |
| `pnpm --filter api test:e2e` | **12 suites, 289/289** (dont `organization-branding` 76) |
| `pnpm --filter api exec eslint "{src,apps,libs,test}/**/*.ts"` | 0 erreur (2 avertissements préexistants, fichiers non modifiés) |
| `pnpm --filter api build` | OK |
| `pnpm --filter web lint` | OK |
| `pnpm --filter web exec tsc --noEmit` | OK |
| `pnpm --filter web build` | OK — Next.js 16.3.6 (Turbopack), 23 routes |
| `pnpm audit` | **32** (0 critical, 13 high, 15 moderate, 4 low), contre 45 au départ |
| `git diff --check` | Propre |
| Contrôle ciblé des formulaires (Playwright, `next build` + `next start`) | **4/4** : inscription, espaces seuls et 21 caractères, invitation, branding |
| Docker API réel (`api/Dockerfile`) | Build OK, **21/21 vérifications** (détail ci-dessous) |

**Premier passage e2e : 36 échecs dans 4 suites**, dus à la nouvelle limite de 20 et non à l'application :
- des fixtures préexistantes utilisaient des noms de plus de 20 caractères (ex. `Stranded Context Org 19C`, `Active Org Suspended Membership 19B`) ; elles ont été raccourcies sur 8 lignes, noms uniquement, assertions inchangées ;
- les 21 réponses **500** venaient de `socket.e2e-spec.ts`, dont l'application de test **n'installe pas** le `ValidationPipe` global de production : le schéma Mongoose (défense en profondeur) a bloqué le nom de 21 caractères.

**Détail du contrôle ciblé des formulaires** :
- `maxLength` 20 et saisie tronquée à 20 sur les trois formulaires ;
- 20 caractères Unicode acceptés ;
- espaces seuls → 400 affiché, aucun compte créé ;
- 21 caractères → 400 ;
- trim avant calcul de longueur ;
- nom d'invitation trimé ;
- branding : `accept` PNG/WebP/JPEG, nom historique de 30 caractères conservé lors d'un changement de couleur, aucun débordement à 390 px.

**Détail des vérifications dans l'image Docker API** :
- linux x64, **musl**, Sharp 0.35.5, libvips 8.18.7, `multer 2.4.0`, `platform-express 11.2.6` ;
- politique absente avant le bootstrap Nest (aucun effet à l'import), puis appliquée par `ImageSecurityModule` ;
- chargeurs : PNG, WebP et JPEG autorisés ; SVG, GIF, AVIF et HEIF bloqués ;
- acceptés : PNG → `.png`, WebP → `.webp`, JPEG `.jpg` → `.jpg`, JPEG `.jpeg` → `.jpg` ;
- refusés : WebP animé, SVG, GIF, AVIF, HEIF déguisé, JPEG tronqué ;
- charge multipart hostile → 400 en 119 ms ;
- taille de l'image : 109,2 Mo.

**Avis de sécurité** :
- **corrigés (13)** : Multer ×5 (wc9g, 535w, qfvm, 3pph, qvfw), Next ×2 critiques (2xp9, p293), Sharp web ×2 (f88m, rgj7), PostCSS ×4 ;
- **nouveaux** : 0 ;
- **restants (32), aucun lié à l'upload ni aux images** :
  - `qs` 6.15.3 (via `express`, runtime API, 2 moderate) ;
  - `fast-uri`, `js-yaml`, `nanoid` : outillage de développement API ;
  - `undici`, `hono`, `ip-address` : CLI `shadcn` côté web.

## 9. Fichiers

| Fichier | Changement |
| --- | --- |
| `api/package.json` | `@nestjs/platform-express` `^11.2.6`, `multer` `^2.4.0` |
| `web/package.json` | `next` `16.3.6` |
| `pnpm-lock.yaml` | Résolutions correspondantes |
| `api/src/common/upload/safe-file-interceptor.ts` | **Nouveau** : limites multipart durcies |
| `api/src/common/image/sharp-security-policy.ts` (+ spec) | **Nouveau** : politique Sharp idempotente |
| `api/src/common/image/image-security.module.ts` | **Nouveau** : application au bootstrap |
| `api/src/app.module.ts` | Import d'`ImageSecurityModule` |
| `api/src/common/validation/name-rules.ts` (+ spec) | 20/20, cohérence frontend/backend testée |
| `api/src/auth/dto/*.ts`, `organizations/dto/update-branding.dto.ts`, schémas, `organizations.service.ts` | Commentaires 20 (règles issues des constantes) |
| `api/src/organizations/logo/logo-validation.ts` (+ specs) | JPEG, ordre final, animés refusés, plus d'effet de bord |
| `api/src/organizations/logo/logo-upload.interceptor.ts` | Base `SafeFileInterceptor` |
| `api/src/products/products.controller.ts`, `api/src/objects/objects.controller.ts` | `SafeFileInterceptor` |
| `api/test/organization-branding.e2e-spec.ts` | Noms 20/21, stockage PNG/WebP/JPEG, politique au bootstrap, multipart |
| `api/test/{auth-context,auth-organizations,invitations,socket}.e2e-spec.ts` | Fixtures de noms ramenées à 20 caractères ou moins |
| `web/src/lib/logo-upload-policy.ts` | **Nouveau** : formats acceptés, taille max et texte d'aide du logo |
| `web/src/lib/name-limits.ts` | Limites de noms uniquement (constantes logo déplacées) |
| `web/src/app/app/organization/branding/page.tsx` | Import depuis `logo-upload-policy.ts` |

## 10. Risques résiduels

- **APNG** accepté (limite libvips assumée, test de caractérisation).
- **Politique Sharp globale** au processus API : toute évolution de format doit modifier l'allowlist explicitement.
- **`failOn: 'warning'`** strict : un JPEG ou PNG exporté avec des avertissements de décodage (profil ICC défectueux, octets superflus) est refusé et doit être réexporté.
- **Dockerfiles** (1-12E) ; alignement des `@nestjs/*` sur 11.2.6 ; `qs` à surveiller.
- **E2E `socket`** : l'application de test n'installe pas le `ValidationPipe` de production (préexistant) ; seule la défense Mongoose s'y applique.
