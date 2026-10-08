/**
 * 1-16A — Migration idempotente : index des notifications push
 * (`push_subscriptions`, `push_jobs`, `push_deliveries`).
 *
 * Usage (après `pnpm --filter api build`) :
 *   MONGODB_URI=... pnpm --filter api migrate:push-notification-indexes
 *
 * - Rejouable sans effet : no-op si les index exacts existent déjà.
 * - Échoue bruyamment (code de sortie 1) si un index de même clé est mal
 *   configuré — rien n'est écrasé ni supprimé. Aucun TTL.
 * - PRÉREQUIS de `WEB_PUSH_ENABLED=true` : le démarrage HTTP refuse sinon
 *   d'activer les notifications. Sans effet sur les autres collections.
 * - Ne journalise JAMAIS l'URI (identifiants) ni aucune donnée métier.
 */
import { createConnection } from 'mongoose';
import { ensurePushIndexes } from '../push/push-indexes';

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI requis.');
    process.exitCode = 1;
    return;
  }
  const connection = await createConnection(uri).asPromise();
  try {
    const result = await ensurePushIndexes(connection);
    console.log(
      result === 'created'
        ? 'notifications push : index créés et vérifiés.'
        : 'notifications push : index déjà présents (aucune modification).',
    );
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      'Migration des index push échouée :',
      error instanceof Error ? error.message : 'erreur inconnue',
    );
    process.exitCode = 1;
  });
}
