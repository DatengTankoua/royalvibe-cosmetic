# Lot 1-16F — Mode clair/sombre sur toute l'application

État : **implémenté et validé, non commité**. Aucun commit, push ni
déploiement. CamPay reste indisponible, webhook désactivé.

## 1. Base

- Au départ : branche `architecture/phase-1-16c-legal-and-usage-pages`,
  HEAD `ab7441f`, lot 1-16E présent mais non commité, index vide, stash
  `stash@{0}` (« lint-staged automatic backup (564a998) »). Le travail F a
  commencé sur cette branche, sans toucher aux fichiers E.
- Pendant le lot, l'utilisateur a commité E (`7e463d9`, « feat: add analytics
  insights sections and labels for French localization », 26 fichiers, tous
  du lot E). La branche **`architecture/phase-1-16f-light-dark-theme`** a
  alors été créée depuis ce HEAD (`git switch -c`, modifications F emportées
  telles quelles). Aucun reset, aucune application de stash, aucun nettoyage.
- Fin de lot : index vide, `stash@{0}` inchangé, aucun fichier E modifié.

## 2. Inventaire initial

| Élément | Constat |
|---|---|
| Thème | Jetons shadcn (`:root` / `.dark`) déjà présents dans `globals.css`, variante Tailwind `dark:` déclarée, mais **aucun mécanisme pour poser `.dark`** |
| `next-themes` 0.4.6 | Dépendance installée, utilisée seulement par `ui/sonner.tsx` sans fournisseur monté (lisait toujours « system ») |
| Marque Stock Master | `--brand-navy`, `--brand-orange` ; pages publiques en couleurs fixes (`bg-white`, `#3d4e66`, `#26364d`, `#f5f8fc`, `#eef3f9`) |
| Couleur du commerce | `lib/tenant-brand.ts` : calcul unique, validé `#rrggbb`, variables `--tenant-*` posées sur `[data-tenant-shell]` ; variantes calculées pour fond **blanc uniquement** |
| Composants communs | `PublicHeader` (pages d'aide et juridiques via `DocumentPage`), `LandingHeader`, en-tête du shell `/app` (+ écran de blocage), en-tête de `/access` ; parcours `/auth/*` sans en-tête |
| Graphiques | Barres en `div` sur `--tenant-accent` (Recharts non utilisé) |
| Sécurité | Aucune Content-Security-Policy (ni en-tête dans `next.config.ts`, ni proxy) |
| Service worker | Assets `/_next/static/*` mis en cache à la volée (noms hachés), navigations publiques en réseau d'abord ; outbox en IndexedDB |
| Impression | Aucun `window.print` ; exports Excel/PDF générés côté API |

## 3. Choix techniques

- **Pas de nouvelle dépendance.** `next-themes` n'est pas retenu : sa
  version 0.4.6 rend son script depuis un composant client, ce que React 19
  signale par une erreur console (« Encountered a script tag… »). À la place :
  - `web/src/lib/theme.ts` : préférence (`light` | `dark` | `system`), lecture
    et écriture protégées (`try/catch`, repli en mémoire), résolution, et
    application impérative sur `<html>` (classe `dark` + `color-scheme`) ;
    script inline statique `THEME_INIT_SCRIPT`.
  - `app/layout.tsx` : ce script dans `<head>`, exécuté avant le premier
    rendu. `<html>` portait déjà `suppressHydrationWarning`.
  - `components/theme/use-theme.ts` : `useThemePreference()`
    (`useSyncExternalStore`, instantané serveur « system ») et `ThemeSync`
    (suit `prefers-color-scheme` et l'évènement `storage` des autres onglets).
    Le thème n'est **jamais** appliqué depuis un rendu React. Rien n'est
    remonté et aucune requête n'est envoyée.
  - `components/theme/theme-toggle.tsx` : bouton soleil/lune + `Menu` de
    `@base-ui/react` (déjà installé). L'icône suit le thème par CSS
    (`dark:`), donc le HTML est identique au rendu serveur.
  - `ui/sonner.tsx` lit désormais `useThemePreference().resolved`.
  `next-themes` reste dans `package.json`, sans usage. Le retirer modifierait
  le lockfile : nettoyage possible dans un lot ultérieur.
- **Stockage** : clé unique `stockmaster.theme` (`light` ou `dark`, absente
  en mode Automatique), sans donnée métier. Ajoutée au tableau de
  `/cookies`, page sans archive ni acceptation.
- **CSP** : aucune politique existante. Le script inline est une chaîne
  constante, sans donnée dynamique. Si une CSP est introduite plus tard, il
  faudra un nonce ou un hash pour ce script.
- **Impression** : la variante `dark:` et les jetons `.dark` sont limités à
  `@media screen`. L'impression reste en thème clair quel que soit le choix.

## 4. Contrôle commun

Icône soleil/lune, nom accessible « Thème d'affichage : <choix> »,
info-bulle « Thème d'affichage ». Le menu propose « Clair », « Sombre » et
« Automatique » (`menuitemradio`, `aria-checked`, coche visible). Au
clavier : Entrée ou Espace ouvre, flèches, Entrée choisit, Échap ferme, et le
focus revient au bouton.

| Route(s) | Composant commun | Emplacement |
|---|---|---|
| `/` | `LandingHeader` | avant « Se connecter » (bureau) ; à côté du bouton menu (< 1024 px), panneau inchangé |
| `/guide`, `/contact`, `/cookies`, `/conditions-utilisation`, `/conditions-abonnement`, `/confidentialite`, `/mentions-legales`, `/traitement-donnees` | `DocumentPage` → `PublicHeader` | fin de l'en-tête |
| `/auth/login`, `/auth/register`, `/auth/forgot-password`, `/auth/reset-password`, `/auth/verify-email`, `/auth/invitations/accept` | **nouveau** `app/auth/layout.tsx` | coin haut droit (layouts enfants inchangés) |
| `/access` | en-tête de la page | à droite |
| `/app/**` (toutes les pages métier et Organisation) | en-tête du shell `app/app/layout.tsx` | avant la cloche ; **la cloche reste immédiatement avant le prénom** |
| Écran de blocage commercial | en-tête du même shell | après l'indicateur de connexion |
| `/offline` | page | coin haut droit |
| Pages introuvables | **nouveau** `app/not-found.tsx` (`PublicHeader`) | fin de l'en-tête |
| `/analytics`, `/sales`, `/corbeille`, `/products/[id]`, `/objects/[id]`, `/sections/[id]` | redirections serveur vers `/app/**` | — |

La barre de navigation mobile du bas n'est pas modifiée.

## 5. Couleurs

- **Pages publiques** (identité Stock Master conservée) : nouveaux jetons
  `--brand-ink` (textes et filets), `--brand-solid` (fonds pleins sous texte
  blanc) et `--public-bg/-surface/-surface-2/-body/-muted`, déclinés en
  sombre (fond navy profond `#071a33`). Les bandeaux héro et CTA gardent
  `--brand-navy`. Le texte navy sur bouton orange reste fixe (4,85:1 dans
  les deux thèmes). L'aperçu téléphone de l'accueil (capture de l'app) n'est
  pas modifié.
- **Logo** : sur une plaque blanche en sombre (`Wordmark`), sans inversion
  ni filtre. Les logos de commerce restaient déjà sur fond blanc
  (`TenantLogo`).
- **Couleur du commerce** (`tenant-brand.ts`) : `computeTenantAccent` renvoie
  la variante claire (champs existants) et `dark`. `tenantAccentStyle` pose
  `--tenant-light-*` et `--tenant-dark-*` ; `globals.css` associe
  `--tenant-accent*` à l'une ou l'autre selon le thème, sans recalcul ni
  rendu. La couleur enregistrée (`brand`) n'est jamais modifiée et rien n'est
  réécrit en base. Garanties testées sur 19 couleurs extrêmes :
  - texte sur bouton ≥ 4,5:1 (navy ou blanc) dans les deux thèmes ;
  - bouton et barre de graphique ≥ 3:1 contre le fond : blanc en clair ;
    `#171717` et `#0a0a0a` en sombre ;
  - texte accentué ≥ 4,5:1 sur toutes les surfaces (`muted` et fond léger
    compris) ; focus ≥ 3:1 ; filets ≥ 1,5:1 (décoratifs).
  - **Changement visible en clair** : les couleurs très claires (blanc, jaune
    pâle…) sont désormais assombries jusqu'à 3:1 contre le blanc (exemple :
    `#ffeb3b` → `#80761e`). Le navy par défaut est inchangé.
- **Couleurs fixes corrigées** : `text-green-600` (≈ 3,3:1 sur blanc, sous
  AA) → `green-700` / `dark:green-400` (fiche produit, carte produit) ;
  `text-red-600` + `dark:text-red-400` ; survol `amber-100` du bloc « Ventes
  en attente » (illisible en sombre) ; icônes ambre et émeraude ; bordure
  des initiales ; voile des dialogues renforcé en sombre. Les états restent
  portés par un texte ou une icône (« Rentable », « À perte », badge
  « non lue » en lecture d'écran…), jamais par la seule couleur.
- La pastille de l'écran Marque affiche volontairement la couleur brute
  enregistrée (avec bordure).

## 6. Fonctions préservées

Aucune modification des permissions, calculs, API métier, archives
juridiques, versions ou empreintes des conditions. Service worker inchangé :
les nouveaux styles arrivent par des fichiers `/_next/static/*` hachés, et
l'outbox (IndexedDB) n'est pas touchée. Exports Excel/PDF côté API ;
impression forcée en clair. Aucune traduction (réservée au lot 1-16G).

## 7. Validation

Uniquement sur la recette isolée (`recipe.js start --provider=simulated`,
MongoDB éphémère, comptes fictifs), sans `.env` réel ni base réelle.

| Contrôle | Résultat |
|---|---|
| `tsc --noEmit` (web) | OK |
| `eslint` (web, complet, sans `--fix`) | OK, 0 avertissement |
| `node scripts/test-tenant-brand.mjs` (**nouveau**, `pnpm --filter web test:tenant-brand`) | 41/41 |
| `node scripts/test-refresh-coordinator.mjs` | 6/6 |
| `recipe.js isolated web-build` | `exit 0`, 0 `.env` dans la copie, archives juridiques vérifiées (CGU 0.3, conditions d'abonnement 0.4, confidentialité 0.3 : aucun écart), copie supprimée |
| `git diff --check` | OK |
| Campagne navigateur 1-16F (Playwright 1.62.1 hors dépôt, Chromium 1234) | **80/80** |

Détail de la campagne navigateur :

- **P1** : préférence système sombre puis claire appliquée **avant
  hydratation**, avec tout le JavaScript applicatif bloqué : pas de flash.
- **P2** : Automatique suit un changement du système en direct.
- **P3** : choix Sombre sans rechargement, une seule clé de stockage,
  conservé au rechargement (JS bloqué) et après navigation ; retour
  Automatique (clé effacée).
- **P4** : synchronisation vers un autre onglet, dans les deux sens.
- **P5** : accès à la clé du thème refusés : thème système, puis choix tenu
  en mémoire, sans erreur.
- **P6** : nom accessible et choix actif, parcours clavier complet, focus
  rendu au bouton (Entrée et Échap).
- En-tête `/app` à 390 et 1440 px : ordre thème → cloche → prénom.
- **Formulaire Assistance commencé** (390 et 1440 px) : texte conservé après
  deux changements de thème, même document, **0 nouvelle connexion socket,
  0 requête API** (ni échange de session ni synchronisation).
- **Vente hors connexion en attente** : outbox inchangée (même
  `clientOperationId`, `pending`). Fenêtre témoin de 6 s sans changement :
  1 tentative programmée. Fenêtre de 6 s avec trois changements de thème :
  0 tentative (prochaine échéance programmée de l'outbox à +10 à 14 s).
- **Couleurs extrêmes** : jaune `#ffeb3b` (clair → `#80761e`, sombre
  inchangé), noir `#000000` (sombre → `#666666`), magenta `#ff00ff` modifié
  en direct par le propriétaire (sombre `#ff1aff`, clair `#cc00cc`).
  Variables calculées par le module réel et comparées.
- **Changement d'organisation** : un utilisateur membre de deux commerces se
  reconnecte sur le second, et les couleurs de ce commerce s'appliquent
  immédiatement.
- **Impression** avec Sombre choisi : fond blanc, accent de la variante
  claire.
- **Écran de blocage** (abonnement expiré pendant une session ouverte, 390
  et 1440 px, deux thèmes) : contrôle présent et fonctionnel.
- **Contraste du texte** (audit automatique de tout texte visible, fond
  composé réel, seuils 4,5:1 et 3:1 pour le grand texte) : accueil,
  connexion, CGU, 404, accueil `/app`, Analyse, dialogue, Assistance,
  `/access`, blocage, en 390 et 1440 px et dans les deux thèmes. **0 texte
  sous le seuil** ; minimum 4,53:1 en clair, 4,85:1 en sombre.
- Aucune erreur d'hydratation. Les autres erreurs console sont toutes
  provoquées par les tests : JS bloqué (P1/P3), page 404 testée, vente
  coupée, 403 d'abonnement expiré, image fictive `e2e.local`.

Non relancés (comportement inchangé) : suites API, campagnes paiement,
inscription, temps réel RT1–RT33 et push.

Captures (`phase-1-16f-captures/`) : `accueil-390-clair`,
`accueil-1440-sombre`, `connexion-390-sombre`, `cgu-1440-sombre-haut`,
`404-390-sombre`, `menu-theme-clavier-1440-clair`,
`app-accueil-jaune-390-clair`, `app-accueil-jaune-390-sombre`,
`analyse-jaune-1440-clair`, `analyse-jaune-1440-sombre`,
`dialogue-390-sombre`, `assistance-formulaire-1440-sombre`,
`vente-en-attente-1440-sombre`, `app-accueil-noir-1440-sombre`,
`access-390-sombre`, `blocage-390-sombre`, `blocage-1440-clair`.

## 8. Limites

1. **Stockage entièrement bloqué** : le thème reste fonctionnel, mais
   l'application ne démarre pas, car `lib/auth.ts` lit le jeton de session
   dans `localStorage` sans protection. Comportement antérieur au lot,
   hors périmètre (session).
2. **Audit de contraste** : automatique, limité au texte sur fond uni. Les
   textes sur image ou dégradé, les états de survol et les placeholders sont
   vérifiés visuellement sur les captures, pas mesurés.
3. **Graphiques** : les barres d'Analyse utilisent `--tenant-accent` (≥ 3:1
   garanti). Les couleurs d'état (rouge, ambre, vert) des cartes « À
   surveiller » du lot E avaient déjà leurs variantes `dark:` et n'ont pas
   été modifiées.
4. **Couleur du navigateur** (`theme-color` / manifeste) : navy
   `#062B5C`, inchangé, adapté aux deux thèmes.
5. **Pages d'erreur** : seule la page introuvable est ajoutée. Aucune
   frontière d'erreur globale (`error.tsx` / `global-error.tsx`) n'existait,
   et aucune n'est ajoutée dans ce lot.
6. **Écrans non capturés** une à une (inscription, invitation, mot de passe,
   confirmation d'e-mail, pages Organisation) : même layout et mêmes jetons
   que les écrans testés.

## 9. Fichiers

Nouveaux : `web/src/lib/theme.ts`, `web/src/components/theme/use-theme.ts`,
`web/src/components/theme/theme-toggle.tsx`, `web/src/app/auth/layout.tsx`,
`web/src/app/not-found.tsx`, `web/scripts/test-tenant-brand.mjs`, ce
document et `phase-1-16f-captures/`.

Modifiés : `web/package.json` (script `test:tenant-brand`),
`web/src/app/globals.css`, `web/src/app/layout.tsx`,
`web/src/app/app/layout.tsx`, `web/src/lib/tenant-brand.ts`,
`web/src/components/ui/sonner.tsx`, `ui/dialog.tsx`, `ui/alert-dialog.tsx`,
`public/public-header.tsx`, `public/public-footer.tsx`,
`landing/landing-header.tsx`, `landing/session-cta.tsx`,
`legal/document-page.tsx`, `subscription/subscription-offers.tsx`,
`brand/wordmark.tsx`, `brand/tenant-logo.tsx`, `products/product-card.tsx`,
`app/page.tsx`, `app/access/page.tsx`, `app/offline/page.tsx`,
`app/cookies/page.tsx`, `app/app/page.tsx`,
`app/app/catalog/products/[id]/page.tsx`,
`app/app/organization/members/page.tsx`,
`app/app/organization/support/page.tsx`.
