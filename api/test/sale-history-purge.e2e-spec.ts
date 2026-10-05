import 'reflect-metadata';
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
  AuditAction,
  AuditLogDocument,
} from './../src/audit/schemas/audit-log.schema';
import {
  MembershipStatus,
  OrganizationRole,
} from './../src/organizations/permissions';
import { Organization } from './../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from './../src/organizations/schemas/organization.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import { ProductsService } from './../src/products/products.service';
import { AuditService } from './../src/audit/audit.service';
import { backfillSaleProductHistory } from './../src/sales/sale-history-backfill';
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
 * E2E 1-15D — historique des ventes après suppression définitive.
 *
 * Replica set éphémère (`MongoMemoryReplSet`, garde anti-27017) : vraies
 * transactions, vrais conflits d'écriture. Les courses vente/purge sont
 * ORDONNÉES par des barrières (promesses libérées explicitement) posées par
 * espionnage d'une méthode existante, sans aucun crochet de test dans le
 * code de production et sans attente à durée fixe.
 *
 * Aucune image réelle : `imageUrl` factice, hors du préfixe du stockage,
 * donc aucun appel au stockage (la suppression effective des fichiers est
 * prouvée par la recette navigateur, stockage simulé 1-15C).
 */

const TEST_JWT_SECRET = 'e2e-only-static-secret-not-production-use';
const PASSWORD = 'hist-15d-pw-!1x';
const ORG_A = 'a15d0000000000000000000a';
const ORG_B = 'b15d0000000000000000000b';
// Organisation dédiée à la preuve du bénéfice global (aucune autre vente).
const ORG_C = 'c15d0000000000000000000c';

describe('E2E 1-15D — historique des ventes après purge', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let connection: Connection;
  let productModel: Model<ProductDocument>;
  let saleModel: Model<SaleDocument>;
  let auditModel: Model<AuditLogDocument>;
  let productsService: ProductsService;
  let auditService: AuditService;
  let ownerA = '';
  let sellerA = '';
  let ownerB = '';
  let sectionA = '';
  let sectionB = '';
  let ownerC = '';
  let sectionC = '';

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function seed(
    name: string,
    org = ORG_A,
    section = sectionA,
    purchasePrice = 100,
  ) {
    const product = await productModel.create({
      sectionId: new Types.ObjectId(section),
      name,
      imageUrl: 'https://e2e.local/img.png',
      purchasePrice,
      salePrice: 400,
      initialQuantity: 20,
      remainingQuantity: 20,
      organizationId: new Types.ObjectId(org),
    });
    return product._id.toString();
  }

  const sell = (productId: string, quantity: number, token = ownerA) =>
    http()
      .post('/sales')
      .set(auth(token))
      .send({ productId, quantity, salePrice: 400 });

  async function purge(productId: string, token = ownerA) {
    return http().delete(`/products/${productId}/permanent`).set(auth(token));
  }

  const ranking = async (token = ownerA) =>
    (await http().get('/analytics/products/ranking').set(auth(token)))
      .body as Array<Record<string, unknown>>;
  const rowOf = async (productId: string, token = ownerA) =>
    (await ranking(token)).find((r) => String(r.productId) === productId);
  const overview = async (token = ownerA) =>
    (await http().get('/analytics/overview').set(auth(token))).body as Record<
      string,
      unknown
    >;
  const rawSale = (id: unknown) =>
    connection
      .collection('sales')
      .findOne({ _id: new Types.ObjectId(String(id)) }) as Promise<Record<
      string,
      unknown
    > | null>;

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

      connection = moduleFixture.get<Connection>(getConnectionToken());
      productModel = moduleFixture.get(getModelToken('Product'));
      saleModel = moduleFixture.get(getModelToken('Sale'));
      auditModel = moduleFixture.get(getModelToken('AuditLog'));
      productsService = moduleFixture.get(ProductsService);
      auditService = moduleFixture.get(AuditService);
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
        [ORG_A, 'hist-a-15d'],
        [ORG_B, 'hist-b-15d'],
        [ORG_C, 'hist-c-15d'],
      ]) {
        await organizationModel.create({ _id: id, slug, name: slug });
      }
      await activateTestSubscriptions(moduleFixture, [ORG_A, ORG_B, ORG_C]);
      const hash = await bcrypt.hash(PASSWORD, 10);
      const member = async (
        email: string,
        org: string,
        role: OrganizationRole,
      ) => {
        const user = await userModel.create({
          emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
          name: email.split('@')[0],
          email,
          password: hash,
        });
        await membershipModel.create({
          organizationId: new Types.ObjectId(org),
          userId: user._id,
          role,
          status: MembershipStatus.ACTIVE,
        });
        const login = await http()
          .post('/auth/login')
          .send({ email, password: PASSWORD });
        expect(login.status).toBe(201);
        return login.body.access_token as string;
      };
      ownerA = await member(
        'owner-a-15d@e2e.test',
        ORG_A,
        OrganizationRole.OWNER,
      );
      sellerA = await member(
        'seller-a-15d@e2e.test',
        ORG_A,
        OrganizationRole.SELLER,
      );
      ownerB = await member(
        'owner-b-15d@e2e.test',
        ORG_B,
        OrganizationRole.OWNER,
      );
      sectionA = (
        await http().post('/sections').set(auth(ownerA)).send({ name: 'A' })
      ).body._id as string;
      sectionB = (
        await http().post('/sections').set(auth(ownerB)).send({ name: 'B' })
      ).body._id as string;
      ownerC = await member(
        'owner-c-15d@e2e.test',
        ORG_C,
        OrganizationRole.OWNER,
      );
      sectionC = (
        await http().post('/sections').set(auth(ownerC)).send({ name: 'C' })
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

  it('vente puis purge : nom, quantités, montants et bénéfice conservés ; inventaire courant mis à jour', async () => {
    const id = await seed(`Purge-${Date.now()}`);
    const sale = await sell(id, 2);
    expect(sale.status).toBe(201);
    const before = { row: await rowOf(id), overview: await overview() };
    expect(before.row).toMatchObject({ netProfit: 600, remainingQuantity: 18 });

    expect((await purge(id)).status).toBe(200);
    expect(await productModel.countDocuments({ _id: id })).toBe(0);

    const listed = (await http().get('/sales').set(auth(ownerA))).body as Array<
      Record<string, unknown>
    >;
    const kept = listed.find((s) => s._id === sale.body._id);
    expect(kept).toMatchObject({
      productId: null,
      productName: before.row!.productName,
      lastKnownProductName: before.row!.productName,
      lastKnownSource: 'purge',
      quantity: 2,
      salePrice: 400,
    });
    expect(kept).not.toHaveProperty('lastKnownUnitCost');

    const after = await rowOf(id);
    expect(after).toMatchObject({
      productName: before.row!.productName,
      productDeleted: true,
      totalUnitsSold: 2,
      totalRevenue: 800,
      transactionCount: 1,
      netProfit: 600,
      remainingQuantity: null,
      imageUrl: null,
    });
    const ov = await overview();
    expect(ov.totalRevenue).toBe(before.overview.totalRevenue);
    expect(ov.netProfit).toBe(before.overview.netProfit);
    expect(ov.productsCount).toBe(
      (before.overview.productsCount as number) - 1,
    );
    expect(ov.totalInvested).toBe(
      (before.overview.totalInvested as number) - 2000,
    );
    // Période : la vente reste dans la tendance mensuelle.
    const monthly = (await http().get('/analytics/monthly').set(auth(ownerA)))
      .body as Array<{ totalRevenue: number }>;
    expect(monthly.reduce((s, m) => s + m.totalRevenue, 0)).toBe(
      ov.totalRevenue,
    );
  });

  it('renommage entre deux ventes : noms historiques ; un seul groupe ; nom client ignoré', async () => {
    const id = await seed(`Avant-${Date.now()}`);
    const s1 = await sell(id, 1);
    await productModel.updateOne({ _id: id }, { $set: { name: 'Après 15D' } });
    // Un nom fourni par le client est refusé (jamais pris pour preuve).
    const forged = await http().post('/sales').set(auth(ownerA)).send({
      productId: id,
      quantity: 1,
      salePrice: 400,
      productName: 'Faux',
    });
    expect(forged.status).toBe(400);
    const s2 = await sell(id, 1);
    expect((await rawSale(s1.body._id))!.productName).toMatch(/^Avant-/);
    expect((await rawSale(s2.body._id))!.productName).toBe('Après 15D');
    const rows = (await ranking()).filter((r) => String(r.productId) === id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      productName: 'Après 15D',
      totalUnitsSold: 2,
    });

    await purge(id);
    expect((await rawSale(s1.body._id))!.productName).toMatch(/^Avant-/);
    expect(await rowOf(id)).toMatchObject({
      productName: 'Après 15D',
      totalUnitsSold: 2,
      netProfit: 600,
    });
  });

  it('vente ancienne sans nom : dernier nom connu figé à la purge, distinct du nom enregistré ; jamais écrasé', async () => {
    const id = await seed(`Ancien-${Date.now()}`);
    const legacy = await sell(id, 1);
    const stamped = await sell(id, 1);
    await saleModel.collection.updateOne(
      { _id: new Types.ObjectId(legacy.body._id as string) },
      { $unset: { productName: '' } },
    );
    // Historique déjà posé (rattrapage antérieur) : intouchable.
    await saleModel.collection.updateOne(
      { _id: new Types.ObjectId(stamped.body._id as string) },
      {
        $set: {
          lastKnownProductName: 'Déjà conservé',
          lastKnownUnitCost: 90,
          lastKnownSource: 'audit',
        },
      },
    );
    await purge(id);
    const raw = await rawSale(legacy.body._id);
    expect(raw).not.toHaveProperty('productName');
    expect(raw).toMatchObject({
      lastKnownProductName: expect.stringMatching(/^Ancien-/),
      lastKnownUnitCost: 100,
      lastKnownSource: 'purge',
    });
    expect(await rawSale(stamped.body._id)).toMatchObject({
      lastKnownProductName: 'Déjà conservé',
      lastKnownUnitCost: 90,
      lastKnownSource: 'audit',
    });
    // 800 − (100 + 90) : chaque vente garde SON coût conservé.
    expect(await rowOf(id)).toMatchObject({ netProfit: 610 });
  });

  it('purge de catégorie : comportement actuel, aucune cascade ; historique intact', async () => {
    const section = (
      await http().post('/sections').set(auth(ownerA)).send({ name: 'Cat 15D' })
    ).body._id as string;
    const id = await seed(`Cat-${Date.now()}`, ORG_A, section);
    await sell(id, 2);
    const before = await rowOf(id);
    await http().delete(`/sections/${section}`).set(auth(ownerA));
    expect(
      (await http().delete(`/sections/${section}/permanent`).set(auth(ownerA)))
        .status,
    ).toBe(200);
    const product = await productModel.findById(id).lean();
    expect(product).toMatchObject({ deletedAt: null });
    expect(String(product!.sectionId)).toBe(section);
    expect(await rowOf(id)).toEqual(before);
    expect(
      await saleModel.countDocuments({ productId: new Types.ObjectId(id) }),
    ).toBe(1);
  });

  it('isolation et droits : B ne purge ni ne voit A ; le vendeur voit sa vente nommée, jamais le coût', async () => {
    const id = await seed(`Iso-${Date.now()}`);
    const own = await sell(id, 1, sellerA);
    expect(own.status).toBe(201);
    await sell(id, 1);
    const idB = await seed(`IsoB-${Date.now()}`, ORG_B, sectionB);
    await sell(idB, 1, ownerB);

    expect((await purge(id, ownerB)).status).toBe(404);
    expect(await productModel.countDocuments({ _id: id })).toBe(1);
    await purge(id);

    const sellerSales = (await http().get('/sales').set(auth(sellerA)))
      .body as Array<Record<string, unknown>>;
    expect(sellerSales.map((s) => s._id)).toEqual([own.body._id]);
    expect(sellerSales[0].lastKnownProductName).toMatch(/^Iso-/);
    expect(JSON.stringify(sellerSales)).not.toMatch(/Cost|purchasePrice/);
    expect(
      (await http().get('/analytics/products/ranking').set(auth(sellerA)))
        .status,
    ).toBe(403);

    const salesB = (await http().get('/sales').set(auth(ownerB))).body as Array<
      Record<string, unknown>
    >;
    expect(salesB).toHaveLength(1);
    expect(await rawSale(salesB[0]._id as string)).not.toHaveProperty(
      'lastKnownSource',
    );
    expect((await ranking(ownerB)).map((r) => String(r.productId))).toEqual([
      idB,
    ]);
  });

  it('concurrence (a) : vente en cours, purge lancée, vente validée → historique figé sur la vente', async () => {
    const id = await seed(`ConcA-${Date.now()}`);
    const hold = barrier();
    const original = productsService.decrementStock.bind(productsService);
    let decremented = 0;
    jest
      .spyOn(productsService, 'decrementStock')
      .mockImplementation(async (...args) => {
        const product = await original(...args);
        decremented += 1;
        await hold.wait(); // transaction de vente ouverte, stock écrit
        return product;
      });
    const deletes = jest.spyOn(productModel, 'findOneAndDelete');

    const salePending = sell(id, 2).then((r) => r);
    await until(() => decremented === 1, 'vente en transaction');
    const purgePending = purge(id).then((r) => r);
    await until(() => deletes.mock.calls.length >= 1, 'purge tentée');
    hold.release();
    const [saleRes, purgeRes] = await Promise.all([salePending, purgePending]);

    expect(saleRes.status).toBe(201);
    expect(purgeRes.status).toBe(200);
    expect(await productModel.countDocuments({ _id: id })).toBe(0);
    expect(await rawSale(saleRes.body._id)).toMatchObject({
      productName: expect.stringMatching(/^ConcA-/),
      lastKnownUnitCost: 100,
      lastKnownSource: 'purge',
    });
  });

  it('concurrence (b) : purge en cours, vente lancée → refus 404, aucune vente ni trace orpheline', async () => {
    const id = await seed(`ConcB-${Date.now()}`);
    const hold = barrier();
    const originalUpdateMany = saleModel.updateMany.bind(saleModel);
    let stamped = 0;
    jest.spyOn(saleModel, 'updateMany').mockImplementation(((
      ...args: Parameters<typeof saleModel.updateMany>
    ) => {
      const query = originalUpdateMany(...args);
      const exec = query.exec.bind(query);
      query.exec = async () => {
        const result = await exec();
        stamped += 1;
        await hold.wait(); // transaction de purge ouverte, produit supprimé
        return result;
      };
      return query;
    }) as typeof saleModel.updateMany);
    const decrement = jest.spyOn(productsService, 'decrementStock');
    const salesBefore = await saleModel.countDocuments();
    const soldBefore = await auditModel.countDocuments({
      action: AuditAction.SOLD,
    });

    const purgePending = purge(id).then((r) => r);
    await until(() => stamped === 1, 'purge en transaction');
    const salePending = http()
      .post('/sales')
      .set(auth(ownerA))
      .send({
        productId: id,
        quantity: 1,
        salePrice: 400,
        clientOperationId: '7d1f0b0e-5d0a-4b8e-9a51-15d000000001',
      })
      .then((r) => r);
    await until(() => decrement.mock.calls.length >= 1, 'vente tentée');
    hold.release();
    const [purgeRes, saleRes] = await Promise.all([purgePending, salePending]);

    expect(purgeRes.status).toBe(200);
    expect(saleRes.status).toBe(404);
    expect(await saleModel.countDocuments()).toBe(salesBefore);
    expect(await auditModel.countDocuments({ action: AuditAction.SOLD })).toBe(
      soldBefore,
    );
    expect(
      await connection.collection('sale_operations').countDocuments({
        clientOperationId: '7d1f0b0e-5d0a-4b8e-9a51-15d000000001',
      }),
    ).toBe(0);
  });

  it('rattrapage explicite (CLI) : simulation sans écriture, reconstruction depuis l’audit, cas impossible, idempotence', async () => {
    // Traces d'audit sous la forme exacte écrite par `ProductsService`
    // (le parcours par l'API, avec stockage simulé, est couvert par RT28).
    const fd = Date.now();
    const traced = await seed(`Cli-${fd}`);
    const actor = new Types.ObjectId();
    const trace = (action: AuditAction, details: Record<string, unknown>) =>
      auditModel.create({
        organizationId: new Types.ObjectId(ORG_A),
        productId: new Types.ObjectId(traced),
        action,
        actorId: actor,
        details,
      });
    await trace(AuditAction.CREATED, { name: `Cli-${fd}`, purchasePrice: 100 });
    await trace(AuditAction.NAME_CHANGED, {
      name: { from: `Cli-${fd}`, to: 'Cli final' },
    });
    await trace(AuditAction.PRICE_CHANGED, {
      purchasePrice: { from: 100, to: 150 },
    });
    await trace(AuditAction.DELETED, { name: 'Cli final' });
    const untraced = await seed(`Sans-trace-${fd}`);
    const s1 = await sell(traced, 2);
    const s2 = await sell(untraced, 1);
    await saleModel.collection.updateMany(
      {
        _id: {
          $in: [s1.body._id, s2.body._id].map(
            (i) => new Types.ObjectId(i as string),
          ),
        },
      },
      { $unset: { productName: '' } },
    );
    // Purge ANTÉRIEURE à 1-15D simulée : document supprimé sans historique.
    await productModel.collection.deleteMany({
      _id: { $in: [traced, untraced].map((i) => new Types.ObjectId(i)) },
    });
    await auditModel.deleteMany({ productId: new Types.ObjectId(untraced) });

    const snapshot = async () =>
      JSON.stringify([await rawSale(s1.body._id), await rawSale(s2.body._id)]);
    const initial = await snapshot();
    const dry = await backfillSaleProductHistory(connection, {
      apply: false,
      organizationId: ORG_A,
    });
    expect(dry).toMatchObject({
      mode: 'dry-run',
      candidates: 2,
      recoverable: 1,
      unrecoverable: 1,
      updated: 0,
      unrecoverableSaleIds: [s2.body._id],
    });
    expect(await snapshot()).toBe(initial);

    // Organisation B : aucun effet sur A.
    const other = await backfillSaleProductHistory(connection, {
      apply: true,
      organizationId: ORG_B,
    });
    expect(other.candidates).toBe(0);
    expect(await snapshot()).toBe(initial);

    const applied = await backfillSaleProductHistory(connection, {
      apply: true,
      organizationId: ORG_A,
    });
    expect(applied.updated).toBe(1);
    const r1 = await rawSale(s1.body._id);
    expect(r1).not.toHaveProperty('productName');
    // Nom confirmé par `deleted` ; le passage à 150 n'est qu'une tentative
    // jamais confirmée : coût inconnu, signalé.
    expect(r1).toMatchObject({
      lastKnownProductName: 'Cli final',
      lastKnownSource: 'audit',
    });
    expect(r1).not.toHaveProperty('lastKnownUnitCost');
    expect(applied.costUnknownSaleIds).toEqual(
      expect.arrayContaining([String(s1.body._id), String(s2.body._id)]),
    );
    expect(await rawSale(s2.body._id)).not.toHaveProperty('lastKnownSource');
    const again = await backfillSaleProductHistory(connection, {
      apply: true,
      organizationId: ORG_A,
    });
    expect(again.updated).toBe(0);

    expect(await rowOf(traced)).toMatchObject({
      productName: 'Cli final',
      netProfit: null,
    });
    expect(await rowOf(untraced)).toMatchObject({
      productName: null,
      netProfit: null,
      totalRevenue: 400,
      remainingQuantity: null,
    });
    const ov = await overview();
    expect(ov.netProfit).toBeNull();
    expect(ov.avgMargin).toBeNull();
  });

  it('rattrapage : modification journalisée puis enregistrement refusé → ni le nom ni le prix refusés ne deviennent historiques', async () => {
    const fd = Date.now();
    // Trace `created` sous la forme écrite par `ProductsService.create`
    // (création par l'API impossible ici : aucun stockage joignable).
    const product = async (name: string) => {
      const id = await seed(name);
      await auditModel.create({
        organizationId: new Types.ObjectId(ORG_A),
        productId: new Types.ObjectId(id),
        action: AuditAction.CREATED,
        actorId: new Types.ObjectId(),
        details: { name, purchasePrice: 100, salePrice: 400 },
      });
      return id;
    };
    const trashed = await product(`Refus-A-${fd}`);
    const direct = await product(`Refus-B-${fd}`);
    const untouched = await product(`Stable-${fd}`);

    // VRAIE route : nom et prix journalisés, puis refus (section absente)
    // AVANT l'enregistrement du produit.
    for (const id of [trashed, direct]) {
      const refused = await http()
        .patch(`/products/${id}`)
        .set(auth(ownerA))
        .field('name', `Nom refusé ${id}`)
        .field('purchasePrice', '999')
        .field('sectionId', new Types.ObjectId().toString());
      expect(refused.status).toBe(404);
      const doc = await productModel.findById(id).lean();
      expect(doc).toMatchObject({ purchasePrice: 100 });
      expect(doc!.name).toMatch(/^Refus-/);
      expect(
        await auditModel.countDocuments({
          productId: new Types.ObjectId(id),
          action: {
            $in: [AuditAction.NAME_CHANGED, AuditAction.PRICE_CHANGED],
          },
        }),
      ).toBe(2);
    }
    const sales = {
      trashed: await sell(trashed, 2),
      direct: await sell(direct, 1),
      untouched: await sell(untouched, 1),
    };
    await saleModel.collection.updateMany(
      {
        _id: {
          $in: Object.values(sales).map(
            (s) => new Types.ObjectId(String(s.body._id)),
          ),
        },
      },
      { $unset: { productName: '' } },
    );
    // Corbeille par la route (trace `deleted` réelle) pour le premier seul.
    expect(
      (await http().delete(`/products/${trashed}`).set(auth(ownerA))).status,
    ).toBe(200);
    // Purge ANTÉRIEURE à 1-15D simulée.
    await productModel.collection.deleteMany({
      _id: {
        $in: [trashed, direct, untouched].map((i) => new Types.ObjectId(i)),
      },
    });

    const report = await backfillSaleProductHistory(connection, {
      apply: true,
      organizationId: ORG_A,
    });
    const id = (s: { body: { _id: unknown } }) => String(s.body._id);

    // Nom confirmé par la corbeille (nom réel) ; prix : tentative non
    // confirmée → inconnu, signalé.
    const a = await rawSale(sales.trashed.body._id);
    expect(a).toMatchObject({
      lastKnownProductName: `Refus-A-${fd}`,
      lastKnownSource: 'audit',
    });
    expect(a).not.toHaveProperty('lastKnownUnitCost');
    expect(a).not.toHaveProperty('productName');
    expect(report.costUnknownSaleIds).toContain(id(sales.trashed));
    expect(report.nameUnknownSaleIds).not.toContain(id(sales.trashed));

    // Sans confirmation postérieure : ni nom ni prix → vente intacte.
    expect(await rawSale(sales.direct.body._id)).not.toHaveProperty(
      'lastKnownSource',
    );
    expect(report.unrecoverableSaleIds).toContain(id(sales.direct));

    // Aucune tentative : valeurs de création confirmées.
    expect(await rawSale(sales.untouched.body._id)).toMatchObject({
      lastKnownProductName: `Stable-${fd}`,
      lastKnownUnitCost: 100,
      lastKnownSource: 'audit',
    });

    // Analyses : nom refusé et prix refusé jamais utilisés.
    const ranked = await ranking();
    expect(JSON.stringify(ranked)).not.toContain('Nom refusé');
    expect(await rowOf(trashed)).toMatchObject({
      productName: `Refus-A-${fd}`,
      netProfit: null,
    });
    expect(await rowOf(untouched)).toMatchObject({ netProfit: 300 });
  });

  it('bénéfice : stock ajouté pendant une vente (1-15E : plus d’écriture perdue) → stock cohérent, bénéfice conservé, aucun écart figé', async () => {
    const id = await seed(`Stock-${Date.now()}`, ORG_C, sectionC);
    expect((await sell(id, 2, ownerC)).status).toBe(201);
    const hold = barrier();
    const original = auditService.log.bind(auditService);
    let stockLogged = 0;
    jest
      .spyOn(auditService, 'log')
      .mockImplementation(async (...args: Parameters<AuditService['log']>) => {
        if (args[2] === AuditAction.STOCK_CHANGED) {
          stockLogged += 1;
          await hold.wait(); // produit lu, pas encore enregistré
        }
        return original(...args);
      });
    const patch = http()
      .patch(`/products/${id}`)
      .set(auth(ownerC))
      .field('additionalStock', '5')
      .then((r) => r);
    await until(() => stockLogged === 1, 'ajout de stock en cours');
    expect((await sell(id, 3, ownerC)).status).toBe(201);
    hold.release();
    expect((await patch).status).toBe(200);

    // 1-15E : 20 + 5 − 2 − 3 = 20 ; stock et ventes concordent.
    const doc = await productModel.findById(id).lean();
    expect(doc).toMatchObject({ initialQuantity: 25, remainingQuantity: 20 });

    const before = await overview(ownerC);
    // Règle existante : coût 100 × (25 − 20) = 500.
    expect(before).toMatchObject({ totalRevenue: 2000, netProfit: 1500 });
    expect((await purge(id, ownerC)).status).toBe(200);
    const after = await overview(ownerC);
    expect(after.totalRevenue).toBe(before.totalRevenue);
    expect(after.netProfit).toBe(before.netProfit);
    expect(after.avgMargin).toBe(before.avgMargin);
    expect(
      await connection
        .collection('purged_stock_adjustments')
        .countDocuments({ productId: new Types.ObjectId(id) }),
    ).toBe(0);
  });

  it('bénéfice : écart historique préparé (fixture éphémère, données écrites avant 1-15E) → compensé à la purge', async () => {
    const id = await seed(`Ecart-${Date.now()}`, ORG_C, sectionC);
    expect((await sell(id, 2, ownerC)).status).toBe(201);
    expect((await sell(id, 3, ownerC)).status).toBe(201);
    // Fixture EXPLICITE : stock tel que l'écrivait l'ancienne écriture perdue
    // (25 / 23 au lieu de 25 / 20) ; aucune correction automatique.
    await productModel.collection.updateOne(
      { _id: new Types.ObjectId(id) },
      { $set: { initialQuantity: 25, remainingQuantity: 23 } },
    );

    const before = await overview(ownerC);
    expect((await purge(id, ownerC)).status).toBe(200);
    const after = await overview(ownerC);
    expect(after.totalRevenue).toBe(before.totalRevenue);
    expect(after.netProfit).toBe(before.netProfit);
    expect(after.avgMargin).toBe(before.avgMargin);
    // Écart figé : (25 − 23) − 5 = −3 unités au prix d'achat de la purge.
    const adjustments = await connection
      .collection('purged_stock_adjustments')
      .find({ productId: new Types.ObjectId(id) })
      .toArray();
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]).toMatchObject({ unitCost: 100, units: -3 });
    expect(String(adjustments[0].organizationId)).toBe(ORG_C);
  });

  it('bénéfice : opérations de stock séquentielles (vente, modification, annulation, ajout) → égalité des quantités, aucun écart figé', async () => {
    const id = await seed(`Seq-${Date.now()}`, ORG_C, sectionC);
    const s1 = await sell(id, 4, ownerC);
    const s2 = await sell(id, 3, ownerC);
    expect(
      (
        await http()
          .patch(`/sales/${String(s1.body._id)}`)
          .set(auth(ownerC))
          .send({ quantity: 6 })
      ).status,
    ).toBe(200);
    expect(
      (
        await http()
          .delete(`/sales/${String(s2.body._id)}`)
          .set(auth(ownerC))
      ).status,
    ).toBe(204);
    expect(
      (
        await http()
          .patch(`/products/${id}`)
          .set(auth(ownerC))
          .field('additionalStock', '7')
      ).status,
    ).toBe(200);
    await sell(id, 2, ownerC);
    // initial − restant = Σ quantités vendues (6 + 2).
    const doc = await productModel.findById(id).lean();
    expect(doc!.initialQuantity - doc!.remainingQuantity).toBe(8);

    const before = await overview(ownerC);
    expect((await purge(id, ownerC)).status).toBe(200);
    const after = await overview(ownerC);
    expect(after.netProfit).toBe(before.netProfit);
    expect(after.avgMargin).toBe(before.avgMargin);
    expect(
      await connection
        .collection('purged_stock_adjustments')
        .countDocuments({ productId: new Types.ObjectId(id) }),
    ).toBe(0);
  });
});
