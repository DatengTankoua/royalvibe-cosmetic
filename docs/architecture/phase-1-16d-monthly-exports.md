# Lot 1-16D — Historique mensuel exportable en Excel et PDF

## 0. Base et périmètre

- Branche `architecture/phase-1-16c-legal-and-usage-pages`, HEAD `8994798`
  (« feat: add legal pages and organization support »), qui contient les
  lots 1-16C et 1-16C.1. Arbre propre au départ, index vide, `stash@{0}`
  (sauvegarde lint-staged `564a998`) non touché.
- Aucun commit, push ni déploiement. CamPay reste
  `UnavailablePaymentProvider`, le webhook reste désactivé.
- Aucun `.env` réel, aucune base réelle, aucun envoi : suites API et build
  web par `recipe.js isolated`, recette navigateur sur la pile éphémère
  `recipe.js start` (MongoDB éphémère, fournisseur simulé).
- **Aucune dépendance ajoutée**, lockfile inchangé (voir § 5).

## 1. Inventaire avant travaux

### 1.1 Données réellement conservées

| Donnée | Source | Fiabilité |
|---|---|---|
| Vente : date métier `occurredAt` (sinon `createdAt`), quantité, prix, vendeur (`sellerId`), acheteur et contact (facultatifs) | `sales` | état **actuel** de la vente (corrections comprises) |
| Nom du produit lors de la vente | `sales.productName` (1-15D, serveur) | absent sur les ventes anciennes |
| Dernier nom connu et coût figé d'un produit purgé | `sales.lastKnownProductName`, `lastKnownUnitCost` (`select: false`) | posés à la purge ou par le rattrapage 1-15D |
| Nom du vendeur | `users.name` (nom **actuel** du compte) | aucun instantané à la vente |
| Correction de vente (`sale_updated`), annulation (`sale_cancelled`) | `auditlogs`, écrits **dans la transaction** qui modifie ou supprime la vente | confirmées : l'entrée n'existe que si l'opération a été validée |
| Ajout de stock (`stock_changed`), renommage, prix | `auditlogs`, écrits **avant** `product.save()` | **tentatives** seulement (1-15D § 4.2) : non reprises |
| Stock à une date passée | — | **n'existe pas** : aucun stock historique n'est affiché |

Une vente annulée est supprimée (`deleteOne`) : elle ne figure plus parmi
les ventes du mois, seulement parmi les annulations, d'après le journal.

### 1.2 Règles de l'Analyse réutilisées

- Bornes : `monthMatch` de `AnalyticsService`, `new Date(année, mois, 1)`,
  donc minuit dans le **fuseau du processus API**, début inclus, fin
  exclue ; filtre sur `occurredAt`, repli sur `createdAt`. La logique est
  déplacée telle quelle dans `api/src/analytics/month-range.ts`
  (`monthBounds`, `saleMonthMatch`) et appelée par `monthMatch` : aucun
  changement de sens (specs Analyse, bilan mensuel 1-16A.1 et purge 1-15D
  rejoués).
- Totaux (montant, quantité, nombre de ventes) : `getOverview(month)`.
- Récapitulatif par produit, gain compris : `getProductsRanking(month)`
  (groupement par identifiant, nom courant puis historique, gain `null` si
  un coût de produit supprimé manque).
- Récapitulatif par vendeur : `getSellersRanking(month)`.

### 1.3 Fuseau réellement utilisé

Celui du processus API (`Intl.DateTimeFormat().resolvedOptions().timeZone`,
même source que le bilan 1-16A.1). L'image Docker `node:22-alpine` ne
définit pas `TZ` : en production il vaut très probablement **UTC**, non
vérifié sur Railway. Le fuseau est écrit dans chaque rapport (synthèse,
pied de page du PDF, note sur les bornes) et affiché sous les boutons.
Sur le poste de développement, il vaut `Europe/Berlin` : les e2e ont donc
vérifié les bornes dans un fuseau autre que UTC. Préparation de
`TZ=Africa/Douala` pour le lancement : § 11.2.

### 1.4 Ancien export hors connexion

`web/src/lib/offline-sales-export.ts` (1-11C.3) : JSON et CSV des ventes
**non synchronisées** de l'outbox, boutons `ExportButtons` dans le panneau
des ventes en attente (2 emplacements), la boîte de déconnexion
(2 emplacements) et l'écran de blocage commercial (1 emplacement).

## 2. API

| Route | Rôle |
|---|---|
| `GET /reports/monthly` | Mois proposés (du mois de création du commerce, ou de sa plus ancienne vente, au mois en cours), nombre de ventes de chacun, mois **sans vente** compris, fuseau, préfixe du nom de fichier |
| `GET /reports/monthly/:month/:format` | `format` = `xlsx` ou `pdf` ; fichier en pièce jointe, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, nom `historique-<slug>-AAAA-MM.<ext>` |

### 2.1 Accès

À chaque requête, les gardes globales relisent tout en base : session
(`JwtAuthGuard`), organisation et appartenance actives
(`OrganizationGuard`), accès commercial (`SubscriptionAccessGuard`, route
**métier** : refus si l'abonnement est inactif ou la session limitée), puis
`@RequirePermissions('analytics.read', 'sales.view_all')`. Le contrôleur
exige ensuite le **rôle d'organisation** propriétaire ou administrateur :
un vendeur à qui ces deux droits auraient été délégués reste refusé (403
`PERMISSION_DENIED`). L'organisation vient uniquement du contexte serveur.

Contenu selon les droits actuels (`effectivePermissions`) :

- gain estimé : `analytics.read` **et** `products.view_financials` ;
- acheteur et contact : `sales.view_all`.

Propriétaire et administrateur ont aujourd'hui toutes les permissions
délégables : ces deux blocs sont donc toujours présents pour eux, mais la
règle est appliquée et testée (colonnes absentes sans le droit).

### 2.2 Données (`MonthlyHistoryService`)

- La liste **complète** des ventes du mois est lue avec le même filtre, sans
  pagination, triée par date métier.
- Elle est lue **en même temps** que les trois agrégations de l'Analyse ; ses
  totaux par mois, par produit et par vendeur doivent coïncider exactement.
  Sinon (vente créée ou modifiée entre deux lectures), tout est relu ; après
  trois essais, 503 `REPORT_DATA_CHANGED` (« Réessayez »).
- Noms (garanties 1-15D) : colonne « Produit (nom lors de la vente) » =
  `productName`, sinon « Nom non enregistré lors de la vente » ; colonne
  « Nom actuel ou dernier connu », renseignée seulement quand elle diffère ;
  « État du produit » : Disponible, Dans la corbeille, **Produit supprimé**.
- Valeur inconnue : « Information indisponible », jamais 0 (gain d'un
  produit supprimé sans coût conservé, et donc le gain total).
- Vendeurs dont le compte n'existe plus : l'Analyse les écarte (jointure
  stricte, limite 1-15D) ; le rapport les regroupe sur une ligne « Compte
  vendeur supprimé », pour que le récapitulatif totalise toutes les ventes.
- Corrections et annulations : entrées du journal **datées du mois**
  (date de l'opération). Une correction sans changement effectif n'est pas
  listée. Pour une correction, la date de la vente concernée est donnée si
  la vente existe encore. Le produit est désigné par son nom actuel, sinon
  par son dernier nom connu dans les ventes, sinon « Information
  indisponible ».

### 2.3 Écart avec la carte « Bénéfice net » de l'Analyse (corrigé en § 11.1)

En mode mois, la carte « Bénéfice net » de l'Analyse soustrait au montant
du mois le coût des ventes **de toutes les périodes** (règle existante,
limite déjà notée en 1-15D § 9). Ce chiffre n'a pas de sens pour un mois
isolé ; il n'est **pas** reproduit. Le rapport donne le « Gain estimé des
produits vendus » = somme des gains du classement par produit de
l'Analyse, qui est, lui, limité au mois. Le libellé et une note l'expliquent.
*Première passe :* règle de l'Analyse laissée telle quelle. *Finalisation :*
la carte mensuelle utilise désormais ce même gain (§ 11.1).

## 3. Contenu des fichiers

Libellés regroupés dans `api/src/reports/report-labels.ts`
(`REPORT_LABELS.fr`, type `ReportLabels` prêt pour un objet `en`).

**Excel** (`.xlsx`), 5 feuilles :

| Feuille | Contenu |
|---|---|
| Synthèse | Commerce, période (début, fin), fuseau, date et auteur de la génération, chiffres essentiels, « À savoir » (ventes en attente non incluses, bornes, état actuel des ventes, noms, gain, corrections) |
| Ventes | Date, produit (nom lors de la vente), nom actuel ou dernier connu, état, quantité, prix unitaire, montant, vendeur, acheteur, contact ; ligne de total |
| Par produit | Produit, état, quantité, nombre de ventes, montant, gain estimé ; total |
| Par vendeur | Vendeur, quantité, nombre de ventes, montant ; total |
| Corrections et annulations | Date, opération, produit, état, date de la vente, quantité et prix avant/après, détail, auteur |

En-têtes figés, filtres automatiques (lignes de total hors du filtre),
largeurs de colonnes, dates en numéros de série Excel avec format
`jj/mm/aaaa hh:mm` (heure murale du fuseau du rapport), montants en
nombres au format `#,##0 "FCFA"`, impression paysage ajustée en largeur
avec la ligne d'en-tête répétée. **Tout texte est une chaîne en ligne
(`inlineStr`) ; aucune cellule de formule n'est jamais écrite** : un nom
commençant par `=`, `+`, `-` ou `@` reste du texte. Les caractères interdits
en XML sont retirés.

**PDF** (A4 paysage) : page de bilan (période, fuseau, génération, cartes
des chiffres essentiels, compteurs, notes), puis les quatre tableaux
complets. Chaque page porte le commerce, le mois, la date de génération,
le fuseau et « Page n / N ». Un tableau qui continue reprend son titre
« (suite) » et son en-tête de colonnes ; les textes longs sont répartis sur
plusieurs lignes ; la somme des largeurs de colonnes est vérifiée (une
largeur incorrecte lève une erreur), donc aucune colonne n'est coupée. Aucun
texte enregistré n'est jamais remplacé : un caractère non reproductible fait
refuser le PDF (422), § 11.3.

## 4. Interface

`web/src/components/analytics/monthly-history-download.tsx`, en haut de
**Analyse**, affiché seulement au propriétaire et à l'administrateur ayant
les deux droits (même règle que le serveur, qui reste seul juge) :

- liste des mois avec leur nombre de ventes (« aucune vente »), mois en
  cours signalé ; par défaut, le dernier mois terminé ;
- « Télécharger en Excel », « Télécharger en PDF » ; verrou contre le double
  clic, libellé « Préparation… », message de réussite ;
- erreurs lisibles (droits, abonnement, mois invalide, données en cours de
  modification, serveur injoignable) ; « Réessayer » si la liste échoue ;
- mois sans vente : « le fichier contiendra seulement le bilan, à zéro » ;
- hors ligne : boutons désactivés, « nécessite une connexion Internet » ;
- rappel que les ventes en attente de synchronisation ne figurent pas dans
  le rapport, avec le nombre de ventes en attente sur cet appareil.

Le nom du fichier vient du préfixe renvoyé par `GET /reports/monthly` : la
configuration CORS existante n'expose pas `Content-Disposition` et n'a pas
été modifiée.

## 5. Choix des générateurs

Écrits dans le projet (`api/src/reports/xlsx`, `api/src/reports/pdf`), sans
dépendance : ZIP (deflate de `zlib`, CRC-32), SpreadsheetML minimal, PDF 1.4
avec Helvetica standard (WinAnsi) et flux compressés. Raisons : aucun ajout
à la chaîne d'approvisionnement (politique 1-12D/1-12F), et un contrôle
complet sur la garantie « jamais de formule ». Contrepartie : voir § 8.

## 6. Ancien export retiré

- Supprimés : `web/src/lib/offline-sales-export.ts`, `ExportButtons` et
  `EXPORT_WARNING` ; boutons retirés des 5 emplacements.
- Textes adaptés : blocage pour incohérence (« note les ventes concernées
  et contacte le support »), abandon d'une vente (« vérifie la liste des
  ventes »), suppression à la déconnexion (« Action irréversible »), limite
  de 200 ventes en attente, messages de conflit de la politique hors ligne,
  commentaires.
- **Conservés sans changement** : ventes locales, outbox, synchronisation,
  confirmation explicite des suppressions, abandon sans effacement. Aucun
  code ne touche aux stockages locaux.
- Pages : Guide (nouvelle rubrique « Télécharger l'historique d'un mois »,
  « Synchronisation » sans export), Cookies et stockage local, Accord de
  traitement (« Restitution et suppression »).

## 7. Validations

| Contrôle | Résultat |
|---|---|
| `isolated api-e2e test/monthly-history-export` | **8/8** (1er passage 5/8 : deux erreurs du test, voir ci-dessous) |
| `isolated api-e2e` monthly-history-export, sale-history-purge, notification-center | **3 suites, 30/30** ; `existsSync api\.env` bloqué, jamais lu |
| `isolated api-unit` reports, subscription-access-routes, analytics, notifications | **5 suites, 43/43** |
| Fichiers réels relus hors projet | `.xlsx` par `openpyxl` (venv temporaire) ; PDF par `pdfinfo`, `pdftotext`, `pdftoppm` (rendu des pages contrôlé visuellement) |
| ESLint API sur les fichiers touchés, sans `--fix` | 0 |
| `tsc --noEmit -p tsconfig.build.json` ; `pnpm --filter api build` | 0 ; réussi |
| ESLint web (`npx eslint src`, sans `--fix`) ; `tsc --noEmit` | 0 ; 0 |
| `isolated web-build` | exit 0 ; 3 `.env*` de `web/` écartés par leur nom, 0 dans la copie ; copie supprimée |
| Recette navigateur (pile `recipe.js start`) | **19/19** |
| `git diff --check` | exit 0 |

**Couverture e2e (8)** : bornes exactes (vente au début inclus, à la fin −1
ms incluse, juste avant et à la fin exclues, vente ancienne sans
`occurredAt`) ; totaux de la synthèse égaux à `GET /analytics/overview` ;
en-têtes HTTP ; aucune formule ; isolation A/B dans les deux sens ; PDF
(bilan, tableaux, pagination) ; 260 ventes : toutes présentes, PDF de plus
de 4 pages, « (suite) » et en-tête répétés ; produit purgé (nom enregistré,
nom final, « Produit supprimé », gain 600 identique à l'Analyse) et coût
inconnu (« Information indisponible » par produit et au total) ;
correction et annulation réelles par l'API, correction sans changement
ignorée ; mois sans vente proposé et généré ; refus du vendeur, du vendeur
délégué, sans session, appartenance suspendue après connexion ; mois et
format invalides (dont mois futur) en 400.

**Unitaires (10)** : CRC-32, colonnes et échappement XML, texte jamais
formule, nombres et dates typés, volet figé, filtre, titres d'impression ;
colonnes acheteur et gain absentes sans droit (Excel et PDF) ; inconnu
jamais 0 ; WinAnsi et retours à la ligne ; en-tête répété et « Page n / N »
sur 120 lignes ; largeur de tableau vérifiée ; mois futur refusé ; nom de
fichier sûr. Matrice d'accès : les deux routes sont métier, avec contexte
d'organisation, sans exception commerciale.

**Écarts au premier passage, corrigés dans les tests** : l'extracteur PDF
du test prenait `endstream` pour un début de flux ; le « mois vide » choisi
(avril 2025) recevait légitimement la vente posée exactement à la borne de
fin de mars. Une exécution unitaire a aussi renvoyé 1 sans sortie lisible
dans mon filtre ; deux relances identiques ont donné 30/30, la cause n'a pas
été établie.

### 7.3 Recette navigateur (19/19)

Pile éphémère `recipe.js start` (fournisseur simulé, web de production dans
la copie isolée), Chromium 1234 piloté par Playwright 1.62.1 hors du dépôt.
181 ventes ensemencées en septembre 2026 dans « Boutique Active », dont une
d'un produit purgé sans coût conservé et un produit nommé `=1+1 …`.

- **Ordinateur (1280 px), propriétaire** : mois proposés avec leur nombre
  de ventes (« octobre 2026 (en cours) — aucune vente »), septembre par
  défaut, mention des ventes en attente ; téléchargement Excel puis PDF
  (nom `historique-boutique-active-…-2026-09.*`), message de réussite ;
  mois sans vente annoncé puis PDF de 2 pages ; erreur 503 simulée :
  « Des ventes ont changé pendant la préparation… » ; hors ligne : boutons
  désactivés et message ; plus aucun bouton « Exporter JSON/CSV » ; aucune
  erreur console hors le 503 provoqué.
- **Téléphone (390 px, tactile)** : aucun débordement horizontal ; PDF et
  Excel téléchargés.
- **Administrateur** : Excel téléchargé.
- **Vendeur** : bloc absent ; appels directs de l'API depuis sa session :
  403 sur la liste des mois et sur le téléchargement.

Fichiers téléchargés relus : Excel, 181 lignes, 362 unités, 371 710 FCFA,
aucune formule, `=1+1 …` en texte, vente du produit purgé avec son nom
enregistré, son dernier nom et « Produit supprimé », gain « Information
indisponible » (produit et total) ; PDF de 14 pages (ordinateur et
téléphone). L'écran Analyse affiche les mêmes totaux (371 710 FCFA, 362,
181). Captures : `phase-1-16d-captures/` (bloc sur ordinateur et téléphone,
erreur, bilan PDF, tableau aux textes longs, dernière page).

Le contrôle « ancien export absent » portait sur une page sans vente en
attente ; l'absence du code est établie par la suppression du module et la
recherche de toute référence (aucune).

## 8. Limites (état après finalisation, § 11)

1. **Fuseau** : `TZ=Africa/Douala` est préparé (README, `docker-compose.prod.yml`,
   validation au démarrage) mais **pas configuré dans Railway** : tant qu'il
   ne l'est pas, la production reste au fuseau du conteneur (probablement
   UTC). La configuration Railway n'a pas été consultée.
2. **PDF** : Helvetica WinAnsi, sans police embarquée. Le français est
   intégralement reproduit ; un nom contenant un caractère hors
   Windows-1252 (autre alphabet, émoji, ł, ā, ő…, espace fine, tabulation)
   fait **refuser** le PDF du mois (422, caractères cités) ; l'Excel le
   conserve exactement. Les largeurs de caractères viennent des métriques
   Helvetica, avec une marge.
3. Une cellule PDF anormalement longue (plus d'une page) est coupée avec
   « … » ; une cellule Excel est limitée à 32 767 caractères (limite Excel).
   Les longueurs autorisées par l'application restent loin de ces bornes.
4. Limitation et borne de simultanéité **en mémoire d'une seule instance**
   (comme les autres limitations du projet) ; un déploiement à plusieurs
   instances exigerait un stockage partagé. Génération en mémoire, sans
   troncature.
5. Gain estimé : prix d'achat **actuel** du produit (règle de l'Analyse) ;
   un prix modifié entre-temps n'est pas historisé. En mode mois, les écarts
   de stock figés à la purge (1-15D, non datés) ne sont comptés que dans la
   vue globale.
6. Nom du vendeur : nom actuel du compte (aucun instantané à la vente).
7. Ajouts de stock, renommages et changements de prix non repris : leur
   journal ne confirme pas l'opération. Aucun stock historique n'est
   affiché.
8. Abonnement inactif : le téléchargement est refusé (route métier), comme
   l'Analyse. Fichiers non testés dans Microsoft Excel ni LibreOffice
   (absents du poste) : relecture par `openpyxl` seulement.
9. Le fichier contient des données d'acheteurs : conservation et diffusion
   relèvent du commerce (rappel dans le guide).
10. Durées d'abonnement (`subscription-terms.ts`) toujours calculées en
    UTC : hors périmètre, non modifiées.

## 9. Fichiers

API — nouveaux : `src/analytics/month-range.ts`, `src/reports/`
(`reports.module.ts`, `monthly-history.controller.ts`,
`monthly-history.service.ts`, `monthly-history.types.ts`,
`monthly-history-xlsx.ts`, `monthly-history-pdf.ts`, `report-labels.ts`,
`report-format.ts`, `xlsx/zip.ts`, `xlsx/xlsx-writer.ts`,
`pdf/pdf-fonts.ts`, `pdf/pdf-writer.ts`, `report-generators.spec.ts`),
`test/monthly-history-export.e2e-spec.ts`. Modifiés :
`src/analytics/analytics.service.ts` (bornes partagées),
`src/app.module.ts`, `src/subscriptions/subscription-access-routes.spec.ts`.

Web — nouveaux : `src/lib/monthly-history.ts`,
`src/components/analytics/monthly-history-download.tsx`. Supprimé :
`src/lib/offline-sales-export.ts`. Modifiés : `app/app/analytics/page.tsx`,
`components/sales/pending-sales-panel.tsx`,
`components/sales/logout-pending-dialog.tsx`,
`components/subscription/local-pending-sales.tsx`,
`components/products/record-sale-dialog.tsx`, `lib/offline-sales-policy.ts`,
`app/guide/page.tsx`, `app/cookies/page.tsx`,
`app/traitement-donnees/page.tsx` ; commentaires seuls :
`app/access/page.tsx`, `app/app/layout.tsx`,
`components/subscription/commercial-block-screen.tsx`,
`contexts/offline-sales-context.tsx`.

## 10. État Git

Branche `architecture/phase-1-16c-legal-and-usage-pages`, HEAD `8994798`
inchangé, **index vide**, `stash@{0}` (lint-staged `564a998`) inchangé.
Arbre de travail : 17 fichiers suivis modifiés ou supprimés (dont
`web/src/lib/offline-sales-export.ts` supprimé), et non suivis :
`api/src/analytics/month-range.ts`, `api/src/reports/`,
`api/test/monthly-history-export.e2e-spec.ts`,
`docs/architecture/phase-1-16d-captures/`, ce rapport,
`web/src/components/analytics/`, `web/src/lib/monthly-history.ts`. Copie
de recette `.stockmaster-recipe-web/` supprimée. Aucun commit, push ni
déploiement. (État final après la finalisation : § 11.8.)

## 11. Finalisation — fiabilité des rapports (7 octobre 2026)

Même arbre (HEAD `8994798`, modifications 1-16D non commitées), index vide,
`stash@{0}` intact. Aucun commit, push, déploiement, base réelle ni `.env`
lu ; aucune variable Railway modifiée, aucune date en base modifiée.

### 11.1 Gain mensuel de l'Analyse

**Reproduit avant correction** (e2e, commerce dédié, produit acheté 100 et
vendu 400 ; 2 unités en juillet 2025, 3 en septembre 2025) :
`GET /analytics/overview?month=2025-07` renvoyait `netProfit: 300` et
`avgMargin: 37.5` (800 − 5 × 100 : coût de **toutes** les périodes) au lieu
de 600 et 75 %. Une vente de septembre d'un produit purgé sans coût
conservé rendait en plus le gain de **juillet** indisponible (`null`).

**Correction** (`AnalyticsService.getOverview`) : avec un mois, gain = somme
des gains du classement par produit **de ce mois** (`getProductsRanking`,
règle 1-15D : prix d'achat actuel, coût figé à la purge), marge = gain /
montant du mois. Un coût inconnu **parmi les ventes du mois** rend le gain
et la marge indisponibles (`null`, affichés « — »), jamais 0. Sans mois :
règle existante inchangée (coût du stock, coûts figés et écarts de purge
1-15D). C'est exactement le « Gain estimé » du rapport (vérifié : 600 dans
les deux). Les écarts de stock figés à la purge ne sont pas datés : ils
restent dans la seule vue globale.

**Écran** : avec un mois choisi, « Gain estimé du mois » et « Marge estimée
du mois », sous-titre « Ventes du mois moins le prix d'achat actuel des
produits vendus (prix figé à la suppression d'un produit) » ; inconnu :
« — » et « Coût d'achat inconnu (produits supprimés) ». Guide et note du
rapport mis à jour.

### 11.2 Calendrier du Cameroun (`TZ=Africa/Douala`)

- **Préparé, non activé** : `README.md` (variables Railway, avec
  explication) et `docker-compose.prod.yml` (`TZ: ${TZ:-Africa/Douala}`).
  Le `Dockerfile` n'est pas modifié : le dépôt ne montre pas comment Railway
  construit l'API, et changer l'image activerait le fuseau au prochain
  déploiement.
- **Démarrage** (`main.ts`, `configureProcessTimeZone`) : `TZ` validé ; un
  nom inconnu bloque le démarrage. Vérifié dans l'image
  `node:22.17.1-alpine3.22` épinglée (sans `/usr/share/zoneinfo`) :
  `Africa/Douala` est appliqué par l'ICU de Node, et un nom erroné
  (`Afrique/Douala`) y est **silencieusement** ignoré (fuseau indéfini, donc
  UTC), d'où le refus. Le fuseau effectif est journalisé.
- **Bornes alignées** : la courbe mensuelle de l'Analyse (et donc la liste
  de mois de l'écran) groupait en **UTC** (`$year`/`$month` sans fuseau)
  alors que les filtres utilisaient le fuseau du processus ; elle utilise
  désormais le même fuseau. Sans effet en UTC. Défaut établi par lecture du
  code, non reproduit avant correction.
- **Vérifié en environnement éphémère** (`test/monthly-boundaries-douala`,
  lancé avec la nouvelle option `--tz=Africa/Douala` du lanceur isolé ;
  seule variable ajoutée à l'environnement construit, garde `.env`
  inchangée) : vente à `2026-09-30T23:30:00Z` = 1er octobre 00:30 ; octobre
  commence à `2026-09-30T23:00:00Z` ; vue d'ensemble, classement, courbe
  (`2026-10`), liste des mois (octobre 1, septembre 0), Excel (date
  01/10/2026 00:30, fuseau affiché), PDF, bilan mensuel
  (`previousReportPeriod` = mêmes bornes, `salesCount` 1 en octobre, 0 en
  septembre) : **4/4**. Sans `--tz`, la suite est **ignorée** (visible dans
  le décompte Jest), jamais réussie à tort. Le `process.env` d'un test Jest
  est une copie : au premier essai, la garde de `configureProcessTimeZone`
  l'a signalé (« non appliqué »).
- Observation : sous Git Bash (MSYS), un `TZ=…` préfixé à la commande
  n'atteint pas Node ; lancé par un processus Node, il est appliqué.

### 11.3 Fidélité du PDF

- Substitutions supprimées : plus de lettre sans accent, de « ? », de
  tabulation ou d'espace fine convertie. `encodeWinAnsi` lève une erreur sur
  tout caractère hors Windows-1252.
- Avant toute mise en page, `assertPdfReproducible` contrôle **tous** les
  textes enregistrés (commerce, auteur, produits, noms actuels, vendeurs,
  acheteurs, contacts, auteurs des corrections). Un seul caractère
  impossible : **422 `REPORT_PDF_UNSUPPORTED_CHARACTERS`**, avec un message
  du type « Certains noms de ce mois contiennent des caractères que le PDF
  ne peut pas reproduire fidèlement (« Ł », « ź »). Téléchargez la version
  Excel, qui les conserve exactement. », affiché tel quel à l'écran.
- Police embarquée écartée : il faudrait ajouter au dépôt un fichier de
  police et un sous-ensemble de glyphes construit à la main, ce qui est
  disproportionné. Windows-1252 couvre tout le français.
- **Vérifié** :
  - unitaires : texte français codé puis décodé à l'identique ; ā, émoji,
    Ж, Łódź, espace fine, tabulation, retour à la ligne refusés ; rendu
    refusé avec la liste exacte des caractères ; Excel exact ;
  - e2e : 422 sur « Savon de Łódź », Excel 200 avec le nom exact ; PDF
    accepté pour « Œufs l'été — crème brûlée », avec les octets 8C, 92 et
    97 dans le flux ;
  - fichier réel lu par `pdftotext -enc UTF-8` : « Œufs l’été — « crème
    brûlée » », « Pâté de foie gras “maison” », « Cœur de bœuf à l’ail »,
    « 5 € la bouteille… Ÿ », « Boutique « Chez Zoé » & Œuvres »,
    « Hélène N’Diaye », « Aïcha Ngô d’Ébène » et « Lœvenbruck » retrouvés
    à l'identique ; page rendue par `pdftoppm` et contrôlée
    (`phase-1-16d-captures/pdf-fidelite-francais.png`).
- Écart de test corrigé : le `TextDecoder('windows-1252')` de Node décode
  0x80–0x9F comme des contrôles Latin-1 ; le test utilise une table
  Windows-1252 explicite. Le PDF, lui, était correct.

### 11.4 Protection de la génération

`api/src/reports/report-generation-limiter.ts`, paramètres centralisés
(`REPORT_GENERATION_LIMITS`, fournis par le jeton
`REPORT_GENERATION_LIMITS_TOKEN`) :

| Paramètre | Valeur et réponse |
|---|---|
| Quota par compte **et** commerce | 20 téléchargements / 10 min → **429 `REPORT_RATE_LIMITED`**, `Retry-After` exact |
| Générations simultanées, global | 3 → **503 `REPORT_GENERATION_BUSY`**, `Retry-After: 10` |
| Générations simultanées par commerce | 2 (Excel et PDF ensemble) → même 503 |

- Appliqué au seul téléchargement, **après** session, organisation,
  abonnement, droits, rôle, format et mois : une requête refusée ou
  invalide ne consomme rien ; un refus de simultanéité non plus.
- Place libérée dans un `finally` (succès, erreur, 422) ; libération
  idempotente ; fenêtres expirées purgées.
- Indépendant du `ThrottlerModule` : y ajouter une fenêtre aurait imposé une
  exclusion sur chaque autre contrôleur limité. Aucun autre compteur n'est
  touché ; aucun rapport n'est tronqué.
- **Vérifié** : unitaires (4) ; e2e `test/monthly-history-limits` (3/3,
  limites de test réduites, course ordonnée par barrière) : 503 pendant une
  génération du même commerce, autre commerce servi, place rendue puis
  Excel **et** PDF servis ; 500 simulé puis place rendue ; 429 avec
  `Retry-After` au 5e téléchargement, autre compte servi, liste des mois,
  Analyse et connexion inchangées, mois invalide toujours en 400.
- Premier essai : 503 attendu, 200 reçu. Le jeton de paramètres n'était pas
  déclaré dans le module, donc non remplaçable : fournisseur déclaré. La
  barrière restée fermée bloquait l'arrêt du test : elle est désormais
  rouverte dans un `finally`.

### 11.5 Compte vendeur supprimé

E2E : 4 ventes d'un vendeur dont le compte et l'appartenance sont
supprimés. L'Analyse l'écarte (classement vendeurs vide) ; le rapport
renvoie **200** en Excel et en PDF (aucun 503) ; les 4 ventes figurent dans
la feuille Ventes ; la ligne « Compte vendeur supprimé » et le total valent
10 unités et 4 000 FCFA. Aucun code modifié : la vérification de cohérence
ne porte que sur les vendeurs présents dans le classement.

### 11.6 Contrôles exécutés

| Contrôle | Résultat |
|---|---|
| `isolated api-e2e` monthly-history-export, monthly-history-limits, sale-history-purge, notification-center, monthly-boundaries-douala | **36/36**, 4 ignorés (Douala sans `--tz`) ; lecture de `api/.env` bloquée 5 fois, jamais lue |
| `isolated api-e2e --tz=Africa/Douala test/monthly-boundaries-douala` | **4/4**, `timeZone: Africa/Douala` |
| `isolated api-unit` reports, analytics, notifications, subscription-access-routes | **7 suites, 53/53** |
| ESLint API (fichiers touchés, sans `--fix`) | 0 erreur, 0 avertissement (2 avertissements introduits puis supprimés en typant `revenue`) |
| `tsc -p tsconfig.build.json` ; `pnpm --filter api build` | 0 ; réussi |
| `tsc -p tsconfig.json` (tests compris), filtré sur les fichiers 1-16D | 0 erreur (une erreur de type dans mon e2e, `permissions: string[]`, corrigée) |
| `node --check` des scripts de recette modifiés | OK |
| ESLint web (`npx eslint src`, sans `--fix`) ; `tsc --noEmit` | 0 ; 0 |
| `isolated web-build` | exit 0 ; 0 `.env` dans la copie ; copie supprimée |
| PDF réel : `pdftotext`, `pdftoppm` | voir § 11.3 |

Non relancés (hors du périmètre demandé) : campagnes navigateur, paiement,
temps réel, suites API complètes. La recette navigateur 19/19 du § 7.3
date de la première passe ; les libellés de la carte mensuelle et les
messages 422, 429 et 503 de l'écran n'ont été contrôlés que par le typage,
le lint et le build.

Note : un MongoDB local de développement (port 27018, dossier
`~/.stockmaster-local`, lancé le 3 octobre) tourne sur le poste ; il n'a
été ni utilisé ni arrêté.

### 11.7 Fichiers de cette étape

- API, modifiés : `src/analytics/analytics.service.ts` (gain mensuel,
  courbe au fuseau), `src/analytics/analytics.service.spec.ts`,
  `src/analytics/month-range.ts` (`configureProcessTimeZone`),
  `src/main.ts`, `src/reports/pdf/pdf-fonts.ts`, `pdf/pdf-writer.ts`,
  `monthly-history-pdf.ts`, `monthly-history.controller.ts`,
  `reports.module.ts`, `report-labels.ts`, `report-generators.spec.ts`,
  `test/monthly-history-export.e2e-spec.ts`.
- API, nouveaux : `src/analytics/month-range.spec.ts`,
  `src/reports/report-generation-limiter.ts` et sa spec,
  `test/monthly-history-limits.e2e-spec.ts`,
  `test/monthly-boundaries-douala.e2e-spec.ts`.
- Recette : `test/recipe/isolated-checks.js`, `test/recipe/recipe.js`
  (option `--tz`).
- Web : `app/app/analytics/page.tsx`, `lib/monthly-history.ts`,
  `lib/api.ts` (commentaire), `app/guide/page.tsx`.
- Racine : `README.md`, `docker-compose.prod.yml` ; capture
  `phase-1-16d-captures/pdf-fidelite-francais.png`.

### 11.8 État Git final

Branche `architecture/phase-1-16c-legal-and-usage-pages`, HEAD `8994798`
inchangé, **index vide**, `stash@{0}` (lint-staged `564a998`) inchangé,
`git diff --check` : exit 0.

- **24 fichiers suivis** modifiés ou supprimés, dont
  `web/src/lib/offline-sales-export.ts` supprimé. Ceux de cette étape :
  `README.md`, `docker-compose.prod.yml`, `api/src/main.ts`,
  `api/src/analytics/analytics.service.spec.ts`,
  `api/test/recipe/isolated-checks.js`, `api/test/recipe/recipe.js`,
  `web/src/lib/api.ts`.
- **Non suivis** : `api/src/analytics/month-range.ts` et sa spec,
  `api/src/reports/`, les trois e2e `monthly-history-export`,
  `monthly-history-limits` et `monthly-boundaries-douala`,
  `docs/architecture/phase-1-16d-captures/`, ce rapport,
  `web/src/components/analytics/`, `web/src/lib/monthly-history.ts`.
- Aucun commit, push ni déploiement.
