# Lot 1-18B — Sécurisation de l'acceptation des invitations

État : **implémenté, non commité**, sur `fix/phase-1-18b-invitation-acceptance`
(créée depuis `feature/phase-1-17b-storage-quotas-product-actions`, HEAD
`74c7e39`). Le rapport 1-18A (non suivi) et `stash@{0}` sont conservés.
Aucun commit, push ou déploiement, aucun service réel ni `.env`, aucun
MongoDB réel. Les limites du login sont inchangées et Turnstile n'est pas
intégré.

## 1. Problème corrigé (1-18A, P1-1)

Le lien d'invitation est remis au **créateur**. Avant ce lot,
`POST /auth/invitations/accept { token }`, une route publique, rattachait
n'importe quel compte existant à l'organisation et renvoyait son nom. Le
détenteur du lien pouvait donc imposer une adhésion et savoir si une adresse
avait un compte (400 `ACCOUNT_DETAILS_REQUIRED` ou 200). Pour un nouveau
compte, le détenteur choisissait aussi le mot de passe ; un clic du vrai
titulaire sur le lien de vérification activait alors ce compte.

## 2. Nouveaux parcours

| Route | Accès | Rôle |
|---|---|---|
| `POST /auth/invitations/inspect` `{ token }` | Session requise (JWT applicatif **ou limité**) | Aperçu (organisation, rôle) si l'invitation est utilisable **et** destinée à l'adresse de la session. Aucune écriture |
| `POST /auth/invitations/accept` `{ token, consent: true }` | Session requise | Rattachement du compte de la session après accord explicite. La réclamation est conditionnée à l'adresse de la session |
| `POST /auth/invitations/credentials/inspect` `{ token, email, password }` | Public, identifiants | Compte **sans organisation active** (aucune session possible) : même aperçu, sans écriture |
| `POST /auth/invitations/credentials/accept` `{ token, email, password, consent: true }` | Public, identifiants | Même rattachement que `accept`. **Aucun jeton délivré** |
| `POST /auth/invitations/account-link` `{ token }` | Public | 202 neutre. Après la réponse, et seulement si l'adresse n'a **aucun** compte, un lien de création est envoyé **à l'adresse invitée** |
| `POST /auth/invitations/create-account` `{ token, name, password, legalAcceptance }` | Public | `token` = lien **reçu par e-mail**. Compte créé **vérifié**, avec membership et preuve légale dans une transaction |

- **Compte existant avec session** : il faut une session de ce compte et
  `consent: true`.
  - Une session d'un autre compte reçoit 403 `INVITATION_ACCOUNT_MISMATCH` et
    ne consomme rien.
  - Sans session, la réponse est 401 avant toute lecture du corps, quelle que
    soit sa forme.
  - Aucune adhésion préalable à l'organisation cible n'est exigée.
  - Les réponses ne contiennent ni nom ni adresse.
- **Compte existant sans organisation active** : la connexion lui est
  refusée (`ORGANIZATION_ACCESS_DENIED`, comportement inchangé), il ne peut
  donc pas ouvrir de session. L'identité est prouvée par les identifiants,
  sans nouvelle forme de session.
  - **Même vérification que le login** : `AuthService.verifyCredentials`,
    extraite de `login` et réutilisée telle quelle. Elle impose un mot de
    passe correct (401 générique identique au login) puis une adresse
    vérifiée (403 `EMAIL_NOT_VERIFIED`).
  - **Mêmes compteurs de limitation que le login** :
    `LoginSharedThrottlerGuard` reprend la clé de `AuthController.login`.
    Ces routes n'offrent donc aucun essai de mot de passe supplémentaire par
    IP.
  - **Aucun JWT** n'est délivré par ces routes. Avant l'adhésion, aucune
    route métier ni réservée à une organisation n'est accessible. Après
    l'adhésion, l'accès passe par un login normal, avec tous les contrôles
    existants (membership, organisation active, abonnement, version de
    session).
  - **Session révoquée** : non applicable, aucune session n'intervient. Un
    mot de passe réinitialisé invalide l'ancien (testé).
  - **Compte désactivé** : le modèle `User` n'a aucun état de désactivation.
    Les états existants restent appliqués : membership suspendue ou révoquée
    dans l'organisation cible (409, jamais réactivée) et organisation
    suspendue (400).
  - **L'acceptation par le lien seul n'est jamais rétablie** : l'accord
    explicite (`consent: true`) et les identifiants du compte de l'adresse
    invitée sont toujours requis.
- **Nouveau compte** : le lien du créateur ne crée jamais de compte. Le nom
  et le mot de passe sont choisis **après** l'ouverture du lien reçu à
  l'adresse invitée ; ce lien vaut preuve de l'adresse (`emailVerifiedAt`).
  Avant cette étape, aucun compte n'existe.
- **Lien de création** :
  - 32 octets aléatoires, stockage SHA-256 (`select: false`) ;
  - validité de 24 h au plus, bornée par l'expiration de l'invitation ;
  - usage unique, remplacement du lien précédent ;
  - délai de 60 s entre deux envois, 5 envois par invitation, demandes
    concurrentes → un seul envoi ;
  - compte apparu entre-temps → 409 `INVITATION_ACCOUNT_EXISTS`,
    invitation conservée.
- **Garanties conservées** : expiration, révocation, usage unique, transaction
  unique avec rollback, membership copiée de l'invitation, signaux temps
  réel, limitation par IP, indépendance vis-à-vis de
  `PUBLIC_REGISTRATION_ENABLED`.
- **Web** :
  - `/auth/invitations/accept` couvre : sans session, avec session, mauvais
    compte (« Changer de compte »), session expirée, déjà membre, annulation.
  - `/auth/invitations/create-account` : rendu dynamique, sans référent, non
    indexée.
  - Page de connexion (marqueur fixe `?next=invitation`) :
    - retour à l'invitation après connexion ;
    - pour un compte sans organisation active, aperçu « Rejoindre … » avec
      « Compte : … », puis « Accepter l'invitation » (adhésion, puis
      connexion normale) ou « Pas maintenant » (rien n'est modifié).
  - Le token n'est conservé que dans le `sessionStorage` de l'onglet. Il
    n'apparaît jamais dans une URL de redirection ni dans un journal.
  - Le service worker exclut `/auth/invitations/`. Textes en FR et EN, sur
    mobile et bureau.

## 3. Index `accountTokenHash` : configuration réelle et migration

- **Configuration de production (dépôt)** : la connexion Mongoose
  (`app.module.ts`) ne règle pas `autoIndex`, donc la valeur par défaut
  `true` s'applique. Le schéma des invitations n'a pas `autoIndex: false`,
  contrairement aux schémas critiques des lots précédents. L'index déclaré
  dans le schéma est donc créé **en arrière-plan au démarrage de l'API**,
  sans garantie de disponibilité avant le premier trafic et sans erreur
  visible en cas d'échec. Collection réelle : `organizationinvitations`
  (vérifié par le test).
- **Décision** : création **explicite et idempotente** ajoutée au mécanisme
  existant `migrate:predeploy`.
  - Nouvelle migration `create-invitation-account-token-index` (helper
    `organizations/invitation-account-index.ts`, script
    `migrate:invitation-account-token-index`, option `--check` en lecture
    seule).
  - Ajoutée en dernière position de `PREDEPLOY_MIGRATIONS`.
  - Sans effet si l'index exact existe. Échec sans rien écraser si un index
    homonyme diffère.
  - Le schéma déclare le **même nom** (`accountTokenHash_1`) et les mêmes
    options : `autoIndex` et la migration aboutissent au même index, sans
    conflit.
- **Migration d'index, pas migration de données** : aucune donnée lue ni
  écrite. Les quatre nouveaux champs sont facultatifs et absents des
  invitations existantes ; aucune reprise n'est nécessaire.
- **Nature de l'index** : index de performance (partiel, non unique).
  L'exactitude repose sur les filtres conditionnels du service. Sans lui, la
  recherche du lien parcourt la collection ; il n'est donc pas vérifié au
  démarrage, comme l'index des preuves légales (1-16C.2).

## 4. Ordre de déploiement API / web

1. **Pré-déploiement API** (Railway « Pre-deploy Command », inchangée) :
   `node /app/api/dist/migrations/predeploy-migrations.js`. Elle crée
   l'index (première fois) ou ne fait rien. Contrôle facultatif en lecture
   seule : `node /app/api/dist/migrations/create-invitation-account-token-index.js --check`.
2. **API**, avant le web. Les nouvelles routes existent alors. L'ancien web
   encore en service appelle `accept` sans session : il reçoit 401 et
   l'invité est bloqué jusqu'au déploiement du web, sans aucune écriture
   (aucune acceptation ne passe par le lien seul).
3. **Web (Vercel)**, juste après. Un onglet ou une PWA ouverts avant le
   déploiement doivent être rechargés.

Pour un retour arrière, le web doit revenir **avant** l'API (inverse de
l'ordre ci-dessus). L'index et les champs facultatifs peuvent rester : ils
sont ignorés par l'ancien code. L'ancien code rétablirait toutefois la
faille d'acceptation par le lien seul.

## 5. Preuves (locales, isolées)

| Contrôle | Résultat |
|---|---|
| Unitaires API ciblés (`src/auth`, `organizations`, `subscriptions`, `common`, `users`, `migrations`) | 44 suites, **933/933** |
| E2E `invitations` (MongoDB éphémère, expéditeur simulé), dont 26 tests 1-18B (19 + 7 « sans organisation active ») | **44/44** |
| E2E `invitation-account-index` (nouveau) : index exact, idempotence, compatibilité `autoIndex`, refus d'un index homonyme différent sans écrasement, présence dans `PREDEPLOY_MIGRATIONS` | **6/6** |
| Migrations **compilées** en processus séparés sur base éphémère : `--check` avant (sortie 1), `predeploy-migrations.js` (0, index créé), `--check` (0), migration seule rejouée (0, sans effet), pré-déploiement rejoué (0), sans `MONGODB_URI` (1) | **6/6** |
| E2E `subscriptions` après correction (§6) | **29/29** |
| E2E login et contexte : `app`, `auth-organizations`, `trust-proxy` | **98/98** |
| E2E adaptés : `email-verification`, `password-reset`, `legal-acceptance`, `organization-branding`, `product-field-permissions`, `invitation-rate-limiting` | **159/159** sur deux passages consécutifs (voir §7 pour un passage antérieur instable) |
| Navigateur réel (Chromium headless piloté par CDP, recette locale 127.0.0.1) : S1 à S5 (25/25) et S6 « compte sans organisation active » (11/11) | **36/36** |
| `tsc` API (build) et web, ESLint sur les fichiers modifiés, `test:i18n`, `i18n:coverage`, `next build` | OK |

Les tests E2E « sans organisation active » couvrent :

- l'absence de session possible (connexion 403, aucun jeton, `/auth/context`
  en 401) ;
- les mauvais identifiants (mot de passe faux, adresse inconnue, mot de
  passe réinitialisé), avec un 401 au message identique au login ;
- une adresse non vérifiée (403) ;
- un mauvais compte, c'est-à-dire des identifiants valides d'une autre
  adresse (403, aucun nom) ;
- l'accord absent, faux ou `"true"` (400) ;
- une acceptation réussie : aucun jeton, membership exacte, ancienne
  membership révoquée jamais réactivée, rejeu refusé, puis login normal vers
  l'organisation cible seulement ;
- la **limitation partagée** : 6 échecs de login puis 4 vérifications par
  identifiants passent, la 5ᵉ et le login suivant sont refusés (429).

Les autres cas E2E et navigateur (créateur, sans session, session expirée,
mauvais compte, accord, nouveau compte, états d'invitation, concurrence,
non-divulgation, retour après connexion) sont ceux décrits dans les
versions précédentes de ce rapport. Ils ont été rejoués sur cette version.
Scripts et captures : scratchpad de session (`invite-browser.mjs`,
`predeploy-cli.cjs`, `shots/`), hors dépôt.

Note de méthode : pendant la recette, les relances répétées du script ont
atteint la limite de connexion par IP (429 attendu, 30 par 15 min). L'API de
recette a été redémarrée par son port de contrôle local pour remettre ces
compteurs en mémoire à zéro, et le dernier contrôle de S6 passe par la
liste des membres plutôt que par une connexion supplémentaire.

## 6. Échec `subscriptions.e2e` : `logoStorage`

- **Attente examinée** : « 2. Essai de 7 jours › inscription… » compare la
  liste exacte des clés d'une `Organization` créée par l'inscription, pour
  prouver qu'aucun champ commercial n'y est ajouté.
- **Contrat voulu** : `logoStorage` (`String`, défaut `null`) a été ajouté
  au schéma par le lot 1-17A (`a7e74f3`, rapport 1-17A §1 : « `logoKey` +
  `logoStorage` »). C'est l'identité du stockage du logo, pas un champ
  commercial. L'attente était donc **obsolète** depuis 1-17A.
- **Preuve que l'échec précède ce lot** : le test exécuté sur `HEAD`
  (`74c7e39`, sans aucune modification de ce lot), dans un worktree détaché
  temporaire hors dépôt, échoue avec le même écart (`+ "logoStorage"`). Le
  worktree a ensuite été retiré ; le dépôt, ses `node_modules` et le stash
  n'ont pas été touchés.
- **Correction** : `logoStorage` est ajouté à la liste exacte, qui reste
  stricte (tout autre champ ferait toujours échouer le test). Le test
  vérifie en plus `logoKey === null` et `logoStorage === null`. Résultat :
  29/29.

## 7. Limites et points ouverts

- **Instabilité d'un test 1-13A, sans lien avec ce lot** :
  - **Constat** : `email-verification.e2e` §7 (« Resend timeout… ») vérifie
    `not.toMatch(/resend|http|422|503/i)` sur une réponse qui contient des
    identifiants et un slug aléatoires. Un passage isolé a échoué parce que
    le slug généré valait `org-fail-3fd4d422`.
  - **Origine** : l'assertion date de `21ea913` (lot 1-13A) et ce lot ne la
    modifie pas.
  - **Passages concernés** : un passage antérieur des six suites avait
    montré 4 échecs dans cette même section §7, sans message conservé : leur
    cause n'est **pas établie**. Les passages suivants sont propres : deux
    fois 159/159 et 8 passages de la suite seule (21/21).
  - **Statut** : non corrigé (hors périmètre), à rendre déterministe dans
    un lot de tests.
- Après l'acceptation avec une session, celle-ci reste sur l'organisation
  courante : « Se reconnecter » permet de choisir. Aucun sélecteur
  d'organisation n'est ajouté.
- **Relais d'e-mails** : un détenteur de `members.invite` peut faire envoyer
  au plus 5 liens par invitation à l'adresse qu'il a choisie. Ce volume est
  borné par la création d'invitations (5/min) et par la limite IP. Il n'y a
  pas de plafond par adresse toutes invitations confondues.
- Les routes par identifiants héritent des propriétés du login : pas de
  limite par compte, et l'écart de temps « compte inconnu » relevé en 1-18A
  (P2-3, P2-4) s'applique aussi à elles. Elles n'ajoutent aucun essai par IP.
- La langue de l'e-mail de création est celle de la page qui l'a demandé.
- Les erreurs de type préexistantes de certaines specs (hors
  `tsconfig.build.json`) restent inchangées.

## 8. Fichiers

API :
- `src/organizations/invitation-acceptance.service.ts`,
  `invitation-account-email.ts`, `invitation-account-index.ts` et
  `invitation-acceptance.spec.ts` (nouveaux) ;
- `invitation-link.ts`, `organizations.module.ts`,
  `organizations.service.ts` (ancienne acceptation retirée, avec sa suite
  unitaire), `schemas/invitation.schema.ts` (+ spec) ;
- `src/auth/auth.controller.ts`, `auth.service.ts` (`verifyCredentials`),
  `auth.module.ts` et `dto/accept-invitation.dto.ts` (+ specs) ;
- `src/common/auth-rate-limiting.ts` (`LoginSharedThrottlerGuard`) ;
- `src/migrations/create-invitation-account-token-index.ts` (nouveau) et
  `predeploy-migrations.ts` ;
- `package.json` (script `migrate:invitation-account-token-index`) ;
- `src/users/users.service.ts`, `src/common/i18n/error-messages.ts`,
  `src/common/validation/name-rules.ts` (+ spec),
  `src/subscriptions/subscription-access-routes.spec.ts`.

Tests API :
- `test/e2e/invitation-acceptance-fixtures.ts` et
  `test/invitation-account-index.e2e-spec.ts` (nouveaux) ;
- `test/e2e/email-verification-fixtures.ts` ;
- E2E `invitations`, `email-verification`, `password-reset`,
  `legal-acceptance`, `organization-branding`, `product-field-permissions`,
  `subscriptions` ;
- recette : `test/recipe/actions.js`, `realtime-scenarios.js`,
  `seed-fixtures.js`.

Web :
- `app/auth/invitations/accept/page.tsx` ;
- `app/auth/invitations/create-account/{page,layout}.tsx` (nouveaux) ;
- `app/auth/login/page.tsx`, `lib/api.ts` ;
- `lib/pending-invitation.ts` (nouveau) ;
- `i18n/resources/{fr,en}/auth.ts`, `public/sw.js`.

Racine : `README.md` (tableau des migrations de pré-déploiement).
