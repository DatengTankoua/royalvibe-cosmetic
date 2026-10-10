# Lot 1-20A — Tests de charge et de surcharge : référence locale

État : **campagne exécutée localement**, non commitée, sur
`perf/phase-1-20a-load-baseline` (créée depuis
`feature/phase-1-19a-member-activity-notifications`, `cdcffaf`, identique à
`origin/main` et contenant 1-19A). `stash@{0}` est conservé. Aucun commit,
push ni déploiement.

**Aucun trafic vers la production** : ni Railway, ni Vercel, ni MongoDB
réel, ni Cloudflare, ni Resend, ni stockage, ni service push réels. Cible
HTTP et Socket.IO refusée si elle n'est pas `127.0.0.1:4300` ; base refusée
si elle n'est pas l'instance éphémère `stockmaster_load`.

Aucun code applicatif n'a été modifié : seuls des outils de test ont été
ajoutés (`api/test/load/`). Les chiffres sont une **référence sans
optimisation**.

## 1. Synthèse

| Question | Réponse mesurée |
|---|---|
| Premier point de saturation | **Le dispatcher de notifications**, vers **7 à 8 événements/s** (ventes et activités, toutes entreprises confondues), quelle que soit la charge HTTP. Au-delà, l'attente croît sans borne. |
| Premier seuil HTTP | **Le catalogue** (`GET /products`) : un cœur saturé dès **6 VU (≈ 24 req/s)**, débit non tenu à 10 VU. Tableau de bord : **5 VU (≈ 17 req/s)**. |
| Scénario mixte réaliste | Tient à **25 VU (≈ 36 req/s)**, premier seuil à **50 VU (≈ 49 req/s)**. |
| Profil volumineux | Seuil franchi **dès 1 VU** : boucle événementielle bloquée par les listes non paginées. |
| Erreurs | 3 réponses inattendues sur 66 038 requêtes k6 (49 paliers), toutes aux paliers déjà saturés. Aucune 5xx journalisée. |
| Intégrité | **Tous les invariants tenus** sur les 4 stacks, y compris sous concurrence pendant la charge. |
| Reprise | Latences revenues au niveau de repos après le pic ; travaux vidés (71 s après un pic court, ≈ 35 min après la surcharge des actions de produits). |

Ces chiffres sont **locaux** : ils ne garantissent ni une capacité Railway
ou Vercel, ni un nombre de clients commerciaux (§ 10).

## 2. Environnement

### Matériel et partage

| Élément | Valeur |
|---|---|
| Machine | AMD Ryzen 7 5800HS, 8 cœurs / 16 threads logiques, 15,4 Go de RAM |
| Système | Windows 11 Famille 10.0.26200 |
| Partage | **Machine partagée** : VS Code, Chrome et services en cours. Mémoire disponible **≈ 400 à 700 Mo** pendant toute la campagne (validation : `GlobalMemoryStatusEx` et `FreePhysicalMemory` concordent), mémoire engagée 54 Go sur 63 Go. |
| Générateur | **Même machine** que l'API et MongoDB. k6 n'a jamais dépassé 0,09 cœur (moyenne par palier) : il n'a pas été le facteur limitant. |
| Docker | Non utilisé (Docker Desktop renvoyait des erreurs 500) : MongoDB tourne en processus local. |

### Versions

| Composant | Version |
|---|---|
| Node.js | 22.17.1 |
| NestJS | 11.1.28 |
| Mongoose / pilote MongoDB | 9.9.0 / 7.5.0 |
| MongoDB (binaire `mongodb-memory-server` 11.2.0) | 8.2.6, replica set à 1 membre, WiredTiger |
| Socket.IO serveur / client | 4.8.3 / 4.8.3 |
| AWS SDK S3 et `s3-request-presigner` | 3.1100.0 |
| Grafana k6 | **v2.3.0** (binaire officiel Windows, SHA-256 vérifié contre `k6-v2.3.0-checksums.txt`, hors dépôt) |

### Processus et bornes

| Processus | Rôle | Borne |
|---|---|---|
| `load-api.js` (1 processus Node) | API compilée (`dist/`) | tas V8 `--max-old-space-size=1024` |
| `mongod` (1 processus) | replica set éphémère, 127.0.0.1, port aléatoire | cache WiredTiger 0,5 Go |
| `load-stack.js` | lanceur, stockage S3 simulé, échantillonneurs | — |
| `k6` | générateur HTTP | durées 20 à 180 s, 1 à 75 VU |
| `realtime-probe.js` | sockets Socket.IO | ≤ 200 sockets |

Aucune borne CPU n'a pu être imposée (pas de conteneur) : l'API est de toute
façon **mono-thread** pour le JavaScript ; elle a plafonné vers 1,0 à
1,3 cœur (thread principal + ramasse-miettes et pool libuv).

### Fidélité à la production

- **API compilée** avec la séquence de `main.ts` : fuseau `Africa/Douala`,
  CORS strict, trust proxy, validations de démarrage, `ValidationPipe`,
  filtre, centre de notifications, traitement de fond à l'intervalle de
  production (**5 s**), reprise du stockage.
- **Index réels** : les 9 migrations de pré-déploiement (`PREDEPLOY_MIGRATIONS`)
  + les index déclarés des schémas `autoIndex` (comme Mongoose en
  production). `autoIndex` n'est **pas** neutralisé (contrairement à
  `recipe/boot-api.js`).
- **Transactions** : replica set réel.
- **Inchangés** : authentification JWT, gardes d'organisation, de
  permissions et d'abonnement, contrôle d'origine Socket.IO, limitation de
  débit.
- **Simulés uniquement** : e-mails (fichier), stockage objet (simulateur S3
  local : la signature des URL reste celle du SDK réel), transport push
  (politique d'endpoint de production appliquée, puis consignation).
- **Écart assumé** : le module est construit par `Test.createTestingModule`
  (pour remplacer l'expéditeur d'e-mails), comme la recette existante.

## 3. Données (hypothèses de test)

Jeu **déterministe** (PRNG à graine fixe). Les volumes sont des
**hypothèses**, pas des statistiques réelles de Stock Master.

| Profil | Entreprises | Utilisateurs (propr. / admin / vendeurs) | Produits | Ventes (historique) | Notifications |
|---|---|---|---|---|---|
| `current` | 5 standard + 1 concentrée | 40 (6 / 7 / 27) | 1 068 | 23 000 sur 90 j | 4 800 |
| `large` | 10 standard + 1 concentrée | 83 (11 / 12 / 60) | 7 533 | 110 000 sur 180 j | 26 000 |

- Entreprise standard (`current`) : 1 propriétaire, 1 admin, 3 vendeurs,
  8 rayons, 150 produits, 3 000 ventes. Concentrée : 2 admins,
  12 vendeurs, 300 produits, 8 000 ventes. En `large` : 600 / 1 500
  produits, 8 000 / 30 000 ventes.
- Comptes créés par les **services réels** (inscription, vérification,
  invitation, création de compte). Catalogue, ventes et notifications
  insérés par les modèles réels (validation Mongoose), stock cohérent
  (`initial = restant + Σ ventes`). Chaque produit référence une photo du
  stockage courant (URL signée à chaque lecture, comme en production).
- **Sessions préparées avant les mesures** (`AuthService.login`, une par
  utilisateur) : le login n'est jamais mesuré par requête.
- 13 appareils push fictifs (propriétaires et admins), enregistrés par la
  route réelle.

## 4. Méthode

### Outils (`api/test/load/`)

| Outil | Usage |
|---|---|
| `load-stack.js` | stack isolée, échantillonneurs (MongoDB `serverStatus` et travaux toutes les 2 s, CPU/RAM des processus API, mongod et k6, mémoire libre) |
| `k6/stockmaster.js` | parcours HTTP (k6) |
| `run-campaign.js` | un `k6 run` par palier, agrégation, **critères d'arrêt** |
| `realtime-probe.js` | Socket.IO, mesuré **à part** |
| `concurrency.js`, `integrity.js` | intégrité |
| `notification-delays.js` | délais du dispatcher, lus en base |
| `profile-summary.js`, `render-results.js` | diagnostic, tableaux |

**Temps réel.** Le serveur utilise Socket.IO (Engine.IO + protocole
Socket.IO) : un WebSocket k6 brut ne reproduit pas ce client. La sonde
utilise `socket.io-client` 4.8.3 (transport `websocket`, comme le web) et
envoie l'en-tête `Origin` autorisé, comme un navigateur : sans lui, le
contrôle `allowRequest` du serveur refuse la connexion (400), ce qui est
voulu.

### Parcours

| Scénario | Requêtes | Rôles |
|---|---|---|
| `catalog` | `GET /sections`, `GET /products`, `GET /products?sectionId=`, `GET /products/:id` | tous |
| `dashboard` | `GET /analytics/overview`, `/monthly`, `/insights`, `GET /sales` | propriétaires, admins |
| `sales` | `POST /sales` (avec `clientOperationId`, comme le web), annulation 10 % | vendeurs |
| `products` | `PATCH /products/:id` (prix, réassort) ; 30 % : corbeille puis restauration de 3 produits **en parallèle** (comme `use-trash.ts`) | admins |
| `notifications` | liste (20), compteur, marquage comme lu | propriétaires, admins |
| `mixed` | selon le rôle, pauses de 1 à 4 s entre actions | composition des entreprises (≈ 70 % vendeurs) |

**Recherche et pagination du catalogue : il n'y en a pas côté serveur.**
`GET /products` renvoie tout le catalogue (filtre `sectionId` seul) ; la
recherche est faite dans le navigateur. `GET /sales` n'est pas paginé non
plus. Les parcours mesurent donc ce que le web appelle réellement.

### Débit offert et obtenu

Hors scénario mixte, chaque VU vise **1 itération/s** (rythme fixe) :
débit offert = VU it/s ; débit obtenu = itérations réalisées / durée. Une
itération en retard réduit le débit obtenu. En mixte, les pauses rendent le
débit offert non défini : seul l'obtenu est donné.

Distinctions : **utilisateurs virtuels** (VU k6) ; **connexions ouvertes**
(sockets, sonde) ; **débit demandé** (it/s offertes) ; **débit traité**
(req/s et it/s obtenues). Plusieurs VU peuvent partager une session (onglets
d'un même utilisateur).

### Progression et critères d'arrêt (fixés avant exécution)

Très faible charge (1 VU, 20 s), puis paliers **5, 10, 25, 50 VU** de 45 s
(60 s en mixte), affinés (2-3-4, 6-7-8) quand le premier palier franchit
déjà un seuil. Charge stable de 180 s, pic court de 30 s, retour à 5 VU.

Critères (`STOP` dans `run-campaign.js`) ; le premier franchi arrête la
progression :

| Critère | Seuil |
|---|---|
| Erreurs inattendues | > 1 % des requêtes |
| Latence d'une route (n ≥ 20) | p95 > 1 500 ms ou p99 > 3 000 ms |
| Débit | obtenu < 90 % de l'offert |
| Mémoire API | tas > 80 % de 1 024 Mo |
| Mémoire machine | libre < 250 Mo |
| Boucle événementielle | médiane des p99 par seconde > 250 ms |
| MongoDB | latence moyenne lecture ou écriture > 50 ms ; attente du pool p99 > 200 ms |
| Générateur | k6 > 4 cœurs (mesure suspecte) |
| Incohérence métier | arrêt immédiat |

Réponses classées : **erreurs inattendues** (5xx, réseau, délai > 10 s,
4xx non prévu), **refus métier** (stock insuffisant, conflit d'idempotence),
**429** comptés à part.

## 5. Mesures

Légende : VU = utilisateurs virtuels ; it/s = itérations par seconde ;
« Boucle » = médiane des p99 par seconde du retard de la boucle
événementielle. **Le plancher de cette mesure est ≈ 16 ms sous Windows**
(granularité des minuteurs), même au repos. « Travaux » = travaux de
notification en attente (maximum) et ancienneté du plus ancien. Tableaux
complets par route : fichiers de résultats (§ 11).

### 5.1 Très faible charge (1 VU, 20 s, profil `current`)

| Parcours | Route la plus lente (n, p50 / p95 / p99 ms) | API cœurs | Boucle (ms) |
|---|---|---|---|
| catalogue | `products_list` (20, 80 / 132 / 203) | 0,23 | 21 |
| tableau de bord | `sales_history` (20, 200 / 324 / 346) | 0,32 | 71 |
| vente | `sales_create` (20, 70 / 95 / 98) | 0,05 | 17 |
| produits | `product_update` (20, 69 / 110 / 110) | 0,05 | 17 |
| notifications | `notifications_read` (20, 49 / 81 / 81) ; liste 12, compteur 12 | 0,05 | 17 |

### 5.2 Paliers par parcours (profil `current`, plusieurs entreprises)

| Palier | VU | it/s offert → obtenu | req/s | Route la plus lente (n, p50/p95/p99 ms) | Inattendues / refus / 429 | API cœurs | Boucle (ms) | mongod cœurs | Mongo L / É (ms) | Travaux (âge s) | Seuil |
|---|---|---|---|---|---|---|---|---|---|---|---|
| catalogue | 5 | 5 → 5 | 20 | products_list (225, 215/410/492) | 0/0/0 | 0,62 | 76 | 0,23 | 1,7 / 4,6 | 0 | non |
| catalogue | 6 | 6 → 6 | 24 | products_list (270, 263/467/520) | 0/0/0 | **1,00** | 170 | 0,43 | 1,6 / 2,9 | — | non |
| catalogue | 8 | 8 → 8 | 32 | products_list (360, 344/584/639) | 0/0/0 | 1,20 | 238 | 0,57 | 1,9 / 3,0 | — | non |
| catalogue | 10 | 10 → **8,73** | 34,9 | products_list (393, 289/731/982) | 0/0/0 | 1,12 | 182 | 0,51 | 2,0 / — | 0 | **débit** (+ mémoire machine 238 Mo) |
| tableau de bord | 2 | 2 → 2 | 8 | sales_history (90, 340/404/432) | 0/0/0 | 0,55 | 102 | 0,38 | 5,2 / — | 0 | non |
| tableau de bord | 4 | 4 → 4 | 16 | sales_history (180, 513/740/779) | 0/0/0 | 1,17 | 163 | 1,00 | 7,1 / — | 0 | non |
| tableau de bord | 5 | 5 → **4,31** | 17,2 | sales_history (194, 642/897/1052) | 0/0/0 | 1,24 | 209 | 1,06 | 7,8 / — | 0 | **débit** |
| vente | 5 | 5 → 5 | 5,4 | sales_create (225, —/95/—) | 0/0/0 | 0,13 | 17 | 0,07 | 0,2 / 7,3 | 71 (13) | non |
| vente | 10 | 10 → 10 | 11,2 | sales_create (450, 75/97/113) | 0/0/0 | 0,18 | 16 | 0,14 | 0,2 / 2,0 | **199 (17)** | non |
| vente | 25 | 25 → 25 | 27,9 | sales_create (1125, 197/298/321) | 0/0/0 | 0,37 | 23 | 0,26 | 0,3 / 1,2 | **1 085 (38)** | non |
| vente | 50 | 50 → 50 | 55,1 | sales_create (2250, 380/570/662) | 0/0/0 | 0,54 | 36 | 0,37 | 0,3 / 0,8 | **3 238 (79)** | mémoire machine 188 Mo |
| produits | 5 | 5 → 5 | 12,5 | product_update (225, 57/121/135) | 0/0/0 | 0,20 | 17 | 0,15 | 0,3 / 6,0 | **3 378 (131)** | non |
| produits | 25 | 25 → 25 | 66,7 | product_update (1125, 224/273/344) | 0/0/0 | 0,58 | 33 | 0,44 | 0,3 / 2,6 | **6 913 (208)** | non |
| produits | 50 | 50 → **43,2** | 116,5 | product_update (1944, 629/924/969) | **2**/0/0 | 1,06 | 78 | 0,72 | 0,4 / 2,7 | **12 061 (258)** | **débit** |
| notifications | 10 | 10 → 10 | 28,3 | notifications_unread (450, 60/113/129) | 0/0/0 | 0,28 | 18 | 0,23 | 0,5 / 2,8 | (reliquat) | non |
| notifications | 50 | 50 → 50 | 135,4 | notifications_read (1592, 226/306/342) | 0/0/0 | 0,80 | 56 | 0,55 | 0,4 / 2,2 | (reliquat) | non |

Entreprise **concentrée** (303 produits, catalogue) : 5 VU → 20 req/s,
p95 628 ms, API 1,06 cœur ; **10 VU → 6,87 / 10 it/s, boucle 330 ms :
seuil**.

Les travaux en attente des paliers « produits » et « notifications »
cumulent ceux des paliers précédents (une même stack).

### 5.3 Scénario mixte (pauses réalistes, profil `current`)

| Palier | VU | it/s obtenu | req/s | Route la plus lente (n, p50/p95/p99 ms) | Inattendues / refus / 429 | API cœurs | Boucle (ms) | Mongo L / É (ms) | Travaux (âge s) | Seuil |
|---|---|---|---|---|---|---|---|---|---|---|
| montée | 5 | 1,18 | 6,8 | products_list (58, 48/249/422) | 0/0/0 | 0,18 | 20 | 0,5 / 3,1 | 18 (5) | non |
| montée | 10 | 2,35 | 13,2 | products_list (108, 47/192/429) | 0/0/0 | 0,31 | 43 | 1,0 / 2,5 | 16 (5) | non |
| montée | 25 | 5,95 | 36,2 | products_list (228, 70/637/1043) | 0/0/0 | 1,01 | 88 | 1,4 / 2,9 | 48 (8) | non |
| montée | 50 | 8,47 | 49,3 | products_by_section (359, 231/1612/2112) | 1/0/0 | 1,27 | 159 | 1,4 / 2,0 | 410 (50) | **p95 > 1,5 s ; attente du pool 368 ms** |
| **stable 180 s** | 25 | 5,95 | 35,9 | sales_history (442, 194/530/689) | 0/0/0 | 1,08 | 95 | 1,4 / 2,7 | 317 (72) | non |
| **pic 30 s** | 75 | 9,03 | 52,7 | product_trash (30, 941/3352/3414) | 0/0/0 | 1,23 | 224 | 1,5 / 2,9 | 240 (38) | p95 > 1,5 s sur 9 routes |
| **reprise** | 5 | 1,22 | 6,8 | products_list (61, 49/106/202) | 0/0/0 | 0,19 | 21 | 0,5 / 2,8 | 168 → 0 | non |

Charge stable de 180 s à 25 VU, par minute : RSS API 271 → 277 Mo, tas
146 → 157 Mo, boucle 127 → 133 ms, lecture MongoDB 1,5 → 1,4 ms. **Aucune
dérive.** Travaux en attente : **plateau ≈ 300** (voir § 6).

Correction de méthode : une première série mixte (stack 2) attribuait les
premiers VU aux propriétaires, puis aux administrateurs, de sorte qu'aucun
vendeur n'était présent à 5 et 10 VU. Le tableau ci-dessus vient de la
série corrigée (mélange déterministe, stack 4). La série initiale (stack 2)
montrait le même plafond, ≈ 37 req/s à 25-50 VU, mais avec des parcours
de gestion plus coûteux ; elle n'est pas retenue.

### 5.4 Profil volumineux (`large`)

| Palier | VU | Route la plus lente (n, p50/p95/p99 ms) | API cœurs | Boucle (ms) | Seuil |
|---|---|---|---|---|---|
| catalogue | 1 | products_list (45, 330/448/582) | 0,58 | **274** (max 560) | **boucle** |
| tableau de bord | 1 | sales_history (44, 592/765/827) | 0,80 | **290** | **boucle** |
| vente | 25 | sales_create (1125, 209/247/278) | 0,33 | 25 | non (travaux 1 234, 47 s) |

Taille et durée d'une requête isolée, au repos :

| Organisation | `GET /products` | `GET /sales` |
|---|---|---|
| standard `current` | 153 produits, 0,13 Mo, 131 ms | 3 504 ventes, **1,5 Mo, 360 ms** |
| concentrée `current` | 303 produits, 0,26 Mo, 150 ms | 9 246 ventes, **4,1 Mo, 690 ms** |
| standard `large` | 603 produits, 0,50 Mo, ≈ 400 ms | 8 000 ventes, **3,4 Mo, ≈ 700 ms** |
| concentrée `large` | 1 503 produits, 1,25 Mo, ≈ 880 ms | 30 000 ventes, **12,7 Mo, ≈ 2,4 s** |

L'écriture (vente) ne se dégrade pas avec le volume ; les lectures
complètes croissent linéairement.

### 5.5 Temps réel (Socket.IO, mesuré séparément)

Sonde : 40 sessions, `sale:created` attendu par **chaque** socket de
l'entreprise. Option `--refetch` : comme le web (`use-live-refresh`),
chaque socket relit `GET /products` 400 ms après un événement de vente.

| Sockets | Ventes/s | Relectures | Connexion p50 / p95 (ms) | Vente HTTP p95 | Propagation p50 / p95 | Complétude | Hors entreprise |
|---|---|---|---|---|---|---|---|
| 40, sans relecture (stack 2) | 1 | — | 248 / 252 | 41 ms | **20 / 38 ms** | 100 % | 0 |
| 40 (1 par utilisateur) | 2 | 225 / 30 s | 159 / 172 | 1,9 s | 414 ms / 1,9 s | 100 % | 0 |
| 120 (3 par utilisateur) | 2 | 420 / 30 s | 490 / 518 | 8,6 s | 3,0 / 8,7 s | 100 % | 0 |
| 200 (5 par utilisateur) | 2 | 1 525 / 30 s | 700 / 759 | **30,7 s** | 14,1 / 29,9 s | 100 % | 0 |

- **Amplification.** Chaque vente déclenche autant de `GET /products` que
  d'onglets ouverts dans l'entreprise. À 2 ventes/s seulement, 120 sockets
  saturent l'API par ces relectures (§ 7.1).
- **Reconnexion** après redémarrage de l'API (200 sockets, stratégie par
  défaut du client) : redémarrage 4,4 s ; **200 / 200 reconnectées**, p50
  9,0 s et p95 10,6 s après le début du redémarrage. Les 132 relectures en
  échec de ce palier sont celles qui étaient en vol pendant le redémarrage
  volontaire.
- `notifications:changed` (sans reliquat) : p50 2,8 s, p95 4,9 s après la
  vente. C'est l'intervalle **volontaire** du traitement de fond (5 s), pas
  la charge.
- Mesure non faite : délai d'un vrai navigateur (rendu, service worker).

## 6. Dispatcher de notifications

### Délai volontaire et retard de charge

`notification-delays.js` lit en base, pour chaque travail :

| Grandeur | Définition | Nature |
|---|---|---|
| outbox | `processedAt − createdAt` | attente ; ≤ 5 s par conception (intervalle) |
| centre | 1re notification persistante − `eventAt` | ce que voit l'utilisateur |
| regroupement | `nextAttemptAt − eventAt` des livraisons | **volontaire** (fenêtre d'une minute ; intégré à l'`eventAt` du récapitulatif de ventes) |
| retard push | `sentAt − nextAttemptAt` | **dû à la charge** (transport simulé : aucun réseau) |

### Mesures (notification persistante de vente, palier de ventes)

| Ventes/s offertes | Travaux | Centre p50 / p95 | Travaux en attente max |
|---|---|---|---|
| 5 | 215 | 8,4 / 13,0 s | 71 |
| 10 | 430 | 15,8 / 27,7 s | 199 |
| 25 | 1 075 | **98,6 / 156 s** | 1 085 |
| 50 | 2 150 | **354 / 519 s** | 3 238 |

Récapitulatif push des ventes : retard dû à la charge p50 6,9 s à
5 ventes/s (une passe), le regroupement d'une minute étant en plus et
volontaire. Mixte stable à 25 VU : centre **53 s** (p50) pour
≈ 5,7 événements/s, travaux en plateau à ≈ 300 : le dispatcher est à sa
limite.

### Débit maximal de vidange

- **Mesuré au repos : 7,6 travaux/s** (12 819 → 12 369 en 59 s), avec une
  API à **6 % de CPU**. La limite n'est donc pas une ressource.
- Pendant la charge, la limite est plus basse : le dispatcher partage le
  thread de l'API.
- **Surcharge des actions de produits (1-19A)** : 50 admins à
  1 action/s produisent ≈ 100 activités/s. Pic de **13 095 travaux**, le
  plus ancien en attente depuis 1 290 s. Vidange complète en
  **≈ 35 min**, sans échec ni perte (intégrité § 8).
- Après le pic mixte court : 240 travaux, vidés **71 s** après la fin du
  pic.
- File **unique et FIFO** (`eventAt`) pour toutes les entreprises : une
  entreprise qui produit beaucoup d'activités retarde les notifications de
  ventes de **toutes** les autres.

## 7. Diagnostic (avec preuves)

### 7.1 Catalogue : signature des URL de photos (CPU)

Scénario minimal : `catalog`, 10 VU, 30 s ; profil CPU de 20 s de l'API
(inspecteur interne, `cpu-profile.request`).

| Temps propre par paquet | Part |
|---|---|
| `@smithy/core` | 30,1 % |
| natif / V8 (dont GC 5,9 %) | 22,1 % |
| `mongoose` | 10,1 % |
| `@aws-sdk/s3-request-presigner` | 8,0 % |
| `mongodb` | 6,6 % |
| `@aws-sdk/core` | 4,0 % |
| `bson` | 3,6 % |
| `@smithy/signature-v4` | 3,0 % |

- La chaîne de **pré-signature du SDK AWS** représente **≈ 46 % du CPU** de
  l'API ; Mongoose, le pilote et BSON en font ≈ 20 %.
- Micro-mesure isolée de `getSignedUrl` (même configuration) : **0,56 ms
  par signature** (0,72 ms de CPU).
- `GET /products` signe **une URL par produit et par réponse**
  (`toMetricsViews → imageUrlFor → signedReadUrl`) : 153 produits
  ≈ 85 ms. Cela correspond au p50 de `products_list` à 1 VU (80 ms).
- MongoDB n'est pas en cause : 1,6 à 2 ms en moyenne, mongod à 0,5 cœur.
- L'attente du pool (p99 158 ms à 10 VU) suit le blocage de la boucle :
  11 connexions utilisées sur 100.

### 7.2 Historique des ventes : liste complète non paginée

- `GET /sales` relit **tout** l'historique, avec 2 `populate`. Plan
  MongoDB : `IXSCAN(organizationId_1_productId_1_createdAt_-1) → SORT →
  FETCH`. Le tri est fait en mémoire (index sans `productId`), mais
  l'exécution reste rapide : 18 ms pour 3 504 ventes, 63 ms pour 9 246.
- Le coût est côté Node : hydratation, `populate`, sérialisation de
  1,5 à 12,7 Mo. Il croît linéairement avec l'historique (§ 5.4).
- `GET /products` a le même défaut de liste complète : 1,25 Mo pour
  1 503 produits.
- En profil `large`, une seule requête bloque la boucle 270 à 560 ms et
  retarde **toutes** les autres requêtes du processus.

### 7.3 Dispatcher : lot unique par passe

`push-dispatcher.service.ts` : `dispatchJobs` lit **un seul lot de 50**
travaux en attente (`limit(BATCH)`, tri `eventAt`), les traite un par un,
puis la passe suivante attend **5 s** (`PUSH_POLL_INTERVAL_MS`). L'index
`status_1_eventAt_1` existe : ce n'est pas la requête. Le débit est
plafonné par conception à ≈ 50 / (5 s + durée de la passe) : 7,6 /s
mesurés.

### 7.4 Vente : hausse de latence sans saturation visible (non prouvée)

Le p50 de `sales_create` passe de 75 à 380 ms entre 10 et 50 VU, avec une
API à 0,54 cœur, des écritures MongoDB à 0,8 ms, des validations de
transaction (`commitTransaction`) à 4,4 ms et une attente du pool de 27 ms
au plus. 102 transactions sur 2 426 ont été rejouées par `withTransaction`,
sans erreur. Hypothèse : une attente cumulée sur ≈ 15 allers-retours
séquentiels par vente (gardes, transaction, `populate`), aggravée par la
pression mémoire de la machine (188 Mo libres). **Cause non établie.**
Le p95 reste à 570 ms, sous le seuil.

### 7.5 Erreurs inattendues

3 réponses en échec au total : 2 au palier « produits » à 50 VU (0,04 %)
et 1 au palier mixte à 50 VU. Elles ne sont pas des délais dépassés et
aucune 5xx n'est journalisée. Elles n'ont pas été reproduites sur 30 s. Les
collisions de corbeille entre VU ont été testées et répondent toutes 200
(routes idempotentes). **Statut exact non capturé** (journalisation
`LOG_UNEXPECTED=1` ajoutée ensuite à k6).

## 8. Intégrité métier

Vérifiée par `integrity.js` (lecture seule) sur **les 4 stacks**, après
vidange. Cumul : **7 893 ventes créées pendant la campagne** (7 101 conservées, 792 annulées).

| Invariant | Résultat |
|---|---|
| Stock jamais négatif | 0 sur 1 068 / 7 533 produits |
| `restant = initial − Σ ventes` | **0 écart** |
| Chaque vente a son audit `sold` ; chaque `sold` désigne une vente existante ou annulée | **0 écart** |
| Vente rattachée à un produit d'une autre organisation | 0 |
| Notification de vente : un exemplaire par destinataire éligible (propriétaire et admins, sauf l'auteur) | **0 manquant, 0 en trop, 0 auteur notifié** |
| Doublon (`eventKey`, destinataire) | 0 |
| Destinataire hors de l'organisation | 0 |
| Livraisons push : doublon ou appareil d'une autre organisation | 0 |
| Vidange des travaux après la baisse de charge | complète, aucun travail en échec |

### Sous concurrence (`concurrency.js`, rejoué **pendant** la charge stable)

| Cas | Résultat |
|---|---|
| A. 36 ventes simultanées (12 vendeurs) sur un produit à 20 unités | **20 × 201, 16 × 400 `INSUFFICIENT_STOCK`**, stock final 0 |
| A'. 10 ventes de 2 unités sur un stock de 5 | 2 × 201, 8 refus, stock 1 |
| B. 10 ventes de 3 unités annulées **deux fois en parallèle** (vendeur et propriétaire) | **10 × 204, 10 × 404**, stock restauré exactement (30) |
| C. Même `clientOperationId` × 10 en parallèle | 10 × 201, **une seule vente** (même `_id`), stock − 1 |
| C'. Même clé, autre contenu / autre vendeur | 409 `IDEMPOTENCY_KEY_REUSED` / 409 `IDEMPOTENCY_KEY_CONFLICT`, stock inchangé |
| C''. **Sans** `clientOperationId`, deux envois | **2 ventes** : aucune déduplication (flux historique, garantie réelle 1-11C.1) |
| D. 3 adhésions de comptes existants, chacune acceptée deux fois en parallèle | 3 × 200, 3 × 400 `INVITATION_INVALID_OR_EXPIRED` ; une adhésion et **une** notification « nouveau membre » par gestionnaire, aucune hors organisation |
| E. 15 connexions simultanées (même IP) | 10 × 201, **5 × 429 `AUTH_RATE_LIMITED` attendus** |

**429.** Aucun 429 sur les routes métier (elles ne sont pas limitées). Les
seuls 429 sont ceux, **attendus**, de la limitation des connexions et
acceptations (10 / min / IP), comptés à part.

### Limite connue (1-19A) : activités enregistrées après l'action

Les notifications d'activité (`member-activity`) sont enregistrées **après**
le succès du service, en best effort. Sous charge, rien n'a été perdu de
façon visible : 13 433 travaux ont été regroupés en 172 notifications sur
la stack 1. Ce n'est pas vérifiable exactement par comptage, car les
actions sont regroupées par minute. Un arrêt du processus entre l'action et
l'enregistrement perdrait toujours la notification. Le redémarrage de l'API
pendant la charge temps réel n'a montré aucune incohérence d'intégrité,
sans prouver l'absence de cette perte. Cette limite est distincte de la
saturation du dispatcher ; la surcharge l'aggrave (§ 6).

## 9. Trois améliorations prioritaires

Ce sont des recommandations justifiées par les mesures. **Aucune n'a été
appliquée** : pas de refonte, pas de cache ni de service ajoutés, pas de
seuil métier modifié.

1. **Débit du dispatcher de notifications** (premier point de saturation,
   § 6 et § 7.3). Au-delà de ≈ 7,6 événements/s, toutes entreprises
   confondues, l'attente devient non bornée (jusqu'à 35 min observées), et
   une entreprise peut retarder les autres (FIFO unique). Piste : enchaîner
   les lots tant qu'il en reste dans une même passe, au lieu d'attendre 5 s
   après chaque lot de 50. Le regroupement volontaire d'une minute n'est
   pas en cause. À mesurer de nouveau avec `ramp-sales` et `ramp-products`.
2. **Coût CPU de `GET /products`** (premier seuil HTTP, § 7.1, et
   amplification temps réel, § 5.5). 46 % du CPU va à la signature d'une
   URL par produit et par réponse ; chaque vente déclenche une relecture
   complète par onglet ouvert. Pistes, à arbitrer : signer moins (ou plus
   tôt), réduire les relectures complètes après `sale:created`. Une
   relecture ciblée est possible, le web disposant déjà du `productId`.
3. **Listes complètes non paginées : `GET /sales`, `GET /products`** (§ 7.2,
   § 5.4). Sur le profil volumineux, une seule requête bloque la boucle
   événementielle 270 à 560 ms pour tout le processus, et l'historique
   atteint 12,7 Mo. Piste : pagination et filtres côté serveur, en
   commençant par l'historique des ventes (index adapté au tri sans
   `productId`).

## 10. Limites de validité

- **Résultats locaux**, sur une machine partagée et sous pression mémoire,
  avec le générateur sur le même hôte. Ce n'est **pas** une capacité
  garantie de Railway ou Vercel (CPU, réseau et latence vers MongoDB Atlas
  différents ; le web Next.js n'était pas dans la boucle).
- **Pas une estimation du nombre de clients commerciaux** : les volumes
  et parcours sont des hypothèses de test.
- MongoDB local (8.2.6, 1 membre, sans réseau) : la latence d'un cluster
  géré à distance s'ajouterait à **chaque** aller-retour, ce qui pèserait
  surtout sur la vente (≈ 15 allers-retours).
- Une seule instance d'API (comme le dispatcher, conçu mono-instance).
- Le stockage simulé ne mesure ni R2 ni les téléchargements de photos par
  le navigateur. Les URL sont signées par le vrai SDK.
- Le plancher du retard de boucle (≈ 16 ms) est propre à Windows.
- La mémoire machine (critère 250 Mo) a coïncidé avec deux arrêts
  (catalogue à 10 VU, vente à 50 VU) ; pour le catalogue, le débit était
  déjà insuffisant.
- **Non mesurés** : latence MongoDB par commande au-delà des moyennes de
  `serverStatus` ; contention d'un vrai navigateur ; envoi Web Push réel ;
  appels R2 ; comportement derrière le proxy Railway.
- Charge stable limitée à 180 s ; pic court à 75 VU. **Aucune saturation
  n'a été atteinte pour les notifications du centre (lecture) jusqu'à
  50 VU, ni pour l'écriture des ventes jusqu'à 50 ventes/s** : cela ne
  signifie pas une capacité illimitée, seulement que ces bornes n'ont pas
  été dépassées.

## 11. Reproduire

Depuis la racine du dépôt (README : `api/test/load/README.md`) :

```bash
pnpm --filter api build
# k6 : binaire officiel v2.3.0, somme SHA-256 vérifiée, hors dépôt
node api/test/load/load-stack.js start --profile=current --keep-state   # terminal 1

# terminal 2
export K6=<chemin>/k6.exe OUT=<dossier de résultats>
bash api/test/load/campaign-1-20a.sh baseline
bash api/test/load/campaign-1-20a.sh ramps
bash api/test/load/campaign-1-20a.sh fine
bash api/test/load/campaign-1-20a.sh concentrated
bash api/test/load/campaign-1-20a.sh realtime
DRAIN_S=3600 bash api/test/load/campaign-1-20a.sh integrity
node api/test/load/load-stack.js stop

# nouvelle stack (données neuves) pour le mixte
node api/test/load/load-stack.js start --profile=current --keep-state
bash api/test/load/campaign-1-20a.sh mixed
bash api/test/load/campaign-1-20a.sh steady      # 25 VU, concurrence à 60 s
bash api/test/load/campaign-1-20a.sh spike       # 75 VU, puis 5 VU
DRAIN_S=900 bash api/test/load/campaign-1-20a.sh integrity
node api/test/load/load-stack.js stop

# profil volumineux
node api/test/load/load-stack.js start --profile=large --keep-state
bash api/test/load/campaign-1-20a.sh large
bash api/test/load/campaign-1-20a.sh integrity
node api/test/load/load-stack.js stop

# outils d'analyse
node api/test/load/notification-delays.js --from=<ISO> --to=<ISO>
node api/test/load/render-results.js "$OUT"
```

Fichiers de résultats (synthèses k6 par palier, JSON agrégés, profils,
séries brutes) : répertoire temporaire de la session, hors dépôt.

## 12. Fichiers ajoutés

Uniquement `api/test/load/` (hors `dist/`, non compilés, aucun binaire de
production concerné) : `load-common.js`, `load-stack.js`, `load-api.js`,
`load-seed.js`, `k6/stockmaster.js`, `run-campaign.js`, `realtime-probe.js`,
`concurrency.js`, `integrity.js`, `notification-delays.js`,
`profile-summary.js`, `render-results.js`, `campaign-1-20a.sh`,
`README.md`. Réutilisés sans modification : `recipe/preload.cjs`
(garde anti-`.env`, chien de garde), `recipe/recipe-common.js`,
`recipe/storage-sim.js`, `recipe/actions.js`.

## 13. Nettoyage

Seules les ressources de cette campagne ont été supprimées :

- les 4 instances MongoDB éphémères (données supprimées) ;
- `%TEMP%/stockmaster-load-1-20a` ;
- les scripts de diagnostic temporaires.

Vérifié ensuite : aucun processus `mongod` ou `k6` restant, ports
4300/4398/4399 libres, aucun dossier `mongo-mem-*`. Le binaire k6 et les
résultats restent dans le répertoire temporaire de la session, hors dépôt.
`stash@{0}` et les branches existantes sont intacts.
