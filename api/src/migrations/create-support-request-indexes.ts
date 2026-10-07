/**
 * 1-16C.1 — Migration idempotente : index TTL de `support_requests`
 * (purge du registre anti-doublon des demandes d'assistance après 30 jours).
 *
 * Usage (après `pnpm --filter api build`) :
 *   MONGODB_URI=... pnpm --filter api migrate:support-request-indexes
 *
 * - Rejouable sans effet : no-op si l'index exact existe déjà.
 * - Échoue (code 1) si un index homonyme a d'autres options : rien n'est
 *   écrasé ni supprimé.
 * - Ne journalise JAMAIS l'URI ni aucune donnée.
 */
import { createConnection } from 'mongoose';
import { ensureSupportRequestIndexes } from '../support/support-request-indexes';

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI requis.');
    process.exitCode = 1;
    return;
  }
  const connection = await createConnection(uri).asPromise();
  try {
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
