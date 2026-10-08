import 'reflect-metadata';
import { createConnection, type Connection } from 'mongoose';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';
import { SUPPORT_REQUESTS_COLLECTION } from '../src/support/schemas/support-request.schema';
import { SUPPORT_REQUEST_RETENTION_SECONDS } from '../src/support/support-constants';
import {
  SUPPORT_REQUEST_TTL_INDEX_NAME,
  ensureSupportRequestIndexes,
} from '../src/support/support-request-indexes';

/**
 * 1-16C.1 — Migration `create-support-request-indexes` sur une base
 * ÉPHÉMÈRE uniquement : index TTL exact, idempotence, refus d'une
 * configuration incompatible sans rien écraser.
 */
describe('Index TTL support_requests (e2e 1-16C.1)', () => {
  let connection: Connection;

  const ttlIndex = async () =>
    (await connection
      .db!.collection(SUPPORT_REQUESTS_COLLECTION)
      .listIndexes()
      .toArray()
      .catch(() => [])) as Array<{
      name?: string;
      key: Record<string, unknown>;
      expireAfterSeconds?: number;
    }>;

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

  it('crée l’index attendu : createdAt, expireAfterSeconds = 2592000', async () => {
    expect(SUPPORT_REQUEST_RETENTION_SECONDS).toBe(2_592_000);
    await expect(ensureSupportRequestIndexes(connection)).resolves.toBe(
      'created',
    );
    const index = (await ttlIndex()).find(
      (i) => i.name === SUPPORT_REQUEST_TTL_INDEX_NAME,
    );
    expect(index?.key).toEqual({ createdAt: 1 });
    expect(index?.expireAfterSeconds).toBe(2_592_000);
  });

  it('idempotente : un second passage ne modifie rien', async () => {
    const before = await ttlIndex();
    await expect(ensureSupportRequestIndexes(connection)).resolves.toBe(
      'already-present',
    );
    expect(await ttlIndex()).toEqual(before);
  });

  it('configuration incompatible : refus, l’index existant n’est pas écrasé', async () => {
    const collection = connection.db!.collection(SUPPORT_REQUESTS_COLLECTION);
    await collection.dropIndex(SUPPORT_REQUEST_TTL_INDEX_NAME);
    await collection.createIndex(
      { createdAt: 1 },
      { name: SUPPORT_REQUEST_TTL_INDEX_NAME, expireAfterSeconds: 60 },
    );
    await expect(ensureSupportRequestIndexes(connection)).rejects.toThrow();
    const index = (await ttlIndex()).find(
      (i) => i.name === SUPPORT_REQUEST_TTL_INDEX_NAME,
    );
    expect(index?.expireAfterSeconds).toBe(60);
  });
});
