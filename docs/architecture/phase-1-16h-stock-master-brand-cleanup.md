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

- Clés locales `heyama_token` / `heyama_user` :
  - [auth.ts](C:/Users/daten/Downloads/heyama-test/web/src/lib/auth.ts)
  - [offline-sales-sync.ts](C:/Users/daten/Downloads/heyama-test/web/src/lib/offline-sales-sync.ts)
  - [cookies fr](C:/Users/daten/Downloads/heyama-test/web/src/i18n/documents/cookies/fr.tsx)
  - [cookies en](C:/Users/daten/Downloads/heyama-test/web/src/i18n/documents/cookies/en.tsx)
  - raison : compatibilité session et reprise des ventes en attente (pas de migration de stockage dans ce lot).
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

- code runtime : uniquement clés de compatibilité `heyama_*` (justifiées ci-dessus) ;
- docs historiques et tests : conservés comme historique/fixtures.

## 5. État Git demandé (avant commit)

Nouveau fichier inclus :

- [phase-1-16h-stock-master-brand-cleanup.md](C:/Users/daten/Downloads/heyama-test/docs/architecture/phase-1-16h-stock-master-brand-cleanup.md)

### git status --short --branch

```txt
## architecture/phase-1-16h-stock-master-brand-cleanup
 M .env.prod.example
 M README.md
 M api/.env.example
 M api/README.md
 M docker-compose.prod.yml
 M docker-compose.yml
 M nginx/nginx.conf
 M package.json
 M web/README.md
 M web/public/marketing/capture-analyse-mobile.png
 M web/public/marketing/capture-ventes-mobile.png
 M web/src/app/page.tsx
 M web/src/components/landing/product-preview.tsx
 M web/src/i18n/resources/en/public.ts
 M web/src/i18n/resources/fr/public.ts
?? docs/architecture/phase-1-16h-stock-master-brand-cleanup.md
```

### git diff --name-status

```txt
M	.env.prod.example
M	README.md
M	api/.env.example
M	api/README.md
M	docker-compose.prod.yml
M	docker-compose.yml
M	nginx/nginx.conf
M	package.json
M	web/README.md
M	web/public/marketing/capture-analyse-mobile.png
M	web/public/marketing/capture-ventes-mobile.png
M	web/src/app/page.tsx
M	web/src/components/landing/product-preview.tsx
M	web/src/i18n/resources/en/public.ts
M	web/src/i18n/resources/fr/public.ts
```

### git diff --stat

```txt
 .env.prod.example                               |  16 +++++-----
 README.md                                       |   7 ++---
 api/.env.example                                |   4 +--
 api/README.md                                   |  10 +++---
 docker-compose.prod.yml                         |  16 +++++-----
 docker-compose.yml                              |   8 ++---
 nginx/nginx.conf                                |   8 ++---
 package.json                                    |   4 +--
 web/README.md                                   |   8 ++---
 web/public/marketing/capture-analyse-mobile.png | Bin 92509 -> 48917 bytes
 web/public/marketing/capture-ventes-mobile.png  | Bin 128175 -> 29489 bytes
 web/src/app/page.tsx                            |   4 +++
 web/src/components/landing/product-preview.tsx  |  12 +++----
 web/src/i18n/resources/en/public.ts             |  40 ++++++++++++++----------
 web/src/i18n/resources/fr/public.ts             |  40 ++++++++++++++----------
 15 files changed, 98 insertions(+), 79 deletions(-)
```

### git diff --check

```txt
(aucune erreur de whitespace signalée)
```

## 6. Limites restantes

- Échec connu hors périmètre lot : `name-rules.spec.ts` et, plus largement, la suite TS API (typecheck tests) n’est pas présentée comme verte.
- Captures marketing refaites avec recette locale et boutique fictive ; validation appareils réels Android/iPhone toujours non faite (inchangé).
