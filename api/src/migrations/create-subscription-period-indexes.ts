/**
 * 1-14B — Migration idempotente : les 3 index uniques de
 * `subscription_periods` (idempotence, chaîne linéaire, essai unique).
 *
 * Usage (après `pnpm --filter api build`) :
 *   MONGODB_URI=... pnpm --filter api migrate:subscription-period-indexes
 *
 * - Rejouable sans effet : no-op si les index exacts existent déjà.
 * - Échoue bruyamment (code de sortie 1) si un index de même clé est mal
 *   configuré ou si des doublons empêchent l'unicité — rien n'est écrasé ni
 *   supprimé.
 * - PRÉREQUIS PRODUCTION : à exécuter AVANT de démarrer une API qui
 *   attribue des essais (`SubscriptionPeriodIndexCheck` refuse sinon le
 *   démarrage avec `NODE_ENV=production`).
 * - Ne journalise JAMAIS l'URI (identifiants) ni aucune donnée métier.
 */
import { createConnection } from 'mongoose';
import { ensureSubscriptionPeriodIndexes } from '../subscriptions/subscription-period-indexes';

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI requis.');
    process.exitCode = 1;
    return;
  }
  const connection = await createConnection(uri).asPromise();
  try {
    const result = await ensureSubscriptionPeriodIndexes(connection);
    console.log(
      result === 'created'
        ? 'subscription_periods : index créés et vérifiés.'
        : 'subscription_periods : index déjà présents (aucune modification).',
    );
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      'Migration subscription_periods échouée :',
      error instanceof Error ? error.message : 'erreur inconnue',
    );
    process.exitCode = 1;
  });
}
