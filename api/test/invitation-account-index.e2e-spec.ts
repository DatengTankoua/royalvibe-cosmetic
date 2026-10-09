import 'reflect-metadata';
import { createConnection, type Connection } from 'mongoose';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';
import {
  OrganizationInvitation,
  OrganizationInvitationSchema,
} from '../src/organizations/schemas/invitation.schema';
import {
  INVITATIONS_COLLECTION,
  INVITATION_ACCOUNT_TOKEN_INDEX_NAME,
  checkInvitationAccountIndex,
  ensureInvitationAccountIndex,
} from '../src/organizations/invitation-account-index';
import { PREDEPLOY_MIGRATIONS } from '../src/migrations/predeploy-migrations';

/**
 * 1-18B — Migration d'index `create-invitation-account-token-index` sur une
 * base ÉPHÉMÈRE uniquement : index partiel exact, idempotence,
 * compatibilité avec `autoIndex`, refus d'une configuration incompatible
 * sans rien écraser, présence dans le pré-déploiement.
 */
describe('Index accountTokenHash des invitations (e2e 1-18B)', () => {
  let connection: Connection;

  const indexes = async () =>
    (await connection
      .db!.collection(INVITATIONS_COLLECTION)
      .listIndexes()
      .toArray()
      .catch(() => [])) as Array<{
      name?: string;
      key: Record<string, unknown>;
      unique?: boolean;
      partialFilterExpression?: Record<string, unknown>;
    }>;
  const accountIndex = async () =>
    (await indexes()).find(
      (i) => i.name === INVITATION_ACCOUNT_TOKEN_INDEX_NAME,
    );

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

  it('collection visée = collection réelle du modèle', () => {
    const model = connection.model(
      OrganizationInvitation.name,
      OrganizationInvitationSchema,
    );
    expect(model.collection.collectionName).toBe(INVITATIONS_COLLECTION);
  });

  it('base sans collection : vérification en lecture seule → absent ; création de l’index partiel exact', async () => {
    await expect(checkInvitationAccountIndex(connection)).resolves.toBe(
      'index accountTokenHash absent',
    );
    await expect(ensureInvitationAccountIndex(connection)).resolves.toBe(
      'created',
    );
    const index = await accountIndex();
    expect(index?.key).toEqual({ accountTokenHash: 1 });
    expect(index?.unique).toBeUndefined();
    expect(index?.partialFilterExpression).toEqual({
      accountTokenHash: { $exists: true },
    });
    await expect(checkInvitationAccountIndex(connection)).resolves.toBeNull();
  });

  it('idempotente : un second passage ne modifie rien', async () => {
    const before = await indexes();
    await expect(ensureInvitationAccountIndex(connection)).resolves.toBe(
      'already-present',
    );
    expect(await indexes()).toEqual(before);
  });

  it('compatible avec autoIndex : l’index créé par le schéma est reconnu tel quel', async () => {
    const collection = connection.db!.collection(INVITATIONS_COLLECTION);
    await collection.dropIndex(INVITATION_ACCOUNT_TOKEN_INDEX_NAME);
    const model = connection.model(
      OrganizationInvitation.name,
      OrganizationInvitationSchema,
    );
    await model.createIndexes();
    expect(await accountIndex()).toBeDefined();
    await expect(ensureInvitationAccountIndex(connection)).resolves.toBe(
      'already-present',
    );
  });

  it('configuration incompatible : refus, l’index existant n’est pas écrasé', async () => {
    const collection = connection.db!.collection(INVITATIONS_COLLECTION);
    await collection.dropIndex(INVITATION_ACCOUNT_TOKEN_INDEX_NAME);
    await collection.createIndex(
      { accountTokenHash: 1 },
      { name: INVITATION_ACCOUNT_TOKEN_INDEX_NAME, sparse: true },
    );
    await expect(checkInvitationAccountIndex(connection)).resolves.toBe(
      'options inattendues',
    );
    await expect(ensureInvitationAccountIndex(connection)).rejects.toThrow();
    const index = (await accountIndex()) as { sparse?: boolean } | undefined;
    expect(index?.sparse).toBe(true);
  });

  it('pré-déploiement : migration listée, après les migrations existantes', () => {
    const index = PREDEPLOY_MIGRATIONS.indexOf(
      'create-invitation-account-token-index.js',
    );
    expect(index).toBeGreaterThan(
      PREDEPLOY_MIGRATIONS.indexOf('create-legal-acceptance-indexes.js'),
    );
  });
});
