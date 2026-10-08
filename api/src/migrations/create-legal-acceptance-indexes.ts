/**
 * 1-16C.2 — Migration idempotente : collections `legal_acceptances` et
 * `legal_document_versions`, et index de lecture `{ userId, acceptedAt }`.
 *
 * Usage (après `pnpm --filter api build`) :
 *   MONGODB_URI=... pnpm --filter api migrate:legal-acceptance-indexes
 * Image de production (sans pnpm), dossier /app/api :
 *   node dist/migrations/create-legal-acceptance-indexes.js
 * Vérification en LECTURE SEULE : ajouter `--check` (sortie 1 si absent).
 *
 * - Rejouable sans effet : no-op si l'index exact existe déjà.
 * - Échoue (code 1) si un index homonyme a d'autres options : rien n'est
 *   écrasé ni supprimé. Aucun TTL ; aucune donnée lue ni écrite.
 * - Ne journalise JAMAIS l'URI ni aucune donnée.
 */
import { createConnection } from 'mongoose';
import {
  LEGAL_ACCEPTANCE_USER_INDEX_NAME,
  checkLegalAcceptanceIndexes,
  ensureLegalAcceptanceIndexes,
} from '../legal/legal-acceptance-indexes';

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
      const problem = await checkLegalAcceptanceIndexes(connection);
      if (problem) {
        console.error(`legal_acceptances : ${problem} (lecture seule).`);
        process.exitCode = 1;
      } else {
        console.log(
          `legal_acceptances : index ${LEGAL_ACCEPTANCE_USER_INDEX_NAME} présent (lecture seule).`,
        );
      }
      return;
    }
    const result = await ensureLegalAcceptanceIndexes(connection);
    console.log(
      result === 'created'
        ? 'legal_acceptances : collections et index créés et vérifiés.'
        : 'legal_acceptances : index déjà présent (aucune modification).',
    );
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      'Migration legal_acceptances échouée :',
      error instanceof Error ? error.message : 'erreur inconnue',
    );
    process.exitCode = 1;
  });
}
