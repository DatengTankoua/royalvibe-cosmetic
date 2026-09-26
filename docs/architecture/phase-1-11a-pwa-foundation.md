# Phase 1-11A — Logo, PWA et socle hors connexion

**Branche** `architecture/phase-1-11a-pwa-foundation` · **Base** `8325e3b` (1-10B) — aucun commit, aucun push, aucun fichier API modifié, aucun package ajouté (génération d'images via `System.Drawing`, déjà présent sous Windows).

## 1. Images

Sources fournies copiées telles quelles dans `web/public/brand/` (`stock-master-icon.png` 1254×1254, `stock-master-logo-horizontal.png` 2172×724, alpha `Format32bppArgb` préservé) — jamais redessinées, jamais de SVG alternatif. Variantes générées **uniquement** depuis `stock-master-icon.png` par `web/scripts/generate-pwa-icons.ps1` (redimensionnement bicubique haute qualité, jamais d'étirement — mise à l'échelle uniforme sur une source carrée) :
- `icon-192.png` / `icon-512.png` : plein cadre, transparence conservée.
- `icon-maskable-512.png` : fond opaque `#062B5C`, artwork limité à la zone de sécurité (80 %).
- `apple-touch-icon.png` (180×180) : fond opaque blanc (transparence rendue en noir par iOS sinon).
- `favicon.ico` (32×32, `Bitmap.GetHicon()` → `Icon.Save`) écrit sur `web/src/app/favicon.ico`, remplaçant l'icône Next par défaut.

## 2. Intégration

`Wordmark` (`components/brand/wordmark.tsx`) rend désormais une `next/image` (`alt="Stock Master"`, `width`/`height` explicites dérivés du ratio réel — jamais étiré), variante `horizontal` (défaut) ou `icon`. Toutes les occurrences texte remplacées par le logo avec une hauteur adaptée au contexte (32–48px pages d'auth/accueil, 24–28px landing/shell). Le shell `/app` affiche le logo horizontal ≥ `sm`, l'icône seule en dessous (`sm:hidden`) — version compacte mobile demandée. Aucun asset RoyalVibe réintroduit (vérifié par recherche).

## 3. Metadata & manifest

`manifest.ts` : `start_url: "/app"`, `scope: "/"`, `display: "standalone"`, `theme_color: "#062B5C"`, `background_color: "#FFFFFF"`, icônes 192/512 (`purpose: "any"`) + maskable 512. `layout.tsx` (racine) : `metadata.icons.icon` (192/512) + `icons.apple` (180×180).

## 4. Service worker (`public/sw.js`, versionné `stockmaster-v2`)

Stratégie **deny-by-default** : seuls les chemins explicitement listés sont interceptés, tout le reste part au réseau natif sans lecture/écriture de cache.
- **Précaché à l'install** : `/`, `/offline`, `/manifest.webmanifest`, les 4 icônes, les 2 images de marque. Les chunks `/_next/static/*` (hash de build inconnu à l'avance, aucun outil de build-time caching ajouté) sont mis en cache **à la volée** (cache-first) lors de leur premier fetch, jamais précachés.
- **Cache-first** : `/_next/static/*`, `/icons/*`, `/brand/*` (assets versionnés/statiques).
- **Network-first + fallback offline** : navigations **uniquement** vers `/`, `/offline`, `/auth/login`, `/auth/register` — `/auth/invitations/accept` en est **exclue**, ni précachée ni network-first.
- **`/auth/invitations/accept` entièrement exclue du service worker** (correction sécurité) : `isInvitationAcceptPath()` retourne AVANT toute stratégie/`respondWith`, dès l'entrée du handler `fetch` (le token est en query string, `?token=...`) — requête toujours au réseau natif, jamais de lecture/écriture Cache Storage. Filet de sécurité additionnel : `isSensitiveUrl()` empêche tout `cache.put` (network-first ou cache-first) pour une URL dont le chemin/query contient `token`/`access_token`/`code`/`invitation`, même hors de cette route. **Aucun token d'invitation ne peut atterrir en Cache Storage.**
- **Jamais intercepté ni caché** (retour précoce, sans `respondWith`) : méthode ≠ GET, origine croisée, tout chemin sous `/app`, `/api`, `/socket.io`, `/auth/invitations/accept` — couvre par construction API/JWT, données organisationnelles, catalogue/ventes/analytics/audits/membres/invitations, images privées S3 (autre origine) et Socket.IO.
- `activate` purge **uniquement** les caches dont le nom commence par `stockmaster-` et diffère de `stockmaster-v2` — tout cache d'un autre namespace/application partageant l'origine est préservé.


## 5. Hors connexion

`app/offline/page.tsx` (route publique, hors du shell `/app`) : message « Vous êtes hors connexion », rappel que données métier/modifications nécessitent Internet, bouton « Réessayer » (`location.reload()`). `hooks/use-online-status.ts` : état initial lu de façon synchrone (`navigator.onLine`), écoute `online`/`offline` avec nettoyage à l'unmount — aucune mutation/file d'attente/sync automatique. `OnlineStatusIndicator` (`components/layout/online-status-indicator.tsx`) affiché dans le header `/app`, masqué si en ligne, `role="status"`/`aria-live="polite"`.

## 6. Résultats

- `pnpm lint` (web) : 0 erreur, 0 warning.
- `pnpm build` (web, Next 16 Turbopack) : succès, **24 routes** (23 précédentes + `/offline`).
- Dimensions/transparence/alpha des icônes vérifiées via `System.Drawing` (192×192, 512×512 ×2, 180×180, toutes `Format32bppArgb` sauf le favicon opaque).
- Recherche « RoyalVibe » dans `web/src` : seule occurrence = commentaire documentant l'absence de réintroduction.
- Chemins `/app`, `/api`, `/socket.io` et toute origine croisée exclus du service worker par construction (revue de code, pas d'exécution réseau réelle dans cette phase).
- `git diff --check` : mêmes avertissements CRLF/LF préexistants (1-9B→1-10B), aucun conflit.

## 7. Limites

- Pas de précache des chunks `_next/static/*` (hash inconnu avant build) — mise en cache uniquement au premier fetch réel ; un premier chargement totalement hors connexion sur un navigateur jamais visité échouera pour ces chunks.
- Aucun test automatisé du service worker (pas d'environnement `service worker`/Playwright dans cette phase) — comportement validé par lecture de code uniquement.
- `favicon.ico` est un seul cadre 32×32 (pas de multi-résolution 16/48) — suffisant pour les navigateurs modernes, pas testé sur des clients legacy.

Aucun commit, aucun push — en attente de validation.
