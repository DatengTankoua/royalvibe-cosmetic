import 'reflect-metadata';
import { Connection, Model, Types } from 'mongoose';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { AppModule } from './../src/app.module';
import { Organization } from './../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from './../src/organizations/schemas/organization.schema';
import {
  SubscriptionPeriod,
  SubscriptionPeriodDocument,
} from './../src/subscriptions/schemas/subscription-period.schema';
import { ensureSubscriptionPeriodIndexes } from './../src/subscriptions/subscription-period-indexes';
import {
  GrantedPeriodView,
  SubscriptionGrantError,
  SubscriptionsService,
} from './../src/subscriptions/subscriptions.service';
import { SubscriptionSource } from './../src/subscriptions/subscription-terms';
import { SUBSCRIPTION_CLOCK } from './../src/subscriptions/subscription-clock';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import { createE2eEmailSender } from './e2e/email-verification-fixtures';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';

/**
 * E2E 1-14D.2A — attribution `payment` dans la transaction d'un appelant,
 * sur le replica set éphémère (garde anti-27017). Aucun prestataire, aucun
 * réseau, aucune route HTTP.
 *
 * L'« appelant » est simulé par une écriture TÉMOIN dans une collection de
 * fixture (`e2e_payment_witnesses`) : elle représente le futur marquage d'un
 * paiement. Ce n'est PAS le modèle de production `subscription_payments`.
 */

const TEST_JWT_SECRET = 'payment-foundation-14d2a-e2e-only-secret';
const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-03-01T09:00:00.000Z');
const TRIAL_END = new Date(T0.getTime() + 7 * DAY_MS);
const WITNESSES = 'e2e_payment_witnesses';

let clockNow: Date | null = null;
const testClock = () => (clockNow ? new Date(clockNow) : new Date());

interface Witness {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  term: string;
  status: 'pending' | 'succeeded';
  periodId?: string;
}

describe('Socle serveur des paiements (e2e 1-14D.2A)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication;
  let connection: Connection;
  let organizationModel: Model<OrganizationDocument>;
  let periodModel: Model<SubscriptionPeriodDocument>;
  let subscriptions: SubscriptionsService;
  let sequence = 0;

  const witnesses = () => connection.collection<Witness>(WITNESSES);

  /** Organisation + essai de 7 jours (même chemin que l'inscription). */
  async function createOrganization(): Promise<string> {
    sequence += 1;
    const session = await connection.startSession();
    try {
      let id = '';
      await session.withTransaction(async () => {
        const [org] = await organizationModel.create(
          [{ name: `Pay ${sequence}`, slug: `pay-14d2a-${sequence}` }],
          { session },
        );
        await subscriptions.grantTrial(org._id, session);
        id = String(org._id);
      });
      return id;
    } finally {
      await session.endSession();
    }
  }

  const periodsOf = (orgId: string) =>
    periodModel
      .find({ organizationId: new Types.ObjectId(orgId) })
      .sort({ sequence: 1 })
      .lean()
      .exec();

  /** Futur « paiement en attente », écrit HORS transaction. */
  async function pendingWitness(orgId: string, term: string) {
    const _id = new Types.ObjectId();
    await witnesses().insertOne({
      _id,
      organizationId: new Types.ObjectId(orgId),
      term,
      status: 'pending',
    });
    return _id;
  }

  /**
   * Finalisation simulée : marquage du témoin ET attribution, dans UNE
   * transaction (`runInGrantTransaction`). Un témoin déjà `succeeded` →
   * aucune attribution (rejeu côté appelant).
   */
  function finalize(
    witnessId: Types.ObjectId,
    options: {
      afterGrant?: () => Promise<void> | void;
      reference?: string;
      calls?: { count: number };
    } = {},
  ): Promise<GrantedPeriodView | 'already-succeeded'> {
    return subscriptions.runInGrantTransaction(async (session) => {
      if (options.calls) options.calls.count += 1;
      const witness = await witnesses().findOne(
        { _id: witnessId },
        { session },
      );
      if (!witness) throw new Error('witness missing');
      if (witness.status === 'succeeded') return 'already-succeeded' as const;
      const granted = await subscriptions.grantSubscriptionInSession(
        {
          organizationId: String(witness.organizationId),
          term: witness.term,
          source: SubscriptionSource.PAYMENT,
          sourceReference: options.reference ?? `payment:${String(witnessId)}`,
          grantedBy: 'payment:e2e',
        },
        session,
      );
      await witnesses().updateOne(
        { _id: witnessId, status: 'pending' },
        { $set: { status: 'succeeded', periodId: granted.periodId } },
        { session },
      );
      await options.afterGrant?.();
      return granted;
    });
  }

  const grantPaymentAlone = (
    orgId: string,
    term: string,
    reference: string,
  ): Promise<GrantedPeriodView> =>
    subscriptions.runInGrantTransaction((session) =>
      subscriptions.grantSubscriptionInSession(
        {
          organizationId: orgId,
          term,
          source: SubscriptionSource.PAYMENT,
          sourceReference: reference,
          grantedBy: 'payment:e2e',
        },
        session,
      ),
    );

  const grantManual = (orgId: string, term: string, reference: string) =>
    subscriptions.grantSubscription({
      organizationId: orgId,
      term,
      sourceReference: reference,
      grantedBy: 'ops-e2e',
    });

  async function grantErrorCode(promise: Promise<unknown>): Promise<string> {
    const error: unknown = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SubscriptionGrantError);
    return (error as SubscriptionGrantError).code;
  }

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      process.env.MONGODB_URI = validatedEphemeralUri(replSet);
      process.env.JWT_SECRET = TEST_JWT_SECRET;
      process.env.CORS_ORIGIN = 'https://payment-foundation-e2e.example.com';

      moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EMAIL_SENDER)
        .useValue(createE2eEmailSender())
        .overrideProvider(SUBSCRIPTION_CLOCK)
        .useValue(testClock)
        .compile();
      app = moduleFixture.createNestApplication();
      await app.init();

      connection = moduleFixture.get(getConnectionToken());
      organizationModel = moduleFixture.get(getModelToken(Organization.name));
      periodModel = moduleFixture.get(getModelToken(SubscriptionPeriod.name));
      subscriptions = moduleFixture.get(SubscriptionsService);
      await ensureSubscriptionPeriodIndexes(connection);
      // Fixture : la collection témoin existe AVANT les transactions.
      await connection.createCollection(WITNESSES);
    } catch (error) {
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  beforeEach(() => {
    clockNow = T0;
  });

  afterEach(() => {
    clockNow = null;
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  // ─── 1. Non-régression manuel / essai ──────────────────────────────────────

  describe('1. Non-régression : essai et attribution manuelle', () => {
    it('essai unique 7 × 24 h, puis manuel cumulé, source `manual` conservée', async () => {
      const orgId = await createOrganization();
      const manual = await grantManual(orgId, 'monthly', `REC-nr-${orgId}`);
      expect(manual.replayed).toBe(false);
      expect(manual.startsAt.toISOString()).toBe(TRIAL_END.toISOString());
      expect(manual.endsAt.toISOString()).toBe('2026-04-08T09:00:00.000Z');
      const periods = await periodsOf(orgId);
      expect(periods.map((p) => [p.sequence, p.kind, p.source])).toEqual([
        [1, 'trial', 'trial'],
        [2, 'subscription', 'manual'],
      ]);
      expect(periods[0].endsAt.getTime() - periods[0].startsAt.getTime()).toBe(
        7 * DAY_MS,
      );
      const again = await grantManual(orgId, 'monthly', `REC-nr-${orgId}`);
      expect(again).toMatchObject({
        replayed: true,
        periodId: manual.periodId,
      });
      expect(await periodsOf(orgId)).toHaveLength(2);
    });

    it('second essai toujours impossible', async () => {
      const orgId = await createOrganization();
      const code = await grantErrorCode(
        subscriptions.runInGrantTransaction((session) =>
          subscriptions.grantTrial(new Types.ObjectId(orgId), session),
        ),
      );
      expect(code).toBe('TRIAL_ALREADY_GRANTED');
      expect(await periodsOf(orgId)).toHaveLength(1);
    });
  });

  // ─── 2. Attribution `payment` dans une transaction externe ─────────────────

  describe('2. Attribution `payment` dans la transaction de l’appelant', () => {
    it('période `payment` + témoin `succeeded` dans la même transaction', async () => {
      const orgId = await createOrganization();
      const witnessId = await pendingWitness(orgId, 'quarterly');
      const granted = await finalize(witnessId);
      if (granted === 'already-succeeded') throw new Error('unexpected');
      expect(granted.replayed).toBe(false);
      // début = max(heure serveur, fin de couverture) = fin d'essai.
      expect(granted.startsAt.toISOString()).toBe(TRIAL_END.toISOString());
      expect(granted.endsAt.toISOString()).toBe('2026-06-08T09:00:00.000Z');

      const periods = await periodsOf(orgId);
      expect(periods).toHaveLength(2);
      expect(periods[1]).toMatchObject({
        sequence: 2,
        kind: 'subscription',
        term: 'quarterly',
        source: 'payment',
        sourceReference: `payment:${String(witnessId)}`,
        grantedBy: 'payment:e2e',
      });
      expect(String(periods[1].previousPeriodId)).toBe(String(periods[0]._id));
      expect(await witnesses().findOne({ _id: witnessId })).toMatchObject({
        status: 'succeeded',
        periodId: granted.periodId,
      });
    });

    it('après expiration : début = heure serveur ; mois calendaires UTC (31 → fin de mois)', async () => {
      clockNow = new Date('2026-01-31T10:00:00.000Z');
      const orgId = await createOrganization();
      clockNow = new Date('2026-03-31T10:00:00.000Z');
      const witnessId = await pendingWitness(orgId, 'monthly');
      const granted = await finalize(witnessId);
      if (granted === 'already-succeeded') throw new Error('unexpected');
      expect(granted.startsAt.toISOString()).toBe('2026-03-31T10:00:00.000Z');
      expect(granted.endsAt.toISOString()).toBe('2026-04-30T10:00:00.000Z');
    });
  });

  // ─── 3. Rollback commun ────────────────────────────────────────────────────

  describe('3. Rollback commun témoin + période', () => {
    it('échec APRÈS attribution et marquage → ni période ni marquage', async () => {
      const orgId = await createOrganization();
      const witnessId = await pendingWitness(orgId, 'annual');
      const calls = { count: 0 };
      await expect(
        finalize(witnessId, {
          calls,
          afterGrant: () => {
            throw new Error('payment-step-failed');
          },
        }),
      ).rejects.toThrow('payment-step-failed');
      // Erreur non ciblée : aucune reprise.
      expect(calls.count).toBe(1);
      expect(await periodsOf(orgId)).toHaveLength(1);
      expect(
        await periodModel.countDocuments({
          source: 'payment',
          sourceReference: `payment:${String(witnessId)}`,
        }),
      ).toBe(0);
      expect(await witnesses().findOne({ _id: witnessId })).toMatchObject({
        status: 'pending',
      });
      expect(
        (await witnesses().findOne({ _id: witnessId }))?.periodId,
      ).toBeUndefined();

      // La même finalisation réussit ensuite, une seule fois.
      const granted = await finalize(witnessId);
      expect(granted).not.toBe('already-succeeded');
      expect(await finalize(witnessId)).toBe('already-succeeded');
      expect(await periodsOf(orgId)).toHaveLength(2);
    });

    it('écriture de l’appelant AVANT un refus de l’attribution → annulée', async () => {
      const orgId = await createOrganization();
      const code = await grantErrorCode(
        subscriptions.runInGrantTransaction(async (session) => {
          await witnesses().insertOne(
            {
              _id: new Types.ObjectId(),
              organizationId: new Types.ObjectId(orgId),
              term: 'monthly',
              status: 'succeeded',
            },
            { session },
          );
          return subscriptions.grantSubscriptionInSession(
            {
              organizationId: String(new Types.ObjectId()),
              term: 'monthly',
              source: SubscriptionSource.PAYMENT,
              sourceReference: `payment:missing-org-${orgId}`,
              grantedBy: 'payment:e2e',
            },
            session,
          );
        }),
      );
      expect(code).toBe('ORGANIZATION_NOT_FOUND');
      expect(
        await witnesses().countDocuments({
          organizationId: new Types.ObjectId(orgId),
        }),
      ).toBe(0);
    });

    it('sans transaction de l’appelant → TRANSACTION_REQUIRED, aucune écriture', async () => {
      const orgId = await createOrganization();
      const session = await connection.startSession();
      try {
        const code = await grantErrorCode(
          subscriptions.grantSubscriptionInSession(
            {
              organizationId: orgId,
              term: 'monthly',
              source: SubscriptionSource.PAYMENT,
              sourceReference: `payment:no-tx-${orgId}`,
              grantedBy: 'payment:e2e',
            },
            session,
          ),
        );
        expect(code).toBe('TRANSACTION_REQUIRED');
      } finally {
        await session.endSession();
      }
      expect(await periodsOf(orgId)).toHaveLength(1);
    });
  });

  // ─── 4. Rejeu, conflit, indépendance des sources ───────────────────────────

  describe('4. Rejeu, réutilisation incohérente, indépendance des sources', () => {
    it('rejeu identique (heure différente) → même période, aucune durée ajoutée', async () => {
      const orgId = await createOrganization();
      const reference = `payment:replay-${orgId}`;
      const first = await grantPaymentAlone(orgId, 'monthly', reference);
      clockNow = new Date(T0.getTime() + 60 * DAY_MS);
      const again = await grantPaymentAlone(orgId, 'monthly', reference);
      expect(again).toMatchObject({
        replayed: true,
        periodId: first.periodId,
        sequence: first.sequence,
      });
      expect(again.startsAt.toISOString()).toBe(first.startsAt.toISOString());
      expect(again.endsAt.toISOString()).toBe(first.endsAt.toISOString());
      expect(await periodsOf(orgId)).toHaveLength(2);
    });

    it('même référence `payment`, autre organisation ou autre durée → conflit, aucune écriture (témoin compris)', async () => {
      const a = await createOrganization();
      const b = await createOrganization();
      const reference = `payment:conflict-${a}`;
      await grantPaymentAlone(a, 'monthly', reference);
      const before = await periodModel.countDocuments();

      for (const [orgId, term] of [
        [b, 'monthly'],
        [a, 'annual'],
      ]) {
        const witnessId = await pendingWitness(orgId, term);
        const code = await grantErrorCode(finalize(witnessId, { reference }));
        expect(code).toBe('SUBSCRIPTION_REFERENCE_CONFLICT');
        expect(await witnesses().findOne({ _id: witnessId })).toMatchObject({
          status: 'pending',
        });
      }
      expect(await periodModel.countDocuments()).toBe(before);
      expect(await periodsOf(b)).toHaveLength(1);
    });

    it('même référence sous `manual` et `payment` → deux attributions distinctes, chacune idempotente', async () => {
      const orgId = await createOrganization();
      const reference = `SHARED-${orgId}`;
      const manual = await grantManual(orgId, 'monthly', reference);
      const payment = await grantPaymentAlone(orgId, 'monthly', reference);
      expect(payment.replayed).toBe(false);
      expect(payment.periodId).not.toBe(manual.periodId);
      expect(payment.startsAt.toISOString()).toBe(manual.endsAt.toISOString());

      // Rejeux : chaque source retrouve SA période.
      expect(await grantManual(orgId, 'monthly', reference)).toMatchObject({
        replayed: true,
        periodId: manual.periodId,
      });
      expect(
        await grantPaymentAlone(orgId, 'monthly', reference),
      ).toMatchObject({ replayed: true, periodId: payment.periodId });
      // Une durée différente sous l'autre source reste un conflit propre
      // à cette source.
      expect(
        await grantErrorCode(grantPaymentAlone(orgId, 'annual', reference)),
      ).toBe('SUBSCRIPTION_REFERENCE_CONFLICT');

      const periods = await periodsOf(orgId);
      expect(periods.map((p) => p.source)).toEqual([
        'trial',
        'manual',
        'payment',
      ]);
    });
  });

  // ─── 5. Concurrence ────────────────────────────────────────────────────────

  describe('5. Attributions concurrentes', () => {
    it('4 paiements + 1 manuel simultanés → chaîne linéaire, jointive, aucune durée perdue, témoins exacts', async () => {
      const orgId = await createOrganization();
      const witnessIds = await Promise.all(
        [1, 2, 3, 4].map(() => pendingWitness(orgId, 'monthly')),
      );
      const calls = { count: 0 };
      const results = await Promise.all([
        ...witnessIds.map((id) => finalize(id, { calls })),
        grantManual(orgId, 'monthly', `REC-parallel-${orgId}`),
      ]);
      console.log(
        `[1-14D.2A] 4 finalisations simultanées : ${calls.count} exécutions du callback.`,
      );
      expect(calls.count).toBeGreaterThanOrEqual(4);
      expect(
        results.every((r) => r !== 'already-succeeded' && !r.replayed),
      ).toBe(true);

      const periods = await periodsOf(orgId);
      expect(periods.map((p) => p.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
      for (let i = 1; i < periods.length; i++) {
        expect(String(periods[i].previousPeriodId)).toBe(
          String(periods[i - 1]._id),
        );
        expect(periods[i].startsAt.toISOString()).toBe(
          periods[i - 1].endsAt.toISOString(),
        );
      }
      // Essai (→ 8 mars) + 5 mois calendaires.
      expect(periods[5].endsAt.toISOString()).toBe('2026-08-08T09:00:00.000Z');
      expect(
        periods.filter((p) => p.source === SubscriptionSource.PAYMENT),
      ).toHaveLength(4);

      // Chaque témoin pointe vers SA période, exactement une fois.
      const marked = await witnesses()
        .find({ _id: { $in: witnessIds } })
        .toArray();
      expect(marked.every((w) => w.status === 'succeeded')).toBe(true);
      const periodIds = new Set(periods.map((p) => String(p._id)));
      expect(new Set(marked.map((w) => w.periodId)).size).toBe(4);
      for (const w of marked) expect(periodIds.has(w.periodId!)).toBe(true);
    });

    it('finalisations concurrentes d’un MÊME paiement → une seule période, un seul marquage', async () => {
      const orgId = await createOrganization();
      const witnessId = await pendingWitness(orgId, 'semiannual');
      const results = await Promise.all(
        Array.from({ length: 6 }, () => finalize(witnessId)),
      );
      const granted = results.filter(
        (r): r is GrantedPeriodView => r !== 'already-succeeded',
      );
      expect(new Set(granted.map((r) => r.periodId)).size).toBe(1);
      expect(granted.filter((r) => !r.replayed)).toHaveLength(1);
      expect(
        await periodModel.countDocuments({
          source: 'payment',
          sourceReference: `payment:${String(witnessId)}`,
        }),
      ).toBe(1);
      expect(await periodsOf(orgId)).toHaveLength(2);
    });

    it('rejeux concurrents d’une même référence (sans témoin) → une seule période', async () => {
      const orgId = await createOrganization();
      const reference = `payment:concurrent-${orgId}`;
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          grantPaymentAlone(orgId, 'quarterly', reference),
        ),
      );
      expect(new Set(results.map((r) => r.periodId)).size).toBe(1);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(await periodsOf(orgId)).toHaveLength(2);
    });
  });

  // ─── 6. Ciblage des collisions (base réelle) ───────────────────────────────

  describe('6. Ciblage des collisions', () => {
    it('collision de l’index d’essai dans la transaction → relancée, aucune reprise, rien d’écrit', async () => {
      const orgId = await createOrganization();
      let calls = 0;
      const error: unknown = await subscriptions
        .runInGrantTransaction(async (session) => {
          calls += 1;
          await periodModel.collection.insertOne(
            {
              organizationId: new Types.ObjectId(orgId),
              sequence: 2,
              kind: 'trial',
              term: null,
              startsAt: T0,
              endsAt: TRIAL_END,
              source: 'trial',
              sourceReference: `trial-bis:${orgId}`,
              grantedBy: 'system',
              previousPeriodId: null,
            },
            { session },
          );
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toMatchObject({
        code: 11000,
        keyPattern: { organizationId: 1 },
      });
      expect(calls).toBe(1);
      expect(await periodsOf(orgId)).toHaveLength(1);
    });

    it('collision d’un index de l’appelant → relancée sans reprise ; l’attribution est annulée', async () => {
      const orgId = await createOrganization();
      const existing = await pendingWitness(orgId, 'monthly');
      let calls = 0;
      const error: unknown = await subscriptions
        .runInGrantTransaction(async (session) => {
          calls += 1;
          await subscriptions.grantSubscriptionInSession(
            {
              organizationId: orgId,
              term: 'monthly',
              source: SubscriptionSource.PAYMENT,
              sourceReference: `payment:caller-dup-${orgId}`,
              grantedBy: 'payment:e2e',
            },
            session,
          );
          // `_id` déjà présent : E11000 sur l'index de l'appelant.
          await witnesses().insertOne(
            {
              _id: existing,
              organizationId: new Types.ObjectId(orgId),
              term: 'monthly',
              status: 'succeeded',
            },
            { session },
          );
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toMatchObject({ code: 11000, keyPattern: { _id: 1 } });
      expect(calls).toBe(1);
      expect(await periodsOf(orgId)).toHaveLength(1);
    });
  });
});
