# Phase 1-9D — Migration des pages métier dans le shell Stock Master

**Branche** `architecture/phase-1-9d-business-pages-shell` · **Base** `14dac28` (1-9C) — aucun commit, aucun push, aucun accès Atlas/Supabase/27017, aucun package ajouté, aucun fichier `api/` modifié.

## 1. Inventaire (avant migration)

Pages métier authentifiées réellement présentes (hors `/auth/*` et `/app/*` déjà en place) :

| Ancien chemin | Contenu | Liens internes | Appels API | `User.role` | Socket.IO |
|---|---|---|---|---|---|
| `/` | Catalogue racine (sections) | `/sections/:id` (via `SectionCard`) | `GET/POST/PATCH/DELETE /sections` | `user.role === "admin"` (créer/renommer/supprimer + prop `isAdmin`) | `useSections()` → `useSocket()` propre |
| `/sections/[id]` | Sous-catalogue + produits | `/sections/:id` (parent), `/sections/:id` (enfants), `/products/:id` | sections + produits | `user.role === "admin"` (sous-section + produit, créer/éditer/supprimer) | `useProducts()` → `useSocket()` propre |
| `/products/[id]` | Fiche produit (métriques, ventes, audit) | retour navigateur uniquement | `GET /products/:id`, ventes via `RecordSaleDialog`/`EditSaleDialog` | `user.role === "admin"` (bouton éditer une vente) | aucun |
| `/sales` | Liste des ventes | aucun | `GET /sales` | aucun | aucun |
| `/analytics` | KPIs, classements, tendance mensuelle | `/products/:id` (modal épuisés) | `GET /analytics/*`, `GET /products` | aucun | aucun |
| `/corbeille` | Corbeille sections + produits | `/sections/:id`, `/products/:id` | `GET /trash`, restore/purge sections+produits | `user.role !== "admin"` → redirection | aucun |
| `/objects/[id]` | Alias legacy (redirection pure) | → `/products/:id` | aucun | aucun | aucun |

**Navbar historique** (`components/layout/navbar.tsx`, montée par `app/layout.tsx` sur toutes les routes hors `/auth/*`/`/app/*`) : liens Catalogue/Analytics/Ventes/Corbeille (admin) + dialogue convertisseur EUR↔CFA, gating `user?.role === "admin"`.

**Constat "autres pages"** : `/objects` (liste) n'a **aucune page** — seul l'alias `[id]` existe. `components/objects/*` (`object-card`, `create-object-dialog`, `delete-object-button`) et `hooks/use-objects.ts` ne sont importés par **aucune route** (code mort préexistant, non lié à cette migration). Aucun blocage contractuel trouvé : toutes les pages listées ci-dessus étaient migrables sans casser un contrat backend (aucune route backend n'a dû changer).

## 2. Mapping exact ancien chemin → nouveau chemin

| Ancien | Nouveau (implémentation) | Ancien devient |
|---|---|---|
| `/` | `/app/catalog` | redirection serveur (`redirect()`) |
| `/sections/[id]` | `/app/catalog/[id]` | redirection serveur |
| `/products/[id]` | `/app/catalog/products/[id]` | redirection serveur |
| `/sales` | `/app/sales` | redirection serveur |
| `/analytics` | `/app/analytics` | redirection serveur |
| `/corbeille` | `/app/trash` | redirection serveur |
| `/objects/[id]` | *(alias legacy, inchangé)* | redirige directement vers `/app/catalog/products/:id` (plus de double-saut via `/products/:id`) |

Chaque ancien chemin est désormais un Server Component minimal appelant `redirect()` (Next 16, `params` asynchrones sur les segments dynamiques) — sans dépendre du JWT (stocké en `localStorage`, invisible côté serveur) : la garde d'authentification reste exclusivement dans `app/app/layout.tsx`, qui s'exécute après la redirection. Aucune boucle possible (chaque alias pointe vers une route `/app/*` distincte, jamais vers lui-même). `/` est donc libéré pour une future landing page publique — non créée ici.

**Une seule implémentation par page** : tout le code métier (JSX, hooks, dialogues) a été déplacé tel quel sous `/app/*` ; les anciens fichiers ne contiennent plus aucune logique dupliquée.

## 3. Matrice permission → UI/requête

| Domaine | Action | Permission (backend, vérifiée dans les contrôleurs) | UI |
|---|---|---|---|
| Nav | Accueil, Catalogue, Organisation | aucune | toujours visibles |
| Nav | Ventes | `sales.view_own` OU `sales.view_all` OU `sales.record` | lien visible ; liste chargée seulement si `view_own`/`view_all` |
| Nav | Analyse | `analytics.read` | lien visible + gate d'affichage/fetch |
| Nav | Corbeille | `trash.manage` | lien visible + gate d'affichage/fetch |
| Sections | créer/renommer/soft-delete | `catalog.manage` | `CreateSectionDialog` + boutons `SectionCard` (`canManage`) |
| Sections | restore/purge | `trash.manage` | page `/app/trash` uniquement |
| Produits | créer/soft-delete | `products.manage` | `CreateProductDialog` + bouton supprimer `ProductCard` (`canDelete`) |
| Produits | modifier — champ `name` | `products.manage` (`canManageDescription`) | `UpdateProductDialog` : groupe « Nom » affiché seulement si accordé, jamais envoyé sinon |
| Produits | modifier — champs `purchasePrice`/`salePrice`/`additionalStock` | `stock.adjust` (`canAdjustStock`) | `UpdateProductDialog` : groupe « Prix/Stock » affiché seulement si accordé, jamais envoyé sinon |
| Produits | modifier — remplacer l'image | `products.manage` requis (vérifié dans `products.controller.ts::update`) | non implémenté dans `UpdateProductDialog` (aucun champ image dans ce formulaire) — rien à gater tant que cette capacité n'existe pas |
| Produits | bouton « Modifier » `ProductCard` | `products.manage` OU `stock.adjust` (au moins un champ éditable) | `canEdit = canManageDescription \|\| canAdjustStock` ; si aucune des deux, bouton absent et dialogue jamais ouvert |
| Produits | restore/purge | `trash.manage` | page `/app/trash` uniquement |
| Produits | historique ventes/audit affiché | scope calculé serveur (`sales.view_all`/`view_own`/`audit.read`) | aucun filtrage client — le serveur renvoie déjà le sous-ensemble autorisé |
| Ventes | enregistrer | `sales.record` | `RecordSaleDialog` affiché seulement si accordé |
| Ventes | modifier/supprimer une vente | `sales.record` ET (`sales.view_all` OU vente propre à l'acteur) | crayon d'édition sur la fiche produit |
| Ventes | liste (`/app/sales`) | `sales.view_all` OU `sales.view_own` | aucun `GET /sales` déclenché sinon (message dédié si `sales.record` seul) |
| Analytics | toutes les routes | `analytics.read` | aucun appel déclenché sans la permission (message dédié) |
| Trash | liste + actions | `trash.manage` | `useTrash(enabled)` n'appelle `GET /trash` que si `enabled` |

Toutes ces règles ont été vérifiées directement dans `products.controller.ts`, `sections.controller.ts`, `sales.controller.ts`, `analytics.controller.ts`, `trash.controller.ts` (aucune supposition). Le masquage frontend reste une aide UX ; chaque route backend garde sa propre autorité (`@RequirePermissions`/vérifications manuelles inchangées, aucun fichier `api/` modifié).

## 4. Suppression de `User.role` côté métier

Recherche exhaustive (`user\.role`, `User\.role`, `ApiUser\.role`, `isAdmin`) sur `web/src` : plus aucune décision d'UI métier basée sur le rôle legacy. Remplacements :
- `SectionCard`/`ProductCard` : prop `isAdmin` → `canManage` / (`canEdit`, `canDelete`) dérivées de `authContext.effectivePermissions` via le nouveau helper `hasPermission()` (`lib/organization-permissions.ts`).
- Toutes les pages sous `/app/*` consomment `useOrganizationShell().authContext` (jamais `useAuth().user.role`, jamais de décodage JWT).
- Seule occurrence restante de `.role` : `contexts/auth-context.tsx` (`role: result.user.role`) — stockage du champ legacy renvoyé par `/auth/me`/login (contrat backend inchangé), **plus jamais lu** pour une décision d'autorisation métier.

## 5. Navigation responsive

Source unique (`visibleNavItems(authContext)` dans `app/app/layout.tsx`), filtrée par permission, partagée entre :
- **Rangée desktop** (`hidden md:block`, sous le header, `overflow-x-auto`) : tous les items visibles, testé conceptuellement à 1024/1440px (aucun retour à la ligne cassant grâce à l'overflow horizontal).
- **Barre mobile fixe** (`md:hidden`, `pb-[env(safe-area-inset-bottom)]`) : jusqu'à **6 destinations possibles** (Accueil/Catalogue/Ventes/Analyse/Corbeille/Organisation selon permissions). Au-delà de 4 destinations visibles, les 4 premières restent directes et un bouton **« Plus »** (`Dialog` existant, aucun nouveau composant) regroupe le reste + convertisseur EUR↔CFA + déconnexion — jamais plus de 5 icônes dans la barre fixe, jamais « six boutons écrasés ». Avec ≤4 destinations, la barre affiche directement les liens + « Quitter » (comportement identique à 1-9C).
- Le convertisseur EUR↔CFA (`CurrencyConverter`, réutilisé tel quel) est accessible depuis le header desktop (icône dédiée) et depuis le menu « Plus » mobile — fonctionnalité de l'ancienne navbar migrée sans duplication (le composant `CreateProductDialog` avait déjà son propre déclencheur, inchangé).
- Un seul shell/navbar actif à la fois : l'ancienne `components/layout/navbar.tsx` est supprimée (plus aucune route ne peut l'afficher : les anciennes pages métier sont désormais de simples redirections serveur, jamais rendues côté client).
- Tables (classement produits analytics) : `overflow-x-auto` déjà en place, inchangé. Dialogues/formulaires réutilisés tels quels (déjà contraints en largeur via `DialogContent`). États loading/vide/erreur préservés sur chaque page migrée.

## 6. Socket.IO et changement d'organisation

- La connexion Socket.IO est désormais **ouverte une seule fois** par `SocketProvider` (nouveau `contexts/socket-context.tsx`), monté dans `AppShellLayout` — donc partagée par toutes les pages sous `/app/*` et **stable à travers la navigation** entre elles (le layout ne se démonte pas lors d'un changement de page interne, contrairement à l'ancien design où chaque hook (`useSections`/`useProducts`) ouvrait sa propre connexion `io()` à chaque montage).
- `hooks/use-socket.ts` (connexion par hook) est supprimé ; `useSections`/`useProducts`/`useObjects` consomment désormais `useSocket()` depuis `contexts/socket-context.tsx` (même nom, même signature, import déplacé uniquement).
- Changement d'organisation (`handleSwitch` dans `AppShellLayout`, inchangé) : `window.location.assign("/app")` — **rechargement complet du navigateur**, qui démonte tout l'arbre React (y compris `SocketProvider` et toutes les pages métier) et recrée une connexion socket neuve avec le nouveau JWT. Aucune donnée de l'ancienne organisation ne peut donc subsister : ce n'est pas un ajout de cette phase, mais un comportement déjà garanti structurellement par 1-9B, vérifié à nouveau ici.
- Aucun `organizationId` construit côté client dans les pages migrées : tous les appels (`fetchSections`, `fetchProducts`, `fetchSales`, `fetchTrash`, endpoints analytics) restent inchangés et dépendent uniquement du JWT/contexte serveur.

## 7. Recherches finales

- `User\.role|ApiUser\.role|user\.role|isAdmin` (regex, `web/src`) : plus aucune occurrence de décision d'UI ; seules des mentions en commentaire et l'assignation legacy dans `auth-context.tsx` (voir §4).
- Anciens chemins métier (`/sections/`, `/products/`, `/sales`, `/analytics`, `/corbeille`) : toutes les occurrences restantes dans `web/src` sont soit des appels **API backend** (`lib/api.ts`, inchangés à raison — ce sont des routes REST, pas des routes Next), soit les cibles des redirections des alias legacy eux-mêmes. Un lien oublié a été trouvé et corrigé : `components/ui/duplicate-warning-dialog.tsx` (redirection après doublon détecté) pointait vers `/sections/:id`/`/products/:id`/`/corbeille` → mis à jour vers `/app/catalog/:id`, `/app/catalog/products/:id`, `/app/trash`.
- `RoyalVibe` : 2 occurrences, toutes deux des commentaires déjà neutres hérités de 1-9B (`app/layout.tsx`, `app/manifest.ts`) expliquant l'absence d'icône — aucune fuite de marque, non modifiées.
- Import morts nettoyés : `components/layout/navbar.tsx` et `hooks/use-socket.ts` supprimés (plus aucune référence).
- `components/objects/*` et `hooks/use-objects.ts` : confirmés non importés par aucune route avant **et** après cette migration (code mort préexistant, hors périmètre de suppression — non demandé, non touché) ; seul le lien obsolète dans `object-card.tsx` a été mis à jour par cohérence (§ nettoyage).

## 8. Résultats

- `pnpm lint` (web) : 0 erreur, 0 warning.
- `pnpm build` (web, Next 16 Turbopack) : compilation + vérification TypeScript réussies. Le compteur `(19/19)` affiché pendant le build est le nombre de pages **statiques** générées, pas le nombre total de routes — le tableau « Route (app) » final liste réellement **23 routes** (18 statiques ○ + 5 dynamiques ƒ : `/app/catalog/[id]`, `/app/catalog/products/[id]`, `/objects/[id]`, `/products/[id]`, `/sections/[id]`) :
  `/`, `/_not-found`, `/analytics`, `/app`, `/app/analytics`, `/app/catalog`, `/app/catalog/[id]`, `/app/catalog/products/[id]`, `/app/organization`, `/app/organization/branding`, `/app/organization/invitations`, `/app/organization/members`, `/app/sales`, `/app/trash`, `/auth/invitations/accept`, `/auth/login`, `/auth/register`, `/corbeille`, `/manifest.webmanifest`, `/objects/[id]`, `/products/[id]`, `/sales`, `/sections/[id]`.
- `git diff --check` : propre (uniquement des avertissements CRLF/LF, comme en 1-9B/1-9C).
- Backend : **non modifié, non relancé** (aucun fichier `api/` touché — vérifié par `git status`).
- Revue structurée mobile (320/375/390px) et desktop (1024/1440px) : basée sur la lecture du code et des classes Tailwind (mêmes contraintes qu'en 1-9C — pas de lancement de `next dev` contre une base réelle), pas de rendu observé dans un navigateur.

## 9. Risques résiduels

- **Pas de test manuel en navigateur réel** (même contrainte qu'en 1-9C) : la validation responsive s'appuie sur la revue du code/Tailwind, pas sur un rendu observé. Recommandation : validation visuelle rapide avant merge, en particulier la bascule 4 items + « Plus » sur mobile.
- Léger effet de bord au premier chargement : tant que `authContext` n'est pas résolu, la barre mobile affiche la composition minimale (Accueil/Catalogue/Organisation + « Quitter ») puis peut basculer vers « Plus » une fois les permissions connues — flash bref, cohérent avec les autres écrans qui affichent déjà un état « Chargement… » pendant ce court intervalle, non corrigé (jugé mineur).
- `components/objects/*` et `hooks/use-objects.ts` restent du code mort préexistant (non lié à cette migration) ; leur suppression n'a pas été demandée et sortait du périmètre strict de cette phase.
- Le convertisseur EUR↔CFA n'est plus accessible en un clic direct sur mobile (il faut ouvrir « Plus ») — compromis assumé pour respecter la contrainte « pas plus de 5 icônes » de la barre fixe.
- `lib/organization-permissions.ts::hasPermission` duplique volontairement un helper déjà présent côté backend (`organizations/permissions.ts::hasPermission`) — même lecture manuelle requise que pour `DELEGABLE_PERMISSIONS` (voir 1-9C) : toute évolution du modèle de permissions doit être répercutée manuellement des deux côtés.

## 10. Correction ciblée — formulaire produit selon permissions dynamiques

Constat après revue (`ProductCard`, `UpdateProductDialog`, payload `PATCH /products/:id` réel) : le formulaire d'édition affichait/envoyait **toujours** les 4 champs (`name`, `purchasePrice`, `salePrice`, `additionalStock`) dès que l'utilisateur avait `products.manage` **OU** `stock.adjust`, sans distinguer les deux groupes — un acteur avec `stock.adjust` seul pouvait ainsi voir (et, si modifié, tenter d'envoyer) le champ `name`, bloqué uniquement par le 403 serveur (défense en profondeur suffisante côté sécurité, mais UX incorrecte et non conforme au contrat demandé).

**Correction** (`components/products/update-product-dialog.tsx`, seul appelant : `app/app/catalog/[id]/page.tsx`) :
- Deux nouvelles props obligatoires, transmises séparément par la page : `canManageDescription` (= `products.manage`) et `canAdjustStock` (= `stock.adjust`) — jamais `User.role`.
- Groupe « Nom » rendu **uniquement** si `canManageDescription` ; groupe « Prix d'achat/vente + stock » rendu **uniquement** si `canAdjustStock` — masquage complet (pas de champ désactivé résiduel), donc rien à envoyer par construction.
- Payload construit explicitement champ par champ, gaté par la permission **avant** tout diff de valeur (`if (canManageDescription && name !== product.name) payload.name = ...`) : un champ non autorisé n'entre jamais dans le JSON envoyé à `updateProduct()`, même si sa valeur locale est restée strictement identique à l'originale.
- Si le payload construit est vide (`Object.keys(payload).length === 0`) — aucune permission n'autorise de champ modifié, ou tout est resté identique — aucun appel réseau n'est déclenché ; message `toast.error("Aucune modification à enregistrer.")`.
- Si ni `canManageDescription` ni `canAdjustStock` : le formulaire est remplacé par un message « Tu n'as pas la permission de modifier ce produit. », sans bouton de soumission (défense en profondeur — le bouton « Modifier » de `ProductCard` était de toute façon déjà absent dans ce cas, `canEdit = canManageDescription || canAdjustStock`).
- Remplacement d'image : vérifié dans `products.controller.ts::update` (exige `products.manage`) — **non implémenté** dans `UpdateProductDialog` (aucun champ image dans ce formulaire, contrairement à `CreateProductDialog` qui en a un et reste gardé par `products.manage` à la création, inchangé) ; rien à borner tant que cette capacité n'existe pas côté édition. Idem pour `sectionId` (typé dans `updateProduct()` côté `lib/api.ts` mais jamais construit par aucun formulaire) — non ajouté ici, hors périmètre de cette correction ciblée.
- Aucun appelant supplémentaire trouvé (`grep` sur `UpdateProductDialog`) : seule la page `/app/catalog/[id]` instancie ce dialogue.

**Validation** : `pnpm lint` (web) 0 erreur/0 warning ; `pnpm build` (web) compile + typecheck OK, mêmes 23 routes qu'en §8 (aucune route ajoutée/retirée) ; `git diff --check` propre (mêmes avertissements CRLF/LF préexistants). Aucun fichier `api/` touché, aucun package ajouté, aucun commit/push.

Aucun commit, aucun push — en attente de validation.
