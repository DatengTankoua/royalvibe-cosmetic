# Lot 1-16B — Accueil moderne et parcours d'inscription

Branche : `architecture/phase-1-16b-marketing-homepage`, créée depuis
`72d882e` (`architecture/phase-1-16a-web-push-notifications`, déjà poussée).
État initial vérifié : HEAD `72d882eb38062b8955909beb4590fc644b589eb5`, arbre
et index propres, un stash préexistant (`stash@{0}: lint-staged automatic
backup (564a998)`), laissé intact.

Périmètre : page `/` et composants `components/landing/*`. Inchangés : shell
`/app`, authentification, permissions, service worker, ventes hors ligne,
notifications, paiements, règles d'accès.

## 1. Skills de design

| Skill | Source et révision consultée |
|---|---|
| Création : `frontend-design` | `anthropics/skills`, `skills/frontend-design/SKILL.md`, dernier commit du fichier `41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f` |
| Revue : `web-design-guidelines` | `vercel-labs/agent-skills`, `skills/web-design-guidelines/SKILL.md`, commit `ba46938889d4e58635362fb8f618e1178ac3ec46` |
| Directives référencées par la revue | `vercel-labs/web-interface-guidelines`, `command.md`, commit `4ecfb9fb8d1d3b7009674869b3aaee2f904042e1` |

Lus avec `curl` (raw GitHub + API des commits), le 6 octobre 2026. Aucun
CLI installé, aucune dépendance ajoutée.

## 2. Direction visuelle retenue

**Idée :** « le cahier de la boutique, dans le téléphone ». L'accueil montre
tout de suite l'application réelle, sur un bandeau bleu marine, avec une
seule couleur d'action (l'orange).

- **Couleurs :** bleu marine `#062B5C` (texte, bandeaux), orange `#FF6A00`
  (action principale uniquement, texte bleu dessus), blanc, bleu brume
  `#EEF3F9` (section hors ligne), ardoise `#3D4E66` (texte secondaire).
- **Typographie :** Geist seule (déjà chargée par `next/font`), titres en
  800 serrés, `text-balance` sur les titres, chiffres tabulaires pour les
  prix. Aucune police ajoutée.
- **Composition :** tout aligné à gauche. Héros en deux colonnes sur
  ordinateur (texte, puis deux téléphones superposés), empilé sur
  téléphone. Les bénéfices sont une liste à icônes, pas une grille de
  cartes identiques. Les tarifs forment une liste de prix (total d'abord),
  la formule 12 mois marquée d'un filet orange. La FAQ utilise `<details>`
  natif.
- **Écartés volontairement** (tics relevés par `frontend-design`) : étiquettes
  en majuscules au-dessus des titres, mot isolé surligné dans le titre,
  flèches dans les boutons, grille de quatre cartes de prix identiques,
  animations d'entrée par section. La numérotation n'est utilisée que pour
  le fonctionnement hors ligne, qui est une vraie séquence.
- **Mouvement :** aucune animation automatique. Seule la flèche de la FAQ
  pivote, sous `motion-safe`.
- **Écart assumé avec la revue Vercel :** elle demande des titres en
  « Title Case » (règle anglaise). En français, on garde la majuscule
  initiale seule, comme le recommande aussi `frontend-design`.

### Visuel principal : vraies captures

La recette permettait de produire de vraies captures, l'accueil les utilise
donc : écrans **Analyse** et **Ventes**, capturés à 390 × 844 px (échelle 2)
sur la stack éphémère de la recette. Ils ont été refaits lors de la
finalisation, après la correction de la police (§ 5.2), avec les mêmes
données fictives et après `document.fonts.ready` :

- compte et commerce fictifs, « Gérant Démo » et « Boutique Démo », créés par
  les routes publiques (inscription, puis lien de vérification capturé par
  la recette) ;
- 3 rayons et 9 produits génériques sans marque (riz, huile, savon…), avec
  des images unies générées pour l'occasion ;
- 10 ventes fictives, via `POST /sales` ;
- le bandeau d'activation des notifications a été fermé avec « Plus tard »,
  une action normale de l'utilisateur.

Fichiers : `web/public/marketing/capture-analyse-mobile.png` (90 Ko) et
`capture-ventes-mobile.png` (125 Ko), servis en WebP par l'optimiseur Next.
Les chiffres affichés n'ont pas changé (324 500, 88 250 et 18 200 FCFA,
20,6 %, 76 unités, 10 transactions), donc les textes alternatifs restent
exacts. La légende indique toujours « Captures réelles de l'application,
avec une boutique et des ventes fictives ». Aucun contenu de client réel.

## 3. Fichiers modifiés

| Fichier | Changement |
|---|---|
| `web/src/app/page.tsx` | Accueil réécrit : en-tête, héros, bénéfices, hors ligne, tarifs, FAQ, appel final, pied de page ; lien d'évitement, `touch-action: manipulation`. Le flag d'inscription est lu au niveau du module : quand l'inscription est fermée, les métadonnées, la première et la cinquième réponse de la FAQ et le titre de l'appel final ne présentent plus l'essai comme accessible. |
| `web/src/app/globals.css` | **Une ligne** : `--font-sans: var(--font-sans)` devient `--font-sans: var(--font-geist-sans)` (référence circulaire, § 5.2). Aucun autre changement global. |
| `web/src/components/landing/landing-header.tsx` (nouveau) | En-tête client : navigation par ancres et, sous 1024 px, menu repliable (`aria-expanded`/`aria-controls`, Échap rend le focus au bouton, fermeture au clic sur un lien ou au passage en largeur bureau). |
| `web/src/components/landing/landing-nav.ts` (nouveau) | Liste des ancres partagée par l'en-tête et le pied de page, dans un module neutre (voir § 6, point 7). |
| `web/src/components/landing/product-preview.tsx` (nouveau) | Les deux captures dans des cadres de téléphone, avec leur légende. |
| `web/src/components/landing/session-cta.tsx` | Libellés qui disent l'action (« Se connecter », « Créer un compte », « Ouvrir l'application ») ; liens stylés directement, sans `<button>` dans un `<a>` ; lien d'inscription masqué quand le flag d'affichage la ferme ; variantes `menu` et `final` (fond sombre). La logique de session est inchangée. |
| `web/public/marketing/*.png` (nouveaux) | Les deux captures. |
| `docs/architecture/phase-1-16b-marketing-homepage.md` (nouveau) | Ce rapport. |
| `docs/architecture/phase-1-16b-captures/*.png` (nouveaux) | Captures de la recette (§ 5). |

Non modifiés : `layout.tsx`, `sw.js`, `subscription-offers.*`, pages
`auth/*` et `/app`, harnais de recette, API.

## 4. Contenu et tarifs vérifiés

| Affirmation de la page | Source vérifiée |
|---|---|
| 1 mois 3 000, 3 mois 8 500, 6 mois 16 000, 12 mois 30 000 FCFA | `api/src/subscriptions/subscription-pricing.ts:34-37`, identiques à `web/src/lib/subscription-offers.ts` (rendu à partir de ce module, jamais recopié) |
| Économies 500, 2 000 et 6 000 FCFA (« 2 mois offerts ») ; équivalents mensuels 2 833, 2 667 et 2 500 FCFA | calculs de `subscription-offers.ts` (cohérence vérifiée au chargement) |
| Essai de 7 jours, à la création du commerce | `TRIAL_DURATION_MS` (`subscription-terms.ts:43`) ; `grantTrial` appelé à la création de l'organisation (`organizations.service.ts:334`) |
| Sans carte bancaire | aucune donnée de paiement dans l'inscription |
| Confirmation de l'adresse e-mail avant l'accès | page `auth/register` (« Confirmez votre adresse email… ») |
| Aucun prélèvement automatique, aucun supplément par vendeur | `OfferConditions` (conditions validées en 1-14C.2) |
| Vendeurs invités par un lien transmis soi-même | `create-invitation-dialog.tsx` (1-12G : aucun e-mail envoyé) |
| Chaque membre peut vendre ; les autres droits s'ajoutent un par un | `STANDARD_MEMBER_PERMISSIONS` et `SUPPLEMENTARY_PERMISSIONS` |
| Analyse : chiffre d'affaires, bénéfice, marge, classements produits et vendeurs ; stock faible et épuisés | `app/app/analytics/page.tsx` et capture réelle |
| Hors ligne : catalogue et droit de vendre gardés 72 h, ventes en attente jusqu'à 14 jours, envoi automatique, serveur qui revalide, seule la vente possible sans réseau | `OFFLINE_CATALOG_TTL_MS`, `OFFLINE_SALES_CAPABILITY_TTL_MS`, `OUTBOX_PENDING_MAX_AGE_MS`, accueil `/app` (le catalogue est la seule route `/app` servie hors ligne) |
| Ajout à l'écran d'accueil selon le navigateur (Chrome Android) | `lib/pwa-install.ts` |
| Espace séparé par commerce | isolation multi-tenant (phase 1-4) |

**Volontairement absents :** témoignages, nombre de clients, gains chiffrés,
partenaires, logos d'opérateurs, CamPay et Mobile Money (paiement non
annoncé comme actif), notifications push Android ou iPhone. La page parle
seulement d'un « centre de notifications dans l'application ».

**Inscription fermée :** si `NEXT_PUBLIC_REGISTRATION_ENABLED` ne vaut pas
`true`, les boutons d'essai deviennent « Se connecter », les liens
d'inscription disparaissent (en-tête, menu, tarifs, appel final, pied de
page), la page affiche « Les inscriptions sont momentanément fermées », et
ni la FAQ, ni les métadonnées, ni l'appel final ne parlent d'essai.
Vérifié dans le navigateur sur un build isolé avec le flag à `false`
(§ 5.3).

## 5. Contrôles et résultats

### 5.1 Premier passage (avant finalisation)

Tout tourne sur la stack de recette éphémère (`recipe.js start`, fournisseur
simulé) : MongoDB en mémoire, copie web isolée sans `.env*`, comptes
fictifs, aucun envoi externe. Playwright 1.62.1 déjà présent hors dépôt
(cache npx), Chromium 1234. Le script de recette ciblée est un fichier de
travail hors dépôt. Il réutilise `api/test/recipe/lib.js` (`loadPlaywright`,
`uiLogin`).

#### Recette navigateur : 22/22

| # | Contrôle | Résultat |
|---|---|---|
| M1 | Mobile 390 px sans débordement horizontal | OK (`scrollWidth` 390 = `clientWidth` 390) |
| M2 / M2b | Images chargées, `alt` présents, aperçu décodé | OK |
| M3–M6 | Menu mobile : fermé au départ, ouvert (`aria-expanded=true`), 4 ancres plus Se connecter / Créer un compte, Échap ferme et rend le focus au bouton | OK |
| M7 | Lien du menu : le panneau se ferme et `#tarifs` arrive sous l'en-tête (haut à 80 px, en-tête de 64 px) | OK |
| M8 | FAQ au clavier : Entrée ouvre puis ferme | OK |
| M9 | Les 6 ancres ont une cible | OK |
| M10 | 11 liens d'authentification : « Se connecter » / « Connexion » vers `/auth/login`, « Commencer mon essai gratuit » / « Créer un compte » / « Inscription » vers `/auth/register` | OK |
| M11–M12 | Bouton principal vers le formulaire d'inscription ; « Se connecter » vers la connexion | OK |
| M13 | Mobile : 0 erreur console, 0 requête en échec, 0 réponse ≥ 400 | OK (voir note) |
| D1–D3 | Bureau 1440 px : pas de débordement, navigation visible, menu mobile masqué, images chargées | OK |
| D4 | Premier Tab : lien « Aller au contenu » visible | OK |
| D5 | Focus visible sur les 25 éléments atteints au clavier | OK |
| D6 | Bureau : 0 erreur console, 0 ressource manquante | OK |
| S1 | Session active : l'accueil reste affiché sans redirection, « Ouvrir l'application » mène à `/app`, aucune erreur | OK |
| S2 | Session limitée (abonnement expiré) : l'accueil reste affiché sans redirection, liens publics, `/access` toujours servi | OK, comportement de la base (voir note) |

Notes :

- **M13**, premier passage : 2 `net::ERR_ABORTED` sur `/_next/image`. Le test
  ouvrait `/` puis cliquait aussitôt sur le bouton d'essai, et la navigation
  annulait les chargements en cours. Les deux URL répondent 200 en
  `image/webp`. Le contrôle compte maintenant à part les annulations dues
  aux navigations du test. Au passage final : 0 erreur avant navigation et 0
  annulation.
- **S2**, premier passage : j'attendais « Ouvrir l'application » en session
  limitée. Or, à `72d882e`, `SessionCta` ne teste que `useAuth().user`, et
  la session limitée est un jeton séparé en `sessionStorage`, sans `user`.
  L'accueil affichait donc déjà les liens publics. Ce comportement est
  conservé comme demandé, et le contrôle vérifie maintenant ce comportement.

#### Contrastes (WCAG, calculés)

| Couple | Ratio |
|---|---|
| Blanc sur bleu marine | 13,93 |
| Bleu sur orange (bouton principal) / survol `#FF8533` | 4,85 / 5,74 |
| Blanc à 80 % sur bleu (textes secondaires du héros) | 9,40 |
| Ardoise sur blanc / sur bleu brume | 8,47 / 7,59 |
| Bleu à 80 % sur blanc (liens de l'en-tête) | 7,60 |
| Bordure du bouton secondaire (élément non textuel) | 3,44 |

#### Revue `web-design-guidelines`, appliquée à `page.tsx` et `components/landing/*`

Corrigé pendant la revue : `touch-action: manipulation` ; appel final avec
l'inscription en premier ; `<button>` imbriqué dans `<a>` supprimé
(`SessionCta`) ; double `<main>` évité (le layout racine en fournit déjà un,
le contenu de l'accueil est un `div#contenu`). Conforme : `aria-label` sur
le bouton icône, icônes en `aria-hidden`, lien d'évitement, hiérarchie
h1 > h2 > h3, `scroll-margin` sur les ancres, `focus-visible` partout,
`…`, guillemets « », espaces insécables avant « par mois », `tabular-nums`,
`text-balance`/`text-pretty`, `min-w-0`, images dimensionnées, `priority` sur
la capture principale, `Intl.NumberFormat` pour les montants.

Points restants, mineurs :

- `#contenu` (`tabIndex=-1`, cible du lien d'évitement, non interactif) a
  `outline-none`.
- Pas de `scroll-padding-top` global : un élément atteint au Tab peut
  passer sous l'en-tête collant. Cela demanderait de modifier `html`
  (globals), hors périmètre.
- Pas de `translate="no"` sur « Stock Master » dans le texte courant.

#### Autres contrôles

| Commande | Résultat |
|---|---|
| `npx eslint` (dans `web/`, sans `--fix`) | exit 0, aucun message |
| `npx tsc --noEmit` (dans `web/`) | exit 0 |
| `node api/test/recipe/recipe.js isolated web-build` (recette arrêtée) | exit 0 ; `/` prérendue en statique ; `envFilesInCopy: 0` ; 3 `.env*` exclus sur leur nom ; accès `.env*` bloqués par la garde ; copie supprimée ensuite |
| `git diff --check` | exit 0 ; nouveaux fichiers texte sans espace en fin de ligne |

Un premier build de recette a échoué au prérendu de `/` :
`LANDING_NAV.map is not a function`. Cause et correction au § 6, point 7.

Non relancés, conformément à la consigne : campagnes RT, D.2H, suites API
complètes.

### 5.2 Finalisation : police

Vérification préalable : `next/font` déclare bien `variable: "--font-geist-sans"`
(`web/src/app/layout.tsx:10`). La correction attendue s'appliquait donc
telle quelle. Le contournement local de l'accueil
(`font-[family-name:var(--font-geist-sans)]`) a été retiré, il n'est plus
utile.

Contrôle navigateur (stack de recette, compte « Boutique Démo ») : après
`networkidle` et `document.fonts.ready`, la police **effectivement rendue**
est lue par le protocole DevTools (`CSS.getPlatformFontsForNode`), et pas
seulement la valeur CSS déclarée. La mesure porte sur le titre (`h1`/`h2`,
sinon le bouton d'envoi) et sur un élément de texte courant. Elle est
complétée par une mesure de débordement horizontal. Résultat : **12/12**.

| Largeur | Connexion | Inscription | Catalogue | Ventes | Analyse | Console |
|---|---|---|---|---|---|---|
| Mobile 390 px | Geist, 390/390 | Geist, 390/390 | Geist, 390/390 | Geist, 390/390 | Geist, 390/390 | 0 erreur |
| Bureau 1440 px | Geist, 1440/1440 | Geist, 1440/1440 | Geist, 1440/1440 | Geist, 1440/1440 | Geist, 1440/1440 | 0 erreur |

Police déclarée partout : `Geist, "Geist Fallback"`. Polices rendues
relevées : uniquement `Geist`, jamais `Times New Roman` ni la police de
repli. Au premier passage, la sonde a renvoyé 2 KO sur Connexion, faute de
`<h1>` sur cette page ; elle a été corrigée et Geist y est bien rendue.
Remarque hors périmètre : la page Connexion n'a pas de titre `<h1>`, son
titre visible est le logo. C'est préexistant et n'a pas été modifié.

### 5.3 Finalisation : inscriptions fermées

Un script de travail hors dépôt reprend les modules du harnais
(`web-copy.prepareIsolatedWeb`, `recipe-common.webEnv`, garde `.env` chargée
par `preload.cjs`). Il construit et sert la copie isolée
`.stockmaster-recipe-web/` avec `NEXT_PUBLIC_REGISTRATION_ENABLED=false`, la
surcharge passée en dernier à `webEnv`. Ni le harnais ni l'API n'ont été
modifiés. Aucune API ni base n'est démarrée : l'accueil et
`/auth/register` fermé n'appellent pas l'API. Résultat : **17/17**.

| # | Contrôle | Mobile | Bureau |
|---|---|---|---|
| B1 | Copie isolée : 3 `.env*` exclus sur leur nom, 0 présent | OK | |
| B2 | `next build` avec le flag à `false` : exit 0 | OK | |
| C1 | Message « Les inscriptions sont momentanément fermées » visible (2 occurrences : héros et tarifs) | OK | OK |
| C2 | 0 lien vers `/auth/register` dans l'en-tête, le menu ouvert (mobile), les tarifs, l'appel final et le pied de page | OK | OK |
| C3 | Bouton du héros « Se connecter » vers `/auth/login` ; appel final limité à « Se connecter » | OK | OK |
| C4 | 0 occurrence de « essai » et 0 invitation à s'inscrire dans tout le texte, FAQ dépliée comprise ; métadonnées sans essai (« Abonnement de 3 000 FCFA par mois, ou 30 000 FCFA pour 12 mois. ») | OK | OK |
| C5 | Clic sur le bouton principal : arrivée sur `/auth/login` | OK | OK |
| C6 | `/auth/register` : écran existant « Inscription désactivée », 0 formulaire, lien « Se connecter » vers `/auth/login` | OK | OK |
| C7 | 0 erreur console, 0 réponse ≥ 400, pas de débordement | OK | OK |
| B3 | Copie isolée supprimée après le test | OK | |

Ce contrôle a fait apparaître trois textes qui présentaient encore l'essai
comme accessible quand l'inscription est fermée : la FAQ (« Comment je
commence ? Créez votre compte… », « Après les 7 jours d'essai… »), la
description des métadonnées et le titre de l'appel final (« Essayez Stock
Master… »). Ils sont maintenant conditionnés au flag. Quand l'inscription
est ouverte, les textes sont identiques à ceux d'avant.

### 5.4 Finalisation : nouvelles captures et recette de l'accueil

Après le remplacement des captures, la stack de recette a été reconstruite
sur le code final et la recette de l'accueil (§ 5.1) relancée : **22/22**,
sur trois passages consécutifs.

Le passage précédent, sur le même code, avait donné 21/22 : M13 signalait
2 erreurs côté mobile avant toute navigation. À ce moment, le script ne
consignait que leur nombre. Il les détaille maintenant, et elles ne se sont
plus reproduites en trois passages. Leur nature reste **inconnue**. Le
contexte : la machine n'avait que 309 Mo de RAM libre, et un démarrage de la
stack venait d'échouer sur `TurbopackInternalError … os error 1450`
(ressources système insuffisantes), réussi à la relance sans changement de
code.

Présentation dans l'accueil : M2 et M2b vérifient le chargement et le
décodage des deux captures, et M13 et D6 l'absence de ressource manquante.
Les captures `accueil-*` montrent les écrans en Geist.

#### Contrôles finaux

| Commande | Résultat |
|---|---|
| `npx eslint` (dans `web/`, sans `--fix`) | exit 0, aucun message |
| `npx tsc --noEmit` (dans `web/`) | exit 0 |
| `node api/test/recipe/recipe.js isolated web-build` (recette arrêtée) | exit 0 ; `/` prérendue en statique ; `excludedEnvFilesByName: 3`, `envFilesInCopy: 0` ; copie supprimée |
| `git diff --check` | exit 0 ; nouveaux fichiers texte sans espace en fin de ligne |

Non relancés, conformément à la consigne : campagnes RT, D.2H, suites API.

#### Captures (`docs/architecture/phase-1-16b-captures/`)

| Fichier | Contenu |
|---|---|
| `accueil-mobile-haut.png` | Accueil ouvert, premier écran 390 × 844 |
| `accueil-mobile-menu.png` | Menu mobile ouvert |
| `accueil-mobile-faq.png` | FAQ, une question ouverte |
| `accueil-desktop-haut.png` | Accueil ouvert, premier écran 1440 × 900 |
| `accueil-desktop-complet.png` | Page entière sur ordinateur |
| `ferme-mobile-haut.png`, `ferme-bureau-haut.png` | Inscription fermée, premier écran |
| `ferme-mobile-menu.png` | Inscription fermée, menu ouvert (« Se connecter » seul) |
| `ferme-mobile-auth-register.png` | `/auth/register` fermé (écran existant) |
| `police-mobile-connexion.png`, `police-mobile-analyse.png`, `police-bureau-catalogue.png` | Espace connecté et connexion en Geist |

## 6. Validé localement et configuration de production non vérifiée

### Validé localement (recette isolée, données éphémères)

- Accueil ouvert et fermé, mobile et bureau : contenus, liens, menu, FAQ,
  clavier, focus, contrastes, absence de débordement et d'erreur (§ 5).
- Police Geist effectivement rendue sur Connexion, Inscription, catalogue,
  Ventes et Analyse (§ 5.2).
- Sessions déjà ouvertes, active et limitée : comportement de la base
  conservé (§ 5.1).
- Build de production isolé sans aucun `.env` réel.

### Non vérifié : configuration de production avant le 9 octobre

1. **Inscription fermée par défaut, à deux niveaux.** L'API refuse
   l'inscription sauf si `PUBLIC_REGISTRATION_ENABLED=true`
   (`auth.controller.ts:59`). Le web ne l'affiche que si
   `NEXT_PUBLIC_REGISTRATION_ENABLED=true`, une valeur fixée au build. Pour
   ouvrir, il faut activer **les deux** en production et reconstruire le
   web. Si un seul est activé, l'accueil et l'API se contredisent. Les
   règles d'accès n'ont pas été modifiées.
2. **Confirmation de l'e-mail obligatoire.** Sans `RESEND_API_KEY` et
   `EMAIL_FROM` valides en production, le lien de confirmation ne part pas
   et le nouveau commerçant ne peut pas se connecter.
3. **Renouvellement après l'essai.** La page ne cite aucun moyen de
   paiement, car CamPay n'est pas actif. Il faut une procédure côté
   opérateur (attribution par script) et un moyen de contact.
4. **Rendu de la police en production.** La correction a été vérifiée sur
   le build isolé. Le build de production (Vercel ou image Docker)
   télécharge Geist via `next/font/google`, comme avant : à vérifier une
   fois déployé.

### Points connus, hors périmètre

5. **Accueil hors ligne.** Le service worker précache `/`, mais pas les URL
   `/_next/image`. Hors ligne, l'accueil s'affiche avec le texte alternatif
   à la place des captures. Le service worker n'a pas été modifié.
6. **Changement visible dans l'espace connecté.** La correction de la police
   remplace la police serif par défaut par Geist dans tout le shell, comme
   le prévoyait déjà `layout.tsx`. Les contrôles § 5.2 n'ont relevé aucun
   débordement sur les cinq écrans vérifiés. Les autres écrans du shell
   n'ont pas été passés en revue un par un.
7. **Piège pour les prochains lots.** Une constante exportée d'un module
   `"use client"` (comme `RECOMMENDED_TERM` ou l'ancienne `LANDING_NAV`)
   n'est, dans un composant serveur, qu'une référence client, pas sa valeur.
   C'est la cause du premier prérendu cassé. Correctif : les constantes
   partagées vont dans un module neutre (`landing-nav.ts`), et la formule
   mise en avant est calculée à partir des données.

## 7. Arrêt

Arrêt avant commit, push et déploiement. L'index et le stash sont dans leur
état initial. État Git complet : voir le compte rendu de fin de lot.
