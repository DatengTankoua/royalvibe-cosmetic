# RoyalVibe — API (NestJS)

API REST + WebSocket de l'application **RoyalVibe Cosmétiques & Bijoux**.

## Stack

- NestJS 11 · TypeScript · Mongoose (MongoDB 7)
- `@nestjs/jwt` + Passport (authentification JWT)
- `@nestjs/websockets` + Socket.IO (temps réel)
- `@aws-sdk/client-s3` (upload images MinIO/S3)
- `class-validator` / `class-transformer`
- `bcryptjs` (hash des mots de passe)

## Modules

| Module | Description |
|---|---|
| `auth` | Register, login, JWT guards, `@Public()` decorator |
| `users` | Schéma User, rôles Admin/Seller |
| `sections` | Catégories de produits (CRUD admin) |
| `products` | Catalogue + métriques (stock, profit, statut) |
| `sales` | Enregistrement des ventes, décrémentation du stock |
| `audit` | Journal immuable de chaque modification produit |
| `analytics` | Agrégations MongoDB : KPIs, classements, tendance mensuelle |
| `events` | Passerelle WebSocket (product:created/updated/deleted, sale:created) |
| `s3` | Upload et suppression d'images (S3-compatible) |

## Lancer en dev

```bash
# Depuis la racine du monorepo
pnpm --filter api start:dev
# ou depuis api/
pnpm start:dev
```

L'API tourne sur [http://localhost:4000](http://localhost:4000).

## Variables d'environnement

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `PORT` | Port de l'API (défaut : 4000) |
| `MONGODB_URI` | URI MongoDB |
| `JWT_SECRET` | Secret JWT (long string aléatoire en prod) |
| `CORS_ORIGIN` | Origines autorisées (ex: `https://royalvibe.com`) |
| `S3_ENDPOINT` | URL MinIO/S3 |
| `S3_REGION` | Région S3 |
| `S3_ACCESS_KEY` | Clé d'accès S3 |
| `S3_SECRET_KEY` | Secret S3 |
| `S3_BUCKET` | Nom du bucket |
| `S3_FORCE_PATH_STYLE` | `true` pour MinIO |
| `S3_PUBLIC_URL` | URL publique pour les images (si différente de `S3_ENDPOINT`) |

## Endpoints principaux

```
POST /auth/register
POST /auth/login
GET  /auth/me

GET  /sections
POST /sections           (admin)
GET  /sections/:id

GET  /products?sectionId=
POST /products           (admin)
GET  /products/:id
PATCH /products/:id      (admin)
DELETE /products/:id     (admin)

GET  /sales
POST /sales

GET  /audit/:productId

GET  /analytics/overview?month=YYYY-MM
GET  /analytics/products/ranking?month=YYYY-MM
GET  /analytics/sellers/ranking?month=YYYY-MM
GET  /analytics/monthly
```

## Build production

```bash
pnpm build    # compile TypeScript → dist/
node dist/main
```

Ou via Docker (voir `Dockerfile` à la racine du dossier `api/`).


[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ pnpm install
```

## Compile and run the project

```bash
# development
$ pnpm run start

# watch mode
$ pnpm run start:dev

# production mode
$ pnpm run start:prod
```

## Run tests

```bash
# unit tests
$ pnpm run test

# e2e tests
$ pnpm run test:e2e

# test coverage
$ pnpm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ pnpm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
