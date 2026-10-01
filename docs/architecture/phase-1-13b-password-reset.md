# Phase 1-13B — Mot de passe oublié et réinitialisation sécurisée

Branche `architecture/phase-1-13b-password-reset`, base `21ea913` (1-13A). Aucun commit, aucun push, aucun déploiement. **Aucun accès à Atlas, Supabase ni au port hôte 27017 ; aucune donnée réelle ; aucun email réel** : `MongoMemoryReplSet` éphémère, expéditeur simulé, `fetch` mocké dès que l'expéditeur Resend réel est branché. Aucun paquet ajouté ni mis à jour (manifestes et lockfile inchangés, audit non relancé). Aucun vrai fichier `.env` modifié ; Compose inchangé (mêmes variables qu'en 1-13A). Stash existant non touché.

Hors périmètre : Google, changement d'adresse email, nouvelle politique de mot de passe, refonte de l'authentification ou des invitations.

## Décisions

| Sujet | Décision |
| --- | --- |
| Sessions | Nouveau `User.authVersion` (absent = 0), claim JWT `ver`, comparé à chaque requête et à chaque handshake |
| Lien | `randomBytes(32)` base64url, **SHA-256 seul en base**, 1 h, usage unique, champs propres (`passwordReset*`, `select: false`), aucun index TTL |
| Écriture | Une seule `updateOne` conditionnée (token, expiration, version) : mot de passe + version + retrait du lien |
| Emails | **Même** `EMAIL_SENDER`/Resend qu'en 1-13A (module exporté), clés d'idempotence par type |
| Sockets | Registre existant (1-7C) étendu : fermeture ciblée par version, toutes organisations |
| Réponse publique | Recherche du compte et envoi **après** la réponse ; seule la configuration absente répond 503 |

## 1. Audit

- **Mot de passe** : `User.password` (`select: false`), bcryptjs coût 10 à l'inscription et à l'acceptation d'invitation ; DTO `@IsString @MinLength(6) @MaxLength(100)`, jamais trimé ; composant web `NewPasswordFields` + `validateNewPassword`.
- **JWT** : un seul point de signature, `AuthService.sign`, appelé par la connexion (choix explicite d'organisation et organisation unique) et `POST /auth/switch-organization`. Payload `{ sub, orgId }`, aucun mécanisme de révocation existant.
- **Validation** : `JwtStrategy.validate` et le middleware Socket.IO relisent le User à chaque requête/handshake (point unique d'ajout du contrôle).
- **Sockets ouverts** : `SocketRegistryService` (mémoire, clé `organisation:utilisateur`) déjà utilisé pour fermer les sockets après mutation de membership ; aucun nouveau timer par socket nécessaire.
- **1-13A** : `EMAIL_SENDER` (Resend via `fetch`, timeout 10 s, validation `EMAIL_FROM`, aucune relance), limiteur par adresse hachée, `PUBLIC_APP_URL` validée.
- **Web** : un `401` hors `/auth/*` déclenche la déconnexion forcée (arrêt du worker, outbox conservée, partition `userId:organizationId` inchangée).

## 2. Contrats

### `POST /auth/password-reset/request` — public

Body strict `{ email }` (trim + minuscules, `IsEmail`, 254 max — même DTO qu'en 1-13A). `Cache-Control: no-store`.

| Cas | Réponse |
| --- | --- |
| Compte inexistant, vérifié ou non, cooldown, plafond, envoi accepté ou échec fournisseur | `202 { message: "Si un compte correspond à cette adresse, vous recevrez un lien pour réinitialiser votre mot de passe." }` |
| Configuration d'envoi absente/invalide (clé, expéditeur, `PUBLIC_APP_URL`) | `503 EMAIL_DELIVERY_UNAVAILABLE`, avant toute recherche, identique pour toute adresse |
| Adresse invalide / champ en trop | `400` de validation |
| Limite par IP (fenêtres existantes, compteur propre à la route) | `429 AUTH_RATE_LIMITED` + `Retry-After` |
| Limite par adresse normalisée (5 / 15 min, namespace `password-reset-address`) | `429 PASSWORD_RESET_RATE_LIMITED` + `Retry-After` |

Durée de réponse : seule la vérification de configuration est synchrone. La recherche du compte, la réservation et l'appel Resend s'exécutent après la réponse (aucune sortie anticipée observable). Une demande ne change jamais le mot de passe, la version de session ni l'état de vérification.

### `POST /auth/password-reset/confirm` — public

Body strict `{ token, password }`. `Cache-Control: no-store`. La confirmation du mot de passe reste côté interface.

| Cas | Réponse |
| --- | --- |
| Succès | `200 { reset: true }` — aucun JWT, aucune connexion automatique |
| Token absent, vide, mal typé (y compris objet), > 512 caractères, inconnu, expiré, utilisé | `400 PASSWORD_RESET_INVALID_OR_EXPIRED`, « Ce lien de réinitialisation est invalide ou a expiré. » |
| Mot de passe absent, non chaîne, < 6 ou > 100 caractères | `400` de validation, « Le mot de passe doit contenir entre 6 et 100 caractères. » (sans `code`, lien non consommé) |
| Champ supplémentaire | `400` de validation |
| Limite par IP | `429 AUTH_RATE_LIMITED` |

Le mot de passe n'est jamais trimé (vérifié : un mot de passe entouré d'espaces fonctionne, sa version trimée est refusée).

### Sessions

| Point | Comportement |
| --- | --- |
| Connexion | `{ sub, orgId, ver }`, `ver` = version lue **avec** les identifiants (jamais fournie par le client) |
| Changement d'organisation | `ver` = version **validée dans le JWT appelant** ; si la base a changé entre-temps → `401 SESSION_REVOKED`, aucun JWT (jamais d'élévation vers une version plus récente) |
| JWT historique sans `ver` | Version 0 : accepté tant que le compte n'a jamais été réinitialisé |
| `ver` présent mais chaîne, décimal, négatif, `null` | Refusé (aucune conversion) |
| Version différente de la base | `401 { code: "SESSION_REVOKED", message: "Votre session a expiré. Veuillez vous reconnecter." }` sur toute route protégée, toute organisation |
| Socket.IO | Même contrôle au handshake et à chaque reconnexion (`unauthorized` générique) |

`JWT_SECRET` inchangé ; les autres utilisateurs ne sont pas déconnectés. Les réponses de connexion n'exposent ni `password` ni `authVersion` ; `/auth/me` renvoie des champs explicites, sans la version de session portée par le principal (`sessionVersion`).

## 3. Lien, réservation et atomicité

- **Durée** : 1 heure. **Cooldown** : 60 s par compte. **Plafond** : 5 émissions par fenêtre d'une heure.
- **Réservation** : lecture de l'état, puis `updateOne` conditionnée sur `passwordResetLastSentAt` lu **et** sur la version de session lue. Parmi des demandes concurrentes, une seule réserve et envoie ; une demande préparée avant une réinitialisation ne recrée pas de lien sur un état devenu obsolète.
- **Remplacement** : chaque émission écrase le hash précédent.
- **Confirmation** :
  1. recherche du candidat (hash + expiration) **avant** le hachage bcrypt — un échec ne consomme rien ;
  2. hachage (bcryptjs, coût 10, comme l'inscription) ;
  3. une écriture : `updateOne({ _id, passwordResetTokenHash, passwordResetExpiresAt > now, authVersion: version lue }, { $set: { password, authVersion: version + 1 }, $unset: hash + expiration })`.
  Deux confirmations concurrentes : une seule écriture aboutit, les autres reçoivent `PASSWORD_RESET_INVALID_OR_EXPIRED`.
- **Non modifiés** : `emailVerifiedAt` et champs de vérification d'email, memberships, permissions, organisations, ventes.

## 4. Après l'écriture

1. **Sockets** : `SocketRegistryService.disconnectUserSessionsBefore(userId, nouvelleVersion)` ferme, dans toutes les organisations de l'utilisateur, les sockets dont la version du handshake (`socket.data.authVersion`) est antérieure. Les sockets déjà à la nouvelle version restent ouverts ; aucun événement émis, aucun timer ajouté.
2. **Notification** « Votre mot de passe Stock Master a été modifié. » (sans mot de passe, token ni lien de connexion), `Idempotency-Key: password-changed-<userId>-<version>`, envoyée sans être attendue.

Un échec de l'une ou l'autre est journalisé (raison seule) et ne transforme pas la réinitialisation appliquée en échec.

## 5. Emails

- Lien : `${PUBLIC_APP_URL}/auth/reset-password?token=<token encodé>`, origine validée par `parsePublicAppOrigin`, jamais `Host`.
- Français, HTML et texte, valeurs échappées (helper `escapeHtml` de 1-13A).
- `Idempotency-Key` : `password-reset-<userId>-<horodatage>` (lien), `password-changed-<userId>-<version>` (notification) ; la vérification d'email garde `email-verification-…`.
- Aucune relance ni file d'envoi. Échec ambigu (timeout) : le lien réservé reste valide jusqu'à expiration ou remplacement.
- Journaux : `Password reset: reset link delivery failed — <raison>`, `… change notification delivery failed — <raison>`, `… delivery is not configured`. Jamais clé, adresse, token, hash, URL, mot de passe ni réponse Resend.

## 6. Interface web

- **Connexion** : lien « Mot de passe oublié ? » vers `/auth/forgot-password`.
- **`/auth/forgot-password`** : champ email, bouton « Envoyer le lien », retour à la connexion ; message neutre identique ; garde synchrone (`ref`) contre le double clic ; délai local de 60 s ; 429, 503 et erreur réseau traduits simplement ; aucun nouvel essai automatique.
- **`/auth/reset-password`** : même modèle que `/auth/verify-email` — rendu initial « Chargement… » identique serveur/navigateur, token lu après montage, retiré de l'URL, gardé en mémoire ; aucune requête au chargement. Formulaire `NewPasswordFields` réutilisé ; aucun POST si la confirmation diffère ; double clic : un seul POST.
  - Succès : « Votre mot de passe a été modifié. Connectez-vous avec votre nouveau mot de passe. »
  - Lien invalide/expiré/incomplet : message + « Demander un nouveau lien ».
  - Erreur réseau : nouvel essai uniquement sur clic, avec l'explication qu'une tentative de connexion avec le nouveau mot de passe permet de vérifier si la modification a été enregistrée.
  - La session éventuellement ouverte d'un autre compte n'est ni lue ni modifiée.
- **En-têtes** : `force-dynamic`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`, meta referrer et robots.
- **Service worker** : `/auth/reset-password` exclu avant toute stratégie ; `reset-password` ajouté au filet `SENSITIVE_URL_PATTERN`. La réinitialisation n'est possible qu'avec Internet.
- **`SESSION_REVOKED`** : déconnexion forcée existante (worker arrêté). L'outbox n'est jamais supprimée et sa clé de partition ne change pas ; après reconnexion, les ventes reprennent avec leurs UUID.

## 7. Compte non vérifié

La réinitialisation fonctionne (mot de passe changé, version incrémentée) mais `emailVerifiedAt` et le lien de vérification en cours restent inchangés : la connexion reste refusée avec `EMAIL_NOT_VERIFIED` jusqu'à la confirmation de l'adresse (vérifié en e2e).

## 8. Limites

- **Hors ligne** : une session locale ne découvre sa révocation qu'au retour du réseau. D'ici là, catalogue hors ligne et saisie de ventes en attente restent possibles ; la synchronisation est ensuite refusée jusqu'à la reconnexion avec le nouveau mot de passe.
- **Requêtes en cours** : une requête déjà autorisée avant l'écriture peut se terminer ; aucune annulation n'est promise.
- **Plusieurs instances API** : la fermeture des sockets ouverts ne concerne que l'instance qui traite la confirmation (registre mémoire, aucun bus distribué ajouté). Sur une autre instance, un socket ouvert reste connecté jusqu'à sa reconnexion ou l'expiration de son JWT ; il ne reçoit cependant que les diffusions de son organisation et toute reconnexion est refusée. Le rate limiting reste également mono-instance (0B.6).
- **Réponse publique** : la recherche asynchrone supprime l'écart de durée lié à l'existence du compte ; le refus d'inscription pour une adresse déjà utilisée (0B.5) reste distinguable, inscription publique fermée par défaut.
- **Échec ambigu** : un email peut être livré malgré un timeout signalé ; le lien reste valide 1 h au plus.

## 8 bis. Complément de validation : compte historique et concurrence

Barrière déterministe (aucun sleep) : `jest.spyOn(OrganizationsService.resolveActiveContext).mockImplementationOnce` suspend l'appel entre la lecture de l'état et l'émission du JWT, signale son arrivée, puis attend une libération explicite.

| Cas | Couverture avant | Résultat |
| --- | --- | --- |
| Compte historique réel | Partielle (comptes sans `authVersion` dès la création, sans `$unset` ni lecture brute) | Test ajouté : `$unset` sur la collection, absence confirmée par `collection.findOne` ; JWT historique sans `ver` et JWT `ver: 0` acceptés ; réservation sans création du champ ; confirmation `200`, `authVersion` brut = 1 ; nouveau mot de passe accepté, ancien refusé ; les deux anciens JWT → `SESSION_REVOKED`. **Aucun défaut.** |
| Connexion concurrente | Non couverte | Test ajouté : connexion suspendue après validation des anciens identifiants, réinitialisation complète, reprise → `201` avec un JWT `ver: 0`, refusé sur `/auth/context`, `/auth/me`, `/products`, le switch et Socket.IO ; connexion avec le nouveau mot de passe → `ver: 1` utilisable. **Aucun défaut** (la version est lue avec les identifiants). |
| Changement d'organisation concurrent | Non couverte | **Défaut reproduit** : requête autorisée par l'ancien JWT, suspendue, réinitialisation, reprise → `200` avec un JWT utilisable (`/auth/context` → 200), car le service relisait la version en base avant de signer. **Corrigé** : `JwtStrategy` porte la version validée (`sessionVersion`) dans le principal ; `switchOrganization` relit la base, refuse avec `401 SESSION_REVOKED` si elle diffère et signe avec la version validée. Après correction : `401`, aucun JWT ; choix d'organisation normal vérifié avant et après la réinitialisation (`ver: 1`). |

Ces trois tests passent de façon identique sur trois exécutions successives. Unitaires ajoutés : refus du switch si la base est plus récente que le JWT, absence d'élévation, `/auth/me` sans `sessionVersion`, principal avec `sessionVersion`.

## 9. Tests

**Unitaires (API)** : 55 suites, **913/913** (1-13A : 54 / 875 ; 910 avant le complément §8 bis).
- `password-reset.service.spec.ts` (nouveau) : réponse avant toute recherche ; token ≥ 32 octets, SHA-256 seul, 1 h, clé d'idempotence ; réservation conditionnée sur la version (0 et > 0) ; aucun effet d'une demande sur mot de passe, version ou vérification ; compte inexistant ; cooldown, plafond, réservation perdue ; échec fournisseur sans fuite ; 503 avant recherche ; écriture atomique exacte (mot de passe non trimé, version + 1, aucun champ de vérification) ; tokens absents/vides/mal typés/objet/trop longs ; inconnu → aucune écriture ; écriture perdue → ni déconnexion ni notification ; échecs post-écriture sans effet sur le résultat.
- Adaptés : `jwt.strategy.spec.ts` (versions acceptées et refusées, conversions refusées), `socket-auth.middleware.spec.ts` (refus de version, version mémorisée), `socket-registry.service.spec.ts` (fermeture ciblée multi-organisations), `auth.service.spec.ts` (`ver` signé, switch relu en base, rien d'exposé), `auth.controller.spec.ts`.

**E2E (API)** : 14 suites, **348/348** (1-13A : 13 / 330 ; 345 avant le complément). `test/password-reset.e2e-spec.ts` (nouveau, 18 tests dont les 3 du §8 bis) :
1. demande → email → réinitialisation → ancien mot de passe refusé, nouveau accepté, ancien JWT `SESSION_REVOKED`, notification sans secret ;
2. compte inexistant : même réponse, aucun email ;
3. compte non vérifié : mot de passe changé, vérification inchangée, `EMAIL_NOT_VERIFIED` puis connexion après confirmation ;
4. tokens absents/vides/mal typés/injection/trop longs/inconnus/expirés/réutilisés ; mot de passe invalide → validation distincte sans consommer le lien ; champ en trop refusé ; espaces conservés ;
5. 5 confirmations concurrentes → une réussite, version 1, une notification ;
6. 5 demandes concurrentes → un email ; cooldown ; remplacement ; nouvelle demande après réinitialisation ; plafond horaire ; limite par adresse (6ᵉ → 429) sans effet sur la vérification d'email ;
7. configuration absente → 503 identique sans appel réseau ; Resend 422 et timeout (`fetch` mocké) → réponse neutre, un seul appel, mot de passe/sessions inchangés, lien réservé conservé ;
8–10. JWT de deux organisations et JWT historique sans `ver` acceptés avant, refusés après (routes, switch) ; trois sockets fermés (`io server disconnect`), reconnexions refusées, socket et session d'un autre utilisateur intacts, nouveau socket préservé ; vente en attente refusée avec l'ancien JWT puis enregistrée une seule fois avec le nouveau ;
11. aucune donnée interne dans les réponses ; aucun token, hash, URL ni mot de passe dans les journaux ; aucune adresse dans les journaux `PasswordReset`.

Les suites 1-13A et les parcours d'invitation existants restent verts dans le même run.

**Playwright** (temporaire hors dépôt ; API compilée avec expéditeur simulé, `MongoMemoryReplSet` :4100 ; `next build` + `next start` :3100) : **9/9, deux exécutions consécutives sur piles neuves** :

| # | Résultat observé |
| --- | --- |
| 0 | Session ouverte avant réinitialisation, vente en attente dans l'outbox |
| 1 | Lien « Mot de passe oublié ? » ; double clic → un seul POST ; message neutre ; délai local ; compte inexistant : même message, aucun email ; mot de passe inchangé après demande |
| 2 | `no-store`, `no-referrer`, `noindex`, meta referrer ; HTML serveur « Chargement… » sans formulaire ; token retiré de l'URL ; aucun POST ni changement au chargement ; aucun token stocké ; aucune erreur d'hydratation |
| 3 | Confirmation différente → message, aucun POST ; coupure réseau → message avec l'explication de vérification, aucune relance en 2 s ; double clic → un seul POST, succès, version 1, pas de connexion automatique, aucun token stocké |
| 4 | Lien réutilisé → message + « Demander un nouveau lien » ; lien sans token → message |
| 5 | Ancienne session : `/app` → déconnexion forcée, outbox identique (même UUID, même partition) ; ancien mot de passe refusé ; nouveau → vente `synced`, une seule vente serveur |
| 6 | Navigateur connecté à un autre compte : `localStorage` identique, session de cet autre compte toujours valide |
| 7 | `sw.js` exclut la route ; service worker actif ; Cache Storage sans token ; journaux API et web sans token, hash, URL ni mot de passe |
| 8 | Régression : inscription → vérification d'email → connexion ; invitation manuelle → vérification → connexion |

Artefacts de test (pas des défauts) : les 5 demandes concurrentes atteignent la limite par adresse, remise à zéro du stockage de limitation dans la suite e2e ; dans Playwright, l'étape 6 échouait au premier essai à cause du cooldown serveur de 60 s (demande précédente à l'étape 1), la fin du cooldown est désormais simulée en base. Le rate limiting a été remis à zéro entre groupes par redémarrage de l'API seule.

## 10. Validation du dépôt

| Commande | Résultat |
| --- | --- |
| `pnpm --filter api test` | 55 suites, 913/913 (relancé après le complément) |
| `pnpm --filter api test:e2e` | 14 suites, 348/348 (relancé après le complément) |
| `eslint` API (sans `--fix`) | 0 erreur, 2 avertissements préexistants (`test/app.e2e-spec.ts:520`, `test/e2e/ephemeral-mongodb.ts:67`) ; 2 erreurs (`as never` inutiles dans une spec) corrigées, spec relancée (40/40) |
| `pnpm --filter api build` | OK (relancé après le complément ; lint API également : 0 erreur, 2 avertissements préexistants) |
| `pnpm --filter web lint` / `exec tsc --noEmit` / `build` | OK / OK / OK (`/auth/reset-password` dynamique, `/auth/forgot-password` statique) ; non relancés après le complément, aucun fichier web modifié |
| Compose | Non relancé : configuration inchangée |
| `git diff --check` | Propre |

## 11. Fichiers

| Fichier | Changement |
| --- | --- |
| `api/src/auth/session-version.ts` | **Nouveau** : version de session, claim `ver`, `SESSION_REVOKED` |
| `api/src/password-reset/*` | **Nouveau** : service, emails, DTO, limiteur par adresse, module, spec |
| `api/src/users/schemas/user.schema.ts`, `users.service.ts` | `authVersion`, champs `passwordReset*` (`select: false`), `findByIdForAuth` |
| `api/src/auth/auth.service.ts`, `auth.controller.ts`, `auth.module.ts`, `strategies/jwt.strategy.ts` | `ver` signé, endpoints, contrôle de version ; principal `sessionVersion`, switch sans élévation, `/auth/me` explicite (§8 bis) |
| `api/src/events/socket-auth.middleware.ts`, `api/src/organizations/socket-registry.service.ts` | Contrôle au handshake, fermeture ciblée |
| `api/src/email-verification/email-verification.module.ts`, `email-verification-rate-limiting.ts` | `EMAIL_SENDER` exporté ; base commune du limiteur par adresse |
| `api/test/password-reset.e2e-spec.ts` | **Nouveau** |
| `api/src/**/*.spec.ts` (5) | Adaptés |
| `web/src/app/auth/forgot-password/page.tsx`, `web/src/app/auth/reset-password/{layout,page}.tsx` | **Nouveaux** |
| `web/src/app/auth/login/page.tsx`, `web/src/lib/api.ts`, `web/public/sw.js`, `web/next.config.ts` | Lien, client API, exclusion, en-têtes |

## 12. Prérequis avant déploiement

Identiques à 1-13A (domaine Resend vérifié, `RESEND_API_KEY`, `EMAIL_FROM`, `PUBLIC_APP_URL`), plus :

- déployer API et web ensemble (le web porte les nouvelles pages) ;
- les JWT existants (sans `ver`) restent valides jusqu'à leur expiration naturelle ou une réinitialisation : aucune déconnexion générale au déploiement ;
- une seule instance d'API tant qu'aucun bus Socket.IO/stockage partagé n'existe (§8).
