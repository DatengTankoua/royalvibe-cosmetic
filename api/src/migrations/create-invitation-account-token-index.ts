/**
 * 1-18B — Migration d'INDEX idempotente (aucune migration de données) :
 * index partiel `accountTokenHash_1` de `organizationinvitations`.
 *
 * Usage (après `pnpm --filter api build`) :
 *   MONGODB_URI=... pnpm --filter api migrate:invitation-account-token-index
 * Image de production (sans pnpm), dossier /app/api :
 *   node dist/migrations/create-invitation-account-token-index.js
 * Vérification en LECTURE SEULE : ajouter `--check` (sortie 1 si absent).
 *
 * - Rejouable sans effet : no-op si l'index exact existe déjà (y compris
 *   s'il a été créé par `autoIndex`, mêmes nom et options).
 * - Échoue (code 1) si un index homonyme a d'autres options : rien n'est
 *   écrasé ni supprimé. Aucune donnée lue ni écrite.
 * - Ne journalise JAMAIS l'URI ni aucune donnée.
 */
import { createConnection } from 'mongoose';
import {
  INVITATION_ACCOUNT_TOKEN_INDEX_NAME,
  checkInvitationAccountIndex,
  ensureInvitationAccountIndex,
} from '../organizations/invitation-account-index';

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
      const problem = await checkInvitationAccountIndex(connection);
      if (problem) {
        console.error(`organizationinvitations : ${problem} (lecture seule).`);
        process.exitCode = 1;
      } else {
        console.log(
          `organizationinvitations : index ${INVITATION_ACCOUNT_TOKEN_INDEX_NAME} présent (lecture seule).`,
        );
      }
      return;
    }
    const result = await ensureInvitationAccountIndex(connection);
    console.log(
      result === 'created'
        ? 'organizationinvitations : index créé et vérifié.'
        : 'organizationinvitations : index déjà présent (aucune modification).',
    );
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      'Migration organizationinvitations échouée :',
      error instanceof Error ? error.message : 'erreur inconnue',
    );
    process.exitCode = 1;
  });
}
