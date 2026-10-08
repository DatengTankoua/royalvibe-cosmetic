# Lot 1-16C.1 — Coordonnées Stock Master et assistance depuis Organisation

## 0. Base et périmètre

- Branche `architecture/phase-1-16c-legal-and-usage-pages`, HEAD `12f8dc5`,
  avec les modifications non commitées du lot 1-16C. Ces modifications sont
  conservées et complétées. Index vide ; `stash@{0}` (sauvegarde
  lint-staged `564a998`) non touché.
- Aucun commit, push, déploiement ni activation. CamPay reste
  `UnavailablePaymentProvider`, le webhook reste désactivé.
- Aucun `.env` réel, aucune base réelle, aucun e-mail réel : MongoDB
  éphémère, transport e-mail simulé, `fetch` remplacé par un mock dans les
  tests API.
- L'acceptation juridique versionnée des conditions reste un point distinct,
  à traiter ensuite (rapport 1-16C, § 4).

## 1. Coordonnées

### 1.1 Confirmé par le propriétaire (7 octobre 2026)

Centralisé dans `web/src/lib/legal/site-identity.ts` :

| Élément | Valeur |
|---|---|
| Nom légal | Stock Master |
| Nom commercial | Stock Master |
| Exploitant | entreprise |
| Domaine | https://stock-master.app |
| Implantations | Bijou Maképé, Douala, Cameroun ; Carrefour GP Melen, après l'ancien commissariat du 13e, Yaoundé, Cameroun |
| Adresses | contact@, support@, confidentialite@, noreply@stock-master.app |

Aucune forme juridique, aucun capital, aucun numéro ni aucun siège social
n'a été déduit. Les deux implantations sont listées sans hiérarchie.

### 1.2 Déclaré, non vérifié par l'équipe technique

Les quatre adresses sont **déclarées fonctionnelles par le propriétaire**
(`CONTACT_EMAILS_STATUS.declaredWorkingByOwner = "2026-10-07"`). Aucun
envoi ni aucune réception réels n'ont été testés dans ce lot
(`testedByTechnicalTeam: false`) : toutes les validations ont utilisé un
transport simulé.

L'expéditeur reste la configuration `EMAIL_FROM` existante : une adresse du
domaine vérifié chez Resend. Ce lot ne l'impose pas et ne modifie pas la
configuration de production, qui n'a pas été lue. Les pages Contact et
Mentions légales disent seulement que les e-mails automatiques partent
« d'une adresse du domaine ».

### 1.3 Encore attendu (en commentaire dans le code, jamais affiché)

Téléphone, RCCM, NIU (annoncés ultérieurement) ; forme juridique, capital,
directeur de la publication ; pays d'hébergement des prestataires ;
décisions et validations juridiques listées au rapport 1-16C (§ 6).

### 1.4 Pages : avertissements retirés, statut « projet » conservé

Conformément à la demande, les pages sont déployables en l'état :

- les marqueurs visibles « À compléter » sont **tous** passés en
  commentaires JSX (`{/* À COMPLÉTER : … */}`), au même endroit. Quand une
  phrase n'avait de sens qu'avec l'information manquante, elle a été retirée
  avec son marqueur. Aucune valeur n'a été inventée ;
- le bandeau « Projet en cours de finalisation » et le paragraphe
  « Engagements encore à définir » de l'accord de traitement ne sont plus
  affichés ; ce dernier est conservé en commentaire ;
- le composant `components/legal/missing.tsx` est supprimé (inutilisé) ;
- le statut « projet » reste dans le registre `LEGAL_DOCUMENTS` (version
  0.2, 7 octobre 2026) : les six documents juridiques restent **non
  indexés** (`noindex`) tant que les validations manquent. Le guide et la
  page Contact sont indexables.

Le rapport 1-16C a été complété en conséquence (§ 9).

## 2. Permission et navigation

| Élément | Mise en œuvre |
|---|---|
| Permission | `support.contact`, libellé « Contacter le service client », ajoutée à `DELEGABLE_PERMISSIONS` (API) et à son miroir web |
| Propriétaire, administrateur | Autorisés par défaut : ces rôles reçoivent toutes les permissions délégables par calcul (`DEFAULT_PERMISSIONS_BY_ROLE`) |
| Vendeur | Refusé par défaut ; accordable dans la gestion des membres (case générée depuis `SUPPLEMENTARY_PERMISSIONS`, anti-escalade existante) |
| Membres existants | **Aucune migration** : `membership.permissions` n'est pas modifié ; les permissions personnalisées restent intactes |
| Navigation | Organisation → **Assistance** (`/app/organization/support`), onglet affiché seulement avec le droit ; barre d'onglets défilante sur mobile |
| Accès direct sans droit | Écran « Votre rôle ne permet pas… » avec lien vers `/contact` ; **aucune** requête `/support/*` émise |
| API | `GET /support/context` et `POST /support/requests`, protégés par `@RequirePermissions('support.contact')` au niveau du contrôleur |

À chaque requête, les gardes globaux relisent tout en base, quel que soit
le contenu du navigateur ou du JWT : le compte et la version de session
(`JwtAuthGuard`), l'appartenance et l'organisation actives
(`OrganizationGuard`), l'accès commercial (`SubscriptionAccessGuard`), puis
les droits actuels (`PermissionGuard`). Un droit retiré ou une appartenance
suspendue s'applique donc dès la requête suivante. Une session limitée
(abonnement expiré) n'accède pas à ces routes : la page publique `/contact`
reste la voie dans ce cas.

## 3. Formulaire

`web/src/app/app/organization/support/page.tsx` et `web/src/lib/support.ts` :

- catégories Utilisation, Abonnement, Problème technique et Autre ; sujet
  de 150 caractères au plus ; message de 5 000 caractères au plus, avec
  compteurs ;
- bloc « Informations transmises au service client » : nom, e-mail
  (réponse), commerce, rôle, identifiants du compte, du commerce (avec son
  slug) et de l'appartenance, et la page concernée si elle est fournie.
  Ces informations sont **lues depuis l'API** (`GET /support/context`), donc
  identiques à ce que le serveur joint, et ne sont pas modifiables ;
- validation : erreurs sous chaque champ (`aria-invalid`,
  `aria-describedby`), focus sur le premier champ en erreur ;
- envoi : verrou client (`useRef`) et bouton désactivé « Envoi… » ;
  confirmation qui reçoit le focus et affiche la référence (`AS-XXXXXXXX`),
  en précisant que l'acceptation par le transport ne prouve pas la lecture ;
- erreur : messages lisibles par cas (incertain, fenêtre dépassée, en
  cours, indisponible, quota, droit retiré, invalide). Le sujet et le
  message restent dans les champs ;
- hors ligne : message « l'envoi nécessite Internet », bouton désactivé,
  brouillon gardé à l'écran en mémoire seulement. Rien n'est écrit dans
  l'outbox des ventes ni dans un stockage local ;
- UUID d'intention (`crypto.randomUUID()`) conservé pour réessayer le même
  contenu, renouvelé dès que le contenu change après un essai ou après un
  succès ;
- paramètre facultatif `?depuis=/app/…` pour la page concernée : validé
  (préfixe `/app`, ni requête ni fragment, 200 caractères au plus). Aucun
  écran ne le renseigne encore.

## 4. Contexte construit par l'API

`api/src/support/support.service.ts` :

| Information | Source |
|---|---|
| Utilisateur : id, nom, e-mail | Base (`users`), via l'id issu de la session |
| Organisation : id, nom, slug | Base (`organizations`), organisation courante résolue par la garde |
| Appartenance : id, rôle, droits effectifs | Contexte de la garde (relu en base), `effectivePermissions` |
| Référence, date | Serveur (référence dérivée de l'UUID ; horloge injectable) |
| Page, version publique | Corps, facultatifs et validés : chemin `/…` sans `?` ni `#` (200 caractères au plus) ; version `[0-9A-Za-z.+-]` (40 au plus, `NEXT_PUBLIC_APP_VERSION`, non défini aujourd'hui) |

Le DTO n'accepte que `requestId`, `category`, `subject`, `message`, `page`
et `appVersion`. Avec `forbidNonWhitelisted`, toute tentative d'imposer
`userId`, `organizationId`, `email`, `to`, `replyTo` ou `role` reçoit une
erreur 400. Ne sont **jamais** joints : jetons, mots de passe, clés,
ventes, contacts d'acheteurs, fichiers, journaux, stockages locaux.

## 5. Envoi au service client

| Règle | Mise en œuvre |
|---|---|
| Transport | Expéditeur existant `EMAIL_SENDER` (Resend via `fetch`, sans SDK), réutilisé |
| Destinataire | `SUPPORT_RECIPIENT = 'support@stock-master.app'`, constante serveur |
| Expéditeur | `EMAIL_FROM` existant (inchangé) |
| Reply-To | Nouveau champ facultatif `replyTo` de `OutgoingEmail`, transmis à Resend en `reply_to`. La valeur vient de l'e-mail du compte en base. Une adresse invalide (retour à la ligne, nom, liste) est refusée **avant** tout appel. Les e-mails existants sont inchangés (champ absent) |
| Contenu | Fonction pure `buildSupportEmail` : texte et HTML, toutes les valeurs échappées (`escapeHtml` existant), sujet sur une ligne, date de Douala et ISO UTC. Pas de modèle avec logo dans le projet : style simple des e-mails existants |
| Injections | Sujet sans aucun caractère de contrôle, message sans caractère de contrôle hors retour à la ligne et tabulation, chemin et version filtrés, Reply-To contrôlé |
| Limitation | Fenêtre nommée `support-request` : **5 requêtes / 10 min**, blocage 10 min, par utilisateur et organisation. Elle est ajoutée au `ThrottlerModule.forRoot()` unique, et les autres gardes du projet l'excluent explicitement (`SKIP_SUPPORT_THROTTLER`). La garde s'exécute avant la validation : une requête invalide compte aussi |

### 5.1 Doublons, rejeux et résultat inconnu

Documentation Resend consultée le 7 octobre 2026
(https://resend.com/docs/dashboard/emails/idempotency-keys) :

- une clé est conservée **24 heures**, et fait 256 caractères au plus ;
- même clé et même corps : même réponse, sans second envoi ;
- même clé avec un corps différent : `409 invalid_idempotent_request` ;
- requête en cours avec la même clé : `409 concurrent_idempotent_requests`.

Mise en œuvre :

1. Le client génère un UUID par intention. Le serveur l'utilise comme
   `_id` d'un document `support_requests` (unicité par l'index natif) et
   comme clé Resend `support-request/<uuid>`.
2. Le registre garde le **contexte et la date établis à la création**. Un
   rejeu produit donc exactement le même sujet, le même texte et le même
   HTML : la condition de Resend pour ne pas renvoyer est remplie.
3. Le contenu d'un rejeu est comparé à une **empreinte SHA-256** (catégorie,
   sujet, message, page, version). Un contenu différent avec le même UUID
   reçoit `409 SUPPORT_REQUEST_MISMATCH`. Un UUID déjà pris par un autre
   membre ou une autre organisation reçoit `409 SUPPORT_REQUEST_CONFLICT`.
4. Verrou d'envoi en base (60 s) : une requête concurrente (double clic)
   reçoit `409 SUPPORT_REQUEST_IN_PROGRESS`.
5. Résultats du transport :
   - **accepté** : statut `sent`. Un rejeu renvoie la même référence avec
     `replayed: true`, sans rien renvoyer ;
   - **refus certain** (configuration absente, 4xx sauf 409, 429) : statut
     `failed`, réponse `503 SUPPORT_DELIVERY_UNAVAILABLE`. Un renvoi est
     sans risque ;
   - **résultat inconnu** (délai, réseau, 5xx, 409, erreur inattendue,
     verrou périmé) : statut `unknown`, réponse
     `503 SUPPORT_DELIVERY_UNCERTAIN` avec la référence. Le renvoi se fait
     avec la même clé et le même corps, **seulement dans les 23 heures**
     qui suivent le premier appel au transport (une heure de marge sur les
     24 heures de Resend). Au-delà, la réponse est
     `409 SUPPORT_RETRY_WINDOW_EXPIRED` avec la référence : aucun renvoi
     automatique, et l'utilisateur est invité à écrire à support@ en citant
     la référence.
6. La déduplication n'est **pas permanente** : un enregistrement expire
   30 jours après la demande, puis il est effacé par le nettoyage en
   arrière-plan (voir § 6). Un rejeu après son effacement serait traité
   comme une nouvelle demande.
7. Le succès affiché signifie que le transport a accepté le message. Il ne
   prouve ni la réception ni la lecture par le service client.

## 6. Persistance et migration

**Justification.** La clé Resend expire après 24 heures et ne renseigne pas
sur un envoi dont le résultat est inconnu. Pour garantir un rejeu identique
(contexte et date initiaux), refuser un contenu différent et appliquer la
fenêtre de 23 heures, il faut un état serveur par intention.

**Collection `support_requests`, minimale.** Elle contient l'UUID,
la référence, les identifiants (utilisateur, organisation, appartenance),
la catégorie, l'empreinte, la page et la version, l'instantané du contexte
(nom, e-mail, commerce, slug, rôle, droits) et les états d'envoi (statut,
tentatives, dates, verrou). Le **sujet et le message ne sont pas
conservés** (vérifié par le test « message exact »).

**Migration explicite :**
`pnpm --filter api migrate:support-request-indexes`
(`api/src/migrations/create-support-request-indexes.ts`).

- Elle crée l'index TTL `createdAt_1_ttl` sur `createdAt`, avec
  `expireAfterSeconds = 2592000` (30 jours). Elle est idempotente et ne
  remplace pas un index homonyme de configuration différente : ces trois
  points sont vérifiés sur base éphémère (§ 11).
- Elle n'est **pas exigée au démarrage** : l'unicité repose sur `_id`. Sans
  la migration, l'assistance fonctionne mais le registre n'expire jamais.
- **Procédure de déploiement** : elle est inscrite dans `README.md`
  (« Déploiement production », « Migrations à exécuter avant l'activation
  d'une version ») et **doit précéder l'activation de cette version**.
  Railway déploie à chaque push sur `main`, donc elle se lance avant la
  fusion.
- Elle a été exécutée dans la recette (`launcher.js`), **jamais** sur une
  base réelle.

**Conservation réellement en place :**

- **expiration** de chaque enregistrement du registre 30 jours après la
  demande (index TTL, après migration) ;
- **nettoyage automatique en arrière-plan** : MongoDB efface les
  enregistrements expirés lors de passages périodiques, donc la suppression
  peut intervenir un peu après le 30e jour. Aucune suppression à l'instant
  exact n'est promise, ni dans ce rapport ni dans la politique de
  confidentialité ;
- **e-mail d'assistance conservé séparément**, dans la messagerie
  support@, hors de l'application : durée non définie, non inventée, en
  commentaire dans la page ;
- compteurs de limitation en mémoire, perdus au redémarrage (une seule
  instance d'API).

## 7. Documentation mise à jour

- **Guide** : section « Besoin d'aide ? » (parcours Organisation →
  Assistance, informations jointes, hors ligne, droits) ; droit « contacter
  le service client » dans les rôles ; renouvellement par Assistance.
- **Contact** : coordonnées confirmées, implantations, parcours
  Organisation → Assistance, e-mail pour ceux qui ne peuvent pas accéder à
  leur organisation.
- **Confidentialité** : nouvelle catégorie « Demandes d'assistance »,
  finalité et fondement envisagé (à valider), destinataire (service client
  via Resend), conservation : expiration du registre après 30 jours,
  nettoyage en arrière-plan pouvant intervenir ensuite, messagerie
  conservée séparément (durée à compléter).
- **Accord de traitement** : les demandes d'assistance relèvent des données
  dont l'exploitant est responsable, et non du traitement pour le compte du
  commerce.
- **Conditions d'abonnement et d'utilisation** : le renouvellement et les
  réclamations passent aussi par Assistance.
- **Mentions légales** : exploitant et implantations.
- **Rapport 1-16C** : § 9 ajouté.

## 8. Fichiers

### 8.1 API

| Fichier | Statut | Rôle |
|---|---|---|
| `api/src/support/support-constants.ts` | nouveau | Destinataire fixe, catégories, bornes, fenêtre de 23 h, verrou, rétention, horloge |
| `api/src/support/schemas/support-request.schema.ts` | nouveau | Registre minimal |
| `api/src/support/dto/create-support-request.dto.ts` | nouveau | Corps strict, motifs anti-injection |
| `api/src/support/support-email.ts` | nouveau | Message texte et HTML échappé, déterministe |
| `api/src/support/support-rate-limiting.ts` | nouveau | Fenêtre `support-request` et garde utilisateur+organisation |
| `api/src/support/support.service.ts` | nouveau | Contexte, intention, verrou, envoi, classement des échecs |
| `api/src/support/support.controller.ts` | nouveau | `GET /support/context`, `POST /support/requests` |
| `api/src/support/support.module.ts` | nouveau | Module (réutilise `EmailVerificationModule`) |
| `api/src/support/support-request-indexes.ts` | nouveau | Index TTL (création par migration) |
| `api/src/support/support.spec.ts` | nouveau | Unitaires |
| `api/src/migrations/create-support-request-indexes.ts` | nouveau | Migration explicite |
| `api/test/organization-support.e2e-spec.ts` | nouveau | E2E |
| `api/src/organizations/permissions.ts` | modifié | `support.contact` |
| `api/src/organizations/organization.schema.spec.ts` | modifié | 15 permissions, liste triée |
| `api/src/email-verification/email-sender.ts`, `resend-email-sender.ts` | modifiés | `replyTo` facultatif, `isValidReplyTo` |
| `api/src/auth/auth.module.ts` | modifié | Fenêtre `support-request` |
| `api/src/auth/auth.controller.ts`, `organizations/organizations.controller.ts`, `subscriptions/payments/subscription-payments.controller.ts`, `subscriptions/payments/campay/campay-webhook.controller.ts` | modifiés | Exclusion de la nouvelle fenêtre |
| `api/src/app.module.ts` | modifié | `SupportModule` |
| `api/package.json` | modifié | Script `migrate:support-request-indexes` |
| `api/test/recipe/launcher.js`, `boot-api.js` | modifiés (harnais) | Migration dans la recette ; `replyTo` et clé d'idempotence consignés dans `mail.jsonl` |

### 8.2 Web

| Fichier | Statut | Rôle |
|---|---|---|
| `web/src/app/app/organization/support/page.tsx` | nouveau | Page Assistance |
| `web/src/lib/support.ts` | nouveau | Appels, bornes miroir, classement des erreurs |
| `web/src/app/app/organization/layout.tsx` | modifié | Onglet Assistance (permission) |
| `web/src/lib/organization-permissions.ts` | modifié | `support.contact` et libellé |
| `web/src/lib/legal/site-identity.ts` | modifié | Coordonnées confirmées, implantations, état déclaré des adresses, manques en commentaire |
| `web/src/components/legal/document-page.tsx` | modifié | Bandeau « projet » retiré |
| `web/src/components/legal/missing.tsx` | supprimé | Plus utilisé |
| `web/src/app/{mentions-legales,contact,conditions-utilisation,conditions-abonnement,confidentialite,cookies,traitement-donnees,guide}/page.tsx` | modifiés | Marqueurs passés en commentaires, coordonnées, assistance |

`docs/architecture/phase-1-16c1-captures/` : 9 captures de recette.

## 9. Contrôles exécutés

| Contrôle | Résultat |
|---|---|
| Lint web (`npx eslint`, sans `--fix`) | exit 0 |
| Typage web (`npx tsc --noEmit`) | exit 0 |
| Lint API (`npx eslint src` et e2e de l'assistance, sans `--fix`) | exit 0. Prettier a été appliqué **avant** à mes seuls fichiers, comme mise en forme et non comme correction de lint |
| Typage API, configuration de build (`tsc -p tsconfig.build.json`) | exit 0 |
| Typage API, `tsconfig.json` (avec les tests) | 238 erreurs, **toutes** dans des `*.spec.ts` et `test/` que je n'ai pas modifiés ; aucune dans les fichiers touchés. Préexistantes, sans effet sur `nest build` ni sur ts-jest |
| `pnpm --filter api build` | réussi (module et migration dans `dist`) |
| `recipe.js isolated api-unit` : support, organization.schema, resend-email-sender, permission.guard | **4 suites, 63/63** |
| `recipe.js isolated api-e2e test/organization-support` | **15/15** (1er passage : 12/14, voir ci-dessous) ; la garde a bloqué la lecture de `api/.env` |
| Régression ciblée, `api-e2e` : invitation-rate-limiting, membership-management, auth-context, email-verification, subscription-payments, campay-webhook | **6 suites, 122/122** |
| Recette navigateur Assistance (stack éphémère, `mail.jsonl` simulé) | **16/16** |
| Recette navigateur des pages 1-16C (attente mise à jour : ni bandeau, ni marqueur, `noindex`) | **49/49** ; 0 marqueur sur les 8 pages |
| `recipe.js isolated web-build` | exit 0 ; `/app/organization/support` prérendue ; `envFilesInCopy: 0` ; copie supprimée |
| `git diff --check` | exit 0 |

**Couverture e2e (15) :**

- contexte propriétaire et administrateur, avec `no-store` ;
- vendeur refusé (contexte et envoi, sans registre ni e-mail) ;
- vendeur autorisé ;
- droit retiré après ouverture de la page, puis appartenance suspendue ;
- usurpation : 6 champs refusés en 400, et UUID d'un autre membre refusé
  en 409 ;
- message exact : destinataire, Reply-To, clé, sujet, contexte, HTML
  échappé, absence de secrets, registre sans sujet ni message ;
- rejeu identique, puis contenu différent (409) ;
- double clic (409 en cours, un seul envoi) ;
- refus certain (503), puis nouvel essai accepté ;
- résultat inconnu, puis renvoi avec la même clé et un contenu
  byte-identique ;
- au-delà de 23 h : 409 sans nouvel appel ;
- 502 et 409 du prestataire traités comme incertains ;
- 13 cas de bornes et d'injection, et bornes exactes acceptées ;
- requêtes invalides comptées dans le quota ;
- 5 demandes puis 429 avec `Retry-After`, quota distinct pour un autre
  membre, connexion non affectée.

**Écarts au premier passage, corrigés dans les tests et non dans le code :**

- e2e : deux cas de validation recevaient 429, parce que la garde de
  limitation passe avant la validation. Le comportement est conservé et
  testé ; le quota est remis à zéro entre les cas de validation ;
- recette navigateur :
  - lecture du bloc de contexte pendant « Chargement… » ;
  - double clic simulé par deux clics séparés : le second attendait un
    bouton déjà désactivé, ce qui confirme le verrou ;
  - réutilisation d'un contexte navigateur déjà connecté ;
  - quota épuisé par le passage précédent, d'où la remise à zéro par
    `restartApi`.

  Une vérification séparée a confirmé que l'application refuse l'envoi en
  403 et conserve le texte quand le droit est retiré.

**Recette Assistance (16/16) :**

- onglet visible pour le propriétaire et l'administrateur, absent pour le
  vendeur sans droit ;
- bloc d'informations complet ;
- validation et focus ;
- succès avec référence, un seul e-mail malgré le double clic ;
- e-mail simulé correct (destinataire, Reply-To, clé, contenu) ;
- mobile 390 px sans débordement ;
- hors ligne : envoi bloqué, texte conservé, outbox vide ;
- erreur 429 : texte conservé ;
- vendeur sans droit : accès direct refusé, aucune requête `/support` ;
- droit accordé puis retiré pendant la page : 403, texte conservé, aucun
  e-mail ;
- 8 pages publiques en 200, sans avertissement ni débordement ;
  coordonnées et implantations affichées sans siège désigné ;
- aucune erreur console (hors le 429 attendu).

Non relancés : campagnes temps réel et paiement, suites API complètes.

## 10. Limites

1. Les adresses e-mail sont déclarées fonctionnelles mais **non testées** ;
   la configuration `EMAIL_FROM` de production n'a pas été lue.
2. La migration TTL doit être exécutée avant l'activation (README). Sans
   elle, le registre n'expire pas.
3. La limitation et les verrous reposent sur une seule instance d'API
   (compteurs en mémoire).
4. Les documents juridiques restent des projets non indexés. L'acceptation
   versionnée reste à faire, dans un lot distinct.
5. Le paramètre `?depuis=` existe, mais aucun lien de l'application ne le
   renseigne encore.
6. Le message n'est pas archivé côté application. Une demande est retrouvée
   par sa référence dans la messagerie support@.

## 11. Finalisation avant commit (7 octobre 2026)

Corrections et contrôles ciblés, sur base éphémère uniquement. Aucune
migration réelle, aucun e-mail réel, aucun `.env` réel. Les 122 tests de
régression et les campagnes complètes n'ont **pas** été rejoués : les
changements de cette étape portent sur des tests, la documentation et deux
phrases de pages.

### 11.1 Matrice d'accès

La suite `subscription-access-routes` ne couvrait pas l'assistance :
`SupportController` ne figurait pas dans la liste des contrôleurs. Il y est
ajouté, avec un test dédié. Les deux routes sont **métier** (refus
commercial par défaut, aucune exception), avec contexte d'organisation,
`@RequirePermissions('support.contact')`, sans opération owner-only et
sans route publique. Résultat : **9/9** (`recipe.js isolated api-unit
src/subscriptions/subscription-access-routes`).

Refus à l'exécution (`test/organization-support.e2e-spec.ts`). Chaque cas
vérifie le code exact, **aucun registre créé** et **aucun appel au
transport** :

| Cas | Contexte | Envoi | Preuve |
|---|---|---|---|
| Abonnement expiré, jeton applicatif déjà ouvert | 403 `SUBSCRIPTION_INACTIVE` | 403 `SUBSCRIPTION_INACTIVE` | nouveau test |
| Session limitée (jeton `subscription_limited`) | 403 `SUBSCRIPTION_ACCESS_LIMITED` | 403 `SUBSCRIPTION_ACCESS_LIMITED` | nouveau test |
| Organisation suspendue | 403 `ORGANIZATION_ACCESS_DENIED` | 403 `ORGANIZATION_ACCESS_DENIED` | nouveau test |
| Sans `support.contact` (vendeur) | 403 | 403 | test existant, réutilisé |
| Droit retiré après ouverture ; appartenance suspendue | — | 403 | test existant, réutilisé |

L'horloge des abonnements (`SUBSCRIPTION_CLOCK`) est remplacée seulement
dans ce test ; chaque cas utilise un commerce isolé. Résultat : **18/18**
(15 tests existants + 3 nouveaux), garde `.env` active (lecture de
`api/.env` bloquée).

### 11.2 Conservation et migration

- **Procédure de déploiement** : `README.md` contient désormais
  « Migrations à exécuter avant l'activation d'une version », avec
  `pnpm --filter api migrate:support-request-indexes` marquée **à exécuter
  avant l'activation de cette version**. Comme Railway déploie à chaque push
  sur `main`, elle se lance avant la fusion. Le message attendu de chaque
  passage y est indiqué.
- **Index sur base éphémère** (`test/support-request-indexes.e2e-spec.ts`,
  **3/3**) :
  1. index `createdAt_1_ttl` sur `{ createdAt: 1 }` avec
     `expireAfterSeconds = 2592000` ;
  2. second passage : `already-present`, index identique ;
  3. index homonyme incompatible (`expireAfterSeconds = 60`) : la
     migration échoue et l'index existant reste à 60 s, rien n'est écrasé.
  Aucun résultat antérieur n'établissait ces trois points : la recette avait
  seulement exécuté la migration.
- **Formulations** : la politique de confidentialité et ce rapport (§ 6,
  § 5.1 point 6, § 7) distinguent l'**expiration** après 30 jours, le
  **nettoyage automatique en arrière-plan** qui peut intervenir un peu plus
  tard, et la **conservation séparée** des e-mails dans la messagerie
  support@. Aucune suppression à l'instant exact n'est promise.

### 11.3 Expéditeur

- L'obligation d'utiliser `noreply@stock-master.app` est retirée de ce
  rapport (§ 1.2) et du rapport 1-16C (§ 6.1). `EMAIL_FROM` y est décrit
  comme la configuration existante d'une adresse du domaine vérifié chez
  Resend, sans modification de la production.
- Par cohérence, les pages Contact et Mentions légales ne disent plus que
  les e-mails automatiques « partent de noreply@… ». Elles indiquent qu'ils
  partent d'« une adresse du domaine stock-master.app ». Je n'avais jamais
  vérifié l'affirmation précédente, introduite en 1-16C.1. Un commentaire
  dans le code rappelle que l'expéditeur réel dépend d'`EMAIL_FROM`.
- Inchangé : les informations manquantes restent en commentaires, aucun
  avertissement n'est visible, et les documents gardent le statut interne
  « projet » et `noindex`.

### 11.4 Fichiers de cette étape

| Fichier | Changement |
|---|---|
| `api/src/subscriptions/subscription-access-routes.spec.ts` | `SupportController` dans la matrice ; test dédié (+32 lignes, aucune autre ligne modifiée) |
| `api/test/organization-support.e2e-spec.ts` | 3 tests de refus (expiré, limité, suspendu) ; horloge d'abonnement injectable |
| `api/test/support-request-indexes.e2e-spec.ts` | Nouveau : index TTL, idempotence, refus d'un index incompatible |
| `README.md` | Procédure de migration avant activation |
| `web/src/app/confidentialite/page.tsx` | Expiration, nettoyage différé, messagerie séparée |
| `web/src/app/contact/page.tsx`, `web/src/app/mentions-legales/page.tsx` | Expéditeur décrit comme « une adresse du domaine » |
| `docs/architecture/phase-1-16c1-organization-support.md`, `phase-1-16c-legal-and-usage-pages.md` | Ce point, expéditeur, conservation |

### 11.5 Contrôles exécutés

| Contrôle | Résultat |
|---|---|
| `isolated api-unit src/subscriptions/subscription-access-routes` | 9/9 |
| `isolated api-e2e test/organization-support` | 18/18 |
| `isolated api-e2e test/support-request-indexes` | 3/3 |
| ESLint API (sans `--fix`) sur les 3 fichiers de test touchés | exit 0 (Prettier appliqué avant à ces seuls fichiers) |
| ESLint et `tsc --noEmit` web sur les pages touchées | exit 0 |
| `isolated web-build` | 1er passage : compilation réussie, puis exit 1 au nettoyage (`EBUSY`, verrou Windows déjà rencontré en 1-16C). Copie supprimée par `removeIsolatedWeb`, `web/node_modules` intact. 2e passage : **exit 0**, `envFilesInCopy: 0` |
| `git diff --check` | exit 0 |

## 12. État Git final

Branche `architecture/phase-1-16c-legal-and-usage-pages`, HEAD `12f8dc5`,
index vide, `stash@{0}` inchangé. Détail dans le compte rendu de fin de lot.
