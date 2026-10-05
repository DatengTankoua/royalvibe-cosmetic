import 'reflect-metadata';
import { randomUUID } from 'crypto';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { Model, Types } from 'mongoose';
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
import { Organization } from './../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from './../src/organizations/schemas/organization.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import {
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
} from './../src/organizations/permissions';
import { SubscriptionSource } from './../src/subscriptions/subscription-terms';
import {
  SubscriptionPeriod,
  SubscriptionPeriodDocument,
} from './../src/subscriptions/schemas/subscription-period.schema';
import { ensureSubscriptionPeriodIndexes } from './../src/subscriptions/subscription-period-indexes';
import {
  MongooseSession,
  SubscriptionsService,
} from './../src/subscriptions/subscriptions.service';
import { SubscriptionSignalsService } from './../src/subscriptions/subscription-signals.service';
import {
  SubscriptionPayment,
  SubscriptionPaymentDocument,
} from './../src/subscriptions/payments/schemas/subscription-payment.schema';
import { PAYMENT_PROVIDER } from './../src/subscriptions/payments/payment-provider';
import { SubscriptionPaymentsService } from './../src/subscriptions/payments/subscription-payments.service';
import { EventsGateway } from './../src/events/events.gateway';
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
import { until } from './e2e/barriers';

/**
 * E2E 1-15F — signaux temps réel des abonnements et paiements, sur le replica
 * set éphémère (garde anti-27017), avec de VRAIS clients Socket.IO et le
 * prestataire SIMULÉ (`overrideProvider`) ; aucun réseau externe.
 *
 * Prouve : émission après commit seulement, payload `{}`, destinataires lus
 * en base (propriétaire actif réel SEUL pour `payments:changed` et
 * `subscription:changed` ; aucun administrateur), aucune émission sur refus, rejeu, rollback ou
 * écriture sans effet, organisation B jamais touchée, suspension prioritaire,
 * panne d'émission sans effet HTTP, aucune consultation du prestataire due à
 * un signal.
 *
 * Absences prouvées sans délai arbitraire : les promesses d'émission du
 * service de signaux sont attendues, puis une SENTINELLE est diffusée à tous
 * les sockets ; chaque socket la reçoit après tout signal émis avant elle
 * (ordre garanti par connexion).
 */

const TEST_JWT_SECRET = 'realtime-subscription-payments-15f-e2e-only';
const E2E_CORS_ORIGIN = 'https://realtime-payments-15f-e2e.example.com';
const PASSWORD = 'rt-15f-pw-!1x';
const PHONE = '677123456';
const SIGNALS = ['payments:changed', 'subscription:changed'] as const;

type Received = { event: string; payload: unknown };
type PaymentBody = {
  paymentId: string;
  reference: string;
  status: string;
  replayed?: boolean;
};

interface Client {
  label: string;
  socket: Socket;
  received: Received[];
  sentinels: number;
}

const sim = new SimulatedPaymentProvider();

describe('Temps réel abonnements et paiements (e2e 1-15F)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let port = 0;
  let userModel: Model<UserDocument>;
  let organizationModel: Model<OrganizationDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;
  let periodModel: Model<SubscriptionPeriodDocument>;
  let paymentModel: Model<SubscriptionPaymentDocument>;
  let subscriptions: SubscriptionsService;
  let signals: SubscriptionSignalsService;
  let payments: SubscriptionPaymentsService;
  let gateway: EventsGateway;
  let seq = 0;
  let sentinel = 0;
  const emailSender = createE2eEmailSender();
  const clients: Client[] = [];
  /** Promesses d'émission en cours (service de signaux espionné). */
  const inflight: Promise<void>[] = [];
  /** Journal d'ordre : fin de transaction et appels d'émission. */
  const journal: string[] = [];

  const server = () => app.getHttpServer();
  const clearThrottle = () =>
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();

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
    const email = `${label}-${seq}-15f@rt.test`;
    const reg = await request(server())
      .post('/auth/register')
      .send({
        name: 'Owner',
        email,
        password: PASSWORD,
        organizationName: `Org ${label} ${seq}`,
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
  ) {
    seq += 1;
    const email = `${role}-${seq}-15f@rt.test`;
    const user = await userModel.create({
      emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
      name: role,
      email,
      password: await bcrypt.hash(PASSWORD, 10),
      // Rôle legacy `admin` : n'ouvre JAMAIS les paiements.
      role: UserRole.ADMIN,
    });
    const membership = await membershipModel.create({
      organizationId: new Types.ObjectId(orgId),
      userId: user._id,
      role,
      status: MembershipStatus.ACTIVE,
      permissions: [],
    });
    return {
      email,
      userId: user._id.toHexString(),
      membershipId: membership._id.toHexString(),
      token: await login(email),
    };
  }

  /** Client Socket.IO réel ; résout à la connexion (handshake accepté). */
  function connect(label: string, token: string): Promise<Client> {
    const socket = io(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      reconnection: false,
      timeout: 4_000,
      extraHeaders: { origin: E2E_CORS_ORIGIN },
      auth: { token },
    });
    const client: Client = { label, socket, received: [], sentinels: 0 };
    clients.push(client);
    for (const event of SIGNALS) {
      socket.on(event, (payload: unknown) =>
        client.received.push({ event, payload }),
      );
    }
    socket.on('test:sentinel', (n: number) => (client.sentinels = n));
    return new Promise((resolve, reject) => {
      socket.once('connect', () => resolve(client));
      socket.once('connect_error', (e) => reject(e));
    });
  }

  /**
   * Toutes les émissions demandées sont faites, puis une sentinelle diffusée
   * à chaque socket connecté est reçue : tout signal antérieur l'est aussi.
   */
  async function settle(): Promise<void> {
    while (inflight.length) await inflight.shift();
    sentinel += 1;
    const n = sentinel;
    gateway.server.emit('test:sentinel', n);
    await until(
      () => clients.every((c) => !c.socket.connected || c.sentinels >= n),
      `sentinelle ${n}`,
    );
  }

  const count = (client: Client, event: string) =>
    client.received.filter((r) => r.event === event).length;
  const total = (client: Client) => client.received.length;
  const mark = () => clients.map((c) => c.received.length);
  /** Signaux reçus par `client` depuis `marks`. */
  const since = (client: Client, marks: number[]) =>
    client.received.slice(marks[clients.indexOf(client)] ?? 0);

  const pay = async (
    token: string,
    clientOperationId: string = randomUUID(),
  ): Promise<{ status: number; body: PaymentBody }> => {
    clearThrottle();
    const res = await request(server())
      .post('/organizations/current/subscription/payments')
      .set('Authorization', `Bearer ${token}`)
      .send({ term: 'monthly', payerPhone: PHONE, clientOperationId });
    return { status: res.status, body: res.body as PaymentBody };
  };
  const refresh = (token: string, paymentId: string) => {
    clearThrottle();
    return request(server())
      .post(`/organizations/current/subscription/payments/${paymentId}/refresh`)
      .set('Authorization', `Bearer ${token}`);
  };
  const paymentPeriods = (paymentId: string) =>
    periodModel.countDocuments({
      source: SubscriptionSource.PAYMENT,
      sourceReference: `payment:${paymentId}`,
    });

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

      userModel = moduleFixture.get(getModelToken('User'));
      organizationModel = moduleFixture.get(getModelToken(Organization.name));
      membershipModel = moduleFixture.get(
        getModelToken(OrganizationMembership.name),
      );
      periodModel = moduleFixture.get(getModelToken(SubscriptionPeriod.name));
      paymentModel = moduleFixture.get(getModelToken(SubscriptionPayment.name));
      subscriptions = moduleFixture.get(SubscriptionsService);
      signals = moduleFixture.get(SubscriptionSignalsService);
      payments = moduleFixture.get(SubscriptionPaymentsService);
      gateway = moduleFixture.get(EventsGateway);
      await ensureSubscriptionPeriodIndexes(
        moduleFixture.get(getConnectionToken()),
      );

      // Espions sans changement de comportement : promesses d'émission
      // suivies, ordre consigné (`journal`).
      for (const method of [
        'paymentsChanged',
        'subscriptionChanged',
      ] as const) {
        const original = signals[method].bind(signals);
        jest
          .spyOn(signals, method)
          .mockImplementation((organizationId: string): Promise<void> => {
            journal.push(`emit:${method}`);
            const promise: Promise<void> = original(organizationId);
            inflight.push(promise);
            return promise;
          });
      }
    } catch (error) {
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  beforeEach(() => {
    sim.reset();
    journal.length = 0;
  });

  afterEach(async () => {
    await settle();
    for (const c of clients) c.socket.disconnect();
    clients.length = 0;
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app?.close();
    await stopEphemeralMongoSafe();
  });

  it('1. création : les deux onglets du propriétaire reçoivent `payments:changed` {} ; admin et organisation B rien ; rejeu et refus muets', async () => {
    const a = await registerOwner('a');
    const admin = await seedMember(a.orgId, OrganizationRole.ADMIN);
    const b = await registerOwner('b');
    const tab1 = await connect('owner-tab1', a.token);
    const tab2 = await connect('owner-tab2', a.token);
    const adminA = await connect('admin-a', admin.token);
    const ownerB = await connect('owner-b', b.token);
    await settle();

    const operation = randomUUID();
    const created = await pay(a.token, operation);
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('pending');
    await settle();
    for (const tab of [tab1, tab2]) {
      expect(tab.received).toEqual([
        { event: 'payments:changed', payload: {} },
      ]);
    }
    expect(total(adminA)).toBe(0);
    expect(total(ownerB)).toBe(0);
    expect(sim.initiations).toHaveLength(1);

    // Rejeu du même UUID : aucune écriture, aucun signal.
    const marks = mark();
    const replay = await pay(a.token, operation);
    expect(replay.status).toBe(201);
    expect(replay.body.replayed).toBe(true);
    // Second paiement alors qu'un paiement est ouvert : refus, aucun signal.
    const refused = await pay(a.token);
    expect(refused.status).toBe(409);
    // Administrateur : refus owner-only, aucun signal ni consultation.
    const adminRefresh = await refresh(admin.token, created.body.paymentId);
    expect(adminRefresh.status).toBe(403);
    await settle();
    for (const c of clients) expect(since(c, marks)).toEqual([]);
    expect(sim.initiations).toHaveLength(1);
    expect(sim.statusCalls).toBe(0);
  });

  it('2. vérification sans changement (`pending` → `pending`) : une consultation, aucun signal', async () => {
    const a = await registerOwner('nochange');
    const tab = await connect('owner', a.token);
    const created = await pay(a.token);
    await settle();
    const marks = mark();

    const res = await refresh(a.token, created.body.paymentId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    await settle();
    expect(since(tab, marks)).toEqual([]);
    expect(sim.statusCalls).toBe(1);
  });

  it('3. succès : émissions APRÈS le commit ; propriétaire `payments` + `subscription`, admin et B rien ; une seule période', async () => {
    const a = await registerOwner('success');
    const admin = await seedMember(a.orgId, OrganizationRole.ADMIN);
    const b = await registerOwner('success-b');
    const created = await pay(a.token);
    const paymentId = created.body.paymentId;
    sim.settle(created.body.reference, 'succeeded');

    const tab1 = await connect('owner-tab1', a.token);
    const tab2 = await connect('owner-tab2', a.token);
    const adminA = await connect('admin-a', admin.token);
    const ownerB = await connect('owner-b', b.token);
    await settle();

    // Lecture en base À LA RÉCEPTION : la période est déjà validée.
    const seenAtReception: number[] = [];
    tab1.socket.once('subscription:changed', () => {
      void paymentPeriods(paymentId).then((n) => seenAtReception.push(n));
    });
    // Fin de la transaction consignée : aucune émission avant.
    const original = subscriptions.runInGrantTransaction.bind(subscriptions);
    const grant = jest
      .spyOn(subscriptions, 'runInGrantTransaction')
      .mockImplementationOnce(async (work, options) => {
        const value = await original(async (session: MongooseSession) => {
          const result = await work(session);
          journal.push('callback-done');
          return result;
        }, options);
        journal.push('committed');
        return value;
      });

    journal.length = 0;
    const res = await refresh(a.token, paymentId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('succeeded');
    await settle();
    grant.mockRestore();

    expect(journal.indexOf('committed')).toBeGreaterThan(
      journal.indexOf('callback-done'),
    );
    expect(journal.slice(0, journal.indexOf('committed'))).not.toContainEqual(
      expect.stringMatching(/^emit:/),
    );
    expect(journal).toEqual(
      expect.arrayContaining([
        'emit:subscriptionChanged',
        'emit:paymentsChanged',
      ]),
    );
    await until(() => seenAtReception.length === 1, 'lecture à la réception');
    expect(seenAtReception).toEqual([1]);

    for (const tab of [tab1, tab2]) {
      expect(count(tab, 'payments:changed')).toBe(1);
      expect(count(tab, 'subscription:changed')).toBe(1);
      expect(
        tab.received.every((r) => JSON.stringify(r.payload) === '{}'),
      ).toBe(true);
    }
    // Administrateur non propriétaire : aucun des deux signaux.
    expect(adminA.received).toEqual([]);
    expect(total(ownerB)).toBe(0);
    expect(await paymentPeriods(paymentId)).toBe(1);
    expect(sim.statusCalls).toBe(1);

    // Rejeu d'un succès : aucune consultation, aucune période, aucun signal.
    const marks = mark();
    const again = await refresh(a.token, paymentId);
    expect(again.body.status).toBe('succeeded');
    await settle();
    for (const c of clients) expect(since(c, marks)).toEqual([]);
    expect(sim.statusCalls).toBe(1);
    expect(await paymentPeriods(paymentId)).toBe(1);
  });

  it('4. rollback de la transaction d’attribution : aucun signal, aucune période, paiement inchangé', async () => {
    const a = await registerOwner('rollback');
    const admin = await seedMember(a.orgId, OrganizationRole.ADMIN);
    const created = await pay(a.token);
    const paymentId = created.body.paymentId;
    sim.settle(created.body.reference, 'succeeded');
    const tab = await connect('owner', a.token);
    const adminA = await connect('admin', admin.token);
    await settle();
    const marks = mark();

    const original = subscriptions.runInGrantTransaction.bind(subscriptions);
    const grant = jest
      .spyOn(subscriptions, 'runInGrantTransaction')
      .mockImplementationOnce((work, options) =>
        original(async (session: MongooseSession) => {
          await work(session);
          // Échec APRÈS les écritures, avant le commit : tout est annulé.
          throw new Error('panne simulée avant commit');
        }, options),
      );
    journal.length = 0;
    const res = await refresh(a.token, paymentId);
    grant.mockRestore();
    expect(res.status).toBe(500);
    await settle();

    expect(since(tab, marks)).toEqual([]);
    expect(since(adminA, marks)).toEqual([]);
    expect(journal.filter((j) => j.startsWith('emit:'))).toEqual([]);
    expect(await paymentPeriods(paymentId)).toBe(0);
    expect((await paymentModel.findById(paymentId).lean())?.status).toBe(
      'pending',
    );
  });

  it('5. échec confirmé : `payments:changed` au propriétaire seul, jamais `subscription:changed`', async () => {
    const a = await registerOwner('failed');
    const admin = await seedMember(a.orgId, OrganizationRole.ADMIN);
    const created = await pay(a.token);
    sim.settle(created.body.reference, 'failed');
    const tab = await connect('owner', a.token);
    const adminA = await connect('admin', admin.token);
    await settle();
    const marks = mark();

    const res = await refresh(a.token, created.body.paymentId);
    expect(res.body.status).toBe('failed');
    await settle();
    expect(since(tab, marks)).toEqual([
      { event: 'payments:changed', payload: {} },
    ]);
    expect(since(adminA, marks)).toEqual([]);
  });

  it('6. transfert de propriété : l’ancien propriétaire n’est plus visé, le nouveau l’est', async () => {
    const a = await registerOwner('transfer');
    const successor = await seedMember(a.orgId, OrganizationRole.ADMIN);
    const created = await pay(a.token);
    const paymentId = created.body.paymentId;

    clearThrottle();
    const transfer = await request(server())
      .post(
        `/organizations/members/${successor.membershipId}/transfer-ownership`,
      )
      .set('Authorization', `Bearer ${a.token}`);
    expect([200, 201]).toContain(transfer.status);

    // Jetons antérieurs au transfert (JWT `{ sub, orgId }`, sans rôle) :
    // les sockets sont rouverts après la déconnexion serveur existante.
    const formerOwner = await connect('former-owner', a.token);
    const newOwner = await connect('new-owner', successor.token);
    await settle();
    const marks = mark();

    // L'ancien propriétaire ne peut plus vérifier (owner-only, rôle en base).
    expect((await refresh(a.token, paymentId)).status).toBe(403);
    sim.settle(created.body.reference, 'succeeded');
    const res = await refresh(successor.token, paymentId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('succeeded');
    await settle();

    expect(count(newOwner, 'payments:changed')).toBe(1);
    expect(count(newOwner, 'subscription:changed')).toBe(1);
    // Ancien propriétaire (désormais admin) : aucun des deux signaux.
    expect(since(formerOwner, marks)).toEqual([]);
  });

  it('7. organisation suspendue : succès confirmé côté serveur (webhook) sans aucun signal', async () => {
    const a = await registerOwner('suspended');
    const created = await pay(a.token);
    const paymentId = created.body.paymentId;
    sim.settle(created.body.reference, 'succeeded');
    const tab = await connect('owner', a.token);
    await settle();
    const marks = mark();

    await organizationModel.updateOne(
      { _id: new Types.ObjectId(a.orgId) },
      { $set: { status: OrganizationStatus.SUSPENDED } },
    );
    // Chemin serveur commun (webhook, 1-14D.2F) : la route HTTP refuse déjà
    // une organisation suspendue.
    const view = await payments.confirmPayment(new Types.ObjectId(paymentId));
    expect(view.status).toBe('succeeded');
    await settle();
    expect(journal).toEqual(
      expect.arrayContaining([
        'emit:subscriptionChanged',
        'emit:paymentsChanged',
      ]),
    );
    expect(since(tab, marks)).toEqual([]);
    expect(await paymentPeriods(paymentId)).toBe(1);
  });

  it('8. panne d’émission : l’écriture validée reste un succès HTTP', async () => {
    const a = await registerOwner('emitfail');
    const tab = await connect('owner', a.token);
    await settle();
    const marks = mark();
    const failing = jest
      .spyOn(gateway, 'emitToMember')
      .mockImplementation(() => {
        throw new Error('panne d’émission simulée');
      });
    const created = await pay(a.token);
    await settle();
    failing.mockRestore();
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('pending');
    expect(since(tab, marks)).toEqual([]);
    expect(
      await paymentModel.countDocuments({
        organizationId: new Types.ObjectId(a.orgId),
      }),
    ).toBe(1);
  });
});
