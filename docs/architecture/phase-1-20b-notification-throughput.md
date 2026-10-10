# Lot 1-20B — Débit du dispatcher de notifications

État : **implémenté, testé et mesuré localement**, non commité, sur
`perf/phase-1-20b-notification-throughput`. La branche part de
`perf/phase-1-20a-load-baseline` (`cdcffaf`) et conserve les scripts et
rapports non commités de 1-20A. `stash@{0}` est conservé.

Aucun commit, push, déploiement ni service réel : base MongoDB éphémère,
transport push, e-mails et stockage simulés (outils de 1-20A).

Hors périmètre, **inchangés** : signatures d'URL, relectures temps réel,
pagination. Ils auront leurs propres mesures.

## 1. Synthèse

| | Avant (témoin, ancien code) | Après |
|---|---|---|
| Débit sortant sous charge, ventes réparties (22 travaux/s entrants) | 6,3 travaux/s | **17,2 travaux/s** (× 2,7) |
| Délai du centre, ventes, p50 / p95 (même palier) | 131 / 304 s | **5,9 / 40 s** |
| Ventes à 25 /s : file max (âge) | 1 046 (37 s) | **174 (9 s)** |
| Vidange après les paliers de ventes | inachevée à 300 s (891 restants) | **41 s** |
| Entreprise peu active pendant le flux d'une autre | 22 / 38 notifications vues, p95 280 s | **38 / 38, p95 32 s** |
| Mixte témoin (25 VU) : délai du centre p50 / p95 | 55 / 66 s | **7 / 13 s** |
| Coût HTTP | — | ventes : équivalent ; mixte saturé : p95 + 3 à + 33 % (§ 5) |

**Nouveau seuil observé** (§ 6) :
- ≈ **17 travaux/s** répartis sur plusieurs entreprises, sous charge HTTP ;
- ≈ **11 travaux/s** pour une seule entreprise : séquentiel par
  organisation ;
- au repos, ≈ 20 à 30 travaux/s.

Au-delà, la file grossit encore, mais plus lentement. Une entreprise qui
déborde ne bloque plus les autres.

## 2. Changement

Fichier : `api/src/push/push-dispatcher.service.ts`. Aucun nouveau service,
aucune nouvelle collection, **aucun nouvel index**, aucune migration.

### Avant

Une passe = **un** lot de 50 travaux (FIFO global sur `eventAt`), puis
rattrapage des rappels, puis **un** lot de 50 envois. La passe suivante
partait **5 s** après la fin de la précédente, quel que soit le reliquat :
débit plafonné à ≈ 50 / (5 s + durée de la passe), soit 7,6 /s au repos.

### Après

| Élément | Règle | Constante |
|---|---|---|
| Tour | un lot de travaux **puis** un lot d'envois échus | `BATCH` = 50 (inchangé) |
| Passe | tours enchaînés tant qu'un lot est plein | `PUSH_PASS_MAX_ROUNDS` = 10 tours |
| | arrêt aussi au premier tour qui dépasse le budget de durée | `PUSH_PASS_TIME_BUDGET_MS` = 1 s |
| Entre deux passes | 100 ms s'il reste du travail immédiatement traitable, sinon 5 s | `PUSH_BUSY_INTERVAL_MS` = 100 ; `PUSH_POLL_INTERVAL_MS` = 5 s (inchangé) |
| Main rendue | `setImmediate` tous les 10 éléments, et entre deux tours | `YIELD_EVERY` = 10 |
| Répartition | au plus 10 travaux par organisation dans un lot, complétés par les plus anciens des **autres** organisations, puis par l'excédent (aucune perte de débit pour une organisation seule) | `PUSH_JOBS_PER_ORGANIZATION` = 10 |
| Parallélisme borné | au plus 3 organisations **différentes** en parallèle ; séquentiel et dans l'ordre `eventAt` au sein d'une organisation | `PUSH_DISPATCH_LANES` = 3 |
| Passes superposées | `runOnce()` sérialisé (une passe attend la fin de la précédente) | — |
| Arrêt | `stop()` interrompt entre deux éléments et attend la passe en cours | — |

Points de conception :

- **Pas de boucle active à vide.** On ne repart vite que si le lot était
  plein. File vide : un seul tour, puis 5 s d'attente.
- **Pas de boucle rapide sur une panne.** Une exception arrête la passe ; la
  suivante attend 5 s, comme avant.
- **Travaux différés jamais avancés.** Seules les livraisons échues
  (`nextAttemptAt ≤ maintenant`) sont envoyées. La fenêtre d'une minute des
  regroupements et les reprises (30 s à 30 min, 5 tentatives) sont donc
  inchangées.
- **Envois jamais affamés.** Chaque tour envoie un lot après avoir réparti
  un lot de travaux.
- **Pourquoi par organisation.** Les clés de regroupement (récapitulatif
  des ventes, groupe d'activités) et les clés d'unicité contiennent
  l'organisation. Deux organisations n'ont donc aucune écriture commune.
  Au sein d'une organisation, l'ordre et la séquence d'avant sont conservés.
- **Pas de travail en arrière-plan.** Toutes les voies doivent s'arrêter
  avant la fin de la passe ; la première erreur est relancée ensuite.

### Paramètres retenus et alternative mesurée

| Variante (ventes, 50 /s) | Sortant | Centre p50 / p95 | `sales_create` p50 / p95 | API cœurs |
|---|---|---|---|---|
| Témoin (ancien code) | 6,3 /s | 131 / 304 s | 377 / 539 ms | 0,56 |
| Enchaînement + répartition, **1 voie** | ≈ 12,5 /s | 29 / 77 s | 508 / 584 ms | 0,71 |
| **3 voies (retenu)** | 17,2 /s | 5,9 / 40 s | 387 / 455 ms | 0,75 |

Une seule voie doublait le débit, mais coûtait davantage aux requêtes
HTTP. Avec 3 voies, le traitement attend moins MongoDB et la latence HTTP
revient au niveau du témoin. Je n'ai pas essayé plus de 3 voies : chaque
voie garde une connexion du pool pendant ses requêtes, et le gain est
plafonné par le séquentiel par organisation.

## 3. Garanties conservées

| Garantie | Comment | Preuve |
|---|---|---|
| Événements de vente et d'adhésion dans la transaction métier | outbox inchangée (`push-outbox.service.ts` non modifié) | e2e `sales-transaction`, `invitations`, `member-activity-notifications` |
| Déduplication | `eventKey` unique des travaux, `{eventKey, userId}` des notifications, `{jobId, subscriptionId}` des livraisons, inchangés | e2e 1-20B n° 5, 7 ; intégrité des campagnes : 0 doublon |
| Reprise après panne | un travail n'est clos (`closeJob`, conditionnel sur `pending`) qu'**après** centre et livraisons ; une erreur laisse le travail en attente | e2e 1-20B n° 5, 6, 13 |
| Permissions actuelles | relues à la répartition et avant chaque envoi (inchangé) | e2e `web-push-notifications`, `notification-center` |
| Auteur exclu, isolation, push générique | inchangés | intégrité : 0 auteur notifié, 0 hors organisation |
| Aucun travail perdu ni clos avant traitement | interruption entre deux éléments : rien n'est clos | e2e 1-20B n° 6 (arrêt), 13 (voie en échec) |

- **Push.** Le transport existant ne garantit pas une livraison exactement
  une fois. Un plantage entre l'envoi et `finish` peut renvoyer après
  expiration du verrou de 60 s : comportement inchangé, et ce lot ne promet
  pas mieux.
- **Activités.** La limite connue de 1-19A reste **distincte** de ce
  correctif : l'activité est enregistrée **après** l'action, en best
  effort.
- **Mono-instance.** Les travaux ne sont pas réservés : seule la clôture
  est conditionnelle. Deux processus exécutant le traitement pourraient
  répartir le même travail en même temps. Les clés uniques empêchent les
  doublons de notifications et de livraisons, mais **ce lot ne coordonne
  pas plusieurs instances** ; c'est documenté dans le service.

## 4. Méthode de comparaison

### Témoin de l'ancien code

`make-baseline-dist.js` copie `api/dist` et ne remplace que
`push/push-dispatcher.service.js` par la version de `HEAD` (`cdcffaf`),
transpilée avec les options de `tsconfig.build.json`. Les deux mesures
utilisent donc le même binaire, à ce seul fichier près. La régénération
produit un fichier identique octet pour octet à celui qui a été mesuré. Le
dossier `api/.load-dist-1-20a-baseline` a été supprimé ensuite.

Le témoin reproduit 1-20A : ventes à 50 /s, file 3 181 (âge 78 s), contre
3 238 (79 s) en 1-20A.

### Conditions

- `compare-1-20b.sh <groupe> <variante>` : **stack neuve** pour chaque
  mesure, mêmes données déterministes (profil `current`), **file vide** au
  départ, mêmes paramètres k6 (paliers de 45 s, rythme 1 itération/s/VU,
  120 s en mixte).
- Ordre : témoin, puis nouveau code, groupe par groupe.
- **Mémoire.** La machine est partagée (VS Code, Chrome), et je n'ai fermé
  aucune application. La mémoire libre au départ est notée dans
  `conditions.txt` :
  - ventes : 389 / 669 Mo ;
  - produits : 785 / 754 Mo ;
  - mixte : 522 / 393 Mo.
- Une mesure mixte du témoin faite à **116 Mo** libres (52 Mo au minimum)
  a été écartée et rejouée à 522 Mo. Elle est conservée dans
  `_superseded/`.
- **Arrêt.** Critère ajouté, fixé avant les mesures : plus ancien travail
  prêt > 120 s, pour ne pas recréer l'attente de 35 min. Vidange bornée à
  300 s.

### Groupes

| Groupe | Contenu |
|---|---|
| `sales` | ventes réparties sur les 6 entreprises, 5 → 50 VU |
| `products-fairness` | modifications et actions groupées de produits **concentrées sur `conc1`** (2 admins, 5 → 50 VU) ; en parallèle, `quiet-org-probe.js` vend dans `std2` toutes les 5 s et relit le centre du propriétaire par la route réelle |
| `mixed` | scénario mixte témoin, 25 VU, 120 s, pauses réalistes |

### Grandeurs

- **Débit visé et débit injecté.** Visé = VU / rythme ; injecté =
  itérations réalisées par k6.
- **Débit entrant et sortant de la file.** Travaux créés et travaux clos sur
  la fenêtre des paliers ; le sortant est calculé à partir de la file en
  fin de fenêtre.
- **Âge du plus ancien travail prêt.** Échantillonné toutes les 2 s.
- **Délai du centre.** Première notification − `eventAt`.
- **Retard push hors regroupement.** `sentAt − nextAttemptAt` ; la fenêtre
  d'une minute est exclue.
- **Mesures système.** Latences HTTP par route, CPU, RSS, retard de la
  boucle événementielle, attente du pool, comme en 1-20A.
- **Réponses inattendues.** Journalisées dès la première exécution : route,
  méthode, statut, code, erreur k6, identifiant de corrélation
  `x-load-correlation-id`, extrait court du corps. Jamais de jeton.

## 5. Comparaison avant / après

### 5.1 Ventes réparties (`sales`)

| VU | File max (âge s) avant → après | `sales_create` p50 / p95 ms avant → après | API cœurs avant → après | Boucle p99 méd. ms |
|---|---|---|---|---|
| 5 | 37 (7) → 32 (5) | 64 / 159 → 49 / 86 | 0,20 → 0,17 | 17 → 16 |
| 10 | 182 (17) → **74 (9)** | 88 / 126 → 102 / 151 | 0,23 → 0,25 | 17 → 20 |
| 25 | 1 046 (37) → **174 (9)** | 238 / 362 → 201 / 286 | 0,43 → 0,47 | 25 → 21 |
| 50 | 3 181 (78) → **1 031 (31)** | 377 / 539 → 387 / 455 | 0,56 → 0,75 | 37 → 38 |

| Fenêtre des paliers (199 s) | Avant | Après |
|---|---|---|
| Entrant | 22,3 /s | 22,3 /s |
| Sortant | 6,3 /s | **17,2 /s** |
| Centre (ventes) p50 / p95 | 131 / 304 s | **5,9 / 40 s** |
| Retard push des activités (hors fenêtre) p50 / p95 | 5,1 / 58 s | **1,5 / 5,5 s** |
| Retard push du récapitulatif des ventes p50 / p95 | 2,9 / 4,7 s | 1,0 / 5,1 s |
| Vidange après les paliers | **inachevée** à 300 s (891) | **41 s** |
| Erreurs inattendues | 0 | 0 |
| Intégrité | échec de la vidange seulement | **OK** |

### 5.2 Activités concentrées et entreprise peu active (`products-fairness`)

| VU | File max (âge s) avant → après | `product_update` p95 ms | Débit injecté (offert 1 it/s/VU) |
|---|---|---|---|
| 5 | 247 (18) → 109 (8) | 97 → 149 | 5 → 5 |
| 10 | 1 159 (41) → 571 (21) | 184 → 180 | 10 → 10 |
| 25 | 3 919 (82) → 3 089 (44) | 525 → 380 | 25 → 25 |
| 50 | 8 248 (131) → 7 850 (92) | 1 293 → 1 063 | 34,5 → 41,7 (sur 50) |

Fenêtre des paliers : entrant ≈ 48 à 51 /s ; sortant 6,2 → **11,2 /s**.
Vidange inachevée à 300 s dans les deux cas : il restait 4 938 travaux
avant et 1 473 après.

**Entreprise peu active (`std2`), vue par l'utilisateur :**

| | Avant | Après |
|---|---|---|
| Notifications de vente vues dans le délai de la sonde | 22 / 38 | **38 / 38** |
| Délai p50 / p95 / max | 52,7 / 279,6 / 329 s | **2,6 / 31,9 / 37,6 s** |
| Délai du centre en base p50 / p95 | 138 / 527 s | **2,1 / 31 s** |

Avant, `std2` attendait derrière tout le flux de `conc1` (FIFO global).
Après, ses travaux entrent dans le lot suivant ; le délai restant vient de
la durée des lots du flux de `conc1`.

### 5.3 Mixte témoin (25 VU, 120 s)

| | Avant | Après |
|---|---|---|
| Débit HTTP | 31,7 req/s | 30,0 req/s |
| API cœurs ; boucle p99 méd. ; RSS | 1,27 ; 159 ms ; 254 Mo | 1,30 ; 156 ms ; 277 Mo |
| File max (âge) | 283 (67 s) | **75 (16 s)** |
| Sortant / entrant | 2,5 / 4,7 /s | **4,5 / 4,5 /s** |
| Centre (ventes) p50 / p95 | 55 / 66 s | **6,9 / 13 s** |
| Retard push des activités p50 / p95 | 11 / 56 s | 9,9 / 13,6 s |
| Vidange | 49 s après | 2 s après |
| Intégrité | OK | OK |

Latences HTTP p50 / p95 (ms), avant → après :

| Route | Avant | Après |
|---|---|---|
| `sales_create` | 231 / 678 | 251 / 753 |
| `products_list` | 142 / 597 | 164 / 762 |
| `sales_history` | 299 / 754 | 359 / 875 |
| `notifications_list` | 92 / 503 | 113 / 519 |
| `product_update` | 150 / 677 | 258 / 901 |
| `analytics_overview` | 119 / 355 | 161 / 524 |

## 6. Nouveau seuil et coût HTTP

- **Plusieurs entreprises.** Le dispatcher suit 25 ventes/s : file stable
  ≈ 170, âge 9 s, alors que le témoin décrochait dès 10 /s. À 50 /s (22
  travaux entrants/s, en comptant les activités), il sort 17 /s : la file
  grossit d'environ 5 /s, et se vide en 41 s après la charge.
- **Une seule entreprise très active.** Elle reste traitée en séquence :
  ≈ 11 travaux/s sous charge, environ 21 /s pendant la vidange. 25 VU
  d'actions de produits (≈ 25 activités/s) dépassent ce débit. La file
  grossit, mais **les autres entreprises ne sont plus bloquées**.
- **Coût HTTP sur les ventes.** Équivalent au témoin :
  - p50 de 387 contre 377 ms à 50 VU, p95 de 455 contre 539 ms ;
  - + 0,19 cœur pour l'API, qui fait 2,7 fois plus de travail.
- **Coût HTTP sur le mixte saturé** (API ≈ 1,3 cœur dans les deux cas) :
  - p50 de + 20 à + 110 ms selon la route ;
  - p95 de + 3 % (`notifications_list`) à + 48 % (`analytics_overview`) ;
  - attente du pool p99 au maximum : 890 contre 496 ms.

  Le dispatcher fait maintenant le travail que l'ancien code repoussait
  (4,5 contre 2,5 travaux/s), sur le même thread que l'HTTP. **Une seule
  mesure par variante** : la part due au bruit de la machine partagée
  (393 contre 522 Mo libres) n'est pas séparée.
- **Réglage si ce coût est jugé trop élevé.** Baisser `PUSH_DISPATCH_LANES`
  ou `PUSH_PASS_MAX_ROUNDS`, ou augmenter `PUSH_BUSY_INTERVAL_MS`. Je n'ai
  pas mesuré de variante intermédiaire.
- **Limites de 1-20A inchangées.** Le premier seuil HTTP reste le catalogue
  (signature des URL), et le mixte plafonne vers 30 à 36 req/s sur cette
  machine.

## 7. Erreurs

| Erreur | Statut |
|---|---|
| Ventes et mixte (toutes variantes) | **0** réponse inattendue |
| Produits concentrés, 50 VU : 8 (témoin) et 12 (nouveau) | **toutes identiques** : `DELETE /products/:id` dans `http.batch`, `status 0`, erreur k6 1220 `read: connection reset by peer`, 6 à 86 ms, par paires dans le même lot. Aucune 5xx, aucun code métier. **Présentes sur les deux versions** : sans lien avec le dispatcher. |
| Hypothèse keep-alive | **non confirmée.** Le serveur HTTP Node ferme les connexions inactives après 5 s (`keepAliveTimeout` par défaut ; `main.ts` ne le change pas), d'où l'hypothèse d'une course avec une connexion réutilisée par k6. Expérience : 4 × 50 VU sur `conc1` (≈ 24 800 requêtes), délai par défaut puis 65 s (réglage de l'entrée de test seulement) : **0 erreur dans les deux cas**. Les réinitialisations ne sont apparues qu'en fin de montée complète, avec une file chargée et une mémoire libre de 258 à 410 Mo. **Cause non établie.** |
| 1-20A (3 réponses non identifiées) | probablement de même nature (même palier, mêmes routes), sans preuve : leur statut n'avait pas été capturé |

Les journaux `*.unexpected.jsonl` sont dans les preuves (§ 9). Le journal
interne de l'API de ces stacks n'a pas été conservé : il est supprimé avec
le répertoire d'état.

## 8. Validation

| Contrôle | Résultat |
|---|---|
| Nouveau `test/push-dispatcher-throughput.e2e-spec.ts` | **13 / 13** |
| E2E ciblés : `web-push-notifications`, `notification-center`, `member-activity-notifications`, `sales-transaction`, `invitations` | **103 / 103** |
| Unitaires `src/push`, `src/notifications`, `src/sales`, `src/organizations` | **421 / 421** |
| `tsc` (build), ESLint (0 erreur), Prettier des fichiers touchés | OK |
| Intégrité après chaque mesure du nouveau code (stock, audit, notifications exactement une fois par destinataire, doublons, isolation, livraisons, vidange) | **OK** |

Scénarios du nouveau test (MongoDB éphémère, vrai dispatcher, faux
transport, horloge contrôlée) :

1. plusieurs lots dans une passe, sans attente de 5 s ;
2. budget de tours borné, sans rien perdre ;
3. file vide : un seul tour ;
4. travaux différés jamais avancés : fenêtre d'une minute et reprise après
   un 503 ;
5. échec du centre puis reprise : rien de clos, aucun doublon ;
6. arrêt pendant une vidange : plus de passe ensuite ; chaque travail est
   clos avec ses notifications, ou intact ;
7. deux `runOnce()` simultanés : sérialisés, aucun doublon ;
8. répartition : l'organisation peu active passe dans le premier lot
   (rang < 50 au lieu de 401) ;
9. organisation seule : 50 travaux par tour (le plafond ne réduit pas le
   débit) ;
10. ordonnancement : passes rapprochées tant qu'il reste du travail, puis
    retour à l'intervalle de repos ;
11. budget de durée ;
12. voies parallèles bornées, jamais une organisation avec elle-même,
    ordre `eventAt` conservé ;
13. échec dans une voie : la passe attend les autres avant d'échouer, rien
    ne continue en arrière-plan.

Adaptation d'un test existant : `web-push-notifications` n° 12 compare la
synthèse exacte d'une passe. Elle porte deux champs de plus (`rounds`,
`backlog`) ; la valeur attendue (runtime inactif : 0 tour) est ajoutée.

Les suites e2e et unitaires complètes n'ont pas été relancées : aucun
risque concret hors du dispatcher, dont l'interface publique (`start`,
`stop`, `runOnce`) est conservée.

## 9. Preuves conservées

- `docs/architecture/phase-1-20a-evidence/` : résultats de 1-20A (paliers,
  synthèses k6 des paliers comparés, intégrité, délais, séries compressées,
  synthèse du profil CPU). Voir son `README.md`.
- `docs/architecture/phase-1-20b-evidence/` : un dossier par groupe et
  variante, contenant :
  - les paliers et les synthèses k6 ;
  - `delays.json` (flux, délais par catégorie) ;
  - `integrity.json`, `quiet-org.json` ;
  - `*.unexpected.jsonl` ;
  - `conditions.txt` ;
  - les séries compressées.

  On y trouve aussi `keepalive/` (expérience du § 7) et `_superseded/`
  (première sonde, qui ne lisait pas l'identifiant de vente, absent de la
  vue ; mixte du témoin en manque de mémoire).

Vérifié avant copie : aucun jeton, aucune session, aucune adresse e-mail,
aucun chemin local.

## 10. Limites

- Résultats **locaux**, sur une machine partagée, avec une mesure par
  variante. Ce n'est ni une capacité de Railway, ni une estimation du
  nombre de clients.
- **Une seule instance d'API** : le traitement n'est pas coordonné entre
  instances (§ 3).
- Une entreprise seule reste plafonnée par le traitement séquentiel de ses
  travaux. Paralléliser au sein d'une organisation demanderait de revoir
  les regroupements : hors périmètre.
- Requête de répartition : quand une organisation est plafonnée, la
  recherche des autres organisations parcourt l'index
  `status_1_eventAt_1`, puis filtre sur l'organisation. Son coût croît avec
  le reliquat de l'organisation plafonnée. Je ne l'ai pas mesuré à part ;
  il est inclus dans les débits ci-dessus. Aucun index ajouté.
- Le coût HTTP du mixte saturé (§ 6) n'est pas séparé du bruit.
- Les réinitialisations de connexion côté k6 (§ 7) restent inexpliquées.

## 11. Déploiement

- **Aucune migration**, aucun index, aucune variable d'environnement
  nouvelle. Le web n'est pas concerné.
- **Une seule instance d'API** doit exécuter le traitement de fond (comme
  avant).
- Déployer l'API. Après le démarrage, surveiller :
  - le nombre de travaux `push_jobs` en `pending` et l'âge du plus ancien ;
  - les latences HTTP pendant les pics d'activité.
- **Retour arrière** : redéployer l'API précédente. Aucune donnée n'a
  changé de forme ; les travaux en attente sont repris par l'ancien code.

## 12. Fichiers

- `api/src/push/push-dispatcher.service.ts` (modifié).
- `api/test/push-dispatcher-throughput.e2e-spec.ts` (nouveau) ;
  `api/test/web-push-notifications.e2e-spec.ts` (une assertion).
- Outils `api/test/load/` :
  - nouveaux : `compare-1-20b.sh`, `compare-summary.js`,
    `quiet-org-probe.js`, `make-baseline-dist.js` ;
  - modifiés :
    - `k6/stockmaster.js` : corrélation, réponses inattendues
      journalisées, `TARGET=org:` ;
    - `run-campaign.js` : collecte, critère de file ;
    - `notification-delays.js` : flux ;
    - `load-stack.js`, `load-common.js`, `load-api.js` : `--dist`,
      réglages d'expérience ;
    - `README.md`.
- Preuves : `docs/architecture/phase-1-20a-evidence/`,
  `docs/architecture/phase-1-20b-evidence/`.
