# Phase 1-16A.1 — Centre de notifications, alertes commerciales et invitations PWA

Branche : `architecture/phase-1-16a-web-push-notifications` (inchangée), HEAD
**`d4bf3c364e92ea3a5681d077e441168a20ec7a3e`**, au-dessus du lot
[1-16A](phase-1-16a-web-push-notifications.md) **non commité**, conservé et
étendu. Au départ : index vide, `stash@{0}` (lint-staged `564a998`) présent et
**non touché** ; index restitué vide à la fin.

Aucun commit, push, déploiement ni activation. Aucun appel CamPay, aucune
nouvelle plateforme push, aucune dépendance ajoutée (lockfile inchangé depuis
1-16A). Aucun `.env` réel lu ou modifié : suites par `recipe.js isolated`,
campagne navigateur sur la stack de recette éphémère, transport push simulé,
horloge `PUSH_CLOCK` contrôlée.

---

## 1. Architecture

```
écriture métier (transaction)          dispatcher (processus HTTP, 5 s)
  vente / correction / paiement   ──►  push_jobs  ──►  notifications      (1 par utilisateur, centre)
  balayages : échéances, bilans        (événement)  └─►  push_deliveries   (1 par appareil, si push actif)
```

- **Événement** (`push_jobs`, clé `eventKey` unique) : enregistré dans la
  MÊME session que l'écriture métier, ou par un balayage serveur.
- **Notification logique** (`notifications`, nouveau) : un utilisateur, une
  organisation, un événement (unique `{eventKey, userId}`). État lu / non lu
  partagé entre tous ses appareils. Existe même si le push est désactivé,
  refusé ou sans appareil.
- **Livraison push** (`push_deliveries`) : par appareil, inchangée sauf le
  regroupement des ventes (§4).

Nouveau module `notifications` (module de base : `PushRuntime`, `PUSH_CLOCK`,
centre, signaux, bilans ; n'importe que `AnalyticsModule`). `PushModule`
l'importe ; `EventsModule` aussi (signal privé). Aucun cycle.

**Activation** (`PushRuntime`) :

| Contexte | Événements, centre, rappels, bilans | Push |
| --- | --- | --- |
| Démarrage HTTP, `WEB_PUSH_ENABLED=false` | **oui** (`activateCenter`) | non |
| Démarrage HTTP, `WEB_PUSH_ENABLED=true` | oui | oui |
| CLI, migrations, simulation, backfill, tests chargeant `AppModule` | **non** | non |

`startWebPush` devient `startNotifications` (seul appelant : `main.ts`,
vérifié par test statique). Aucun fournisseur n'implémente `OnModuleInit` /
`OnApplicationBootstrap`.

## 2. Règles métier

### 2.1 Catégories et droits (règle unique `canAccessCategory`)

| Catégorie | Déclencheur | Destinataires et lecteurs (droits ACTUELS) |
| --- | --- | --- |
| `stock-depleted` | stock positif → 0 | `products.view_stock_details` |
| `stock-low` | franchissement de 80 % consommé | `products.view_stock_details` |
| `sale-created` | création de vente validée | propriétaire ou administrateur avec `sales.view_all` |
| `subscription-ending` | échéance effective < 24 h | propriétaire réel |
| `payment-succeeded` | période attribuée + `succeeded` | propriétaire réel |
| `monthly-report` | bilan du mois écoulé | `analytics.read` |

La même règle sert à la répartition, avant chaque envoi push, et à **chaque
lecture** du centre (liste, compteur, ouverture, « tout lire », invendus) :
une permission retirée, une rétrogradation ou un transfert de propriété
masquent immédiatement les anciennes notifications (404 à l'ouverture, aucun
détail calculé), sans les supprimer. Les routes du centre gardent le contrôle
commercial par défaut (JWT applicatif, abonnement actif) : rien en session
limitée.

### 2.2 Seuil de 80 %

- `consommé = initialQuantity − remainingQuantity` ; atteint si
  `5 × consommé ≥ 4 × initialQuantity` (comparaison entière exacte, aucun
  pourcentage arrondi) : 100 initiales → alerte à 20 restantes, pas à 21.
  Quantité initiale ≤ 0 ou non finie : jamais.
- Franchissement = non atteint avant ET atteint après, avec les valeurs de la
  **même écriture** : `decrementStock` (`$inc` atomique 1-15E, valeur avant =
  après + quantité) et `adjustStock` (correction de quantité, même session,
  renvoie désormais initial / avant / après).
- Une opération qui atteint zéro n'émet **que** la rupture.
- Réarmement naturel : réapprovisionnement (`$inc` initial et restant),
  correction à la baisse ou annulation font repasser sous le seuil ; le
  franchissement suivant est un nouvel événement (clé de l'écriture
  déclenchante).
- À la répartition : produit purgé / corbeillé → annulé ; épuisé entre-temps
  → annulé (`depleted`, la rupture prend le relais) ; repassé sous le seuil →
  `restocked` ; franchissement plus récent → `superseded`.

### 2.3 Nouvelle vente

Événement `sale-created:<vente>` dans la transaction de `createFresh`, après
l'audit : aucun après rollback, aucun au rejeu idempotent (pas de
transaction), un seul après reprise du callback. Correction et annulation ne
créent pas de « nouvelle vente » ; une vente annulée avant la répartition
n'est pas notifiée (`sale-cancelled`). Détail lu à l'ouverture (vente
courante, nom de produit courant ou historique, vendeur enregistré) ; aucun
prix d'achat.

### 2.4 Bilan mensuel

- Balayage toutes les 5 min : **mois civil précédent seulement**, bornes de
  `AnalyticsService.monthMatch` (`new Date(année, mois, 1)`, fuseau du
  processus API, fin exclue), organisations actives créées avant la fin du
  mois. Unique `{organizationId, period}` ; événement
  `monthly-report:<org>:<AAAA-MM>` ; reprise après redémarrage ou crash.
  Aucun mois plus ancien n'est généré (pas de rafale à l'activation) ; une
  activation en cours de mois génère le bilan du mois précédent.
- Contenu calculé par `AnalyticsService.getProductsRanking` /
  `getSellersRanking` (mêmes règles) :
  - top 5 par quantité nette (ventes existantes, quantité corrigée,
    annulations exclues), **ex æquo du 5e rang inclus**, groupés par
    identifiant, nom courant puis nom historique 1-15D (produit purgé
    signalé) ;
  - vendeur du mois : chiffre d'affaires net maximal par `sellerId`
    enregistré (jamais l'auteur d'une correction), **tous les ex æquo** ;
    aucun sans vente ;
  - produits sans vente : produits encore présents (actifs ou en corbeille)
    créés avant la fin du mois et non corbeillés avant son début ; « ajouté
    pendant le mois » signalé ; liste paginée.
- Affiche période, fuseau et date de calcul. Aucun coût, prix d'achat,
  bénéfice ni marge (ni calculé, ni stocké).

### 2.5 Lecture et expiration

- Liste et compteur ne marquent rien. `readAt` est fixé à la **première**
  ouverture (`POST …/:id/open`), lecture (`…/:id/read`) ou « tout marquer
  comme lu » (visibles seulement) ; filtre `readAt: null`, donc `expiresAt`
  jamais repoussé.
- Rétention après lecture (centralisée, `notification-retention.ts`) :

  | Catégorie | Après lecture |
  | --- | --- |
  | Nouvelle vente | 48 h |
  | Seuil 80 %, bilan mensuel | 7 jours |
  | Rupture, échéance, paiement | 30 jours |

- Expirées exclues dès la lecture API ; nettoyage par index TTL
  `expiresAt_1_ttl` (0 s). Non lues : jamais supprimées. Supprimer une
  notification ne touche ni vente, ni paiement, ni audit, ni bilan.

### 2.6 Préférences

- Centre (nouveau, `notification_preferences`, par utilisateur et
  organisation, tous appareils) : catégorie coupée → plus créée et masquée.
- Push (par appareil) : 6 catégories ; clés absentes d'un ancien document =
  actives. Les deux consentements sont indépendants.

### 2.7 Temps réel

Signal privé `notifications:changed` (`{}`) via `emitToMember` (room de
l'organisation, couverture valide, utilisateur désigné) : création, lecture,
« tout lire », préférences. Le web relit compteur et liste par l'API via le
coordinateur 1-15A (`useLiveRefresh` : regroupement, rattrapage à la
reconnexion), sans polling ; réponses ignorées si le jeton a changé ou si une
réponse plus récente a été appliquée ; cloche remontée par clé de session et
d'organisation.

## 3. Push : compléments

- **Regroupement des ventes** : fenêtre FIXE d'une minute alignée ; un
  événement interne `sale-digest:<org>:<début>` par fenêtre, une livraison par
  appareil envoyée à la fin de la fenêtre, texte « De nouvelles ventes ont été
  enregistrées. », tag `sale-digest:<org>` (remplace l'affichage précédent).
  Chaque vente garde sa notification individuelle dans le centre.
- Délais de pertinence push : rupture et seuil 6 h, vente 1 h, paiement 1 h,
  bilan 12 h, échéance jusqu'à l'échéance. Au-delà, la notification du centre
  est créée quand même (`outcome: push-expired`).
- **Complément 1-16A — rappel encore pertinent** : un appareil activé ou une
  préférence réactivée après la création du rappel le reçoit tant que
  l'échéance effective est future et inchangée (rattrapage à chaque passe,
  une seule livraison par appareil) ; la notification du centre manquante est
  créée de même (nouveau propriétaire après transfert compris).
- Textes : « Le stock d'un produit est presque épuisé. », « Nouvelle vente
  enregistrée. », « Votre bilan mensuel est disponible. ».

**Clarification (après déconnexion)** :
- *Aucune notification métier* : après une déconnexion en ligne, l'appareil
  est supprimé côté serveur et désabonné dans le navigateur : **plus aucun
  push n'est envoyé**, rien ne s'affiche.
- *Notification neutre* : seulement si un push arrive encore (déconnexion
  hors ligne, retrait serveur échoué, compte changé sur un appareil partagé).
  Les navigateurs imposant un affichage, le service worker montre « Stock
  Master — Notifications désactivées sur cet appareil. », sans aucun contenu
  métier, et désabonne le navigateur ; le serveur désactive l'appareil au
  premier 404/410.

## 4. Interface

- **Cloche** dans l'en-tête, immédiatement avant le nom (session applicative,
  contexte courant, hors blocage commercial) : badge rouge, `99+` au-delà de
  99, `aria-label` « Notifications, N non lues » / « plus de 99 »,
  `aria-expanded`, Échap et clic extérieur ferment. Panneau : 5 récentes
  (non lues marquées, texte « (non lue) » pour lecteurs d'écran), lien
  « Voir toutes les notifications ».
- **Centre** `/app/notifications` : Toutes / Non lues, « Afficher plus »
  (curseur), « Tout marquer comme lu ». **Détail** `/app/notifications/[id]` :
  ouverture = lecture explicite ; vue par catégorie (stock, vente, échéance,
  paiement, bilan avec invendus paginés) ; bouton vers l'écran concerné.
- **Réglages** Organisation → Notifications : « Dans l'application »
  (préférences du centre) puis « Notifications push sur cet appareil »
  (inchangé, 6 catégories).
- **Invitations** (`EngagementPrompt`, après chargement du contexte) :
  - une seule invitation : installation si proposée (`beforeinstallprompt`)
    ou aide iPhone/iPad (Safari, hors mode autonome), sinon activation push si
    navigateur ET serveur le permettent et l'appareil n'est pas abonné ;
    permission refusée → aide aux réglages, jamais de `requestPermission` ;
  - modal au plus **une fois par 24 h et par appareil**
    (`localStorage`), uniquement sur l'accueil `/app`, en ligne, sans autre
    dialogue ouvert ni champ en saisie ; sinon bannière discrète ;
    « Plus tard » masque la bannière pour la session ;
  - permission native demandée seulement au clic sur « Activer » ;
  - installation détectée par mode autonome, `appinstalled`, ou acceptation
    de l'invite native (mémorisée) ; aucune détection garantie ailleurs
    (Firefox, Safari macOS : aucune invitation d'installation) ;
  - aucune modification du hors ligne, du service worker ni de l'outbox.

## 5. Routes ajoutées

`GET /notifications`, `GET /notifications/unread-count`,
`GET|PUT /notifications/preferences`, `POST /notifications/read-all`,
`POST /notifications/:id/open`, `POST /notifications/:id/read`,
`GET /notifications/:id/report/unsold`. Toutes **métier** (aucune exception
commerciale), testées dans la matrice des routes. Champs inconnus refusés.

## 6. Migrations et configuration

- Même migration, étendue : `pnpm --filter api migrate:push-notification-indexes`
  crée aussi `notifications` (unique `eventKey_1_userId_1`, liste, compteur,
  **TTL `expiresAt_1_ttl`**), `notification_preferences` (unique) et
  `monthly_reports` (unique `{organizationId, period}`). Idempotente, aucun
  autre TTL toléré.
- **Changement de prérequis** : le centre étant toujours actif, la
  vérification des index a lieu en **production même avec
  `WEB_PUSH_ENABLED=false`** (et partout dès que le push est activé) : la
  migration doit précéder le déploiement. Documenté dans `api/.env.example` et
  `api/README.md`.
- Aucune variable nouvelle. Aucune migration de données (les appareils 1-16A
  sans les nouvelles clés de préférence les reçoivent actives par défaut).

## 7. Validation (résultats exacts)

| Commande | Résultat |
| --- | --- |
| `isolated api-unit` ciblé (push, notifications, matrice, ventes, produits, events, analytics) | 22/22 suites, 411/411 |
| `isolated api-e2e web-push-notifications notification-center` | **2/2, 22/22** |
| Mutation : filtre des catégories autorisées retiré du centre | tests 6 et 10 **échouent** (fichier restauré) |
| `isolated api-unit` complet | **76/76 suites, 1453/1453** |
| `isolated api-e2e` complet | **29/29 suites, 612/612** ; garde : 28 `existsSync api/.env` bloqués |
| `isolated web-build` | exit 0 ; 0 `.env*` dans la copie ; routes `/app/notifications`, `/app/notifications/[id]` |
| `recipe.js push-browser` (stack éphémère, Playwright 1.59.1 hors dépôt, Chromium 1234) | **9/9** (P1–P9, une seule passe) |
| `eslint` sans `--fix` (fichiers API touchés ; `web/src`) | 0 problème |
| `tsc` build API, `tsc` web | 0 erreur |
| `tsc -p tsconfig.json` API (specs) | 238 diagnostics, liste par fichier/code **identique** à la référence 1-16A (aucun nouveau) |
| `git diff --check` | aucun problème |

La suite 1-16A a été adaptée au nouveau modèle (ses appareils coupent les
catégories ajoutées ; catégories par rôle ; `push-expired` au lieu
d'`expired` pour un événement trop ancien ; preuve CLI étendue aux
collections du centre et des bilans).

E2E `notification-center` (vrais sockets) :

| # | Preuve |
| --- | --- |
| 1 | TTL `expiresAt` 0 s, unicités du centre et des bilans |
| 2 | Push désactivé : vente → propriétaire et administrateur (2 appareils du propriétaire signalés), vendeur avec `sales.view_all` et organisation B rien ; aucune livraison ; liste/compteur sans effet ; ouverture → lu partout, signal à l'autre appareil, détail sans coût ; `expiresAt = readAt + 48 h`, seconde ouverture sans effet ; expirée exclue (404) ; non lue conservée ; vente intacte ; notification d'autrui 404 |
| 3 | Rollback → aucun événement ; rejeu idempotent → 1 ; correction et annulation → 0 nouvelle vente ; vente annulée avant la passe → `sale-cancelled` |
| 4 | 21 restants : rien ; 20 : une alerte ; 19 : rien ; propriétaire et vendeur autorisé, pas le vendeur standard ; annulations → réarmé ; correction refranchissant → nouvelle alerte ; réapprovisionnement → `restocked` puis nouveau franchissement ; rupture directe → rupture seule ; initiale nulle → rien |
| 5 | 3 ventes concurrentes autour du seuil → stock 1, **exactement 1** alerte |
| 6 | Rétrogradation → tout masqué (liste, compteur, 404) sans suppression ; permission de stock rendue → seuil seul ; préférence du centre coupée → masquée, non créée ; « tout lire » limité aux visibles ; champ inconnu 400 |
| 7 | Push actif : 3 ventes → 3 notifications, 1 push à la fin de la fenêtre, fenêtre suivante → second push |
| 8 | Rappel : appareil activé avec préférence coupée → rien ; préférence réactivée → 1 envoi, pas de doublon ; après l'échéance → plus de rattrapage |
| 9 | Bilan : mois précédent seul, idempotent ; propriétaire et vendeur `analytics.read`, pas vendeur standard ; 4 ventes ; top Café 6 / Thé 6 (correction) / Produit purgé 2 ; vente annulée exclue ; vente hors mois ignorée ; vendeur du mois Bea (correction par le propriétaire attribuée à Bea) puis Ali + Bea à égalité ; invendus Invendu / Nouveau (ajouté pendant le mois) / Sucre, produit futur exclu, pagination ; aucun champ de coût ; rétention 7 j ; mois sans vente : aucun vendeur ni classement |
| 10 | Transfert de propriété : rappel masqué pour l'ancien propriétaire, créé pour le nouveau |

Campagne navigateur (P1–P6 de 1-16A rejoués, modal neutralisé ; nouveaux) :

| # | Résultat observé |
| --- | --- |
| P7 | Cloche avant le nom ; vente → badge « 1 » sur le second appareil et liste du premier mises à jour sans rechargement ; ouvrir la cloche ne lit rien ; lecture sur le premier appareil → badge effacé sur le second ; 0 écriture et outbox inchangée sur le second ; 120 non lues → « 99+ », libellé « plus de 99 » ; « Tout marquer comme lu » → badge effacé |
| P8 | Modal à l'accueil après connexion, 0 `requestPermission` ; « Plus tard » → bannière masquée ; pas de second modal sous 24 h ; écran Ventes : bannière, jamais de modal ; nouvel onglet : bannière seule ; 25 h plus tard : modal, « Activer » → 1 demande, appareil enregistré ; ensuite plus aucune invitation |
| P9 | Permission refusée : bannière d'aide aux réglages, aucun bouton Activer, aucun modal, 0 `requestPermission` ; `beforeinstallprompt` → invitation d'installation, « Installer » → invite native, installation mémorisée, invitation retirée ; `appinstalled` → invitation retirée |

## 8. Limites

- Mono-instance ; latence ≤ 5 s (centre), bilans et rappels à 5 min près.
- Fuseau des bilans = fuseau du processus API (comme les analyses) ; à
  vérifier sur l'hébergement (souvent UTC).
- Produits purgés sans vente du mois : impossibles à lister ; vendeurs dont
  l'utilisateur a été supprimé : exclus par la jointure des analyses.
- `adjustStock` (correction de vente) reste une lecture-écriture en session
  transactionnelle (existant, non modifié) ; les conflits concurrents sont
  rejoués par le driver.
- Détection d'installation imparfaite hors Chromium ; aucune invitation
  d'installation sur Firefox / Safari macOS.
- Seuil : un produit dont le stock initial est faible déclenche l'alerte
  tôt en unités (règle du modèle, voulue).
- Livraison push « au moins une fois » ; appareils réels **non vérifiés**
  (procédure : rapport 1-16A §7, avec en plus la cloche, une vente, un
  franchissement de seuil et le bilan du début de mois).

## 9. Fichiers

Nouveaux : `api/src/notifications/**` (module, contrôleur, DTO, centre,
signaux, bilans, rétention, 3 schémas, `notification-rules.spec.ts`),
`api/src/push/stock-thresholds.ts` (+ spec),
`api/test/notification-center.e2e-spec.ts`,
`web/src/app/app/notifications/page.tsx`,
`web/src/app/app/notifications/[id]/page.tsx`,
`web/src/components/notifications/{notification-bell,center-preferences,engagement-prompt}.tsx`,
`web/src/lib/notifications.ts`, `web/src/lib/pwa-install.ts`, ce rapport.

Modifiés (en plus des fichiers 1-16A) : `api/src/analytics/analytics.module.ts`
(export), `api/src/events/{events.gateway,events.module}.ts`,
`api/src/products/products.service.ts`, `api/src/sales/sales.service.ts`,
`api/src/push/*` (catégories, runtime, outbox, dispatcher, messages, index,
bootstrap, abonnements, schémas), `api/src/main.ts`,
`api/src/subscriptions/subscription-access-routes.spec.ts`,
`api/test/web-push-notifications.e2e-spec.ts`,
`api/test/recipe/{push-browser.js,recipe.js}`, `api/.env.example`,
`api/README.md`, `web/src/app/app/layout.tsx`,
`web/src/app/app/organization/notifications/page.tsx`,
`web/src/components/layout/pwa-register.tsx`,
`web/src/lib/push-notifications.ts`.
