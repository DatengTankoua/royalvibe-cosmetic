import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { SUBSCRIPTION_PAYMENTS_COLLECTION } from './schemas/subscription-payment.schema';

/**
 * 1-14D.2B — Index REQUIS de `subscription_payments` :
 * 1. unique `{ organizationId, clientOperationId }` — rejeu d'une opération ;
 * 2. unique `{ merchantReference }` — référence marchand unique ;
 * 3. unique partiel `{ provider, providerReference }` (référence renseignée) ;
 * 4. unique partiel `{ organizationId }` lorsque `open: true` — un seul
 *    paiement ouvert par organisation ;
 * 5. `{ organizationId, _id: -1 }` (non unique) — historique paginé.
 *
 * Même contrat que `subscription-period-indexes.ts` : création EXPLICITE et
 * idempotente (migration, tests éphémères), jamais au démarrage ;
 * vérification EXACTE et fail-fast en production ; une configuration
 * incompatible n'est jamais écrasée. Aucun TTL.
 */

export interface RequiredPaymentIndex {
  name: string;
  key: Readonly<Record<string, 1 | -1>>;
  unique: boolean;
  partialFilterExpression?: Readonly<Record<string, unknown>>;
}

export const SUBSCRIPTION_PAYMENT_INDEXES: readonly RequiredPaymentIndex[] =
  Object.freeze([
    Object.freeze({
      name: 'organizationId_1_clientOperationId_1',
      key: Object.freeze({ organizationId: 1, clientOperationId: 1 } as const),
      unique: true,
    }),
    Object.freeze({
      name: 'merchantReference_1',
      key: Object.freeze({ merchantReference: 1 } as const),
      unique: true,
    }),
    Object.freeze({
      name: 'provider_1_providerReference_1',
      key: Object.freeze({ provider: 1, providerReference: 1 } as const),
      unique: true,
      partialFilterExpression: Object.freeze({
        providerReference: Object.freeze({ $type: 'string' }),
      }),
    }),
    Object.freeze({
      name: 'organizationId_1_single_open_payment',
      key: Object.freeze({ organizationId: 1 } as const),
      unique: true,
      partialFilterExpression: Object.freeze({ open: true }),
    }),
    Object.freeze({
      name: 'organizationId_1__id_-1',
      key: Object.freeze({ organizationId: 1, _id: -1 } as const),
      unique: false,
    }),
  ]);

const NAMESPACE_NOT_FOUND = 26;

export class SubscriptionPaymentIndexError extends Error {
  constructor(reason: string) {
    super(
      `Index ${SUBSCRIPTION_PAYMENTS_COLLECTION} invalides : ${reason}. ` +
        'Exécuter la migration `pnpm --filter api migrate:subscription-payment-indexes`.',
    );
    this.name = 'SubscriptionPaymentIndexError';
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

/** Égalité STRUCTURELLE, ordre des clés compris (MongoDB le conserve). */
function sameValue(actual: unknown, expected: unknown): boolean {
  if (
    typeof expected !== 'object' ||
    expected === null ||
    typeof actual !== 'object' ||
    actual === null
  ) {
    // Les clés d'index peuvent revenir en `Int32`/`Double` : comparaison
    // numérique tolérante au type, jamais à la valeur.
    return typeof expected === 'number'
      ? Number(actual) === expected
      : actual === expected;
  }
  const a = Object.entries(actual);
  const e = Object.entries(expected);
  return (
    a.length === e.length &&
    e.every(([k, v], i) => a[i][0] === k && sameValue(a[i][1], v))
  );
}

function describeOne(
  indexes: readonly IndexDescription[],
  required: RequiredPaymentIndex,
): string | null {
  const candidates = indexes.filter((i) => sameValue(i.key, required.key));
  const index = candidates.find((i) =>
    required.partialFilterExpression === undefined
      ? i.partialFilterExpression === undefined
      : sameValue(i.partialFilterExpression, required.partialFilterExpression),
  );
  if (!index) {
    return candidates.length > 0
      ? `${required.name} : filtre partiel inattendu`
      : `${required.name} : index absent`;
  }
  if ((index.unique === true) !== required.unique) {
    return `${required.name} : unicité inattendue`;
  }
  if (index.sparse === true) return `${required.name} : index sparse`;
  if (index.expireAfterSeconds !== undefined) {
    return `${required.name} : TTL interdit`;
  }
  if (index.collation !== undefined) {
    return `${required.name} : collation inattendue`;
  }
  return null;
}

/** Premier problème rencontré, ou `null` si les 5 index sont conformes. */
export function describeSubscriptionPaymentIndexProblem(
  indexes: readonly IndexDescription[],
): string | null {
  for (const required of SUBSCRIPTION_PAYMENT_INDEXES) {
    const problem = describeOne(indexes, required);
    if (problem) return problem;
  }
  // Aucun TTL toléré sur la collection, même hors index requis.
  const ttl = indexes.find((i) => i.expireAfterSeconds !== undefined);
  return ttl ? `${ttl.name ?? 'index'} : TTL interdit` : null;
}

function database(connection: Connection) {
  const db = connection.db;
  if (!db) {
    throw new SubscriptionPaymentIndexError('connexion MongoDB non prête');
  }
  return db;
}

async function listIndexes(
  connection: Connection,
): Promise<IndexDescription[]> {
  try {
    return (await database(connection)
      .collection(SUBSCRIPTION_PAYMENTS_COLLECTION)
      .listIndexes()
      .toArray()) as IndexDescription[];
  } catch (error) {
    if ((error as { code?: unknown }).code === NAMESPACE_NOT_FOUND) return [];
    throw error;
  }
}

export async function verifySubscriptionPaymentIndexes(
  connection: Connection,
): Promise<void> {
  const problem = describeSubscriptionPaymentIndexProblem(
    await listIndexes(connection),
  );
  if (problem) throw new SubscriptionPaymentIndexError(problem);
}

/**
 * Idempotent : no-op si les 5 index exacts existent. Sinon vérifie TOUS les
 * index requis puis crée les absents ; un index de même clé mal configuré
 * (ou un TTL) fait échouer AVANT toute création, sans jamais rien remplacer.
 * Revérifie ensuite.
 */
export async function ensureSubscriptionPaymentIndexes(
  connection: Connection,
): Promise<'already-present' | 'created'> {
  const existing = await listIndexes(connection);
  if (!describeSubscriptionPaymentIndexProblem(existing)) {
    return 'already-present';
  }
  // Validation COMPLÈTE avant toute création : une configuration
  // incompatible n'entraîne aucune création partielle.
  const missing: RequiredPaymentIndex[] = [];
  for (const required of SUBSCRIPTION_PAYMENT_INDEXES) {
    const problem = describeOne(existing, required);
    if (!problem) continue;
    if (!problem.endsWith('index absent')) {
      throw new SubscriptionPaymentIndexError(problem);
    }
    missing.push(required);
  }
  const ttl = existing.find((i) => i.expireAfterSeconds !== undefined);
  if (ttl) {
    throw new SubscriptionPaymentIndexError(
      `${ttl.name ?? 'index'} : TTL interdit`,
    );
  }
  for (const required of missing) {
    await database(connection)
      .collection(SUBSCRIPTION_PAYMENTS_COLLECTION)
      .createIndex(
        { ...required.key },
        {
          name: required.name,
          ...(required.unique ? { unique: true } : {}),
          ...(required.partialFilterExpression
            ? {
                partialFilterExpression: JSON.parse(
                  JSON.stringify(required.partialFilterExpression),
                ) as Record<string, unknown>,
              }
            : {}),
        },
      );
  }
  await verifySubscriptionPaymentIndexes(connection);
  return 'created';
}

export function shouldVerifySubscriptionPaymentIndexes(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.NODE_ENV === 'production';
}

/** Production : index absents ou mal configurés → `app.init()` rejette. */
@Injectable()
export class SubscriptionPaymentIndexCheck implements OnApplicationBootstrap {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!shouldVerifySubscriptionPaymentIndexes()) return;
    await verifySubscriptionPaymentIndexes(this.connection);
  }
}

/** Nom de l'index REQUIS en cause d'un E11000 (clé exacte), sinon `null`. */
export function subscriptionPaymentDuplicateKeyIndex(
  error: unknown,
): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const { code, keyPattern } = error as {
    code?: unknown;
    keyPattern?: unknown;
  };
  if (code !== 11000) return null;
  if (typeof keyPattern !== 'object' || keyPattern === null) return null;
  const match = SUBSCRIPTION_PAYMENT_INDEXES.find(
    (i) => i.unique && sameValue(keyPattern, i.key),
  );
  return match ? match.name : null;
}
