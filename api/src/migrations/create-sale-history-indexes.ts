/**
 * 1-20E — Migration idempotente : index de l'historique paginé des ventes
 * (`sales`) `{organizationId, createdAt -1, _id -1}` et `{organizationId,
 * sellerId, createdAt -1, _id -1}`.
 *
 * Usage (après `pnpm --filter api build`) :
 *   MONGODB_URI=... pnpm --filter api migrate:sale-history-indexes
 *
 * - Rejouable sans effet : no-op si les index exacts existent déjà.
 * - Échoue (code 1) si un index homonyme a d'autres options — rien n'est
 *   écrasé ni supprimé.
 * - Sans ces index, `GET /sales/history` reste CORRECT (tri en mémoire,
 *   plus lent) : aucune vérification bloquante au démarrage.
 * - Ne journalise JAMAIS l'URI ni aucune donnée métier.
 */
import { createConnection } from 'mongoose';
import { ensureSaleHistoryIndexes } from '../sales/sale-history';

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI requis.');
    process.exitCode = 1;
    return;
  }
  const connection = await createConnection(uri).asPromise();
  try {
    const created = await ensureSaleHistoryIndexes(connection);
    console.log(
      created.length > 0
        ? `sales : index de l'historique créés (${created.join(', ')}).`
        : "sales : index de l'historique déjà présents (aucune modification).",
    );
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      'Migration des index de l’historique des ventes échouée :',
      error instanceof Error ? error.message : 'erreur inconnue',
    );
    process.exitCode = 1;
  });
}
