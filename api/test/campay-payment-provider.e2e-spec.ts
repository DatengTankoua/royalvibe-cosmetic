import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { Connection, Model, Types } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import {
  SubscriptionPeriod,
  SubscriptionPeriodDocument,
} from './../src/subscriptions/schemas/subscription-period.schema';
import { ensureSubscriptionPeriodIndexes } from './../src/subscriptions/subscription-period-indexes';
import {
  SubscriptionPayment,
  SubscriptionPaymentDocument,
} from './../src/subscriptions/payments/schemas/subscription-payment.schema';
import { ensureSubscriptionPaymentIndexes } from './../src/subscriptions/payments/subscription-payment-indexes';
import { PAYMENT_PROVIDER } from './../src/subscriptions/payments/payment-provider';
import { SubscriptionSource } from './../src/subscriptions/subscription-terms';
import { CamPayPaymentProvider } from './../src/subscriptions/payments/campay/campay-payment-provider';
import {
  CamPayHttpRequest,
  CamPayHttpResponse,
  CamPayTransportError,
  fetchCamPayTransport,
} from './../src/subscriptions/payments/campay/campay-transport';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import {
  autoConfirmVerificationEmails,
  createE2eEmailSender,
} from './e2e/email-verification-fixtures';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';

/**
 * E2E 1-14D.2D — adaptateur CamPay RÉEL (classe livrée) branché sur un FAUX
 * transport HTTP, injecté par `overrideProvider` (test uniquement), sur le
 * replica set éphémère. Aucun domaine CamPay contacté ; identifiants et
 * références fictifs. Le fournisseur de production reste
 * `UnavailablePaymentProvider` (voir le spec unitaire de l'adaptateur et
 * `subscription-payments-default-provider.e2e-spec.ts`).
 */

const TEST_JWT_SECRET = 'campay-adapter-14d2d-e2e-only-secret';
const PASSWORD = 'campay-14d2d-pw-!1x';
const CAMPAY_USERNAME = 'fake-campay-app-username';
const CAMPAY_PASSWORD = 'fake-campay-app-password';
const CAMPAY_TOKEN = 'fake.campay.token';
const PHONE_INPUT = '+237 677 12 34 56';
const PHONE = '237677123456';

type Route = (request: CamPayHttpRequest) => Promise<CamPayHttpResponse>;
const routes: { token?: Route; collect?: Route; status?: Route } = {};
const calls: CamPayHttpRequest[] = [];

const json = (status: number, body: unknown): CamPayHttpResponse => ({
  status,
  bodyText: JSON.stringify(body),
});

async function fakeTransport(req: CamPayHttpRequest) {
  calls.push(req);
  const path = new URL(req.url).pathname;
  const route =
    path === '/api/token/'
      ? routes.token
      : path === '/api/collect/'
        ? routes.collect
        : path.startsWith('/api/transaction/')
          ? routes.status
          : undefined;
  if (!route) throw new Error(`route inattendue ${path}`);
  return route(req);
}

const campayRef = () => randomUUID();
// Horloge MONOTONE de l'adaptateur, décalable pour faire expirer son jeton.
let monotonicOffset = 0;
const adapterClock = () => performance.now() + monotonicOffset;
const collectCalls = () => calls.filter((c) => c.url.endsWith('/api/collect/'));
const statusCalls = () =>
  calls.filter((c) => c.url.includes('/api/transaction/'));

describe('Adaptateur CamPay + moteur de confirmation (e2e 1-14D.2D)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let paymentModel: Model<SubscriptionPaymentDocument>;
  let periodModel: Model<SubscriptionPeriodDocument>;
  const emailSender = createE2eEmailSender();
  const consoleSpies: jest.SpyInstance[] = [];
  let seq = 0;

  const server = () => app.getHttpServer();
  const clearThrottle = () =>
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();

  async function registerOwner(label: string) {
    clearThrottle();
    seq += 1;
    const email = `${label}-${seq}-14d2d@campay.test`;
    const reg = await request(server())
      .post('/auth/register')
      .send({
        name: 'Owner',
        email,
        password: PASSWORD,
        organizationName: `Org ${seq}`,
      });
    expect(reg.status).toBe(201);
    clearThrottle();
    const login = await request(server())
      .post('/auth/login')
      .send({ email, password: PASSWORD });
    expect(login.status).toBe(201);
    return {
      orgId: String(reg.body.organization._id),
      token: String(login.body.access_token),
    };
  }

  const pay = (token: string, clientOperationId = randomUUID()) => {
    clearThrottle();
    return request(server())
      .post('/organizations/current/subscription/payments')
      .set('Authorization', `Bearer ${token}`)
      .send({ term: 'monthly', payerPhone: PHONE_INPUT, clientOperationId });
  };

  const refresh = (token: string, paymentId: unknown) => {
    clearThrottle();
    return request(server())
      .post(
        `/organizations/current/subscription/payments/${String(paymentId)}/refresh`,
      )
      .set('Authorization', `Bearer ${token}`);
  };

  const paymentsOf = (orgId: string) =>
    paymentModel
      .find({ organizationId: new Types.ObjectId(orgId) })
      .lean()
      .exec();
  const periodsOf = (orgId: string) =>
    periodModel
      .find({ organizationId: new Types.ObjectId(orgId) })
      .lean()
      .exec();

  /** Réponses publiques : jamais de secret, jeton, téléphone ni corps CamPay. */
  const expectNoLeak = (body: unknown) => {
    const text = JSON.stringify(body);
    for (const secret of [
      CAMPAY_USERNAME,
      CAMPAY_PASSWORD,
      CAMPAY_TOKEN,
      PHONE,
      'ussd_code',
      'operator',
    ]) {
      expect(text).not.toContain(secret);
    }
  };

  /** Statut CamPay (forme officielle) pour une collecte donnée. */
  const statusBody = (
    reference: string,
    merchantReference: string,
    overrides: Record<string, unknown> = {},
  ) => ({
    reference,
    external_reference: merchantReference,
    status: 'PENDING',
    amount: 3000.0,
    currency: 'XAF',
    operator: 'MTN',
    code: 'CP2610020001',
    operator_reference: null,
    description: 'Abonnement Stock Master (1 mois)',
    external_user: '',
    reason: null,
    phone_number: PHONE,
    endpoint: 'collect',
    ...overrides,
  });

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      process.env.MONGODB_URI = validatedEphemeralUri(replSet);
      process.env.JWT_SECRET = TEST_JWT_SECRET;
      process.env.CORS_ORIGIN = 'https://campay-adapter-e2e.example.com';
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';

      moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EMAIL_SENDER)
        .useValue(emailSender)
        .overrideProvider(PAYMENT_PROVIDER)
        .useValue(
          new CamPayPaymentProvider({
            environment: 'demo',
            username: CAMPAY_USERNAME,
            password: CAMPAY_PASSWORD,
            transport: fakeTransport,
            monotonic: adapterClock,
          }),
        )
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
      const connection = moduleFixture.get<Connection>(getConnectionToken());
      await ensureSubscriptionPeriodIndexes(connection);
      await ensureSubscriptionPaymentIndexes(connection);
      paymentModel = moduleFixture.get(getModelToken(SubscriptionPayment.name));
      periodModel = moduleFixture.get(getModelToken(SubscriptionPeriod.name));
    } catch (error) {
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  beforeEach(() => {
    calls.length = 0;
    routes.token = () =>
      Promise.resolve(json(200, { token: CAMPAY_TOKEN, expires_in: 3600 }));
    routes.collect = () =>
      Promise.resolve(json(200, { reference: campayRef() }));
    routes.status = undefined;
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      consoleSpies.push(jest.spyOn(console, method).mockImplementation());
    }
  });

  afterEach(() => {
    // Ni l'adaptateur ni le moteur ne journalisent de donnée de paiement.
    for (const spy of consoleSpies) {
      for (const args of spy.mock.calls) {
        const text = JSON.stringify(args);
        for (const secret of [CAMPAY_PASSWORD, CAMPAY_TOKEN, PHONE]) {
          expect(text).not.toContain(secret);
        }
      }
    }
    consoleSpies.splice(0).forEach((spy) => spy.mockRestore());
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  it('initiation : payload exact, référence marchand PERSISTÉE transmise, `pending` sans attribution', async () => {
    const { orgId, token } = await registerOwner('initiate');
    const reference = campayRef();
    routes.collect = () =>
      Promise.resolve(
        json(200, {
          reference: reference.toUpperCase(),
          ussd_code: '*126#',
          operator: 'mtn',
        }),
      );
    const res = await pay(token);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expectNoLeak(res.body);
    const [payment] = await paymentsOf(orgId);
    const [collect] = collectCalls();
    expect(JSON.parse(collect.body!)).toEqual({
      amount: '3000',
      currency: 'XAF',
      from: PHONE,
      description: 'Abonnement Stock Master (1 mois)',
      external_reference: payment.merchantReference,
    });
    expect(collect.headers.Authorization).toBe(`Token ${CAMPAY_TOKEN}`);
    expect(collect.url).toBe('https://demo.campay.net/api/collect/');
    expect(payment).toMatchObject({
      provider: 'campay',
      status: 'pending',
      open: true,
      providerReference: reference.toLowerCase(),
      periodId: null,
    });
    // Collecte acceptée ≠ paiement réussi : aucune période, aucune consultation.
    expect(await periodsOf(orgId)).toHaveLength(1);
    expect(statusCalls()).toHaveLength(0);
  });

  it('réponse perdue après collecte : incertain, même référence, aucune seconde collecte ni fausse récupération', async () => {
    const { orgId, token } = await registerOwner('lost');
    routes.collect = () => Promise.reject(new CamPayTransportError('unknown'));
    const clientOperationId = randomUUID();
    const res = await pay(token, clientOperationId);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('uncertain');
    const [payment] = await paymentsOf(orgId);
    expect(JSON.parse(collectCalls()[0].body!).external_reference).toBe(
      payment.merchantReference,
    );

    const replay = await pay(token, clientOperationId);
    expect(replay.body).toMatchObject({
      paymentId: res.body.paymentId,
      reference: payment.merchantReference,
      replayed: true,
    });
    expect((await pay(token)).body.code).toBe('PAYMENT_ALREADY_PENDING');
    // Recherche par référence marchand NON supportée : aucun appel CamPay.
    const checked = await refresh(token, res.body.paymentId);
    expect(checked.status).toBe(200);
    expect(checked.body.status).toBe('uncertain');
    expect(collectCalls()).toHaveLength(1);
    expect(statusCalls()).toHaveLength(0);
    expect(await paymentsOf(orgId)).toHaveLength(1);
  });

  it('échec AVANT envoi (authentification) : 503, collecte jamais envoyée, paiement fermé sans collecte possible', async () => {
    const { orgId, token } = await registerOwner('not-sent');
    // Jeton en mémoire EXPIRÉ (4 h) : une nouvelle authentification est
    // requise, et elle échoue.
    monotonicOffset += 4 * 60 * 60 * 1000;
    routes.token = () =>
      Promise.resolve(json(500, { detail: CAMPAY_PASSWORD }));
    const res = await pay(token);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PAYMENT_SERVICE_UNAVAILABLE');
    expectNoLeak(res.body);
    expect(collectCalls()).toHaveLength(0);
    const [payment] = await paymentsOf(orgId);
    expect(payment).toMatchObject({
      status: 'failed',
      open: false,
      incidentCode: 'provider_unavailable',
    });
  });

  it('erreur APRÈS envoi (500 de la collecte) : incertain, jamais un refus définitif', async () => {
    const { token } = await registerOwner('after-send');
    routes.collect = () =>
      Promise.resolve(json(400, { message: 'ER102 unsupported carrier' }));
    const res = await pay(token);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('uncertain');
    expect(collectCalls()).toHaveLength(1);
  });

  it('succès VÉRIFIÉ : attribution atomique `payment`, rejeu sans seconde période ni appel', async () => {
    const { orgId, token } = await registerOwner('success');
    const reference = campayRef();
    routes.collect = () => Promise.resolve(json(200, { reference }));
    const created = await pay(token);
    const [payment] = await paymentsOf(orgId);

    routes.status = () =>
      Promise.resolve(
        json(200, statusBody(reference, payment.merchantReference)),
      );
    const pending = await refresh(token, created.body.paymentId);
    expect(pending.body.status).toBe('pending');
    expect(statusCalls()[0].url).toBe(
      `https://demo.campay.net/api/transaction/${reference}/`,
    );

    routes.status = () =>
      Promise.resolve(
        json(
          200,
          statusBody(reference, payment.merchantReference, {
            status: 'SUCCESSFUL',
            operator_reference: 'MP261002.0001',
          }),
        ),
      );
    const done = await refresh(token, created.body.paymentId);
    expect(done.body.status).toBe('succeeded');
    expectNoLeak(done.body);
    const periods = await periodsOf(orgId);
    expect(
      periods.filter((p) => p.source === SubscriptionSource.PAYMENT),
    ).toHaveLength(1);
    expect(periods[periods.length - 1]).toMatchObject({
      sourceReference: `payment:${created.body.paymentId}`,
      grantedBy: 'payment:campay',
      term: 'monthly',
    });

    const before = statusCalls().length;
    const again = await refresh(token, created.body.paymentId);
    expect(again.body.status).toBe('succeeded');
    expect(statusCalls()).toHaveLength(before);
    expect(await periodsOf(orgId)).toHaveLength(periods.length);
  });

  it('refus confirmé (FAILED) : aucune attribution', async () => {
    const { orgId, token } = await registerOwner('failed');
    const reference = campayRef();
    routes.collect = () => Promise.resolve(json(200, { reference }));
    const created = await pay(token);
    const [payment] = await paymentsOf(orgId);
    routes.status = () =>
      Promise.resolve(
        json(
          200,
          statusBody(reference, payment.merchantReference, {
            status: 'FAILED',
            reason: 'declined',
          }),
        ),
      );
    expect((await refresh(token, created.body.paymentId)).body.status).toBe(
      'failed',
    );
    expect(await periodsOf(orgId)).toHaveLength(1);
  });

  it.each([
    ['montant différent', { amount: 2999 }],
    ['montant décimal', { amount: 3000.5 }],
    ['montant absent', { amount: undefined }],
    ['devise', { currency: 'XOF' }],
    ['référence marchand absente', { external_reference: '' }],
    ['référence marchand différente', { external_reference: 'SMOTHER' }],
  ])(
    'discordance (%s) → review, aucune attribution',
    async (_label, override) => {
      const { orgId, token } = await registerOwner('mismatch');
      const reference = campayRef();
      routes.collect = () => Promise.resolve(json(200, { reference }));
      const created = await pay(token);
      const [payment] = await paymentsOf(orgId);
      routes.status = () =>
        Promise.resolve(
          json(
            200,
            statusBody(reference, payment.merchantReference, {
              status: 'SUCCESSFUL',
              ...override,
            }),
          ),
        );
      const res = await refresh(token, created.body.paymentId);
      expect(res.body.status).toBe('review');
      expect(await periodsOf(orgId)).toHaveLength(1);
    },
  );

  it('référence CamPay discordante → review', async () => {
    const { orgId, token } = await registerOwner('ref-mismatch');
    const reference = campayRef();
    routes.collect = () => Promise.resolve(json(200, { reference }));
    const created = await pay(token);
    const [payment] = await paymentsOf(orgId);
    // Réponse portant une AUTRE référence CamPay que celle demandée.
    routes.status = () =>
      Promise.resolve(
        json(
          200,
          statusBody(campayRef(), payment.merchantReference, {
            status: 'SUCCESSFUL',
          }),
        ),
      );
    expect((await refresh(token, created.body.paymentId)).body.status).toBe(
      'review',
    );
    expect(await periodsOf(orgId)).toHaveLength(1);
  });

  it.each([
    [
      'statut inconnu',
      () => Promise.resolve(json(200, { status: 'REVERSED' })),
    ],
    ['HTTP 500', () => Promise.resolve(json(500, { detail: CAMPAY_TOKEN }))],
    ['transport', () => Promise.reject(new CamPayTransportError('unknown'))],
  ])(
    '%s → 503 PAYMENT_STATUS_UNAVAILABLE, état conservé',
    async (_label, route) => {
      const { orgId, token } = await registerOwner('status-down');
      const created = await pay(token);
      const before = (await paymentsOf(orgId))[0];
      routes.status = route;
      const res = await refresh(token, created.body.paymentId);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('PAYMENT_STATUS_UNAVAILABLE');
      expectNoLeak(res.body);
      const after = (await paymentsOf(orgId))[0];
      expect(after.status).toBe(before.status);
      expect(after.providerReference).toBe(before.providerReference);
      expect(await periodsOf(orgId)).toHaveLength(1);
    },
  );

  // ─── Montants bruts : transport `fetch` RÉEL + serveur HTTP LOCAL ────────

  describe('montants JSON bruts (précision) — transport réel, serveur local', () => {
    let local: Server;
    let localBase = '';
    let rawBody = '';

    beforeAll(async () => {
      local = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(rawBody);
      });
      await new Promise<void>((resolve) =>
        local.listen(0, '127.0.0.1', resolve),
      );
      localBase = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      local.closeAllConnections();
      await new Promise((resolve) => local.close(resolve));
    });

    it.each([
      ['3000.0000000000000001', 'review', 0],
      ['2999.9999999999999999', 'review', 0],
      ['3000.0', 'succeeded', 1],
    ])(
      'corps brut `"amount":%s` → %s (%i période `payment`)',
      async (literal, expectedStatus, expectedPeriods) => {
        const { orgId, token } = await registerOwner('raw-amount');
        const reference = campayRef();
        routes.collect = () => Promise.resolve(json(200, { reference }));
        const created = await pay(token);
        const [payment] = await paymentsOf(orgId);
        // Corps BRUT : le littéral est écrit tel quel (jamais JSON.stringify).
        rawBody =
          `{"reference":"${reference}","external_reference":"${payment.merchantReference}",` +
          `"status":"SUCCESSFUL","amount":${literal},"currency":"XAF",` +
          `"operator":"MTN","code":"CP2610020002","endpoint":"collect"}`;
        routes.status = (req) =>
          fetchCamPayTransport({
            ...req,
            url: req.url.replace('https://demo.campay.net', localBase),
          });
        const res = await refresh(token, created.body.paymentId);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe(expectedStatus);
        const periods = await periodsOf(orgId);
        expect(
          periods.filter((p) => p.source === SubscriptionSource.PAYMENT),
        ).toHaveLength(expectedPeriods);
        const after = (await paymentsOf(orgId))[0];
        expect(after.periodId === null).toBe(expectedPeriods === 0);
        // Rien de la réponse brute n'est stocké.
        expect(JSON.stringify(after)).not.toContain(literal);
      },
    );
  });
});
