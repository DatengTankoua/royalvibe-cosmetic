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
import {
  MembershipStatus,
  OrganizationRole,
} from './../src/organizations/permissions';
import { Organization } from './../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from './../src/organizations/schemas/organization.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import { MonthlyHistoryService } from './../src/reports/monthly-history.service';
import {
  REPORT_GENERATION_LIMITS_TOKEN,
  ReportGenerationLimiter,
} from './../src/reports/report-generation-limiter';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';
import { activateTestSubscriptions } from './e2e/subscription-fixtures';
import { barrier } from './e2e/barriers';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import {
  E2E_EMAIL_VERIFIED_AT,
  autoConfirmVerificationEmails,
  createE2eEmailSender,
} from './e2e/email-verification-fixtures';

const emailSender = createE2eEmailSender();

/**
 * E2E 1-16D — protection de la génération des historiques. Paramètres de
 * test réduits par le jeton `REPORT_GENERATION_LIMITS_TOKEN` (production :
 * `REPORT_GENERATION_LIMITS`). Courses ORDONNÉES par barrière posée sur
 * `MonthlyHistoryService.build`, sans attente à durée fixe.
 */

const TEST_JWT_SECRET = 'e2e-only-static-secret-not-production-use';
const PASSWORD = 'lim-16d-pw-!1x';
const ORG_A = 'e16d0000000000000000000a';
const ORG_B = 'e16d0000000000000000000b';
const MONTH = '2025-06';
const LIMITS = {
  windowMs: 60 * 60_000,
  maxPerWindow: 4,
  maxActiveGlobal: 2,
  maxActivePerOrganization: 1,
  busyRetryAfterSeconds: 9,
};

describe('E2E 1-16D — limitation de la génération des historiques', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let limiter: ReportGenerationLimiter;
  let history: MonthlyHistoryService;
  let ownerA = '';
  let adminA = '';
  let ownerB = '';

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const get = (token: string, format = 'xlsx') =>
    http().get(`/reports/monthly/${MONTH}/${format}`).set(auth(token));

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
        .overrideProvider(REPORT_GENERATION_LIMITS_TOKEN)
        .useValue(LIMITS)
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
      limiter = moduleFixture.get(ReportGenerationLimiter);
      history = moduleFixture.get(MonthlyHistoryService);

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
        [ORG_A, 'limite-a-16d'],
        [ORG_B, 'limite-b-16d'],
      ]) {
        await organizationModel.create({ _id: id, slug, name: slug });
      }
      await activateTestSubscriptions(moduleFixture, [ORG_A, ORG_B]);
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
        'owner-a-lim@e2e.test',
        ORG_A,
        OrganizationRole.OWNER,
      );
      adminA = await member(
        'admin-a-lim@e2e.test',
        ORG_A,
        OrganizationRole.ADMIN,
      );
      ownerB = await member(
        'owner-b-lim@e2e.test',
        ORG_B,
        OrganizationRole.OWNER,
      );
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

  it('simultanéité : 503 temporaire et compréhensible, place rendue après succès', async () => {
    const gate = barrier();
    const entered = barrier();
    const original = history.build.bind(history);
    jest.spyOn(history, 'build').mockImplementationOnce(async (...args) => {
      entered.release();
      await gate.wait();
      return original(...args);
    });
    const first = get(ownerA).then((r) => r);
    try {
      await entered.wait();
      expect(limiter.active).toBe(1);

      // Même commerce (borne par commerce = 1) : refus temporaire.
      const busy = await get(adminA, 'pdf');
      expect(busy.status).toBe(503);
      expect(busy.body.code).toBe('REPORT_GENERATION_BUSY');
      expect(busy.headers['retry-after']).toBe('9');
      expect(busy.body.message).toContain('Réessayez dans quelques secondes');
      // Autre commerce : servi (borne globale = 2).
      expect((await get(ownerB)).status).toBe(200);
    } finally {
      // Toujours rouverte, même après un échec : jamais de requête bloquée.
      gate.release();
    }
    expect((await first).status).toBe(200);
    expect(limiter.active).toBe(0);
    // Place rendue : Excel puis PDF normalement.
    expect((await get(adminA, 'xlsx')).status).toBe(200);
    expect((await get(adminA, 'pdf')).status).toBe(200);
  });

  it('place rendue après une erreur de génération', async () => {
    jest
      .spyOn(history, 'build')
      .mockRejectedValueOnce(new Error('panne simulée'));
    expect((await get(ownerB)).status).toBe(500);
    expect(limiter.active).toBe(0);
    expect((await get(ownerB, 'pdf')).status).toBe(200);
  });

  it('quota par compte : 429 avec Retry-After, sans effet sur les autres comptes ni les autres routes', async () => {
    // ownerA : 1 admission au test précédent ; 3 de plus atteignent 4.
    for (let i = 0; i < 3; i++) {
      expect((await get(ownerA, i % 2 ? 'pdf' : 'xlsx')).status).toBe(200);
    }
    const limited = await get(ownerA, 'pdf');
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('REPORT_RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.body.message).toContain('Trop de téléchargements');
    expect(limiter.active).toBe(0);

    // Autres comptes et autres routes : inchangés.
    expect((await get(adminA)).status).toBe(200);
    expect(
      (await http().get('/reports/monthly').set(auth(ownerA))).status,
    ).toBe(200);
    expect(
      (
        await http()
          .get('/analytics/overview')
          .query({ month: MONTH })
          .set(auth(ownerA))
      ).status,
    ).toBe(200);
    // Contrôles d'accès et de saisie AVANT le quota : 400, jamais 429.
    expect(
      (await http().get('/reports/monthly/2025-13/pdf').set(auth(ownerA)))
        .status,
    ).toBe(400);
    // La connexion (compteurs du ThrottlerModule) reste disponible.
    expect(
      (
        await http()
          .post('/auth/login')
          .send({ email: 'owner-a-lim@e2e.test', password: PASSWORD })
      ).status,
    ).toBe(201);
  });
});
