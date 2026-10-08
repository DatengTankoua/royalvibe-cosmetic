import 'reflect-metadata';
import { Model, Types } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { UserDocument } from './../src/users/schemas/user.schema';
import { ProductDocument } from './../src/products/schemas/product.schema';
import { AuditAction } from './../src/audit/schemas/audit-log.schema';
import { AuditService } from './../src/audit/audit.service';
import { EventsGateway } from './../src/events/events.gateway';
import {
  MembershipStatus,
  OrganizationRole,
} from './../src/organizations/permissions';
import { Organization } from './../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from './../src/organizations/schemas/organization.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';
import { activateTestSubscriptions } from './e2e/subscription-fixtures';
import { barrier, until } from './e2e/barriers';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import {
  E2E_EMAIL_VERIFIED_AT,
  autoConfirmVerificationEmails,
  createE2eEmailSender,
} from './e2e/email-verification-fixtures';

const emailSender = createE2eEmailSender();

/**
 * E2E 1-15E — modifications concurrentes du stock d'un produit.
 *
 * Replica set éphémère (vraies transactions de vente). La modification du
 * produit (`PATCH /products/:id`) est RETENUE entre la lecture du produit et
 * son enregistrement : la barrière est posée sur l'appel existant
 * `AuditService.log(stock_changed)`, situé exactement entre les deux. Les
 * opérations intercalées passent par les vraies routes. Le stock contrôlé
 * est celui PERSISTÉ (relu en base), indépendamment des analyses.
 */

const TEST_JWT_SECRET = 'e2e-only-static-secret-not-production-use';
const PASSWORD = 'stock-15e-pw-!1x';
const ORG_A = 'a15e0000000000000000000a';
const ORG_B = 'b15e0000000000000000000b';

describe('E2E 1-15E — stock : modifications concurrentes', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let productModel: Model<ProductDocument>;
  let auditService: AuditService;
  let eventsGateway: EventsGateway;
  let ownerA = '';
  let ownerB = '';
  let sectionA = '';

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function seed(name: string, org = ORG_A) {
    const product = await productModel.create({
      sectionId: new Types.ObjectId(sectionA),
      name,
      imageUrl: 'https://e2e.local/img.png',
      purchasePrice: 100,
      salePrice: 400,
      initialQuantity: 20,
      remainingQuantity: 20,
      organizationId: new Types.ObjectId(org),
    });
    return product._id.toString();
  }

  const stockOf = async (id: string) => {
    const p = await productModel.findById(id).lean();
    return p && { initial: p.initialQuantity, remaining: p.remainingQuantity };
  };

  const sell = (productId: string, quantity: number) =>
    http()
      .post('/sales')
      .set(auth(ownerA))
      .send({ productId, quantity, salePrice: 400 });

  const patchProduct = (
    id: string,
    fields: Record<string, string>,
    token = ownerA,
  ) => {
    let req = http().patch(`/products/${id}`).set(auth(token));
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    return req.then((r) => r);
  };

  /**
   * Retient chaque modification de stock APRÈS la lecture du produit et
   * AVANT son enregistrement ; `reached` compte les requêtes retenues.
   */
  function holdStockUpdates() {
    const hold = barrier();
    const original = auditService.log.bind(auditService);
    const state = { reached: 0 };
    jest
      .spyOn(auditService, 'log')
      .mockImplementation(async (...args: Parameters<AuditService['log']>) => {
        if (args[2] === AuditAction.STOCK_CHANGED) {
          state.reached += 1;
          await hold.wait();
        }
        return original(...args);
      });
    return { state, release: hold.release };
  }

  const productUpdatedEmits = (spy: jest.SpyInstance, id: string) =>
    spy.mock.calls.filter(
      ([, event, payload]) =>
        event === 'product:updated' &&
        String((payload as { _id?: unknown })._id) === id,
    ).length;

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
      process.env.CORS_ORIGIN = 'https://e2e.example.com';

      moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EMAIL_SENDER)
        .useValue(emailSender)
        .compile();
      app = moduleFixture.createNestApplication();
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

      productModel = moduleFixture.get(getModelToken('Product'));
      auditService = moduleFixture.get(AuditService);
      eventsGateway = moduleFixture.get(EventsGateway);
      const userModel = moduleFixture.get<Model<UserDocument>>(
        getModelToken('User'),
      );
      const organizationModel = moduleFixture.get<Model<OrganizationDocument>>(
        getModelToken(Organization.name),
      );
      const membershipModel = moduleFixture.get<
        Model<OrganizationMembershipDocument>
      >(getModelToken(OrganizationMembership.name));

      for (const [id, slug] of [
        [ORG_A, 'stock-a-15e'],
        [ORG_B, 'stock-b-15e'],
      ]) {
        await organizationModel.create({ _id: id, slug, name: slug });
      }
      await activateTestSubscriptions(moduleFixture, [ORG_A, ORG_B]);
      const hash = await bcrypt.hash(PASSWORD, 10);
      const member = async (email: string, org: string) => {
        const user = await userModel.create({
          emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
          name: email.split('@')[0],
          email,
          password: hash,
        });
        await membershipModel.create({
          organizationId: new Types.ObjectId(org),
          userId: user._id,
          role: OrganizationRole.OWNER,
          status: MembershipStatus.ACTIVE,
        });
        const login = await http()
          .post('/auth/login')
          .send({ email, password: PASSWORD });
        expect(login.status).toBe(201);
        return login.body.access_token as string;
      };
      ownerA = await member('owner-a-15e@e2e.test', ORG_A);
      ownerB = await member('owner-b-15e@e2e.test', ORG_B);
      sectionA = (
        await http().post('/sections').set(auth(ownerA)).send({ name: 'A' })
      ).body._id as string;
    } catch (err) {
      if (moduleFixture) await moduleFixture.close().catch(() => undefined);
      await stopEphemeralMongoSafe();
      throw err;
    }
  }, 180_000);

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  it('ajout de stock et vente intercalée : vente conservée, stock 25/20', async () => {
    const id = await seed(`Vente-${Date.now()}`);
    expect((await sell(id, 2)).status).toBe(201);
    const held = holdStockUpdates();
    const pending = patchProduct(id, { additionalStock: '5' });
    await until(() => held.state.reached === 1, 'ajout retenu après lecture');
    expect((await sell(id, 3)).status).toBe(201);
    held.release();
    const res = await pending;
    expect(res.status).toBe(200);

    // 20 + 5 − 2 − 3 : la vente intercalée n'est pas écrasée.
    expect(await stockOf(id)).toEqual({ initial: 25, remaining: 20 });
    // La réponse reflète l'état enregistré, vente comprise.
    expect(res.body).toMatchObject({
      product: { initialQuantity: 25, remainingQuantity: 20 },
      unitsSold: 5,
    });
  });

  it('deux ajouts concurrents : chaque effet appliqué exactement une fois', async () => {
    const id = await seed(`Ajouts-${Date.now()}`);
    const held = holdStockUpdates();
    const first = patchProduct(id, { additionalStock: '5' });
    const second = patchProduct(id, { additionalStock: '7' });
    // Les deux requêtes ont lu le MÊME état avant toute écriture.
    await until(() => held.state.reached === 2, 'deux ajouts retenus');
    held.release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(await stockOf(id)).toEqual({ initial: 32, remaining: 32 });
  });

  it('ajout de stock et correction puis annulation de vente intercalées : effets conservés', async () => {
    const id = await seed(`Correction-${Date.now()}`);
    const s1 = await sell(id, 4);
    const s2 = await sell(id, 3);
    expect(await stockOf(id)).toEqual({ initial: 20, remaining: 13 });

    let held = holdStockUpdates();
    let pending = patchProduct(id, { additionalStock: '5' });
    await until(() => held.state.reached === 1, 'ajout retenu');
    // Correction 4 → 6 (adjustStock, transaction de vente).
    expect(
      (
        await http()
          .patch(`/sales/${String(s1.body._id)}`)
          .set(auth(ownerA))
          .send({ quantity: 6 })
      ).status,
    ).toBe(200);
    held.release();
    expect((await pending).status).toBe(200);
    expect(await stockOf(id)).toEqual({ initial: 25, remaining: 16 });

    jest.restoreAllMocks();
    held = holdStockUpdates();
    pending = patchProduct(id, { additionalStock: '1' });
    await until(() => held.state.reached === 1, 'ajout retenu');
    // Annulation de la vente de 3 (stock restitué).
    expect(
      (
        await http()
          .delete(`/sales/${String(s2.body._id)}`)
          .set(auth(ownerA))
      ).status,
    ).toBe(204);
    held.release();
    expect((await pending).status).toBe(200);
    // 25 + 1 = 26 ; vendu : 6 → restant 20.
    expect(await stockOf(id)).toEqual({ initial: 26, remaining: 20 });
  });

  it('corrections et annulations de vente seules : aucune régression', async () => {
    const id = await seed(`Seules-${Date.now()}`);
    const s1 = await sell(id, 5);
    expect(
      (
        await http()
          .patch(`/sales/${String(s1.body._id)}`)
          .set(auth(ownerA))
          .send({ quantity: 2 })
      ).status,
    ).toBe(200);
    expect(await stockOf(id)).toEqual({ initial: 20, remaining: 18 });
    // Correction au-delà du stock : refus, rien d'appliqué.
    const tooMuch = await http()
      .patch(`/sales/${String(s1.body._id)}`)
      .set(auth(ownerA))
      .send({ quantity: 50 });
    expect(tooMuch.status).toBe(400);
    expect(await stockOf(id)).toEqual({ initial: 20, remaining: 18 });
    expect(
      (
        await http()
          .delete(`/sales/${String(s1.body._id)}`)
          .set(auth(ownerA))
      ).status,
    ).toBe(204);
    expect(await stockOf(id)).toEqual({ initial: 20, remaining: 20 });
  });

  it('refus (section absente) : aucune modification partielle, aucune émission de succès', async () => {
    const id = await seed(`Refus-${Date.now()}`);
    const emit = jest.spyOn(eventsGateway, 'emitToOrganization');
    const res = await patchProduct(id, {
      name: `Refusé-${id}`,
      purchasePrice: '999',
      additionalStock: '5',
      sectionId: new Types.ObjectId().toString(),
    });
    expect(res.status).toBe(404);
    const doc = await productModel.findById(id).lean();
    expect(doc).toMatchObject({
      purchasePrice: 100,
      initialQuantity: 20,
      remainingQuantity: 20,
    });
    expect(doc!.name).toMatch(/^Refus-/);
    expect(productUpdatedEmits(emit, id)).toBe(0);
  });

  it('produit supprimé définitivement pendant la modification : 404, rien recréé, aucune émission', async () => {
    const id = await seed(`Purge-${Date.now()}`);
    const emit = jest.spyOn(eventsGateway, 'emitToOrganization');
    const held = holdStockUpdates();
    const pending = patchProduct(id, { additionalStock: '5' });
    await until(() => held.state.reached === 1, 'ajout retenu');
    expect(
      (await http().delete(`/products/${id}/permanent`).set(auth(ownerA)))
        .status,
    ).toBe(200);
    held.release();
    expect((await pending).status).toBe(404);
    expect(await productModel.countDocuments({ _id: id })).toBe(0);
    expect(productUpdatedEmits(emit, id)).toBe(0);
  });

  it('produit d’une autre organisation : 404, aucune mutation', async () => {
    const id = await seed(`Etranger-${Date.now()}`);
    const res = await patchProduct(
      id,
      { additionalStock: '5', name: 'Pris par B' },
      ownerB,
    );
    expect(res.status).toBe(404);
    const doc = await productModel.findById(id).lean();
    expect(doc).toMatchObject({ initialQuantity: 20, remainingQuantity: 20 });
    expect(doc!.name).toMatch(/^Etranger-/);
  });
});
