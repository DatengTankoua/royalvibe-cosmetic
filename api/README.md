# Stock Master — API (NestJS)

API REST + WebSocket de l'application **Stock Master**.

## Stack

- NestJS 11 · TypeScript · Mongoose (MongoDB 7)
- `@nestjs/jwt` + Passport (authentification JWT Bearer)
- `@nestjs/websockets` + Socket.IO (temps réel)
- `@aws-sdk/client-s3` (upload images MinIO/S3-compatible)
- `class-validator` / `class-transformer` (validation des DTOs)
- `bcryptjs` (hash des mots de passe)

---

## Prérequis

- Node.js 22+, pnpm 11+
- MongoDB 7 et MinIO en cours d'exécution (voir `docker-compose.yml` à la racine)

## Lancer en dev

```bash
# Depuis la racine du monorepo
pnpm --filter api start:dev

# Ou depuis le dossier api/
pnpm start:dev
```

L'API écoute sur [http://localhost:4000](http://localhost:4000).

Le mode `--watch` recompile automatiquement à chaque modification de fichier.

## Variables d'environnement

```bash
cp .env.example .env
```

Toutes les valeurs par défaut du `.env.example` sont compatibles avec le `docker-compose.yml` de dev.

| Variable | Défaut | Description |
|---|---|---|
| `PORT` | `4000` | Port d'écoute |
| `MONGODB_URI` | `mongodb://localhost:27017/stockmaster` | URI de connexion MongoDB |
| `JWT_SECRET` | `change-me-...` | Secret JWT — **changer en production** |
| `CORS_ORIGIN` | `http://localhost:3000` | Origines autorisées (séparées par virgule) |
| `S3_ENDPOINT` | `http://localhost:9000` | URL MinIO ou S3 |
| `S3_REGION` | `us-east-1` | Région S3 |
| `S3_ACCESS_KEY` | `minioadmin` | Clé d'accès S3 |
| `S3_SECRET_KEY` | `minioadmin123` | Secret S3 |
| `S3_BUCKET` | `stockmaster-objects` | Nom du bucket |
| `S3_FORCE_PATH_STYLE` | `true` | Valeur exacte `true` = adressage path-style (MinIO) ; sinon virtual-hosted (exemple officiel R2) |
| `S3_SIGNING_ENDPOINT` | _(vide)_ | Origine http(s) jointe par le navigateur, utilisée **uniquement** pour signer les URL GET quand l'API joint le stockage par un nom interne (Docker Compose : `https://s3.<domaine>`). Vide pour R2 (endpoint unique). N'affecte pas l'identité du stockage |
| `S3_SIGNED_URL_TTL_SECONDS` | `900` | Durée des URL GET signées (entier 60–3600). Bucket privé : aucune URL publique ; la clé est stockée, l'URL est signée à chaque lecture |
| `S3_CHECKSUM_MODE` | `when_supported` | Sommes de contrôle du SDK (`when_supported` ou `when_required`) ; à changer seulement après l'essai R2 opérateur |
| `STORAGE_QUOTA_BYTES` | `250000000` | Quota de stockage par organisation, en octets (photos, corbeille comprise, et logo). Serveur uniquement : aucune route ne le modifie |
| `STORAGE_QUOTA_MODE` | `enforce` | `enforce` bloque un envoi qui dépasserait le quota (413 `STORAGE_QUOTA_EXCEEDED`) ; `track` comptabilise sans bloquer (initialisation des fichiers existants) |
| `STORAGE_RESERVATION_TTL_SECONDS` | `900` | Durée d'une réservation (60–3600) ; l'envoi est annulé au tiers de cette durée, la reprise n'agit qu'après échéance |
| `STORAGE_INVENTORY_INTERVAL_SECONDS` | `21600` | Période de l'inventaire du stockage (fichiers présents sans entrée au registre : envoi arrivé après la reprise, ancien code), **en mode `enforce` seulement** (300–604800, `0` = désactivé ; CLI `storage:quota inventory` sinon) |
| `STORAGE_RECOVERY_INTERVAL_SECONDS` | `600` | Période de la reprise automatique dans le processus HTTP (60–86400, `0` = désactivée ; CLI `storage:quota recover --apply` sinon ; sans `--apply` : état des lieux sans écriture) |

`S3_PUBLIC_URL` n'est plus lue (stockage R2 privé). L'identité du stockage
(hôte de `S3_ENDPOINT` + `S3_BUCKET`) est enregistrée avec chaque clé : une
autre configuration ne lit ni ne supprime les objets d'un autre stockage.
| `WEB_PUSH_ENABLED` | `false` | Notifications Web Push (1-16A) ; `true` exige les trois clés VAPID ci-dessous (démarrage refusé si invalides). Le centre de notifications (1-16A.1) fonctionne dans tous les cas ; la migration `migrate:push-notification-indexes` est requise en production et dès que le push est activé |
| `WEB_PUSH_VAPID_PUBLIC_KEY` | _(vide)_ | Clé publique P-256 base64url, **stable** entre redémarrages |
| `WEB_PUSH_VAPID_PRIVATE_KEY` | _(vide)_ | Clé privée correspondante — **secret**, jamais journalisée |
| `WEB_PUSH_VAPID_SUBJECT` | _(vide)_ | Contact `mailto:` ou URL `https:` |

---

## Modules

| Module | Rôle |
|---|---|
| `auth` | Register, login, stratégie JWT Passport, guard global, décorateurs `@Public()` et `@CurrentUser()` |
| `users` | Schéma Mongoose `User`, rôles `admin` / `seller` |
| `sections` | Catégories hiérarchiques (CRUD réservé aux admins, lecture ouverte) |
| `products` | Catalogue + calcul des métriques (stock, bénéfice, statut) à chaque lecture |
| `sales` | Enregistrement des ventes, décrémentation automatique du stock |
| `audit` | Journal immuable : enregistre chaque action sur les produits avec l'acteur et les détails |
| `analytics` | Agrégations MongoDB : KPIs globaux, classements produits/vendeurs, tendance mensuelle |
| `events` | Passerelle WebSocket — émet les événements `product:created`, `product:updated`, `product:deleted`, `sale:created` |
| `s3` | Upload (multipart/form-data via Multer) et suppression d'images |
| `trash` | Suppression douce (soft delete) avec restauration ou suppression définitive |

---

## Référence API

> Toutes les routes sont protégées par JWT sauf `POST /auth/register`, `POST /auth/login` et `GET /health`.
> Inclure le header : `Authorization: Bearer <token>`

### Health

```
GET /health   → { status: "ok" }  (public — utilisé par le CI/CD pour les health checks)
```

### Auth

```
POST /auth/register   { name, email, password }  → { access_token, user }
POST /auth/login      { email, password }         → { access_token, user }
GET  /auth/me                                     → user courant
```

### Sections

```
GET    /sections              → liste (filtre optionnel : ?parentId=)
GET    /sections/:id          → détail
POST   /sections              (admin) { name, description?, parentId? }
PATCH  /sections/:id          (admin) { name?, description? }
DELETE /sections/:id          (admin) → soft delete
PATCH  /sections/:id/restore  (admin) → restauration depuis la corbeille
DELETE /sections/:id/permanent (admin) → suppression définitive
```

### Produits

```
GET    /products              → liste avec métriques (filtre : ?sectionId=)
GET    /products/:id          → détail + ventes + audit
POST   /products              (admin) multipart/form-data: { sectionId, name, purchasePrice, salePrice, initialQuantity, image }
PATCH  /products/:id          (admin) { name?, purchasePrice?, salePrice?, additionalStock?, sectionId? }
DELETE /products/:id          (admin) → soft delete
PATCH  /products/:id/restore  (admin) → restauration
DELETE /products/:id/permanent (admin) → suppression définitive
```

### Ventes

```
GET  /sales              → liste (filtre : ?productId=)
POST /sales              { productId, quantity, salePrice, buyerName?, buyerContact? }
```

### Analytics

```
GET /analytics/overview            → KPIs globaux (filtre : ?month=YYYY-MM)
GET /analytics/products/ranking    → classement produits (filtre : ?month=YYYY-MM)
GET /analytics/sellers/ranking     → classement vendeurs (filtre : ?month=YYYY-MM)
GET /analytics/monthly             → tendance sur 12 mois
```

### Corbeille

```
GET /trash   → { sections: [...], products: [...] }
```

---

## WebSocket (Socket.IO)

Connexion : `ws://localhost:4000` (ou port configuré).

| Événement émis | Payload | Déclencheur |
|---|---|---|
| `product:created` | `{ productId }` | Création d'un produit |
| `product:updated` | `{ productId }` | Modification d'un produit |
| `product:deleted` | `{ productId }` | Suppression d'un produit |
| `sale:created` | `{ saleId, productId }` | Enregistrement d'une vente |

---

## Commandes

```bash
pnpm start:dev      # dev avec rechargement automatique
pnpm start:debug    # dev avec débogueur Node.js attachable
pnpm build          # compile TypeScript → dist/
pnpm start:prod     # démarre le build de production
pnpm test           # tests unitaires
pnpm test:e2e       # tests end-to-end
pnpm test:cov       # couverture de code
pnpm lint           # ESLint avec auto-fix
```

## Build production (Docker)

```bash
docker build -t stock-master-api ./api
```

Voir `Dockerfile` pour les détails du build multi-stage.

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
