# Phase 1-13A — Vérification des emails avec Resend

Branche `architecture/phase-1-13a-email-verification`, base `2b7ca4d` (1-12H). Aucun commit, aucun push, aucun déploiement. **Aucun accès à Atlas, Supabase ni au port hôte 27017 ; aucune donnée réelle ; aucun email réel envoyé** : tests sur `MongoMemoryReplSet` éphémère avec expéditeur simulé, `fetch` toujours mocké lorsque l'expéditeur Resend réel est branché. Aucun paquet ajouté ni mis à jour (manifestes et lockfile inchangés, audit non relancé). Aucun vrai fichier `.env` modifié. Stash existant non touché.

Hors périmètre : « Mot de passe oublié », connexion Google, changement d'adresse email.

## Décisions

| Sujet | Décision |
| --- | --- |
| État | `User.emailVerifiedAt` : absent ou `null` = non vérifiée ; renseigné **uniquement** par la consommation d'un lien valide |
| Comptes existants | Jamais marqués vérifiés automatiquement ; aucune migration ; lien demandable depuis la connexion |
| Preuve | Token `randomBytes(32)` (base64url), **SHA-256 seul en base**, 24 h, usage unique, consommation atomique |
| Invitation | Le lien d'invitation n'est **pas** une preuve ; aucun email à la création d'une invitation |
| Resend | « Accepté par Resend » ≠ vérifié ; service isolé `EMAIL_SENDER`, remplacé en test par `overrideProvider` |
| Connexion | Identifiants d'abord, puis `403 EMAIL_NOT_VERIFIED` sans JWT |
| Routes protégées | `JwtStrategy` relit le User à chaque requête : `401 EMAIL_NOT_VERIFIED` pour un ancien JWT |
| Socket.IO | Même contrôle au handshake (connexion et reconnexion), erreur générique `unauthorized` |
| Confirmation | `POST` explicite, sans JWT ni connexion automatique ; jamais par `GET` |

## 1. Audit

- **Auth** : `AuthService.login` émettait un JWT dès les identifiants validés (puis règles d'organisation). `JwtStrategy.validate` relit déjà le User à chaque requête (`findById`) : point unique pour refuser un ancien JWT. `/auth/me` renvoie un principal explicite (jamais le document).
- **Socket.IO** : `installSocketAuthMiddleware` relit aussi le User au handshake ; chaque reconnexion repasse par ce middleware.
- **Inscription / invitation** : `registerOwner` et `acceptInvitation` sont transactionnels ; aucun email n'existait (1-12G : invitations par lien copié). `PUBLIC_APP_URL` est déjà validée par `parsePublicAppOrigin` (jamais `Host`).
- **Rate limiting** : stockage mémoire unique de `@nestjs/throttler` ; `AuthThrottlerGuard` (par IP, fenêtres `login-short`/`login-long`, compteur par route).
- **Web** : un `401` hors `/auth/*` déclenche la déconnexion forcée (arrêt du worker de synchronisation, outbox conservée, `clearAuth`). Le service worker exclut déjà `/auth/invitations/accept` ; la page d'acceptation lit le token après montage puis le retire de l'URL.
- **Hors ligne** : outbox `stockmaster-offline-sales-outbox` dans une base distincte, jamais purgée par `purgeAllOfflineData`.

## 2. Modèle

Champs ajoutés au schéma `User` (aucune migration, aucun index unique) :

| Champ | Visibilité | Rôle |
| --- | --- | --- |
| `emailVerifiedAt` | lisible | Preuve ; absent/`null` = non vérifiée |
| `emailVerificationTokenHash` | `select: false`, index sparse | SHA-256 du token courant |
| `emailVerificationExpiresAt` | `select: false` | Expiration (émission + 24 h) |
| `emailVerificationLastSentAt` | `select: false` | Cooldown et verrou optimiste |
| `emailVerificationWindowStartedAt`, `emailVerificationSendCount` | `select: false` | Plafond horaire |

La vérification appartient au compte : aucune lecture ni écriture de membership, rôle, permission ou organisation.

## 3. Contrats

### `POST /auth/email-verification/request` — public

Body `{ email }` (trim + minuscules, `IsEmail`, 254 caractères max). En-tête `Cache-Control: no-store`.

| Cas | Réponse |
| --- | --- |
| Compte inexistant, déjà vérifié, en cooldown, plafond atteint, envoi réussi ou échec fournisseur | `202 { message: "Si un compte non vérifié correspond à cette adresse, un nouveau lien de confirmation vient d'être envoyé." }` |
| Configuration d'envoi absente/invalide (clé, expéditeur ou `PUBLIC_APP_URL`) | `503 EMAIL_DELIVERY_UNAVAILABLE`, vérifié **avant** toute lecture de l'adresse (identique pour toute adresse) |
| Adresse invalide | `400` de validation |
| Limite par IP (fenêtres existantes, compteur propre à la route) | `429 AUTH_RATE_LIMITED` + `Retry-After` |
| Limite par adresse normalisée | `429 EMAIL_VERIFICATION_RATE_LIMITED` + `Retry-After` |

L'envoi n'est **pas attendu** par la réponse : la durée de réponse ne dépend pas de l'existence du compte (seule la réservation en base est synchrone).

### `POST /auth/email-verification/confirm` — public

Body `{ token }`. En-tête `Cache-Control: no-store`. Aucune session requise, aucune identité fournie par le client.

| Cas | Réponse |
| --- | --- |
| Token valide, non expiré, compte non vérifié | `200 { verified: true }` (aucun JWT) |
| Absent, vide, mal typé (y compris objet `{ $ne: … }`), > 512 caractères, inconnu, expiré, déjà utilisé, compte déjà vérifié | `400 EMAIL_VERIFICATION_INVALID_OR_EXPIRED`, « Ce lien de confirmation est invalide ou a expiré. » |
| Limite par IP | `429 AUTH_RATE_LIMITED` |

Consommation : **une seule** `updateOne({ emailVerificationTokenHash, emailVerificationExpiresAt > now, emailVerifiedAt: null }, { $set: emailVerifiedAt, $unset: hash + expiration })`. Atomique sur un document : de deux confirmations concurrentes, une seule réussit.

### Réponses de création de compte

`POST /auth/register` et `POST /auth/invitations/accept` ajoutent `emailVerification: { status }` :

| `status` | Sens |
| --- | --- |
| `sent` | Resend a accepté l'envoi (le compte reste **non vérifié**) |
| `failed` | Compte créé et conservé, non vérifié ; envoi impossible (fournisseur ou configuration) ; renvoi possible |
| `recently_sent` | Cooldown/plafond : aucun nouvel envoi |
| `not_required` | Compte déjà vérifié (invitation acceptée par un compte existant vérifié) |

Aucune erreur brute du fournisseur n'est exposée. L'envoi a lieu **après** le commit de la transaction ; un échec ne supprime ni ne vérifie le compte, et un nouvel essai d'inscription avec la même adresse reste refusé (aucune duplication).

### Connexion et accès

| Point | Refus |
| --- | --- |
| `POST /auth/login` (identifiants corrects) | `403 { code: "EMAIL_NOT_VERIFIED", message: "Confirmez votre adresse email pour accéder à votre compte." }`, aucun JWT, aucune requête organisationnelle |
| `POST /auth/login` (identifiants faux) | `401` générique inchangé (ne révèle pas l'état de vérification) |
| Toute route protégée, y compris `/auth/me`, `/auth/context`, `/auth/switch-organization` | `401 { code: "EMAIL_NOT_VERIFIED" }` |
| Handshake Socket.IO | `connect_error` `unauthorized`, aucun contexte ni timer |

Les refus existants (membership suspendue/révoquée, organisation inactive, permissions, rate limiting) sont inchangés et s'appliquent en plus.

## 4. Émission, cooldown et concurrence

- **Cooldown** : 60 s entre deux émissions pour un compte.
- **Plafond** : 5 émissions par fenêtre d'une heure (fenêtre ouverte par la première émission, puis réinitialisée).
- **Limite par adresse** : 5 demandes / 15 min, blocage 15 min ; clé `email-verification-address:<SHA-256(adresse)>`, jamais l'adresse en clair. S'applique à toute adresse, existante ou non.
- **Concurrence** : lecture de l'état, puis `updateOne` conditionné sur la valeur lue de `emailVerificationLastSentAt`. Parmi des demandes simultanées, une seule modifie le document et envoie ; les autres sont traitées comme un cooldown.
- **Remplacement** : chaque émission écrase le hash précédent ; l'ancien lien devient invalide.
- **Échec d'envoi** : la réservation (nouveau hash, cooldown, compteur) est conservée ; le renvoi est possible après 60 s. Si le fournisseur a malgré tout livré l'email (timeout ambigu), ce lien reste valide.

## 5. Resend

`api/src/email-verification/resend-email-sender.ts`, via `fetch` natif :

- `POST https://api.resend.com/emails` (URL fixe), `Authorization: Bearer <RESEND_API_KEY>`, `Idempotency-Key: email-verification-<userId>-<horodatage ms>` (une clé par émission logique) ;
- `AbortSignal.timeout(10 s)`, `redirect: "error"`, statut HTTP contrôlé, corps de réponse jamais lu ni propagé ;
- **aucune relance automatique** ;
- `EMAIL_FROM` validé : `adresse@domaine` ou `Nom <adresse@domaine>`, sans retour à la ligne ni liste.

Email en français, HTML et texte : nom échappé (HTML) et ramené sur une ligne (texte), URL échappée dans l'attribut `href`. Lien : `${PUBLIC_APP_URL}/auth/verify-email?token=<token encodé>`, origine validée par `parsePublicAppOrigin` (réutilisé de 1-12G).

**Journaux** : uniquement `Email verification: delivery failed — <raison> (HTTP <statut>)` ou `delivery is not configured`. Jamais de clé, mot de passe, adresse, token, hash, URL, contenu d'email ou réponse brute (vérifié en e2e et sur les journaux de la pile Playwright).

## 6. Interface web

- **Inscription** : « Compte créé » puis « Confirmez votre adresse email pour accéder à votre compte. » ; en cas d'échec d'envoi, message dédié et renvoi immédiatement proposé.
- **Invitation** : après acceptation d'un nouveau compte (ou d'un compte existant non vérifié), même message et même renvoi.
- **Connexion** : `EMAIL_NOT_VERIFIED` affiche « Adresse email non confirmée » et un bouton de renvoi ; aucun token ni utilisateur stocké.
- **Renvoi** (`EmailVerificationResend`) : garde de double clic (`ref`), délai local de 60 s aligné sur le serveur, message neutre ; 429 et 503 traduits sans détail technique.
- **`/auth/verify-email`** : rendu initial « Chargement… » identique serveur/navigateur ; token lu après montage, retiré de l'URL (`history.replaceState`), gardé en mémoire (`ref`) seulement ; bouton explicite « Confirmer mon adresse email » ; succès « Adresse email confirmée » + lien vers la connexion ; lien invalide/expiré → message + lien de connexion (où le renvoi est proposé) ; erreur réseau, 429 ou 5xx → nouvel essai **uniquement** sur clic. La page ne lit ni ne modifie la session éventuellement ouverte.
- **En-têtes de la page** : `layout.tsx` en `force-dynamic` (document jamais prérendu ni mis en cache partagé), `<meta name="referrer" content="no-referrer">`, `robots: noindex` ; `next.config.ts` ajoute `Cache-Control: no-store`, `Referrer-Policy: no-referrer` et `X-Robots-Tag: noindex`. Observé sur `next start` : `Cache-Control` contenant `no-store` et `Referrer-Policy: no-referrer`.
- **Service worker** : `/auth/verify-email` exclu avant toute stratégie (comme `/auth/invitations/accept`) ; `verify-email` ajouté au filet `SENSITIVE_URL_PATTERN`. Aucun token dans `localStorage`, `sessionStorage`, IndexedDB ni Cache Storage (vérifié).
- Règles de noms, mots de passe et confirmation inchangées.

## 7. Comptes historiques, sessions et hors ligne

- **Comptes historiques** : non vérifiés au déploiement. Connexion refusée avec `EMAIL_NOT_VERIFIED` et renvoi proposé ; la vérification ne touche ni l'`_id`, ni le mot de passe, ni les memberships, rôles, permissions, organisations ou ventes (vérifié en e2e).
- **Ancienne session** : le premier appel protégé renvoie `401 EMAIL_NOT_VERIFIED` → déconnexion forcée existante : worker de synchronisation arrêté, **outbox conservée**, retour à la connexion. Après vérification et connexion, l'opération en attente est synchronisée une seule fois (même `clientOperationId`).
- Aucune purge des ventes en attente, aucun cache de vérification ni mécanisme de synchronisation ajouté.
- **Limite assumée** : sans réseau, un ancien contexte local (identité vérifiée localement, TTL 72 h de 1-11C.3) ne peut pas découvrir la nouvelle restriction serveur ; le catalogue hors ligne et la saisie de ventes en attente restent possibles jusqu'au retour du réseau, où le refus serveur s'applique et bloque la synchronisation tant que l'adresse n'est pas vérifiée.

## 8. Tests

**Unitaires (API)** : 54 suites, 875 tests (1-12H : 50 / 814).
- `email-verification.service.spec.ts` (nouveau) : token ≥ 32 octets, hash seul stocké, 24 h, clé d'idempotence ; déjà vérifié ; cooldown ; plafond et réinitialisation de fenêtre ; verrou optimiste perdu ; échec fournisseur (journal sans adresse, token, URL) ; configuration absente/invalide ; adresse normalisée ; réponse neutre ; 503 avant toute lecture ; confirmation atomique ; tokens absents, vides, mal typés, objet, trop longs.
- `resend-email-sender.spec.ts` (nouveau) : requête exacte (URL, Bearer, `Idempotency-Key`, timeout, `redirect`), 7 statuts HTTP refusés, timeout, réseau, aucune relance, configuration absente, validation de `EMAIL_FROM`.
- `verification-email.spec.ts`, `email-verification-rate-limiting.spec.ts` (nouveaux) : lien encodé, échappement ; clé hachée, 429 + `Retry-After`.
- Adaptés : `auth.service.spec.ts` (envoi après commit, échec sans exception, aucun envoi si la transaction échoue, acceptation, login non vérifié après identifiants), `auth.controller.spec.ts`, `jwt.strategy.spec.ts`, `socket-auth.middleware.spec.ts`.

**E2E (API)** : 13 suites, 330 tests. `test/email-verification.e2e-spec.ts` (nouveau, 21 tests) couvre les 10 scénarios demandés :
1. inscription → non vérifié → login 403 → confirmation (`200`, `no-store`, aucun JWT) → login ;
2. invitation avec inscription publique fermée → même parcours ; membership identique avant/après ; rôle et permissions conservés ; compte existant vérifié → `not_required` ;
3. compte historique (champs retirés) → renvoi → vérification sans perte (`_id`, mot de passe, memberships, ventes) ;
4. compte vérifié : connexion normale, aucun envoi sur demande ;
5. tokens absents, vides, mal typés, injection, trop longs, inconnus, expirés, réutilisés ; 5 confirmations concurrentes → exactement une réussite ;
6. réponse neutre identique (inconnu, vérifié, non vérifié, cooldown) ; cooldown ; remplacement du lien ; clés d'idempotence distinctes ; 5 demandes concurrentes → un envoi ; plafond horaire ; limite par adresse normalisée (6ᵉ → 429) ;
7. Resend réel avec `fetch` mocké : 422, 503, injoignable, timeout → compte unique non vérifié, réinscription refusée, un seul appel, renvoi puis confirmation ; configuration absente → `failed` et 503 identique pour toute adresse, sans appel réseau ; `PUBLIC_APP_URL` invalide → 503 ;
8. ancien JWT refusé sur `/auth/context`, `/auth/me`, `/products`, `/auth/switch-organization` ; Socket.IO refusé puis accepté après vérification ;
9. aucun champ interne dans `/auth/me`, les membres, le contexte ; aucun token, hash, URL ni clé dans les journaux capturés ; aucune adresse dans les journaux `EmailVerification` ;
10. vente en attente rejouée avec l'ancien JWT → 401, rien d'enregistré ; après vérification → 201 puis rejeu idempotent (même vente).

Suites existantes : expéditeur simulé injecté ; leurs parcours inscription/invitation consomment le lien via le service réel (`autoConfirmVerificationEmails`, `test/e2e/email-verification-fixtures.ts`) ; les utilisateurs créés directement portent `emailVerifiedAt` explicite. Deux assertions de forme de réponse adaptées (`emailVerification`). Aucun bypass en production. Avant l'ajout de la nouvelle suite, les 12 suites existantes adaptées donnaient ici 309 tests verts (le rapport 1-12H indiquait 307).

**Playwright** (temporaire hors dépôt ; API compilée démarrée avec l'expéditeur simulé par `overrideProvider`, `MongoMemoryReplSet` :4100 ; `next build` + `next start` :3100) : **7/7, deux exécutions consécutives** :

| # | Résultat observé |
| --- | --- |
| 1 | Inscription UI → « Confirmez votre adresse email… », renvoi en cooldown ; login → « Adresse email non confirmée », aucun token local ; double clic sur renvoi → **un seul** POST, réponse neutre, aucun nouvel email (cooldown serveur) ; page de confirmation : `Cache-Control` `no-store`, `Referrer-Policy: no-referrer`, meta referrer, HTML serveur « Chargement… » sans bouton ; token retiré de l'URL ; compte non vérifié après simple chargement ; aucun token dans les stockages ; confirmation par POST sans `Referer` ; pas de connexion automatique ; connexion OK ; aucune erreur d'hydratation |
| 2 | Inscription publique fermée (403) ; invitation → aucun email à la création ; acceptation UI → message de confirmation ; login refusé ; confirmation → login ; contexte `seller` + `products.view_financials` |
| 3 | Token absent (message, pas de bouton) ; token invalide (message + lien de connexion) ; coupure réseau → erreur, aucune relance en 2 s, compte non vérifié ; nouveau clic → confirmé |
| 4 | Fournisseur en échec → « Compte créé », message d'échec, compte unique non vérifié ; renvoi → email → confirmation |
| 5 | Session ouverte (propriétaire) + confirmation d'un autre compte → `localStorage` identique |
| 6 | Vente en attente (outbox) ; compte rendu historique → `/app` → déconnexion forcée, token local retiré, **outbox identique** (même `clientOperationId`) ; login refusé ; renvoi ; confirmation ; login → opération `synced`, une seule vente serveur |
| 7 | `sw.js` exclut la route ; service worker actif pendant la confirmation ; Cache Storage sans token ni URL de vérification ; journaux API et web sans token, hash ni URL complète |

Artefact de test corrigé (pas un défaut) : l'assertion « aucun Referer » lisait `request.headers()`, qui expose `referer: ""` ; les en-têtes réellement émis (`allHeaders()`) n'en contiennent pas. Le rate limiting a été remis à zéro entre groupes de scénarios par redémarrage de l'API seule (base conservée) côté Playwright et par `ThrottlerStorage` côté e2e.

## 9. Validation du dépôt

| Commande | Résultat |
| --- | --- |
| `pnpm --filter api test` | **54 suites, 875/875** |
| `pnpm --filter api test:e2e` | **13 suites, 330/330** |
| `eslint` API (sans `--fix`) | 0 erreur, 2 avertissements préexistants (`test/app.e2e-spec.ts:520`, `test/e2e/ephemeral-mongodb.ts:67`) ; erreurs initiales des nouveaux tests corrigées, suites relancées |
| `pnpm --filter api build` | OK |
| `pnpm --filter web lint` / `exec tsc --noEmit` / `build` | OK / OK / OK (`/auth/verify-email` dynamique) |
| `docker compose -f docker-compose.prod.yml --env-file .env.prod.example config --quiet` ; `docker compose -f docker-compose.yml config --quiet` | OK ; `RESEND_API_KEY` et `EMAIL_FROM` transmis à l'API |
| `git diff --check` | Propre |

## 10. Fichiers

| Fichier | Changement |
| --- | --- |
| `api/src/users/schemas/user.schema.ts` | `emailVerifiedAt` + champs internes `select: false` |
| `api/src/email-verification/*` | **Nouveau** : service, expéditeur Resend, contrat `EMAIL_SENDER`, gabarit, DTO, limiteur par adresse, module, 4 specs |
| `api/src/auth/auth.service.ts`, `auth.controller.ts`, `auth.module.ts` | Envoi après commit, `EMAIL_NOT_VERIFIED` au login, endpoints `request`/`confirm` |
| `api/src/auth/strategies/jwt.strategy.ts`, `api/src/events/socket-auth.middleware.ts` | Refus des comptes non vérifiés |
| `api/test/email-verification.e2e-spec.ts`, `api/test/e2e/email-verification-fixtures.ts` | **Nouveaux** |
| `api/test/*.e2e-spec.ts` (12), `api/src/**/*.spec.ts` (4) | Expéditeur simulé, fixtures vérifiées explicites, contrats adaptés |
| `web/src/app/auth/verify-email/{layout,page}.tsx`, `web/src/components/auth/email-verification-resend.tsx` | **Nouveaux** |
| `web/src/app/auth/{login,register,invitations/accept}/page.tsx`, `web/src/contexts/auth-context.tsx`, `web/src/lib/api.ts` | Messages, renvoi, code `EMAIL_NOT_VERIFIED` conservé |
| `web/public/sw.js`, `web/next.config.ts` | Exclusion de la route, en-têtes |
| `api/.env.example`, `.env.prod.example`, `docker-compose.prod.yml` | Exemples et transmission runtime de `RESEND_API_KEY`, `EMAIL_FROM` |

Inchangés : manifestes, lockfile, autres schémas, invitations (toujours par lien), migrations, outbox, catalogue hors ligne, analytics.

## 11. Prérequis avant déploiement

1. **Domaine d'envoi vérifié dans Resend** (SPF/DKIM) et adresse `EMAIL_FROM` sur ce domaine.
2. `RESEND_API_KEY` (secret, jamais commité) et `EMAIL_FROM` fournis à l'API (`docker-compose.prod.yml` les transmet) ; sans eux, les comptes sont créés non vérifiés et le renvoi répond 503.
3. `PUBLIC_APP_URL` valide (origine http(s) nue) — déjà requise pour les invitations.
4. Frontend et API déployés **ensemble** : l'ancien frontend n'afficherait pas le renvoi.
5. **Impact immédiat** : tous les comptes existants, propriétaires compris, deviennent non vérifiés. Au premier appel, chaque session est déconnectée et chaque connexion refusée jusqu'à la confirmation (renvoi depuis la page de connexion). Les ventes en attente restent sur les appareils mais ne se synchronisent qu'après vérification. Prévenir les utilisateurs et vérifier le premier envoi réel avant d'ouvrir l'accès.
6. Rate limiting en mémoire : une seule instance d'API (limite déjà documentée en 0B.6/1-10B).

## 12. Limites

- **Hors ligne** : voir §7 ; aucune découverte de la restriction sans réseau.
- **Confirmation concurrente** : un second onglet qui confirme le même lien reçoit le message « invalide ou expiré » alors que l'adresse est vérifiée ; la connexion fonctionne.
- **Échec ambigu** (timeout) : l'email peut être livré malgré l'échec signalé ; le lien reste valide jusqu'à son remplacement.
- **Inscription** : le refus d'une adresse déjà utilisée (400, comportement 0B.5) reste distinguable d'une création ; l'inscription publique est fermée par défaut.
- **Contexte figé par session** : inchangé ; l'API relit l'état de vérification à chaque requête et à chaque handshake.
- **Liens Resend** : la clé d'idempotence n'est valable que 24 h côté Resend ; chaque émission en utilise une nouvelle.
