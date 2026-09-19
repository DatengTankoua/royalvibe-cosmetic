# Phase 0B.5 — Désactivation de l'inscription publique

## Avant / après
- Avant : `POST /auth/register` ouvert à tous (rôle `seller` par défaut, aucun contrôle).
- Après : désactivée **par défaut** ; seule `PUBLIC_REGISTRATION_ENABLED=true` (valeur exacte, sensible à la casse) l'active. Sinon : **HTTP 403** + code stable **`REGISTRATION_DISABLED`** + `AuthService.register` **jamais appelé** (garde dans `AuthController`, levée avant toute logique) ; aucun compte créé en base. Le backend reste l'autorité finale quel que soit le flag frontend.
- Login/comptes existants : **inchangés** (404/401/201 de l'existant). Aucun « premier utilisateur admin », aucun endpoint intermédiaire.

## Configuration (sans secret)
`.env.prod.example` : `PUBLIC_REGISTRATION_ENABLED=false` (API) + `NEXT_PUBLIC_REGISTRATION_ENABLED=false` (web). Web : le lien « S'inscrire » de la page login est masqué (variable absente = `false`) et l'accès direct à `/auth/register` affiche un message court + lien de connexion. `NEXT_PUBLIC_*` utilisé **uniquement pour l'affichage**.

## Tests
- `auth.controller.spec.ts` (nouveau) : `it.each` de 7 valeurs désactivées (absente/`false`/`1`/`yes`/`TRUE`/`true `/vide) → 403 + `REGISTRATION_DISABLED` + service **non appelé** ; `true` → comportement existant (service appelé) ; login fonctionnel tandis que l'inscription est fermée.
- E2E `app.e2e-spec.ts` (describe 7) : sans variable → POST 403 `REGISTRATION_DISABLED`, **0 compte créé** (compteur Mongo éphémère avant/après) + login refusé (401) ; login d'un compte existant 201. Fixtures des suites E2E : variable activée **explicitement** dans le beforeAll (restaurée par `delete` dans chaque test).

## Risques résiduels
- Flag lu à chaque requête côté API (pas de figement au boot) : cohérent avec la spéc « activée explicitement en test puis restaurée ».
- Fermeture TEMPORAIRE : sera remplacée par l'inscription du gérant comme **OWNER**, la **création de son organisation**, et l'**invitation sécurisée des vendeurs** (phase organisation — non créée ici ; aucun `organization`/`membership`/`invitation`).

## Fichiers (8)
`api/src/auth/auth.controller.ts` · `api/src/auth/auth.controller.spec.ts` (N) · `api/test/app.e2e-spec.ts` · `api/test/socket.e2e-spec.ts` · `web/src/app/auth/login/page.tsx` · `web/src/app/auth/register/page.tsx` · `.env.prod.example` · ce rapport (N)
