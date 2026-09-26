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
import { UserDocument } from './../src/users/schemas/user.schema';
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
 * E2E (1-10B) — livraison email des invitations, `RESEND_API_KEY`/
 * `EMAIL_FROM`/`PUBLIC_APP_URL` CONFIGURÉS pour cette suite uniquement
 * (instance d'app dédiée, MongoDB éphémère réel). AUCUN accès réseau réel :
 * `global.fetch` est systématiquement remplacé par un mock avant chaque
 * test — jamais l'implémentation native, jamais Resend/Atlas réels.
 */

const TEST_JWT_SECRET = 'invitation-email-e2e-only-static-secret';
const E2E_CORS_ORIGIN = 'https://invitation-email-e2e.example.com';

const OWNER_EMAIL = 'owner-110b@royalvibe.test';
const PASSWORD = 'owner-110b-pw-!1x';

describe('Livraison email des invitations (e2e 1-10B) — sent/failed, sécurité', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let invitationModel: Model<OrganizationInvitationDocument>;
  let userModel: Model<UserDocument>;

  let orgId = '';
  let ownerToken = '';

  let originalFetch: typeof fetch;
  let fetchMock: jest.Mock;

  const invite = (token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/organizations/invitations')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

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
      // Config email COMPLÈTE : seule cette suite l'exerce, jamais un accès
      // réseau réel — `global.fetch` est mocké avant chaque test ci-dessous.
      process.env.RESEND_API_KEY = 'e2e-fake-resend-key';
      process.env.EMAIL_FROM = 'no-reply@stockmaster-e2e.test';
      process.env.PUBLIC_APP_URL = 'https://app.stockmaster-e2e.test';

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
      invitationModel = moduleFixture.get(
        getModelToken(OrganizationInvitation.name),
      );

      const reg = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          name: 'Owner 110B',
          email: OWNER_EMAIL,
          password: PASSWORD,
          organizationName: 'Org 110B',
        });
      expect(reg.status).toBe(201);
      orgId = reg.body.organization._id as string;

      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: OWNER_EMAIL, password: PASSWORD });
      expect(login.status).toBe(201);
      ownerToken = login.body.access_token as string;
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
    // 1-10B : cette suite réutilise le même owner/org sur plusieurs `it()`
    // (jusqu'à 7 appels `invite()`) — réinitialise le quota
    // `invitation-create` (5/60 s) avant chaque test, sans sleep.
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('provider accepte (2xx) → 201, delivery.status = sent, un seul appel fetch vers Resend', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const email = `sent-${Date.now()}@royalvibe.test`;

    const res = await invite(ownerToken, { email, role: 'seller' });

    expect(res.status).toBe(201);
    expect(res.body.delivery).toEqual({ status: 'sent' });
    expect(res.body.token).toEqual(expect.any(String));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://api.resend.com/emails');
    // Jamais le token brut/clé API en clair dans une réponse HTTP :
    expect(JSON.stringify(res.body)).not.toContain('e2e-fake-resend-key');
  });

  it('provider répond 500 → 201 quand même, delivery.status = failed, invitation unique conservée', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const email = `failed-500-${Date.now()}@royalvibe.test`;

    const res = await invite(ownerToken, { email, role: 'seller' });

    expect(res.status).toBe(201);
    expect(res.body.delivery).toEqual({ status: 'failed' });
    expect(res.body.token).toEqual(expect.any(String));
    const stored = await invitationModel
      .find({ organizationId: new Types.ObjectId(orgId), email })
      .exec();
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe('pending');
  });

  it('provider time-out (fetch rejette) → 201 quand même, delivery.status = failed, aucun 500, aucune seconde invitation', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
      }),
    );
    const email = `failed-timeout-${Date.now()}@royalvibe.test`;

    const res = await invite(ownerToken, { email, role: 'seller' });

    expect(res.status).toBe(201);
    expect(res.body.delivery).toEqual({ status: 'failed' });

    // Aucun retry automatique : une seconde tentative sur le MÊME email
    // pendant que l'invitation est encore `pending` reste un conflit 409 —
    // jamais une deuxième invitation créée.
    const retry = await invite(ownerToken, { email, role: 'seller' });
    expect(retry.status).toBe(409);
    const stored = await invitationModel
      .find({ organizationId: new Types.ObjectId(orgId), email })
      .exec();
    expect(stored).toHaveLength(1);
  });

  it('permission refusée (seller sans members.invite) → 403, aucun appel email', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const sellerEmail = `seller-no-invite-${Date.now()}@royalvibe.test`;
    const sellerPassword = 'seller-110b-pw-!1x';
    const seller = await userModel.create({
      name: 'Seller 110B',
      email: sellerEmail,
      password: await bcrypt.hash(sellerPassword, 10),
    });
    const membershipModel = moduleFixture.get(
      getModelToken('OrganizationMembership'),
    );
    await membershipModel.create({
      organizationId: new Types.ObjectId(orgId),
      userId: seller._id,
      role: 'seller',
      status: 'active',
    });
    const login = await request(app.getHttpServer()).post('/auth/login').send({
      email: sellerEmail,
      password: sellerPassword,
      organizationId: orgId,
    });
    expect(login.status).toBe(201);
    const sellerToken = login.body.access_token as string;

    const res = await invite(sellerToken, {
      email: `target-${Date.now()}@royalvibe.test`,
      role: 'seller',
    });

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('payload invalide (rôle owner interdit) → 400, aucun appel email, aucune invitation créée', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const before = await invitationModel.countDocuments();

    const res = await invite(ownerToken, {
      email: `forbidden-role-${Date.now()}@royalvibe.test`,
      role: 'owner',
    });

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await invitationModel.countDocuments()).toBe(before);
  });

  it('invitation `pending` déjà existante (409) → aucun nouvel appel email', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const email = `dup-${Date.now()}@royalvibe.test`;

    const first = await invite(ownerToken, { email, role: 'seller' });
    expect(first.status).toBe(201);
    fetchMock.mockClear();

    const second = await invite(ownerToken, { email, role: 'seller' });
    expect(second.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
