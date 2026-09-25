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
// 1-4C.1 : seconde org pour prouver l'isolation de la vente.
const ADMIN_B_EMAIL = 'admin-b-14c1@royalvibe.test';
const E2E_CORS_ORIGIN = 'https://e2e.example.com';
// 1-3B.1 : sans une org active, le login ne fournit plus de JWT.
const TRADE_ORG_ID = 'dddddddddddddddddddddddd';
// Org B (1-4C.1) : un tenant distinct des fixtures et des assertions.
const ORG_B_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';

function messageOf(body: unknown): string {
  const m = (body as { message?: string | string[] } | undefined)?.message;
  return Array.isArray(m) ? m.join(' ') : String(m ?? '');
}

describe('App (e2e 0B.7B) — transaction atomique vente–stock–audit', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let adminToken = '';
  let adminBToken = '';

  // modèles de la même connexion Mongoose que l'app (jamais la connexion
  // globale de mongoose) — pour les fixtures et les assertions.
  let userModel: Model<UserDocument>;
  let productModel: Model<ProductDocument>;
  let saleModel: Model<SaleDocument>;
  let auditModel: Model<AuditLogDocument>;
  let organizationModel: Model<OrganizationDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;

  // Sections par org (fix via HTTP /sections, token propre à chaque org) :
  let sectionId = ''; // org A
  let sectionIdB = ''; // org B (1-4C.1)

  /**
   * Crée un produit SANS passer par S3 (imageUrl factice, écriture directe).
   * 1-4C.1 : `organizationId` est écrite dans le document — un produit de A
   * est invisible à B (mêmes nom/champs = 404 pour un tenant étranger).
   */
  async function seedProduct(
    name: string,
    initialQuantity: number,
    org: string = TRADE_ORG_ID,
    section: string = '',
  ) {
    const p = await productModel.create({
      sectionId: new Types.ObjectId(section || sectionId),
      name,
      imageUrl: 'https://e2e.local/img.png',
      purchasePrice: 100,
      salePrice: 400,
      initialQuantity,
      remainingQuantity: initialQuantity,
      organizationId: new Types.ObjectId(org),
    });
    return { id: p._id.toString(), product: p };
  }

  const remainingOf = async (productId: string) => {
    const p = await productModel.findById(productId).exec();
    return p!.remainingQuantity;
  };

  const createSale = (
    productId: string,
    quantity: number,
    token: string = adminToken,
  ) =>
    request(app.getHttpServer())
      .post('/sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ productId, quantity, salePrice: 400, buyerName: 'Client E2E' });

  const listSales = (token: string) =>
    request(app.getHttpServer())
      .get('/sales')
      .set('Authorization', `Bearer ${token}`);

  const updateSale = (
    saleId: string,
    body: Record<string, unknown>,
    token: string,
  ) =>
    request(app.getHttpServer())
      .patch(`/sales/${saleId}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const removeSale = (saleId: string, token: string) =>
    request(app.getHttpServer())
      .delete(`/sales/${saleId}`)
      .set('Authorization', `Bearer ${token}`);

  /** 1-4C.1 : compteurs tenant — ventes + audits `sold` d'une org précise. */
  const salesOfOrg = async (org: string) =>
    saleModel.countDocuments({ organizationId: new Types.ObjectId(org) });
  const soldAuditsOfOrg = async (org: string) =>
    auditModel.countDocuments({
      organizationId: new Types.ObjectId(org),
      action: 'sold',
    });

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

      // 1-4C.1 : seconde org (B) + son admin + login dédié.
      const regB = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          name: 'Admin B 1-4C.1',
          email: ADMIN_B_EMAIL,
          password: 'adm-b-14c1-pw-!1x',
        });
      expect(regB.status).toBe(201);
      const adminBUser = await userModel.findOne({ email: ADMIN_B_EMAIL });
      adminBUser!.role = UserRole.ADMIN;
      await adminBUser!.save();

      await organizationModel.create({
        _id: ORG_B_ID,
        slug: 'org-b-14c1',
        name: 'Org B 1-4C.1',
      });
      await membershipModel.create({
        organizationId: new Types.ObjectId(ORG_B_ID),
        userId: adminBUser!._id,
        role: 'owner',
        status: 'active',
      });

      // L'admin A a DEUX orgs actives (A puis B) → le login de A DOIT
      // explicitement choisir TRADE_ORG_ID (jamais de sélection implicite).
      const loginA = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: ADMIN_EMAIL,
          password: 'adm-0b7-pw-!1x',
          organizationId: TRADE_ORG_ID,
        });
      expect(loginA.status).toBe(201);
      adminToken = loginA.body.access_token as string;

      // L'admin B est mono-org B → sélection automatique.
      const loginB = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: ADMIN_B_EMAIL, password: 'adm-b-14c1-pw-!1x' });
      expect(loginB.status).toBe(201);
      adminBToken = loginB.body.access_token as string;

      // ---- sections de fixtures ----
      const sectionRes = await request(app.getHttpServer())
        .post('/sections')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `Section A-${Date.now()}` });
      expect(sectionRes.status).toBe(201);
      sectionId = sectionRes.body._id as string;

      const sectionBRes = await request(app.getHttpServer())
        .post('/sections')
        .set('Authorization', `Bearer ${adminBToken}`)
        .send({ name: `Section B-${Date.now()}` });
      expect(sectionBRes.status).toBe(201);
      sectionIdB = sectionBRes.body._id as string;
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
      // 1-4C.1 : la vente est attachée à l'org A — B n'a AUCUNE vente :
      expect(sale[0].organizationId.toString()).toBe(TRADE_ORG_ID);
      expect(await salesOfOrg(ORG_B_ID)).toBe(0);
      const latestSold = (
        await auditModel.find().sort({ createdAt: -1 }).limit(1).exec()
      )[0];
      expect(String(latestSold.details.saleId)).toBe(sale[0]._id.toString());
      expect(latestSold.organizationId.toString()).toBe(TRADE_ORG_ID);
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
      // 1-4C.1 : la seule vente est attachée à A (jamais à B) :
      expect(sales[0].organizationId.toString()).toBe(TRADE_ORG_ID);
      expect(await salesOfOrg(ORG_B_ID)).toBe(0);
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
      const emitSpy = jest.spyOn(gateway, 'emitToOrganization');

      try {
        const res = await createSale(id, 1);
        expect(res.status).toBe(404);
        expect(messageOf(res.body)).toBe(`Product ${id} not found`);

        expect(await saleModel.countDocuments()).toBe(salesBefore);
        expect(await auditModel.countDocuments({ action: 'sold' })).toBe(
          soldBefore,
        );
        expect(await remainingOf(id)).toBe(3);
        expect(emitSpy).not.toHaveBeenCalled();
      } finally {
        emitSpy.mockRestore();
      }
    });
  });

  describe('5. Socket.IO : événement uniquement après le commit', () => {
    it('un appel après succès, zéro appel supplémentaire après rollback', async () => {
      const gateway = moduleFixture.get(EventsGateway);
      const emitSpy = jest.spyOn(gateway, 'emitToOrganization');

      // succès → 1 émission :
      const { id } = await seedProduct(`Emit-${Date.now()}`, 5);
      const ok = await createSale(id, 2);
      expect(ok.status).toBe(201);
      expect(emitSpy).toHaveBeenCalledTimes(1);
      expect(emitSpy).toHaveBeenCalledWith(
        TRADE_ORG_ID,
        'sale:created',
        expect.objectContaining({
          _id: expect.anything(),
          organizationId: expect.anything(),
        }),
      );
      emitSpy.mockClear();

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
      expect(emitSpy).not.toHaveBeenCalled();
      emitSpy.mockRestore();
    });
  });
  /**
   * 6. Isolation multi-tenant de la vente (1-4C.1) — deux orgs A/B :
   * le stock, la vente et l'audit de A n'existent JAMAIS dans B, et
   * réciproquement. Un produit de B vendu avec un token A est
   * indistinguable d'un produit absent (même 404, zéro fuite).
   */
  describe('6. Isolation multi-tenant de la vente (1-4C.1)', () => {
    it('vente A sur produit A : ventes A +1, audit SOLD A +1, B intouché (zéro vente, zéro audit, stock intact)', async () => {
      const { id } = await seedProduct(
        'IsoA-' + Date.now(),
        5,
        TRADE_ORG_ID,
        sectionId,
      );
      const aBefore = await salesOfOrg(TRADE_ORG_ID);
      const bBefore = await salesOfOrg(ORG_B_ID);
      const soldABefore = await soldAuditsOfOrg(TRADE_ORG_ID);
      const soldBefore = await soldAuditsOfOrg(ORG_B_ID);
      const bStock = await seedProduct(
        'IsoB-' + Date.now(),
        9,
        ORG_B_ID,
        sectionIdB,
      );

      const res = await createSale(id, 2);
      expect(res.status).toBe(201);

      expect(await remainingOf(id)).toBe(3);
      expect(await salesOfOrg(TRADE_ORG_ID)).toBe(aBefore + 1);
      expect(await soldAuditsOfOrg(TRADE_ORG_ID)).toBe(soldABefore + 1);
      // B : AUCUNE vente, AUCUN audit, stock INTACT (le décompte n'a pas
      // touché le tenant B) :
      expect(await salesOfOrg(ORG_B_ID)).toBe(bBefore);
      expect(await soldAuditsOfOrg(ORG_B_ID)).toBe(soldBefore);
      expect(await remainingOf(bStock.id)).toBe(9);
      // la vente créée porte l'org A en base :
      const created = (
        await saleModel.find({ productId: new Types.ObjectId(id) }).exec()
      ).find((s) => s.organizationId.toString() === TRADE_ORG_ID);
      expect(created).toBeDefined();
    });

    it("vente A sur produit B : 404 identique à l'absent, zéro écriture, stock A/B intacts, zéro événement", async () => {
      const { id } = await seedProduct(
        'IsoB-' + Date.now(),
        4,
        ORG_B_ID,
        sectionIdB,
      );
      const aSales = await salesOfOrg(TRADE_ORG_ID);
      const bSales = await salesOfOrg(ORG_B_ID);
      const aSold = await soldAuditsOfOrg(TRADE_ORG_ID);
      const aStockBefore = await seedProduct(
        'IsoA-' + Date.now(),
        3,
        TRADE_ORG_ID,
        sectionId,
      );

      const gateway = moduleFixture.get(EventsGateway);
      const emitSpy = jest.spyOn(gateway, 'emitToOrganization');

      let res: request.Response;
      try {
        res = await createSale(id, 1, adminToken);
        expect(res.status).toBe(404);
        expect(messageOf(res.body)).toBe(`Product ${id} not found`);
        // zéro écriture dans les DEUX tenants :
        expect(await salesOfOrg(TRADE_ORG_ID)).toBe(aSales);
        expect(await salesOfOrg(ORG_B_ID)).toBe(bSales);
        expect(await soldAuditsOfOrg(TRADE_ORG_ID)).toBe(aSold);
        expect(await soldAuditsOfOrg(ORG_B_ID)).toBe(0);
        // stocks intacts des deux côtés (ni décompte, ni fuite) :
        expect(await remainingOf(id)).toBe(4);
        expect(await remainingOf(aStockBefore.id)).toBe(3);
        // zéro événement post-commit :
        expect(emitSpy).not.toHaveBeenCalled();
      } finally {
        emitSpy.mockRestore();
      }
    });

    it('concurrence : deux ventes A du dernier article (stock=1) — une 201, une 400, stock final 0, exactement une vente A + un audit A', async () => {
      const { id } = await seedProduct(
        'IsoRace-' + Date.now(),
        1,
        TRADE_ORG_ID,
        sectionId,
      );
      const aBefore = await salesOfOrg(TRADE_ORG_ID);
      const soldABefore = await soldAuditsOfOrg(TRADE_ORG_ID);

      // Deux requêtes HTTP DISTINCTES en concurrence (jamais dans la
      // transaction) :
      const [a, b] = await Promise.all([createSale(id, 1), createSale(id, 1)]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 400]);
      const failed = a.status === 400 ? a : b;
      expect(messageOf(failed.body)).toBe('Not enough stock. Available: 0');

      const stock = await remainingOf(id);
      expect(stock).toBe(0);
      expect(stock).not.toBeLessThan(0);
      expect(await salesOfOrg(TRADE_ORG_ID)).toBe(aBefore + 1);
      expect(await soldAuditsOfOrg(TRADE_ORG_ID)).toBe(soldABefore + 1);
      expect(await salesOfOrg(ORG_B_ID)).toBe(0);
    });

    it('mêmes nom et id de section en A et B : les deux ventes indépendantes sont validées, chaque tenant porte sa propre vente', async () => {
      // MÊME nom de produit et même sectionId nominal (sections distinctes
      // mais de même nom) : l'unicité de nom 1-4B est tenant-scopée.
      const now = Date.now();
      const aProd = await seedProduct(
        'DupName-' + now,
        2,
        TRADE_ORG_ID,
        sectionId,
      );
      const bProd = await seedProduct(
        'DupName-' + now,
        2,
        ORG_B_ID,
        sectionIdB,
      );
      expect(aProd.id).not.toBe(bProd.id);

      const aSales = await salesOfOrg(TRADE_ORG_ID);
      const bSales = await salesOfOrg(ORG_B_ID);

      const [ra, rb] = await Promise.all([
        createSale(aProd.id, 1, adminToken),
        createSale(bProd.id, 1, adminBToken),
      ]);
      expect(ra.status).toBe(201);
      expect(rb.status).toBe(201);

      expect(await remainingOf(aProd.id)).toBe(1);
      expect(await remainingOf(bProd.id)).toBe(1);
      expect(await salesOfOrg(TRADE_ORG_ID)).toBe(aSales + 1);
      expect(await salesOfOrg(ORG_B_ID)).toBe(bSales + 1);
      // chaque vente porte le tenant exact :
      const aSale = (
        await saleModel.find({ productId: new Types.ObjectId(aProd.id) }).exec()
      )[0];
      const bSale = (
        await saleModel.find({ productId: new Types.ObjectId(bProd.id) }).exec()
      )[0];
      expect(aSale.organizationId.toString()).toBe(TRADE_ORG_ID);
      expect(bSale.organizationId.toString()).toBe(ORG_B_ID);
    });

    it('sale:created uniquement après commit pour B : 1 émission sur succès B, zéro supplémentaire après rollback', async () => {
      const gateway = moduleFixture.get(EventsGateway);
      const emitSpy = jest.spyOn(gateway, 'emitToOrganization');

      const { id } = await seedProduct(
        'IsoEmit-' + Date.now(),
        5,
        ORG_B_ID,
        sectionIdB,
      );

      // succès B → 1 émission, avec le tenant B dans le payload :
      const ok = await createSale(id, 1, adminBToken);
      expect(ok.status).toBe(201);
      expect(emitSpy).toHaveBeenCalledTimes(1);
      expect(emitSpy).toHaveBeenCalledWith(
        ORG_B_ID,
        'sale:created',
        expect.objectContaining({
          _id: expect.anything(),
          organizationId: expect.anything(),
        }),
      );
      emitSpy.mockClear();

      // rollback (audit en panne, AVEC session) → zéro émission suppl. :
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
        const failed = await createSale(id, 1, adminBToken);
        expect(failed.status).toBeGreaterThanOrEqual(500);
      } finally {
        auditModel.create =
          originalCreate as unknown as typeof auditModel.create;
      }
      expect(emitSpy).not.toHaveBeenCalled();
      emitSpy.mockRestore();
    });
  });

  describe('7. Isolation et atomicité des autres opérations Sales (1-4C.2)', () => {
    it('GET retourne deux listes disjointes, chacune limitée à son organisation', async () => {
      const aProduct = await seedProduct(
        'ListA-' + Date.now(),
        3,
        TRADE_ORG_ID,
        sectionId,
      );
      const bProduct = await seedProduct(
        'ListB-' + Date.now(),
        3,
        ORG_B_ID,
        sectionIdB,
      );
      const aCreated = await createSale(aProduct.id, 1, adminToken);
      const bCreated = await createSale(bProduct.id, 1, adminBToken);
      expect(aCreated.status).toBe(201);
      expect(bCreated.status).toBe(201);

      const [aList, bList] = await Promise.all([
        listSales(adminToken),
        listSales(adminBToken),
      ]);
      expect(aList.status).toBe(200);
      expect(bList.status).toBe(200);
      const aIds = (aList.body as Array<{ _id: string }>).map((s) => s._id);
      const bIds = (bList.body as Array<{ _id: string }>).map((s) => s._id);
      expect(aIds).toContain(aCreated.body._id as string);
      expect(aIds).not.toContain(bCreated.body._id as string);
      expect(bIds).toContain(bCreated.body._id as string);
      expect(bIds).not.toContain(aCreated.body._id as string);
      expect(aIds.filter((id) => bIds.includes(id))).toEqual([]);
    });

    it('A ne peut PATCH ni DELETE une vente B : 404 et aucun état B/audit ne change', async () => {
      const product = await seedProduct(
        'ForeignB-' + Date.now(),
        5,
        ORG_B_ID,
        sectionIdB,
      );
      const created = await createSale(product.id, 2, adminBToken);
      const saleId = created.body._id as string;
      const auditBefore = await auditModel.countDocuments();

      const patched = await updateSale(saleId, { quantity: 1 }, adminToken);
      expect(patched.status).toBe(404);
      expect(messageOf(patched.body)).toBe(`Sale ${saleId} not found`);
      const removed = await removeSale(saleId, adminToken);
      expect(removed.status).toBe(404);
      expect(messageOf(removed.body)).toBe(`Sale ${saleId} not found`);

      expect((await saleModel.findById(saleId))!.quantity).toBe(2);
      expect(await remainingOf(product.id)).toBe(3);
      expect(await auditModel.countDocuments()).toBe(auditBefore);
    });

    it('update A ajuste uniquement le stock A et écrit l’audit A', async () => {
      const aProduct = await seedProduct(
        'UpdateA-' + Date.now(),
        8,
        TRADE_ORG_ID,
        sectionId,
      );
      const bProduct = await seedProduct(
        'UpdateB-' + Date.now(),
        8,
        ORG_B_ID,
        sectionIdB,
      );
      const created = await createSale(aProduct.id, 3, adminToken);
      const aAuditBefore = await auditModel.countDocuments({
        organizationId: new Types.ObjectId(TRADE_ORG_ID),
        action: 'sale_updated',
      });
      const bAuditBefore = await auditModel.countDocuments({
        organizationId: new Types.ObjectId(ORG_B_ID),
        action: 'sale_updated',
      });

      const patched = await updateSale(
        created.body._id as string,
        { quantity: 1 },
        adminToken,
      );
      expect(patched.status).toBe(200);
      expect(await remainingOf(aProduct.id)).toBe(7);
      expect(await remainingOf(bProduct.id)).toBe(8);
      expect(
        await auditModel.countDocuments({
          organizationId: new Types.ObjectId(TRADE_ORG_ID),
          action: 'sale_updated',
        }),
      ).toBe(aAuditBefore + 1);
      expect(
        await auditModel.countDocuments({
          organizationId: new Types.ObjectId(ORG_B_ID),
          action: 'sale_updated',
        }),
      ).toBe(bAuditBefore);
    });

    it('delete A restaure uniquement le stock A et écrit l’audit A', async () => {
      const aProduct = await seedProduct(
        'DeleteA-' + Date.now(),
        6,
        TRADE_ORG_ID,
        sectionId,
      );
      const bProduct = await seedProduct(
        'DeleteB-' + Date.now(),
        6,
        ORG_B_ID,
        sectionIdB,
      );
      const created = await createSale(aProduct.id, 2, adminToken);
      const auditBefore = await auditModel.countDocuments({
        organizationId: new Types.ObjectId(TRADE_ORG_ID),
        action: 'sale_cancelled',
      });

      const removed = await removeSale(created.body._id as string, adminToken);
      expect(removed.status).toBe(204);
      expect(await remainingOf(aProduct.id)).toBe(6);
      expect(await remainingOf(bProduct.id)).toBe(6);
      expect(
        await auditModel.countDocuments({
          organizationId: new Types.ObjectId(TRADE_ORG_ID),
          action: 'sale_cancelled',
        }),
      ).toBe(auditBefore + 1);
    });

    it('échec audit update : rollback de la vente, du stock et de l’audit', async () => {
      const product = await seedProduct(
        'RollbackUpdate-' + Date.now(),
        5,
        TRADE_ORG_ID,
        sectionId,
      );
      const created = await createSale(product.id, 2, adminToken);
      const saleId = created.body._id as string;
      const auditBefore = await auditModel.countDocuments();
      const originalCreate = auditModel.create.bind(auditModel) as (
        docs: unknown,
        opts?: { session?: unknown },
      ) => Promise<unknown>;
      auditModel.create = ((docs: unknown, opts?: { session?: unknown }) =>
        opts?.session
          ? Promise.reject(new Error('forced update audit rollback'))
          : originalCreate(docs, opts)) as unknown as typeof auditModel.create;

      let response: request.Response;
      try {
        response = await updateSale(saleId, { quantity: 1 }, adminToken);
      } finally {
        auditModel.create =
          originalCreate as unknown as typeof auditModel.create;
      }
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect((await saleModel.findById(saleId))!.quantity).toBe(2);
      expect(await remainingOf(product.id)).toBe(3);
      expect(await auditModel.countDocuments()).toBe(auditBefore);
    });

    it('échec audit remove : rollback de la vente, du stock et de l’audit', async () => {
      const product = await seedProduct(
        'RollbackRemove-' + Date.now(),
        5,
        TRADE_ORG_ID,
        sectionId,
      );
      const created = await createSale(product.id, 2, adminToken);
      const saleId = created.body._id as string;
      const auditBefore = await auditModel.countDocuments();
      const originalCreate = auditModel.create.bind(auditModel) as (
        docs: unknown,
        opts?: { session?: unknown },
      ) => Promise<unknown>;
      auditModel.create = ((docs: unknown, opts?: { session?: unknown }) =>
        opts?.session
          ? Promise.reject(new Error('forced remove audit rollback'))
          : originalCreate(docs, opts)) as unknown as typeof auditModel.create;

      let response: request.Response;
      try {
        response = await removeSale(saleId, adminToken);
      } finally {
        auditModel.create =
          originalCreate as unknown as typeof auditModel.create;
      }
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(await saleModel.findById(saleId)).not.toBeNull();
      expect(await remainingOf(product.id)).toBe(3);
      expect(await auditModel.countDocuments()).toBe(auditBefore);
    });

    it('organizationId falsifié dans body/query/header ne change jamais le tenant', async () => {
      const product = await seedProduct(
        'Forgery-' + Date.now(),
        5,
        TRADE_ORG_ID,
        sectionId,
      );
      const created = await createSale(product.id, 2, adminToken);
      const saleId = created.body._id as string;

      const rejected = await updateSale(
        saleId,
        { salePrice: 123, organizationId: ORG_B_ID },
        adminToken,
      );
      expect(rejected.status).toBe(400);
      expect((await saleModel.findById(saleId))!.salePrice).toBe(400);

      const accepted = await request(app.getHttpServer())
        .patch(`/sales/${saleId}?organizationId=${ORG_B_ID}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Organization-Id', ORG_B_ID)
        .send({ salePrice: 250 });
      expect(accepted.status).toBe(200);
      const persisted = await saleModel.findById(saleId);
      expect(persisted!.salePrice).toBe(250);
      expect(persisted!.organizationId.toString()).toBe(TRADE_ORG_ID);
    });
  });

  describe('8. Isolation Analytics, Audit et corbeille (1-4D)', () => {
    const analyticsSnapshot = async (token: string) => {
      const endpoints = [
        '/analytics/overview',
        '/analytics/products/ranking',
        '/analytics/sellers/ranking',
        '/analytics/monthly',
      ];
      const responses = await Promise.all(
        endpoints.map((endpoint) =>
          request(app.getHttpServer())
            .get(endpoint)
            .set('Authorization', `Bearer ${token}`),
        ),
      );
      for (const response of responses) expect(response.status).toBe(200);
      const productRanking = [
        ...(responses[1].body as Array<{ productId: string }>),
      ].sort((a, b) => String(a.productId).localeCompare(String(b.productId)));
      const sellerRanking = [
        ...(responses[2].body as Array<{ sellerId: string }>),
      ].sort((a, b) => String(a.sellerId).localeCompare(String(b.sellerId)));
      return [
        responses[0].body as unknown,
        productRanking,
        sellerRanking,
        responses[3].body as unknown,
      ];
    };

    it('toutes les métriques A restent identiques après variation des données B', async () => {
      const aProduct = await seedProduct(
        'AnalyticsA-' + Date.now(),
        6,
        TRADE_ORG_ID,
        sectionId,
      );
      expect((await createSale(aProduct.id, 2, adminToken)).status).toBe(201);
      const beforeB = await analyticsSnapshot(adminToken);

      const bProduct = await seedProduct(
        'AnalyticsB-' + Date.now(),
        40,
        ORG_B_ID,
        sectionIdB,
      );
      expect((await createSale(bProduct.id, 17, adminBToken)).status).toBe(201);

      expect(await analyticsSnapshot(adminToken)).toEqual(beforeB);
      const productRanking = beforeB[1] as Array<{ productId: string }>;
      expect(productRanking.map((row) => String(row.productId))).toContain(
        aProduct.id,
      );
      expect(productRanking.map((row) => String(row.productId))).not.toContain(
        bProduct.id,
      );

      const forged = await request(app.getHttpServer())
        .get(`/analytics/overview?organizationId=${ORG_B_ID}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Organization-Id', ORG_B_ID)
        .send({ organizationId: ORG_B_ID });
      expect(forged.status).toBe(200);
      expect(forged.body).toEqual(beforeB[0]);
    });

    it('historique Audit A exclut B et un produit B est un 404 identique à l’absent', async () => {
      const aProduct = await seedProduct(
        'AuditA-' + Date.now(),
        5,
        TRADE_ORG_ID,
        sectionId,
      );
      const bProduct = await seedProduct(
        'AuditB-' + Date.now(),
        5,
        ORG_B_ID,
        sectionIdB,
      );
      expect((await createSale(aProduct.id, 1, adminToken)).status).toBe(201);
      const adminB = await userModel.findOne({ email: ADMIN_B_EMAIL });
      await auditModel.create({
        organizationId: new Types.ObjectId(ORG_B_ID),
        productId: new Types.ObjectId(aProduct.id),
        action: 'price_changed',
        actorId: adminB!._id,
        details: { marker: 'foreign-audit' },
      });

      const detail = await request(app.getHttpServer())
        .get(`/products/${aProduct.id}?organizationId=${ORG_B_ID}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Organization-Id', ORG_B_ID)
        .send({ organizationId: ORG_B_ID });
      expect(detail.status).toBe(200);
      const logs = detail.body.auditLogs as Array<{
        organizationId: string;
        details: { marker?: string };
      }>;
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(
        logs.every((log) => String(log.organizationId) === TRADE_ORG_ID),
      ).toBe(true);
      expect(logs.some((log) => log.details.marker === 'foreign-audit')).toBe(
        false,
      );

      const foreign = await request(app.getHttpServer())
        .get(`/products/${bProduct.id}`)
        .set('Authorization', `Bearer ${adminToken}`);
      const missingId = new Types.ObjectId().toString();
      const missing = await request(app.getHttpServer())
        .get(`/products/${missingId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(messageOf(foreign.body)).toBe(`Product ${bProduct.id} not found`);
      expect(messageOf(missing.body)).toBe(`Product ${missingId} not found`);
    });

    it('corbeilles A/B sont strictement disjointes et les valeurs falsifiées sont ignorées', async () => {
      const createSection = (name: string, token: string) =>
        request(app.getHttpServer())
          .post('/sections')
          .set('Authorization', `Bearer ${token}`)
          .send({ name });
      const sectionA = await createSection('TrashA-' + Date.now(), adminToken);
      const sectionB = await createSection('TrashB-' + Date.now(), adminBToken);
      expect(sectionA.status).toBe(201);
      expect(sectionB.status).toBe(201);
      expect(
        (
          await request(app.getHttpServer())
            .delete(`/sections/${sectionA.body._id as string}`)
            .set('Authorization', `Bearer ${adminToken}`)
        ).status,
      ).toBe(200);
      expect(
        (
          await request(app.getHttpServer())
            .delete(`/sections/${sectionB.body._id as string}`)
            .set('Authorization', `Bearer ${adminBToken}`)
        ).status,
      ).toBe(200);

      const productA = await seedProduct(
        'TrashProductA-' + Date.now(),
        2,
        TRADE_ORG_ID,
        sectionId,
      );
      const productB = await seedProduct(
        'TrashProductB-' + Date.now(),
        2,
        ORG_B_ID,
        sectionIdB,
      );
      await productModel.updateMany(
        { _id: { $in: [productA.product._id, productB.product._id] } },
        { $set: { deletedAt: new Date() } },
      );

      const getTrash = (token: string) =>
        request(app.getHttpServer())
          .get('/trash')
          .set('Authorization', `Bearer ${token}`);
      const [trashA, trashB] = await Promise.all([
        getTrash(adminToken),
        getTrash(adminBToken),
      ]);
      expect(trashA.status).toBe(200);
      expect(trashB.status).toBe(200);
      const ids = (rows: Array<{ _id: string }>) =>
        rows.map((row) => String(row._id));
      const aSections = ids(trashA.body.sections as Array<{ _id: string }>);
      const bSections = ids(trashB.body.sections as Array<{ _id: string }>);
      const aProducts = ids(trashA.body.products as Array<{ _id: string }>);
      const bProducts = ids(trashB.body.products as Array<{ _id: string }>);
      expect(aSections).toContain(sectionA.body._id as string);
      expect(bSections).toContain(sectionB.body._id as string);
      expect(aProducts).toContain(productA.id);
      expect(bProducts).toContain(productB.id);
      expect(aSections.filter((id) => bSections.includes(id))).toEqual([]);
      expect(aProducts.filter((id) => bProducts.includes(id))).toEqual([]);

      const forged = await request(app.getHttpServer())
        .get(`/trash?organizationId=${ORG_B_ID}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Organization-Id', ORG_B_ID)
        .send({ organizationId: ORG_B_ID });
      expect(forged.status).toBe(200);
      expect(ids(forged.body.sections as Array<{ _id: string }>)).toEqual(
        aSections,
      );
      expect(ids(forged.body.products as Array<{ _id: string }>)).toEqual(
        aProducts,
      );
    });
  });
});
