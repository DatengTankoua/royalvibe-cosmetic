# Lot 1-16E — Une page Analyse utile aux décisions du magasin

État : **implémenté et finalisé, non commité**. Aucun commit, push,
déploiement ni activation. CamPay reste indisponible, webhook désactivé.

## 1. Base

- Branche `architecture/phase-1-16c-legal-and-usage-pages`, HEAD réel
  `ab7441f` (« feat: add versioned terms acceptance and predeploy
  migrations ») : le lot 1-16C.2 annoncé « peut-être non commité » l'était
  déjà. L'état communiqué au départ (`03f5459`) est le parent de 1-16C.2.
- Arbre propre et index vide au départ ; stash `stash@{0}` (« lint-staged
  automatic backup (564a998) ») conservé, jamais appliqué. Au début de la
  finalisation, état identique (HEAD `ab7441f`, fichiers 1-16E non commités,
  index vide, même stash). Archives juridiques de 1-16C.2 non modifiées.
- Skill de référence lu : `asgard-ai-platform/skills`,
  `data-dashboard-design/SKILL.md`, **commit
  `7d6869a5a2aab1226a51a5e50d757fe945991db8`** (7 avril 2026, dernier commit
  touchant ce fichier). Principes retenus, adaptés au magasin, sans outil BI :
  un écran pour un public (le responsable) et un but (décider) ; pyramide
  courte (3 priorités, 3 chiffres, puis détails) ; lecture en 5 secondes ;
  toute métrique avec un contexte de comparaison ; hygiène des métriques
  (anciennes cartes reléguées dans « Détails ») ; confiance dans les données
  (fraîcheur, ventes locales non comptées). La « Layer strategy »
  (tableaux exécutif/opérationnel/diagnostic) devient : écran principal,
  section « Stock actuel », section « Détails ».

## 2. Audit court (avant implémentation)

| Élément | Constat |
|---|---|
| `AnalyticsController` | Toutes les routes sous `analytics.read`. Les gains, marges et le capital investi étaient renvoyés à tout membre ayant ce droit, même sans `products.view_financials` |
| `AnalyticsService` | Classement par produit = source du gain mensuel (1-16D), regroupé par identifiant, purgés gérés (nom et coût figés, coût inconnu → `null`) |
| Ventes | Corrections = mise à jour en place ; annulation = suppression : les documents présents sont les ventes nettes confirmées. Date métier `occurredAt`, repli `createdAt` |
| Produits | `createdAt` (timestamps), `deletedAt` (corbeille), stock `remainingQuantity`. Seuil existant « 80 % consommé » (`push/stock-thresholds.ts`, 1-16A.1) ≡ statut `low_stock` |
| Droits | `analytics.read` ; financier = `products.view_financials` (règle déjà appliquée par l'historique mensuel 1-16D) ; détails de stock = `products.view_stock_details` (`product-projection.ts`, 1-12H) ; modification stock/prix = `stock.adjust` |
| Pagination | Aucune pagination existante pour ces listes (les autres routes renvoient des listes complètes) |
| Index | `sales {organizationId, productId, createdAt}`, `products {organizationId, sectionId, deletedAt}` : réutilisés (filtre initial sur `organizationId`), aucun nouvel index |
| Temps réel | `useLiveRefresh` (coordinateur, rattrapage à la reconnexion) + `useSocketSignals` ; signaux ventes et produits déjà définis pour l'Analyse |

## 3. Écran

Ordre : **À surveiller → Vos ventes → Ce qui se vend**, puis l'historique
mensuel Excel/PDF (1-16D, inchangé), puis deux sections repliées : « Stock
actuel et rythme des ventes » (listes complètes, paginées) et « Détails :
Produits, vendeurs et historique » (`#analytics-details` : classements du
mois, ventes par vendeur, historique par mois, totaux depuis le début ;
requêtes lancées seulement à l'ouverture).

- **À surveiller** : au plus 3 cartes, par gravité `out` > `soon` > `price` >
  `low` > `stale`. Chaque carte : titre courant, décompte, fait chiffré (le
  produit le plus urgent), raison courte, action vers le parcours existant,
  bouton « Voir les N produits concernés » qui ouvre et focalise la liste
  correspondante. **N = total de cette liste** (même priorité unique, § 4).
- **Listes « Stock actuel »** : la première page (50) arrive avec l'Analyse ;
  « Afficher les N suivants » charge la suite (`/analytics/insights/list`,
  même ordre). Affichage « 50 affichés sur 63 », bouton retiré quand tout est
  affiché ; message d'erreur et nouvel essai possibles. Un produit déjà
  affiché n'est jamais ajouté deux fois. À chaque relecture temps réel,
  chaque liste repart de sa première page à jour.
- **Actions** : avec `stock.adjust`, « Ajouter du stock » / « Revoir le
  prix » ouvrent la fenêtre de modification existante du catalogue
  (`/app/catalog/<section>?modifier=<produit>`, ouverte une fois, seulement si
  le compte peut modifier ; le serveur revalide chaque champ). Sinon, « Voir
  le produit ». Aucune action automatique.
- **Vos ventes** : montant, nombre de ventes (+ unités), gain estimé
  seulement avec le droit financier. Mois en cours par défaut (mois du
  serveur, fuseau de l'API). Période affichée, comparaison datée, rappel
  « ventes enregistrées, pas nécessairement de l'argent encaissé ».
  Présentation des comparaisons : § 4.
- **Ce qui se vend** : ventes par jour (barres aux couleurs du commerce,
  résumé textuel + tableau jour par jour) et 5 premiers produits par montant
  (montant, quantité, **stock actuel** explicitement indépendant de la
  période).
- Fraîcheur (« Données du serveur à HH:MM ») et rappel discret des ventes
  locales non synchronisées (avec leur nombre sur cet appareil).

## 4. Calculs (`api/src/analytics/insights.ts`, fonctions pures)

Seuils centralisés : `api/src/analytics/insight-thresholds.ts` — **choix du
produit, ajustables après usage** :

| Seuil | Valeur |
|---|---|
| Fenêtre d'observation | 28 jours civils terminés (aujourd'hui exclu) |
| Observation minimale | 14 jours |
| Dates de vente distinctes minimales | 3 |
| Mise en évidence | ≤ 7 jours estimés (valeur non arrondie) |
| Cartes « À surveiller » | 3 |
| « Ce qui se vend » | 5 produits |
| Taille de page des listes | 50 (décomptes sur tous les produits) |

- Début d'observation = max(début de fenêtre, jour d'ajout du produit, jour
  de création du commerce) ; le jour d'ajout compte. Ventes antérieures à ce
  début ignorées.
- `moyenne = quantité vendue / jours d'observation` ;
  `jours restants = stock actuel / moyenne`, calculé
  `stock × jours / quantité` pour éviter l'erreur d'arrondi (7 jours exacts
  restent 7).
- Estimation seulement avec ≥ 14 jours, ≥ 3 dates distinctes, quantités
  valides (nombre > 0, sinon « Quantités de vente invalides ») et moyenne
  positive ; sinon « Pas assez de ventes pour estimer ».
- Signaux : stock 0 → **rupture constatée** ; estimation ≤ 7 j → **risque
  estimé** ; sans estimation, seuil 80 % existant → **stock faible**. Les
  notifications 1-16A.1 ne changent pas.
- **Sans vente récente** : produit disponible (hors corbeille), stock > 0,
  ajouté avant la fenêtre, aucune vente enregistrée sur la fenêtre →
  « Aucune vente enregistrée depuis 28 jours ». Ajouté pendant la fenêtre →
  « Ajoutés récemment, pas encore vendus », jamais en carte. Aucune
  affirmation sur la disponibilité réelle pendant la période.
- **Prix à vérifier** (droit financier) : gain estimé négatif sur la
  période choisie, produit disponible, coût connu ; faits affichés : montant,
  unités, prix d'achat actuel, gain.
- Libellés : « au rythme des ventes enregistrées » ; saisonnalité, jours en
  rupture et délais fournisseurs explicitement inconnus.

### Priorité unique et ordre stable (finalisation)

- `assignPrimaryPriority` : chaque produit n'est gardé que dans la liste la
  plus grave (`out` > `soon` > `price` > `low` > `stale`) ; « Ajoutés
  récemment » exclut tout produit déjà présent dans une liste prioritaire.
  Cartes, listes, décomptes et pages partagent ce résultat : un produit en
  rupture **et** vendu à perte figure seulement dans « Rupture ».
  Conséquence : sans droit financier (pas de liste `price`), un tel produit
  peut apparaître dans « Stock faible » ou « Sans vente récente » ; les
  décomptes diffèrent donc selon les droits, sans rien révéler.
- Ordre total : critère métier (unités vendues, jours restants, stock, gain,
  date d'ajout), puis nom (fr), puis identifiant. Deux produits homonymes
  restent dans le même ordre d'une lecture à l'autre.
- Pages : `pageOf(liste, offset, limit)` sur la liste complète recalculée à
  chaque lecture (`count` = total réel à ce moment). Aucune liste illimitée
  n'est renvoyée : 50 éléments au plus par réponse.

### Chiffres et comparaisons

- Totaux et gain de la période = somme du classement par produit
  (`rankingFor`, extrait de `getProductsRanking` sans changement de règle) :
  **même gain que `/analytics/overview?month` et que l'historique mensuel**.
  Coût inconnu → gain `null` → « — ».
- Comparaison (`comparisonWindow`) : mois en cours → même durée écoulée
  depuis le début du mois précédent (**inchangé**) ; mois terminé → mois
  précédent entier, **vrais totaux mensuels** (concordants avec les exports).
  Indisponible si la période précédente commence avant la création du
  commerce, ou si la durée écoulée dépasse le mois précédent (ex. 30 mars
  face à février).
- **Mois terminés de durées différentes** (finalisation) : le serveur ajoute
  `days`, `previousDays`, `revenuePerDayChange` et `salesCountPerDayChange`
  (`changePercent` sur montant / jours). L'écran, dans les cartes existantes,
  affiche deux lignes nommées : « Total du mois : +10,7 % · avant : 28 000
  FCFA » et « Par jour : stable · avant : 1 000 FCFA par jour », puis
  « Comparé au 1 févr. – 28 févr. Mois de 31 jours contre 28 jours : le total
  dépend de la durée ; le rythme se lit « par jour ». » Mois de même durée :
  une seule ligne, comme avant. Base précédente à zéro : aucun pourcentage
  (total comme par jour). Le gain garde « avant : … » sans pourcentage.
- Bornes et filtre de date : `saleRangeMatch` (même règle que
  `saleMonthMatch`, qui l'appelle désormais). Jours civils : fuseau du
  processus API, comme 1-16D.

## 5. Droits et isolation

- `GET /analytics/insights?month=AAAA-MM` : `analytics.read` (garde), mois
  validé (400 `ANALYTICS_MONTH_INVALID` si invalide ou futur),
  `Cache-Control: no-store`, toutes les lectures filtrées par
  `organizationId` du contexte relu en base à chaque requête.
- `GET /analytics/insights/list?kind=&offset=&limit=&month=` (finalisation) :
  mêmes gardes ; `kind` ∈ `out|soon|price|low|stale|recent`, `offset` entier
  0–100 000, `limit` entier 1–50 (défaut 50), sinon 400
  `ANALYTICS_LIST_INVALID` ; `kind=price` sans droit financier → 403
  `PERMISSION_DENIED` avant tout calcul.
- **Droit financier** = `analytics.read` ET `products.view_financials`
  (`canReadFinancials`, accepté). Sans lui : pas de `gain`, pas de
  `priceChecks`, pas de carte « Prix à vérifier », aucun décompte ni prix
  d'achat. Même règle sur `/analytics/overview` (sans `totalInvested`,
  `netProfit`, `avgMargin`) et `/analytics/products/ranking` (sans
  `netProfit`). Propriétaire et administrateur : inchangé.
- **Détails de stock (`products.view_stock_details`)** — règle constatée
  (aucune fuite trouvée, aucune correction nécessaire) :
  - réservés à ce droit (`product-projection.ts`, 1-12H) : stock initial
    (`initialQuantity`) et unités vendues calculées sur le stock
    (`initial − restant`) ;
  - standard pour tout membre : stock restant et statut (`low_stock`,
    `out_of_stock`) ;
  - l'aide à la décision ne renvoie **jamais** `initialQuantity` ; elle
    renvoie le stock restant (standard), les ventes enregistrées sur la
    fenêtre et les estimations qui en découlent (données de ventes, domaine
    `analytics.read`, déjà présentes dans les classements), et le signal
    « Stock faible » (équivalent au statut `low_stock` standard) ;
  - limite préexistante, non introduite ici : `analytics.read` donne déjà le
    total des unités vendues par produit (classement toutes périodes) ; avec
    le stock restant, un stock initial approché peut s'en déduire tant qu'il
    n'y a eu ni réapprovisionnement ni correction.
- **Retrait de droits** : les permissions sont relues en base à chaque
  requête ; vérifié en e2e (droit financier accordé → `gain` présent ;
  retiré → absent à la lecture suivante ; `analytics.read` retiré → 403 sur
  les deux routes) et en navigateur (rechargement → message de refus).
- Pas de nouveau classement individuel des vendeurs, pas de polling, aucun
  appel CamPay, aucune notification ni dépendance ajoutée.

## 6. Temps réel et interface

- Relecture silencieuse via le coordinateur existant sur les signaux ventes
  et produits ; rattrapage à la reconnexion ; ordre des réponses
  (`createResponseOrder`). Section « Détails » : même mécanisme, montée
  seulement ouverte. Les listes paginées repartent de leur première page à
  chaque relecture (composant remonté sur `generatedAt`).
- Couleurs du commerce (`--tenant-accent*`), couleurs d'état réservées et
  toujours accompagnées d'une icône et d'un titre. Focus visible, `label` du
  sélecteur de période, `aria-live` sur la fraîcheur et sur « X affichés sur
  N », listes en `role=region` titrées, tableaux avec en-têtes.
- Libellés regroupés dans `web/src/lib/analytics-labels.ts` (français ;
  forme prête pour l'anglais du lot suivant).

## 7. Validation

### Première passe

| Contrôle | Résultat |
|---|---|
| Unitaires `src/analytics` + `src/reports` | 6 suites, 55/55 |
| E2E `analytics-insights.e2e-spec.ts` | 9/9 (deux corrections de fixture : nom > 20 caractères ; annulation = 204) |
| E2E voisins (export mensuel, isolation multi-tenant, droits produits, Douala) | 44 : 40 OK, 4 ignorés (suite Douala hors fuseau) |
| `isolated api-e2e monthly-boundaries-douala analytics-insights --tz=Africa/Douala` | 13/13 |
| Recette navigateur (pile `recipe.js start`) | 19/20 puis 20/20 (contrôle D10 corrigé : le nom est dans un champ) ; carte mensuelle = export, PDF 422 → Excel, 429/503 lisibles puis récupération |

### Finalisation

| Contrôle | Résultat |
|---|---|
| Unitaires `src/analytics`, `src/reports`, `src/notifications`, `src/push` | 11 suites, **123/123** (dont `insights.spec.ts` 28/28 : + priorité unique, carte de 63 produits, pages contiguës) |
| `isolated api-e2e analytics-insights` | **13/13**, exit 0 |
| `isolated api-e2e monthly-boundaries-douala analytics-insights --tz=Africa/Douala` | **17/17**, exit 0 |
| Nouveaux cas e2e | 63 produits en rupture (noms en double) : carte 63, première page 50 = page 0 de la liste, pages 0/50 et 0/20/40/60 identiques, 63 distincts = tous les produits créés, page vide au-delà, 5 paramètres invalides → 400, isolation ; priorité unique (rupture + perte comptée une fois, carte = liste) ; droits de stock et retrait de droits ; février 28 j / mars 31 j au même rythme : totaux 28 000 / 31 000, +10,7 % du total, 0 % par jour, base zéro sans pourcentage |
| Correction de fixture | « Nouveau savon » (20 restants sur 100) relevait aussi du seuil 80 % : la priorité unique le range dans « Stock faible » ; stock initial porté à 20 pour garder un produit « récent » |
| Scénarios temps réel adaptés, `realtime RT22 RT8` puis `RT28` | **3/3 PASS** (RT8 : ventes 0→1→2, unités 0→2, montant 800, 2 relectures `/analytics/insights`, vendeur 0 requête ; RT22 : ligne du produit purgé dans « Détails », stock « — » ; RT28 : bénéfice toutes périodes « — ») |
| Contrôles navigateur ciblés (pile fraîche, après corrections de libellés) | **9/9** : carte « 63 produits épuisés », « Voir les 63 produits concernés » ouvre et focalise la liste, « 50 affichés sur 63 », « Afficher les 13 suivants » au clavier → 63 lignes distinctes, bouton retiré ; mars/février : « Total du mois : +10,7 % », « Par jour : stable · avant : 1 000 FCFA par jour », durées affichées ; mois en cours inchangé ; membre `analytics.read` seul sur téléphone : aucune réponse `/analytics` avec `initialQuantity`, `purchasePrice` ou `gain`, liste complète, 0 px de débordement ; droit retiré → refus ; 0 erreur console |
| ESLint API (`{src,apps,libs,test}/**/*.ts`, sans `--fix`) | 0 erreur, 2 avertissements préexistants (`test/app.e2e-spec.ts`, `test/e2e/ephemeral-mongodb.ts`, non modifiés) |
| `tsc -p tsconfig.build.json` ; `nest build` ; `tsc -p tsconfig.json` filtré 1-16E | 0 ; réussi ; 0 |
| ESLint web (`npx eslint src`) ; `tsc --noEmit` ; Prettier | 0 ; 0 ; conforme |
| `node --check` de `realtime-scenarios.js` | OK |
| `isolated web-build` | `ok: true`, 0 `.env` dans la copie, archives juridiques vérifiées, copie supprimée |
| `git diff --check` (fichiers nouveaux compris) | aucun problème |

Le premier passage des contrôles ciblés (9/9) a révélé deux défauts de
libellé, corrigés puis revérifiés sur une pile fraîche : « 28 févr.. »
(double point) et « avant : 1 000 FCFA » sans « par jour ». RT8, RT22 et RT28
ont tourné avant cette correction de libellés, qui ne touche pas leurs
assertions.

Non relancés (hors périmètre) : suites API complètes, campagnes de paiement
et d'inscription, RT1–RT33 au complet, campagne 1-16D.

Outillage : Playwright 1.62.1 installé dans un dossier temporaire hors
dépôt, Chromium 1234 ; scripts de contrôle 1-16E temporaires hors dépôt ;
bases MongoDB éphémères uniquement, aucun `.env` réel lu.

Captures (`phase-1-16e-captures/`) : finalisation — `liste-63-produits.png`,
`comparaison-mois-termines.png`, `mobile-liste-sans-droits.png` ; première
passe (antérieures à la pagination, ordre et cartes inchangés) —
`bureau-analyse.png`, `mobile-analyse.png`, `analyse-sans-droit-financier.png`,
`action-ajouter-du-stock.png`, `erreur-pdf-422.png`,
`erreur-503-recuperee.png`.

## 8. Limites

1. Les estimations ignorent les jours où le produit était en rupture, la
   saisonnalité et les délais fournisseurs ; elles l'affichent.
2. Les seuils sont des choix de produit non calibrés sur l'usage réel.
3. Pages par décalage sur une liste recalculée : si des produits changent
   de liste entre deux clics « Afficher les suivants », un produit peut
   être sauté jusqu'à la relecture suivante (les doublons sont, eux,
   écartés). Toute relecture temps réel repart de la première page à jour.
4. Chaque page recalcule toutes les listes de l'organisation (produits
   disponibles, ventes des 28 derniers jours, classement du mois avec le
   droit financier) : coût proportionnel au catalogue, acceptable aux
   tailles actuelles, non mesuré sur un grand catalogue.
5. Priorité unique : un produit en rupture et vendu à perte n'apparaît pas
   dans « Prix à vérifier » tant qu'il est en rupture.
6. Un produit restauré de la corbeille reprend sa date d'ajout initiale.
7. « Ajouter du stock » ouvre la modification dans le catalogue du produit ;
   si le produit a changé de catalogue entre-temps, la page s'ouvre sans la
   fenêtre (aucune erreur).
8. Les libellés de « Détails » restent dans le composant (ceux de l'aide à
   la décision sont centralisés) ; « avant : 1 par jour » pour le nombre de
   ventes reste succinct.
9. Le mois en cours suit le fuseau du processus API (`TZ`, cf. 1-16D,
   toujours non configuré dans Railway).
10. Captures de la première passe antérieures à la pagination.

## 9. Fichiers

Modifiés : `api/src/analytics/analytics.controller.ts`,
`analytics.module.ts`, `analytics.service.ts`, `analytics.service.spec.ts`,
`month-range.ts` ; `api/test/recipe/realtime-scenarios.js` (RT8, RT22, RT28 :
ouverture de « Détails », libellés « Vos ventes ») ;
`web/src/app/app/analytics/page.tsx`, `web/src/app/app/catalog/[id]/page.tsx`,
`web/src/lib/api.ts`.

Nouveaux : `api/src/analytics/insight-thresholds.ts`, `insights.ts`,
`insights.spec.ts` ; `api/test/analytics-insights.e2e-spec.ts` ;
`web/src/components/analytics/insights-sections.tsx`,
`analytics-details.tsx` ; `web/src/lib/analytics-labels.ts` ; ce document et
`phase-1-16e-captures/`.
