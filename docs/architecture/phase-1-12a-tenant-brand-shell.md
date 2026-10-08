# Phase 1-12A — Identité visuelle du commerce dans le shell

Branche `architecture/phase-1-12a-tenant-brand-shell`, base `3cc41bc` (fix(web): stabilize offline catalog experience).
Frontend uniquement : aucun fichier `api/`, aucun DTO/schéma, aucun package ni lockfile.

## Objectif

Dans `/app`, le commerce devient l'identité principale (logo ou initiales, nom, couleur). Stock Master n'est plus qu'une signature discrète « by Stock Master ». Les pages `/`, `/auth/login`, `/auth/register`, `/auth/invitations/accept` et `/offline` gardent le logo Stock Master et les couleurs shadcn/Stock Master.

## Audit initial

| Point | Constat (base `3cc41bc`) |
| --- | --- |
| En-tête `/app` | `Wordmark` Stock Master dominant (180 px desktop, icône mobile). Nom de l'organisation en petit gris, masqué sous `sm`. `brandColor` utilisé seulement pour un filet de 4 px, en `style` brut. |
| Logo tenant | Jamais affiché dans le shell (seulement dans la page Branding). |
| Couleur tenant | Aucun calcul de contraste. Navigation active en `text-primary` (noir shadcn). |
| Switch | Bouton « Changer d'organisation » + `listbox` + `handleSwitch` dans `app/app/layout.tsx`. Méthode `switchOrganization` dans `AuthContext`, états `switching`/`menuOpen`/`switchingRef`, erreur de switch via `listError`. |
| Nom utilisateur | `user.name` complet, sans troncature. |
| Hors ligne | `offline-identity-db` : pointeur user/org + empreinte du token. `offline-sales-capability` : booléen seul. **Aucun stockage du nom ni de la couleur** : après F5 hors ligne, l'en-tête n'affichait que le logo Stock Master. |
| Accueil `/app` | Grand `Wordmark` Stock Master. CTA en navy fixe. |

## Choix visuels

- **En-tête** : logo ou initiales dans un cadre fixe de 36 × 36, puis le nom (`truncate`, nom complet dans `title`). Dessous, « by Stock Master » en 11 px `muted`, avec `hidden sm:block`. Ensuite : indicateur hors ligne, ventes en attente, convertisseur (desktop), premier prénom (`max-w-32 truncate`), déconnexion. Bordure basse en `--tenant-accent-border`.
- **Logo** (`components/brand/tenant-logo.tsx`) :
  - cadre fixe (36 px dans le shell, 80 px à l'accueil), fond blanc, `object-contain` : jamais étiré ni rogné ;
  - seulement `logoUrl` http(s) fourni par l'API, jamais `logoKey` ;
  - si `onError`, ou si l'image est `complete` avec `naturalWidth === 0`, l'échec est mémorisé par URL et le logo repasse aux initiales ;
  - initiales : deux premiers mots commençant par une lettre ou un chiffre, par graphème (« Épicerie du Coin » → « ÉD ») ; icône magasin si le nom est vide.
- **Couleur** : jetons posés en `style` inline sur la racine `[data-tenant-shell]` du shell. Ils sont réappliqués sur le `DialogContent` du menu « Plus », rendu en portail.
  - Navigation active desktop et « Plus » : fond `soft`, texte `ink`, anneau `border`.
  - Barre mobile : texte `ink` et barre d'indicateur `accent`.
  - Onglets Organisation : bordure `accent`, texte `ink`.
  - Pastille d'initiales : `accent` / `accent-foreground`.
  - Accueil : carte à fond `soft` et bordure `border`, CTA `accent` / `accent-foreground`.
  - Focus : `--ring` redéfini **uniquement** sous `[data-tenant-shell]` (`globals.css`). `:root` n'est pas modifié.
- **Accueil `/app`** : grand logo ou initiales du commerce, nom, « Bienvenue, <prénom>. » Plus de grand logo Stock Master.
- **Chargement** : barre squelette à la place du nom. Nom absent : « Mon commerce ». Aucune mention « organisation indisponible » hors ligne. Un refus HTTP reste signalé sous l'en-tête, comme avant.

### Calcul centralisé — `lib/tenant-brand.ts`

Fonctions pures, sans DOM :

- **Validation** : `normalizeBrandColor` accepte uniquement `#RRGGBB` strict. Sinon, repli sur le navy Stock Master `#062b5c`.
- **Ré-émission** : chaque jeton est recalculé à partir des entiers RGB et ré-émis en `#rrggbb` par `toHex`. Aucune chaîne fournie n'atteint le CSS : `red;background:url(x)` tombe sur le repli.
- **`accent`** : la couleur du commerce, assombrie par pas de 5 % si ni le navy ni le blanc n'atteignent 4,5:1 (couleurs moyennes, pire cas ≈ 3,7:1).
- **`accentForeground`** : navy `#062b5c` ou blanc, le plus contrasté, toujours ≥ 4,5:1.
- **`accentInk`** : l'accent utilisé comme couleur de texte, assombri jusqu'à ≥ 4,5:1 sur blanc **et** sur `soft`.
- **Autres jetons** : `accentSoft` (10 % de la couleur), `accentBorder` (40 %), `accentRing` (= `ink`).

| Couleur | `accent` | texte | contraste | `ink` (sur blanc) |
| --- | --- | --- | --- | --- |
| `#FFFDE7` très claire | `#fffde7` | navy | 13,57 | `#737268` — 4,84 |
| `#0A0A0A` sombre | `#0a0a0a` | blanc | 19,80 | `#0a0a0a` — 19,80 |
| `#FF6A00` orange | `#ff6a00` | navy | 4,85 | `#b34a00` — 5,39 |
| `#3B82F6` bleu moyen | `#326fd1` (assombri) | blanc | 4,85 | `#2f68c5` — 5,37 |

### Noms — `lib/display-names.ts` (affichage uniquement)

- `firstNameOf` : premier segment non vide après trim (`\s+` Unicode). Repli « Mon compte ».
- `fullNameOf` : nom nettoyé des espaces superflus, utilisé pour `title`.
- `organizationInitials` : initiales par graphème, voir ci-dessus.

Le nom complet de l'utilisateur est aussi en `sr-only` s'il diffère du prénom. Les valeurs stockées (`heyama_user`, API) ne sont jamais modifiées. La limite de 60 caractères n'est pas encore imposée côté API (phase suivante).

## Suppression du changement d'organisation

- Retirés du shell : bouton, `listbox`, `handleSwitch`, états `switching`/`menuOpen`/`switchingRef`, message d'erreur de switch.
- `AuthContext.switchOrganization` supprimé (plus aucun appelant).
- **Conservés** :
  - `switchOrganization()` de `lib/api.ts` (contrat bas niveau) et l'endpoint backend ;
  - la sélection multi-organisation du login ;
  - `fetchActiveOrganizations`, qui ne sert plus qu'à « Aucune organisation active » ;
  - le dialogue de ventes en attente au logout.
- **Parcours** : déconnexion → worker arrêté (`stopOfflineSalesSync`) → recensement de l'outbox → dialogue si besoin → `purgeAllOfflineData()` → login → sélection de l'organisation → `/app`.

## Stockage hors ligne minimal — schéma exact

Il n'existait pas de stockage équivalent : le pointeur d'identité ne porte ni nom ni couleur, et il est écrit après `/auth/context` seul. Base IndexedDB séparée `stockmaster-offline-tenant-brand` (version 1), store `brand`, clé unique `current` :

```ts
interface OfflineTenantBrand {
  schemaVersion: 1;
  userId: string;          // GET /auth/context
  organizationId: string;  // GET /auth/context (= /organizations/current._id)
  organizationName: string;// GET /organizations/current, ≤ 200 car. (borne défensive)
  brandColor: string;      // #rrggbb normalisé
  updatedAt: string;       // ISO 8601
}
```

- **Écriture** : seulement si `/auth/context` **et** `/organizations/current` réussissent et que `current._id === context.organizationId`. Champs recopiés un à un, jamais la réponse brute.
- **Lecture** : seulement après `readVerifiedIdentity` (empreinte du token courant, JWT non expiré). Ensuite, `validateTenantBrandRecord` (pure) exige :
  - correspondance **exacte** du user et de l'organisation ;
  - schéma v1, nom non vide et ≤ 200 caractères, couleur valide ;
  - `updatedAt` à moins de 72 h, et pas plus de 5 min dans le futur.
- **Purge** :
  - `purgeAllOfflineData()` : logout et bouton « Données hors connexion », avec catalogue, identité et capacité ;
  - à chaque login réussi, avant `setToken` (changement de session) ;
  - sur refus HTTP de `/auth/context`, comme la capacité.
- **Jamais stockés** : rôle, permission, JWT, empreinte de token, membership, `logoUrl`/`logoKey`, image. Aucune clé `localStorage` ajoutée. Hors ligne, le logo n'est pas disponible : initiales.
- **Retour en ligne** : le rechargement du contexte existant (`online`) relit `/organizations/current`, met à jour le branding affiché et réécrit l'enregistrement.

## Fichiers

| Fichier | Changement |
| --- | --- |
| `web/src/lib/tenant-brand.ts` | **Nouveau** : validation couleur, contraste WCAG, jetons `--tenant-*`. |
| `web/src/lib/display-names.ts` | **Nouveau** : premier prénom, nom complet, initiales. |
| `web/src/lib/offline-tenant-brand-db.ts` | **Nouveau** : stockage minimal nom/couleur, validation pure, TTL 72 h. |
| `web/src/components/brand/tenant-logo.tsx` | **Nouveau** : logo en cadre fixe et repli sur les initiales. |
| `web/src/app/app/layout.tsx` | En-tête tenant, jetons scoped, switch retiré, écriture/lecture/purge du snapshot visuel. |
| `web/src/app/app/page.tsx` | Accueil aux couleurs du commerce (logo, nom, prénom, CTA). |
| `web/src/app/app/organization/layout.tsx` | Onglet actif en accent tenant. |
| `web/src/app/globals.css` | `--ring` redéfini sous `[data-tenant-shell]` uniquement. |
| `web/src/contexts/auth-context.tsx` | `switchOrganization` retiré ; purge du snapshot visuel au login. |
| `web/src/lib/offline-purge.ts` | Purge du snapshot visuel ajoutée. |
| `web/src/lib/api.ts` | Commentaire de `fetchActiveOrganizations` uniquement. |
| `web/src/app/app/organization/offline-data/page.tsx` | Texte : mentionne le nom et la couleur du commerce. |

## Tests

**Fonctions pures** (`node --experimental-strip-types`, scratchpad) : **53 408 assertions OK**.

- **Rejets de couleur** : `orange`, `FF6A00`, `#fff`, `#FF6A0`, `#FF6A000`, `#FF6A00;`, espace initial, `red;background:url(x)`, non-chaînes.
- **Balayage de 4 096 couleurs** (pas de 17 par canal) : `accent`/`foreground` ≥ 4,5, `ink` ≥ 4,5 sur blanc et sur `soft`, texte ≥ 4,5 sur `soft`, `ring` ≥ 3, tous les jetons au format `#rrggbb`. `tenantAccentStyle` ne produit que des propriétés `--tenant-*`.
- **Noms** : prénoms multiples, tabulations, trim, tiret, CJK, repli. Initiales accentuées, chiffre, ponctuation, emoji ignoré.
- **Cache** : autre user, autre organisation, schéma, couleur, nom vide ou trop long, TTL atteint (72 h refusé, 71,9 h accepté), date future ou invalide, non-objet.

**Tests réels** (Playwright temporaire hors dépôt, `next build` + `next start` sur :3100, API compilée sur `MongoMemoryReplSet`, :4100) : **16/16, deux exécutions consécutives**.

1. **Logo** : PNG 3:1 servi par une route Playwright (`logoUrl` injecté, pas de S3 en test). Cadre 36 × 36 dans l'en-tête et 80 × 80 à l'accueil, image ≤ cadre, `object-fit: contain`.
2. **Sans logo** : initiales « BA ».
3. **Logo cassé (404)** : initiales dans l'en-tête et à l'accueil, aucune `<img>` cassée dans la page.
4. **Nom très long** (83 car.) : `ellipsis`, `title` complet, aucun débordement. Tronqué à 320, 375 et 390 px ; tient entier à 1 280 px.
5. **Plusieurs prénoms** : « Jean » affiché, `title` « Jean Pierre Martin-Dupont ».
6. **Noms utilisateur** (réécrits dans `heyama_user`) : `   Anne-Sophie   Élisabeth\tOyono  ` → « Anne-Sophie » ; mot de 48 caractères tronqué à ≤ 128 px ; « 李 小龙 » → « 李 » ; espaces seuls → « Mon compte ». Stockage intact.
7. **Couleurs**, contrastes mesurés sur les couleurs **calculées** du navigateur :
   - `#FF6A00` : pastille 4,85, navigation active 4,84, CTA 4,85, texte navy, focus `#b34a00` ;
   - `#FFFDE7` : texte navy, pastille 13,57, navigation active 4,84, CTA 13,57 ;
   - `#0A0A0A` : texte blanc, pastille 19,80, navigation active 16,01, CTA 19,80.
8. **Largeurs** : 1 280, puis 320, 375 et 390 px. Aucun débordement horizontal, logo 36 × 36, nom dans la fenêtre.
9. **Signature** : « by Stock Master » visible à 1 280 px, absente à 320, 375 et 390 px.
10. **Aucun switch** : ni « Changer d'organisation » ni `listbox`, desktop comme menu « Plus » mobile. Aucun logo Stock Master dans l'en-tête ni à l'accueil.
11. **Multi-organisation** : login → sélection → A. Logout → login → sélection → B.
12. **Vente en attente** (API `/sales` en 503) → logout → « Se déconnecter et conserver sur cet appareil ». Outbox identique octet pour octet, snapshot visuel purgé, token supprimé.
13. **F5 hors ligne** (`navigator.onLine = false`, API coupée) sur `/app/catalog` : nom « Boutique A », initiales « BA », accent `#ff6a00`, message hors ligne unique, aucune mention « organisation indisponible ». Enregistrement IndexedDB limité aux 6 champs, sans token, charge utile JWT, rôle, permission ni logo.
14. **Retour en ligne** : couleur passée à `#22C55E` côté API, puis événement `online`. Jetons et enregistrement mis à jour.
15. **Isolation A/B** :
    - dans B, aucun nom de A, couleur de B, enregistrement lié à B ;
    - enregistrement **falsifié** pour A injecté pendant la session B, puis F5 hors ligne : jamais affiché (repli « Mon commerce », couleur par défaut).
16. **Pages publiques** : `/`, `/auth/login`, `/auth/register`, `/auth/invitations/accept`, `/offline`. Logo Stock Master chargé, aucun `[data-tenant-shell]`, `--tenant-accent` vide sur `:root`, `--ring` shadcn inchangé.

Plus : `localStorage` limité à `heyama_token` et `heyama_user`. Aucune erreur de page.

**Régression 1-11C.3** : navigation hors ligne ciblée 4/4 (pastille en ligne, pastille hors ligne, repli, fragment `#offline-sales-panel`). Les suites 1-11C.3 qui testaient le switch A→B et le logo Stock Master de l'en-tête ne s'appliquent plus.

**Validation** : `eslint` (web) OK, `tsc --noEmit` OK, `next build` OK, `git diff --check` propre. Aucun fichier `api/`, aucun package ni lockfile.

## Limites

- **Portails** : les jetons ne s'appliquent qu'à ce qui est rendu sous la racine du shell et dans le menu « Plus ». Les autres dialogues (vente, produit…) gardent le `--ring` shadcn. Les boutons `primary` shadcn restent noirs : `--primary` n'est volontairement pas redéfini.
- **Premier rendu en ligne sans snapshot** : l'accent vaut le navy par défaut jusqu'à la réponse de `/organizations/current` (squelette sur le nom).
- **Logo hors ligne** : non mis en cache dans cette phase, donc initiales. Une URL signée expirée donne aussi les initiales.
- **Longueur des noms** : pas encore de limite côté API. La borne de 200 caractères du cache hors ligne est seulement défensive.
- **F5 hors ligne** : simulé dans Playwright (`navigator.onLine` forcé, API coupée), comme en 1-11C.3a. **À confirmer** dans un vrai Chrome hors ligne.
