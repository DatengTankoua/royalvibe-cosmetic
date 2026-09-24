import 'reflect-metadata';
import { Model, Types } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
// 1-3B.1 : sans une org active, le login ne fournit plus de JWT.
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { UserDocument, UserRole } from './../src/users/schemas/user.schema';
import { ProductDocument } from './../src/products/schemas/product.schema';
import { SaleDocument } from './../src/sales/schemas/sale.schema';
import { AuditLogDocument } from './../src/audit/schemas/audit-log.schema';
import { Organization } from './../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from './../src/organizations/schemas/organization.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import { EventsGateway } from './../src/events/events.gateway';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';
import {
  buildOriginAllowlist,
  parseCORSOrigin,
  buildHttpCorsOptions,
} from './../src/events/origin.helpers';

/**
 * E2E (phase 0B.7B) — transaction atomique VENTE–STOCK–AUDIT.
 *
 * Réutilise l'infrastructure 0B.2 : `MongoMemoryReplSet` (binaire pinné 8.2.6,
 * base `inventory_saas_e2e`, garde anti-27017 `validatedEphemeralUri`,
 * arrêt complet + nettoyage `stopEphemeralMongoSafe`). Ce replica set est le
 * prérequis des transactions MongoDB — c'est lui qui permet d'observer un vrai
 * rollback et une vraie concurrence.
 *
 * `Promise.all` n'y est utilisé QUE pour lancer deux requêtes HTTP DISTINCTES
 * en concurrence : il n'entre jamais dans la logique de la transaction.
 * Aucun `sleep` réel, aucun hook de test dans le code de production.
 */

const TEST_JWT_SECRET = 'e2e-only-static-secret-not-production-use';
const ADMIN_EMAIL = 'admin-0b7@royalvibe.test';
const E2E_CORS_ORIGIN = 'https://e2e.example.com';
// 1-3B.1 : sans une org active, le login n'émet plus de JWT.
const TRADE_ORG_ID = 'dddddddddddddddddddddddd';

function messageOf(body: unknown): string {
  const m = (body as { message?: string | string[] } | undefined)?.message;
  return Array.isArray(m) ? m.join(' ') : String(m ?? '');
}

describe('App (e2e 0B.7B) — transaction atomique vente–stock–audit', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let adminToken = '';

  // modèles de la même connexion Mongoose que l'app (jamais la connexion
  // globale de mongoose) — pour les fixtures et les assertions.
  let userModel: Model<UserDocument>;
  let productModel: Model<ProductDocument>;
  let saleModel: Model<SaleDocument>;
  let auditModel: Model<AuditLogDocument>;
  let organizationModel: Model<OrganizationDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;

  let sectionId = '';

  /** Crée un produit SANS passer par S3 (imageUrl factice, écriture directe). */
  async function seedProduct(name: string, initialQuantity: number) {
    const p = await productModel.create({
      sectionId: new Types.ObjectId(sectionId),
      name,
      imageUrl: 'https://e2e.local/img.png',
      purchasePrice: 100,
      salePrice: 400,
      initialQuantity,
      remainingQuantity: initialQuantity,
    });
    return { id: p._id.toString(), product: p };
  }

  const remainingOf = async (productId: string) => {
    const p = await productModel.findById(productId).exec();
    return p!.remainingQuantity;
  };

  const createSale = (productId: string, quantity: number) =>
    request(app.getHttpServer())
      .post('/sales')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ productId, quantity, salePrice: 400, buyerName: 'Client E2E' });

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
      }).compile();
      app = moduleFixture.createNestApplication();
      const corsAllowlist = buildOriginAllowlist(
        parseCORSOrigin(process.env.CORS_ORIGIN, 'development'),
      );
      app.enableCors(buildHttpCorsOptions(corsAllowlist));
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
      );
      app.useGlobalFilters(new HttpExceptionFilter());
      await app.init();

      userModel = moduleFixture.get<Model<UserDocument>>(getModelToken('User'));
      productModel = moduleFixture.get<Model<ProductDocument>>(
        getModelToken('Product'),
      );
      saleModel = moduleFixture.get<Model<SaleDocument>>(getModelToken('Sale'));
      auditModel = moduleFixture.get<Model<AuditLogDocument>>(
        getModelToken('AuditLog'),
      );
      organizationModel = moduleFixture.get<Model<OrganizationDocument>>(
        getModelToken(Organization.name),
      );
      membershipModel = moduleFixture.get<
        Model<OrganizationMembershipDocument>
      >(getModelToken(OrganizationMembership.name));

      // ---- utilisateur admin de test ----
      const reg = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          name: 'Admin 0B.7',
          email: ADMIN_EMAIL,
          password: 'adm-0b7-pw-!1x',
        });
      expect(reg.status).toBe(201);
      const adminDoc = await userModel.findOne({ email: ADMIN_EMAIL });
      adminDoc!.role = UserRole.ADMIN;
      await adminDoc!.save();

      // ---- organisation + membership de l'admin (1-3B.1) ----
      await organizationModel.create({
        _id: TRADE_ORG_ID,
        slug: 'trade-e2e',
        name: 'Org Vente E2E',
      });
      await membershipModel.create({
        organizationId: new Types.ObjectId(TRADE_ORG_ID),
        userId: adminDoc!._id,
        role: 'owner',
        status: 'active',
      });

      // Une seule org active → sélection automatique (cas B, pas de
      // choix demandé par le client).
      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: ADMIN_EMAIL, password: 'adm-0b7-pw-!1x' });
      expect(login.status).toBe(201);
      adminToken = login.body.access_token as string;

      // ---- section de fixtures ----
      const sectionRes = await request(app.getHttpServer())
        .post('/sections')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `Section 0B.7-${Date.now()}` });
      expect(sectionRes.status).toBe(201);
      sectionId = sectionRes.body._id as string;
    } catch (err) {
      if (moduleFixture) await moduleFixture.close().catch(() => undefined);
      await stopEphemeralMongoSafe();
      throw err;
    }
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  describe('1. succès : stock 10, vente 3', () => {
    it('valide les trois écritures : 1 vente, stock 7, 1 audit SOLD', async () => {
      const { id } = await seedProduct(`Stock10-${Date.now()}`, 10);
      const salesBefore = await saleModel.countDocuments();
      const soldBefore = await auditModel.countDocuments({ action: 'sold' });

      const res = await createSale(id, 3);
      expect(res.status).toBe(201);

      expect(await remainingOf(id)).toBe(7);
      expect(await saleModel.countDocuments()).toBe(salesBefore + 1);
      expect(await auditModel.countDocuments({ action: 'sold' })).toBe(
        soldBefore + 1,
      );
      // l'audit référence la vente réellement créée :
      const sale = await saleModel
        .find({ productId: new Types.ObjectId(id) })
        .exec();
      expect(sale).toHaveLength(1);
      const latestSold = (
        await auditModel.find().sort({ createdAt: -1 }).limit(1).exec()
      )[0];
      expect(String(latestSold.details.saleId)).toBe(sale[0]._id.toString());
    });
  });

  describe('2. stock insuffisant : 400 exact, aucun effet', () => {
    it('refuse avec le message métier exact, stock inchangé, ni vente ni audit', async () => {
      const { id } = await seedProduct(`Stock1-${Date.now()}`, 1);
      const salesBefore = await saleModel.countDocuments();
      const soldBefore = await auditModel.countDocuments({ action: 'sold' });

      const res = await createSale(id, 5);
      expect(res.status).toBe(400);
      expect(messageOf(res.body)).toBe('Not enough stock. Available: 1');

      expect(await remainingOf(id)).toBe(1);
      expect(await saleModel.countDocuments()).toBe(salesBefore);
      expect(await auditModel.countDocuments({ action: 'sold' })).toBe(
        soldBefore,
      );
    });
  });

  describe('3. échec volontaire de AuditService.log : rollback complet', () => {
    it('aucune vente, stock restauré, aucun audit SOLD', async () => {
      const { id } = await seedProduct(`Rollback-${Date.now()}`, 4);
      const stockBefore = await remainingOf(id);
      const salesBefore = await saleModel.countDocuments();
      const soldBefore = await auditModel.countDocuments({ action: 'sold' });

      // Échec injecté DANS la transaction : l'écriture d'audit de la vente est
      // la seule `create` d'audit qui reçoit une `session` active → on rejette
      // pour imiter une panne en mi-transaction. Les écritures d'audit des
      // fixtures (sans session) passent normalement.
      const originalCreate = auditModel.create.bind(auditModel) as (
        docs: unknown,
        opts?: { session?: unknown },
      ) => Promise<unknown>;
      auditModel.create = ((docs: unknown, opts?: { session?: unknown }) => {
        if (opts?.session) {
          return Promise.reject(
            new Error('simulated mid-transaction audit failure'),
          );
        }
        return originalCreate(docs, opts);
      }) as unknown as typeof auditModel.create;

      let res: request.Response;
      try {
        res = await createSale(id, 2);
      } finally {
        auditModel.create =
          originalCreate as unknown as typeof auditModel.create;
      }

      // la transaction a échoué (erreur non-HTTP remontée → 5xx) :
      expect(res.status).toBeGreaterThanOrEqual(500);

      // ROLLBACK prouvé sur le replset :
      expect(await remainingOf(id)).toBe(stockBefore);
      expect(await saleModel.countDocuments()).toBe(salesBefore);
      expect(await auditModel.countDocuments({ action: 'sold' })).toBe(
        soldBefore,
      );
    });
  });

  describe('4. concurrence : deux ventes du dernier article', () => {
    it('exactement une réussit, une refusée métier, stock final 0', async () => {
      const { id } = await seedProduct(`Racing-${Date.now()}`, 1);
      const salesBefore = await saleModel.countDocuments();
      const soldBefore = await auditModel.countDocuments({ action: 'sold' });

      // Deux requêtes HTTP DISTINCTES lancées en concurrence UNIQUEMENT ici
      // (jamais à l'intérieur d'une transaction) :
      const [a, b] = await Promise.all([createSale(id, 1), createSale(id, 1)]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 400]);

      const failed = a.status === 400 ? a : b;
      expect(messageOf(failed.body)).toBe('Not enough stock. Available: 0');

      const stock = await remainingOf(id);
      expect(stock).toBe(0); // jamais négatif
      expect(stock).not.toBeLessThan(0);
      expect(await saleModel.countDocuments()).toBe(salesBefore + 1); // une seule
      expect(await auditModel.countDocuments({ action: 'sold' })).toBe(
        soldBefore + 1, // un seul audit
      );
      const sales = await saleModel
        .find({ productId: new Types.ObjectId(id) })
        .exec();
      expect(sales).toHaveLength(1);
    });
  });

  describe('4B. produit corbeillé : 404 métier, aucun effet', () => {
    it('vente refusée 404, ni vente ni audit ni stock ni événement', async () => {
      // produit ACTIF avec du stock, puis placé dans la corbeille :
      const { id } = await seedProduct(`Trashed-${Date.now()}`, 3);
      const productDoc = await productModel.findById(id).exec();
      productDoc!.deletedAt = new Date();
      await productDoc!.save();

      const salesBefore = await saleModel.countDocuments();
      const soldBefore = await auditModel.countDocuments({ action: 'sold' });

      // espion : aucune émission de `sale:created` ne doit avoir lieu :
      const gateway = moduleFixture.get(EventsGateway);
      const realEmit = gateway.emit.bind(gateway);
      let saleCreated = 0;
      gateway.emit = (event: string, payload: unknown) => {
        if (event === 'sale:created') saleCreated += 1;
        return realEmit(event, payload);
      };

      const res = await createSale(id, 1);
      expect(res.status).toBe(404);
      expect(messageOf(res.body)).toBe(`Product ${id} not found`);

      expect(await saleModel.countDocuments()).toBe(salesBefore);
      expect(await auditModel.countDocuments({ action: 'sold' })).toBe(
        soldBefore,
      );
      // le stock n'a pas été décrémenté :
      expect(await remainingOf(id)).toBe(3);
      // aucun événement post-commit :
      expect(saleCreated).toBe(0);

      gateway.emit = realEmit;
    });
  });

  describe('5. Socket.IO : événement uniquement après le commit', () => {
    it('un appel après succès, zéro appel supplémentaire après rollback', async () => {
      const gateway = moduleFixture.get(EventsGateway);
      const realEmit = gateway.emit.bind(gateway);
      let saleCreated = 0;
      gateway.emit = (event: string, payload: unknown) => {
        if (event === 'sale:created') saleCreated += 1;
        return realEmit(event, payload);
      };

      // succès → 1 émission :
      const { id } = await seedProduct(`Emit-${Date.now()}`, 5);
      const ok = await createSale(id, 2);
      expect(ok.status).toBe(201);
      expect(saleCreated).toBe(1);

      // rollback (audit en panne, AVEC session) → aucune émission
      // supplémentaire : l'emit ne part que post-commit.
      const originalCreate = auditModel.create.bind(auditModel) as (
        docs: unknown,
        opts?: { session?: unknown },
      ) => Promise<unknown>;
      auditModel.create = ((docs: unknown, opts?: { session?: unknown }) => {
        if (opts?.session) {
          return Promise.reject(new Error('forced rollback, no emit'));
        }
        return originalCreate(docs, opts);
      }) as unknown as typeof auditModel.create;
      try {
        const failed = await createSale(id, 2);
        expect(failed.status).toBeGreaterThanOrEqual(500);
      } finally {
        auditModel.create =
          originalCreate as unknown as typeof auditModel.create;
      }
      expect(saleCreated).toBe(1);

      // restauration de l'émition réelle :
      gateway.emit = realEmit;
    });
  });
});
