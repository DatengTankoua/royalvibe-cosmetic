# Phase 1-15C — Temps réel des membres, invitations et de l'image de marque

Branche : `architecture/phase-1-15c-realtime-organization`, créée depuis
`architecture/phase-1-15b-realtime-sections-deletions` à
**`d7d4fde5f3ac162862eabcf16851829bdd91de72`** (« fix: synchronize sections
and permanent product deletions »), présent sur `origin`. Au départ : arbre
et index propres ; `stash@{0}` (sauvegarde lint-staged `564a998`) présent et
**non touché**.

Rapports consultés : [1-15A](phase-1-15a-realtime-saas.md) (coordinateur,
remontage sur changement de droits, isolement des validations),
[1-15B](phase-1-15b-realtime-sections-deletions.md),
[1-14D.2H](phase-1-14d2h-payment-local-recipe.md) (stack éphémère).

Aucun commit, push ni déploiement. Aucune base réelle ; aucun appel à un
service externe réel (stockage, e-mail, CamPay). **Aucun `.env` réel lu,
déplacé ou modifié** : suites API et build web uniquement par
`recipe.js isolated`. Aucune dépendance, lockfile inchangé.
`UnavailablePaymentProvider` et webhook désactivé : inchangés ; parcours de
paiement non touché.

---

## 1. Audit avant correction

Aucune opération, permission ni règle métier ajoutée.

| Opération                                              | Route (permission)                                                         | Écriture / transaction                                                | Avant 1-15C                                                                      |
| ------------------------------------------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Modifier rôle, droits, statut (suspension, révocation) | `PATCH /organizations/members/:id` (`members.manage`, anti-escalade)       | transaction ; acteur et cible relus                                   | `disconnectMember` du membre visé **après commit** ; **rien** pour les collègues |
| Transférer la propriété                                | `POST /organizations/members/:id/transfer-ownership` (propriétaire strict) | transaction                                                           | déconnexion de l'ancien et du nouveau propriétaire après commit ; rien d'autre   |
| Créer une invitation                                   | `POST /organizations/invitations` (`members.invite`, anti-escalade)        | écriture simple (expiration de l'ancienne `pending` puis création)    | **aucun** événement                                                              |
| Révoquer                                               | `POST /organizations/invitations/:id/revoke` (`members.invite`)            | `findOneAndUpdate` conditionnel                                       | **aucun**                                                                        |
| Accepter                                               | `POST /auth/invitations/accept` (public, jeton)                            | transaction (invitation, utilisateur, membership)                     | **aucun**                                                                        |
| Nom, couleur, logo                                     | `PATCH /organizations/current/branding` (`branding.manage`)                | logo validé puis envoyé au stockage, sauvegarde, ancien logo supprimé | **aucun**                                                                        |
| Retirer le logo                                        | `DELETE /organizations/current/logo` (`branding.manage`)                   | sauvegarde si un logo existait                                        | **aucun**                                                                        |

Lecture : `GET /organizations/members` exige `members.manage`,
`GET /organizations/invitations` exige `members.invite`,
`GET /organizations/current` est ouvert à tout membre actif.

**Écrans** : pages Organisation › Membres et › Invitations (chargées une
fois, sans requête sans le droit) ; nom et logo affichés par le **shell**
(`layout.tsx`, `GET /organizations/current`) et la page Branding ; le shell
ne rechargeait l'organisation qu'au démarrage ou par `refreshShell`, qui
relit aussi le contexte et **relance une passe de l'outbox**.

**Contrainte d'architecture** : `EventsModule` importe
`OrganizationsModule` ; `OrganizationsService` ne peut pas injecter
`EventsGateway` sans cycle. `SocketRegistryService` est déjà l'instance
partagée par les deux (déconnexions 1-7C, 1-13B).

### 1.1 Défauts reproduits avant correction

Stack D.2H ; API compilée depuis **`d7d4fde`** et web non modifié au
moment du build ; scénarios RT15–RT21 : **0/7**. Chaque échec a été vérifié
à l'étape attendue (pas sur l'outillage : le stockage simulé recevait bien
les vrais envois, images PNG intactes 240×120, 200×100, 128×64).

| #   | Scénario                                        | Premier échec observé                                                                   |
| --- | ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| F1  | RT15 — deux administrateurs                     | droit ajouté à un vendeur **non visible** chez le second administrateur                 |
| F2  | RT16 — droit d'invitation retiré au membre visé | la liste disparaît déjà (1-15A) ; mais l'**en-tête** ne suit pas un renommage ultérieur |
| F3  | RT17 — invitations                              | invitation créée par un collègue **absente** de la liste                                |
| F4  | RT18 — image de marque                          | nouveau logo **jamais affiché** chez le collègue                                        |
| F5  | RT19 — coupure                                  | nom modifié pendant la coupure **non rattrapé**                                         |
| F6  | RT20 — changement de session                    | aucune relecture de l'organisation n'existait à retenir                                 |
| F7  | RT21 — signaux                                  | aucun signal d'organisation émis                                                        |

## 2. Correctifs API

- `SocketRegistryService` : `attachOrganizationEmitter` (branché par
  `EventsGateway.afterInit` sur son **`emitToOrganization`** : même room
  `organization:<id>`, même filtre de couverture d'abonnement) et
  `signalOrganization(organizationId, event)`, **payload `{}`**, best
  effort (une panne n'est jamais propagée ; sans passerelle, aucun effet).
- `OrganizationsService`, après chaque écriture validée :

| Opération                         | Signal                                   | Moment                                                            |
| --------------------------------- | ---------------------------------------- | ----------------------------------------------------------------- |
| Rôle / droits / statut            | `members:changed`                        | après commit **et** après la déconnexion existante du membre visé |
| Transfert de propriété            | `members:changed`                        | après commit et les deux déconnexions                             |
| Acceptation d'invitation          | `invitations:changed`, `members:changed` | après la fin de session (commit), hors du callback rejouable      |
| Création, révocation d'invitation | `invitations:changed`                    | après l'écriture ; rien sur refus ni 404                          |
| Nom, couleur, logo                | `organization:updated`                   | après la sauvegarde ; rien sur refus de validation                |
| Retrait du logo                   | `organization:updated`                   | seulement si un logo existait                                     |

Jamais d'e-mail, de membre, de permission, de jeton, de lien ni d'URL dans
un signal. Déconnexions existantes, JWT, isolation des organisations,
couverture d'abonnement : inchangés.

## 3. Correctifs web

| Fichier                                     | Changement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/app/layout.tsx`                        | `refreshOrganization` : relit **seulement** `GET /organizations/current`, ignore toute réponse d'une autre session, d'une autre organisation ou plus ancienne qu'une réponse appliquée (`createResponseOrder`, partagé avec le chargement du shell) ; met à jour nom, couleur, logo et l'instantané de marque hors ligne. `OrganizationLiveSync` (dans `SocketProvider`) : `organization:updated` → relecture regroupée, rattrapage à la reconnexion. **Ni relecture du contexte, ni passe de l'outbox, ni nouveau socket** |
| `contexts/organization-shell-context.tsx`   | `refreshOrganization` exposé                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `app/app/organization/branding/page.tsx`    | après sa propre modification : `refreshOrganization` au lieu de `refreshShell` (qui relisait le contexte et relançait l'outbox)                                                                                                                                                                                                                                                                                                                                                                                             |
| `app/app/organization/members/page.tsx`     | `members:changed` → relecture silencieuse, **seulement avec `members.manage`** ; ordre des réponses, rattrapage                                                                                                                                                                                                                                                                                                                                                                                                             |
| `app/app/organization/invitations/page.tsx` | `invitations:changed` → idem, **seulement avec `members.invite`**                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Le contexte serveur reste l'autorité : un signal ne donne aucun droit. Les
changements de droits continuent de passer par la déconnexion serveur et le
remontage des pages de 1-15A (données interdites retirées).

## 4. Recette

**Stockage simulé** (`api/test/recipe/storage-sim.js`, nouveau) : serveur
en mémoire sur `127.0.0.1:4298`, désigné à l'API par `S3_ENDPOINT` dans
l'environnement construit de la recette (`recipe-common.js`) et démarré par
le lanceur. L'API garde **son code de production** : vrai `S3Service`, vrai
client AWS (corps `aws-chunked` décodé par le simulateur), validations
complètes du logo avant envoi. Le navigateur charge le logo depuis ce
serveur comme depuis un vrai stockage public. Invitations : e-mails simulés
de D.2H, liens locaux (`PUBLIC_APP_URL` = web de la recette).

RT1–RT14 et leurs assertions sont inchangés. Nouveaux scénarios :

| #    | Scénario                                                                                                                                                            | Résultat observé (code corrigé)                                                                                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RT15 | Deux administrateurs ; le premier ajoute un droit à un vendeur, le suspend, puis le propriétaire transfère la propriété au premier                                  | chez le second : libellé du droit, « Suspendue », « Propriétaire » sans rechargement ; ≥ 3 `members:changed`, tous `{}`                                                                                                         |
| RT16 | Vendeur délégué `members.invite` sur ses invitations ; droit retiré, puis suspension                                                                                | liste et e-mails retirés ; **un** socket rouvert (signal suivant reçu : en-tête renommé) ; plus aucune lecture des invitations ; suspension → écran de refus                                                                    |
| RT17 | Second administrateur sur Invitations et Membres, vendeur standard sur les pages protégées ; création, révocation, nouvelle création, acceptation par le lien local | « En attente », « Révoquée », « Acceptée », nouveau membre listé ; vendeur : **0 requête** vers `/organizations/members                                                                                                         | invitations`, aucun e-mail dans son DOM ; aucune frame avec `@` |
| RT18 | Collègue sur le catalogue ; logo 240×120, renommage, logo 160×160, retrait du logo                                                                                  | logo **réellement chargé** (`complete`, dimensions naturelles exactes), nom, initiales après retrait ; 2 envois et des lectures au stockage simulé, ancien logo supprimé ; **0 nouveau socket, 0 relecture de `/auth/context`** |
| RT19 | Shell et invitations hors ligne ; nom, logo et invitation pendant la coupure                                                                                        | rattrapés à la reconnexion (logo 200×100 chargé)                                                                                                                                                                                |
| RT20 | Organisation B ouverte pendant des modifications de A ; puis session A → B avec une relecture de l'organisation A **retenue**                                       | B : 0 signal, 0 relecture, nom inchangé ; le nom de A n'apparaît **jamais** dans la session B (sentinelle)                                                                                                                      |
| RT21 | Vendeur standard ; invitation, acceptation, logo                                                                                                                    | tous les signaux reçus sont `{}` ; 0 lecture protégée                                                                                                                                                                           |

## 5. Tests API ajoutés

- `socket-registry.service.spec.ts` (+3) : sans passerelle aucun effet ;
  délégation `(organisation, événement, {})` ; panne non propagée.
- `events.gateway.spec.ts` (+1) : `afterInit` branche un émetteur qui
  délègue à `emitToOrganization`.
- `organizations.service.spec.ts` : création (après `create`, une fois),
  refus (aucune), révocation (404 : aucune) ; acceptation (deux signaux
  **après `endSession`**, rien sur invitation invalide ni rollback) ;
  modification de membre (après `endSession` et après `disconnectMember`,
  rien sur les quatre refus existants) ; transfert (après les deux
  déconnexions) ; image de marque (après `save`, rien sur refus ; retrait
  du logo seulement s'il existait). Mocks existants du registre complétés.

## 6. Validations (état final, environnement isolé)

Suites API et build web **exclusivement** par `recipe.js isolated`
(environnement construit, garde préchargée jusque dans les workers Jest,
copie web sans `.env*`).

| Contrôle                                                                                             | Résultat                                                                                        |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| RT15–RT21, `d7d4fde` (référence)                                                                     | **0/7** (F1–F7)                                                                                 |
| RT15–RT21, code corrigé                                                                              | 7/7 au premier passage                                                                          |
| `realtime` RT1–RT21, première campagne complète                                                      | **20/21** : RT20 en échec (« B : aucune relecture »), voir ci-dessous                           |
| RT20 seul après correction de la fenêtre d'observation                                               | 3/3                                                                                             |
| `realtime` RT1–RT21, campagne complète sur l'état final                                              | **21/21**                                                                                       |
| `scenarios` D.2H                                                                                     | **18/18**                                                                                       |
| `pnpm --filter web test:coordinator`                                                                 | **6/6**                                                                                         |
| `isolated api-unit`                                                                                  | **69/69 suites, 1352/1352** (+10 tests 1-15C) ; aucune tentative d'accès à un `.env`            |
| `isolated api-e2e`                                                                                   | **24/24 suites, 563/563** ; `existsSync api\.env` bloqué 23 fois, jamais lu                     |
| `isolated web-build`                                                                                 | compilé, 26 pages ; 3 `.env*` de `web/` écartés par leur nom, 0 dans la copie ; copie supprimée |
| `pnpm --filter api build` ; typage de **production** `api : npx tsc --noEmit -p tsconfig.build.json` | OK ; **0 erreur**                                                                               |
| `pnpm --filter api exec eslint "{src,apps,libs,test}/**/*.ts"` (sans `--fix`)                        | 0 erreur, 2 avertissements préexistants                                                         |
| `web : npx eslint .` (sans `--fix`) / `npx tsc --noEmit`                                             | 0 / 0                                                                                           |
| `npx jest src/organizations src/events src/sections src/products` (ciblé)                            | 23 suites, 486/486                                                                              |
| `npx prettier --check` ; `node --check` des scripts de recette ; `git diff --check`                  | OK ; OK ; OK                                                                                    |
| Lockfile                                                                                             | inchangé                                                                                        |

**Échec intermédiaire de RT20 — cause non confirmée.** Dans la première
campagne complète, RT20 a relevé une lecture de B vers
`/organizations/(current|invitations|members)` pendant la fenêtre
d'observation, alors que B n'avait reçu **aucun** signal de A (assertion
précédente vérifiée). La requête n'était pas nommée dans le message
d'échec : sa cause **reste non confirmée**. Hypothèse la plus probable : le
rattrapage normal de 1-15A, déclenché quand le socket de B se connecte après
le chargement initial de la page (limite déjà documentée en 1-15A).

Ajustement du scénario, sans code applicatif modifié :

- l'attente du **socket de B ouvert** puis d'une **page B au repos**
  (aucune requête pendant 1,5 s) est placée **avant** les mutations de A
  (renommage, invitation, modification de membre) et avant le début de la
  fenêtre observée ;
- les assertions d'isolation sont **conservées** : aucun signal de A reçu
  par B, aucune relecture de `/organizations/(current|invitations|members)`
  (désormais nommée en cas d'échec), nom de B inchangé, puis, lors du
  changement de session avec une relecture retenue, nom de A jamais affiché
  dans la session B (sentinelle) et en-tête toujours celui de B ;
- résultat : 3/3 sur RT20 seul, puis 21/21 en campagne complète.

### 6.1 Typage

Deux contrôles distincts :

- **Typage de production** (`tsconfig.build.json`, celui du build, qui
  exclut les specs) : **0 erreur** sur l'état final.
- **Typage complet** (`tsconfig.json`, specs et tests e2e compris) : il
  n'est pas propre sur la base. Mesure **comparée** à `d7d4fde` (même
  commande sur une copie de `api/src`, `api/test` et `tsconfig.json` de ce
  commit, placée temporairement sous `api/` pour résoudre les mêmes
  `node_modules`, puis supprimée ; comparaison des messages par fichier et
  code d'erreur, numéros de ligne ignorés) :

| Mesure                                                                          | `d7d4fde`                                 | 1-15C avant la correction          | 1-15C final |
| ------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------- | ----------- |
| Erreurs (`tsc --noEmit -p tsconfig.json`)                                       | 249 (+1 artefact de la copie, ci-dessous) | 251                                | **238**     |
| `TS2345` `createInvitation(… VALID_DTO …)` dans `organizations.service.spec.ts` | 11                                        | 13 (mes 2 nouveaux appels en plus) | **0**       |
| Erreurs absentes de `d7d4fde`                                                   | —                                         | 2 (mes 2 appels)                   | **aucune**  |

Correction : la fixture commune `VALID_DTO` est typée
`CreateInvitationDto` (même e-mail, même rôle `OrganizationRole.ADMIN`, qui
appartient aux `INVITABLE_ROLES`) ; aucune assertion, aucun `any`, aucune
suppression de diagnostic. Elle corrige aussi les 11 erreurs identiques des
appels existants. Les 2 erreurs restantes de ce fichier (`TS2352`,
`SelectableOrganization` vers `Record<string, unknown>`) sont présentes à
l'identique dans `d7d4fde` et restent hors périmètre, comme les autres
erreurs des specs.

Artefact de mesure : dans la copie de `d7d4fde`, `subscription-pricing.spec.ts`
ne trouve pas `../../../web/src/lib/subscription-offers` (chemin relatif vers
`web/` différent depuis le dossier temporaire) ; cette erreur n'existe pas
dans le dépôt et n'est pas comptée.

Après la correction : suites unitaires dans l'environnement isolé
(`recipe.js isolated api-unit`, qui exécute toute la suite, dont
`organizations.service.spec.ts`, `socket-registry.service.spec.ts` et
`events.gateway.spec.ts`) **69/69, 1352/1352** ; `eslint` (sans `--fix`) et
Prettier des six fichiers API concernés : 0 erreur. Seul le type de la
fixture ayant changé, les campagnes navigateur et les suites e2e n'ont pas
été relancées.

## 7. Fichiers

| Fichier                                                                                                                           | Changement                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `api/src/organizations/socket-registry.service.ts`                                                                                | `OrganizationSignal`, `attachOrganizationEmitter`, `signalOrganization` (payload `{}`, best effort) |
| `api/src/events/events.gateway.ts`                                                                                                | `afterInit` branche `emitToOrganization` sur le registre                                            |
| `api/src/organizations/organizations.service.ts`                                                                                  | signaux après création, révocation, acceptation, modification de membre, transfert, image de marque |
| `api/src/organizations/organizations.service.spec.ts`, `socket-registry.service.spec.ts`, `api/src/events/events.gateway.spec.ts` | +10 tests, mocks du registre complétés ; fixture `VALID_DTO` typée `CreateInvitationDto`            |
| `web/src/app/app/layout.tsx`                                                                                                      | `refreshOrganization`, `OrganizationLiveSync`                                                       |
| `web/src/contexts/organization-shell-context.tsx`                                                                                 | `refreshOrganization`                                                                               |
| `web/src/app/app/organization/branding/page.tsx`                                                                                  | relecture de l'organisation seule après modification                                                |
| `web/src/app/app/organization/members/page.tsx`, `invitations/page.tsx`                                                           | relecture sur signal selon le droit, ordre, rattrapage                                              |
| `api/test/recipe/storage-sim.js`                                                                                                  | **Nouveau** : stockage objet simulé                                                                 |
| `api/test/recipe/recipe-common.js`, `launcher.js`                                                                                 | port `storage` 4298, `S3_ENDPOINT` de la recette, démarrage et arrêt du simulateur                  |
| `api/test/recipe/realtime-scenarios.js`                                                                                           | RT15–RT21 et aides (RT1–RT14 inchangés)                                                             |
| `api/test/recipe/recipe.js`                                                                                                       | aide de la commande `realtime`                                                                      |
| `docs/architecture/phase-1-15c-realtime-organization.md`                                                                          | **Nouveau** : ce document                                                                           |

Inchangés : schémas, DTO, routes, permissions, règles métier, `S3Service`,
validations du logo, middleware Socket.IO, ventes, outbox, abonnements,
paiements, service worker, `env-guard.cjs`, `isolated-checks.js`, lockfile,
`.env`.

## 8. Limites restantes

- **Le temps réel n'est pas terminé globalement.** Abonnement et paiements
  restent relus à l'ouverture et vérifiés manuellement (inchangés).
- **Multi-instance hors périmètre** : registre, émetteur et rooms en
  mémoire d'un seul processus.
- **Purge des sections non vides** (1-15B) et **échec ponctuel du test de
  concurrence de paiement** (1-15B, non reproduit) : sujets distincts, non
  traités ici.
- **Formulaire Branding** : s'il est ouvert pendant qu'un collègue modifie
  le nom, le champ est réhydraté avec la valeur serveur (comportement
  existant de la page, désormais déclenché aussi par le temps réel).
- **Invitation expirée** : l'expiration est constatée à la prochaine
  création pour le même e-mail (comportement existant) ; aucun signal n'est
  émis au simple passage du temps.
- **Session limitée / accès bloqué** : aucun socket (1-14C.2), donc aucun
  signal d'organisation ; relecture à la reprise de l'accès.
