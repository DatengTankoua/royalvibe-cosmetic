import 'reflect-metadata';
import { createECDH, randomBytes, randomUUID } from 'crypto';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { Connection, Model, Types } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { ThrottlerStorage } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { App } from 'supertest/types';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { UserDocument, UserRole } from './../src/users/schemas/user.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import {
  DelegablePermission,
  MembershipStatus,
  OrganizationRole,
} from './../src/organizations/permissions';
import { Product } from './../src/products/schemas/product.schema';
import type { ProductDocument } from './../src/products/schemas/product.schema';
import { Section } from './../src/sections/schemas/section.schema';
import type { SectionDocument } from './../src/sections/schemas/section.schema';
import { Sale } from './../src/sales/schemas/sale.schema';
import type { SaleDocument } from './../src/sales/schemas/sale.schema';
import {
  SubscriptionPeriod,
  SubscriptionPeriodDocument,
} from './../src/subscriptions/schemas/subscription-period.schema';
import { ensureSubscriptionPeriodIndexes } from './../src/subscriptions/subscription-period-indexes';
import { PAYMENT_PROVIDER } from './../src/subscriptions/payments/payment-provider';
import { AuditService } from './../src/audit/audit.service';
import { EventsGateway } from './../src/events/events.gateway';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import { PUSH_CLOCK, PushRuntime } from './../src/push/push-runtime';
import {
  PushDispatcherService,
  SALE_DIGEST_WINDOW_MS,
} from './../src/push/push-dispatcher.service';
import { ensurePushIndexes } from './../src/push/push-indexes';
import type {
  PushSendResult,
  PushTarget,
  PushTransport,
} from './../src/push/push-transport';
import type { PushMessagePayload } from './../src/push/push-messages';
import {
  PushJob,
  PushJobDocument,
} from './../src/push/schemas/push-job.schema';
import {
  PushDelivery,
  PushDeliveryDocument,
} from './../src/push/schemas/push-delivery.schema';
import { PushCategory } from './../src/push/schemas/push-category';
import {
  AppNotification,
  NotificationDocument,
} from './../src/notifications/schemas/notification.schema';
import {
  MonthlyReport,
  MonthlyReportDocument,
} from './../src/notifications/schemas/monthly-report.schema';
import { MonthlyReportService } from './../src/notifications/monthly-report.service';
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
import { until } from './e2e/barriers';
import { OWNER_TERMS } from './e2e/legal-acceptance-fixtures';

/**
 * E2E 1-16A.1 — centre de notifications, seuil de 80 %, nouvelles ventes,
 * bilan mensuel, lecture et expiration, signal privé entre appareils.
 *
 * MongoMemoryReplSet (garde anti-27017), AppModule réelle, VRAIS clients
 * Socket.IO, prestataire de paiement simulé, FAUX transport push, horloge
 * des notifications contrôlée (`PUSH_CLOCK`) ; le traitement de fond n'est
 * jamais démarré : passes explicites (`runOnce`). Centre actif SANS push par
 * défaut (`activateCenter`), push activé seulement par les tests qui
 * l'exigent.
 */

const TEST_JWT_SECRET = 'notification-center-16a1-e2e-only';
const E2E_CORS_ORIGIN = 'https://notification-center-16a1-e2e.example.com';
const PASSWORD = 'nc-16a1-pw-!1x';
const HOUR = 60 * 60 * 1000;

class FakePushTransport implements PushTransport {
  readonly sent: Array<{ endpoint: string; payload: PushMessagePayload }> = [];
  send(target: PushTarget, payload: string): Promise<PushSendResult> {
    this.sent.push({
      endpoint: target.endpoint,
      payload: JSON.parse(payload) as PushMessagePayload,
    });
    return Promise.resolve({ statusCode: 201 });
  }
  to(endpoint: string) {
    return this.sent.filter((s) => s.endpoint === endpoint);
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

interface Client {
  socket: Socket;
  signals: number;
  sentinel: number;
}

let now = new Date();
const setNow = (d: Date) => {
  now = new Date(d.getTime());
};
const advance = (ms: number) => setNow(new Date(now.getTime() + ms));

describe('Centre de notifications (e2e 1-16A.1)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let port = 0;
  let connection: Connection;
  let userModel: Model<UserDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;
  let productModel: Model<ProductDocument>;
  let sectionModel: Model<SectionDocument>;
  let saleModel: Model<SaleDocument>;
  let periodModel: Model<SubscriptionPeriodDocument>;
  let jobModel: Model<PushJobDocument>;
  let deliveryModel: Model<PushDeliveryDocument>;
  let notificationModel: Model<NotificationDocument>;
  let reportModel: Model<MonthlyReportDocument>;
  let runtime: PushRuntime;
  let dispatcher: PushDispatcherService;
  let gateway: EventsGateway;
  let seq = 0;
  let sentinel = 0;
  const clients: Client[] = [];
  const config = vapidConfig();
  const transport = new FakePushTransport();
  const sim = new SimulatedPaymentProvider();
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
    const email = `${label}-${seq}-16a1@nc.test`;
    const reg = await request(server())
      .post('/auth/register')
      .send({
        ...OWNER_TERMS,
        name: `Owner ${seq}`,
        email,
        password: PASSWORD,
        organizationName: `Org ${label} ${seq}`.slice(0, 20),
      });
    expect(reg.status).toBe(201);
    return {
      email,
      orgId: reg.body.organization._id as string,
      userId: String(reg.body.user._id),
      token: await login(email),
    };
  }

  async function seedMember(
    orgId: string,
    role: OrganizationRole.ADMIN | OrganizationRole.SELLER,
    permissions: DelegablePermission[] = [],
    name: string = role,
  ) {
    seq += 1;
    const email = `${role}-${seq}-16a1@nc.test`;
    const user = await userModel.create({
      emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
      name,
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

  async function seedProduct(
    orgId: string,
    initial: number,
    remaining = initial,
    name?: string,
  ) {
    seq += 1;
    const section = await sectionModel.create({
      organizationId: new Types.ObjectId(orgId),
      name: `Rayon ${seq}`,
      description: '',
    });
    const product = await productModel.create({
      organizationId: new Types.ObjectId(orgId),
      sectionId: section._id,
      name: name ?? `Produit ${seq}`,
      imageUrl: 'https://e2e.local/img.png',
      purchasePrice: 100,
      salePrice: 400,
      initialQuantity: initial,
      remainingQuantity: remaining,
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

  const jobs = (category: PushCategory, productId?: string) =>
    jobModel
      .find({
        category,
        ...(productId ? { productId: new Types.ObjectId(productId) } : {}),
      })
      .lean()
      .exec();

  const list = async (token: string, status: 'all' | 'unread' = 'all') => {
    const res = await request(server())
      .get(`/notifications?status=${status}&limit=50`)
      .set(auth(token));
    expect(res.status).toBe(200);
    return res.body as {
      items: Array<{
        id: string;
        category: PushCategory;
        title: string;
        body: string;
        link: string;
        readAt: string | null;
      }>;
      nextCursor: string | null;
    };
  };
  const count = async (token: string) => {
    const res = await request(server())
      .get('/notifications/unread-count')
      .set(auth(token));
    expect(res.status).toBe(200);
    return res.body.count as number;
  };
  const ofCategory = async (token: string, category: PushCategory) =>
    (await list(token)).items.filter((n) => n.category === category);

  function connect(token: string): Promise<Client> {
    const socket = io(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      reconnection: false,
      timeout: 4_000,
      extraHeaders: { origin: E2E_CORS_ORIGIN },
      auth: { token },
    });
    const client: Client = { socket, signals: 0, sentinel: 0 };
    clients.push(client);
    socket.on('notifications:changed', (payload: unknown) => {
      expect(payload).toEqual({});
      client.signals += 1;
    });
    socket.on('test:sentinel', (n: number) => (client.sentinel = n));
    return new Promise((resolve, reject) => {
      socket.once('connect', () => resolve(client));
      socket.once('connect_error', (e) => reject(e));
    });
  }

  /** Tout signal émis avant la sentinelle est reçu (ordre par connexion). */
  async function settle(): Promise<void> {
    sentinel += 1;
    const n = sentinel;
    gateway.server.emit('test:sentinel', n);
    await until(
      () => clients.every((c) => !c.socket.connected || c.sentinel >= n),
      `sentinelle ${n}`,
    );
  }

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
      await app.listen(0);
      port = ((server() as unknown as Server).address() as AddressInfo).port;

      connection = moduleFixture.get(getConnectionToken());
      userModel = moduleFixture.get(getModelToken('User'));
      membershipModel = moduleFixture.get(
        getModelToken(OrganizationMembership.name),
      );
      productModel = moduleFixture.get(getModelToken(Product.name));
      sectionModel = moduleFixture.get(getModelToken(Section.name));
      saleModel = moduleFixture.get(getModelToken(Sale.name));
      periodModel = moduleFixture.get(getModelToken(SubscriptionPeriod.name));
      jobModel = moduleFixture.get(getModelToken(PushJob.name));
      deliveryModel = moduleFixture.get(getModelToken(PushDelivery.name));
      notificationModel = moduleFixture.get(
        getModelToken(AppNotification.name),
      );
      reportModel = moduleFixture.get(getModelToken(MonthlyReport.name));
      runtime = moduleFixture.get(PushRuntime);
      dispatcher = moduleFixture.get(PushDispatcherService);
      gateway = moduleFixture.get(EventsGateway);
      await ensureSubscriptionPeriodIndexes(connection);
      await ensurePushIndexes(connection);
    } catch (error) {
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  beforeEach(() => {
    setNow(new Date());
    transport.sent.length = 0;
    runtime.deactivate();
    runtime.activateCenter();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const c of clients) c.socket.disconnect();
    clients.length = 0;
  });

  afterAll(async () => {
    await app?.close();
    await stopEphemeralMongoSafe();
  });

  it('1. index : TTL `expiresAt` exact, unicités du centre et des bilans', async () => {
    const indexes = await connection
      .db!.collection('notifications')
      .listIndexes()
      .toArray();
    const ttl = indexes.find((i) => i.name === 'expiresAt_1_ttl');
    expect(ttl?.expireAfterSeconds).toBe(0);
    expect(indexes.find((i) => i.name === 'eventKey_1_userId_1')?.unique).toBe(
      true,
    );
    const reports = await connection
      .db!.collection('monthly_reports')
      .listIndexes()
      .toArray();
    expect(
      reports.find((i) => i.name === 'organizationId_1_period_1')?.unique,
    ).toBe(true);
  });

  it('2. nouvelle vente, push désactivé : notification au propriétaire et à l’administrateur seuls ; signal privé entre appareils ; lecture et expiration', async () => {
    const a = await registerOwner('sale');
    const admin = await seedMember(a.orgId, OrganizationRole.ADMIN);
    const seller = await seedMember(a.orgId, OrganizationRole.SELLER, [
      'sales.view_all',
    ]);
    const b = await registerOwner('sale-b');
    const ownerPhone = await connect(a.token);
    const ownerLaptop = await connect(a.token);
    const adminSocket = await connect(admin.token);
    const sellerSocket = await connect(seller.token);
    const ownerB = await connect(b.token);
    await settle();

    const productId = await seedProduct(a.orgId, 50);
    const sale = await sell(seller.token, productId, 1);
    expect(sale.status).toBe(201);
    // Événement durable dans la transaction ; rien avant la passe.
    expect(await jobs(PushCategory.SALE_CREATED, productId)).toHaveLength(1);
    expect(await count(a.token)).toBe(0);

    await dispatcher.runOnce();
    await settle();
    expect(ownerPhone.signals).toBe(1);
    expect(ownerLaptop.signals).toBe(1);
    expect(adminSocket.signals).toBe(1);
    expect(sellerSocket.signals).toBe(0);
    expect(ownerB.signals).toBe(0);
    expect(await count(a.token)).toBe(1);
    expect(await count(admin.token)).toBe(1);
    expect(await count(seller.token)).toBe(0);
    expect(await count(b.token)).toBe(0);
    expect(await deliveryModel.countDocuments()).toBe(0);

    const [item] = (await list(a.token)).items;
    expect(item).toMatchObject({
      category: 'sale-created',
      title: 'Stock Master',
      body: 'Nouvelle vente enregistrée.',
      link: '/app/sales',
      readAt: null,
    });
    // La liste et le compteur ne marquent rien comme lu.
    expect(await count(a.token)).toBe(1);

    // Consultation explicite sur un appareil : lue partout (état partagé),
    // signal à l'autre appareil, détails relus avec les droits actuels.
    const opened = await request(server())
      .post(`/notifications/${item.id}/open`)
      .set(auth(a.token));
    expect(opened.status).toBe(200);
    expect(opened.body.details).toMatchObject({
      kind: 'sale',
      cancelled: false,
      quantity: 1,
      salePrice: 400,
      total: 400,
      sellerName: 'seller',
    });
    expect(opened.body.details).not.toHaveProperty('purchasePrice');
    await settle();
    expect(ownerLaptop.signals).toBe(2);
    expect(adminSocket.signals).toBe(1);
    expect(await count(a.token)).toBe(0);
    expect(await count(admin.token)).toBe(1);

    const stored = await notificationModel.findById(item.id).lean().exec();
    expect(stored!.expiresAt!.getTime() - stored!.readAt!.getTime()).toBe(
      48 * HOUR,
    );
    // Seconde consultation : `readAt` et `expiresAt` inchangés.
    advance(HOUR);
    await request(server())
      .post(`/notifications/${item.id}/open`)
      .set(auth(a.token))
      .expect(200);
    const again = await notificationModel.findById(item.id).lean().exec();
    expect(again!.readAt).toEqual(stored!.readAt);
    expect(again!.expiresAt).toEqual(stored!.expiresAt);

    // Expirée : exclue de la lecture API avant tout nettoyage TTL.
    advance(48 * HOUR);
    expect((await list(a.token)).items.map((n) => n.id)).not.toContain(item.id);
    await request(server())
      .post(`/notifications/${item.id}/open`)
      .set(auth(a.token))
      .expect(404);
    // Non lue : jamais expirée.
    expect(await count(admin.token)).toBe(1);
    // La vente existe toujours.
    expect(await saleModel.countDocuments({ _id: sale.body._id })).toBe(1);

    // Accès d'un autre utilisateur à la notification : indistinguable.
    const [adminItem] = (await list(admin.token)).items;
    await request(server())
      .post(`/notifications/${adminItem.id}/open`)
      .set(auth(b.token))
      .expect(404);
    await request(server())
      .post(`/notifications/${adminItem.id}/open`)
      .set(auth(a.token))
      .expect(404);
  });

  it('3. vente : rollback sans événement, rejeu idempotent sans doublon, correction et annulation sans « nouvelle vente »', async () => {
    const a = await registerOwner('sale-tx');
    const productId = await seedProduct(a.orgId, 50);
    jest
      .spyOn(moduleFixture.get(AuditService), 'log')
      .mockRejectedValueOnce(new Error('audit indisponible'));
    expect((await sell(a.token, productId, 1)).status).toBe(500);
    expect(await jobs(PushCategory.SALE_CREATED, productId)).toHaveLength(0);

    const operation = randomUUID();
    const first = await sell(a.token, productId, 2, operation);
    const replay = await sell(a.token, productId, 2, operation);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(await jobs(PushCategory.SALE_CREATED, productId)).toHaveLength(1);

    await request(server())
      .patch(`/sales/${first.body._id}`)
      .set(auth(a.token))
      .send({ quantity: 3 })
      .expect(200);
    await request(server())
      .delete(`/sales/${first.body._id}`)
      .set(auth(a.token))
      .expect(204);
    expect(await jobs(PushCategory.SALE_CREATED, productId)).toHaveLength(1);

    // Vente annulée avant la passe : pas de notification.
    await dispatcher.runOnce();
    expect(await ofCategory(a.token, PushCategory.SALE_CREATED)).toEqual([]);
    const [job] = await jobs(PushCategory.SALE_CREATED, productId);
    expect(job.outcome).toBe('sale-cancelled');
  });

  it('4. seuil de 80 % : franchissement exact, une alerte, réarmement par correction ou réapprovisionnement, rupture prioritaire', async () => {
    const a = await registerOwner('low');
    const trusted = await seedMember(a.orgId, OrganizationRole.SELLER, [
      'products.view_stock_details',
    ]);
    const seller = await seedMember(a.orgId, OrganizationRole.SELLER);
    const productId = await seedProduct(a.orgId, 100);
    const lows = () => jobs(PushCategory.STOCK_LOW, productId);

    expect((await sell(a.token, productId, 79)).status).toBe(201); // 21 restants
    expect(await lows()).toHaveLength(0);
    const crossing = await sell(a.token, productId, 1); // 20 restants
    expect(crossing.status).toBe(201);
    expect(await lows()).toHaveLength(1);
    expect((await sell(a.token, productId, 1)).status).toBe(201); // 19
    expect(await lows()).toHaveLength(1);

    await dispatcher.runOnce();
    const owner = await ofCategory(a.token, PushCategory.STOCK_LOW);
    expect(owner).toHaveLength(1);
    expect(owner[0].body).toBe('Le stock d’un produit est presque épuisé.');
    expect(
      await ofCategory(trusted.token, PushCategory.STOCK_LOW),
    ).toHaveLength(1);
    expect(await ofCategory(seller.token, PushCategory.STOCK_LOW)).toEqual([]);
    const opened = await request(server())
      .post(`/notifications/${owner[0].id}/open`)
      .set(auth(a.token));
    expect(opened.body.details).toMatchObject({
      kind: 'stock',
      remainingQuantity: 19,
      initialQuantity: 100,
    });

    // Annulations : vente de franchissement → 20 restants (toujours
    // atteint) ; dernière vente → 21 (sous le seuil : réarmé).
    await request(server())
      .delete(`/sales/${crossing.body._id}`)
      .set(auth(a.token))
      .expect(204);
    expect(
      (await productModel.findById(productId).lean())?.remainingQuantity,
    ).toBe(20);
    const last = (
      await saleModel
        .find({ productId: new Types.ObjectId(productId) })
        .sort({ createdAt: -1 })
        .lean()
    )[0];
    await request(server())
      .delete(`/sales/${String(last._id)}`)
      .set(auth(a.token))
      .expect(204); // 21 : réarmé
    expect(await lows()).toHaveLength(1);
    // Nouvelle correction de quantité qui refranchit : nouvelle alerte.
    const big = (
      await saleModel
        .find({ productId: new Types.ObjectId(productId) })
        .sort({ createdAt: 1 })
        .lean()
    )[0];
    await request(server())
      .patch(`/sales/${String(big._id)}`)
      .set(auth(a.token))
      .send({ quantity: 80 }) // 79 → 80 vendus : 20 restants
      .expect(200);
    expect(await lows()).toHaveLength(2);

    // Réapprovisionnement : +100 (200 initiales, 120 restantes) → sous le
    // seuil ; l'alerte en attente devient caduque.
    await request(server())
      .patch(`/products/${productId}`)
      .set(auth(a.token))
      .field('additionalStock', '100')
      .expect(200);
    await dispatcher.runOnce();
    const pending = await lows();
    expect(pending.find((j) => j.outcome === 'restocked')).toBeDefined();
    // Franchissement suivant : 120 → 40 restants (160 consommées = 80 %).
    expect((await sell(a.token, productId, 80)).status).toBe(201);
    expect(await lows()).toHaveLength(3);

    // Rupture directe depuis un stock au-dessus du seuil : rupture seule.
    const direct = await seedProduct(a.orgId, 10);
    expect((await sell(a.token, direct, 10)).status).toBe(201);
    expect(await jobs(PushCategory.STOCK_LOW, direct)).toHaveLength(0);
    expect(await jobs(PushCategory.STOCK_DEPLETED, direct)).toHaveLength(1);

    // Quantité initiale nulle (donnée historique hors validation du
    // schéma, insérée directement) : jamais d'alerte de seuil.
    const zero = await seedProduct(a.orgId, 5, 5);
    await productModel.collection.updateOne(
      { _id: new Types.ObjectId(zero) },
      { $set: { initialQuantity: 0 } },
    );
    expect((await sell(a.token, zero, 1)).status).toBe(201);
    expect(await jobs(PushCategory.STOCK_LOW, zero)).toHaveLength(0);
  });

  it('5. seuil : ventes concurrentes sur le franchissement → exactement une alerte (écritures atomiques 1-15E)', async () => {
    const a = await registerOwner('race');
    const productId = await seedProduct(a.orgId, 10, 4); // 6 consommées
    const results = await Promise.all([
      sell(a.token, productId, 1),
      sell(a.token, productId, 1),
      sell(a.token, productId, 1),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(
      (await productModel.findById(productId).lean())?.remainingQuantity,
    ).toBe(1);
    expect(await jobs(PushCategory.STOCK_LOW, productId)).toHaveLength(1);
  });

  it('6. droits revalidés à la lecture : permission retirée, transfert de propriété, préférences du centre', async () => {
    const a = await registerOwner('rights');
    const admin = await seedMember(a.orgId, OrganizationRole.ADMIN);
    const productId = await seedProduct(a.orgId, 100);
    expect((await sell(a.token, productId, 80)).status).toBe(201);
    await dispatcher.runOnce();
    const adminItems = (await list(admin.token)).items;
    expect(adminItems.map((n) => n.category).sort()).toEqual(
      ['sale-created', 'stock-low'].sort(),
    );

    // Rôle rétrogradé en vendeur sans permissions : tout est masqué
    // (liste, compteur, détail), sans suppression.
    await membershipModel.updateOne(
      { _id: new Types.ObjectId(admin.membershipId) },
      { $set: { role: OrganizationRole.SELLER, permissions: [] } },
    );
    expect((await list(admin.token)).items).toEqual([]);
    expect(await count(admin.token)).toBe(0);
    for (const n of adminItems) {
      await request(server())
        .post(`/notifications/${n.id}/open`)
        .set(auth(admin.token))
        .expect(404);
    }
    expect(
      await notificationModel.countDocuments({
        userId: new Types.ObjectId(admin.userId),
      }),
    ).toBe(2);
    // Permission de stock rendue : la notification de seuil seule réapparaît.
    await membershipModel.updateOne(
      { _id: new Types.ObjectId(admin.membershipId) },
      { $set: { permissions: ['products.view_stock_details'] } },
    );
    expect((await list(admin.token)).items.map((n) => n.category)).toEqual([
      'stock-low',
    ]);

    // Préférences du centre : catégorie coupée → masquée et plus créée ;
    // « tout marquer comme lu » ne touche que les visibles.
    const prefs = await request(server())
      .put('/notifications/preferences')
      .set(auth(a.token))
      .send({ saleCreated: false });
    expect(prefs.status).toBe(200);
    expect(prefs.body.categories.saleCreated).toBe(false);
    expect(await ofCategory(a.token, PushCategory.SALE_CREATED)).toEqual([]);
    expect((await sell(a.token, productId, 1)).status).toBe(201);
    await dispatcher.runOnce();
    expect(
      await notificationModel.countDocuments({
        userId: new Types.ObjectId(a.userId),
        category: PushCategory.SALE_CREATED,
      }),
    ).toBe(1);
    const marked = await request(server())
      .post('/notifications/read-all')
      .set(auth(a.token));
    expect(marked.body.marked).toBe(1); // stock-low seul
    const hiddenSale = await notificationModel
      .findOne({
        userId: new Types.ObjectId(a.userId),
        category: PushCategory.SALE_CREATED,
      })
      .lean();
    expect(hiddenSale?.readAt).toBeNull();
    // Champs inconnus refusés.
    await request(server())
      .put('/notifications/preferences')
      .set(auth(a.token))
      .send({ marketing: true })
      .expect(400);
  });

  it('7. push actif : chaque vente dans le centre, push regroupés par fenêtre fixe d’une minute', async () => {
    runtime.activate(config, transport);
    const a = await registerOwner('digest');
    const device = {
      endpoint: `https://fcm.googleapis.com/fcm/send/digest-${randomUUID()}`,
      keys: browserKeys(),
    };
    await request(server())
      .post('/notifications/push/subscription')
      .set(auth(a.token))
      .send({ subscription: device })
      .expect(200);
    // Fenêtre alignée SUIVANTE (appareil enregistré avant) : début + 5 s.
    const windowStart =
      Math.floor(now.getTime() / SALE_DIGEST_WINDOW_MS) *
        SALE_DIGEST_WINDOW_MS +
      SALE_DIGEST_WINDOW_MS;
    setNow(new Date(windowStart + 5_000));
    const productId = await seedProduct(a.orgId, 1000);
    for (let i = 0; i < 3; i += 1) {
      expect((await sell(a.token, productId, 1)).status).toBe(201);
      advance(1_000);
    }
    await dispatcher.runOnce();
    expect(await ofCategory(a.token, PushCategory.SALE_CREATED)).toHaveLength(
      3,
    );
    expect(transport.to(device.endpoint)).toEqual([]); // fenêtre en cours
    setNow(new Date(windowStart + SALE_DIGEST_WINDOW_MS));
    await dispatcher.runOnce();
    const sent = transport.to(device.endpoint);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toMatchObject({
      category: 'sale-digest',
      body: 'De nouvelles ventes ont été enregistrées.',
      url: '/app/sales',
    });
    // Fenêtre suivante : un nouveau regroupement.
    advance(5_000);
    expect((await sell(a.token, productId, 1)).status).toBe(201);
    await dispatcher.runOnce();
    advance(SALE_DIGEST_WINDOW_MS);
    await dispatcher.runOnce();
    expect(transport.to(device.endpoint)).toHaveLength(2);
  });

  it('8. rappel encore pertinent : appareil activé ou préférence réactivée après le rappel → livré une seule fois', async () => {
    runtime.activate(config, transport);
    const a = await registerOwner('catchup');
    const base = Date.now() + 40 * 24 * HOUR;
    await periodModel.updateOne(
      { organizationId: new Types.ObjectId(a.orgId) },
      { $set: { endsAt: new Date(base) } },
    );
    setNow(new Date(base - 20 * HOUR));
    await dispatcher.scanSubscriptionReminders();
    await dispatcher.runOnce();
    expect(
      await ofCategory(a.token, PushCategory.SUBSCRIPTION_ENDING),
    ).toHaveLength(1);

    advance(2 * HOUR); // 18 h avant l'échéance
    const late = {
      endpoint: `https://fcm.googleapis.com/fcm/send/late-${randomUUID()}`,
      keys: browserKeys(),
    };
    await request(server())
      .post('/notifications/push/subscription')
      .set(auth(a.token))
      .send({ subscription: late, preferences: { subscriptionEnding: false } })
      .expect(200);
    await dispatcher.runOnce();
    expect(transport.to(late.endpoint)).toEqual([]); // préférence coupée
    await request(server())
      .patch('/notifications/push/subscription')
      .set(auth(a.token))
      .send({
        endpoint: late.endpoint,
        preferences: { subscriptionEnding: true },
      })
      .expect(200);
    await dispatcher.runOnce();
    await dispatcher.runOnce();
    const reminders = transport
      .to(late.endpoint)
      .filter((s) => s.payload.category === PushCategory.SUBSCRIPTION_ENDING);
    expect(reminders).toHaveLength(1);
    // Après l'échéance : plus de rattrapage.
    setNow(new Date(base + 1));
    const other = {
      endpoint: `https://fcm.googleapis.com/fcm/send/after-${randomUUID()}`,
      keys: browserKeys(),
    };
    await request(server())
      .post('/notifications/push/subscription')
      .set(auth(a.token))
      .send({ subscription: other })
      .expect(200);
    await dispatcher.runOnce();
    expect(
      transport
        .to(other.endpoint)
        .filter((s) => s.payload.category === PushCategory.SUBSCRIPTION_ENDING),
    ).toEqual([]);
  });

  it('9. bilan mensuel : classement net, ex æquo, annulations, produit purgé, invendus, droits, idempotence, mois sans vente', async () => {
    const a = await registerOwner('report');
    const ali = await seedMember(a.orgId, OrganizationRole.SELLER, [], 'Ali');
    const bea = await seedMember(a.orgId, OrganizationRole.SELLER, [], 'Bea');
    const analyst = await seedMember(
      a.orgId,
      OrganizationRole.SELLER,
      ['analytics.read'],
      'Analyste',
    );
    const empty = await registerOwner('report-empty');

    // Mois du bilan : le mois SUIVANT le mois réel (organisations et
    // produits créés avant son début, ventes datées dedans).
    const real = new Date();
    const start = new Date(real.getFullYear(), real.getMonth() + 1, 1);
    const end = new Date(real.getFullYear(), real.getMonth() + 2, 1);
    const inMonth = (day: number) =>
      new Date(start.getFullYear(), start.getMonth(), day, 12);
    const period = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;

    const p1 = await seedProduct(a.orgId, 100, 100, 'Café');
    const p2 = await seedProduct(a.orgId, 100, 100, 'Thé');
    const p3 = await seedProduct(a.orgId, 100, 100, 'Sucre');
    await seedProduct(a.orgId, 100, 100, 'Invendu');
    const introduced = await seedProduct(a.orgId, 100, 100, 'Nouveau');
    await productModel.collection.updateOne(
      { _id: new Types.ObjectId(introduced) },
      { $set: { createdAt: inMonth(10) } },
    );
    const future = await seedProduct(a.orgId, 100, 100, 'Futur');
    await productModel.collection.updateOne(
      { _id: new Types.ObjectId(future) },
      { $set: { createdAt: new Date(end.getTime() + HOUR) } },
    );
    const purgedId = new Types.ObjectId();
    const org = new Types.ObjectId(a.orgId);
    const sale = (
      productId: string | Types.ObjectId,
      sellerId: string,
      quantity: number,
      price: number,
      day: number,
      extra: Record<string, unknown> = {},
    ) =>
      saleModel.create({
        organizationId: org,
        productId: new Types.ObjectId(String(productId)),
        sellerId: new Types.ObjectId(sellerId),
        quantity,
        salePrice: price,
        productName: 'nom à la vente',
        occurredAt: inMonth(day),
        ...extra,
      });
    await sale(p1, ali.userId, 5, 100, 2);
    const corrected = await sale(p2, bea.userId, 9, 100, 3);
    const cancelled = await sale(p3, bea.userId, 20, 100, 4);
    await sale(purgedId, bea.userId, 2, 50, 5, {
      lastKnownProductName: 'Produit purgé',
    });
    await sale(p1, ali.userId, 1, 100, 6);
    // Vente hors du mois : ignorée.
    await sale(p3, ali.userId, 50, 100, 1, {
      occurredAt: new Date(start.getTime() - HOUR),
    });
    // Correction par le propriétaire (vendeur enregistré inchangé) et
    // annulation : règles des analyses.
    await request(server())
      .patch(`/sales/${String(corrected._id)}`)
      .set(auth(a.token))
      .send({ quantity: 6 })
      .expect(200);
    await request(server())
      .delete(`/sales/${String(cancelled._id)}`)
      .set(auth(a.token))
      .expect(204);

    // Début du mois suivant (bornes du mois précédent : test unitaire).
    setNow(new Date(end.getTime() + 10 * 60_000));
    await dispatcher.scanMonthlyReports();
    await dispatcher.scanMonthlyReports(); // idempotent
    expect(
      await reportModel.countDocuments({ period, organizationId: org }),
    ).toBe(1);
    // Première génération : mois précédent seul, aucun mois plus ancien.
    expect(
      await reportModel.countDocuments({
        organizationId: org,
        period: { $ne: period },
      }),
    ).toBe(0);
    await dispatcher.runOnce();
    await dispatcher.runOnce();

    const items = await ofCategory(a.token, PushCategory.MONTHLY_REPORT);
    expect(items).toHaveLength(1);
    expect(items[0].body).toBe('Votre bilan mensuel est disponible.');
    expect(
      await ofCategory(analyst.token, PushCategory.MONTHLY_REPORT),
    ).toHaveLength(1);
    expect(await ofCategory(ali.token, PushCategory.MONTHLY_REPORT)).toEqual(
      [],
    );

    const opened = await request(server())
      .post(`/notifications/${items[0].id}/open`)
      .set(auth(a.token));
    expect(opened.status).toBe(200);
    const report = opened.body.details;
    expect(report).toMatchObject({
      kind: 'monthly-report',
      period,
      salesCount: 4,
    });
    expect(new Date(String(report.periodStart))).toEqual(start);
    expect(new Date(String(report.periodEnd))).toEqual(end);
    expect(report.computedAt).toBeDefined();
    expect(
      report.topProducts.map(
        (p: { name: string; units: number; deleted: boolean }) => [
          p.name,
          p.units,
          p.deleted,
        ],
      ),
    ).toEqual([
      ['Café', 6, false],
      ['Thé', 6, false],
      ['Produit purgé', 2, true],
    ]);
    // Ali 600, Bea 6×100 + 2×50 = 700 → Bea seule (la correction du
    // propriétaire reste attribuée à Bea).
    expect(report.sellersOfMonth.map((s: { name: string }) => s.name)).toEqual([
      'Bea',
    ]);
    expect(JSON.stringify(report)).not.toMatch(
      /purchasePrice|netProfit|margin|cost/i,
    );
    const unsoldNames = report.unsold.items.map(
      (p: { name: string; introducedDuringMonth: boolean }) => [
        p.name,
        p.introducedDuringMonth,
      ],
    );
    expect(unsoldNames).toEqual([
      ['Invendu', false],
      ['Nouveau', true],
      ['Sucre', false],
    ]);
    const page = await request(server())
      .get(`/notifications/${items[0].id}/report/unsold?offset=1&limit=1`)
      .set(auth(a.token));
    expect(page.body).toMatchObject({ total: 3, offset: 1 });
    expect(page.body.items.map((p: { name: string }) => p.name)).toEqual([
      'Nouveau',
    ]);
    // Rétention 7 jours après lecture.
    const stored = await notificationModel.findById(items[0].id).lean();
    expect(stored!.expiresAt!.getTime() - stored!.readAt!.getTime()).toBe(
      7 * 24 * HOUR,
    );

    // Mois sans vente : aucun vendeur, aucun classement.
    const [emptyItem] = await ofCategory(
      empty.token,
      PushCategory.MONTHLY_REPORT,
    );
    const emptyReport = (
      await request(server())
        .post(`/notifications/${emptyItem.id}/open`)
        .set(auth(empty.token))
    ).body.details;
    expect(emptyReport).toMatchObject({
      salesCount: 0,
      topProducts: [],
      sellersOfMonth: [],
    });
    // Ex æquo : vente égalisant Ali sur un nouveau bilan calculé.
    const reports = moduleFixture.get(MonthlyReportService);
    const tie = await reports.compute(org, { period, start, end }, now);
    expect(tie.sellersOfMonth.map((s) => s.name)).toEqual(['Bea']);
    await sale(p2, ali.userId, 1, 100, 7);
    const tied = await reports.compute(org, { period, start, end }, now);
    expect(tied.sellersOfMonth.map((s) => s.name)).toEqual(['Ali', 'Bea']);
  });

  it('10. propriétaire transféré : anciennes notifications réservées au propriétaire masquées', async () => {
    const a = await registerOwner('owner');
    const admin = await seedMember(a.orgId, OrganizationRole.ADMIN);
    const base = Date.now() + 80 * 24 * HOUR;
    await periodModel.updateOne(
      { organizationId: new Types.ObjectId(a.orgId) },
      { $set: { endsAt: new Date(base) } },
    );
    setNow(new Date(base - 10 * HOUR));
    await dispatcher.scanSubscriptionReminders();
    await dispatcher.runOnce();
    expect(
      await ofCategory(a.token, PushCategory.SUBSCRIPTION_ENDING),
    ).toHaveLength(1);
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
    expect(await ofCategory(a.token, PushCategory.SUBSCRIPTION_ENDING)).toEqual(
      [],
    );
    // Nouveau propriétaire : rattrapage du rappel encore pertinent.
    await dispatcher.runOnce();
    expect(
      await ofCategory(admin.token, PushCategory.SUBSCRIPTION_ENDING),
    ).toHaveLength(1);
  });
});
