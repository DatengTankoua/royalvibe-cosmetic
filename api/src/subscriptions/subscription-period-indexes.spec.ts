import {
  SUBSCRIPTION_PERIOD_INDEXES,
  describeSubscriptionPeriodIndexProblem,
  shouldVerifySubscriptionPeriodIndexes,
  subscriptionDuplicateKeyIndex,
} from './subscription-period-indexes';

const valid = () => [
  { name: '_id_', key: { _id: 1 } },
  {
    name: 'source_1_sourceReference_1',
    key: { source: 1, sourceReference: 1 },
    unique: true,
  },
  {
    name: 'organizationId_1_sequence_1',
    key: { organizationId: 1, sequence: 1 },
    unique: true,
  },
  {
    name: 'organizationId_1_single_trial',
    key: { organizationId: 1 },
    unique: true,
    partialFilterExpression: { kind: 'trial' },
  },
];

describe('subscription-period-indexes (1-14B)', () => {
  it('exactement 3 index requis, tous uniques', () => {
    expect(SUBSCRIPTION_PERIOD_INDEXES.map((i) => i.name)).toEqual([
      'source_1_sourceReference_1',
      'organizationId_1_sequence_1',
      'organizationId_1_single_trial',
    ]);
  });

  it('configuration exacte → aucun problème', () => {
    expect(describeSubscriptionPeriodIndexProblem(valid())).toBeNull();
  });

  it.each([
    [
      'absent',
      (ix: ReturnType<typeof valid>) =>
        ix.filter((i) => i.name !== 'organizationId_1_sequence_1'),
      'organizationId_1_sequence_1 : index absent',
    ],
    [
      'non unique',
      (ix: ReturnType<typeof valid>) =>
        ix.map((i) =>
          i.name === 'source_1_sourceReference_1' ? { ...i, unique: false } : i,
        ),
      'source_1_sourceReference_1 : index non unique',
    ],
    [
      'clé dans un autre ordre',
      (ix: ReturnType<typeof valid>) =>
        ix.map((i) =>
          i.name === 'organizationId_1_sequence_1'
            ? { ...i, key: { sequence: 1, organizationId: 1 } }
            : i,
        ),
      'organizationId_1_sequence_1 : index absent',
    ],
    [
      'essai sans filtre partiel',
      (ix: ReturnType<typeof valid>) =>
        ix.map((i) =>
          i.name === 'organizationId_1_single_trial'
            ? { name: i.name, key: i.key, unique: true }
            : i,
        ),
      'organizationId_1_single_trial : filtre partiel inattendu',
    ],
    [
      'filtre partiel différent',
      (ix: ReturnType<typeof valid>) =>
        ix.map((i) =>
          i.name === 'organizationId_1_single_trial'
            ? { ...i, partialFilterExpression: { kind: 'subscription' } }
            : i,
        ),
      'organizationId_1_single_trial : filtre partiel inattendu',
    ],
    [
      'sparse',
      (ix: ReturnType<typeof valid>) =>
        ix.map((i) =>
          i.name === 'source_1_sourceReference_1' ? { ...i, sparse: true } : i,
        ),
      'source_1_sourceReference_1 : index sparse',
    ],
    [
      'TTL',
      (ix: ReturnType<typeof valid>) =>
        ix.map((i) =>
          i.name === 'organizationId_1_sequence_1'
            ? { ...i, expireAfterSeconds: 60 }
            : i,
        ),
      'organizationId_1_sequence_1 : TTL interdit',
    ],
    [
      'collation',
      (ix: ReturnType<typeof valid>) =>
        ix.map((i) =>
          i.name === 'source_1_sourceReference_1'
            ? { ...i, collation: { locale: 'fr' } }
            : i,
        ),
      'source_1_sourceReference_1 : collation inattendue',
    ],
  ])('%s → refusé', (_label, mutate, expected) => {
    expect(describeSubscriptionPeriodIndexProblem(mutate(valid()))).toBe(
      expected,
    );
  });

  it('vérification fail-fast en production uniquement', () => {
    expect(
      shouldVerifySubscriptionPeriodIndexes({ NODE_ENV: 'production' }),
    ).toBe(true);
    expect(shouldVerifySubscriptionPeriodIndexes({ NODE_ENV: 'test' })).toBe(
      false,
    );
    expect(shouldVerifySubscriptionPeriodIndexes({})).toBe(false);
  });

  describe('subscriptionDuplicateKeyIndex', () => {
    const e11000 = (keyPattern: unknown) => ({ code: 11000, keyPattern });

    it('reconnaît uniquement les clés exactes des index requis', () => {
      expect(
        subscriptionDuplicateKeyIndex(
          e11000({ source: 1, sourceReference: 1 }),
        ),
      ).toBe('source_1_sourceReference_1');
      expect(
        subscriptionDuplicateKeyIndex(
          e11000({ organizationId: 1, sequence: 1 }),
        ),
      ).toBe('organizationId_1_sequence_1');
      expect(subscriptionDuplicateKeyIndex(e11000({ organizationId: 1 }))).toBe(
        'organizationId_1_single_trial',
      );
    });

    it('tout autre E11000 ou erreur → null', () => {
      expect(subscriptionDuplicateKeyIndex(e11000({ _id: 1 }))).toBeNull();
      expect(
        subscriptionDuplicateKeyIndex(
          e11000({ sequence: 1, organizationId: 1 }),
        ),
      ).toBeNull();
      expect(subscriptionDuplicateKeyIndex(e11000(undefined))).toBeNull();
      expect(
        subscriptionDuplicateKeyIndex({
          code: 112,
          keyPattern: { source: 1, sourceReference: 1 },
        }),
      ).toBeNull();
      expect(subscriptionDuplicateKeyIndex(null)).toBeNull();
      expect(subscriptionDuplicateKeyIndex(new Error('x'))).toBeNull();
    });
  });
});
