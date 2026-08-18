# RoyalVibe — Frontend (Next.js)

Interface utilisateur de l'application **RoyalVibe Cosmétiques & Bijoux**.

## Stack

- Next.js 16 (App Router) · React 19 · TypeScript 5
- Tailwind CSS v4 · `@base-ui/react` (composants headless) · `recharts` (graphiques)
- `socket.io-client` (mises à jour temps réel)
- `next-themes` (thème sombre/clair)
- `sonner` (notifications toast)
- PWA : manifest + service worker (`public/sw.js`)

---

## Prérequis

- Node.js 22+, pnpm 11+
- L'API NestJS doit être en cours d'exécution (voir `../api/README.md`)

## Lancer en dev

```bash
# Depuis la racine du monorepo
pnpm --filter web dev

# Ou depuis le dossier web/
pnpm dev
```

L'app est accessible sur [http://localhost:3000](http://localhost:3000).

## Variables d'environnement

```bash
cp .env.example .env.local
```

| Variable | Défaut | Description |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | URL de l'API NestJS |

> `NEXT_PUBLIC_API_URL` est injectée **au build**. En production Docker, elle est passée via l'`ARG` du Dockerfile.

---

## Pages

| Route | Accès | Description |
|---|---|---|
| `/` | Tous | Grille des sections racines |
| `/sections/[id]` | Tous | Sous-sections et produits d'une section |
| `/products/[id]` | Tous | Détail produit : métriques, historique ventes, journal d'audit |
| `/sales` | Tous | Historique global de toutes les ventes |
| `/analytics` | Admin | Dashboard KPIs, classements, tendance mensuelle |
| `/corbeille` | Admin | Corbeille : restauration ou suppression définitive |
| `/auth/login` | Public | Connexion JWT |
| `/auth/register` | Public | Inscription |

---

## Architecture du code

```
src/
├── app/                    # Pages Next.js (App Router)
│   ├── layout.tsx          # Layout racine (providers, navigation)
│   ├── page.tsx            # Grille des sections
│   ├── analytics/          # Dashboard analytique
│   ├── auth/               # Login / Register
│   ├── corbeille/          # Corbeille (soft delete)
│   ├── objects/            # Alias legacy (redirige vers products)
│   ├── products/[id]/      # Détail produit
│   ├── sales/              # Historique des ventes
│   └── sections/[id]/      # Produits d'une section
│
├── components/
│   ├── layout/             # Navigation, sidebar, header
│   ├── currency/           # Convertisseur EUR ↔ FCFA
│   ├── objects/            # Composants produits (cartes, formulaires)
│   ├── products/           # Métriques, tableaux ventes/audit
│   ├── sections/           # Cartes sections
│   └── ui/                 # Composants atomiques (Button, Dialog, Badge…)
│
├── contexts/
│   └── auth-context.tsx    # Contexte d'authentification global (JWT)
│
├── hooks/
│   ├── use-objects.ts      # Fetch + mutations produits (wraps api.ts)
│   ├── use-products.ts     # Alias de use-objects
│   ├── use-sections.ts     # Fetch + mutations sections
│   ├── use-socket.ts       # Connexion Socket.IO + listeners temps réel
│   └── use-trash.ts        # Fetch corbeille, restauration, suppression
│
└── lib/
    ├── api.ts              # Axios client + toutes les fonctions API typées
    ├── auth.ts             # Helpers JWT (getToken, setToken, removeToken)
    ├── currency.ts         # Conversion EUR ↔ FCFA (taux fixe 655,957)
    └── utils.ts            # Utilitaires (cn, formatDate…)
```

---

## Temps réel (WebSocket)

Le hook `useSocket` se connecte automatiquement à l'API via Socket.IO.  
Les événements `product:created`, `product:updated`, `product:deleted` et `sale:created` déclenchent un rafraîchissement des données sans rechargement de page.

## PWA

L'application est installable sur mobile et desktop. Le manifest est généré dans `src/app/manifest.ts` et le service worker dans `public/sw.js`.

---

## Commandes

```bash
pnpm dev        # serveur de développement (http://localhost:3000)
pnpm build      # build de production → .next/standalone
pnpm start      # démarre le build de production
pnpm lint       # ESLint
```

## Build production (Docker)

```bash
docker build \
  --build-arg NEXT_PUBLIC_API_URL=https://api.royalvibe.tondomaine.com \
  -t royalvibe-web \
  ./web
```

Le Dockerfile utilise un build multi-stage avec `output: 'standalone'` pour une image minimale.
