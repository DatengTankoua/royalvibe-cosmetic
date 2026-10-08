import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import {
  SALE_OPERATIONS_COLLECTION,
  SALE_OPERATION_INDEX_KEY,
} from './schemas/sale-operation.schema';

/**
 * 1-11C.1 — Index unique idempotent `sale_operations`
 * `{ organizationId: 1, clientOperationId: 1 }`.
 *
 * - `ensureSaleOperationIndex` : création EXPLICITE et idempotente (migration
 *   dédiée, tests éphémères). Jamais appelée au démarrage de l'API.
 * - `verifySaleOperationIndex` : lecture seule ; lève si l'index est absent
 *   ou mal configuré (non unique, partiel, sparse, TTL, collation, clé dans un
 *   autre ordre). Sans cet index, deux rejeux concurrents pourraient créer
 *   deux ventes.
 */

export const SALE_OPERATION_INDEX_NAME = 'organizationId_1_clientOperationId_1';

const NAMESPACE_NOT_FOUND = 26;

export class SaleOperationIndexError extends Error {
  constructor(reason: string) {
    super(
      `Index idempotent ${SALE_OPERATIONS_COLLECTION}.${SALE_OPERATION_INDEX_NAME} invalide : ${reason}. ` +
        'Exécuter la migration `pnpm --filter api migrate:sale-operations-index`.',
    );
    this.name = 'SaleOperationIndexError';
  }
}

interface IndexDescription {
  name?: string;
  key: Record<string, unknown>;
  unique?: boolean;
  sparse?: boolean;
  partialFilterExpression?: unknown;
  expireAfterSeconds?: number;
  collation?: unknown;
}

function hasExactKey(key: Record<string, unknown>): boolean {
  const actual = Object.entries(key);
  const expected = Object.entries(SALE_OPERATION_INDEX_KEY);
  return (
    actual.length === expected.length &&
    expected.every(
      ([field, dir], i) => actual[i][0] === field && actual[i][1] === dir,
    )
  );
}

/** Raison du refus, ou `null` si la configuration est EXACTEMENT la bonne. */
export function describeSaleOperationIndexProblem(
  indexes: readonly IndexDescription[],
): string | null {
  const index = indexes.find((i) => hasExactKey(i.key));
  if (!index) return 'index absent';
  if (index.unique !== true) return 'index non unique';
  if (index.partialFilterExpression !== undefined) return 'index partiel';
  if (index.sparse === true) return 'index sparse';
  if (index.expireAfterSeconds !== undefined) return 'TTL interdit';
  if (index.collation !== undefined) return 'collation inattendue';
  return null;
}

function database(connection: Connection) {
  const db = connection.db;
  if (!db) throw new SaleOperationIndexError('connexion MongoDB non prête');
  return db;
}

async function listIndexes(
  connection: Connection,
): Promise<IndexDescription[]> {
  try {
    return (await database(connection)
      .collection(SALE_OPERATIONS_COLLECTION)
      .listIndexes()
      .toArray()) as IndexDescription[];
  } catch (error) {
    if ((error as { code?: unknown }).code === NAMESPACE_NOT_FOUND) return [];
    throw error;
  }
}

export async function verifySaleOperationIndex(
  connection: Connection,
): Promise<void> {
  const problem = describeSaleOperationIndexProblem(
    await listIndexes(connection),
  );
  if (problem) throw new SaleOperationIndexError(problem);
}

/**
 * Idempotent : no-op si l'index exact existe ; sinon le crée (MongoDB lève
 * si un index homonyme existe avec d'autres options — jamais écrasé), puis
 * revérifie.
 */
export async function ensureSaleOperationIndex(
  connection: Connection,
): Promise<'already-present' | 'created'> {
  if (!describeSaleOperationIndexProblem(await listIndexes(connection))) {
    return 'already-present';
  }
  await database(connection)
    .collection(SALE_OPERATIONS_COLLECTION)
    .createIndex(
      { ...SALE_OPERATION_INDEX_KEY },
      { unique: true, name: SALE_OPERATION_INDEX_NAME },
    );
  await verifySaleOperationIndex(connection);
  return 'created';
}

/** Vérification fail-fast réservée aux environnements déployés. */
export function shouldVerifySaleOperationIndex(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.NODE_ENV === 'production';
}

/**
 * Au démarrage en production (`NODE_ENV=production`, cf. `api/Dockerfile`) :
 * index absent ou mal configuré → `app.init()` rejette, l'API ne démarre
 * pas. Hors production : aucune lecture (les tests éphémères créent l'index
 * explicitement via `ensureSaleOperationIndex`).
 */
@Injectable()
export class SaleOperationIndexCheck implements OnApplicationBootstrap {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!shouldVerifySaleOperationIndex()) return;
    await verifySaleOperationIndex(this.connection);
  }
}
