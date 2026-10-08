# Phase 1-16A — Notifications Web Push métier

Branche : `architecture/phase-1-16a-web-push-notifications`, créée depuis
`architecture/phase-1-15f-realtime-subscription-payments` à
**`d4bf3c364e92ea3a5681d077e441168a20ec7a3e`** (« fix: synchronize
subscription and payment views in real time »). Au départ : arbre et index
propres ; `stash@{0}` (sauvegarde lint-staged `564a998`) présent et **non
touché**. Index restitué vide à la fin.

Aucun commit, push, déploiement ni activation en production. Aucun appel
CamPay, aucune activation du fournisseur ni du webhook (fichiers inchangés).
Aucun `.env` réel lu, déplacé ou modifié : suites API et build web par
`recipe.js isolated`, campagne navigateur sur la stack de recette éphémère.
Aucun service push réel contacté.

---

## 1. État initial constaté

| Sujet | Constat |
| --- | --- |
| Service worker | `web/public/sw.js` (1-11A/B), scope `/`, cache `stockmaster-v3`, deny-by-default, **aucun** gestionnaire `push` / `notificationclick` |
| Identité locale | `stockmaster-offline-identity` (IndexedDB) : `userId`, `organizationId`, empreinte du jeton ; écrit après `/auth/context`, effacé à la déconnexion (`purgeAllOfflineData`) |
| Stock → 0 | Uniquement par les ventes, en transaction : `decrementStock` (création) et `adjustStock` (modification de quantité). La modification de produit n'ajoute que du stock (`$inc` positif) |
| Paiement confirmé | `finalize` → `runInGrantTransaction` (callback rejouable) → `grantAndMarkSucceededInSession` |
| Échéance | Calculée à la lecture (`computeSubscriptionState`, `coverageEndsAt`) ; aucun cron |
| CLI | `subscription:reconcile-payment` charge `AppModule` (`createApplicationContext`) ; migrations par `createConnection` |
| Index | Convention `autoIndex: false` + migration explicite + vérification exacte |
| Dépendances | Aucune bibliothèque push |

## 2. Changements

### 2.1 Dépendance

`web-push@3.6.7` (dépendance API) et `@types/web-push@3.6.4` (dev), versions
exactes ; `pnpm-lock.yaml` +54 lignes. Aucun Firebase, OneSignal, Webpushr ni
Redis.

### 2.2 API — module `push` (feuille, aucun cycle)

| Fichier | Rôle |
| --- | --- |
| `push-config.ts` | `resolveWebPushConfig` : désactivé par défaut ; `WEB_PUSH_ENABLED=true` exige trois valeurs VAPID valides (paire cohérente vérifiée, sujet `mailto:`/`https:`), sinon `WebPushConfigError` sans aucune valeur de clé dans le message |
| `push-endpoint-policy.ts` | Endpoints HTTPS, port par défaut, sans identifiants : `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `web.push.apple.com`, `*.push.apple.com`, `*.notify.windows.com`. IP, hôtes arbitraires/privés, `http:` refusés. Clés : `p256dh` 65 octets (point non compressé), `auth` 16 octets, base64url strict ; endpoint ≤ 2048 |
| `schemas/*` | `push_subscriptions` (appareil ↔ utilisateur + organisation, préférences, `authVersion`), `push_jobs` (outbox, `eventKey` unique), `push_deliveries` (unique `{jobId, subscriptionId}`) |
| `push-indexes.ts` + migration `create-push-notification-indexes.ts` | 8 index, création explicite idempotente, aucun TTL ; vérifiés à l'activation |
| `push-runtime.ts` | État d'activation **inactif par défaut** ; `PUSH_CLOCK` injectable |
| `push-outbox.service.ts` | Enregistrement d'un travail **dans la session de la transaction métier** (`$setOnInsert` sur `eventKey`) ; aucune écriture si inactif |
| `push-dispatcher.service.ts` | Balayage des échéances, répartition, revalidation, envoi, reprises ; `start()` uniquement depuis `main.ts` |
| `push-transport.ts` | `WebPushTransport` (`aes128gcm`, VAPID, `TTL`, `Topic`, délai socket 10 s + délai global 15 s) ; endpoint revérifié avant chaque requête |
| `push-messages.ts` | Textes génériques, lien interne, `tag` stable, titulaire `aud` |
| `push-subscriptions.service.ts`, `push.controller.ts`, DTO | Routes authentifiées de gestion |
| `push-bootstrap.ts` | `startWebPush` : index vérifiés, runtime activé, dispatcher démarré |

Points d'enregistrement (même session, avant commit) :

| Événement | Endroit | Clé |
| --- | --- | --- |
| Stock épuisé (création de vente) | `SalesService.createFresh`, si `quantity > 0` et stock après décrément = 0 | `stock-depleted:<produit>:sale:<id pré-généré>` |
| Stock épuisé (quantité de vente augmentée) | `SalesService.update`, `delta < 0` et stock restant = 0 | `stock-depleted:<produit>:sale-update:<id d'opération>` |
| Paiement confirmé | callback de `finalize`, **après** attribution et passage à `succeeded` | `payment-succeeded:<paiement>` |
| Échéance | balayage serveur (toutes les 5 min) | `subscription-ending:<organisation>:<échéance ms>` |

`adjustStock` renvoie désormais le stock restant (`undefined` si produit
absent, comme avant). `PushOutboxService` est injecté en `@Optional()` dans
`SalesService` et `SubscriptionPaymentsService` (specs unitaires inchangées).
Le rapprochement CLI n'enregistre rien (runtime inactif hors HTTP), comme il
n'émet aucun signal socket depuis 1-15F.

### 2.3 Routes (`/notifications/push`)

| Route | Accès |
| --- | --- |
| `GET config` | membre actif, JWT applicatif, abonnement actif → `{enabled, publicKey, categories}` (catégories du rôle courant) |
| `POST subscription` | idem ; 503 `PUSH_DISABLED` si inactif, 400 `PUSH_SUBSCRIPTION_INVALID` |
| `POST subscription/status`, `PATCH subscription` | idem ; appareil d'un autre titulaire indistinguable d'un absent |
| `POST subscription/remove` | exception `identity` (session limitée, abonnement expiré) ; supprime seulement l'appareil de l'utilisateur courant ; 204 silencieux |

Utilisateur, organisation, rôle et permissions : contexte serveur. Aucune
réponse ne contient d'endpoint ni de clé. 10 appareils actifs au plus par
membre et organisation (le plus ancien passe `disabled/replaced`). La
matrice des routes (`subscription-access-routes.spec.ts`) intègre le
contrôleur et la nouvelle exception, testée explicitement.

### 2.4 Destinataires et revalidation

Répartition puis **revalidation avant chaque envoi** (premier et reprises) :

- pertinence : produit présent, non corbeillé, toujours à 0 et dernier
  épuisement connu (`superseded` sinon) ; paiement `succeeded` avec période ;
  échéance effective inchangée et future ; organisation active ; délai de
  pertinence (stock 6 h, paiement 1 h, échéance jusqu'à l'échéance) ;
- appareil : actif, même titulaire qu'à la répartition (réattribution
  écartée), préférence active, **activé avant l'événement** (aucune rafale
  d'anciens événements à l'activation) ;
- personne : utilisateur présent, même version de session (sinon appareil
  `disabled/session-revoked`), membership active ; stock épuisé →
  `products.view_stock_details` (propriétaire, administrateur, ou vendeur
  autorisé) ; échéance et paiement → **propriétaire actif réel**.

Une suspension, un retrait de droit ou un transfert de propriété écarte donc
les anciens destinataires même pour une reprise.

### 2.5 Fiabilité

- Envoi uniquement par le dispatcher, après commit ; rollback → aucun
  travail ; rejeu de vente idempotente ou reprise du callback par le driver →
  un seul travail (upsert sur clé stable dans la même session).
- `404/410` → appareil `disabled/gone`, livraison `failed`. `429`, `5xx`,
  panne réseau, délai, transport qui rejette → reprise à 30 s, 2 min, 10 min,
  30 min ; 5 tentatives au plus. Autres `4xx` → échec définitif.
- Livraison en cours verrouillée 60 s (`sending`), reprise après crash :
  « au moins une fois », jamais promis « exactement une fois » ; `tag` et
  en-tête `Topic` stables limitent les doublons visibles.
- Rappels persistants en base : reprise après redémarrage, aucune minuterie
  navigateur.
- Une panne push n'affecte jamais une réponse HTTP de vente ou de paiement.
- Journaux : identifiant de livraison et statut seulement.
- Mono-instance : boucle `setTimeout` non chevauchante (5 s), `unref`,
  arrêtée à `onApplicationShutdown`.

### 2.6 CLI et chargement d'`AppModule`

Aucun fournisseur push n'implémente `OnModuleInit`/`OnApplicationBootstrap` ;
`PushRuntime` reste inactif tant que `main.ts` n'appelle pas
`startWebPush`. Charger `AppModule` (CLI, simulation, migrations, backfill,
tests) ne démarre aucun dispatcher, n'écrit aucun travail et n'envoie rien,
même avec `WEB_PUSH_*` présents dans l'environnement (test e2e 12 ; garde
statique dans `push-messages.spec.ts` : seul `main.ts` active).

### 2.7 Web

- `web/public/sw.js` : gestionnaires `push` et `notificationclick` ajoutés au
  worker existant (scope, `CACHE_VERSION`, stratégies fetch inchangés ; aucun
  second worker). Aucune requête réseau dans ces gestionnaires.
  - Contrôle local avant affichage : `aud` du message comparé au pointeur
    d'identité hors ligne, ouvert **sans création** (mise à niveau annulée si
    la base n'existe pas). Sans identité ou autre compte : notification
    neutre « Notifications désactivées sur cet appareil. » et désabonnement
    local.
  - Clic : chemin `/app…` filtré ; fenêtre existante → message
    `stockmaster:push-navigate` et navigation **client** (`router.push`, sans
    rechargement) par `PushNavigationBridge` (layout racine) ; sinon
    `openWindow`. Les droits restent contrôlés par la page.
- `lib/push-notifications.ts` : support (dont iPhone/iPad hors écran
  d'accueil), permission, abonnement via le worker existant, préférences,
  désactivation, `releasePushOnLogout`.
- Onglet **Organisation → Notifications** (tout membre actif) : « Activer
  les notifications » (seule demande de permission), cases par catégorie
  disponible (mise à jour optimiste, rétablie en cas d'échec), « Désactiver
  les notifications », états : fonctionnalité désactivée, navigateur
  incompatible, iPhone/iPad à installer, permission refusée, aucune
  catégorie pour le rôle ; aide d'installation iPhone/iPad.
- Déconnexion (`auth-context`) : retrait serveur avec le jeton sortant
  (client HTTP brut, 2 s), puis désabonnement local, borné à 3 s, avant la
  purge existante.

**Déconnexion hors ligne, reprise** : le désabonnement local et l'effacement
de l'identité suffisent à empêcher tout affichage métier ; l'appareil reste
actif côté serveur jusqu'au premier `404/410` du service push, qui le
désactive. Si le désabonnement local échoue, le premier message reçu sans
identité correspondante désabonne le navigateur. Limite connue : la purge
manuelle « Données hors connexion » efface aussi l'identité ; un message
reçu avant la relecture suivante du contexte désabonne l'appareil, qu'il
faut réactiver.

## 3. Migrations

Une seule, nouvelle et idempotente :
`pnpm --filter api migrate:push-notification-indexes` (prérequis de
`WEB_PUSH_ENABLED=true` ; sinon le démarrage HTTP échoue avec cette
commande). Aucune migration de données. Pas de nouvel index sur
`subscription_periods` : le balayage filtre `endsAt` sans index dédié
(collection petite, une passe par 5 min).

## 4. Configuration

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `WEB_PUSH_ENABLED` | `false` | `true` active ; toute autre valeur est une erreur |
| `WEB_PUSH_VAPID_PUBLIC_KEY` | — | clé publique P-256 base64url, stable |
| `WEB_PUSH_VAPID_PRIVATE_KEY` | — | secret, jamais journalisé |
| `WEB_PUSH_VAPID_SUBJECT` | — | `mailto:` ou `https:` |

Documenté dans `api/.env.example` (modèle versionné) et `api/README.md`.
Génération : `npx web-push generate-vapid-keys` depuis `api/`. Aucune
variable web supplémentaire (clé publique servie par `GET config`).

## 5. Validation (commandes et résultats exacts)

| Commande | Résultat |
| --- | --- |
| `recipe.js isolated api-unit` (complet) | **74/74 suites, 1428/1428** |
| `recipe.js isolated api-e2e web-push-notifications` | **12/12** |
| Mutation : upsert de l'outbox sans `session` | tests 5 et 9 **échouent** (fichier restauré, diff vide) |
| `recipe.js isolated api-e2e` (13 suites communes : ventes, stock, purge, paiements, rapprochement, webhook, temps réel, accès) | **13/13, 233/233** |
| `recipe.js isolated api-e2e` (complet, AppModule modifié) | **28/28, 602/602** ; garde : 27 `existsSync api/.env` bloqués, aucune lecture |
| `recipe.js isolated web-build` | exit 0, 3 `.env*` écartés par nom, 0 dans la copie, route `/app/organization/notifications` générée |
| `recipe.js push-browser` (stack éphémère, Playwright 1.59.1 hors dépôt, Chromium 1234) | **6/6** |
| `eslint` sans `--fix` (fichiers API touchés, `web/src`) | 0 problème |
| `tsc -p tsconfig.build.json` (API), `tsc` (web) | 0 erreur |
| `tsc -p tsconfig.json` (API, specs comprises) | 238 diagnostics, tous dans des specs préexistantes ; HEAD extrait : 239 (même liste par fichier et code, + 1 import non résolu propre à l'extraction) → **aucun nouveau diagnostic** |
| `git diff --check` (nouveaux fichiers inclus) | aucun problème |

E2E `web-push-notifications` (MongoMemoryReplSet, faux transport, horloge
`PUSH_CLOCK` contrôlée, dispatcher jamais démarré, passes explicites) :

| # | Preuve |
| --- | --- |
| 1 | Désactivé : `config` fermé, 503, aucun travail, dispatcher non démarré |
| 2 | 401 sans jeton ; catégories par rôle ; endpoints/clés invalides et champ `organizationId` refusés ; appareil invisible et non modifiable par un autre membre ; préférences ; retrait |
| 3 | Stock 3→2 : rien ; 2→0 : un travail, aucun envoi avant la passe ; propriétaire, administrateur et vendeur autorisé reçoivent, vendeur sans droit non ; organisation B isolée ; pas de doublon ; réapprovisionnement puis épuisement → nouvelle alerte |
| 4 | Réapprovisionné ou purgé avant la passe → `cancelled` (`restocked`, `product-removed`) |
| 5 | Rollback (audit en échec dans la transaction) → 500, stock intact, aucun travail ; rejeu idempotent → 1 travail ; reprise réelle du callback par le driver (`TransientTransactionError`) → 1 travail |
| 6 | Préférence coupée, droit retiré, membre suspendu, session révoquée (appareil désactivé), appareil partagé réattribué à un autre compte/organisation : aucun envoi ; droit retiré entre une panne et la reprise → `skipped` |
| 7 | 410/404 → désactivé et plus visé ; reprises bornées (30 s, 2 min…, 5 tentatives) ; appareil activé après l'événement : rien ; événement > 6 h : `expired` |
| 8 | Transport qui rejette : passe sans exception, reprise programmée, vente 201 |
| 9 | Paiement : rien pour `pending` ; rollback forcé → aucun travail ; succès → un travail, rejeu sans second ; propriétaire seul, admin rien ; texte sans chiffre ni devise |
| 10 | Transfert de propriété avant la passe : ancien propriétaire rien, nouveau reçoit ; organisation suspendue : `organization-inactive` |
| 11 | Rappel : rien à 25 h, un rappel à 23 h (texte d'essai, TTL borné), propriétaire seul ; balayages répétés et état mémoire perdu : pas de doublon ; renouvellement avant la passe → `renewed` ; échéance dépassée → `expired` |
| 12 | `createApplicationContext(AppModule)` avec `WEB_PUSH_*` : runtime inactif, dispatcher arrêté, aucune écriture (transaction CLI), aucun envoi |

Campagne navigateur `push-browser` (abonnement navigateur fictif, transport
simulé consigné dans `push.jsonl`, livraison au vrai worker par DevTools
`ServiceWorker.deliverPushMessage`) :

| # | Résultat observé |
| --- | --- |
| P1 | 0 demande de permission au chargement et au rechargement ; 1 demande et 1 abonnement au clic ; appareil enregistré au bon titulaire ; 3 catégories (propriétaire) ; préférence enregistrée et relue |
| P2 | Notification affichée par le worker existant (titre, texte générique, lien interne) ; 0 requête vente/auth/paiement/socket ; outbox identique |
| P3 | Liens externes, `//`, `..`, `null` → `/app` ; clic → `/app/sales` sans rechargement ; 0 écriture |
| P4 | 1 enregistrement, scope `/`, `/sw.js`, cache `stockmaster-v3`, document hors ligne toujours précaché |
| P5 | Déconnexion : 1 retrait serveur, appareil supprimé, désabonnement navigateur ; message ultérieur : notification neutre, aucun contenu métier |
| P6 | Déconnexion hors ligne : désabonnement local ; appareil encore actif côté serveur (reprise documentée) ; message ultérieur neutre |

Deux défauts trouvés par la campagne et corrigés : case à cocher non
optimiste (P1) ; `focus()` refusé hors activation interrompait le clic (P3).
Les deux premiers passages de P6 ont buté sur la limite de connexions de la
recette ; la campagne redémarre désormais l'API avant chaque scénario.

Aucune répétition systématique RT1–RT33 ni D.2H : comportements temps réel et
paiements couverts par les suites e2e communes ci-dessus.

## 6. Limites

- Mono-instance : dispatcher dans le processus HTTP ; plusieurs instances
  dupliqueraient le balayage (clés uniques) mais pas la coordination des
  envois.
- Latence : jusqu'à ~5 s (boucle), rappels à 5 min près.
- Paiement confirmé par CLI de rapprochement : pas de notification.
- Livraison réseau au moins une fois, jamais garantie exactement une fois.
- Firefox, Edge, Safari macOS : endpoints autorisés mais **non vérifiés** sur
  appareil.
- Aucune livraison réelle effectuée dans ce lot (§7).

## 7. Recette réelle (à faire — **non vérifié**)

Aucun appareil ni environnement HTTPS n'était disponible : Android et
iPhone/PWA **non vérifiés**.

1. Environnement de test HTTPS (pas la production), une instance API.
2. `npx web-push generate-vapid-keys` ; renseigner les quatre variables dans
   la configuration de **cet** environnement ; exécuter la migration ;
   démarrer : le journal affiche « Notifications push activées ».
3. Compte de test explicite : un propriétaire et un vendeur avec
   `products.view_stock_details`, sur une organisation de test.
4. **Android (Chrome)** : se connecter, Organisation → Notifications →
   Activer ; écran verrouillé ; vendre la dernière unité d'un produit de
   test : notification générique « Un produit est en rupture de stock. » ;
   toucher → page produit après déverrouillage.
5. **iPhone/iPad (iOS/iPadOS ≥ 16.4)** : Safari → Partager → « Sur l'écran
   d'accueil » ; ouvrir depuis l'icône ; activer ; refaire l'épuisement.
6. Rappel : placer la fin d'essai d'une organisation de test à < 24 h
   (écriture explicite sur la base de test), attendre ≤ 5 min.
7. Paiement confirmé : seulement quand l'accès CamPay Live sera traité par le
   lot dédié.
8. Déconnexion, puis nouvel épuisement : aucune notification sur l'appareil.
9. Consigner pour chaque appareil : modèle, version, navigateur, délai
   observé, statut des livraisons (`push_deliveries`).

## 8. Fichiers

Modifiés : `api/.env.example`, `api/README.md`, `api/package.json`,
`api/src/app.module.ts`, `api/src/main.ts`,
`api/src/products/products.service.ts`, `api/src/sales/sales.module.ts`,
`api/src/sales/sales.service.ts`,
`api/src/subscriptions/payments/subscription-payments.service.ts`,
`api/src/subscriptions/subscription-access-routes.spec.ts`,
`api/src/subscriptions/subscriptions.module.ts`,
`api/test/recipe/{README.md,boot-api.js,launcher.js,recipe.js}`,
`pnpm-lock.yaml`, `web/public/sw.js`,
`web/src/app/app/organization/layout.tsx`, `web/src/app/layout.tsx`,
`web/src/contexts/auth-context.tsx`.

Nouveaux : `api/src/push/**` (20 fichiers dont 3 specs),
`api/src/migrations/create-push-notification-indexes.ts`,
`api/test/web-push-notifications.e2e-spec.ts`,
`api/test/recipe/push-browser.js`,
`web/src/app/app/organization/notifications/page.tsx`,
`web/src/components/layout/push-navigation-bridge.tsx`,
`web/src/lib/push-notifications.ts`, ce rapport.

Sources : [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API),
[web-push](https://github.com/web-push-libs/web-push),
[WebKit — Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).
