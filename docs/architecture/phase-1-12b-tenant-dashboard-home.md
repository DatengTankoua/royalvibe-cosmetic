# Phase 1-12B — Refonte de l'accueil connecté tenant

Branche `architecture/phase-1-12b-tenant-dashboard-home`, base `b1a84f8` (feat(web): add tenant-branded application shell).
Frontend uniquement : aucun fichier `api/`, DTO/schéma, service worker, page métier interne, landing, authentification, package ni lockfile modifié.

## Objectif

`/app` devient un accueil mobile-first aux couleurs du commerce : salutation, zone « ventes en attente » et accès rapides filtrés par permissions effectives, cohérents hors ligne. Aucune donnée, aucun chiffre, graphique ni fonctionnalité métier inventés.

La capture de référence mentionnée dans la demande n'était pas jointe. Le design suit la description écrite : cartes arrondies, bloc d'icône coloré, titre court, sous-texte, grille à deux colonnes sur mobile.

## Audit initial

| Point | Constat (base `b1a84f8`) |
| --- | --- |
| Contenu de `/app` | Carte 1-12A : grand logo ou initiales, nom du commerce (déjà dans l'en-tête), « Bienvenue, <prénom> », un seul bouton « Accéder au catalogue ». |
| Routes métier | `/app/catalog` (et sous-routes), `/app/sales`, `/app/sales/pending`, `/app/analytics`, `/app/trash`, `/app/organization/{branding,members,invitations,offline-data}`. `/app/organization` redirige vers `branding`. |
| Permissions réelles | Voir le tableau ci-dessous. |
| Convertisseur | `components/currency/currency-converter.tsx`, dialogue `open`/`onOpenChange`. Taux fixe `EUR_TO_XOF = 655.957`, **aucun appel réseau** : fonctionne hors ligne. Ouvert depuis l'en-tête desktop et le menu « Plus » mobile. |
| Données sans nouvel appel | `useOrganizationShell()` : `authContext` (permissions effectives), `organization`. `useOfflineSales()` : `offline`, `unfinalizedCount`. `usePendingSalesHref()` : cible en ligne ou hors ligne. `useAuth().user.name`. |
| Compteur « en attente » | `useOfflineSales().unfinalizedCount` (partition user/organisation courante). Ancre existante `PendingSalesAnchor`. |
| Hors ligne | `offline = !online \|\| (!authContext && offlineIdentity)`, même définition que le shell. Seule `/app/catalog` est servie par le service worker. Le shell rend les autres destinations non interactives (`ShellNavLink`, 1-11C.3a) et affiche un message unique. |
| Navigation | Desktop : barre d'onglets sous l'en-tête. Mobile : barre fixe en bas (`md:hidden`, `pb-[env(safe-area-inset-bottom)]`) et menu « Plus » au-delà de 4 entrées. `<main>` du shell en `pb-16` (`pb-24` hors ligne). La navigation du shell montre « Organisation » à tout membre (Branding en lecture, Hors connexion) ; inchangée ici. |

## Mapping final

Décisions prises **uniquement** sur `authContext.effectivePermissions` via `hasPermission`, dans la fonction pure `homeQuickActions()` (`web/src/lib/home-quick-actions.ts`). Jamais `User.role` / `ApiUser.role`. Sans contexte d'autorisation (chargement, refus), seules les cartes sans condition apparaissent (fail-closed).

| Carte | Route | Condition | Hors ligne (page déjà montée) |
| --- | --- | --- | --- |
| Catalogue (carte principale) | `/app/catalog` | Tout membre actif | **Active** : ancre HTML simple (document servi par le SW), jamais de navigation RSC |
| Ventes | `/app/sales` | `sales.view_all` \|\| `sales.view_own` \|\| `sales.record` (mêmes droits que la page et la navigation 1-9D) | Non interactive, « Indisponible hors connexion » |
| Analyse | `/app/analytics` | `analytics.read`, sinon non rendue | Non interactive |
| Corbeille | `/app/trash` | `trash.manage`, sinon non rendue | Non interactive |
| Organisation | 1er onglet administrable : `branding.manage` → `/branding`, sinon `members.manage` → `/members`, sinon `members.invite` → `/invitations` | Au moins une des trois, sinon **non rendue** (jamais un écran réservé en lecture seule ou refusé) | Non interactive |
| Convertisseur | Dialogue existant (bouton) | Tout membre actif | **Actif** : même composant, aucune logique dupliquée |
| Zone « N ventes en attente » | En ligne `/app/sales/pending`, hors ligne `/app/catalog#offline-sales-panel` | `unfinalizedCount > 0` | Panneau du catalogue, via `PendingSalesAnchor` |

Aucune opération réservée au propriétaire n'a de page dans l'interface : aucune carte « owner-only ».

**Sous-textes** :
- Ventes : « Toutes les ventes du commerce », « Vos ventes enregistrées » ou « Saisie depuis une fiche produit », selon les droits.
- Organisation : liste réelle des capacités (« Logo et couleur, membres, invitations »).
- Aucun chiffre.

**Résultat par rôle** (défauts backend : owner et admin ont toutes les permissions délégables ; seller a `sales.record` et `sales.view_own`) :
- owner / admin : 6 cartes ;
- vendeur par défaut : Catalogue, Ventes, Convertisseur ;
- vendeur avec `analytics.read` : + Analyse.

## Choix visuels et responsive

- **Salutation** : `h1` « Bonjour, <premier prénom> » (nom complet dans `title`), puis « Que souhaitez-vous faire aujourd'hui ? ». Bloc `--tenant-accent-soft`, bordure `--tenant-accent-border`, filet gauche `--tenant-accent`. Le nom du commerce n'est pas répété (il est dans l'en-tête).
- **Carte principale Catalogue** : fond `--tenant-accent`, texte `--tenant-accent-foreground` (≥ 4,5:1 garanti par 1-12A). Survol et appui : anneau `--tenant-accent-border`, jamais d'opacité sur le fond (le contraste calculé serait faussé).
- **Autres cartes** :
  - repos : fond `card`, bordure `--tenant-accent-border`, bloc d'icône 44 × 44 en `--tenant-accent` / `--tenant-accent-foreground` ;
  - survol et appui : fond `--tenant-accent-soft`, bordure `--tenant-accent` ;
  - focus clavier : `ring-2` `--tenant-accent-ring` avec décalage.
- **Carte indisponible** : `div` non focusable, bordure pointillée, icône grise, texte « Indisponible hors connexion » visible (lu tel quel par les lecteurs d'écran). Ni lien ni bouton.
- **Zone en attente** : ambre, comme la pastille existante de l'en-tête (sens « en attente »). `h2` masqué visuellement, cible de 56 px de haut.
- **Structure** :
  - `h1` ; `h2` « Ventes en attente » (`sr-only`, si présente) ; `h2` « Accès rapides » ;
  - cartes en `ul/li` ;
  - ordre de tabulation = ordre visuel.
- **Transitions** : `motion-safe:transition-colors` uniquement (respecte `prefers-reduced-motion`), aucune animation.
- Icônes Lucide déjà installées. Aucune image ajoutée.
- **Grille** :

  | Largeur | Colonnes | Catalogue |
  | --- | --- | --- |
  | < 360 px | 1 | pleine largeur |
  | ≥ 360 px (375/390, tablette) | 2 | pleine largeur |
  | ≥ 1024 px | 3 | 2 colonnes |

  Conteneur `max-w-4xl` (grille ≤ 848 px), cartes de 112 px de haut minimum, sous-texte limité à 2 lignes.
- **Barre mobile** : `pb-[max(1.5rem,env(safe-area-inset-bottom))]` en plus du `pb-16` du shell. La dernière carte reste au-dessus de la barre fixe.
- **Performance** : aucun appel API ajouté. `useMemo` sur le contexte d'autorisation. Le convertisseur de l'accueil est une seconde instance locale du même composant (état d'ouverture local), sans état global partagé.

## Fichiers

| Fichier | Changement |
| --- | --- |
| `web/src/app/app/page.tsx` | Accueil refait : salutation, zone en attente, accès rapides, convertisseur. |
| `web/src/components/dashboard/home-quick-actions.tsx` | **Nouveau** : grille et états des cartes (normal, principal, indisponible). |
| `web/src/lib/home-quick-actions.ts` | **Nouveau** : mapping pur carte → route → permission → disponibilité hors ligne. |
| `docs/architecture/phase-1-12b-tenant-dashboard-home.md` | Ce document. |

## Tests

**Mapping pur** (`node --experimental-strip-types`, scratchpad) : **24 assertions OK**.
- Rôles et délégations, dont chaque droit « Ventes » isolé.
- `catalog.manage`, `products.manage`, `stock.adjust` et `audit.read` : aucune carte ajoutée.
- Cibles Organisation.
- `role: owner` sans permission : aucune carte admin ; `role: seller` ignoré.
- Contexte absent : fail-closed.

**Tests réels** (Playwright temporaire hors dépôt, `next build` + `next start` :3100, API compilée sur `MongoMemoryReplSet` :4100). **18/18** sur les exécutions 4 et 5.

L'exécution 3 a donné 17/18 à cause d'une hypothèse erronée du test clavier. Au retour en ligne, la vente en attente avait déjà été synchronisée, donc la zone avait disparu : c'est le comportement attendu. Le test tient désormais compte de la présence réelle de la zone ; l'exécution 4 l'a couverte présente, la 5 absente.

1. **Owner** : 6 cartes. Balises et cibles exactes (Organisation → `/app/organization/branding`, Convertisseur = `BUTTON`). Nom du commerce absent du contenu. Aucun pourcentage, montant, « tendance » ni graphique.
2. **Admin** : 6 cartes (toutes les permissions délégables).
3. **Vendeur par défaut** : Catalogue, Ventes, Convertisseur. Aucun lien vers Analyse, Corbeille ou Organisation dans la page. Sous-texte « Vos ventes enregistrées ».
4. **Vendeur + `analytics.read`** : Analyse en plus, rien d'autre.
5. **Même utilisateur** : owner dans A → 6 cartes ; vendeur dans B → 3 cartes.
6. **Rôle legacy ignoré** : `users.role = admin` en base **et** `heyama_user.role = admin` en local, pour un vendeur : toujours 3 cartes.
7. **Couleurs** (contrastes mesurés sur les couleurs calculées du navigateur, converties via canvas) :

   | Couleur | Carte principale titre / sous-texte | Bloc d'icône | Carte titre / sous-texte | Salutation |
   | --- | --- | --- | --- | --- |
   | `#FFFDE7` | 13,57 / 13,57 | 13,57 | 19,80 / 4,74 | 19,77 |
   | `#0A0A0A` | 19,80 / 19,80 | 19,80 | 19,80 / 4,74 | 16,01 |
   | `#FF6A00` | 4,85 / 4,85 | 4,85 | 19,80 / 4,74 | 17,78 |

   Survol : fond calculé = `--tenant-accent-soft`.
8. **0 vente en attente** : zone absente.
9. **1 vente en attente** (API `/sales` en 503) : « 1 vente en attente », `href="/app/sales/pending"`, clic → page des ventes en attente.
10. **Coupure réseau après montage** (SW contrôleur) :
    - Catalogue = `<a href="/app/catalog">` ; Convertisseur actif (dialogue ouvert puis fermé) ;
    - Ventes, Analyse, Corbeille, Organisation = `DIV` sans lien ni bouton, `tabIndex -1`, texte « Indisponible hors connexion » ; un clic ne navigue pas ;
    - zone en attente → `/app/catalog#offline-sales-panel`, texte « Elles seront envoyées au retour de la connexion. » ;
    - message hors ligne du shell présent **une seule fois**, aucun terme technique ;
    - **zéro requête RSC**.
    - **10b** : clic sur la zone hors ligne → `/app/catalog#offline-sales-panel`, panneau affiché, zéro RSC.
11. **Retour en ligne** : 5 liens + 1 bouton, plus aucune carte indisponible, zone → `/app/sales/pending`, clic Analyse → `/app/analytics`.
12. **Clavier** :
    - ordre de tabulation (zone en attente si présente) → Catalogue → Ventes → Analyse → Corbeille → Organisation → Convertisseur ;
    - `:focus-visible` et anneau présents sur chaque élément ; Entrée ouvre le convertisseur ;
    - toutes les cibles ≥ 44 × 44 ;
    - titres `H1 Bonjour, Awa` / (`H2 Ventes en attente`) / `H2 Accès rapides`.
13. **Mobile** :
    - 320 px : 1 colonne (grille 288 px) ; 375 et 390 px : 2 colonnes ;
    - aucun débordement, aucun sous-texte ni titre coupé ;
    - dernière carte (bas à 652 px) au-dessus de la barre fixe (675 px).
14. **Tablette et desktop** : 768 px : 2 colonnes (720 px) ; 1 024 et 1 440 px : 3 colonnes, grille 848 px, carte la plus large 561 px (Catalogue sur 2 colonnes).
15. **Pages publiques** `/`, `/auth/login`, `/auth/register`, `/auth/invitations/accept`, `/offline` : logo Stock Master chargé, aucune carte ni jeton tenant.
16. **Régression** : logout (dialogue « conserver » si une vente reste) → login UI → sélection multi-organisation → `/app`. En-tête 1-12A : nom « Boutique A », « by Stock Master », accent `#ff6a00`, aucun « Changer d'organisation ». 6 cartes.

Aucune erreur de page sur l'ensemble des exécutions.

**Régression 1-11C.3** : navigation hors ligne ciblée 4/4. Les assertions 1-12A propres à l'ancien accueil (grand logo, bouton « Accéder au catalogue ») sont remplacées par ce design.

**Validation** : `eslint` (web) OK, `tsc --noEmit` OK, `next build` OK, `git diff --check` propre. Aucun fichier `api/`, aucun package ni lockfile.

## Limites

- **`/app` au F5 hors ligne** : non garanti (le service worker ne sert que `/app/catalog`). `sw.js` n'est pas modifié. Seul le scénario « page montée puis coupure » est traité et testé.
- **Chargement** : pendant le chargement du contexte d'autorisation, seules les cartes Catalogue et Convertisseur s'affichent ; les autres apparaissent à la réponse de `/auth/context`, sans squelette.
- **Navigation du shell** : elle affiche toujours « Organisation » à tout membre (Branding en lecture, Hors connexion). Seule la carte d'accueil applique la règle « capacité administrable ». Ce lien n'a pas été modifié : hors périmètre.
- **Hors ligne** : la carte Ventes est désactivée, mais la saisie reste possible depuis le catalogue (fiche produit), comme en 1-11C.3.
- **Référence visuelle** : la capture annoncée n'a pas été reçue ; le rendu suit la description écrite.
