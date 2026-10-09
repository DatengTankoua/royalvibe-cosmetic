# Lot 1-18D — Anti-abus des demandes de liens par e-mail

État : **implémenté et testé localement**, non commité, sur
`security/phase-1-18d-email-link-anti-abuse` (créée depuis
`security/phase-1-18c-auth-anti-abuse`, HEAD `477f520`, où 1-18C est commité ;
arbre propre au départ, `stash@{0}` conservé). Aucun commit, push,
déploiement, e-mail réel ni appel à Cloudflare ou à Resend. **Rien n'est
activé en production.**

Périmètre : `POST /auth/password-reset/request`,
`POST /auth/email-verification/request` et leurs points d'entrée web
(« Mot de passe oublié », renvoi du lien après l'inscription et à la
connexion d'un compte non vérifié).

## 1. Changements

- **Turnstile** : le service et le widget de 1-18C sont réutilisés, avec une
  action par parcours, vérifiée par l'API : `password-reset` et
  `email-verification`. Un jeton d'une autre action est refusé.
- **Ordre des contrôles** (dans le gestionnaire, plus dans un garde) :
  1. limites IP (garde existant, inchangé) ;
  2. validation du corps (pipe), puis Turnstile ;
  3. limite par adresse (5 / 15 min, mêmes stockage, clé hachée, code et
     `Retry-After`), puis plafonds persistants du compte (délai de 60 s,
     5 envois/h, réservation atomique) ;
  4. traitement métier.

  Le limiteur par adresse est devenu un service, `AddressRequestLimiter`,
  pour pouvoir passer après Turnstile. **Sans défi valide**, rien n'est
  touché : ni quota d'adresse, ni jeton ou compteur du compte, ni e-mail.
- **Réponses neutres** inchangées : compte connu, inconnu, déjà vérifié ou
  plafonné. Un défi réussi ne prouve pas la possession de l'adresse et ne
  remet aucun quota à zéro.
- **Écart de temps** sur `email-verification/request` : même mécanisme que la
  réinitialisation (1-13B). La recherche du compte, la réservation et
  l'envoi ont lieu **après** la réponse (`setImmediate`) ; la réponse ne
  dépend plus d'une lecture ou d'une écriture propre au compte. Il n'y a pas
  de promesse de temps constant.
- **Garanties conservées** : expiration (24 h et 1 h), usage unique,
  remplacement du lien précédent, révocation des sessions après
  réinitialisation, délais et plafonds persistants. La réponse de doublon à
  l'inscription n'est pas modifiée, et rien n'est envoyé automatiquement à
  la création d'une invitation.
- **Turnstile non configuré** : les deux demandes sont refusées (503
  `TURNSTILE_UNAVAILABLE`), et le démarrage le signale dans le journal.
- **Web** (FR/EN, bureau et mobile) :
  - vérification exigée avant l'envoi, renouvelée après chaque demande
    (jeton à usage unique) et à l'expiration ;
  - Cloudflare indisponible : message réessayable, sans le délai local de
    60 s ;
  - couvre « Mot de passe oublié » et le renvoi après l'inscription comme à
    la connexion d'un compte non vérifié ;
  - le message « non configuré » du widget est devenu générique.

## 2. Tests (locaux, services simulés, base temporaire)

| Contrôle | Résultat |
|---|---|
| Unitaires API (toutes suites), dont le limiteur par adresse (clé hachée, 429 + `Retry-After`, espaces séparés), l'ordre Turnstile → quota → service pour les deux routes, l'absence de quota et de service si le défi est refusé, et l'absence de lecture du compte avant la réponse | 90 suites, **1672/1672** |
| **E2E `email-link-anti-abuse`** (nouveau, les deux routes, application réelle, Turnstile simulé, e-mails enregistrés) | **18/18** |
| E2E `email-verification` et `password-reset` (requêtes avec défi simulé) | **40/40** |
| Navigateur réel (Chromium headless, recette `--anti-bot=simulated`) | **10/10** |
| API : `tsc` (build), ESLint (0 erreur) ; web : `tsc`, ESLint, `test:i18n`, `i18n:coverage` | OK |

Cas couverts par la suite E2E, pour chaque route :

- **Défi absent, invalide, d'une autre action ou fournisseur indisponible**
  (400 / 503) : document du compte strictement inchangé, quota d'adresse
  jamais créé, aucun e-mail.
- **Défi rejoué** : refusé ; quota et jetons identiques à l'état laissé par
  la demande valide.
- **Turnstile non configuré** : 503, rien consommé.
- **Défi valide** : réponses identiques pour un compte concerné, un compte
  dans l'autre état et une adresse inconnue ; e-mails envoyés seulement aux
  comptes concernés.
- **Six défis valides successifs** : 5 × 202 puis 429. Un seul e-mail grâce
  au délai de 60 s, et un nouveau défi ne débloque pas le plafond.
- **Huit demandes concurrentes** : 5 × 202, 3 × 429, un seul e-mail,
  compteur d'envois à 1.

Cas couverts en navigateur :

- **Mot de passe oublié, bureau** : sans défi, aucun envoi ; avec défi, un
  lien ; défi renouvelé.
- **Mot de passe oublié, mobile** : adresse inconnue, réponse identique,
  aucun e-mail.
- **Connexion d'un compte non vérifié, mobile** : renvoi refusé sans défi,
  réponse neutre avec défi, défi renouvelé.
- **Écran après l'inscription** : défi présent pour le renvoi.

Point de méthode : le premier passage navigateur a échoué parce que l'API de
recette utilisait un `dist` antérieur aux changements. Il a été rejoué après
reconstruction.

La campagne E2E complète n'a pas été relancée : seules les suites liées à
ces routes l'ont été. Le test instable `email-verification` (1-13A) n'a pas
échoué.

## 3. Limites résiduelles

- **Turnstile ne supprime pas tout abus** : il réduit l'automatisation, mais
  un tiers capable de résoudre les défis (humain ou service de résolution)
  peut toujours provoquer, dans les limites inchangées, des e-mails non
  sollicités vers une adresse : 5 demandes / 15 min par adresse, 1 envoi par
  minute et 5 par heure par compte, limites IP.
- **Blocage ciblé du formulaire** : un tel tiers peut aussi atteindre la
  limite par adresse et gêner le titulaire pendant 15 min. Ce comportement
  existe depuis 1-13A, mais devient plus coûteux.
- **Le jeton Turnstile n'est pas lié à l'adresse saisie.**
- **Limite par adresse** : toujours en mémoire, par instance (inchangé). Les
  plafonds par compte restent persistants.
- **Dépendance à Cloudflare** : sans clé, ou si Cloudflare est indisponible,
  ni réinitialisation ni renvoi du lien ne sont possibles (refus 503
  réessayable). C'est un choix de refus par défaut.
- **Turnstile réel non exercé** : seul le vérificateur simulé l'est ici, le
  chemin Cloudflare ayant été testé en 1-18C contre un faux `siteverify`.

## 4. Déploiement et anciens onglets

Ordre :

1. **Configurer Turnstile** (même widget que 1-18C) :
   `TURNSTILE_SECRET_KEY` et `TURNSTILE_ALLOWED_HOSTNAMES` (API),
   `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (web). Sans cela, l'API 1-18D refuse
   les deux demandes.
2. **Pré-déployer puis déployer l'API.** Ce lot n'ajoute aucune migration.
3. **Déployer le web** sans attendre.

Compatibilité :
- **Ancien onglet ou PWA non rafraîchie** : la demande part sans jeton et
  reçoit 400 `TURNSTILE_REQUIRED`. Aucune écriture, aucun quota consommé,
  aucun e-mail. L'ancien formulaire affiche un message d'erreur générique ;
  il suffit de recharger la page pour obtenir le widget.
- **Entre les étapes 2 et 3** : les demandes de lien du web encore ancien
  échouent de la même façon. Les liens déjà envoyés restent valables.
- **Retour arrière** : revenir au commit 1-18C (`477f520`), web puis API.
  Cela conserve 1-18B et 1-18C ; ne jamais revenir avant 1-18B.

## 5. Fichiers

API :
- `src/auth/auth.controller.ts` (ordre des contrôles, Turnstile, limite par
  adresse) et spec ;
- `src/email-verification/email-verification-rate-limiting.ts`
  (`AddressRequestLimiter`) et spec ;
- `email-verification.service.ts` (traitement après réponse) et spec ;
- `email-verification.dto.ts` (`turnstileToken`, hérité par la
  réinitialisation) ;
- `email-verification.module.ts` ;
- `src/password-reset/password-reset-rate-limiting.ts` et
  `password-reset.module.ts` ;
- `src/anti-bot/turnstile-config.ts` (actions) ;
- `src/main.ts` (avertissement au démarrage).

Tests API :
- `test/email-link-anti-abuse.e2e-spec.ts` (nouveau) ;
- `test/email-verification.e2e-spec.ts` et
  `test/password-reset.e2e-spec.ts`.

Web :
- `app/auth/forgot-password/page.tsx` ;
- `components/auth/email-verification-resend.tsx` ;
- `lib/api.ts` ;
- `i18n/resources/{fr,en}/auth.ts`.

Racine : `README.md` et `.env.prod.example`.
