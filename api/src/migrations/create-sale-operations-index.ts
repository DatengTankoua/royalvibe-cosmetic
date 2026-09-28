/**
 * 1-11C.1 — Migration idempotente : index unique `sale_operations`
 * `{ organizationId: 1, clientOperationId: 1 }`.
 *
 * Usage (après `pnpm --filter api build`) :
 *   MONGODB_URI=... pnpm --filter api migrate:sale-operations-index
 *
 * - Rejouable sans effet : no-op si l'index exact existe déjà.
 * - Échoue bruyamment (code de sortie 1) si un index conflictuel existe ou
 *   si des doublons empêchent l'unicité — rien n'est écrasé ni supprimé.
 * - Ne journalise JAMAIS l'URI (identifiants) ni aucune donnée métier.
 */
import { createConnection } from 'mongoose';
import { ensureSaleOperationIndex } from '../sales/sale-operation-index';

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI requis.');
    process.exitCode = 1;
    return;
  }
  const connection = await createConnection(uri).asPromise();
  try {
    const result = await ensureSaleOperationIndex(connection);
    console.log(
      result === 'created'
        ? 'sale_operations : index idempotent créé et vérifié.'
        : 'sale_operations : index idempotent déjà présent (aucune modification).',
    );
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      'Migration sale_operations échouée :',
      error instanceof Error ? error.message : 'erreur inconnue',
    );
    process.exitCode = 1;
  });
}
