# Heyama Objects

Objects manager (title, description, image) with a NestJS + MongoDB API,
S3-compatible image storage (MinIO in dev), and a Next.js frontend with
real-time updates over Socket.IO.

## Stack

- **API**: NestJS, Mongoose, `class-validator`, `@aws-sdk/client-s3`, `@nestjs/websockets` + `socket.io`
- **Web**: Next.js (App Router), TypeScript, Tailwind, shadcn/ui (Base UI), `socket.io-client`
- **Infra**: MongoDB, MinIO (S3-compatible), Docker Compose
- **Tooling**: pnpm workspaces, ESLint, Prettier, Husky + lint-staged

## Prerequisites

- Node.js 22+
- pnpm (`corepack enable` or `npm i -g pnpm`)
- Docker (for MongoDB and MinIO)

## Quick start

```bash
git clone <repo-url>
cd heyama-test

# 1. Start MongoDB and MinIO
docker compose up -d

# 2. Create the MinIO bucket
# Open http://localhost:9001 (login: minioadmin / minioadmin123)
# → Buckets → Create bucket → name it "heyama-objects"
# → Bucket → Anonymous access → add a "readonly" policy on prefix "*"
#   (so uploaded images are publicly viewable from the browser)

# 3. Install dependencies
pnpm install

# 4. Configure environment variables
cp api/.env.example api/.env
cp web/.env.example web/.env.local
# defaults already match the docker-compose services, no edits needed for local dev

# 5. Run the API and the web app (two terminals)
pnpm --filter api start:dev   # http://localhost:4000
pnpm --filter web dev         # http://localhost:3000
```

Open http://localhost:3000, create an object with an image — it appears
instantly (via Socket.IO) on every open tab, including the one you're not
using.

## Environment variables

See `api/.env.example` and `web/.env.example` for the full list. Local
defaults are pre-wired to the `docker-compose.yml` services (MongoDB on
`27017`, MinIO on `9000`).

## Project structure

```
api/    NestJS REST API + WebSocket gateway
web/    Next.js frontend
```

## Scripts

From the repo root:

```bash
pnpm lint     # lint api + web
pnpm format   # prettier --write on the whole repo
```

Per package:

```bash
pnpm --filter api test    # jest unit tests
pnpm --filter api build   # nest build
pnpm --filter web build   # next build
```

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs lint, tests and build for
`api` and `web` on every push/PR to `main`/`dev`.
