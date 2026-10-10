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
import { OrganizationInvitation } from './../src/organizations/schemas/invitation.schema';
import type { OrganizationInvitationDocument } from './../src/organizations/schemas/invitation.schema';
import {
  DelegablePermission,
  InvitationStatus,
  MembershipStatus,
  OrganizationRole,
} from './../src/organizations/permissions';
import { Product } from './../src/products/schemas/product.schema';
import type { ProductDocument } from './../src/products/schemas/product.schema';
import { Section } from './../src/sections/schemas/section.schema';
import type { SectionDocument } from './../src/sections/schemas/section.schema';
import { Sale } from './../src/sales/schemas/sale.schema';
import type { SaleDocument } from './../src/sales/schemas/sale.schema';
import { ensureSubscriptionPeriodIndexes } from './../src/subscriptions/subscription-period-indexes';
import { PAYMENT_PROVIDER } from './../src/subscriptions/payments/payment-provider';
import { EventsGateway } from './../src/events/events.gateway';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import { PUSH_CLOCK, PushRuntime } from './../src/push/push-runtime';
import { PushDispatcherService } from './../src/push/push-dispatcher.service';
import { PushOutboxService } from './../src/push/push-outbox.service';
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
  PushJobStatus,
} from './../src/push/schemas/push-job.schema';
import { PushCategory } from './../src/push/schemas/push-category';
import {
  AppNotification,
  NotificationDocument,
} from './../src/notifications/schemas/notification.schema';
import { NotificationCenterService } from './../src/notifications/notification-center.service';
import { MEMBER_ACTIVITY_WINDOW_MS } from './../src/notifications/member-activity';
import {
  previewTerminatedInvitations,
  purgeTerminatedInvitations,
} from './../src/migrations/purge-terminated-invitations';
import {
  inventorySalesNotifications,
  stripSalesNotifications,
} from './../src/migrations/sales-notifications-permission';
import {
  E2E_EMAIL_VERIFIED_AT,
  autoConfirmVerificationEmails,
  createE2eEmailSender,
} from './e2e/email-verification-fixtures';
import {
  acceptWithSession,
  createInvitedAccount,
} from './e2e/invitation-acceptance-fixtures';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';
import { SimulatedPaymentProvider } from './e2e/simulated-payment-provider';
import { until } from './e2e/barriers';
import { INVITATION_TERMS, OWNER_TERMS } from './e2e/legal-acceptance-fixtures';
import { postRegister } from './e2e/registration-fixtures';

/**
 * E2E 1-19A — invitations terminées supprimées, notification « nouveau
 * membre », notifications de ventes par permission dédiée, activité des
 * collaborateurs annoncée au propriétaire (regroupée), push et temps réel.
 *
 * MongoMemoryReplSet (garde anti-27017), AppModule réelle, VRAIS clients
 * Socket.IO, e-mails, paiement et transport push SIMULÉS, horloge des
 * notifications contrôlée (`PUSH_CLOCK`). Le traitement de fond n'est
 * jamais démarré : passes explicites (`runOnce`).
 */

const TEST_JWT_SECRET = 'member-activity-19a-e2e-only';
const E2E_CORS_ORIGIN = 'https://member-activity-19a-e2e.example.com';
const PASSWORD = 'ma-19a-pw-!1x';

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

function tokenOf(res: { body: { invitationUrl?: unknown } }): string {
  return (
    new URL(String(res.body.invitationUrl)).searchParams.get('token') ?? ''
  );
}

interface Client {
  socket: Socket;
  signals: number;
  sentinel: number;
}

interface Listed {
  id: string;
  category: PushCategory;
  body: string;
  link: string;
  readAt: string | null;
}

let now = new Date();
const setNow = (d: Date) => {
  now = new Date(d.getTime());
};
const advance = (ms: number) => setNow(new Date(now.getTime() + ms));
/** Début de la fenêtre de regroupement SUIVANTE + 5 s (fenêtre entière devant). */
const freshWindow = () =>
  setNow(
    new Date(
      Math.floor(Date.now() / MEMBER_ACTIVITY_WINDOW_MS) *
        MEMBER_ACTIVITY_WINDOW_MS +
        MEMBER_ACTIVITY_WINDOW_MS +
        5_000,
    ),
  );

describe('Notifications des membres (e2e 1-19A)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let port = 0;
  let connection: Connection;
  let userModel: Model<UserDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;
  let invitationModel: Model<OrganizationInvitationDocument>;
  let productModel: Model<ProductDocument>;
  let sectionModel: Model<SectionDocument>;
  let saleModel: Model<SaleDocument>;
  let jobModel: Model<PushJobDocument>;
  let notificationModel: Model<NotificationDocument>;
  let runtime: PushRuntime;
  let dispatcher: PushDispatcherService;
  let outbox: PushOutboxService;
  let center: NotificationCenterService;
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

  async function registerOwner(label: string, name?: string) {
    clearThrottle();
    seq += 1;
    const email = `${label}-${seq}-19a@ma.test`;
    const reg = await postRegister(app, {
      ...OWNER_TERMS,
      name: name ?? `Owner ${seq}`,
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
    name: string = role,
  ) {
    seq += 1;
    const email = `${role}-${seq}-19a@ma.test`;
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

  async function seedProduct(orgId: string, name: string, initial = 100) {
    seq += 1;
    const section = await sectionModel.create({
      organizationId: new Types.ObjectId(orgId),
      name: `Rayon ${seq}`,
      description: '',
    });
    const product = await productModel.create({
      organizationId: new Types.ObjectId(orgId),
      sectionId: section._id,
      name,
      imageUrl: 'https://e2e.local/img.png',
      purchasePrice: 100,
      salePrice: 400,
      initialQuantity: initial,
      remainingQuantity: initial,
    });
    return product._id.toHexString();
  }

  const invite = (
    token: string,
    body: { email: string; role: 'admin' | 'seller' },
  ) => {
    clearThrottle();
    return request(server())
      .post('/organizations/invitations')
      .set(auth(token))
      .send(body);
  };

  const sell = (token: string, productId: string, op?: string) =>
    request(server())
      .post('/sales')
      .set(auth(token))
      .send({
        productId,
        quantity: 1,
        salePrice: 400,
        ...(op ? { clientOperationId: op } : {}),
      });

  const list = async (token: string, language = 'fr-FR') => {
    const res = await request(server())
      .get('/notifications?status=all&limit=50')
      .set(auth(token))
      .set('Accept-Language', language);
    expect(res.status).toBe(200);
    return res.body.items as Listed[];
  };
  const ofCategory = async (token: string, category: PushCategory) =>
    (await list(token)).filter((n) => n.category === category);
  const count = async (token: string) => {
    const res = await request(server())
      .get('/notifications/unread-count')
      .set(auth(token));
    expect(res.status).toBe(200);
    return res.body.count as number;
  };
  const open = async (token: string, id: string) => {
    const res = await request(server())
      .post(`/notifications/${id}/open`)
      .set(auth(token));
    return res;
  };
  const jobsOf = (category: PushCategory, organizationId: string) =>
    jobModel
      .find({ category, organizationId: new Types.ObjectId(organizationId) })
      .lean()
      .exec();
  const pendingInvitation = (orgId: string, email: string) =>
    invitationModel
      .findOne({ organizationId: new Types.ObjectId(orgId), email })
      .lean()
      .exec();

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
      invitationModel = moduleFixture.get(
        getModelToken(OrganizationInvitation.name),
      );
      productModel = moduleFixture.get(getModelToken(Product.name));
      sectionModel = moduleFixture.get(getModelToken(Section.name));
      saleModel = moduleFixture.get(getModelToken(Sale.name));
      jobModel = moduleFixture.get(getModelToken(PushJob.name));
      notificationModel = moduleFixture.get(
        getModelToken(AppNotification.name),
      );
      runtime = moduleFixture.get(PushRuntime);
      dispatcher = moduleFixture.get(PushDispatcherService);
      outbox = moduleFixture.get(PushOutboxService);
      center = moduleFixture.get(NotificationCenterService);
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

  // ─── 1. Invitations : acceptation ─────────────────────────────────────────

  it('1. acceptation (compte existant) : invitation supprimée, adhésion, « nouveau membre » aux seuls gestionnaires des membres, auteur exclu, liens inutilisables', async () => {
    const a = await registerOwner('join');
    const admin = await seedMember(a.orgId, OrganizationRole.ADMIN);
    const manager = await seedMember(a.orgId, OrganizationRole.SELLER, [
      'members.manage',
    ]);
    const plain = await seedMember(a.orgId, OrganizationRole.SELLER, [
      'members.invite',
      'sales.notifications',
    ]);
    const b = await registerOwner('join-b');
    const joiner = await registerOwner('joiner');
    await userModel.updateOne(
      { email: joiner.email },
      { $set: { name: 'Awa Diallo' } },
    );

    const issued = await invite(a.token, {
      email: joiner.email,
      role: 'seller',
    });
    expect(issued.status).toBe(201);
    const token = tokenOf(issued);

    const ownerSocket = await connect(a.token);
    const adminSocket = await connect(admin.token);
    const managerSocket = await connect(manager.token);
    const plainSocket = await connect(plain.token);
    const ownerB = await connect(b.token);
    await settle();

    const accepted = await acceptWithSession(server(), joiner.token, token);
    expect(accepted.status).toBe(200);

    // Supprimée de la collection, sans corbeille ; adhésion copiée.
    expect(await pendingInvitation(a.orgId, joiner.email)).toBeNull();
    expect(
      await membershipModel.countDocuments({
        organizationId: new Types.ObjectId(a.orgId),
        userId: new Types.ObjectId(joiner.userId),
        status: MembershipStatus.ACTIVE,
      }),
    ).toBe(1);
    const [joined] = await jobsOf(PushCategory.MEMBER_JOINED, a.orgId);
    expect(joined.actorId!.toHexString()).toBe(joiner.userId);
    // Création de l'invitation par le propriétaire : jamais annoncée.
    expect(await jobsOf(PushCategory.MEMBER_ACTIVITY, a.orgId)).toHaveLength(0);

    // Les deux liens ne désignent plus rien.
    const replay = await acceptWithSession(server(), joiner.token, token);
    expect(replay.status).toBe(400);
    expect(replay.body.code).toBe('INVITATION_INVALID_OR_EXPIRED');
    const link = await request(server())
      .post('/auth/invitations/account-link')
      .send({ token });
    expect(link.status).toBe(400);

    await dispatcher.runOnce();
    await settle();
    expect(ownerSocket.signals).toBe(1);
    expect(adminSocket.signals).toBe(1);
    expect(managerSocket.signals).toBe(1);
    expect(plainSocket.signals).toBe(0);
    expect(ownerB.signals).toBe(0);
    expect(
      await notificationModel.countDocuments({
        userId: new Types.ObjectId(joiner.userId),
      }),
    ).toBe(0);

    const [item] = await ofCategory(a.token, PushCategory.MEMBER_JOINED);
    expect(item).toMatchObject({
      body: 'Awa Diallo a rejoint votre entreprise.',
      link: '/app/organization/members',
      readAt: null,
    });
    const [english] = (await list(a.token, 'en-GB')).filter(
      (n) => n.category === PushCategory.MEMBER_JOINED,
    );
    expect(english.body).toBe('Awa Diallo joined your business.');
    const opened = await open(a.token, item.id);
    expect(opened.status).toBe(200);
    expect(opened.body.details).toMatchObject({
      kind: 'member-joined',
      memberName: 'Awa Diallo',
      role: 'seller',
      active: true,
    });
    // Notification d'un autre : indistinguable d'une absente.
    expect((await open(plain.token, item.id)).status).toBe(404);
    expect((await open(b.token, item.id)).status).toBe(404);

    // Rejeu de la passe : aucun doublon.
    const before = await notificationModel.countDocuments();
    await dispatcher.runOnce();
    expect(await notificationModel.countDocuments()).toBe(before);
  });

  it('2. création de compte par le lien e-mail : invitation et lien de création supprimés, notification ; l’invitation créée par un administrateur est annoncée au propriétaire', async () => {
    const a = await registerOwner('newacc');
    const admin = await seedMember(a.orgId, OrganizationRole.ADMIN, [], 'Ali');
    const email = `newacc-${randomUUID()}@ma.test`;
    const issued = await invite(admin.token, { email, role: 'seller' });
    expect(issued.status).toBe(201);
    const token = tokenOf(issued);

    clearThrottle();
    const created = await createInvitedAccount(
      server(),
      emailSender,
      token,
      email,
      { name: 'Binta Sow', password: PASSWORD },
    );
    expect(created.status).toBe(200);
    expect(await pendingInvitation(a.orgId, email)).toBeNull();

    // Lien du créateur et lien reçu par e-mail : inutilisables ensuite.
    const accountToken = /token=([^\s"&]+)/.exec(
      emailSender.sentTo(email).at(-1)!.text,
    )![1];
    const again = await request(server())
      .post('/auth/invitations/create-account')
      .send({
        ...INVITATION_TERMS,
        token: decodeURIComponent(accountToken),
        name: 'Autre',
        password: PASSWORD,
      });
    expect(again.body.code).toBe('INVITATION_INVALID_OR_EXPIRED');
    expect(again.status).toBe(400);
    const link = await request(server())
      .post('/auth/invitations/account-link')
      .send({ token });
    expect(link.status).toBe(400);

    await dispatcher.runOnce();
    const [joined] = await ofCategory(a.token, PushCategory.MEMBER_JOINED);
    expect(joined.body).toBe('Binta Sow a rejoint votre entreprise.');
    expect(
      await ofCategory(admin.token, PushCategory.MEMBER_JOINED),
    ).toHaveLength(1);
    const [activity] = await ofCategory(a.token, PushCategory.MEMBER_ACTIVITY);
    expect(activity.body).toBe(`Ali a créé l'invitation de « ${email} ».`);
    // L'administrateur auteur n'est jamais notifié de sa propre action,
    // et l'activité est réservée au propriétaire.
    expect(
      await ofCategory(admin.token, PushCategory.MEMBER_ACTIVITY),
    ).toHaveLength(0);
    // Aucun jeton ni lien dans la notification ni dans son détail.
    const opened = await open(a.token, activity.id);
    expect(JSON.stringify(opened.body)).not.toContain(token);
    expect(opened.body.details).toMatchObject({
      kind: 'member-activity',
      actorName: 'Ali',
      entity: 'invitation',
      action: 'created',
      link: '/app/organization/invitations',
    });
  });

  it('3. refus et échecs : mauvais compte, consentement absent, déjà membre, rollback → invitation conservée et aucun événement ; nouvelle tentative possible', async () => {
    const a = await registerOwner('refuse');
    const joiner = await registerOwner('refuse-joiner');
    const other = await registerOwner('refuse-other');
    const issued = await invite(a.token, {
      email: joiner.email,
      role: 'seller',
    });
    const token = tokenOf(issued);

    // Mauvais compte.
    const mismatch = await acceptWithSession(server(), other.token, token);
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.code).toBe('INVITATION_ACCOUNT_MISMATCH');
    // Consentement absent (« Pas maintenant » n'appelle même pas l'API).
    const noConsent = await request(server())
      .post('/auth/invitations/accept')
      .set(auth(joiner.token))
      .send({ token });
    expect(noConsent.status).toBe(400);

    // Échec dans la transaction (après suppression et adhésion) : rollback.
    jest
      .spyOn(outbox, 'memberJoinedInSession')
      .mockRejectedValueOnce(new Error('simulated failure'));
    const failed = await acceptWithSession(server(), joiner.token, token);
    expect(failed.status).toBe(500);

    expect((await pendingInvitation(a.orgId, joiner.email))!.status).toBe(
      InvitationStatus.PENDING,
    );
    expect(
      await membershipModel.countDocuments({
        organizationId: new Types.ObjectId(a.orgId),
        userId: new Types.ObjectId(joiner.userId),
      }),
    ).toBe(0);
    expect(await jobsOf(PushCategory.MEMBER_JOINED, a.orgId)).toHaveLength(0);

    // Déjà membre (même suspendu) : refus stable, invitation intacte.
    const suspended = await seedMember(a.orgId, OrganizationRole.SELLER);
    await membershipModel.updateOne(
      { _id: new Types.ObjectId(suspended.membershipId) },
      { $set: { status: MembershipStatus.SUSPENDED } },
    );
    const second = await invite(a.token, {
      email: suspended.email,
      role: 'seller',
    });
    expect(second.status).toBe(201);
    const already = await acceptWithSession(
      server(),
      suspended.token,
      tokenOf(second),
    );
    expect(already.status).toBe(409);
    expect((await pendingInvitation(a.orgId, suspended.email))!.status).toBe(
      InvitationStatus.PENDING,
    );

    await dispatcher.runOnce();
    expect(await ofCategory(a.token, PushCategory.MEMBER_JOINED)).toHaveLength(
      0,
    );

    // L'invitation conservée reste utilisable.
    const ok = await acceptWithSession(server(), joiner.token, token);
    expect(ok.status).toBe(200);
    expect(await pendingInvitation(a.orgId, joiner.email)).toBeNull();
    expect(await jobsOf(PushCategory.MEMBER_JOINED, a.orgId)).toHaveLength(1);
  });

  it('4. concurrence : deux acceptations simultanées → une seule adhésion, un seul événement, invitation supprimée', async () => {
    const a = await registerOwner('race');
    const joiner = await registerOwner('race-joiner');
    const token = tokenOf(
      await invite(a.token, { email: joiner.email, role: 'seller' }),
    );
    const results = await Promise.all([
      acceptWithSession(server(), joiner.token, token),
      acceptWithSession(server(), joiner.token, token),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s >= 400 && s < 500)).toHaveLength(1);
    expect(
      await membershipModel.countDocuments({
        organizationId: new Types.ObjectId(a.orgId),
        userId: new Types.ObjectId(joiner.userId),
      }),
    ).toBe(1);
    expect(await jobsOf(PushCategory.MEMBER_JOINED, a.orgId)).toHaveLength(1);
    expect(await pendingInvitation(a.orgId, joiner.email)).toBeNull();
  });

  // ─── 2. Révocation ────────────────────────────────────────────────────────

  it('5. révocation : invitation supprimée, liens inutilisables, annoncée au propriétaire seulement si un autre membre révoque', async () => {
    const a = await registerOwner('revoke');
    const admin = await seedMember(a.orgId, OrganizationRole.ADMIN, [], 'Ali');
    freshWindow();
    const email = `revoked-${randomUUID()}@ma.test`;
    const issued = await invite(admin.token, { email, role: 'seller' });
    const id = issued.body.invitation._id as string;
    const token = tokenOf(issued);

    const revoked = await request(server())
      .post(`/organizations/invitations/${id}/revoke`)
      .set(auth(admin.token));
    expect(revoked.status).toBe(200);
    expect(revoked.body.status).toBe('revoked');
    expect(await invitationModel.findById(id).lean()).toBeNull();
    // Seconde révocation et liens : plus rien.
    expect(
      (
        await request(server())
          .post(`/organizations/invitations/${id}/revoke`)
          .set(auth(admin.token))
      ).status,
    ).toBe(404);
    expect(
      (
        await request(server())
          .post('/auth/invitations/account-link')
          .send({ token })
      ).status,
    ).toBe(400);

    // Révocation par le propriétaire : rien à annoncer.
    const own = await invite(a.token, {
      email: `own-${randomUUID()}@ma.test`,
      role: 'seller',
    });
    await request(server())
      .post(`/organizations/invitations/${own.body.invitation._id}/revoke`)
      .set(auth(a.token))
      .expect(200);

    await dispatcher.runOnce();
    const activity = (
      await ofCategory(a.token, PushCategory.MEMBER_ACTIVITY)
    ).map((n) => n.body);
    expect(activity.sort()).toEqual(
      [
        `Ali a créé l'invitation de « ${email} ».`,
        `Ali a révoqué l'invitation de « ${email} ».`,
      ].sort(),
    );
    expect(
      await ofCategory(admin.token, PushCategory.MEMBER_ACTIVITY),
    ).toHaveLength(0);
  });

  // ─── 3. Ventes ────────────────────────────────────────────────────────────

  it('6. vente : permission dédiée `sales.notifications`, auteur exclu, montants réservés à `sales.view_all`, isolation, rejeu sans doublon', async () => {
    const a = await registerOwner('sales', 'Patron');
    const admin = await seedMember(a.orgId, OrganizationRole.ADMIN);
    const receiver = await seedMember(a.orgId, OrganizationRole.SELLER, [
      'sales.notifications',
    ]);
    const receiverWithFigures = await seedMember(
      a.orgId,
      OrganizationRole.SELLER,
      ['sales.notifications', 'sales.view_all'],
    );
    const viewerOnly = await seedMember(a.orgId, OrganizationRole.SELLER, [
      'sales.view_all',
    ]);
    const author = await seedMember(
      a.orgId,
      OrganizationRole.SELLER,
      ['sales.notifications'],
      'Vendeuse',
    );
    const b = await registerOwner('sales-b');
    const productId = await seedProduct(a.orgId, 'Savon');

    const op = randomUUID();
    const sale = await sell(author.token, productId, op);
    expect(sale.status).toBe(201);
    const replay = await sell(author.token, productId, op);
    expect([200, 201]).toContain(replay.status);
    expect(await jobsOf(PushCategory.SALE_CREATED, a.orgId)).toHaveLength(1);
    // La création de vente n'est jamais une « activité » (pas de doublon).
    expect(await jobsOf(PushCategory.MEMBER_ACTIVITY, a.orgId)).toHaveLength(0);

    await dispatcher.runOnce();
    await dispatcher.runOnce();
    const received = async (token: string) =>
      (await ofCategory(token, PushCategory.SALE_CREATED)).length;
    expect(await received(a.token)).toBe(1);
    expect(await received(admin.token)).toBe(1);
    expect(await received(receiver.token)).toBe(1);
    expect(await received(receiverWithFigures.token)).toBe(1);
    expect(await received(viewerOnly.token)).toBe(0);
    expect(await received(author.token)).toBe(0);
    expect(await received(b.token)).toBe(0);

    const detail = async (token: string) => {
      const [n] = await ofCategory(token, PushCategory.SALE_CREATED);
      const res = await open(token, n.id);
      expect(res.status).toBe(200);
      return res.body.details as Record<string, unknown>;
    };
    const hidden = await detail(receiver.token);
    expect(hidden).toMatchObject({
      kind: 'sale',
      productName: 'Savon',
      sellerName: 'Vendeuse',
    });
    expect(hidden).not.toHaveProperty('total');
    expect(hidden).not.toHaveProperty('salePrice');
    expect(hidden).not.toHaveProperty('quantity');
    expect(await detail(receiverWithFigures.token)).toMatchObject({
      quantity: 1,
      total: 400,
    });
    expect(await detail(a.token)).toMatchObject({ total: 400 });

    // Vente du propriétaire : il n'est pas notifié, l'administrateur oui.
    expect((await sell(a.token, productId)).status).toBe(201);
    await dispatcher.runOnce();
    expect(await received(a.token)).toBe(1);
    expect(await received(admin.token)).toBe(2);

    // Permission retirée : notifications masquées aussitôt (droits actuels).
    await membershipModel.updateOne(
      { _id: new Types.ObjectId(receiver.membershipId) },
      { $set: { permissions: [] } },
    );
    const relogged = await login(receiver.email);
    expect(await received(relogged)).toBe(0);
  });

  it('7. panne du centre de notifications : la vente réussie reste, l’événement est repris à la passe suivante sans doublon', async () => {
    const a = await registerOwner('outage');
    const seller = await seedMember(a.orgId, OrganizationRole.SELLER);
    const productId = await seedProduct(a.orgId, 'Riz');
    const sale = await sell(seller.token, productId);
    expect(sale.status).toBe(201);

    jest
      .spyOn(center, 'createFromJob')
      .mockRejectedValueOnce(new Error('simulated outage'));
    await expect(dispatcher.runOnce()).rejects.toThrow('simulated outage');
    expect(await saleModel.countDocuments({ _id: sale.body._id })).toBe(1);
    const [job] = await jobsOf(PushCategory.SALE_CREATED, a.orgId);
    expect(job.status).toBe(PushJobStatus.PENDING);

    await dispatcher.runOnce();
    await dispatcher.runOnce();
    expect(await ofCategory(a.token, PushCategory.SALE_CREATED)).toHaveLength(
      1,
    );
  });

  // ─── 4. Activité des collaborateurs ───────────────────────────────────────

  it('8. produits : modification, corbeille groupée, restauration, suppression définitive → propriétaire seul, récapitulatif, lisible après suppression ; rien pour ses propres actions ni sur échec ; reprise sans doublon', async () => {
    const a = await registerOwner('catalog');
    const admin = await seedMember(a.orgId, OrganizationRole.ADMIN, [], 'Ali');
    const seller = await seedMember(a.orgId, OrganizationRole.SELLER);
    const ids = await Promise.all(
      ['Savon', 'Huile', 'Sucre'].map((n) => seedProduct(a.orgId, n)),
    );
    const extra = await seedProduct(a.orgId, 'Thé');
    freshWindow();
    const ownerSocket = await connect(a.token);
    await settle();

    // Modification (multipart comme le web).
    await request(server())
      .patch(`/products/${extra}`)
      .set(auth(admin.token))
      .field('name', 'Thé vert')
      .expect(200);
    // Action groupée de la corbeille (le web envoie N requêtes).
    const trashed = await Promise.all(
      ids.map((id) =>
        request(server()).delete(`/products/${id}`).set(auth(admin.token)),
      ),
    );
    expect(trashed.map((r) => r.status)).toEqual([200, 200, 200]);
    await request(server())
      .patch(`/products/${ids[0]}/restore`)
      .set(auth(admin.token))
      .expect(200);
    await request(server())
      .delete(`/products/${ids[1]}/permanent`)
      .set(auth(admin.token))
      .expect(200);

    // Échecs et refus : aucun événement.
    await request(server())
      .delete(`/products/${new Types.ObjectId().toHexString()}`)
      .set(auth(admin.token))
      .expect(404);
    await request(server())
      .delete(`/products/${ids[2]}`)
      .set(auth(seller.token))
      .expect(403);
    // Action du propriétaire : jamais annoncée.
    await request(server())
      .patch(`/products/${extra}`)
      .set(auth(a.token))
      .field('name', 'Thé noir')
      .expect(200);
    expect(await jobsOf(PushCategory.MEMBER_ACTIVITY, a.orgId)).toHaveLength(6);

    await dispatcher.runOnce();
    await settle();
    expect(ownerSocket.signals).toBeGreaterThan(0);
    const bodies = (await ofCategory(a.token, PushCategory.MEMBER_ACTIVITY))
      .map((n) => n.body)
      .sort();
    expect(bodies).toEqual(
      [
        'Ali a modifié le produit « Thé vert ».',
        'Ali a mis à la corbeille 3 produits.',
        'Ali a restauré le produit « Savon ».',
        'Ali a supprimé définitivement le produit « Huile ».',
      ].sort(),
    );
    for (const member of [admin, seller]) {
      expect(
        await ofCategory(member.token, PushCategory.MEMBER_ACTIVITY),
      ).toHaveLength(0);
    }

    // Détail du regroupement : cibles figées, liens vers les seules cibles
    // encore présentes (corbeille, catalogue), jamais vers la supprimée.
    const items = await ofCategory(a.token, PushCategory.MEMBER_ACTIVITY);
    const group = items.find((n) => n.body.includes('3 produits'))!;
    const groupDetail = (await open(a.token, group.id)).body.details;
    expect(groupDetail).toMatchObject({
      kind: 'member-activity',
      entity: 'product',
      action: 'trashed',
      count: 3,
      totalTargets: 3,
    });
    const byName = Object.fromEntries(
      (
        groupDetail.targets as Array<{
          name: string;
          link: string | null;
          removed: boolean;
        }>
      ).map((t) => [t.name, t]),
    );
    expect(byName['Savon'].link).toBe(`/app/catalog/products/${ids[0]}`);
    expect(byName['Huile']).toMatchObject({ link: null, removed: true });
    expect(byName['Sucre'].link).toBe('/app/trash');
    const purged = items.find((n) => n.body.includes('définitivement'))!;
    expect((await open(a.token, purged.id)).body.details).toMatchObject({
      targets: [{ name: 'Huile', link: null, removed: true }],
    });

    // Reprise après crash (travaux repassés « pending ») : rien en double.
    await jobModel.updateMany(
      {
        organizationId: new Types.ObjectId(a.orgId),
        category: PushCategory.MEMBER_ACTIVITY,
        'activity.action': 'trashed',
      },
      { $set: { status: PushJobStatus.PENDING } },
    );
    const total = await notificationModel.countDocuments();
    await dispatcher.runOnce();
    expect(await notificationModel.countDocuments()).toBe(total);
    const stored = await notificationModel.findById(group.id).lean();
    expect(stored!.activityCount).toBe(3);

    // Fenêtre suivante : nouveau récapitulatif, le précédent est intact.
    advance(MEMBER_ACTIVITY_WINDOW_MS);
    await request(server())
      .delete(`/products/${ids[0]}`)
      .set(auth(admin.token))
      .expect(200);
    await dispatcher.runOnce();
    expect(
      (await ofCategory(a.token, PushCategory.MEMBER_ACTIVITY)).filter((n) =>
        n.body.startsWith('Ali a mis à la corbeille'),
      ),
    ).toHaveLength(2);
  });

  it('9. catalogue : sections créées, modifiées, mises à la corbeille, restaurées, supprimées définitivement', async () => {
    const a = await registerOwner('sections');
    const editor = await seedMember(
      a.orgId,
      OrganizationRole.SELLER,
      ['catalog.manage', 'trash.manage'],
      'Moussa',
    );
    freshWindow();
    const created = await request(server())
      .post('/sections')
      .set(auth(editor.token))
      .send({ name: 'Boissons' })
      .expect(201);
    const id = created.body._id as string;
    await request(server())
      .patch(`/sections/${id}`)
      .set(auth(editor.token))
      .send({ name: 'Boissons fraîches' })
      .expect(200);
    await request(server())
      .delete(`/sections/${id}`)
      .set(auth(editor.token))
      .expect(200);
    await request(server())
      .patch(`/sections/${id}/restore`)
      .set(auth(editor.token))
      .expect(200);
    await request(server())
      .delete(`/sections/${id}/permanent`)
      .set(auth(editor.token))
      .expect(200);

    await dispatcher.runOnce();
    expect(
      (await ofCategory(a.token, PushCategory.MEMBER_ACTIVITY))
        .map((n) => n.body)
        .sort(),
    ).toEqual(
      [
        'Moussa a créé la section « Boissons ».',
        'Moussa a modifié la section « Boissons fraîches ».',
        'Moussa a mis à la corbeille la section « Boissons fraîches ».',
        'Moussa a restauré la section « Boissons fraîches ».',
        'Moussa a supprimé définitivement la section « Boissons fraîches ».',
      ].sort(),
    );
  });

  it('10. autres écritures déléguées : membres, identité visuelle, modification et annulation de vente (sans doublon avec « nouvelle vente »)', async () => {
    const a = await registerOwner('others');
    const admin = await seedMember(a.orgId, OrganizationRole.ADMIN, [], 'Ali');
    const seller = await seedMember(
      a.orgId,
      OrganizationRole.SELLER,
      [],
      'Fatou',
    );
    const productId = await seedProduct(a.orgId, 'Savon');
    freshWindow();

    await request(server())
      .patch(`/organizations/members/${seller.membershipId}`)
      .set(auth(admin.token))
      .send({ permissions: ['analytics.read'] })
      .expect(200);
    await request(server())
      .patch('/organizations/current/branding')
      .set(auth(admin.token))
      .field('brandColor', '#123456')
      .expect(200);
    const sale = await sell(seller.token, productId);
    expect(sale.status).toBe(201);
    await request(server())
      .patch(`/sales/${sale.body._id}`)
      .set(auth(seller.token))
      .send({ quantity: 2 })
      .expect(200);
    await request(server())
      .delete(`/sales/${sale.body._id}`)
      .set(auth(seller.token))
      .expect(204);
    await request(server())
      .delete(`/sales/${sale.body._id}`)
      .set(auth(seller.token))
      .expect(404);

    await dispatcher.runOnce();
    expect(
      (await ofCategory(a.token, PushCategory.MEMBER_ACTIVITY))
        .map((n) => n.body)
        .sort(),
    ).toEqual(
      [
        'Ali a modifié le membre « Fatou ».',
        "Ali a modifié l'identité visuelle.",
        'Fatou a modifié une vente de « Savon ».',
        'Fatou a annulé une vente de « Savon ».',
      ].sort(),
    );
    // Vente annulée avant la passe : la « nouvelle vente » n'est plus
    // pertinente (règle 1-16A.1 inchangée), jamais annoncée en double.
    expect(await ofCategory(a.token, PushCategory.SALE_CREATED)).toHaveLength(
      0,
    );
  });

  // ─── 5. Temps réel, reconnexion, push ─────────────────────────────────────

  it('11. temps réel puis reconnexion : signal privé reçu, notification retrouvée avec une nouvelle session ; compteur non lu', async () => {
    const a = await registerOwner('realtime');
    const admin = await seedMember(a.orgId, OrganizationRole.ADMIN, [], 'Ali');
    const productId = await seedProduct(a.orgId, 'Lait');
    const ownerSocket = await connect(a.token);
    const adminSocket = await connect(admin.token);
    await settle();
    await request(server())
      .delete(`/products/${productId}`)
      .set(auth(admin.token))
      .expect(200);
    await dispatcher.runOnce();
    await settle();
    expect(ownerSocket.signals).toBe(1);
    expect(adminSocket.signals).toBe(0);

    ownerSocket.socket.disconnect();
    const fresh = await login(a.email);
    expect(await count(fresh)).toBe(1);
    const [item] = await ofCategory(fresh, PushCategory.MEMBER_ACTIVITY);
    expect(item.body).toBe('Ali a mis à la corbeille le produit « Lait ».');
  });

  it('12. push actif : un seul push générique par regroupement, en fin de fenêtre', async () => {
    runtime.activate(config, transport);
    const a = await registerOwner('push');
    const admin = await seedMember(a.orgId, OrganizationRole.ADMIN, [], 'Ali');
    const device = {
      endpoint: `https://fcm.googleapis.com/fcm/send/activity-${randomUUID()}`,
      keys: browserKeys(),
    };
    await request(server())
      .post('/notifications/push/subscription')
      .set(auth(a.token))
      .send({ subscription: device })
      .expect(200);
    freshWindow();
    const ids = await Promise.all(
      ['A', 'B', 'C'].map((n) => seedProduct(a.orgId, n)),
    );
    for (const id of ids) {
      await request(server())
        .delete(`/products/${id}`)
        .set(auth(admin.token))
        .expect(200);
    }
    await dispatcher.runOnce();
    expect(transport.to(device.endpoint)).toEqual([]);
    const windowEnd =
      Math.floor(now.getTime() / MEMBER_ACTIVITY_WINDOW_MS) *
        MEMBER_ACTIVITY_WINDOW_MS +
      MEMBER_ACTIVITY_WINDOW_MS;
    setNow(new Date(windowEnd));
    await dispatcher.runOnce();
    const sent = transport.to(device.endpoint);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toMatchObject({
      category: 'member-activity',
      body: 'Un collaborateur a modifié les données de votre entreprise.',
      url: '/app/notifications',
    });
    // Écran verrouillé : ni nom de personne ni nom de produit.
    expect(JSON.stringify(sent[0].payload)).not.toMatch(/Ali|« /);
  });

  // ─── 6. Nettoyage historique ──────────────────────────────────────────────

  it('13. nettoyage historique : aperçu, puis suppression idempotente des seules invitations acceptées ou révoquées', async () => {
    const organizationId = new Types.ObjectId();
    const invitedById = new Types.ObjectId();
    const doc = (status: InvitationStatus) => ({
      organizationId,
      email: `${status}-${randomUUID()}@legacy.test`,
      role: 'seller',
      permissions: [],
      tokenHash: randomBytes(32).toString('hex'),
      invitedById,
      status,
      expiresAt: new Date(Date.now() + 3_600_000),
      acceptedAt: null,
    });
    await invitationModel.collection.insertMany([
      doc(InvitationStatus.ACCEPTED),
      doc(InvitationStatus.ACCEPTED),
      doc(InvitationStatus.REVOKED),
      doc(InvitationStatus.PENDING),
      doc(InvitationStatus.EXPIRED),
    ]);
    // Les parcours des tests précédents n'ont laissé aucune invitation
    // terminée : seules les anciennes sont comptées.
    expect(await previewTerminatedInvitations(connection)).toEqual({
      accepted: 2,
      revoked: 1,
      total: 3,
    });
    expect(await invitationModel.countDocuments({ organizationId })).toBe(5);
    expect(await purgeTerminatedInvitations(connection)).toBe(3);
    expect(await purgeTerminatedInvitations(connection)).toBe(0);
    expect(await previewTerminatedInvitations(connection)).toEqual({
      accepted: 0,
      revoked: 0,
      total: 0,
    });
    const left = await invitationModel
      .find({ organizationId })
      .select({ status: 1 })
      .lean();
    expect(left.map((i) => i.status).sort()).toEqual([
      InvitationStatus.EXPIRED,
      InvitationStatus.PENDING,
    ]);
  });
  // ─── 7. Compatibilité de `sales.notifications` ────────────────────────────

  it('14. formulaire de membre antérieur (sans catalogue) : `sales.notifications` jamais retirée à son insu ; formulaire actuel : retrait explicite possible', async () => {
    const a = await registerOwner('catalog-v');
    const admin = await seedMember(a.orgId, OrganizationRole.ADMIN);
    const seller = await seedMember(a.orgId, OrganizationRole.SELLER);
    const patch = (token: string, body: object, catalog?: number) =>
      request(server())
        .patch(
          `/organizations/members/${seller.membershipId}${
            catalog ? `?permissionsCatalog=${catalog}` : ''
          }`,
        )
        .set(auth(token))
        .send(body);
    const stored = async () =>
      (await membershipModel.findById(seller.membershipId).lean())!.permissions;

    // Attribution par le web actuel.
    expect(
      (await patch(a.token, { permissions: ['sales.notifications'] }, 2))
        .status,
    ).toBe(200);
    expect(await stored()).toEqual(['sales.notifications']);

    // Ancien formulaire (propriétaire puis administrateur) : il envoie la
    // liste qu'il connaît ; la permission inconnue de lui est conservée.
    expect(
      (await patch(a.token, { permissions: ['analytics.read'] })).status,
    ).toBe(200);
    expect((await stored()).sort()).toEqual([
      'analytics.read',
      'sales.notifications',
    ]);
    const byAdmin = await patch(admin.token, {
      permissions: [],
      status: 'active',
    });
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.body.permissions).toEqual(['sales.notifications']);
    // Catalogue falsifié : traité comme le plus ancien.
    await patch(a.token, { permissions: [] }, 99).expect(200);
    expect(await stored()).toEqual(['sales.notifications']);

    // Web actuel : le retrait explicite est appliqué.
    await patch(a.token, { permissions: [] }, 2).expect(200);
    expect(await stored()).toEqual([]);

    // Invitation portant la permission : recopiée à l'acceptation.
    const joiner = await registerOwner('catalog-joiner');
    clearThrottle();
    const issued = await request(server())
      .post('/organizations/invitations')
      .set(auth(a.token))
      .send({
        email: joiner.email,
        role: 'seller',
        permissions: ['sales.notifications'],
      });
    expect(issued.status).toBe(201);
    expect(
      (await acceptWithSession(server(), joiner.token, tokenOf(issued))).status,
    ).toBe(200);
    const joined = await membershipModel
      .findOne({
        organizationId: new Types.ObjectId(a.orgId),
        userId: new Types.ObjectId(joiner.userId),
      })
      .lean();
    expect(joined!.permissions).toEqual(['sales.notifications']);
  });

  it('15. retour arrière : inventaire de TOUS les porteurs (memberships de tout rôle et statut, invitations), aperçu puis retrait idempotent', async () => {
    const a = await registerOwner('rollback');
    const seller = await seedMember(a.orgId, OrganizationRole.SELLER, [
      'sales.notifications',
      'analytics.read',
    ]);
    const admin = await seedMember(a.orgId, OrganizationRole.ADMIN, [
      'sales.notifications',
    ]);
    await membershipModel.updateOne(
      { _id: new Types.ObjectId(admin.membershipId) },
      { $set: { status: MembershipStatus.SUSPENDED } },
    );
    clearThrottle();
    await request(server())
      .post('/organizations/invitations')
      .set(auth(a.token))
      .send({
        email: `rollback-${randomUUID()}@ma.test`,
        role: 'seller',
        permissions: ['sales.notifications'],
      })
      .expect(201);

    const before = await inventorySalesNotifications(connection);
    // Tests précédents compris : au moins ces porteurs, de chaque nature.
    expect(before.memberships.byRole.seller).toBeGreaterThanOrEqual(1);
    expect(before.memberships.byRole.admin).toBeGreaterThanOrEqual(1);
    expect(before.memberships.byStatus.suspended).toBeGreaterThanOrEqual(1);
    expect(before.invitations.byStatus.pending).toBeGreaterThanOrEqual(1);
    // L'inventaire n'écrit rien.
    expect(await inventorySalesNotifications(connection)).toEqual(before);

    const removed = await stripSalesNotifications(connection);
    expect(removed).toEqual({
      memberships: before.memberships.total,
      invitations: before.invitations.total,
    });
    expect(await stripSalesNotifications(connection)).toEqual({
      memberships: 0,
      invitations: 0,
    });
    const after = await inventorySalesNotifications(connection);
    expect(after.memberships.total + after.invitations.total).toBe(0);
    // Les autres permissions sont intactes.
    expect(
      (await membershipModel.findById(seller.membershipId).lean())!.permissions,
    ).toEqual(['analytics.read']);
  });
});
