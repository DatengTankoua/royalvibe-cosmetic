# Lot 1-18A — Audit des protections contre les abus sur l'authentification

État : **audit uniquement**, sur `feature/phase-1-17b-storage-quotas-product-actions`
(HEAD `74c7e39`, arbre propre, `stash@{0}` conservé). Aucun changement
applicatif, aucune installation, aucun `.env` ni secret lu, aucun appel à un
service réel, aucun commit, push ou déploiement. Seul ce rapport est ajouté.

Légende des preuves : **T** = protection couverte par un test exécuté pour
cet audit ; **C** = constat par lecture du code, non testé ; **?** =
comportement inconnu (dépend de la production).

Tests exécutés (locaux, isolés, MongoDB éphémère, expéditeur simulé) :

| Commande | Résultat |
|---|---|
| `npx jest src/common/auth-rate-limiting src/common/invitation-rate-limiting src/email-verification/email-verification-rate-limiting src/common/trust-proxy` | 4 suites, 75/75 |
| `test:e2e` `invitations.e2e-spec.ts -t "user existant\|ACCOUNT_DETAILS_REQUIRED\|rate limiting existant"` | 3/3 |
| `test:e2e` `email-verification`, `password-reset`, `app` `-t "limitation par adresse\|limite par adresse\|plafond horaire\|Rate limiting du login\|réponse identique\|conflit stable"` | 13/13 |

## 0. Mécanique commune

- **Limitation par IP** : `AuthThrottlerGuard` ([auth-rate-limiting.ts](../../api/src/common/auth-rate-limiting.ts)),
  `ThrottlerGuard` de `@nestjs/throttler` 6.7.0, posé **par méthode** sur les
  7 routes publiques de `AuthController`. Deux fenêtres pour chaque route :
  `login-short` 10 req / 60 s (blocage 60 s) et `login-long` 30 req / 15 min
  (blocage 15 min). Clé = `sha256(classe-handler-fenêtre-tracker)` : **compteur
  distinct par route**. Tracker = `normalizeIp(req.ip)` (IPv4 exacte, IPv6
  agrégée en /64). Toutes les requêtes comptent (succès, échecs, 400 de
  validation : les gardes passent avant les pipes). Pendant un blocage, les
  requêtes ne prolongent pas le blocage. `setHeaders: false` ; `Retry-After`
  propre ; corps `AUTH_RATE_LIMITED`. **T** (`app.e2e` §8, `trust-proxy.e2e`).
- **Ordre** : gardes globaux `JwtAuthGuard → OrganizationGuard →
  SubscriptionAccessGuard → PermissionGuard → RolesGuard` ([auth.module.ts](../../api/src/auth/auth.module.ts)),
  puis gardes de méthode. Les routes publiques (`@Public()`) traversent les
  globaux sans contrôle, puis la limitation IP, puis (le cas échéant) la
  limitation par adresse. Fenêtres exemptées de `AuthController` :
  `invitation-create`, paiements, assistance (`@SkipThrottle`).
- **Limitation par adresse** : `NormalizedAddressThrottlerGuard`
  ([email-verification-rate-limiting.ts](../../api/src/email-verification/email-verification-rate-limiting.ts)),
  5 demandes / 15 min, blocage 15 min, clé `namespace:SHA-256(trim+minuscules)`,
  appliquée à toute adresse (existante ou non). **T**.
- **Plafonds persistants par compte** (MongoDB, survivent au redémarrage) :
  cooldown 60 s + 5 envois / heure glissante, réservation par mise à jour
  conditionnelle (concurrence : un seul envoi). **T**.
- **Stockage des compteurs IP/adresse** : mémoire du processus. Perdus à
  chaque redémarrage/redéploiement ; non partagés entre instances (limite ×N
  avec N instances, y compris pendant le chevauchement d'un déploiement).
  Documenté en 0B.6 ; **C**.
- **`req.ip`** : `trust proxy` réglé uniquement par `TRUST_PROXY_HOPS` ou
  `TRUST_PROXY_ADDRESSES` ([trust-proxy.ts](../../api/src/common/trust-proxy.ts), [main.ts](../../api/src/main.ts)) ;
  aucune lecture manuelle d'en-tête. `HOPS=2` validé **seulement** sur le
  chemin public Railway en IPv4 (information fournie). Le web (Vercel)
  appelle l'API depuis le navigateur : pas de route Next intermédiaire ni de
  `rewrites` (vérifié), donc pas d'IP Vercel partagée.
- **Anti-bot** : aucun (ni Turnstile, ni reCAPTCHA, ni hCaptcha dans `api/` ou `web/`). **C**.
- **Verrouillage de compte** : aucun (aucun compteur d'échecs par compte). **C**.

## 1. Tableau route / protections / preuves / lacunes

| Route | Protections réelles | Preuves | Lacunes |
|---|---|---|---|
| `POST /auth/register` ([auth.controller.ts:92](../../api/src/auth/auth.controller.ts#L92)) | Fermée par défaut (`PUBLIC_REGISTRATION_ENABLED` ≠ `true` → 403 avant toute logique) ; IP 10/min, 30/15 min ; email unique (transaction) ; envoi du lien de vérification sous plafonds par compte | T (`app.e2e` §7, inscription 429, conflit stable) | Valeur en production **?**. Ouverte : **énumération** (201 vs 400 `DUPLICATE_EMAIL_MESSAGE`, [auth.service.ts:96](../../api/src/auth/auth.service.ts#L96)) ; chaque inscription envoie un e-mail à une **adresse arbitraire** (≈ 2 880/jour/IP) et crée une organisation ; bcrypt avant le contrôle de doublon (coût CPU) ; aucun anti-bot |
| `POST /auth/login` ([:111](../../api/src/auth/auth.controller.ts#L111)) | IP 10/min, 30/15 min ; message 401 identique (inconnu / mauvais mot de passe) ; `EMAIL_NOT_VERIFIED` et refus d'organisation seulement **après** un mot de passe correct | T (`app.e2e` §8 : 429, corps stable, XFF forgé ignoré sans proxy approuvé) | **Aucune limite par compte** : N IP × 30/15 min contre un même compte. **Écart de temps** : compte inconnu → retour avant `bcrypt.compare` ([auth.service.ts:259-265](../../api/src/auth/auth.service.ts#L259-L265)) → énumération par chronométrage (C, non mesuré). `password` sans `MaxLength` dans `LoginDto` (bcrypt tronque à 72 octets ; impact faible). Bcrypt (bcryptjs, JS pur) sur une seule instance : saturation CPU possible par IP multiples (C) |
| `POST /auth/email-verification/request` ([:136](../../api/src/auth/auth.controller.ts#L136)) | IP (compteur propre) + adresse 5/15 min ; réponse 202 neutre ; cooldown 60 s + 5/h par compte (persistants) ; concurrence → un envoi ; envoi non attendu | T (`email-verification.e2e` §6) | Recherche + réservation **attendues** avant la réponse ([email-verification.service.ts:147](../../api/src/email-verification/email-verification.service.ts#L147)) : petit écart de temps « compte non vérifié » vs autres (C). Un tiers peut **maintenir bloqué** le renvoi d'une adresse (6 requêtes / 15 min suffisent) et consommer les 5 envois/h du compte (C) |
| `POST /auth/email-verification/confirm` ([:151](../../api/src/auth/auth.controller.ts#L151)) | IP ; jeton 256 bits, stocké haché (SHA-256), 24 h, usage unique par mise à jour conditionnelle ; renvoi remplace le lien ; erreur unique | T (expiré, réutilisé, concurrence) | Aucune significative (espace de jetons non exploitable) |
| `POST /auth/password-reset/request` ([:164](../../api/src/auth/auth.controller.ts#L164)) | IP + adresse 5/15 min (namespace distinct) ; 202 neutre ; **tout** le traitement après la réponse (`setImmediate`) ; cooldown 60 s + 5/h par compte ; condition sur `authVersion` | T (`password-reset.e2e` §2, §6) | Même **blocage entretenu** de l'adresse et même consommation du plafond horaire par un tiers (C) ; jusqu'à 5 e-mails/h non sollicités vers la victime |
| `POST /auth/password-reset/confirm` ([:177](../../api/src/auth/auth.controller.ts#L177)) | IP ; jeton 256 bits haché, 1 h, usage unique conditionnel (jeton + expiration + `authVersion`) ; recherche du jeton **avant** bcrypt ; sessions révoquées ; e-mail de notification | T (expiré, concurrence) | Aucune significative |
| `POST /organizations/invitations` (création) | JWT + organisation + `members.invite` + sous-ensemble des droits de l'acteur ; 5 créations / 60 s par **utilisateur+organisation** ; un seul `pending` par (org, e-mail) ; **aucun e-mail envoyé** (lien remis au créateur, 1-12G) | T (`invitation-rate-limiting.e2e`, `invitations.e2e`) | Aucun plafond journalier (7 200/jour/utilisateur) ; sert d'outil d'**énumération** combiné à l'acceptation (ligne suivante) |
| `POST /auth/invitations/accept` ([:121](../../api/src/auth/auth.controller.ts#L121)) | IP 10/min ; jeton 256 bits haché, 72 h, révocable, usage unique (`findOneAndUpdate` conditionnel en transaction) ; erreur unique `INVITATION_INVALID_OR_EXPIRED` | T (concurrence, rejeu, 429) | **Compte existant rattaché sans authentification** : `{ token }` seul suffit ([organizations.service.ts:639](../../api/src/organizations/organizations.service.ts#L639)) ; la réponse contient le **nom** du compte. Détenteur du lien (dont le créateur) : 400 `ACCOUNT_DETAILS_REQUIRED` = pas de compte, 200 = compte existant → énumération + adhésion imposée. **Confirmé** par `invitations.e2e` « user existant » |

## 2. Risques concrets, par priorité

**P1 — à corriger**

1. **Adhésion imposée et énumération via invitation.** Tout propriétaire
   (ou délégué `members.invite`) peut inviter l'adresse d'un tiers, accepter
   lui-même le lien et obtenir une membership pour ce compte, sans action
   de son titulaire, ainsi que son nom. Le même aller-retour révèle
   l'existence de n'importe quelle adresse (5/min/utilisateur). Si
   l'inscription est ouverte, n'importe qui peut devenir propriétaire.
2. **Inscription ouverte = relais d'e-mails et énumération** (seulement si
   `PUBLIC_REGISTRATION_ENABLED=true` en production, **?**) : e-mails vers
   des adresses arbitraires (≈ 2 880/jour/IP, illimité avec plusieurs IP),
   comptes et organisations indésirables, réputation d'expéditeur Resend,
   statut 201/400 révélant l'existence d'un compte.

**P2**

3. **Bourrage d'identifiants distribué** : aucune limite par compte ni
   globale sur `/auth/login`. Avec beaucoup d'IP, un compte peut être testé
   sans plafond ; chaque essai coûte un bcrypt sur l'unique instance
   (saturation CPU possible).
4. **Énumération par chronométrage du login** (compte inconnu sans bcrypt).
5. **Blocage entretenu des demandes de lien** : 6 requêtes par 15 min
   depuis n'importe quelle IP suffisent à refuser (429) les demandes de
   réinitialisation/vérification d'une adresse précise, et 5 demandes/h
   épuisent son plafond persistant. Pas de blocage *durable* du compte (la
   connexion reste possible), mais un déni ciblé et un harcèlement de
   5 e-mails/h.

**P3**

6. **Redémarrage / plusieurs instances** : compteurs IP/adresse remis à zéro
   à chaque déploiement, multipliés par N en cas de réplicas. Les plafonds
   par compte (MongoDB) restent en place.
7. **Chemins réseau non validés** (**?**) : IPv6, réseau privé Railway,
   proxy TCP, domaine personnalisé ou CDN devant l'API. Un chemin avec un
   nombre de sauts différent rend `req.ip` soit falsifiable (XFF forgé
   approuvé), soit partagé (toutes les requêtes sur l'IP du proxy). Ajouter
   Cloudflare devant l'API **changerait** le nombre de sauts.
8. **IP partagées et connexions instables** : 10 connexions/min et 30/15 min
   par IP **et par route**, succès compris. Une boutique derrière un NAT,
   un opérateur mobile en CGNAT ou un Wi-Fi public partage ce quota ; un
   tiers sur la même IP peut le consommer. Les reprises sur réseau instable
   consomment aussi le quota (la page d'acceptation ne relance pas
   automatiquement, ce qui limite l'effet). Le message de 429 parle de
   « tentatives de connexion » sur toutes les routes ; `Retry-After` n'est
   pas affiché par la page de connexion.
9. Petit écart de temps sur `email-verification/request` (révèle un compte
   **non vérifié**).

**Contrôles navigateur** : le délai de renvoi de 60 s
([email-verification-resend.tsx](../../web/src/components/auth/email-verification-resend.tsx)),
les gardes de double soumission et le masquage du lien d'inscription
(`NEXT_PUBLIC_REGISTRATION_ENABLED`) sont **cosmétiques** ; chacun a son
équivalent serveur (cooldown persistant, réservation conditionnelle,
`PUBLIC_REGISTRATION_ENABLED`). Aucun contrôle de sécurité n'existe
seulement côté navigateur.

## 3. Plus petit lot de corrections utile (proposé, non implémenté)

Ordre conseillé ; aucune nouvelle dépendance pour 1 à 4.

1. **Acceptation par un compte existant authentifiée** (P1-1). Si l'e-mail
   de l'invitation correspond à un compte existant, exiger un JWT dont
   l'utilisateur est ce compte (nouvelle route authentifiée, ou même route
   avec contrôle du JWT) ; sinon renvoyer la **même** erreur que
   `ACCOUNT_DETAILS_REQUIRED`, sans consommer l'invitation ni révéler de nom.
   La réponse ne contient plus `user.name` pour un compte non authentifié.
   Web : l'invité existant passe par la connexion puis revient sur le lien.
2. **Limite par compte sur la connexion, sans verrouillage** (P2-3) :
   réutiliser `NormalizedAddressThrottlerGuard` (namespace `login-address`),
   par exemple 10 / 15 min par adresse, **refus temporaire** (429) et
   jamais de verrouillage persistant ; à défaut, ne compter que les échecs
   (voir §5). Complète la limite IP existante.
3. **Login à temps constant** (P2-4) : en l'absence de compte, exécuter
   `bcrypt.compare` contre un hash factice constant. Ajouter `MaxLength(100)`
   au mot de passe de `LoginDto` (même politique que l'inscription).
4. **Inscription : vérifier le doublon** avant bcrypt et répondre de façon
   neutre (P1-2) — seulement si l'inscription publique doit être ouverte ;
   sinon la laisser fermée et le documenter.
5. **Turnstile** sur les parcours publics qui envoient des e-mails (§4).

Hors lot minimal, à décider plus tard : stockage partagé (Redis) avant tout
passage à plusieurs instances (déjà requis par 0B.6) ; message de 429
propre à chaque route et affichage de `Retry-After` ; plafond journalier de
créations d'invitations.

## 4. Cloudflare Turnstile

**Intérêt** : rendre coûteuse l'automatisation des parcours qui envoient
des e-mails ou créent des comptes, là où une IP par requête contourne la
limite IP. Turnstile **ne remplace aucune** limite serveur existante : il
s'ajoute devant elles, et les limites par IP, par adresse et par compte
restent l'autorité.

| Parcours | Turnstile | Raison |
|---|---|---|
| Inscription (si ouverte) | **Oui, prioritaire** | Envoi d'e-mail à une adresse arbitraire, création de comptes/organisations |
| Demande de réinitialisation | **Oui** | Harcèlement et blocage entretenu d'une adresse (P2-5) |
| Demande de lien de vérification | **Oui** | Idem |
| Connexion | Optionnel, **conditionnel** (après quelques échecs pour une IP ou une adresse) | Évite la friction pour les vendeurs pressés ; utile contre le bourrage distribué |
| Acceptation d'invitation, confirmations (jeton 256 bits) | Non | Jeton secret ; aucun gain mesurable |
| Création d'invitation | Non | Authentifiée, limitée par utilisateur+organisation, aucun e-mail |

**Validation serveur nécessaire** (le widget seul ne protège rien) :

- jeton reçu dans le corps, validé côté API par `POST
  https://challenges.cloudflare.com/turnstile/v0/siteverify` avec la clé
  secrète (variable d'environnement), **avant** toute logique métier et
  après la limite IP (pour qu'un afflux de jetons invalides reste limité) ;
- contrôler `success`, `hostname` (domaine attendu, ex. `www.stock-master.app`),
  `action` (une valeur par parcours), et l'âge (`challenge_ts`) ; un jeton
  n'est valable qu'une fois (le refus de rejeu est fait par Cloudflare) ;
- délai court sur l'appel `siteverify` et politique explicite en cas
  d'indisponibilité (refus 503 stable, ou dégradation vers les seules
  limites serveur) ;
- `remoteip` = `req.ip` uniquement si la chaîne de proxys est fiable ;
- refus avec un code stable unique, sans révéler l'existence d'un compte ;
- interrupteur par variable (désactivé par défaut), clés de test Cloudflare
  dans les tests E2E, aucun appel réel en test ;
- CSP du web à adapter (`challenges.cloudflare.com` en script et frame) ;
  prévoir l'accessibilité et le mode PWA hors ligne (ces parcours exigent
  déjà le réseau).

## 5. Décisions ou informations manquantes

1. **`PUBLIC_REGISTRATION_ENABLED` en production** et intention : ouvrir
   l'inscription publique ? (détermine la priorité de P1-2 et de Turnstile).
2. **Acceptation par compte existant** : accepter de rendre la connexion
   obligatoire pour qu'un compte existant rejoigne une organisation
   (changement de parcours web) ?
3. **Limite par compte au login** : seuil acceptable, et comptage de toutes
   les tentatives ou seulement des échecs (ce dernier évite de pénaliser un
   utilisateur légitime mais demande d'incrémenter après la vérification).
4. **Chemins réseau vers l'API** : domaine de l'API, présence d'un CDN/
   Cloudflare devant elle, IPv6, autres services dans l'environnement
   Railway, proxy TCP. Toute modification de ce chemin impose de revalider
   `TRUST_PROXY_HOPS`.
5. **Nombre d'instances** et comportement des déploiements Railway
   (chevauchement, réplicas) : confirmer « une seule instance » et le
   documenter comme contrainte tant que les compteurs sont en mémoire.
6. **Turnstile** : compte Cloudflare, domaine(s) autorisés (production,
   aperçus Vercel), politique en cas d'indisponibilité de `siteverify`.
7. **Profil des clients** : boutiques derrière une même IP (CGNAT mobile
   fréquent) — pour calibrer les seuils par IP plutôt que les réduire.
