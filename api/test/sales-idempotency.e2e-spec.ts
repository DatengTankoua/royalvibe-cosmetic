import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { Connection, Model, Types } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { UserDocument } from './../src/users/schemas/user.schema';
import { ProductDocument } from './../src/products/schemas/product.schema';
import { SaleDocument } from './../src/sales/schemas/sale.schema';
import {
  SaleOperation,
  SaleOperationDocument,
  SALE_OPERATIONS_COLLECTION,
} from './../src/sales/schemas/sale-operation.schema';
import { AuditLogDocument } from './../src/audit/schemas/audit-log.schema';
import { Organization } from './../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from './../src/organizations/schemas/organization.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import { EventsGateway } from './../src/events/events.gateway';
import {
  SaleOperationIndexCheck,
  SaleOperationIndexError,
  ensureSaleOperationIndex,
  verifySaleOperationIndex,
} from './../src/sales/sale-operation-index';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';
import {
  buildHttpCorsOptions,
  buildOriginAllowlist,
  parseCORSOrigin,
} from './../src/events/origin.helpers';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import {
  E2E_EMAIL_VERIFIED_AT,
  autoConfirmVerificationEmails,
  createE2eEmailSender,
} from './e2e/email-verification-fixtures';

// 1-13A : expéditeur simulé, liens confirmés via le service réel.
const emailSender = createE2eEmailSender();

/**
 * E2E 1-11C.1 — idempotence de `POST /sales` sur replica set éphémère
 * (`MongoMemoryReplSet`, garde anti-27017). Aucune base réelle.
 *
 * L'index unique `sale_operations` n'est JAMAIS créé au démarrage
 * (`autoIndex: false`) : ce fichier prouve d'abord son absence (fail-fast
 * production), puis le crée EXPLICITEMENT via la fonction de migration.
 */

const TEST_JWT_SECRET = 'e2e-only-static-secret-not-production-use';
const E2E_CORS_ORIGIN = 'https://e2e.example.com';
const ORG_A = 'a11c1a11c1a11c1a11c1a11c';
const ORG_B = 'b11c1b11c1b11c1b11c1b11c';
const ORG_C = 'c11c1c11c1c11c1c11c1c11c';
const PASSWORD = 'idem-11c1-pw-!1x';
const DAY_MS = 24 * 60 * 60 * 1000;

describe('App (e2e 1-11C.1) — idempotence POST /sales', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let connection: Connection;
  let userModel: Model<UserDocument>;
  let productModel: Model<ProductDocument>;
  let saleModel: Model<SaleDocument>;
  let operationModel: Model<SaleOperationDocument>;
  let auditModel: Model<AuditLogDocument>;
  let organizationModel: Model<OrganizationDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;
  let emitSpy: jest.SpyInstance;

  const tokens: Record<string, string> = {};
  const userIds: Record<string, Types.ObjectId> = {};
  const sections: Record<string, string> = {};

  async function seedUser(
    label: string,
    org: string,
    role: 'owner' | 'seller',
  ) {
    const user = await userModel.create({
      emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
      name: `User ${label}`,
      email: `${label}-11c1@idem.test`,
      password: await bcrypt.hash(PASSWORD, 10),
    });
    userIds[label] = user._id;
    await membershipModel.create({
      organizationId: new Types.ObjectId(org),
      userId: user._id,
      role,
      status: 'active',
    });
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: `${label}-11c1@idem.test`, password: PASSWORD });
    expect(login.status).toBe(201);
    tokens[label] = login.body.access_token as string;
  }

  async function seedProduct(org: string, quantity: number) {
    const p = await productModel.create({
      sectionId: new Types.ObjectId(sections[org]),
      name: `P-${randomUUID()}`,
      imageUrl: 'https://e2e.local/img.png',
      purchasePrice: 100,
      salePrice: 400,
      initialQuantity: quantity,
      remainingQuantity: quantity,
      organizationId: new Types.ObjectId(org),
    });
    return p._id.toString();
  }

  const post = (token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/sales')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const saleBody = (
    productId: string,
    extra: Record<string, unknown> = {},
  ) => ({
    productId,
    quantity: 2,
    salePrice: 400,
    buyerName: 'Client 1-11C.1',
    ...extra,
  });

  const remainingOf = async (id: string) =>
    (await productModel.findById(id).exec())!.remainingQuantity;
  const countFor = async (productId: string) => ({
    sales: await saleModel.countDocuments({
      productId: new Types.ObjectId(productId),
    }),
    sold: await auditModel.countDocuments({
      productId: new Types.ObjectId(productId),
      action: 'sold',
    }),
  });
  const operationsFor = (clientOperationId: string) =>
    operationModel.countDocuments({ clientOperationId });

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      process.env.MONGODB_URI = validatedEphemeralUri(replSet);
      process.env.JWT_SECRET = TEST_JWT_SECRET;
      process.env.S3_ENDPOINT = 'http://127.0.0.1:65535';
      process.env.S3_REGION = 'us-east-1';
      process.env.S3_ACCESS_KEY = 'e2e-local';
      process.env.S3_SECRET_KEY = 'e2e-local';
      process.env.S3_BUCKET = 'e2e-local';
      process.env.S3_FORCE_PATH_STYLE = 'true';
      process.env.CORS_ORIGIN = E2E_CORS_ORIGIN;
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';

      moduleFixture = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(EMAIL_SENDER)
        .useValue(emailSender)
        .compile();
      app = moduleFixture.createNestApplication();
      app.enableCors(
        buildHttpCorsOptions(
          buildOriginAllowlist(
            parseCORSOrigin(process.env.CORS_ORIGIN, 'development'),
          ),
        ),
      );
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
      );
      app.useGlobalFilters(new HttpExceptionFilter());
      await app.init();
      autoConfirmVerificationEmails(app, emailSender);

      connection = moduleFixture.get<Connection>(getConnectionToken());
      userModel = moduleFixture.get(getModelToken('User'));
      productModel = moduleFixture.get(getModelToken('Product'));
      saleModel = moduleFixture.get(getModelToken('Sale'));
      operationModel = moduleFixture.get(getModelToken(SaleOperation.name));
      auditModel = moduleFixture.get(getModelToken('AuditLog'));
      organizationModel = moduleFixture.get(getModelToken(Organization.name));
      membershipModel = moduleFixture.get(
        getModelToken(OrganizationMembership.name),
      );

      for (const [id, slug] of [
        [ORG_A, 'idem-a'],
        [ORG_B, 'idem-b'],
        [ORG_C, 'idem-c'],
      ]) {
        await organizationModel.create({ _id: id, slug, name: slug });
      }
      await seedUser('ownerA', ORG_A, 'owner');
      await seedUser('sellerA', ORG_A, 'seller');
      await seedUser('sellerA2', ORG_A, 'seller');
      await seedUser('ownerB', ORG_B, 'owner');
      await seedUser('ownerC', ORG_C, 'owner');

      for (const [org, owner] of [
        [ORG_A, 'ownerA'],
        [ORG_B, 'ownerB'],
        [ORG_C, 'ownerC'],
      ]) {
        const res = await request(app.getHttpServer())
          .post('/sections')
          .set('Authorization', `Bearer ${tokens[owner]}`)
          .send({ name: `Section ${org}` });
        expect(res.status).toBe(201);
        sections[org] = res.body._id as string;
      }
    } catch (err) {
      if (moduleFixture) await moduleFixture.close().catch(() => undefined);
      await stopEphemeralMongoSafe();
      throw err;
    }
  }, 180_000);

  beforeEach(() => {
    emitSpy = jest.spyOn(
      moduleFixture.get(EventsGateway),
      'emitToOrganization',
    );
    emitSpy.mockClear();
  });

  afterEach(() => emitSpy.mockRestore());

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  describe('0. index unique : jamais implicite, migration explicite', () => {
    it('absent après le démarrage (autoIndex désactivé) → fail-fast production', async () => {
      await expect(verifySaleOperationIndex(connection)).rejects.toBeInstanceOf(
        SaleOperationIndexError,
      );
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        await expect(
          new SaleOperationIndexCheck(connection).onApplicationBootstrap(),
        ).rejects.toBeInstanceOf(SaleOperationIndexError);
      } finally {
        process.env.NODE_ENV = previous;
      }
    });

    it('migration idempotente : créé puis déjà présent ; index unique exact réellement présent', async () => {
      await expect(ensureSaleOperationIndex(connection)).resolves.toBe(
        'created',
      );
      await expect(ensureSaleOperationIndex(connection)).resolves.toBe(
        'already-present',
      );
      await expect(verifySaleOperationIndex(connection)).resolves.toBe(
        undefined,
      );
      const indexes = await connection
        .db!.collection(SALE_OPERATIONS_COLLECTION)
        .listIndexes()
        .toArray();
      const idem = indexes.find(
        (i) => i.name === 'organizationId_1_clientOperationId_1',
      );
      expect(idem).toBeDefined();
      expect(Object.entries(idem!.key as Record<string, number>)).toEqual([
        ['organizationId', 1],
        ['clientOperationId', 1],
      ]);
      expect(idem!.unique).toBe(true);
      expect(idem!.partialFilterExpression).toBeUndefined();
      expect(idem!.expireAfterSeconds).toBeUndefined();
    });
  });

  describe('1. rejeux : exactement une vente, un décrément, un audit', () => {
    it('même clé 3 fois séquentielles → 3×201, même saleId, stock -q une fois, 1 émission', async () => {
      const productId = await seedProduct(ORG_A, 10);
      const key = randomUUID();
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await post(
          tokens.sellerA,
          saleBody(productId, { clientOperationId: key }),
        );
        expect(res.status).toBe(201);
        ids.push(res.body._id as string);
      }
      expect(new Set(ids).size).toBe(1);
      expect(await remainingOf(productId)).toBe(8);
      expect(await countFor(productId)).toEqual({ sales: 1, sold: 1 });
      expect(await operationsFor(key)).toBe(1);
      expect(emitSpy).toHaveBeenCalledTimes(1);
      const audit = await auditModel
        .findOne({ productId: new Types.ObjectId(productId), action: 'sold' })
        .lean()
        .exec();
      expect(String((audit!.details as { saleId: unknown }).saleId)).toBe(
        ids[0],
      );
    });

    it('même clé 5 fois concurrentes → aucun 5xx, même saleId, 1 vente, stock -q une fois', async () => {
      const productId = await seedProduct(ORG_A, 10);
      const key = randomUUID();
      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          post(tokens.sellerA, saleBody(productId, { clientOperationId: key })),
        ),
      );
      for (const res of responses) expect(res.status).toBe(201);
      expect(new Set(responses.map((r) => r.body._id as string)).size).toBe(1);
      expect(await remainingOf(productId)).toBe(8);
      expect(await countFor(productId)).toEqual({ sales: 1, sold: 1 });
      expect(await operationsFor(key)).toBe(1);
      expect(emitSpy).toHaveBeenCalledTimes(1);
    });

    it('payload différent avec la même clé → 409 IDEMPOTENCY_KEY_REUSED, aucun effet', async () => {
      const productId = await seedProduct(ORG_A, 10);
      const key = randomUUID();
      expect(
        (
          await post(
            tokens.sellerA,
            saleBody(productId, { clientOperationId: key }),
          )
        ).status,
      ).toBe(201);
      const res = await post(
        tokens.sellerA,
        saleBody(productId, { clientOperationId: key, quantity: 3 }),
      );
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await remainingOf(productId)).toBe(8);
      expect(await countFor(productId)).toEqual({ sales: 1, sold: 1 });
    });
  });

  describe('2. rollback et conflits métier', () => {
    it('échec d’audit → ni vente ni SaleOperation, puis retry de la même clé réussit', async () => {
      const productId = await seedProduct(ORG_A, 5);
      const key = randomUUID();
      const originalCreate = auditModel.create.bind(auditModel) as (
        docs: unknown,
        opts?: { session?: unknown },
      ) => Promise<unknown>;
      auditModel.create = ((docs: unknown, opts?: { session?: unknown }) =>
        opts?.session
          ? Promise.reject(new Error('simulated audit failure'))
          : originalCreate(docs, opts)) as unknown as typeof auditModel.create;
      let failed: request.Response;
      try {
        failed = await post(
          tokens.sellerA,
          saleBody(productId, { clientOperationId: key }),
        );
      } finally {
        auditModel.create =
          originalCreate as unknown as typeof auditModel.create;
      }
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(await remainingOf(productId)).toBe(5);
      expect(await countFor(productId)).toEqual({ sales: 0, sold: 0 });
      expect(await operationsFor(key)).toBe(0);
      expect(emitSpy).not.toHaveBeenCalled();

      const retry = await post(
        tokens.sellerA,
        saleBody(productId, { clientOperationId: key }),
      );
      expect(retry.status).toBe(201);
      expect(await remainingOf(productId)).toBe(3);
      expect(await operationsFor(key)).toBe(1);
    });

    it('stock insuffisant → 400 INSUFFICIENT_STOCK sans opération ; retry après réapprovisionnement réussit', async () => {
      const productId = await seedProduct(ORG_A, 1);
      const key = randomUUID();
      const res = await post(
        tokens.sellerA,
        saleBody(productId, { clientOperationId: key }),
      );
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'INSUFFICIENT_STOCK',
        message: 'Not enough stock. Available: 1',
        available: 1,
      });
      expect(await operationsFor(key)).toBe(0);

      await productModel.updateOne(
        { _id: new Types.ObjectId(productId) },
        { $set: { remainingQuantity: 5 } },
      );
      const retry = await post(
        tokens.sellerA,
        saleBody(productId, { clientOperationId: key }),
      );
      expect(retry.status).toBe(201);
      expect(await remainingOf(productId)).toBe(3);
      expect(await countFor(productId)).toEqual({ sales: 1, sold: 1 });
    });

    it('produit absent → 404 PRODUCT_NOT_FOUND, message historique conservé', async () => {
      const missing = new Types.ObjectId().toString();
      const res = await post(
        tokens.sellerA,
        saleBody(missing, { clientOperationId: randomUUID() }),
      );
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        code: 'PRODUCT_NOT_FOUND',
        message: `Product ${missing} not found`,
      });
    });

    it('vente supprimée puis rejeu → 409 SALE_OPERATION_ALREADY_APPLIED, stock inchangé', async () => {
      const productId = await seedProduct(ORG_A, 10);
      const key = randomUUID();
      const created = await post(
        tokens.ownerA,
        saleBody(productId, { clientOperationId: key }),
      );
      expect(created.status).toBe(201);
      const removed = await request(app.getHttpServer())
        .delete(`/sales/${created.body._id as string}`)
        .set('Authorization', `Bearer ${tokens.ownerA}`);
      expect(removed.status).toBe(204);
      expect(await remainingOf(productId)).toBe(10);

      const replay = await post(
        tokens.ownerA,
        saleBody(productId, { clientOperationId: key }),
      );
      expect(replay.status).toBe(409);
      expect(replay.body.code).toBe('SALE_OPERATION_ALREADY_APPLIED');
      expect(await remainingOf(productId)).toBe(10);
      expect(await countFor(productId)).toEqual({ sales: 0, sold: 1 });
    });
  });

  describe('3. tenant, vendeur, accès', () => {
    it('même clé en A et en B → deux ventes indépendantes', async () => {
      const productA = await seedProduct(ORG_A, 10);
      const productB = await seedProduct(ORG_B, 10);
      const key = randomUUID();
      const a = await post(
        tokens.ownerA,
        saleBody(productA, { clientOperationId: key }),
      );
      const b = await post(
        tokens.ownerB,
        saleBody(productB, { clientOperationId: key }),
      );
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(a.body._id).not.toBe(b.body._id);
      expect(await operationsFor(key)).toBe(2);
      expect(await remainingOf(productA)).toBe(8);
      expect(await remainingOf(productB)).toBe(8);
    });

    it('autre vendeur de la même org → 409 IDEMPOTENCY_KEY_CONFLICT sans aucune donnée', async () => {
      const productId = await seedProduct(ORG_A, 10);
      const key = randomUUID();
      const first = await post(
        tokens.sellerA,
        saleBody(productId, { clientOperationId: key }),
      );
      expect(first.status).toBe(201);
      const res = await post(
        tokens.sellerA2,
        saleBody(productId, { clientOperationId: key }),
      );
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain(first.body._id as string);
      expect(raw).not.toContain('Client 1-11C.1');
      expect(raw).not.toContain(String(userIds.sellerA));
      expect(await countFor(productId)).toEqual({ sales: 1, sold: 1 });
    });

    it('organizationId/sellerId/userId forgés → 400, aucune écriture', async () => {
      const productId = await seedProduct(ORG_A, 10);
      for (const field of ['organizationId', 'sellerId', 'userId']) {
        const res = await post(
          tokens.sellerA,
          saleBody(productId, {
            clientOperationId: randomUUID(),
            [field]: ORG_B,
          }),
        );
        expect(res.status).toBe(400);
      }
      expect(await remainingOf(productId)).toBe(10);
      expect(await countFor(productId)).toEqual({ sales: 0, sold: 0 });
    });

    it('membership révoquée → 403 (y compris rejeu d’une clé déjà appliquée)', async () => {
      const productId = await seedProduct(ORG_A, 10);
      const key = randomUUID();
      expect(
        (
          await post(
            tokens.sellerA2,
            saleBody(productId, { clientOperationId: key }),
          )
        ).status,
      ).toBe(201);
      await membershipModel.updateOne(
        { userId: userIds.sellerA2, organizationId: new Types.ObjectId(ORG_A) },
        { $set: { status: 'revoked' } },
      );
      const replay = await post(
        tokens.sellerA2,
        saleBody(productId, { clientOperationId: key }),
      );
      expect(replay.status).toBe(403);
      expect(replay.body.code).toBe('ORGANIZATION_ACCESS_DENIED');
      const fresh = await post(
        tokens.sellerA2,
        saleBody(productId, { clientOperationId: randomUUID() }),
      );
      expect(fresh.status).toBe(403);
      expect(await remainingOf(productId)).toBe(8);
      expect(await countFor(productId)).toEqual({ sales: 1, sold: 1 });
    });

    it('organisation suspendue → 403, aucune écriture', async () => {
      const productId = await seedProduct(ORG_C, 10);
      await organizationModel.updateOne(
        { _id: new Types.ObjectId(ORG_C) },
        { $set: { status: 'suspended' } },
      );
      const key = randomUUID();
      const res = await post(
        tokens.ownerC,
        saleBody(productId, { clientOperationId: key }),
      );
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ORGANIZATION_ACCESS_DENIED');
      expect(await operationsFor(key)).toBe(0);
      expect(await remainingOf(productId)).toBe(10);
    });
  });

  describe('4. occurredAt et analytics', () => {
    it('quantity décimale → 400 ; occurredAt non UTC → 400', async () => {
      const productId = await seedProduct(ORG_A, 10);
      expect(
        (await post(tokens.sellerA, saleBody(productId, { quantity: 1.5 })))
          .status,
      ).toBe(400);
      expect(
        (
          await post(
            tokens.sellerA,
            saleBody(productId, { occurredAt: '2026-09-20T10:00:00+01:00' }),
          )
        ).status,
      ).toBe(400);
      expect(await remainingOf(productId)).toBe(10);
    });

    it('occurredAt hors plage (−15 j, +10 min) → 400 SALE_DATE_OUT_OF_RANGE, aucune écriture', async () => {
      const productId = await seedProduct(ORG_A, 10);
      for (const delta of [-15 * DAY_MS, 10 * 60 * 1000]) {
        const key = randomUUID();
        const res = await post(
          tokens.sellerA,
          saleBody(productId, {
            clientOperationId: key,
            occurredAt: new Date(Date.now() + delta).toISOString(),
          }),
        );
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('SALE_DATE_OUT_OF_RANGE');
        expect(await operationsFor(key)).toBe(0);
      }
      expect(await remainingOf(productId)).toBe(10);
    });

    it('occurredAt fourni est stocké ; absent → heure serveur ; createdAt reste technique', async () => {
      const productId = await seedProduct(ORG_A, 10);
      const at = new Date(Date.now() - 3 * DAY_MS);
      at.setUTCMilliseconds(0);
      const withDate = await post(
        tokens.sellerA,
        saleBody(productId, { occurredAt: at.toISOString() }),
      );
      expect(withDate.status).toBe(201);
      expect(withDate.body.occurredAt).toBe(at.toISOString());
      expect(
        new Date(withDate.body.createdAt as string).getTime(),
      ).toBeGreaterThan(at.getTime());

      const before = Date.now();
      const without = await post(tokens.sellerA, saleBody(productId));
      expect(without.status).toBe(201);
      expect(
        new Date(without.body.occurredAt as string).getTime(),
      ).toBeGreaterThanOrEqual(before - 1000);
    });

    it('analytics : période sur occurredAt, repli createdAt pour les ventes anciennes', async () => {
      const productId = new Types.ObjectId();
      const base = {
        organizationId: new Types.ObjectId(ORG_A),
        productId,
        productName: 'Legacy',
        sellerId: userIds.ownerA,
      };
      // Écritures brutes (driver) : `createdAt` imposé, hors timestamps Mongoose.
      await saleModel.collection.insertMany([
        // vente ancienne SANS occurredAt → comptée sur createdAt (2025-02).
        {
          ...base,
          quantity: 3,
          salePrice: 10,
          createdAt: new Date(2025, 1, 10, 12),
        },
        // occurredAt 2025-01, persistée en 2025-03 → comptée en 2025-01.
        {
          ...base,
          quantity: 5,
          salePrice: 10,
          occurredAt: new Date(2025, 0, 20, 12),
          createdAt: new Date(2025, 2, 5, 12),
        },
      ]);

      const monthly = await request(app.getHttpServer())
        .get('/analytics/monthly')
        .set('Authorization', `Bearer ${tokens.ownerA}`);
      expect(monthly.status).toBe(200);
      const byPeriod = new Map(
        (monthly.body as Array<{ period: string; totalUnitsSold: number }>).map(
          (m) => [m.period, m.totalUnitsSold],
        ),
      );
      expect(byPeriod.get('2025-01')).toBe(5);
      expect(byPeriod.get('2025-02')).toBe(3);
      expect(byPeriod.has('2025-03')).toBe(false);

      const overview = async (month: string) =>
        (
          await request(app.getHttpServer())
            .get(`/analytics/overview?month=${month}`)
            .set('Authorization', `Bearer ${tokens.ownerA}`)
        ).body as { unitsSold: number };
      expect((await overview('2025-01')).unitsSold).toBe(5);
      expect((await overview('2025-02')).unitsSold).toBe(3);
      expect((await overview('2025-03')).unitsSold).toBe(0);
    });
  });
});
