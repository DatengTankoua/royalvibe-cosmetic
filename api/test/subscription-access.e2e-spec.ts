import 'reflect-metadata';
import { randomUUID } from 'crypto';
import type { AddressInfo } from 'net';
import { Connection, Model, Types } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerStorage } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { App } from 'supertest/types';
import { io } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { UserDocument } from './../src/users/schemas/user.schema';
import { Organization } from './../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from './../src/organizations/schemas/organization.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import { ProductDocument } from './../src/products/schemas/product.schema';
import { SaleDocument } from './../src/sales/schemas/sale.schema';
import { SubscriptionPeriod } from './../src/subscriptions/schemas/subscription-period.schema';
import type { SubscriptionPeriodDocument } from './../src/subscriptions/schemas/subscription-period.schema';
import { ensureSubscriptionPeriodIndexes } from './../src/subscriptions/subscription-period-indexes';
import { SubscriptionsService } from './../src/subscriptions/subscriptions.service';
import type { SubscriptionAccessDecision } from './../src/subscriptions/subscription-access';
import { SUBSCRIPTION_CLOCK } from './../src/subscriptions/subscription-clock';
import { EventsGateway } from './../src/events/events.gateway';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';
import {
  buildHttpCorsOptions,
  buildOriginAllowlist,
  parseCORSOrigin,
} from './../src/events/origin.helpers';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import {
  E2E_EMAIL_VERIFIED_AT,
  autoConfirmVerificationEmails,
  createE2eEmailSender,
} from './e2e/email-verification-fixtures';
import { OWNER_TERMS } from './e2e/legal-acceptance-fixtures';

// 1-13A : expéditeur simulé, liens confirmés via le service réel.
const emailSender = createE2eEmailSender();

/**
 * E2E 1-14C.1 — contrôle commercial de l'accès API (replica set éphémère,
 * garde anti-27017 ; aucun email réel, aucun fournisseur de paiement).
 *
 * Horloge : `SUBSCRIPTION_CLOCK` remplacé UNIQUEMENT ici. Les courses sont
 * ordonnées par des BARRIÈRES (promesses contrôlées par le test), jamais par
 * des attentes temporisées.
 */

const TEST_JWT_SECRET = 'subscription-access-14c1-e2e-only-secret';
const E2E_CORS_ORIGIN = 'https://subscription-access-e2e.example.com';
const PASSWORD = 'access-14c1-pw-!1x';
const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-03-01T09:00:00.000Z').getTime();
const DURING_TRIAL = T0 + DAY_MS;
const AFTER_TRIAL = T0 + 30 * DAY_MS;

let clockNow = T0;
const testClock = () => new Date(clockNow);

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('Contrôle commercial de l’accès API (e2e 1-14C.1)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let connection: Connection;
  let jwtService: JwtService;
  let subscriptions: SubscriptionsService;
  let gateway: EventsGateway;
  let port = 0;
  let userModel: Model<UserDocument>;
  let organizationModel: Model<OrganizationDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;
  let periodModel: Model<SubscriptionPeriodDocument>;
  let productModel: Model<ProductDocument>;
  let saleModel: Model<SaleDocument>;
  let seq = 0;
  const openSockets: ClientSocket[] = [];

  const server = () => app.getHttpServer();
  const clearThrottle = () =>
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();

  async function registerOwner(label: string) {
    clearThrottle();
    seq += 1;
    const email = `${label}-${seq}-14c1@access.test`;
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
    return { email, orgId: reg.body.organization._id as string };
  }

  function loginRaw(email: string, organizationId?: string) {
    clearThrottle();
    return request(server())
      .post('/auth/login')
      .send({
        email,
        password: PASSWORD,
        ...(organizationId ? { organizationId } : {}),
      });
  }

  async function appToken(email: string, organizationId?: string) {
    const res = await loginRaw(email, organizationId);
    expect(res.status).toBe(201);
    return res.body.access_token as string;
  }

  async function restrictedToken(email: string, organizationId?: string) {
    const res = await loginRaw(email, organizationId);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUBSCRIPTION_INACTIVE');
    expect(res.body.access_token).toBeUndefined();
    return res.body.restrictedToken as string;
  }

  async function seedMember(
    orgId: string,
    role: 'owner' | 'admin' | 'seller',
    permissions: string[] = [],
    status: 'active' | 'suspended' | 'revoked' = 'active',
  ) {
    seq += 1;
    const email = `${role}-${seq}-14c1@access.test`;
    const user = await userModel.create({
      emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
      name: role,
      email,
      password: await bcrypt.hash(PASSWORD, 10),
      // Rôle legacy `admin` : ne doit JAMAIS ouvrir un droit.
      role: 'admin',
    });
    await membershipModel.create({
      organizationId: new Types.ObjectId(orgId),
      userId: user._id,
      role,
      status,
      permissions,
    });
    return { email, userId: user._id };
  }

  const call = (
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    token?: string,
  ) => {
    const req = request(server())[method](path);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  /** Routes métier représentatives (lecture + écriture, toutes familles). */
  const businessProbes = (token: string) => [
    call('get', '/products', token),
    call('get', '/sections', token),
    call('post', '/sections', token).send({ name: 'Rayon' }),
    call('get', '/sales', token),
    call('get', '/analytics/overview', token),
    call('get', '/trash', token),
    call('get', '/organizations/current', token),
    call('patch', '/organizations/current/branding', token).field(
      'brandColor',
      '#123456',
    ),
    call('get', '/organizations/members', token),
    call('get', '/organizations/invitations', token),
    call('post', '/organizations/invitations', token).send({
      email: `probe-${randomUUID()}@access.test`,
      role: 'seller',
    }),
  ];

  async function expectBusinessBlocked(token: string, code: string) {
    for (const res of await Promise.all(businessProbes(token))) {
      expect([res.status, res.body.code, res.req.path]).toEqual([
        403,
        code,
        res.req.path,
      ]);
    }
  }

  async function grant(orgId: string, term = 'monthly') {
    return subscriptions.grantSubscription({
      organizationId: orgId,
      term,
      sourceReference: `REC-${randomUUID()}`,
      grantedBy: 'ops-e2e',
    });
  }

  async function seedProduct(token: string, orgId: string, quantity = 10) {
    const section = await call('post', '/sections', token).send({
      name: `Rayon ${randomUUID()}`,
    });
    expect(section.status).toBe(201);
    const product = await productModel.create({
      sectionId: new Types.ObjectId(section.body._id as string),
      name: `P-${randomUUID()}`,
      imageUrl: 'https://e2e.local/img.png',
      purchasePrice: 100,
      salePrice: 400,
      initialQuantity: quantity,
      remainingQuantity: quantity,
      organizationId: new Types.ObjectId(orgId),
    });
    return product._id.toString();
  }

  function connectSocket(token: string): ClientSocket {
    const socket = io(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      reconnection: false,
      timeout: 4_000,
      extraHeaders: { origin: E2E_CORS_ORIGIN },
      auth: { token },
    });
    openSockets.push(socket);
    return socket;
  }

  function socketOutcome(socket: ClientSocket) {
    return new Promise<{ connected: boolean; error?: string }>((resolve) => {
      socket.once('connect', () => resolve({ connected: true }));
      socket.once('connect_error', (err: Error) =>
        resolve({ connected: false, error: err.message }),
      );
    });
  }

  /**
   * Barrière sur la PROCHAINE lecture d'état commercial : la lecture est
   * suspendue jusqu'à `release()` ; `reached` est résolu à son entrée,
   * `done` à sa sortie (valeur relue).
   */
  function gateNextDecision() {
    const reached = deferred();
    const gate = deferred();
    const done = deferred<SubscriptionAccessDecision>();
    const original = (organizationId: string) =>
      SubscriptionsService.prototype.getAccessDecision.call(
        subscriptions,
        organizationId,
      ) as Promise<SubscriptionAccessDecision>;
    const spy = jest
      .spyOn(subscriptions, 'getAccessDecision')
      .mockImplementationOnce(async (organizationId: string) => {
        reached.resolve();
        await gate.promise;
        const decision = await original(organizationId);
        done.resolve(decision);
        return decision;
      });
    return { reached, release: () => gate.resolve(), done, spy };
  }

  const bumpSessionVersion = (email: string) =>
    userModel.updateOne({ email }, { $inc: { authVersion: 1 } });

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
        .overrideProvider(SUBSCRIPTION_CLOCK)
        .useValue(testClock)
        .compile();
      app = moduleFixture.createNestApplication();
      app.enableCors(
        buildHttpCorsOptions(
          buildOriginAllowlist(parseCORSOrigin(E2E_CORS_ORIGIN, 'development')),
        ),
      );
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
      port = (app.getHttpServer().address() as AddressInfo).port;

      connection = moduleFixture.get(getConnectionToken());
      jwtService = moduleFixture.get(JwtService);
      subscriptions = moduleFixture.get(SubscriptionsService);
      gateway = moduleFixture.get(EventsGateway);
      userModel = moduleFixture.get(getModelToken('User'));
      organizationModel = moduleFixture.get(getModelToken(Organization.name));
      membershipModel = moduleFixture.get(
        getModelToken(OrganizationMembership.name),
      );
      periodModel = moduleFixture.get(getModelToken(SubscriptionPeriod.name));
      productModel = moduleFixture.get(getModelToken('Product'));
      saleModel = moduleFixture.get(getModelToken('Sale'));
      // Index requis (migration explicite, comme en production).
      await ensureSubscriptionPeriodIndexes(connection);
    } catch (error) {
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  afterEach(() => {
    jest.restoreAllMocks();
    for (const socket of openSockets.splice(0)) socket.disconnect();
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  // ─── 1. Actif ──────────────────────────────────────────────────────────────

  it('1. essai et abonnement actifs : contrat de connexion et accès habituels', async () => {
    clockNow = T0;
    const { email, orgId } = await registerOwner('active');
    clockNow = DURING_TRIAL;
    const token = await appToken(email);
    expect(jwtService.decode(token)).toMatchObject({ accessScope: 'app' });
    for (const res of await Promise.all(businessProbes(token))) {
      expect(res.status).toBeLessThan(300);
    }
    const context = await call('get', '/auth/context', token);
    expect(context.body.access).toEqual({
      subscriptionState: 'active',
      applicationAccess: true,
      coverageEndsAt: new Date(T0 + 7 * DAY_MS).toISOString(),
      checkedAt: new Date(DURING_TRIAL).toISOString(),
      canRenew: true,
      tokenScope: 'app',
      canRecordSales: true,
    });
    // Abonnement payant après l'essai : même comportement.
    await grant(orgId);
    clockNow = T0 + 10 * DAY_MS;
    expect((await call('get', '/products', token)).status).toBe(200);
  });

  // ─── 2. Inactif pour tous ──────────────────────────────────────────────────

  it('2. none, expired, scheduled : routes métier refusées pour tous les rôles', async () => {
    clockNow = T0;
    const { email, orgId } = await registerOwner('inactive-all');
    const admin = await seedMember(orgId, 'admin');
    const seller = await seedMember(orgId, 'seller');
    clockNow = DURING_TRIAL;
    const tokens = await Promise.all(
      [email, admin.email, seller.email].map((e) => appToken(e)),
    );

    for (const at of [
      AFTER_TRIAL, // expired
      T0 - DAY_MS, // scheduled : essai pas encore commencé
    ]) {
      clockNow = at;
      for (const token of tokens) {
        await expectBusinessBlocked(token, 'SUBSCRIPTION_INACTIVE');
      }
    }

    // none : organisation sans aucune période (données locales historiques).
    const legacy = await organizationModel.create({
      name: 'Legacy',
      slug: `legacy-${randomUUID()}`,
    });
    const legacyOwner = await seedMember(legacy._id.toString(), 'owner');
    clockNow = DURING_TRIAL;
    const res = await loginRaw(legacyOwner.email);
    expect(res.status).toBe(403);
    expect(res.body.access.subscriptionState).toBe('none');
  });

  // ─── 3 + 4. Login inactif ──────────────────────────────────────────────────

  it('3. login propriétaire inactif : identification limitée, aucun JWT applicatif', async () => {
    clockNow = T0;
    const { email, orgId } = await registerOwner('owner-limited');
    clockNow = AFTER_TRIAL;
    const res = await loginRaw(email);
    expect(res.status).toBe(403);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Object.keys(res.body as object).sort()).toEqual(
      [
        'access',
        'code',
        'error',
        'message',
        'path',
        'restrictedToken',
        'statusCode',
        'timestamp',
      ].sort(),
    );
    expect(res.body.access).toEqual({
      subscriptionState: 'expired',
      applicationAccess: false,
      coverageEndsAt: new Date(T0 + 7 * DAY_MS).toISOString(),
      checkedAt: new Date(AFTER_TRIAL).toISOString(),
      canRenew: true,
    });
    const payload = jwtService.decode(res.body.restrictedToken as string);
    expect(payload).toMatchObject({
      orgId,
      accessScope: 'subscription_limited',
    });
    expect(payload.exp - payload.iat).toBe(15 * 60);

    const restricted = res.body.restrictedToken as string;
    expect((await call('get', '/auth/me', restricted)).status).toBe(200);
    const context = await call('get', '/auth/context', restricted);
    expect(context.status).toBe(200);
    expect(context.body.access).toMatchObject({
      applicationAccess: false,
      canRenew: true,
      tokenScope: 'subscription_limited',
      canRecordSales: false,
    });
    const subscription = await call(
      'get',
      '/organizations/current/subscription',
      restricted,
    );
    expect(subscription.status).toBe(200);
    expect(subscription.body.state).toBe('expired');
  });

  it('3bis. mauvais mot de passe : refus générique, aucun état commercial révélé', async () => {
    clockNow = T0;
    const { email } = await registerOwner('wrong-pw');
    clockNow = AFTER_TRIAL;
    clearThrottle();
    const res = await request(server())
      .post('/auth/login')
      .send({ email, password: 'not-the-password-1' });
    expect(res.status).toBe(401);
    const flat = JSON.stringify(res.body);
    for (const leak of ['SUBSCRIPTION', 'restrictedToken', 'access']) {
      expect(flat).not.toContain(leak);
    }
  });

  it('4. login admin/vendeur inactif : jeton limité, aucun accès métier ni renouvellement', async () => {
    clockNow = T0;
    const { orgId } = await registerOwner('members-limited');
    const admin = await seedMember(orgId, 'admin', [
      'members.manage',
      'branding.manage',
    ]);
    const seller = await seedMember(orgId, 'seller', ['analytics.read']);
    clockNow = AFTER_TRIAL;
    for (const member of [admin, seller]) {
      const res = await loginRaw(member.email);
      expect(res.status).toBe(403);
      expect(res.body.access.canRenew).toBe(false);
      const restricted = res.body.restrictedToken as string;
      await expectBusinessBlocked(restricted, 'SUBSCRIPTION_ACCESS_LIMITED');
      const subscription = await call(
        'get',
        '/organizations/current/subscription',
        restricted,
      );
      expect(subscription.status).toBe(403);
      expect(subscription.body.code).toBe('PERMISSION_DENIED');
    }
  });

  // ─── 5. Sessions ouvertes ──────────────────────────────────────────────────

  it('5. ancien JWT applicatif encore valide après expiration → 403 sur les routes métier', async () => {
    clockNow = T0;
    const { email } = await registerOwner('open-session');
    clockNow = DURING_TRIAL;
    const token = await appToken(email);
    expect((await call('get', '/products', token)).status).toBe(200);
    clockNow = AFTER_TRIAL;
    await expectBusinessBlocked(token, 'SUBSCRIPTION_INACTIVE');
    // Identification et état restent lisibles (jamais 401 pour une expiration).
    expect((await call('get', '/auth/me', token)).status).toBe(200);
    const context = await call('get', '/auth/context', token);
    expect(context.status).toBe(200);
    expect(context.body.access).toMatchObject({
      applicationAccess: false,
      tokenScope: 'app',
      canRecordSales: false,
    });
    // `sales.record` reste une permission RÉELLE du membre.
    expect(context.body.effectivePermissions).toContain('sales.record');
  });

  // ─── 6 + 7. Jeton limité et activation ─────────────────────────────────────

  it('6 + 7. jeton limité : exceptions seules ; activation → ancien JWT réutilisable, jeton limité toujours limité jusqu’à l’échange', async () => {
    clockNow = T0;
    const { email, orgId } = await registerOwner('activation');
    clockNow = DURING_TRIAL;
    const oldAppToken = await appToken(email);
    clockNow = AFTER_TRIAL;
    const restricted = await restrictedToken(email);

    // Jeton limité : switch interdit, échange refusé tant qu'inactif.
    const switchRes = await call(
      'post',
      '/auth/switch-organization',
      restricted,
    ).send({ organizationId: orgId });
    expect(switchRes.status).toBe(403);
    expect(switchRes.body.code).toBe('SUBSCRIPTION_ACCESS_LIMITED');
    const early = await call(
      'post',
      '/auth/subscription-access/complete',
      restricted,
    );
    expect(early.status).toBe(403);
    expect(early.body.code).toBe('SUBSCRIPTION_INACTIVE');
    expect(early.body.access_token).toBeUndefined();
    expect(early.body.restrictedToken).toBeUndefined();

    // Activation manuelle (service serveur — aucune route HTTP).
    await grant(orgId);

    // Ancien JWT applicatif : accès retrouvé sans changement de token.
    expect((await call('get', '/products', oldAppToken)).status).toBe(200);
    // Jeton limité : toujours limité.
    await expectBusinessBlocked(restricted, 'SUBSCRIPTION_ACCESS_LIMITED');

    // Corps non vide → refus, aucune donnée client.
    const forged = await call(
      'post',
      '/auth/subscription-access/complete',
      restricted,
    ).send({ organizationId: new Types.ObjectId().toString() });
    expect(forged.status).toBe(400);
    // JWT applicatif → l'échange n'a pas lieu d'être.
    const fromApp = await call(
      'post',
      '/auth/subscription-access/complete',
      oldAppToken,
    );
    expect(fromApp.status).toBe(400);
    expect(fromApp.body.code).toBe('RESTRICTED_TOKEN_REQUIRED');

    const exchanged = await call(
      'post',
      '/auth/subscription-access/complete',
      restricted,
    );
    expect(exchanged.status).toBe(200);
    expect(exchanged.headers['cache-control']).toBe('no-store');
    expect(Object.keys(exchanged.body as object)).toEqual(['access_token']);
    const fresh = exchanged.body.access_token as string;
    expect(jwtService.decode(fresh)).toMatchObject({
      orgId,
      accessScope: 'app',
    });
    expect((await call('get', '/products', fresh)).status).toBe(200);
    // L'ancien jeton limité reste limité après l'échange.
    expect((await call('get', '/products', restricted)).body.code).toBe(
      'SUBSCRIPTION_ACCESS_LIMITED',
    );
  });

  // ─── 8. Aucune élévation ───────────────────────────────────────────────────

  it('8. propriétaire seul : permissions supplémentaires et rôle legacy n’ouvrent jamais le renouvellement', async () => {
    clockNow = T0;
    const { email, orgId } = await registerOwner('no-elevation');
    const admin = await seedMember(orgId, 'admin', [
      'members.manage',
      'members.invite',
      'branding.manage',
      'analytics.read',
      'audit.read',
      'trash.manage',
    ]);
    clockNow = AFTER_TRIAL;
    const ownerLogin = await loginRaw(email);
    const adminLogin = await loginRaw(admin.email);
    expect(ownerLogin.body.access.canRenew).toBe(true);
    expect(adminLogin.body.access.canRenew).toBe(false);
    const adminRestricted = adminLogin.body.restrictedToken as string;
    const context = await call('get', '/auth/context', adminRestricted);
    expect(context.body.access.canRenew).toBe(false);
    expect(
      (
        await call(
          'get',
          '/organizations/current/subscription',
          adminRestricted,
        )
      ).status,
    ).toBe(403);
  });

  // ─── 9. Multi-organisation ─────────────────────────────────────────────────

  it('9. multi-organisation : une organisation active reste accessible malgré une autre expirée', async () => {
    clockNow = T0;
    const expiredOrg = await registerOwner('multi-expired');
    clockNow = AFTER_TRIAL;
    const activeOrg = await registerOwner('multi-active');
    const owner = await userModel.findOne({ email: expiredOrg.email });
    await membershipModel.create({
      organizationId: new Types.ObjectId(activeOrg.orgId),
      userId: owner!._id,
      role: 'seller',
      status: 'active',
    });

    const selection = await loginRaw(expiredOrg.email);
    expect(selection.status).toBe(201);
    expect(selection.body.organizationSelectionRequired).toBe(true);

    const activeToken = await appToken(expiredOrg.email, activeOrg.orgId);
    expect((await call('get', '/products', activeToken)).status).toBe(200);
    await restrictedToken(expiredOrg.email, expiredOrg.orgId);

    // Switch vers l'organisation expirée : jeton limité, jamais applicatif.
    const toExpired = await call(
      'post',
      '/auth/switch-organization',
      activeToken,
    ).send({ organizationId: expiredOrg.orgId });
    expect(toExpired.status).toBe(403);
    expect(toExpired.body.code).toBe('SUBSCRIPTION_INACTIVE');
    expect(toExpired.headers['cache-control']).toBe('no-store');
    expect(
      jwtService.decode(toExpired.body.restrictedToken as string),
    ).toMatchObject({
      orgId: expiredOrg.orgId,
      accessScope: 'subscription_limited',
    });
    // L'ancien JWT de l'organisation active n'est pas affecté.
    expect((await call('get', '/products', activeToken)).status).toBe(200);
  });

  // ─── 10 + 11. Ventes ───────────────────────────────────────────────────────

  it('10 + 11. vente appliquée puis expiration : confirmation sans doublon ; nouvelle vente → 403 sans écriture', async () => {
    clockNow = T0;
    const { email, orgId } = await registerOwner('sales');
    const seller = await seedMember(orgId, 'seller');
    clockNow = DURING_TRIAL;
    const ownerToken = await appToken(email);
    const sellerToken = await appToken(seller.email);
    const productId = await seedProduct(ownerToken, orgId, 10);
    const body = {
      productId,
      quantity: 2,
      salePrice: 400,
      buyerName: 'Client',
      clientOperationId: randomUUID(),
    };
    const first = await call('post', '/sales', sellerToken).send(body);
    expect(first.status).toBe(201);
    // Vente supprimée avant l'expiration (rejeu → code existant).
    const deletedBody = { ...body, clientOperationId: randomUUID() };
    const toDelete = await call('post', '/sales', sellerToken).send(
      deletedBody,
    );
    expect(toDelete.status).toBe(201);
    expect(
      (await call('delete', `/sales/${toDelete.body._id}`, ownerToken)).status,
    ).toBe(204);

    // Réponse perdue, puis expiration.
    clockNow = AFTER_TRIAL;
    const counts = async () => ({
      sales: await saleModel.countDocuments({
        organizationId: new Types.ObjectId(orgId),
      }),
      stock: (await productModel.findById(productId).lean())!.remainingQuantity,
      audit: await connection
        .collection('auditlogs')
        .countDocuments({ organizationId: new Types.ObjectId(orgId) }),
      operations: await connection
        .collection('sale_operations')
        .countDocuments({ organizationId: new Types.ObjectId(orgId) }),
    });
    const before = await counts();
    const emitted = jest.spyOn(gateway, 'emitToOrganization');

    // 10. Rejeu exact → même vente, aucune écriture, aucun événement.
    const replay = await call('post', '/sales', sellerToken).send(body);
    expect(replay.status).toBe(201);
    expect(replay.body._id).toBe(first.body._id);
    // Codes existants conservés.
    const reused = await call('post', '/sales', sellerToken).send({
      ...body,
      quantity: 3,
    });
    expect([reused.status, reused.body.code]).toEqual([
      409,
      'IDEMPOTENCY_KEY_REUSED',
    ]);
    const otherSeller = await call('post', '/sales', ownerToken).send(body);
    expect([otherSeller.status, otherSeller.body.code]).toEqual([
      409,
      'IDEMPOTENCY_KEY_CONFLICT',
    ]);
    const deleted = await call('post', '/sales', sellerToken).send(deletedBody);
    expect([deleted.status, deleted.body.code]).toEqual([
      409,
      'SALE_OPERATION_ALREADY_APPLIED',
    ]);

    // 11. Nouvelle opération, clé inconnue, sans clé, date client ancienne.
    for (const fresh of [
      { ...body, clientOperationId: randomUUID() },
      { productId, quantity: 1, salePrice: 400 },
      {
        ...body,
        clientOperationId: randomUUID(),
        occurredAt: new Date(T0 + DAY_MS).toISOString(),
      },
    ]) {
      const res = await call('post', '/sales', sellerToken).send(fresh);
      expect([res.status, res.body.code]).toEqual([
        403,
        'SUBSCRIPTION_INACTIVE',
      ]);
    }
    // Jeton limité : aucune confirmation possible.
    const restricted = await restrictedToken(seller.email);
    const limited = await call('post', '/sales', restricted).send(body);
    expect([limited.status, limited.body.code]).toEqual([
      403,
      'SUBSCRIPTION_ACCESS_LIMITED',
    ]);

    expect(await counts()).toEqual(before);
    expect(emitted).not.toHaveBeenCalled();
  });

  // ─── 12. Sockets ───────────────────────────────────────────────────────────

  it('12a. handshake : jeton limité ou abonnement inactif → refus', async () => {
    clockNow = T0;
    const { email } = await registerOwner('socket-refused');
    clockNow = DURING_TRIAL;
    const token = await appToken(email);
    clockNow = AFTER_TRIAL;
    const restricted = await restrictedToken(email);
    for (const candidate of [token, restricted]) {
      const outcome = await socketOutcome(connectSocket(candidate));
      expect(outcome).toEqual({ connected: false, error: 'unauthorized' });
    }
  });

  it('12b. socket ouvert : fermé à l’échéance si l’état relu est inactif', async () => {
    clockNow = T0;
    const { email } = await registerOwner('socket-close');
    const coverageEnd = T0 + 7 * DAY_MS;
    clockNow = coverageEnd - 1_000;
    const token = await appToken(email);
    const socket = connectSocket(token);
    expect(await socketOutcome(socket)).toEqual({ connected: true });

    // Barrière : la relecture à l'échéance attend l'avance d'horloge.
    const check = gateNextDecision();
    const closed = new Promise<string>((resolve) =>
      socket.once('disconnect', (reason) => resolve(reason)),
    );
    await check.reached.promise;
    clockNow = coverageEnd + 1;
    check.release();
    expect((await check.done.promise).active).toBe(false);
    expect(await closed).toBe('io server disconnect');
  });

  it('12c. renouvellement avant l’échéance : socket conservé, émissions maintenues', async () => {
    clockNow = T0;
    const { email, orgId } = await registerOwner('socket-renew');
    const coverageEnd = T0 + 7 * DAY_MS;
    clockNow = coverageEnd - 1_000;
    const token = await appToken(email);
    const productId = await seedProduct(token, orgId);
    const socket = connectSocket(token);
    expect(await socketOutcome(socket)).toEqual({ connected: true });

    const check = gateNextDecision();
    await check.reached.promise;
    await grant(orgId); // renouvellement anticipé : prolonge la couverture
    clockNow = coverageEnd + 1;
    check.release();
    const decision = await check.done.promise;
    expect(decision.active).toBe(true);
    expect(socket.connected).toBe(true);

    const received = new Promise<unknown>((resolve) =>
      socket.once('sale:created', resolve),
    );
    const sale = await call('post', '/sales', token).send({
      productId,
      quantity: 1,
      salePrice: 400,
    });
    expect(sale.status).toBe(201);
    expect(await received).toMatchObject({ _id: sale.body._id });
  });

  // ─── 13. Protections antérieures ───────────────────────────────────────────

  it('13. suspension, révocation, email non vérifié et authVersion : protections antérieures prioritaires', async () => {
    clockNow = T0;
    const { email, orgId } = await registerOwner('prior');
    const revoked = await seedMember(orgId, 'seller', [], 'revoked');
    clockNow = AFTER_TRIAL;

    // Révocation : refus uniforme, aucun jeton limité.
    const revokedLogin = await loginRaw(revoked.email);
    expect(revokedLogin.status).toBe(403);
    expect(revokedLogin.body.code).toBe('ORGANIZATION_ACCESS_DENIED');
    expect(revokedLogin.body.restrictedToken).toBeUndefined();

    // Email non vérifié : refus 1-13A avant tout état commercial.
    seq += 1;
    const unverifiedEmail = `unverified-${seq}-14c1@access.test`;
    const unverified = await userModel.create({
      name: 'Unverified',
      email: unverifiedEmail,
      password: await bcrypt.hash(PASSWORD, 10),
    });
    await membershipModel.create({
      organizationId: new Types.ObjectId(orgId),
      userId: unverified._id,
      role: 'seller',
      status: 'active',
    });
    const unverifiedLogin = await loginRaw(unverifiedEmail);
    expect(unverifiedLogin.status).toBe(403);
    expect(unverifiedLogin.body.code).toBe('EMAIL_NOT_VERIFIED');
    expect(unverifiedLogin.body.restrictedToken).toBeUndefined();

    // authVersion : jeton limité antérieur à une réinitialisation → 401.
    const restricted = await restrictedToken(email);
    await bumpSessionVersion(email);
    const revokedSession = await call('get', '/auth/context', restricted);
    expect(revokedSession.status).toBe(401);
    expect(revokedSession.body.code).toBe('SESSION_REVOKED');

    // Suspension : prioritaire même avec un abonnement actif.
    await grant(orgId);
    const fresh = await appToken(email);
    await organizationModel.updateOne(
      { _id: new Types.ObjectId(orgId) },
      { $set: { status: 'suspended' } },
    );
    const suspended = await call('get', '/products', fresh);
    expect([suspended.status, suspended.body.code]).toEqual([
      403,
      'ORGANIZATION_ACCESS_DENIED',
    ]);
    const suspendedLogin = await loginRaw(email);
    expect(suspendedLogin.status).toBe(403);
    expect(suspendedLogin.body.code).toBe('ORGANIZATION_ACCESS_DENIED');
    expect(suspendedLogin.body.restrictedToken).toBeUndefined();
    const org = await organizationModel.findById(orgId).lean();
    expect(org!.status).toBe('suspended');
  });

  // ─── 14. Courses avec une réinitialisation ─────────────────────────────────

  it('14. réinitialisation concurrente pendant login, switch et échange : aucune session utilisable', async () => {
    clockNow = T0;
    const target = await registerOwner('race-target');
    const { email, orgId } = await registerOwner('race');
    const user = await userModel.findOne({ email });
    await membershipModel.create({
      organizationId: new Types.ObjectId(target.orgId),
      userId: user!._id,
      role: 'seller',
      status: 'active',
    });
    clockNow = DURING_TRIAL;

    // Login : version lue avec les identifiants ; réinitialisation pendant
    // la lecture commerciale → JWT émis mais refusé ensuite.
    let gate = gateNextDecision();
    // supertest n'envoie qu'au premier `.then()` : envoi explicite.
    const loginPending = loginRaw(email, orgId).then((r) => r);
    await gate.reached.promise;
    await bumpSessionVersion(email);
    gate.release();
    const login = await loginPending;
    expect(login.status).toBe(201);
    const stale = await call(
      'get',
      '/auth/me',
      login.body.access_token as string,
    );
    expect([stale.status, stale.body.code]).toEqual([401, 'SESSION_REVOKED']);

    // Switch : réinitialisation pendant la lecture → 401, aucun JWT.
    const token = await appToken(email, orgId);
    gate = gateNextDecision();
    const switchPending = call('post', '/auth/switch-organization', token)
      .send({ organizationId: target.orgId })
      .then((r) => r);
    await gate.reached.promise;
    await bumpSessionVersion(email);
    gate.release();
    const switched = await switchPending;
    expect([switched.status, switched.body.code]).toEqual([
      401,
      'SESSION_REVOKED',
    ]);
    expect(switched.body.access_token).toBeUndefined();

    // Échange du jeton limité : réinitialisation pendant la lecture → 401.
    clockNow = AFTER_TRIAL;
    const restricted = await restrictedToken(email, orgId);
    await grant(orgId);
    gate = gateNextDecision();
    const exchangePending = call(
      'post',
      '/auth/subscription-access/complete',
      restricted,
    ).then((r) => r);
    await gate.reached.promise;
    await bumpSessionVersion(email);
    gate.release();
    const exchanged = await exchangePending;
    expect([exchanged.status, exchanged.body.code]).toEqual([
      401,
      'SESSION_REVOKED',
    ]);
    expect(exchanged.body.access_token).toBeUndefined();
  });

  // ─── 15. Paramètres forgés ─────────────────────────────────────────────────

  it('15. claims mal typés et paramètres forgés : aucun contournement', async () => {
    clockNow = T0;
    const { email, orgId } = await registerOwner('forged');
    const other = await registerOwner('forged-other');
    const user = await userModel.findOne({ email });
    clockNow = AFTER_TRIAL;
    await grant(other.orgId);
    const restricted = await restrictedToken(email);
    const base = { sub: user!._id.toString(), orgId, ver: 0 };
    for (const accessScope of ['APP', 'admin', 1, null, ['app'], { a: 1 }]) {
      const forged = jwtService.sign({ ...base, accessScope });
      const res = await call('get', '/auth/me', forged);
      expect(res.status).toBe(401);
      const socket = await socketOutcome(connectSocket(forged));
      expect(socket.connected).toBe(false);
    }
    // Paramètres client ignorés : organisation, état, dates.
    const res = await request(server())
      .get(`/products?organizationId=${other.orgId}&state=active`)
      .set('Authorization', `Bearer ${restricted}`)
      .set('X-Organization-Id', other.orgId)
      .set('X-Subscription-State', 'active');
    expect([res.status, res.body.code]).toEqual([
      403,
      'SUBSCRIPTION_ACCESS_LIMITED',
    ]);
    const sale = await call('post', '/sales', restricted).send({
      productId: new Types.ObjectId().toString(),
      quantity: 1,
      salePrice: 1,
      organizationId: other.orgId,
    });
    // Refus commercial AVANT toute validation ou lecture du corps.
    expect([sale.status, sale.body.code]).toEqual([
      403,
      'SUBSCRIPTION_ACCESS_LIMITED',
    ]);
    // Aucune route HTTP ne crée de période.
    const before = await periodModel.countDocuments();
    for (const method of ['post', 'patch'] as const) {
      const write = await call(
        method,
        '/organizations/current/subscription',
        restricted,
      ).send({ term: 'annual', startsAt: new Date(T0).toISOString() });
      expect(write.status).toBe(404);
    }
    expect(await periodModel.countDocuments()).toBe(before);
  });

  // ─── 16. Projections et journaux ───────────────────────────────────────────

  it('16. projections, en-têtes et journaux : aucun champ interne exposé', async () => {
    // Capture des journaux du processus (stdout/stderr) pendant le scénario.
    const writes: string[] = [];
    const record = (chunk: string | Uint8Array): boolean => {
      writes.push(String(chunk));
      return true;
    };
    jest.spyOn(process.stdout, 'write').mockImplementation(record);
    jest.spyOn(process.stderr, 'write').mockImplementation(record);

    clockNow = T0;
    const { email } = await registerOwner('projection');
    clockNow = AFTER_TRIAL;
    const login = await loginRaw(email);
    const restricted = login.body.restrictedToken as string;
    const responses = [
      login,
      await call('get', '/auth/context', restricted),
      await call('get', '/auth/me', restricted),
      await call('get', '/auth/organizations', restricted),
      await call('get', '/organizations/current/subscription', restricted),
      await call('get', '/products', restricted),
      await call('post', '/auth/subscription-access/complete', restricted),
    ];
    for (const res of responses) {
      expect(res.headers['cache-control']).toBe('no-store');
      const flat = JSON.stringify(res.body);
      for (const internal of [
        'sourceReference',
        'grantedBy',
        'trial:',
        'previousPeriodId',
        'sequence',
        'authVersion',
        'password',
        'membershipId',
      ]) {
        expect(flat).not.toContain(internal);
      }
    }
    const logs = writes.join('');
    expect(logs).not.toContain(restricted);
    expect(logs).not.toContain(PASSWORD);
    expect(logs).not.toContain(TEST_JWT_SECRET);
    expect(logs).not.toContain(process.env.MONGODB_URI ?? 'never');
  });
});
