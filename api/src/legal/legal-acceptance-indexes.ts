import type { Connection } from 'mongoose';
import {
  LEGAL_ACCEPTANCES_COLLECTION,
  LEGAL_DOCUMENT_VERSIONS_COLLECTION,
} from './schemas/legal-acceptance.schema';

/**
 * 1-16C.2 — Index de lecture de `legal_acceptances` (statut d'un compte :
 * `{ userId, acceptedAt }`). L'unicité d'une preuve et d'un texte archivé
 * repose sur `_id` (natif) : cet index n'est PAS requis pour l'exactitude,
 * il n'est donc pas vérifié au démarrage. La migration crée aussi
 * explicitement les deux collections, pour que les premières écritures,
 * faites dans une transaction, ne dépendent pas d'une création implicite.
 *
 * Création uniquement par `pnpm --filter api migrate:legal-acceptance-indexes`
 * (idempotente ; échoue sans rien écraser si un index homonyme diffère).
 * Aucun TTL : une preuve n'expire jamais automatiquement.
 */
export const LEGAL_ACCEPTANCE_USER_INDEX_NAME = 'userId_1_acceptedAt_-1';

const NAMESPACE_NOT_FOUND = 26;
const NAMESPACE_EXISTS = 48;

interface IndexDescription {
  name?: string;
  key: Record<string, unknown>;
  unique?: boolean;
  expireAfterSeconds?: number;
}

export function describeLegalAcceptanceIndexProblem(
  indexes: readonly IndexDescription[],
): string | null {
  const index = indexes.find(
    (i) => i.name === LEGAL_ACCEPTANCE_USER_INDEX_NAME,
  );
  if (!index) return 'index userId absent';
  const key = Object.entries(index.key);
  if (
    key.length !== 2 ||
    key[0][0] !== 'userId' ||
    key[0][1] !== 1 ||
    key[1][0] !== 'acceptedAt' ||
    key[1][1] !== -1
  ) {
    return 'clé inattendue';
  }
  if (index.unique || index.expireAfterSeconds !== undefined) {
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
      .collection(LEGAL_ACCEPTANCES_COLLECTION)
      .listIndexes()
      .toArray()) as IndexDescription[];
  } catch (error) {
    if ((error as { code?: unknown }).code === NAMESPACE_NOT_FOUND) return [];
    throw error;
  }
}

async function ensureCollection(
  connection: Connection,
  name: string,
): Promise<void> {
  const db = connection.db;
  if (!db) throw new Error('connexion MongoDB non prête');
  try {
    await db.createCollection(name);
  } catch (error) {
    if ((error as { code?: unknown }).code !== NAMESPACE_EXISTS) throw error;
  }
}

/** Vérification en LECTURE SEULE (`listIndexes` uniquement). */
export async function checkLegalAcceptanceIndexes(
  connection: Connection,
): Promise<string | null> {
  return describeLegalAcceptanceIndexProblem(await listIndexes(connection));
}

export async function ensureLegalAcceptanceIndexes(
  connection: Connection,
): Promise<'already-present' | 'created'> {
  await ensureCollection(connection, LEGAL_ACCEPTANCES_COLLECTION);
  await ensureCollection(connection, LEGAL_DOCUMENT_VERSIONS_COLLECTION);
  if (!describeLegalAcceptanceIndexProblem(await listIndexes(connection))) {
    return 'already-present';
  }
  const db = connection.db;
  if (!db) throw new Error('connexion MongoDB non prête');
  await db
    .collection(LEGAL_ACCEPTANCES_COLLECTION)
    .createIndex(
      { userId: 1, acceptedAt: -1 },
      { name: LEGAL_ACCEPTANCE_USER_INDEX_NAME },
    );
  const problem = describeLegalAcceptanceIndexProblem(
    await listIndexes(connection),
  );
  if (problem) {
    throw new Error(`Index legal_acceptances invalide : ${problem}`);
  }
  return 'created';
}
