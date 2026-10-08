import 'reflect-metadata';
import { inflateRawSync, inflateSync } from 'zlib';
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
 * E2E 1-16D — historique mensuel exportable (Excel, PDF).
 *
 * Replica set éphémère (garde anti-27017), aucun `.env`, aucun envoi.
 * Les fichiers produits sont décompressés et lus ici (ZIP et flux PDF) :
 * le contenu réel est contrôlé, pas seulement le code HTTP.
 */

const TEST_JWT_SECRET = 'e2e-only-static-secret-not-production-use';
const PASSWORD = 'hist-16d-pw-!1x';
const ORG_A = 'a16d0000000000000000000a';
const ORG_B = 'b16d0000000000000000000b';
// Commerce dédié : gain mensuel sur deux mois, vendeur supprimé.
const ORG_C = 'c16d0000000000000000000c';
// Mois passés fixes, indépendants de la date d'exécution.
const MONTH = '2025-03';
// (Avril reçoit la vente posée exactement à la borne de fin de mars.)
const EMPTY_MONTH = '2025-08';
const BIG_MONTH = '2025-05';

/** Lecture minimale d'une archive ZIP (répertoire central). */
function unzip(buffer: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let p = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const method = buffer.readUInt16LE(p + 10);
    const size = buffer.readUInt32LE(p + 20);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extra = buffer.readUInt16LE(p + 30);
    const comment = buffer.readUInt16LE(p + 32);
    const local = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLength);
    const localName = buffer.readUInt16LE(local + 26);
    const localExtra = buffer.readUInt16LE(local + 28);
    const start = local + 30 + localName + localExtra;
    const data = buffer.subarray(start, start + size);
    files.set(
      name,
      (method === 8 ? inflateRawSync(data) : data).toString('utf8'),
    );
    p += 46 + nameLength + extra + comment;
  }
  return files;
}

const sheetRows = (xml: string) => xml.match(/<row /g)?.length ?? 0;
const inlineTexts = (xml: string) =>
  [...xml.matchAll(/<t xml:space="preserve">([^<]*)<\/t>/g)].map((m) =>
    m[1]
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&'),
  );

/** Texte visible d'un PDF produit ici (flux Flate, chaînes hex WinAnsi). */
function pdfText(buffer: Buffer): { pages: number; text: string } {
  const raw = buffer.toString('latin1');
  const pages = Number(
    /\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(raw)?.[1],
  );
  let text = '';
  // `>>\nstream\n` : début d'un flux (jamais la fin `endstream`).
  const re = />>\nstream\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const stop = raw.indexOf('\nendstream', start);
    const content = inflateSync(buffer.subarray(start, stop)).toString(
      'latin1',
    );
    for (const hex of content.matchAll(/<([0-9a-f]*)> Tj/g)) {
      text += Buffer.from(hex[1], 'hex').toString('latin1') + '\n';
    }
  }
  return { pages, text };
}

describe('E2E 1-16D — historique mensuel exportable', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let productModel: Model<ProductDocument>;
  let saleModel: Model<SaleDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;
  let ownerA = '';
  let adminA = '';
  let sellerA = '';
  let sellerAId = '';
  let grantedSellerA = '';
  let ownerB = '';
  let sectionA = '';
  let sectionB = '';
  let ownerC = '';
  let sellerCId = '';
  let sectionC = '';
  let userModel: Model<UserDocument>;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const download = (
    token: string,
    month: string,
    format: string,
    lang?: 'fr' | 'en',
  ) =>
    http()
      .get(`/reports/monthly/${month}/${format}`)
      .query(lang ? { lang } : {})
      .set(auth(token))
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });

  async function seedProduct(
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
      initialQuantity: 1000,
      remainingQuantity: 1000,
      organizationId: new Types.ObjectId(org),
    });
    return product._id.toString();
  }

  /** Vente historique insérée à une date choisie (bornes du mois). */
  async function insertSale(fields: {
    productId: string;
    at: Date | null;
    createdAt?: Date;
    quantity?: number;
    salePrice?: number;
    org?: string;
    sellerId?: string;
    productName?: string;
    lastKnownUnitCost?: number;
  }) {
    const doc = await saleModel.create({
      organizationId: new Types.ObjectId(fields.org ?? ORG_A),
      productId: new Types.ObjectId(fields.productId),
      quantity: fields.quantity ?? 1,
      salePrice: fields.salePrice ?? 400,
      sellerId: new Types.ObjectId(fields.sellerId ?? sellerAId),
      ...(fields.productName ? { productName: fields.productName } : {}),
      ...(fields.at ? { occurredAt: fields.at } : {}),
      ...(fields.lastKnownUnitCost !== undefined
        ? { lastKnownUnitCost: fields.lastKnownUnitCost }
        : {}),
    });
    if (fields.createdAt) {
      await saleModel.collection.updateOne(
        { _id: doc._id },
        { $set: { createdAt: fields.createdAt } },
      );
    }
    return doc._id.toString();
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
      userModel = moduleFixture.get<Model<UserDocument>>(getModelToken('User'));
      const organizationModel = moduleFixture.get<Model<OrganizationDocument>>(
        getModelToken(Organization.name),
      );
      membershipModel = moduleFixture.get(
        getModelToken(OrganizationMembership.name),
      );

      await organizationModel.create({
        _id: ORG_A,
        slug: 'boutique-a-16d',
        name: 'Boutique Étoile A',
      });
      // Création en janvier 2025 : premier mois proposé.
      await organizationModel.collection.updateOne(
        { _id: new Types.ObjectId(ORG_A) },
        { $set: { createdAt: new Date(2025, 0, 15) } },
      );
      await organizationModel.create({
        _id: ORG_B,
        slug: 'boutique-b-16d',
        name: 'Boutique B',
      });
      await organizationModel.create({
        _id: ORG_C,
        slug: 'boutique-c-16d',
        name: 'Boutique C',
      });
      await activateTestSubscriptions(moduleFixture, [ORG_A, ORG_B, ORG_C]);
      const hash = await bcrypt.hash(PASSWORD, 10);
      const member = async (
        email: string,
        org: string,
        role: OrganizationRole,
        name: string,
        permissions: DelegablePermission[] = [],
      ) => {
        const user = await userModel.create({
          emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
          name,
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
        'owner-a-16d@e2e.test',
        ORG_A,
        OrganizationRole.OWNER,
        'Propriétaire A',
      );
      ownerA = owner.token;
      adminA = (
        await member(
          'admin-a-16d@e2e.test',
          ORG_A,
          OrganizationRole.ADMIN,
          'Admin A',
        )
      ).token;
      const seller = await member(
        'seller-a-16d@e2e.test',
        ORG_A,
        OrganizationRole.SELLER,
        'Vendeuse A',
      );
      sellerA = seller.token;
      sellerAId = seller.id;
      // Vendeur à qui les deux droits ont été délégués : le rôle reste refusé.
      grantedSellerA = (
        await member(
          'granted-a-16d@e2e.test',
          ORG_A,
          OrganizationRole.SELLER,
          'Vendeur délégué',
          ['analytics.read', 'sales.view_all'],
        )
      ).token;
      ownerB = (
        await member(
          'owner-b-16d@e2e.test',
          ORG_B,
          OrganizationRole.OWNER,
          'Propriétaire B',
        )
      ).token;
      sectionA = (
        await http().post('/sections').set(auth(ownerA)).send({ name: 'A' })
      ).body._id as string;
      sectionB = (
        await http().post('/sections').set(auth(ownerB)).send({ name: 'B' })
      ).body._id as string;
      ownerC = (
        await member(
          'owner-c-16d@e2e.test',
          ORG_C,
          OrganizationRole.OWNER,
          'Propriétaire C',
        )
      ).token;
      sellerCId = (
        await member(
          'seller-c-16d@e2e.test',
          ORG_C,
          OrganizationRole.SELLER,
          'Vendeur parti',
        )
      ).id;
      sectionC = (
        await http().post('/sections').set(auth(ownerC)).send({ name: 'C' })
      ).body._id as string;
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

  it('bornes du mois identiques à l’Analyse, ventes complètes et totaux égaux', async () => {
    const { start, end } = monthBounds(MONTH);
    const product = await seedProduct('Savon « doux »');
    const inside = [
      await insertSale({
        productId: product,
        at: start,
        productName: 'Savon « doux »',
      }),
      await insertSale({
        productId: product,
        at: new Date(end.getTime() - 1),
        quantity: 3,
        productName: 'Savon « doux »',
      }),
      // Vente ancienne sans `occurredAt` : repli sur `createdAt`.
      await insertSale({
        productId: product,
        at: null,
        createdAt: new Date(start.getTime() + 3_600_000),
        quantity: 2,
        salePrice: 500,
        productName: 'Savon « doux »',
      }),
    ];
    // Hors du mois, de part et d'autre.
    await insertSale({
      productId: product,
      at: new Date(start.getTime() - 1),
      productName: 'Savon « doux »',
    });
    await insertSale({
      productId: product,
      at: end,
      productName: 'Savon « doux »',
    });
    // Vente de B le même mois : jamais dans le rapport de A.
    const productB = await seedProduct('Produit secret de B', ORG_B, sectionB);
    await insertSale({
      productId: productB,
      at: start,
      org: ORG_B,
      productName: 'Produit secret de B',
    });

    const overview = (
      await http()
        .get('/analytics/overview')
        .query({ month: MONTH })
        .set(auth(ownerA))
    ).body as {
      totalRevenue: number;
      unitsSold: number;
      totalTransactions: number;
    };
    expect(overview).toMatchObject({
      totalTransactions: 3,
      unitsSold: 6,
      totalRevenue: 400 + 1200 + 1000,
    });

    const res = await download(ownerA, MONTH, 'xlsx');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="historique-boutique-a-16d-${MONTH}.xlsx"`,
    );
    const files = unzip(res.body as Buffer);
    const sales = files.get('xl/worksheets/sheet2.xml')!;
    // En-tête + 3 ventes + ligne vide + total.
    expect(sheetRows(sales)).toBe(1 + inside.length + 2);
    const all = [...files.values()].join('');
    expect(all).not.toContain('<f>');
    expect(all).not.toContain('Produit secret de B');
    expect(all).not.toContain('Boutique B');
    // Totaux de la synthèse = Analyse.
    const summary = files.get('xl/worksheets/sheet1.xml')!;
    expect(summary).toContain(`<v>${overview.totalRevenue}</v>`);
    expect(summary).toContain(`<v>${overview.unitsSold}</v>`);
    expect(inlineTexts(summary)).toContain(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );

    // B ne voit que B.
    const resB = await download(ownerB, MONTH, 'xlsx');
    const allB = [...unzip(resB.body as Buffer).values()].join('');
    expect(allB).toContain('Produit secret de B');
    expect(allB).not.toContain('Savon');
  });

  it('PDF : bilan, tableaux, fuseau, sans données d’une autre organisation', async () => {
    const res = await download(ownerA, MONTH, 'pdf');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    const body = res.body as Buffer;
    expect(body.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    const { pages, text } = pdfText(body);
    expect(pages).toBeGreaterThanOrEqual(2);
    expect(text).toContain('Historique mensuel des ventes');
    expect(text).toContain('Ventes du mois');
    expect(text).toContain('Récapitulatif par produit');
    expect(text).toContain('Savon « doux »');
    expect(text).not.toContain('Produit secret de B');
    expect(text).toContain(`Page ${pages} / ${pages}`);
  });

  it('1-16G — anglais : mêmes ventes, mêmes totaux, noms d’origine ; fichiers FR/EN distincts', async () => {
    // Un rapport à la fois par commerce (limite 1-16D) : téléchargements
    // successifs ; l'isolement des langues entre requêtes simultanées est
    // vérifié sur les messages d'erreur (legal-acceptance e2e).
    const frX = await download(ownerA, MONTH, 'xlsx', 'fr');
    const enX = await download(ownerA, MONTH, 'xlsx', 'en');
    const frP = await download(ownerA, MONTH, 'pdf', 'fr');
    const enP = await download(ownerA, MONTH, 'pdf', 'en');
    for (const res of [frX, enX, frP, enP]) expect(res.status).toBe(200);
    expect(enX.headers['content-disposition']).toBe(
      `attachment; filename="sales-history-boutique-a-16d-${MONTH}.xlsx"`,
    );
    expect(frX.headers['content-disposition']).toBe(
      `attachment; filename="historique-boutique-a-16d-${MONTH}.xlsx"`,
    );
    const fr = unzip(frX.body as Buffer);
    const en = unzip(enX.body as Buffer);
    const numbers = (xml: string) =>
      [...xml.matchAll(/<v>([^<]*)<\/v>/g)].map((m) => m[1]);
    for (const sheet of [
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
      'xl/worksheets/sheet3.xml',
    ]) {
      const a = fr.get(sheet);
      const b = en.get(sheet);
      if (!a) continue;
      // Mêmes lignes, mêmes valeurs numériques (montants, quantités, dates).
      expect(sheetRows(b!)).toBe(sheetRows(a));
      expect(numbers(b!)).toEqual(numbers(a));
    }
    const enTexts = [...en.values()].join('');
    expect(enTexts).toContain('Month summary');
    expect(enTexts).toContain('Savon « doux »');
    expect(enTexts).toContain('FCFA');
    expect(enTexts).not.toContain('Bilan du mois');
    expect([...fr.values()].join('')).not.toContain('Month summary');

    const frPdf = pdfText(frP.body as Buffer);
    const enPdf = pdfText(enP.body as Buffer);
    expect(enPdf.pages).toBe(frPdf.pages);
    expect(enPdf.text).toContain('Monthly sales history');
    expect(enPdf.text).toContain('Savon « doux »');
    expect(enPdf.text).not.toContain('Historique mensuel des ventes');
    expect(frPdf.text).toContain('Historique mensuel des ventes');
  });

  it('toutes les ventes d’un gros mois, PDF sur plusieurs pages avec en-tête répété', async () => {
    const { start } = monthBounds(BIG_MONTH);
    const product = await seedProduct('Article en série');
    const docs = Array.from({ length: 260 }, (_, i) => ({
      organizationId: new Types.ObjectId(ORG_A),
      productId: new Types.ObjectId(product),
      productName: 'Article en série',
      quantity: 1 + (i % 3),
      salePrice: 250,
      sellerId: new Types.ObjectId(sellerAId),
      occurredAt: new Date(start.getTime() + i * 60_000),
    }));
    await saleModel.insertMany(docs);
    const expectedUnits = docs.reduce((n, d) => n + d.quantity, 0);

    const xlsx = unzip(
      (await download(ownerA, BIG_MONTH, 'xlsx')).body as Buffer,
    );
    expect(sheetRows(xlsx.get('xl/worksheets/sheet2.xml')!)).toBe(1 + 260 + 2);
    expect(xlsx.get('xl/worksheets/sheet2.xml')).toContain(
      `<v>${expectedUnits}</v>`,
    );

    const { pages, text } = pdfText(
      (await download(adminA, BIG_MONTH, 'pdf')).body as Buffer,
    );
    expect(pages).toBeGreaterThan(4);
    expect(
      text.split('Ventes du mois (suite)').length - 1,
    ).toBeGreaterThanOrEqual(3);
    // Un en-tête de colonnes par page de ventes.
    expect(text.split('Prix unitaire').length - 1).toBeGreaterThanOrEqual(4);
    expect(text.match(/Article en série/g)?.length).toBeGreaterThanOrEqual(260);
  });

  it('produit purgé : nom enregistré et mention ; coût inconnu jamais remplacé par 0', async () => {
    const month = '2025-06';
    const { start } = monthBounds(month);
    const purged = await seedProduct('Ancien nom', ORG_A, sectionA, 100);
    await insertSale({
      productId: purged,
      at: start,
      quantity: 2,
      productName: 'Ancien nom',
    });
    await productModel.updateOne(
      { _id: purged },
      { $set: { name: 'Nom final' } },
    );
    expect(
      (await http().delete(`/products/${purged}/permanent`).set(auth(ownerA)))
        .status,
    ).toBe(200);
    // Vente d'un produit disparu sans coût conservé (purge antérieure).
    const ghost = new Types.ObjectId().toHexString();
    await insertSale({ productId: ghost, at: start, productName: 'Fantôme' });

    const ranking = (
      await http()
        .get('/analytics/products/ranking')
        .query({ month })
        .set(auth(ownerA))
    ).body as Array<{ productId: string; netProfit: number | null }>;
    expect(ranking.find((r) => r.productId === purged)?.netProfit).toBe(600);
    expect(ranking.find((r) => r.productId === ghost)?.netProfit).toBeNull();

    const files = unzip((await download(ownerA, month, 'xlsx')).body as Buffer);
    const salesTexts = inlineTexts(files.get('xl/worksheets/sheet2.xml')!);
    expect(salesTexts).toEqual(
      expect.arrayContaining([
        'Ancien nom',
        'Nom final',
        'Produit supprimé',
        'Fantôme',
      ]),
    );
    const products = files.get('xl/worksheets/sheet3.xml')!;
    expect(products).toContain('<v>600</v>');
    expect(inlineTexts(products)).toContain('Information indisponible');
    const summary = files.get('xl/worksheets/sheet1.xml')!;
    expect(inlineTexts(summary)).toContain('Information indisponible');
    expect(inlineTexts(summary)).toEqual(
      expect.arrayContaining([expect.stringContaining("n'a pas été conservé")]),
    );
  });

  it('corrections et annulations confirmées par l’historique, listées au mois de l’opération', async () => {
    const product = await seedProduct('Lait');
    const created = await http()
      .post('/sales')
      .set(auth(ownerA))
      .send({ productId: product, quantity: 3, salePrice: 400 });
    expect(created.status).toBe(201);
    const saleId = created.body._id as string;
    expect(
      (
        await http()
          .patch(`/sales/${saleId}`)
          .set(auth(ownerA))
          .send({ quantity: 2 })
      ).status,
    ).toBe(200);
    // Correction sans changement : non listée.
    expect(
      (
        await http()
          .patch(`/sales/${saleId}`)
          .set(auth(ownerA))
          .send({ quantity: 2 })
      ).status,
    ).toBe(200);
    const other = await http()
      .post('/sales')
      .set(auth(ownerA))
      .send({ productId: product, quantity: 1, salePrice: 450 });
    expect(
      (await http().delete(`/sales/${other.body._id}`).set(auth(ownerA)))
        .status,
    ).toBe(204);

    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const files = unzip((await download(ownerA, month, 'xlsx')).body as Buffer);
    const movements = files.get('xl/worksheets/sheet5.xml')!;
    const texts = inlineTexts(movements);
    expect(texts.filter((t) => t === 'Correction')).toHaveLength(1);
    expect(texts.filter((t) => t === 'Annulation')).toHaveLength(1);
    expect(texts).toEqual(
      expect.arrayContaining(['Quantité : 3 → 2', 'Propriétaire A']),
    );
  });

  it('mois sans vente : rapport généré et mois proposé', async () => {
    const months = await http().get('/reports/monthly').set(auth(ownerA));
    expect(months.status).toBe(200);
    expect(months.headers['cache-control']).toBe('no-store');
    expect(months.body.filenamePrefix).toBe('historique-boutique-a-16d');
    const list = months.body.months as Array<{
      month: string;
      salesCount: number;
    }>;
    expect(list.find((m) => m.month === EMPTY_MONTH)).toEqual({
      month: EMPTY_MONTH,
      salesCount: 0,
    });
    expect(list.find((m) => m.month === MONTH)?.salesCount).toBe(3);
    expect(list.at(-1)?.month).toBe('2025-01');

    const pdf = pdfText(
      (await download(ownerA, EMPTY_MONTH, 'pdf')).body as Buffer,
    );
    expect(pdf.text).toContain('Aucune vente enregistrée pour ce mois.');
    const xlsx = unzip(
      (await download(ownerA, EMPTY_MONTH, 'xlsx')).body as Buffer,
    );
    expect(sheetRows(xlsx.get('xl/worksheets/sheet2.xml')!)).toBe(2);
  });

  it('accès : vendeur, vendeur délégué, sans session, autre organisation, appartenance suspendue', async () => {
    for (const token of [sellerA, grantedSellerA]) {
      expect(
        (await http().get('/reports/monthly').set(auth(token))).status,
      ).toBe(403);
      for (const format of ['xlsx', 'pdf']) {
        const res = await http()
          .get(`/reports/monthly/${MONTH}/${format}`)
          .set(auth(token));
        expect(res.status).toBe(403);
        expect(res.headers['content-type']).toContain('application/json');
      }
    }
    expect((await http().get(`/reports/monthly/${MONTH}/pdf`)).status).toBe(
      401,
    );
    // L'organisation vient du jeton relu en base : le propriétaire de B
    // n'obtient que B (vérifié au premier test), jamais un mois de A.
    // Appartenance suspendue après connexion : refus immédiat.
    const admin = await membershipModel.findOne({
      role: OrganizationRole.ADMIN,
      organizationId: new Types.ObjectId(ORG_A),
    });
    await membershipModel.updateOne(
      { _id: admin!._id },
      { $set: { status: MembershipStatus.SUSPENDED } },
    );
    expect(
      (await http().get(`/reports/monthly/${MONTH}/pdf`).set(auth(adminA)))
        .status,
    ).toBe(403);
    await membershipModel.updateOne(
      { _id: admin!._id },
      { $set: { status: MembershipStatus.ACTIVE } },
    );
  });

  it('gain du mois : coûts des autres mois et coûts inconnus d’un autre mois sans effet ; global inchangé', async () => {
    const m1 = '2025-07';
    const m2 = '2025-09';
    // 20 unités achetées 100, vendues 400 : 2 en juillet, 3 en septembre.
    const product = await productModel.create({
      sectionId: new Types.ObjectId(sectionC),
      name: 'Bougie',
      imageUrl: 'https://e2e.local/img.png',
      purchasePrice: 100,
      salePrice: 400,
      initialQuantity: 20,
      remainingQuantity: 15,
      organizationId: new Types.ObjectId(ORG_C),
    });
    const id = product._id.toString();
    const ownerCId = String(
      (await userModel.findOne({ email: 'owner-c-16d@e2e.test' }))!._id,
    );
    await insertSale({
      productId: id,
      org: ORG_C,
      sellerId: ownerCId,
      at: monthBounds(m1).start,
      quantity: 2,
      productName: 'Bougie',
    });
    await insertSale({
      productId: id,
      org: ORG_C,
      sellerId: ownerCId,
      at: monthBounds(m2).start,
      quantity: 3,
      productName: 'Bougie',
    });
    const overview = async (month?: string) =>
      (
        await http()
          .get('/analytics/overview')
          .query(month ? { month } : {})
          .set(auth(ownerC))
      ).body as {
        totalRevenue: number;
        netProfit: number | null;
        avgMargin: number | null;
      };
    // Juillet : 800 - 2 x 100 = 600 (et non 800 - 5 x 100 = 300).
    expect(await overview(m1)).toMatchObject({
      totalRevenue: 800,
      netProfit: 600,
      avgMargin: 75,
    });
    // Septembre : vente d'un produit purgé dont le coût n'a pas été conservé.
    await insertSale({
      productId: new Types.ObjectId().toHexString(),
      org: ORG_C,
      sellerId: ownerCId,
      at: monthBounds(m2).start,
      productName: 'Disparu',
    });

    // Le coût inconnu de septembre ne rend pas juillet indisponible.
    expect(await overview(m1)).toMatchObject({
      totalRevenue: 800,
      netProfit: 600,
      avgMargin: 75,
    });
    // Septembre : coût inconnu dans le mois → indisponible, jamais 0.
    expect(await overview(m2)).toMatchObject({
      netProfit: null,
      avgMargin: null,
    });
    // Vue globale : règle existante (coût inconnu quelque part → null).
    expect((await overview()).netProfit).toBeNull();

    // Même gain que le rapport du mois.
    const files = unzip((await download(ownerC, m1, 'xlsx')).body as Buffer);
    expect(files.get('xl/worksheets/sheet1.xml')).toContain('<v>600</v>');
  });

  it('compte vendeur supprimé : toutes ses ventes exportées, récapitulatifs complets, aucun 503', async () => {
    const month = '2025-10';
    const product = await seedProduct('Thé', ORG_C, sectionC);
    for (let i = 0; i < 4; i++) {
      await insertSale({
        productId: product,
        org: ORG_C,
        sellerId: sellerCId,
        at: new Date(monthBounds(month).start.getTime() + i * 60_000),
        quantity: 1 + i,
        productName: 'Thé',
      });
    }
    await membershipModel.deleteMany({ userId: new Types.ObjectId(sellerCId) });
    await userModel.deleteOne({ _id: new Types.ObjectId(sellerCId) });

    const sellersRanking = (
      await http()
        .get('/analytics/sellers/ranking')
        .query({ month })
        .set(auth(ownerC))
    ).body as unknown[];
    expect(sellersRanking).toHaveLength(0); // l'Analyse écarte ce compte

    for (const format of ['xlsx', 'pdf']) {
      expect((await download(ownerC, month, format)).status).toBe(200);
    }
    const files = unzip((await download(ownerC, month, 'xlsx')).body as Buffer);
    expect(sheetRows(files.get('xl/worksheets/sheet2.xml')!)).toBe(1 + 4 + 2);
    const sellers = files.get('xl/worksheets/sheet4.xml')!;
    expect(inlineTexts(sellers)).toContain('Compte vendeur supprimé');
    // Ligne du compte supprimé et total : 10 unités, 4 ventes, 4 000.
    expect(sellers.match(/<v>10<\/v>/g)).toHaveLength(2);
    expect(sellers.match(/<v>4000<\/v>/g)).toHaveLength(2);
  });

  it('PDF refusé (422, message clair) si un nom n’est pas reproductible ; Excel exact ; français accepté', async () => {
    const month = '2025-11';
    const product = await seedProduct('Savon de Łódź', ORG_C, sectionC);
    await insertSale({
      productId: product,
      org: ORG_C,
      sellerId: sellerCId,
      at: monthBounds(month).start,
      productName: 'Savon de Łódź',
    });
    const refused = await http()
      .get(`/reports/monthly/${month}/pdf`)
      .set(auth(ownerC));
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('REPORT_PDF_UNSUPPORTED_CHARACTERS');
    expect(refused.body.characters).toEqual(['Ł', 'ź']);
    expect(refused.body.message).toContain('« Ł »');
    expect(refused.body.message).toContain('Excel');
    const xlsx = unzip((await download(ownerC, month, 'xlsx')).body as Buffer);
    expect(inlineTexts(xlsx.get('xl/worksheets/sheet2.xml')!)).toContain(
      'Savon de Łódź',
    );

    // Français (accents, œ/Œ, apostrophe typographique) : PDF accepté.
    const french = '2025-12';
    const accepted = await seedProduct(
      'Œufs l’été — crème brûlée',
      ORG_C,
      sectionC,
    );
    await insertSale({
      productId: accepted,
      org: ORG_C,
      sellerId: sellerCId,
      at: monthBounds(french).start,
      productName: 'Œufs l’été — crème brûlée',
    });
    const pdf = await download(ownerC, french, 'pdf');
    expect(pdf.status).toBe(200);
    // Octets Windows-1252 attendus dans le flux : Œ = 8c, ’ = 92, — = 97.
    const raw = (pdf.body as Buffer).toString('latin1');
    let hex = '';
    for (const m of raw.matchAll(/>>\nstream\n/g)) {
      const start = m.index + m[0].length;
      const stop = raw.indexOf('\nendstream', start);
      hex += inflateSync((pdf.body as Buffer).subarray(start, stop)).toString(
        'latin1',
      );
    }
    const expected = Buffer.from([
      0x8c,
      ...Buffer.from('ufs l', 'latin1'),
      0x92,
      ...Buffer.from('été ', 'latin1'),
      0x97,
    ]).toString('hex');
    expect(hex).toContain(expected);
  });

  it('mois et format invalides : 400', async () => {
    const now = new Date();
    const future = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const futureMonth = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}`;
    for (const path of [
      `/reports/monthly/2025-13/pdf`,
      `/reports/monthly/1999-12/pdf`,
      `/reports/monthly/2025-3/pdf`,
      `/reports/monthly/${futureMonth}/pdf`,
      `/reports/monthly/${MONTH}/csv`,
    ]) {
      const res = await http().get(path).set(auth(ownerA));
      expect(res.status).toBe(400);
    }
  });
});
