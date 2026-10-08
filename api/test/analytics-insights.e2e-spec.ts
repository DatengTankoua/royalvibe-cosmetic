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
import { SaleDocument } from './../src/sales/schemas/sale.schema';
import {
  MembershipStatus,
  OrganizationRole,
} from './../src/organizations/permissions';
import type { DelegablePermission } from './../src/organizations/permissions';
import { Organization } from './../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from './../src/organizations/schemas/organization.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import { monthBounds } from './../src/analytics/month-range';
import { localMonthKey } from './../src/analytics/insights';
import { MonthlyHistoryService } from './../src/reports/monthly-history.service';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';
import { activateTestSubscriptions } from './e2e/subscription-fixtures';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import {
  E2E_EMAIL_VERIFIED_AT,
  autoConfirmVerificationEmails,
  createE2eEmailSender,
} from './e2e/email-verification-fixtures';

const emailSender = createE2eEmailSender();

/**
 * E2E 1-16E — aide à la décision de la page Analyse (`/analytics/insights`).
 *
 * Replica set éphémère (garde anti-27017), aucun `.env`, aucun envoi.
 * Les dates sont relatives à l'exécution (mois en cours, fenêtre des 28
 * derniers jours civils terminés), construites dans le fuseau du processus.
 */

const TEST_JWT_SECRET = 'e2e-only-static-secret-not-production-use';
const PASSWORD = 'insights-16e-pw-!1x';
const ORG_A = 'a16e0000000000000000000a';
const ORG_B = 'b16e0000000000000000000b';
// Commerce dont un produit purgé n'a pas de coût conservé.
const ORG_C = 'c16e0000000000000000000c';
// Commerce de plus de 50 produits en rupture et de mois terminés inégaux.
const ORG_D = 'd16e0000000000000000000d';
const MANY_OUT = 63;

/** Jour civil `offset` (négatif : passé) à 10:00, fuseau du processus. */
function dayAt(offset: number, hour = 10): Date {
  const now = new Date();
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + offset,
    hour,
  );
}

interface Insights {
  rights: { financials: boolean };
  period: { month: string; inProgress: boolean };
  summary: {
    revenue: number;
    salesCount: number;
    unitsSold: number;
    gain?: number | null;
  };
  comparison: {
    available: boolean;
    partial?: boolean;
    reason?: string | null;
    start: string;
    totals?: { revenue: number; gain?: number | null };
  };
  trend: Array<{ date: string; revenue: number; salesCount: number }>;
  topProducts: Array<{
    productId: string;
    name: string | null;
    productDeleted: boolean;
    revenue: number;
    unitsSold: number;
    remainingQuantity: number | null;
  }>;
  priorities: Array<{
    kind: string;
    count: number;
    items: Array<{ productId: string }>;
  }>;
  stock: Record<
    'out' | 'soon' | 'low' | 'stale' | 'recent',
    {
      count: number;
      items: Array<{
        productId: string;
        remainingQuantity: number;
        estimate: Record<string, unknown>;
      }>;
    }
  >;
  priceChecks?: {
    count: number;
    items: Array<{ productId: string; gain: number; purchasePrice: number }>;
  };
}

describe('E2E 1-16E — aide à la décision (Analyse)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let productModel: Model<ProductDocument>;
  let saleModel: Model<SaleDocument>;
  let ownerA = '';
  let ownerAId = '';
  let analystA = '';
  let sellerA = '';
  let ownerB = '';
  let ownerC = '';
  let ownerD = '';
  let sectionD = '';
  let analystMembershipId = '';
  let membershipModel: Model<OrganizationMembershipDocument>;
  let sectionA = '';
  let sectionB = '';
  let sectionC = '';
  const ids: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const insights = async (token: string, month?: string) => {
    const res = await http()
      .get('/analytics/insights')
      .query(month ? { month } : {})
      .set(auth(token));
    expect(res.status).toBe(200);
    return res.body as Insights;
  };

  async function seedProduct(fields: {
    name: string;
    org?: string;
    section?: string;
    purchasePrice?: number;
    initialQuantity?: number;
    remainingQuantity: number;
    createdAt: Date;
  }) {
    const product = await productModel.create({
      sectionId: new Types.ObjectId(fields.section ?? sectionA),
      name: fields.name,
      imageUrl: 'https://e2e.local/img.png',
      purchasePrice: fields.purchasePrice ?? 100,
      salePrice: 400,
      initialQuantity: fields.initialQuantity ?? 100,
      remainingQuantity: fields.remainingQuantity,
      organizationId: new Types.ObjectId(fields.org ?? ORG_A),
    });
    await productModel.collection.updateOne(
      { _id: product._id },
      { $set: { createdAt: fields.createdAt } },
    );
    return product._id.toString();
  }

  async function insertSale(fields: {
    productId: string;
    at: Date;
    quantity?: number;
    salePrice?: number;
    org?: string;
    lastKnownProductName?: string;
    lastKnownUnitCost?: number;
  }) {
    await saleModel.create({
      organizationId: new Types.ObjectId(fields.org ?? ORG_A),
      productId: new Types.ObjectId(fields.productId),
      quantity: fields.quantity ?? 1,
      salePrice: fields.salePrice ?? 400,
      sellerId: new Types.ObjectId(ownerAId),
      occurredAt: fields.at,
      ...(fields.lastKnownProductName
        ? {
            lastKnownProductName: fields.lastKnownProductName,
            lastKnownSource: 'purge',
          }
        : {}),
      ...(fields.lastKnownUnitCost !== undefined
        ? { lastKnownUnitCost: fields.lastKnownUnitCost }
        : {}),
    });
  }

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
      saleModel = moduleFixture.get(getModelToken('Sale'));
      const userModel = moduleFixture.get<Model<UserDocument>>(
        getModelToken('User'),
      );
      const organizationModel = moduleFixture.get<Model<OrganizationDocument>>(
        getModelToken(Organization.name),
      );
      membershipModel = moduleFixture.get<
        Model<OrganizationMembershipDocument>
      >(getModelToken(OrganizationMembership.name));

      for (const [id, slug] of [
        [ORG_A, 'boutique-a-16e'],
        [ORG_B, 'boutique-b-16e'],
        [ORG_C, 'boutique-c-16e'],
        [ORG_D, 'boutique-d-16e'],
      ]) {
        await organizationModel.create({ _id: id, slug, name: slug });
        // Commerce ancien : observation complète, comparaison possible.
        await organizationModel.collection.updateOne(
          { _id: new Types.ObjectId(id) },
          { $set: { createdAt: new Date(2025, 0, 15) } },
        );
      }
      await activateTestSubscriptions(moduleFixture, [
        ORG_A,
        ORG_B,
        ORG_C,
        ORG_D,
      ]);
      const hash = await bcrypt.hash(PASSWORD, 10);
      const member = async (
        email: string,
        org: string,
        role: OrganizationRole,
        permissions: DelegablePermission[] = [],
      ) => {
        const user = await userModel.create({
          emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
          name: email.split('@')[0].slice(0, 20),
          email,
          password: hash,
        });
        await membershipModel.create({
          organizationId: new Types.ObjectId(org),
          userId: user._id,
          role,
          permissions,
          status: MembershipStatus.ACTIVE,
        });
        const login = await http()
          .post('/auth/login')
          .send({ email, password: PASSWORD });
        expect(login.status).toBe(201);
        return {
          token: login.body.access_token as string,
          id: user._id.toString(),
        };
      };
      const owner = await member(
        'owner-a-16e@e2e.test',
        ORG_A,
        OrganizationRole.OWNER,
      );
      ownerA = owner.token;
      ownerAId = owner.id;
      // Analyse déléguée SANS droit financier ni détails de stock.
      const analyst = await member(
        'analyst-a-16e@e2e.test',
        ORG_A,
        OrganizationRole.SELLER,
        ['analytics.read'],
      );
      analystA = analyst.token;
      analystMembershipId = String(
        (await membershipModel.findOne({
          userId: new Types.ObjectId(analyst.id),
        }))!._id,
      );
      sellerA = (
        await member('seller-a-16e@e2e.test', ORG_A, OrganizationRole.SELLER)
      ).token;
      ownerB = (
        await member('owner-b-16e@e2e.test', ORG_B, OrganizationRole.OWNER)
      ).token;
      ownerC = (
        await member('owner-c-16e@e2e.test', ORG_C, OrganizationRole.OWNER)
      ).token;
      sectionA = (
        await http().post('/sections').set(auth(ownerA)).send({ name: 'A' })
      ).body._id as string;
      sectionB = (
        await http().post('/sections').set(auth(ownerB)).send({ name: 'B' })
      ).body._id as string;
      sectionC = (
        await http().post('/sections').set(auth(ownerC)).send({ name: 'C' })
      ).body._id as string;
      ownerD = (
        await member('owner-d-16e@e2e.test', ORG_D, OrganizationRole.OWNER)
      ).token;
      sectionD = (
        await http().post('/sections').set(auth(ownerD)).send({ name: 'D' })
      ).body._id as string;

      const old = dayAt(-90);
      // Rupture constatée.
      ids.out = await seedProduct({
        name: 'Riz 5 kg',
        remainingQuantity: 0,
        initialQuantity: 10,
        createdAt: old,
      });
      // 24 unités sur 28 jours, 3 dates : 6 en stock → 7 jours exacts.
      ids.soon = await seedProduct({
        name: 'Huile 1 L',
        remainingQuantity: 6,
        createdAt: old,
      });
      for (const offset of [-2, -5, -9]) {
        await insertSale({
          productId: ids.soon,
          at: dayAt(offset),
          quantity: 8,
        });
      }
      // Une seule date de vente : pas d'estimation, 80 % consommé → faible.
      ids.low = await seedProduct({
        name: 'Sucre',
        remainingQuantity: 2,
        initialQuantity: 10,
        createdAt: old,
      });
      await insertSale({ productId: ids.low, at: dayAt(-3), quantity: 1 });
      // Aucune vente sur 28 jours (une seule, il y a 40 jours).
      ids.stale = await seedProduct({
        name: 'Parapluie',
        remainingQuantity: 50,
        createdAt: old,
      });
      await insertSale({ productId: ids.stale, at: dayAt(-40) });
      // Ajouté il y a 3 jours, jamais vendu : distingué (« récent »).
      ids.recent = await seedProduct({
        name: 'Nouveau savon',
        remainingQuantity: 20,
        initialQuantity: 20,
        createdAt: dayAt(-3),
      });
      // Vendu sous le prix d'achat aujourd'hui : gain négatif.
      ids.price = await seedProduct({
        name: 'Lait',
        purchasePrice: 500,
        remainingQuantity: 80,
        createdAt: old,
      });
      await insertSale({
        productId: ids.price,
        at: new Date(),
        quantity: 2,
        salePrice: 400,
      });
      // Produit supprimé définitivement : nom et coût figés à la purge.
      ids.purged = new Types.ObjectId().toString();
      await insertSale({
        productId: ids.purged,
        at: new Date(),
        quantity: 1,
        salePrice: 900,
        lastKnownProductName: 'Ancien thé',
        lastKnownUnitCost: 300,
      });
      // Commerce B : même mois, ne doit jamais apparaître chez A.
      ids.b = await seedProduct({
        name: 'Secret de B',
        org: ORG_B,
        section: sectionB,
        remainingQuantity: 0,
        createdAt: old,
      });
      await insertSale({
        productId: ids.b,
        org: ORG_B,
        at: new Date(),
        quantity: 7,
        salePrice: 10_000,
      });
      // Commerce C : produit purgé dont le coût n'a pas été conservé.
      const cPurged = new Types.ObjectId().toString();
      await insertSale({
        productId: cPurged,
        org: ORG_C,
        at: new Date(),
        lastKnownProductName: 'Inconnu C',
      });
      void sectionC;
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

  it('vendeur sans `analytics.read` : 403 ; mois futur ou invalide : 400', async () => {
    expect(
      (await http().get('/analytics/insights').set(auth(sellerA))).status,
    ).toBe(403);
    for (const month of ['2099-01', 'abc', '2026-13']) {
      const res = await http()
        .get('/analytics/insights')
        .query({ month })
        .set(auth(ownerA));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('ANALYTICS_MONTH_INVALID');
    }
  });

  it('priorités : rupture, risque estimé, prix à vérifier (≤ 3 cartes, sans doublon)', async () => {
    const body = await insights(ownerA);
    expect(body.period.month).toBe(localMonthKey(new Date()));
    expect(body.period.inProgress).toBe(true);
    expect(body.priorities.map((p) => p.kind)).toEqual([
      'out',
      'soon',
      'price',
    ]);
    const all = body.priorities.flatMap((p) => p.items.map((i) => i.productId));
    expect(new Set(all).size).toBe(all.length);

    expect(body.stock.out.items.map((i) => i.productId)).toEqual([ids.out]);
    const soon = body.stock.soon.items.find((i) => i.productId === ids.soon);
    expect(soon?.estimate).toMatchObject({
      estimable: true,
      observedDays: 28,
      distinctSaleDays: 3,
      unitsSold: 24,
      daysLeft: 7,
    });
    const low = body.stock.low.items.find((i) => i.productId === ids.low);
    expect(low?.estimate).toMatchObject({
      estimable: false,
      reason: 'insufficient_history',
    });
    expect(body.stock.stale.items.map((i) => i.productId)).toContain(ids.stale);
    expect(body.stock.stale.items.map((i) => i.productId)).not.toContain(
      ids.recent,
    );
    expect(body.stock.recent.items.map((i) => i.productId)).toEqual([
      ids.recent,
    ]);
    expect(body.priceChecks?.items).toEqual([
      expect.objectContaining({
        productId: ids.price,
        purchasePrice: 500,
        gain: 2 * 400 - 2 * 500,
      }),
    ]);
  });

  it('ventes du mois : purgé avec nom historique, stock actuel, isolation', async () => {
    const body = await insights(ownerA);
    const purged = body.topProducts.find((p) => p.productId === ids.purged);
    expect(purged).toMatchObject({
      name: 'Ancien thé',
      productDeleted: true,
      remainingQuantity: null,
    });
    const price = body.topProducts.find((p) => p.productId === ids.price);
    expect(price).toMatchObject({ remainingQuantity: 80, unitsSold: 2 });
    // Jamais les données du commerce B.
    expect(JSON.stringify(body)).not.toContain(ids.b);
    expect(JSON.stringify(body)).not.toContain('Secret de B');
    const b = await insights(ownerB);
    expect(b.summary).toMatchObject({ revenue: 70_000, salesCount: 1 });
    expect(JSON.stringify(b)).not.toContain(ids.price);
  });

  it('sans droit financier : ni gain, ni coût, ni « prix à vérifier » (même pas un décompte)', async () => {
    const body = await insights(analystA);
    expect(body.rights.financials).toBe(false);
    expect(body.summary).not.toHaveProperty('gain');
    expect(body).not.toHaveProperty('priceChecks');
    expect(body.priorities.map((p) => p.kind)).not.toContain('price');
    if (body.comparison.totals) {
      expect(body.comparison.totals).not.toHaveProperty('gain');
    }
    const text = JSON.stringify(body);
    expect(text).not.toContain('purchasePrice');
    expect(text).not.toContain('"gain"');
    // Mêmes règles pour les routes historiques de l'Analyse.
    const overview = await http()
      .get('/analytics/overview')
      .set(auth(analystA));
    expect(overview.status).toBe(200);
    expect(overview.body).not.toHaveProperty('netProfit');
    expect(overview.body).not.toHaveProperty('totalInvested');
    expect(overview.body).toHaveProperty('totalRevenue');
    const ranking = await http()
      .get('/analytics/products/ranking')
      .set(auth(analystA));
    expect(ranking.body.length).toBeGreaterThan(0);
    for (const row of ranking.body) expect(row).not.toHaveProperty('netProfit');
    // Le propriétaire les reçoit toujours.
    const ownerOverview = await http()
      .get('/analytics/overview')
      .set(auth(ownerA));
    expect(ownerOverview.body).toHaveProperty('netProfit');
  });

  it('coût inconnu (produit purgé sans coût) : gain `null`, jamais 0', async () => {
    const body = await insights(ownerC);
    expect(body.summary.gain).toBeNull();
    expect(body.summary.revenue).toBe(400);
  });

  it('mois en cours : cohérent avec l’historique mensuel exportable (1-16D)', async () => {
    const body = await insights(ownerA);
    const history = await moduleFixture.get(MonthlyHistoryService).build(
      {
        userId: ownerAId,
        organizationId: ORG_A,
        membershipId: new Types.ObjectId().toString(),
        role: OrganizationRole.OWNER,
        permissions: [],
      },
      body.period.month,
    );
    expect(body.summary.revenue).toBe(history.summary.revenue);
    expect(body.summary.salesCount).toBe(history.summary.salesCount);
    expect(body.summary.unitsSold).toBe(history.summary.quantity);
    expect(body.summary.gain).toBe(history.summary.estimatedGain);
    const overview = await http()
      .get('/analytics/overview')
      .query({ month: body.period.month })
      .set(auth(ownerA));
    expect(body.summary.gain).toBe(overview.body.netProfit);
    // Somme de l'évolution jour par jour = montant du mois.
    expect(body.trend.reduce((s, d) => s + d.revenue, 0)).toBe(
      body.summary.revenue,
    );
  });

  it('comparaison : même durée écoulée du mois précédent, jamais le mois entier', async () => {
    const body = await insights(ownerA);
    const now = new Date();
    const current = monthBounds(localMonthKey(now));
    const previousStart = new Date(
      current.start.getFullYear(),
      current.start.getMonth() - 1,
      1,
    );
    expect(new Date(body.comparison.start)).toEqual(previousStart);
    if (body.comparison.available) {
      expect(body.comparison.partial).toBe(true);
    } else {
      expect(body.comparison.reason).toBe('unequal_length');
    }
  });

  it('correction et annulation d’une vente : chiffres et stock relus à jour', async () => {
    const product = await seedProduct({
      name: 'Café',
      remainingQuantity: 30,
      initialQuantity: 30,
      createdAt: dayAt(-60),
    });
    const before = await insights(ownerA);
    const sale = await http()
      .post('/sales')
      .set(auth(ownerA))
      .send({ productId: product, quantity: 3, salePrice: 1000 });
    expect(sale.status).toBe(201);
    const corrected = await http()
      .patch(`/sales/${sale.body._id}`)
      .set(auth(ownerA))
      .send({ quantity: 1 });
    expect(corrected.status).toBe(200);
    const cancelled = await http()
      .post('/sales')
      .set(auth(ownerA))
      .send({ productId: product, quantity: 5, salePrice: 1000 });
    expect(cancelled.status).toBe(201);
    expect(
      (await http().delete(`/sales/${cancelled.body._id}`).set(auth(ownerA)))
        .status,
    ).toBe(204);

    const after = await insights(ownerA);
    expect(after.summary.revenue - before.summary.revenue).toBe(1000);
    expect(after.summary.salesCount - before.summary.salesCount).toBe(1);
    expect(after.summary.unitsSold - before.summary.unitsSold).toBe(1);
    const row = after.topProducts.find((p) => p.productId === product);
    expect(row).toMatchObject({ unitsSold: 1, remainingQuantity: 29 });
  });

  it('mois passé choisi : le stock reste le stock ACTUEL', async () => {
    const now = new Date();
    const previous = localMonthKey(
      new Date(now.getFullYear(), now.getMonth() - 1, 1),
    );
    const body = await insights(ownerA, previous);
    expect(body.period).toMatchObject({ month: previous, inProgress: false });
    expect(
      body.stock.out.items.find((i) => i.productId === ids.out)
        ?.remainingQuantity,
    ).toBe(0);
    if (body.comparison.available) {
      expect(body.comparison.partial).toBe(false);
    }
  });

  it('plus de 50 produits concernés : pages stables, sans doublon ni omission', async () => {
    const created: string[] = [];
    for (let i = 0; i < MANY_OUT; i++) {
      created.push(
        await seedProduct({
          // Noms identiques deux à deux : départage par identifiant.
          name: `Article ${String(Math.floor(i / 2)).padStart(2, '0')}`,
          org: ORG_D,
          section: sectionD,
          remainingQuantity: 0,
          initialQuantity: 5,
          createdAt: dayAt(-90),
        }),
      );
    }
    const body = await insights(ownerD);
    expect(body.priorities[0]).toMatchObject({ kind: 'out', count: MANY_OUT });
    expect(body.priorities[0].items).toHaveLength(1);
    expect(body.stock.out.count).toBe(MANY_OUT);
    expect(body.stock.out.items).toHaveLength(50);

    const page = async (offset: number, limit?: number) => {
      const res = await http()
        .get('/analytics/insights/list')
        .query({ kind: 'out', offset, ...(limit ? { limit } : {}) })
        .set(auth(ownerD));
      expect(res.status).toBe(200);
      return res.body as {
        count: number;
        offset: number;
        items: Array<{ productId: string }>;
      };
    };
    const first = await page(0);
    const second = await page(50);
    expect(first.count).toBe(MANY_OUT);
    expect(second.count).toBe(MANY_OUT);
    expect(first.items.map((i) => i.productId)).toEqual(
      body.stock.out.items.map((i) => i.productId),
    );
    expect(second.items).toHaveLength(MANY_OUT - 50);
    const all = [...first.items, ...second.items].map((i) => i.productId);
    expect(new Set(all).size).toBe(MANY_OUT);
    expect([...all].sort()).toEqual([...created].sort());
    // Ordre identique à chaque lecture (petites pages comprises).
    const small = [
      ...(await page(0, 20)).items,
      ...(await page(20, 20)).items,
      ...(await page(40, 20)).items,
      ...(await page(60, 20)).items,
    ].map((i) => i.productId);
    expect(small).toEqual(all);
    expect((await page(100)).items).toEqual([]);

    for (const query of [
      { kind: 'tout' },
      { kind: 'out', offset: -1 },
      { kind: 'out', offset: 'abc' },
      { kind: 'out', limit: 0 },
      { kind: 'out', limit: 51 },
    ]) {
      const res = await http()
        .get('/analytics/insights/list')
        .query(query)
        .set(auth(ownerD));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('ANALYTICS_LIST_INVALID');
    }
    // Isolation : le commerce A ne voit aucun de ces produits.
    const fromA = await http()
      .get('/analytics/insights/list')
      .query({ kind: 'out', limit: 50 })
      .set(auth(ownerA));
    expect(
      (fromA.body.items as Array<{ productId: string }>).some((i) =>
        created.includes(i.productId),
      ),
    ).toBe(false);
  });

  it('priorité unique : un produit en rupture ET vendu à perte n’est compté qu’une fois', async () => {
    const both = await seedProduct({
      name: 'Perte et rupture',
      purchasePrice: 900,
      remainingQuantity: 0,
      createdAt: dayAt(-90),
    });
    await insertSale({ productId: both, at: new Date(), salePrice: 400 });
    try {
      const body = await insights(ownerA);
      const listed = [
        ...body.stock.out.items,
        ...body.stock.soon.items,
        ...body.stock.low.items,
        ...body.stock.stale.items,
        ...body.stock.recent.items,
        ...(body.priceChecks?.items ?? []),
      ].map((i) => i.productId);
      expect(listed.filter((id) => id === both)).toHaveLength(1);
      expect(body.stock.out.items.map((i) => i.productId)).toContain(both);
      expect(body.priceChecks?.items.map((i) => i.productId)).not.toContain(
        both,
      );
      // Carte et liste : même décompte.
      for (const card of body.priorities) {
        const list =
          card.kind === 'price'
            ? body.priceChecks
            : body.stock[card.kind as 'out' | 'soon' | 'low' | 'stale'];
        expect(card.count).toBe(list?.count);
      }
    } finally {
      await saleModel.deleteMany({ productId: new Types.ObjectId(both) });
      await productModel.deleteOne({ _id: new Types.ObjectId(both) });
    }
  });

  it('droits de stock : rien de réservé à `products.view_stock_details` ; retrait des droits appliqué à la lecture suivante', async () => {
    // Sans `products.view_stock_details` : stock restant (standard) et
    // rythme des ventes (analyse), jamais le stock initial.
    const body = await insights(analystA);
    const text = JSON.stringify(body);
    expect(text).not.toContain('initialQuantity');
    expect(text).not.toContain('purchasePrice');
    expect(body.stock.out.items[0]).toHaveProperty('remainingQuantity');
    const list = await http()
      .get('/analytics/insights/list')
      .query({ kind: 'soon' })
      .set(auth(analystA));
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain('initialQuantity');
    expect(
      (
        await http()
          .get('/analytics/insights/list')
          .query({ kind: 'price' })
          .set(auth(analystA))
      ).status,
    ).toBe(403);

    const setPermissions = (permissions: DelegablePermission[]) =>
      membershipModel.updateOne(
        { _id: new Types.ObjectId(analystMembershipId) },
        { $set: { permissions } },
      );
    try {
      // Droit financier accordé puis retiré : effet dès la lecture suivante.
      await setPermissions(['analytics.read', 'products.view_financials']);
      expect((await insights(analystA)).summary).toHaveProperty('gain');
      await setPermissions(['analytics.read']);
      expect((await insights(analystA)).summary).not.toHaveProperty('gain');
      // `analytics.read` retiré : plus aucune lecture.
      await setPermissions([]);
      for (const url of ['/analytics/insights', '/analytics/insights/list']) {
        const res = await http()
          .get(url)
          .query({ kind: 'out' })
          .set(auth(analystA));
        expect(res.status).toBe(403);
      }
    } finally {
      await setPermissions(['analytics.read']);
    }
  });

  it('mois terminés de durées différentes : vrais totaux, rythme par jour distinct', async () => {
    // Même rythme (1 000 FCFA, 1 vente par jour) en février (28 j) et en
    // mars 2026 (31 j).
    const product = await seedProduct({
      name: 'Pain',
      org: ORG_D,
      section: sectionD,
      remainingQuantity: 500,
      initialQuantity: 1000,
      createdAt: new Date(2025, 5, 1),
    });
    for (const [month, days] of [
      [1, 28],
      [2, 31],
    ]) {
      for (let d = 1; d <= days; d++) {
        await insertSale({
          productId: product,
          org: ORG_D,
          at: new Date(2026, month, d, 12),
          salePrice: 1000,
        });
      }
    }
    const body = await insights(ownerD, '2026-03');
    expect(body.summary).toMatchObject({ revenue: 31_000, salesCount: 31 });
    expect(body.comparison).toMatchObject({
      available: true,
      partial: false,
      month: '2026-02',
      totals: { revenue: 28_000, salesCount: 28 },
      days: 31,
      previousDays: 28,
      revenuePerDayChange: 0,
      salesCountPerDayChange: 0,
    });
    expect(
      (body.comparison as unknown as { revenueChange: number }).revenueChange,
    ).toBeCloseTo((31 / 28 - 1) * 100, 6);
    // Base précédente à zéro : aucun pourcentage, ni total ni par jour.
    const february = await insights(ownerD, '2026-02');
    expect(february.comparison).toMatchObject({
      available: true,
      revenueChange: null,
      revenuePerDayChange: null,
    });
  });
});
