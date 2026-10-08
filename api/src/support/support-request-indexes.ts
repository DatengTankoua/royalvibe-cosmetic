import type { Connection } from 'mongoose';
import { SUPPORT_REQUESTS_COLLECTION } from './schemas/support-request.schema';
import { SUPPORT_REQUEST_RETENTION_SECONDS } from './support-constants';

/**
 * 1-16C.1 — Index TTL du registre anti-doublon `support_requests`
 * (`createdAt`, 30 jours). L'unicité des intentions repose sur l'index
 * `_id` natif : ce TTL ne sert qu'à la purge. Sans lui, l'assistance
 * fonctionne mais le registre n'est pas purgé : il n'est donc PAS vérifié
 * au démarrage (aucun blocage de l'API).
 *
 * Création uniquement par la migration explicite
 * `pnpm --filter api migrate:support-request-indexes` (idempotente ; échoue
 * sans rien écraser si un index homonyme a d'autres options).
 */
export const SUPPORT_REQUEST_TTL_INDEX_NAME = 'createdAt_1_ttl';

const NAMESPACE_NOT_FOUND = 26;

interface IndexDescription {
  name?: string;
  key: Record<string, unknown>;
  expireAfterSeconds?: number;
}

export function describeSupportRequestIndexProblem(
  indexes: readonly IndexDescription[],
): string | null {
  const index = indexes.find((i) => i.name === SUPPORT_REQUEST_TTL_INDEX_NAME);
  if (!index) return 'index TTL absent';
  const key = Object.entries(index.key);
  if (key.length !== 1 || key[0][0] !== 'createdAt' || key[0][1] !== 1) {
    return 'clé inattendue';
  }
  if (Number(index.expireAfterSeconds) !== SUPPORT_REQUEST_RETENTION_SECONDS) {
    return 'durée TTL inattendue';
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
      .collection(SUPPORT_REQUESTS_COLLECTION)
      .listIndexes()
      .toArray()) as IndexDescription[];
  } catch (error) {
    if ((error as { code?: unknown }).code === NAMESPACE_NOT_FOUND) return [];
    throw error;
  }
}

/**
 * 1-16C.2 — Vérification en LECTURE SEULE (`listIndexes` uniquement) :
 * `null` si l'index TTL attendu existe, sinon le problème constaté. Aucune
 * création, aucune donnée lue.
 */
export async function checkSupportRequestIndexes(
  connection: Connection,
): Promise<string | null> {
  return describeSupportRequestIndexProblem(await listIndexes(connection));
}

export async function ensureSupportRequestIndexes(
  connection: Connection,
): Promise<'already-present' | 'created'> {
  if (!describeSupportRequestIndexProblem(await listIndexes(connection))) {
    return 'already-present';
  }
  const db = connection.db;
  if (!db) throw new Error('connexion MongoDB non prête');
  await db.collection(SUPPORT_REQUESTS_COLLECTION).createIndex(
    { createdAt: 1 },
    {
      name: SUPPORT_REQUEST_TTL_INDEX_NAME,
      expireAfterSeconds: SUPPORT_REQUEST_RETENTION_SECONDS,
    },
  );
  const problem = describeSupportRequestIndexProblem(
    await listIndexes(connection),
  );
  if (problem) throw new Error(`Index support_requests invalide : ${problem}`);
  return 'created';
}
