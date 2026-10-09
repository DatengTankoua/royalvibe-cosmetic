import type { Connection } from 'mongoose';

/**
 * 1-18B — Index de recherche du lien de création de compte d'un invité
 * (`accountTokenHash`), partiel : seules les invitations qui ont un lien en
 * cours y figurent. Index de PERFORMANCE uniquement (aucune unicité) :
 * l'exactitude repose sur les filtres conditionnels du service ; sans lui,
 * la recherche parcourt la collection. Il n'est donc pas vérifié au
 * démarrage.
 *
 * Déclaré aussi dans `OrganizationInvitationSchema` (mêmes clé, nom et
 * options) : `autoIndex`, actif par défaut sur ce schéma, le crée en
 * arrière-plan au démarrage, sans garantie de disponibilité ni erreur
 * visible. La migration `create-invitation-account-token-index`
 * (pré-déploiement) le crée de façon explicite, idempotente et vérifiée
 * AVANT l'activation de la version. Migration d'index uniquement : aucune
 * donnée lue ni écrite.
 */
export const INVITATIONS_COLLECTION = 'organizationinvitations';
export const INVITATION_ACCOUNT_TOKEN_INDEX_NAME = 'accountTokenHash_1';
export const INVITATION_ACCOUNT_TOKEN_INDEX_KEY = Object.freeze({
  accountTokenHash: 1,
} as const);
export const INVITATION_ACCOUNT_TOKEN_INDEX_FILTER = Object.freeze({
  accountTokenHash: { $exists: true },
});

const NAMESPACE_NOT_FOUND = 26;

interface IndexDescription {
  name?: string;
  key: Record<string, unknown>;
  unique?: boolean;
  sparse?: boolean;
  expireAfterSeconds?: number;
  partialFilterExpression?: Record<string, unknown>;
}

/** `null` si l'index exact existe ; sinon la raison (sans donnée). */
export function describeInvitationAccountIndexProblem(
  indexes: readonly IndexDescription[],
): string | null {
  const index = indexes.find(
    (i) => i.name === INVITATION_ACCOUNT_TOKEN_INDEX_NAME,
  );
  if (!index) return 'index accountTokenHash absent';
  const key = Object.entries(index.key);
  if (key.length !== 1 || key[0][0] !== 'accountTokenHash' || key[0][1] !== 1) {
    return 'clé inattendue';
  }
  if (
    index.unique ||
    index.sparse ||
    index.expireAfterSeconds !== undefined ||
    JSON.stringify(index.partialFilterExpression ?? null) !==
      JSON.stringify(INVITATION_ACCOUNT_TOKEN_INDEX_FILTER)
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
      .collection(INVITATIONS_COLLECTION)
      .listIndexes()
      .toArray()) as IndexDescription[];
  } catch (error) {
    if ((error as { code?: unknown }).code === NAMESPACE_NOT_FOUND) return [];
    throw error;
  }
}

/** Vérification en LECTURE SEULE (`listIndexes` uniquement). */
export async function checkInvitationAccountIndex(
  connection: Connection,
): Promise<string | null> {
  return describeInvitationAccountIndexProblem(await listIndexes(connection));
}

/**
 * Idempotente : sans effet si l'index exact existe. Un index homonyme
 * différent fait échouer `createIndex` (conflit d'options) : rien n'est
 * écrasé ni supprimé.
 */
export async function ensureInvitationAccountIndex(
  connection: Connection,
): Promise<'already-present' | 'created'> {
  if (!describeInvitationAccountIndexProblem(await listIndexes(connection))) {
    return 'already-present';
  }
  const db = connection.db;
  if (!db) throw new Error('connexion MongoDB non prête');
  await db.collection(INVITATIONS_COLLECTION).createIndex(
    { ...INVITATION_ACCOUNT_TOKEN_INDEX_KEY },
    {
      name: INVITATION_ACCOUNT_TOKEN_INDEX_NAME,
      partialFilterExpression: { ...INVITATION_ACCOUNT_TOKEN_INDEX_FILTER },
    },
  );
  const problem = describeInvitationAccountIndexProblem(
    await listIndexes(connection),
  );
  if (problem) {
    throw new Error(`Index organizationinvitations invalide : ${problem}`);
  }
  return 'created';
}
