import type { Connection } from 'mongoose';
import {
  IndexDescription,
  RequiredPaymentIndex,
  describeOne,
} from '../subscription-payment-indexes';
import { SUBSCRIPTION_PAYMENT_RECONCILIATIONS_COLLECTION } from './subscription-payment-reconciliation.schema';

/**
 * 1-14D.2G — Index REQUIS de `subscription_payment_reconciliations` :
 * 1. unique `{ operationId }` — une opération opérateur, un audit (rejeu) ;
 * 2. `{ paymentId, _id: -1 }` — historique par paiement (inspection).
 *
 * Même contrat que les index de paiement : création EXPLICITE par migration
 * (jamais au démarrage), validation COMPLÈTE avant toute création, aucune
 * configuration incompatible écrasée, aucun TTL. Le CLI vérifie ces index
 * avant toute mutation.
 */
export const SUBSCRIPTION_PAYMENT_RECONCILIATION_INDEXES: readonly RequiredPaymentIndex[] =
  Object.freeze([
    Object.freeze({
      name: 'operationId_1',
      key: Object.freeze({ operationId: 1 } as const),
      unique: true,
    }),
    Object.freeze({
      name: 'paymentId_1__id_-1',
      key: Object.freeze({ paymentId: 1, _id: -1 } as const),
      unique: false,
    }),
  ]);

const NAMESPACE_NOT_FOUND = 26;

export class SubscriptionPaymentReconciliationIndexError extends Error {
  constructor(reason: string) {
    super(
      `Index ${SUBSCRIPTION_PAYMENT_RECONCILIATIONS_COLLECTION} invalides : ${reason}. ` +
        'Exécuter la migration `pnpm --filter api migrate:subscription-payment-reconciliation-indexes`.',
    );
    this.name = 'SubscriptionPaymentReconciliationIndexError';
  }
}

export function describeReconciliationIndexProblem(
  indexes: readonly IndexDescription[],
): string | null {
  for (const required of SUBSCRIPTION_PAYMENT_RECONCILIATION_INDEXES) {
    const problem = describeOne(indexes, required);
    if (problem) return problem;
  }
  const ttl = indexes.find((i) => i.expireAfterSeconds !== undefined);
  return ttl ? `${ttl.name ?? 'index'} : TTL interdit` : null;
}

function collection(connection: Connection) {
  const db = connection.db;
  if (!db) {
    throw new SubscriptionPaymentReconciliationIndexError(
      'connexion MongoDB non prête',
    );
  }
  return db.collection(SUBSCRIPTION_PAYMENT_RECONCILIATIONS_COLLECTION);
}

async function listIndexes(
  connection: Connection,
): Promise<IndexDescription[]> {
  try {
    return (await collection(connection)
      .listIndexes()
      .toArray()) as IndexDescription[];
  } catch (error) {
    if ((error as { code?: unknown }).code === NAMESPACE_NOT_FOUND) return [];
    throw error;
  }
}

export async function verifyReconciliationIndexes(
  connection: Connection,
): Promise<void> {
  const problem = describeReconciliationIndexProblem(
    await listIndexes(connection),
  );
  if (problem) throw new SubscriptionPaymentReconciliationIndexError(problem);
}

/** Idempotent ; validation de TOUS les index avant toute création. */
export async function ensureReconciliationIndexes(
  connection: Connection,
): Promise<'already-present' | 'created'> {
  const existing = await listIndexes(connection);
  if (!describeReconciliationIndexProblem(existing)) return 'already-present';
  const missing: RequiredPaymentIndex[] = [];
  for (const required of SUBSCRIPTION_PAYMENT_RECONCILIATION_INDEXES) {
    const problem = describeOne(existing, required);
    if (!problem) continue;
    if (!problem.endsWith('index absent')) {
      throw new SubscriptionPaymentReconciliationIndexError(problem);
    }
    missing.push(required);
  }
  const ttl = existing.find((i) => i.expireAfterSeconds !== undefined);
  if (ttl) {
    throw new SubscriptionPaymentReconciliationIndexError(
      `${ttl.name ?? 'index'} : TTL interdit`,
    );
  }
  for (const required of missing) {
    await collection(connection).createIndex(
      { ...required.key },
      { name: required.name, ...(required.unique ? { unique: true } : {}) },
    );
  }
  await verifyReconciliationIndexes(connection);
  return 'created';
}

/** E11000 sur l'identifiant d'opération (opération rejouée en concurrence). */
export function isReconciliationOperationDuplicate(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, keyPattern } = error as {
    code?: unknown;
    keyPattern?: unknown;
  };
  return (
    code === 11000 &&
    typeof keyPattern === 'object' &&
    keyPattern !== null &&
    Object.keys(keyPattern).join(',') === 'operationId'
  );
}
