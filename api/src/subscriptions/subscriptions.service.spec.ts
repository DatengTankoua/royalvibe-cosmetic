import type { Connection, Model } from 'mongoose';
import type { OrganizationDocument } from '../organizations/schemas/organization.schema';
import type { SubscriptionPeriodDocument } from './schemas/subscription-period.schema';
import {
  MAX_GRANT_ATTEMPTS,
  MongooseSession,
  SubscriptionGrantError,
  SubscriptionsService,
  isRetryableGrantCollision,
} from './subscriptions.service';
import { SubscriptionSource } from './subscription-terms';

/**
 * 1-14D.2A — Enveloppe transactionnelle des attributions, sans base :
 * session simulée (la base réelle est couverte par l'e2e
 * `subscription-payment-foundation`). Vérifie le ciblage des collisions,
 * la borne des reprises et la fermeture des sessions.
 */

const duplicate = (keyPattern: Record<string, 1>) =>
  Object.assign(new Error('E11000 duplicate key error'), {
    code: 11000,
    keyPattern,
  });

const REFERENCE_COLLISION = () => duplicate({ source: 1, sourceReference: 1 });
const SEQUENCE_COLLISION = () => duplicate({ organizationId: 1, sequence: 1 });
const TRIAL_COLLISION = () => duplicate({ organizationId: 1 });

interface FakeSession {
  withTransaction: jest.Mock;
  endSession: jest.Mock;
  inTransaction: () => boolean;
}

function harness() {
  const sessions: FakeSession[] = [];
  const connection = {
    startSession: jest.fn(() => {
      let active = false;
      const session: FakeSession = {
        inTransaction: () => active,
        endSession: jest.fn(() => Promise.resolve()),
        withTransaction: jest.fn(async (fn: () => Promise<unknown>) => {
          active = true;
          try {
            return await fn();
          } finally {
            active = false;
          }
        }),
      };
      sessions.push(session);
      return Promise.resolve(session);
    }),
  };
  const periodModel = { findOne: jest.fn(), create: jest.fn() };
  const organizationModel = { exists: jest.fn() };
  const service = new SubscriptionsService(
    periodModel as unknown as Model<SubscriptionPeriodDocument>,
    organizationModel as unknown as Model<OrganizationDocument>,
    connection as unknown as Connection,
    () => new Date('2026-03-01T09:00:00.000Z'),
  );
  return { service, sessions, connection, periodModel, organizationModel };
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

describe('isRetryableGrantCollision (1-14D.2A)', () => {
  it('collisions attendues : idempotence et séquence uniquement', () => {
    expect(isRetryableGrantCollision(REFERENCE_COLLISION())).toBe(true);
    expect(isRetryableGrantCollision(SEQUENCE_COLLISION())).toBe(true);
  });

  it('jamais : essai unique, autre index, autre code, erreur quelconque', () => {
    expect(isRetryableGrantCollision(TRIAL_COLLISION())).toBe(false);
    expect(isRetryableGrantCollision(duplicate({ merchantReference: 1 }))).toBe(
      false,
    );
    expect(
      isRetryableGrantCollision(
        Object.assign(new Error('x'), {
          code: 112,
          keyPattern: { source: 1, sourceReference: 1 },
        }),
      ),
    ).toBe(false);
    expect(isRetryableGrantCollision(new Error('boom'))).toBe(false);
    expect(isRetryableGrantCollision(null)).toBe(false);
  });
});

describe('SubscriptionsService.runInGrantTransaction (1-14D.2A)', () => {
  it('succès : une session, une transaction, résultat renvoyé, session fermée', async () => {
    const { service, sessions } = harness();
    const work = jest.fn((session: MongooseSession) => {
      expect(session.inTransaction()).toBe(true);
      return Promise.resolve('ok');
    });
    await expect(service.runInGrantTransaction(work)).resolves.toBe('ok');
    expect(work).toHaveBeenCalledTimes(1);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].endSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['idempotence', REFERENCE_COLLISION],
    ['séquence', SEQUENCE_COLLISION],
  ])(
    'collision %s : transaction COMPLÈTE rejouée dans une nouvelle session',
    async (_label, collision) => {
      const { service, sessions } = harness();
      const work = jest
        .fn<Promise<string>, [MongooseSession]>()
        .mockRejectedValueOnce(collision())
        .mockResolvedValueOnce('second');
      await expect(service.runInGrantTransaction(work)).resolves.toBe('second');
      expect(work).toHaveBeenCalledTimes(2);
      // Jamais la même session (donc jamais la transaction avortée).
      expect(sessions).toHaveLength(2);
      expect(work.mock.calls[0][0]).not.toBe(work.mock.calls[1][0]);
      for (const s of sessions) expect(s.endSession).toHaveBeenCalledTimes(1);
    },
  );

  it(`collisions persistantes : ${MAX_GRANT_ATTEMPTS} tentatives puis GRANT_CONTENTION`, async () => {
    const { service, sessions } = harness();
    const work = jest.fn(() => Promise.reject(SEQUENCE_COLLISION()));
    const error = await errorOf(service.runInGrantTransaction(work));
    expect(error).toBeInstanceOf(SubscriptionGrantError);
    expect((error as SubscriptionGrantError).code).toBe('GRANT_CONTENTION');
    expect(work).toHaveBeenCalledTimes(MAX_GRANT_ATTEMPTS);
    expect(sessions).toHaveLength(MAX_GRANT_ATTEMPTS);
    for (const s of sessions) expect(s.endSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['essai unique', TRIAL_COLLISION],
    ['index d’un appelant', () => duplicate({ merchantReference: 1 })],
    ['erreur quelconque', () => new Error('boom')],
    [
      'conflit de référence métier',
      () =>
        new SubscriptionGrantError(
          'SUBSCRIPTION_REFERENCE_CONFLICT',
          'Référence déjà utilisée pour une autre attribution.',
        ),
    ],
  ])('%s : relancée telle quelle, sans reprise', async (_label, makeError) => {
    const { service, sessions } = harness();
    const thrown = makeError();
    const work = jest.fn(() => Promise.reject(thrown));
    await expect(service.runInGrantTransaction(work)).rejects.toBe(thrown);
    expect(work).toHaveBeenCalledTimes(1);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].endSession).toHaveBeenCalledTimes(1);
  });
});

describe('SubscriptionsService.grantSubscriptionInSession — garde (1-14D.2A)', () => {
  const input = {
    organizationId: '64b7f0a1c2d3e4f5a6b7c8d9',
    term: 'monthly',
    source: SubscriptionSource.PAYMENT,
    sourceReference: 'payment:64b7f0a1c2d3e4f5a6b7c8da',
    grantedBy: 'payment:test',
  } as const;

  it('sans session ou session hors transaction → TRANSACTION_REQUIRED, aucune lecture', async () => {
    const { service, periodModel, connection } = harness();
    for (const session of [
      undefined,
      null,
      {},
      { inTransaction: () => false },
    ]) {
      const error = await errorOf(
        service.grantSubscriptionInSession(
          input,
          session as unknown as MongooseSession,
        ),
      );
      expect((error as SubscriptionGrantError).code).toBe(
        'TRANSACTION_REQUIRED',
      );
    }
    expect(periodModel.findOne).not.toHaveBeenCalled();
    expect(periodModel.create).not.toHaveBeenCalled();
    // N'ouvre jamais de transaction propre.
    expect(connection.startSession).not.toHaveBeenCalled();
  });

  it.each([SubscriptionSource.TRIAL, 'other', undefined])(
    'source %p → INVALID_INPUT, aucune lecture',
    async (source) => {
      const { service, periodModel } = harness();
      const error = await errorOf(
        service.grantSubscriptionInSession(
          { ...input, source } as unknown as typeof input,
          { inTransaction: () => true } as unknown as MongooseSession,
        ),
      );
      expect((error as SubscriptionGrantError).code).toBe('INVALID_INPUT');
      expect(periodModel.findOne).not.toHaveBeenCalled();
    },
  );
});

describe('SubscriptionsService.grantSubscription — source figée (1-14D.2A)', () => {
  it('une `source` glissée dans l’entrée est ignorée : toujours `manual`', async () => {
    const { service, periodModel } = harness();
    const chain = {
      session: () => chain,
      exec: () => Promise.reject(new Error('stop-after-read')),
    };
    periodModel.findOne.mockReturnValue(chain);
    await expect(
      service.grantSubscription({
        organizationId: '64b7f0a1c2d3e4f5a6b7c8d9',
        term: 'monthly',
        sourceReference: 'REC-1',
        grantedBy: 'ops',
        source: 'payment',
      } as unknown as Parameters<typeof service.grantSubscription>[0]),
    ).rejects.toThrow('stop-after-read');
    expect(periodModel.findOne).toHaveBeenCalledWith({
      source: 'manual',
      sourceReference: 'REC-1',
    });
  });

  it('entrée invalide → refus avant toute session', async () => {
    const { service, connection } = harness();
    const error = await errorOf(
      service.grantSubscription({
        organizationId: 'nope',
        term: 'monthly',
        sourceReference: 'REC-1',
        grantedBy: 'ops',
      }),
    );
    expect((error as SubscriptionGrantError).code).toBe('INVALID_INPUT');
    expect(connection.startSession).not.toHaveBeenCalled();
  });
});
