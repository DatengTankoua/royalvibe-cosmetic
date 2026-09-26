# Phase 1-10A — Landing page publique Stock Master

**Branche** `architecture/phase-1-10a-public-landing` · **Base** `11db991` (1-9D) — aucun commit, aucun push, aucun accès Atlas/Supabase/27017, aucun package ajouté, aucun fichier `api/` modifié.

## 1. Fichiers touchés

| Fichier | Nature |
|---|---|
| `web/src/app/page.tsx` | Remplacé : ancienne redirection serveur (`redirect("/app/catalog")`) → landing publique complète + `metadata` propre à la route |
| `web/src/components/landing/session-cta.tsx` | Nouveau : bouton(s) d'action sensibles à la session, isolé en client component |

Aucun autre fichier modifié : `web/src/app/layout.tsx` et `web/src/app/manifest.ts` (métadonnées globales, couleurs, absence d'icône) restent inchangés — déjà cohérents avec la marque (voir §4). Toutes les anciennes pages métier (`/sections/[id]`, `/products/[id]`, `/sales`, `/analytics`, `/corbeille`, `/objects/[id]`) restent les redirections serveur créées en 1-9D, non touchées.

## 2. Structure de la landing (`web/src/app/page.tsx`)

Server Component (pas de `"use client"` au niveau page) — seul `SessionCta` est un client component isolé, qui lit `useAuth()` (état déjà en mémoire via `AuthProvider`, aucun appel réseau). Sections, dans l'ordre demandé :

1. **Header** (sticky) : `Wordmark`, lien ancre `#fonctionnalites`, `SessionCta variant="header"`.
2. **Hero** : titre (gestion stocks/ventes pour PME) + sous-texte + `SessionCta variant="hero"`.
3. **Bénéfices** : 4 cartes — Simple / Rapide / Efficace / Sécurisé (icônes `lucide-react` déjà installées : `CheckCircle2Icon`, `ZapIcon`, `TrendingUpIcon`, `ShieldCheckIcon`).
4. **Fonctionnalités** (`id="fonctionnalites"`) : 7 cartes, une par capacité réellement livrée (voir §3).
5. **En 3 étapes** : créer l'entreprise → ajouter les produits → suivre ventes/performances (cercles numérotés CSS, navy + anneau orange, aucune image).
6. **CTA final** : `SessionCta variant="final"`.
7. **Footer minimal** : `Wordmark` + liens Connexion/Inscription.

`SessionCta` (client, un seul composant réutilisé 3 fois) :
- **En cours de résolution** (`isLoading === true`) : état neutre non interactif — bouton désactivé « Chargement… », hauteur stable (`h-11`), conteneur `aria-busy="true"`. Jamais traité comme « non connecté » : ni Connexion/Inscription, ni « Ouvrir l'application » ne sont rendus tant que la session n'est pas résolue.
- **Résolue, `user === null`** : boutons **Connexion** (`/auth/login`) + **Inscription** (`/auth/register`).
- **Résolue, `user` présent** : bouton unique **« Ouvrir l'application »** vers `/app` — jamais de redirection automatique, la landing reste consultable et navigable même connecté.
- Aucun token, JWT ou donnée organisationnelle affiché ou logué ; `useAuth()` ne fait que relire l'état déjà chargé par `AuthProvider` (pas de nouvel appel API déclenché par la landing).

## 3. Contenu réel vs non annoncé

Fonctionnalités listées (7), toutes vérifiées comme livrées dans le shell `/app/*` (1-9A→1-9D) : catalogue & stock, ventes, analytics, corbeille, convertisseur EUR–FCFA, multi-organisation, membres et permissions.

**Explicitement non promis** (respecté par omission volontaire, commenté dans le code) : paiement intégré, application mobile native, fonctionnement hors ligne, emails automatiques, toute fonctionnalité non livrée. Aucun chiffre, client, témoignage, certification ou logo inventé — seul le `Wordmark` existant (composant `components/brand/wordmark.tsx`, inchangé) est utilisé, aucune image marketing.

## 4. Design / responsive

- Mobile-first : header en `flex-wrap` (jamais de débordement horizontal, retour à la ligne si nécessaire à 320px), grilles `grid-cols-2`→`sm:grid-cols-4` (bénéfices) et `grid-cols-1`→`sm:grid-cols-2`→`lg:grid-cols-3` (fonctionnalités), conteneur `max-w-6xl` centré.
- Boutons tactiles : tous les CTA (`Button` du design system) forcés en `h-11` (44px), taille minimale respectée partout (header, hero, final, footer).
- Contrastes : texte de marque en navy `#062B5C` sur fond blanc (~13:1, largement AA). L'orange `#FF6A00` n'est **jamais utilisé comme couleur de texte** (calcul de contraste orange/blanc ≈ 2.9:1, sous le seuil AA même pour texte large) — utilisé uniquement en accent décoratif : fond teinté à 15 % derrière le mot « simplifiée » (le texte reste navy dessus) et anneau (`ring`) décoratif autour des cercles d'étapes (navy + blanc, contraste ~13:1).
- Animation : une seule, `motion-safe:animate-in motion-safe:fade-in` sur le hero — désactivée automatiquement si `prefers-reduced-motion: reduce` (variante Tailwind `motion-safe:`), aucune autre animation ajoutée.
- Aucun asset externe/image ajouté ; icônes exclusivement `lucide-react` (déjà dépendance du projet) ; formes (cercles d'étapes) en CSS pur.

## 5. SEO et métadonnées

- `page.tsx` exporte son propre `metadata` (titre + description + OpenGraph texte uniquement, hérite le reste de `layout.tsx`) : titre honnête (« Stock Master — Gestion des stocks et des ventes pour PME »), description alignée sur les fonctionnalités réellement listées, aucune image OpenGraph inventée.
- `layout.tsx` (metadata globale) et `manifest.ts` (nom, short_name, couleurs `#062B5C`/blanc) déjà conformes depuis 1-9B/1-9D — non modifiés, aucune icône RoyalVibe réintroduite.

## 6. Recherches finales

- `RoyalVibe|royalvibe` (`web/src`, `web/public`) : seules les 2 occurrences déjà existantes et justifiées en 1-9B (commentaires dans `layout.tsx`/`manifest.ts` expliquant l'absence d'icône) — aucune nouvelle occurrence, `web/public` : 0 résultat.
- Anciens liens métier (`href="/sections`, `/products`, `/sales"`, `/analytics"`, `/corbeille"`) dans `web/src` : 0 résultat — la landing ne référence que `/app`, `/auth/login`, `/auth/register`, `#fonctionnalites`.
- Anciens logos/icônes : `next.svg`/`vercel.svg`/`globe.svg`/`window.svg`/`file.svg` sous `web/public` non référencés par aucun fichier (`web/src`) — code mort préexistant sans lien avec RoyalVibe ou cette phase, non touché (hors périmètre, comme `components/objects/*` en 1-9D).
- Claims non implémentés (`paiement`, `hors ligne`, `email automatique`, `application mobile`) : seule occurrence trouvée est le commentaire du code listant explicitement ce qui n'est **pas** promis — aucune fuite dans le contenu affiché.

## 7. Résultats

- `pnpm lint` (web) : 0 erreur, 0 warning.
- `pnpm build` (web, Next 16 Turbopack) : compilation + TypeScript réussis. Mêmes **23 routes** qu'en 1-9D (`/` passe de dynamique `redirect()` à **statique prérendue** ○, aucune route ajoutée/retirée) :
  `/`, `/_not-found`, `/analytics`, `/app`, `/app/analytics`, `/app/catalog`, `/app/catalog/[id]`, `/app/catalog/products/[id]`, `/app/organization`, `/app/organization/branding`, `/app/organization/invitations`, `/app/organization/members`, `/app/sales`, `/app/trash`, `/auth/invitations/accept`, `/auth/login`, `/auth/register`, `/corbeille`, `/manifest.webmanifest`, `/objects/[id]`, `/products/[id]`, `/sales`, `/sections/[id]`.
- `git diff --check` : propre (même avertissement CRLF/LF préexistant qu'en 1-9B/1-9C/1-9D, aucun conflit de fusion ni espace en fin de ligne).
- Revue responsive structurée (320/375/390px, 1024/1440px) : basée sur lecture du code/Tailwind (grilles, `flex-wrap`, `max-w-6xl`, boutons `h-11`) — pas de rendu observé dans un navigateur réel (même contrainte qu'en 1-9C/1-9D).
- Backend : **non modifié, non relancé** (aucun fichier `api/` touché).

## 8. Risques résiduels

- **Pas de test manuel en navigateur réel** (même limite que les phases précédentes) : validation responsive/contraste basée sur la lecture du code, pas observée.
- `web/public/{next,vercel,globe,window,file}.svg` restent des assets Next.js par défaut, non référencés, non liés à RoyalVibe — leur suppression n'a pas été demandée et sort du périmètre strict de cette phase.
- Le fond orange à 15 % derrière « simplifiée » est une nuance très claire calculée pour rester lisible (le texte reste navy) — à revalider visuellement en navigateur réel avant merge, comme tout choix de contraste basé sur un calcul plutôt qu'un rendu observé.

Aucun commit, aucun push — en attente de validation.
