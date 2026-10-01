import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { SUBSCRIPTION_PERIODS_COLLECTION } from './schemas/subscription-period.schema';
import { SubscriptionPeriodKind } from './subscription-terms';

/**
 * 1-14B — Index REQUIS de `subscription_periods` (tous uniques) :
 * 1. `{ source, sourceReference }` — idempotence des attributions ;
 * 2. `{ organizationId, sequence }` — chaîne linéaire par organisation :
 *    deux attributions concurrentes ne peuvent pas prendre le même rang ;
 * 3. `{ organizationId }` partiel `{ kind: 'trial' }` — un seul essai par
 *    organisation, quelle que soit la référence.
 *
 * Même contrat que `sale-operation-index.ts` : création EXPLICITE et
 * idempotente (migration, tests éphémères), jamais au démarrage ;
 * vérification fail-fast en production ; une configuration incompatible
 * n'est jamais écrasée.
 */

export interface RequiredIndex {
  name: string;
  key: Readonly<Record<string, 1>>;
  partialFilterExpression?: Readonly<Record<string, unknown>>;
}

export const SUBSCRIPTION_PERIOD_INDEXES: readonly RequiredIndex[] =
  Object.freeze([
    Object.freeze({
      name: 'source_1_sourceReference_1',
      key: Object.freeze({ source: 1, sourceReference: 1 } as const),
    }),
    Object.freeze({
      name: 'organizationId_1_sequence_1',
      key: Object.freeze({ organizationId: 1, sequence: 1 } as const),
    }),
    Object.freeze({
      name: 'organizationId_1_single_trial',
      key: Object.freeze({ organizationId: 1 } as const),
      partialFilterExpression: Object.freeze({
        kind: SubscriptionPeriodKind.TRIAL,
      }),
    }),
  ]);

const NAMESPACE_NOT_FOUND = 26;

export class SubscriptionPeriodIndexError extends Error {
  constructor(reason: string) {
    super(
      `Index ${SUBSCRIPTION_PERIODS_COLLECTION} invalides : ${reason}. ` +
        'Exécuter la migration `pnpm --filter api migrate:subscription-period-indexes`.',
    );
    this.name = 'SubscriptionPeriodIndexError';
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

function sameOrderedEntries(
  actual: Record<string, unknown>,
  expected: Readonly<Record<string, unknown>>,
): boolean {
  const a = Object.entries(actual);
  const e = Object.entries(expected);
  return (
    a.length === e.length &&
    e.every(([field, value], i) => a[i][0] === field && a[i][1] === value)
  );
}

function samePartial(
  actual: unknown,
  expected: RequiredIndex['partialFilterExpression'],
): boolean {
  if (expected === undefined) return actual === undefined;
  return (
    typeof actual === 'object' &&
    actual !== null &&
    sameOrderedEntries(actual as Record<string, unknown>, expected)
  );
}

/** Problème d'un index requis, ou `null` s'il est EXACTEMENT conforme. */
function describeOne(
  indexes: readonly IndexDescription[],
  required: RequiredIndex,
): string | null {
  const candidates = indexes.filter((i) =>
    sameOrderedEntries(i.key, required.key),
  );
  const index = candidates.find((i) =>
    samePartial(i.partialFilterExpression, required.partialFilterExpression),
  );
  if (!index) {
    return candidates.length > 0
      ? `${required.name} : filtre partiel inattendu`
      : `${required.name} : index absent`;
  }
  if (index.unique !== true) return `${required.name} : index non unique`;
  if (index.sparse === true) return `${required.name} : index sparse`;
  if (index.expireAfterSeconds !== undefined) {
    return `${required.name} : TTL interdit`;
  }
  if (index.collation !== undefined) {
    return `${required.name} : collation inattendue`;
  }
  return null;
}

/** Premier problème rencontré, ou `null` si les 3 index sont conformes. */
export function describeSubscriptionPeriodIndexProblem(
  indexes: readonly IndexDescription[],
): string | null {
  for (const required of SUBSCRIPTION_PERIOD_INDEXES) {
    const problem = describeOne(indexes, required);
    if (problem) return problem;
  }
  return null;
}

function database(connection: Connection) {
  const db = connection.db;
  if (!db) {
    throw new SubscriptionPeriodIndexError('connexion MongoDB non prête');
  }
  return db;
}

async function listIndexes(
  connection: Connection,
): Promise<IndexDescription[]> {
  try {
    return (await database(connection)
      .collection(SUBSCRIPTION_PERIODS_COLLECTION)
      .listIndexes()
      .toArray()) as IndexDescription[];
  } catch (error) {
    if ((error as { code?: unknown }).code === NAMESPACE_NOT_FOUND) return [];
    throw error;
  }
}

export async function verifySubscriptionPeriodIndexes(
  connection: Connection,
): Promise<void> {
  const problem = describeSubscriptionPeriodIndexProblem(
    await listIndexes(connection),
  );
  if (problem) throw new SubscriptionPeriodIndexError(problem);
}

/**
 * Idempotent : no-op si les 3 index exacts existent. Sinon crée chaque index
 * absent ; un index de même clé mal configuré n'est JAMAIS remplacé
 * (MongoDB refuse la création, la migration échoue). Revérifie ensuite.
 */
export async function ensureSubscriptionPeriodIndexes(
  connection: Connection,
): Promise<'already-present' | 'created'> {
  const existing = await listIndexes(connection);
  if (!describeSubscriptionPeriodIndexProblem(existing)) {
    return 'already-present';
  }
  for (const required of SUBSCRIPTION_PERIOD_INDEXES) {
    const problem = describeOne(existing, required);
    if (!problem) continue;
    if (!problem.endsWith('index absent')) {
      throw new SubscriptionPeriodIndexError(problem);
    }
    await database(connection)
      .collection(SUBSCRIPTION_PERIODS_COLLECTION)
      .createIndex(
        { ...required.key },
        {
          unique: true,
          name: required.name,
          ...(required.partialFilterExpression
            ? {
                partialFilterExpression: {
                  ...required.partialFilterExpression,
                },
              }
            : {}),
        },
      );
  }
  await verifySubscriptionPeriodIndexes(connection);
  return 'created';
}

/** Vérification fail-fast réservée aux environnements déployés. */
export function shouldVerifySubscriptionPeriodIndexes(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.NODE_ENV === 'production';
}

/**
 * En production (`NODE_ENV=production`) : index absents ou mal configurés →
 * `app.init()` rejette. Hors production : aucune lecture (les tests
 * éphémères créent les index explicitement).
 */
@Injectable()
export class SubscriptionPeriodIndexCheck implements OnApplicationBootstrap {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!shouldVerifySubscriptionPeriodIndexes()) return;
    await verifySubscriptionPeriodIndexes(this.connection);
  }
}

/**
 * E11000 levé par l'un des index REQUIS (clé exacte), jamais un autre.
 * Renvoie le nom de l'index en cause, ou `null`.
 */
export function subscriptionDuplicateKeyIndex(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const { code, keyPattern } = error as {
    code?: unknown;
    keyPattern?: unknown;
  };
  if (code !== 11000) return null;
  if (typeof keyPattern !== 'object' || keyPattern === null) return null;
  const match = SUBSCRIPTION_PERIOD_INDEXES.find((i) =>
    sameOrderedEntries(keyPattern as Record<string, unknown>, i.key),
  );
  return match ? match.name : null;
}
