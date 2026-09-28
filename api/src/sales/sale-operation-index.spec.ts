import type { Connection } from 'mongoose';
import {
  SaleOperationIndexCheck,
  SaleOperationIndexError,
  describeSaleOperationIndexProblem,
  shouldVerifySaleOperationIndex,
} from './sale-operation-index';

const key = { organizationId: 1, clientOperationId: 1 };
const idIndex = { name: '_id_', key: { _id: 1 } };

describe('sale-operation-index (1-11C.1)', () => {
  describe('describeSaleOperationIndexProblem', () => {
    it('accepte uniquement la configuration exacte', () => {
      expect(
        describeSaleOperationIndexProblem([idIndex, { key, unique: true }]),
      ).toBeNull();
    });

    it.each([
      ['absent', [idIndex]],
      ['non unique', [{ key }]],
      [
        'ordre de clé inversé',
        [{ key: { clientOperationId: 1, organizationId: 1 }, unique: true }],
      ],
      [
        'direction différente',
        [{ key: { organizationId: 1, clientOperationId: -1 }, unique: true }],
      ],
      ['partiel', [{ key, unique: true, partialFilterExpression: {} }]],
      ['sparse', [{ key, unique: true, sparse: true }]],
      ['TTL', [{ key, unique: true, expireAfterSeconds: 60 }]],
      ['collation', [{ key, unique: true, collation: { locale: 'fr' } }]],
    ])('refuse : %s', (_label, indexes) => {
      expect(describeSaleOperationIndexProblem(indexes)).not.toBeNull();
    });
  });

  describe('fail-fast au démarrage', () => {
    it('vérification uniquement en production', () => {
      expect(shouldVerifySaleOperationIndex({ NODE_ENV: 'production' })).toBe(
        true,
      );
      expect(shouldVerifySaleOperationIndex({ NODE_ENV: 'test' })).toBe(false);
      expect(shouldVerifySaleOperationIndex({})).toBe(false);
    });

    function connectionWith(indexes: unknown[] | Error) {
      const listIndexes = jest.fn(() => ({
        toArray: () =>
          indexes instanceof Error
            ? Promise.reject(indexes)
            : Promise.resolve(indexes),
      }));
      const connection = {
        db: { collection: jest.fn(() => ({ listIndexes })) },
      } as unknown as Connection;
      return { connection, listIndexes };
    }

    const withEnv = async (value: string, fn: () => Promise<void>) => {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = value;
      try {
        await fn();
      } finally {
        process.env.NODE_ENV = previous;
      }
    };

    it('hors production : aucune lecture de la base', async () => {
      const { connection, listIndexes } = connectionWith([]);
      await withEnv('test', () =>
        new SaleOperationIndexCheck(connection).onApplicationBootstrap(),
      );
      expect(listIndexes).not.toHaveBeenCalled();
    });

    it('production + index absent (collection absente) → démarrage refusé', async () => {
      const { connection } = connectionWith(
        Object.assign(new Error('ns does not exist'), { code: 26 }),
      );
      await withEnv('production', async () => {
        await expect(
          new SaleOperationIndexCheck(connection).onApplicationBootstrap(),
        ).rejects.toBeInstanceOf(SaleOperationIndexError);
      });
    });

    it('production + index exact → démarrage autorisé', async () => {
      const { connection } = connectionWith([idIndex, { key, unique: true }]);
      await withEnv('production', async () => {
        await expect(
          new SaleOperationIndexCheck(connection).onApplicationBootstrap(),
        ).resolves.toBeUndefined();
      });
    });
  });
});
