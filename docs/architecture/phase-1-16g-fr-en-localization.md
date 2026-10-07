# Lot 1-16G — Stock Master en français et en anglais

> Les textes juridiques restent des **projets** (statut « projet »,
> `noindex`, sans bandeau visible). Leur traduction anglaise est fidèle au
> français, sans clause, promesse ni coordonnée ajoutée. Elle ne vaut **pas**
> validation juridique.

## 0. Base, Git et règles suivies

- Base : commit F `cfbb6de` (« feat: implement light/dark theme support
  across the application »). Branche
  `architecture/phase-1-16g-fr-en-localization` créée depuis ce HEAD
  (`git switch -c`).
- `stash@{0}` (sauvegarde lint-staged `564a998`) présent et **non touché**.
- **Incident d'index (corrigé)** : un `git rm --cached
  web/src/lib/analytics-labels.ts` a brièvement modifié l'index. Il a été
  annulé aussitôt par `git restore --staged`. L'index est **vide** ; la
  suppression de ce fichier n'existe que dans l'arbre de travail.
- Aucun commit, push, déploiement, migration réelle ni activation. Aucun
  `.env` réel ouvert. MongoDB éphémère uniquement, transports e-mail et push
  simulés. CamPay reste désactivé (fournisseur simulé en recette) et le
  webhook aussi.
- Les règles métier, les codes, les permissions, les identifiants, les
  statuts et les routes sont inchangés. La documentation de développement et
  les commentaires restent en français.

## 1. Inventaire de départ

Tous les textes étaient écrits en dur, en français, dans environ 160 fichiers
du web. Ils ont été regroupés par domaine :

- pages publiques et documents ;
- authentification ;
- catalogue ;
- ventes et file hors ligne ;
- analyse ;
- organisation ;
- abonnement ;
- notifications ;
- interface commune.

Côté API, environ 90 messages d'erreur visibles, en français et en anglais
historique, s'y ajoutent. S'y ajoutent aussi trois modèles d'e-mail, les
textes génériques des notifications push et du centre, et les libellés des
exports Excel et PDF. Le service worker affiche un texte de repli.
L'inventaire est désormais rejouable (§ 6.1).

## 2. Bibliothèque, mode et rendu

### 2.1 Dépendances (versions exactes)

| Paquet | Version | Rôle |
|---|---|---|
| `next-i18next` | `16.3.1` | Intégration App Router (proxy, serveur, client) |
| `i18next` | `26.4.2` | Moteur (pluriels CLDR, interpolation) |
| `react-i18next` | `17.0.16` | Liaison React, requise par next-i18next |

- Les versions sont fixées sans `^` dans `web/package.json`.
- `pnpm-lock.yaml` ne reçoit **que des ajouts** (+98 lignes, 0 ligne
  retirée) : les trois paquets et quatre dépendances transitives
  (`hoist-non-react-statics`, `@types/hoist-non-react-statics`,
  `html-parse-stringify`, `i18next-resources-to-backend`).
- Aucun service de traduction distant n'est utilisé.

### 2.2 Mode retenu : langue hors de l'URL

Le mode est `localeInPath: false` : la langue est lue dans un cookie, sinon
dans l'en-tête `Accept-Language`, sinon le français est retenu.

- **Les URL ne changent pas** : liens des e-mails, routes du service worker
  et favoris restent valides.
- Le mode avec segment `[lng]` a été écarté : changer de segment racine force
  un rechargement complet. Cela casserait la bascule sans perte (§ 4).
- `web/src/proxy.ts` (`createProxy`) fixe l'en-tête interne
  `x-i18next-current-language`, en **écrasant** toute valeur venue du client.
  Le proxy ne pose jamais de cookie (`persistCookie: false`).
- **Routes exclues du mécanisme** : `api`, `socket.io`, `_next/static`,
  `_next/image`, `sw.js`, `manifest.webmanifest`, `favicon.ico`, `icons/`,
  `brand/`, `marketing/`, `robots.txt`, `sitemap.xml` et tout fichier avec
  extension.
- Côté serveur, chaque requête utilise `getT(ns, { lng })`, une traduction
  fixée par requête. **Aucune langue globale n'est modifiable.** La recette
  G1 le vérifie avec 60 requêtes simultanées (§ 7.3).

### 2.3 Effet sur le rendu statique

La disposition racine lit les en-têtes de la requête. Toutes les pages sont
donc rendues **dynamiquement** : elles ne sont plus prérendues au build.

- Conséquence 1 : l'outil d'archive juridique (`web/scripts/legal-archive.mjs`)
  ne lit plus le HTML prérendu.
  - Il lance `next start` sur un port libre, puis lit chaque document avec le
    cookie `fr`, puis `en`.
  - Il exige que la page servie déclare la langue demandée (`html lang`).
  - La commande de la CI est inchangée (`check --next-dir .next`) ;
    `--base-url` permet de viser un serveur déjà lancé.
- Conséquence 2 : un temps serveur par page, sans effet mesuré en recette.
  Vercel exécute ce rendu dynamique sans réglage supplémentaire.
- Les traductions sont **intégrées au build** : ce sont des modules
  TypeScript, sans aucun chargement réseau. Elles fonctionnent donc hors
  ligne et sur Vercel.

## 3. Choix de la langue

### 3.1 Cookie `stockmaster.lang`

| Propriété | Valeur |
|---|---|
| Nom | `stockmaster.lang` |
| Valeur | `fr` ou `en`, aucune donnée personnelle |
| Finalité | Afficher les pages dans la langue choisie |
| Durée réelle | 365 jours (`Max-Age`) ; vérifiée en recette : 365 j |
| Attributs | `Path=/`, `SameSite=Lax`, `Secure` en HTTPS |
| Posé par | **Uniquement** le sélecteur « Français / English » ; jamais par la détection ni par le serveur |

Ce cookie est strictement nécessaire à une fonction demandée par la personne
(le choix de langue) : aucun consentement préalable n'est requis.

Il est documenté dans la page Cookies, version **0.4**. La politique de
confidentialité passe aussi en version 0.4, car la langue choisie devient une
donnée du compte (§ 5.3).

### 3.2 Défaut et détection

- Sans cookie, la langue est choisie dans cet ordre :
  1. l'en-tête `Accept-Language` du navigateur, s'il demande l'anglais
     avant le français ;
  2. sinon le **français** (aucun en-tête, ou autres langues seulement).
- La détection ne fait que **proposer** une langue : elle ne pose aucun
  cookie. Le premier choix explicite fait foi.
- `<html lang>` est rendu par le serveur dans la bonne langue, puis mis à jour
  dans le navigateur à chaque bascule.

### 3.3 Sélecteur

- Le contrôle `LanguageSwitcher` est un menu Base UI identique à celui du
  thème. Le bouton affiche l'icône et `FR` ou `EN`.
- Les choix sont écrits dans leur propre langue (« Français », « English »),
  avec l'attribut `lang`.
- Il est présent dans tous les en-têtes :
  - en-têtes publics ;
  - accueil ;
  - authentification ;
  - accès limité ;
  - écran de blocage ;
  - page hors ligne ;
  - shell `/app`.
- Ordre vérifié dans les quatre combinaisons thème/langue : langue, thème,
  cloche, puis prénom ou déconnexion.

### 3.4 Préférence du compte (e-mails, push)

- Nouveau champ facultatif `User.locale` (`fr` ou `en`).
  - À l'inscription, il reçoit la langue des conditions acceptées.
  - Il est ensuite mis à jour par `PUT /auth/me/locale`. La route est en
    catégorie « identité » : une session limitée peut l'appeler. Elle ne
    lit l'utilisateur que dans le jeton (`sub`), répond en `no-store` et
    refuse tout champ en trop.
- Le navigateur envoie cette préférence une fois par session et par langue,
  en ligne seulement. Un échec est silencieux.
- **Comptes anciens** : sans valeur, les envois partent en français. Aucune
  réécriture globale, **aucune migration** (champ facultatif, aucun index).

## 4. Bascule sans perte, hors ligne comprise

- Toutes les ressources FR et EN sont chargées dans le navigateur
  (`initAsync: false`).
- Une bascule fait quatre choses : écrire le cookie, appeler
  `changeLanguage`, mettre à jour `html lang`, et enregistrer la langue dans
  IndexedDB (`stockmaster-preferences`) pour le service worker.
- Un `router.refresh()` rafraîchit les parties rendues par le serveur, en
  ligne seulement. Hors ligne, il est reporté au retour de la connexion.
- Rien n'est rechargé :
  - formulaires ;
  - UUID d'opération ;
  - verrou d'initiation et marqueur de paiement ;
  - outbox des ventes ;
  - session, thème, couleurs du commerce ;
  - sockets.
- Une bascule ne déclenche aucun paiement, aucun appel CamPay et aucun rejeu
  de vente. Elle n'efface aucune donnée locale.
- Réconciliation :
  - au montage, avec le cookie, pour les pages servies par le cache du
    service worker ;
  - à `visibilitychange`, pour les autres onglets.

## 5. Couverture

### 5.1 Web

- **10 espaces de noms** : `common`, `public`, `auth`, `catalog`, `sales`,
  `analytics`, `organization`, `subscription`, `notifications`, `legal`.
  Ils contiennent **1 191 clés** françaises, dans
  `web/src/i18n/resources/{fr,en}/`.
- Les clés sont typées : l'anglais est typé `Translation<typeof fr>`. Une clé
  manquante ou en trop est une erreur de compilation.
- Les longs documents ont un module de contenu par langue :
  `web/src/i18n/documents/<page>/{fr,en}.tsx`.
  - Pages concernées : CGU, CGA, confidentialité, cookies, mentions,
    traitement des données, contact et guide.
  - Le JSX français a été **déplacé tel quel** ; les empreintes le prouvent
    (§ 5.3).
- Sont traduits :
  - titres et descriptions de page (`generateMetadata`) ;
  - textes accessibles (`aria-label`, `title`, `alt`, `sr-only`) ;
  - validations, messages vides et hors ligne ;
  - notifications toast et aide à l'installation de la PWA.
- **Formats** : `fr-FR` ou `en-GB` pour les nombres et les dates. La devise
  reste **FCFA**. Le fuseau et les bornes comptables ne changent pas.
- **Jamais traduits** : noms de commerce, de produit et de personne, messages
  saisis, codes et statuts techniques. Les étiquettes des rôles et
  permissions sont traduites, pas les codes.
- **Pluriels** : le français a les formes `_one`, `_many` et `_other` (règle
  CLDR « many ») ; l'anglais a `_one` et `_other`.
- Le service worker lit la langue de l'appareil dans IndexedDB pour son
  texte de repli. `CACHE_VERSION` est inchangé (v3).
- Le manifeste PWA a une description bilingue, `lang: "fr"`, et reste hors du
  mécanisme de langue.

### 5.2 API

| Domaine | Comportement |
|---|---|
| Erreurs | Catalogue `common/i18n/error-messages.ts` (88 entrées, gabarits `${…}` avec valeurs reportées). Appliqué par `HttpExceptionFilter` **seulement** si la requête indique une langue (`?lang=` ou `Accept-Language`) ; sinon le message reste tel qu'écrit, pour les scripts et outils. Codes, statuts et filtrage des messages techniques ou sensibles inchangés. |
| E-mails | Confirmation d'adresse, réinitialisation et changement de mot de passe en anglais. Langue = `User.locale` du **destinataire** (repli français), jamais celle du demandeur ni du processus. |
| Push | Texte générique dans la langue de chaque destinataire (`push-dispatcher` lit `User.locale`). Catégorie, lien et regroupement identiques. |
| Centre de notifications | Texte rendu dans la langue de la requête ; donnée enregistrée unique. |
| Exports | `REPORT_LABELS.en` (`en-GB`) : mêmes ventes, mêmes totaux, noms d'origine. Fichier `sales-history-<commerce>-<mois>` en anglais. Message de PDF impossible composé dans la langue demandée. |

### 5.3 Conditions versionnées

**Archives existantes** : elles sont **identiques octet pour octet**, et
aucune preuve n'est modifiée. Ces empreintes sont désormais vérifiées par un
test (`legal.spec.ts`).

| Document | Version | Langue | Empreinte SHA-256 |
|---|---|---|---|
| Conditions d'utilisation | 0.3 | fr | `5c2e4c36…dec2c2` |
| Conditions d'abonnement | 0.3 | fr | `7efc7db3…e72` |
| Conditions d'abonnement | 0.4 | fr | `bade5d46…e4ee` |
| Confidentialité | 0.3 | fr | `941a2c17…d082` |

**Ajouts par le mécanisme C.2** (`legal-archive.mjs write
--published-at=2026-10-08`, build isolé) :

| Document | Version | Langue | Empreinte SHA-256 |
|---|---|---|---|
| Conditions d'utilisation | 0.3 | en | `52ec39f1…bfb7` |
| Conditions d'abonnement | 0.4 | en | `5559b27b…bde` |
| Confidentialité | 0.4 | fr | `4370f183…8de1` |
| Confidentialité | 0.4 | en | `9d52182d…9969` |

- Les traductions des CGU et des CGA gardent **le même numéro de version** que
  le texte français, car leur contenu est identique.
- Les versions remplacées (CGA 0.3, confidentialité 0.3) **ne sont jamais
  traduites**.
- **Confidentialité 0.4** : un seul ajout, la langue choisie parmi les données
  du compte.
- **Cookies 0.4** (page d'information, sans archive) : une rubrique
  « cookie » décrit `stockmaster.lang`. Le stockage IndexedDB
  `stockmaster-preferences` est ajouté.
- **Langue d'une acceptation** : le serveur accepte une langue seulement si
  tous ses documents existent. Sinon il répond `400
  LEGAL_LOCALE_UNAVAILABLE`, par exemple pour `de`.
  - Une acceptation anglaise enregistre les versions `/en` et leurs
    empreintes.
  - Les archives françaises déjà en base ne sont ni modifiées ni remplacées
    (e2e et recette G3).
- Aucune ancienne archive n'est traduite à la volée.
- `publishedAt` est porté par la version. Les traductions des CGU et des CGA
  conservent donc la date 2026-10-07 de leur version française.

## 6. Contrôles rejouables

### 6.1 Commandes

| Commande | Contrôle |
|---|---|
| `pnpm --filter web test:i18n` | Mêmes clés FR/EN, valeurs non vides, mêmes variables `{{x}}` et balises `<x>`, pluriels complets ; rendu anglais avec `fallbackLng: false` (un repli français ne peut pas masquer une absence) |
| `pnpm --filter web i18n:coverage` | Analyse syntaxique de `web/src` : signale tout texte visible écrit en dur (JSX, attributs accessibles, toasts, métadonnées). Échoue s'il en reste. |
| `api/src/common/i18n/i18n.spec.ts` | Chaque message d'erreur lancé dans le code (relevé par `scanErrorMessages`) a une entrée au catalogue ; chaque source française a son anglais ; e-mails, push et libellés de rapport en anglais |
| `legal-archive.mjs check` | Texte servi = archive, pour `fr` et `en` |

Les deux premières commandes sont ajoutées à la CI, job `web`, avant le
build.

### 6.2 Textes non traduits restants

- Le dernier passage de `i18n:coverage` ne relève **0 texte**, sur
  164 fichiers.
- Exclusions volontaires :
  - noms de marque et « EUR ↔ CFA » ;
  - appels réservés au développement (`console.*`) ;
  - `components/objects/*`, du code mort importé nulle part ;
  - `lib/legal/site-identity.ts`, qui contient des données d'identité.
- Restent en français, par décision : voir § 8.

## 7. Validation

### 7.1 API

- **Unitaires** (`recipe.js isolated api-unit`) : **1 547 tests réussis**
  sur 83 suites.
  - Une suite échoue au chargement : `common/validation/name-rules.spec.ts`
    (`Reflect.getMetadata is not a function`).
  - **Cette erreur est antérieure au lot** : aucun des fichiers importés par
    cette suite, directement ou non, n'a changé.
  - Nouvelle suite : `common/i18n/i18n.spec.ts`.
  - Suites adaptées :
    - `legal.spec.ts` : l'anglais est désormais disponible ; empreintes
      françaises figées ; acceptation anglaise ;
    - `auth.controller.spec.ts` : `UsersService`, `/me` avec `locale`,
      `PUT /me/locale` ;
    - matrice des routes : `PUT /auth/me/locale` en « identité ».
- **e2e sur MongoDB éphémère** (`recipe.js isolated api-e2e`), 10 suites :
  - legal-acceptance ;
  - email-verification ;
  - password-reset ;
  - auth-context ;
  - notification-center ;
  - web-push-notifications ;
  - monthly-history-export et monthly-history-limits ;
  - organization-support ;
  - invitations.

  Le résultat final est donné au § 7.4.
- **Cas e2e ajoutés** :
  - Inscription en anglais : preuve `/en`, archives françaises intactes,
    `User.locale = en`, e-mail de confirmation en anglais, `/auth/me`.
  - `PUT /auth/me/locale` :
    - 401 sans session ;
    - 400 si la langue est inconnue ou si un champ est en trop ;
    - 200 en `no-store` ;
    - seule la préférence change.
  - Erreurs : trois requêtes simultanées (sans langue, en `fr`, en `en`).
    Le message suit la langue demandée ; statut et corps sont identiques
    sinon ; le code `LEGAL_LOCALE_UNAVAILABLE` n'est jamais traduit.
  - Exports FR/EN : mêmes lignes et mêmes valeurs numériques dans chaque
    feuille. Libellés anglais, noms d'origine, FCFA. PDF anglais avec le
    même nombre de pages.
  - Push : la même alerte arrive en français au propriétaire et en anglais à
    l'administrateur. Le vendeur à l'origine de la vente est en anglais,
    sans effet sur les autres.
  - E-mails de mot de passe : compte anglais → anglais. Compte ancien sans
    préférence, même demandé depuis un navigateur anglais → français.
  - Centre : même notification en `en` et en `fr`, avec identifiant, lien et
    état de lecture identiques.
- **Autres contrôles** :
  - lint API sans `--fix` : 0 erreur ; 2 avertissements dans des fichiers
    non modifiés ;
  - `tsc` du build (`tsconfig.build.json`) : 0 erreur ;
  - `nest build` : `dist/legal/archive` contient les 8 textes et le
    manifeste.
- `tsc` avec la configuration de test signale des erreurs de typage dans des
  tests anciens, ignorées par ts-jest. **Une seule venait du lot** : le
  catalogue d'offres du web importait `@/i18n/format`, que l'API ne résout
  pas. C'est corrigé par des imports relatifs.

### 7.2 Web

- Contrôles qui passent :
  - `tsc` et ESLint (0 problème) ;
  - `test:i18n` (10 espaces, 1 191 clés, 0 problème) ;
  - `i18n:coverage` (0 texte) ;
  - `test-tenant-brand` et `test-refresh-coordinator` ;
  - `git diff --check`.
- **Build isolé** (`recipe.js isolated web-build`) :
  - build réussi (exit 0) ;
  - archive vérifiée en `fr` et en `en` : 0 problème ;
  - 0 fichier `.env` dans la copie.

### 7.3 Recette navigateur (7/7)

Conditions : pile isolée `recipe.js start --provider=simulated`, Playwright
1.64 installé hors du dépôt, Chromium sans interface.

| # | Scénario | Résultat |
|---|---|---|
| G1 | 60 requêtes simultanées (6 pages, cookie FR ou EN, `Accept-Language` contraire) | 0 fuite de langue ; sans cookie → `fr` ; navigateur `de` → `fr` ; navigateur `en` → `en` ; `sw.js` et manifeste servis sans cookie et inchangés |
| G2 | Rendu initial et hydratation : 13 pages publiques + 15 pages `/app`, en FR puis en EN | `html lang` juste partout ; 0 erreur console ou d'hydratation |
| G3 | Inscription : 5 champs remplis et case cochée, puis bascule en anglais | Champs et case conservés, même document, cookie `en` 365 j `Lax`. Inscription envoyée en anglais : preuve `conditions-utilisation@0.3/en`, `conditions-abonnement@0.4/en` ; `User.locale = en` ; 3 archives françaises identiques |
| G4 | Vente en attente (POST coupé), puis passage **hors ligne** et bascule en anglais | Interface anglaise hors ligne ; vente intacte (UUID, contenu, date, statut) ; 0 POST pendant la bascule ; même document. Au retour : **1** vente, même UUID ; langue conservée |
| G5 | Paiement initié (fournisseur simulé), puis bascules FR → EN → FR | Marqueur `stockmaster_payment_intents` identique ; 1 paiement ; 0 POST de paiement ; 0 nouvelle initiation |
| G6 | Mobile 390 px, clair/sombre × FR/EN, 4 pages | 0 débordement horizontal ; thème appliqué ; noms du commerce et du produit inchangés ; ordre langue › thème › cloche › déconnexion |
| G7 | Téléchargement Excel depuis l'interface anglaise | Requête `?lang=en` → 200, fichier `sales-history-…xlsx` |

G4 détail : pendant l'attente, seuls les compteurs de nouvel essai
(`attempts`, `nextAttemptAt`, `updatedAt`, `lastError`) ont évolué, comme
prévu avec un réseau coupé.

La pile a été arrêtée par `recipe.js stop` ; sa copie
`.stockmaster-recipe-web/` est supprimée.

### 7.4 Dernier passage

Les 10 suites e2e ciblées ont été rejouées une dernière fois après toutes les
modifications (MongoDB éphémère, `recipe.js isolated api-e2e`) :
**10 suites réussies, 152 tests réussis sur 152**.

## 8. Limites connues

- **Validation automatique (class-validator)** : les messages par défaut,
  sans `message` explicite (par exemple « name must be a string »), restent
  en anglais. Le web affiche ses propres messages pour ces cas.
- **Manifeste PWA** : une seule langue (`lang: "fr"`, description bilingue).
  Il est exclu du mécanisme de langue.
- **Cache du service worker** : une page mise en cache garde la langue de sa
  mise en cache. Au chargement, elle est réalignée sur le cookie, sans
  rechargement.
- **Accueil** : les captures marketing (images) restent en français.
- **Assistance** : l'e-mail transmis à l'équipe Stock Master reste en
  français. Le message saisi n'est jamais traduit.
- **Synchronisation de la préférence** : un `PUT /auth/me/locale` par session
  et par changement de langue, en ligne seulement. Un appareil resté hors
  ligne envoie sa préférence à la reconnexion suivante.
- **Inventaire** (`i18n:coverage`) : c'est une heuristique syntaxique. Un texte
  construit par concaténation hors JSX pourrait lui échapper. La relecture de
  G2 et G6 n'en a pas trouvé.
- **Code mort** : `components/objects/*` n'est pas traduit, car il n'est
  importé nulle part.
- **`name-rules.spec.ts`** : son échec est antérieur au lot, et rien ne le
  corrige ici.

## 9. Fichiers

### 9.1 Nouveaux

- **Web — infrastructure i18n** : `web/src/i18n/`, qui contient :
  - `settings.ts`, `config.ts`, `server.ts`, `locale-provider.tsx` ;
  - `rich.tsx`, `format.ts`, `use-format.ts`, `use-message.ts`,
    `client-t.ts`, `i18next.d.ts` ;
  - `resources/` et `documents/`.
- **Web — autres fichiers** :
  - `web/src/proxy.ts` ;
  - `web/src/components/i18n/language-switcher.tsx` ;
  - `web/src/components/public/header-classes.ts` ;
  - `web/src/components/analytics/use-analytics.ts` ;
  - `web/src/lib/device-locale-db.ts` ;
  - `web/scripts/check-i18n.mjs` et `web/scripts/i18n-coverage.mjs`.
- **API** :
  - `api/src/common/i18n/` : `locale.ts`, `error-messages.ts`,
    `error-message-scan.ts`, `i18n.spec.ts` ;
  - `api/src/auth/dto/update-locale.dto.ts` ;
  - 4 archives juridiques (§ 5.3).
- **Ce rapport.**

### 9.2 Supprimé (arbre de travail seulement)

- `web/src/lib/analytics-labels.ts`, remplacé par l'espace de noms
  `analytics`.

### 9.3 Modifiés

- Environ 140 fichiers web : pages, composants, `lib/`, `public/sw.js`,
  `scripts/legal-archive.mjs`, `package.json`.
- API :
  - `auth` : contrôleur, service, stratégie JWT ;
  - filtre d'exceptions ;
  - e-mails de confirmation et de mot de passe ;
  - `legal` : contrôleur, service, documents, manifeste ;
  - notifications et push ;
  - `organizations.service` ;
  - rapports : contrôleur et libellés ;
  - `users` : schéma et service ;
  - tests e2e et unitaires cités au § 7.1.
- `pnpm-lock.yaml` (ajouts seulement) et `.github/workflows/ci.yml` (deux
  contrôles i18n, commentaire de l'archive).
