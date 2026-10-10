import 'reflect-metadata';
import { createConnection, type Connection } from 'mongoose';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';
import { RATE_LIMIT_BUCKETS_COLLECTION } from '../src/common/rate-limit/persistent-rate-limiter.service';
import {
  RATE_LIMIT_TTL_INDEX_NAME,
  checkRateLimitIndexes,
  ensureRateLimitIndexes,
} from '../src/common/rate-limit/rate-limit-indexes';
import { PREDEPLOY_MIGRATIONS } from '../src/migrations/predeploy-migrations';

/**
 * 1-18C — Migration d'index `create-rate-limit-indexes` sur base ÉPHÉMÈRE :
 * TTL exact, idempotence, refus d'un index homonyme différent sans
 * écrasement, présence dans le pré-déploiement.
 */
describe('Index TTL rate_limit_buckets (e2e 1-18C)', () => {
  let connection: Connection;

  const ttlIndex = async () =>
    (
      (await connection
        .db!.collection(RATE_LIMIT_BUCKETS_COLLECTION)
        .listIndexes()
        .toArray()
        .catch(() => [])) as Array<{
        name?: string;
        key: Record<string, unknown>;
        expireAfterSeconds?: number;
      }>
    ).find((i) => i.name === RATE_LIMIT_TTL_INDEX_NAME);

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    connection = await createConnection(
      validatedEphemeralUri(replSet),
    ).asPromise();
  }, 180_000);

  afterAll(async () => {
    if (connection) await connection.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  it('absent → créé : expiresAt, expireAfterSeconds = 0', async () => {
    await expect(checkRateLimitIndexes(connection)).resolves.toBe(
      'index TTL expiresAt absent',
    );
    await expect(ensureRateLimitIndexes(connection)).resolves.toBe('created');
    const index = await ttlIndex();
    expect(index?.key).toEqual({ expiresAt: 1 });
    expect(index?.expireAfterSeconds).toBe(0);
    await expect(checkRateLimitIndexes(connection)).resolves.toBeNull();
  });

  it('idempotente : second passage sans effet', async () => {
    await expect(ensureRateLimitIndexes(connection)).resolves.toBe(
      'already-present',
    );
  });

  it('index homonyme différent : refus, rien n’est écrasé', async () => {
    const collection = connection.db!.collection(RATE_LIMIT_BUCKETS_COLLECTION);
    await collection.dropIndex(RATE_LIMIT_TTL_INDEX_NAME);
    await collection.createIndex(
      { expiresAt: 1 },
      { name: RATE_LIMIT_TTL_INDEX_NAME, expireAfterSeconds: 60 },
    );
    await expect(ensureRateLimitIndexes(connection)).rejects.toThrow();
    expect((await ttlIndex())?.expireAfterSeconds).toBe(60);
  });

  // 1-20F : des migrations de performance (1-20E, 1-20F) suivent désormais ;
  // l'ordre utile est celui relatif à 1-18B.
  it('pré-déploiement : juste après celles de 1-18B', () => {
    const index = PREDEPLOY_MIGRATIONS.indexOf('create-rate-limit-indexes.js');
    expect(index).toBeGreaterThan(0);
    expect(PREDEPLOY_MIGRATIONS[index - 1]).toBe(
      'create-invitation-account-token-index.js',
    );
  });
});
