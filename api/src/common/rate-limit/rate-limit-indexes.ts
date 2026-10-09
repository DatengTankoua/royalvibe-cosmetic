import type { Connection } from 'mongoose';
import { RATE_LIMIT_BUCKETS_COLLECTION } from './persistent-rate-limiter.service';

/**
 * 1-18C — Index TTL de `rate_limit_buckets` (`expiresAt`, expiration à la
 * date indiquée). Nettoyage uniquement : l'exactitude des plafonds ne
 * dépend pas de lui (une fenêtre échue est réinitialisée à la demande
 * suivante), il n'est donc pas vérifié au démarrage. Création par la
 * migration `create-rate-limit-indexes` (pré-déploiement), idempotente ;
 * échec sans rien écraser si un index homonyme diffère. Migration d'index
 * uniquement : aucune donnée lue ni écrite.
 */
export const RATE_LIMIT_TTL_INDEX_NAME = 'expiresAt_1_ttl';

const NAMESPACE_NOT_FOUND = 26;

interface IndexDescription {
  name?: string;
  key: Record<string, unknown>;
  unique?: boolean;
  expireAfterSeconds?: number;
  partialFilterExpression?: unknown;
}

export function describeRateLimitIndexProblem(
  indexes: readonly IndexDescription[],
): string | null {
  const index = indexes.find((i) => i.name === RATE_LIMIT_TTL_INDEX_NAME);
  if (!index) return 'index TTL expiresAt absent';
  const key = Object.entries(index.key);
  if (key.length !== 1 || key[0][0] !== 'expiresAt' || key[0][1] !== 1) {
    return 'clé inattendue';
  }
  if (
    index.expireAfterSeconds !== 0 ||
    index.unique ||
    index.partialFilterExpression !== undefined
  ) {
    return 'options inattendues';
  }
  return null;
}

async function listIndexes(
  connection: Connection,
): Promise<IndexDescription[]> {
  const db = connection.db;
  if (!db) throw new Error('connexion MongoDB non prête');
  try {
    return (await db
      .collection(RATE_LIMIT_BUCKETS_COLLECTION)
      .listIndexes()
      .toArray()) as IndexDescription[];
  } catch (error) {
    if ((error as { code?: unknown }).code === NAMESPACE_NOT_FOUND) return [];
    throw error;
  }
}

/** Vérification en LECTURE SEULE (`listIndexes` uniquement). */
export async function checkRateLimitIndexes(
  connection: Connection,
): Promise<string | null> {
  return describeRateLimitIndexProblem(await listIndexes(connection));
}

export async function ensureRateLimitIndexes(
  connection: Connection,
): Promise<'already-present' | 'created'> {
  if (!describeRateLimitIndexProblem(await listIndexes(connection))) {
    return 'already-present';
  }
  const db = connection.db;
  if (!db) throw new Error('connexion MongoDB non prête');
  await db
    .collection(RATE_LIMIT_BUCKETS_COLLECTION)
    .createIndex(
      { expiresAt: 1 },
      { name: RATE_LIMIT_TTL_INDEX_NAME, expireAfterSeconds: 0 },
    );
  const problem = describeRateLimitIndexProblem(await listIndexes(connection));
  if (problem) {
    throw new Error(`Index rate_limit_buckets invalide : ${problem}`);
  }
  return 'created';
}
