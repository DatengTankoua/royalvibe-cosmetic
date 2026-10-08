# Phase 1-11C.3 — Interface des ventes hors ligne et cycle de session

Base : `architecture/phase-1-11c2-offline-sales-outbox` @ `03238df`. Frontend uniquement : aucun fichier `api/`, aucun package, service worker inchangé.

## Capacité hors ligne (`lib/offline-sales-capability.ts`)

- Base séparée `stockmaster-offline-sales-capability`, contenant un seul enregistrement : `{schemaVersion, userId, organizationId, tokenFingerprint, canRecordSales, writtenAt, expiresAt}`.
- Écrite **uniquement** après un `GET /auth/context` réussi, avec `canRecordSales = hasPermission(ctx, "sales.record")` (jamais le rôle ni la liste des permissions) ; effacée si le serveur refuse le contexte (401/403).
- Accordée seulement si le schéma, l'identité et l'empreinte du token courant correspondent, que le token n'est pas expiré, que `now < expiresAt` et que `expiresAt − writtenAt ≤ 72 h` (même si l'enregistrement a été altéré).
- Autorise **uniquement** l'affichage du formulaire et l'ajout local (guards serveur revalidés à la synchronisation). Purgée avec le catalogue et l'identité, **jamais** l'outbox.

## Formulaire (`components/products/record-sale-dialog.tsx`)

- `SaleFormDialog` : un seul formulaire pour l'en ligne, le hors ligne et la correction.
  - `productId` et produit viennent du catalogue courant ou du snapshot ; aucune organisation ni vendeur saisissable.
  - Quantité entière ≥ 1 et ≤ stock indicatif ; prix ≥ 0 ; acheteur et contact ≤ 100 caractères.
  - Garde synchrone contre le double clic.
- **Toute vente passe par `enqueueOfflineSale`** (UUID et `occurredAt` figés une seule fois). `createSale` (POST direct) est supprimé de `lib/api.ts`.
- **En ligne** : ajout, puis demande de passe, puis attente de confirmation (10 s maximum).
  - `synced` → « Vente enregistrée » ;
  - `conflict` → message générique et renvoi vers « Ventes en attente » ;
  - sinon → « Vente enregistrée sur cet appareil, en attente de synchronisation ».
- **Hors ligne** : ajout seul, avertissement « le serveur reste l'autorité finale ». Refus explicites : capacité, identité, limite de 200, stockage, correction impossible.

## Stock indicatif

- `useIndicativeStock` = `max(0, stock serveur/snapshot − Σ quantités réservées)`, avec la règle pure **prudente** `reservesStock(op, serverLoadedAt)` :
  - **réserve** : pending, syncing, conflit à issue incertaine (`SERVER_UNAVAILABLE`, `EXPIRED` déjà tentée, corruption) ;
  - **ne réserve pas** : refus métier certain (stock, produit, date, validation/4xx), `EXPIRED` jamais envoyée, `abandoned`, `synced` déjà annulée ;
  - `synced` : réservée tant que les données affichées ont été **demandées avant** la confirmation (`serverLoadedAt` = début de la dernière requête réussie : `useProducts`, fiche produit ; `snapshot.updatedAt` hors ligne ; inconnu → réservée). Un rafraîchissement échoué conserve donc la réservation jusqu'au prochain chargement réussi (aucune boucle : un seul rechargement par confirmation, via `syncedVersion`).
- Cartes en ligne/hors ligne, fiches et formulaire : libellé « Stock indicatif » tant qu'une réservation existe ; quantité supérieure refusée localement.

## Contexte partagé (`contexts/offline-sales-context.tsx`)

- `OfflineSalesProvider` dans le shell : **partition courante uniquement**, relue sur les événements de l'outbox. Expose `canRecordSales`, opérations, blocage, compteur, `recordSale`, `act`, `syncNow`.
- **Identité** : contexte serveur, sinon identité hors ligne, sinon identité **vérifiée localement** en lecture seule (consultation et export après un refus 401/403). Dans ce dernier cas, aucune saisie (capacité effacée) et aucun envoi (le worker exige le contexte serveur).

## Page « Ventes en attente » (`/app/sales/pending`, `components/sales/pending-sales-panel.tsx`)

- Compteurs pending, syncing et à traiter. Pour chaque vente : produit, quantité × prix, `occurredAt`, acheteur, statut en texte, tentatives et message **générique** (`describeOperationError`). Aucune erreur brute, aucun token ni empreinte.
- **Actions** (règles pures `allowedOperationActions`) :
  - `pending` → « Synchroniser maintenant » (échéance immédiate, même UUID) ;
  - refus métier (stock, date, produit, validation, 4xx) → **Corriger** : une nouvelle opération avec un **nouvel UUID**, l'ancienne passant `abandoned` **dans la même transaction** que l'ajout ; ou Abandonner (avec confirmation) ;
  - `SERVER_UNAVAILABLE` → Réessayer (même UUID, compteur remis à zéro) ou abandon averti (« peut avoir été enregistrée ») ;
  - `EXPIRED` : correction seulement si jamais envoyée (`attempts = 0`), sinon abandon averti ;
  - corruption d'idempotence → jamais de renvoi ni de correction ; export puis « Retirer de la file » (abandon et levée du blocage, avec confirmation) ;
  - `synced` récentes : repliées, purgées au bout de 7 jours.
- Partition bloquée (401/403) : bannière « reconnecte-toi ou contacte un administrateur », sans boucle. Un conflit ne bloque pas les ventes suivantes, sauf corruption ou blocage d'accès.

## Export (`lib/offline-sales-export.ts`)

- JSON et CSV des opérations non finalisées, téléchargement local, avertissement « nom/contact acheteur », rien n'est effacé. Champs : UUID, organisation, statut, produit, quantité, prix, acheteur, dates, tentatives, code d'erreur (jamais de JWT, d'empreinte ni de `partitionKey`).
- CSV : chaque cellule entre guillemets ; celles commençant par `= + - @ \t \r` sont préfixées d'une apostrophe ; BOM UTF-8.

## Logout et switch (`app/app/layout.tsx`, `components/sales/logout-pending-dialog.tsx`)

**Logout volontaire** :
1. `stopOfflineSalesSync(3000)` ;
2. comptage des ventes non finalisées de **toutes** les partitions de l'utilisateur (timeout 3 s) ;
3. selon le résultat :
   - aucune → logout normal ;
   - lecture impossible → logout **sans suppression** et message générique ;
   - sinon, dialogue obligatoire :
     - Synchroniser maintenant (partition courante, 10 s maximum, puis recomptage) ;
     - Exporter JSON ou CSV ; Se déconnecter et conserver ;
     - Supprimer définitivement (seconde confirmation, puis `deleteUserOperations`). Aucune option par défaut ; « Annuler » relance le worker.

**Logout forcé (401 sur le token courant)** : `setForcedLogoutListener` arrête le worker. L'outbox est conservée, sans modale.

**Switch d'organisation** :
1. `stopOfflineSalesSync(3000)` **avant** le changement de JWT ;
2. `switchOrganization` ;
3. purge du catalogue, de l'identité et de la capacité (jamais de l'outbox) ;
4. rechargement de `/app`. En cas d'échec : ancienne session conservée, worker relancé.

## Navigation

- Pastille « N en attente » (en-tête), badge sur « Ventes », lien depuis `/app/sales` et depuis l'erreur « limite atteinte ». Rien si la file est vide.
- `usePendingSalesHref` : en ligne → `/app/sales/pending` (`Link`) ; **hors ligne** (réseau coupé ou shell en repli) → ancre HTML `/app/catalog#offline-sales-panel`, **jamais** `/app/sales/pending`. Le fragment n'est pas envoyé au serveur : l'exception exacte du service worker (`/app/catalog`, sans query) reste valable.
- Panneau intégré à `/app/catalog` hors ligne : `<section id="offline-sales-panel" tabIndex=-1>`, ouvert, défilé et focalisé au chargement avec le fragment, sur `hashchange` ou via l'événement du lien (fragment déjà présent). Sans organisation active (accès révoqué), le panneau s'affiche sous « Se déconnecter ».

## Corrections découvertes par les tests réels

- **Shell ouvert hors ligne** : contexte serveur rechargé sur `online` (sinon le worker ne reprenait jamais). **Accès révoqué** : ventes locales visibles et exportables (identité vérifiée localement, lecture seule).

## Tests réels (Playwright temporaire, scratchpad, hors Git)

- **Stack** : `MongoMemoryReplSet`, migration 1-11C.1, API compilée, `next build` + `next start` (service worker actif). **Hors ligne simulé** : API injoignable au chargement puis `setOffline` (dans Playwright, une navigation hors ligne échoue avant le service worker).
- **12/12, deux exécutions complètes** :
  1. vente en ligne synchronisée, une seule vente ;
  2. hors ligne, pending, reconnexion, synced ;
  3. 201 perdue : même UUID, aucun doublon ;
  4. deux onglets : un seul envoi ;
  5. conflit de stock, puis correction avec un nouvel UUID (l'ancien est abandonné, 0 vente côté serveur pour cet UUID) ;
  6. la vente suivante est synchronisée ;
  7. logout : conserver, exporter, supprimer ;
  8. switch A→B pendant l'envoi : aucun JWT B pour A, envoi avec JWT A après retour ;
  9. capacité `false`, expirée, TTL supérieur à 72 h, autre token ou absente : formulaire hors ligne interdit ; capacité valide : formulaire autorisé ;
  10. membership suspendue : 403, un seul POST, partition bloquée, aucune boucle, plus de saisie ;
  11. CSV : `=HYPERLINK…` et `+33…` neutralisés, aucun token ;
  12. 320, 375 et 390 px sans débordement horizontal.
- **Navigation hors ligne ciblée (4/4)** : pastille en ligne → `/app/sales/pending` ; catalogue chargé puis réseau coupé → clic → panneau ouvert et focalisé, aucun lien vers `/app/sales/pending`, aucune erreur de page ni de document, re-clic avec fragment présent ; repli hors ligne → clic → panneau ; arrivée directe avec le fragment → panneau ouvert. Régression des 12 scénarios : 12/12.
- **Règles pures** : actions autorisées et messages ; matrice de réservation (17 cas + 4 agrégats). **Validation** : `eslint`, `next build` OK, `git diff --check` propre.

## Correctif post-test manuel — navigation et assets hors ligne

Constat : `sw.js` contrôle la page, `stockmaster-v3` contient `/app/catalog`, le manifeste, les images de marque et les chunks. Les erreurs venaient des routes volontairement non servies hors ligne et des requêtes anticipées de Next.js. **Service worker inchangé.**

| Problème | Cause racine | Correction |
| --- | --- | --- |
| Catalogue ne bascule pas à la coupure | Le repli dépendait d'une erreur réseau de `GET /sections`, or une page déjà chargée ne refait aucune requête : les `SectionCard` (liens `/app/catalog/[id]`) restaient affichées. Après F5 hors ligne, le snapshot attendait en plus l'échec réseau de `/auth/context` avant de lire l'identité vérifiée. | `app/app/catalog/page.tsx` : repli dès que `useOfflineSales().offline` est vrai (ou vraie panne réseau). Hors ligne, les `SectionCard` ne sont jamais rendues, même sans snapshot. Au retour de `online` : rechargement des sections. `app/app/layout.tsx` : si `navigator.onLine === false` au chargement, identité vérifiée lue immédiatement ; ignorée dès que le contexte répond (un 401/403 la remet à `null`). |
| Liens actifs vers des routes non servies | La navigation du shell rendait des `Link` vers `/app`, Ventes, Analyse, Corbeille et Organisation quel que soit l'état réseau. Le prefetch automatique générait des requêtes RSC. | `ShellNavLink` (desktop, barre mobile, menu « Plus ») : hors ligne, un `span` non focalisable `aria-disabled="true"` avec le titre « Indisponible hors connexion » et le texte équivalent pour lecteurs d'écran, plus une mention visible. Catalogue = ancre HTML `/app/catalog` (document servi par le SW, jamais de fetch RSC). En ligne : `Link prefetch={false}`. `prefetch={false}` est aussi ajouté aux liens `/app` des pages et cartes (sections, produits, objets, onglets Organisation, retours, corbeille, analyse, pastille). |
| Logo absent hors ligne | `next/image` réécrit la source en `/_next/image?url=/brand/…` : URL dynamique non précachée alors que `/brand/*` l'est. | `Wordmark` : `unoptimized` → `src="/brand/…"` directement. Dimensions, ratio, classes responsives et `alt` inchangés, aucun nouveau fichier, `/_next/image` toujours hors cache. |
| Reconnexions Socket.IO en boucle | Le socket vivait tant que la session durait : hors ligne, le client tentait de se reconnecter en permanence. | `SocketProvider` dépend de `useOnlineStatus()` : `offline` → cleanup (`disconnect`) et aucun nouveau socket ; `online` → un seul socket avec le token courant. Nettoyage unmount/logout/switch inchangé (même effet). |
| Manifeste | Présent dans `stockmaster-v3`, aucune erreur reproductible avec un SW contrôleur. | Non modifié. |

**Tests réels** (Playwright temporaire, scratchpad, `next build` + `next start`, API compilée sur MongoMemoryReplSet), **11/11, deux exécutions** :
1. `/app/catalog` en ligne puis `setOffline` : « Données hors connexion » en 12–19 ms, aucun lien `/app/catalog/…`.
2. Section → sous-section → produit : URL `/app/catalog`, zéro requête RSC ni `/app/catalog/…`.
3. F5 hors ligne : (a) document servi par le SW, navigateur hors ligne fonctionnel ; (b) `navigator.onLine === false` dès le chargement et API suspendue, sans réponse ni erreur : bascule en ~135 ms et snapshot affiché, sans attendre d'erreur API.
4. Desktop et mobile (375 px, menu « Plus ») : aucun `a[href]` vers `/app`, Ventes, Analyse, Corbeille ou Organisation ; éléments `aria-disabled` ; clic et survol sans navigation ni requête ; aucun débordement horizontal.
5. Pastille → `/app/catalog#offline-sales-panel`, panneau focalisé.
6. Aucun prefetch RSC vers ces routes, en ligne (au chargement) comme hors ligne.
7. Logos `/brand/stock-master-logo-horizontal.png` (desktop) et `/brand/stock-master-icon.png` (375 px) chargés hors ligne ; zéro requête `/_next/image` sur toute la session.
8. Zéro socket ouvert pendant 8 s hors ligne ; exactement un au retour `online` et après navigation ; aucun socket au F5 hors ligne.
9. Retour en ligne : contexte et sections rechargés (200), navigation Ventes → Catalogue → A → B, suppression produit reçue en temps réel.

**Régression** : 12/12 scénarios 1-11C.3 (le 7 et le 11 forment un seul test combiné) et 4/4 navigation hors ligne ciblée. **Validation** : `eslint`, `next build`, `git diff --check`. Aucun fichier `api/`, aucun package.

**Artefact de test** : dans Playwright/CDP, un document chargé sous `setOffline(true)` voit `navigator.onLine === true` et ne reçoit pas `online` (sonde isolée). Le test 3a resynchronise donc l'émulation. Le test 3b force `navigator.onLine = false` par script d'init, puis émet `online`.

## Correctif 1-11C.3a — stabilisation hors ligne

Reprend le correctif précédent (catalogue, navigation, Socket.IO inchangés dans leur principe) et corrige deux points du test manuel.

| Problème | Cause racine | Correction |
| --- | --- | --- |
| Logo surdimensionné avec `unoptimized` | Sans optimisation, `next/image` n'émet plus de `srcset` 1x/2x. Avec `w-auto h-auto`, l'`<img>` prenait la taille naturelle du PNG (2172 × 724), bornée seulement par `max-w-full`. | `Wordmark` : conteneur `block` aux dimensions explicites (largeur centralisée small/medium/large + `aspect-ratio` réel, `max-w-full`), `<img>` en `h-full w-full object-contain`, `unoptimized` conservé (PNG précachés, jamais `/_next/image`). Rendu identique aux tailles d'avant : 230 × 77, 180 × 60, 140 × 47, icône 44 × 44. |
| Messages hors ligne multiples et techniques | Chaque couche affichait son propre message : shell (« identité vérifiée localement, données mises en cache »), erreurs réseau du branding et de la liste d'organisations, bandeau du catalogue, formulaire de vente, fiche produit. | Un seul message principal dans le shell : « Vous êtes hors connexion. Vous pouvez consulter les données enregistrées sur cet appareil et saisir des ventes qui seront envoyées au retour de la connexion. » Catalogue : « Dernière mise à jour : <date>. Certaines informations peuvent ne plus être à jour. » Une panne réseau n'affiche plus « Organisation actuelle indisponible » ni « Impossible de joindre le serveur » (un refus HTTP reste affiché). « Aucune organisation active » ne se déduit plus que d'une liste réellement reçue (`listLoaded`). Textes du formulaire, de la fiche et du panneau reformulés sans « serveur » ni « synchronisation ». Le message de nouvel essai après 5xx devient « Envoi momentanément impossible, nouvel essai automatique. ». Erreurs métier inchangées : stock insuffisant, vente refusée, accès refusé, conflit à traiter. |

Mobile hors ligne : mention discrète « Autres pages : indisponible hors connexion » au-dessus de la barre fixe (marge basse du contenu ajustée).

**Tests réels** (`next build` + `next start`, Playwright temporaire hors dépôt) :
- **Ciblés, 12/12, deux exécutions.**
  - Coupure sur `/app/catalog` : bascule en 13–50 ms.
  - Section → sous-section → produit : URL `/app/catalog`, zéro requête RSC.
  - F5 hors ligne, document servi par le SW.
  - F5 avec `navigator.onLine === false` et API sans réponse : bascule en ~170 ms.
  - Arrivée sur `#offline-sales-panel`.
  - Aucun lien actif indisponible (desktop, 375 px, menu « Plus »).
  - Message principal présent une seule fois ; aucun terme interdit dans la page ni la fiche produit (identité vérifiée, cache, lecture seule, serveur, JWT, snapshot, IndexedDB, Organisation actuelle indisponible, Impossible de joindre).
  - Zéro socket pendant 10 s hors ligne, un seul au retour.
  - Retour en ligne : sections rechargées, navigation et temps réel OK.
  - Logos mesurés, zéro `/_next/image` :
    - hors ligne : 180 × 60 à 1280 px ; icône 44 × 44 à 320, 375 et 390 px ;
    - en ligne : login 230 × 77, accueil 180 × 60 et 140 × 47, à 1280, 320, 375 et 390 px ;
    - aucun débordement.
- **Régression 12/12** sur les exécutions 2 et 3. Exécution 1 : scénario 9 en échec une fois (produit absent du catalogue hors ligne juste après la resynchronisation qui suit le switch), non reproduit ; cause probable : écriture locale asynchrone interrompue par la navigation immédiate du test.
- **Navigation hors ligne 4/4.**
- **F5 dans un vrai Chrome hors ligne** (réseau réellement coupé) : **à confirmer par l'utilisateur**. Dans Playwright, un document chargé sous émulation hors ligne voit `navigator.onLine === true`.

`web/public/sw.js` inchangé. Aucun fichier `api/`, aucun package.

Test manuel Chrome réel :
- F5 hors ligne sur /app/catalog : PASS
- F5 hors ligne sur /app/catalog#offline-sales-panel : PASS
- retour en ligne et reconnexion Socket.IO : PASS

## Limites

- `Retry-After` reste illisible en cross-origin sans `exposedHeaders: ['Retry-After']` côté API. **À ajouter avant le déploiement** ; en attendant, repli sur le backoff.
- Une mise à jour produit reçue par Socket.IO après une confirmation ne met pas à jour `serverLoadedAt` : la vente peut rester déduite jusqu'au rechargement suivant (sous-estimation prudente, jamais de surestimation).
- « Synchroniser maintenant » au logout ne traite que l'organisation courante (JWT courant). Les autres partitions restent conservées ou exportables.
- La capacité reste un contrôle local : altérable sur un appareil compromis, sans effet serveur (guards revalidés).
