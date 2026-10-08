# Phase 1-5B — Stockage des images Produit isolé par organisation

## Base et fichiers
- Base : `architecture/phase-1-5a-socket-organization-rooms` à `6f61b0d`.
- Branche : `architecture/phase-1-5b-tenant-storage`.
- Production (5) : `s3/s3.service.ts` ; `products/products.controller.ts` ; `products/products.service.ts` ; `objects/objects.controller.ts` ; `objects/objects.service.ts` (dette).
- Tests (4) : `s3.service.spec.ts`, `products.controller.spec.ts`, `products.service.spec.ts`, `objects.service.spec.ts`.
- Correction ciblée (ce lot) : cycle `create` + parsing URL structuré de `deleteFile`. Aucun schéma/dépendance/frontend/réseau réel touché.

## Appelants S3
- `ProductsController.create/update` (org via `@CurrentOrganization()`) ; `ProductsService.permanentDelete`/`update` (ancienne image) ; `Objects*` legacy orphelin confirmé (`ObjectsModule` non importé, non réactivé).

## Format de clé
- `uploadFile(file, keyPrefix)` : clé = `${keyPrefix}/${uuid}-${sanitize(filename)}` ; Produits → `organizations/<organizationId>/products`.
- `sanitizeFilename` : basename seul, Unicode→ASCII, contrôles retirés, espaces→tirets, extension préservée (fallback `file`).

## Parsing/suppression (corrigé)
- `deleteFile` ne fait plus de `split(bucket/)` naïf (vulnérable à une origine étrangère portant le bucket dans son chemin). `extractTenantKey` utilise `new URL()` structuré :
  1. rejette credentials embarqués (`username`/`password`) ;
  2. exige `origin` **et** chemin de base EXACTS = ceux réellement utilisés pour produire les URLs (`publicUrlBase`, dérivé de `S3_PUBLIC_URL` ou `S3_ENDPOINT`), calculés une fois au constructeur ;
  3. `decodeURIComponent` sur le reste du chemin → rejet si encodage invalide ;
  4. `allowedPrefix + '/'` exigé (jamais `startsWith` nu).
- Origine étrangère, chemin de base voisin (autre bucket), clé plate, préfixe tenant différent, URL malformée/credentials/encodage invalide → **aucun** `DeleteObjectCommand`. Ni l'URL ni un secret ne sont journalisés (aucun `log`/`console` ajouté).
- Nouveau test explicite : `https://evil.example/<bucket>/organizations/A/products/victim.jpg` avec bucket+préfixe corrects → refusé (origine seule suffit à rejeter).

## Cycle create (corrigé)
- `uploadFile` conserve l'URL ; si `ProductsService.create` échoue ensuite, le contrôleur supprime **uniquement** cette nouvelle image sous le préfixe tenant exact puis repropage l'erreur d'origine (`catch`/`throw err`).
- Si `uploadFile` échoue avant de retourner une URL : aucune suppression tentée, `productsService.create` jamais appelé.
- Cycle `update` (1-5B initial) inchangé : upload → échec mutation → nettoyage nouvelle image ; succès → suppression ancienne après `save()`.

## Tests
- `deleteFile` : clé A ok ; org B, legacy plate, URL malformée, préfixe voisin, **origine étrangère**, bucket voisin même origine, credentials embarqués, encodage invalide, base Supabase complète → couverts.
- `create` : succès (upload puis service, org transmise) ; échec service → suppression nouvelle image + org exacte ; échec upload → aucune suppression, service jamais appelé.
- Sanitisation/URLs MinIO/Supabase : inchangés et verts. Aucun réseau (`S3Client` mocké).

## Résultats
- `pnpm --filter api test` : **29/29 suites, 439/439 tests** (+7 vs lot précédent).
- `pnpm --filter api test:e2e` : **4/4 suites, 117/117 tests**.
- `pnpm --filter api exec eslint "{src,apps,libs,test}/**/*.ts"` (sans `--fix` global) : **0 erreur, 2 avertissements préexistants**.
- `pnpm --filter api build` : **succès**. `git diff --check` : **succès**.

## État Git
- Branche `architecture/phase-1-5b-tenant-storage` propre, en avance sur la base ; aucun commit, push ni accès réseau réel.
