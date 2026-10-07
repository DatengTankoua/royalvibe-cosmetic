# Lot 1-16C.2 — Acceptation versionnée des conditions et migrations de production

> Les textes juridiques restent des **projets** (statut interne « projet »,
> `noindex`). Ce lot met en place le **mécanisme** d'acceptation et de preuve ;
> il ne vaut pas validation juridique (rapport 1-16C, § 6.2).

## 0. Base, périmètre et règles suivies

- Branche `architecture/phase-1-16c-legal-and-usage-pages`, HEAD `03f5459`
  (« feat: add complete monthly Excel and PDF exports »), qui contient les lots
  1-16C, 1-16C.1 et 1-16D (commits `8994798`, `03f5459`).
- État initial vérifié : arbre et index propres ; `stash@{0}` (sauvegarde
  lint-staged `564a998`) présent et **non touché**.
- Aucun commit, push, déploiement, migration réelle ni activation. Aucun
  `.env` réel ouvert, aucune base réelle : MongoDB éphémère uniquement.
  Aucune dépendance ajoutée.
- CamPay reste `UnavailablePaymentProvider`, le webhook reste désactivé.

## 1. Migration de l'assistance et pré-déploiement

### 1.1 Constats

| Élément | Constat |
|---|---|
| `api/package.json` | `migrate:support-request-indexes` = `node dist/migrations/create-support-request-indexes.js` (programme compilé) |
| `api/Dockerfile`, étape `runtime` | `WORKDIR /app/api`, `NODE_ENV=production`, seules les dépendances de **production** (`pnpm install --prod`), `dist` copié, **pnpm absent**, utilisateur `node`, `CMD ["node", "dist/main"]` |
| Conséquence | `pnpm --filter api migrate:*` **ne fonctionne pas** dans l'image de production : il faut appeler `node` sur le programme compilé |
| Programme compilé | 4 fichiers (`migrations/`, `support/support-request-indexes.js`, `support/schemas/…`, `support/support-constants.js`) ; modules externes : `mongoose`, `@nestjs/mongoose`, tous deux en `dependencies` (analyse statique des `require`) |
| Dossier de lancement | Sans effet : les modules sont résolus depuis l'emplacement du script ; aucun fichier relatif au dossier courant n'est lu. Seule `MONGODB_URI` est lue, jamais journalisée |
| Configuration Railway | **Absente du dépôt** (ni `railway.json` ni `railway.toml`) et non consultée : constructeur, dossier racine et `RAILWAY_DOCKERFILE_PATH` réels inconnus |
| Démarrage en production | L'API vérifie au démarrage les index `sale_operations`, `subscription_periods`, `subscription_payments` **et push** (`startNotifications` vérifie dès que `NODE_ENV=production`, même avec `WEB_PUSH_ENABLED=false`). L'index TTL d'assistance n'est pas vérifié au démarrage |

Documentation Railway consultée le 7 octobre 2026 :
- « Pre-deploy Command » : exécutée entre la construction et le
  déploiement, avec les variables du service et le réseau privé ; système
  de fichiers non conservé ; **échec → pas de nouvel essai, le déploiement ne
  se poursuit pas** ; pas de limite de durée par défaut, réglable de 1 à
  3 600 s. Le dossier de lancement n'y est pas précisé.
- « Config as code » : `deploy.preDeployCommand` (tableau) ; le code
  l'emporte sur le tableau de bord ; un `Dockerfile` trouvé est toujours
  utilisé.
- « Dockerfiles » : détection à la racine du dossier source, ou
  `RAILWAY_DOCKERFILE_PATH`.

### 1.2 Commande retenue

```
node /app/api/dist/migrations/predeploy-migrations.js
```

Nouveau lanceur `api/src/migrations/predeploy-migrations.ts` : une seule
commande, sans dépendre de l'interprétation d'un `&&` par Railway. Il
exécute les migrations d'index **existantes**, dans des processus séparés,
et s'arrête au premier échec (code 1) :

1. `create-sale-operations-index.js` (vérifiée au démarrage)
2. `create-subscription-period-indexes.js` (vérifiée au démarrage)
3. `create-subscription-payment-indexes.js` (vérifiée au démarrage)
4. `create-subscription-payment-reconciliation-indexes.js` (CLI `--apply`)
5. `create-push-notification-indexes.js` (vérifiée au démarrage)
6. `create-support-request-indexes.js` (TTL 30 jours, 1-16C.1)
7. `create-legal-acceptance-indexes.js` (1-16C.2)

La migration seule : `node /app/api/dist/migrations/create-support-request-indexes.js`.
Les outils opérateur (`subscription:grant`, rapprochement, rattrapage) ne
sont jamais lancés. Script `migrate:predeploy` ajouté pour un poste.

### 1.3 Vérification en lecture seule

Mode `--check` ajouté aux migrations de l'assistance et des acceptations :
`listIndexes` uniquement, aucune création, sortie 1 si absent ou différent.

```
node /app/api/dist/migrations/create-support-request-indexes.js --check
→ support_requests : index createdAt_1_ttl présent, createdAt, expireAfterSeconds=2592000 (lecture seule).
```

Équivalent `mongosh` : `db.support_requests.getIndexes()`.

### 1.4 README

Section « Migrations à exécuter avant l'activation d'une version »
réécrite : règle (la migration **précède** l'activation de la nouvelle
API), Pre-deploy Command comme moyen recommandé de garantir l'ordre, commande
exacte, tableau de toutes les migrations requises et de leur raison,
vérification en lecture seule, délai conseillé (Pre-deploy Timeout), accès
réseau Atlas, limites (constructeur Railway à confirmer ; chemin relatif
`dist/migrations/…` si le service n'est pas construit avec `api/Dockerfile`).
Nouvelle section « Documents juridiques versionnés ».

### 1.5 Vérifié / non vérifié

| Contrôle | Résultat |
|---|---|
| Construction de l'image (`docker build -f api/Dockerfile .`, tag local, aucun push) | **Non exécutée** : le moteur Docker Desktop répond 500 (`dockerDesktopLinuxEngine`). Je ne l'ai pas démarré moi-même |
| Reproduction de l'étape `prod-deps` | `pnpm install --frozen-lockfile --prod --ignore-scripts --offline --filter api` dans un dossier temporaire (même lockfile, magasin local, aucun téléchargement) : 14 dépendances de production, sans `jest` ni `mongodb-memory-server` |
| Programmes compilés lancés par chemin absolu, depuis un autre dossier, avec ces seules dépendances, contre MongoDB éphémère 8.2.6 | `--check` avant : sortie 1 (« index TTL absent ») ; sans `MONGODB_URI` : sortie 1 ; pré-déploiement : 7 migrations créées, sortie 0 ; `--check` après : sortie 0 ; rejeu : 7 « déjà présent », sortie 0 ; index lu : `{"key":{"createdAt":1},"name":"createdAt_1_ttl","expireAfterSeconds":2592000}` |
| Archives juridiques dans `dist` | `nest build` copie `dist/legal/archive/**` (option `assets`), octets identiques (`cmp`) |
| Comportement réel de Railway (dossier de travail, analyse de la commande, accès Atlas depuis le pré-déploiement) | **Non vérifié** (aucun accès) |

## 2. Acceptation explicite

### 2.1 Audit des parcours

| Parcours | Route | Avant ce lot |
|---|---|---|
| Inscription : compte + commerce (seule création de commerce) | `POST /auth/register` (fermé sauf `PUBLIC_REGISTRATION_ENABLED=true`) | Phrase d'information, aucune case, aucune preuve |
| Invitation, nouveau compte | `POST /auth/invitations/accept` avec nom et mot de passe | Aucune case, aucune preuve |
| Invitation, compte existant | `POST /auth/invitations/accept` `{ token }`, envoyé **automatiquement** à l'ouverture du lien, **sans authentification** | Rattachement direct |
| Transfert de propriété | `POST /organizations/members/:id/transfer-ownership` | — |

Point clé : pour un compte existant, le lien d'invitation ne prouve pas
l'identité de la personne (le code le dit déjà pour la boîte mail). **Aucune
acceptation n'est enregistrée par ce chemin** ; l'accord est demandé après
connexion (§ 2.6).

### 2.2 Documents par parcours

| Parcours | Acceptés (case) | Présentés (information) |
|---|---|---|
| Inscription (personne qui engage le commerce) | Conditions d'utilisation, **conditions d'abonnement** | Politique de confidentialité |
| Nouveau compte par invitation | Conditions d'utilisation | Politique de confidentialité |
| Compte existant | Documents en vigueur non acceptés : conditions d'utilisation ; conditions d'abonnement **si propriétaire de ce commerce** | Politique de confidentialité |

La politique de confidentialité n'est jamais « acceptée » : un envoi qui la
place parmi les documents acceptés est refusé (400). Aucun consentement
facultatif n'existe ni n'est créé ; la permission push reste une action
séparée (inchangée).

### 2.3 Archive versionnée et empreintes

- Le texte archivé est le texte **présenté** : extrait du HTML prérendu par
  `next build` (régions `data-legal-text` du gabarit : titre, version,
  introduction, sections ; sans sommaire, en-tête ni pied). Langue lue dans
  `<html lang>`, version dans `data-legal-version`.
- `web/scripts/legal-archive.mjs` : `check` (texte affiché identique à
  l'archive de la version déclarée, archives conformes au manifeste) et
  `write` (archive une **nouvelle** version ; refuse de réécrire une version
  existante ; n'écrase aucun fichier). Intégré au build isolé
  (`recipe.js isolated web-build`, `--legal-archive=write
  --published-at=…`) et ajouté à la CI web après `pnpm build`.
- `api/src/legal/archive/` : `manifest.json` + `<document>/<version>.<langue>.txt`,
  en français, publiés le 7 octobre 2026 :

| Document | SHA-256 | État |
|---|---|---|
| `conditions-utilisation` 0.3 fr | `5c2e4c36edc0ecbd545659a0e12fcb50c36b543277819629ad5dc33c63dec2c2` | en vigueur |
| `conditions-abonnement` 0.3 fr | `7efc7db353af8c9b842e798fb810c8b0082f16d9fe2c0bf116e7218c45a50e72` | historique, conservée telle quelle (§ 7) |
| `conditions-abonnement` 0.4 fr | `bade5d4650c93eed40481082ce6780f3b99073cd5bfc31bc141ca862b392e4ee` | en vigueur (§ 7) |
| `confidentialite` 0.3 fr | `941a2c17b62003c13668af353cf262dbc01616aa7a548c590fe5fb7dc841d082` | en vigueur |

- `.gitattributes` : `api/src/legal/archive/** -text`. Sans lui,
  `core.autocrlf=true` (configuration du poste) convertirait les fins de
  ligne au checkout Windows et changerait les empreintes.
- L'API lit l'archive **à la première utilisation** (jamais au démarrage :
  une archive absente bloque l'acceptation, pas l'API ni les ventes) et
  contrôle chaque texte contre l'empreinte du manifeste.

### 2.4 Contrôles du serveur

Le navigateur envoie seulement `legalAcceptance: { accepted, locale,
documents: [{id, version}], notices: [{id, version}] }`. Le serveur, **avant
toute écriture** :

| Cas | Réponse |
|---|---|
| Absente, `accepted ≠ true`, document requis manquant | 400 `LEGAL_ACCEPTANCE_REQUIRED` |
| Document inconnu, en double, non prévu pour ce parcours | 400 `LEGAL_DOCUMENTS_INVALID` |
| Version différente de la version en vigueur | 409 `LEGAL_VERSION_OUTDATED` (+ versions en vigueur) |
| Langue sans texte archivé (ex. `en`) | 400 `LEGAL_LOCALE_UNAVAILABLE` |
| Archive absente ou altérée ; version déjà archivée en base avec un autre texte | 503 `LEGAL_ARCHIVE_UNAVAILABLE` |
| Date, empreinte, utilisateur ou tout autre champ fourni | 400 (`forbidNonWhitelisted`, y compris dans les objets imbriqués) |

**Date, versions, langue et empreintes enregistrées viennent du serveur**
(horloge injectable, manifeste).

### 2.5 Enregistrement

Dans la **même transaction** que la création du compte (et du commerce) :
une erreur annule tout, une invitation refusée reste `pending`.

- `legal_acceptances` (une preuve par action explicite) : `_id` déterministe
  (empreinte de l'utilisateur, du commerce, du parcours et des versions
  acceptées : un rejeu ne crée pas de doublon, unicité par l'index `_id`
  natif), `userId`, `organizationId`, `context`, `acceptedAt` (serveur),
  `locale`, `acceptedDocuments` et `presentedNotices` (document, version,
  langue, empreinte, référence de l'archive).
- `legal_document_versions` : texte complet de chaque version acceptée,
  archivé à sa première acceptation par `$setOnInsert` (jamais réécrit),
  relu et comparé ; contenu différent → refus 503.
- Immuabilité côté application : middleware Mongoose refusant toute mise à
  jour, remplacement ou suppression (requêtes et documents). Une écriture
  directe en base par un administrateur reste possible : à couvrir par les
  droits Atlas (§ 4).

### 2.6 Comptes existants

- Aucune acceptation rétroactive : un compte sans preuve est « en attente ».
- `GET /legal/acceptance` (sans cache) : documents en vigueur non acceptés,
  calculés depuis les preuves (rôle relu en base) ; `POST /legal/acceptance`
  : confirmation explicite, mêmes contrôles ; rien en attente →
  `already-accepted`, aucune nouvelle preuve.
- Web : boîte de dialogue dans le shell (`LegalAcceptancePrompt`), case non
  cochée, liens en nouvel onglet, « Plus tard » (session du navigateur),
  rechargement imposé si les versions affichées diffèrent.
- **Désactivée par défaut** : `LEGAL_ACCEPTANCE_PROMPT_ENABLED` (valeur exacte
  `true`, variable du service API). L'acceptation à l'inscription et à
  l'invitation n'en dépend pas.
- Ventes hors connexion et restrictions commerciales préservées : aucune
  route métier ne dépend de l'acceptation ; l'invite n'apparaît ni hors
  ligne ni sur l'écran de blocage commercial ; une session limitée reçoit
  403 sur `/legal/*` et reste limitée ; la synchronisation de l'outbox est
  indépendante.

### 2.7 Pages et formulaires

- Inscription : case « J'ai lu et j'accepte les conditions d'utilisation et
  les conditions d'abonnement (versions 0.3 et 0.3) », non cochée, aucune
  requête sans elle (focus et message), information de confidentialité
  distincte. Invitation (nouveau compte) : idem avec les seules conditions
  d'utilisation.
- Conditions d'utilisation 0.3 : section « Acceptation de ces conditions ».
  Conditions d'abonnement 0.3 : section « Qui accepte ces conditions ».
  Confidentialité 0.3 : catégorie « Acceptation des conditions », finalité
  (obligation de preuve, loi 2010/021 art. 26, décret 2011/1521/PM art. 12,
  à valider), conservation (tant que le compte existe ; durée ultérieure en
  commentaire), distinction information / autorisations facultatives / push.
  Guide : la case à l'inscription et à l'invitation.
- Statut interne « projet » et `noindex` conservés ; informations manquantes
  en commentaires (`À COMPLÉTER`, `À VALIDER`) ; **aucun bandeau visible**.

### 2.8 Traduction FR/EN

`LEGAL_LOCALE = "fr"` côté web ; le manifeste porte une langue par version.
Une version anglaise s'ajoutera par une page `lang="en"` archivée ; d'ici
là, le serveur refuse `en` (400), donc aucune acceptation d'une traduction
inexistante ne peut être enregistrée.

## 3. Validation

Outils isolés uniquement (`recipe.js isolated`, garde anti-`.env`, MongoDB
éphémère, copie web sans `.env*`).

| Contrôle | Résultat |
|---|---|
| Lint web (`npx eslint`, sans `--fix`) | exit 0 |
| Typage web (`npx tsc --noEmit`) | exit 0 |
| Lint API (`npx eslint src` + tests modifiés, sans `--fix`) | exit 0 ; 1 avertissement **antérieur** (`app.e2e-spec.ts:525`, ligne non modifiée) |
| Typage API (`tsc -p tsconfig.build.json`) | exit 0 |
| `pnpm --filter api build` | réussi ; `dist/legal/archive` présent |
| Unitaires `isolated api-unit src/legal src/support src/auth src/organizations` | **24 suites, 486/486** |
| E2E `legal-acceptance`, `support-request-indexes`, `organization-support` | **3 suites, 36/36** |
| Régression e2e : les 23 suites qui inscrivent ou invitent | **23 suites, 531/531** |
| `isolated web-build` (après mise en forme finale) | exit 0 ; archives `check` ok (3 documents 0.3) ; `envFilesInCopy: 0` ; copie supprimée |
| Script d'archive, texte modifié sans nouvelle version (faux `.next`) | `check` exit 1 ; `write` exit 1 (« jamais réécrite ») ; manifeste inchangé |
| Migrations compilées hors dépôt (§ 1.5) | conformes |
| `git diff --check` + fichiers nouveaux | aucun espace en fin de ligne |

Couverture de `test/legal-acceptance.e2e-spec.ts` (15) : refus sans
acceptation ; case non cochée, abonnement manquant, version périmée,
traduction inexistante, document en trop (aucune écriture) ; date,
empreinte et identité impossibles à imposer ; preuve complète (date
serveur, `_id`, versions, empreintes, textes en base octet pour octet) ;
rejeu de l'inscription ; invitation nouveau compte (refus, invitation
intacte, abonnement refusé, puis preuve) ; invitation compte existant sans
preuve ; compte existant (statut, drapeau, refus, confirmation, rejeu sans
doublon) ; transfert de propriété (abonnement en attente pour ce commerce
seulement, route métier accessible sans acceptation) ; nouvelle version
(anciennes preuves et ancien texte inchangés) ; conflit d'archive (503,
aucune écriture) ; immuabilité ; session limitée (403, restriction
maintenue) ; migration (collections, index sans TTL, idempotence, refus
d'un index homonyme différent sans l'écraser).

Unitaires `src/legal/legal.spec.ts` : intégrité de l'archive (empreintes,
aucun fichier orphelin, aucune fin de ligne Windows), manifeste invalide
refusé, texte altéré refusé, tous les refus de `resolveSubmission`,
déterminisme de la clé de rejeu.

Recette navigateur : non exécutée au premier passage, réalisée pendant la
finalisation (§ 7.3, 18/18).

## 4. Points bloquants et décisions avant activation

1. ~~Conditions d'abonnement 0.3 annonçant un paiement en ligne
   disponible~~ : **corrigé** par la version 0.4 (§ 7.1). La 0.3 reste
   archivée telle quelle, puisqu'elle a pu être présentée.
2. ~~Cookies et accord de traitement modifiés sans nouveau numéro~~ :
   **corrigé**, version 0.3 (§ 7.2).
3. Juriste : la case porte sur les **conditions** ; elle n'est pas présentée
   comme le consentement de la loi 2024/017 (art. 9) au traitement des
   données du compte (commentaire `À VALIDER` dans la politique). Forme de
   ce consentement, inclusion éventuelle de l'accord de traitement des
   données, durée de conservation des preuves (10 ans envisagés), langue
   anglaise : à décider.
4. Railway : confirmer le constructeur (`api/Dockerfile`, contexte racine),
   saisir la Pre-deploy Command et un délai, vérifier l'accès Atlas. Version
   en service inconnue (1-14D.2E.1) : si une ancienne version tourne, le
   pré-déploiement peut **créer** des index uniques et échouer sur des
   doublons, ce qui bloque le déploiement sans rien écraser.
5. Droits Atlas : limiter la modification et la suppression de
   `legal_acceptances` et `legal_document_versions` (l'immuabilité applicative
   ne protège pas d'un accès direct).
6. Activer `LEGAL_ACCEPTANCE_PROMPT_ENABLED` seulement après le point 3.
7. Achat d'une période par le propriétaire (paiement en ligne) : aucune
   acceptation spécifique ajoutée, le paiement étant fermé.

## 5. Fichiers

### 5.1 Nouveaux

| Fichier | Rôle |
|---|---|
| `.gitattributes` | Octets exacts des archives |
| `api/src/legal/legal-documents.ts` | Manifeste, archive vérifiée, exigences par parcours |
| `api/src/legal/legal-acceptance.service.ts` | Contrôles, enregistrement, statut, confirmation |
| `api/src/legal/legal.controller.ts`, `legal.module.ts` | `GET`/`POST /legal/acceptance` ; module feuille |
| `api/src/legal/schemas/legal-acceptance.schema.ts` | Preuves et textes, immuables côté application |
| `api/src/legal/dto/legal-acceptance.dto.ts` | Corps strict |
| `api/src/legal/legal-acceptance-indexes.ts` | Collections, index, vérification |
| `api/src/legal/archive/**` | Manifeste et textes 0.3 |
| `api/src/legal/legal.spec.ts` | Unitaires |
| `api/src/migrations/create-legal-acceptance-indexes.ts` | Migration (`--check`) |
| `api/src/migrations/predeploy-migrations.ts` | Lanceur de pré-déploiement |
| `api/test/legal-acceptance.e2e-spec.ts`, `api/test/e2e/legal-acceptance-fixtures.ts` | E2E et aide |
| `web/scripts/legal-archive.mjs` | Extraction, vérification, archivage |
| `web/src/lib/legal/acceptance.ts` | Miroir des exigences, charge utile, erreurs, appels |
| `web/src/components/legal/terms-acceptance-field.tsx` | Case d'acceptation |
| `web/src/components/legal/legal-acceptance-prompt.tsx` | Invite des comptes existants |
| `docs/architecture/phase-1-16c2-versioned-terms.md` | Ce rapport |

### 5.2 Modifiés

| Fichier | Changement |
|---|---|
| `README.md` | Migrations avant activation, pré-déploiement, lecture seule ; documents versionnés |
| `.github/workflows/ci.yml` | Étape `legal-archive.mjs check` après le build web |
| `api/nest-cli.json` | `assets` : archive copiée dans `dist` |
| `api/package.json` | `migrate:legal-acceptance-indexes`, `migrate:predeploy` |
| `api/src/app.module.ts`, `auth/auth.module.ts`, `organizations/organizations.module.ts` | `LegalModule` |
| `api/src/auth/dto/register.dto.ts`, `accept-invitation.dto.ts` | `legalAcceptance` facultatif au DTO (code stable en service) |
| `api/src/auth/auth.service.ts` | Contrôle avant écriture, preuve dans la transaction d'inscription |
| `api/src/organizations/organizations.service.ts` | Idem pour un compte créé par invitation ; rien pour un compte existant |
| `api/src/support/support-request-indexes.ts`, `migrations/create-support-request-indexes.ts` | `--check` (lecture seule) |
| `api/src/auth/auth.service.spec.ts`, `organizations/organizations.service.spec.ts` | Double de `LegalAcceptanceService` |
| 23 suites `api/test/*.e2e-spec.ts` | Acceptation jointe aux inscriptions et aux créations de compte par invitation |
| `api/test/recipe/{actions,realtime-scenarios,seed-fixtures,launcher,isolated-checks,recipe}.js` | Acceptation dans la recette et les fixtures ; migration et option `--legal-prompt` (recette seulement) dans le lanceur ; contrôle d'archive du build isolé |
| `web/src/lib/legal/site-identity.ts` | `id` des documents ; CGU et confidentialité 0.3, CGA 0.4, cookies et accord de traitement 0.3 |
| `web/src/components/legal/document-page.tsx` | Marqueurs `data-legal-*` (aucun changement visible) |
| `web/src/app/auth/register/page.tsx`, `auth/invitations/accept/page.tsx` | Case et erreurs |
| `web/src/app/app/layout.tsx` | Invite des comptes existants |
| `web/src/lib/api.ts` | Types des charges utiles |
| `web/src/app/{conditions-utilisation,conditions-abonnement,confidentialite,guide}/page.tsx` | Textes 0.3 et guide |

## 6. État Git final

Voir § 7.6.

## 7. Finalisation (7 octobre 2026)

État vérifié au départ : branche `architecture/phase-1-16c-legal-and-usage-pages`,
HEAD `03f5459`, lot 1-16C.2 non commité (64 entrées), index vide,
`stash@{0}` présent. CamPay et le webhook restent désactivés.

### 7.1 Conditions d'abonnement 0.4

- Section « Paiement et renouvellement » : l'annonce d'un paiement en ligne
  disponible est remplacée par « Le paiement en ligne n'est pas encore
  activé. Pour toute demande de renouvellement, contactez
  support@stock-master.app. ». La puce « En cas de problème lors du
  paiement… », qui supposait un paiement possible, est retirée. Aucune
  procédure de paiement ni garantie de renouvellement n'est ajoutée ; le
  commentaire « À COMPLÉTER » sur les moyens de paiement est conservé.
- Archive : `conditions-abonnement/0.4.fr.txt` écrit par
  `isolated web-build --legal-archive=write --published-at=2026-10-07` ; le
  manifeste passe la version courante à 0.4. **La 0.3 est intacte** :
  fichier identique octet pour octet (`cmp`), empreinte `7efc7db3…`
  inchangée dans le manifeste. Différence 0.3 → 0.4 : ligne de version,
  phrase du paiement, puce retirée.
- Références : registre web (`DRAFT_0_4`). Formulaires, aides e2e et
  harnais lisent la version courante du registre ou du manifeste : aucune
  valeur recopiée à modifier.
- Autres affirmations recherchées dans les pages actives : le guide (« pas
  encore disponible ») et la page Cookies (« inutilisé tant que le paiement
  en ligne est fermé ») sont déjà cohérents. Non modifiés, à noter : la FAQ
  de l'accueil (« le propriétaire choisit une durée… depuis l'espace
  Abonnement ») ne dit pas que le paiement est disponible ; le panneau de
  paiement de l'application (1-14D.2C) affiche un formulaire Mobile Money
  qui répond « indisponible pour le moment » à l'envoi. C'est un
  comportement produit, hors du périmètre texte de ce lot.

### 7.2 Cookies et accord de traitement

Leur état actuel (modifié par `03f5459`, le 7 octobre 2026 à 14:42 +0200)
reçoit la **version 0.3**, datée du « 7 octobre 2026 ». Ils restent hors des
documents à accepter, au statut « projet » et `noindex`. Aucun bandeau
ajouté ; commentaires « À COMPLÉTER » conservés.

### 7.3 Recette navigateur (18/18)

- Outil : `playwright-core@1.62.1` installé dans le dossier temporaire de
  session (hors dépôt, aucune dépendance du projet), Chromium 1234 déjà en
  cache. Script de recette hors dépôt.
- Stack isolée `recipe.js start --legal-prompt` : MongoDB éphémère, e-mails
  simulés, copie web sans `.env*`. La nouvelle option `--legal-prompt` du
  harnais transmet `LEGAL_ACCEPTANCE_PROMPT_ENABLED=true` à l'API de recette
  **uniquement** ; elle est absente par défaut.
- **Défaut trouvé et corrigé** : `seed-fixtures.js` inscrivait et invitait
  ses comptes par les services réels sans acceptation, et la stack refusait
  de démarrer (« L'acceptation des conditions est requise »). Le fichier
  joint maintenant l'acceptation, comme le web ; les comptes de fixtures ont
  donc une preuve. Pour le cas « compte existant », le script crée dans la
  base éphémère un administrateur sans preuve, comme un compte d'avant ce
  lot.

| Vérification | Résultat |
|---|---|
| Inscription : case présente, non cochée au chargement | OK |
| Libellé : conditions d'utilisation et d'abonnement, « versions 0.3 et 0.4 » | OK |
| Sans case : message, focus sur la case, **aucune requête** | OK (2) |
| Page périmée (corps envoyé avec CGA 0.3, réponse du vrai serveur) : « Les conditions ont été mises à jour. Recharge la page… » | OK |
| Inscription réussie, charge utile = versions actuelles ; statut serveur sans attente | OK (2) |
| Invitation : case non cochée, conditions d'utilisation seules ; refus local sans requête ; acceptation réussie | OK (3) |
| Compte existant : rien d'inventé, CGU en attente, invite affichée, case non cochée, « J'accepte » désactivé | OK (2) |
| « Plus tard » : invite masquée pour la session, rien enregistré | OK |
| Version devenue périmée (réponse de statut modifiée pour annoncer 9.9) : seul « Recharger » est proposé, aucune case | OK |
| Après rechargement : confirmation explicite enregistrée ; rejeu `already-accepted`, aucun doublon ; plus d'invite | OK (3) |
| Console : aucune erreur inattendue | OK |

Captures (hors dépôt) : refus d'inscription, page périmée, invitation
acceptée, invite d'un compte existant, invite périmée. Stack arrêtée, copie
web supprimée.

### 7.4 Migrations : précisions

- Commande conservée : `node /app/api/dist/migrations/predeploy-migrations.js`.
  Elle **dépend du constructeur et des chemins réels de l'image**
  (`/app/api` = `api/Dockerfile`).
- Testé : les programmes compilés, lancés par chemin absolu depuis un autre
  dossier avec les **seules dépendances de production** installées depuis
  le lockfile (§ 1.5). **Non vérifiés** : l'image Docker (moteur
  indisponible) et Railway (aucun accès).
- **Échec partiel** : chaque migration s'exécute à part ; si une étape
  échoue, les index créés par les étapes précédentes restent en place. Rien
  n'est annulé, aucun index ni aucune donnée n'est supprimé
  automatiquement ; une relance après correction est sans effet sur les
  étapes déjà faites. Écrit dans le README et dans le lanceur.

### 7.5 Tests relancés (ciblés)

| Contrôle | Résultat |
|---|---|
| Unitaires `src/legal` (dont 0.4 en vigueur, empreinte 0.3 figée, phrase exacte, plus de « Mobile Money ») | **18/18** |
| E2E `test/legal-acceptance` (dont 0.3 → 0.4 : ancienne version refusée en 409 sans écriture ; preuve et texte 0.3 conservés ; 0.4 acceptée avec texte et empreinte exacts ; nouvelle confirmation demandée puis rien en attente) | **16/16** |
| `isolated web-build --legal-archive=write` puis `check` | exit 0 ; texte affiché = archive pour CGU 0.3, CGA 0.4, confidentialité 0.3 ; `envFilesInCopy: 0` |
| Lint sans `--fix` : API (`src/legal`, `src/migrations`, `src/support`, tests légaux) et web | exit 0 |
| Typage API (`tsconfig.build.json`) et web | exit 0 |
| `pnpm --filter api build` | réussi |
| Prettier sur les fichiers du harnais modifiés ; `git diff --check` | OK |

Non relancés, faute de nouvelle raison : les 531 tests de régression et les
campagnes générales. Les suites e2e existantes lisent les versions dans le
manifeste et ne dépendent pas du numéro 0.4.

### 7.6 Limites restantes et état Git

- Image Docker et Railway non vérifiés ; constructeur à confirmer.
- Décisions juridiques (§ 4, point 3) et droits Atlas (point 5) ouverts.
- Le panneau de paiement de l'application reste visible (§ 7.1).
- Branche `architecture/phase-1-16c-legal-and-usage-pages`, HEAD `03f5459`,
  **index vide** (identique au départ), `stash@{0}` inchangé. Aucun commit,
  push, migration réelle, configuration Railway, déploiement ni activation.
