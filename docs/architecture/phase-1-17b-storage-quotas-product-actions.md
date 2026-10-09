# Lot 1-17B — Quotas de stockage, photo d'un produit existant, « Vendre » depuis la carte produit

État : **implémenté et complété, non commité** sur
`feature/phase-1-17b-storage-quotas-product-actions` (créée depuis
`architecture/phase-1-16h-stock-master-brand-cleanup`, HEAD `f4e6736`,
`stash@{0}` conservé). Aucun commit, push ni déploiement. Aucun service
réel, secret ni donnée de production touché ; aucun `.env` lu. **Aucune
commande de migration ou de réconciliation exécutée en production ; aucune
opération 1-17B exécutée sur R2.**

Périmètre (validé avec l'utilisateur) : le « modal de détail » visé est la
**carte produit** de `/app/catalog/[id]` : « Vendre » sous « Modifier »,
et aussi hors connexion.

## 1. Changements

**API** (`api/src/storage-quota/`, nouveau module)

- `storage_objects` : registre, une entrée par fichier (`_id` déterministe
  `stockage::clé`, organisation, type `product_image|logo`, octets, état,
  échéance, origine `upload|initialization|reconciliation`).
  `storage_usages` : compteur par organisation (`_id` = organisation ;
  aucune migration d'index).
- `StorageQuotaService` : réservation, envoi, rattachement, libération,
  reprise, recalcul, initialisation, **inventaire du stockage**, **entrées
  orphelines**. `GET /organizations/current/storage` (lecture seule ;
  `products.manage`, `branding.manage` **ou** `trash.manage` ; organisation
  du contexte ; jamais de clé).
- Photos produit et logos passent par ce service ; validation d'image
  existante (5 Mio, Sharp) inchangée, avant la réservation.
- Écritures de référence transactionnelles et conditionnelles : création +
  rattachement ; remplacement conditionné à la photo lue + rattachement de
  la nouvelle + détachement de l'ancienne ; logo par `$set` conditionné au
  logo lu ; purge : détachement dans sa transaction. Conflit → 409
  `PRODUCT_IMAGE_CONFLICT` / `LOGO_CONFLICT`.
- `S3Service` : clé imposée (`newObjectKey`, préfixe exact), `abortSignal`,
  `headStoredObject` (`HeadObject`), `listStoredObjects` (`ListObjectsV2`,
  préfixe `organizations/` obligatoire, échec si une taille manque).
- Codes : 413 `STORAGE_QUOTA_EXCEEDED`, 503 `STORAGE_UPLOAD_INTERRUPTED`,
  409 `PRODUCT_IMAGE_CONFLICT`, `LOGO_CONFLICT` ; messages FR/EN.
- Traitements de fond (`main.ts` uniquement) : reprise ; inventaire
  **seulement en mode `enforce`**.
- CLI opérateur `storage:quota` (§4).

**Web** : fenêtre « Modifier le produit » avec photo (sélection, aperçu,
annulation, chargement, erreurs dans la fenêtre, hors connexion : envoi
impossible, expliqué) ; « Vendre » sur la carte produit (parcours de vente
existant, produit présélectionné, focus rendu, anti-double soumission) et
sur la carte hors ligne (annulation depuis le détail → retour au détail) ;
Paramètres → Stockage (utilisé, limite, envois en cours, alertes),
actualisé après envoi, remplacement, purge, logo, et par les signaux temps
réel existants ; textes FR/EN.

## 2. Comptabilisation et récupération

| Étape | Registre | Compteur |
|---|---|---|
| Réservation (transaction ; incrément **conditionnel** `stockés + réservés + taille ≤ quota` sur le document unique de l'organisation) | `reserved` | réservés + n |
| Envoi (hors transaction ; annulation SDK à TTL/3) | — | — |
| Fin d'envoi (transaction) | `uploaded` | réservés − n, stockés + n |
| Écriture de la référence (transaction de l'appelant) | `attached` ; ancienne → `deleting` | — |
| Suppression **confirmée** puis transaction | entrée supprimée | stockés − n |

- Taille comptée = octets envoyés (`body.length`, serveur).
- Concurrence : le compteur est le point d'écriture unique (deux envois pour
  la dernière place → un seul). Toute transition est conditionnelle à
  l'état attendu : ni double comptage ni double libération.
- Remplacement : coexistence des deux fichiers comptée ; l'ancien n'est
  libéré qu'après sa suppression. Corbeille : rien n'est libéré.

### 2.1 Envoi échoué, annulé ou arrivé tardivement (complément)

- **Ni une erreur ni une annulation côté SDK, ni une absence constatée à un
  instant donné ne prouvent qu'un envoi en vol n'aboutira pas.**
  Désormais, un envoi échoué ou annulé **reste réservé et compté** (nouvelle
  échéance) ; une suppression est tentée immédiatement (objet déjà arrivé),
  et la reprise ne libère qu'après l'échéance, sur suppression confirmée.
- Filet durable : **inventaire du stockage** (`reconcileInventory`). Il
  liste le stockage COURANT sous `organizations/<id>/products|branding/`
  (préfixe exact ; clé hors schéma → `foreign_key`, jamais touchée) et
  retrouve tout fichier présent **sans entrée au registre** : envoi arrivé
  après la reprise de sa réservation, processus arrêté entre-temps, fichier
  écrit par un code antérieur. L'état de référence étant le stockage
  lui-même, il est retrouvé après tout redémarrage. Chaque fichier non
  suivi est **compté immédiatement** (taille du stockage), dans une
  transaction qui relit et verrouille sa référence : référencé →
  `attached` (jamais supprimé) ; sinon → `deleting`, supprimé après un délai
  de grâce (dernière modification + durée de réservation) par la reprise,
  qui **revérifie la référence** avant de supprimer ; octets libérés
  seulement sur suppression confirmée. Un fichier arrivé encore plus tard
  est retrouvé à la passe d'inventaire réussie suivante (délai non garanti :
  voir §8).
- Fréquence : `STORAGE_INVENTORY_INTERVAL_SECONDS` (6 h par défaut) **en
  mode `enforce` uniquement**, et CLI `inventory` à tout moment. En mode
  `track` (initialisation, retour après rollback), rien n'est supprimé
  automatiquement avant la revue de l'opérateur.

### 2.2 Concurrence initialisation / détachement ; entrées orphelines

- **Verrou de référence** : l'initialisation et l'inventaire relisent la
  référence par une **écriture** du document référent (`$inc __v`, sans
  horodatage) dans leur transaction. Un détachement concurrent (remplacement,
  purge, retrait du logo) écrit ce même document : conflit d'écriture, il
  est rejoué **après** le comptage et détache donc l'entrée. Plus d'entrée
  `attached` créée pour un fichier en cours de détachement.
- **Entrées `attached` sans référence** (référence retirée par un code
  antérieur ou une écriture directe) : détection en diagnostic ;
  récupération explicite et relançable (`orphans --apply`) : en
  transaction, état et référence relus (toujours absente) → `deleting` ;
  puis la reprise revérifie la référence, supprime et libère **seulement**
  sur suppression confirmée (suppression idempotente : absence confirmée) ;
  sinon nouvelle échéance, octets toujours comptés. Une référence revenue
  entre la détection et l'écriture conserve l'entrée.

## 3. Variables (service API)

| Variable | Défaut | Rôle |
|---|---|---|
| `STORAGE_QUOTA_BYTES` | `250000000` | Quota par organisation (octets) |
| `STORAGE_QUOTA_MODE` | `enforce` | `enforce` bloque ; `track` comptabilise sans bloquer et désactive l'inventaire automatique |
| `STORAGE_RESERVATION_TTL_SECONDS` | `900` | 60–3600 ; annulation SDK à TTL/3 ; échéance des réservations et délai de grâce de l'inventaire |
| `STORAGE_RECOVERY_INTERVAL_SECONDS` | `600` | 60–86400, `0` = désactivée |
| `STORAGE_INVENTORY_INTERVAL_SECONDS` | `21600` | 300–604800, `0` = désactivé ; mode `enforce` seulement |

Valeur invalide → refus au démarrage. Documentées dans `api/README.md`,
`api/.env.example`, transmises par `docker-compose.prod.yml`.

## 4. Procédure opérateur — commandes exactes

**Depuis la racine du dépôt**, après `pnpm --filter api build`, dans un
shell où l'environnement du service API est **exporté explicitement** :
`MONGODB_URI`, `JWT_SECRET`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`,
`S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_FORCE_PATH_STYLE`, et les `STORAGE_*`
du service. La CLI refuse de démarrer si `MONGODB_URI` ou une variable
`S3_*` manque (jamais complétée par un `.env`).

Forme recommandée (codes de sortie exacts ; la racine du dépôt n'a pas de
`.env`) :

```bash
node api/dist/migrations/storage-quota.js diagnose
node api/dist/migrations/storage-quota.js initialize --apply
node api/dist/migrations/storage-quota.js inventory            # lecture seule
node api/dist/migrations/storage-quota.js inventory --apply
node api/dist/migrations/storage-quota.js orphans              # lecture seule
node api/dist/migrations/storage-quota.js orphans --apply
node api/dist/migrations/storage-quota.js recover              # lecture seule
node api/dist/migrations/storage-quota.js recover --apply
node api/dist/migrations/storage-quota.js recompute            # lecture seule
node api/dist/migrations/storage-quota.js recompute --apply
# option de chaque commande : --organization=<id> ; recover : --limit=<n>
```

Équivalent `pnpm --filter api storage:quota <commande> [options]` (vérifié
depuis la racine) : `pnpm` renvoie 1 pour tout échec et affiche le vrai
code (« Exit status N ») ; il s'exécute dans `api/`.

Règles : **sans `--apply`, aucune commande n'écrit** (ni MongoDB ni
stockage) ; `diagnose` refuse `--apply`. Sorties : 0 = rien à faire,
3 = action nécessaire (détail JSON : identifiants d'organisation, comptages,
octets ; jamais de clé ni d'URL), 2 = arguments, 1 = erreur (stockage
injoignable, inventaire incomplet : rien n'est écrit).

- `diagnose` : initialisation (références + `HeadObject`), inventaire
  (`ListObjectsV2`), entrées orphelines, cohérence compteurs/registre.
- `recover` **est un état des lieux** : entrées réservées, envoyées ou à
  supprimer, échues ou non, avec leurs octets, la prochaine échéance et le
  nombre maximal de tentatives ; sortie 3 s'il existe des entrées échues ;
  aucune écriture. **`recover --apply` effectue la reprise** (rattachement
  ou suppression puis libération sur suppression confirmée) ; sortie 3 s'il
  reste des entrées à reprendre (suppression encore en échec).
- `recompute` **est un diagnostic** : il compare le compteur au registre et
  sort en 3 en cas d'écart, sans écrire. **`recompute --apply` est
  nécessaire pour écrire** (reconstruction du compteur depuis le registre,
  en transaction). Il ne remplace ni `inventory` ni `orphans` (il ne lit pas
  le stockage).

## 5. Ordre de déploiement

1. Variables du service : `STORAGE_QUOTA_MODE=track` (autres : défauts).
2. Déployer ce lot (collections créées à l'usage ; aucune migration
   d'index). En `track`, pas d'inventaire automatique.
3. **Essai R2 1-17B** (§7) avec `api/test/storage/r2-operator-trial.js`.
4. `diagnose` ; examiner `unknown_size`, `bad_prefix`, `other_storage`,
   `foreign_key`, fichiers non suivis, orphelins, `overQuota`.
5. `initialize --apply` (relancer jusqu'à `complete: true`), puis
   `inventory --apply`, `orphans --apply` ; après le délai de grâce,
   `recover` (état des lieux) puis `recover --apply` (ou laisser la reprise
   automatique de l'API) ; `recompute` doit sortir en 0
   (sinon `recompute --apply`) ; `diagnose` doit sortir en 0.
6. `STORAGE_QUOTA_MODE=enforce`, redémarrer (inventaire automatique actif).
   Une organisation déjà au-delà du quota garde fichiers et ventes ; seuls
   ses nouveaux envois sont refusés.

### 5.1 Retour arrière puis retour au nouveau code

Pendant un retour arrière, l'ancien code ajoute, remplace ou supprime des
fichiers **sans mettre à jour le registre** : fichiers non suivis
(nouveaux), entrées `attached` sans référence (remplacées ou purgées), et
compteur alors faux. Avant de réactiver `enforce` :

1. Redéployer le nouveau code avec `STORAGE_QUOTA_MODE=track` ; **aucune
   instance de l'ancien code ne doit rester active** (déploiement
   terminé).
2. `diagnose`, puis `inventory --apply` (fichiers ajoutés par l'ancien
   code : comptés, rattachés s'ils sont référencés) et `orphans --apply`
   (fichiers remplacés ou supprimés par l'ancien code : supprimés si
   présents, libérés sur suppression confirmée).
3. Après le délai de grâce : `recover`, puis `recover --apply` ;
   `recompute` (0 attendu, sinon `recompute --apply`) ; `diagnose` en 0.
4. Seulement alors `STORAGE_QUOTA_MODE=enforce`.

Les collections `storage_objects`/`storage_usages` sont ignorées par
l'ancien code et peuvent rester ; les photos et logos restent lisibles.

## 6. Vérifications (simulées, aucun service réel)

| Contrôle | Résultat |
|---|---|
| Unitaires API, commande CI isolée — passe complète du lot | 86/86 suites, 1624/1624 |
| Unitaires API ciblés après complément (quotas, S3, produits, organisations, i18n) | 22/22 suites, **445/445** |
| E2E ciblés après complément : `storage-quota` (15), **`storage-reconciliation` (5, nouveau)**, branding, purge | 4/4, **109/109** |
| Envoi retardé → reprise (absent à cet instant, libéré) → **arrivée tardive** → arrêt du processus → **redémarrage** (nouvelle instance, même base, même stockage) → inventaire : diagnostic sans écriture, puis fichier compté aussitôt, supprimé après le délai de grâce, octets libérés ; fichier référencé intact ; relance sans double comptage ; compteurs cohérents | réussi (déterministe : barrière jamais levée, horloge du service imposée) |
| Envoi annulé après arrivée du corps : réservation comptée jusqu'à l'échéance, libérée par la reprise | réussi |
| Fichier non suivi **référencé** (ancien code) : compté `attached`, jamais supprimé ; clé hors schéma ignorée ; pagination de l'inventaire | réussi |
| Détachement **concurrent** à l'initialisation (barrière dans la transaction, purge lancée pendant le verrou) : purge rejouée après le comptage, aucune entrée orpheline, octets libérés une fois | réussi ; **témoin** : même test avec une simple lecture de la référence → entrée orpheline restante (échec), puis code restauré |
| Orphelins : détection sans écriture ; référence revenue pendant la récupération → conservée ; récupération (absence confirmée) → libérés ; relance sans effet ; fichier de l'ancien code retrouvé par l'inventaire | réussi |
| Activation automatique : reprise et inventaire en `enforce` ; aucun inventaire en `track` ou à `0` (minuteries simulées) | réussi |
| CLI sur MongoDB éphémère + stockage simulé joignable : `diagnose` 3 → `inventory --apply` 0 → `diagnose` 0 ; `recompute` 0 ; aucune clé en sortie | réussi |
| CLI `recover` sans `--apply` (échéance dépassée) : sortie 3, 1 entrée échue, **registre inchangé** ; puis `recover --apply` : libérée, sortie 0 ; e2e : état des lieux avant/après échéance, registre et compteur inchangés | réussi |
| CLI, stockage injoignable : `diagnose`/`inventory` sortie 1, aucune collection créée ; variable `S3_*` absente → refus | réussi |
| `pnpm --filter api storage:quota …` depuis la racine (arguments avec et sans `--`) | arguments transmis ; code « Exit status N » |
| `r2-operator-trial.js` étendu, contre le stockage simulé (mécanique seulement) | **17/17** |
| `tsc -p tsconfig.build.json`, `nest build`, ESLint API | 0 erreur (2 avertissements préexistants) |
| Passe complète du lot (inchangée par le complément, côté web) : contrôle navigateur 37/37, RT7/RT18/RT19/RT22 4/4, build web isolé `ok: true` | voir 1re passe |

## 7. R2 : déjà vérifié vs à vérifier

**Vérifié sur R2 réel (lot 1-17A, essai opérateur 11/11)** : `PutObject`
(sommes de contrôle par défaut), lecture par URL signée, refus sans
signature / clé modifiée / lien expiré, `DeleteObject` puis 404,
adressage virtual-hosted, `S3_REGION=auto`.

**Nouveau en 1-17B, jamais exécuté sur R2** (vérifié seulement contre le
stockage simulé) :

- `HeadObject` signé par en-tête (taille ; 404 → absence) ;
- `ListObjectsV2` sous `organizations/` (droits du jeton R2 sur la liste,
  pagination, `Size`, `LastModified`) ;
- `PutObject` avec `abortSignal` (annulation) ;
- `DeleteObject` d'une clé **déjà absente** → succès (idempotence sur
  laquelle repose « absence confirmée ») ;
- clé imposée par le serveur avant l'envoi.

L'essai opérateur `api/test/storage/r2-operator-trial.js` couvre désormais
ces points (étapes « 1-17B ») ; à rejouer sur R2 (même commande que 1-17A,
§7 du rapport 1-17A) **avant** l'étape 6 du §5.

## 8. Limites restantes

- Production non initialisée : jusqu'à l'étape 5, l'occupation affichée
  ignore les fichiers existants. Opérations 1-17B non vérifiées sur R2
  (§7) ; Docker/MinIO non exercés.
- **Délai de prise en compte d'un fichier arrivé tardivement : non
  garanti.** Ce fichier n'est compté qu'à la prochaine passe d'inventaire
  **réussie**. `STORAGE_INVENTORY_INTERVAL_SECONDS` (6 h par défaut) n'est
  qu'une période nominale, qui suppose : API démarrée et active en continu
  (la minuterie repart à chaque redémarrage, la première passe a lieu une
  période après le démarrage), mode `enforce`, et inventaire terminé sans
  erreur. Une passe échouée (R2 injoignable, droit de liste manquant,
  limitation, taille absente) n'écrit rien, est journalisée
  (« Inventaire du stockage impossible ») et n'est retentée qu'à la période
  suivante ; tant que l'API est arrêtée, en mode `track`, ou que les erreurs
  persistent, le délai n'est pas borné. Le fichier n'est jamais perdu (il
  reste dans le stockage et sera retrouvé), mais l'occupation est sous-
  estimée d'autant pendant ce temps. Après un incident (panne de l'API ou
  de R2, redéploiement), l'opérateur lance `inventory` puis, si besoin,
  `inventory --apply` ; une surveillance de ce message dans les journaux
  est recommandée (aucune alerte automatique n'est fournie).
- La reprise automatique dépend des mêmes conditions (API active, R2
  joignable) : tant qu'elle n'aboutit pas, les octets restent comptés
  (sur-estimation, jamais de libération sans suppression confirmée) ;
  `recover` montre les entrées échues et `recover --apply` les traite.
- L'inventaire liste tout le préfixe `organizations/` : coût proportionnel
  au nombre de fichiers (une page de 1000 par appel) ; à surveiller si le
  volume croît.
- Un code qui référencerait une clé existante sans passer par le registre
  (ancien code pendant un déploiement mixte) est protégé par le délai de
  grâce et la nouvelle vérification avant suppression, pas par un verrou :
  ne lancer `inventory --apply`/`orphans --apply` qu'une fois l'ancien code
  arrêté.
- Changement de stockage (bucket/compte) : les entrées de l'ancien stockage
  restent comptées et ne sont ni inventoriées ni supprimées.
- Quota unique pour toutes les organisations.
- `api/README.md` et `storage-sim.js` n'étaient déjà pas au format Prettier
  (seules les lignes ajoutées le sont) ; erreurs de type préexistantes dans
  certaines specs hors `tsconfig.build.json`.

## 9. Fichiers

API : `src/storage-quota/` (module, service, contrôleur, configuration,
préfixes, traitements de fond, schémas, spec), `src/migrations/storage-quota.ts`,
`src/s3/s3.service.ts` (+ spec), `src/products/products.controller.ts`,
`products.service.ts`, `products.module.ts` (+ specs),
`src/organizations/organization-branding.controller.ts`,
`organizations.service.ts`, `organizations.module.ts` (+ specs),
`src/common/i18n/error-messages.ts`, `src/app.module.ts`, `src/main.ts`,
`package.json`, `test/storage-quota.e2e-spec.ts`,
`test/storage-reconciliation.e2e-spec.ts`,
`test/organization-branding.e2e-spec.ts`, `test/recipe/recipe-common.js`,
`test/recipe/storage-sim.js`, `test/storage/r2-operator-trial.js`,
`README.md`, `.env.example` ; racine : `docker-compose.prod.yml`.

Web : `app/app/organization/storage/page.tsx`, `organization/layout.tsx`,
`organization/branding/page.tsx`, `app/app/catalog/[id]/page.tsx`,
`components/products/update-product-dialog.tsx`, `product-card.tsx`,
`offline-product-card.tsx`, `record-sale-dialog.tsx`,
`components/catalog/offline-catalog-browser.tsx`, `hooks/use-products.ts`,
`hooks/use-trash.ts`, `lib/api.ts`, `lib/storage-usage.ts`,
`lib/organization-permissions.ts`, ressources i18n FR/EN (`catalog`,
`common`, `organization`).

Documentation : ce rapport.
