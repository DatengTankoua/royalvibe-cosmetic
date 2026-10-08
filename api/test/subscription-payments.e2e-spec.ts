import 'reflect-metadata';
import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import { Connection, Model, Types } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { ThrottlerStorage } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { UserDocument } from './../src/users/schemas/user.schema';
import { Organization } from './../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from './../src/organizations/schemas/organization.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import {
  SubscriptionPeriod,
  SubscriptionPeriodDocument,
} from './../src/subscriptions/schemas/subscription-period.schema';
import { ensureSubscriptionPeriodIndexes } from './../src/subscriptions/subscription-period-indexes';
import {
  SubscriptionGrantError,
  SubscriptionsService,
} from './../src/subscriptions/subscriptions.service';
import {
  SUBSCRIPTION_CLOCK,
  SUBSCRIPTION_MONOTONIC_CLOCK,
} from './../src/subscriptions/subscription-clock';
import { SubscriptionSource } from './../src/subscriptions/subscription-terms';
import * as pricing from './../src/subscriptions/subscription-pricing';
import {
  SUBSCRIPTION_PAYMENTS_COLLECTION,
  SubscriptionPayment,
  SubscriptionPaymentDocument,
  SubscriptionPaymentStatus,
} from './../src/subscriptions/payments/schemas/subscription-payment.schema';
import {
  SubscriptionPaymentIndexError,
  ensureSubscriptionPaymentIndexes,
  verifySubscriptionPaymentIndexes,
} from './../src/subscriptions/payments/subscription-payment-indexes';
import { PAYMENT_PROVIDER } from './../src/subscriptions/payments/payment-provider';
import {
  PAYMENT_CONFIRMATION_BUDGET_MS,
  SubscriptionPaymentsService,
} from './../src/subscriptions/payments/subscription-payments.service';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import {
  E2E_EMAIL_VERIFIED_AT,
  autoConfirmVerificationEmails,
  createE2eEmailSender,
} from './e2e/email-verification-fixtures';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';
import { SimulatedPaymentProvider } from './e2e/simulated-payment-provider';
import { OWNER_TERMS } from './e2e/legal-acceptance-fixtures';

/**
 * E2E 1-14D.2B — demandes de paiement et moteur de confirmation, sur le
 * replica set éphémère (garde anti-27017). Prestataire SIMULÉ injecté par
 * `overrideProvider` ; aucun réseau, aucun paiement réel. Ordonnancement
 * concurrent par barrières (jamais d'attente arbitraire).
 *
 * Prérequis : `pnpm --filter api build` (migration compilée exercée en
 * sous-processus sur cette même base).
 */

const TEST_JWT_SECRET = 'subscription-payments-14d2b-e2e-only-secret';
const E2E_CORS_ORIGIN = 'https://subscription-payments-e2e.example.com';
const PASSWORD = 'pay-14d2b-pw-!1x';
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const T0 = new Date('2026-03-01T09:00:00.000Z').getTime();
const TRIAL_END = T0 + 7 * DAY_MS;
const AFTER_TRIAL = T0 + 30 * DAY_MS;
const PHONE = '677123456';

const MIGRATION_SCRIPT = join(
  __dirname,
  '..',
  'dist',
  'migrations',
  'create-subscription-payment-indexes.js',
);

const VIEW_KEYS = [
  'amount',
  'confirmedAt',
  'createdAt',
  'currency',
  'failedAt',
  'initiatedAt',
  'payerPhoneMasked',
  'paymentId',
  'reference',
  'status',
  'term',
].sort();

let clockNow = T0;
const testClock = () => new Date(clockNow);
// Horloge MONOTONE réelle, décalable par un test pour épuiser un budget.
let monotonicOffset = 0;
const testMonotonic = () => performance.now() + monotonicOffset;

const sim = new SimulatedPaymentProvider();

describe('Paiements d’abonnement (e2e 1-14D.2B)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let connection: Connection;
  let mongoUri = '';
  let userModel: Model<UserDocument>;
  let organizationModel: Model<OrganizationDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;
  let periodModel: Model<SubscriptionPeriodDocument>;
  let paymentModel: Model<SubscriptionPaymentDocument>;
  let subscriptions: SubscriptionsService;
  let payments: SubscriptionPaymentsService;
  let seq = 0;
  const emailSender = createE2eEmailSender();

  const server = () => app.getHttpServer();
  const clearThrottle = () =>
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();

  const call = (method: 'get' | 'post', path: string, token?: string) => {
    const req = request(server())[method](path);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  async function registerOwner(label: string) {
    clearThrottle();
    seq += 1;
    const email = `${label}-${seq}-14d2b@pay.test`;
    const reg = await request(server())
      .post('/auth/register')
      .send({
        ...OWNER_TERMS,
        name: 'Owner',
        email,
        password: PASSWORD,
        organizationName: `Org ${seq}`,
      });
    expect(reg.status).toBe(201);
    const orgId = reg.body.organization._id as string;
    return { email, orgId, token: await appToken(email) };
  }

  function loginRaw(email: string) {
    clearThrottle();
    return request(server()).post('/auth/login').send({
      email,
      password: PASSWORD,
    });
  }

  async function appToken(email: string): Promise<string> {
    const res = await loginRaw(email);
    expect(res.status).toBe(201);
    return res.body.access_token as string;
  }

  async function restrictedToken(email: string): Promise<string> {
    const res = await loginRaw(email);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUBSCRIPTION_INACTIVE');
    return res.body.restrictedToken as string;
  }

  async function seedMember(
    orgId: string,
    role: 'admin' | 'seller',
    permissions: string[] = [],
  ): Promise<string> {
    seq += 1;
    const email = `${role}-${seq}-14d2b@pay.test`;
    const user = await userModel.create({
      emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
      name: role,
      email,
      password: await bcrypt.hash(PASSWORD, 10),
      // Rôle legacy `admin` : ne doit JAMAIS ouvrir les paiements.
      role: 'admin',
    });
    await membershipModel.create({
      organizationId: new Types.ObjectId(orgId),
      userId: user._id,
      role,
      status: 'active',
      permissions,
    });
    return appToken(email);
  }

  const pay = (token: string, body: Record<string, unknown> = {}) => {
    clearThrottle();
    return call(
      'post',
      '/organizations/current/subscription/payments',
      token,
    ).send({
      term: 'monthly',
      payerPhone: PHONE,
      clientOperationId: randomUUID(),
      ...body,
    });
  };

  const refresh = (token: string, paymentId: unknown) => {
    clearThrottle();
    return call(
      'post',
      `/organizations/current/subscription/payments/${String(paymentId)}/refresh`,
      token,
    );
  };

  const getPayment = (token: string, paymentId: unknown) =>
    call(
      'get',
      `/organizations/current/subscription/payments/${String(paymentId)}`,
      token,
    );

  const paymentDoc = (paymentId: unknown) =>
    paymentModel.findById(String(paymentId)).lean().exec();

  const paymentsOf = (orgId: string) =>
    paymentModel
      .find({ organizationId: new Types.ObjectId(orgId) })
      .lean()
      .exec();

  const paymentPeriods = (paymentId: unknown) =>
    periodModel
      .find({
        source: SubscriptionSource.PAYMENT,
        sourceReference: `payment:${String(paymentId)}`,
      })
      .lean()
      .exec();

  const periodsOf = (orgId: string) =>
    periodModel
      .find({ organizationId: new Types.ObjectId(orgId) })
      .sort({ sequence: 1 })
      .lean()
      .exec();

  /** Paiement accepté (`pending`) puis validé par le payeur chez le prestataire. */
  async function pendingPayment(token: string, term = 'monthly') {
    const res = await pay(token, { term });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    return res.body as { paymentId: string; reference: string };
  }

  // Une SEULE application par fichier : Passport enregistre la stratégie
  // `jwt` dans un singleton global (le fournisseur par défaut est couvert
  // par `subscription-payments-default-provider.e2e-spec.ts`).
  function buildModule() {
    return Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_SENDER)
      .useValue(emailSender)
      .overrideProvider(SUBSCRIPTION_CLOCK)
      .useValue(testClock)
      .overrideProvider(SUBSCRIPTION_MONOTONIC_CLOCK)
      .useValue(testMonotonic)
      .overrideProvider(PAYMENT_PROVIDER)
      .useValue(sim)
      .compile();
  }

  async function startApp(fixture: TestingModule) {
    const nest = fixture.createNestApplication<INestApplication<App>>();
    nest.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    nest.useGlobalFilters(new HttpExceptionFilter());
    await nest.init();
    return nest;
  }

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      mongoUri = validatedEphemeralUri(replSet);
      process.env.MONGODB_URI = mongoUri;
      process.env.JWT_SECRET = TEST_JWT_SECRET;
      process.env.CORS_ORIGIN = E2E_CORS_ORIGIN;
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';

      moduleFixture = await buildModule();
      app = await startApp(moduleFixture);
      autoConfirmVerificationEmails(app, emailSender);

      connection = moduleFixture.get(getConnectionToken());
      userModel = moduleFixture.get(getModelToken('User'));
      organizationModel = moduleFixture.get(getModelToken(Organization.name));
      membershipModel = moduleFixture.get(
        getModelToken(OrganizationMembership.name),
      );
      periodModel = moduleFixture.get(getModelToken(SubscriptionPeriod.name));
      paymentModel = moduleFixture.get(getModelToken(SubscriptionPayment.name));
      subscriptions = moduleFixture.get(SubscriptionsService);
      payments = moduleFixture.get(SubscriptionPaymentsService);
      await ensureSubscriptionPeriodIndexes(connection);
    } catch (error) {
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  beforeEach(() => {
    clockNow = T0;
    monotonicOffset = 0;
    sim.reset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  // ─── 1. Migration ──────────────────────────────────────────────────────────

  describe('1. Index (migration explicite)', () => {
    const run = (withUri = true) => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.MONGODB_URI;
      if (withUri) env.MONGODB_URI = mongoUri;
      const result = spawnSync(process.execPath, [MIGRATION_SCRIPT], {
        env,
        encoding: 'utf8',
        timeout: 60_000,
      });
      const output = `${result.stdout}${result.stderr}`;
      expect(output).not.toContain(mongoUri);
      expect(output).not.toContain(new URL(mongoUri).host);
      return { status: result.status, output };
    };

    beforeAll(() => {
      if (!existsSync(MIGRATION_SCRIPT)) {
        throw new Error(
          `Script compilé absent (${MIGRATION_SCRIPT}) : exécuter \`pnpm --filter api build\` avant les E2E.`,
        );
      }
    });

    it('absents après le démarrage (autoIndex désactivé) → vérification refusée', async () => {
      await expect(
        verifySubscriptionPaymentIndexes(connection),
      ).rejects.toBeInstanceOf(SubscriptionPaymentIndexError);
    });

    it('index de même clé mal configuré → migration compilée en échec, aucune création, rien écrasé', async () => {
      const collection = connection.collection(
        SUBSCRIPTION_PAYMENTS_COLLECTION,
      );
      await collection.createIndex(
        { merchantReference: 1 },
        { name: 'merchantReference_1' },
      );
      const failed = run();
      expect(failed.status).toBe(1);
      expect(failed.output).toContain(
        'merchantReference_1 : unicité inattendue',
      );
      const kept = (await collection.listIndexes().toArray()).find(
        (i) => i.name === 'merchantReference_1',
      );
      expect(kept?.unique).toBeUndefined();
      // Validation complète AVANT création : aucun autre index créé.
      expect(
        (await collection.listIndexes().toArray()).map((i) => i.name).sort(),
      ).toEqual(['_id_', 'merchantReference_1']);
      await collection.dropIndex('merchantReference_1');
    });

    it('migration compilée exécutée deux fois : créés, puis déjà présents ; sans URI → code 1', async () => {
      const first = run();
      expect(first.status).toBe(0);
      expect(first.output).toContain('index créés et vérifiés');
      const second = run();
      expect(second.status).toBe(0);
      expect(second.output).toContain('déjà présents');
      await expect(
        verifySubscriptionPaymentIndexes(connection),
      ).resolves.toBeUndefined();
      await expect(ensureSubscriptionPaymentIndexes(connection)).resolves.toBe(
        'already-present',
      );
      expect(run(false).status).toBe(1);
    });
  });

  // ─── 2. Accès ──────────────────────────────────────────────────────────────

  describe('2. Accès : propriétaire réel uniquement', () => {
    it('propriétaire avec JWT applicatif ou jeton limité → autorisé', async () => {
      const active = await registerOwner('owner-app');
      expect((await pay(active.token)).status).toBe(201);

      const expired = await registerOwner('owner-limited');
      clockNow = AFTER_TRIAL;
      const limited = await restrictedToken(expired.email);
      const res = await pay(limited);
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('pending');
      expect((await getPayment(limited, res.body.paymentId)).status).toBe(200);
      expect((await refresh(limited, res.body.paymentId)).status).toBe(200);
      // Le jeton limité n'ouvre toujours aucune route métier.
      const business = await call('get', '/products', limited);
      expect(business.status).toBe(403);
      expect(business.body.code).toBe('SUBSCRIPTION_ACCESS_LIMITED');
    });

    it('admin (toutes permissions + rôle legacy admin) et vendeur → 403 sur les 4 routes ; sans JWT → 401', async () => {
      const { orgId, token } = await registerOwner('roles');
      const { paymentId } = await pendingPayment(token);
      // Admin : toutes les permissions délégables par défaut de son rôle.
      const admin = await seedMember(orgId, 'admin');
      const seller = await seedMember(orgId, 'seller');
      for (const candidate of [admin, seller]) {
        const responses = [
          await pay(candidate),
          await call(
            'get',
            '/organizations/current/subscription/payments',
            candidate,
          ),
          await getPayment(candidate, paymentId),
          await refresh(candidate, paymentId),
        ];
        for (const res of responses) {
          expect(res.status).toBe(403);
          expect(res.body.code).toBe('PERMISSION_DENIED');
        }
      }
      expect((await pay('')).status).toBe(401);
      expect(
        (
          await call(
            'get',
            `/organizations/current/subscription/payments/${paymentId}`,
          )
        ).status,
      ).toBe(401);
      expect(await paymentsOf(orgId)).toHaveLength(1);
    });

    it('organisation suspendue → 403 ; session révoquée → 401 (gardes globaux conservés)', async () => {
      const suspended = await registerOwner('suspended');
      await organizationModel.updateOne(
        { _id: new Types.ObjectId(suspended.orgId) },
        { $set: { status: 'suspended' } },
      );
      const res = await pay(suspended.token);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ORGANIZATION_ACCESS_DENIED');

      const revoked = await registerOwner('revoked');
      await userModel.updateOne(
        { email: revoked.email },
        { $inc: { authVersion: 1 } },
      );
      expect((await pay(revoked.token)).status).toBe(401);
      expect(sim.initiations).toHaveLength(0);
    });
  });

  // ─── 3. Validation, projection et isolation ────────────────────────────────

  describe('3. Validation stricte, projection, isolation A/B', () => {
    it.each([
      ['amount', 1],
      ['currency', 'XOF'],
      ['organizationId', '64b7f0a1c2d3e4f5a6b7c8d9'],
      ['requestedBy', '64b7f0a1c2d3e4f5a6b7c8d9'],
      ['provider', 'simulated'],
      ['status', 'succeeded'],
      ['term', 'weekly'],
      ['clientOperationId', 'not-a-uuid'],
    ])(
      'champ %s forgé ou invalide → 400, aucune demande',
      async (field, value) => {
        const { orgId, token } = await registerOwner(`forged-${field}`);
        const res = await pay(token, { [field]: value });
        expect(res.status).toBe(400);
        expect(await paymentsOf(orgId)).toHaveLength(0);
        expect(sim.initiations).toHaveLength(0);
      },
    );

    it('téléphone invalide → 400 INVALID_PAYER_PHONE ; jamais stocké en clair', async () => {
      const { orgId, token } = await registerOwner('phone');
      const bad = await pay(token, { payerPhone: '+33 6 12 34 56 78' });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('INVALID_PAYER_PHONE');
      expect(await paymentsOf(orgId)).toHaveLength(0);

      const ok = await pay(token, { payerPhone: '+237 677 12 34 56' });
      expect(ok.status).toBe(201);
      expect(sim.initiations[0].payerPhone).toBe('237677123456');
      const raw = JSON.stringify(await paymentDoc(ok.body.paymentId));
      expect(raw).not.toContain('677123456');
      expect(raw).not.toContain('12 34 56');
    });

    it('projection explicite (aucune empreinte ni donnée interne), no-store', async () => {
      const { token } = await registerOwner('projection');
      const created = await pay(token);
      expect(created.headers['cache-control']).toBe('no-store');
      expect(Object.keys(created.body as object).sort()).toEqual(
        [...VIEW_KEYS, 'replayed'].sort(),
      );
      expect(created.body).toMatchObject({
        status: 'pending',
        term: 'monthly',
        amount: 3000,
        currency: 'XAF',
        payerPhoneMasked: '+237 6•• ••• •56',
      });
      expect(created.body.reference).toMatch(/^SM[0-9A-F]{24}$/);
      const read = await getPayment(token, created.body.paymentId);
      expect(Object.keys(read.body as object).sort()).toEqual(VIEW_KEYS);
      expect(read.headers['cache-control']).toBe('no-store');
      for (const leak of [
        'requestFingerprint',
        'clientOperationId',
        'providerReference',
        'SIM-',
        'requestedBy',
        'organizationId',
      ]) {
        expect(JSON.stringify(read.body)).not.toContain(leak);
      }
    });

    it('autre organisation, id invalide ou inexistant → 404 uniforme ; listes isolées', async () => {
      const a = await registerOwner('iso-a');
      const b = await registerOwner('iso-b');
      const { paymentId } = await pendingPayment(a.token);
      for (const res of [
        await getPayment(b.token, paymentId),
        await refresh(b.token, paymentId),
        await getPayment(b.token, 'nope'),
        await getPayment(b.token, new Types.ObjectId().toHexString()),
      ]) {
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('PAYMENT_NOT_FOUND');
        expect(res.headers['cache-control']).toBe('no-store');
      }
      const listB = await call(
        'get',
        '/organizations/current/subscription/payments',
        b.token,
      );
      expect(listB.body).toEqual({ items: [], nextCursor: null });
      expect(sim.statusCalls).toBe(0);
    });

    it('refresh : corps non vide refusé ; historique paginé et borné', async () => {
      const { token } = await registerOwner('history');
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        sim.queueInitiation('reject');
        const res = await pay(token);
        expect(res.body.status).toBe('failed');
        ids.push(res.body.paymentId as string);
      }
      clearThrottle();
      const withBody = await call(
        'post',
        `/organizations/current/subscription/payments/${ids[0]}/refresh`,
        token,
      ).send({ status: 'succeeded' });
      expect(withBody.status).toBe(400);
      expect(withBody.body.code).toBe('UNEXPECTED_BODY');

      const page1 = await call(
        'get',
        '/organizations/current/subscription/payments?limit=2',
        token,
      );
      expect(
        page1.body.items.map((p: { paymentId: string }) => p.paymentId),
      ).toEqual([ids[2], ids[1]]);
      const page2 = await call(
        'get',
        `/organizations/current/subscription/payments?limit=2&before=${page1.body.nextCursor}`,
        token,
      );
      expect(page2.body).toMatchObject({ nextCursor: null });
      expect(
        page2.body.items.map((p: { paymentId: string }) => p.paymentId),
      ).toEqual([ids[0]]);
      for (const query of ['limit=0', 'limit=51', 'before=nope', 'extra=1']) {
        const bad = await call(
          'get',
          `/organizations/current/subscription/payments?${query}`,
          token,
        );
        expect(bad.status).toBe(400);
      }
    });
  });

  // ─── 4. Tarif figé ─────────────────────────────────────────────────────────

  describe('4. Tarifs figés', () => {
    it('rejeu identique après changement de catalogue → même paiement au tarif figé ; confirmation au tarif figé', async () => {
      const { orgId, token } = await registerOwner('frozen');
      const clientOperationId = randomUUID();
      const created = await pay(token, {
        term: 'quarterly',
        clientOperationId,
      });
      expect(created.body).toMatchObject({ amount: 8500, replayed: false });

      // Catalogue « modifié » (simulation) : nouveau tarif, nouvelle version.
      const original = pricing.getSubscriptionPrice;
      jest
        .spyOn(pricing, 'getSubscriptionPrice')
        .mockImplementation((term: unknown) => ({
          ...original(term),
          amount: 9900,
          pricingVersion: 2,
        }));
      const replay = await pay(token, { term: 'quarterly', clientOperationId });
      expect(replay.status).toBe(201);
      expect(replay.body).toMatchObject({
        paymentId: created.body.paymentId,
        amount: 8500,
        replayed: true,
      });
      expect(sim.initiations).toHaveLength(1);
      jest.restoreAllMocks();

      const doc = await paymentDoc(created.body.paymentId);
      expect(doc).toMatchObject({
        amount: 8500,
        pricingVersion: 1,
        currency: 'XAF',
      });
      sim.settle(String(created.body.reference), 'succeeded');
      const done = await refresh(token, created.body.paymentId);
      expect(done.body).toMatchObject({ status: 'succeeded', amount: 8500 });
      expect(await paymentsOf(orgId)).toHaveLength(1);
    });
  });

  // ─── 5. Rejeu et concurrence à l'initiation ────────────────────────────────

  describe('5. Rejeu et concurrence à l’initiation', () => {
    it('double clic : 5 envois simultanés du même UUID → une demande, une initiation', async () => {
      const { orgId, token } = await registerOwner('double-click');
      const clientOperationId = randomUUID();
      clearThrottle();
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          call(
            'post',
            '/organizations/current/subscription/payments',
            token,
          ).send({
            term: 'monthly',
            payerPhone: PHONE,
            clientOperationId,
          }),
        ),
      );
      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(new Set(results.map((r) => r.body.paymentId)).size).toBe(1);
      expect(results.filter((r) => r.body.replayed === false)).toHaveLength(1);
      expect(sim.initiations).toHaveLength(1);
      expect(await paymentsOf(orgId)).toHaveLength(1);
    });

    it('demandes différentes pendant une initiation en cours → 409 PAYMENT_ALREADY_PENDING, une seule collecte', async () => {
      const { orgId, token } = await registerOwner('concurrent');
      const gate = sim.gateInitiation('accept');
      const first = pay(token).then((r) => r);
      await gate.reached;
      const others = await Promise.all(
        [1, 2, 3, 4].map(() => pay(token, { term: 'annual' })),
      );
      gate.release();
      const winner = await first;
      expect(winner.status).toBe(201);
      for (const res of others) {
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
          code: 'PAYMENT_ALREADY_PENDING',
          paymentId: winner.body.paymentId,
        });
      }
      expect(sim.initiations).toHaveLength(1);
      expect(await paymentsOf(orgId)).toHaveLength(1);
    });

    it('UUID réutilisé pour une autre demande → 409 stable ; après refus confirmé, nouvelle demande acceptée', async () => {
      const { orgId, token } = await registerOwner('uuid');
      const clientOperationId = randomUUID();
      const created = await pay(token, { clientOperationId });
      for (const variant of [{ term: 'annual' }, { payerPhone: '699999999' }]) {
        const res = await pay(token, { clientOperationId, ...variant });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('PAYMENT_OPERATION_CONFLICT');
      }
      const second = await pay(token);
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('PAYMENT_ALREADY_PENDING');
      expect(sim.initiations).toHaveLength(1);

      sim.settle(String(created.body.reference), 'failed');
      expect((await refresh(token, created.body.paymentId)).body.status).toBe(
        'failed',
      );
      const next = await pay(token);
      expect(next.status).toBe(201);
      expect(next.body.paymentId).not.toBe(created.body.paymentId);
      expect(await paymentsOf(orgId)).toHaveLength(2);
      expect(
        (await periodsOf(orgId)).filter(
          (p) => p.source === SubscriptionSource.PAYMENT,
        ),
      ).toHaveLength(0);
    });
  });

  // ─── 6. Initiation incertaine ──────────────────────────────────────────────

  describe('6. Initiation incertaine', () => {
    it('collecte créée, réponse perdue → même référence, aucune seconde collecte ; récupération sûre par référence marchand', async () => {
      const { orgId, token } = await registerOwner('lost');
      const clientOperationId = randomUUID();
      sim.queueInitiation('lost');
      const created = await pay(token, { clientOperationId });
      expect(created.status).toBe(201);
      expect(created.body.status).toBe('uncertain');
      const reference = created.body.reference as string;
      expect(sim.byMerchant(reference)?.state).toBe('pending');

      const replay = await pay(token, { clientOperationId });
      expect(replay.body).toMatchObject({
        paymentId: created.body.paymentId,
        reference,
        status: 'uncertain',
        replayed: true,
      });
      expect((await pay(token)).body.code).toBe('PAYMENT_ALREADY_PENDING');
      expect(sim.initiations).toHaveLength(1);

      const recovered = await refresh(token, created.body.paymentId);
      expect(recovered.body.status).toBe('pending');
      expect(
        (await paymentDoc(created.body.paymentId))?.providerReference,
      ).toBe(sim.byMerchant(reference)?.providerReference);
      sim.settle(reference, 'succeeded');
      expect((await refresh(token, created.body.paymentId)).body.status).toBe(
        'succeeded',
      );
      expect(await paymentPeriods(created.body.paymentId)).toHaveLength(1);
      expect(sim.initiations).toHaveLength(1);
      expect(await paymentsOf(orgId)).toHaveLength(1);
    });

    it('incertitude sans collecte retrouvée → état incertain conservé, collecte bloquée', async () => {
      const { token } = await registerOwner('uncertain');
      sim.queueInitiation('uncertain-not-created');
      const created = await pay(token);
      expect(created.body.status).toBe('uncertain');
      const after = await refresh(token, created.body.paymentId);
      expect(after.status).toBe(200);
      expect(after.body.status).toBe('uncertain');
      expect((await paymentDoc(created.body.paymentId))?.open).toBe(true);
      expect((await pay(token)).body.code).toBe('PAYMENT_ALREADY_PENDING');
      expect(sim.initiations).toHaveLength(1);
    });

    it('prestataire sans recherche par référence marchand → aucune consultation, état conservé', async () => {
      const { token } = await registerOwner('no-lookup');
      sim.supportsMerchantReferenceLookup = false;
      sim.queueInitiation('lost');
      const created = await pay(token);
      const after = await refresh(token, created.body.paymentId);
      expect(after.body.status).toBe('uncertain');
      expect(sim.statusCalls).toBe(0);
      expect(sim.initiations).toHaveLength(1);
    });

    it('requête jamais transmise → 503, paiement fermé (aucune collecte possible) ; nouvelle demande permise', async () => {
      const { orgId, token } = await registerOwner('not-sent');
      sim.queueInitiation('unavailable');
      const res = await pay(token);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('PAYMENT_SERVICE_UNAVAILABLE');
      const [doc] = await paymentsOf(orgId);
      expect(doc).toMatchObject({
        status: 'failed',
        open: false,
        incidentCode: 'provider_unavailable',
      });
      expect((await pay(token)).status).toBe(201);
    });

    it('statut indisponible → 503 PAYMENT_STATUS_UNAVAILABLE, état conservé, lecture locale possible', async () => {
      const { token } = await registerOwner('status-down');
      const { paymentId } = await pendingPayment(token);
      sim.queueStatus('unavailable');
      const res = await refresh(token, paymentId);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('PAYMENT_STATUS_UNAVAILABLE');
      expect((await getPayment(token, paymentId)).body.status).toBe('pending');
    });
  });

  // ─── 7. Délais ─────────────────────────────────────────────────────────────

  describe('7. Délais locaux', () => {
    it('attente au-delà de 15 minutes → toujours ouvert, aucune seconde collecte ; succès tardif accepté sans perte de durée', async () => {
      const { orgId, token } = await registerOwner('slow');
      const { paymentId, reference } = await pendingPayment(token);
      clockNow = T0 + 16 * MINUTE_MS;
      expect((await refresh(token, paymentId)).body.status).toBe('pending');
      clockNow = T0 + 3 * DAY_MS;
      expect((await refresh(token, paymentId)).body.status).toBe('pending');
      expect((await pay(token)).body.code).toBe('PAYMENT_ALREADY_PENDING');
      expect((await paymentDoc(paymentId))?.open).toBe(true);
      expect(sim.initiations).toHaveLength(1);

      sim.settle(reference, 'succeeded');
      expect((await refresh(token, paymentId)).body.status).toBe('succeeded');
      const periods = await periodsOf(orgId);
      // début = max(heure serveur, fin de couverture) = fin de l'essai.
      expect(periods[1].startsAt.getTime()).toBe(TRIAL_END);
      expect(periods[1].source).toBe('payment');
    });

    it('succès après expiration de l’essai → début à l’heure serveur', async () => {
      const { orgId, token } = await registerOwner('late');
      const { paymentId, reference } = await pendingPayment(token);
      clockNow = AFTER_TRIAL;
      sim.settle(reference, 'succeeded');
      const view = await payments.confirmPayment(new Types.ObjectId(paymentId));
      expect(view.status).toBe('succeeded');
      const periods = await periodsOf(orgId);
      expect(periods[1].startsAt.getTime()).toBe(AFTER_TRIAL);
    });
  });

  // ─── 8. Confirmation atomique ──────────────────────────────────────────────

  describe('8. Confirmation atomique', () => {
    it('dix confirmations concurrentes → une seule période, paiement marqué une fois', async () => {
      const { orgId, token } = await registerOwner('ten');
      const { paymentId, reference } = await pendingPayment(token);
      sim.settle(reference, 'succeeded');
      const views = await Promise.all(
        Array.from({ length: 10 }, () =>
          payments.confirmPayment(new Types.ObjectId(paymentId)),
        ),
      );
      expect(
        views.every((v) => v.status === SubscriptionPaymentStatus.SUCCEEDED),
      ).toBe(true);
      const periods = await paymentPeriods(paymentId);
      expect(periods).toHaveLength(1);
      expect((await periodsOf(orgId)).map((p) => p.sequence)).toEqual([1, 2]);
      const doc = await paymentDoc(paymentId);
      expect(doc).toMatchObject({ status: 'succeeded', open: false });
      expect(String(doc?.periodId)).toBe(String(periods[0]._id));
    });

    it('échec après attribution dans la transaction → rollback commun ; reprise sans double attribution', async () => {
      const { orgId, token } = await registerOwner('rollback');
      const { paymentId, reference } = await pendingPayment(token);
      sim.settle(reference, 'succeeded');
      const original =
        subscriptions.grantSubscriptionInSession.bind(subscriptions);
      jest
        .spyOn(subscriptions, 'grantSubscriptionInSession')
        .mockImplementationOnce(async (input, session) => {
          await original(input, session);
          throw new Error('crash-after-grant');
        });
      await expect(
        payments.confirmPayment(new Types.ObjectId(paymentId)),
      ).rejects.toThrow('crash-after-grant');
      expect(await paymentPeriods(paymentId)).toHaveLength(0);
      expect(await paymentDoc(paymentId)).toMatchObject({
        status: 'pending',
        open: true,
        periodId: null,
      });

      expect((await refresh(token, paymentId)).body.status).toBe('succeeded');
      expect((await refresh(token, paymentId)).body.status).toBe('succeeded');
      expect(await paymentPeriods(paymentId)).toHaveLength(1);
      expect(await periodsOf(orgId)).toHaveLength(2);
    });

    it('refus confirmé → aucune attribution ; succès confirmé ensuite (renversement) → attribué une fois', async () => {
      const { orgId, token } = await registerOwner('refused');
      const { paymentId, reference } = await pendingPayment(token);
      sim.settle(reference, 'failed');
      expect((await refresh(token, paymentId)).body.status).toBe('failed');
      expect(await paymentPeriods(paymentId)).toHaveLength(0);
      sim.settle(reference, 'succeeded');
      expect((await refresh(token, paymentId)).body.status).toBe('succeeded');
      expect(await paymentPeriods(paymentId)).toHaveLength(1);
      expect(await periodsOf(orgId)).toHaveLength(2);
    });

    it('échec arrivé après un succès (réponse désordonnée) → aucune régression ni retrait de période', async () => {
      const { orgId, token } = await registerOwner('out-of-order');
      const { paymentId, reference } = await pendingPayment(token);
      sim.settle(reference, 'succeeded');
      // A lit un statut OBSOLÈTE (`failed`), retenu par une barrière ;
      // B confirme le succès pendant ce temps.
      const stale = sim.gateStatus({ override: { state: 'failed' } });
      const a = payments.confirmPayment(new Types.ObjectId(paymentId));
      await stale.reached;
      const b = await payments.confirmPayment(new Types.ObjectId(paymentId));
      expect(b.status).toBe('succeeded');
      stale.release();
      expect((await a).status).toBe('succeeded');
      expect(await paymentDoc(paymentId)).toMatchObject({
        status: 'succeeded',
        incidentCode: 'late_failure_after_success',
      });
      expect(await paymentPeriods(paymentId)).toHaveLength(1);

      // Après succès : aucun nouvel appel au prestataire.
      sim.settle(reference, 'failed');
      const calls = sim.statusCalls;
      expect((await refresh(token, paymentId)).body.status).toBe('succeeded');
      expect(sim.statusCalls).toBe(calls);
      expect(await periodsOf(orgId)).toHaveLength(2);
    });

    it('réponse `pending` arrivée après un succès → aucune régression, paiement fermé, période conservée', async () => {
      const { orgId, token } = await registerOwner('late-pending');
      const { paymentId, reference } = await pendingPayment(token);
      sim.settle(String(reference), 'succeeded');
      // A lit un statut OBSOLÈTE `pending`, retenu ; B confirme le succès.
      const stale = sim.gateStatus({ override: { state: 'pending' } });
      const a = payments.confirmPayment(new Types.ObjectId(paymentId));
      await stale.reached;
      const b = await payments.confirmPayment(new Types.ObjectId(paymentId));
      expect(b.status).toBe(SubscriptionPaymentStatus.SUCCEEDED);
      stale.release();
      expect((await a).status).toBe(SubscriptionPaymentStatus.SUCCEEDED);
      const doc = await paymentDoc(paymentId);
      expect(doc).toMatchObject({ status: 'succeeded', open: false });
      const periods = await paymentPeriods(paymentId);
      expect(periods).toHaveLength(1);
      expect(String(doc?.periodId)).toBe(String(periods[0]._id));
      expect(await periodsOf(orgId)).toHaveLength(2);
    });

    it('réponse d’initiation `accepted` arrivée après un succès → aucune régression', async () => {
      const { orgId, token } = await registerOwner('late-accepted');
      // La collecte existe chez le prestataire, mais la réponse `accepted`
      // est retenue par une barrière.
      const gate = sim.gateInitiation('accept', { createdBeforeGate: true });
      const creation = pay(token).then((r) => r);
      await gate.reached;
      const [inFlight] = await paymentsOf(orgId);
      expect(inFlight.status).toBe('initiating');
      // Le payeur valide ; une confirmation (recherche par référence
      // marchand) aboutit AVANT la réponse d'initiation.
      sim.settle(inFlight.merchantReference, 'succeeded');
      const confirmed = await payments.confirmPayment(inFlight._id);
      expect(confirmed.status).toBe(SubscriptionPaymentStatus.SUCCEEDED);
      gate.release();
      const created = await creation;
      expect(created.status).toBe(201);
      expect(created.body.status).toBe('succeeded');
      const doc = await paymentDoc(inFlight._id);
      expect(doc).toMatchObject({
        status: 'succeeded',
        open: false,
        providerReference: sim.byMerchant(inFlight.merchantReference)
          ?.providerReference,
      });
      expect(await paymentPeriods(inFlight._id)).toHaveLength(1);
      expect(await periodsOf(orgId)).toHaveLength(2);
      expect(sim.initiations).toHaveLength(1);
    });
  });

  // ─── 9. Concordance ───────────────────────────────────────────────────────

  describe('9. Concordance obligatoire', () => {
    it.each([
      ['montant différent', { amount: 2999 }],
      ['montant non numérique', { amount: '3000' }],
      ['montant décimal', { amount: 3000.5 }],
      ['devise', { currency: 'XOF' }],
      ['référence marchand', { merchantReference: 'SMOTHER' }],
      ['référence marchand absente', { merchantReference: null }],
      ['référence prestataire', { providerReference: 'SIM-OTHER' }],
    ])(
      '%s → review, aucune attribution ni nouvelle collecte',
      async (_label, override) => {
        const { orgId, token } = await registerOwner('mismatch');
        const { paymentId, reference } = await pendingPayment(token);
        sim.settle(reference, 'succeeded');
        sim.queueStatus({ override });
        const res = await refresh(token, paymentId);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('review');
        expect(await paymentDoc(paymentId)).toMatchObject({
          open: true,
          incidentCode: 'provider_mismatch',
          periodId: null,
        });
        expect(await paymentPeriods(paymentId)).toHaveLength(0);
        expect((await pay(token)).body.code).toBe('PAYMENT_ALREADY_PENDING');
        // Statut ultérieur concordant : reste à traiter (opérateur).
        expect((await refresh(token, paymentId)).body.status).toBe('review');
        expect(await periodsOf(orgId)).toHaveLength(1);
        expect(sim.initiations).toHaveLength(1);
      },
    );
  });

  // ─── 10. Reprise de l'accès ────────────────────────────────────────────────

  describe('10. Accès rétabli par les contrats existants', () => {
    it('jeton limité → paiement confirmé → échange `complete` → accès métier ; rôles et permissions inchangés', async () => {
      const { orgId, email } = await registerOwner('resume');
      const seller = await seedMember(orgId, 'seller');
      const membershipsBefore = await membershipModel
        .find({ organizationId: new Types.ObjectId(orgId) })
        .sort({ _id: 1 })
        .lean()
        .exec();
      clockNow = AFTER_TRIAL;
      const limited = await restrictedToken(email);
      const res = await pay(limited);
      sim.settle(String(res.body.reference), 'succeeded');
      expect((await refresh(limited, res.body.paymentId)).body.status).toBe(
        'succeeded',
      );

      const state = await call(
        'get',
        '/organizations/current/subscription',
        limited,
      );
      expect(state.body.state).toBe('active');
      const completed = await call(
        'post',
        '/auth/subscription-access/complete',
        limited,
      );
      expect(completed.status).toBe(200);
      const appJwt = completed.body.access_token as string;
      expect((await call('get', '/products', appJwt)).status).toBe(200);
      // Le jeton limité reste limité.
      expect((await call('get', '/products', limited)).body.code).toBe(
        'SUBSCRIPTION_ACCESS_LIMITED',
      );
      // Vendeur : refus COMMERCIAL levé (ses permissions restent les siennes).
      expect((await call('get', '/products', seller)).body.code).not.toBe(
        'SUBSCRIPTION_INACTIVE',
      );
      const sellerPayments = await call(
        'get',
        '/organizations/current/subscription/payments',
        seller,
      );
      expect(sellerPayments.body.code).toBe('PERMISSION_DENIED');
      const membershipsAfter = await membershipModel
        .find({ organizationId: new Types.ObjectId(orgId) })
        .sort({ _id: 1 })
        .lean()
        .exec();
      expect(
        membershipsAfter.map((m) => [m.role, m.status, m.permissions]),
      ).toEqual(
        membershipsBefore.map((m) => [m.role, m.status, m.permissions]),
      );
    });

    it('organisation suspendue : le paiement aboutit mais la suspension reste prioritaire', async () => {
      const { orgId, token } = await registerOwner('paid-suspended');
      const { paymentId, reference } = await pendingPayment(token);
      await organizationModel.updateOne(
        { _id: new Types.ObjectId(orgId) },
        { $set: { status: 'suspended' } },
      );
      sim.settle(reference, 'succeeded');
      expect((await refresh(token, paymentId)).body.code).toBe(
        'ORGANIZATION_ACCESS_DENIED',
      );
      const view = await payments.confirmPayment(new Types.ObjectId(paymentId));
      expect(view.status).toBe('succeeded');
      const org = await organizationModel.findById(orgId).lean().exec();
      expect(org?.status).toBe('suspended');
      expect((await call('get', '/products', token)).body.code).toBe(
        'ORGANIZATION_ACCESS_DENIED',
      );
    });
  });

  // ─── 11. Limitation de débit ───────────────────────────────────────────────

  describe('11. Limitation de débit (stockage existant)', () => {
    it('écritures limitées par utilisateur+organisation ; lectures sur une fenêtre distincte', async () => {
      const { token } = await registerOwner('rate');
      const { paymentId } = await pendingPayment(token);
      clearThrottle();
      const statuses: number[] = [];
      let limited: request.Response | null = null;
      for (let i = 0; i < 11; i++) {
        const res = await call(
          'post',
          `/organizations/current/subscription/payments/${paymentId}/refresh`,
          token,
        );
        statuses.push(res.status);
        if (res.status === 429) limited = res;
      }
      expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
      expect(statuses[10]).toBe(429);
      expect(limited?.body.code).toBe('PAYMENT_RATE_LIMITED');
      expect(Number(limited?.headers['retry-after'])).toBeGreaterThan(0);
      expect(limited?.headers['cache-control']).toBe('no-store');
      expect((await getPayment(token, paymentId)).status).toBe(200);
      clearThrottle();
    });
  });
  // ─── 12. Budget transactionnel ─────────────────────────────────────────────

  describe('12. Budget global de la confirmation (30 s)', () => {
    it('budget épuisé après une collision → 503 PAYMENT_CONFIRMATION_PENDING, aucune nouvelle tentative ni changement d’état ; confirmation ultérieure idempotente', async () => {
      const { orgId, token } = await registerOwner('budget');
      const { paymentId, reference } = await pendingPayment(token);
      sim.settle(String(reference), 'succeeded');
      const spy = jest
        .spyOn(subscriptions, 'grantSubscriptionInSession')
        .mockImplementationOnce(() => {
          // Le temps monotone dépasse l'échéance pendant la tentative, qui
          // échoue sur une collision normalement rejouable.
          monotonicOffset += PAYMENT_CONFIRMATION_BUDGET_MS + 1;
          return Promise.reject(
            Object.assign(new Error('E11000 duplicate key error'), {
              code: 11000,
              keyPattern: { organizationId: 1, sequence: 1 },
            }),
          );
        });
      const res = await refresh(token, paymentId);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('PAYMENT_CONFIRMATION_PENDING');
      expect(res.headers['cache-control']).toBe('no-store');
      // Aucune nouvelle tentative après l'épuisement du budget.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await paymentDoc(paymentId)).toMatchObject({
        status: 'pending',
        open: true,
        periodId: null,
      });
      expect(await paymentPeriods(paymentId)).toHaveLength(0);
      expect((await pay(token)).body.code).toBe('PAYMENT_ALREADY_PENDING');
      expect(sim.initiations).toHaveLength(1);

      // Nouvelle confirmation : NOUVEAU budget, attribution unique.
      spy.mockRestore();
      expect((await refresh(token, paymentId)).body.status).toBe('succeeded');
      expect((await refresh(token, paymentId)).body.status).toBe('succeeded');
      expect(await paymentPeriods(paymentId)).toHaveLength(1);
      expect(await periodsOf(orgId)).toHaveLength(2);
    });

    it('commit validé mais réponse perdue (expiration) → 503, puis rejeu retrouvant le commit, sans seconde période', async () => {
      const { orgId, token } = await registerOwner('budget-commit');
      const { paymentId, reference } = await pendingPayment(token);
      sim.settle(String(reference), 'succeeded');
      const original = subscriptions.runInGrantTransaction.bind(subscriptions);
      jest
        .spyOn(subscriptions, 'runInGrantTransaction')
        .mockImplementationOnce(async (work, options) => {
          await original(work, options);
          throw new SubscriptionGrantError('GRANT_TIMEOUT', 'lost response');
        });
      const res = await refresh(token, paymentId);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('PAYMENT_CONFIRMATION_PENDING');
      const statusCalls = sim.statusCalls;
      const again = await refresh(token, paymentId);
      expect(again.body.status).toBe('succeeded');
      // Rejeu local : aucun appel prestataire, aucune seconde attribution.
      expect(sim.statusCalls).toBe(statusCalls);
      expect(await paymentPeriods(paymentId)).toHaveLength(1);
      expect(await periodsOf(orgId)).toHaveLength(2);
    });

    it('expiration CSOT RÉELLE du driver : transaction annulée côté serveur, aucune écriture validée', async () => {
      const { orgId } = await registerOwner('csot');
      const witnesses = connection.collection('e2e_csot_witnesses');
      if (
        !(await connection
          .db!.listCollections({ name: 'e2e_csot_witnesses' })
          .hasNext())
      ) {
        await connection.createCollection('e2e_csot_witnesses');
      }
      let attempts = 0;
      const error: unknown = await subscriptions
        .runInGrantTransaction(
          async (session) => {
            attempts += 1;
            await witnesses.insertOne({ orgId }, { session });
            // Dépassement RÉEL de l'échéance du driver (aucun Promise.race) :
            // l'opération suivante de la session est refusée par le driver.
            await new Promise((resolve) => setTimeout(resolve, 400));
            return subscriptions.grantSubscriptionInSession(
              {
                organizationId: orgId,
                term: 'monthly',
                source: SubscriptionSource.PAYMENT,
                sourceReference: `payment:csot-${orgId}`,
                grantedBy: 'payment:e2e',
              },
              session,
            );
          },
          { budgetMs: 150 },
        )
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(SubscriptionGrantError);
      expect((error as SubscriptionGrantError).code).toBe('GRANT_TIMEOUT');
      expect(attempts).toBe(1);
      expect(await witnesses.countDocuments({ orgId })).toBe(0);
      expect(await periodsOf(orgId)).toHaveLength(1);
    });
  });
});
