import 'reflect-metadata';
import { createECDH, randomBytes, randomUUID } from 'crypto';
import { Connection, Model, Types, mongo } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { ThrottlerStorage } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { UserDocument, UserRole } from './../src/users/schemas/user.schema';
import { Organization } from './../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from './../src/organizations/schemas/organization.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import {
  DelegablePermission,
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
} from './../src/organizations/permissions';
import { Product } from './../src/products/schemas/product.schema';
import type { ProductDocument } from './../src/products/schemas/product.schema';
import { Section } from './../src/sections/schemas/section.schema';
import type { SectionDocument } from './../src/sections/schemas/section.schema';
import {
  SubscriptionPeriod,
  SubscriptionPeriodDocument,
} from './../src/subscriptions/schemas/subscription-period.schema';
import { ensureSubscriptionPeriodIndexes } from './../src/subscriptions/subscription-period-indexes';
import { ensureSubscriptionPaymentIndexes } from './../src/subscriptions/payments/subscription-payment-indexes';
import {
  MongooseSession,
  SubscriptionsService,
} from './../src/subscriptions/subscriptions.service';
import { PAYMENT_PROVIDER } from './../src/subscriptions/payments/payment-provider';
import { AuditService } from './../src/audit/audit.service';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import { PUSH_CLOCK, PushRuntime } from './../src/push/push-runtime';
import { PushOutboxService } from './../src/push/push-outbox.service';
import {
  PUSH_MAX_ATTEMPTS,
  PushDispatcherService,
} from './../src/push/push-dispatcher.service';
import { ensurePushIndexes } from './../src/push/push-indexes';
import type {
  PushSendOptions,
  PushSendResult,
  PushTarget,
  PushTransport,
} from './../src/push/push-transport';
import type { PushMessagePayload } from './../src/push/push-messages';
import {
  PushJob,
  PushJobDocument,
  PushJobStatus,
} from './../src/push/schemas/push-job.schema';
import {
  PushDelivery,
  PushDeliveryDocument,
  PushDeliveryStatus,
} from './../src/push/schemas/push-delivery.schema';
import {
  PushSubscriptionDocument,
  PushSubscriptionRecord,
  PushSubscriptionStatus,
} from './../src/push/schemas/push-subscription.schema';
import { PushCategory } from './../src/push/schemas/push-category';
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
import { postRegister } from './e2e/registration-fixtures';

/**
 * E2E 1-16A — notifications Web Push métier, sur le replica set éphémère
 * (garde anti-27017), AppModule réelle, prestataire de paiement SIMULÉ et
 * FAUX transport push (aucun réseau, aucune clé réelle : paire VAPID générée
 * par le test). Horloge des notifications contrôlée (`PUSH_CLOCK`) ; le
 * traitement de fond n'est JAMAIS démarré : chaque passe est explicite
 * (`runOnce`).
 */

const TEST_JWT_SECRET = 'web-push-16a-e2e-only';
const E2E_CORS_ORIGIN = 'https://web-push-16a-e2e.example.com';
const PASSWORD = 'wp-16a-pw-!1x';
const PHONE = '677123456';
const HOUR = 60 * 60 * 1000;

interface Sent {
  endpoint: string;
  payload: PushMessagePayload;
  options: PushSendOptions;
}

/** Faux transport : enregistre, répond selon un script par endpoint. */
class FakePushTransport implements PushTransport {
  readonly sent: Sent[] = [];
  private readonly script = new Map<string, Array<number | null | 'throw'>>();

  respond(endpoint: string, ...codes: Array<number | null | 'throw'>) {
    this.script.set(endpoint, [...(this.script.get(endpoint) ?? []), ...codes]);
  }

  reset() {
    this.sent.length = 0;
    this.script.clear();
  }

  to(endpoint: string): Sent[] {
    return this.sent.filter((s) => s.endpoint === endpoint);
  }

  /** La file est commune aux tests : assertions par organisation. */
  forOrg(organizationId: string): Sent[] {
    return this.sent.filter((s) => s.payload.aud.o === organizationId);
  }

  send(
    target: PushTarget,
    payload: string,
    options: PushSendOptions,
  ): Promise<PushSendResult> {
    this.sent.push({
      endpoint: target.endpoint,
      payload: JSON.parse(payload) as PushMessagePayload,
      options,
    });
    const next = this.script.get(target.endpoint)?.shift();
    if (next === 'throw') return Promise.reject(new Error('transport down'));
    if (next === null) {
      return Promise.resolve({ statusCode: null, error: 'network' });
    }
    return Promise.resolve({ statusCode: next ?? 201 });
  }
}

function vapidConfig() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    enabled: true as const,
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: ecdh.getPrivateKey().toString('base64url'),
    subject: 'mailto:e2e@example.com',
  };
}

function browserKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
}

const sim = new SimulatedPaymentProvider();
const transport = new FakePushTransport();
let now = new Date();
const setNow = (date: Date) => {
  now = new Date(date.getTime());
};
const advance = (ms: number) => setNow(new Date(now.getTime() + ms));

describe('Notifications Web Push métier (e2e 1-16A)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let connection: Connection;
  let userModel: Model<UserDocument>;
  let organizationModel: Model<OrganizationDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;
  let productModel: Model<ProductDocument>;
  let sectionModel: Model<SectionDocument>;
  let periodModel: Model<SubscriptionPeriodDocument>;
  let jobModel: Model<PushJobDocument>;
  let deliveryModel: Model<PushDeliveryDocument>;
  let subscriptionModel: Model<PushSubscriptionDocument>;
  let runtime: PushRuntime;
  let dispatcher: PushDispatcherService;
  let outbox: PushOutboxService;
  let subscriptions: SubscriptionsService;
  let seq = 0;
  const config = vapidConfig();
  const emailSender = createE2eEmailSender();

  const server = () => app.getHttpServer();
  const clearThrottle = () =>
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function login(email: string): Promise<string> {
    clearThrottle();
    const res = await request(server())
      .post('/auth/login')
      .send({ email, password: PASSWORD });
    expect(res.status).toBe(201);
    return res.body.access_token as string;
  }

  async function registerOwner(label: string) {
    clearThrottle();
    seq += 1;
    const email = `${label}-${seq}-16a@wp.test`;
    const reg = await postRegister(app, {
      ...OWNER_TERMS,
      name: 'Owner',
      email,
      password: PASSWORD,
      organizationName: `Org ${label} ${seq}`.slice(0, 20),
    });
    expect(reg.status).toBe(202);
    return {
      email,
      orgId: reg.owner!.organization._id,
      userId: String(reg.owner!.user._id),
      token: await login(email),
    };
  }

  async function seedMember(
    orgId: string,
    role: OrganizationRole.ADMIN | OrganizationRole.SELLER,
    permissions: DelegablePermission[] = [],
  ) {
    seq += 1;
    const email = `${role}-${seq}-16a@wp.test`;
    const user = await userModel.create({
      emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
      name: role,
      email,
      password: await bcrypt.hash(PASSWORD, 10),
      role: UserRole.SELLER,
    });
    const membership = await membershipModel.create({
      organizationId: new Types.ObjectId(orgId),
      userId: user._id,
      role,
      status: MembershipStatus.ACTIVE,
      permissions,
    });
    return {
      email,
      userId: user._id.toHexString(),
      membershipId: membership._id.toHexString(),
      token: await login(email),
    };
  }

  /** Appareil (navigateur) : endpoint FCM fictif, clés générées. */
  function device(label: string) {
    seq += 1;
    return {
      endpoint: `https://fcm.googleapis.com/fcm/send/${label}-${seq}`,
      keys: browserKeys(),
    };
  }

  function subscribe(
    token: string,
    browser: ReturnType<typeof device>,
    preferences?: Record<string, boolean>,
  ) {
    return request(server())
      .post('/notifications/push/subscription')
      .set(auth(token))
      .send({ subscription: browser, ...(preferences ? { preferences } : {}) });
  }

  /**
   * 1-16A.1 : cette suite couvre les catégories de 1-16A ; ses appareils
   * coupent les catégories ajoutées (couvertes par
   * `notification-center.e2e-spec.ts`).
   */
  async function subscribed(token: string, label: string) {
    const browser = device(label);
    const res = await subscribe(token, browser, {
      stockLow: false,
      saleCreated: false,
      monthlyReport: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.registered).toBe(true);
    return browser;
  }

  async function seedProduct(orgId: string, quantity: number) {
    seq += 1;
    const section = await sectionModel.create({
      organizationId: new Types.ObjectId(orgId),
      name: `Rayon ${seq}`,
      description: '',
    });
    const product = await productModel.create({
      organizationId: new Types.ObjectId(orgId),
      sectionId: section._id,
      name: `Produit ${seq}`,
      imageUrl: 'https://e2e.local/img.png',
      purchasePrice: 100,
      salePrice: 400,
      initialQuantity: quantity,
      remainingQuantity: quantity,
    });
    return product._id.toHexString();
  }

  const sell = (
    token: string,
    productId: string,
    quantity: number,
    clientOperationId?: string,
  ) =>
    request(server())
      .post('/sales')
      .set(auth(token))
      .send({
        productId,
        quantity,
        salePrice: 400,
        ...(clientOperationId ? { clientOperationId } : {}),
      });

  const restock = (token: string, productId: string, added: number) =>
    request(server())
      .patch(`/products/${productId}`)
      .set(auth(token))
      .field('additionalStock', String(added));

  // Événements des catégories 1-16A (les ventes portent aussi un produit).
  const jobsFor = (filter: Record<string, unknown>) =>
    jobModel
      .find({
        category: {
          $in: [
            PushCategory.STOCK_DEPLETED,
            PushCategory.SUBSCRIPTION_ENDING,
            PushCategory.PAYMENT_SUCCEEDED,
          ],
        },
        ...filter,
      })
      .lean()
      .exec();

  const pay = async (token: string) => {
    clearThrottle();
    const res = await request(server())
      .post('/organizations/current/subscription/payments')
      .set(auth(token))
      .send({
        term: 'monthly',
        payerPhone: PHONE,
        clientOperationId: randomUUID(),
      });
    expect(res.status).toBe(201);
    return res.body as { paymentId: string; reference: string };
  };
  const refresh = (token: string, paymentId: string) => {
    clearThrottle();
    return request(server())
      .post(`/organizations/current/subscription/payments/${paymentId}/refresh`)
      .set(auth(token));
  };

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      process.env.MONGODB_URI = validatedEphemeralUri(replSet);
      process.env.JWT_SECRET = TEST_JWT_SECRET;
      process.env.CORS_ORIGIN = E2E_CORS_ORIGIN;
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';

      moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EMAIL_SENDER)
        .useValue(emailSender)
        .overrideProvider(PAYMENT_PROVIDER)
        .useValue(sim)
        .overrideProvider(PUSH_CLOCK)
        .useValue(() => new Date(now.getTime()))
        .compile();
      app = moduleFixture.createNestApplication<INestApplication<App>>();
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
      productModel = moduleFixture.get(getModelToken(Product.name));
      sectionModel = moduleFixture.get(getModelToken(Section.name));
      periodModel = moduleFixture.get(getModelToken(SubscriptionPeriod.name));
      jobModel = moduleFixture.get(getModelToken(PushJob.name));
      deliveryModel = moduleFixture.get(getModelToken(PushDelivery.name));
      subscriptionModel = moduleFixture.get(
        getModelToken(PushSubscriptionRecord.name),
      );
      runtime = moduleFixture.get(PushRuntime);
      dispatcher = moduleFixture.get(PushDispatcherService);
      outbox = moduleFixture.get(PushOutboxService);
      subscriptions = moduleFixture.get(SubscriptionsService);
      await ensureSubscriptionPeriodIndexes(connection);
      await ensureSubscriptionPaymentIndexes(connection);
      expect(await ensurePushIndexes(connection)).toBe('created');
      expect(await ensurePushIndexes(connection)).toBe('already-present');
    } catch (error) {
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  beforeEach(() => {
    sim.reset();
    transport.reset();
    setNow(new Date());
    runtime.activate(config, transport);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app?.close();
    await stopEphemeralMongoSafe();
  });

  it('1. désactivé par défaut : configuration fermée, aucun enregistrement, aucun travail', async () => {
    runtime.deactivate();
    const a = await registerOwner('off');
    const cfg = await request(server())
      .get('/notifications/push/config')
      .set(auth(a.token));
    expect(cfg.status).toBe(200);
    expect(cfg.body).toEqual({
      enabled: false,
      publicKey: null,
      categories: [],
    });
    const res = await subscribe(a.token, device('off'));
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PUSH_DISABLED');

    const productId = await seedProduct(a.orgId, 1);
    expect((await sell(a.token, productId, 1)).status).toBe(201);
    expect(await jobsFor({ productId: new Types.ObjectId(productId) })).toEqual(
      [],
    );
    expect(await dispatcher.runOnce()).toMatchObject({ sent: 0 });
    expect(dispatcher.started).toBe(false);
  });

  it('2. consentement et isolation : catégories par rôle, endpoints validés, appareil invisible des autres titulaires', async () => {
    const a = await registerOwner('consent');
    const admin = await seedMember(a.orgId, OrganizationRole.ADMIN);
    const seller = await seedMember(a.orgId, OrganizationRole.SELLER);
    const unauthenticated = await request(server()).get(
      '/notifications/push/config',
    );
    expect(unauthenticated.status).toBe(401);

    const categories = async (token: string) =>
      (
        await request(server())
          .get('/notifications/push/config')
          .set(auth(token))
      ).body as { enabled: boolean; publicKey: string; categories: string[] };
    const ownerCfg = await categories(a.token);
    expect(ownerCfg.enabled).toBe(true);
    expect(ownerCfg.publicKey).toBe(config.publicKey);
    // 1-16A.1 : règle unique `canAccessCategory` ; 1-19A : nouveau membre
    // (`members.manage`) et activité des membres (propriétaire seul).
    expect(ownerCfg.categories).toEqual([
      'stock-depleted',
      'stock-low',
      'sale-created',
      'subscription-ending',
      'payment-succeeded',
      'monthly-report',
      'member-joined',
      'member-activity',
    ]);
    expect((await categories(admin.token)).categories).toEqual([
      'stock-depleted',
      'stock-low',
      'sale-created',
      'monthly-report',
      'member-joined',
    ]);
    expect((await categories(seller.token)).categories).toEqual([]);

    // Destinations refusées : hôte arbitraire, IP privée, http, clés invalides.
    for (const bad of [
      { endpoint: 'https://attacker.example.com/x', keys: browserKeys() },
      { endpoint: 'https://10.0.0.5/push', keys: browserKeys() },
      { endpoint: 'http://fcm.googleapis.com/fcm/send/x', keys: browserKeys() },
      {
        endpoint: 'https://fcm.googleapis.com/fcm/send/x',
        keys: { p256dh: 'AAAA', auth: 'BBBB' },
      },
    ]) {
      const res = await subscribe(a.token, bad);
      expect(res.status).toBe(400);
    }
    // Champ inconnu (organisation, utilisateur) : refusé par la validation.
    const forged = await request(server())
      .post('/notifications/push/subscription')
      .set(auth(a.token))
      .send({ subscription: device('x'), organizationId: a.orgId });
    expect(forged.status).toBe(400);
    expect(
      await subscriptionModel.countDocuments({
        organizationId: new Types.ObjectId(a.orgId),
      }),
    ).toBe(0);

    const browser = device('consent');
    expect((await subscribe(a.token, browser)).status).toBe(200);
    const record = await subscriptionModel
      .findOne({ userId: new Types.ObjectId(a.userId) })
      .lean()
      .exec();
    expect(String(record?.organizationId)).toBe(a.orgId);
    expect(record?.preferences).toEqual({
      stockDepleted: true,
      stockLow: true,
      saleCreated: true,
      subscriptionEnding: true,
      paymentSucceeded: true,
      monthlyReport: true,
      // 1-19A.
      memberJoined: true,
      memberActivity: true,
    });

    const status = (token: string) =>
      request(server())
        .post('/notifications/push/subscription/status')
        .set(auth(token))
        .send({ endpoint: browser.endpoint });
    expect((await status(a.token)).body).toMatchObject({ registered: true });
    // Un autre membre ne voit ni ne modifie l'appareil du propriétaire.
    expect((await status(admin.token)).body).toEqual({
      registered: false,
      preferences: null,
    });
    const foreignPatch = await request(server())
      .patch('/notifications/push/subscription')
      .set(auth(admin.token))
      .send({
        endpoint: browser.endpoint,
        preferences: { stockDepleted: false },
      });
    expect(foreignPatch.status).toBe(404);
    await request(server())
      .post('/notifications/push/subscription/remove')
      .set(auth(admin.token))
      .send({ endpoint: browser.endpoint })
      .expect(204);
    expect((await status(a.token)).body.registered).toBe(true);

    // Préférences du titulaire.
    const patch = await request(server())
      .patch('/notifications/push/subscription')
      .set(auth(a.token))
      .send({
        endpoint: browser.endpoint,
        preferences: { stockDepleted: false },
      });
    expect(patch.status).toBe(200);
    expect(patch.body.preferences).toEqual({
      stockDepleted: false,
      stockLow: true,
      saleCreated: true,
      subscriptionEnding: true,
      paymentSucceeded: true,
      monthlyReport: true,
      memberJoined: true,
      memberActivity: true,
    });
    // Aucune réponse ne renvoie l'endpoint ni les clés.
    expect(JSON.stringify(patch.body)).not.toContain('fcm.googleapis.com');

    // Désactivation : retrait de l'appareil.
    await request(server())
      .post('/notifications/push/subscription/remove')
      .set(auth(a.token))
      .send({ endpoint: browser.endpoint })
      .expect(204);
    expect((await status(a.token)).body.registered).toBe(false);
  });

  it('3. stock épuisé : une alerte après commit aux seuls membres autorisés de l’organisation ; réapprovisionnement → nouvelle alerte', async () => {
    const a = await registerOwner('stock');
    const admin = await seedMember(a.orgId, OrganizationRole.ADMIN);
    const seller = await seedMember(a.orgId, OrganizationRole.SELLER);
    const trusted = await seedMember(a.orgId, OrganizationRole.SELLER, [
      'products.view_stock_details',
    ]);
    const b = await registerOwner('stock-b');
    const devices = {
      owner: await subscribed(a.token, 'owner'),
      admin: await subscribed(admin.token, 'admin'),
      seller: await subscribed(seller.token, 'seller'),
      trusted: await subscribed(trusted.token, 'trusted'),
      ownerB: await subscribed(b.token, 'owner-b'),
    };
    const productId = await seedProduct(a.orgId, 3);
    const productB = await seedProduct(b.orgId, 5);

    // Vente partielle : pas de passage à zéro, aucun travail.
    expect((await sell(seller.token, productId, 1)).status).toBe(201);
    expect((await sell(b.token, productB, 5)).status).toBe(201);
    const partialJobs = await jobsFor({
      productId: new Types.ObjectId(productId),
    });
    expect(partialJobs).toEqual([]);

    // Passage réel 2 → 0 : un travail, aucun envoi avant la passe.
    expect((await sell(seller.token, productId, 2)).status).toBe(201);
    const jobs = await jobsFor({ productId: new Types.ObjectId(productId) });
    expect(jobs).toHaveLength(1);
    expect(transport.sent).toEqual([]);

    await dispatcher.runOnce();
    const receivers = new Set(transport.sent.map((s) => s.endpoint));
    expect(receivers.has(devices.owner.endpoint)).toBe(true);
    expect(receivers.has(devices.admin.endpoint)).toBe(true);
    expect(receivers.has(devices.trusted.endpoint)).toBe(true);
    expect(receivers.has(devices.seller.endpoint)).toBe(false);
    const ownerMessage = transport.to(devices.owner.endpoint)[0];
    expect(ownerMessage.payload).toEqual({
      v: 1,
      category: 'stock-depleted',
      title: 'Stock Master',
      body: 'Un produit est en rupture de stock.',
      url: `/app/catalog/products/${productId}`,
      tag: `stock-depleted:${productId}`,
      aud: { u: a.userId, o: a.orgId },
    });
    expect(ownerMessage.options.topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    // Organisation B : son propre épuisement, jamais celui de A.
    for (const s of transport.to(devices.ownerB.endpoint)) {
      expect(s.payload.url).toBe(`/app/catalog/products/${productB}`);
    }

    // Passe suivante : rien de plus (une alerte par passage à zéro).
    const sentBefore = transport.sent.length;
    await dispatcher.runOnce();
    expect(transport.sent.length).toBe(sentBefore);

    // Réapprovisionnement puis nouvel épuisement → nouvelle alerte.
    expect((await restock(a.token, productId, 1)).status).toBe(200);
    expect((await sell(seller.token, productId, 1)).status).toBe(201);
    await dispatcher.runOnce();
    expect(transport.to(devices.owner.endpoint)).toHaveLength(2);
    expect(
      await jobsFor({ productId: new Types.ObjectId(productId) }),
    ).toHaveLength(2);
  });

  it('3 bis (1-16G). langue du DESTINATAIRE : même alerte, texte de chacun ; ni celle de l’auteur de la vente ni celle du processus', async () => {
    const a = await registerOwner('stock-lang');
    const admin = await seedMember(a.orgId, OrganizationRole.ADMIN);
    const seller = await seedMember(a.orgId, OrganizationRole.SELLER);
    // L'administrateur choisit l'anglais ; le vendeur (auteur de la vente)
    // aussi, sans effet sur les autres destinataires.
    for (const token of [admin.token, seller.token]) {
      const res = await request(server())
        .put('/auth/me/locale')
        .set(auth(token))
        .send({ locale: 'en' });
      expect(res.status).toBe(200);
    }
    const devices = {
      owner: await subscribed(a.token, 'owner-lang'),
      admin: await subscribed(admin.token, 'admin-lang'),
    };
    const productId = await seedProduct(a.orgId, 1);
    expect((await sell(seller.token, productId, 1)).status).toBe(201);
    await dispatcher.runOnce();

    const toOwner = transport.to(devices.owner.endpoint);
    const toAdmin = transport.to(devices.admin.endpoint);
    expect(toOwner).toHaveLength(1);
    expect(toAdmin).toHaveLength(1);
    expect(toOwner[0].payload.body).toBe('Un produit est en rupture de stock.');
    expect(toAdmin[0].payload.body).toBe('A product is out of stock.');
    // Seul le texte change : catégorie, lien et regroupement identiques.
    expect({ ...toAdmin[0].payload, body: '', aud: null }).toEqual({
      ...toOwner[0].payload,
      body: '',
      aud: null,
    });
  });

  it('4. pertinence revérifiée : réapprovisionné ou purgé avant la passe → aucune alerte', async () => {
    const a = await registerOwner('relevance');
    const owner = await subscribed(a.token, 'owner');
    const restocked = await seedProduct(a.orgId, 1);
    const purged = await seedProduct(a.orgId, 1);
    expect((await sell(a.token, restocked, 1)).status).toBe(201);
    expect((await sell(a.token, purged, 1)).status).toBe(201);
    expect((await restock(a.token, restocked, 4)).status).toBe(200);
    await productModel.deleteOne({ _id: new Types.ObjectId(purged) });

    await dispatcher.runOnce();
    expect(transport.to(owner.endpoint)).toEqual([]);
    const outcomes = (
      await jobModel
        .find({
          category: PushCategory.STOCK_DEPLETED,
          productId: {
            $in: [new Types.ObjectId(restocked), new Types.ObjectId(purged)],
          },
        })
        .lean()
    ).map((j) => [j.status, j.outcome]);
    expect(outcomes.sort()).toEqual(
      [
        [PushJobStatus.CANCELLED, 'product-removed'],
        [PushJobStatus.CANCELLED, 'restocked'],
      ].sort(),
    );
  });

  it('5. commit, rollback et rejeu : aucun travail après rollback, un seul après rejeu ou reprise du callback', async () => {
    const a = await registerOwner('commit');
    await subscribed(a.token, 'owner');

    // Rollback : l'audit échoue DANS la transaction après la décrémentation.
    const rolledBack = await seedProduct(a.orgId, 1);
    const audit = moduleFixture.get(AuditService);
    jest
      .spyOn(audit, 'log')
      .mockRejectedValueOnce(new Error('audit indisponible'));
    const failed = await sell(a.token, rolledBack, 1);
    expect(failed.status).toBe(500);
    expect(
      (await productModel.findById(rolledBack).lean())?.remainingQuantity,
    ).toBe(1);
    expect(
      await jobsFor({ productId: new Types.ObjectId(rolledBack) }),
    ).toEqual([]);

    // Rejeu idempotent d'une vente : même opération, un seul travail.
    const replayed = await seedProduct(a.orgId, 2);
    const operation = randomUUID();
    expect((await sell(a.token, replayed, 2, operation)).status).toBe(201);
    expect((await sell(a.token, replayed, 2, operation)).status).toBe(201);
    expect(
      await jobsFor({ productId: new Types.ObjectId(replayed) }),
    ).toHaveLength(1);

    // Reprise du callback transactionnel par le driver (erreur transitoire
    // APRÈS l'enregistrement du travail) : un seul travail validé.
    const retried = await seedProduct(a.orgId, 1);
    const original = outbox.stockDepletedInSession.bind(outbox);
    let calls = 0;
    jest
      .spyOn(outbox, 'stockDepletedInSession')
      .mockImplementation(async (session, input) => {
        calls += 1;
        await original(session, input);
        if (calls === 1) {
          const transient = new mongo.MongoError('transient');
          transient.addErrorLabel('TransientTransactionError');
          throw transient;
        }
      });
    expect((await sell(a.token, retried, 1)).status).toBe(201);
    expect(calls).toBe(2);
    expect(
      await jobsFor({ productId: new Types.ObjectId(retried) }),
    ).toHaveLength(1);

    // L'envoi n'a lieu qu'à la passe, après commit.
    expect(transport.forOrg(a.orgId)).toEqual([]);
    await dispatcher.runOnce();
    expect(transport.forOrg(a.orgId)).toHaveLength(2);
  });

  it('6. droits revalidés : préférence coupée, droit retiré, suspension, session révoquée, changement de compte sur l’appareil', async () => {
    const a = await registerOwner('rights');
    const admin = await seedMember(a.orgId, OrganizationRole.ADMIN);
    const trusted = await seedMember(a.orgId, OrganizationRole.SELLER, [
      'products.view_stock_details',
    ]);
    const revoked = await seedMember(a.orgId, OrganizationRole.ADMIN);
    const ownerDevice = await subscribed(a.token, 'owner');
    const adminDevice = await subscribed(admin.token, 'admin');
    const trustedDevice = await subscribed(trusted.token, 'trusted');
    const revokedDevice = await subscribed(revoked.token, 'revoked');
    // Préférence coupée par le propriétaire.
    await request(server())
      .patch('/notifications/push/subscription')
      .set(auth(a.token))
      .send({
        endpoint: ownerDevice.endpoint,
        preferences: { stockDepleted: false },
      })
      .expect(200);

    // Appareil partagé : un autre compte (organisation B) active le MÊME
    // navigateur ; l'ancien titulaire n'y reçoit plus rien.
    const b = await registerOwner('rights-b');
    const shared = await subscribed(admin.token, 'shared');
    const reassigned = await subscribe(b.token, shared);
    expect(reassigned.status).toBe(200);
    const sharedRecord = await subscriptionModel
      .findOne({ userId: new Types.ObjectId(b.userId) })
      .lean();
    expect(String(sharedRecord?.organizationId)).toBe(b.orgId);
    expect(
      (
        await request(server())
          .post('/notifications/push/subscription/status')
          .set(auth(admin.token))
          .send({ endpoint: shared.endpoint })
      ).body.registered,
    ).toBe(false);

    // Après l'événement : permission retirée, membre suspendu, session
    // révoquée (réinitialisation du mot de passe).
    const productId = await seedProduct(a.orgId, 1);
    expect((await sell(a.token, productId, 1)).status).toBe(201);
    await membershipModel.updateOne(
      { _id: new Types.ObjectId(trusted.membershipId) },
      { $set: { permissions: [] } },
    );
    await membershipModel.updateOne(
      { _id: new Types.ObjectId(admin.membershipId) },
      { $set: { status: MembershipStatus.SUSPENDED } },
    );
    await userModel.updateOne(
      { _id: new Types.ObjectId(revoked.userId) },
      { $set: { authVersion: 1 } },
    );

    await dispatcher.runOnce();
    expect(transport.forOrg(a.orgId)).toEqual([]);
    expect(transport.to(ownerDevice.endpoint)).toEqual([]);
    expect(transport.to(adminDevice.endpoint)).toEqual([]);
    expect(transport.to(trustedDevice.endpoint)).toEqual([]);
    expect(transport.to(revokedDevice.endpoint)).toEqual([]);
    expect(transport.to(shared.endpoint)).toEqual([]);
    const revokedRecord = await subscriptionModel
      .findOne({ userId: new Types.ObjectId(revoked.userId) })
      .lean();
    expect(revokedRecord?.status).toBe(PushSubscriptionStatus.DISABLED);
    expect(revokedRecord?.disabledReason).toBe('session-revoked');

    // Droit retiré ENTRE la répartition et une reprise : livraison écartée.
    await membershipModel.updateOne(
      { _id: new Types.ObjectId(admin.membershipId) },
      { $set: { status: MembershipStatus.ACTIVE } },
    );
    const adminDevice2 = await subscribed(admin.token, 'admin-2');
    const product2 = await seedProduct(a.orgId, 1);
    expect((await sell(a.token, product2, 1)).status).toBe(201);
    transport.respond(adminDevice2.endpoint, 503);
    await dispatcher.runOnce();
    expect(transport.to(adminDevice2.endpoint)).toHaveLength(1);
    await membershipModel.updateOne(
      { _id: new Types.ObjectId(admin.membershipId) },
      { $set: { status: MembershipStatus.SUSPENDED } },
    );
    advance(HOUR);
    await dispatcher.runOnce();
    expect(transport.to(adminDevice2.endpoint)).toHaveLength(1);
    const admin2Record = await subscriptionModel
      .findOne({ endpoint: adminDevice2.endpoint })
      .lean();
    const delivery = await deliveryModel
      .findOne({ subscriptionId: admin2Record?._id })
      .lean();
    expect(delivery?.status).toBe(PushDeliveryStatus.SKIPPED);
    expect(delivery?.lastResult).toBe('membership-inactive');
  });

  it('7. abonnement invalide (404/410) désactivé ; panne transitoire reprise avec délais bornés ; activation tardive sans rafale', async () => {
    const a = await registerOwner('retry');
    const gone = await subscribed(a.token, 'gone');
    const missing = await subscribed(a.token, 'missing');
    const flaky = await subscribed(a.token, 'flaky');
    const dead = await subscribed(a.token, 'dead');
    transport.respond(gone.endpoint, 410);
    transport.respond(missing.endpoint, 404);
    transport.respond(flaky.endpoint, 500, null);
    transport.respond(
      dead.endpoint,
      ...Array<number>(PUSH_MAX_ATTEMPTS).fill(503),
    );
    const productId = await seedProduct(a.orgId, 1);
    expect((await sell(a.token, productId, 1)).status).toBe(201);

    await dispatcher.runOnce();
    for (const d of [gone, missing]) {
      const record = await subscriptionModel
        .findOne({ endpoint: d.endpoint })
        .lean();
      expect(record?.status).toBe(PushSubscriptionStatus.DISABLED);
      expect(record?.disabledReason).toBe('gone');
    }
    // Reprises : pas avant le délai, puis après.
    await dispatcher.runOnce();
    expect(transport.to(flaky.endpoint)).toHaveLength(1);
    advance(31_000);
    await dispatcher.runOnce();
    expect(transport.to(flaky.endpoint)).toHaveLength(2);
    advance(2 * 60_000 + 1_000);
    await dispatcher.runOnce();
    expect(transport.to(flaky.endpoint)).toHaveLength(3);
    for (let i = 0; i < PUSH_MAX_ATTEMPTS + 2; i += 1) {
      advance(31 * 60_000);
      if (now.getTime() - Date.now() > 5 * HOUR) break;
      await dispatcher.runOnce();
    }
    expect(transport.to(dead.endpoint)).toHaveLength(PUSH_MAX_ATTEMPTS);
    const deadDelivery = await deliveryModel
      .findOne({
        subscriptionId: (
          await subscriptionModel.findOne({ endpoint: dead.endpoint }).lean()
        )?._id,
      })
      .lean();
    expect(deadDelivery?.status).toBe(PushDeliveryStatus.FAILED);
    expect(deadDelivery?.attempts).toBe(PUSH_MAX_ATTEMPTS);

    // Événement suivant : les appareils disparus ne sont plus visés.
    setNow(new Date());
    transport.reset();
    const product2 = await seedProduct(a.orgId, 1);
    expect((await sell(a.token, product2, 1)).status).toBe(201);
    await dispatcher.runOnce();
    expect(transport.to(gone.endpoint)).toEqual([]);
    expect(transport.to(missing.endpoint)).toEqual([]);

    // Appareil activé APRÈS un événement non encore traité, puis passe
    // tardive : aucun ancien événement ne lui est livré.
    transport.reset();
    const product3 = await seedProduct(a.orgId, 1);
    expect((await sell(a.token, product3, 1)).status).toBe(201);
    advance(1_000);
    const late = await subscribed(a.token, 'late');
    await dispatcher.runOnce();
    expect(transport.to(late.endpoint)).toEqual([]);
    // Événement trop ancien (> 6 h) au moment de la passe : aucun push
    // (1-16A.1 : la notification du centre reste créée, l'événement étant
    // toujours pertinent).
    transport.reset();
    const product4 = await seedProduct(a.orgId, 1);
    expect((await sell(a.token, product4, 1)).status).toBe(201);
    advance(7 * HOUR);
    await dispatcher.runOnce();
    expect(transport.forOrg(a.orgId)).toEqual([]);
    expect(
      (
        await jobModel
          .findOne({
            productId: new Types.ObjectId(product4),
            category: PushCategory.STOCK_DEPLETED,
          })
          .lean()
      )?.outcome,
    ).toBe('push-expired');
  });

  it('8. panne push : la vente reste un succès HTTP, l’erreur reste interne', async () => {
    const a = await registerOwner('failure');
    const owner = await subscribed(a.token, 'owner');
    transport.respond(owner.endpoint, 'throw');
    const productId = await seedProduct(a.orgId, 1);
    const sale = await sell(a.token, productId, 1);
    expect(sale.status).toBe(201);
    // Transport qui rejette : traité comme une panne réseau, reprise bornée ;
    // aucune exception ne remonte, aucune écriture métier n'est touchée.
    const summary = await dispatcher.runOnce();
    expect(summary.retried).toBeGreaterThanOrEqual(1);
    const record = await subscriptionModel
      .findOne({ endpoint: owner.endpoint })
      .lean();
    const delivery = await deliveryModel
      .findOne({ subscriptionId: record?._id })
      .lean();
    expect(delivery?.status).toBe(PushDeliveryStatus.PENDING);
    expect(delivery?.lastResult).toBe('transport');
    expect(
      (await productModel.findById(productId).lean())?.remainingQuantity,
    ).toBe(0);
    const later = await sell(a.token, await seedProduct(a.orgId, 3), 1);
    expect(later.status).toBe(201);
  });

  it('9. paiement confirmé : propriétaire actif seul, après attribution ; jamais pour pending ; rollback et rejeu sans travail', async () => {
    const a = await registerOwner('pay');
    const admin = await seedMember(a.orgId, OrganizationRole.ADMIN);
    const ownerDevice = await subscribed(a.token, 'owner');
    const adminDevice = await subscribed(admin.token, 'admin');

    const created = await pay(a.token);
    const pending = await refresh(a.token, created.paymentId);
    expect(pending.body.status).toBe('pending');
    expect(
      await jobsFor({ paymentId: new Types.ObjectId(created.paymentId) }),
    ).toEqual([]);

    // Rollback forcé APRÈS les écritures du callback : aucun travail.
    sim.settle(created.reference, 'succeeded');
    const original = subscriptions.runInGrantTransaction.bind(subscriptions);
    jest
      .spyOn(subscriptions, 'runInGrantTransaction')
      .mockImplementationOnce((work, options) =>
        original(async (session: MongooseSession) => {
          await work(session);
          throw new Error('rollback forcé');
        }, options),
      );
    expect((await refresh(a.token, created.paymentId)).status).toBe(500);
    expect(
      await jobsFor({ paymentId: new Types.ObjectId(created.paymentId) }),
    ).toEqual([]);

    const succeeded = await refresh(a.token, created.paymentId);
    expect(succeeded.status).toBe(200);
    expect(succeeded.body.status).toBe('succeeded');
    // Rejeu : aucun second travail.
    expect((await refresh(a.token, created.paymentId)).status).toBe(200);
    const jobs = await jobsFor({
      paymentId: new Types.ObjectId(created.paymentId),
    });
    expect(jobs).toHaveLength(1);

    await dispatcher.runOnce();
    expect(transport.to(adminDevice.endpoint)).toEqual([]);
    const [message] = transport.to(ownerDevice.endpoint);
    expect(message.payload).toMatchObject({
      category: 'payment-succeeded',
      body: 'Votre paiement a été confirmé.',
      url: '/app/organization/subscription',
    });
    expect(`${message.payload.title} ${message.payload.body}`).not.toMatch(
      /\d|XAF|FCFA/,
    );
  });

  it('10. transfert de propriété ou suspension de l’organisation : anciens destinataires écartés', async () => {
    const a = await registerOwner('transfer');
    const admin = await seedMember(a.orgId, OrganizationRole.ADMIN);
    const ownerDevice = await subscribed(a.token, 'owner');
    const adminDevice = await subscribed(admin.token, 'admin');
    const created = await pay(a.token);
    sim.settle(created.reference, 'succeeded');
    expect((await refresh(a.token, created.paymentId)).status).toBe(200);

    // Transfert APRÈS l'événement, AVANT la passe.
    await membershipModel.updateOne(
      {
        organizationId: new Types.ObjectId(a.orgId),
        userId: new Types.ObjectId(a.userId),
      },
      { $set: { role: OrganizationRole.ADMIN } },
    );
    await membershipModel.updateOne(
      { _id: new Types.ObjectId(admin.membershipId) },
      { $set: { role: OrganizationRole.OWNER } },
    );
    await dispatcher.runOnce();
    expect(transport.to(ownerDevice.endpoint)).toEqual([]);
    expect(transport.to(adminDevice.endpoint)).toHaveLength(1);

    // Organisation suspendue : aucun envoi, même aux membres autorisés.
    transport.reset();
    const productId = await seedProduct(a.orgId, 1);
    expect((await sell(admin.token, productId, 1)).status).toBe(201);
    await organizationModel.updateOne(
      { _id: new Types.ObjectId(a.orgId) },
      { $set: { status: OrganizationStatus.SUSPENDED } },
    );
    await dispatcher.runOnce();
    expect(transport.forOrg(a.orgId)).toEqual([]);
    expect(
      (
        await jobModel
          .findOne({
            productId: new Types.ObjectId(productId),
            category: PushCategory.STOCK_DEPLETED,
          })
          .lean()
      )?.outcome,
    ).toBe('organization-inactive');
  });

  it('11. rappel d’échéance : 24 h avant l’échéance UTC effective, propriétaire seul, un rappel, aucun après renouvellement', async () => {
    // Échéances PLACÉES explicitement loin de celles des autres
    // organisations du fichier (essais de 7 jours créés à la même heure).
    const base = Date.now() + 30 * 24 * HOUR;
    const placeTrialEnd = async (orgId: string, endsAt: Date) => {
      await periodModel.updateOne(
        { organizationId: new Types.ObjectId(orgId) },
        { $set: { endsAt } },
      );
      return endsAt;
    };
    const remindersOf = (orgId: string) =>
      jobsFor({
        organizationId: new Types.ObjectId(orgId),
        category: PushCategory.SUBSCRIPTION_ENDING,
      });

    const a = await registerOwner('remind');
    const admin = await seedMember(a.orgId, OrganizationRole.ADMIN);
    const ownerDevice = await subscribed(a.token, 'owner');
    const adminDevice = await subscribed(admin.token, 'admin');
    const endA = await placeTrialEnd(a.orgId, new Date(base));

    // 25 h avant : rien.
    setNow(new Date(endA.getTime() - 25 * HOUR));
    await dispatcher.scanSubscriptionReminders();
    expect(await remindersOf(a.orgId)).toEqual([]);

    // 23 h avant : un rappel au propriétaire, texte d'essai.
    setNow(new Date(endA.getTime() - 23 * HOUR));
    await dispatcher.runOnce();
    const sentToOwner = transport.to(ownerDevice.endpoint);
    expect(sentToOwner).toHaveLength(1);
    expect(sentToOwner[0].payload).toMatchObject({
      category: 'subscription-ending',
      body: "Votre période d'essai se termine bientôt.",
      url: '/app/organization/subscription',
      tag: `subscription-ending:${a.orgId}`,
    });
    expect(sentToOwner[0].options.ttlSeconds).toBeLessThanOrEqual(23 * 3600);
    expect(transport.to(adminDevice.endpoint)).toEqual([]);

    // Balayages répétés, y compris par un « nouveau processus » (état en
    // mémoire perdu) : la clé d'échéance empêche tout doublon.
    advance(10 * 60_000);
    await dispatcher.scanSubscriptionReminders();
    await dispatcher.scanSubscriptionReminders();
    (
      dispatcher as unknown as { lastReminderScanAt: number | null }
    ).lastReminderScanAt = null;
    await dispatcher.runOnce();
    expect(transport.to(ownerDevice.endpoint)).toHaveLength(1);
    expect(await remindersOf(a.orgId)).toHaveLength(1);

    // Rappel enregistré puis renouvellement AVANT la passe : annulé.
    const renewed = await registerOwner('remind-renewed');
    const renewedDevice = await subscribed(renewed.token, 'renewed');
    const endR = await placeTrialEnd(
      renewed.orgId,
      new Date(base + 10 * 24 * HOUR),
    );
    setNow(new Date(endR.getTime() - 2 * HOUR));
    await dispatcher.scanSubscriptionReminders();
    expect(await remindersOf(renewed.orgId)).toHaveLength(1);
    await subscriptions.grantSubscription({
      organizationId: renewed.orgId,
      term: 'monthly',
      sourceReference: `e2e-renewal:${renewed.orgId}`,
      grantedBy: 'e2e',
    });
    await dispatcher.runOnce();
    expect(transport.to(renewedDevice.endpoint)).toEqual([]);
    const [renewedJob] = await remindersOf(renewed.orgId);
    expect(renewedJob.status).toBe(PushJobStatus.CANCELLED);
    expect(renewedJob.outcome).toBe('renewed');
    // Nouveau balayage : l'échéance effective est désormais au-delà de 24 h.
    await dispatcher.scanSubscriptionReminders();
    expect(await remindersOf(renewed.orgId)).toHaveLength(1);

    // Échéance dépassée avant la passe : jamais annoncée après coup.
    const late = await registerOwner('remind-late');
    const lateDevice = await subscribed(late.token, 'late');
    const endL = await placeTrialEnd(
      late.orgId,
      new Date(base + 20 * 24 * HOUR),
    );
    setNow(new Date(endL.getTime() - HOUR));
    await dispatcher.scanSubscriptionReminders();
    setNow(new Date(endL.getTime() + 1));
    await dispatcher.runOnce();
    expect(transport.to(lateDevice.endpoint)).toEqual([]);
    const [lateJob] = await remindersOf(late.orgId);
    expect(lateJob.outcome).toBe('expired');
  });

  it('12. contexte CLI (`createApplicationContext(AppModule)`, push configuré) : aucun dispatcher, aucune écriture, aucun envoi', async () => {
    const owner = await registerOwner('cli');
    const product = await seedProduct(owner.orgId, 1);
    const counts = async () => ({
      jobs: await jobModel.countDocuments(),
      deliveries: await deliveryModel.countDocuments(),
      subscriptions: await subscriptionModel.countDocuments(),
      // 1-16A.1 : centre, préférences et bilans.
      notifications: await connection
        .db!.collection('notifications')
        .countDocuments(),
      preferences: await connection
        .db!.collection('notification_preferences')
        .countDocuments(),
      reports: await connection
        .db!.collection('monthly_reports')
        .countDocuments(),
    });
    const before = await counts();
    const sentBefore = transport.sent.length;
    const keys = [
      'WEB_PUSH_ENABLED',
      'WEB_PUSH_VAPID_PUBLIC_KEY',
      'WEB_PUSH_VAPID_PRIVATE_KEY',
      'WEB_PUSH_VAPID_SUBJECT',
    ] as const;
    Object.assign(process.env, {
      WEB_PUSH_ENABLED: 'true',
      WEB_PUSH_VAPID_PUBLIC_KEY: config.publicKey,
      WEB_PUSH_VAPID_PRIVATE_KEY: config.privateKey,
      WEB_PUSH_VAPID_SUBJECT: config.subject,
    });
    const cli = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    try {
      const cliDispatcher = cli.get(PushDispatcherService);
      expect(cli.get(PushRuntime).active).toBe(false);
      expect(cliDispatcher.started).toBe(false);
      // Écriture transactionnelle d'un CLI : aucun travail enregistré.
      const session = await cli
        .get<Connection>(getConnectionToken())
        .startSession();
      try {
        await session.withTransaction(() =>
          cli.get(PushOutboxService).stockDepletedInSession(session, {
            organizationId: owner.orgId,
            productId: product,
            trigger: 'cli',
          }),
        );
      } finally {
        await session.endSession();
      }
      expect(await cliDispatcher.runOnce()).toEqual({
        reminders: 0,
        reports: 0,
        jobsDispatched: 0,
        jobsCancelled: 0,
        notifications: 0,
        sent: 0,
        retried: 0,
        skipped: 0,
        failed: 0,
      });
      expect(cliDispatcher.started).toBe(false);
    } finally {
      await cli.close();
      for (const key of keys) delete process.env[key];
    }
    expect(await counts()).toEqual(before);
    expect(transport.sent.length).toBe(sentBefore);
  });
});
