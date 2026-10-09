# Lot 1-18E — Confidentialité de l'inscription publique

État : **implémenté et testé localement**, non commité, sur
`security/phase-1-18e-registration-privacy`. La branche part de
`security/phase-1-18d-email-link-anti-abuse` (HEAD `e91bec8`, où 1-18D est
commité ; arbre propre au départ, `stash@{0}` conservé).

Aucun commit, push ni déploiement n'a été fait. Aucun e-mail réel n'est parti
et ni Cloudflare ni Resend n'ont été appelés.

Objectif : une demande valide ayant passé Turnstile ne révèle plus, ni par
l'API ni par le web, si l'adresse possède déjà un compte.

## 1. Contrat `POST /auth/register`

### Avant

| Cas | Réponse |
|---|---|
| Adresse nouvelle | **201**, avec `user{_id,name,email}`, `organization{_id,name,slug,currency,status}` et `emailVerification{status}` |
| Adresse existante | **400** : « Si cette adresse est valide, un email de confirmation a déjà été envoyé. » |

Le cas « adresse existante » se distinguait par son statut, son corps et
l'absence d'identifiants.

### Après

Pour une adresse nouvelle, existante vérifiée ou existante non vérifiée, la
réponse est identique :

```
202 Accepted
Cache-Control: no-store
{ "message": "Si cette adresse peut être utilisée, un e-mail de confirmation vient d'y être envoyé. Si vous avez déjà un compte, connectez-vous ou réinitialisez votre mot de passe." }
```

Le message est traduit en anglais via `Accept-Language`, comme les autres.
La réponse ne contient aucun identifiant de compte ni d'organisation, et
aucun jeton.

### Inchangé

Ces refus sont rendus avant toute recherche du compte. Ils sont donc
identiques pour toutes les adresses :

- 400 de validation (champs, `forbidNonWhitelisted`) ;
- `LEGAL_ACCEPTANCE_REQUIRED` ;
- `TURNSTILE_REQUIRED` et `TURNSTILE_FAILED`, ou 503 `TURNSTILE_UNAVAILABLE` ;
- 403 `REGISTRATION_DISABLED` (`PUBLIC_REGISTRATION_ENABLED`) ;
- 429 des limites IP.

### Consommateurs vérifiés avant la modification

- le web (`authRegister` et la page d'inscription) ;
- la recette locale (`actions.js` et `seed-fixtures.js`) ;
- 27 suites e2e.

Il n'existe aucune application mobile ni de bureau native : « mobile » et
« bureau » désignent le web.

## 2. Changements

### API (`AuthService.register`)

Ordre des étapes :

1. conditions légales ;
2. recherche du compte par adresse normalisée ;
3. selon le résultat :
   - **adresse existante** : retour immédiat. Il n'y a ni hachage, ni
     session ou transaction, ni écriture. Mot de passe, profil, adhésions et
     preuves légales restent intacts, et aucune organisation ni aucun e-mail
     n'est créé ;
   - **adresse nouvelle** : la transaction (compte, organisation, adhésion
     propriétaire, essai, preuve légale) est inchangée. Seul l'envoi du lien
     de vérification a lieu après la réponse (`setImmediate`). Un échec
     d'envoi est journalisé et rattrapable par « renvoyer le lien ».

Le service renvoie un résultat interne (`created`, identifiants) que le
contrôleur n'expose jamais. Les envois en attente sont réglés à l'arrêt de
l'application, avec `settleVerificationDispatches` et
`onApplicationShutdown`.

**Inscriptions concurrentes.** Un doublon E11000 sur l'index `email` annule
la transaction perdante et produit la même issue neutre. Il n'y a donc qu'une
seule création et aucun orphelin.

Les erreurs suivantes sont propagées et donnent 500, jamais un faux succès :

- un doublon sur un autre index (par exemple `slug`) ;
- toute autre erreur de base de données ;
- une panne de lecture.

### Web (FR/EN, mobile et bureau)

L'écran final est le même dans tous les cas. Il a pour titre « Vérifie ta
messagerie » / « Check your inbox » et n'affirme jamais « Compte créé ».

Il rappelle l'adresse saisie (« Si l'adresse … peut être utilisée… ») et
s'adresse aussi aux titulaires d'un compte existant. Il propose à tous :

- **Se connecter** ;
- **Réinitialiser mon mot de passe** ;
- le **renvoi du lien de vérification**, protégé par Turnstile (1-18D) et
  soumis à un délai initial de 60 s.

`authRegister` ignore désormais le corps de la réponse et fonctionne avec
l'ancienne API (201) comme avec la nouvelle (202).

## 3. Preuves (locales, base temporaire, e-mails et Turnstile simulés)

| Contrôle | Résultat |
|---|---|
| Unitaires API (toutes suites), dont l'adresse existante (aucun hachage, aucune session, aucune écriture, aucun envoi, recherche normalisée), les conditions légales vérifiées avant la recherche, le doublon `email` (issue neutre), le doublon `slug` (propagé), l'envoi après la réponse et l'envoi en échec ; contrôleur : même `{message}` pour les deux issues | 90 suites, **1676/1676** |
| **E2E `registration-privacy`** (nouveau, voir le détail ci-dessous) | **8/8** |
| E2E complet (27 suites migrées vers le nouveau contrat, dont `app` : corps exact, `no-store`, course à deux, seconde inscription → même 202) | **42 suites, 786 réussis**, 1 suite ignorée (préexistante) |
| Navigateur, recette locale (`start --anti-bot=simulated`), Chromium : bureau FR, mobile FR (390 px) et bureau EN. Une inscription nouvelle puis la même adresse avec un autre nom, mot de passe et organisation : texte, liens et boutons identiques, jamais « Compte créé », liens connexion et réinitialisation, renvoi avec anti-robot, 1 seul e-mail, second mot de passe refusé (401) | **27/27** |
| Web : `tsc --noEmit`, ESLint des fichiers touchés, `i18n:coverage --fail` | OK |
| API : `nest build`, ESLint et Prettier des fichiers touchés | OK |

Détail de la suite `registration-privacy` :

- statut, corps et `Cache-Control` identiques pour une adresse nouvelle,
  existante vérifiée et existante non vérifiée ;
- compte existant (vérifié ou non) strictement inchangé : document
  utilisateur complet (y compris le hash et les champs de vérification),
  adhésions, nombre d'organisations, preuves légales ; aucun e-mail, et
  l'ancien mot de passe reste valable ;
- une nouvelle inscription suivie de la vérification puis de la connexion ;
- 5 inscriptions concurrentes : une seule création, une organisation, une
  adhésion, une preuve et un e-mail, avec des réponses identiques ;
- validations, conditions légales, Turnstile et
  `PUBLIC_REGISTRATION_ENABLED`, identiques quelle que soit l'adresse ;
- panne de lecture et échec dans la transaction : 500, aucune écriture, aucun
  e-mail.

Effet secondaire : un test `email-verification` lisait un slug aléatoire dans
le corps de la réponse et était instable. Il lit maintenant la base.

## 4. Limites temporelles résiduelles

Ce lot ne promet pas un temps constant.

| Adresse | Travail synchrone |
|---|---|
| Nouvelle | hachage bcrypt et transaction MongoDB |
| Existante | une lecture indexée |

L'envoi de l'e-mail est sorti du chemin synchrone, ce qui supprime l'écart
dû au fournisseur. En revanche, le hachage et la transaction restent
synchrones pour une adresse nouvelle : sinon une vraie panne serait masquée
par un succès. Aucun délai artificiel n'a été ajouté, et l'adresse existante
ne fait aucun hachage inutile.

Mesure indicative sur la recette locale (sur le réseau, la gigue réduira
l'écart visible, sans le supprimer) :

| Série | Adresse nouvelle (médiane) | Adresse existante (médiane) |
|---|---|---|
| 1 (4 paires) | 141 ms | 8 ms |
| 2 (4 paires) | 181 ms | 11 ms |

Un attaquant patient peut donc encore distinguer les deux cas par le temps.
Chaque essai lui coûte toutefois :

- un défi Turnstile ;
- les limites IP ;
- et, si l'adresse est libre, **la création réelle** d'un compte et d'une
  organisation à cette adresse. La sonde est alors visible, et l'adresse est
  ensuite « prise » pour ses sondes suivantes.

Fermer complètement cet écart demanderait une inscription asynchrone
(création après la réponse), donc une refonte. Elle est hors périmètre.

Autres canaux, inchangés ici :

- la connexion ne signale « non vérifié » qu'après un mot de passe correct ;
- la réinitialisation et le renvoi restent neutres (1-13B et 1-18D).

## 5. Déploiement et anciens onglets

Aucune migration n'est nécessaire. Ordre recommandé :

1. **Déployer le web d'abord.** Le nouveau web ignore le corps de la réponse
   et affiche l'écran neutre pour la réponse 201 de l'API actuelle comme pour
   le 202. Face à l'API actuelle, une adresse déjà utilisée reçoit encore le
   400 de doublon : c'est le comportement actuel, sans régression.
2. **Déployer l'API ensuite.**

Anciens onglets ou PWA non rafraîchis après le déploiement de l'API :

- L'ancien formulaire lit `result.user.email` dans une réponse qui ne le
  contient plus. Il affiche donc un **message d'erreur générique alors que
  la demande a abouti** : le compte peut avoir été créé et l'e-mail envoyé.
- Il n'y a ni double création ni fuite. Une nouvelle tentative avec la même
  adresse reçoit le même 202. Il suffit de recharger la page, de consulter sa
  messagerie ou de se connecter.
- La fenêtre de cette gêne est réduite à presque rien si le web est déployé
  avant l'API.

L'ordre inverse (API d'abord) rend cette gêne visible pour **tous** les
utilisateurs du web encore ancien jusqu'au déploiement du web. Il faut
l'éviter.

**Retour arrière** : API puis web, vers 1-18D (`e91bec8`). Le web 1-18E reste
compatible avec l'API 1-18D.

## 6. Fichiers

API :

- `src/auth/auth.service.ts` : issue interne, adresse existante sans
  écriture, doublon concurrent, envoi après la réponse. Avec sa spec.
- `src/auth/auth.controller.ts` : 202, `no-store`, message neutre. Avec sa
  spec.
- `src/common/i18n/error-messages.ts` : traduction du message neutre et
  retrait de celle de l'ancien message de doublon.

Tests API :

- `test/registration-privacy.e2e-spec.ts` (nouveau) ;
- `test/e2e/registration-fixtures.ts` (nouveau ; `postRegister` lit le
  compte en base) ;
- 27 suites e2e adaptées au contrat ;
- `test/recipe/actions.js` et `test/recipe/seed-fixtures.js`.

Web :

- `app/auth/register/page.tsx` ;
- `lib/api.ts` ;
- `i18n/resources/{fr,en}/auth.ts`.
