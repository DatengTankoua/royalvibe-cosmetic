# Phase 1-11B — Catalogue hors ligne sécurisé en lecture seule (corrigé)

**Branche** `architecture/phase-1-11b-offline-catalog` · **Base** `996fdc3` (1-11A) — aucun commit, aucun push, aucun fichier `api/` modifié, aucun package ajouté, aucun accès réseau réel. Correction bloquante suite à revue : les scénarios C/D/E ne fonctionnaient pas (voir §7 pour les résultats réels après correction).

## 1. Identité hors ligne (`lib/offline-identity-db.ts`, `lib/jwt.ts`)

Base dédiée `stockmaster-offline-identity` (séparée du catalogue) : `{ schemaVersion, userId, organizationId, tokenFingerprint (SHA-256 du JWT via Web Crypto), writtenAt }`. Écrit **uniquement** après un `GET /auth/context` réussi (`AppShellLayout`). Lecture : recalcule le SHA-256 du token **local courant**, compare exactement, vérifie l'expiration JWT locale (`isJwtExpired`, décodage transitoire, jamais persisté) — token absent/expiré/mismatch ⇒ `null`. Jamais de token brut/payload/rôle/permission stocké ; le fingerprint est un **détecteur de changement local**, jamais une preuve de validité serveur (aucune révocation vérifiable hors ligne).

## 2. Shell (`app/app/layout.tsx`)

`isNetworkError()` distingue panne réseau de réponse HTTP sur `GET /auth/context` : succès → `authContext` + écriture du pointeur ; **panne réseau** → tente `readVerifiedIdentity` (fail-closed si non prouvée) ; **401/403/autre réponse HTTP** → `offlineIdentity` reste `null`, jamais de repli (une révocation serveur n'est jamais traitée comme un mode hors ligne). Branding/liste d'organisations indépendants, ne bloquent jamais le catalogue. Bandeau clair « Mode hors connexion : identité vérifiée localement ».

## 3. Document offline (`public/sw.js`, `CACHE_VERSION="v3"`)

Exception **unique et étroite** : navigation exacte `/app/catalog` **sans query string**, jamais de `cache.put` d'une réponse live — uniquement le document précaché à l'`install`. `/app/*` reste exclu partout ailleurs (y compris `[id]`/`products/[id]`). Limite documentée : un premier accès jamais visité en ligne reste impossible (aucun SW/chunk en cache).

## 4. Navigation offline robuste (`components/catalog/offline-catalog-browser.tsx`)

`/app/catalog` (route dynamique `[id]`/`products/[id]` plus jamais utilisées hors ligne) embarque `OfflineCatalogBrowser` : navigation interne (pile en mémoire), détail produit minimal en `Dialog`, **aucun** `router.push`/`Link` dynamique. `/app/catalog/[id]` et `/products/[id]` redeviennent 100% en ligne (revert complet, diff vide vs 1-11A pour `products/[id]`) — ils continuent seulement d'**alimenter** le cache après chaque chargement réussi.

## 5. Snapshots par scope (`lib/offline-catalog-db.ts`, `schemaVersion=2`)

`syncedScopes: string[]` (`root-sections`, `section-children:<id>`, `section-products:<id>`). Chaque écriture (`applyCatalogScopeUpdates`, une transaction get/compute/put) **remplace** le scope (retire l'ancien contenu, élimine tout `_id` dupliqué ailleurs, insère la réponse même vide), marque le scope synchronisé, **préserve** tous les autres scopes. UI : scope synchronisé vide → « Aucun élément » ; scope absent → « Cette section n'a pas encore été synchronisée ».

## 6. Purge robuste (`lib/offline-db-utils.ts`, `offline-purge.ts`)

`onversionchange` ferme toute connexion ; `deleteIndexedDb` résout sur `onsuccess`/`onerror`/`onblocked` + timeout défensif 2s ; toute opération top-level est bornée par `withTimeout`. `purgeAllOfflineData()` (catalogue + identité) appelé au logout (avant fin) et après switch réussi (jamais sur échec) — jamais bloquant, erreur générique uniquement.

## 7. Résultats réels A–E (Chrome/Chromium via Playwright, stack locale complète : Mongo/MinIO/API/Next prod)

Compte de test créé, section « Parfums » + produit réels, snapshot IndexedDB inspecté directement.

| # | Scénario | Résultat |
|---|---|---|
| A | Page montée, réseau coupé | **PASS** (état React inchangé) |
| B | Navigation interne section→produit, hors ligne | **PASS** via `OfflineCatalogBrowser` (URL inchangée, dialog minimal) |
| C | F5 sur `/app/catalog` après visite en ligne | **PASS** (SW sert le shell précaché, `offlineIdentity` vérifiée, snapshot lu, « Parfums » affiché) |
| D | Nouveau contexte jamais visité, hors ligne | **FAIL** — `net::ERR_INTERNET_DISCONNECTED`, confirmé limite plateforme |
| E | `/auth/context` en panne réseau | **PASS** (identique à C) |
| E | `/auth/context` → 401 réel (même avec catalogue aussi injoignable) | **REFUS confirmé** — aucune donnée offline, aucun bandeau « hors connexion » |

Logout : les deux bases IndexedDB confirmées supprimées (`indexedDB.databases()` vide) avant redirection `/auth/login`, aucun blocage.

## 8. Validation

`pnpm --filter web lint` : 0 erreur. `pnpm --filter web build` : succès (25 routes, `/app/catalog` toujours `○` statique). `git diff --check` : mêmes avertissements CRLF préexistants, aucun conflit. Recherche token/sale/audit/member dans le stockage : aucune occurrence hors commentaires.

## 9. Limites persistantes

Données jusqu'à 72h ; aucune vérification de révocation serveur possible offline (fingerprint = détecteur local uniquement) ; scénario D non résolvable (limite PWA fondamentale) ; snapshot limité aux scopes déjà visités en ligne.

Aucun commit, aucun push — en attente de validation.
