# RoyalVibe — Frontend (Next.js)

Interface utilisateur de l'application **RoyalVibe Cosmétiques & Bijoux**.

## Stack

- Next.js 16 (App Router) · React 19 · TypeScript 5
- Tailwind CSS · `@base-ui/react` · `recharts`
- `socket.io-client` (mises à jour temps réel)
- PWA (manifest + service worker)

## Pages

| Route | Description |
|---|---|
| `/` | Grille des sections (catégories) |
| `/sections/[id]` | Produits d'une section |
| `/products/[id]` | Détail produit : métriques, ventes, audit |
| `/analytics` | Dashboard analytique avec filtre par mois |
| `/sales` | Historique de toutes les ventes |
| `/auth/login` | Connexion JWT |
| `/auth/register` | Inscription |

## Lancer en dev

```bash
# Depuis la racine du monorepo
pnpm --filter web dev
# ou depuis web/
pnpm dev
```

L'app tourne sur [http://localhost:3000](http://localhost:3000).

## Variables d'environnement

```bash
cp .env.example .env.local
```

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_API_URL` | URL de l'API NestJS (ex: `http://localhost:4000`) |
| `S3_HOSTNAME` | Hostname MinIO/S3 pour autoriser les images Next.js (prod) |

## Build production

```bash
pnpm build    # génère .next/standalone
pnpm start    # démarre le serveur de prod
```

Ou via Docker (voir `Dockerfile` à la racine du dossier `web/`).
