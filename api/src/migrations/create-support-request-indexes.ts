/**
 * 1-16C.1 — Migration idempotente : index TTL de `support_requests`
 * (purge du registre anti-doublon des demandes d'assistance après 30 jours).
 *
 * Usage (après `pnpm --filter api build`) :
 *   MONGODB_URI=... pnpm --filter api migrate:support-request-indexes
 * Image de production (sans pnpm), dossier /app/api :
 *   node dist/migrations/create-support-request-indexes.js
 * Vérification en LECTURE SEULE (aucune création ; sortie 1 si absent ou
 * différent) :
 *   node dist/migrations/create-support-request-indexes.js --check
 *
 * - Rejouable sans effet : no-op si l'index exact existe déjà.
 * - Échoue (code 1) si un index homonyme a d'autres options : rien n'est
 *   écrasé ni supprimé.
 * - Ne journalise JAMAIS l'URI ni aucune donnée.
 */
import { createConnection } from 'mongoose';
import {
  SUPPORT_REQUEST_TTL_INDEX_NAME,
  checkSupportRequestIndexes,
  ensureSupportRequestIndexes,
} from '../support/support-request-indexes';
import { SUPPORT_REQUEST_RETENTION_SECONDS } from '../support/support-constants';

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI requis.');
    process.exitCode = 1;
    return;
  }
  const checkOnly = process.argv.includes('--check');
  const connection = await createConnection(uri).asPromise();
  try {
    if (checkOnly) {
      const problem = await checkSupportRequestIndexes(connection);
      if (problem) {
        console.error(`support_requests : ${problem} (lecture seule).`);
        process.exitCode = 1;
      } else {
        console.log(
          `support_requests : index ${SUPPORT_REQUEST_TTL_INDEX_NAME} présent, ` +
            `createdAt, expireAfterSeconds=${SUPPORT_REQUEST_RETENTION_SECONDS} (lecture seule).`,
        );
      }
      return;
    }
    const result = await ensureSupportRequestIndexes(connection);
    console.log(
      result === 'created'
        ? 'support_requests : index TTL créé et vérifié.'
        : 'support_requests : index TTL déjà présent (aucune modification).',
    );
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      'Migration support_requests échouée :',
      error instanceof Error ? error.message : 'erreur inconnue',
    );
    process.exitCode = 1;
  });
}
