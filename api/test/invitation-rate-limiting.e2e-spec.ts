import 'reflect-metadata';
import { Model, Types } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ThrottlerStorage } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { INVITATION_RATE_LIMIT_CODE } from './../src/common/invitation-rate-limiting';
import { UserDocument } from './../src/users/schemas/user.schema';
import { Organization } from './../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from './../src/organizations/schemas/organization.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import { OrganizationInvitation } from './../src/organizations/schemas/invitation.schema';
import type { OrganizationInvitationDocument } from './../src/organizations/schemas/invitation.schema';
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
 * E2E (correction sécurité 1-10B) — rate limiting de
 * `POST /organizations/invitations` (fenêtre `invitation-create`,
 * 5 créations / 60 s, tracker utilisateur+organisation). Config email
 * ABSENTE dans cette suite (delivery toujours `manual`) ; `global.fetch`
 * est quand même systématiquement mocké par défense — AUCUN accès réseau
 * réel, jamais Resend.
 */

const TEST_JWT_SECRET = 'invitation-rate-limit-e2e-only-secret';
const E2E_CORS_ORIGIN = 'https://invitation-rate-limit-e2e.example.com';
const PASSWORD = 'rl-110b-pw-!1x';

const OWNER_A_EMAIL = 'owner-a-rl110b@royalvibe.test';
const ADMIN_A_EMAIL = 'admin-a-rl110b@royalvibe.test';

describe('Rate limiting invitations (e2e 1-10B) — POST /organizations/invitations', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let userModel: Model<UserDocument>;
  let organizationModel: Model<OrganizationDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;
  let invitationModel: Model<OrganizationInvitationDocument>;

  let orgAId = '';
  let ownerAToken = '';
  let adminAToken = '';

  let originalFetch: typeof fetch;
  let fetchMock: jest.Mock;

  const invite = (token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/organizations/invitations')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const list = (token: string) =>
    request(app.getHttpServer())
      .get('/organizations/invitations')
      .set('Authorization', `Bearer ${token}`);
  const revoke = (token: string, id: string) =>
    request(app.getHttpServer())
      .post(`/organizations/invitations/${id}/revoke`)
      .set('Authorization', `Bearer ${token}`);
  const login = (body: Record<string, unknown>) =>
    request(app.getHttpServer()).post('/auth/login').send(body);

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
      // Config email volontairement ABSENTE : hors périmètre de cette
      // suite (delivery = 'manual' partout, zéro réseau de toute façon).
      delete process.env.RESEND_API_KEY;
      delete process.env.EMAIL_FROM;
      delete process.env.PUBLIC_APP_URL;

      moduleFixture = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = moduleFixture.createNestApplication();
      app.enableCors(
        buildHttpCorsOptions(
          buildOriginAllowlist(parseCORSOrigin(E2E_CORS_ORIGIN, 'development')),
        ),
      );
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
      );
      app.useGlobalFilters(new HttpExceptionFilter());
      await app.init();

      userModel = moduleFixture.get(getModelToken('User'));
      organizationModel = moduleFixture.get(getModelToken(Organization.name));
      membershipModel = moduleFixture.get(
        getModelToken(OrganizationMembership.name),
      );
      invitationModel = moduleFixture.get(
        getModelToken(OrganizationInvitation.name),
      );

      const reg = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          name: 'Owner A RL110B',
          email: OWNER_A_EMAIL,
          password: PASSWORD,
          organizationName: 'Org A RL110B',
        });
      expect(reg.status).toBe(201);
      orgAId = reg.body.organization._id as string;

      const loginOwnerA = await login({
        email: OWNER_A_EMAIL,
        password: PASSWORD,
      });
      expect(loginOwnerA.status).toBe(201);
      ownerAToken = loginOwnerA.body.access_token as string;

      // Admin A : membre actif DISTINCT de la même organisation (isole le
      // composant "utilisateur" de la clé, à organisation constante).
      const adminA = await userModel.create({
        name: 'Admin A RL110B',
        email: ADMIN_A_EMAIL,
        password: await bcrypt.hash(PASSWORD, 10),
      });
      await membershipModel.create({
        organizationId: new Types.ObjectId(orgAId),
        userId: adminA._id,
        role: 'admin',
        status: 'active',
      });
      const loginAdminA = await login({
        email: ADMIN_A_EMAIL,
        password: PASSWORD,
        organizationId: orgAId,
      });
      expect(loginAdminA.status).toBe(201);
      adminAToken = loginAdminA.body.access_token as string;
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

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    // Aucun sleep : chaque test repart d'un quota vierge (mêmes acteurs
    // réutilisés d'un test à l'autre dans ce fichier).
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('5 créations autorisées, la 6e → 429 (contrat stable, Retry-After, zéro invitation et zéro fetch pour la requête bloquée)', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await invite(ownerAToken, {
        email: `rl-ok-${i}-${Date.now()}@royalvibe.test`,
        role: 'seller',
      });
      expect(res.status).toBe(201);
    }
    const before = await invitationModel.countDocuments();

    const blockedEmail = `rl-blocked-${Date.now()}@royalvibe.test`;
    const blocked = await invite(ownerAToken, {
      email: blockedEmail,
      role: 'seller',
    });

    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({
      statusCode: 429,
      code: INVITATION_RATE_LIMIT_CODE,
      message: expect.any(String),
    });
    const retryAfter = Number(blocked.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    // Zéro invitation créée pour la requête bloquée :
    expect(await invitationModel.countDocuments()).toBe(before);
    expect(await invitationModel.countDocuments({ email: blockedEmail })).toBe(
      0,
    );
    // Zéro appel EmailService/fetch pour une requête throttlée :
    expect(fetchMock).not.toHaveBeenCalled();
    // Aucun secret/donnée d'invitation dans le corps 429 :
    expect(JSON.stringify(blocked.body)).not.toContain(blockedEmail);
  });

  it('compteur isolé entre deux utilisateurs distincts de la MÊME organisation', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await invite(ownerAToken, {
        email: `rl-isolA-${i}-${Date.now()}@royalvibe.test`,
        role: 'seller',
      });
      expect(res.status).toBe(201);
    }
    const ownerBlocked = await invite(ownerAToken, {
      email: `rl-isolA-blocked-${Date.now()}@royalvibe.test`,
      role: 'seller',
    });
    expect(ownerBlocked.status).toBe(429);

    // Admin A (utilisateur DISTINCT, même organisation) : quota intact.
    const adminFirst = await invite(adminAToken, {
      email: `rl-isolB-${Date.now()}@royalvibe.test`,
      role: 'seller',
    });
    expect(adminFirst.status).toBe(201);
  });

  it('même utilisateur, deux organisations → quotas indépendants (clé user+organisation)', async () => {
    // Organisation B distincte, avec Owner A comme admin actif — même
    // utilisateur sous-jacent, organisation différente.
    const orgB = await organizationModel.create({
      name: 'Org B RL110B',
      slug: `org-b-rl110b-${Date.now()}`,
      status: 'active',
    });
    const ownerAUser = await userModel.findOne({ email: OWNER_A_EMAIL });
    await membershipModel.create({
      organizationId: orgB._id,
      userId: ownerAUser!._id,
      role: 'admin',
      status: 'active',
    });
    const loginOrgB = await login({
      email: OWNER_A_EMAIL,
      password: PASSWORD,
      organizationId: orgB._id.toString(),
    });
    expect(loginOrgB.status).toBe(201);
    const ownerAOrgBToken = loginOrgB.body.access_token as string;

    // Épuise le quota de Owner A dans l'organisation A :
    for (let i = 0; i < 5; i++) {
      const res = await invite(ownerAToken, {
        email: `rl-sameuser-orgA-${i}-${Date.now()}@royalvibe.test`,
        role: 'seller',
      });
      expect(res.status).toBe(201);
    }
    const blockedOrgA = await invite(ownerAToken, {
      email: `rl-sameuser-orgA-blocked-${Date.now()}@royalvibe.test`,
      role: 'seller',
    });
    expect(blockedOrgA.status).toBe(429);

    // MÊME utilisateur, organisation B : quota indépendant, toujours 201.
    const firstOrgB = await invite(ownerAOrgBToken, {
      email: `rl-sameuser-orgB-${Date.now()}@royalvibe.test`,
      role: 'seller',
    });
    expect(firstOrgB.status).toBe(201);
  });

  it('GET /organizations/invitations et revoke ne sont JAMAIS impactés, même après épuisement du quota de création', async () => {
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await invite(ownerAToken, {
        email: `rl-getrevoke-${i}-${Date.now()}@royalvibe.test`,
        role: 'seller',
      });
      expect(res.status).toBe(201);
      created.push(res.body.invitation._id as string);
    }
    const blocked = await invite(ownerAToken, {
      email: `rl-getrevoke-blocked-${Date.now()}@royalvibe.test`,
      role: 'seller',
    });
    expect(blocked.status).toBe(429);

    // 10 GET consécutifs : jamais 429 (aucune garde de débit sur cette route).
    for (let i = 0; i < 10; i++) {
      const res = await list(ownerAToken);
      expect(res.status).toBe(200);
    }

    // Révocation des 5 invitations créées : jamais 429 non plus.
    for (const id of created) {
      const res = await revoke(ownerAToken, id);
      expect(res.status).toBe(200);
    }
  });
});
