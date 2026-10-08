# Phase 1-12G — Invitations par lien et confirmation du mot de passe

Branche `architecture/phase-1-12g-invitation-link-flow`, base `5753f8b` (1-12F). Aucun commit, aucun push, aucun déploiement. **Aucun accès à Atlas, Supabase ni au port hôte 27017 ; aucune donnée réelle ; aucun email envoyé** : tests sur `MongoMemoryReplSet` éphémère. Aucun paquet ajouté ni mis à jour (manifestes et lockfile inchangés, audit non relancé). Stash existant non touché ; vrais fichiers `.env` non modifiés.

## Décisions

| Sujet | Décision |
| --- | --- |
| Envoi automatique | **Supprimé** : aucun appel à Resend, module email retiré (seul consommateur : les invitations) |
| Contrat de création | `{ invitation, invitationUrl }` ; `token` et `delivery` retirés |
| Origine du lien | `PUBLIC_APP_URL` validée (origine http(s) nue), jamais `Host` ni `window.location` |
| Sans `PUBLIC_APP_URL` valide | 503 `INVITATION_LINK_UNAVAILABLE` **avant** toute lecture ou écriture d'invitation |
| Acceptation | Contrat inchangé (`{ token }`, puis `{ token, name, password }`) |
| Confirmation du mot de passe | Inscription publique et création de compte par invitation ; contrôle côté interface uniquement |
| Rate limiting | Inchangé (création 5/60 s par utilisateur+organisation ; acceptation par IP) |

## 1. Cause reproduite

Stack locale (API compilée, `next build` + `next start`), invitation créée **depuis l'interface**, lien copié par le bouton, ouvert dans un **nouveau contexte navigateur** :

- `/auth/invitations/accept` est prérendue statiquement. Le token était lu dans l'initialiseur de `useState` (`window` absent au prérendu), donc **le HTML servi contenait « Lien d'invitation invalide. » + « Se connecter »**.
- Au chargement : erreur React **#418** (écart d'hydratation), puis rendu client correct.
- Sur un appareil lent (CPU ×6, 3G émulés) : **l'invité voit « Lien d'invitation invalide. » pendant ~7 s** avant « Vérification… ». Sur un appareil rapide, le parcours finit par aboutir, d'où un symptôme intermittent. Si le JavaScript échoue, l'erreur reste affichée.
- Autres défauts constatés : le lien était construit côté client avec `window.location.origin` et un token non encodé ; un échec du presse-papiers n'était pas géré (promesse rejetée, aucune alternative).

## 2. Correction

**API**
- `invitation-link.ts` : `parsePublicAppOrigin` (http/https, sans identifiants, chemin, query ni fragment) et `buildInvitationUrl` (`/auth/invitations/accept?token=` + `encodeURIComponent`).
- `createInvitation` : origine vérifiée juste après les contrôles de permission ; réponse `{ invitation, invitationUrl }`. Le token brut n'existe que dans ce lien, renvoyé une seule fois ; seul son hash SHA-256 est stocké ; les listes ne l'exposent jamais.
- Supprimés : `api/src/email/` (`EmailModule`, `EmailService`, `ResendEmailService`, spec), `test/invitation-email-delivery.e2e-spec.ts`, injection dans `OrganizationsService`.

**Web**
- Page d'acceptation : le token est lu **après le montage** (même HTML serveur et client : « Vérification de l'invitation… »), retiré de l'URL et gardé en mémoire (`ref`). Démarrage unique (garde contre les effets rejoués) ; garde synchrone contre la double soumission ; token absent → aucun appel ; erreur réseau → aucune relance automatique, bouton « Réessayer » explicite ; succès → « Invitation acceptée », nom de l'organisation, lien vers la connexion, sans connexion automatique ni modification du `localStorage`.
- Dialogue de création : titre « Invitation créée », lien en lecture seule sélectionnable, « Copier le lien » → « Lien copié », date d'expiration. Si le presse-papiers échoue : lien sélectionné et message de copie manuelle ; la copie n'appelle jamais l'API. Garde contre le double clic à la création. Messages d'envoi et de livraison d'email retirés.
- `NewPasswordFields` (nouveau) : « Mot de passe » et « Confirmer le mot de passe », `autocomplete="new-password"`, un seul bouton afficher/masquer pour les deux champs, indication 6 à 100 caractères.
- `password-policy.ts` (nouveau) : miroir de la politique backend (`MinLength(6)`, `MaxLength(100)`), aucun trim ; message « Les mots de passe ne correspondent pas. ». Seul `password` est envoyé.
- Inscription publique : confirmation, garde de double soumission. Toujours désactivée par défaut.
- Libellé de révocation : « L'invitation destinée à… » (au lieu de « envoyée à »).

**Configuration**
- `api/.env.example`, `.env.prod.example` : `RESEND_API_KEY`/`EMAIL_FROM` retirés ; `PUBLIC_APP_URL` documentée comme requise.
- `docker-compose.prod.yml` : `RESEND_API_KEY`/`EMAIL_FROM` retirés ; `PUBLIC_APP_URL: ${PUBLIC_APP_URL:-${WEB_URL}}` (l'URL publique du frontend, déjà utilisée pour `CORS_ORIGIN`).

## 3. Contrat final

```
POST /organizations/invitations            (members.invite, 5/60 s)
  → 201 { invitation: { _id, email, role, permissions, status, expiresAt },
          invitationUrl: "<PUBLIC_APP_URL>/auth/invitations/accept?token=<encodé>" }
  → 503 { code: "INVITATION_LINK_UNAVAILABLE" }  si PUBLIC_APP_URL absente/invalide (aucune écriture)

POST /auth/invitations/accept              (public, rate-limité par IP) — inchangé
  { token }                   → 200 compte existant rattaché | 400 ACCOUNT_DETAILS_REQUIRED (non consommée)
  { token, name, password }   → 200 compte créé
  invalide/expirée/révoquée/déjà acceptée → 400 INVITATION_INVALID_OR_EXPIRED
```

L'email, l'organisation, le rôle et les permissions viennent de l'invitation côté serveur.

## 4. Tests API

- `organizations.service.spec.ts` : lien construit depuis `PUBLIC_APP_URL` et token encodé ; 8 valeurs invalides → 503 sans lecture ni écriture ; 403 prioritaire sur 503 ; seule `PUBLIC_APP_URL` est lue ; token absent de la réponse et du document créé.
- `invitations.e2e-spec.ts` : réponse exacte `{ invitation, invitationUrl }` ; token absent de la base et de la liste ; **en-têtes `Host`/`X-Forwarded-Host` forgés sans effet** ; nouveau test du **parcours par lien avec inscription publique fermée** : `{ token }` → `ACCOUNT_DETAILS_REQUIRED`, invitation toujours `pending`, aucun utilisateur ; compte créé (nom trimé, rôle et permissions de l'invitation) ; rejeu refusé ; **mot de passe non trimé** (le mot de passe trimé → 401) ; connexion à la bonne organisation.
- `invitation-rate-limiting.e2e-spec.ts` : `fetch` mocké, **aucun appel réseau** sur les 5 créations autorisées ni sur la 6e (429).
- Tests email (1-10B) supprimés avec le code : 13 tests unitaires Resend, 6 tests unitaires de livraison, 6 e2e.

## 5. Parcours réels (Playwright temporaire hors dépôt)

Stack : `MongoMemoryReplSet`, API compilée (:4100, `PUBLIC_APP_URL=http://localhost:3100`), `next build` + `next start` (:3100, service worker actif). **11/11**.

| # | Scénario | Résultat |
| --- | --- | --- |
| 1 | Création UI, copie, lien `http://localhost:3100/auth/invitations/accept?token=<43 car.>`, expiration affichée, lien absent de la liste et de la base | OK |
| 1, 7, 8 | Lien copié dans un nouveau contexte : **aucune erreur d'hydratation**, URL nettoyée, 1er POST `{ token }` seul ; confirmation différente et mot de passe trop court → **aucun POST** ; identique + double clic → **un seul** POST `{ token, name, password }`, mot de passe non trimé, confirmation jamais envoyée ; connexion : organisation A, rôle `seller` | OK |
| 5 | Rejeu du lien utilisé → « Cette invitation est invalide ou a expiré. », 1 utilisateur, 1 membership | OK |
| 5 | Double clic sur « Créer l'invitation » → 1 POST, 1 invitation | OK |
| 2, 6 | Compte existant (propriétaire B) invité dans A avec « Voir les analyses », lien ouvert **dans le navigateur du propriétaire A connecté** : rattaché sans formulaire, **session A inchangée**, membership A `seller` + `analytics.read`, membership B `owner` intacte, invitation invisible pour B | OK |
| 4 | Token absent → message, **0 POST** ; invalide, expiré, révoqué → message générique, aucun compte | OK |
| — | Erreur réseau → message, **aucune relance** en 1,5 s ; « Réessayer » → formulaire, invitation toujours `pending` | OK |
| 9 | `clipboard.writeText` rejeté, 3 clics sur « Copier » → message de copie manuelle, lien sélectionné en entier, **1 POST**, 1 invitation | OK |
| 7, 8 | Inscription publique : confirmation différente → 0 POST ; identique + double clic → 1 POST, compte créé | OK |
| 10 | Cache Storage (créateur et invité, SW actif) : **aucun token**, aucune entrée `/auth/invitations/accept` ni `token=` ; **aucune requête hors localhost** sur toute la session | OK |
| 3 | Build web et API avec inscription publique **fermée** : `/auth/register` → 403 `REGISTRATION_DISABLED`, page « Inscription désactivée » ; invitation `admin` acceptée, rôle `admin` à la connexion | OK |

Sonde lente après correction (CPU ×6, 3G) : « Vérification de l'invitation… » dès le premier affichage, puis le résultat ; aucune erreur de page. HTML statique : « Vérification de l'invitation… ».

Artefacts de test, pas des défauts : le rate limiting existant (10 acceptations par minute et par IP) bloquait les exécutions successives depuis localhost. L'API a été redémarrée entre groupes de scénarios (base conservée) et les créations réparties entre plusieurs propriétaires (5 créations/60 s). Dans Cache Storage, un chunk JS versionné contient le chemin de la route sous forme de texte (table de routes Next) : ce n'est ni une page ni un token.

## 6. Validation du dépôt

| Commande | Résultat |
| --- | --- |
| `pnpm --filter api test` | **48 suites, 784/784** (1-12F : 49 / 792 ; −19 tests email, +11) |
| `pnpm --filter api test:e2e` | **11 suites, 290/290** (1-12F : 12 / 294 ; −6 e2e email, +2) |
| `eslint` API | 0 erreur, 2 avertissements préexistants (`test/app.e2e-spec.ts:505`, `test/e2e/ephemeral-mongodb.ts:67`) ; 3 erreurs Prettier dans les nouveaux tests corrigées, suites concernées relancées (96/96, 32/32) |
| `pnpm --filter api build` | OK |
| `pnpm --filter web lint` / `exec tsc --noEmit` / `build` | OK / OK / OK |
| `docker compose -f docker-compose.prod.yml --env-file .env.prod.example config` | OK (`PUBLIC_APP_URL` résolue depuis `WEB_URL`) ; `docker-compose.yml` inchangé, OK |
| `git diff --check` | Propre |

## 7. Fichiers

| Fichier | Changement |
| --- | --- |
| `api/src/organizations/invitation-link.ts` | **Nouveau** : validation de l'origine, construction du lien |
| `api/src/organizations/organizations.service.ts` | `invitationUrl`, 503 sans origine, envoi retiré |
| `api/src/organizations/organizations.module.ts` | `EmailModule` retiré |
| `api/src/email/*` (4 fichiers) | **Supprimés** |
| `api/src/organizations/organizations.service.spec.ts` | Tests du lien, stubs `ConfigService` |
| `api/test/invitations.e2e-spec.ts` | Contrat, `Host` forgé, parcours par lien |
| `api/test/invitation-rate-limiting.e2e-spec.ts`, `organization-branding.e2e-spec.ts` | `PUBLIC_APP_URL`, token extrait du lien |
| `api/test/invitation-email-delivery.e2e-spec.ts` | **Supprimé** |
| `web/src/app/auth/invitations/accept/page.tsx` | Lecture du token après montage, confirmation, gardes |
| `web/src/app/auth/register/page.tsx` | Confirmation, garde de double soumission |
| `web/src/components/auth/new-password-fields.tsx`, `web/src/lib/password-policy.ts` | **Nouveaux** |
| `web/src/components/organization/create-invitation-dialog.tsx` | Lien, copie, copie manuelle, expiration |
| `web/src/lib/api.ts`, `web/src/lib/organization-errors.ts` | Contrat `CreatedInvitation`, message 503 |
| `web/src/app/app/organization/invitations/page.tsx` | Libellé de révocation |
| `api/.env.example`, `.env.prod.example`, `docker-compose.prod.yml` | Variables Resend retirées, `PUBLIC_APP_URL` |

Inchangés : manifestes, lockfile, `web/public/sw.js` (la route d'acceptation y était déjà exclue), Dockerfiles, schémas, DTO, rate limiting, rapports historiques.

## 8. Limites

- **Posséder le lien ne prouve pas l'accès à la boîte mail.** Aucune adresse n'est marquée vérifiée ; toute personne qui reçoit le lien peut créer le compte associé à l'adresse invitée. La vérification d'email, « Mot de passe oublié » et Google sont hors périmètre (phases suivantes) ; aucun bouton correspondant n'est affiché.
- Le lien n'est affiché qu'une fois : s'il est perdu, il faut révoquer et recréer l'invitation.
- **Action requise en local** : `api/.env` ne définit pas `PUBLIC_APP_URL` (fichier non modifié). Sans cette variable, la création d'invitation répond 503. Ajouter `PUBLIC_APP_URL=http://localhost:3000`. En production, `WEB_URL` sert de valeur par défaut via Compose.
- Un rechargement de la page d'acceptation après le retrait du token affiche « Lien d'invitation incomplet » : il faut rouvrir le lien reçu (l'invitation n'est pas consommée tant que le compte n'est pas créé).
- Le rate limiting de l'acceptation reste par IP : plusieurs invités derrière une même IP partagent le quota (comportement existant).
