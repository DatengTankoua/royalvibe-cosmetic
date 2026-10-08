# Phase 1-9A — Frontend Stock Master : inscription, connexion et invitation

**Branche** `architecture/phase-1-9a-frontend-auth` · **Base** `3aa5176` (1-8A) — aucun commit, aucun push, aucun accès Atlas/Supabase.

## Décision de marque
Nom visible **Stock Master**. Variables centrales `--brand-navy #062B5C`, `--brand-orange #FF6A00`, `--brand-white #FFFFFF` (`globals.css`), consommées via wordmark texte (`StockMaster`, composant partagé `components/brand/wordmark.tsx`) — **aucun fichier logo inventé**. Thème shadcn `--primary` global **non touché** pour ne pas affecter les pages métier.

**Correction ciblée (post-revue)** : `Wordmark` vivait initialement dans `app/auth/login/page.tsx` et était réimporté depuis ce fichier de page par `register`/`invitations/accept`/`app` — extrait vers `components/brand/wordmark.tsx` (nouveau) pour que `login/page.tsx` n'exporte plus que la page attendue par Next.js. Rendu et variables CSS strictement identiques ; aucun autre refactor. Budget porté à **9 fichiers production** (exception explicitement autorisée).

## Contrats backend consommés (aucun backend modifié)
| Endpoint | Contrat frontend |
|---|---|
| `POST /auth/login` | `{email,password,organizationId?}` → `{access_token,user}` **ou** `{organizationSelectionRequired:true, organizations:[{organizationId,name}]}`. |
| `POST /auth/register` | `{name,email,password,organizationName}` → 201 `{user,organization}`, **jamais de token** ; 403 `REGISTRATION_DISABLED` géré sans crash. |
| `POST /auth/invitations/accept` | `{token,name?,password?}` → succès `{user,organization,membership}` (pas de token) ; 400 `ACCOUNT_DETAILS_REQUIRED` (compte inconnu) ; 400 `INVITATION_INVALID_OR_EXPIRED`/409 `MEMBERSHIP_ALREADY_EXISTS` (messages déjà génériques côté API, affichés tels quels). |

## Connexion multi-organisation (`auth/login/page.tsx`, `contexts/auth-context.tsx`)
Le mot de passe ne vit **que** dans le `useState` local de la page (jamais dans `AuthContext`, jamais `localStorage`/`sessionStorage`/log) ; effacé après succès (`setPassword("")`) ou abandon (bouton « Retour »). `AuthContext.login(email,password,organizationId?)` retourne une union `{status:"success"}` / `{status:"organizationSelectionRequired", organizations}` ; seul le cas `success` écrit le token/l'utilisateur via le mécanisme existant (`lib/auth.ts`, inchangé). Sélection d'organisation : liste exacte renvoyée par l'API, **aucune saisie libre d'`organizationId`**. Succès → `router.push("/app")`.

## Inscription propriétaire (`auth/register/page.tsx`)
Formulaire strict `{name,email,password,organizationName}`, message explicite « crée ton entreprise et ton compte propriétaire ». `register()` retiré du contexte (appel direct `authRegister`, aucune écriture de state partagé — l'API ne renvoie pas de session). Succès 201 → écran de confirmation + lien vers `/auth/login` (aucune redirection automatique supposant un token). `REGISTRATION_DISABLED` détecté via `getApiErrorCode` et affiché avec un message dédié (pas le générique "Accès refusé.").

## Acceptation d'invitation (`auth/invitations/accept/page.tsx`, nouveau)
Token lu une seule fois via initialiseur paresseux de `useState` (pas d'effet miroir) depuis `window.location.search`, puis retiré visuellement de l'URL via `history.replaceState` (conservé en mémoire pour l'appel API). Premier appel avec le token seul ; `ACCOUNT_DETAILS_REQUIRED` bascule sur un formulaire `name`/`password` ; succès → message puis lien login ; toute autre erreur → message générique déjà fourni par l'API. Aucun champ role/permissions/organizationId exposé. Garde `useRef` contre le double appel réseau (token à usage unique).

## Route `/app` (`app/page.tsx`, nouveau)
Entrée authentifiée minimale : réutilise le garde existant (`useAuth` + redirection `/auth/login` si non authentifié, même motif que `sales/page.tsx`), affiche le wordmark Stock Master et un lien vers le catalogue existant (`/`). Aucune page métier migrée.

## Qualité
Bouton afficher/masquer mot de passe accessible (`aria-label`, `aria-pressed`) sur login et invitation. Erreurs associées aux champs (`role="alert"`, `aria-describedby`). États `loading` désactivant les boutons de soumission (anti double-submit). Responsive conservé (classes existantes) + `pb-[max(3rem,env(safe-area-inset-bottom))]` pour la safe-area iPhone sur les écrans d'auth et `/app`.

## Fichiers (9 prod, 0 test, 1 rapport)
Prod : `lib/api.ts` (contrats login/register/invitations + `getApiErrorCode`), `contexts/auth-context.tsx` (login multi-org, `register` retiré), `components/brand/wordmark.tsx` (nouveau, extrait de `login/page.tsx`), `app/auth/login/page.tsx`, `app/auth/register/page.tsx`, `app/auth/invitations/accept/page.tsx` (nouveau), `app/app/page.tsx` (nouveau), `app/layout.tsx` (metadata Stock Master), `app/globals.css` (variables de marque).
Tests : **aucun** — le package `web` ne possède aucune infrastructure de test (pas de jest/vitest/playwright, aucun script `test`) ; conformément à la contrainte de ne pas introduire de framework de test, aucun n'a été ajouté. Validation faite par lint + build/typecheck.
**Reportés explicitement à 1-9B** (hors budget/scope de 1-9A) : `components/layout/navbar.tsx` et `app/manifest.ts` conservent le branding RoyalVibe (chrome partagé avec les pages métier, non listés comme « pages touchées ») ; l'ancien fichier `/logo.jpg` RoyalVibe reste référencé par ces deux fichiers et par les icônes `layout.tsx`. **Ces trois éléments devront être mis à jour (ou le fichier logo supprimé) avant tout lancement en production.**

## Résultats
`pnpm --filter web exec eslint "src/**/*.{ts,tsx}"` → 0 erreur. `pnpm --filter web build` → compilation + typecheck OK, routes `/app` et `/auth/invitations/accept` générées en statique. `git diff --check` → propre (seuls avertissements CRLF/LF, sans caractère invalide). Aucun test backend requis (aucun fichier `api/` modifié).

## Hors périmètre
Aucun backend modifié. Aucune migration des pages métier (catalogue/produits/ventes/analytics/corbeille inchangés). Aucun nouveau fichier logo. Aucune dépendance ajoutée.

Aucun commit, aucun push — en attente de validation.
