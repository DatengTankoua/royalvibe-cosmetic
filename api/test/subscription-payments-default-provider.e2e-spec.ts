import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { Connection, Model, Types } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { ensureSubscriptionPeriodIndexes } from './../src/subscriptions/subscription-period-indexes';
import { SUBSCRIPTION_CLOCK } from './../src/subscriptions/subscription-clock';
import { SubscriptionTerm } from './../src/subscriptions/subscription-terms';
import {
  SubscriptionPayment,
  SubscriptionPaymentDocument,
  SubscriptionPaymentStatus,
} from './../src/subscriptions/payments/schemas/subscription-payment.schema';
import { ensureSubscriptionPaymentIndexes } from './../src/subscriptions/payments/subscription-payment-indexes';
import {
  PAYMENT_PROVIDER,
  UnavailablePaymentProvider,
} from './../src/subscriptions/payments/payment-provider';
import {
  computePaymentRequestFingerprint,
  derivePaymentFingerprintKey,
  merchantReferenceFor,
} from './../src/subscriptions/payments/payment-request';
import { API_APPLICATION_OPTIONS } from './../src/common/application-options';
import {
  CAMPAY_WEBHOOK_CONFIG,
  DISABLED_CAMPAY_WEBHOOK,
} from './../src/subscriptions/payments/campay/campay-webhook.config';
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
 * E2E 1-14D.2B — fournisseur de paiement PAR DÉFAUT (aucun `overrideProvider`
 * de `PAYMENT_PROVIDER`) : c'est la configuration de production tant
 * qu'aucun adaptateur réel n'est branché. Fichier séparé : une seule
 * application Nest par processus de test (stratégie Passport globale).
 *
 * 1-14D.2F : même configuration de production pour le webhook CamPay
 * (désactivé par défaut, options de bootstrap de `main.ts`).
 */

const TEST_JWT_SECRET = 'subscription-payments-default-14d2b-e2e-secret';
const PASSWORD = 'pay-default-14d2b-pw-!1x';
const T0 = new Date('2026-03-01T09:00:00.000Z').getTime();
const testClock = () => new Date(T0);

describe('Paiements : fournisseur par défaut indisponible (e2e 1-14D.2B)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let paymentModel: Model<SubscriptionPaymentDocument>;
  const emailSender = createE2eEmailSender();

  const server = () => app.getHttpServer();
  const clearThrottle = () =>
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();
  const call = (method: 'get' | 'post', path: string, token: string) =>
    request(server())[method](path).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      process.env.MONGODB_URI = validatedEphemeralUri(replSet);
      process.env.JWT_SECRET = TEST_JWT_SECRET;
      process.env.CORS_ORIGIN = 'https://payments-default-e2e.example.com';
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';

      moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EMAIL_SENDER)
        .useValue(emailSender)
        .overrideProvider(SUBSCRIPTION_CLOCK)
        .useValue(testClock)
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
    } catch (error) {
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  it('fournisseur injecté par défaut : indisponible', () => {
    const provider: unknown = moduleFixture.get(PAYMENT_PROVIDER);
    expect(provider).toBeInstanceOf(UnavailablePaymentProvider);
  });

  it('nouvelle initiation et consultation → 503, aucune écriture ; lectures locales et rejeu disponibles', async () => {
    clearThrottle();
    const email = `owner-default-14d2b@pay.test`;
    const reg = await postRegister(app, {
      ...OWNER_TERMS,
      name: 'Owner',
      email,
      password: PASSWORD,
      organizationName: 'Org default',
    });
    expect(reg.status).toBe(202);
    const orgId = String(reg.owner!.organization._id);
    clearThrottle();
    const login = await request(server())
      .post('/auth/login')
      .send({ email, password: PASSWORD });
    const token = String(login.body.access_token);
    const ownerUser = await moduleFixture
      .get<Model<{ email: string }>>(getModelToken('User'))
      .findOne({ email })
      .lean()
      .exec();
    const owner = String(ownerUser?._id);

    const refused = await call(
      'post',
      '/organizations/current/subscription/payments',
      token,
    ).send({
      term: 'monthly',
      payerPhone: '677123456',
      clientOperationId: randomUUID(),
    });
    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe('PAYMENT_SERVICE_UNAVAILABLE');
    expect(refused.headers['cache-control']).toBe('no-store');
    expect(
      await paymentModel.countDocuments({
        organizationId: new Types.ObjectId(orgId),
      }),
    ).toBe(0);

    // Fixture : paiement ouvert créé quand un prestataire était disponible.
    const _id = new Types.ObjectId();
    const clientOperationId = randomUUID();
    await paymentModel.create({
      _id,
      organizationId: new Types.ObjectId(orgId),
      requestedBy: new Types.ObjectId(owner),
      clientOperationId,
      requestFingerprint: computePaymentRequestFingerprint(
        derivePaymentFingerprintKey(TEST_JWT_SECRET),
        {
          requestedBy: owner,
          term: SubscriptionTerm.MONTHLY,
          payerPhone: '237677123456',
        },
      ),
      term: SubscriptionTerm.MONTHLY,
      amount: 3000,
      currency: 'XAF',
      pricingVersion: 1,
      provider: 'simulated',
      merchantReference: merchantReferenceFor(_id),
      providerReference: 'SIM-FIXTURE',
      status: SubscriptionPaymentStatus.PENDING,
      open: true,
      payerPhoneMasked: '+237 6•• ••• •56',
    });
    const before = await paymentModel.findById(_id).lean().exec();

    const read = await call(
      'get',
      `/organizations/current/subscription/payments/${_id.toHexString()}`,
      token,
    );
    expect(read.status).toBe(200);
    expect(read.body.status).toBe('pending');
    const list = await call(
      'get',
      '/organizations/current/subscription/payments',
      token,
    );
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);

    clearThrottle();
    const refreshed = await call(
      'post',
      `/organizations/current/subscription/payments/${_id.toHexString()}/refresh`,
      token,
    );
    expect(refreshed.status).toBe(503);
    expect(refreshed.body.code).toBe('PAYMENT_SERVICE_UNAVAILABLE');

    // Rejeu local de l'opération existante : même paiement, aucun réseau.
    clearThrottle();
    const replay = await call(
      'post',
      '/organizations/current/subscription/payments',
      token,
    ).send({ term: 'monthly', payerPhone: '677123456', clientOperationId });
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({
      paymentId: _id.toHexString(),
      replayed: true,
    });

    expect(await paymentModel.findById(_id).lean().exec()).toEqual(before);
    expect(
      await paymentModel.countDocuments({
        organizationId: new Types.ObjectId(orgId),
      }),
    ).toBe(1);
  });

  it('webhook CamPay (1-14D.2F) DÉSACTIVÉ par défaut : 503 sans lecture, sans base ni prestataire, quels que soient query, en-têtes ou environnement', async () => {
    expect(moduleFixture.get(CAMPAY_WEBHOOK_CONFIG)).toBe(
      DISABLED_CAMPAY_WEBHOOK,
    );
    // Fixture : paiement CamPay en attente (référence persistée).
    const _id = new Types.ObjectId();
    const reference = randomUUID();
    await paymentModel.create({
      _id,
      organizationId: new Types.ObjectId(),
      requestedBy: new Types.ObjectId(),
      clientOperationId: randomUUID(),
      requestFingerprint: 'f'.repeat(64),
      term: SubscriptionTerm.MONTHLY,
      amount: 3000,
      currency: 'XAF',
      pricingVersion: 1,
      provider: 'campay',
      merchantReference: merchantReferenceFor(_id),
      providerReference: reference,
      status: SubscriptionPaymentStatus.PENDING,
      open: true,
      payerPhoneMasked: '+237 6•• ••• •56',
    });
    const before = await paymentModel.findById(_id).lean().exec();
    const provider =
      moduleFixture.get<UnavailablePaymentProvider>(PAYMENT_PROVIDER);
    const fetchStatus = jest.spyOn(provider, 'fetchStatus');
    const findOne = jest.spyOn(paymentModel, 'findOne');
    const findById = jest.spyOn(paymentModel, 'findById');
    // Une variable d'environnement n'active rien (jamais lue par le webhook).
    process.env.CAMPAY_WEBHOOK_KEY = 'fake-campay-webhook-key-14d2f-env';
    process.env.CAMPAY_WEBHOOK_ENABLED = 'true';
    const params = {
      status: 'SUCCESSFUL',
      reference,
      amount: '3000',
      currency: 'XAF',
      signature: 'e30.e30.' + 'A'.repeat(43),
      endpoint: 'collect',
      external_reference: merchantReferenceFor(_id),
      phone_number: '237677123456',
    };
    try {
      const responses = [
        await request(server())
          .get('/payments/webhooks/campay')
          .query({ ...params, enabled: 'true', webhook: '1' }),
        await request(server())
          .post('/payments/webhooks/campay?enabled=true')
          .set('X-Webhook-Enabled', 'true')
          .set('Content-Type', 'application/json')
          .send(JSON.stringify(params)),
        await request(server())
          .post('/payments/webhooks/campay')
          .set('Content-Type', 'application/json')
          .send(JSON.stringify({ ...params, enabled: true })),
      ];
      for (const res of responses) {
        expect(res.status).toBe(503);
        expect(res.body).toEqual({
          statusCode: 503,
          code: 'PAYMENT_WEBHOOK_DISABLED',
          message: 'Notifications de paiement désactivées.',
        });
        expect(res.headers['cache-control']).toBe('no-store');
        expect(JSON.stringify(res.body)).not.toContain(params.signature);
      }
      expect(fetchStatus).not.toHaveBeenCalled();
      expect(findOne).not.toHaveBeenCalled();
      expect(findById).not.toHaveBeenCalled();
      expect(await paymentModel.findById(_id).lean().exec()).toEqual(before);
    } finally {
      delete process.env.CAMPAY_WEBHOOK_KEY;
      delete process.env.CAMPAY_WEBHOOK_ENABLED;
      fetchStatus.mockRestore();
      findOne.mockRestore();
      findById.mockRestore();
    }
  });

  it('webhook désactivé (1-14D.2F) : variantes de chemin et JSON malformé sans donnée sensible ni journal', async () => {
    const markers = [
      'FAKESIGMARKER7Q',
      '237699000111',
      'BODYSEC',
      'ignature',
      '?',
    ];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
      (method) => jest.spyOn(console, method).mockImplementation(),
    );
    try {
      for (const path of [
        '/PAYMENTS/WEBHOOKS/CAMPAY',
        '/payments/webhooks/campay/',
        '/Payments/Webhooks/Campay/',
      ]) {
        clearThrottle();
        const disabled = await request(server()).get(path).query({
          signature: 'FAKESIGMARKER7Q.a.b',
          phone_number: '237699000111',
        });
        expect(disabled.status).toBe(503);
        expect(disabled.body.code).toBe('PAYMENT_WEBHOOK_DISABLED');
        const malformed = await request(server())
          .post(`${path}?signature=FAKESIGMARKER7Q`)
          .set('Content-Type', 'application/json')
          .send(
            '{"signature":BODYSECRETMARKER9Z,"phone_number":"237699000111"}',
          );
        expect(malformed.status).toBe(400);
        expect(malformed.body.message).toBe(
          'Notification de paiement invalide.',
        );
        for (const res of [disabled, malformed]) {
          expect(res.headers['cache-control']).toBe('no-store');
          for (const marker of markers) expect(res.text).not.toContain(marker);
        }
      }
      for (const spy of spies) {
        const text = JSON.stringify(spy.mock.calls);
        for (const marker of markers.slice(0, 4)) {
          expect(text).not.toContain(marker);
        }
      }
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});
