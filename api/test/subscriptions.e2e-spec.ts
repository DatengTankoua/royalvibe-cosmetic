import 'reflect-metadata';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { Connection, Model, Types } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { ThrottlerStorage } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { UserDocument } from './../src/users/schemas/user.schema';
import { Organization } from './../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from './../src/organizations/schemas/organization.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import {
  SUBSCRIPTION_PERIODS_COLLECTION,
  SubscriptionPeriod,
  SubscriptionPeriodDocument,
} from './../src/subscriptions/schemas/subscription-period.schema';
import {
  SubscriptionPeriodIndexError,
  ensureSubscriptionPeriodIndexes,
  verifySubscriptionPeriodIndexes,
} from './../src/subscriptions/subscription-period-indexes';
import {
  SubscriptionGrantError,
  SubscriptionsService,
} from './../src/subscriptions/subscriptions.service';
import { SUBSCRIPTION_CLOCK } from './../src/subscriptions/subscription-clock';
import { EmailVerificationService } from './../src/email-verification/email-verification.service';
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
  verificationTokenFrom,
} from './e2e/email-verification-fixtures';
import { createInvitedAccount } from './e2e/invitation-acceptance-fixtures';
import { OWNER_TERMS } from './e2e/legal-acceptance-fixtures';

import { postRegister } from './e2e/registration-fixtures';

// 1-13A : expéditeur simulé, liens confirmés via le service réel.
const emailSender = createE2eEmailSender();

/**
 * E2E 1-14B — socle d'abonnement par organisation, sur replica set éphémère
 * (`MongoMemoryReplSet`, garde anti-27017). Aucune base réelle, aucun
 * fournisseur de paiement.
 *
 * Horloge : `SUBSCRIPTION_CLOCK` remplacé UNIQUEMENT ici
 * (`overrideProvider`) ; aucune variable de production.
 *
 * Les index `subscription_periods` ne sont jamais créés au démarrage : ce
 * fichier prouve leur absence, puis les crée via la fonction de migration.
 * Le script compilé (`dist/`) est exercé en sous-processus sur cette même
 * base éphémère (prérequis : `pnpm --filter api build`).
 */

const TEST_JWT_SECRET = 'subscriptions-14b-e2e-only-secret';
const E2E_CORS_ORIGIN = 'https://subscriptions-e2e.example.com';
const PASSWORD = 'subs-14b-pw-!1x';
const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_MS = 7 * DAY_MS;
const T0 = new Date('2026-03-01T09:00:00.000Z');

const DIST_DIR = join(__dirname, '..', 'dist', 'migrations');
const GRANT_SCRIPT = join(DIST_DIR, 'grant-subscription-period.js');
const MIGRATION_SCRIPT = join(
  DIST_DIR,
  'create-subscription-period-indexes.js',
);

let clockNow: Date | null = null;
const testClock = () => (clockNow ? new Date(clockNow) : new Date());

describe('Abonnements par organisation (e2e 1-14B)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let connection: Connection;
  let mongoUri = '';
  let userModel: Model<UserDocument>;
  let organizationModel: Model<OrganizationDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;
  let periodModel: Model<SubscriptionPeriodDocument>;
  let subscriptions: SubscriptionsService;
  let sequenceId = 0;

  const clearThrottle = () =>
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();

  async function registerOwner(label: string) {
    clearThrottle();
    sequenceId += 1;
    const email = `${label}-${sequenceId}-14b@subs.test`;
    const reg = await postRegister(app, {
      ...OWNER_TERMS,
      name: 'Owner',
      email,
      password: PASSWORD,
      organizationName: `Org ${sequenceId}`,
    });
    expect(reg.status).toBe(202);
    const orgId = reg.owner!.organization._id;
    const token = await login(email);
    return { email, orgId, token };
  }

  async function login(email: string): Promise<string> {
    clearThrottle();
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD });
    expect(res.status).toBe(201);
    return res.body.access_token as string;
  }

  async function seedMember(
    orgId: string,
    role: 'admin' | 'seller',
    permissions: string[] = [],
  ): Promise<string> {
    sequenceId += 1;
    const email = `${role}-${sequenceId}-14b@subs.test`;
    const user = await userModel.create({
      emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
      name: role,
      email,
      password: await bcrypt.hash(PASSWORD, 10),
      // Rôle legacy `admin` : ne doit JAMAIS ouvrir la lecture.
      role: 'admin',
    });
    await membershipModel.create({
      organizationId: new Types.ObjectId(orgId),
      userId: user._id,
      role,
      status: 'active',
      permissions,
    });
    return login(email);
  }

  const periodsOf = (orgId: string) =>
    periodModel
      .find({ organizationId: new Types.ObjectId(orgId) })
      .sort({ sequence: 1 })
      .lean()
      .exec();

  const grant = (
    organizationId: string,
    term: string,
    sourceReference: string,
    grantedBy = 'ops-e2e',
  ) =>
    subscriptions.grantSubscription({
      organizationId,
      term,
      sourceReference,
      grantedBy,
    });

  const getSubscription = (token: string, path = '') =>
    request(app.getHttpServer())
      .get(`/organizations/current/subscription${path}`)
      .set('Authorization', `Bearer ${token}`);

  const expectGrantError = async (
    promise: Promise<unknown>,
    code: string,
  ): Promise<void> => {
    const error: unknown = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SubscriptionGrantError);
    expect((error as SubscriptionGrantError).code).toBe(code);
  };

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      mongoUri = validatedEphemeralUri(replSet);
      process.env.MONGODB_URI = mongoUri;
      process.env.JWT_SECRET = TEST_JWT_SECRET;
      process.env.CORS_ORIGIN = E2E_CORS_ORIGIN;
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';

      moduleFixture = await Test.createTestingModule({
        imports: [AppModule],
      })
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

      connection = moduleFixture.get(getConnectionToken());
      userModel = moduleFixture.get(getModelToken('User'));
      organizationModel = moduleFixture.get(getModelToken(Organization.name));
      membershipModel = moduleFixture.get(
        getModelToken(OrganizationMembership.name),
      );
      periodModel = moduleFixture.get(getModelToken(SubscriptionPeriod.name));
      subscriptions = moduleFixture.get(SubscriptionsService);
    } catch (error) {
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  afterEach(() => {
    clockNow = null;
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  // ─── 1. Index et migration ─────────────────────────────────────────────────

  describe('1. Index (migration explicite)', () => {
    it('absents après le démarrage (autoIndex désactivé) → vérification refusée', async () => {
      await expect(verifySubscriptionPeriodIndexes(connection)).rejects.toThrow(
        SubscriptionPeriodIndexError,
      );
    });

    it('migration : créés puis rejeu sans changement', async () => {
      await expect(ensureSubscriptionPeriodIndexes(connection)).resolves.toBe(
        'created',
      );
      const before = await connection
        .db!.collection(SUBSCRIPTION_PERIODS_COLLECTION)
        .listIndexes()
        .toArray();
      await expect(ensureSubscriptionPeriodIndexes(connection)).resolves.toBe(
        'already-present',
      );
      const after = await connection
        .db!.collection(SUBSCRIPTION_PERIODS_COLLECTION)
        .listIndexes()
        .toArray();
      expect(after).toEqual(before);
      expect(after.map((i) => i.name).sort()).toEqual(
        [
          '_id_',
          'organizationId_1_sequence_1',
          'organizationId_1_single_trial',
          'source_1_sourceReference_1',
        ].sort(),
      );
      await expect(
        verifySubscriptionPeriodIndexes(connection),
      ).resolves.toBeUndefined();
    });

    it('configuration incompatible (même clé non unique) → refusée, jamais écrasée', async () => {
      const collection = connection.db!.collection(
        SUBSCRIPTION_PERIODS_COLLECTION,
      );
      await collection.dropIndex('organizationId_1_sequence_1');
      await collection.createIndex(
        { organizationId: 1, sequence: 1 },
        { name: 'organizationId_1_sequence_1' },
      );
      try {
        await expect(
          ensureSubscriptionPeriodIndexes(connection),
        ).rejects.toThrow(SubscriptionPeriodIndexError);
        const kept = (await collection.listIndexes().toArray()).find(
          (i) => i.name === 'organizationId_1_sequence_1',
        );
        expect(kept?.unique).toBeUndefined();
      } finally {
        await collection.dropIndex('organizationId_1_sequence_1');
        await ensureSubscriptionPeriodIndexes(connection);
      }
      await expect(
        verifySubscriptionPeriodIndexes(connection),
      ).resolves.toBeUndefined();
    });
  });

  // ─── 2. Essai ──────────────────────────────────────────────────────────────

  describe('2. Essai de 7 jours à la création', () => {
    it('inscription → exactement un essai de 7 × 24 h, heure serveur, rang 1', async () => {
      clockNow = T0;
      const { orgId } = await registerOwner('trial');
      const periods = await periodsOf(orgId);
      expect(periods).toHaveLength(1);
      const [trial] = periods;
      expect(trial).toMatchObject({
        sequence: 1,
        kind: 'trial',
        term: null,
        source: 'trial',
        sourceReference: `trial:${orgId}`,
        grantedBy: 'system',
        previousPeriodId: null,
      });
      expect(trial.startsAt.toISOString()).toBe(T0.toISOString());
      expect(trial.endsAt.getTime() - trial.startsAt.getTime()).toBe(TRIAL_MS);

      // Organization inchangée : aucun champ commercial, statut actif.
      const org = await organizationModel.findById(orgId).lean().exec();
      expect(Object.keys(org!).sort()).toEqual(
        [
          '__v',
          '_id',
          'brandColor',
          'createdAt',
          'currency',
          'logoKey',
          // 1-17A : identité du stockage du logo (jamais commerciale).
          'logoStorage',
          'name',
          'slug',
          'status',
          'updatedAt',
        ].sort(),
      );
      expect(org!.status).toBe('active');
      // Aucun logo à l'inscription : clé et stockage absents.
      expect(org!.logoKey).toBeNull();
      expect(org!.logoStorage).toBeNull();
    });

    it('échec de l’essai → rollback complet (ni User, ni Organization, ni période)', async () => {
      clearThrottle();
      const email = `trial-rollback-${Date.now()}@subs.test`;
      const counts = () =>
        Promise.all([
          userModel.countDocuments({ email }),
          organizationModel.countDocuments(),
          membershipModel.countDocuments(),
          periodModel.countDocuments(),
        ]);
      const before = await counts();
      const originalCreate = periodModel.create.bind(periodModel) as (
        docs: unknown,
        opts?: { session?: unknown },
      ) => Promise<unknown>;
      periodModel.create = ((docs: unknown, opts?: { session?: unknown }) =>
        opts?.session
          ? Promise.reject(new Error('simulated trial failure'))
          : originalCreate(docs, opts)) as unknown as typeof periodModel.create;
      let res: request.Response;
      try {
        res = await postRegister(app, {
          ...OWNER_TERMS,
          name: 'Rollback',
          email,
          password: PASSWORD,
          organizationName: 'Rollback Org',
        });
      } finally {
        periodModel.create =
          originalCreate as unknown as typeof periodModel.create;
      }
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(await counts()).toEqual(before);
    });

    it('rollback APRÈS l’essai (même transaction) → aucune période orpheline', async () => {
      const before = await periodModel.countDocuments();
      const orgId = new Types.ObjectId();
      const session = await connection.startSession();
      try {
        await expect(
          session.withTransaction(async () => {
            await subscriptions.grantTrial(orgId, session);
            throw new Error('simulated failure after trial');
          }),
        ).rejects.toThrow('simulated failure after trial');
      } finally {
        await session.endSession();
      }
      expect(await periodModel.countDocuments()).toBe(before);
      expect(await periodModel.countDocuments({ organizationId: orgId })).toBe(
        0,
      );
    });

    it('deuxième essai impossible (service, puis contrainte DB avec une autre référence)', async () => {
      const { orgId } = await registerOwner('trial-twice');
      const session = await connection.startSession();
      try {
        await expectGrantError(
          session.withTransaction(() =>
            subscriptions.grantTrial(new Types.ObjectId(orgId), session),
          ),
          'TRIAL_ALREADY_GRANTED',
        );
      } finally {
        await session.endSession();
      }
      const insert = periodModel.collection.insertOne({
        organizationId: new Types.ObjectId(orgId),
        sequence: 99,
        kind: 'trial',
        term: null,
        startsAt: new Date(),
        endsAt: new Date(Date.now() + TRIAL_MS),
        source: 'trial',
        sourceReference: `other-reference-${orgId}`,
        grantedBy: 'system',
        previousPeriodId: null,
      });
      await expect(insert).rejects.toMatchObject({
        code: 11000,
        keyPattern: { organizationId: 1 },
      });
      expect(await periodsOf(orgId)).toHaveLength(1);
    });

    it('chaque nouvelle organisation reçoit son propre essai', async () => {
      const a = await registerOwner('own-trial-a');
      const b = await registerOwner('own-trial-b');
      const [pa] = await periodsOf(a.orgId);
      const [pb] = await periodsOf(b.orgId);
      expect(pa.kind).toBe('trial');
      expect(pb.kind).toBe('trial');
      expect(pa._id.equals(pb._id)).toBe(false);
    });

    it('vérification d’email différée → début d’essai inchangé', async () => {
      emailSender.onSent = null;
      try {
        clockNow = T0;
        clearThrottle();
        const email = `late-verify-${Date.now()}@subs.test`;
        const reg = await postRegister(app, {
          ...OWNER_TERMS,
          name: 'Late',
          email,
          password: PASSWORD,
          organizationName: 'Late Verify',
        });
        expect(reg.status).toBe(202);
        const orgId = reg.owner!.organization._id;

        clockNow = new Date(T0.getTime() + 2 * DAY_MS);
        const [sent] = emailSender.sentTo(email).slice(-1);
        await app
          .get(EmailVerificationService)
          .confirm(verificationTokenFrom(sent));
        await login(email);

        const periods = await periodsOf(orgId);
        expect(periods).toHaveLength(1);
        expect(periods[0].startsAt.toISOString()).toBe(T0.toISOString());
      } finally {
        autoConfirmVerificationEmails(app, emailSender);
      }
    });

    it('invitation acceptée, reconnexion et branding → essai inchangé, aucun essai pour le membre', async () => {
      const owner = await registerOwner('invite-keeps');
      const snapshot = await periodsOf(owner.orgId);
      const totalBefore = await periodModel.countDocuments();

      sequenceId += 1;
      const inviteeEmail = `invitee-${sequenceId}-14b@subs.test`;
      const issued = await request(app.getHttpServer())
        .post('/organizations/invitations')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ email: inviteeEmail, role: 'seller' });
      expect(issued.status).toBe(201);
      const token =
        new URL(String(issued.body.invitationUrl)).searchParams.get('token') ??
        '';
      clearThrottle();
      const accepted = await createInvitedAccount(
        app.getHttpServer(),
        emailSender,
        token,
        inviteeEmail,
        { name: 'Invitee', password: PASSWORD },
      );
      expect(accepted.status).toBe(200);
      await login(inviteeEmail);
      await login(owner.email);

      const branding = await request(app.getHttpServer())
        .patch('/organizations/current/branding')
        .set('Authorization', `Bearer ${owner.token}`)
        .field('brandColor', '#123456');
      expect(branding.status).toBe(200);

      expect(await periodsOf(owner.orgId)).toEqual(snapshot);
      expect(await periodModel.countDocuments()).toBe(totalBefore);
    });
  });

  // ─── 3. Lecture ────────────────────────────────────────────────────────────

  describe('3. GET /organizations/current/subscription', () => {
    let owner: { orgId: string; token: string; email: string };
    let other: { orgId: string; token: string; email: string };

    beforeAll(async () => {
      clockNow = T0;
      owner = await registerOwner('read');
      other = await registerOwner('read-other');
      clockNow = null;
    });

    it('propriétaire → 200, projection explicite, aucune donnée interne', async () => {
      clockNow = new Date(T0.getTime() + DAY_MS);
      const res = await getSubscription(owner.token);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        state: 'active',
        currentPeriod: {
          kind: 'trial',
          term: null,
          startsAt: T0.toISOString(),
          endsAt: new Date(T0.getTime() + TRIAL_MS).toISOString(),
        },
        coverageEndsAt: new Date(T0.getTime() + TRIAL_MS).toISOString(),
        nextPeriodStartsAt: null,
        // 1-14C.2 : historique des périodes (projection explicite).
        periods: [
          {
            kind: 'trial',
            term: null,
            startsAt: T0.toISOString(),
            endsAt: new Date(T0.getTime() + TRIAL_MS).toISOString(),
          },
        ],
      });
      const flat = JSON.stringify(res.body);
      for (const forbidden of [
        'sourceReference',
        'grantedBy',
        'system',
        'trial:',
        'sequence',
        'previousPeriodId',
        '_id',
        owner.orgId,
      ]) {
        expect(flat).not.toContain(forbidden);
      }
    });

    it('organisation tirée du contexte seul (query/body ignorés)', async () => {
      await grant(other.orgId, 'annual', `read-other-${Date.now()}`);
      clockNow = new Date(T0.getTime() + DAY_MS);
      const res = await request(app.getHttpServer())
        .get(
          `/organizations/current/subscription?organizationId=${other.orgId}`,
        )
        .set('Authorization', `Bearer ${owner.token}`)
        .set('X-Organization-Id', other.orgId);
      expect(res.status).toBe(200);
      expect(res.body.currentPeriod.kind).toBe('trial');
    });

    it('après l’essai → expired (calcul à l’heure serveur, sans cron)', async () => {
      clockNow = new Date(T0.getTime() + TRIAL_MS);
      const res = await getSubscription(owner.token);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        state: 'expired',
        currentPeriod: null,
        coverageEndsAt: new Date(T0.getTime() + TRIAL_MS).toISOString(),
        nextPeriodStartsAt: null,
        periods: [
          {
            kind: 'trial',
            term: null,
            startsAt: T0.toISOString(),
            endsAt: new Date(T0.getTime() + TRIAL_MS).toISOString(),
          },
        ],
      });
    });

    it('admin (toutes permissions + rôle legacy admin) et vendeur → 403 PERMISSION_DENIED', async () => {
      // 1-14C.1 : connexion pendant l'essai (heure serveur figée).
      clockNow = new Date(T0.getTime() + DAY_MS);
      const adminToken = await seedMember(owner.orgId, 'admin', [
        'members.manage',
        'branding.manage',
      ]);
      const sellerToken = await seedMember(owner.orgId, 'seller', [
        'analytics.read',
      ]);
      for (const token of [adminToken, sellerToken]) {
        const res = await getSubscription(token);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('PERMISSION_DENIED');
      }
    });

    it('sans JWT → 401 ; aucune route d’écriture', async () => {
      const anonymous = await request(app.getHttpServer()).get(
        '/organizations/current/subscription',
      );
      expect(anonymous.status).toBe(401);
      const body = { term: 'annual', startsAt: '2020-01-01T00:00:00.000Z' };
      const writes = await Promise.all([
        request(app.getHttpServer())
          .post('/organizations/current/subscription')
          .set('Authorization', `Bearer ${owner.token}`)
          .send(body),
        request(app.getHttpServer())
          .patch('/organizations/current/subscription')
          .set('Authorization', `Bearer ${owner.token}`)
          .send(body),
        request(app.getHttpServer())
          .put('/organizations/current/subscription')
          .set('Authorization', `Bearer ${owner.token}`)
          .send(body),
        request(app.getHttpServer())
          .delete('/organizations/current/subscription')
          .set('Authorization', `Bearer ${owner.token}`),
      ]);
      for (const res of writes) expect(res.status).toBe(404);
      expect(await periodsOf(owner.orgId)).toHaveLength(1);
    });
  });

  // ─── 4. Renouvellement ─────────────────────────────────────────────────────

  describe('4. Renouvellement (cumul de la couverture)', () => {
    it('pendant l’essai, anticipés multiples, pendant un abonnement, après expiration', async () => {
      clockNow = T0;
      const { orgId, token } = await registerOwner('renew');
      const trialEnd = new Date(T0.getTime() + TRIAL_MS);

      // Pendant l'essai : commence à la fin de l'essai (temps non perdu).
      clockNow = new Date(T0.getTime() + 2 * DAY_MS);
      const r1 = await grant(orgId, 'monthly', `renew-1-${orgId}`);
      expect(r1.replayed).toBe(false);
      expect(r1.startsAt.toISOString()).toBe(trialEnd.toISOString());
      expect(r1.endsAt.toISOString()).toBe('2026-04-08T09:00:00.000Z');

      // Deuxième anticipé : après r1.
      const r2 = await grant(orgId, 'quarterly', `renew-2-${orgId}`);
      expect(r2.startsAt.toISOString()).toBe(r1.endsAt.toISOString());
      expect(r2.endsAt.toISOString()).toBe('2026-07-08T09:00:00.000Z');

      const during = await getSubscription(token);
      expect(during.body.state).toBe('active');
      expect(during.body.currentPeriod.kind).toBe('trial');
      expect(during.body.coverageEndsAt).toBe('2026-07-08T09:00:00.000Z');

      // Pendant un abonnement : après la couverture future.
      clockNow = new Date('2026-04-10T00:00:00.000Z');
      const r3 = await grant(orgId, 'annual', `renew-3-${orgId}`);
      expect(r3.startsAt.toISOString()).toBe('2026-07-08T09:00:00.000Z');
      expect(r3.endsAt.toISOString()).toBe('2027-07-08T09:00:00.000Z');
      const mid = await getSubscription(token);
      expect(mid.body.currentPeriod).toMatchObject({
        kind: 'subscription',
        term: 'quarterly',
      });
      expect(mid.body.coverageEndsAt).toBe('2027-07-08T09:00:00.000Z');

      // Après expiration : commence maintenant.
      clockNow = new Date('2028-01-31T10:00:00.000Z');
      expect((await getSubscription(token)).body.state).toBe('expired');
      const r4 = await grant(orgId, 'semiannual', `renew-4-${orgId}`);
      expect(r4.startsAt.toISOString()).toBe('2028-01-31T10:00:00.000Z');
      expect(r4.endsAt.toISOString()).toBe('2028-07-31T10:00:00.000Z');
      const after = await getSubscription(token);
      expect(after.body.state).toBe('active');
      expect(after.body.currentPeriod.term).toBe('semiannual');

      // Chaîne linéaire, aucune période modifiée.
      const periods = await periodsOf(orgId);
      expect(periods.map((p) => p.sequence)).toEqual([1, 2, 3, 4, 5]);
      for (let i = 1; i < periods.length; i++) {
        expect(String(periods[i].previousPeriodId)).toBe(
          String(periods[i - 1]._id),
        );
      }
      expect(periods[0].endsAt.toISOString()).toBe(trialEnd.toISOString());
    });

    it('1-14C.2 : historique des périodes — plus récente d’abord, projection explicite, lecture seule', async () => {
      clockNow = T0;
      const { orgId, token } = await registerOwner('history');
      clockNow = new Date(T0.getTime() + 2 * DAY_MS);
      await grant(orgId, 'monthly', `hist-1-${orgId}`, 'ops-secret-name');
      await grant(orgId, 'annual', `hist-2-${orgId}`, 'ops-secret-name');
      const before = await periodModel.countDocuments({
        organizationId: new Types.ObjectId(orgId),
      });
      const res = await getSubscription(token);
      expect(res.status).toBe(200);
      const periods = res.body.periods as Array<Record<string, unknown>>;
      expect(periods.map((p) => [p.kind, p.term])).toEqual([
        ['subscription', 'annual'],
        ['subscription', 'monthly'],
        ['trial', null],
      ]);
      for (const entry of periods) {
        expect(Object.keys(entry).sort()).toEqual([
          'endsAt',
          'kind',
          'startsAt',
          'term',
        ]);
      }
      expect(periods[1]).toEqual({
        kind: 'subscription',
        term: 'monthly',
        startsAt: '2026-03-08T09:00:00.000Z',
        endsAt: '2026-04-08T09:00:00.000Z',
      });
      const flat = JSON.stringify(res.body);
      for (const forbidden of [
        'hist-1-',
        'hist-2-',
        'ops-secret-name',
        'manual',
        'source',
        'sequence',
        'previousPeriodId',
        '_id',
      ]) {
        expect(flat).not.toContain(forbidden);
      }
      // Lecture seule : aucune période créée par la consultation.
      expect(
        await periodModel.countDocuments({
          organizationId: new Types.ObjectId(orgId),
        }),
      ).toBe(before);
    });

    it('attribution à une organisation inexistante ou entrées invalides → refus, aucune écriture', async () => {
      const before = await periodModel.countDocuments();
      await expectGrantError(
        grant(
          new Types.ObjectId().toString(),
          'monthly',
          `ghost-${Date.now()}`,
        ),
        'ORGANIZATION_NOT_FOUND',
      );
      const { orgId } = await registerOwner('invalid-input');
      const afterRegister = await periodModel.countDocuments();
      await expectGrantError(
        grant('not-an-id', 'monthly', 'x'),
        'INVALID_INPUT',
      );
      await expectGrantError(grant(orgId, 'weekly', 'x'), 'INVALID_INPUT');
      await expectGrantError(grant(orgId, 'monthly', '   '), 'INVALID_INPUT');
      await expectGrantError(grant(orgId, 'monthly', 'x', ''), 'INVALID_INPUT');
      expect(afterRegister).toBe(before + 1);
      expect(await periodModel.countDocuments()).toBe(afterRegister);
    });
  });

  // ─── 5. Idempotence ────────────────────────────────────────────────────────

  describe('5. Idempotence { source, sourceReference }', () => {
    it('rejeu séquentiel (heure et opérateur différents) → même période, aucune durée ajoutée', async () => {
      clockNow = T0;
      const { orgId } = await registerOwner('replay');
      const reference = `REC-replay-${orgId}`;
      const first = await grant(orgId, 'monthly', reference);
      clockNow = new Date(T0.getTime() + 40 * DAY_MS);
      const again = await grant(
        orgId,
        'monthly',
        reference,
        'another-operator',
      );
      expect(again.replayed).toBe(true);
      expect(again.periodId).toBe(first.periodId);
      expect(again.startsAt.toISOString()).toBe(first.startsAt.toISOString());
      expect(again.endsAt.toISOString()).toBe(first.endsAt.toISOString());
      expect(await periodsOf(orgId)).toHaveLength(2);
    });

    it('même référence, autre organisation ou autre durée → conflit, aucune écriture', async () => {
      const a = await registerOwner('conflict-a');
      const b = await registerOwner('conflict-b');
      const reference = `REC-conflict-${a.orgId}`;
      await grant(a.orgId, 'monthly', reference);
      const before = await periodModel.countDocuments();
      await expectGrantError(
        grant(b.orgId, 'monthly', reference),
        'SUBSCRIPTION_REFERENCE_CONFLICT',
      );
      await expectGrantError(
        grant(a.orgId, 'annual', reference),
        'SUBSCRIPTION_REFERENCE_CONFLICT',
      );
      expect(await periodModel.countDocuments()).toBe(before);
      expect(await periodsOf(b.orgId)).toHaveLength(1);
    });

    it('rejeux concurrents d’une même référence → une seule période', async () => {
      const { orgId } = await registerOwner('replay-concurrent');
      const reference = `REC-concurrent-${orgId}`;
      const results = await Promise.all(
        Array.from({ length: 6 }, () => grant(orgId, 'quarterly', reference)),
      );
      expect(new Set(results.map((r) => r.periodId)).size).toBe(1);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      const periods = await periodsOf(orgId);
      expect(periods).toHaveLength(2);
      expect(
        await periodModel.countDocuments({
          source: 'manual',
          sourceReference: reference,
        }),
      ).toBe(1);
    });
  });

  // ─── 6. Concurrence ────────────────────────────────────────────────────────

  describe('6. Attributions différentes simultanées', () => {
    it('cumul complet, chaîne linéaire, aucune branche', async () => {
      clockNow = T0;
      const { orgId } = await registerOwner('parallel');
      // Instrumentation (lecture seule) : nombre d'insertions tentées, pour
      // constater les collisions réellement absorbées par la reprise.
      const originalCreate = periodModel.create.bind(periodModel) as (
        ...args: unknown[]
      ) => Promise<unknown>;
      let createAttempts = 0;
      periodModel.create = ((...args: unknown[]) => {
        createAttempts += 1;
        return originalCreate(...args);
      }) as unknown as typeof periodModel.create;
      let results: Awaited<ReturnType<typeof grant>>[];
      try {
        results = await Promise.all(
          [1, 2, 3, 4].map((n) =>
            grant(orgId, 'monthly', `REC-parallel-${n}-${orgId}`),
          ),
        );
      } finally {
        periodModel.create =
          originalCreate as unknown as typeof periodModel.create;
      }
      expect(results.every((r) => !r.replayed)).toBe(true);
      expect(createAttempts).toBeGreaterThanOrEqual(4);
      console.log(
        `[1-14B] 4 attributions simultanées : ${createAttempts} insertions tentées.`,
      );

      const periods = await periodsOf(orgId);
      expect(periods.map((p) => p.sequence)).toEqual([1, 2, 3, 4, 5]);
      const previous = periods.slice(1).map((p) => String(p.previousPeriodId));
      expect(new Set(previous).size).toBe(4);
      for (let i = 1; i < periods.length; i++) {
        expect(String(periods[i].previousPeriodId)).toBe(
          String(periods[i - 1]._id),
        );
        // Jointives : chaque période commence à la fin de la précédente.
        expect(periods[i].startsAt.toISOString()).toBe(
          periods[i - 1].endsAt.toISOString(),
        );
      }
      // Essai (→ 8 mars) + 4 mois calendaires.
      expect(periods[4].endsAt.toISOString()).toBe('2026-07-08T09:00:00.000Z');
    });

    it('contrainte DB : un rang déjà pris est refusé (aucune branche possible)', async () => {
      const { orgId } = await registerOwner('fork');
      const [trial] = await periodsOf(orgId);
      const fork = periodModel.collection.insertOne({
        organizationId: new Types.ObjectId(orgId),
        sequence: 1,
        kind: 'subscription',
        term: 'monthly',
        startsAt: trial.endsAt,
        endsAt: new Date(trial.endsAt.getTime() + 30 * DAY_MS),
        source: 'manual',
        sourceReference: `REC-fork-${orgId}`,
        grantedBy: 'ops-e2e',
        previousPeriodId: null,
      });
      await expect(fork).rejects.toMatchObject({
        code: 11000,
        keyPattern: { organizationId: 1, sequence: 1 },
      });
      expect(await periodsOf(orgId)).toHaveLength(1);
    });
  });

  // ─── 7. Isolation, suspension, absence de blocage ──────────────────────────

  describe('7. Isolation, suspension et blocage commercial (1-14C.1)', () => {
    it('isolation : une attribution ne touche jamais une autre organisation', async () => {
      clockNow = T0;
      const a = await registerOwner('iso-a');
      const b = await registerOwner('iso-b');
      const bBefore = await periodsOf(b.orgId);
      await grant(a.orgId, 'annual', `REC-iso-${a.orgId}`);
      expect(await periodsOf(b.orgId)).toEqual(bBefore);
      clockNow = new Date(T0.getTime() + DAY_MS);
      const resB = await getSubscription(b.token);
      expect(resB.body.coverageEndsAt).toBe(
        new Date(T0.getTime() + TRIAL_MS).toISOString(),
      );
      const resA = await getSubscription(a.token);
      expect(resA.body.coverageEndsAt).toBe('2027-03-08T09:00:00.000Z');
    });

    it('suspension administrative conservée, jamais levée par une attribution', async () => {
      const { orgId, token } = await registerOwner('suspended');
      await organizationModel.updateOne(
        { _id: new Types.ObjectId(orgId) },
        { $set: { status: 'suspended' } },
      );
      const granted = await grant(orgId, 'annual', `REC-suspended-${orgId}`);
      expect(granted.replayed).toBe(false);
      const org = await organizationModel.findById(orgId).lean().exec();
      expect(org!.status).toBe('suspended');
      const res = await getSubscription(token);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ORGANIZATION_ACCESS_DENIED');
    });

    it('1-14C.1 : organisation expirée ou sans période → accès métier bloqué (ancien JWT compris), état lisible', async () => {
      clockNow = T0;
      const expired = await registerOwner('block-expired');
      clockNow = new Date(T0.getTime() + 365 * DAY_MS);
      // Lecture d'état propriétaire toujours possible (renouvellement).
      expect((await getSubscription(expired.token)).body.state).toBe('expired');

      // Organisation locale historique : aucune période (aucune migration).
      const legacyOrg = await organizationModel.create({
        name: 'Legacy',
        slug: `legacy-${Date.now()}`,
      });
      sequenceId += 1;
      const legacyEmail = `legacy-${sequenceId}-14b@subs.test`;
      const legacyUser = await userModel.create({
        emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
        name: 'Legacy',
        email: legacyEmail,
        password: await bcrypt.hash(PASSWORD, 10),
      });
      await membershipModel.create({
        organizationId: legacyOrg._id,
        userId: legacyUser._id,
        role: 'owner',
        status: 'active',
      });
      clearThrottle();
      const legacyLogin = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: legacyEmail, password: PASSWORD });
      expect(legacyLogin.status).toBe(403);
      expect(legacyLogin.body.code).toBe('SUBSCRIPTION_INACTIVE');
      expect(legacyLogin.body.access_token).toBeUndefined();
      const restricted = legacyLogin.body.restrictedToken as string;
      const none = await getSubscription(restricted);
      expect(none.body).toEqual({
        state: 'none',
        currentPeriod: null,
        coverageEndsAt: null,
        nextPeriodStartsAt: null,
        periods: [],
      });

      for (const [token, code] of [
        [expired.token, 'SUBSCRIPTION_INACTIVE'],
        [restricted, 'SUBSCRIPTION_ACCESS_LIMITED'],
      ] as const) {
        const context = await request(app.getHttpServer())
          .get('/auth/context')
          .set('Authorization', `Bearer ${token}`);
        expect(context.status).toBe(200);
        expect(context.body.access.applicationAccess).toBe(false);
        const products = await request(app.getHttpServer())
          .get('/products')
          .set('Authorization', `Bearer ${token}`);
        expect(products.status).toBe(403);
        expect(products.body.code).toBe(code);
        const section = await request(app.getHttpServer())
          .post('/sections')
          .set('Authorization', `Bearer ${token}`)
          .send({ name: `Rayon ${Date.now()}` });
        expect(section.status).toBe(403);
        expect(section.body.code).toBe(code);
      }
      // Aucune période créée, aucun statut administratif modifié.
      expect(
        await periodModel.countDocuments({ organizationId: legacyOrg._id }),
      ).toBe(0);
      const legacy = await organizationModel.findById(legacyOrg._id).lean();
      expect(legacy!.status).toBe('active');
    });
  });

  // ─── 8. Scripts compilés (dist/) ───────────────────────────────────────────

  describe('8. Scripts compilés sur la base éphémère', () => {
    const run = (script: string, args: string[], withUri = true) => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.MONGODB_URI;
      if (withUri) env.MONGODB_URI = mongoUri;
      const result = spawnSync(process.execPath, [script, ...args], {
        env,
        encoding: 'utf8',
        timeout: 60_000,
      });
      const output = `${result.stdout}${result.stderr}`;
      // Jamais l'URI (ni host:port) dans la sortie.
      expect(output).not.toContain(mongoUri);
      expect(output).not.toContain(new URL(mongoUri).host);
      return { status: result.status, stdout: result.stdout, output };
    };

    beforeAll(() => {
      for (const script of [GRANT_SCRIPT, MIGRATION_SCRIPT]) {
        if (!existsSync(script)) {
          throw new Error(
            `Script compilé absent (${script}) : exécuter \`pnpm --filter api build\` avant les E2E.`,
          );
        }
      }
    });

    it('migration compilée : rejeu sans changement ; sans URI → code 1', () => {
      const ok = run(MIGRATION_SCRIPT, []);
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain('déjà présents');
      expect(run(MIGRATION_SCRIPT, [], false).status).toBe(1);
    });

    it('attribution compilée : succès, rejeu, organisation suspendue inchangée', async () => {
      const { orgId } = await registerOwner('cli');
      await organizationModel.updateOne(
        { _id: new Types.ObjectId(orgId) },
        { $set: { status: 'suspended' } },
      );
      const args = [
        '--',
        `--organization-id=${orgId}`,
        '--term=quarterly',
        `--reference=CLI-${orgId}`,
        '--operator=ops-cli',
      ];
      const first = run(GRANT_SCRIPT, args);
      expect(first.status).toBe(0);
      const granted = JSON.parse(first.stdout.trim()) as Record<string, string>;
      expect(granted).toMatchObject({
        result: 'granted',
        organizationId: orgId,
        term: 'quarterly',
      });
      expect(Object.keys(granted).sort()).toEqual(
        ['endsAt', 'organizationId', 'result', 'startsAt', 'term'].sort(),
      );

      const replay = run(GRANT_SCRIPT, args);
      expect(replay.status).toBe(0);
      const replayed = JSON.parse(replay.stdout.trim()) as Record<
        string,
        string
      >;
      expect(replayed).toEqual({ ...granted, result: 'already-granted' });

      const periods = await periodsOf(orgId);
      expect(periods).toHaveLength(2);
      expect(periods[1]).toMatchObject({
        kind: 'subscription',
        term: 'quarterly',
        source: 'manual',
        grantedBy: 'ops-cli',
      });
      const org = await organizationModel.findById(orgId).lean().exec();
      expect(org!.status).toBe('suspended');
    });

    it('arguments invalides, date fournie, organisation inconnue, sans URI → code 1, aucune écriture', async () => {
      const { orgId } = await registerOwner('cli-invalid');
      const before = await periodModel.countDocuments();
      const valid = [
        `--organization-id=${orgId}`,
        '--term=monthly',
        `--reference=CLI-invalid-${orgId}`,
        '--operator=ops-cli',
      ];
      const cases: Array<[string[], boolean]> = [
        [valid.slice(1), true],
        [[...valid, '--starts-at=2020-01-01T00:00:00.000Z'], true],
        [[...valid.slice(0, 1), '--term=weekly', ...valid.slice(2)], true],
        [
          [
            `--organization-id=${new Types.ObjectId().toString()}`,
            ...valid.slice(1),
          ],
          true,
        ],
        [valid, false],
      ];
      for (const [args, withUri] of cases) {
        expect(run(GRANT_SCRIPT, args, withUri).status).toBe(1);
      }
      expect(await periodModel.countDocuments()).toBe(before);
    });
  });
});
