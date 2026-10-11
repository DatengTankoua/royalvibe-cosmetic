import 'reflect-metadata';
import { createHmac, randomUUID } from 'crypto';
import { Model, Types } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
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
import { SubscriptionSource } from './../src/subscriptions/subscription-terms';
import {
  SubscriptionPayment,
  SubscriptionPaymentDocument,
} from './../src/subscriptions/payments/schemas/subscription-payment.schema';
import { ensureSubscriptionPaymentIndexes } from './../src/subscriptions/payments/subscription-payment-indexes';
import {
  PAYMENT_CONFIRMATION_PROVIDERS,
  PAYMENT_PROVIDER,
} from './../src/subscriptions/payments/payment-provider';
import {
  PAYMENT_RETURN_ORIGIN,
  SubscriptionPaymentsService,
} from './../src/subscriptions/payments/subscription-payments.service';
import {
  SASPAY_LOOKUP_MAX_PAGES,
  SasPayPaymentProvider,
} from './../src/subscriptions/payments/saspay/saspay-payment-provider';
import { SASPAY_WEBHOOK_CONFIG } from './../src/subscriptions/payments/saspay/saspay-webhook.service';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import { PaymentReconciliationService } from './../src/subscriptions/payments/reconciliation/payment-reconciliation.service';
import { ensureReconciliationIndexes } from './../src/subscriptions/payments/reconciliation/subscription-payment-reconciliation-indexes';
import { ReconciliationReason } from './../src/subscriptions/payments/reconciliation/subscription-payment-reconciliation.schema';
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
import { FAKE_SASPAY_KEY, FakeSasPay } from './e2e/fake-saspay';

/**
 * 1-21B — Paiement d'abonnement par PAGE HÉBERGÉE SasPay, de bout en bout
 * contre un FAUX SasPay (transport de l'adaptateur RÉEL), base éphémère.
 *
 * Documenté (contrat officiel) : création de session sans idempotence,
 * consultation par trois routes, liste paginée, webhook HMAC du corps brut.
 * HYPOTHÈSES simulées, à vérifier en bac à sable : une transaction
 * rattachée par session, succès possible après `EXPIRED`, cohérence des
 * routes de session (une incohérence est testée comme telle).
 */

const TEST_JWT_SECRET = 'saspay-checkout-21b-e2e-only-secret';
const WEBHOOK_SECRET = 'saspay-webhook-secret-21b-e2e-only';
const PASSWORD = 'pay-21b-pw-!1x';
const RETURN_ORIGIN = 'https://app.saspay-e2e.example';

const fake = new FakeSasPay();
const provider = new SasPayPaymentProvider({
  environment: 'sandbox',
  secretKey: FAKE_SASPAY_KEY,
  transport: fake.transport,
});

function signed(body: unknown, ageSeconds = 0, secret = WEBHOOK_SECRET) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000) - ageSeconds);
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${raw}`)
    .digest('hex');
  return { raw, timestamp, signature };
}

describe('Paiement par page hébergée SasPay (e2e 1-21B)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let paymentModel: Model<SubscriptionPaymentDocument>;
  let periodModel: Model<SubscriptionPeriodDocument>;
  let payments: SubscriptionPaymentsService;
  let seq = 0;
  const emailSender = createE2eEmailSender();

  const server = () => app.getHttpServer();
  const clearThrottle = () =>
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();
  const base = '/organizations/current/subscription/payments';

  async function owner(label: string) {
    clearThrottle();
    seq += 1;
    const email = `${label}-${seq}-21b@pay.test`;
    const reg = await postRegister(app, {
      ...OWNER_TERMS,
      name: `Gérant ${seq}`,
      email,
      password: PASSWORD,
      organizationName: `Boutique ${seq}`,
    });
    expect(reg.status).toBe(202);
    clearThrottle();
    const login = await request(server())
      .post('/auth/login')
      .send({ email, password: PASSWORD });
    expect(login.status).toBe(201);
    return {
      email,
      orgId: reg.owner!.organization._id,
      token: login.body.access_token as string,
    };
  }

  const create = (
    token: string,
    body: Record<string, unknown> = {},
  ): request.Test => {
    clearThrottle();
    return request(server())
      .post(base)
      .set('Authorization', `Bearer ${token}`)
      .send({ term: 'monthly', clientOperationId: randomUUID(), ...body });
  };
  const refresh = (token: string, id: string) => {
    clearThrottle();
    return request(server())
      .post(`${base}/${id}/refresh`)
      .set('Authorization', `Bearer ${token}`);
  };
  const doc = (id: string) => paymentModel.findById(id).lean().exec();
  const periodsFor = (id: string) =>
    periodModel
      .find({
        source: SubscriptionSource.PAYMENT,
        sourceReference: `payment:${id}`,
      })
      .lean()
      .exec();
  const notify = (
    body: unknown,
    options: { ageSeconds?: number; secret?: string; tamper?: boolean } = {},
  ) => {
    clearThrottle();
    const s = signed(body, options.ageSeconds, options.secret);
    return request(server())
      .post('/payments/webhooks/saspay')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', s.signature)
      .set('X-Webhook-Timestamp', s.timestamp)
      .set('X-Webhook-Event', (body as { event: string }).event)
      .send(options.tamper ? s.raw.replace('PAIEMENT', 'PAIEMENT ') : s.raw);
  };
  const event = (transactionId: string, name = 'transaction.success') => ({
    event: name,
    data: {
      id: transactionId,
      reference: 'TXN-x',
      type: 'PAIEMENT',
      status: 'SUCCESS',
      amount: '3000.00',
      currency: 'XAF',
    },
  });

  async function pendingPayment(token: string) {
    const res = await create(token);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    const stored = await doc(res.body.paymentId as string);
    return {
      id: res.body.paymentId as string,
      reference: res.body.reference as string,
      sessionId: stored!.providerReference!,
      body: res.body as Record<string, unknown>,
    };
  }

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      process.env.MONGODB_URI = validatedEphemeralUri(replSet);
      process.env.JWT_SECRET = TEST_JWT_SECRET;
      process.env.CORS_ORIGIN = 'https://saspay-e2e.example.com';
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
      moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EMAIL_SENDER)
        .useValue(emailSender)
        .overrideProvider(PAYMENT_PROVIDER)
        .useValue(provider)
        .overrideProvider(PAYMENT_CONFIRMATION_PROVIDERS)
        .useValue([provider])
        .overrideProvider(SASPAY_WEBHOOK_CONFIG)
        .useValue({ enabled: true, secret: WEBHOOK_SECRET })
        .overrideProvider(PAYMENT_RETURN_ORIGIN)
        .useValue(RETURN_ORIGIN)
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
      const connection = moduleFixture.get(getConnectionToken());
      await ensureSubscriptionPeriodIndexes(connection);
      await ensureSubscriptionPaymentIndexes(connection);
      await ensureReconciliationIndexes(connection);
      paymentModel = moduleFixture.get(getModelToken(SubscriptionPayment.name));
      periodModel = moduleFixture.get(getModelToken(SubscriptionPeriod.name));
      payments = moduleFixture.get(SubscriptionPaymentsService);
    } catch (error) {
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  beforeEach(() => {
    fake.envelope = true;
    fake.nextCreate = 'normal';
    fake.statusOutage = false;
    fake.inconsistentStatusRoute = false;
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  // ─── Création ──────────────────────────────────────────────────────────────

  it('1. capacités : page hébergée ; création sans numéro, valeurs serveur, page validée, aucun secret renvoyé', async () => {
    const o = await owner('create');
    const caps = await request(server())
      .get(`${base}/capabilities`)
      .set('Authorization', `Bearer ${o.token}`);
    expect(caps.body).toEqual({ available: true, method: 'hosted-checkout' });

    const p = await pendingPayment(o.token);
    expect(p.body.payerPhoneMasked).toBeNull();
    expect(String(p.body.checkoutUrl)).toMatch(
      /^https:\/\/pay\.saspay\.me\/checkout\/[0-9a-f]+$/,
    );
    expect(JSON.stringify(p.body)).not.toContain(FAKE_SASPAY_KEY);
    const session = fake.sessions.get(p.sessionId)!;
    expect(session).toMatchObject({
      amount: '3000.00',
      currency: 'XAF',
      customer_email: o.email,
      customer_name: expect.stringContaining('Gérant'),
      return_url: `${RETURN_ORIGIN}/app/organization/subscription?payment=${p.id}`,
      metadata: { merchantReference: p.reference },
    });
    expect(session.description).toContain(p.reference);
    const stored = await doc(p.id);
    expect(stored).toMatchObject({
      provider: 'saspay',
      status: 'pending',
      open: true,
      amount: 3000,
      payerPhoneMasked: null,
    });
  });

  it('2. rejeu du même UUID : même paiement, aucune seconde session ; créations concurrentes : une seule ouverte', async () => {
    const o = await owner('replay');
    const op = randomUUID();
    const first = await create(o.token, { clientOperationId: op });
    const again = await create(o.token, { clientOperationId: op });
    expect(again.status).toBe(201);
    expect(again.body.replayed).toBe(true);
    expect(again.body.paymentId).toBe(first.body.paymentId);
    expect(again.body.checkoutUrl).toBe(first.body.checkoutUrl);
    expect(
      [...fake.sessions.values()].filter(
        (s) => s.metadata.merchantReference === first.body.reference,
      ),
    ).toHaveLength(1);

    const other = await owner('concurrent');
    const before = fake.sessions.size;
    const results = await Promise.all([1, 2, 3].map(() => create(other.token)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      results.filter((r) => r.body.code === 'PAYMENT_ALREADY_PENDING').length,
    ).toBe(2);
    expect(fake.sessions.size - before).toBe(1);
  });

  it('3. réponse perdue : incertain, aucune seconde session au rejeu ; vérification → session retrouvée par metadata et adoptée', async () => {
    const o = await owner('lost');
    const op = randomUUID();
    fake.nextCreate = 'lost-after-create';
    const lost = await create(o.token, { clientOperationId: op });
    expect(lost.status).toBe(201);
    expect(lost.body.status).toBe('uncertain');
    expect(lost.body.checkoutUrl).toBeNull();
    const replay = await create(o.token, { clientOperationId: op });
    expect(replay.body.replayed).toBe(true);
    expect(fake.sessionByReference(lost.body.reference)).toBeDefined();
    const created = [...fake.sessions.values()].filter(
      (s) => s.metadata.merchantReference === lost.body.reference,
    );
    expect(created).toHaveLength(1);

    const adopted = await refresh(o.token, lost.body.paymentId);
    expect(adopted.status).toBe(200);
    expect(adopted.body.status).toBe('pending');
    expect(adopted.body.checkoutUrl).toMatch(/^https:\/\/pay\.saspay\.me\//);
    expect((await doc(lost.body.paymentId))!.providerReference).toBe(
      created[0].id,
    );
  });

  it('4. réponse perdue sans session trouvée, ou 500 après création : reste incertain, aucune nouvelle session ; refus 422 : échec sans session', async () => {
    const o = await owner('notfound');
    fake.nextCreate = 'lost-after-create';
    const lost = await create(o.token);
    const session = fake.sessionByReference(lost.body.reference)!;
    fake.sessions.delete(session.id); // introuvable dans les pages lues
    const before = fake.sessions.size;
    const still = await refresh(o.token, lost.body.paymentId);
    expect(still.body.status).toBe('uncertain');
    expect(fake.sessions.size).toBe(before);
    expect(fake.count('POST', '/checkout-sessions/')).toBeGreaterThan(0);

    const o2 = await owner('err500');
    fake.nextCreate = 'error-500-after-create';
    const r500 = await create(o2.token);
    expect(r500.body.status).toBe('uncertain');

    const o3 = await owner('reject');
    fake.nextCreate = 'reject-422';
    const rejected = await create(o3.token);
    expect(rejected.body.status).toBe('failed');

    const o4 = await owner('foreign-url');
    fake.nextCreate = 'foreign-checkout-url';
    const foreign = await create(o4.token);
    expect(foreign.body.status).toBe('uncertain');
    expect(foreign.body.checkoutUrl).toBeNull();
  });

  it('5. correspondances multiples : jamais départagées → vérification opérateur', async () => {
    const o = await owner('ambiguous');
    fake.nextCreate = 'lost-after-create';
    const lost = await create(o.token);
    fake.addForeignSession(lost.body.reference);
    const res = await refresh(o.token, lost.body.paymentId);
    expect(res.body.status).toBe('review');
    expect((await doc(lost.body.paymentId))!.incidentCode).toBe(
      'provider_inconsistent',
    );
  });

  it('6. recherche bornée : au plus 5 pages lues ; au-delà, aucune preuve d’absence (reste incertain)', async () => {
    const o = await owner('bounded');
    fake.nextCreate = 'lost-after-create';
    const lost = await create(o.token);
    for (let i = 0; i < 100 * SASPAY_LOOKUP_MAX_PAGES + 5; i += 1) {
      fake.addForeignSession(`SMOTHER${i}`);
    }
    const listed = () =>
      fake.calls.filter(
        (c) => c.method === 'GET' && c.path === '/checkout-sessions/',
      ).length;
    const before = listed();
    const res = await refresh(o.token, lost.body.paymentId);
    expect(res.body.status).toBe('uncertain');
    expect(listed() - before).toBe(SASPAY_LOOKUP_MAX_PAGES);
    // Nettoyage : sessions étrangères retirées pour les tests suivants.
    for (const [id, s] of fake.sessions) {
      if (String(s.metadata.merchantReference).startsWith('SMOTHER')) {
        fake.sessions.delete(id);
      }
    }
  });

  // ─── Confirmation ──────────────────────────────────────────────────────────

  it('7. succès vérifié par les trois routes : une période, transaction rattachée, page retirée de la vue', async () => {
    const o = await owner('success');
    const p = await pendingPayment(o.token);
    const tx = fake.attempt(p.sessionId, 'SUCCESS');
    const res = await refresh(o.token, p.id);
    expect(res.body.status).toBe('succeeded');
    expect(res.body.checkoutUrl).toBeNull();
    expect(await periodsFor(p.id)).toHaveLength(1);
    expect((await doc(p.id))!.providerTransactionId).toBe(tx);
    // Rejeu : aucune seconde période.
    expect((await refresh(o.token, p.id)).body.status).toBe('succeeded');
    expect(await periodsFor(p.id)).toHaveLength(1);
  });

  it('8. attente, tentative échouée sur page ouverte, page expirée (vérification), succès tardif accepté', async () => {
    const o = await owner('states');
    const p = await pendingPayment(o.token);
    const tx = fake.attempt(p.sessionId, 'PENDING');
    expect((await refresh(o.token, p.id)).body.status).toBe('pending');
    fake.settle(tx, 'FAILED');
    const failedOnOpenPage = await refresh(o.token, p.id);
    expect(failedOnOpenPage.body.status).toBe('pending');
    expect(failedOnOpenPage.body.checkoutUrl).not.toBeNull();

    fake.close(p.sessionId, 'EXPIRED');
    const closed = await refresh(o.token, p.id);
    expect(closed.body.status).toBe('uncertain');
    expect(closed.body.checkoutUrl).toBeNull();
    expect(await doc(p.id)).toMatchObject({
      open: true,
      incidentCode: 'checkout_unresolved',
    });
    // Aucune nouvelle tentative libérée automatiquement.
    expect((await create(o.token)).body.code).toBe('PAYMENT_ALREADY_PENDING');

    // Succès tardif (hypothèse à vérifier en bac à sable) : attribué.
    fake.settle(tx, 'SUCCESS');
    const late = await refresh(o.token, p.id);
    expect(late.body.status).toBe('succeeded');
    expect(await periodsFor(p.id)).toHaveLength(1);
  });

  it('9. discordances → vérification, jamais d’attribution : débit ≠ prix, devise, metadata absente, transaction désignée différemment', async () => {
    const cases: Array<(sessionId: string) => void> = [
      (s) => fake.attempt(s, 'SUCCESS', { debited: '3053.00' }),
      (s) => fake.attempt(s, 'SUCCESS', { currency: 'XOF' }),
      (s) => {
        fake.sessions.get(s)!.metadata = {};
        fake.attempt(s, 'SUCCESS');
      },
      (s) => {
        fake.attempt(s, 'SUCCESS');
        fake.inconsistentStatusRoute = true;
      },
    ];
    for (const prepare of cases) {
      fake.inconsistentStatusRoute = false;
      const o = await owner('mismatch');
      const p = await pendingPayment(o.token);
      prepare(p.sessionId);
      const res = await refresh(o.token, p.id);
      expect(res.body.status).toBe('review');
      expect(await periodsFor(p.id)).toHaveLength(0);
    }
  });

  it('10. confirmations concurrentes (refresh ×5, webhooks ×3, moteur ×2) : une seule période', async () => {
    const o = await owner('race');
    const p = await pendingPayment(o.token);
    const tx = fake.attempt(p.sessionId, 'SUCCESS');
    await Promise.all([
      ...[1, 2, 3, 4, 5].map(() => refresh(o.token, p.id)),
      ...[1, 2, 3].map(() => notify(event(tx))),
      payments.confirmPayment(new Types.ObjectId(p.id)),
      payments.confirmPayment(new Types.ObjectId(p.id)),
    ]);
    expect((await doc(p.id))!.status).toBe('succeeded');
    expect(await periodsFor(p.id)).toHaveLength(1);
  });

  // ─── Webhook ───────────────────────────────────────────────────────────────

  it('11. webhook : signature invalide, corps altéré, horodatage hors tolérance → 401, aucune lecture', async () => {
    const calls = fake.calls.length;
    expect(
      (await notify(event(randomUUID()), { secret: 'autre-secret-0000000' }))
        .status,
    ).toBe(401);
    expect((await notify(event(randomUUID()), { tamper: true })).status).toBe(
      401,
    );
    expect(
      (await notify(event(randomUUID()), { ageSeconds: 301 })).status,
    ).toBe(401);
    expect(fake.calls.length).toBe(calls);
  });

  it('12. webhook arrivé AVANT le rattachement : rapprochement borné, rattachement puis attribution ; rejeu : sans effet', async () => {
    const o = await owner('early');
    const p = await pendingPayment(o.token);
    const tx = fake.attempt(p.sessionId, 'SUCCESS');
    expect((await doc(p.id))!.providerTransactionId).toBeNull();
    const res = await notify(event(tx));
    expect(res.status).toBe(200);
    expect(await doc(p.id)).toMatchObject({
      status: 'succeeded',
      providerTransactionId: tx,
    });
    expect((await notify(event(tx))).status).toBe(200);
    expect(await periodsFor(p.id)).toHaveLength(1);
  });

  it('13. webhook : transaction étrangère sans candidat → accusé ; événement hors transaction → accusé ; panne SasPay → 503 temporaire, état conservé', async () => {
    // Aucun paiement candidat récent sans transaction : accusé.
    await paymentModel
      .updateMany(
        { provider: 'saspay', providerTransactionId: null, open: true },
        { $set: { initiatedAt: new Date(Date.now() - 48 * 3600 * 1000) } },
      )
      .exec();
    expect((await notify(event(randomUUID()))).status).toBe(200);
    expect(
      (await notify({ event: 'wallet_transfer.completed', data: { id: 'x' } }))
        .status,
    ).toBe(200);

    const o = await owner('outage');
    const p = await pendingPayment(o.token);
    const tx = fake.attempt(p.sessionId, 'SUCCESS');
    fake.statusOutage = true;
    const res = await notify(event(tx));
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('60');
    expect((await doc(p.id))!.status).toBe('pending');
    fake.statusOutage = false;
    expect((await notify(event(tx))).status).toBe(200);
    expect((await doc(p.id))!.status).toBe('succeeded');
  });

  it('14. base indisponible pendant le webhook → 503 (SasPay renverra)', async () => {
    const spy = jest
      .spyOn(payments, 'findByProviderTransaction')
      .mockRejectedValueOnce(new Error('base indisponible'));
    try {
      expect((await notify(event(randomUUID()))).status).toBe(503);
    } finally {
      spy.mockRestore();
    }
  });

  it('15. enveloppe absente (exemples documentés) : même résultat', async () => {
    fake.envelope = false;
    const o = await owner('bare');
    const p = await pendingPayment(o.token);
    fake.attempt(p.sessionId, 'SUCCESS');
    expect((await refresh(o.token, p.id)).body.status).toBe('succeeded');
  });

  it('16. une transaction ne sert jamais deux paiements (index unique)', async () => {
    const a = await owner('dupA');
    const pa = await pendingPayment(a.token);
    const tx = fake.attempt(pa.sessionId, 'PENDING');
    expect((await refresh(a.token, pa.id)).body.status).toBe('pending');
    const b = await owner('dupB');
    const pb = await pendingPayment(b.token);
    // Session de B désignant (à tort) la transaction de A.
    fake.sessions.get(pb.sessionId)!.transaction = tx;
    const res = await refresh(b.token, pb.id);
    expect(res.body.status).toBe('review');
    expect((await doc(pb.id))!.providerTransactionId).toBeNull();
  });

  it('17. procédure opérateur : page close sans succès → plan bloqué ; clôture explicite (--close-unresolved) → échec, nouvelle tentative possible', async () => {
    const o = await owner('operator');
    const p = await pendingPayment(o.token);
    fake.close(p.sessionId, 'EXPIRED');
    expect((await refresh(o.token, p.id)).body.status).toBe('uncertain');
    const reconciliation = moduleFixture.get(PaymentReconciliationService);
    const blocked = await reconciliation.plan(p.id, null);
    expect(blocked).toMatchObject({
      decision: 'blocked',
      reason: 'provider-unresolved',
    });
    const ready = await reconciliation.plan(p.id, null, {
      closeUnresolved: true,
    });
    expect(ready).toMatchObject({ decision: 'ready', action: 'fail' });
    if (ready.decision !== 'ready') throw new Error('plan');
    const applied = await reconciliation.apply(
      p.id,
      null,
      {
        operationId: randomUUID(),
        operatorId: 'ops.e2e',
        reasonCode: ReconciliationReason.PROVIDER_CHECKOUT_CLOSED,
        reasonTicket: null,
        planToken: ready.planToken,
      },
      { closeUnresolved: true },
    );
    expect(applied).toMatchObject({ result: 'applied', action: 'fail' });
    expect(await doc(p.id)).toMatchObject({ status: 'failed', open: false });
    expect(await periodsFor(p.id)).toHaveLength(0);
    // Option sans objet sur un paiement non concerné : refus.
    const other = await owner('operator2');
    const q = await pendingPayment(other.token);
    expect(
      await reconciliation.plan(q.id, null, { closeUnresolved: true }),
    ).toMatchObject({ decision: 'blocked' });
    expect((await create(o.token)).status).toBe(201);
  });
});
