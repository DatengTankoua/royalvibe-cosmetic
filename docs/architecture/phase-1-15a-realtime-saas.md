# Phase 1-15A — Audit et correction du temps réel fonctionnel SaaS

Branche : `architecture/phase-1-15a-realtime-saas`, créée depuis
`architecture/phase-1-14d2h-payment-local-recipe` à
**`edee9c164f613ff194780e3cd203453ee1faf221`** (« test(api): add isolated
local subscription payment recipe »), à jour avec `origin`. Au départ :
arbre et index propres ; `stash@{0}` (sauvegarde lint-staged `564a998`)
présent et **non touché**.

Rapports lus : [1-5A](phase-1-5a-socket-organization-rooms.md),
[1-11C.3](phase-1-11c3-offline-sales-ui.md),
[1-12H](phase-1-12h-product-field-permissions.md),
[1-14C.1](phase-1-14c1-subscription-access-api.md),
[1-14C.2](phase-1-14c2-subscription-access-ui.md),
[1-14D.2H](phase-1-14d2h-payment-local-recipe.md).

Aucun commit, push ni déploiement. Aucune base réelle, aucun appel
CamPay, e-mail ou stockage réel : stack isolée D.2H (MongoMemoryReplSet,
simulateurs, copie web sans `.env*`). **Portée sur les `.env`** : aucun
`.env` réel n'a été ouvert, déplacé ou modifié. La recette navigateur et
les validations isolées (§ 7.2) n'ont pu en charger aucun. En revanche, les
validations du premier passage, lancées par les commandes standard dans
`api/` et `web/`, **ont pu charger** `api/.env` et `web/.env.local` (§ 7.1,
7.3) ; elles ont été refaites en configuration isolée. Aucune dépendance
ajoutée, lockfile inchangé. Le fournisseur de production reste
`UnavailablePaymentProvider`, le webhook reste désactivé, la vérification du
paiement reste manuelle : aucun fichier d'abonnement ou de paiement modifié.

---

## 1. Trajet audité

action métier → écriture validée → `EventsGateway.emitToOrganization` →
room `organization:<id>` filtrée par couverture d'abonnement → socket du
shell (`SocketProvider`) → hooks d'écran → relecture via l'API autorisée.

Garanties API constatées (code actuel, inchangées) :

- handshake JWT `{ sub, orgId }`, portée `app` seule, membership et
  organisation actives, abonnement couvert (1-5A, 1-14C.1) ;
- émission uniquement `server.to(room)` par socket, sockets à couverture
  échue exclus (1-14C.1) ;
- `PATCH /organizations/members/:id` (droits, rôle, suspension, révocation)
  et transfert de propriété : `disconnectMember` **après commit** ;
  réinitialisation de mot de passe : sockets antérieurs fermés (1-13B) ;
- ventes : émission après commit et hors session, dans `try/catch` ; aucune
  émission sur rollback ni sur rejeu idempotent (vérifié en navigateur, RT7).

## 2. Matrice (état après correctifs)

Payloads : « standard » = `{ product, status }` sans prix d'achat, stock
initial ni agrégats (1-12H) ; « ids » = `{ _id, productId }`.

| Action                                                            | Événement, payload, moment                                          | Destinataires               | Consommateurs web et écrans                                                                       | Reconnexion / changement de contexte                               | Statut                                                                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Vente créée (en ligne ou outbox)                                  | `sale:created`, ids, après commit, best effort ; rien au rejeu      | room org, couverture valide | cartes (`useProducts`), fiche, **Ventes**, **Analyse** : relecture silencieuse regroupée          | rattrapage à chaque connexion ; pages remontées si contexte change | **complet** (RT1, RT7, RT8 pour Analyse)                                                                              |
| Vente modifiée / supprimée                                        | `sale:updated` / `sale:deleted`, ids, après commit                  | idem                        | idem                                                                                              | idem                                                               | **complet** (RT1)                                                                                                     |
| Produit créé / restauré                                           | `product:created`, standard                                         | idem                        | cartes (fusion + relecture), fiche (restauration), **Analyse**, **Corbeille**                     | idem                                                               | **complet** : cartes (1-12H), Corbeille à la restauration (RT9) ; restauration sur une fiche ouverte : code seulement |
| Produit modifié (prix, nom, stock ajouté)                         | `product:updated`, standard, après `save`                           | idem                        | cartes (fusion standard + relecture pour tous), **fiche** (relecture), Analyse                    | idem                                                               | **complet** (RT1, RT5)                                                                                                |
| Produit à la corbeille                                            | `product:deleted`, id                                               | idem                        | cartes (retrait), **fiche** (« placé dans la corbeille »), Analyse, Corbeille                     | idem                                                               | **complet** pour cartes et fiche (RT1) et Corbeille (RT9) ; Analyse : code seulement                                  |
| Produit supprimé définitivement                                   | aucun                                                               | —                           | —                                                                                                 | relu au prochain chargement                                        | volontairement manuel (limite)                                                                                        |
| Sections (créer, renommer, supprimer, restaurer)                  | aucun (l'API n'émet rien ; écouteurs web `section:*` sans émetteur) | —                           | —                                                                                                 | relu au prochain chargement                                        | **absent** (hors périmètre)                                                                                           |
| Droits, rôle modifiés                                             | aucun événement ; **déconnexion serveur** du membre après commit    | membre visé                 | shell : contexte relu, **pages remontées**, **nouveau socket**                                    | —                                                                  | **complet** (RT3)                                                                                                     |
| Suspension / révocation membership                                | déconnexion serveur ; handshake ensuite refusé                      | membre visé                 | shell : contexte refusé → **écran « accès plus actif »**, pages retirées, ventes locales visibles | —                                                                  | **complet** (RT3)                                                                                                     |
| Organisation / utilisateur changés (logout → login, autre onglet) | —                                                                   | —                           | **session adoptée** dans les autres onglets, état et pages de l'ancienne session abandonnés       | réponses périmées ignorées                                         | **complet** (RT4)                                                                                                     |
| Coupure réseau / perte de transport                               | événements de la coupure **non rejoués** par Socket.IO              | —                           | relecture de rattrapage de chaque écran ouvert à la reconnexion                                   | —                                                                  | **complet** (RT5)                                                                                                     |
| Abonnement expiré en session                                      | déconnexion à l'échéance (1-14C.1) ; aucun événement                | membre                      | contexte relu → écran de blocage (1-14C.2)                                                        | —                                                                  | inchangé (D.2H 18/18)                                                                                                 |
| Paiement d'abonnement, webhook, rapprochement                     | aucun événement temps réel                                          | —                           | « Vérifier le paiement » manuel                                                                   | —                                                                  | **volontairement manuel**, non modifié                                                                                |
| Membres, invitations, image de marque, historique d'abonnement    | aucun                                                               | —                           | rechargement à l'ouverture de la page                                                             | —                                                                  | volontairement manuel / absent                                                                                        |
| Accueil `/app`                                                    | —                                                                   | —                           | aucune donnée métier affichée (1-12B)                                                             | —                                                                  | sans objet                                                                                                            |

Historique d'audit et « Ventes récentes » de la fiche : relus avec la fiche
(scope `own`/`all` appliqué par l'API).

## 3. Pistes anciennes vérifiées

| Piste                                                                  | Constat sur le code actuel                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1-12H : pas de consommateur web pour `sale:created`                    | **Plus d'actualité** pour cartes et fiche (correctif 1-12H, `useSaleInvalidation`) : vérifié en référence (RT1 avance jusqu'à 48 sur les deux). **Toujours vrai** pour Ventes et Analyse → corrigé ici.                                                                                                                                                                                                                                       |
| 1-11C.3 : une mise à jour Socket.IO ne met pas à jour `serverLoadedAt` | Toujours vrai et **conservé volontairement** : une fusion d'événement n'avance jamais `loadedAt`. Le risque de double déduction durable venait de l'absence de relecture serveur après la fusion pour un membre standard : désormais toute diffusion produit déclenche une relecture serveur, seule à faire avancer `loadedAt`. RT1 et RT7 : après confirmation et relecture, « Stock restant » = valeur serveur, jamais « Stock indicatif ». |

## 4. Défauts reproduits avant correction

Campagne `realtime` sur la stack isolée, **web compilé depuis HEAD
`edee9c1`** (les fichiers modifiés ont été mis de côté le temps de la copie
isolée, empreintes SHA-256 vérifiées à la restauration) : **2/7**.

| #   | Scénario                                             | Résultat de référence                                                                                    | Cause                                                                                                                                                                                                                                            |
| --- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | RT1 — vente d'un collègue                            | cartes et fiche OK ; **la liste Ventes ne montre pas la vente** sans rechargement                        | aucune écoute sur `/app/sales` (ni sur Analyse)                                                                                                                                                                                                  |
| D2  | RT3 — retrait de `products.view_financials`          | « CA réel » **reste affiché** (délai dépassé)                                                            | la déconnexion serveur relit le contexte, mais les pages gardent leurs données projetées selon les anciens droits ; **le socket n'est jamais rouvert** (`SocketProvider` ne dépendait que de l'utilisateur, de la version du jeton et du réseau) |
| D3  | RT4b — l'autre onglet se connecte à l'organisation B | l'onglet 1 **garde l'en-tête de A** alors que ses requêtes partent avec le jeton B                       | aucune écoute `storage` du jeton dans `AuthProvider`                                                                                                                                                                                             |
| D4  | RT5 — 2 ventes et un prix modifié pendant la coupure | fiche figée à **40** (attendu 35) après reconnexion                                                      | événements de la coupure perdus, aucune relecture à la reconnexion                                                                                                                                                                               |
| D5  | RT6 — invalidation pendant une relecture retenue     | relecture parallèle (49) puis **réponse retenue périmée (53) appliquée en dernier** ; fiche bloquée à 53 | relectures non sérialisées, aucun ordre des réponses                                                                                                                                                                                             |

Défaut constaté par analyse (non observable sans panne provoquée) :

| #   | Constat                                                                                                                                                                                                                 | Correction                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| D6  | `ProductsService` émettait `product:*` sans `try/catch` : une exception d'émission transformait une création, modification, mise à la corbeille ou restauration **déjà écrite** en erreur 500 (rejouable par le client) | émissions produit en best effort (comme les ventes) ; test unitaire qui échoue sans le correctif |

RT2 (seconde organisation) et RT7 (outbox, rejeu) passaient déjà sur HEAD.

## 5. Corrections

Réutilisation de Socket.IO, des providers et des chargements existants ;
aucun cache, polling permanent ni bus ajouté ; événements inchangés
(minimaux) ; aucun écran ne lit de payload au-delà des identifiants.

**Web**

- `lib/refresh-coordinator.ts` (nouveau) :
  - `createRefreshCoordinator` : demandes rapprochées regroupées dans une
    fenêtre non repoussée (400 ms), relectures **sérialisées** ; une demande
    arrivée pendant une relecture en provoque une autre après elle ;
    aucune minuterie sans demande ;
  - `createResponseOrder` : une réponse n'est appliquée que si aucune
    réponse plus récente ne l'a été (monotone).
- `hooks/use-live-refresh.ts` (nouveau) : `useLiveRefresh` (coordinateur +
  **rattrapage** : à chaque connexion du socket, relecture si la dernière
  lecture réussie a commencé avant ; rien hors ligne) et `useSocketSignals`.
- `contexts/socket-context.tsx` : instant de la dernière connexion
  (`useSocketConnectedAt`, y compris reconnexion automatique) ; prop
  `restartKey`.
- `app/app/layout.tsx` :
  - déconnexion serveur + contexte relu valide → **un** nouveau socket ;
  - contexte refusé (401/403 hors refus commercial) → écran « Ton accès à
    cette organisation n'est plus actif », pages métier retirées, ventes
    locales et déconnexion conservées ;
  - pages **remontées** quand utilisateur, organisation, rôle, permissions
    effectives ou accord de saisie changent ;
  - état de la session précédente effacé et pages non montées tant que le
    contexte de la session courante n'est pas connu ; moteur de
    synchronisation sans contexte pendant cet intervalle.
- `contexts/auth-context.tsx`, `lib/auth.ts` : un changement du jeton ou de
  l'utilisateur dans un **autre onglet** est adopté (nouvelle
  `sessionVersion`) ou, s'il est retiré, la session est quittée.
- `hooks/use-products.ts` : ordre des réponses ; toute diffusion produit ou
  vente concernant la liste → relecture silencieuse regroupée (pour tous les
  membres, plus seulement ceux qui voient les champs étendus).
- `hooks/use-sale-invalidation.ts` : filtre seulement ; le regroupement
  passe par l'appelant (l'ancien minuteur local perdait l'invalidation
  arrivée pendant un chargement).
- Fiche produit : ordre des réponses, `product:updated` / `product:created`
  → relecture, `product:deleted` → « Ce produit a été placé dans la
  corbeille. ».
- Ventes, Analyse, Corbeille : relecture silencieuse sur leurs signaux,
  ordre des réponses, rattrapage.

`serverLoadedAt` : uniquement le début d'une lecture HTTP **réussie et
appliquée** ; jamais avancé par un événement. Outbox, UUID, idempotence,
capacité hors ligne et service worker : inchangés.

**API** — `products.service.ts` : `emitBestEffort` (D6). Aucune autre
modification (rooms, JWT, abonnement, projections, ventes inchangés).

## 6. Recette navigateur

Stack D.2H (`recipe.js start`), Playwright 1.63.0 et Chromium 1234 déjà
présents (aucune installation). Commande :
`node api/test/recipe/recipe.js realtime [RT1..RT9] --playwright=<dir> --chromium=<exe>`
(`api/test/recipe/realtime-scenarios.js`). Chaque utilisateur a son propre
contexte navigateur ; frames Socket.IO capturées ; courses ordonnées par
barrières (`page.route` retenant la première réponse) ; attentes sur effets
observables ; seules des fenêtres bornées (1–1,5 s) prouvent des absences.

| #   | Scénario                                                                                                                                                                                                                                           | Résultat observé (code corrigé)                                                                                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RT1 | Propriétaire vend 2 par l'UI (acheteur, contact) ; vendeur standard sur les cartes, vendeur finances sur la fiche, propriétaire sur Ventes. Puis vente API d'un collègue (3), modification (→1), suppression ; produit +10 et prix 450 ; corbeille | cartes et fiche 50→48→45→47→48→58→retiré ; CA réel 800 ; auteur : « Stock restant 48 » (aucune double déduction) ; Ventes : vente ajoutée puis retirée ; aucun rechargement complet ; frames de vente = exactement `_id, productId`, frames produit sans champ restreint ni acheteur |
| RT2 | Vente dans A, propriétaire de B ouvert                                                                                                                                                                                                             | B : 0 frame métier, 0 relecture, aucun produit de A, stock 20 inchangé                                                                                                                                                                                                               |
| RT3 | Finances retirées puis rendues ; vente entre les deux ; suspension d'un vendeur                                                                                                                                                                    | « CA réel », prix d'achat, coût total absents du DOM sans rechargement ; socket rouvert (fiche 30→28) ; finances revenues ; suspendu : catalogue retiré, 0 frame                                                                                                                     |
| RT4 | (a) relecture de A retenue, déconnexion, connexion B, libération ; (b) second onglet du même navigateur connecté à B                                                                                                                               | (a) aucun produit de A dans B ; (b) onglet 1 : en-tête B adopté, aucun produit ni événement de A ensuite                                                                                                                                                                             |
| RT5 | Deux contextes hors ligne ; 2 ventes et prix 470 pendant la coupure                                                                                                                                                                                | au retour : fiche 35 et prix 470 sans rechargement ; cartes 35                                                                                                                                                                                                                       |
| RT6 | Rafale de 5 ventes ; puis relecture retenue + vente pendant le chargement                                                                                                                                                                          | rafale : 1 relecture ; pendant la barrière : 1 seule requête (sérialisée) ; valeur finale 49, jamais écrasée par la réponse retenue                                                                                                                                                  |
| RT7 | Vente saisie quand `POST /sales` n'atteint pas l'API (méthode D.2H), reprise ; rejeu du même `clientOperationId`                                                                                                                                   | 1 vente serveur, 1 événement, rejeu 200 sans événement ; stock 22 partout ; vendeur « Stock restant 22 »                                                                                                                                                                             |
| RT8 | **Analyse** : propriétaire (`analytics.read`) sur `/app/analytics`, vendeur standard sur la même page ; le vendeur vend 2 puis 1 par l'API                                                                                                         | propriétaire, sans rechargement : Transactions 0→1→2, Unités vendues 0→2, Chiffre d'affaires 800 ; aucune donnée acheteur ; vendeur : « pas la permission », **0 requête `/analytics`**, aucun indicateur                                                                            |
| RT9 | **Corbeille** : propriétaire sur `/app/trash` ; un administrateur met le produit à la corbeille puis le restaure (API)                                                                                                                             | produit affiché dans la corbeille puis retiré après restauration, « Aucun produit dans la corbeille. » de nouveau, sans rechargement                                                                                                                                                 |

| Campagne                                                                                                | Web                        | Résultat                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `realtime` RT1–RT7                                                                                      | HEAD `edee9c1` (référence) | **2/7** (RT2, RT7) — défauts D1 à D5                                                                                                                                                                  |
| `realtime` RT1–RT7                                                                                      | corrigé                    | **premier passage 6/7, puis deux passages 7/7**. Le premier échec venait de l'assertion du test (elle attendait 200, `DELETE /sales` répond 204) ; l'assertion a été corrigée, le code applicatif non |
| `realtime` RT8, RT9                                                                                     | corrigé                    | 2/2 dès le premier passage : **aucun défaut reproduit**, donc aucune correction ajoutée. Non rejoués sur HEAD                                                                                         |
| `realtime` RT1–RT9 (après ajout de RT8, RT9)                                                            | corrigé                    | **9/9, deux passages consécutifs**                                                                                                                                                                    |
| `scenarios` D.2H (paiement, outbox, session limitée, changement d'organisation, webhook, rapprochement) | corrigé                    | **18/18**, deux fois (avant et après la modification de `env-guard.cjs`)                                                                                                                              |

Ajustements d'outillage pendant la mise au point (aucune assertion
affaiblie) : la barrière retenait toutes les requêtes et bloquait l'écran
suivant (ne retient plus que la première) ; RT7 utilisait l'émulation hors
ligne de Playwright, où la saisie répondait « Stockage local indisponible »
— remplacée par la méthode du scénario 11 D.2H ; message d'échec évalué
paresseusement.

## 7. Validations et isolement des `.env`

### 7.1 Portée de l'isolement

- **Recette navigateur** (stack D.2H, campagnes `realtime` et `scenarios`) :
  isolée dès le départ (environnement construit, garde préchargée, copie
  web sans `.env*`, répertoire de travail vide pour l'API).
- **Validations du dépôt du premier passage** (§ 7.3) : lancées par les
  commandes standard dans `api/` et `web/`. **Elles ont pu charger les
  `.env` réels** : `ConfigModule.forRoot()` lit `api/.env` du répertoire
  courant (tests e2e qui démarrent `AppModule`), et `next build` charge
  `web/.env.local` et les autres `.env*` de production. Aucun de ces
  fichiers n'a été ouvert ni affiché par moi ; la protection anti-27017
  des e2e ne démontre **pas** cet isolement.
- **Validations isolées** (§ 7.2) : tout a été relancé ensuite sans aucun
  `.env` réel chargeable. Ce sont elles qui font foi.

### 7.2 Validations isolées (nouvelles)

Outil : `api/test/recipe/isolated-checks.js`, via
`node api/test/recipe/recipe.js isolated selftest|api-unit|api-e2e|web-build`.
Il réutilise les protections D.2H :

- **environnement construit** (`baseEnv` : liste blanche système, aucune
  variable applicative héritée) ;
- **garde** `env-guard.cjs` préchargée par `NODE_OPTIONS` dans chaque
  processus JavaScript, **workers Jest compris** ; toute ouverture,
  lecture ou `stat` d'un `.env*` échoue comme un fichier absent, et la
  tentative est seulement **nommée** dans un journal ;
- **build Next dans la copie isolée** (`web-copy.js`), qui écarte les
  `.env*` sur leur nom sans les ouvrir : seule protection valable aussi pour
  le lecteur dotenv natif de Turbopack (D.2H § 3).

Aucun `.env` réel n'est lu, déplacé ni modifié. Côté `api/`, ses `.env`
ne sont visés que par des tentatives bloquées.

**Exception ajoutée à la garde** (`RECIPE_ENV_GUARD_ALLOW_PREFIXES`, absente
par défaut, posée seulement pour `isolated api-e2e`). La suite e2e D.2G
`payment-reconciliation-cli-process` écrit **ses propres `.env` factices**
dans `%TEMP%\reconcile-cli-14d2g-*` (témoin de l'incident D.2G). Sous la
garde seule, son nettoyage `rmSync` ne voyait plus ces fichiers :
`ENOENT`/`ENOTEMPTY` en `afterAll`, suite marquée en échec alors que ses
tests passaient (premier passage isolé : 23/24 suites, 563/563 tests).
C'est l'artefact déjà décrit en D.2H (§ 4.5, défaut 5). L'exception ne
couvre que ce préfixe temporaire, et un préfixe situé sous le dépôt est
refusé. Le dossier factice laissé par ce premier passage a été supprimé.

| Contrôle                                                                                                                                                                                                                                                                                                                              | Résultat                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isolated selftest` : 4 `.env` factices (`.env`, `.env.local`, `.env.test`, `.env.development`) contenant un canari, 3 sondes Jest sur **2 workers**, chacune appelant `ConfigModule.forRoot({})` (comme `AppModule`), `dotenv.config()` et une lecture directe ; **configuration gardée identique aux e2e**, exception D.2G comprise | **pass** : avec la garde, 0 canari sur les 3 voies (2 workers) ; **témoin sans garde : canari lu par les 3 voies** ; 6 tentatives bloquées journalisées ; relancé après le formatage final : pass                     |
| `env-guard-selftest` (D.2H, garde par défaut, après modification de `env-guard.cjs`)                                                                                                                                                                                                                                                  | pass : `@next/env`, `dotenv`, `@nestjs/config` ne lisent rien avec la garde, lisent tout sans (témoin)                                                                                                                |
| `web-canary-check` (D.2H : vrais `next build` et `next start` avec 5 `.env*` canaris)                                                                                                                                                                                                                                                 | pass : **T1 témoin sans protection applique les canaris** (« Environments: .env.production.local, .env.local, .env.production, .env ») ; T2, T3, T4 n'appliquent rien                                                 |
| `isolated api-unit`                                                                                                                                                                                                                                                                                                                   | **69/69 suites, 1338/1338** ; journal : **0 tentative** (aucun test unitaire n'appelle `ConfigModule.forRoot`)                                                                                                        |
| `isolated api-e2e`                                                                                                                                                                                                                                                                                                                    | **24/24 suites, 563/563** ; journal : `existsSync api\.env` **bloqué 23 fois** (jamais lu), aucune autre tentative                                                                                                    |
| `isolated web-build`                                                                                                                                                                                                                                                                                                                  | compilé, 26 pages ; 3 `.env*` de `web/` écartés par leur nom, 0 dans la copie ; tentatives `statSync` des 4 noms de production **dans la copie** (fichiers absents) ; aucune ligne « Environments » ; copie supprimée |

### 7.3 Validations du premier passage (non isolées, conservées pour l'historique)

| Commande                     | Résultat                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter api test`     | 69/69 suites, 1338/1338                                                                                             |
| `pnpm --filter api test:e2e` | 1ʳᵉ exécution : 23/24 suites, 562/563 ; 2ᵉ : 24/24, 563/563                                                         |
| `pnpm --filter web build`    | OK, 26 pages ; a remplacé `web/.next` (ignoré par Git), qui contenait jusque-là le build de recette signalé en D.2H |

**Échec `email-verification` (1ʳᵉ exécution e2e non isolée)** : un test de
`test/email-verification.e2e-spec.ts` (« 7. Échecs Resend… HTTP 422 :
compte créé une fois, non vérifié, renvoi ultérieur possible ») a échoué
une fois. Il **n'a pas été reproduit** : la suite seule (21/21), la seconde
exécution complète et l'exécution isolée (24/24) passent. **Cause inconnue**
(le détail de l'assertion n'a pas été conservé) ; **aucun lien identifié**
avec le correctif, qui ne touche côté API que l'émission des événements
produit.

### 7.4 Autres contrôles (après les derniers changements)

| Commande                                                                      | Résultat                                                                                          |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `pnpm --filter web test:coordinator`                                          | **6/6** (§ 7.5)                                                                                   |
| `pnpm --filter api exec eslint "{src,apps,libs,test}/**/*.ts"` (sans `--fix`) | 0 erreur, 2 avertissements préexistants (`test/app.e2e-spec.ts`, `test/e2e/ephemeral-mongodb.ts`) |
| `web : npx eslint .` (sans `--fix`) / `npx tsc --noEmit`                      | 0 / 0                                                                                             |
| `pnpm --filter api build`                                                     | OK                                                                                                |
| `npx jest src/products/products.service.spec.ts`                              | 37/37 (test D6 compris)                                                                           |
| `npx prettier --check` sur tous les fichiers modifiés ou nouveaux             | OK (fins de ligne LF)                                                                             |
| `node --check` des scripts de recette                                         | OK                                                                                                |

### 7.5 Tests du coordinateur (dans le dépôt)

`web/scripts/test-refresh-coordinator.mjs`, lancé par
`pnpm --filter web test:coordinator` (script ajouté à `web/package.json` ;
aucune dépendance, lockfile inchangé). Runner `node:test`, **horloge
simulée** (`mock.timers`, aucune attente réelle), module transpilé en
mémoire par le TypeScript déjà installé.

1. **Regroupement** : 10 demandes → aucune relecture à 399 ms, une à 400 ms,
   aucune ensuite.
2. **Fenêtre non repoussée** : une demande toutes les 100 ms pendant 1 s
   donne au moins 2 relectures (une fenêtre repoussée n'en donnerait
   aucune).
3. **Sérialisation** : demandes pendant une relecture retenue → aucune
   relecture parallèle, exactement une relecture supplémentaire après,
   jamais plus d'une active.
4. **Récupération après erreur** : une relecture en échec n'empêche pas la
   suivante.
5. **Destruction** : rien après `dispose`, ni demande en attente ni
   nouvelle.
6. **Ordre des réponses** : réponse périmée refusée, réponse plus ancienne
   arrivée la première acceptée.

## 8. Fichiers

| Fichier                                                                                                                  | Changement                                                                   |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `web/src/lib/refresh-coordinator.ts`                                                                                     | **Nouveau** : regroupement sérialisé, ordre des réponses                     |
| `web/src/hooks/use-live-refresh.ts`                                                                                      | **Nouveau** : relecture regroupée, rattrapage, signaux                       |
| `web/src/contexts/socket-context.tsx`                                                                                    | Instant de connexion, `restartKey`                                           |
| `web/src/app/app/layout.tsx`                                                                                             | Socket rouvert, écran de refus, remontage, session courante                  |
| `web/src/contexts/auth-context.tsx`, `web/src/lib/auth.ts`                                                               | Session d'un autre onglet adoptée                                            |
| `web/src/hooks/use-products.ts`, `web/src/hooks/use-sale-invalidation.ts`, `web/src/hooks/use-trash.ts`                  | Relectures regroupées, ordre, rattrapage                                     |
| `web/src/app/app/catalog/products/[id]/page.tsx`, `web/src/app/app/sales/page.tsx`, `web/src/app/app/analytics/page.tsx` | Écoutes, ordre, rattrapage                                                   |
| `web/scripts/test-refresh-coordinator.mjs`                                                                               | **Nouveau** : 6 tests déterministes du coordinateur                          |
| `web/package.json`                                                                                                       | Script `test:coordinator` (aucune dépendance)                                |
| `api/src/products/products.service.ts`, `.spec.ts`                                                                       | Émissions produit best effort + test                                         |
| `api/test/recipe/realtime-scenarios.js`                                                                                  | **Nouveau** : campagne RT1–RT9                                               |
| `api/test/recipe/isolated-checks.js`                                                                                     | **Nouveau** : validations isolées des `.env` réels, auto-test Jest           |
| `api/test/recipe/env-guard.cjs`                                                                                          | Exception optionnelle `RECIPE_ENV_GUARD_ALLOW_PREFIXES` (absente par défaut) |
| `api/test/recipe/recipe.js`                                                                                              | Commandes `realtime` et `isolated`                                           |
| `docs/architecture/phase-1-15a-realtime-saas.md`                                                                         | Ce document                                                                  |

Inchangés : schémas, DTO, migrations, gateway, middleware Socket.IO,
ventes, abonnements, paiements, outbox, service worker, lockfile, `.env`
(ni lus, ni déplacés, ni modifiés).

## 9. Limites restantes

- **Sections** : aucune diffusion (l'API n'émet rien ; les écouteurs web
  `section:*` n'ont pas d'émetteur). Relues à l'ouverture seulement.
- **Mono-instance** : rooms, registre des sockets et filtre de couverture
  restent en mémoire du processus (1-7C, 1-14C.1) ; un déploiement
  horizontal exigerait un adaptateur partagé.
- **Suppression définitive** d'un produit, **membres, invitations, image de
  marque, abonnement et paiements** : relus à l'ouverture seulement ;
  paiement vérifié manuellement (inchangé).
- **RT8 et RT9** prouvent le comportement corrigé mais n'ont pas été rejoués
  sur HEAD : leur capacité à détecter l'ancienne absence d'écoute repose sur
  l'audit du code (aucune écoute sur Analyse ni Corbeille avant 1-15A).
- **Remontage sur changement de droits** : un dialogue ouvert est fermé ; la
  saisie en cours est perdue (rare, et l'API l'aurait revalidée).
- **Refus de contexte persistant dans la session** : après un 401/403 du
  contexte, l'écran de refus reste affiché jusqu'à un contexte valide
  (rechargement ou reconnexion), y compris en cas de panne réseau ensuite.
- **Rattrapage** : une relecture par écran ouvert à chaque reconnexion ; au
  premier chargement d'une page, une relecture supplémentaire si le socket
  se connecte après la requête initiale.
- **Isolement des unitaires API** : la garde y était active (même
  environnement que l'auto-test), mais aucune tentative n'a été observée
  pendant l'exécution réelle, faute d'appel à `ConfigModule.forRoot`.
- **Exception D.2G** : sous `isolated api-e2e`, la suite D.2G lit ses
  propres `.env` factices de `%TEMP%\reconcile-cli-14d2g-*`, comme hors
  garde ; aucun autre dossier n'est concerné.
- **Saisie sous émulation hors ligne Playwright** : « Stockage local
  indisponible » observé (non investigué, hors temps réel ; même famille
  d'artefacts qu'en 1-11C.3).
- **Environnement** : la machine manquait de mémoire (premier build Next en
  erreur Windows 1450, puis un dossier de travail disparu pendant un
  démarrage interrompu). Avec l'accord de l'utilisateur, deux exécutions
  jest e2e bloquées depuis la veille (et leurs `mongod` éphémères) ont été
  arrêtées ; la stack de développement locale (27018) et Docker n'ont pas
  été touchés. Une stack est aussi tombée sur la limite de 30 min des
  tâches de fond de l'outil ; nettoyage refait à chaque fois (copie isolée,
  état, ports vérifiés).
