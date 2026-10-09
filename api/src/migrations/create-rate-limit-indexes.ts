/**
 * 1-18C — Migration d'INDEX idempotente (aucune migration de données) :
 * index TTL `expiresAt_1_ttl` de `rate_limit_buckets` (plafonds par compte
 * et par destinataire d'invitation).
 *
 * Usage (après `pnpm --filter api build`) :
 *   MONGODB_URI=... pnpm --filter api migrate:rate-limit-indexes
 * Image de production (sans pnpm), dossier /app/api :
 *   node dist/migrations/create-rate-limit-indexes.js
 * Vérification en LECTURE SEULE : ajouter `--check` (sortie 1 si absent).
 *
 * Rejouable sans effet ; échoue (code 1) sans rien écraser si un index
 * homonyme diffère. Ne journalise JAMAIS l'URI ni aucune donnée.
 */
import { createConnection } from 'mongoose';
import {
  RATE_LIMIT_TTL_INDEX_NAME,
  checkRateLimitIndexes,
  ensureRateLimitIndexes,
} from '../common/rate-limit/rate-limit-indexes';

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
      const problem = await checkRateLimitIndexes(connection);
      if (problem) {
        console.error(`rate_limit_buckets : ${problem} (lecture seule).`);
        process.exitCode = 1;
      } else {
        console.log(
          `rate_limit_buckets : index ${RATE_LIMIT_TTL_INDEX_NAME} présent (lecture seule).`,
        );
      }
      return;
    }
    const result = await ensureRateLimitIndexes(connection);
    console.log(
      result === 'created'
        ? 'rate_limit_buckets : index créé et vérifié.'
        : 'rate_limit_buckets : index déjà présent (aucune modification).',
    );
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      'Migration rate_limit_buckets échouée :',
      error instanceof Error ? error.message : 'erreur inconnue',
    );
    process.exitCode = 1;
  });
}
