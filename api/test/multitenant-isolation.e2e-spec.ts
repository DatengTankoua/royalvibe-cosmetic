import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';
import request, { Response } from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AuditLogDocument } from './../src/audit/schemas/audit-log.schema';
import { EventsGateway } from './../src/events/events.gateway';
import {
  buildHttpCorsOptions,
  buildOriginAllowlist,
  parseCORSOrigin,
} from './../src/events/origin.helpers';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { Organization } from './../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from './../src/organizations/schemas/organization.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import { ProductDocument } from './../src/products/schemas/product.schema';
import { S3Service } from './../src/s3/s3.service';
import { SaleDocument } from './../src/sales/schemas/sale.schema';
import { SectionDocument } from './../src/sections/schemas/section.schema';
import { UserDocument, UserRole } from './../src/users/schemas/user.schema';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';

const JWT_SECRET = 'phase-1-4e-e2e-only-secret';
const ADMIN_EMAIL = 'admin-14e@royalvibe.test';
const ADMIN_PASSWORD = 'admin-14e-pw-!1x';
const ORG_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ORG_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const ORIGIN = 'https://phase-1-4e.example.com';

function messageOf(body: unknown): string {
  const message = (body as { message?: string | string[] }).message;
  return Array.isArray(message) ? message.join(' ') : String(message ?? '');
}

function expectForeignLikeMissing(
  foreign: Response,
  missing: Response,
  foreignId: string,
  missingId: string,
): void {
  expect(foreign.status).toBe(404);
  expect(missing.status).toBe(404);
  expect(messageOf(foreign.body).replace(foreignId, '<id>')).toBe(
    messageOf(missing.body).replace(missingId, '<id>'),
  );
}

function ids(rows: Array<{ _id: string }>): string[] {
  return rows.map((row) => String(row._id)).sort();
}

describe('Phase 1-4E — portail transversal d’isolation multi-tenant', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let tokenA = '';
  let tokenB = '';
  let adminId = '';

  let userModel: Model<UserDocument>;
  let organizationModel: Model<OrganizationDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;
  let sectionModel: Model<SectionDocument>;
  let productModel: Model<ProductDocument>;
  let saleModel: Model<SaleDocument>;
  let auditModel: Model<AuditLogDocument>;

  let sectionA = '';
  let sectionB = '';
  let trashedSectionA = '';
  let trashedSectionB = '';
  let productA = '';
  let productB = '';
  let trashedProductA = '';
  let trashedProductB = '';
  let saleA = '';
  let saleB = '';
  let emitToOrganizationSpy: jest.SpyInstance;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const login = (organizationId: string) =>
    request(app.getHttpServer()).post('/auth/login').send({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      organizationId,
    });

  const createSale = (token: string, productId: string, quantity: number) =>
    request(app.getHttpServer())
      .post('/sales')
      .set(auth(token))
      .send({ productId, quantity, salePrice: 400, buyerName: 'Gate 1-4E' });

  const sectionSnapshot = (id: string) =>
    sectionModel.findById(id).lean().exec();
  const productSnapshot = (id: string) =>
    productModel.findById(id).lean().exec();
  const saleSnapshot = (id: string) => saleModel.findById(id).lean().exec();

  const analyticsSnapshot = async (token: string) => {
    const endpoints = [
      '/analytics/overview',
      '/analytics/products/ranking',
      '/analytics/sellers/ranking',
      '/analytics/monthly',
    ];
    const responses = await Promise.all(
      endpoints.map((endpoint) =>
        request(app.getHttpServer()).get(endpoint).set(auth(token)),
      ),
    );
    for (const response of responses) expect(response.status).toBe(200);
    const products = [
      ...(responses[1].body as Array<{ productId: string }>),
    ].sort((left, right) =>
      String(left.productId).localeCompare(String(right.productId)),
    );
    const sellers = [
      ...(responses[2].body as Array<{ sellerId: string }>),
    ].sort((left, right) =>
      String(left.sellerId).localeCompare(String(right.sellerId)),
    );
    return [responses[0].body as unknown, products, sellers, responses[3].body];
  };

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      process.env.MONGODB_URI = validatedEphemeralUri(replSet);
      process.env.JWT_SECRET = JWT_SECRET;
      process.env.S3_ENDPOINT = 'http://127.0.0.1:65535';
      process.env.S3_REGION = 'us-east-1';
      process.env.S3_ACCESS_KEY = 'e2e-local';
      process.env.S3_SECRET_KEY = 'e2e-local';
      process.env.S3_BUCKET = 'e2e-local';
      process.env.S3_FORCE_PATH_STYLE = 'true';
      process.env.CORS_ORIGIN = ORIGIN;
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';

      moduleFixture = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = moduleFixture.createNestApplication();
      app.enableCors(
        buildHttpCorsOptions(
          buildOriginAllowlist(parseCORSOrigin(ORIGIN, 'development')),
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

      userModel = moduleFixture.get(getModelToken('User'));
      organizationModel = moduleFixture.get(getModelToken(Organization.name));
      membershipModel = moduleFixture.get(
        getModelToken(OrganizationMembership.name),
      );
      sectionModel = moduleFixture.get(getModelToken('Section'));
      productModel = moduleFixture.get(getModelToken('Product'));
      saleModel = moduleFixture.get(getModelToken('Sale'));
      auditModel = moduleFixture.get(getModelToken('AuditLog'));

      const registration = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          name: 'Admin Gate 1-4E',
          email: ADMIN_EMAIL,
          password: ADMIN_PASSWORD,
          // 1-6A : organizationName obligatoire ; l'org auto-cr\u00e9\u00e9e n'est
          // jamais utilis\u00e9e (org A/B cr\u00e9\u00e9es manuellement ci-dessous, login
          // toujours explicite).
          organizationName: 'Admin Gate 1-4E Org',
        });
      expect(registration.status).toBe(201);
      const admin = await userModel.findOne({ email: ADMIN_EMAIL });
      expect(admin).not.toBeNull();
      admin!.role = UserRole.ADMIN;
      await admin!.save();
      adminId = admin!._id.toString();

      await organizationModel.create([
        { _id: new Types.ObjectId(ORG_A), slug: 'gate-org-a', name: 'Gate A' },
        { _id: new Types.ObjectId(ORG_B), slug: 'gate-org-b', name: 'Gate B' },
      ]);
      await membershipModel.create([
        {
          organizationId: new Types.ObjectId(ORG_A),
          userId: admin!._id,
          role: 'owner',
          status: 'active',
        },
        {
          organizationId: new Types.ObjectId(ORG_B),
          userId: admin!._id,
          role: 'owner',
          status: 'active',
        },
      ]);

      const [loginA, loginB] = await Promise.all([login(ORG_A), login(ORG_B)]);
      expect(loginA.status).toBe(201);
      expect(loginB.status).toBe(201);
      tokenA = loginA.body.access_token as string;
      tokenB = loginB.body.access_token as string;

      const sections = await sectionModel.create([
        {
          organizationId: new Types.ObjectId(ORG_A),
          name: 'Active Section A',
          description: 'A',
          deletedAt: null,
          parentId: null,
        },
        {
          organizationId: new Types.ObjectId(ORG_B),
          name: 'Active Section B',
          description: 'B',
          deletedAt: null,
          parentId: null,
        },
        {
          organizationId: new Types.ObjectId(ORG_A),
          name: 'Trashed Section A',
          description: 'A trash',
          deletedAt: new Date('2026-01-01T00:00:00.000Z'),
          parentId: null,
        },
        {
          organizationId: new Types.ObjectId(ORG_B),
          name: 'Trashed Section B',
          description: 'B trash',
          deletedAt: new Date('2026-01-02T00:00:00.000Z'),
          parentId: null,
        },
      ]);
      [sectionA, sectionB, trashedSectionA, trashedSectionB] = sections.map(
        (section) => section._id.toString(),
      );

      const productIds = Array.from({ length: 4 }, () => new Types.ObjectId());
      await productModel.collection.insertMany([
        {
          _id: productIds[0],
          organizationId: new Types.ObjectId(ORG_A),
          sectionId: new Types.ObjectId(sectionA),
          name: 'Active Product A',
          imageUrl: null,
          purchasePrice: 100,
          salePrice: 400,
          initialQuantity: 20,
          remainingQuantity: 20,
          deletedAt: null,
        },
        {
          _id: productIds[1],
          organizationId: new Types.ObjectId(ORG_B),
          sectionId: new Types.ObjectId(sectionB),
          name: 'Active Product B',
          imageUrl: null,
          purchasePrice: 300,
          salePrice: 900,
          initialQuantity: 30,
          remainingQuantity: 30,
          deletedAt: null,
        },
        {
          _id: productIds[2],
          organizationId: new Types.ObjectId(ORG_A),
          sectionId: new Types.ObjectId(sectionA),
          name: 'Trashed Product A',
          imageUrl: null,
          purchasePrice: 50,
          salePrice: 150,
          initialQuantity: 4,
          remainingQuantity: 4,
          deletedAt: new Date('2026-01-03T00:00:00.000Z'),
        },
        {
          _id: productIds[3],
          organizationId: new Types.ObjectId(ORG_B),
          sectionId: new Types.ObjectId(sectionB),
          name: 'Trashed Product B',
          imageUrl: null,
          purchasePrice: 70,
          salePrice: 210,
          initialQuantity: 5,
          remainingQuantity: 5,
          deletedAt: new Date('2026-01-04T00:00:00.000Z'),
        },
      ]);
      [productA, productB, trashedProductA, trashedProductB] = productIds.map(
        (productId) => productId.toString(),
      );

      const gateway = moduleFixture.get(EventsGateway);
      emitToOrganizationSpy = jest.spyOn(gateway, 'emitToOrganization');
      const [createdA, createdB] = await Promise.all([
        createSale(tokenA, productA, 2),
        createSale(tokenB, productB, 3),
      ]);
      expect(createdA.status).toBe(201);
      expect(createdB.status).toBe(201);
      saleA = createdA.body._id as string;
      saleB = createdB.body._id as string;
    } catch (error) {
      if (moduleFixture) await moduleFixture.close().catch(() => undefined);
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  afterAll(async () => {
    emitToOrganizationSpy?.mockRestore();
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  it('1. token A voit uniquement les sections et produits actifs A', async () => {
    const [sections, products] = await Promise.all([
      request(app.getHttpServer()).get('/sections').set(auth(tokenA)),
      request(app.getHttpServer()).get('/products').set(auth(tokenA)),
    ]);
    expect(sections.status).toBe(200);
    expect(products.status).toBe(200);
    expect(ids(sections.body as Array<{ _id: string }>)).toContain(sectionA);
    expect(ids(sections.body as Array<{ _id: string }>)).not.toContain(
      sectionB,
    );
    const productIds = (
      products.body as Array<{ product: { _id: string } }>
    ).map((row) => String(row.product._id));
    expect(productIds).toContain(productA);
    expect(productIds).not.toContain(productB);
  });

  it('2. toute opération Section B avec token A est un 404 absent et laisse B inchangée', async () => {
    const before = await sectionSnapshot(sectionB);
    const operations = [
      { method: 'get', path: (id: string) => `/sections/${id}` },
      { method: 'patch', path: (id: string) => `/sections/${id}` },
      { method: 'delete', path: (id: string) => `/sections/${id}` },
      { method: 'patch', path: (id: string) => `/sections/${id}/restore` },
      { method: 'delete', path: (id: string) => `/sections/${id}/permanent` },
    ] as const;

    for (const operation of operations) {
      const missingId = new Types.ObjectId().toString();
      const send = (id: string) => {
        const call = request(app.getHttpServer())
          [operation.method](operation.path(id))
          .set(auth(tokenA));
        return operation.method === 'patch' &&
          !operation.path(id).endsWith('restore')
          ? call.send({ name: 'FORBIDDEN SECTION MUTATION' })
          : call;
      };
      expectForeignLikeMissing(
        await send(sectionB),
        await send(missingId),
        sectionB,
        missingId,
      );
      expect(await sectionSnapshot(sectionB)).toEqual(before);
    }
  });

  it('3. même matrice Produit B, sans appel S3 et avec état B inchangé', async () => {
    const before = await productSnapshot(productB);
    const s3 = moduleFixture.get(S3Service);
    const deleteFile = jest
      .spyOn(s3, 'deleteFile')
      .mockResolvedValue(undefined);
    const operations = [
      { method: 'get', path: (id: string) => `/products/${id}` },
      { method: 'patch', path: (id: string) => `/products/${id}` },
      { method: 'delete', path: (id: string) => `/products/${id}` },
      { method: 'patch', path: (id: string) => `/products/${id}/restore` },
      { method: 'delete', path: (id: string) => `/products/${id}/permanent` },
    ] as const;

    for (const operation of operations) {
      const missingId = new Types.ObjectId().toString();
      const send = (id: string) => {
        const call = request(app.getHttpServer())
          [operation.method](operation.path(id))
          .set(auth(tokenA));
        return operation.method === 'patch' &&
          !operation.path(id).endsWith('restore')
          ? call.send({ name: 'FORBIDDEN PRODUCT MUTATION' })
          : call;
      };
      expectForeignLikeMissing(
        await send(productB),
        await send(missingId),
        productB,
        missingId,
      );
      expect(await productSnapshot(productB)).toEqual(before);
    }
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('4-5. ventes A listées seules; vendre le produit B est sans effet parasite', async () => {
    const list = await request(app.getHttpServer())
      .get('/sales')
      .set(auth(tokenA));
    expect(list.status).toBe(200);
    const saleIds = ids(list.body as Array<{ _id: string }>);
    expect(saleIds).toContain(saleA);
    expect(saleIds).not.toContain(saleB);

    const stockBefore = (await productSnapshot(productB))!.remainingQuantity;
    const salesBefore = await saleModel.countDocuments();
    const auditsBefore = await auditModel.countDocuments();
    emitToOrganizationSpy.mockClear();
    const response = await createSale(tokenA, productB, 1);
    expect(response.status).toBe(404);
    expect(messageOf(response.body)).toBe(`Product ${productB} not found`);
    expect((await productSnapshot(productB))!.remainingQuantity).toBe(
      stockBefore,
    );
    expect(await saleModel.countDocuments()).toBe(salesBefore);
    expect(await auditModel.countDocuments()).toBe(auditsBefore);
    expect(emitToOrganizationSpy).not.toHaveBeenCalled();
  });

  it('6. PATCH/DELETE vente B avec token A sont des 404 absents sans mutation', async () => {
    const saleBefore = await saleSnapshot(saleB);
    const productBefore = await productSnapshot(productB);
    const auditsBefore = await auditModel.find().lean().exec();

    for (const method of ['patch', 'delete'] as const) {
      const missingId = new Types.ObjectId().toString();
      const send = (id: string) => {
        const call = request(app.getHttpServer())
          [method](`/sales/${id}`)
          .set(auth(tokenA));
        return method === 'patch' ? call.send({ quantity: 1 }) : call;
      };
      expectForeignLikeMissing(
        await send(saleB),
        await send(missingId),
        saleB,
        missingId,
      );
      expect(await saleSnapshot(saleB)).toEqual(saleBefore);
      expect(await productSnapshot(productB)).toEqual(productBefore);
      expect(await auditModel.find().lean().exec()).toEqual(auditsBefore);
    }
  });

  it('7. les quatre Analytics A restent identiques quand seules les données B varient', async () => {
    const before = await analyticsSnapshot(tokenA);
    const extraBId = new Types.ObjectId();
    await productModel.collection.insertOne({
      _id: extraBId,
      organizationId: new Types.ObjectId(ORG_B),
      sectionId: new Types.ObjectId(sectionB),
      name: 'Analytics Variation B',
      imageUrl: null,
      purchasePrice: 500,
      salePrice: 1500,
      initialQuantity: 50,
      remainingQuantity: 50,
      deletedAt: null,
    });
    expect((await createSale(tokenB, extraBId.toString(), 11)).status).toBe(
      201,
    );

    const after = await analyticsSnapshot(tokenA);
    expect(after).toEqual(before);
    const serialized = JSON.stringify(after);
    expect(serialized).not.toContain(extraBId.toString());
    expect(serialized).not.toContain('Analytics Variation B');
  });

  it('8. historique Audit A exclut un audit B frauduleux sur productId A', async () => {
    await auditModel.create({
      organizationId: new Types.ObjectId(ORG_B),
      productId: new Types.ObjectId(productA),
      action: 'price_changed',
      actorId: new Types.ObjectId(adminId),
      details: { marker: 'fraudulent-b-audit' },
    });
    const detail = await request(app.getHttpServer())
      .get(`/products/${productA}`)
      .set(auth(tokenA));
    expect(detail.status).toBe(200);
    const logs = detail.body.auditLogs as Array<{
      organizationId: string;
      details: { marker?: string };
    }>;
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs.every((log) => String(log.organizationId) === ORG_A)).toBe(
      true,
    );
    expect(
      logs.some((log) => log.details.marker === 'fraudulent-b-audit'),
    ).toBe(false);
  });

  it('9. GET /trash A retourne uniquement les sections et produits A', async () => {
    const response = await request(app.getHttpServer())
      .get('/trash')
      .set(auth(tokenA));
    expect(response.status).toBe(200);
    const sectionIds = ids(response.body.sections as Array<{ _id: string }>);
    const productIds = ids(response.body.products as Array<{ _id: string }>);
    expect(sectionIds).toContain(trashedSectionA);
    expect(sectionIds).not.toContain(trashedSectionB);
    expect(productIds).toContain(trashedProductA);
    expect(productIds).not.toContain(trashedProductB);
  });

  it('10. token B prouve la symétrie des lectures essentielles', async () => {
    const [sections, products, sales, trash, analytics] = await Promise.all([
      request(app.getHttpServer()).get('/sections').set(auth(tokenB)),
      request(app.getHttpServer()).get('/products').set(auth(tokenB)),
      request(app.getHttpServer()).get('/sales').set(auth(tokenB)),
      request(app.getHttpServer()).get('/trash').set(auth(tokenB)),
      analyticsSnapshot(tokenB),
    ]);
    for (const response of [sections, products, sales, trash]) {
      expect(response.status).toBe(200);
    }
    expect(ids(sections.body as Array<{ _id: string }>)).toContain(sectionB);
    expect(ids(sections.body as Array<{ _id: string }>)).not.toContain(
      sectionA,
    );
    const productIds = (
      products.body as Array<{ product: { _id: string } }>
    ).map((row) => String(row.product._id));
    expect(productIds).toContain(productB);
    expect(productIds).not.toContain(productA);
    expect(ids(sales.body as Array<{ _id: string }>)).toContain(saleB);
    expect(ids(sales.body as Array<{ _id: string }>)).not.toContain(saleA);
    expect(ids(trash.body.sections as Array<{ _id: string }>)).toContain(
      trashedSectionB,
    );
    expect(ids(trash.body.products as Array<{ _id: string }>)).toContain(
      trashedProductB,
    );
    expect(JSON.stringify(analytics)).not.toContain('Active Product A');
    expect(JSON.stringify(analytics)).not.toContain(productA);
  });

  it('11-12. organizationId B falsifié est rejeté ou ignoré et toute mutation reste en A', async () => {
    const before = await sectionSnapshot(sectionA);
    const bodyForgery = await request(app.getHttpServer())
      .patch(`/sections/${sectionA}`)
      .set(auth(tokenA))
      .send({ name: 'Forged', organizationId: ORG_B });
    expect(bodyForgery.status).toBe(400);
    expect(await sectionSnapshot(sectionA)).toEqual(before);

    const [sectionsA, productsA, salesA, trashA, analyticsA] =
      await Promise.all([
        request(app.getHttpServer()).get('/sections').set(auth(tokenA)),
        request(app.getHttpServer()).get('/products').set(auth(tokenA)),
        request(app.getHttpServer()).get('/sales').set(auth(tokenA)),
        request(app.getHttpServer()).get('/trash').set(auth(tokenA)),
        analyticsSnapshot(tokenA),
      ]);
    const forgedRequests = await Promise.all([
      request(app.getHttpServer())
        .get(`/sections?organizationId=${ORG_B}`)
        .set(auth(tokenA))
        .set('X-Organization-Id', ORG_B),
      request(app.getHttpServer())
        .get(`/products?organizationId=${ORG_B}`)
        .set(auth(tokenA))
        .set('X-Organization-Id', ORG_B),
      request(app.getHttpServer())
        .get(`/sales?organizationId=${ORG_B}`)
        .set(auth(tokenA))
        .set('X-Organization-Id', ORG_B),
      request(app.getHttpServer())
        .get(`/trash?organizationId=${ORG_B}`)
        .set(auth(tokenA))
        .set('X-Organization-Id', ORG_B),
      request(app.getHttpServer())
        .get(`/analytics/overview?organizationId=${ORG_B}`)
        .set(auth(tokenA))
        .set('X-Organization-Id', ORG_B),
    ]);
    for (const response of forgedRequests) expect(response.status).toBe(200);
    expect(forgedRequests[0].body).toEqual(sectionsA.body);
    expect(forgedRequests[1].body).toEqual(productsA.body);
    expect(forgedRequests[2].body).toEqual(salesA.body);
    expect(forgedRequests[3].body).toEqual(trashA.body);
    expect(forgedRequests[4].body).toEqual(analyticsA[0]);
    expect(await sectionSnapshot(sectionA)).toEqual(before);
  });
});
