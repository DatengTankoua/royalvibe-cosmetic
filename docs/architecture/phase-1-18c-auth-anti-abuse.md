# Lot 1-18C — Protection anti-abus de l'authentification

État : **implémenté et testé localement**, non commité, sur
`security/phase-1-18c-auth-anti-abuse` (créée depuis
`fix/phase-1-18b-invitation-acceptance`, HEAD `fa3f136`, où 1-18B était déjà
commité ; `stash@{0}` conservé).

**Rien n'est activé en production.** Aucun commit, push, déploiement ou
e-mail réel, aucun compte Cloudflare, aucun appel à Cloudflare ni à un autre
service réel. Documentation Turnstile consultée le 9 octobre 2026
(validation serveur, clés de test, rendu client, CSP).

## 1. Changements

| Protection | Implémentation |
|---|---|
| **Anti-robot de l'inscription** | `POST /auth/register` : après le contrôle `PUBLIC_REGISTRATION_ENABLED` (inchangé), `TurnstileService.verify` (action `register`) s'exécute **avant** tout hachage, compte, organisation, preuve légale ou e-mail. Web : widget Turnstile, nouvel essai après erreur, FR/EN, bureau et mobile |
| **Plafond par destinataire d'invitation** | Avant chaque envoi du lien de création (1-18B), réservation atomique par adresse normalisée, **toutes invitations et organisations confondues**. Plafond atteint : aucun envoi, réponse 202 neutre identique |
| **Plafond d'échecs par compte** | Dans `verifyCredentials`, commun au login, à `credentials/inspect` et à `credentials/accept` : réservation atomique **avant** la vérification, rendue si le mot de passe est correct |
| **Récupération d'accès** (§2) | Au-delà du plafond, le titulaire n'est plus contraint d'attendre : chaque essai exige un **défi Turnstile neuf** (action `login`), reste plafonné **par compte et par client**, et doit présenter le bon mot de passe |
| **Écart de temps** | Pour un compte inconnu, `bcrypt.compare` contre une empreinte factice de même algorithme et même coût (10), calculée une fois par processus. Aucun délai artificiel ; temps constant non garanti |

Aucun droit, abonnement ni garantie de 1-18B n'est modifié : accord
explicite, identifiants du compte invité, usage unique, transactions. Les
limites IP existantes (`login-short` 10/60 s, `login-long` 30/15 min,
compteurs partagés entre login et routes par identifiants) passent
**toujours en premier**, défi ou non.

### 1.1 Turnstile : règles serveur

| Réponse Cloudflare ou situation | Résultat |
|---|---|
| `success` avec hôte autorisé et action attendue (`register` ou `login`) | Suite du parcours |
| Jeton absent, vide ou > 2048 car. | 400 `TURNSTILE_REQUIRED`, aucun appel |
| `invalid-input-response`, `timeout-or-duplicate` (expiré ou rejoué), hôte ou action inattendus | 400 `TURNSTILE_FAILED` |
| `internal-error`, erreurs de secret, HTTP non 2xx, réseau, délai dépassé | 503 `TURNSTILE_UNAVAILABLE` (réessayable) |
| Aucune clé configurée | Inscription : 503, **jamais** d'inscription non validée. Connexion : aucun défi proposé (§2) |

Un seul appel `siteverify` (JSON, `idempotency_key`), borné par
`TURNSTILE_TIMEOUT_MS` (5 s par défaut). Le journal ne contient que la
raison, jamais le jeton, le secret ni l'adresse. `remoteip` n'est pas
envoyé (facultatif). Cloudflare garantit l'usage unique et l'expiration à
300 s.

**Configuration locale ou de test, sans contournement possible en
production** :
- **Mode simulé** : `TURNSTILE_SIMULATED=true` active un vérificateur local
  sans réseau, à usage unique et avec contrôle d'action.
  - **Production** : il est **toujours refusé au démarrage** dès que
    `NODE_ENV=production`, **quelles que soient les origines** configurées.
    Vérifié sur l'API compilée avec des origines publiques, locales et
    absentes : sortie 1, « `TURNSTILE_SIMULATED refusé en production.` ».
  - **Hors production** : il n'est admis qu'avec `NODE_ENV=test` ou des
    origines toutes en boucle locale. Un témoin en `development` avec
    origines locales démarre bien en mode `simulated`.
- **Clés de test publiques de Cloudflare** (`1x…AA`, `2x…AA`, `3x…AA`) :
  refusées au démarrage en production (vérifié, sortie 1) ; un hôte
  `localhost` est aussi refusé en production.
- **Recette locale** : comme elle tournait en `NODE_ENV=production`, la
  simulation y devient une option explicite, `start --anti-bot=simulated`,
  qui lance l'API en `development`. Par défaut, la recette reste en
  production, sans anti-robot : l'inscription HTTP y est refusée (503) et
  les scénarios qui en dépendent exigent l'option.

## 2. Récupération d'accès après dépassement du plafond

Problème corrigé : en renouvelant 10 échecs par fenêtre, un tiers pouvait
maintenir le titulaire bloqué. Comportement retenu :

| Situation (plafond par compte atteint) | Réponse |
|---|---|
| Turnstile disponible, aucun défi joint | 429 `AUTH_CHALLENGE_REQUIRED` + `Retry-After` ; aucune lecture du compte, aucun bcrypt |
| Défi refusé, rejoué, d'une autre action ou fournisseur indisponible | 400 `TURNSTILE_FAILED` / 503 ; aucun essai de mot de passe |
| Défi réussi, plafond par compte **et** client épuisé | 429 `AUTH_RATE_LIMITED` ; aucun essai de mot de passe |
| Défi réussi, mauvais mot de passe | 401 générique, essai compté (par compte et client) ; **rien n'est remis à zéro** |
| Défi réussi **et** bon mot de passe | Contrôles habituels (adresse vérifiée, organisations, accord 1-18B), puis fenêtre d'échecs du compte **refermée** |
| Turnstile non configuré | 429 `AUTH_RATE_LIMITED` jusqu'à la fin de la fenêtre (comportement précédent) |

- **Essais après défi** : chacun exige un défi neuf (usage unique) et reste
  limité à `AUTH_CHALLENGED_FAILURE_LIMIT` échecs (5 par défaut, 1–20) par
  **compte et client** sur la même fenêtre (15 min). Le client est l'IP
  telle que le throttler l'agrège : IPv4 exacte, IPv6 en /64. Un tiers
  épuise donc son propre quota sans toucher celui du titulaire. Les limites
  IP s'ajoutent.
- **Remise à zéro** : jamais sur un simple défi. Seule la combinaison défi
  réussi + bon mot de passe referme la fenêtre du compte : le titulaire a
  prouvé son accès, et les appels suivants (organisation à choisir, aperçu
  puis accord d'une invitation) ne redemandent pas de défi.
- **Comptes inconnus** : même mécanisme, mêmes réponses (« défi requis »,
  puis 401 identique) ; aucune divulgation supplémentaire.
- **Trois routes couvertes** : login, `credentials/inspect`,
  `credentials/accept` (champ facultatif `challengeToken`, ignoré tant que
  le plafond n'est pas atteint). L'accord explicite (`consent: true`)
  reste exigé ; un compte sans organisation active peut récupérer l'accès,
  voir l'aperçu, accepter puis se connecter.
- **Web** : page de connexion. Sur `AUTH_CHALLENGE_REQUIRED`, le widget
  (action `login`) s'affiche et la soumission est bloquée sans vérification.
  Chaque jeton envoyé est retiré, donc une nouvelle vérification est faite à
  chaque essai. Le défi n'est plus demandé une fois le mot de passe vérifié.

## 3. Seuils (configurables, validés au démarrage)

| Variable | Défaut | Bornes | Comportement |
|---|---|---|---|
| `AUTH_ACCOUNT_FAILURE_LIMIT` | 10 | 3–100 | Échecs de mot de passe par identifiant normalisé, avant défi |
| `AUTH_ACCOUNT_FAILURE_WINDOW_SECONDS` | 900 | 60–3600 | Fenêtre **fixe** (aussi celle des essais après défi) |
| `AUTH_CHALLENGED_FAILURE_LIMIT` | 5 | 1–20 | Échecs après défi, par compte **et** client |
| `INVITATION_EMAIL_RECIPIENT_LIMIT` | 5 | 1–50 | E-mails de création par adresse invitée |
| `INVITATION_EMAIL_RECIPIENT_WINDOW_SECONDS` | 86400 | 3600–604800 | Fenêtre fixe |

Les limites 1-18B restent en place : délai de 60 s et 5 envois par
invitation, 5 créations d'invitation par minute, limites IP.

**Fenêtres** : fixes, sans aggravation ni allongement par les tentatives
refusées. Les succès ne comptent pas, et la normalisation est celle du
modèle `User`.

## 4. Stockage

- **Collection** : `rate_limit_buckets`, dans la base MongoDB existante.
  Les plafonds sont **partagés entre instances** et **conservés au
  redémarrage**, sans service supplémentaire.
- **Atomicité** : une réservation est un `findOneAndUpdate` en pipeline avec
  `upsert`. Les demandes concurrentes ne dépassent jamais le plafond.
- **Clés** : `scope:` + HMAC-SHA256(`JWT_SECRET`, scope + sujet). Les sujets
  sont l'identifiant normalisé ou identifiant + client. Aucune adresse,
  aucune IP et aucun mot de passe en clair, en base comme dans les journaux
  (vérifié par test). Une rotation de `JWT_SECRET` remet les compteurs à
  zéro.
- **Expiration** : index TTL `expiresAt_1_ttl` créé par la migration d'index
  `create-rate-limit-indexes`, en dernier dans `migrate:predeploy`, avec
  `--check`. C'est un index de nettoyage, non requis pour l'exactitude.
- **Données** : aucune migration de données.

## 5. Tests exécutés (locaux, isolés)

| Contrôle | Résultat |
|---|---|
| Unitaires API (toutes suites), dont le refus de la simulation en production (origines publiques, locales, absentes), le parcours de récupération (défi requis, défi refusé, mauvais mot de passe sans remise à zéro, bon mot de passe avec fenêtre refermée, plafond par client, compte inconnu, jeton ignoré hors plafond) et la clé client IPv4/IPv6 | 90 suites, **1671/1671** |
| **E2E `auth-anti-abuse`** : application réelle, MongoDB éphémère, faux Cloudflare, e-mails simulés, plusieurs IP. Dont 8 tests de récupération (titulaire bloqué par un tiers qui récupère l'accès ; défi seul sans remise à zéro ; plafond par compte et client qui épuise l'attaquant mais pas le titulaire ; défi rejoué, d'une autre action ou indisponible ; limites IP conservées malgré des défis valides ; compte inconnu identique ; sans Turnstile, refus seul ; compte sans organisation : défi, aperçu, accord explicite, connexion) | **35/35** |
| E2E ciblés après le changement de `verifyCredentials` : `app`, `trust-proxy`, `invitations`, `auth-organizations`, `password-reset`, `auth-anti-abuse` | **196/196** |
| E2E index : `rate-limit-index`, `invitation-account-index` (passage précédent, code d'index inchangé) | 10/10 |
| Migrations compilées sur base éphémère (passage précédent, inchangées) | 8/8 |
| **Démarrage de l'API compilée** : simulation en production avec origines publiques, locales ou absentes, et clé de test en production → 4/4 refusés (code 1) ; témoin hors production → mode `simulated` | OK |
| Navigateur réel (Chromium headless, recette `--anti-bot=simulated`) : **récupération d'accès** L1 (bureau, compte bloqué par un tiers : défi requis, envoi refusé sans défi, connexion après défi, fenêtre refermée) et L2 (mobile, compte sans organisation invité et bloqué : défi, aperçu, accord, connexion) | **9/9** |
| Navigateur : inscription, bureau et mobile (même build) | **8/8** |
| Web : `tsc`, ESLint, `test:i18n`, `i18n:coverage`, build de production (recette) ; API : `tsc` (build), ESLint (0 erreur) | OK |

Un premier passage L1/L2 avait révélé un défaut web : après défi réussi puis
refus « aucune organisation active », la page exigeait encore un défi pour
la connexion qui suit l'accord. Il a été corrigé : le défi est levé dès que
l'API a vérifié le mot de passe. Deux contrôles du script, eux, touchaient
d'abord la limite IP ; ils ont été corrigés. La campagne complète n'a pas
été relancée : seules les suites liées aux changements l'ont été.

Le test instable `email-verification` (1-13A) n'a pas échoué pendant ces
passages ; sa correction reste à faire dans un lot séparé.

## 6. Limites

- **Turnstile réel non exercé** : le chemin Cloudflare est testé contre un
  faux `siteverify` reprenant les formes documentées. Ni un vrai widget, ni
  la clé de production, ni les domaines Vercel n'ont été vérifiés.
- **Pas de plafond global par compte après défi** : ce choix évite qu'un
  tiers puisse à nouveau bloquer le titulaire. Le coût d'un essai est donc
  un défi Turnstile résolu, dans la limite de 5 échecs par IP (ou /64) et
  par fenêtre, plus les limites IP. Un attaquant disposant de nombreuses IP
  et de résolutions de défis peut continuer à essayer à ce prix ; la
  qualité des mots de passe (6 caractères minimum aujourd'hui) reste la
  défense de fond.
- **Sans clé Turnstile en production** : aucun défi n'est possible, et le
  blocage entretenu par un tiers reste possible (au plus 15 min à la fois,
  renouvelables). La clé est donc requise avant l'ouverture, pour la
  connexion comme pour l'inscription.
- Un tiers peut toujours forcer l'affichage du défi au titulaire. Ce n'est
  qu'une gêne : un défi en mode *Managed* est en général transparent.
- **Envois échoués** : le plafond par destinataire compte les envois tentés,
  y compris ceux refusés par le fournisseur.
- Les limites IP restent en mémoire, par instance (inchangé depuis 0B.6).
- Chaque tentative de connexion ajoute une écriture MongoDB.
- **Recette par défaut** : sans anti-robot, ses scénarios d'inscription HTTP
  (temps réel, push, `owner`) exigent `start --anti-bot=simulated`.
- L'envoi automatique de l'invitation dès sa création reste hors périmètre.

## 7. Fichiers

API :
- `src/anti-bot/` : configuration, service, module et spec ;
- `src/common/rate-limit/` : configuration, limiteur persistant
  (avec `reset`), index, module et spec ;
- `src/auth/password-hashing.ts` ;
- `auth.service.ts` (récupération d'accès), `auth.controller.ts` (clé
  client), `auth.module.ts`, `dto/register.dto.ts`, `dto/login.dto.ts`,
  `dto/accept-invitation.dto.ts` et specs ;
- `src/common/auth-rate-limiting.ts` (`RateLimitedException`, corps
  `AUTH_CHALLENGE_REQUIRED`, `clientKeyFor`) et
  `src/common/client-key.spec.ts` ;
- `src/common/filters/http-exception.filter.ts` (`Retry-After`) ;
- `src/organizations/invitation-acceptance.service.ts` et
  `organizations.module.ts` ;
- `src/main.ts` ;
- `src/common/i18n/error-messages.ts` ;
- `src/migrations/create-rate-limit-indexes.ts` et
  `predeploy-migrations.ts` ;
- `package.json`.

Tests API :
- `test/auth-anti-abuse.e2e-spec.ts`, `test/rate-limit-index.e2e-spec.ts` et
  `test/e2e/rate-limit-fixtures.ts` ;
- `test/e2e/legal-acceptance-fixtures.ts` ;
- isolation des compteurs : `app`, `trust-proxy`, `legal-acceptance` et
  `invitation-account-index` ;
- recette : `recipe-common.js`, `recipe.js` (`--anti-bot=simulated`) et
  `actions.js`.

Web :
- `components/auth/turnstile-widget.tsx` ;
- `app/auth/register/page.tsx` et `app/auth/login/page.tsx` (défi de
  récupération) ;
- `contexts/auth-context.tsx`, `lib/api.ts`,
  `i18n/resources/{fr,en}/auth.ts`.

Racine : `README.md`, `.env.prod.example`, `api/.env.example`,
`web/.env.example`, `docker-compose.prod.yml`.

## 8. Configuration Cloudflare et activation en production

À fournir par l'exploitant (rien n'est configuré par ce lot) :

1. **Cloudflare** :
   - créer **un** widget Turnstile (mode *Managed*) pour
     `www.stock-master.app`, et pour tout autre domaine servant les
     formulaires ;
   - ce widget sert l'inscription (action `register`) et le défi de
     connexion (action `login`) ; les actions ne se déclarent pas dans
     Cloudflare, l'API les vérifie ;
   - noter la clé de site (publique) et la clé secrète.
2. **Railway (API)** :
   - `TURNSTILE_SECRET_KEY` (secret) ;
   - `TURNSTILE_ALLOWED_HOSTNAMES=www.stock-master.app` (mêmes domaines
     qu'au point 1) ;
   - facultatif : `TURNSTILE_TIMEOUT_MS` et les seuils du §3 ;
   - **ne jamais** définir `TURNSTILE_SIMULATED` (démarrage refusé) ;
   - après redémarrage, le journal affiche « Anti-robot de l'inscription :
     cloudflare ».
3. **Vercel (web)** : `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, puis redéploiement
   (valeur inlinée au build).
4. **Ordre de déploiement** :
   1. pré-déploiement de l'API (crée `expiresAt_1_ttl`, sans effet ensuite) ;
   2. API ;
   3. web.

   Entre les étapes 2 et 3, un compte au-delà du plafond reçoit
   `AUTH_CHALLENGE_REQUIRED`, que l'ancien web affiche comme un simple
   message : il attend la fin de la fenêtre (15 min au plus) ; rien n'est
   écrit.
5. **Vérifications manuelles conseillées** (non faites par ce lot) :
   - une inscription réelle avec le widget ;
   - sur un compte de test, 10 échecs, puis récupération par le défi.
6. Seulement ensuite, si l'inscription doit être ouverte :
   `PUBLIC_REGISTRATION_ENABLED=true` et
   `NEXT_PUBLIC_REGISTRATION_ENABLED=true`.

## 9. Retour arrière (en conservant 1-18B)

- **Problème limité à l'inscription** : la fermer
  (`PUBLIC_REGISTRATION_ENABLED=false`).
- **Problème de défi Turnstile** : retirer la clé n'est pas recommandé (plus
  de récupération possible, §6). Préférer ajuster
  `AUTH_ACCOUNT_FAILURE_LIMIT` ou `AUTH_CHALLENGED_FAILURE_LIMIT`, ce qui ne
  demande aucun redéploiement du code.
- **Retour de code nécessaire** :
  - revenir à **`fa3f136` (1-18B)**, web d'abord puis API ;
  - `rate_limit_buckets` et son index peuvent rester (ignorés, vidés par le
    TTL) ;
  - **ne jamais** revenir avant 1-18B : l'acceptation d'invitation par le
    lien seul serait rétablie ;
  - après ce retour, il n'y a plus de plafond persistant par compte ni par
    destinataire, ni d'anti-robot : l'inscription doit rester fermée.
