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
} from './../src/subscriptions/payments/campay/campay-transport';
import { CAMPAY_WEBHOOK_CONFIG } from './../src/subscriptions/payments/campay/campay-webhook.config';
import { PaymentReconciliationService } from './../src/subscriptions/payments/reconciliation/payment-reconciliation.service';
import {
  parseReconciliationArguments,
  runReconciliationCommand,
} from './../src/subscriptions/payments/reconciliation/payment-reconciliation-cli';
import {
  SubscriptionPaymentReconciliation,
  SubscriptionPaymentReconciliationDocument,
} from './../src/subscriptions/payments/reconciliation/subscription-payment-reconciliation.schema';
import { ensureReconciliationIndexes } from './../src/subscriptions/payments/reconciliation/subscription-payment-reconciliation-indexes';
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

/**
 * E2E 1-14D.2G — rapprochement OPÉRATEUR (CLI), exécuté par la couche CLI
 * réelle (`runReconciliationCommand`) sur le service injecté de
 * l'application. Adaptateur CamPay RÉEL sur un FAUX transport à barrières,
 * replica set éphémère ; webhook activé par injection uniquement pour les
 * scénarios de concurrence. Aucun domaine CamPay contacté ; références,
 * clés et téléphone FICTIFS. La configuration de production (fournisseur
 * indisponible) est vérifiée par `payment-reconciliation-cli-process.e2e-spec.ts`.
 */

const TEST_JWT_SECRET = 'reconciliation-14d2g-e2e-login-secret';
const WEBHOOK_KEY = 'fake-campay-webhook-key-14d2g-e2e';
const PASSWORD = 'reconcile-14d2g-pw-!1x';
const CAMPAY_TOKEN = 'fake.campay.token.14d2g';
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
const statusCalls = () =>
  calls.filter((c) => c.url.includes('/api/transaction/'));
const collectCalls = () => calls.filter((c) => c.url.endsWith('/api/collect/'));
const referenceOf = (req: CamPayHttpRequest) =>
  new URL(req.url).pathname.split('/')[3];

/** Statuts CamPay par référence ; corps BRUT possible (montants piégeux). */
const campay = new Map<string, Record<string, unknown> | string>();
const defaultStatusRoute: Route = (req) => {
  const entry = campay.get(referenceOf(req));
  if (entry === undefined) return Promise.resolve(json(404, { message: 'x' }));
  return Promise.resolve(
    typeof entry === 'string'
      ? { status: 200, bodyText: entry }
      : json(200, entry),
  );
};

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

const signer = new JwtService();
const signNotification = () => {
  const now = Math.floor(Date.now() / 1000);
  return signer.sign(
    { iat: now, nbf: now, exp: now + 3600 },
    { secret: WEBHOOK_KEY, algorithm: 'HS256' },
  );
};

describe('Rapprochement opérateur par CLI (e2e 1-14D.2G)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let paymentModel: Model<SubscriptionPaymentDocument>;
  let periodModel: Model<SubscriptionPeriodDocument>;
  let auditModel: Model<SubscriptionPaymentReconciliationDocument>;
  let subscriptions: SubscriptionsService;
  let service: PaymentReconciliationService;
  const emailSender = createE2eEmailSender();
  const consoleSpies: jest.SpyInstance[] = [];
  let seq = 0;

  const server = () => app.getHttpServer();
  const clearThrottle = () =>
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();

  async function registerOwner(label: string) {
    clearThrottle();
    seq += 1;
    const email = `${label}-${seq}-14d2g@reconcile.test`;
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
    clearThrottle();
    const login = await request(server())
      .post('/auth/login')
      .send({ email, password: PASSWORD });
    return {
      orgId: String(reg.body.organization._id),
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
  const audits = (paymentId: string) =>
    auditModel
      .find({ paymentId: new Types.ObjectId(paymentId) })
      .lean()
      .exec();

  /** Statut CamPay officiel (forme de D.2D). */
  const statusBody = (
    reference: string,
    merchantReference: string,
    status: 'PENDING' | 'SUCCESSFUL' | 'FAILED',
    overrides: Record<string, unknown> = {},
  ) => ({
    reference,
    external_reference: merchantReference,
    status,
    amount: 3000.0,
    currency: 'XAF',
    operator: 'MTN',
    code: 'CP2610030002',
    operator_reference: null,
    description: 'Abonnement Stock Master (1 mois)',
    external_user: '',
    reason: null,
    phone_number: PHONE,
    endpoint: 'collect',
    ...overrides,
  });

  /** Paiement `uncertain` sans référence (réponse d'initiation perdue). */
  async function uncertainPayment(label: string) {
    const owner = await registerOwner(label);
    routes.collect = () => Promise.reject(new CamPayTransportError('unknown'));
    const res = await pay(owner.token);
    expect(res.body.status).toBe('uncertain');
    const doc = await paymentDoc(String(res.body.paymentId));
    expect(doc!.providerReference).toBeNull();
    return {
      ...owner,
      paymentId: String(res.body.paymentId),
      merchantReference: doc!.merchantReference,
    };
  }

  /** Paiement `pending` avec référence persistée. */
  async function pendingPayment(label: string) {
    const owner = await registerOwner(label);
    const reference = randomUUID();
    routes.collect = () => Promise.resolve(json(200, { reference }));
    const res = await pay(owner.token);
    expect(res.body.status).toBe('pending');
    const doc = await paymentDoc(String(res.body.paymentId));
    return {
      ...owner,
      paymentId: String(res.body.paymentId),
      reference,
      merchantReference: doc!.merchantReference,
    };
  }

  /** Paiement `review` (discordance de montant), référence persistée. */
  async function reviewPayment(label: string) {
    const p = await pendingPayment(label);
    campay.set(
      p.reference,
      statusBody(p.reference, p.merchantReference, 'SUCCESSFUL', {
        amount: 2999,
      }),
    );
    expect((await refresh(p.token, p.paymentId)).body.status).toBe('review');
    return p;
  }

  /** CLI réel (analyse + exécution) sur le service injecté. */
  async function cli(argv: string[]) {
    const command = parseReconciliationArguments(argv);
    if ('error' in command) throw new Error(command.error);
    const out: Record<string, unknown>[] = [];
    const err: string[] = [];
    const code = await runReconciliationCommand(command, service, {
      out: (v) => out.push(v as Record<string, unknown>),
      err: (m) => err.push(m),
    });
    return { code, out: out[0] ?? {}, err, text: JSON.stringify(out) };
  }
  const simulate = (paymentId: string, reference?: string) =>
    cli([
      'reconcile',
      `--payment-id=${paymentId}`,
      ...(reference ? [`--reference=${reference}`] : []),
    ]);
  const apply = (
    paymentId: string,
    plan: string,
    options: {
      reference?: string;
      operationId?: string;
      reason?: string;
      operator?: string;
    } = {},
  ) =>
    cli([
      'reconcile',
      `--payment-id=${paymentId}`,
      ...(options.reference ? [`--reference=${options.reference}`] : []),
      '--apply',
      `--plan=${plan}`,
      `--operation-id=${options.operationId ?? randomUUID()}`,
      `--operator=${options.operator ?? 'ops.alice'}`,
      `--reason=${options.reason ?? 'uncertain-initiation'}`,
    ]);
  const planOf = (r: { out: Record<string, unknown> }) =>
    r.out.plan as { decision: string; planToken: string; reason?: string };

  /** Aucune donnée sensible : téléphone (même masqué), jeton, réponse brute. */
  const expectNoSensitive = (text: string) => {
    for (const marker of [
      PHONE,
      '•',
      CAMPAY_TOKEN,
      'ussd',
      'operator_reference',
      'phone_number',
      'requestFingerprint',
      'clientOperationId',
    ]) {
      expect(text).not.toContain(marker);
    }
  };

  async function snapshot(paymentId: string) {
    return {
      payment: await paymentDoc(paymentId),
      periods: await paymentPeriods(paymentId),
      audits: await audits(paymentId),
    };
  }

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      process.env.MONGODB_URI = validatedEphemeralUri(replSet);
      process.env.JWT_SECRET = TEST_JWT_SECRET;
      process.env.CORS_ORIGIN = 'https://reconciliation-e2e.example.com';
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';

      moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EMAIL_SENDER)
        .useValue(emailSender)
        .overrideProvider(PAYMENT_PROVIDER)
        .useValue(
          new CamPayPaymentProvider({
            environment: 'demo',
            username: 'fake-campay-app-username',
            password: 'fake-campay-app-password',
            transport: fakeTransport,
          }),
        )
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
      expect(await ensureReconciliationIndexes(connection)).toBe('created');
      expect(await ensureReconciliationIndexes(connection)).toBe(
        'already-present',
      );
      paymentModel = moduleFixture.get(getModelToken(SubscriptionPayment.name));
      periodModel = moduleFixture.get(getModelToken(SubscriptionPeriod.name));
      auditModel = moduleFixture.get(
        getModelToken(SubscriptionPaymentReconciliation.name),
      );
      subscriptions = moduleFixture.get(SubscriptionsService);
      service = moduleFixture.get(PaymentReconciliationService);
    } catch (error) {
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  beforeEach(() => {
    calls.length = 0;
    campay.clear();
    routes.token = () =>
      Promise.resolve(json(200, { token: CAMPAY_TOKEN, expires_in: 3600 }));
    routes.collect = () =>
      Promise.resolve(json(200, { reference: randomUUID() }));
    routes.status = defaultStatusRoute;
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      consoleSpies.push(jest.spyOn(console, method).mockImplementation());
    }
  });

  afterEach(() => {
    for (const spy of consoleSpies) {
      const text = JSON.stringify(spy.mock.calls);
      for (const secret of [PHONE, CAMPAY_TOKEN, WEBHOOK_KEY]) {
        expect(text).not.toContain(secret);
      }
    }
    consoleSpies.splice(0);
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  // ─── Inspection et simulation ──────────────────────────────────────────────

  it('inspection et simulation : aucune écriture, aucune donnée sensible', async () => {
    const p = await uncertainPayment('inspect');
    const before = await snapshot(p.paymentId);
    const reference = randomUUID();
    campay.set(
      reference,
      statusBody(reference, p.merchantReference, 'SUCCESSFUL'),
    );

    const inspected = await cli(['inspect', `--payment-id=${p.paymentId}`]);
    expect(inspected.code).toBe(0);
    expect(inspected.out.payment).toMatchObject({
      paymentId: p.paymentId,
      status: 'uncertain',
      reconcilable: true,
      providerReference: null,
      merchantReference: p.merchantReference,
      amount: 3000,
      currency: 'XAF',
      reconciliations: [],
    });
    expectNoSensitive(inspected.text);
    expect(statusCalls()).toHaveLength(0);

    const required = await simulate(p.paymentId);
    expect(required.code).toBe(4);
    expect(planOf(required)).toMatchObject({
      decision: 'blocked',
      reason: 'reference-required',
    });

    const sim = await simulate(p.paymentId, reference.toUpperCase());
    expect(sim.code).toBe(0);
    expect(sim.out).toMatchObject({
      mode: 'simulation',
      plan: {
        decision: 'ready',
        action: 'succeed',
        consultedReference: reference,
        referenceAttach: true,
        before: { status: 'uncertain', providerReference: null },
        after: { status: 'succeeded', open: false, grantsPeriod: true },
        verified: { state: 'succeeded', amount: 3000, currency: 'XAF' },
      },
    });
    expect(planOf(sim).planToken).toMatch(/^[0-9a-f]{32}$/);
    expectNoSensitive(sim.text);
    expect(statusCalls()).toHaveLength(1);
    // Déterministe : même état, même statut → même jeton.
    expect(planOf(await simulate(p.paymentId, reference)).planToken).toBe(
      planOf(sim).planToken,
    );
    expect(await snapshot(p.paymentId)).toEqual(before);
    expect(collectCalls()).toHaveLength(1);
  });

  it('paiement d’un autre prestataire (ou fournisseur indisponible) : bloqué, aucun appel ni mutation', async () => {
    const { orgId } = await registerOwner('other-provider');
    const _id = new Types.ObjectId();
    await paymentModel.create({
      _id,
      organizationId: new Types.ObjectId(orgId),
      requestedBy: new Types.ObjectId(),
      clientOperationId: randomUUID(),
      requestFingerprint: 'f'.repeat(64),
      term: 'monthly',
      amount: 3000,
      currency: 'XAF',
      pricingVersion: 1,
      provider: 'unavailable',
      merchantReference: `SM${_id.toHexString().toUpperCase()}`,
      providerReference: null,
      status: 'uncertain',
      open: true,
      payerPhoneMasked: '+237 6•• ••• •56',
    });
    const id = _id.toHexString();
    const before = await snapshot(id);
    const r = await simulate(id, randomUUID());
    expect(r.code).toBe(4);
    expect(planOf(r).reason).toBe('provider-unavailable');
    const applied = await apply(id, 'a'.repeat(32), {
      reference: randomUUID(),
    });
    expect(applied.code).toBe(4);
    expect(calls).toHaveLength(0);
    expect(await snapshot(id)).toEqual(before);
  });

  // ─── Récupération et états vérifiés ────────────────────────────────────────

  it('`uncertain` sans référence + SUCCESSFUL concordant : rattachement, période `payment` et audit, atomiquement', async () => {
    const p = await uncertainPayment('recover');
    const reference = randomUUID();
    campay.set(
      reference,
      statusBody(reference, p.merchantReference, 'SUCCESSFUL'),
    );
    const sim = await simulate(p.paymentId, reference);
    const operationId = randomUUID();
    const r = await apply(p.paymentId, planOf(sim).planToken, {
      reference,
      operationId,
      reason: 'customer-evidence',
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({
      result: 'applied',
      operationId,
      action: 'succeed',
      consultedReference: reference,
      referenceAttached: true,
      before: { status: 'uncertain', providerReference: null },
      after: { status: 'succeeded', providerReference: reference },
    });
    expectNoSensitive(r.text);
    const doc = await paymentDoc(p.paymentId);
    expect(doc).toMatchObject({
      status: 'succeeded',
      open: false,
      providerReference: reference,
    });
    const periods = await paymentPeriods(p.paymentId);
    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({
      source: 'payment',
      sourceReference: `payment:${p.paymentId}`,
      grantedBy: 'payment:campay',
    });
    expect(String(doc!.periodId)).toBe(String(periods[0]._id));
    const [audit] = await audits(p.paymentId);
    expect(audit).toMatchObject({
      operationId,
      operatorId: 'ops.alice',
      reasonCode: 'customer-evidence',
      reasonTicket: null,
      action: 'succeed',
      consultedReference: reference,
      referenceAttached: true,
      beforeStatus: 'uncertain',
      beforeProviderReference: null,
      afterStatus: 'succeeded',
      afterProviderReference: reference,
      verifiedState: 'succeeded',
      verifiedProviderReference: reference,
      verifiedMerchantReference: p.merchantReference,
      verifiedAmount: 3000,
      verifiedCurrency: 'XAF',
      result: 'applied',
    });
    expect(String(audit.afterPeriodId)).toBe(String(periods[0]._id));
    // Audit : sa propre empreinte d'opération (hachage des paramètres CLI)
    // est attendue ; jamais l'empreinte HMAC du paiement, un téléphone
    // (même masqué), un jeton ni un champ de réponse brute.
    const auditText = JSON.stringify(audit);
    for (const marker of [
      PHONE,
      '•',
      CAMPAY_TOKEN,
      doc!.requestFingerprint,
      'phone',
      'ussd',
      'operator_reference',
    ]) {
      expect(auditText).not.toContain(marker);
    }
    // Historique visible à l'inspection ; aucune collecte supplémentaire.
    const inspected = await cli(['inspect', `--payment-id=${p.paymentId}`]);
    expect(
      (inspected.out.payment as { reconciliations: unknown[] }).reconciliations,
    ).toHaveLength(1);
    expect(collectCalls()).toHaveLength(1);
  });

  it('`review` concordant : succès ; `review` toujours discordant : bloqué, état et référence conservés', async () => {
    const ok = await reviewPayment('review-ok');
    campay.set(
      ok.reference,
      statusBody(ok.reference, ok.merchantReference, 'SUCCESSFUL'),
    );
    const sim = await simulate(ok.paymentId);
    expect(planOf(sim)).toMatchObject({
      decision: 'ready',
      referenceAttach: false,
    });
    const r = await apply(ok.paymentId, planOf(sim).planToken, {
      reason: 'review-investigation',
    });
    expect(r.code).toBe(0);
    expect((await paymentDoc(ok.paymentId))!.status).toBe('succeeded');
    expect(await paymentPeriods(ok.paymentId)).toHaveLength(1);

    const bad = await reviewPayment('review-bad');
    const before = await snapshot(bad.paymentId);
    const blocked = await simulate(bad.paymentId);
    expect(blocked.code).toBe(4);
    expect(blocked.out.plan).toMatchObject({
      decision: 'blocked',
      reason: 'mismatch',
      mismatches: ['amount'],
      verified: { amount: 2999 },
    });
    // Aucune dérogation : même avec un jeton quelconque, aucune mutation.
    expect((await apply(bad.paymentId, 'b'.repeat(32))).code).toBe(4);
    expect(await snapshot(bad.paymentId)).toEqual(before);
  });

  it('PENDING vérifié : rattachement, paiement ouvert sans période ; le cycle normal reprend ensuite', async () => {
    const p = await uncertainPayment('pending');
    const reference = randomUUID();
    campay.set(
      reference,
      statusBody(reference, p.merchantReference, 'PENDING'),
    );
    const sim = await simulate(p.paymentId, reference);
    expect(planOf(sim)).toMatchObject({ action: 'mark-pending' });
    const r = await apply(p.paymentId, planOf(sim).planToken, { reference });
    expect(r.code).toBe(0);
    expect(await paymentDoc(p.paymentId)).toMatchObject({
      status: 'pending',
      open: true,
      providerReference: reference,
      periodId: null,
    });
    expect(await paymentPeriods(p.paymentId)).toHaveLength(0);
    // Le moteur de confirmation retrouve désormais le paiement.
    campay.set(
      reference,
      statusBody(reference, p.merchantReference, 'SUCCESSFUL'),
    );
    expect((await refresh(p.token, p.paymentId)).body.status).toBe('succeeded');
    expect(await paymentPeriods(p.paymentId)).toHaveLength(1);
  });

  it('FAILED vérifié : `uncertain` et `review` fermés en `failed`, sans période ; une nouvelle demande redevient possible', async () => {
    const u = await uncertainPayment('failed-u');
    const reference = randomUUID();
    campay.set(reference, statusBody(reference, u.merchantReference, 'FAILED'));
    const sim = await simulate(u.paymentId, reference);
    expect(planOf(sim)).toMatchObject({ action: 'fail' });
    expect(
      (await apply(u.paymentId, planOf(sim).planToken, { reference })).code,
    ).toBe(0);
    expect(await paymentDoc(u.paymentId)).toMatchObject({
      status: 'failed',
      open: false,
      providerReference: reference,
      periodId: null,
    });
    expect(await paymentPeriods(u.paymentId)).toHaveLength(0);
    routes.collect = () =>
      Promise.resolve(json(200, { reference: randomUUID() }));
    expect((await pay(u.token)).status).toBe(201);

    const rv = await reviewPayment('failed-r');
    campay.set(
      rv.reference,
      statusBody(rv.reference, rv.merchantReference, 'FAILED'),
    );
    const simR = await simulate(rv.paymentId);
    expect(
      (
        await apply(rv.paymentId, planOf(simR).planToken, {
          reason: 'review-investigation',
        })
      ).code,
    ).toBe(0);
    expect(await paymentDoc(rv.paymentId)).toMatchObject({
      status: 'failed',
      open: false,
    });
  });

  it('`review` d’un paiement déjà fermé + PENDING : jamais rouvert (bloqué)', async () => {
    const p = await pendingPayment('closed-review');
    campay.set(
      p.reference,
      statusBody(p.reference, p.merchantReference, 'FAILED'),
    );
    expect((await refresh(p.token, p.paymentId)).body.status).toBe('failed');
    campay.set(
      p.reference,
      statusBody(p.reference, p.merchantReference, 'SUCCESSFUL', {
        currency: 'EUR',
      }),
    );
    expect((await refresh(p.token, p.paymentId)).body.status).toBe('review');
    expect((await paymentDoc(p.paymentId))!.open).toBe(false);
    campay.set(
      p.reference,
      statusBody(p.reference, p.merchantReference, 'PENDING'),
    );
    const before = await snapshot(p.paymentId);
    const r = await simulate(p.paymentId);
    expect(r.code).toBe(4);
    expect(planOf(r).reason).toBe('closed-review-cannot-reopen');
    expect(await snapshot(p.paymentId)).toEqual(before);
  });

  // ─── Références ────────────────────────────────────────────────────────────

  it('références : étrangère, déjà rattachée, différente de la persistée, réponse sur une autre référence', async () => {
    const u = await uncertainPayment('refs');
    const before = await snapshot(u.paymentId);

    // Étrangère : la transaction appartient à une autre référence marchand.
    const foreign = randomUUID();
    campay.set(
      foreign,
      statusBody(foreign, 'SM' + 'A'.repeat(24), 'SUCCESSFUL'),
    );
    const r1 = await simulate(u.paymentId, foreign);
    expect(r1.out.plan).toMatchObject({
      reason: 'mismatch',
      mismatches: ['merchantReference'],
    });

    // Déjà rattachée à un autre paiement : refus SANS consultation.
    const other = await pendingPayment('refs-other');
    const callsBefore = statusCalls().length;
    const r2 = await simulate(u.paymentId, other.reference);
    expect(planOf(r2).reason).toBe('reference-already-attached');
    expect(statusCalls()).toHaveLength(callsBefore);

    // CamPay répond pour une AUTRE référence que celle consultée.
    const asked = randomUUID();
    campay.set(
      asked,
      statusBody(randomUUID(), u.merchantReference, 'SUCCESSFUL'),
    );
    const r3 = await simulate(u.paymentId, asked);
    expect(r3.out.plan).toMatchObject({
      reason: 'mismatch',
      mismatches: ['providerReference'],
    });

    // Introuvable / indisponible chez CamPay : bloqué, rien n'est conclu.
    const r4 = await simulate(u.paymentId, randomUUID());
    expect(planOf(r4).reason).toBe('provider-status-unavailable');
    expect(await snapshot(u.paymentId)).toEqual(before);

    // Référence persistée : jamais remplacée par une candidate différente.
    const rv = await reviewPayment('refs-persisted');
    const r5 = await simulate(rv.paymentId, randomUUID());
    expect(planOf(r5).reason).toBe('reference-differs-from-persisted');
    campay.set(
      rv.reference,
      statusBody(rv.reference, rv.merchantReference, 'SUCCESSFUL'),
    );
    expect(
      planOf(await simulate(rv.paymentId, rv.reference.toUpperCase())).decision,
    ).toBe('ready');
  });

  it.each([
    [
      '3000.0000000000000001 (arrondi par JSON.parse)',
      '3000.0000000000000001',
      false,
    ],
    [
      '2999.9999999999999999 (arrondi par JSON.parse)',
      '2999.9999999999999999',
      false,
    ],
    ['3000.5', '3000.5', false],
    ['3e3', '3e3', false],
    ['"3000.0" (chaîne décimale)', '"3000.0"', false],
    ['montant absent', null, false],
    ['3000.0 (littéral entier exact)', '3000.0', true],
    ['"3000" (chaîne entière canonique)', '"3000"', true],
  ])('montant %s', async (_label, literal, accepted) => {
    const u = await uncertainPayment('amount');
    const reference = randomUUID();
    const body = statusBody(reference, u.merchantReference, 'SUCCESSFUL', {
      amount: '__AMOUNT__',
    });
    const raw = JSON.stringify(body);
    campay.set(
      reference,
      literal === null
        ? raw.replace('"amount":"__AMOUNT__",', '')
        : raw.replace('"__AMOUNT__"', literal),
    );
    const r = await simulate(u.paymentId, reference);
    if (accepted) {
      expect(planOf(r).decision).toBe('ready');
    } else {
      expect(r.out.plan).toMatchObject({
        decision: 'blocked',
        reason: 'mismatch',
        mismatches: ['amount'],
      });
      expect(
        (r.out.plan as { verified: { amount: unknown } }).verified.amount,
      ).toBeNull();
    }
  });

  it('champs absents (devise, référence marchand) : bloqué', async () => {
    const u = await uncertainPayment('missing');
    const reference = randomUUID();
    const body = statusBody(
      reference,
      u.merchantReference,
      'SUCCESSFUL',
    ) as Record<string, unknown>;
    delete body.currency;
    delete body.external_reference;
    campay.set(reference, body);
    const r = await simulate(u.paymentId, reference);
    expect(r.out.plan).toMatchObject({
      reason: 'mismatch',
      mismatches: ['merchantReference', 'currency'],
    });
  });

  // ─── Plan obsolète, idempotence ────────────────────────────────────────────

  it('plan obsolète : statut vérifié changé entre simulation et application → code 5, aucune mutation', async () => {
    const u = await uncertainPayment('stale');
    const reference = randomUUID();
    campay.set(
      reference,
      statusBody(reference, u.merchantReference, 'PENDING'),
    );
    const sim = await simulate(u.paymentId, reference);
    campay.set(
      reference,
      statusBody(reference, u.merchantReference, 'SUCCESSFUL'),
    );
    const before = await snapshot(u.paymentId);
    const r = await apply(u.paymentId, planOf(sim).planToken, { reference });
    expect(r.code).toBe(5);
    expect(r.out).toMatchObject({
      error: 'PLAN_STALE',
      currentPlan: { decision: 'ready', action: 'succeed' },
    });
    expect(await snapshot(u.paymentId)).toEqual(before);
  });

  it('identifiant d’opération : rejeu identique sans réseau ; réutilisé avec d’autres paramètres → code 6', async () => {
    const u = await uncertainPayment('idempotent');
    const reference = randomUUID();
    campay.set(
      reference,
      statusBody(reference, u.merchantReference, 'SUCCESSFUL'),
    );
    const plan = planOf(await simulate(u.paymentId, reference)).planToken;
    const operationId = randomUUID();
    const first = await apply(u.paymentId, plan, { reference, operationId });
    expect(first.out.result).toBe('applied');
    const calledBefore = statusCalls().length;
    const again = await apply(u.paymentId, plan, { reference, operationId });
    expect(again.code).toBe(0);
    expect(again.out).toMatchObject({
      result: 'replayed',
      operationId,
      appliedAt: first.out.appliedAt,
    });
    expect(statusCalls()).toHaveLength(calledBefore);

    const otherReason = await apply(u.paymentId, plan, {
      reference,
      operationId,
      reason: 'support-ticket',
    });
    expect(otherReason.code).toBe(6);
    const otherOperator = await apply(u.paymentId, plan, {
      reference,
      operationId,
      operator: 'ops.bob',
    });
    expect(otherOperator.code).toBe(6);
    const v = await uncertainPayment('idempotent-other');
    const otherPayment = await apply(v.paymentId, plan, {
      operationId,
      reference: randomUUID(),
    });
    expect(otherPayment.code).toBe(6);
    expect(await audits(u.paymentId)).toHaveLength(1);
    expect(await audits(v.paymentId)).toHaveLength(0);
    expect(await paymentPeriods(u.paymentId)).toHaveLength(1);
  });

  // ─── Concurrence ───────────────────────────────────────────────────────────

  it('deux opérateurs concurrents (barrière) : une seule application, l’autre plan obsolète ; une période, un audit', async () => {
    const u = await uncertainPayment('race-ops');
    const reference = randomUUID();
    campay.set(
      reference,
      statusBody(reference, u.merchantReference, 'SUCCESSFUL'),
    );
    const plan = planOf(await simulate(u.paymentId, reference)).planToken;
    const gate = barrier();
    routes.status = async (req) => {
      await gate.wait();
      return defaultStatusRoute(req);
    };
    const a = apply(u.paymentId, plan, { reference, operator: 'ops.alice' });
    const b = apply(u.paymentId, plan, { reference, operator: 'ops.bob' });
    await gate.until(2);
    gate.release();
    const codes = (await Promise.all([a, b])).map((r) => r.code).sort();
    expect(codes).toEqual([0, 5]);
    expect(await paymentPeriods(u.paymentId)).toHaveLength(1);
    expect(await audits(u.paymentId)).toHaveLength(1);
  });

  it('opérateur contre webhook et refresh propriétaire (barrière) : aucune double attribution', async () => {
    const rv = await reviewPayment('race-mixed');
    campay.set(
      rv.reference,
      statusBody(rv.reference, rv.merchantReference, 'SUCCESSFUL'),
    );
    const plan = planOf(await simulate(rv.paymentId)).planToken;
    const gate = barrier();
    routes.status = async (req) => {
      await gate.wait();
      return defaultStatusRoute(req);
    };
    const operator = apply(rv.paymentId, plan, {
      reason: 'review-investigation',
    });
    await gate.until(1);
    // Pendant la consultation de l'opérateur : `review` reste hors du cycle
    // automatique (aucune consultation, aucune écriture).
    const hook = await request(server())
      .get('/payments/webhooks/campay')
      .query({
        reference: rv.reference,
        signature: signNotification(),
        status: 'SUCCESSFUL',
        endpoint: 'collect',
      });
    expect(hook.status).toBe(200);
    expect((await refresh(rv.token, rv.paymentId)).body.status).toBe('review');
    expect(gate.state.arrived).toBe(1);
    gate.release();
    expect((await operator).code).toBe(0);
    // Après le rapprochement : notifications et refresh rejoués sans effet.
    routes.status = defaultStatusRoute;
    expect(
      (
        await request(server()).get('/payments/webhooks/campay').query({
          reference: rv.reference,
          signature: signNotification(),
          endpoint: 'collect',
        })
      ).status,
    ).toBe(200);
    expect((await refresh(rv.token, rv.paymentId)).body.status).toBe(
      'succeeded',
    );
    expect(await paymentPeriods(rv.paymentId)).toHaveLength(1);
  });

  it('PENDING rattaché puis webhook et opérateur concurrents (barrière) : une seule période', async () => {
    const u = await uncertainPayment('race-after-pending');
    const reference = randomUUID();
    campay.set(
      reference,
      statusBody(reference, u.merchantReference, 'PENDING'),
    );
    const simP = await simulate(u.paymentId, reference);
    expect(
      (await apply(u.paymentId, planOf(simP).planToken, { reference })).code,
    ).toBe(0);
    // Le paiement est `pending` : l'opérateur ne peut plus le rapprocher,
    // le webhook le confirme par le moteur unique.
    campay.set(
      reference,
      statusBody(reference, u.merchantReference, 'SUCCESSFUL'),
    );
    expect(planOf(await simulate(u.paymentId)).reason).toBe(
      'status-not-reconcilable',
    );
    const gate = barrier();
    routes.status = async (req) => {
      await gate.wait();
      return defaultStatusRoute(req);
    };
    const hooks = [1, 2].map(() =>
      request(server())
        .get('/payments/webhooks/campay')
        .query({
          reference,
          signature: signNotification(),
          endpoint: 'collect',
        })
        .then((r) => r),
    );
    await gate.until(2);
    gate.release();
    for (const r of await Promise.all(hooks)) expect(r.status).toBe(200);
    expect(await paymentPeriods(u.paymentId)).toHaveLength(1);
  });

  // ─── Rollback et commit inconnu ────────────────────────────────────────────

  it('échec de l’audit dans la transaction : rollback complet (ni rattachement, ni période, ni audit) ; rejeu → appliqué', async () => {
    const u = await uncertainPayment('rollback');
    const reference = randomUUID();
    campay.set(
      reference,
      statusBody(reference, u.merchantReference, 'SUCCESSFUL'),
    );
    const plan = planOf(await simulate(u.paymentId, reference)).planToken;
    const before = await snapshot(u.paymentId);
    jest
      .spyOn(auditModel, 'create')
      .mockRejectedValueOnce(new Error('audit write failed'));
    const operationId = randomUUID();
    const failed = await apply(u.paymentId, plan, { reference, operationId });
    expect(failed.code).toBe(1);
    expect(failed.err.join(' ')).not.toContain('audit write failed');
    expect(await snapshot(u.paymentId)).toEqual(before);
    const retried = await apply(u.paymentId, plan, { reference, operationId });
    expect(retried.out.result).toBe('applied');
    expect(await paymentPeriods(u.paymentId)).toHaveLength(1);
    expect(await audits(u.paymentId)).toHaveLength(1);
  });

  it('commit validé mais résultat inconnu → code 7 ; rejeu retrouve le commit sans seconde période ni appel', async () => {
    const u = await uncertainPayment('commit');
    const reference = randomUUID();
    campay.set(
      reference,
      statusBody(reference, u.merchantReference, 'SUCCESSFUL'),
    );
    const plan = planOf(await simulate(u.paymentId, reference)).planToken;
    const original = subscriptions.runInGrantTransaction.bind(subscriptions);
    jest
      .spyOn(subscriptions, 'runInGrantTransaction')
      .mockImplementationOnce(async (work, options) => {
        await original(work, options);
        throw new SubscriptionGrantError('GRANT_TIMEOUT', 'lost response');
      });
    const operationId = randomUUID();
    const lost = await apply(u.paymentId, plan, { reference, operationId });
    expect(lost.code).toBe(7);
    expect(lost.out.error).toBe('CONFIRMATION_PENDING');
    const calledBefore = statusCalls().length;
    const replay = await apply(u.paymentId, plan, { reference, operationId });
    expect(replay.out.result).toBe('replayed');
    expect(statusCalls()).toHaveLength(calledBefore);
    expect(await paymentPeriods(u.paymentId)).toHaveLength(1);
    expect(await audits(u.paymentId)).toHaveLength(1);
  });

  // ─── Routes et accès inchangés ─────────────────────────────────────────────

  it('aucune route de rapprochement ; routes propriétaire et contrôles d’accès inchangés', async () => {
    const p = await pendingPayment('routes');
    for (const path of [
      '/payments/reconciliations',
      `/organizations/current/subscription/payments/${p.paymentId}/reconcile`,
    ]) {
      const res = await request(server())
        .post(path)
        .set('Authorization', `Bearer ${p.token}`)
        .send({});
      expect(res.status).toBe(404);
    }
    expect(
      (
        await request(server()).get(
          `/organizations/current/subscription/payments/${p.paymentId}`,
        )
      ).status,
    ).toBe(401);
    clearThrottle();
    const read = await request(server())
      .get(`/organizations/current/subscription/payments/${p.paymentId}`)
      .set('Authorization', `Bearer ${p.token}`);
    expect(read.status).toBe(200);
    expect(Object.keys(read.body as object)).not.toContain('reconciliations');
  });
});
