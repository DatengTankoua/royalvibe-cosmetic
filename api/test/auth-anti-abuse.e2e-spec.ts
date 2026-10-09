import 'reflect-metadata';
import { Model, Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { ThrottlerStorage } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { AUTH_RATE_LIMIT_CODE } from './../src/common/auth-rate-limiting';
import { applyTrustProxy } from './../src/common/trust-proxy';
import type { ExpressSettings } from './../src/common/trust-proxy';
import { UserDocument } from './../src/users/schemas/user.schema';
import { Organization } from './../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from './../src/organizations/schemas/organization.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import { OrganizationInvitation } from './../src/organizations/schemas/invitation.schema';
import type { OrganizationInvitationDocument } from './../src/organizations/schemas/invitation.schema';
import { TURNSTILE_SITEVERIFY_URL } from './../src/anti-bot/turnstile-config';
import {
  PersistentRateLimiter,
  RATE_LIMIT_BUCKETS_COLLECTION,
} from './../src/common/rate-limit/persistent-rate-limiter.service';
import {
  AUTH_ACCOUNT_FAILURE_SCOPE,
  INVITATION_EMAIL_RECIPIENT_SCOPE,
} from './../src/common/rate-limit/anti-abuse-config';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';
import {
  E2E_EMAIL_VERIFIED_AT,
  autoConfirmVerificationEmails,
  createE2eEmailSender,
} from './e2e/email-verification-fixtures';
import {
  legalAcceptanceFor,
  simulatedTurnstileToken,
} from './e2e/legal-acceptance-fixtures';
import { LegalAcceptanceContext } from '../src/legal/legal-documents';
import { waitFor } from './e2e/invitation-acceptance-fixtures';
import { postRegister } from './e2e/registration-fixtures';

/**
 * E2E 1-18C — protections anti-abus, sur l'application réelle (gardes,
 * filtre, pipes), MongoDB éphémère, fournisseurs SIMULÉS uniquement :
 * Cloudflare (siteverify) par un faux `fetch`, e-mails par l'expéditeur
 * d'enregistrement. Plusieurs IP : `trust proxy` = 1 saut et
 * `X-Forwarded-For` (fixture de test, comme trust-proxy.e2e).
 */
const emailSender = createE2eEmailSender();
const PASSWORD = 'anti-abuse-18c-pw-!1x';
const CF_SECRET = '0x4AAAAAAAe2e-fictitious-secret';
const CF_HOST = 'www.stock-master.app';
const OWNER_LEGAL = legalAcceptanceFor(
  LegalAcceptanceContext.OWNER_REGISTRATION,
);
const INVITATION_LEGAL = legalAcceptanceFor(
  LegalAcceptanceContext.INVITATION_ACCOUNT,
);

/** Réponses simulées de siteverify selon le jeton reçu. */
function cloudflareReply(token: string): Response | 'hang' | 'network' {
  const json = (body: object, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  const ok = (overrides: object = {}) =>
    json({
      success: true,
      challenge_ts: new Date().toISOString(),
      hostname: CF_HOST,
      action: 'register',
      'error-codes': [],
      ...overrides,
    });
  if (token.startsWith('cf-pass-')) return ok();
  if (token === 'cf-test-key')
    return ok({ hostname: 'localhost', action: 'test' });
  if (token === 'cf-other-host') return ok({ hostname: 'evil.example' });
  if (token === 'cf-other-action') return ok({ action: 'login' });
  if (token === 'cf-expired')
    return json({ success: false, 'error-codes': ['timeout-or-duplicate'] });
  if (token === 'cf-invalid')
    return json({ success: false, 'error-codes': ['invalid-input-response'] });
  if (token === 'cf-internal')
    return json({ success: false, 'error-codes': ['internal-error'] });
  if (token === 'cf-http-500') return json({}, 500);
  if (token === 'cf-hang') return 'hang';
  return 'network';
}

describe('Anti-abus de l’authentification (e2e 1-18C)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let connection: Connection;
  let userModel: Model<UserDocument>;
  let organizationModel: Model<OrganizationDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;
  let invitationModel: Model<OrganizationInvitationDocument>;
  let fetchMock: jest.SpyInstance;
  /** Jetons Cloudflare simulés déjà validés (usage unique, comme le service réel). */
  const spent = new Set<string>();

  const server = () => app.getHttpServer();
  const clearThrottle = () =>
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();
  const buckets = () => connection.collection(RATE_LIMIT_BUCKETS_COLLECTION);
  const keyFor = (scope: string, subject: string) =>
    moduleFixture.get(PersistentRateLimiter).keyFor(scope, subject);

  let seq = 0;
  const unique = (label: string) => {
    seq += 1;
    return `${label}-${seq}-${Date.now()}@anti-abuse.test`;
  };

  function useCloudflare() {
    delete process.env.TURNSTILE_SIMULATED;
    process.env.TURNSTILE_SECRET_KEY = CF_SECRET;
    process.env.TURNSTILE_ALLOWED_HOSTNAMES = CF_HOST;
    process.env.TURNSTILE_TIMEOUT_MS = '500';
  }
  function useSimulation() {
    delete process.env.TURNSTILE_SECRET_KEY;
    delete process.env.TURNSTILE_ALLOWED_HOSTNAMES;
    process.env.TURNSTILE_SIMULATED = 'true';
  }

  const register = (
    email: string,
    extra: Record<string, unknown>,
    organizationName = `Org ${seq}`,
  ) =>
    postRegister(app, {
      name: 'Owner',
      email,
      password: PASSWORD,
      organizationName: organizationName.slice(0, 20),
      legalAcceptance: OWNER_LEGAL,
      ...extra,
    });

  const login = (email: string, password: string, ip: string) =>
    request(server())
      .post('/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email, password });

  /** Propriétaire vérifié (inscription simulée) et sa session. */
  async function verifiedOwner(label: string) {
    useSimulation();
    const email = unique(label);
    const res = await register(
      email,
      { turnstileToken: simulatedTurnstileToken() },
      `Org ${label}`,
    );
    expect(res.status).toBe(202);
    const logged = await login(email, PASSWORD, '198.51.100.250');
    expect(logged.status).toBe(201);
    return {
      email,
      orgId: res.owner!.organization._id,
      token: logged.body.access_token as string,
    };
  }

  async function invite(ownerToken: string, email: string) {
    const res = await request(server())
      .post('/organizations/invitations')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email, role: 'seller' });
    expect(res.status).toBe(201);
    return {
      id: res.body.invitation._id as string,
      token:
        new URL(String(res.body.invitationUrl)).searchParams.get('token') ?? '',
    };
  }

  const accountLink = (token: string) =>
    request(server()).post('/auth/invitations/account-link').send({ token });

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      process.env.MONGODB_URI = validatedEphemeralUri(replSet);
      process.env.JWT_SECRET = 'anti-abuse-18c-e2e-only-secret';
      process.env.S3_ENDPOINT = 'http://127.0.0.1:65535';
      process.env.S3_REGION = 'us-east-1';
      process.env.S3_ACCESS_KEY = 'e2e-local';
      process.env.S3_SECRET_KEY = 'e2e-local';
      process.env.S3_BUCKET = 'e2e-local';
      process.env.S3_FORCE_PATH_STYLE = 'true';
      process.env.CORS_ORIGIN = 'https://anti-abuse-e2e.example.com';
      process.env.PUBLIC_APP_URL = 'https://app.anti-abuse-e2e.test';
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
      process.env.AUTH_ACCOUNT_FAILURE_LIMIT = '3';
      process.env.INVITATION_EMAIL_RECIPIENT_LIMIT = '2';

      moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EMAIL_SENDER)
        .useValue(emailSender)
        .compile();
      app = moduleFixture.createNestApplication();
      // FIXTURE : un saut de proxy approuvé pour simuler plusieurs IP.
      applyTrustProxy(app.getHttpAdapter().getInstance() as ExpressSettings, {
        mode: 'hops',
        hops: 1,
      });
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

      connection = moduleFixture.get(getConnectionToken());
      userModel = moduleFixture.get(getModelToken('User'));
      organizationModel = moduleFixture.get(getModelToken(Organization.name));
      membershipModel = moduleFixture.get(
        getModelToken(OrganizationMembership.name),
      );
      invitationModel = moduleFixture.get(
        getModelToken(OrganizationInvitation.name),
      );

      const realFetch = global.fetch;
      fetchMock = jest
        .spyOn(global, 'fetch')
        .mockImplementation((input, init) => {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          if (url !== TURNSTILE_SITEVERIFY_URL) return realFetch(input, init);
          const raw = typeof init?.body === 'string' ? init.body : '{}';
          const body = JSON.parse(raw) as { response: string };
          if (spent.has(body.response)) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  success: false,
                  'error-codes': ['timeout-or-duplicate'],
                }),
                { status: 200 },
              ),
            );
          }
          const reply = cloudflareReply(body.response);
          if (reply === 'network') {
            return Promise.reject(new TypeError('fetch failed'));
          }
          if (reply === 'hang') {
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                const reason: unknown = init.signal!.reason;
                reject(reason instanceof Error ? reason : new Error('aborted'));
              });
            });
          }
          if (body.response.startsWith('cf-pass-')) spent.add(body.response);
          return Promise.resolve(reply);
        });
    } catch (error) {
      if (moduleFixture) await moduleFixture.close().catch(() => undefined);
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  afterAll(async () => {
    fetchMock?.mockRestore();
    for (const name of [
      'TURNSTILE_SECRET_KEY',
      'TURNSTILE_ALLOWED_HOSTNAMES',
      'TURNSTILE_TIMEOUT_MS',
      'AUTH_ACCOUNT_FAILURE_LIMIT',
      'INVITATION_EMAIL_RECIPIENT_LIMIT',
    ]) {
      delete process.env[name];
    }
    process.env.TURNSTILE_SIMULATED = 'true';
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  beforeEach(() => {
    clearThrottle();
    fetchMock?.mockClear();
  });

  // ─── 1. Turnstile sur l'inscription ──────────────────────────────────────

  describe('1. Inscription : vérification anti-robot avant toute écriture', () => {
    beforeEach(() => {
      useCloudflare();
      emailSender.reset();
    });

    /** Aucun compte, aucune organisation, aucun e-mail pour cette adresse. */
    async function expectNothingCreated(
      email: string,
      organizationName: string,
    ) {
      expect(await userModel.countDocuments({ email })).toBe(0);
      expect(
        await organizationModel.countDocuments({ name: organizationName }),
      ).toBe(0);
      expect(emailSender.sentTo(email)).toHaveLength(0);
    }

    it('validation réussie : siteverify appelé (secret, jeton, clé d’idempotence), compte créé et lien envoyé', async () => {
      const email = unique('cf-ok');
      const res = await register(email, { turnstileToken: 'cf-pass-ok' });
      expect(res.status).toBe(202);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(TURNSTILE_SITEVERIFY_URL);
      const sent = JSON.parse(
        typeof init.body === 'string' ? init.body : '{}',
      ) as Record<string, string>;
      expect(sent.secret).toBe(CF_SECRET);
      expect(sent.response).toBe('cf-pass-ok');
      expect(sent.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
      expect(init.signal).toBeDefined();
      expect(await userModel.countDocuments({ email })).toBe(1);
      expect(emailSender.sentTo(email)).toHaveLength(1);
      expect(JSON.stringify(res.body)).not.toContain(CF_SECRET);
    });

    it('jeton rejoué : refusé (timeout-or-duplicate), aucune écriture', async () => {
      const first = unique('cf-replay-a');
      expect(
        (await register(first, { turnstileToken: 'cf-pass-replay' })).status,
      ).toBe(202);
      const second = unique('cf-replay-b');
      const res = await register(
        second,
        { turnstileToken: 'cf-pass-replay' },
        'Org Replay',
      );
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('TURNSTILE_FAILED');
      await expectNothingCreated(second, 'Org Replay');
    });

    it.each([
      ['jeton absent', undefined, 400, 'TURNSTILE_REQUIRED', false],
      ['jeton vide', '   ', 400, 'TURNSTILE_REQUIRED', false],
      ['jeton invalide', 'cf-invalid', 400, 'TURNSTILE_FAILED', true],
      ['jeton expiré', 'cf-expired', 400, 'TURNSTILE_FAILED', true],
      ['hôte inattendu', 'cf-other-host', 400, 'TURNSTILE_FAILED', true],
      ['action inattendue', 'cf-other-action', 400, 'TURNSTILE_FAILED', true],
      [
        'réponse de test hors clé de test',
        'cf-test-key',
        400,
        'TURNSTILE_FAILED',
        true,
      ],
      [
        'erreur interne Cloudflare',
        'cf-internal',
        503,
        'TURNSTILE_UNAVAILABLE',
        true,
      ],
      ['HTTP 500', 'cf-http-500', 503, 'TURNSTILE_UNAVAILABLE', true],
      ['réseau injoignable', 'cf-network', 503, 'TURNSTILE_UNAVAILABLE', true],
    ])(
      '%s → %s, aucune écriture ni e-mail',
      async (_label, token, status, code, called) => {
        const email = unique('cf-refused');
        const organizationName = `Org Refus ${seq}`;
        const res = await register(
          email,
          token === undefined ? {} : { turnstileToken: token },
          organizationName,
        );
        expect(res.status).toBe(status);
        expect(res.body.code).toBe(code);
        expect(fetchMock).toHaveBeenCalledTimes(called ? 1 : 0);
        await expectNothingCreated(email, organizationName);
      },
    );

    it('fournisseur qui ne répond pas : délai borné (TURNSTILE_TIMEOUT_MS), 503 réessayable, aucune écriture', async () => {
      const email = unique('cf-hang');
      const started = Date.now();
      const res = await register(
        email,
        { turnstileToken: 'cf-hang' },
        'Org Hang',
      );
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('TURNSTILE_UNAVAILABLE');
      await expectNothingCreated(email, 'Org Hang');
      // Réessai possible avec un nouveau jeton.
      const retry = await register(
        email,
        { turnstileToken: 'cf-pass-retry' },
        'Org Hang',
      );
      expect(retry.status).toBe(202);
    });

    it('non configuré (aucune clé) : 503, jamais d’inscription non validée', async () => {
      delete process.env.TURNSTILE_SECRET_KEY;
      delete process.env.TURNSTILE_SIMULATED;
      const email = unique('cf-unconfigured');
      const res = await register(
        email,
        { turnstileToken: 'cf-pass-x' },
        'Org Unconf',
      );
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('TURNSTILE_UNAVAILABLE');
      expect(fetchMock).not.toHaveBeenCalled();
      await expectNothingCreated(email, 'Org Unconf');
    });

    it('inscription fermée : 403 avant toute vérification anti-robot', async () => {
      delete process.env.PUBLIC_REGISTRATION_ENABLED;
      try {
        const res = await register(unique('closed'), {
          turnstileToken: 'cf-pass-closed',
        });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('REGISTRATION_DISABLED');
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
      }
    });

    it('mode simulé (test) : usage unique, action vérifiée, indisponibilité simulée', async () => {
      useSimulation();
      const token = simulatedTurnstileToken();
      expect(
        (await register(unique('sim-a'), { turnstileToken: token })).status,
      ).toBe(202);
      const replay = await register(unique('sim-b'), { turnstileToken: token });
      expect([replay.status, replay.body.code]).toEqual([
        400,
        'TURNSTILE_FAILED',
      ]);
      const wrongAction = await register(unique('sim-c'), {
        turnstileToken: simulatedTurnstileToken('login'),
      });
      expect(wrongAction.body.code).toBe('TURNSTILE_FAILED');
      const down = await register(unique('sim-d'), {
        turnstileToken: 'simulated-unavailable',
      });
      expect([down.status, down.body.code]).toEqual([
        503,
        'TURNSTILE_UNAVAILABLE',
      ]);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // ─── 2. Plafond par destinataire d'invitation ────────────────────────────

  describe('2. E-mails de création de compte : plafond par destinataire (2 / 24 h en test)', () => {
    const owners: { email: string; orgId: string; token: string }[] = [];

    beforeAll(async () => {
      for (const label of ['ra', 'rb', 'rc', 'rd']) {
        clearThrottle();
        owners.push(await verifiedOwner(label));
      }
    });
    beforeEach(() => emailSender.reset());

    const sentLinks = (email: string) =>
      emailSender
        .sentTo(email)
        .filter((m) => m.text.includes('/auth/invitations/create-account'));
    const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

    it('partagé entre invitations et organisations ; réponse neutre identique au-delà ; clé opaque', async () => {
      const target = unique('Recipient').toUpperCase().toLowerCase();
      const invitations: { id: string; token: string }[] = [];
      for (const owner of owners.slice(0, 3)) {
        invitations.push(await invite(owner.token, target));
      }
      const first = await accountLink(invitations[0].token);
      await waitFor(() => sentLinks(target).length === 1);
      const second = await accountLink(invitations[1].token);
      await waitFor(() => sentLinks(target).length === 2);
      const third = await accountLink(invitations[2].token);
      await settle();
      expect(sentLinks(target)).toHaveLength(2);
      for (const res of [first, second, third]) {
        expect(res.status).toBe(202);
        expect(res.body).toEqual(first.body);
      }
      // Même invitation, délai individuel écoulé : toujours plafonné.
      await invitationModel.updateOne(
        { _id: new Types.ObjectId(invitations[0].id) },
        { accountLinkLastSentAt: new Date(Date.now() - 120_000) },
      );
      expect((await accountLink(invitations[0].token)).status).toBe(202);
      await settle();
      expect(sentLinks(target)).toHaveLength(2);

      const bucket = await buckets().findOne({
        _id: keyFor(INVITATION_EMAIL_RECIPIENT_SCOPE, target) as never,
      });
      expect(bucket).toMatchObject({
        scope: INVITATION_EMAIL_RECIPIENT_SCOPE,
        count: 4,
      });
      expect(Object.keys(bucket!).sort()).toEqual(
        ['_id', 'count', 'expiresAt', 'scope', 'windowStartedAt'].sort(),
      );
      expect(JSON.stringify(bucket)).not.toContain('@');
    });

    it('demandes concurrentes sur quatre invitations : jamais plus que le plafond', async () => {
      const target = unique('concurrent');
      const invitations: { id: string; token: string }[] = [];
      for (const owner of owners)
        invitations.push(await invite(owner.token, target));
      const responses = await Promise.all(
        invitations.map((invitation) => accountLink(invitation.token)),
      );
      expect(responses.map((r) => r.status)).toEqual([202, 202, 202, 202]);
      await waitFor(() => sentLinks(target).length >= 2);
      await settle();
      expect(sentLinks(target)).toHaveLength(2);
    });

    it('réouverture après expiration de la fenêtre', async () => {
      const target = unique('reopen');
      const invitations: { id: string; token: string }[] = [];
      for (const owner of owners.slice(0, 3)) {
        invitations.push(await invite(owner.token, target));
      }
      await accountLink(invitations[0].token);
      await accountLink(invitations[1].token);
      await waitFor(() => sentLinks(target).length === 2);
      await accountLink(invitations[2].token);
      await settle();
      expect(sentLinks(target)).toHaveLength(2);
      // Fenêtre de 24 h échue (horloge simulée par la base).
      await buckets().updateOne(
        { _id: keyFor(INVITATION_EMAIL_RECIPIENT_SCOPE, target) as never },
        { $set: { windowStartedAt: new Date(Date.now() - 25 * 3_600_000) } },
      );
      await invitationModel.updateOne(
        { _id: new Types.ObjectId(invitations[2].id) },
        { accountLinkLastSentAt: new Date(Date.now() - 120_000) },
      );
      expect((await accountLink(invitations[2].token)).status).toBe(202);
      await waitFor(() => sentLinks(target).length === 3);
    });

    it('adresse avec compte : réponse identique, aucun envoi, plafond non consommé', async () => {
      const existing = owners[3].email;
      const invitation = await invite(owners[0].token, existing);
      const res = await accountLink(invitation.token);
      expect(res.status).toBe(202);
      await settle();
      expect(sentLinks(existing)).toHaveLength(0);
      expect(
        await buckets().countDocuments({
          _id: keyFor(INVITATION_EMAIL_RECIPIENT_SCOPE, existing) as never,
        }),
      ).toBe(0);
    });
  });

  // ─── 3. Plafond d'échecs par compte ──────────────────────────────────────

  describe('3. Échecs d’authentification : plafond par identifiant (3 / 15 min en test)', () => {
    let orgId = '';

    beforeAll(async () => {
      clearThrottle();
      orgId = (await verifiedOwner('accounts')).orgId;
    });

    async function account(
      label: string,
      membership = 'active',
    ): Promise<{ email: string; id: Types.ObjectId }> {
      const email = unique(label);
      const user = await userModel.create({
        emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
        name: label.slice(0, 20),
        email,
        password: await bcrypt.hash(PASSWORD, 10),
      });
      await membershipModel.create({
        organizationId: new Types.ObjectId(orgId),
        userId: user._id,
        role: 'seller',
        status: membership,
      });
      return { email, id: user._id };
    }
    const stable = (body: Record<string, unknown>) => {
      const { timestamp, path, ...rest } = body;
      void timestamp;
      void path;
      return rest;
    };

    it('plusieurs IP contre un compte : refus au-delà du plafond, même avec le bon mot de passe ; autre compte intact', async () => {
      const target = await account('multi-ip');
      const other = await account('other');
      for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
        expect((await login(target.email, 'wrong-pw-!1x', ip)).status).toBe(
          401,
        );
      }
      const blocked = await login(target.email, PASSWORD, '203.0.113.4');
      expect(blocked.status).toBe(429);
      // Turnstile disponible (simulation) : défi de récupération proposé.
      expect(blocked.body.code).toBe('AUTH_CHALLENGE_REQUIRED');
      const retryAfter = Number(blocked.headers['retry-after']);
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(900);
      expect((await login(other.email, PASSWORD, '203.0.113.4')).status).toBe(
        201,
      );
    });

    it('adresse inconnue : même mécanisme et même réponse qu’un compte connu', async () => {
      const known = await account('known');
      const unknown = unique('unknown');
      for (const ip of ['203.0.113.11', '203.0.113.12', '203.0.113.13']) {
        expect((await login(known.email, 'wrong-pw-!1x', ip)).status).toBe(401);
        expect((await login(unknown, 'wrong-pw-!1x', ip)).status).toBe(401);
      }
      const a = await login(known.email, 'wrong-pw-!1x', '203.0.113.14');
      const b = await login(unknown, 'wrong-pw-!1x', '203.0.113.14');
      expect([a.status, b.status]).toEqual([429, 429]);
      expect(stable(a.body as Record<string, unknown>)).toEqual(
        stable(b.body as Record<string, unknown>),
      );
      expect(Boolean(a.headers['retry-after'])).toBe(true);
      expect(Boolean(b.headers['retry-after'])).toBe(true);
    });

    it('compteur partagé par login, credentials/inspect et credentials/accept ; identifiant normalisé', async () => {
      const target = await account('shared');
      const owner = await verifiedOwner('shared-owner');
      const invitation = await invite(owner.token, target.email);
      expect(
        (
          await login(
            target.email.toUpperCase(),
            'wrong-pw-!1x',
            '203.0.113.21',
          )
        ).status,
      ).toBe(401);
      const inspect = await request(server())
        .post('/auth/invitations/credentials/inspect')
        .set('X-Forwarded-For', '203.0.113.22')
        .send({
          token: invitation.token,
          email: target.email.replace(/^./, (c) => c.toUpperCase()),
          password: 'wrong-pw-!1x',
        });
      expect(inspect.status).toBe(401);
      const accept = await request(server())
        .post('/auth/invitations/credentials/accept')
        .set('X-Forwarded-For', '203.0.113.23')
        .send({
          token: invitation.token,
          email: target.email,
          password: 'wrong-pw-!1x',
          consent: true,
        });
      expect(accept.status).toBe(401);
      const blocked = await request(server())
        .post('/auth/invitations/credentials/accept')
        .set('X-Forwarded-For', '203.0.113.24')
        .send({
          token: invitation.token,
          email: target.email,
          password: PASSWORD,
          consent: true,
        });
      expect(blocked.status).toBe(429);
      expect((await login(target.email, PASSWORD, '203.0.113.25')).status).toBe(
        429,
      );
      expect(
        (await invitationModel.findById(invitation.id).exec())!.status,
      ).toBe('pending');
    });

    it('les succès ne comptent pas ; fin de fenêtre : accès rétabli (aucun verrouillage prolongé)', async () => {
      const target = await account('success');
      for (let i = 0; i < 4; i++) {
        expect(
          (await login(target.email, PASSWORD, '203.0.113.31')).status,
        ).toBe(201);
      }
      expect(
        (await login(target.email, 'wrong-pw-!1x', '203.0.113.31')).status,
      ).toBe(401);
      expect(
        (await login(target.email, 'wrong-pw-!1x', '203.0.113.31')).status,
      ).toBe(401);
      expect((await login(target.email, PASSWORD, '203.0.113.31')).status).toBe(
        201,
      );
      expect(
        (await login(target.email, 'wrong-pw-!1x', '203.0.113.32')).status,
      ).toBe(401);
      expect((await login(target.email, PASSWORD, '203.0.113.32')).status).toBe(
        429,
      );
      await buckets().updateOne(
        { _id: keyFor(AUTH_ACCOUNT_FAILURE_SCOPE, target.email) as never },
        { $set: { windowStartedAt: new Date(Date.now() - 901_000) } },
      );
      expect((await login(target.email, PASSWORD, '203.0.113.33')).status).toBe(
        201,
      );
    });

    it('limites par IP conservées : 11ᵉ tentative d’une IP refusée, quels que soient les comptes', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        statuses.push(
          (await login(unique(`ip-${i}`), 'wrong-pw-!1x', '203.0.113.41'))
            .status,
        );
      }
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses[10]).toBe(429);
    });

    it('stockage : clés opaques, ni adresse ni mot de passe en clair', async () => {
      const docs = await buckets().find({}).toArray();
      expect(docs.length).toBeGreaterThan(0);
      const flat = JSON.stringify(docs);
      expect(flat).not.toContain('@');
      expect(flat).not.toContain(PASSWORD);
      expect(flat).not.toContain('wrong-pw');
      for (const doc of docs) {
        expect(String(doc._id)).toMatch(/^[a-z-]+:[0-9a-f]{64}$/);
      }
    });

    it('parcours complet par identifiants (compte sans organisation active) toujours fonctionnel', async () => {
      const orphan = await account('orphan', 'revoked');
      const owner = await verifiedOwner('orphan-owner');
      const invitation = await invite(owner.token, orphan.email);
      const body = {
        token: invitation.token,
        email: orphan.email,
        password: PASSWORD,
      };
      expect((await login(orphan.email, PASSWORD, '203.0.113.51')).status).toBe(
        403,
      );
      const preview = await request(server())
        .post('/auth/invitations/credentials/inspect')
        .set('X-Forwarded-For', '203.0.113.51')
        .send(body);
      expect(preview.status).toBe(200);
      const accepted = await request(server())
        .post('/auth/invitations/credentials/accept')
        .set('X-Forwarded-For', '203.0.113.51')
        .send({ ...body, consent: true });
      expect(accepted.status).toBe(200);
      const logged = await login(orphan.email, PASSWORD, '203.0.113.51');
      expect(logged.status).toBe(201);
      void INVITATION_LEGAL;
    });

    // ─── 4. Récupération d'accès malgré un plafond imposé par un tiers ────
    describe('4. Récupération d’accès : défi Turnstile (action login) puis mot de passe', () => {
      const credentialsLogin = (
        email: string,
        password: string,
        ip: string,
        challengeToken?: string,
      ) =>
        request(server())
          .post('/auth/login')
          .set('X-Forwarded-For', ip)
          .send({
            email,
            password,
            ...(challengeToken ? { challengeToken } : {}),
          });
      const challenge = () => simulatedTurnstileToken('login');

      /** Un tiers fait atteindre le plafond depuis trois IP. */
      async function blockFrom(email: string, prefix: string) {
        for (const n of [1, 2, 3]) {
          expect(
            (await login(email, 'wrong-pw-!1x', `${prefix}.${n}`)).status,
          ).toBe(401);
        }
      }

      beforeAll(() => {
        useSimulation();
        process.env.AUTH_CHALLENGED_FAILURE_LIMIT = '2';
      });
      afterAll(() => {
        delete process.env.AUTH_CHALLENGED_FAILURE_LIMIT;
      });
      beforeEach(() => useSimulation());

      it('titulaire bloqué par un tiers : défi + bon mot de passe → accès rendu, puis connexion normale', async () => {
        const owner = await account('recover');
        await blockFrom(owner.email, '198.18.1');
        const required = await credentialsLogin(
          owner.email,
          PASSWORD,
          '198.18.1.50',
        );
        expect(required.status).toBe(429);
        expect(required.body.code).toBe('AUTH_CHALLENGE_REQUIRED');
        expect(Number(required.headers['retry-after'])).toBeGreaterThan(0);

        const recovered = await credentialsLogin(
          owner.email,
          PASSWORD,
          '198.18.1.50',
          challenge(),
        );
        expect(recovered.status).toBe(201);
        expect(typeof recovered.body.access_token).toBe('string');
        // Accès prouvé (défi + mot de passe) : fenêtre du compte refermée.
        expect((await login(owner.email, PASSWORD, '198.18.1.51')).status).toBe(
          201,
        );
      });

      it('un défi seul ne remet rien à zéro : défi + mauvais mot de passe laisse le plafond en place', async () => {
        const owner = await account('no-reset');
        await blockFrom(owner.email, '198.18.2');
        const wrong = await credentialsLogin(
          owner.email,
          'wrong-pw-!1x',
          '198.18.2.50',
          challenge(),
        );
        expect(wrong.status).toBe(401);
        const still = await login(owner.email, PASSWORD, '198.18.2.51');
        expect([still.status, still.body.code]).toEqual([
          429,
          'AUTH_CHALLENGE_REQUIRED',
        ]);
      });

      it('essais après défi plafonnés par compte ET client : l’attaquant s’épuise, le titulaire passe', async () => {
        const owner = await account('challenged-cap');
        await blockFrom(owner.email, '198.18.3');
        const attacker = '198.18.3.66';
        for (let i = 0; i < 2; i++) {
          expect(
            (
              await credentialsLogin(
                owner.email,
                'wrong-pw-!1x',
                attacker,
                challenge(),
              )
            ).status,
          ).toBe(401);
        }
        // Même avec un défi neuf et même le bon mot de passe : refusé depuis ce client.
        const capped = await credentialsLogin(
          owner.email,
          PASSWORD,
          attacker,
          challenge(),
        );
        expect([capped.status, capped.body.code]).toEqual([
          429,
          AUTH_RATE_LIMIT_CODE,
        ]);
        // Le titulaire, depuis son propre client, n'est pas pénalisé.
        expect(
          (
            await credentialsLogin(
              owner.email,
              PASSWORD,
              '198.18.3.99',
              challenge(),
            )
          ).status,
        ).toBe(201);
      });

      it('défi rejoué, d’une autre action ou absent : refus, aucun accès même avec le bon mot de passe', async () => {
        const owner = await account('bad-challenge');
        await blockFrom(owner.email, '198.18.4');
        const token = challenge();
        expect(
          (
            await credentialsLogin(
              owner.email,
              'wrong-pw-!1x',
              '198.18.4.50',
              token,
            )
          ).status,
        ).toBe(401);
        const replay = await credentialsLogin(
          owner.email,
          PASSWORD,
          '198.18.4.50',
          token,
        );
        expect([replay.status, replay.body.code]).toEqual([
          400,
          'TURNSTILE_FAILED',
        ]);
        const otherAction = await credentialsLogin(
          owner.email,
          PASSWORD,
          '198.18.4.50',
          simulatedTurnstileToken('register'),
        );
        expect([otherAction.status, otherAction.body.code]).toEqual([
          400,
          'TURNSTILE_FAILED',
        ]);
        const down = await credentialsLogin(
          owner.email,
          PASSWORD,
          '198.18.4.50',
          'simulated-unavailable',
        );
        expect([down.status, down.body.code]).toEqual([
          503,
          'TURNSTILE_UNAVAILABLE',
        ]);
        expect(
          (await login(owner.email, PASSWORD, '198.18.4.51')).body.code,
        ).toBe('AUTH_CHALLENGE_REQUIRED');
      });

      it('limites IP conservées : au-delà de 10 essais par minute d’une IP, refus même avec des défis valides', async () => {
        const target = await account('ip-kept');
        await blockFrom(target.email, '198.18.5');
        const ip = '198.18.5.70';
        const statuses: number[] = [];
        for (let i = 0; i < 11; i++) {
          statuses.push(
            (
              await credentialsLogin(
                unique(`ip-kept-${i}`),
                'wrong-pw-!1x',
                ip,
                challenge(),
              )
            ).status,
          );
        }
        expect(statuses[10]).toBe(429);
        const last = await credentialsLogin(
          target.email,
          PASSWORD,
          ip,
          challenge(),
        );
        expect([last.status, last.body.code]).toEqual([
          429,
          AUTH_RATE_LIMIT_CODE,
        ]);
      });

      it('compte inconnu : même réponse « défi requis », puis 401 identique après défi', async () => {
        const known = await account('known-recover');
        const unknown = unique('unknown-recover');
        await blockFrom(known.email, '198.18.6');
        await blockFrom(unknown, '198.18.7');
        const a = await login(known.email, 'wrong-pw-!1x', '198.18.6.50');
        const b = await login(unknown, 'wrong-pw-!1x', '198.18.7.50');
        expect(stable(a.body as Record<string, unknown>)).toEqual(
          stable(b.body as Record<string, unknown>),
        );
        expect(a.body.code).toBe('AUTH_CHALLENGE_REQUIRED');
        const c = await credentialsLogin(
          known.email,
          'wrong-pw-!1x',
          '198.18.6.51',
          challenge(),
        );
        const d = await credentialsLogin(
          unknown,
          'wrong-pw-!1x',
          '198.18.7.51',
          challenge(),
        );
        expect([c.status, d.status]).toEqual([401, 401]);
        expect(stable(c.body as Record<string, unknown>)).toEqual(
          stable(d.body as Record<string, unknown>),
        );
      });

      it('sans Turnstile disponible : aucun défi proposé, refus temporaire seul', async () => {
        const owner = await account('no-turnstile');
        await blockFrom(owner.email, '198.18.8');
        delete process.env.TURNSTILE_SIMULATED;
        delete process.env.TURNSTILE_SECRET_KEY;
        const res = await credentialsLogin(
          owner.email,
          PASSWORD,
          '198.18.8.50',
          challenge(),
        );
        expect([res.status, res.body.code]).toEqual([
          429,
          AUTH_RATE_LIMIT_CODE,
        ]);
      });

      it('compte sans organisation active : défi sur l’aperçu, puis accord explicite et connexion', async () => {
        const orphan = await account('orphan-recover', 'revoked');
        const inviter = await verifiedOwner('orphan-recover-owner');
        useSimulation();
        const invitation = await invite(inviter.token, orphan.email);
        await blockFrom(orphan.email, '198.18.9');
        const body = {
          token: invitation.token,
          email: orphan.email,
          password: PASSWORD,
        };
        const required = await request(server())
          .post('/auth/invitations/credentials/inspect')
          .set('X-Forwarded-For', '198.18.9.50')
          .send(body);
        expect(required.body.code).toBe('AUTH_CHALLENGE_REQUIRED');
        const preview = await request(server())
          .post('/auth/invitations/credentials/inspect')
          .set('X-Forwarded-For', '198.18.9.50')
          .send({ ...body, challengeToken: challenge() });
        expect(preview.status).toBe(200);
        // L'accord reste explicite : sans `consent`, refus de validation.
        const noConsent = await request(server())
          .post('/auth/invitations/credentials/accept')
          .set('X-Forwarded-For', '198.18.9.50')
          .send(body);
        expect(noConsent.status).toBe(400);
        expect(
          (await invitationModel.findById(invitation.id).exec())!.status,
        ).toBe('pending');
        const accepted = await request(server())
          .post('/auth/invitations/credentials/accept')
          .set('X-Forwarded-For', '198.18.9.50')
          .send({ ...body, consent: true });
        expect(accepted.status).toBe(200);
        expect(
          (await login(orphan.email, PASSWORD, '198.18.9.51')).status,
        ).toBe(201);
      });
    });
  });
});
