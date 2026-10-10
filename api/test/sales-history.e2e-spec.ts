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
import {
  MembershipStatus,
  OrganizationRole,
} from './../src/organizations/permissions';
import { Organization } from './../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from './../src/organizations/schemas/organization.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import {
  SALES_HISTORY_MAX_LIMIT,
  ensureSaleHistoryIndexes,
} from './../src/sales/sale-history';
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

/**
 * 1-20E — Historique paginé `GET /sales/history` : limites et paramètres,
 * ordre stable (dates identiques), parcours complet identique à `GET /sales`,
 * pages vides, total exact sur tout le périmètre, restriction `view_own`
 * (pages ET total), isolation entre organisations, filtre produit, ventes
 * créées ou annulées pendant la navigation, index de la migration.
 */

const emailSender = createE2eEmailSender();
const TEST_JWT_SECRET = 'e2e-only-static-secret-not-production-use';
const PASSWORD = 'hist-20e-pw-!1x';
const ORG_A = new Types.ObjectId();
const ORG_B = new Types.ObjectId();
const ORG_EMPTY = new Types.ObjectId();

describe('Historique paginé des ventes (e2e 1-20E)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let connection: Connection;
  let ownerA = '';
  let sellerA1 = '';
  let sellerA2 = '';
  let ownerB = '';
  let ownerEmpty = '';
  let seller1Id = '';
  let seller2Id = '';
  let productA = '';
  let productA2 = '';
  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const history = (
    token: string,
    query: Record<string, string | number> = {},
  ) => http().get('/sales/history').query(query).set(auth(token));

  /** Toutes les pages, en suivant `nextCursor`. */
  async function walk(
    token: string,
    query: Record<string, string | number> = {},
  ) {
    const ids: string[] = [];
    const totals: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await history(token, {
        ...query,
        ...(cursor ? { cursor } : {}),
      });
      expect(res.status).toBe(200);
      ids.push(...(res.body.items as Array<{ _id: string }>).map((s) => s._id));
      totals.push(res.body.total as number);
      cursor = res.body.nextCursor as string | null;
      pages += 1;
    } while (cursor && pages < 100);
    return { ids, totals, pages };
  }

  async function insertSales(
    docs: Array<{
      org: Types.ObjectId;
      seller: string;
      product: string;
      at: Date;
      quantity?: number;
    }>,
  ) {
    await connection.collection('sales').insertMany(
      docs.map((d) => ({
        organizationId: d.org,
        productId: new Types.ObjectId(d.product),
        sellerId: new Types.ObjectId(d.seller),
        quantity: d.quantity ?? 1,
        salePrice: 1000,
        productName: 'Article',
        occurredAt: d.at,
        createdAt: d.at,
      })),
    );
  }

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      process.env.MONGODB_URI = validatedEphemeralUri(replSet);
      process.env.JWT_SECRET = TEST_JWT_SECRET;
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
        [ORG_A, 'hist-a-20e'],
        [ORG_B, 'hist-b-20e'],
        [ORG_EMPTY, 'hist-empty-20e'],
      ] as const) {
        await organizationModel.create({ _id: id, slug, name: slug });
      }
      await activateTestSubscriptions(moduleFixture, [
        ORG_A.toHexString(),
        ORG_B.toHexString(),
        ORG_EMPTY.toHexString(),
      ]);
      const hash = await bcrypt.hash(PASSWORD, 10);
      const member = async (
        email: string,
        org: Types.ObjectId,
        role: OrganizationRole,
      ) => {
        const user = await userModel.create({
          emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
          name: email.split('@')[0],
          email,
          password: hash,
        });
        await membershipModel.create({
          organizationId: org,
          userId: user._id,
          role,
          status: MembershipStatus.ACTIVE,
        });
        const login = await http()
          .post('/auth/login')
          .send({ email, password: PASSWORD });
        expect(login.status).toBe(201);
        return {
          token: login.body.access_token as string,
          id: String(user._id),
        };
      };
      ownerA = (
        await member('owner-a-20e@e2e.test', ORG_A, OrganizationRole.OWNER)
      ).token;
      const s1 = await member(
        'seller-1-20e@e2e.test',
        ORG_A,
        OrganizationRole.SELLER,
      );
      const s2 = await member(
        'seller-2-20e@e2e.test',
        ORG_A,
        OrganizationRole.SELLER,
      );
      sellerA1 = s1.token;
      sellerA2 = s2.token;
      seller1Id = s1.id;
      seller2Id = s2.id;
      ownerB = (
        await member('owner-b-20e@e2e.test', ORG_B, OrganizationRole.OWNER)
      ).token;
      ownerEmpty = (
        await member('owner-e-20e@e2e.test', ORG_EMPTY, OrganizationRole.OWNER)
      ).token;

      const sectionA = (
        await http().post('/sections').set(auth(ownerA)).send({ name: 'A' })
      ).body._id as string;
      const products = connection.collection('products');
      const mk = async (name: string, org: Types.ObjectId, section: string) =>
        String(
          (
            await products.insertOne({
              organizationId: org,
              sectionId: new Types.ObjectId(section),
              name,
              purchasePrice: 500,
              salePrice: 1000,
              initialQuantity: 1000,
              remainingQuantity: 1000,
              deletedAt: null,
              imageKey: null,
              imageStorage: null,
            })
          ).insertedId,
        );
      productA = await mk('Savon', ORG_A, sectionA);
      productA2 = await mk('Huile', ORG_A, sectionA);

      // 53 ventes A : 30 du vendeur 1, 23 du vendeur 2 ; 6 partagent la MÊME
      // date (départage par _id) ; 7 ventes B.
      const base = Date.UTC(2026, 8, 1);
      const same = new Date(base + 10 * 60_000);
      const docs: Parameters<typeof insertSales>[0] = [];
      for (let i = 0; i < 53; i += 1) {
        docs.push({
          org: ORG_A,
          seller: i < 30 ? seller1Id : seller2Id,
          product: i % 4 === 0 ? productA2 : productA,
          at: i >= 20 && i < 26 ? same : new Date(base + i * 60_000),
        });
      }
      await insertSales(docs);
      await insertSales(
        Array.from({ length: 7 }, (_, i) => ({
          org: ORG_B,
          seller: seller1Id,
          product: productA,
          at: new Date(base + i * 1000),
        })),
      );
      expect(await ensureSaleHistoryIndexes(connection)).toHaveLength(2);
      expect(await ensureSaleHistoryIndexes(connection)).toEqual([]);
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

  it('1. page par défaut : 20 ventes, total de toute l’organisation, curseur suivant', async () => {
    const res = await history(ownerA);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(20);
    expect(res.body.total).toBe(53);
    expect(typeof res.body.nextCursor).toBe('string');
    // Même forme d'élément que `GET /sales` (vendeur et produit peuplés).
    expect(res.body.items[0].sellerId).toHaveProperty('name');
    expect(res.body.items[0].productId).toHaveProperty('name');
  });

  it('2. parcours complet = `GET /sales` (même ordre, aucun doublon ni oubli), dates identiques comprises', async () => {
    const legacy = await http().get('/sales').set(auth(ownerA));
    expect(legacy.status).toBe(200);
    const legacyIds = (
      legacy.body as Array<{ _id: string; createdAt: string }>
    ).map((s) => s._id);
    for (const limit of [7, 20, SALES_HISTORY_MAX_LIMIT]) {
      const { ids, totals } = await walk(ownerA, { limit });
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.sort()).toEqual([...legacyIds].sort());
      expect(new Set(totals)).toEqual(new Set([53]));
    }
    // Ordre exact : createdAt décroissant puis _id décroissant.
    const { ids } = await walk(ownerA, { limit: 5 });
    const rows = await connection
      .collection('sales')
      .find({ organizationId: ORG_A })
      .sort({ createdAt: -1, _id: -1 })
      .project({ _id: 1 })
      .toArray();
    expect(ids).toEqual(rows.map((r) => String(r._id)));
  });

  it('3. limites et paramètres invalides : 400', async () => {
    for (const query of [
      { limit: 0 },
      { limit: SALES_HISTORY_MAX_LIMIT + 1 },
      { limit: 'abc' },
      { cursor: 'not a cursor!' },
      {
        cursor: Buffer.from('["2026-01-01T00:00:00Z","zz"]').toString(
          'base64url',
        ),
      },
      { cursor: Buffer.from('[]').toString('base64url') },
      { productId: 'nope' },
      { offset: 10 },
    ]) {
      const res = await history(ownerA, query);
      expect(res.status).toBe(400);
    }
    expect(
      (await history(ownerA, { limit: SALES_HISTORY_MAX_LIMIT })).body.items,
    ).toHaveLength(53);
  });

  it('4. organisation sans vente : page vide, total 0, aucun curseur', async () => {
    const res = await history(ownerEmpty);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], total: 0, nextCursor: null });
  });

  it('5. isolation : l’organisation B ne voit que ses 7 ventes ; un curseur de A ne révèle rien de A', async () => {
    const b = await walk(ownerB, { limit: 3 });
    expect(b.ids).toHaveLength(7);
    expect(new Set(b.totals)).toEqual(new Set([7]));
    const cursorA = (await history(ownerA, { limit: 2 })).body
      .nextCursor as string;
    const res = await history(ownerB, { cursor: cursorA });
    expect(res.status).toBe(200);
    const aIds = new Set((await walk(ownerA)).ids);
    expect(
      (res.body.items as Array<{ _id: string }>).some((s) => aIds.has(s._id)),
    ).toBe(false);
    expect(res.body.total).toBe(7);
  });

  it('6. vendeur sans `sales.view_all` : ses seules ventes, pages ET total', async () => {
    const one = await walk(sellerA1, { limit: 8 });
    expect(one.ids).toHaveLength(30);
    expect(new Set(one.totals)).toEqual(new Set([30]));
    const two = await walk(sellerA2, { limit: 8 });
    expect(two.ids).toHaveLength(23);
    expect(new Set(two.totals)).toEqual(new Set([23]));
    expect(one.ids.some((id) => two.ids.includes(id))).toBe(false);
    const first = await history(sellerA2);
    for (const s of first.body.items as Array<{ sellerId: { name: string } }>) {
      expect(s.sellerId.name).toBe('seller-2-20e');
    }
  });

  it('7. filtre produit : appliqué avant la pagination, total du filtre', async () => {
    const f = await walk(ownerA, { productId: productA2, limit: 4 });
    expect(f.ids).toHaveLength(14); // i % 4 === 0 parmi 0..52
    expect(new Set(f.totals)).toEqual(new Set([14]));
  });

  it('8. vente créée puis annulée PENDANT la navigation : pages stables, total à jour, aucun doublon', async () => {
    const page1 = await history(ownerA, { limit: 10 });
    const cursor = page1.body.nextCursor as string;
    // Nouvelle vente (la plus récente) pendant la navigation.
    const sale = await http()
      .post('/sales')
      .set(auth(sellerA1))
      .send({ productId: productA, quantity: 1, salePrice: 1000 });
    expect(sale.status).toBe(201);
    const page2 = await history(ownerA, { limit: 10, cursor });
    expect(page2.body.total).toBe(54);
    const p1 = (page1.body.items as Array<{ _id: string }>).map((s) => s._id);
    const p2 = (page2.body.items as Array<{ _id: string }>).map((s) => s._id);
    expect(p2.some((id) => p1.includes(id))).toBe(false);
    expect(p2).not.toContain(sale.body._id);
    // Elle apparaît en tête de la première page.
    expect((await history(ownerA, { limit: 10 })).body.items[0]._id).toBe(
      sale.body._id,
    );
    // Annulation d'une vente de la page 2 : la relecture de la page 2 ne la
    // montre plus, le total baisse, la page reste pleine (vente suivante).
    const cancelled = p2[3];
    expect(
      (await http().delete(`/sales/${cancelled}`).set(auth(ownerA))).status,
    ).toBe(204);
    const again = await history(ownerA, { limit: 10, cursor });
    expect(again.body.total).toBe(53);
    expect(
      (again.body.items as Array<{ _id: string }>).map((s) => s._id),
    ).not.toContain(cancelled);
    expect(again.body.items).toHaveLength(10);
  });

  it('9. dernière page vidée : page vide, `nextCursor` null', async () => {
    const all = await walk(ownerB, { limit: 3 });
    expect(all.pages).toBe(3);
    // Curseur au-delà de la plus ancienne vente de B.
    const lastId = all.ids[all.ids.length - 1];
    const lastRaw = await connection
      .collection('sales')
      .findOne({ _id: new Types.ObjectId(lastId) });
    const beyond = Buffer.from(
      JSON.stringify([(lastRaw!.createdAt as Date).toISOString(), lastId]),
    ).toString('base64url');
    const res = await history(ownerB, { cursor: beyond });
    expect(res.body).toEqual({ items: [], total: 7, nextCursor: null });
  });

  it('10. plan de requête : index de l’historique utilisé, documents lus bornés à la page', async () => {
    const explain = (await connection
      .collection('sales')
      .find({ organizationId: ORG_A })
      .sort({ createdAt: -1, _id: -1 })
      .limit(21)
      .explain('executionStats')) as {
      queryPlanner: { winningPlan: unknown };
      executionStats: { totalDocsExamined: number };
    };
    expect(JSON.stringify(explain.queryPlanner.winningPlan)).toContain(
      'organizationId_1_createdAt_-1__id_-1',
    );
    expect(JSON.stringify(explain.queryPlanner.winningPlan)).not.toContain(
      '"SORT"',
    );
    expect(explain.executionStats.totalDocsExamined).toBeLessThanOrEqual(21);
  });

  it('10b. page éloignée : le curseur borne le parcours d’index (coût indépendant de la profondeur)', async () => {
    const rows = await connection
      .collection('sales')
      .find({ organizationId: ORG_A })
      .sort({ createdAt: -1, _id: -1 })
      .toArray();
    const deep = rows[40];
    // Même forme de filtre que `SalesService.findHistoryPage`.
    const explain = (await connection
      .collection('sales')
      .find({
        organizationId: ORG_A,
        createdAt: { $lte: deep.createdAt },
        $or: [
          { createdAt: { $lt: deep.createdAt } },
          { _id: { $lt: deep._id } },
        ],
      })
      .sort({ createdAt: -1, _id: -1 })
      .limit(11)
      .explain('executionStats')) as {
      executionStats: { totalKeysExamined: number; nReturned: number };
    };
    expect(explain.executionStats.nReturned).toBe(11);
    // Parcours depuis le curseur (+ ventes de même date), jamais depuis la tête.
    expect(explain.executionStats.totalKeysExamined).toBeLessThanOrEqual(
      11 + 6,
    );
  });

  it('11. ancien contrat `GET /sales` inchangé : historique complet (tableau)', async () => {
    const res = await http().get('/sales').set(auth(ownerA));
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(53);
  });
});
