import 'reflect-metadata';
import { createECDH, createHash, randomBytes } from 'crypto';
import { Connection, Model, Types } from 'mongoose';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { AppModule } from './../src/app.module';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import { Organization } from './../src/organizations/schemas/organization.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import {
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
} from './../src/organizations/permissions';
import { User } from './../src/users/schemas/user.schema';
import { PUSH_CLOCK, PushRuntime } from './../src/push/push-runtime';
import {
  PUSH_PASS_MAX_ROUNDS,
  PUSH_DISPATCH_LANES,
  PUSH_PASS_TIME_BUDGET_MS,
  PushDispatcherService,
} from './../src/push/push-dispatcher.service';
import { ensurePushIndexes } from './../src/push/push-indexes';
import type {
  PushSendResult,
  PushTarget,
  PushTransport,
} from './../src/push/push-transport';
import { PushJob, PushJobStatus } from './../src/push/schemas/push-job.schema';
import {
  PushDelivery,
  PushDeliveryStatus,
} from './../src/push/schemas/push-delivery.schema';
import { PushSubscriptionRecord } from './../src/push/schemas/push-subscription.schema';
import { PushCategory } from './../src/push/schemas/push-category';
import { AppNotification } from './../src/notifications/schemas/notification.schema';
import { NotificationCenterService } from './../src/notifications/notification-center.service';
import {
  MemberActivityAction,
  MemberActivityEntity,
} from './../src/notifications/member-activity';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';

/**
 * 1-20B — Débit du dispatcher : lots enchaînés dans une passe bornée,
 * répartition entre organisations, travaux différés, échec et reprise,
 * arrêt, passes jamais superposées. MongoDB éphémère, VRAI dispatcher,
 * faux transport push, horloge des notifications contrôlée.
 */

class FakeTransport implements PushTransport {
  readonly sent: string[] = [];
  private readonly script = new Map<string, number[]>();
  respond(endpoint: string, ...codes: number[]) {
    this.script.set(endpoint, codes);
  }
  reset() {
    this.sent.length = 0;
    this.script.clear();
  }
  send(target: PushTarget): Promise<PushSendResult> {
    this.sent.push(target.endpoint);
    const next = this.script.get(target.endpoint)?.shift();
    return Promise.resolve({ statusCode: next ?? 201 });
  }
}

const transport = new FakeTransport();
let now = new Date();
const advance = (ms: number) => {
  now = new Date(now.getTime() + ms);
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function vapid() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    enabled: true as const,
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: ecdh.getPrivateKey().toString('base64url'),
    subject: 'mailto:e2e@example.com',
  };
}

describe('Débit du dispatcher de notifications (e2e 1-20B)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication;
  let dispatcher: PushDispatcherService;
  let runtime: PushRuntime;
  let center: NotificationCenterService;
  let jobModel: Model<PushJob>;
  let deliveryModel: Model<PushDelivery>;
  let notificationModel: Model<AppNotification>;
  let organizationModel: Model<Organization>;
  let membershipModel: Model<OrganizationMembership>;
  let userModel: Model<User>;
  let subscriptionModel: Model<PushSubscriptionRecord>;
  let seq = 0;

  /** Organisation active, `managers` gestionnaires avec un appareil chacun. */
  async function organization(managers = 2) {
    seq += 1;
    const org = await organizationModel.create({
      name: `Org ${seq}`,
      slug: `org-20b-${seq}`,
      status: OrganizationStatus.ACTIVE,
    });
    const userIds: Types.ObjectId[] = [];
    const endpoints: string[] = [];
    for (let i = 0; i < managers; i += 1) {
      const user = await userModel.create({
        name: `Gestionnaire ${seq}-${i}`,
        email: `m${seq}-${i}@dispatch-20b.test`,
        password: 'not-a-real-hash',
        authVersion: 0,
      });
      await membershipModel.create({
        organizationId: org._id,
        userId: user._id,
        role: i === 0 ? OrganizationRole.OWNER : OrganizationRole.ADMIN,
        permissions: [],
        status: MembershipStatus.ACTIVE,
        invitedById: null,
        joinedAt: new Date(now.getTime() - 86_400_000),
      });
      const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-20b-${seq}-${i}`;
      const keys = createECDH('prime256v1');
      keys.generateKeys();
      await subscriptionModel.create({
        userId: user._id,
        organizationId: org._id,
        endpointHash: createHash('sha256').update(endpoint).digest('hex'),
        endpoint,
        p256dh: keys.getPublicKey().toString('base64url'),
        auth: randomBytes(16).toString('base64url'),
        preferences: {
          stockDepleted: true,
          stockLow: true,
          saleCreated: true,
          subscriptionEnding: true,
          paymentSucceeded: true,
          monthlyReport: true,
          memberJoined: true,
          memberActivity: true,
        },
        authVersion: 0,
        registeredAt: new Date(now.getTime() - 86_400_000),
      });
      userIds.push(user._id);
      endpoints.push(endpoint);
    }
    return { id: org._id, userIds, endpoints };
  }

  /** `n` adhésions en attente (envoi push immédiat), `eventAt` croissants. */
  async function joined(
    organizationId: Types.ObjectId,
    n: number,
    startAt = now.getTime() - 60_000,
  ) {
    const docs = Array.from({ length: n }, (_, i) => ({
      eventKey: `member-joined:${new Types.ObjectId().toHexString()}`,
      category: PushCategory.MEMBER_JOINED,
      organizationId,
      actorId: new Types.ObjectId(),
      eventAt: new Date(startAt + i),
      status: PushJobStatus.PENDING,
      deliveries: 0,
    }));
    await jobModel.insertMany(docs);
    return docs.map((d) => d.eventKey);
  }

  const pending = () =>
    jobModel.countDocuments({ status: PushJobStatus.PENDING });

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      process.env.MONGODB_URI = validatedEphemeralUri(replSet);
      process.env.JWT_SECRET = 'dispatch-20b-e2e-only';
      process.env.CORS_ORIGIN = 'https://dispatch-20b-e2e.example.com';
      moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EMAIL_SENDER)
        .useValue({ isConfigured: () => true, send: () => Promise.resolve() })
        .overrideProvider(PUSH_CLOCK)
        .useValue(() => new Date(now.getTime()))
        .compile();
      app = moduleFixture.createNestApplication();
      await app.init();
      const connection = moduleFixture.get<Connection>(getConnectionToken());
      await ensurePushIndexes(connection);
      dispatcher = moduleFixture.get(PushDispatcherService);
      runtime = moduleFixture.get(PushRuntime);
      center = moduleFixture.get(NotificationCenterService);
      jobModel = moduleFixture.get(getModelToken(PushJob.name));
      deliveryModel = moduleFixture.get(getModelToken(PushDelivery.name));
      notificationModel = moduleFixture.get(
        getModelToken(AppNotification.name),
      );
      organizationModel = moduleFixture.get(getModelToken(Organization.name));
      membershipModel = moduleFixture.get(
        getModelToken(OrganizationMembership.name),
      );
      userModel = moduleFixture.get(getModelToken(User.name));
      subscriptionModel = moduleFixture.get(
        getModelToken(PushSubscriptionRecord.name),
      );
      runtime.activate(vapid(), transport);
    } catch (error) {
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  beforeEach(async () => {
    transport.reset();
    // Tours déterministes : le budget de durée ne dépend pas de la vitesse
    // de la machine de test (testé à part, scénario 11).
    dispatcher.passTimeBudgetMs = 60_000;
    now = new Date();
    // Chaque test part d'une file vide (collections propres à la suite).
    await jobModel.deleteMany({});
    await deliveryModel.deleteMany({});
    await notificationModel.deleteMany({});
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await dispatcher.stop();
  });

  afterAll(async () => {
    await app?.close();
    await stopEphemeralMongoSafe();
  });

  it('1. plusieurs lots dans une même passe : tout est réparti et envoyé, sans attente de 5 s', async () => {
    const org = await organization(2);
    await joined(org.id, 130);
    const summary = await dispatcher.runOnce();
    expect(summary.jobsDispatched).toBe(130);
    expect(summary.rounds).toBeGreaterThanOrEqual(3);
    expect(summary.backlog).toBe(false);
    expect(await pending()).toBe(0);
    expect(
      await notificationModel.countDocuments({ organizationId: org.id }),
    ).toBe(260);
    expect(summary.sent).toBe(260);
    expect(new Set(transport.sent).size).toBe(2);
  });

  it('2. budget borné : une passe s’arrête après PUSH_PASS_MAX_ROUNDS tours, sans rien perdre', async () => {
    const org = await organization(1);
    await joined(org.id, 50 * PUSH_PASS_MAX_ROUNDS + 70);
    const first = await dispatcher.runOnce();
    expect(first.rounds).toBe(PUSH_PASS_MAX_ROUNDS);
    expect(first.jobsDispatched).toBeLessThanOrEqual(50 * PUSH_PASS_MAX_ROUNDS);
    expect(first.backlog).toBe(true);
    expect(await pending()).toBe(
      50 * PUSH_PASS_MAX_ROUNDS + 70 - first.jobsDispatched,
    );
    const second = await dispatcher.runOnce();
    expect(second.backlog).toBe(false);
    expect(await pending()).toBe(0);
    expect(
      await jobModel.countDocuments({ status: PushJobStatus.DISPATCHED }),
    ).toBe(50 * PUSH_PASS_MAX_ROUNDS + 70);
  });

  it('3. file vide : un seul tour, aucun travail, aucun reliquat signalé', async () => {
    const summary = await dispatcher.runOnce();
    expect(summary).toMatchObject({
      rounds: 1,
      backlog: false,
      jobsDispatched: 0,
      sent: 0,
    });
  });

  it('4. travaux différés : regroupement d’une minute et reprises jamais avancés', async () => {
    const org = await organization(1);
    // Activité : livraison en fin de fenêtre d'une minute.
    await jobModel.create({
      eventKey: `member-activity:product:updated:${new Types.ObjectId().toHexString()}`,
      category: PushCategory.MEMBER_ACTIVITY,
      organizationId: org.id,
      actorId: new Types.ObjectId(),
      activity: {
        entity: MemberActivityEntity.PRODUCT,
        action: MemberActivityAction.UPDATED,
        targetId: null,
        targetName: 'Savon',
      },
      eventAt: new Date(now.getTime()),
      status: PushJobStatus.PENDING,
      deliveries: 0,
    });
    // Beaucoup d'adhésions : la passe enchaîne plusieurs tours.
    transport.respond(org.endpoints[0], 503);
    await joined(org.id, 120);
    const first = await dispatcher.runOnce();
    expect(first.rounds).toBeGreaterThan(1);
    const deferred = await deliveryModel
      .find({ status: PushDeliveryStatus.PENDING })
      .lean();
    // La livraison de l'activité attend la fin de sa fenêtre ; celle en
    // échec (503) attend son délai de reprise : aucune n'a été avancée.
    expect(deferred.length).toBe(2);
    for (const d of deferred) {
      expect(d.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());
    }
    const retried = deferred.find((d) => d.attempts === 1);
    expect(retried).toBeDefined();
    expect(transport.sent.length).toBe(120);
    advance(61_000);
    const second = await dispatcher.runOnce();
    expect(second.sent).toBe(2);
    expect(
      await deliveryModel.countDocuments({ status: PushDeliveryStatus.SENT }),
    ).toBe(121);
  });

  it('5. échec puis reprise : rien n’est clos avant traitement réussi, aucun doublon', async () => {
    const org = await organization(2);
    await joined(org.id, 60);
    jest
      .spyOn(center, 'createFromJob')
      .mockRejectedValueOnce(new Error('centre indisponible'));
    await expect(dispatcher.runOnce()).rejects.toThrow('centre indisponible');
    expect(await pending()).toBe(60);
    jest.restoreAllMocks();
    const summary = await dispatcher.runOnce();
    expect(summary.jobsDispatched).toBe(60);
    expect(await pending()).toBe(0);
    expect(
      await notificationModel.countDocuments({ organizationId: org.id }),
    ).toBe(120);
    expect(await deliveryModel.countDocuments({})).toBe(120);
  });

  it('6. arrêt propre pendant une vidange : aucune passe ensuite, travaux clos ou intacts', async () => {
    const org = await organization(1);
    await joined(org.id, 1500);
    const spy = jest.spyOn(dispatcher, 'runOnce');
    dispatcher.start(60_000, 10);
    await delay(150);
    await dispatcher.stop();
    const passes = spy.mock.calls.length;
    await delay(300);
    expect(spy.mock.calls.length).toBe(passes);
    const dispatched = await jobModel.countDocuments({
      status: PushJobStatus.DISPATCHED,
    });
    expect(dispatched + (await pending())).toBe(1500);
    // Chaque travail clos a ses notifications ; aucun n'est clos sans elles.
    expect(
      await notificationModel.countDocuments({ organizationId: org.id }),
    ).toBe(dispatched);
  });

  it('7. passes jamais superposées : deux appels simultanés sont sérialisés, aucun doublon', async () => {
    const org = await organization(2);
    await joined(org.id, 120);
    let active = 0;
    let maxActive = 0;
    const original = (dispatcher as any).selectJobs.bind(dispatcher);
    jest.spyOn(dispatcher as any, 'selectJobs').mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(5);
      const result = await original();
      active -= 1;
      return result;
    });
    const [a, b] = await Promise.all([
      dispatcher.runOnce(),
      dispatcher.runOnce(),
    ]);
    expect(maxActive).toBe(1);
    expect(a.jobsDispatched + b.jobsDispatched).toBe(120);
    expect(
      await notificationModel.countDocuments({ organizationId: org.id }),
    ).toBe(240);
    const dup = await notificationModel.aggregate([
      { $group: { _id: { k: '$eventKey', u: '$userId' }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ]);
    expect(dup).toEqual([]);
    expect(await deliveryModel.countDocuments({})).toBe(240);
  });

  it('8. répartition : une organisation peu active passe dans le premier lot, derrière 400 travaux d’une autre', async () => {
    const busy = await organization(1);
    const quiet = await organization(1);
    await joined(busy.id, 400, now.getTime() - 120_000);
    const [quietKey] = await joined(quiet.id, 1, now.getTime() - 1_000);
    const order: string[] = [];
    const close = (dispatcher as any).closeJob.bind(dispatcher);
    jest
      .spyOn(dispatcher as any, 'closeJob')
      .mockImplementation((id: Types.ObjectId, ...rest: unknown[]) => {
        order.push(id.toHexString());
        return close(id, ...rest);
      });
    await dispatcher.runOnce();
    const quietJob = await jobModel.findOne({ eventKey: quietKey }).lean();
    const position = order.indexOf(String(quietJob!._id));
    expect(position).toBeGreaterThanOrEqual(0);
    // Premier lot (rang < 50, trié par `eventAt` dans le lot) au lieu de
    // la 401e place en FIFO strict ; ce lot contient au plus
    // PUSH_JOBS_PER_ORGANIZATION travaux de l'organisation active SI une
    // autre organisation attend, complété ensuite par son excédent.
    expect(position).toBeLessThan(50);
    const firstBatch = order.slice(0, 50);
    const quietInFirst = firstBatch.includes(String(quietJob!._id));
    expect(quietInFirst).toBe(true);
    expect(
      await notificationModel.countDocuments({ organizationId: quiet.id }),
    ).toBe(1);
  });

  it('9. organisation seule : le plafond par organisation ne réduit pas le lot (50 par tour)', async () => {
    const org = await organization(1);
    await joined(org.id, 120);
    const summary = await dispatcher.runOnce();
    // 50 + 50 + 20 : trois tours, pas douze (10 par tour).
    expect(summary.rounds).toBe(3);
    expect(summary.jobsDispatched).toBe(120);
  });

  it('10. ordonnancement : passes rapprochées tant qu’il reste du travail, puis retour à l’intervalle de repos', async () => {
    const org = await organization(1);
    dispatcher.passTimeBudgetMs = PUSH_PASS_TIME_BUDGET_MS;
    await joined(org.id, 160);
    const spy = jest.spyOn(dispatcher, 'runOnce');
    dispatcher.start(60_000, 10);
    const deadline = Date.now() + 60_000;
    while ((await pending()) > 0 && Date.now() < deadline) await delay(50);
    expect(await pending()).toBe(0);
    // Plusieurs passes, sans attendre 60 s entre elles.
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    await delay(200);
    const settled = spy.mock.calls.length;
    await delay(400);
    // File vide : plus aucune passe avant l'intervalle de repos (60 s ici).
    expect(spy.mock.calls.length).toBe(settled);
  }, 90_000);

  it('11. budget de durée : une passe s’arrête au premier tour qui le dépasse', async () => {
    const org = await organization(1);
    await joined(org.id, 120);
    dispatcher.passTimeBudgetMs = 0;
    const summary = await dispatcher.runOnce();
    expect(summary.rounds).toBe(1);
    expect(summary.jobsDispatched).toBe(50);
    expect(summary.backlog).toBe(true);
  });

  it('12. voies parallèles : organisations distinctes en parallèle (borné), jamais une organisation avec elle-même, ordre conservé', async () => {
    const orgs = [];
    for (let i = 0; i < 5; i += 1) orgs.push(await organization(1));
    for (const org of orgs) await joined(org.id, 8);
    const active = new Map<string, number>();
    let concurrent = 0;
    let maxConcurrent = 0;
    let selfOverlap = false;
    const order = new Map<string, number[]>();
    const original = (dispatcher as any).dispatchOne.bind(dispatcher);
    jest
      .spyOn(dispatcher as any, 'dispatchOne')
      .mockImplementation(async (job: any, summary: unknown) => {
        const key = job.organizationId.toHexString();
        if ((active.get(key) ?? 0) > 0) selfOverlap = true;
        active.set(key, (active.get(key) ?? 0) + 1);
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        if (!order.has(key)) order.set(key, []);
        order.get(key)!.push(job.eventAt.getTime());
        await delay(3);
        try {
          return await original(job, summary);
        } finally {
          concurrent -= 1;
          active.set(key, active.get(key)! - 1);
        }
      });
    const summary = await dispatcher.runOnce();
    expect(summary.jobsDispatched).toBe(40);
    expect(selfOverlap).toBe(false);
    expect(maxConcurrent).toBeGreaterThan(1);
    expect(maxConcurrent).toBeLessThanOrEqual(PUSH_DISPATCH_LANES);
    for (const times of order.values()) {
      expect(times).toEqual([...times].sort((a, b) => a - b));
    }
  });

  it('13. échec dans une voie : la passe attend les autres voies avant d’échouer, rien ne continue en arrière-plan', async () => {
    const a = await organization(1);
    const b = await organization(1);
    await joined(a.id, 5, now.getTime() - 10_000);
    await joined(b.id, 5, now.getTime() - 9_000);
    const original = (dispatcher as any).dispatchOne.bind(dispatcher);
    let calls = 0;
    jest
      .spyOn(dispatcher as any, 'dispatchOne')
      .mockImplementation(async (job: any, summary: unknown) => {
        calls += 1;
        if (job.organizationId.equals(a.id)) {
          throw new Error('panne de la voie A');
        }
        await delay(20);
        return original(job, summary);
      });
    await expect(dispatcher.runOnce()).rejects.toThrow('panne de la voie A');
    const callsAtRejection = calls;
    const closedAtRejection = await jobModel.countDocuments({
      status: PushJobStatus.DISPATCHED,
    });
    await delay(300);
    // Rien n'a continué après le rejet de la passe.
    expect(calls).toBe(callsAtRejection);
    expect(
      await jobModel.countDocuments({ status: PushJobStatus.DISPATCHED }),
    ).toBe(closedAtRejection);
    // La voie B a terminé son lot ; A reste intacte (jamais close à tort).
    expect(
      await jobModel.countDocuments({
        organizationId: b.id,
        status: PushJobStatus.DISPATCHED,
      }),
    ).toBe(5);
    expect(
      await jobModel.countDocuments({
        organizationId: a.id,
        status: PushJobStatus.PENDING,
      }),
    ).toBe(5);
  });
});
