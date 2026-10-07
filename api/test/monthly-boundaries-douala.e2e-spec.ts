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
import { Organization } from './../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from './../src/organizations/schemas/organization.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import {
  configureProcessTimeZone,
  monthBounds,
  processTimeZone,
} from './../src/analytics/month-range';
import {
  MonthlyReportService,
  previousReportPeriod,
} from './../src/notifications/monthly-report.service';
import { excelSerial } from './../src/reports/report-format';
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
 * E2E 1-16D — calendrier du Cameroun (`TZ=Africa/Douala`).
 *
 * Le fuseau doit être fixé AU LANCEMENT du processus Jest (le `process.env`
 * d'un test est une copie) : `recipe.js isolated api-e2e
 * --tz=Africa/Douala test/monthly-boundaries-douala`. Sans cette option, la
 * suite est IGNORÉE (visible dans le décompte Jest), jamais réussie à tort.
 * Base éphémère, aucun `.env`. Vente témoin : 2026-09-30T23:30:00Z, soit le
 * 1er octobre à 00:30 à Douala (UTC+1) : elle appartient à OCTOBRE pour
 * l'Analyse, la liste des mois, l'export Excel et PDF et le bilan mensuel.
 */

const TEST_JWT_SECRET = 'e2e-only-static-secret-not-production-use';
const PASSWORD = 'tz-16d-pw-!1x';
const ORG = 'd16d0000000000000000000d';
const SALE_AT = new Date('2026-09-30T23:30:00Z');
const IN_DOUALA = processTimeZone() === 'Africa/Douala';

function unzip(buffer: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let p = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const size = buffer.readUInt32LE(p + 20);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extra = buffer.readUInt16LE(p + 30);
    const comment = buffer.readUInt16LE(p + 32);
    const local = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLength);
    const start =
      local +
      30 +
      buffer.readUInt16LE(local + 26) +
      buffer.readUInt16LE(local + 28);
    files.set(
      name,
      inflateRawSync(buffer.subarray(start, start + size)).toString('utf8'),
    );
    p += 46 + nameLength + extra + comment;
  }
  return files;
}

function pdfText(buffer: Buffer): string {
  const raw = buffer.toString('latin1');
  let text = '';
  for (const m of raw.matchAll(/>>\nstream\n/g)) {
    const start = m.index + m[0].length;
    const stop = raw.indexOf('\nendstream', start);
    const content = inflateSync(buffer.subarray(start, stop)).toString(
      'latin1',
    );
    for (const hex of content.matchAll(/<([0-9a-f]*)> Tj/g)) {
      text += `${Buffer.from(hex[1], 'hex').toString('latin1')}\n`;
    }
  }
  return text;
}

(IN_DOUALA ? describe : describe.skip)(
  'E2E 1-16D — mois au fuseau Africa/Douala',
  () => {
    let moduleFixture: TestingModule;
    let app: INestApplication<App>;
    let owner = '';

    const http = () => request(app.getHttpServer());
    const auth = () => ({ Authorization: `Bearer ${owner}` });
    const download = (month: string, format: string) =>
      http()
        .get(`/reports/monthly/${month}/${format}`)
        .set(auth())
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        });

    beforeAll(async () => {
      // Même validation que le démarrage de l'API, sans changement de fuseau.
      expect(configureProcessTimeZone()).toBe('Africa/Douala');
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

        const userModel = moduleFixture.get<Model<UserDocument>>(
          getModelToken('User'),
        );
        const organizationModel = moduleFixture.get<
          Model<OrganizationDocument>
        >(getModelToken(Organization.name));
        const membershipModel = moduleFixture.get<
          Model<OrganizationMembershipDocument>
        >(getModelToken(OrganizationMembership.name));
        const productModel = moduleFixture.get<Model<ProductDocument>>(
          getModelToken('Product'),
        );
        const saleModel = moduleFixture.get<Model<SaleDocument>>(
          getModelToken('Sale'),
        );

        await organizationModel.create({
          _id: ORG,
          slug: 'boutique-douala',
          name: 'Boutique Douala',
        });
        await organizationModel.collection.updateOne(
          { _id: new Types.ObjectId(ORG) },
          { $set: { createdAt: new Date('2026-08-10T12:00:00Z') } },
        );
        await activateTestSubscriptions(moduleFixture, [ORG]);
        const user = await userModel.create({
          emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
          name: 'Propriétaire Douala',
          email: 'owner-douala-16d@e2e.test',
          password: await bcrypt.hash(PASSWORD, 10),
        });
        await membershipModel.create({
          organizationId: new Types.ObjectId(ORG),
          userId: user._id,
          role: OrganizationRole.OWNER,
          status: MembershipStatus.ACTIVE,
        });
        const login = await http()
          .post('/auth/login')
          .send({ email: 'owner-douala-16d@e2e.test', password: PASSWORD });
        expect(login.status).toBe(201);
        owner = login.body.access_token as string;
        const section = (
          await http().post('/sections').set(auth()).send({ name: 'S' })
        ).body._id as string;
        const product = await productModel.create({
          sectionId: new Types.ObjectId(section),
          name: 'Plantain',
          imageUrl: 'https://e2e.local/img.png',
          purchasePrice: 100,
          salePrice: 400,
          initialQuantity: 10,
          remainingQuantity: 8,
          organizationId: new Types.ObjectId(ORG),
        });
        await saleModel.create({
          organizationId: new Types.ObjectId(ORG),
          productId: product._id,
          productName: 'Plantain',
          quantity: 2,
          salePrice: 400,
          sellerId: user._id,
          occurredAt: SALE_AT,
        });
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

    it('bornes : octobre commence le 30/09 à 23:00 UTC', () => {
      expect(monthBounds('2026-10').start.toISOString()).toBe(
        '2026-09-30T23:00:00.000Z',
      );
      const local = new Date(SALE_AT);
      expect([
        local.getMonth() + 1,
        local.getDate(),
        local.getHours(),
        local.getMinutes(),
      ]).toEqual([10, 1, 0, 30]);
    });

    it('Analyse : vue du mois, classement, courbe mensuelle', async () => {
      const overview = async (month: string) =>
        (await http().get('/analytics/overview').query({ month }).set(auth()))
          .body as {
          totalTransactions: number;
          netProfit: number | null;
        };
      expect(await overview('2026-10')).toMatchObject({
        totalTransactions: 1,
        netProfit: 600,
      });
      expect((await overview('2026-09')).totalTransactions).toBe(0);
      const ranking = (
        await http()
          .get('/analytics/products/ranking')
          .query({ month: '2026-10' })
          .set(auth())
      ).body as unknown[];
      expect(ranking).toHaveLength(1);
      const trend = (await http().get('/analytics/monthly').set(auth()))
        .body as Array<{ period: string }>;
      expect(trend.map((t) => t.period)).toEqual(['2026-10']);
    });

    it('historique exportable : liste des mois, Excel et PDF', async () => {
      const months = (await http().get('/reports/monthly').set(auth()))
        .body as {
        timeZone: string;
        months: Array<{ month: string; salesCount: number }>;
      };
      expect(months.timeZone).toBe('Africa/Douala');
      expect(months.months.find((m) => m.month === '2026-10')?.salesCount).toBe(
        1,
      );
      expect(months.months.find((m) => m.month === '2026-09')?.salesCount).toBe(
        0,
      );

      const october = unzip((await download('2026-10', 'xlsx')).body as Buffer);
      const sales = october.get('xl/worksheets/sheet2.xml')!;
      const serial =
        (Date.UTC(2026, 9, 1, 0, 30) - Date.UTC(1899, 11, 30)) / 86_400_000;
      expect(excelSerial(SALE_AT)).toBe(serial);
      expect(sales).toContain(`<v>${serial}</v>`);
      expect(october.get('xl/worksheets/sheet1.xml')).toContain(
        'Africa/Douala',
      );
      const september = unzip(
        (await download('2026-09', 'xlsx')).body as Buffer,
      );
      expect(september.get('xl/worksheets/sheet2.xml')).not.toContain(
        'Plantain',
      );

      const pdf = pdfText((await download('2026-10', 'pdf')).body as Buffer);
      // Cellule de date sur deux lignes : jour, puis heure.
      expect(pdf).toContain(
        ['01/10/2026', '00:30'].join(String.fromCharCode(10)),
      );
      expect(pdf).toContain('Africa/Douala');
    });

    it('bilan mensuel : mêmes bornes, vente comptée en octobre', async () => {
      const service = moduleFixture.get(MonthlyReportService);
      const october = previousReportPeriod(new Date(2026, 10, 2, 9));
      expect(october.period).toBe('2026-10');
      expect(october.start.getTime()).toBe(
        monthBounds('2026-10').start.getTime(),
      );
      expect(october.end.getTime()).toBe(monthBounds('2026-10').end.getTime());
      const report = await service.compute(
        new Types.ObjectId(ORG),
        october,
        new Date(),
      );
      expect(report).toMatchObject({
        period: '2026-10',
        salesCount: 1,
        timeZone: 'Africa/Douala',
      });
      const september = await service.compute(
        new Types.ObjectId(ORG),
        previousReportPeriod(new Date(2026, 9, 2, 9)),
        new Date(),
      );
      expect(september.salesCount).toBe(0);
    });
  },
);
