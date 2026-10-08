# Lot 1-16H — Actualisation des pages publiques et nettoyage Stock Master

## 0. Base et protection du travail

- État de départ constaté :
  - HEAD : `5808808` (le lot G est déjà commité).
  - Branche de travail créée : `architecture/phase-1-16h-stock-master-brand-cleanup`.
  - Stash conservé et inchangé : `stash@{0}` (`lint-staged automatic backup (564a998)`).
- Aucun commit, push, migration réelle, déploiement ou activation.
- Aucun `.env` réel lu ; aucune opération Railway/Vercel/CamPay.
- Index préservé (vide en fin de lot, aucune mise en staging).

## 1. Pages publiques actualisées (FR/EN)

## 1.1 Accueil et sous-pages publiques

Mises à jour effectuées sur les textes marketing dans les ressources i18n existantes, sans créer de nouveau système :

- [public.ts](C:/Users/daten/Downloads/heyama-test/web/src/i18n/resources/fr/public.ts)
- [public.ts](C:/Users/daten/Downloads/heyama-test/web/src/i18n/resources/en/public.ts)
- [page.tsx](C:/Users/daten/Downloads/heyama-test/web/src/app/page.tsx)

Points explicitement couverts (avec exemples concrets) :

- ventes/stock/collègues en temps réel ;
- Analyse : produits à surveiller, réapprovisionnement, meilleures ventes, gain estimé (sans promesse) ;
- historique mensuel Excel/PDF pour propriétaire et administrateur ;
- centre de notifications, droits d’équipe, assistance ;
- français/anglais, clair/sombre, couleurs commerce ;
- hors connexion avec portée exacte (72h, 14 jours, file limitée à 200, même appareil, session valide).

Tarifs/essai restent lus depuis les sources actuelles (`subscription-offers`) ; l’inscription ouverte/fermée reste pilotée par le flag existant.

## 1.2 Captures marketing

Constat : les fichiers `web/public/marketing/*.png` n'avaient pas été remplacés
(inchangés depuis 1-16B, 780 × 1688 px). La capture Analyse montrait l'ancien
écran « Situation du business » (capital investi, marge moyenne), supprimé par
1-16E : trompeuse face aux textes alternatifs, qui annonçaient « produits à
surveiller ». Le composant déclarait en outre 585 × 1266 px.

Captures refaites sur l'interface actuelle, une paire par langue (mêmes
écrans réels, aucun écran composé ou retouché) :

| Fichier | Contenu |
|---|---|
| `capture-analyse-ventes-mobile-fr.png` | Analyse, « Vos ventes » (montant et comparaison, nombre de ventes, gain estimé) puis « Ce qui se vend » (ventes par jour), interface FR, « Boutique Démo » |
| `capture-ventes-mobile-fr.png` | Ventes, liste des dernières ventes, interface FR |
| `capture-analytics-sales-mobile-en.png` | Analytics, « Your sales » puis « What sells », interface EN, « Demo Shop » |
| `capture-sales-mobile-en.png` | Sales, latest sales, interface EN |

Procédure (stack `recipe.js start`, MongoDB éphémère, aucun `.env` lu) :

- deux commerces fictifs inscrits par les routes publiques (« Boutique
  Démo » / « Gérant Démo », « Demo Shop » / « Demo Manager »), 3 rayons et
  8 produits génériques sans marque créés par l'API (images unies) ;
- historique fictif écrit en base éphémère : commerce et produits datés de
  70 jours, ventes déterministes jour par jour, stock restant cohérent
  (initial = restant + vendu). Résultat calculé par l'application : huile en
  rupture, riz ≈ 4,5 jours de stock, savon sans vente depuis 28 jours ; mois
  en cours légèrement plus actif (+13,8 % de montant face au début de
  septembre) ;
- Playwright 1.62.1 (hors dépôt), 390 × 844, échelle 2, thème clair, cookie
  `stockmaster.lang` ; invite de notifications refermée par son bouton
  « Plus tard » ; Analyse cadrée par défilement sur la carte « Montant des
  ventes » (première version cadrée sur « À surveiller », remplacée car elle
  ne montrait qu'une fonctionnalité) ;
  0 erreur console.

Noms de fichiers nouveaux à chaque changement de contenu : l'optimiseur
d'images de Next (`.next/cache/images`) et les navigateurs mettent en cache
la version optimisée selon l'URL ; un même nom resservirait l'ancienne image.

Composant : `product-preview.tsx` choisit la paire selon la langue de la
requête (`getServerT` → `lng`), dimensions corrigées à 780 × 1688. Textes
alternatifs et légende (FR/EN) décrivent exactement le contenu affiché et
précisent « captures réelles », la langue de l'interface et les données
fictives.

Vérification : accueil rendu sur la stack de recette (FR bureau, EN bureau,
EN 390 px) : bonnes images servies par l'optimiseur, chargées, légende dans
la langue, 0 erreur console, 0 réponse ≥ 400.

## 1.3 Cohérence auth/aide et promesses interdites

- Pas d’annonce de paiement en ligne actif (au contraire : indisponible).
- Pas de promesse de bénéfice garanti.
- Pas de promesse de fonctionnement entièrement hors connexion.
- Mention push conservée dans son périmètre réel (appareils Android/iPhone non validés en réel).

## 2. Nettoyage des anciennes références

## 2.1 Références remplacées (surfaces courantes)

### Identité et domaine

- [README.md](C:/Users/daten/Downloads/heyama-test/README.md)
- [web/README.md](C:/Users/daten/Downloads/heyama-test/web/README.md)
- [api/README.md](C:/Users/daten/Downloads/heyama-test/api/README.md)
- [package.json](C:/Users/daten/Downloads/heyama-test/package.json)
- [.env.prod.example](C:/Users/daten/Downloads/heyama-test/.env.prod.example)
- [docker-compose.prod.yml](C:/Users/daten/Downloads/heyama-test/docker-compose.prod.yml)
- [docker-compose.yml](C:/Users/daten/Downloads/heyama-test/docker-compose.yml)
- [nginx.conf](C:/Users/daten/Downloads/heyama-test/nginx/nginx.conf)
- [api/.env.example](C:/Users/daten/Downloads/heyama-test/api/.env.example)

Remplacements principaux :

- `RoyalVibe*` -> `Stock Master` ;
- domaines de démo/prod -> `stock-master.app` / `api.stock-master.app` / `s3.stock-master.app` ;
- noms de conteneurs/exemples prod alignés sur `stockmaster-*`.

## 2.2 Références conservées volontairement (justifiées)

- Clés locales `heyama_token` / `heyama_user` : **renommées** dans le
  complément (§ 7), plus conservées.
- Modules/routes `objects` et alias legacy :
  - [objects.controller.ts](C:/Users/daten/Downloads/heyama-test/api/src/objects/objects.controller.ts)
  - [objects page](C:/Users/daten/Downloads/heyama-test/web/src/app/objects/%5Bid%5D/page.tsx)
  - raison : compatibilité liens historiques/legacy ; encore référencés.
- Historique documentaire et tests :
  - anciens noms conservés dans rapports historiques `docs/architecture/*` et dans jeux de test (`*.spec.ts`, `api/test/*`) ; non modifiés volontairement.

## 2.3 Suppressions

- Aucune suppression de module/route/asset : pas de preuve d’inutilisation totale sans risque de régression compatibilité.

## 3. Vérifications exécutées

- i18n web :
  - `pnpm --filter web test:i18n` ✅
- lint sans `--fix` :
  - `pnpm --filter web exec eslint .` ✅
  - `pnpm --filter api exec eslint "{src,apps,libs,test}/**/*.ts"` ✅ (2 warnings existants, 0 erreur)
- typage :
  - `pnpm --filter web exec tsc --noEmit` ✅
  - `pnpm --filter api exec tsc --noEmit` ❌ (échec préexistant massif dans les tests API ; aucun fichier API touché par ce lot)
- build web isolé + vérification archives juridiques :
  - `node api/test/recipe/recipe.js isolated web-build` ✅
  - contrôle archives : `ok: true`, `problems: []`.

## 4. Contrôle final des anciennes références

Inventaire `rg` exécuté (contenu + noms de fichiers). Résiduels observés :

- code runtime : aucune clé `heyama_*` après le complément (§ 7) ; seul un
  commentaire de `site-identity.ts` rappelle l'ancien nom (historique de
  version des Cookies) ;
- docs historiques et tests : conservés comme historique/fixtures.

## 5. État Git

Le lot 1-16H (pages publiques, captures, nettoyage) a été commité par
l'utilisateur : `751da39`. L'état Git final du complément est au § 7.6.

## 6. Limites restantes

- Échec connu hors périmètre lot : `name-rules.spec.ts` et, plus largement, la suite TS API (typecheck tests) n’est pas présentée comme verte.
- Captures marketing refaites avec recette locale et boutique fictive ; validation appareils réels Android/iPhone toujours non faite (inchangé).

## 7. Complément — Clés de session Stock Master

Décision confirmée : application pas encore en production ; sessions et
données locales de développement réinitialisables ; aucune compatibilité
avec les anciennes clés.

### 7.1 Base

- HEAD `751da39` (lot 1-16H commité), branche
  `architecture/phase-1-16h-stock-master-brand-cleanup`, arbre propre, index
  vide, `stash@{0}` (`lint-staged automatic backup (564a998)`) conservé,
  jamais appliqué.

### 7.2 Renommage

| Ancienne clé | Nouvelle clé |
|---|---|
| `heyama_token` | `stockmaster_token` |
| `heyama_user` | `stockmaster_user` |

- Définition unique : `web/src/lib/auth.ts` exporte `TOKEN_KEY` et
  `USER_KEY`. Toutes les lectures/écritures passent déjà par ses fonctions
  (`getToken`, `setToken`, `getStoredUser`, `setStoredUser`, `clearAuth`,
  `isAuthStorageKey`) : connexion, inscription, restauration de session
  (`auth-context`), appels API (`lib/api`), WebSocket (`use-socket`),
  déconnexion et synchronisation entre onglets (événement `storage`).
- `web/src/lib/offline-sales-sync.ts` : sa copie locale
  `TOKEN_STORAGE_KEY = "heyama_token"` est supprimée ; `isAuthTokenStorageKey`
  (arrêt de la passe de reprise hors connexion quand le jeton change dans un
  autre onglet) utilise `TOKEN_KEY` importé de `./auth` (déjà importé pour
  `getToken`, aucun cycle).
- Aucune double lecture/écriture, aucune migration ni nettoyage automatique
  des anciennes clés.
- Inchangés : outbox et bases IndexedDB `stockmaster-offline-*`,
  `stockmaster_restricted_session`, `stockmaster_commercial_blocks`, autres
  clés, service worker.
- Recette : `api/test/recipe/scenarios.js` (`logoutLocal`, scénarios 3c et 9)
  lit/efface les nouvelles clés (code exécuté dans la page, chaînes
  littérales).

### 7.3 Pages Cookies et documentation

- `cookies/fr.tsx` et `cookies/en.tsx` : tableau « Stockage du navigateur »
  avec `stockmaster_token` / `stockmaster_user` (finalité et durée
  inchangées).
- Version des Cookies : **0.4 → 0.5** (`DRAFT_COOKIES_0_5`, 8 octobre 2026,
  `site-identity.ts`), selon la règle existante (texte affiché modifié =
  nouveau numéro, comme 0.4 en 1-16G). Document non archivé et non soumis à
  acceptation : aucune archive à écrire.
- Archives juridiques (`api/src/legal/archive/`, CGU, CGA, Confidentialité)
  : ne citent pas ces clés, non modifiées ; contrôle des empreintes du build
  isolé `ok: true`.
- Documentation actuelle : § 2.2 et § 4 de ce rapport mis à jour. Aucun
  README ne citait ces clés.

### 7.4 Références restantes (justifiées)

`heyama_token` / `heyama_user` ne restent que dans :

- rapports et audits historiques datés : `docs/architecture/phase-1a-*`,
  `phase-1-12a-*`, `phase-1-12b-*`, `phase-1-14c2-*`, `phase-1-16c-*`,
  `docs/audits/saas-transformation-audit.md`,
  `docs/security/phase-0b3-websocket-auth.md` — état du code à leur date,
  non réécrits ;
- `web/src/lib/legal/site-identity.ts` : commentaire de la version 0.5 des
  Cookies (nom de l'ancienne clé, sans effet) ;
- ce rapport.

Hors périmètre (autres noms `heyama`, non liés aux deux clés) : bucket de
test `heyama-objects` (`s3.service.spec.ts`), URI de dev refusée par les e2e
(`ephemeral-mongodb.ts`), projet Compose du test proxy (`api/test/proxy`).

### 7.5 Réinitialiser l'ancien stockage de session local (si nécessaire)

Après mise à jour, une session de développement ouverte avec les anciennes
clés n'est plus reconnue : se reconnecter suffit. Pour retirer seulement les
deux anciennes entrées (sans toucher l'outbox ni les autres données), dans la
console du navigateur, sur l'origine de l'application :

```js
localStorage.removeItem("heyama_token");
localStorage.removeItem("heyama_user");
```

Ne pas utiliser `localStorage.clear()` ni « Effacer les données du site » :
cela supprimerait aussi les ventes en attente (IndexedDB) et les
préférences. Aucune base, collection, donnée distante ni volume Docker n'est
concerné.

### 7.6 Contrôles exécutés

| Contrôle | Résultat |
|---|---|
| `pnpm --filter web exec tsc --noEmit` | 0 |
| `pnpm --filter web exec eslint src` | 0 erreur |
| `pnpm --filter web test:i18n` | `problems: []` |
| `pnpm --filter web test:coordinator` | 6/6 |
| Prettier (fichiers modifiés) ; `node --check scenarios.js` ; `git diff --check` | conforme ; OK ; OK |
| Contrôle navigateur ciblé (recette, script temporaire hors dépôt) | **12/12** : connexion → `stockmaster_token` et `stockmaster_user` seuls, aucune clé `heyama_*` écrite ; `GET /auth/me` 200 avec le nouveau jeton ; WebSocket ouvert ; rechargement de `/app/sales` → session restaurée ; second onglet connecté, déconnexion dans le premier → clés effacées et second onglet renvoyé vers `/auth/login` ; anciennes clés seules → redirection vers la connexion (pas de reprise) ; 0 erreur de page |
| `realtime RT7` | **PASS** : vente saisie API coupée, en attente dans l'outbox, reprise → 1 vente serveur, rejeu idempotent sans doublon, stock 25 → 22 partout |
| `scenarios 3c 9 10` (paiement simulé, clés de session) | **3/3 PASS** (marqueur sans jeton ; échange `complete` → jeton applicatif installé ; changement d'organisation/utilisateur sans fuite) |
| `isolated web-build` | `ok: true`, `problems: []`, `envFilesInCopy: 0` |

Contrôles serveur inchangés (aucun fichier `api/src` modifié). Non relancés :
campagnes complètes RT1–RT33, scénarios de paiement complets, suites API.

### 7.7 État Git final (avant commit)

Aucun commit, push ni déploiement. Index vide, `stash@{0}` conservé.

```txt
## architecture/phase-1-16h-stock-master-brand-cleanup...origin/architecture/phase-1-16h-stock-master-brand-cleanup
 M api/test/recipe/scenarios.js
 M docs/architecture/phase-1-16h-stock-master-brand-cleanup.md
 M web/src/i18n/documents/cookies/en.tsx
 M web/src/i18n/documents/cookies/fr.tsx
 M web/src/lib/auth.ts
 M web/src/lib/legal/site-identity.ts
 M web/src/lib/offline-sales-sync.ts
```

Aucun nouveau fichier (scripts de contrôle temporaires hors dépôt).
