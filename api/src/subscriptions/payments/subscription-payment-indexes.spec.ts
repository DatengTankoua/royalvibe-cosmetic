import {
  SUBSCRIPTION_PAYMENT_INDEXES,
  describeSubscriptionPaymentIndexProblem,
  shouldVerifySubscriptionPaymentIndexes,
  subscriptionPaymentDuplicateKeyIndex,
} from './subscription-payment-indexes';
import { SubscriptionPaymentSchema } from './schemas/subscription-payment.schema';

/** Description EXACTE telle que renvoyée par `listIndexes()`. */
const exact = () => [
  { name: '_id_', key: { _id: 1 } },
  ...SUBSCRIPTION_PAYMENT_INDEXES.map((i) => ({
    name: i.name,
    key: { ...i.key },
    ...(i.unique ? { unique: true } : {}),
    ...(i.partialFilterExpression
      ? {
          partialFilterExpression: JSON.parse(
            JSON.stringify(i.partialFilterExpression),
          ) as Record<string, unknown>,
        }
      : {}),
  })),
];

describe('Index subscription_payments (1-14D.2B)', () => {
  it('5 index attendus, dont 4 uniques et 2 partiels ; aucun TTL', () => {
    expect(SUBSCRIPTION_PAYMENT_INDEXES.map((i) => i.name)).toEqual([
      'organizationId_1_clientOperationId_1',
      'merchantReference_1',
      'provider_1_providerReference_1',
      'organizationId_1_single_open_payment',
      'organizationId_1__id_-1',
    ]);
    expect(SUBSCRIPTION_PAYMENT_INDEXES.filter((i) => i.unique)).toHaveLength(
      4,
    );
    expect(describeSubscriptionPaymentIndexProblem(exact())).toBeNull();
  });

  it('autoIndex désactivé : jamais de création au démarrage', () => {
    expect(SubscriptionPaymentSchema.get('autoIndex')).toBe(false);
  });

  it('clés numériques renvoyées en Double/Int32 : tolérées', () => {
    const indexes = exact().map((i) =>
      i.name === 'organizationId_1__id_-1'
        ? { ...i, key: { organizationId: 1.0, _id: -1.0 } }
        : i,
    );
    expect(describeSubscriptionPaymentIndexProblem(indexes)).toBeNull();
  });

  it.each([
    [
      'absent',
      (l: ReturnType<typeof exact>) =>
        l.filter((i) => i.name !== 'merchantReference_1'),
      'merchantReference_1 : index absent',
    ],
    [
      'non unique',
      (l: ReturnType<typeof exact>) =>
        l.map((i) =>
          i.name === 'organizationId_1_clientOperationId_1'
            ? { name: i.name, key: i.key }
            : i,
        ),
      'organizationId_1_clientOperationId_1 : unicité inattendue',
    ],
    [
      'historique devenu unique',
      (l: ReturnType<typeof exact>) =>
        l.map((i) =>
          i.name === 'organizationId_1__id_-1' ? { ...i, unique: true } : i,
        ),
      'organizationId_1__id_-1 : unicité inattendue',
    ],
    [
      'filtre partiel différent',
      (l: ReturnType<typeof exact>) =>
        l.map((i) =>
          i.name === 'organizationId_1_single_open_payment'
            ? { ...i, partialFilterExpression: { open: false } }
            : i,
        ),
      'organizationId_1_single_open_payment : filtre partiel inattendu',
    ],
    [
      'filtre partiel absent',
      (l: ReturnType<typeof exact>) =>
        l.map((i) =>
          i.name === 'provider_1_providerReference_1'
            ? { name: i.name, key: i.key, unique: true }
            : i,
        ),
      'provider_1_providerReference_1 : filtre partiel inattendu',
    ],
    [
      'ordre de clé inversé',
      (l: ReturnType<typeof exact>) =>
        l.map((i) =>
          i.name === 'organizationId_1_clientOperationId_1'
            ? { ...i, key: { clientOperationId: 1, organizationId: 1 } }
            : i,
        ),
      'organizationId_1_clientOperationId_1 : index absent',
    ],
    [
      'TTL',
      (l: ReturnType<typeof exact>) =>
        l.map((i) =>
          i.name === 'merchantReference_1'
            ? { ...i, expireAfterSeconds: 60 }
            : i,
        ),
      'merchantReference_1 : TTL interdit',
    ],
    [
      'TTL sur un index supplémentaire',
      (l: ReturnType<typeof exact>) => [
        ...l,
        { name: 'createdAt_1', key: { createdAt: 1 }, expireAfterSeconds: 1 },
      ],
      'createdAt_1 : TTL interdit',
    ],
  ])('mal configuré (%s) → refusé', (_label, mutate, problem) => {
    expect(describeSubscriptionPaymentIndexProblem(mutate(exact()))).toBe(
      problem,
    );
  });

  it('vérification au démarrage réservée à la production', () => {
    expect(
      shouldVerifySubscriptionPaymentIndexes({ NODE_ENV: 'production' }),
    ).toBe(true);
    expect(shouldVerifySubscriptionPaymentIndexes({ NODE_ENV: 'test' })).toBe(
      false,
    );
    expect(shouldVerifySubscriptionPaymentIndexes({})).toBe(false);
  });

  it('identification des collisions E11000 : index unique requis uniquement', () => {
    const dup = (keyPattern: Record<string, number>) => ({
      code: 11000,
      keyPattern,
    });
    expect(
      subscriptionPaymentDuplicateKeyIndex(
        dup({ organizationId: 1, clientOperationId: 1 }),
      ),
    ).toBe('organizationId_1_clientOperationId_1');
    expect(
      subscriptionPaymentDuplicateKeyIndex(dup({ organizationId: 1 })),
    ).toBe('organizationId_1_single_open_payment');
    expect(
      subscriptionPaymentDuplicateKeyIndex(
        dup({ provider: 1, providerReference: 1 }),
      ),
    ).toBe('provider_1_providerReference_1');
    expect(
      subscriptionPaymentDuplicateKeyIndex(dup({ organizationId: 1, _id: -1 })),
    ).toBeNull();
    expect(subscriptionPaymentDuplicateKeyIndex(dup({ _id: 1 }))).toBeNull();
    expect(
      subscriptionPaymentDuplicateKeyIndex({
        code: 112,
        keyPattern: { merchantReference: 1 },
      }),
    ).toBeNull();
    expect(subscriptionPaymentDuplicateKeyIndex(new Error('x'))).toBeNull();
  });
});
