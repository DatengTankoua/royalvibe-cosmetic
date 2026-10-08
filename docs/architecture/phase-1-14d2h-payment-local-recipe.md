# Phase 1-14D.2H — Recette locale reproductible des paiements et du rapprochement

Branche : `architecture/phase-1-14d2h-payment-local-recipe`
Base : **`1d19b6404ecad3ba8fe92d7b4d1efb143e585d79`** (« feat(api): add audited
subscription payment reconciliation CLI », 1-14D.2G), branche
`architecture/phase-1-14d2g-payment-reconciliation-cli` à jour avec
`origin`. Au départ, l'arbre et l'index étaient propres. Le stash
`stash@{0}` (sauvegarde lint-staged) est préservé.

Rapports lus : [1-14D.2C](phase-1-14d2c-owner-payment-ui.md) (interface,
15 scénarios), [1-14D.2D](phase-1-14d2d-campay-adapter.md),
[1-14D.2E](phase-1-14d2e-proxy-client-ip.md),
[1-14D.2E.1](phase-1-14d2e1-railway-proxy-validation.md),
[1-14D.2F](phase-1-14d2f-campay-webhook.md),
[1-14D.2G](phase-1-14d2g-payment-reconciliation-cli.md).

Ce lot ne contient aucun commit, push ni déploiement. Il ne fait aucun appel
CamPay réel, ne consulte pas la base de l'incident D.2G et ne charge aucun
`.env` réel (build web dans une copie isolée sans `.env*`, garde pour les
autres processus ; preuves par canaris, § 3). Il n'ajoute aucune dépendance et ne
modifie pas le lockfile. **Aucun fichier de production n'est modifié** : le
lot n'ajoute que de l'outillage de test et de la documentation. Le fournisseur de
production reste `UnavailablePaymentProvider` et le webhook reste désactivé.

> **Portée.** Cette recette ne valide **ni la compatibilité avec CamPay ni
> le comportement derrière Railway**. Le faux CamPay reprend les formes
> documentées en D.2D et D.2F ; il ne prouve ni les réponses réelles, ni
> les claims de signature, ni les reprises. La stack locale n'a ni edge ni
> proxy.

> **Complément d'isolement du build web.** La première version buildait et
> servait le web **dans `web/`** : la garde JavaScript et
> `__NEXT_PROCESSED_ENV` y empêchaient l'**application** des `.env*`, sans
> prouver l'absence de **lecture** par le binaire natif. Le build et le
> serveur s'exécutent désormais dans une **copie isolée qui ne contient aucun
> `.env*`** ; `web/.next` n'est plus touché. Les preuves sont au § 3, la
> nouvelle campagne au § 4.1.

---

## 1. Outillage conservé

### 1.1 Artefacts D.2C retrouvés (aucune reconstruction)

Les artefacts temporaires de D.2C existaient encore, intacts, dans le
scratchpad d'une session antérieure (`…/2895e294-…/scratchpad/pw14d2c/`) :
`stack.js`, `boot-api.js`, `lib.js`, `scenarios.js` (725 lignes, 15 cas),
`results-all.json`. Les scénarios ont été **repris tels quels** ; seules
leurs dépendances d'environnement ont été adaptées (URLs, pilotage du
simulateur, chemins). Les assertions sont inchangées.

Points faibles du harnais D.2C, corrigés dans l'outillage livré :

| D.2C (temporaire) | 1-14D.2H (dépôt) |
|---|---|
| Environnements enfants `{ ...process.env, … }` | Construits variable par variable (liste blanche système + valeurs fictives) |
| `next build` / `next start` dans `web/` : `web/.env.local` pouvait être appliqué | Copie isolée sans aucun `.env*`, plus la garde et `__NEXT_PROCESSED_ENV` en défense supplémentaire (§ 3) |
| Build écrivant dans `web/.next` | `web/.next` jamais touché (empreinte identique avant et après) |
| `autoIndex` / `autoCreate` actifs dans l'API de test | Neutralisés avant tout contexte ; index des fixtures créés explicitement |
| Web écoutant sur toutes les interfaces | `next start -H 127.0.0.1` ; tout sur la boucle locale |
| Chemins absolus codés en dur | Relatifs au dépôt ; Playwright passé en argument |

### 1.2 Playwright

Vérifié avant réutilisation, sans aucune installation : **Playwright
1.63.0** déjà présent hors dépôt
(`…/9088b56a-…/scratchpad/pw/node_modules/playwright`, le même que D.2C),
et **Chromium révision 1234** dans `%LOCALAPPDATA%\ms-playwright`.
Playwright 1.63.0 attend la révision 1243, absente. Comme en D.2C, le
Chromium 1234 existant est désigné explicitement (`--chromium=`). Sans
Playwright ou Chromium, la commande `scenarios` répond « AUCUNE campagne
exécutée » (code 3, vérifié).

## 2. Architecture

```
recipe.js start ──► launcher.js (127.0.0.1)
  1. contrôles : api/dist complet, ports 3200/4200/4299 libres, aucune recette en cours
  2. copie isolée <dépôt>/.stockmaster-recipe-web (aucun .env*, node_modules = jonction)
     puis next build dans la copie (env construit, garde)      → <copie>/.next
  3. MongoMemoryReplSet 8.2.6, 127.0.0.1:<aléatoire>, base stockmaster_recipe
  4. 4 migrations compilées (dist/migrations/*)                → index de production
  5. seed-fixtures.js : collections + index autoIndex de prod, comptes fictifs
  6. serveur de contrôle 127.0.0.1:4299 : simulateurs (état partagé)
       ├─ /sim/provider/*  prestataire simulé (contrat D.2C)
       ├─ /campay/api/*    faux CamPay (token, collect, transaction)
       └─ /sim/*, /api/restart, /stop, /state
  7. boot-api.js (entrée de TEST) : dist/AppModule + overrideProvider   127.0.0.1:4200
  8. next start -H 127.0.0.1 -p 3200 (dans la copie)
```

| Fichier (`api/test/recipe/`) | Rôle |
|---|---|
| `recipe.js` | Point d'entrée : démarrage, pilotage, webhook, CLI, campagne |
| `launcher.js` | Stack, serveur de contrôle, nettoyage |
| `recipe-common.js` | Constantes fictives, environnements construits, garde d'URI |
| `web-copy.js` | Copie isolée des sources web (aucun `.env*`) |
| `web-canary.js` | Vérification par canaris du vrai build et du vrai serveur |
| `env-guard.cjs`, `preload.cjs` | Garde anti-`.env` ; chien de garde du lanceur |
| `boot-api.js` | Entrée de test de l'API : **seul** lieu d'injection des prestataires simulés |
| `simulators.js` | Prestataire simulé et faux CamPay |
| `seed-fixtures.js`, `fixtures.js` | Peuplement explicite ; comptes fictifs |
| `reconcile-sim.js` | Rapprochement **simulé** (entrée de test séparée) |
| `actions.js`, `db-tools.js` | Inscription, webhook signé, CLI ; lectures et écritures de test |
| `lib.js`, `scenarios.js` | Campagne Playwright (15 cas D.2C + W1, R1, R2) |
| `README.md` | Procédure manuelle |

L'outillage est en JavaScript, comme le précédent `api/test/proxy/`
(D.2E.1). Il s'exécute directement sur `dist/`. Il n'est pas compilé
(`tsconfig.build.json` exclut `test/`) et aucun runner Jest ne le collecte
(`--listTests` : 0 fichier, unitaires et e2e).

### 2.1 Deux fournisseurs, injectés depuis l'entrée de test uniquement

`boot-api.js` réplique `src/main.ts` sur `dist/` (options de bootstrap,
trust proxy, CORS strict, pipes, filtre global). Il applique ses
remplacements par `overrideProvider` selon `RECIPE_PROVIDER`, variable que
**seul ce fichier lit** :

- **`simulated`** : prestataire simulé au contrat D.2C, nécessaire aux 15
  scénarios (`reject`, `lost`, recherche par référence marchand). Son état
  vit dans le lanceur et l'adaptateur de l'API l'appelle en HTTP local ;
- **`campay`** : le **vrai** `CamPayPaymentProvider` et le **vrai**
  `fetchCamPayTransport` (redirections refusées, annulation,
  classification des échecs). Seule l'origine officielle de démonstration
  est réécrite vers `127.0.0.1:4299/campay` ; toute autre URL est refusée.
  Le webhook est activé avec une **clé fictive**
  (`CAMPAY_WEBHOOK_CONFIG`). Les références sont des UUID, ce qui permet le
  webhook et le rapprochement.

Aucun binaire de production ne contient ces remplacements :
`grep -rlE "RECIPE_PROVIDER|stockmaster-recipe|recipe-14d2h" api/dist`
renvoie 0 fichier. `main.ts` est inchangé, et le vrai CLI lancé sur la base
de recette reste bloqué (§ 4, R1).

### 2.2 Cible MongoDB

L'URI vient **exclusivement** de l'instance créée par le lanceur. Elle est
transmise aux enfants par l'environnement construit et revalidée par chacun
(`assertRecipeUri` : hôte local, port ≠ 27017, base `stockmaster_recipe`,
sans identifiants). Les commandes du terminal 2 la relisent dans
`state.json`, mais seulement si le PID du lanceur est vivant.

### 2.3 Aucune écriture implicite

- `boot-api.js`, `seed-fixtures.js` et `reconcile-sim.js` appellent
  `disableImplicitSchemaWrites()` (fonction **compilée** du CLI D.2G)
  **avant** de charger `AppModule`. Ils vérifient ensuite que l'instance
  Mongoose de `@nestjs/mongoose` a bien `autoIndex = autoCreate = false`.
- Écritures avant les actions de recette : les **4 migrations** (index des
  ventes, périodes, paiements, audits de rapprochement), puis les
  **fixtures**. Celles-ci créent les 8 collections absentes (`auditlogs`,
  `organizationinvitations`, `organizationmemberships`, `organizations`,
  `products`, `sales`, `sections`, `users`) et **leurs index déclarés**,
  que la production confie à `autoIndex` (par exemple l'unicité des
  e-mails). Elles créent ensuite les comptes par les **services réels**
  (`AuthService.register`, `EmailVerificationService.confirm`,
  `OrganizationsService.createInvitation`, `AuthService.acceptInvitation`)
  et expirent explicitement les commerces concernés.
- L'API tourne en `NODE_ENV=production`. Ses vérifications d'index de
  production passent donc au démarrage, ce qui confirme les migrations.

### 2.4 Boucle locale et nettoyage

Écoutes relevées pendant la recette : `127.0.0.1:3200`, `:4200`, `:4299`
et le port MongoDB, **aucune autre interface**. Le serveur de contrôle
refuse toute requête portant un en-tête `Origin` ou un `Host` inattendu :
aucune page web ne peut le piloter.

Le nettoyage s'exécute après un arrêt demandé, une erreur ou un signal
(`SIGINT`, `SIGTERM`, `SIGHUP`, `SIGBREAK`). Il arrête **les seuls
processus lancés** et leurs descendants (`taskkill /T` sous Windows,
groupe de processus ailleurs), puis l'instance MongoDB avec suppression des
données. Il efface ensuite le répertoire d'état et la copie web isolée,
dont la jonction `node_modules` est retirée sans en suivre la cible. Un
chien de garde préchargé dans chaque enfant le fait sortir si le lanceur
disparaît. Une copie laissée par un arrêt brutal est supprimée au démarrage
suivant.

## 3. Aucun `.env` réel

Fichiers présents (noms seulement, contenus **non lus**) : `api/.env`,
`api/.env.local`, `web/.env.local`, `web/.env.development.local`,
`.env.prod` (racine).

### 3.1 Chemins de chargement de la version installée

Analyse de **Next.js 16.3.6**, celle qu'utilise `web/` (paquet
`next@16.3.6`, binaire natif `@next/swc-win32-x64-msvc@16.3.6`, 106 Mo,
résolu depuis ce paquet) :

| Chemin | Constat |
|---|---|
| `next build` (`dist/build/index.js`) | `loadEnvConfig(dir, false)` de `@next/env` sur le **dossier du projet** : `.env.production.local`, `.env.local`, `.env.production`, `.env` |
| `next start` (`next-server.js`, `server/config.js`, `server.runtime.prod.js`) | Même chargeur, même dossier |
| `export/index.js`, `app-info-log.js` | Même chargeur (le second : liste des fichiers, sans rechargement forcé) |
| Turbopack (`build/turbopack-build/impl.js`) | Le projet natif reçoit `env: process.env` depuis le JavaScript |
| **Binaire natif** | Il contient un **lecteur dotenv natif** : `turbo_tasks_env::dotenv::DotenvProcessEnv` (`read_all`, `read_prior`, message « unable to read … for env vars »), crate `dotenvs-0.1.0`. Aucune chaîne `.env.local`, `.env.production` ou `.env.development` n'y figure |

Conclusion : le seul chargeur observable est `@next/env`, sur le dossier du
projet. Mais le binaire embarque un lecteur natif, **hors de portée de la
garde JavaScript**, dont l'inutilisation par `next build` ne peut pas être
démontrée par analyse statique. `__NEXT_PROCESSED_ENV` et l'absence de ligne
« Environments » ne prouvent donc rien sur les lectures natives.

### 3.2 Mesure retenue : copie isolée

`web-copy.js` prépare `<dépôt>/.stockmaster-recipe-web` :

- **liste fermée** d'entrées de premier niveau : `src`, `public`,
  `package.json`, `next.config.ts`, `next-env.d.ts`, `tsconfig.json`,
  `postcss.config.mjs` ;
- copie récursive où **chaque nom est testé avant toute opération** :
  `/^\.env($|\.)/i` écarté (ni ouvert, ni `stat`, ni copié) ; `node_modules`
  et `.next` jamais copiés ;
- `node_modules` est une **jonction** vers `web/node_modules`, sans
  installation ;
- contrôle final : un `.env*` présent dans la copie fait échouer le
  démarrage.

Le build et `next start` ont la copie pour répertoire. **Aucun processus
Next de la recette n'a `web/` pour répertoire** : `web/.next` n'est plus
écrit. La garde et `__NEXT_PROCESSED_ENV` restent en défense
supplémentaire.

Contraintes vérifiées par l'expérience lors de la conception :

| Essai | Résultat |
|---|---|
| Copie dans `%TEMP%` (hors dépôt) | **Refus de Turbopack** : « Symlink [project]/node_modules is invalid, it points out of the filesystem root ». La racine Turbopack est le workspace pnpm (le dépôt) |
| Copie dans un dossier **ignoré** par Git (`build/`) | Build réussi mais **non fidèle** : 3,8 min au lieu de ~30 s, et CSS Tailwind de 221 Ko au lieu de 64 Ko, répartie sur 2 fichiers. L'analyse automatique des sources de Tailwind se comporte autrement dans un chemin ignoré |
| Copie **non ignorée** à la racine du dépôt | Build en 35 s ; CSS **identique** à celle d'un build dans `web/` (`2k1_bjhjdz6px.css`, 64 307 octets) ; 56 fichiers statiques dans les deux cas. Les chunks JS ne diffèrent que par leurs hachages, qui dépendent du chemin des modules (`[project]/.stockmaster-recipe-web/…` au lieu de `[project]/web/…`) |

D'où l'emplacement retenu : non ignoré, visible dans `git status` pendant la
recette, supprimé au nettoyage. La capture mobile de la nouvelle campagne
montre un rendu normalement stylé.

### 3.3 Vérification par canaris du vrai build et du vrai serveur

`recipe.js web-canary-check` (`web-canary.js`) exécute pour chaque cas un
**vrai** `next build`, puis un **vrai** `next start` (127.0.0.1:3299).
Chaque cas part d'une copie des sources, à laquelle s'ajoutent :

- cinq `.env*` **fictifs** (`.env`, `.env.local`, `.env.production`,
  `.env.production.local`, `.env.development.local`), chacun avec ses
  propres marqueurs `NEXT_PUBLIC_RECIPE_CANARY_*` et `RECIPE_CANARY_*` ;
- une page statique de sonde (prérendue au build) et une route dynamique
  (lue à l'exécution), présentes dans la copie temporaire seulement.

Les marqueurs sont recherchés en binaire dans **tout `.next`** et dans les
réponses HTTP.

| Cas | `.env*` dans le dossier de build | Valeurs appliquées (build, page servie, route à l'exécution) | Tentatives JS (garde) | Résultat |
|---|---|---|---|---|
| **T1 témoin** : aucune protection | 5 canaris | **Oui** pour `.env`, `.env.local`, `.env.production`, `.env.production.local`, dans les quatre observations ; non pour `.env.development.local` (attendu en production) ; Next affiche « Environments: .env.production.local, .env.local, .env.production, .env » | — | ✅ le contrôle **détecte** un chargement |
| **T2** : garde + `__NEXT_PROCESSED_ENV` (configuration de la campagne initiale) | 5 canaris | **Aucune** | `statSync` des 4 noms de production, bloqués | ✅ non-application prouvée ; **non-lecture native non prouvée** |
| **T3** : copie isolée + garde (configuration actuelle du lanceur) | **aucun** (5 écartés par la copie) | **Aucune** | `statSync` des 4 noms, sur des fichiers absents | ✅ |
| **T4** : copie isolée seule, sans garde ni `__NEXT_PROCESSED_ENV` | **aucun** | **Aucune** | — | ✅ l'isolement suffit à lui seul |

Dans tous les cas, aucun nom standard (`.env`, `.env.local`,
`.env.production`, `.env.production.local`, `.env.development.local`) ne
figure dans les **ancêtres** du dossier de build : racine du dépôt,
`Downloads`, profil utilisateur, `C:\`. Ce sont des noms relevés par listing,
sans lecture. Résultat global : `pass: true`, code 0.

**Absence d'application et absence de lecture.**

- **Absence d'application** : prouvée dans T2, T3 et T4 par les marqueurs,
  le témoin T1 montrant que le contrôle détecte un chargement réel.
- **Absence de lecture** : prouvée **par construction** dans T3, T4 et le
  lanceur. Les fichiers n'existent ni dans le dossier du projet, ni dans ses
  ancêtres ; aucun chargeur, JavaScript ou natif, ne peut donc lire un
  `.env*` réel depuis le build ou le serveur. La copie écarte les `.env*`
  réels de `web/` sur leur nom, avant toute ouverture.
- T2 ne prouve que l'absence d'application.

### 3.4 Pendant la recette

- Journal de la garde (session avec la copie isolée) : `statSync` des
  4 noms de production **dans `.stockmaster-recipe-web`** (×3 : build,
  worker, serveur) et `existsSync .env` dans le répertoire temporaire de
  l'API (×2). **Aucune tentative ne vise `web/`.**
- `env-guard-selftest` (garde JavaScript de l'API, des migrations et des
  CLI) : `@next/env`, `dotenv` et `@nestjs/config` ne lisent aucun canari
  avec la garde, mais les lisent tous sans elle (témoin). Résultat :
  `pass: true`.
- API, migrations et CLI : leur répertoire courant est le dossier
  temporaire vide de la recette, donc aucun `api/.env` n'y est désigné.

### 3.5 Portée de la campagne initiale

Les campagnes initiales (§ 4.1, « Campagne initiale ») ont tourné sur un
build fait **dans `web/`**, dans la configuration T2. Les `.env*` réels de
`web/` n'y ont donc pas été **appliqués** : garde et `__NEXT_PROCESSED_ENV`,
confirmés par T2 sur canaris. Une **lecture native** de ces fichiers par le
binaire Turbopack n'est en revanche pas exclue pour ces exécutions. Ce build
a aussi **remplacé `web/.next`** dans le dépôt. Son contenu actuel est le
build de recette (API `127.0.0.1:4200`), resté inchangé depuis (empreinte
identique avant et après la nouvelle campagne) ; `pnpm --filter web build`
rétablit un build normal. Ce point ne remet pas en cause les résultats
fonctionnels, qui ont été rejoués sur le build isolé.

## 4. Résultats

Exécution du 2026-10-03/04, sur bases éphémères et simulateurs locaux
uniquement.

### 4.1 Campagnes : **18/18 PASS** sur le build isolé

| Campagne | Build web | Résultat |
|---|---|---|
| **Finale, build isolé** (après le complément) | Copie isolée sans `.env*`, `web/.next` non touché | **18/18 PASS** (3 min 02 s), une seule exécution, assertions inchangées |
| Initiale | Dans `web/` (configuration T2, § 3.5) | 18/18 PASS (4 min 36 s), conservée pour l'historique |

Ensuite, Prettier a reformaté quatre fichiers (`launcher.js`,
`web-copy.js`, `web-canary.js`, `recipe.js`), sans changer leur
comportement. Un démarrage complet a été refait avec cette version : web
200, API 200, arrêt avec nettoyage complet.

Détail des scénarios (identique dans les deux campagnes) :

| # | Scénario | Fournisseur | Résultat |
|---|---|---|---|
| 1 | Propriétaire actif et limité : `pending` ; admin, vendeur, vendeur limité : aucun panneau ni appel ; 2 collectes | simulated | ✅ |
| 2 | Trois clics dans le même tick : 1 POST, UUID du marqueur identique, 1 collecte | simulated | ✅ |
| 3a | Réponse perdue puis rechargement : paiement relu, aucun second POST, 1 collecte | simulated | ✅ |
| 3b | Réponse perdue et historique indisponible : même UUID, même durée, `replayed`, 1 collecte | simulated | ✅ |
| 3c | Requête jamais arrivée : même UUID ; marqueur à 6 champs, sans téléphone ni jeton | simulated | ✅ |
| 4 | Deux onglets : 409 `PAYMENT_ALREADY_PENDING`, paiement de A affiché, 1 collecte | simulated | ✅ |
| 5 | `failed` → « Nouvel essai » relit le serveur (`review` l'emporte) ; nouvel UUID, 2 collectes | simulated | ✅ |
| 5b | Nouvel essai immédiat : relecture puis formulaire, 2 collectes | simulated | ✅ |
| 6 | 30 min simulées sans appel ; 503 sans relance ; `uncertain` et `review` sans formulaire ; 503 prestataire sans faux succès | simulated | ✅ |
| 7 | Montant figé (15 999) affiché depuis l'API | simulated | ✅ |
| 8 | 2 h simulées : 0 refresh ; un clic : 1 refresh, 1 consultation | simulated | ✅ |
| 9 | Succès en session limitée → `complete` → `/app` ; suspension prioritaire : 403, aucun échange | simulated | ✅ |
| 10 | Changement d'organisation et d'utilisateur sans fuite ; réauthentification : paiement retrouvé | simulated | ✅ |
| 11 | Vente hors ligne seule dans l'outbox pendant le paiement, puis synchronisée (1 vente) | simulated | ✅ |
| 12 | Pagination 5 + 2, 429 puis reprise, clavier, 360 px sans débordement, 401 limité | simulated | ✅ |
| **W1** | Webhook désactivé par défaut (503) ; mauvaise clé 401, 0 consultation ; « SUCCESSFUL » alors que CamPay répond PENDING : 200, **rien attribué** ; après validation : 200, `succeeded`, **1 période** ; rejeu identique : 200, **toujours 1 période** et aucune consultation supplémentaire ; accès récupéré par `complete` ; **1 collecte** | campay | ✅ |
| **R1** | `lost` → `uncertain` sans référence ; collecte visible chez le faux CamPay. `inspect` : 0. **Vrai CLI** : code 4 `provider-unavailable`, 0 consultation. Simulation : 0, plan `ready/succeed`, rattachement, **compteurs et paiement inchangés**. Application : `applied`, référence rattachée, **1 période, 1 audit**. Rejeu du même identifiant : `replayed`, toujours 1 période et 1 audit, **aucune consultation**. Même identifiant avec un autre motif : code 6. **1 collecte** | campay | ✅ |
| **R2** | `review` (montant discordant) : 0 période ; rapprochement discordant : code 4 `mismatch`, `review` conservé ; concordant : appliqué, 1 période, 1 audit, 1 collecte | campay | ✅ |

### 4.2 Commandes manuelles exécutées

Toutes les commandes du [README](../../api/test/recipe/README.md) ont été
lancées sur les comptes fictifs, la création de paiement passant par l'appel
API équivalent au bouton (l'interface étant couverte par la campagne) :

| Commande | Observé |
|---|---|
| `start`, `start --keep-logs` (build isolé) | Stack prête ; `web/.next` inchangé (empreinte SHA-256 de tous ses fichiers identique avant et après) |
| `start --reuse-web-build` | Option **retirée** avec le build isolé : refus explicite. Elle avait été éprouvée dans la version initiale |
| `web-canary-check` | `pass: true` (§ 3.3) |
| `status`, `accounts`, `payments`, `sim stats/transactions/reset/settle/queue-init` | Conformes |
| `provider campay` | API redémarrée, base conservée |
| Rapprochement (`proprietaire.rapprochement`) | `inspect` 0 ; `real-cli reconcile` 4 `provider-unavailable` ; `real-cli inspect` 0 ; simulation 0 `ready/succeed` ; `--apply` `applied` ; rejeu `replayed` ; 1 période ; 2 consultations (simulation et application), aucune au rejeu |
| Webhook (`proprietaire.webhook`, session limitée) | `--wrong-key` 401 ; avant validation 200 sans effet ; après `settle` 200, `succeeded`, 1 période ; `--replay` 200, 1 période ; une consultation par notification traitée, aucune au rejeu |
| `org suspend` / `reactivate`, `owner --label=manuel --expired`, `expire` | Conformes |
| `env-guard-selftest` | `pass: true` |
| `stop` | Nettoyage complet (ports libres, répertoire d'état supprimé, instance MongoDB arrêtée) |

### 4.3 Nettoyage éprouvé

| Cas | Résultat |
|---|---|
| Arrêt demandé (`stop`) | Ports libres, état supprimé, **copie web supprimée**, MongoDB de la recette arrêtée |
| Second `start` pendant une recette | Refusé, rien démarré |
| `start` avec un port déjà pris | Refusé au préflight, aucun processus arrêté (observé quand le serveur tiers du test suivant tenait encore 3200) |
| Arrêt **brutal** du lanceur seul (`taskkill /F` sur son PID ; refait avec le build isolé) | API et web arrêtés par le chien de garde en moins de 8 s ; MongoDB arrêtée par le processus de surveillance de `mongodb-memory-server`. **Restent** : la copie `.stockmaster-recipe-web` et le dossier `%TEMP%/mongo-mem-*` de l'instance, ce dernier supprimé ensuite à la main |
| Démarrage suivant cet arrêt brutal, avec erreur en cours de démarrage (port web pris par un serveur tiers **après** les contrôles ; refait avec le build isolé) | La copie périmée est remplacée (un marqueur ajouté a disparu). Échec signalé, nettoyage complet, copie supprimée. Le serveur tiers **n'est pas arrêté** et répond toujours |
| Ctrl+C dans une console | **Non éprouvé automatiquement** : un `SIGINT` ne peut pas être émis vers un processus Node sous Windows depuis l'outillage. Le gestionnaire est le même que pour l'arrêt demandé |

Trois `mongod` étrangers à la recette tournaient pendant tout le lot : deux
instances éphémères d'avant cette session (15 h 39 et 15 h 49), sur des
dossiers `mongo-mem-*`, et une instance locale sur le port 27018
(`~/.stockmaster-local`). **Ils n'ont pas été touchés.**

### 4.4 Contrôles

| Contrôle | Résultat |
|---|---|
| `pnpm --filter api build` (au départ) | Réussi |
| `node --check` sur les 16 fichiers JS | OK |
| `npx prettier --check test/recipe/*.js test/recipe/*.cjs` (configuration de l'API) | OK |
| `npx jest --listTests` / `--config ./test/jest-e2e.json --listTests` | 0 fichier de la recette collecté |
| Fichiers de l'outillage dans `api/dist` | 0 |
| Suites API et web | **Non relancées** : aucun fichier de production ni partagé modifié (ESLint ne couvre que les `.ts`) |
| `git diff --check` | Voir la sortie finale |

### 4.5 Défauts constatés

**Applicatifs : aucun.** Aucune correction de code de production.

**Outillage de recette (corrigés, aucune assertion affaiblie)**

1. **Références simulées répétées** : `/sim/reset` remettait le compteur à
   zéro. `SIM-1` réapparaissait donc d'un scénario à l'autre, et l'index
   unique des références prestataire faisait passer le paiement en
   `review` (premier passage : 3/18). D.2C n'avait pas ce problème,
   puisqu'il recréait son simulateur à chaque redémarrage et horodatait
   ses références. Le format `SIM-<horodatage>-<n>` est repris.
2. **Socket keep-alive périmée** : un `spawnSync` du CLI bloquait la boucle
   d'événements au-delà du keep-alive HTTP (5 s). La requête suivante au
   serveur de contrôle échouait alors (`fetch failed`, R1). Les CLI sont
   désormais lancés en asynchrone.
3. **Disponibilité usurpable** : l'attente du lanceur acceptait toute
   réponse HTTP sur le port. Un serveur tiers apparu sur 3200 après les
   contrôles a été pris pour le web, alors que `next start` avait échoué
   (`EADDRINUSE`), et la recette s'est déclarée prête. Reproduit par le
   test du § 4.3. Le marqueur d'écoute du processus lancé (« API READY »,
   « Ready in ») est désormais exigé, et `EADDRINUSE` fait échouer le
   démarrage ; nouveau test conforme.
4. **Révision Chromium** : Playwright 1.63.0 attend la révision 1243, seule
   la 1234 existe ; ajout de `--chromium=` (comme D.2C).
5. **Garde et suppression** : le processus de l'auto-test, lui-même gardé,
   ne « voyait » pas ses canaris lors du `rmSync`. Ils sont supprimés par
   `unlinkSync`, que la garde n'intercepte pas. Même correction dans
   `web-canary.js`, dont le premier essai a échoué sur ce point, nettoyage
   final compris.
6. **Isolement insuffisant du build web** (complément) : le build et le
   serveur tournaient dans `web/`, où un lecteur dotenv natif pouvait lire
   les `.env*` réels, et `web/.next` était remplacé. Remplacés par la copie
   isolée (§ 3.2).

## 5. Limites

- **Ni CamPay ni Railway** : voir l'avertissement en tête. Les formes
  officielles sont celles de D.2D et D.2F. Les comportements d'erreur du
  faux CamPay (`reject` → 400, `unavailable` → 503, `lost` → socket
  coupée) sont des choix de test.
- En mode `campay`, la consultation et le webhook utilisent le vrai
  adaptateur et la vraie vérification de signature, mais la signature est
  produite avec la clé fictive de la recette. Les claims réels de CamPay
  restent inconnus (D.2F § 1.3).
- Les scénarios D.2C tournent sur le prestataire simulé, qui prend en charge
  la recherche par référence marchand ; l'adaptateur CamPay ne la prend
  pas en charge. Les parcours `uncertain` y diffèrent donc volontairement
  de ceux de CamPay (R1).
- Le build isolé n'est pas identique octet pour octet à un build dans
  `web/` : les chunks JS ont d'autres hachages, liés au chemin des modules.
  Mêmes fichiers statiques, CSS identique.
- La copie `.stockmaster-recipe-web/` est **visible dans `git status`**
  pendant la recette ; il ne faut pas l'ajouter à un commit. Elle ne peut
  être ni hors du dépôt (Turbopack) ni ignorée par Git (Tailwind).
- L'absence de lecture est prouvée **par construction** (aucun `.env*` dans
  le dossier de build ni de nom standard dans ses ancêtres). Elle ne repose
  pas sur une observation des appels natifs, que l'outillage ne trace pas.
  Le lecteur dotenv natif présent dans le binaire n'est pas caractérisé
  davantage.
- `web/.next` contient encore le build de la campagne initiale (API
  `127.0.0.1:4200`) : un `pnpm --filter web build` rétablit un build normal.
- Le build télécharge les polices Geist depuis Google Fonts (comportement
  existant) ; c'est le seul accès réseau externe.
- La garde JavaScript reste la seule protection des processus API,
  migrations et CLI contre un `.env` ; leur répertoire courant est un
  dossier vide de la recette, et `@nestjs/config` ne lit que le `.env` de
  ce répertoire.
- Écritures de test hors fixtures, pendant les actions de recette :
  expiration, suspension, adhésion et produit insérés, montant modifié
  (scénarios 5, 7, 10, 11, comme en D.2C).
- Après un arrêt brutal du lanceur, le dossier de données de l'instance
  MongoDB reste dans `%TEMP%` ; Ctrl+C n'a pas été éprouvé automatiquement.
- Une seule recette à la fois (ports et répertoire d'état fixes).
- La campagne redémarre l'API et change de fournisseur : la lancer sur une
  stack dédiée plutôt qu'au milieu d'une recette manuelle.

## 6. Fichiers

Nouveaux (aucun fichier existant modifié) :

| Fichier | Rôle |
|---|---|
| `api/test/recipe/README.md` | Procédure manuelle |
| `api/test/recipe/recipe.js` | Point d'entrée et commandes |
| `api/test/recipe/launcher.js` | Lanceur, contrôle, nettoyage |
| `api/test/recipe/recipe-common.js` | Constantes fictives, environnements, garde d'URI |
| `api/test/recipe/web-copy.js` | Copie isolée des sources web |
| `api/test/recipe/web-canary.js` | Vérification par canaris du vrai build et du vrai serveur |
| `api/test/recipe/env-guard.cjs` | Garde anti-`.env` |
| `api/test/recipe/preload.cjs` | Préchargement : garde et chien de garde |
| `api/test/recipe/boot-api.js` | Entrée de test de l'API (fournisseurs injectés) |
| `api/test/recipe/simulators.js` | Prestataire simulé, faux CamPay |
| `api/test/recipe/seed-fixtures.js` | Schéma et comptes des fixtures |
| `api/test/recipe/fixtures.js` | Comptes fictifs |
| `api/test/recipe/reconcile-sim.js` | Rapprochement simulé |
| `api/test/recipe/actions.js` | Inscription, invitation, webhook, CLI |
| `api/test/recipe/db-tools.js` | Accès à la base éphémère |
| `api/test/recipe/lib.js` | Aides de la campagne |
| `api/test/recipe/scenarios.js` | 15 scénarios D.2C + W1, R1, R2 |
| `docs/architecture/phase-1-14d2h-payment-local-recipe.md` | Ce document |

Inchangés : tout le code de l'API et du web, les migrations, `main.ts`,
`package.json`, le lockfile, `.gitignore`, Docker, nginx, la configuration
Railway et les `.env` (non lus, absents des copies). `web/.next` (ignoré par
Git) contient toujours le build de la campagne initiale ; la version
actuelle ne l'écrit plus.
