import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { Connection, Model, Types } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { API_APPLICATION_OPTIONS } from './../src/common/application-options';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PAYMENT_WEBHOOK_LIMIT } from './../src/common/subscription-payment-rate-limiting';
import {
  SubscriptionPeriod,
  SubscriptionPeriodDocument,
} from './../src/subscriptions/schemas/subscription-period.schema';
import { ensureSubscriptionPeriodIndexes } from './../src/subscriptions/subscription-period-indexes';
import { SUBSCRIPTION_MONOTONIC_CLOCK } from './../src/subscriptions/subscription-clock';
import {
  SubscriptionGrantError,
  SubscriptionsService,
} from './../src/subscriptions/subscriptions.service';
import {
  SubscriptionPayment,
  SubscriptionPaymentDocument,
} from './../src/subscriptions/payments/schemas/subscription-payment.schema';
import { ensureSubscriptionPaymentIndexes } from './../src/subscriptions/payments/subscription-payment-indexes';
import { PAYMENT_PROVIDER } from './../src/subscriptions/payments/payment-provider';
import { PAYMENT_CONFIRMATION_BUDGET_MS } from './../src/subscriptions/payments/subscription-payments.service';
import { CamPayPaymentProvider } from './../src/subscriptions/payments/campay/campay-payment-provider';
import {
  CamPayHttpRequest,
  CamPayHttpResponse,
  CamPayTransportError,
} from './../src/subscriptions/payments/campay/campay-transport';
import { CAMPAY_WEBHOOK_CONFIG } from './../src/subscriptions/payments/campay/campay-webhook.config';
import { SubscriptionSource } from './../src/subscriptions/subscription-terms';
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
import { OWNER_TERMS } from './e2e/legal-acceptance-fixtures';
import { postRegister } from './e2e/registration-fixtures';

/**
 * E2E 1-14D.2F — webhook CamPay ACTIVÉ PAR INJECTION (test uniquement :
 * `overrideProvider(CAMPAY_WEBHOOK_CONFIG)`), adaptateur CamPay RÉEL sur un
 * FAUX transport à barrières, replica set éphémère, options de bootstrap de
 * `main.ts`. Aucun domaine CamPay contacté ; clés, jetons et références
 * FICTIFS. La configuration de production (webhook désactivé, fournisseur
 * indisponible) est vérifiée dans
 * `subscription-payments-default-provider.e2e-spec.ts`.
 *
 * Contrat CamPay exercé : notification GET (query) ou POST (JSON), champ
 * `signature` = JWT HS256 signé avec la clé webhook. Tout le reste
 * (réponses, temporisation, bornes) relève de choix internes.
 */

const TEST_JWT_SECRET = 'campay-webhook-14d2f-e2e-login-secret';
const WEBHOOK_KEY = 'fake-campay-webhook-key-14d2f-e2e';
const PASSWORD = 'campay-14d2f-pw-!1x';
const CAMPAY_TOKEN = 'fake.campay.token.14d2f';
const PHONE_INPUT = '+237 677 12 34 56';
const PHONE = '237677123456';
const WEBHOOK = '/payments/webhooks/campay';

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
const statusCalls = () =>
  calls.filter((c) => c.url.includes('/api/transaction/'));
const collectCalls = () => calls.filter((c) => c.url.endsWith('/api/collect/'));

/** Barrière déterministe : `arrived` compte les appels en attente. */
function barrier() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  const state = { arrived: 0 };
  return {
    state,
    wait: async () => {
      state.arrived += 1;
      await opened;
    },
    release: () => release(),
    /** Attend `count` arrivées (borné à 15 s ; libère la barrière sinon). */
    until: async (count: number) => {
      const deadline = Date.now() + 15_000;
      while (state.arrived < count) {
        if (Date.now() > deadline) {
          release();
          throw new Error('barrière jamais atteinte');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}

// Horloges monotones décalables : adaptateur (jeton, budget HTTP) et moteur
// de confirmation (budget de 30 s).
let adapterOffset = 0;
const adapterClock = () => performance.now() + adapterOffset;
let engineOffset = 0;
const engineClock = () => performance.now() + engineOffset;

const CAMPAY_EXAMPLE_HEADER: Record<string, unknown> = { app: 'Test' };

/** Implémentation INDÉPENDANTE (jsonwebtoken) pour signer les notifications. */
const signer = new JwtService();
const signNotification = (
  claims: Record<string, unknown> = {},
  key = WEBHOOK_KEY,
  algorithm: 'HS256' | 'HS384' = 'HS256',
) => {
  const now = Math.floor(Date.now() / 1000);
  return signer.sign(
    { iat: now, nbf: now, exp: now + 3600, ...claims },
    {
      secret: key,
      algorithm,
      // En-tête des exemples officiels (`app`), hors du type `JwtHeader`.
      header: { alg: algorithm, typ: 'JWT', ...CAMPAY_EXAMPLE_HEADER },
    },
  );
};

describe('Webhook CamPay (e2e 1-14D.2F)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let paymentModel: Model<SubscriptionPaymentDocument>;
  let periodModel: Model<SubscriptionPeriodDocument>;
  let subscriptions: SubscriptionsService;
  const emailSender = createE2eEmailSender();
  const consoleSpies: jest.SpyInstance[] = [];
  const signaturesSent: string[] = [];
  let seq = 0;

  const server = () => app.getHttpServer();
  const clearThrottle = () =>
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();

  async function registerOwner(label: string) {
    clearThrottle();
    seq += 1;
    const email = `${label}-${seq}-14d2f@campay.test`;
    const reg = await postRegister(app, {
      ...OWNER_TERMS,
      name: 'Owner',
      email,
      password: PASSWORD,
      organizationName: `Org ${seq}`,
    });
    expect(reg.status).toBe(202);
    clearThrottle();
    const login = await request(server())
      .post('/auth/login')
      .send({ email, password: PASSWORD });
    expect(login.status).toBe(201);
    return {
      orgId: String(reg.owner!.organization._id),
      token: String(login.body.access_token),
    };
  }

  const pay = (token: string) => {
    clearThrottle();
    return request(server())
      .post('/organizations/current/subscription/payments')
      .set('Authorization', `Bearer ${token}`)
      .send({
        term: 'monthly',
        payerPhone: PHONE_INPUT,
        clientOperationId: randomUUID(),
      });
  };

  const refresh = (token: string, paymentId: string) => {
    clearThrottle();
    return request(server())
      .post(`/organizations/current/subscription/payments/${paymentId}/refresh`)
      .set('Authorization', `Bearer ${token}`);
  };

  /** Paiement `pending` : collecte acceptée avec la référence CamPay `ref`. */
  async function pendingPayment(label: string) {
    const owner = await registerOwner(label);
    const reference = randomUUID();
    routes.collect = () => Promise.resolve(json(200, { reference }));
    const res = await pay(owner.token);
    expect(res.body.status).toBe('pending');
    const payment = await paymentModel
      .findById(new Types.ObjectId(String(res.body.paymentId)))
      .lean()
      .exec();
    return {
      ...owner,
      paymentId: String(res.body.paymentId),
      reference,
      merchantReference: payment!.merchantReference,
    };
  }

  const paymentDoc = (paymentId: string) =>
    paymentModel.findById(new Types.ObjectId(paymentId)).lean().exec();
  const paymentPeriods = (paymentId: string) =>
    periodModel
      .find({
        source: SubscriptionSource.PAYMENT,
        sourceReference: `payment:${paymentId}`,
      })
      .lean()
      .exec();

  /** Statut CamPay officiel (lu par l'adaptateur, SEULE source de vérité). */
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
    code: 'CP2610030001',
    operator_reference: null,
    description: 'Abonnement Stock Master (1 mois)',
    external_user: '',
    reason: null,
    phone_number: PHONE,
    endpoint: 'collect',
    ...overrides,
  });
  const campayStatus = (body: Record<string, unknown>) => {
    routes.status = () => Promise.resolve(json(200, body));
  };

  /** Paramètres de notification (forme officielle). */
  const notification = (
    reference: string,
    merchantReference: string | null,
    overrides: Record<string, unknown> = {},
  ) => {
    const params: Record<string, unknown> = {
      status: 'SUCCESSFUL',
      reference,
      amount: '3000',
      currency: 'XAF',
      operator: 'MTN',
      code: 'CP2610030001',
      operator_reference: '1234567890',
      signature: signNotification(),
      endpoint: 'collect',
      external_user: '',
      phone_number: PHONE,
      description: 'Abonnement Stock Master (1 mois)',
      reason: '',
      ...(merchantReference ? { external_reference: merchantReference } : {}),
      ...overrides,
    };
    if (typeof params.signature === 'string') {
      signaturesSent.push(params.signature);
    }
    return params;
  };

  const webhookGet = (params: Record<string, unknown>) =>
    request(server())
      .get(WEBHOOK)
      .query(params as Record<string, string>);
  const webhookPost = (params: Record<string, unknown> | string) =>
    request(server())
      .post(WEBHOOK)
      .set('Content-Type', 'application/json')
      .send(typeof params === 'string' ? params : JSON.stringify(params));

  /** Aucune réponse ne reprend la query, la signature ou le téléphone. */
  const expectOpaque = (res: request.Response) => {
    const text = JSON.stringify(res.body);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain('eyJ');
    expect(text).not.toContain('?');
    expect(text).not.toContain(WEBHOOK_KEY);
  };

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      process.env.MONGODB_URI = validatedEphemeralUri(replSet);
      process.env.JWT_SECRET = TEST_JWT_SECRET;
      process.env.CORS_ORIGIN = 'https://campay-webhook-e2e.example.com';
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';

      moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EMAIL_SENDER)
        .useValue(emailSender)
        .overrideProvider(SUBSCRIPTION_MONOTONIC_CLOCK)
        .useValue(engineClock)
        .overrideProvider(PAYMENT_PROVIDER)
        .useValue(
          new CamPayPaymentProvider({
            environment: 'demo',
            username: 'fake-campay-app-username',
            password: 'fake-campay-app-password',
            transport: fakeTransport,
            monotonic: adapterClock,
          }),
        )
        // ACTIVATION PAR INJECTION (test uniquement).
        .overrideProvider(CAMPAY_WEBHOOK_CONFIG)
        .useValue({ enabled: true, webhookKey: WEBHOOK_KEY })
        .compile();
      app = moduleFixture.createNestApplication(API_APPLICATION_OPTIONS);
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
      subscriptions = moduleFixture.get(SubscriptionsService);
    } catch (error) {
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  beforeEach(() => {
    calls.length = 0;
    clearThrottle();
    routes.token = () =>
      Promise.resolve(json(200, { token: CAMPAY_TOKEN, expires_in: 3600 }));
    routes.collect = () =>
      Promise.resolve(json(200, { reference: randomUUID() }));
    routes.status = undefined;
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      consoleSpies.push(jest.spyOn(console, method).mockImplementation());
    }
  });

  afterEach(() => {
    // Aucune journalisation de secret, signature, téléphone ou jeton.
    for (const spy of consoleSpies) {
      for (const args of spy.mock.calls) {
        const text = JSON.stringify(args);
        for (const secret of [
          WEBHOOK_KEY,
          CAMPAY_TOKEN,
          PHONE,
          ...signaturesSent,
        ]) {
          expect(text).not.toContain(secret);
        }
      }
    }
    consoleSpies.splice(0);
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  // ─── Authentification et validation ────────────────────────────────────────

  describe('Authentification (contrat CamPay : JWT HS256, clé webhook)', () => {
    it('signature absente, falsifiée, mauvais algorithme, mauvaise clé → refus, sans base ni prestataire', async () => {
      const p = await pendingPayment('auth');
      campayStatus(
        statusBody(p.reference, p.merchantReference, { status: 'SUCCESSFUL' }),
      );
      const before = await paymentDoc(p.paymentId);
      const valid = signNotification();
      const [h, payload, s] = valid.split('.');
      const tampered = `${h}.${Buffer.from(
        JSON.stringify({ iat: 1, nbf: 1, exp: 9_999_999_999 }),
      ).toString('base64url')}.${s}`;
      const cases: [Record<string, unknown>, number, string][] = [
        [{ signature: undefined }, 400, 'PAYMENT_WEBHOOK_INVALID'],
        [{ signature: '' }, 400, 'PAYMENT_WEBHOOK_INVALID'],
        [{ signature: tampered }, 401, 'PAYMENT_WEBHOOK_UNAUTHORIZED'],
        [
          { signature: `${h}.${payload}.${s.slice(0, -4)}AAAA` },
          401,
          'PAYMENT_WEBHOOK_UNAUTHORIZED',
        ],
        [
          { signature: signNotification({}, 'another-fake-webhook-key-000') },
          401,
          'PAYMENT_WEBHOOK_UNAUTHORIZED',
        ],
        [
          { signature: signNotification({}, WEBHOOK_KEY, 'HS384') },
          401,
          'PAYMENT_WEBHOOK_UNAUTHORIZED',
        ],
        [
          {
            signature: signNotification({
              exp: Math.floor(Date.now() / 1000) - 3600,
            }),
          },
          401,
          'PAYMENT_WEBHOOK_UNAUTHORIZED',
        ],
      ];
      for (const [overrides, status, code] of cases) {
        const params = notification(
          p.reference,
          p.merchantReference,
          overrides,
        );
        if (overrides.signature === undefined) delete params.signature;
        for (const res of [
          await webhookGet(params),
          await webhookPost(params),
        ]) {
          expect(res.status).toBe(status);
          expect(res.body.code).toBe(code);
          expectOpaque(res);
        }
      }
      expect(statusCalls()).toHaveLength(0);
      expect(await paymentDoc(p.paymentId)).toEqual(before);
      expect(await paymentPeriods(p.paymentId)).toHaveLength(0);
    });

    it('un JWT de CONNEXION valide est inutilisable comme signature webhook', async () => {
      const p = await pendingPayment('login-jwt');
      campayStatus(
        statusBody(p.reference, p.merchantReference, { status: 'SUCCESSFUL' }),
      );
      const res = await webhookGet(
        notification(p.reference, p.merchantReference, { signature: p.token }),
      );
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('PAYMENT_WEBHOOK_UNAUTHORIZED');
      expect(statusCalls()).toHaveLength(0);
      expect((await paymentDoc(p.paymentId))!.status).toBe('pending');
    });

    it('claims signés discordants avec les paramètres reçus → refus ; champs non signés documentés comme non protégés', async () => {
      const p = await pendingPayment('claims');
      campayStatus(
        statusBody(p.reference, p.merchantReference, { status: 'SUCCESSFUL' }),
      );
      const other = randomUUID();
      const res = await webhookGet(
        notification(p.reference, p.merchantReference, {
          signature: signNotification({ reference: other }),
        }),
      );
      expect(res.status).toBe(401);
      const status = await webhookGet(
        notification(p.reference, p.merchantReference, {
          signature: signNotification({
            reference: p.reference.toUpperCase(),
            status: 'FAILED',
          }),
          status: 'SUCCESSFUL',
        }),
      );
      expect(status.status).toBe(401);
      expect(statusCalls()).toHaveLength(0);
      // Claims concordants : accepté (le statut reste relu chez CamPay).
      const ok = await webhookGet(
        notification(p.reference, p.merchantReference, {
          signature: signNotification({
            reference: p.reference,
            status: 'SUCCESSFUL',
          }),
        }),
      );
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ received: true });
      expect(statusCalls()).toHaveLength(1);
    });
  });

  describe('Validation des paramètres (choix internes)', () => {
    it('paramètres ambigus, dupliqués, mal typés ou surdimensionnés → 400 / 413, sans base ni prestataire', async () => {
      const p = await pendingPayment('params');
      const params = notification(p.reference, p.merchantReference);
      const query = new URLSearchParams(params as Record<string, string>);
      query.append('reference', randomUUID());
      const duplicateQuery = await request(server()).get(
        `${WEBHOOK}?${query.toString()}`,
      );
      expect(duplicateQuery.status).toBe(400);
      expectOpaque(duplicateQuery);

      const raw = JSON.stringify(params).replace(
        '"status":',
        `"reference":"${randomUUID()}","status":`,
      );
      expect((await webhookPost(raw)).status).toBe(400);
      expect((await webhookPost({ ...params, reference: 42 })).status).toBe(
        400,
      );
      expect(
        (await webhookPost({ ...params, status: { $ne: 'x' } })).status,
      ).toBe(400);
      expect(
        (await webhookGet({ ...params, reference: 'not-a-uuid' })).status,
      ).toBe(400);
      expect(
        (
          await request(server())
            .post(`${WEBHOOK}?reference=${p.reference}`)
            .set('Content-Type', 'application/json')
            .send(JSON.stringify(params))
        ).status,
      ).toBe(400);
      expect(
        (
          await request(server())
            .post(WEBHOOK)
            .set('Content-Type', 'application/x-www-form-urlencoded')
            .send(
              new URLSearchParams(params as Record<string, string>).toString(),
            )
        ).status,
      ).toBe(400);
      const large = await webhookPost({
        ...params,
        description: 'x'.repeat(9000),
      });
      expect(large.status).toBe(413);
      expect(large.body.code).toBe('PAYMENT_WEBHOOK_TOO_LARGE');
      const longUrl = await webhookGet({
        ...params,
        description: 'x'.repeat(500),
        extra_a: 'y'.repeat(500),
        extra_b: 'y'.repeat(500),
        extra_c: 'y'.repeat(500),
        extra_d: 'y'.repeat(500),
        extra_e: 'y'.repeat(500),
        extra_f: 'y'.repeat(500),
        extra_g: 'y'.repeat(500),
        extra_h: 'y'.repeat(500),
        extra_i: 'y'.repeat(500),
        extra_j: 'y'.repeat(500),
        extra_k: 'y'.repeat(500),
        extra_l: 'y'.repeat(500),
        extra_m: 'y'.repeat(500),
        extra_n: 'y'.repeat(500),
        extra_o: 'y'.repeat(500),
        extra_p: 'y'.repeat(500),
      });
      expect(longUrl.status).toBe(413);
      expect(statusCalls()).toHaveLength(0);
      expect((await paymentDoc(p.paymentId))!.status).toBe('pending');
    });
  });

  // ─── Traitement : la notification n'est qu'un déclencheur ──────────────────

  describe('Traitement (moteur unique 1-14D.2B, statut relu chez CamPay)', () => {
    it('succès VÉRIFIÉ (GET puis POST rejoué) : une seule période, rejeu sans appel ni seconde attribution', async () => {
      const p = await pendingPayment('success');
      campayStatus(
        statusBody(p.reference, p.merchantReference, { status: 'SUCCESSFUL' }),
      );
      const res = await webhookGet(
        notification(p.reference.toUpperCase(), p.merchantReference),
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
      expectOpaque(res);
      expect(statusCalls()).toHaveLength(1);
      expect(statusCalls()[0].url).toBe(
        `https://demo.campay.net/api/transaction/${p.reference}/`,
      );
      expect(await paymentDoc(p.paymentId)).toMatchObject({
        status: 'succeeded',
        open: false,
        providerReference: p.reference,
      });
      const periods = await paymentPeriods(p.paymentId);
      expect(periods).toHaveLength(1);
      expect(periods[0]).toMatchObject({ grantedBy: 'payment:campay' });

      for (const res2 of [
        await webhookPost(notification(p.reference, p.merchantReference)),
        await webhookGet(notification(p.reference, p.merchantReference)),
      ]) {
        expect(res2.status).toBe(200);
      }
      expect(statusCalls()).toHaveLength(1);
      expect(await paymentPeriods(p.paymentId)).toHaveLength(1);
    });

    it('callback annonçant SUCCESSFUL alors que CamPay reste PENDING : aucune période ; FAILED annoncé : jamais `failed`', async () => {
      const p = await pendingPayment('announced');
      campayStatus(
        statusBody(p.reference, p.merchantReference, { status: 'PENDING' }),
      );
      for (const status of ['SUCCESSFUL', 'FAILED']) {
        const res = await webhookPost(
          notification(p.reference, p.merchantReference, {
            status,
            amount: 3000,
          }),
        );
        expect(res.status).toBe(200);
      }
      expect(statusCalls()).toHaveLength(2);
      expect(await paymentDoc(p.paymentId)).toMatchObject({
        status: 'pending',
        open: true,
        periodId: null,
      });
      expect(await paymentPeriods(p.paymentId)).toHaveLength(0);
    });

    it.each([
      ['montant', { amount: 2999 }],
      ['montant décimal', { amount: 3000.5 }],
      ['devise', { currency: 'EUR' }],
      ['référence marchand', { external_reference: 'SM' + 'f'.repeat(24) }],
    ])(
      'discordance RÉELLE (%s) chez CamPay → `review`, aucune attribution',
      async (_label, overrides) => {
        const p = await pendingPayment('mismatch');
        campayStatus(
          statusBody(p.reference, p.merchantReference, {
            status: 'SUCCESSFUL',
            ...overrides,
          }),
        );
        // Le callback annonce, lui, des valeurs « parfaites » : sans effet.
        const res = await webhookGet(
          notification(p.reference, p.merchantReference),
        );
        expect(res.status).toBe(200);
        expect(await paymentDoc(p.paymentId)).toMatchObject({
          status: 'review',
          periodId: null,
        });
        expect(await paymentPeriods(p.paymentId)).toHaveLength(0);
      },
    );

    it('référence CamPay discordante chez CamPay → `review`', async () => {
      const p = await pendingPayment('mismatch-ref');
      campayStatus(
        statusBody(randomUUID(), p.merchantReference, { status: 'SUCCESSFUL' }),
      );
      expect(
        (await webhookGet(notification(p.reference, p.merchantReference)))
          .status,
      ).toBe(200);
      expect((await paymentDoc(p.paymentId))!.status).toBe('review');
      expect(await paymentPeriods(p.paymentId)).toHaveLength(0);
    });

    it('callback inconnu : accusé, aucune création de paiement, collecte, référence ni consultation', async () => {
      const { orgId } = await registerOwner('unknown');
      const count = await paymentModel.countDocuments();
      for (const res of [
        await webhookGet(notification(randomUUID(), null)),
        await webhookPost(notification(randomUUID(), 'SM' + '0'.repeat(24))),
      ]) {
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ received: true });
      }
      expect(await paymentModel.countDocuments()).toBe(count);
      expect(
        await paymentModel.countDocuments({
          organizationId: new Types.ObjectId(orgId),
        }),
      ).toBe(0);
      expect(calls).toHaveLength(0);
    });

    it('`endpoint` autre que `collect` (retrait) : accusé, aucune consultation', async () => {
      const p = await pendingPayment('withdraw');
      campayStatus(
        statusBody(p.reference, p.merchantReference, { status: 'SUCCESSFUL' }),
      );
      const res = await webhookGet(
        notification(p.reference, p.merchantReference, {
          endpoint: 'withdraw',
        }),
      );
      expect(res.status).toBe(200);
      expect(statusCalls()).toHaveLength(0);
      expect((await paymentDoc(p.paymentId))!.status).toBe('pending');
    });

    it('callback PRÉCOCE (avant l’enregistrement de la référence) : 503 temporaire sans écriture ; puis traitement normal', async () => {
      const owner = await registerOwner('early');
      const reference = randomUUID();
      const collect = barrier();
      routes.collect = async () => {
        await collect.wait();
        return json(200, { reference });
      };
      const paying = pay(owner.token).then((r) => r);
      // Barrière TOUJOURS libérée (sinon la requête resterait suspendue).
      let initiating!: SubscriptionPayment & { _id: Types.ObjectId };
      try {
        await collect.until(1);
        [initiating] = await paymentModel
          .find({ organizationId: new Types.ObjectId(owner.orgId) })
          .lean<(SubscriptionPayment & { _id: Types.ObjectId })[]>()
          .exec();
        expect(initiating).toMatchObject({
          status: 'initiating',
          providerReference: null,
        });
        const before = await paymentDoc(String(initiating._id));

        const early = await webhookGet(
          notification(reference, initiating.merchantReference),
        );
        expect(early.status).toBe(503);
        expect(early.body.code).toBe('PAYMENT_WEBHOOK_RETRY_LATER');
        expect(early.headers['retry-after']).toBe('60');
        expectOpaque(early);
        // Sans indice marchand : impossible de distinguer d'un inconnu → accusé.
        expect((await webhookGet(notification(reference, null))).status).toBe(
          200,
        );
        expect(statusCalls()).toHaveLength(0);
        expect(await paymentDoc(String(initiating._id))).toEqual(before);
      } finally {
        collect.release();
      }
      expect((await paying).body.status).toBe('pending');
      campayStatus(
        statusBody(reference, initiating.merchantReference, {
          status: 'SUCCESSFUL',
        }),
      );
      const retried = await webhookGet(
        notification(reference, initiating.merchantReference),
      );
      expect(retried.status).toBe(200);
      expect((await paymentDoc(String(initiating._id)))!.status).toBe(
        'succeeded',
      );
      expect(await paymentPeriods(String(initiating._id))).toHaveLength(1);
      expect(collectCalls()).toHaveLength(1);
    });

    it('paiement `uncertain` : la notification ne crée ni n’adopte de référence (traitement opérateur)', async () => {
      const owner = await registerOwner('uncertain');
      routes.collect = () =>
        Promise.reject(new CamPayTransportError('unknown'));
      const res = await pay(owner.token);
      expect(res.body.status).toBe('uncertain');
      const before = await paymentDoc(String(res.body.paymentId));
      const reply = await webhookGet(
        notification(randomUUID(), before!.merchantReference),
      );
      expect(reply.status).toBe(200);
      expect(statusCalls()).toHaveLength(0);
      expect(await paymentDoc(String(res.body.paymentId))).toEqual(before);
    });
  });

  // ─── Concurrence, rejeux, reprises ─────────────────────────────────────────

  describe('Doublons, concurrence et reprises', () => {
    it('webhook ET refresh propriétaire concurrents (barrière) : une seule période', async () => {
      const p = await pendingPayment('race-owner');
      const gate = barrier();
      routes.status = async () => {
        await gate.wait();
        return json(
          200,
          statusBody(p.reference, p.merchantReference, {
            status: 'SUCCESSFUL',
          }),
        );
      };
      const hook = webhookGet(
        notification(p.reference, p.merchantReference),
      ).then((r) => r);
      const owner = refresh(p.token, p.paymentId).then((r) => r);
      await gate.until(2);
      gate.release();
      const [h, o] = await Promise.all([hook, owner]);
      expect(h.status).toBe(200);
      expect(o.status).toBe(200);
      expect(o.body.status).toBe('succeeded');
      expect(await paymentPeriods(p.paymentId)).toHaveLength(1);
      expect((await paymentDoc(p.paymentId))!.status).toBe('succeeded');
    });

    it('notifications dupliquées concurrentes (barrière, GET + POST) : une seule période', async () => {
      const p = await pendingPayment('race-dup');
      const gate = barrier();
      routes.status = async () => {
        await gate.wait();
        return json(
          200,
          statusBody(p.reference, p.merchantReference, {
            status: 'SUCCESSFUL',
          }),
        );
      };
      const pending = [
        webhookGet(notification(p.reference, p.merchantReference)).then(
          (r) => r,
        ),
        webhookPost(notification(p.reference, p.merchantReference)).then(
          (r) => r,
        ),
        webhookGet(notification(p.reference, p.merchantReference)).then(
          (r) => r,
        ),
      ];
      await gate.until(3);
      gate.release();
      for (const res of await Promise.all(pending))
        expect(res.status).toBe(200);
      expect(await paymentPeriods(p.paymentId)).toHaveLength(1);
    });

    it('notification TARDIVE après succès (FAILED annoncé, CamPay FAILED) : paiement et période préservés, aucun appel', async () => {
      const p = await pendingPayment('late');
      campayStatus(
        statusBody(p.reference, p.merchantReference, { status: 'SUCCESSFUL' }),
      );
      expect(
        (await webhookGet(notification(p.reference, p.merchantReference)))
          .status,
      ).toBe(200);
      const succeeded = await paymentDoc(p.paymentId);
      campayStatus(
        statusBody(p.reference, p.merchantReference, { status: 'FAILED' }),
      );
      const calledBefore = statusCalls().length;
      const late = await webhookPost(
        notification(p.reference, p.merchantReference, {
          status: 'FAILED',
          reason: 'late',
        }),
      );
      expect(late.status).toBe(200);
      expect(statusCalls()).toHaveLength(calledBefore);
      expect(await paymentDoc(p.paymentId)).toEqual(succeeded);
      expect(await paymentPeriods(p.paymentId)).toHaveLength(1);
    });

    it('prestataire indisponible → 503 temporaire, jamais `failed` ; nouvelle tentative → succès', async () => {
      const p = await pendingPayment('unavailable');
      routes.status = () => Promise.reject(new CamPayTransportError('unknown'));
      for (const res of [
        await webhookGet(notification(p.reference, p.merchantReference)),
        await webhookPost(notification(p.reference, p.merchantReference)),
      ]) {
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('PAYMENT_WEBHOOK_RETRY_LATER');
        expect(res.headers['retry-after']).toBe('60');
      }
      routes.status = () => Promise.resolve(json(500, { message: 'boom' }));
      expect(
        (await webhookGet(notification(p.reference, p.merchantReference)))
          .status,
      ).toBe(503);
      expect(await paymentDoc(p.paymentId)).toMatchObject({
        status: 'pending',
        open: true,
      });

      campayStatus(
        statusBody(p.reference, p.merchantReference, { status: 'SUCCESSFUL' }),
      );
      expect(
        (await webhookGet(notification(p.reference, p.merchantReference)))
          .status,
      ).toBe(200);
      expect((await paymentDoc(p.paymentId))!.status).toBe('succeeded');
      expect(await paymentPeriods(p.paymentId)).toHaveLength(1);
    });

    it('budget HTTP de l’adaptateur épuisé (10 s) → consultation annulée, 503 temporaire ; nouvelle tentative → succès', async () => {
      const p = await pendingPayment('http-budget');
      // Jeton expiré : la ré-authentification consomme presque tout le budget.
      adapterOffset += 4_000_000;
      routes.token = () => {
        adapterOffset += 9_995;
        return Promise.resolve(
          json(200, { token: CAMPAY_TOKEN, expires_in: 3600 }),
        );
      };
      let aborted = false;
      routes.status = (req) =>
        new Promise((_resolve, reject) => {
          req.signal.addEventListener('abort', () => {
            aborted = true;
            reject(new CamPayTransportError('unknown'));
          });
        });
      const res = await webhookGet(
        notification(p.reference, p.merchantReference),
      );
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('PAYMENT_WEBHOOK_RETRY_LATER');
      expect(aborted).toBe(true);
      expect(await paymentDoc(p.paymentId)).toMatchObject({
        status: 'pending',
        open: true,
      });

      routes.token = () =>
        Promise.resolve(json(200, { token: CAMPAY_TOKEN, expires_in: 3600 }));
      campayStatus(
        statusBody(p.reference, p.merchantReference, { status: 'SUCCESSFUL' }),
      );
      expect(
        (await webhookGet(notification(p.reference, p.merchantReference)))
          .status,
      ).toBe(200);
      expect(await paymentPeriods(p.paymentId)).toHaveLength(1);
    });

    it('budget de confirmation (30 s) épuisé → 503 temporaire, état inchangé ; nouvelle tentative → une seule période', async () => {
      const p = await pendingPayment('grant-budget');
      campayStatus(
        statusBody(p.reference, p.merchantReference, { status: 'SUCCESSFUL' }),
      );
      const spy = jest
        .spyOn(subscriptions, 'grantSubscriptionInSession')
        .mockImplementationOnce(() => {
          engineOffset += PAYMENT_CONFIRMATION_BUDGET_MS + 1;
          return Promise.reject(
            Object.assign(new Error('E11000 duplicate key error'), {
              code: 11000,
              keyPattern: { organizationId: 1, sequence: 1 },
            }),
          );
        });
      const res = await webhookGet(
        notification(p.reference, p.merchantReference),
      );
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('PAYMENT_WEBHOOK_RETRY_LATER');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await paymentDoc(p.paymentId)).toMatchObject({
        status: 'pending',
        open: true,
        periodId: null,
      });
      spy.mockRestore();
      expect(
        (await webhookGet(notification(p.reference, p.merchantReference)))
          .status,
      ).toBe(200);
      expect((await paymentDoc(p.paymentId))!.status).toBe('succeeded');
      expect(await paymentPeriods(p.paymentId)).toHaveLength(1);
    });

    it('commit déjà validé (réponse perdue) retrouvé sans seconde attribution ni appel', async () => {
      const p = await pendingPayment('commit');
      campayStatus(
        statusBody(p.reference, p.merchantReference, { status: 'SUCCESSFUL' }),
      );
      const original = subscriptions.runInGrantTransaction.bind(subscriptions);
      jest
        .spyOn(subscriptions, 'runInGrantTransaction')
        .mockImplementationOnce(async (work, options) => {
          await original(work, options);
          throw new SubscriptionGrantError('GRANT_TIMEOUT', 'lost response');
        });
      const res = await webhookGet(
        notification(p.reference, p.merchantReference),
      );
      expect(res.status).toBe(503);
      const calledBefore = statusCalls().length;
      const again = await webhookPost(
        notification(p.reference, p.merchantReference),
      );
      expect(again.status).toBe(200);
      expect(statusCalls()).toHaveLength(calledBefore);
      expect((await paymentDoc(p.paymentId))!.status).toBe('succeeded');
      expect(await paymentPeriods(p.paymentId)).toHaveLength(1);
    });
  });

  // ─── Limitation et isolement ───────────────────────────────────────────────

  describe('Limitation dédiée et routes propriétaire', () => {
    it(`limite ${PAYMENT_WEBHOOK_LIMIT}/60 s par adresse Express, évaluée AVANT tout traitement ; X-Forwarded-For sans effet`, async () => {
      const p = await pendingPayment('throttle');
      campayStatus(
        statusBody(p.reference, p.merchantReference, { status: 'PENDING' }),
      );
      clearThrottle();
      for (let i = 0; i < PAYMENT_WEBHOOK_LIMIT; i += 1) {
        const res = await request(server())
          .get(WEBHOOK)
          .set('X-Forwarded-For', `203.0.113.${i % 200}`)
          .query({ reference: 'not-a-uuid', signature: 'x' });
        expect(res.status).toBe(400);
      }
      const statusBefore = statusCalls().length;
      const limited = await webhookGet(
        notification(p.reference, p.merchantReference),
      );
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('PAYMENT_WEBHOOK_RATE_LIMITED');
      expect(limited.body.path).toBe(WEBHOOK);
      expect(limited.headers['retry-after']).toBe('60');
      expectOpaque(limited);
      const spoofed = await request(server())
        .post(WEBHOOK)
        .set('X-Forwarded-For', '198.51.100.7')
        .set('X-Real-IP', '198.51.100.8')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(notification(p.reference, p.merchantReference)));
      expect(spoofed.status).toBe(429);
      expect(statusCalls()).toHaveLength(statusBefore);

      // Fenêtres indépendantes : le refresh propriétaire reste disponible…
      const owner = await request(server())
        .post(
          `/organizations/current/subscription/payments/${p.paymentId}/refresh`,
        )
        .set('Authorization', `Bearer ${p.token}`);
      expect(owner.status).toBe(200);
      clearThrottle();
    });

    it('routes propriétaire : contrôles d’accès inchangés (aucun accès via le webhook)', async () => {
      const p = await pendingPayment('access');
      const anonymous = await request(server()).post(
        `/organizations/current/subscription/payments/${p.paymentId}/refresh`,
      );
      expect(anonymous.status).toBe(401);
      const withSignature = await request(server())
        .get(`/organizations/current/subscription/payments/${p.paymentId}`)
        .set('Authorization', `Bearer ${signNotification()}`);
      expect(withSignature.status).toBe(401);
      expect(statusCalls()).toHaveLength(0);
    });
  });

  // ─── Variantes de chemin et erreurs des parseurs (complément D.2F) ────────

  describe('Aucune donnée sensible dans les erreurs : variantes de chemin, JSON malformé', () => {
    // Marqueurs FACTICES : ne doivent apparaître ni dans les réponses ni
    // dans les journaux.
    const SIG_MARKER = 'FAKESIGMARKER7Q.abc.def';
    const PHONE_MARKER = '237699000111';
    const BODY_MARKER = 'BODYSECRETMARKER9Z';
    const VARIANTS = [
      '/PAYMENTS/WEBHOOKS/CAMPAY',
      '/payments/webhooks/campay/',
      '/Payments/Webhooks/Campay/',
    ];

    /** Corps BRUT (texte) : aucun marqueur, aucune query, `no-store`. */
    const expectClean = (res: request.Response, extra: string[] = []) => {
      expect(res.headers['cache-control']).toBe('no-store');
      for (const marker of [
        SIG_MARKER,
        'FAKESIGMARKER7Q',
        PHONE_MARKER,
        BODY_MARKER,
        // Fragments : le message V8 d'une erreur JSON cite un extrait tronqué.
        'BODYSEC',
        'ignature',
        '699000',
        'phone_number',
        'signature',
        '?',
        ...extra,
      ]) {
        expect(res.text).not.toContain(marker);
      }
    };
    const expectQuietConsole = (markers: string[]) => {
      for (const spy of consoleSpies) {
        const text = JSON.stringify(spy.mock.calls);
        for (const marker of markers) expect(text).not.toContain(marker);
      }
    };

    it.each(VARIANTS)(
      '%s : routé vers le webhook ; 401, 503 et 429 sans signature, téléphone ni query',
      async (variant) => {
        const p = await pendingPayment('variant');
        clearThrottle();
        // 401 : signature factice invalide, téléphone factice.
        const unauthorized = await request(server())
          .get(variant)
          .query(
            notification(p.reference, p.merchantReference, {
              signature: SIG_MARKER,
              phone_number: PHONE_MARKER,
            }) as Record<string, string>,
          );
        expect(unauthorized.status).toBe(401);
        expect(unauthorized.body.code).toBe('PAYMENT_WEBHOOK_UNAUTHORIZED');
        expectClean(unauthorized);

        // 503 temporaire : signature VALIDE, statut CamPay indisponible.
        routes.status = () =>
          Promise.reject(new CamPayTransportError('unknown'));
        const valid = notification(p.reference, p.merchantReference, {
          phone_number: PHONE_MARKER,
        });
        const retry = await request(server())
          .get(variant)
          .query(valid as Record<string, string>);
        expect(retry.status).toBe(503);
        expect(retry.body.code).toBe('PAYMENT_WEBHOOK_RETRY_LATER');
        expectClean(retry, [String(valid.signature)]);

        // 429 : refus de la garde (filtre global) sur la même variante.
        clearThrottle();
        for (let i = 0; i < PAYMENT_WEBHOOK_LIMIT; i += 1) {
          await request(server()).get(variant).query({ reference: 'x' });
        }
        const limited = await request(server())
          .get(variant)
          .query({
            ...valid,
            signature: SIG_MARKER,
          } as Record<string, string>);
        expect(limited.status).toBe(429);
        expect(limited.body.code).toBe('PAYMENT_WEBHOOK_RATE_LIMITED');
        expectClean(limited, [String(valid.signature)]);
        expect(statusCalls()).toHaveLength(1);
        expectQuietConsole([SIG_MARKER, PHONE_MARKER, String(valid.signature)]);
        clearThrottle();
      },
    );

    it.each([
      [
        'tronqué',
        `{"signature":"${BODY_MARKER}","phone_number":"237699000111",`,
      ],
      [
        'virgule manquante',
        `{"signature":"${BODY_MARKER}" "phone_number":"237699000111"}`,
      ],
      [
        'jeton nu',
        `{"signature":${BODY_MARKER},"phone_number":"237699000111"}`,
      ],
      [
        'premier caractère (mode strict)',
        `${BODY_MARKER}{"phone_number":"237699000111"}`,
      ],
      [
        'déchet final',
        `{"signature":"x","phone_number":"237699000111"}${BODY_MARKER}`,
      ],
    ])(
      'JSON malformé (%s), rejeté par le parseur avant le contrôleur : réponse et journaux sans extrait du corps',
      async (_label, raw) => {
        for (const path of [WEBHOOK, '/PAYMENTS/WEBHOOKS/CAMPAY/']) {
          clearThrottle();
          const res = await request(server())
            .post(`${path}?signature=${SIG_MARKER}`)
            .set('Content-Type', 'application/json')
            .send(raw);
          expect(res.status).toBe(400);
          expectClean(res);
        }
        expectQuietConsole([BODY_MARKER, PHONE_MARKER, SIG_MARKER]);
        expect(calls).toHaveLength(0);
      },
    );
  });
});
