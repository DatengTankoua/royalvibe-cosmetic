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
import {
  MembershipStatus,
  OrganizationRole,
} from './../src/organizations/permissions';
import { Organization } from './../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from './../src/organizations/schemas/organization.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import {
  PRODUCT_PAGE_DEFAULT_LIMIT,
  PRODUCT_PAGE_MAX_LIMIT,
  countProductsWithoutCreatedAt,
  ensureProductPageIndexes,
} from './../src/products/product-page';
import { S3Service } from './../src/s3/s3.service';
import { productImagePrefix } from './../src/storage-quota/storage-prefixes';
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
 * 1-20F — Liste paginée `GET /products?limit=…` : limites et paramètres,
 * ordre déterministe (dates identiques), parcours complet identique à
 * l'ancien contrat, recherche sur tout le périmètre (règle inchangée :
 * casse ignorée, accents distingués, aucun motif client), totaux du
 * périmètre complet, isolation, projection selon les permissions, agrégats
 * jamais limités à la page, signatures des seuls produits renvoyés,
 * modifications pendant la navigation, plans de requête et index.
 */

const emailSender = createE2eEmailSender();
const TEST_JWT_SECRET = 'e2e-only-static-secret-not-production-use';
const PASSWORD = 'page-20f-pw-!1x';
const ORG_A = new Types.ObjectId();
const ORG_B = new Types.ObjectId();
const ORG_EMPTY = new Types.ObjectId();

interface Envelope {
  product: {
    _id: string;
    name: string;
    sectionId: string;
    remainingQuantity: number;
    purchasePrice?: number;
    initialQuantity?: number;
  };
  status: string;
  actualRevenue?: number;
}

/** Noms spéciaux (recherche) ; le reste : `Article 001…`. */
const SPECIAL = [
  'Éclair au café',
  'éclair vanille',
  'ECLAIR nature',
  'Eclair sans accent',
  'Prix a.b',
  'Prix axb',
  'Savon (lot)',
  'Crème  double',
];

describe('Liste paginée des produits (e2e 1-20F)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let connection: Connection;
  let ownerA = '';
  let sellerA = '';
  let ownerB = '';
  let ownerEmpty = '';
  let sectionA = '';
  let sectionA2 = '';
  let sectionB = '';
  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const page = (token: string, query: Record<string, string | number> = {}) =>
    http().get('/products').query(query).set(auth(token));
  const ids = (body: { items: Envelope[] }) =>
    body.items.map((e) => e.product._id);

  /** Toutes les pages, en suivant `nextCursor`. */
  async function walk(
    token: string,
    query: Record<string, string | number>,
  ): Promise<{ ids: string[]; totals: number[]; pages: number }> {
    const out: string[] = [];
    const totals: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await page(token, {
        ...query,
        ...(cursor ? { cursor } : {}),
      });
      expect(res.status).toBe(200);
      out.push(...ids(res.body));
      totals.push(res.body.total as number);
      cursor = res.body.nextCursor as string | null;
      pages += 1;
    } while (cursor && pages < 200);
    return { ids: out, totals, pages };
  }

  /** Ancien contrat : tableau complet du rayon (référence). */
  async function legacy(token: string, section: string): Promise<Envelope[]> {
    const res = await page(token, { sectionId: section });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    return res.body as Envelope[];
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
        [ORG_A, 'page-a-20f'],
        [ORG_B, 'page-b-20f'],
        [ORG_EMPTY, 'page-empty-20f'],
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
        return login.body.access_token as string;
      };
      ownerA = await member(
        'owner-a-20f@e2e.test',
        ORG_A,
        OrganizationRole.OWNER,
      );
      sellerA = await member(
        'seller-a-20f@e2e.test',
        ORG_A,
        OrganizationRole.SELLER,
      );
      ownerB = await member(
        'owner-b-20f@e2e.test',
        ORG_B,
        OrganizationRole.OWNER,
      );
      ownerEmpty = await member(
        'owner-e-20f@e2e.test',
        ORG_EMPTY,
        OrganizationRole.OWNER,
      );
      const section = async (token: string, name: string) =>
        (await http().post('/sections').set(auth(token)).send({ name })).body
          ._id as string;
      sectionA = await section(ownerA, 'Rayon A');
      sectionA2 = await section(ownerA, 'Rayon A2');
      sectionB = await section(ownerB, 'Rayon B');

      // Rayon A : 60 produits (8 noms spéciaux), 10 de MÊME date (départage
      // par _id), photos sous le préfixe de l'organisation (signature
      // tentée par produit renvoyé) ; Rayon A2 : 3 ; Rayon B : 5 ; un
      // produit de A dans la corbeille.
      const base = Date.UTC(2026, 8, 1);
      const same = new Date(base + 30 * 60_000);
      const docs: Array<Record<string, unknown>> = [];
      for (let i = 0; i < 60; i += 1) {
        const at = i >= 30 && i < 40 ? same : new Date(base + i * 60_000);
        docs.push({
          organizationId: ORG_A,
          sectionId: new Types.ObjectId(sectionA),
          name:
            i < SPECIAL.length
              ? SPECIAL[i]
              : `Article ${String(i).padStart(3, '0')}`,
          purchasePrice: 500,
          salePrice: 1000,
          initialQuantity: 100,
          remainingQuantity: 100,
          deletedAt: null,
          imageKey: `${productImagePrefix(ORG_A.toHexString())}/p-${i}.webp`,
          imageStorage: 'e2e-storage',
          createdAt: at,
          updatedAt: at,
        });
      }
      for (let i = 0; i < 3; i += 1) {
        docs.push({
          organizationId: ORG_A,
          sectionId: new Types.ObjectId(sectionA2),
          name: `Autre ${i}`,
          purchasePrice: 500,
          salePrice: 1000,
          initialQuantity: 100,
          remainingQuantity: 100,
          deletedAt: null,
          imageKey: null,
          imageStorage: null,
          createdAt: new Date(base + i),
          updatedAt: new Date(base + i),
        });
      }
      docs.push({
        organizationId: ORG_A,
        sectionId: new Types.ObjectId(sectionA),
        name: 'Article corbeille',
        purchasePrice: 500,
        salePrice: 1000,
        initialQuantity: 100,
        remainingQuantity: 100,
        deletedAt: new Date(base),
        imageKey: null,
        imageStorage: null,
        createdAt: new Date(base + 5),
        updatedAt: new Date(base + 5),
      });
      for (let i = 0; i < 5; i += 1) {
        docs.push({
          organizationId: ORG_B,
          sectionId: new Types.ObjectId(sectionB),
          name: `Article ${String(i).padStart(3, '0')}`,
          purchasePrice: 500,
          salePrice: 1000,
          initialQuantity: 100,
          remainingQuantity: 100,
          deletedAt: null,
          imageKey: null,
          imageStorage: null,
          createdAt: new Date(base + i),
          updatedAt: new Date(base + i),
        });
      }
      await connection.collection('products').insertMany(docs);
      expect(await ensureProductPageIndexes(connection)).toHaveLength(1);
      expect(await ensureProductPageIndexes(connection)).toEqual([]);
      expect(await countProductsWithoutCreatedAt(connection)).toBe(0);
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

  it('1. page par défaut : 24 produits, totaux du rayon, curseur suivant ; sans `limit` : tableau complet inchangé', async () => {
    const res = await page(ownerA, {
      sectionId: sectionA,
      limit: PRODUCT_PAGE_DEFAULT_LIMIT,
    });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(24);
    expect(res.body.total).toBe(60);
    expect(res.body.scopeTotal).toBe(60);
    expect(typeof res.body.nextCursor).toBe('string');
    // Même forme d'élément que l'ancien contrat.
    expect(Object.keys(res.body.items[0]).sort()).toEqual(
      Object.keys((await legacy(ownerA, sectionA))[0]).sort(),
    );
    expect(await legacy(ownerA, sectionA)).toHaveLength(60);
    // `ids` (1-20D) inchangé : tableau, sans pagination.
    const targeted = await page(ownerA, {
      ids: ids(res.body).slice(0, 2).join(','),
    });
    expect(Array.isArray(targeted.body)).toBe(true);
    expect(targeted.body).toHaveLength(2);
  });

  it('2. parcours complet = ancien contrat (même ordre, aucun doublon ni oubli), dates identiques comprises', async () => {
    const reference = (await legacy(ownerA, sectionA)).map(
      (e) => e.product._id,
    );
    const rows = await connection
      .collection('products')
      .find({
        organizationId: ORG_A,
        sectionId: new Types.ObjectId(sectionA),
        deletedAt: null,
      })
      .sort({ createdAt: -1, _id: -1 })
      .project({ _id: 1 })
      .toArray();
    for (const limit of [1, 7, 24, PRODUCT_PAGE_MAX_LIMIT]) {
      const walked = await walk(ownerA, { sectionId: sectionA, limit });
      expect(new Set(walked.ids).size).toBe(walked.ids.length);
      expect([...walked.ids].sort()).toEqual([...reference].sort());
      // Ordre exact et déterministe : createdAt puis _id décroissants.
      expect(walked.ids).toEqual(rows.map((r) => String(r._id)));
      expect(new Set(walked.totals)).toEqual(new Set([60]));
      expect(walked.pages).toBe(Math.ceil(60 / limit));
    }
  });

  it('3. limites et paramètres invalides : 400 (aucune troncature silencieuse)', async () => {
    const forged = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const query of [
      { limit: 0 },
      { limit: PRODUCT_PAGE_MAX_LIMIT + 1 },
      { limit: 'abc' },
      { limit: '1.5' },
      { limit: -1 },
      { limit: 10, cursor: 'not a cursor!' },
      { limit: 10, cursor: forged(['2026-01-01T00:00:00Z', 'zz']) },
      { limit: 10, cursor: forged(['pas une date', '0'.repeat(24)]) },
      { limit: 10, cursor: forged([]) },
      { limit: 10, cursor: 'a'.repeat(201) },
      { limit: 10, q: '   ' },
      { limit: 10, q: 'x'.repeat(201) },
      { limit: 10, sectionId: 'nope' },
      { limit: 10, ids: '0'.repeat(24) },
      { cursor: forged(['2026-01-01T00:00:00Z', '0'.repeat(24)]) },
      { q: 'Savon' },
    ]) {
      const res = await page(ownerA, query);
      expect([query, res.status]).toEqual([query, 400]);
    }
    const repeated = await http()
      .get(`/products?limit=10&limit=20`)
      .set(auth(ownerA));
    expect(repeated.status).toBe(400);
  });

  it('4. recherche : tout le périmètre, même règle que l’ancienne recherche du web (casse ignorée, accents distingués, texte littéral)', async () => {
    const all = await legacy(ownerA, sectionA);
    // Ordre de référence : createdAt puis _id décroissants (l'ancien contrat
    // ne départage pas les dates identiques).
    const ordered = (
      await connection
        .collection('products')
        .find({
          organizationId: ORG_A,
          sectionId: new Types.ObjectId(sectionA),
          deletedAt: null,
        })
        .sort({ createdAt: -1, _id: -1 })
        .toArray()
    ).map((r) => ({ _id: String(r._id), name: r.name as string }));
    expect(ordered.map((r) => r._id).sort()).toEqual(
      all.map((e) => e.product._id).sort(),
    );
    // Règle du web 1-20E : `name.toLowerCase().includes(q.toLowerCase())`.
    const expected = (q: string) =>
      ordered
        .filter((r) => r.name.toLowerCase().includes(q.toLowerCase()))
        .map((r) => r._id);
    for (const q of [
      'éclair',
      'ÉCLAIR',
      'eclair',
      'a.b',
      '.*',
      '(lot)',
      'Crème  d',
      ' double',
      'article 05',
      'introuvable',
      '^Prix',
      '[a-z]',
      '\\',
    ]) {
      const walked = await walk(ownerA, { sectionId: sectionA, limit: 2, q });
      expect([q, walked.ids]).toEqual([q, expected(q)]);
      expect(new Set(walked.totals)).toEqual(new Set([expected(q).length]));
    }
    // Produit hors de la première page trouvé dès la première page.
    const first = await page(ownerA, { sectionId: sectionA, limit: 24 });
    const deep = all.find(
      (e) =>
        !ids(first.body).includes(e.product._id) &&
        e.product.name.startsWith('Article 01'),
    );
    expect(deep).toBeDefined();
    const found = await page(ownerA, {
      sectionId: sectionA,
      limit: 24,
      q: deep!.product.name,
    });
    expect(ids(found.body)).toEqual([deep!.product._id]);
    expect(found.body.total).toBe(1);
    // `scopeTotal` : tout le rayon, indépendamment de la recherche.
    expect(found.body.scopeTotal).toBe(60);
    const none = await page(ownerA, {
      sectionId: sectionA,
      limit: 24,
      q: 'zzz',
    });
    expect(none.body).toEqual({
      items: [],
      total: 0,
      scopeTotal: 60,
      nextCursor: null,
    });
  });

  it('5. isolation : autre organisation, rayon d’une autre organisation, curseur d’une autre organisation', async () => {
    const b = await walk(ownerB, { sectionId: sectionB, limit: 2 });
    expect(b.ids).toHaveLength(5);
    expect(new Set(b.totals)).toEqual(new Set([5]));
    // Rayon de A demandé par B : vide, totaux nuls (aucune fuite).
    const cross = await page(ownerB, { sectionId: sectionA, limit: 24 });
    expect(cross.body).toEqual({
      items: [],
      total: 0,
      scopeTotal: 0,
      nextCursor: null,
    });
    // Recherche de B sans rayon : jamais un produit de A.
    const search = await page(ownerB, { limit: 100, q: 'Article' });
    expect(search.body.total).toBe(5);
    // Curseur de A rejoué par B : seuls des produits de B.
    const a = await page(ownerA, { sectionId: sectionA, limit: 3 });
    const replay = await page(ownerB, {
      limit: 100,
      cursor: a.body.nextCursor,
    });
    expect(replay.status).toBe(200);
    for (const e of replay.body.items as Envelope[]) {
      expect(b.ids).toContain(e.product._id);
    }
    const empty = await page(ownerEmpty, { limit: 24 });
    expect(empty.body).toEqual({
      items: [],
      total: 0,
      scopeTotal: 0,
      nextCursor: null,
    });
    // Sans rayon : toute l'organisation (corbeille exclue).
    const whole = await page(ownerA, { limit: 100 });
    expect(whole.body.total).toBe(63);
  });

  it('6. projection selon les permissions et agrégats sur toutes les ventes (jamais la page)', async () => {
    const all = await legacy(ownerA, sectionA);
    const target = all[all.length - 1].product._id; // dernière page
    await connection.collection('sales').insertMany(
      [3, 4].map((quantity) => ({
        organizationId: ORG_A,
        productId: new Types.ObjectId(target),
        sellerId: new Types.ObjectId(),
        quantity,
        salePrice: 1000,
        productName: 'x',
        createdAt: new Date(),
      })),
    );
    const owner = await walk(ownerA, { sectionId: sectionA, limit: 24 });
    expect(owner.ids).toContain(target);
    const last = await page(ownerA, {
      sectionId: sectionA,
      limit: 24,
      q: all[all.length - 1].product.name,
    });
    const envelope = (last.body.items as Envelope[]).find(
      (e) => e.product._id === target,
    )!;
    expect(envelope.actualRevenue).toBe(7000);
    expect(envelope.product.purchasePrice).toBe(500);
    expect(envelope.product.initialQuantity).toBe(100);
    // Même agrégat que l'ancien contrat.
    const legacyEnvelope = (await legacy(ownerA, sectionA)).find(
      (e) => e.product._id === target,
    )!;
    expect(legacyEnvelope.actualRevenue).toBe(7000);

    // Vendeur standard : mêmes champs que l'ancien contrat, aucun champ restreint.
    const sellerLegacy = await legacy(sellerA, sectionA);
    const sellerPage = await page(sellerA, { sectionId: sectionA, limit: 24 });
    expect(sellerPage.status).toBe(200);
    for (const e of sellerPage.body.items as Envelope[]) {
      expect(e.product.purchasePrice).toBeUndefined();
      expect(e.product.initialQuantity).toBeUndefined();
      expect(e.actualRevenue).toBeUndefined();
      const same = sellerLegacy.find((x) => x.product._id === e.product._id)!;
      expect(Object.keys(e).sort()).toEqual(Object.keys(same).sort());
      expect(Object.keys(e.product).sort()).toEqual(
        Object.keys(same.product).sort(),
      );
    }
    await connection
      .collection('sales')
      .deleteMany({ productId: new Types.ObjectId(target) });
  });

  it('7. photos : seuls les produits renvoyés sont signés', async () => {
    const s3 = moduleFixture.get(S3Service);
    const spy = jest.spyOn(s3, 'signedReadUrl');
    try {
      const res = await page(ownerA, { sectionId: sectionA, limit: 5 });
      expect(res.body.items).toHaveLength(5);
      expect(spy).toHaveBeenCalledTimes(5);
      spy.mockClear();
      await page(ownerA, { sectionId: sectionA, limit: 24, q: 'zzz' });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('8. vente puis annulation : stock exact sur la page', async () => {
    const first = await page(ownerA, { sectionId: sectionA, limit: 24 });
    const target = (first.body.items as Envelope[])[0].product;
    const sale = await http().post('/sales').set(auth(sellerA)).send({
      productId: target._id,
      quantity: 2,
      salePrice: 1000,
      clientOperationId: randomUUID(),
    });
    expect(sale.status).toBe(201);
    const after = await page(ownerA, { sectionId: sectionA, limit: 24 });
    const sold = (after.body.items as Envelope[]).find(
      (e) => e.product._id === target._id,
    )!;
    expect(sold.product.remainingQuantity).toBe(target.remainingQuantity - 2);
    expect(ids(after.body)).toEqual(ids(first.body)); // position inchangée
    const cancel = await http()
      .delete(`/sales/${sale.body._id as string}`)
      .set(auth(ownerA));
    expect(cancel.status).toBe(204);
    const restored = await page(ownerA, { sectionId: sectionA, limit: 24 });
    expect(
      (restored.body.items as Envelope[]).find(
        (e) => e.product._id === target._id,
      )!.product.remainingQuantity,
    ).toBe(target.remainingQuantity);
  });

  it('9. corbeille, restauration, déplacement et création pendant la navigation : pages cohérentes, sans doublon ni produit supprimé', async () => {
    const p1 = await page(ownerA, { sectionId: sectionA, limit: 24 });
    const p1Ids = ids(p1.body);
    // Corbeille d'un produit de la page 1.
    const trashed = p1Ids[3];
    expect(
      (await http().delete(`/products/${trashed}`).set(auth(ownerA))).status,
    ).toBe(200);
    const p1b = await page(ownerA, { sectionId: sectionA, limit: 24 });
    expect(ids(p1b.body)).not.toContain(trashed);
    expect(p1b.body.items).toHaveLength(24); // page complétée
    expect(p1b.body.total).toBe(59);
    // Page suivante depuis la page RELUE : aucun doublon, corbeille absente.
    const p2 = await page(ownerA, {
      sectionId: sectionA,
      limit: 24,
      cursor: p1b.body.nextCursor,
    });
    expect(ids(p2.body).filter((id) => ids(p1b.body).includes(id))).toEqual([]);
    const walked = await walk(ownerA, { sectionId: sectionA, limit: 24 });
    expect(walked.ids).not.toContain(trashed);
    expect(new Set(walked.ids).size).toBe(59);

    // Restauration : revient à sa place d'origine (createdAt inchangé).
    expect(
      (await http().patch(`/products/${trashed}/restore`).set(auth(ownerA)))
        .status,
    ).toBe(200);
    expect(
      ids((await page(ownerA, { sectionId: sectionA, limit: 24 })).body),
    ).toEqual(p1Ids);

    // Déplacement vers le rayon A2 : quitte A (pages et totaux), rejoint A2.
    const moved = p1Ids[0];
    const patch = await http()
      .patch(`/products/${moved}`)
      .set(auth(ownerA))
      .send({ sectionId: sectionA2 });
    expect(patch.status).toBe(200);
    const inA = await walk(ownerA, { sectionId: sectionA, limit: 24 });
    expect(inA.ids).not.toContain(moved);
    expect(new Set(inA.totals)).toEqual(new Set([59]));
    const inA2 = await page(ownerA, { sectionId: sectionA2, limit: 24 });
    expect(ids(inA2.body)).toContain(moved);
    expect(inA2.body.total).toBe(4);
    await http()
      .patch(`/products/${moved}`)
      .set(auth(ownerA))
      .send({ sectionId: sectionA });

    // Création : en tête, jamais sur une page suivante déjà calculée.
    const before = await page(ownerA, { sectionId: sectionA, limit: 24 });
    const created = await connection.collection('products').insertOne({
      organizationId: ORG_A,
      sectionId: new Types.ObjectId(sectionA),
      name: 'Nouveau 20F',
      purchasePrice: 1,
      salePrice: 2,
      initialQuantity: 1,
      remainingQuantity: 1,
      deletedAt: null,
      imageKey: null,
      imageStorage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const next = await page(ownerA, {
      sectionId: sectionA,
      limit: 24,
      cursor: before.body.nextCursor,
    });
    expect(ids(next.body)).not.toContain(String(created.insertedId));
    const head = await page(ownerA, { sectionId: sectionA, limit: 24 });
    expect(ids(head.body)[0]).toBe(String(created.insertedId));
    expect(head.body.total).toBe(61);
    await connection
      .collection('products')
      .deleteOne({ _id: created.insertedId });
  });

  it('10. plans de requête : index de la page, aucun tri en mémoire, documents bornés par la page', async () => {
    const products = connection.collection('products');
    const scope = {
      organizationId: ORG_A,
      sectionId: new Types.ObjectId(sectionA),
      deletedAt: null,
    };
    const first = (await products
      .find(scope)
      .sort({ createdAt: -1, _id: -1 })
      .limit(25)
      .explain('executionStats')) as {
      queryPlanner: { winningPlan: unknown };
      executionStats: { totalDocsExamined: number };
    };
    const plan = JSON.stringify(first.queryPlanner.winningPlan);
    expect(plan).toContain(
      'organizationId_1_sectionId_1_deletedAt_1_createdAt_-1__id_-1',
    );
    expect(plan).not.toContain('"SORT"');
    expect(first.executionStats.totalDocsExamined).toBeLessThanOrEqual(25);

    // Page éloignée : même forme de filtre que `productPageFilter`.
    const rows = await products
      .find(scope)
      .sort({ createdAt: -1, _id: -1 })
      .toArray();
    const deep = rows[45];
    const far = (await products
      .find({
        ...scope,
        createdAt: { $lte: deep.createdAt },
        $or: [
          { createdAt: { $lt: deep.createdAt } },
          { _id: { $lt: deep._id } },
        ],
      })
      .sort({ createdAt: -1, _id: -1 })
      .limit(6)
      .explain('executionStats')) as {
      executionStats: { totalKeysExamined: number; nReturned: number };
    };
    expect(far.executionStats.nReturned).toBe(6);
    expect(far.executionStats.totalKeysExamined).toBeLessThanOrEqual(6 + 10);
  });
});
