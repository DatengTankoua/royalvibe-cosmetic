import 'reflect-metadata';
import { randomUUID } from 'crypto';
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
import { ensureSubscriptionPeriodIndexes } from './../src/subscriptions/subscription-period-indexes';
import {
  SubscriptionPayment,
  SubscriptionPaymentDocument,
  SubscriptionPaymentStatus,
} from './../src/subscriptions/payments/schemas/subscription-payment.schema';
import { ensureSubscriptionPaymentIndexes } from './../src/subscriptions/payments/subscription-payment-indexes';
import {
  PAYMENT_CONFIRMATION_PROVIDERS,
  PAYMENT_PROVIDER,
  UnavailablePaymentProvider,
} from './../src/subscriptions/payments/payment-provider';
import { SasPayPaymentProvider } from './../src/subscriptions/payments/saspay/saspay-payment-provider';
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
import { FAKE_SASPAY_KEY, FakeSasPay } from './e2e/fake-saspay';

/**
 * 1-21B — Nouvelles tentatives DÉSACTIVÉES (fournisseur par défaut,
 * `PAYMENT_PROVIDER_ACTIVE=none`) mais SasPay configuré pour CONFIRMER : les
 * paiements laissés par un processus précédent (redémarrage) aboutissent ;
 * un paiement CamPay n'est jamais traité par SasPay.
 */

const PASSWORD = 'pay-21b-only-pw-!1x';
const fake = new FakeSasPay();
const saspay = new SasPayPaymentProvider({
  environment: 'sandbox',
  secretKey: FAKE_SASPAY_KEY,
  transport: fake.transport,
});

describe('Confirmations SasPay sans nouvelles tentatives (e2e 1-21B)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let paymentModel: Model<SubscriptionPaymentDocument>;
  let seq = 0;
  const emailSender = createE2eEmailSender();
  const base = '/organizations/current/subscription/payments';
  const server = () => app.getHttpServer();
  const clearThrottle = () =>
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();

  async function owner() {
    clearThrottle();
    seq += 1;
    const email = `only-${seq}-21b@pay.test`;
    const reg = await postRegister(app, {
      ...OWNER_TERMS,
      name: 'Gérant',
      email,
      password: PASSWORD,
      organizationName: `Boutique ${seq}`,
    });
    expect(reg.status).toBe(202);
    clearThrottle();
    const login = await request(server())
      .post('/auth/login')
      .send({ email, password: PASSWORD });
    const orgId = reg.owner!.organization._id;
    const userId = String(
      (await moduleFixture
        .get<Model<{ email: string }>>(getModelToken('User'))
        .findOne({ email })
        .lean()
        .exec())!._id,
    );
    return { orgId, userId, token: login.body.access_token as string };
  }

  /** Paiement OUVERT laissé en base par un processus précédent. */
  async function seed(
    o: { orgId: string; userId: string },
    fields: Partial<SubscriptionPayment>,
  ): Promise<{ id: string; reference: string }> {
    const _id = new Types.ObjectId();
    const reference = `SM${_id.toHexString().toUpperCase()}`;
    await paymentModel.create({
      _id,
      organizationId: new Types.ObjectId(o.orgId),
      requestedBy: new Types.ObjectId(o.userId),
      clientOperationId: randomUUID(),
      requestFingerprint: 'seeded',
      term: 'monthly',
      amount: 3000,
      currency: 'XAF',
      pricingVersion: 1,
      merchantReference: reference,
      providerReference: null,
      status: SubscriptionPaymentStatus.PENDING,
      open: true,
      payerPhoneMasked: null,
      initiatedAt: new Date(),
      ...fields,
    });
    return { id: _id.toHexString(), reference };
  }

  const refresh = (token: string, id: string) => {
    clearThrottle();
    return request(server())
      .post(`${base}/${id}/refresh`)
      .set('Authorization', `Bearer ${token}`);
  };

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      process.env.MONGODB_URI = validatedEphemeralUri(replSet);
      process.env.JWT_SECRET = 'saspay-only-21b-e2e-secret';
      process.env.CORS_ORIGIN = 'https://saspay-only.example.com';
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
      moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EMAIL_SENDER)
        .useValue(emailSender)
        .overrideProvider(PAYMENT_CONFIRMATION_PROVIDERS)
        .useValue([saspay])
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
      paymentModel = moduleFixture.get(getModelToken(SubscriptionPayment.name));
    } catch (error) {
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  it('1. fournisseur des nouvelles tentatives : indisponible → création 503, capacités indisponibles', async () => {
    expect(moduleFixture.get(PAYMENT_PROVIDER)).toBeInstanceOf(
      UnavailablePaymentProvider,
    );
    const o = await owner();
    clearThrottle();
    const created = await request(server())
      .post(base)
      .set('Authorization', `Bearer ${o.token}`)
      .send({ term: 'monthly', clientOperationId: randomUUID() });
    expect(created.status).toBe(503);
    expect(created.body.code).toBe('PAYMENT_SERVICE_UNAVAILABLE');
    const caps = await request(server())
      .get(`${base}/capabilities`)
      .set('Authorization', `Bearer ${o.token}`);
    expect(caps.body).toEqual({ available: false, method: null });
  });

  it('2. paiement SasPay laissé par un processus précédent : confirmé après redémarrage', async () => {
    const o = await owner();
    const placeholder = await seed(o, { provider: 'saspay' });
    const sessionId = fake.addForeignSession(placeholder.reference);
    await paymentModel
      .updateOne(
        { _id: placeholder.id },
        { $set: { providerReference: sessionId } },
      )
      .exec();
    fake.attempt(sessionId, 'SUCCESS');
    const res = await refresh(o.token, placeholder.id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('succeeded');
  });

  it('3. réponse perdue avant le redémarrage : session retrouvée par metadata, adoptée', async () => {
    const o = await owner();
    const lost = await seed(o, {
      provider: 'saspay',
      status: SubscriptionPaymentStatus.UNCERTAIN,
      initiatedAt: null,
    });
    const sessionId = fake.addForeignSession(lost.reference);
    const res = await refresh(o.token, lost.id);
    expect(res.body.status).toBe('pending');
    expect(
      (await paymentModel.findById(lost.id).lean().exec())!.providerReference,
    ).toBe(sessionId);
  });

  it('4. paiement CamPay ouvert : jamais traité par SasPay (503, aucun appel)', async () => {
    const o = await owner();
    const campay = await seed(o, {
      provider: 'campay',
      providerReference: randomUUID(),
    });
    const calls = fake.calls.length;
    const res = await refresh(o.token, campay.id);
    expect(res.status).toBe(503);
    expect(fake.calls.length).toBe(calls);
    expect((await paymentModel.findById(campay.id).lean().exec())!.status).toBe(
      'pending',
    );
  });

  it('5. webhook SasPay désactivé sans secret (défaut) : 503 sans lecture', async () => {
    const calls = fake.calls.length;
    const res = await request(server())
      .post('/payments/webhooks/saspay')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ event: 'transaction.success', data: {} }));
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PAYMENT_WEBHOOK_DISABLED');
    expect(fake.calls.length).toBe(calls);
  });
});
