/**
 * 1-14D.2B — Migration idempotente : les 5 index de `subscription_payments`
 * (rejeu d'opération, référence marchand, référence prestataire, paiement
 * ouvert unique, historique).
 *
 * Usage (après `pnpm --filter api build`) :
 *   MONGODB_URI=... pnpm --filter api migrate:subscription-payment-indexes
 *
 * - Rejouable sans effet : no-op si les index exacts existent déjà.
 * - Échoue bruyamment (code de sortie 1) si un index de même clé est mal
 *   configuré ou si des doublons empêchent l'unicité — rien n'est écrasé ni
 *   supprimé. Aucun TTL.
 * - PRÉREQUIS PRODUCTION : à exécuter AVANT de démarrer l'API
 *   (`SubscriptionPaymentIndexCheck` refuse sinon le démarrage avec
 *   `NODE_ENV=production`).
 * - Ne journalise JAMAIS l'URI (identifiants) ni aucune donnée métier.
 */
import { createConnection } from 'mongoose';
import { ensureSubscriptionPaymentIndexes } from '../subscriptions/payments/subscription-payment-indexes';

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI requis.');
    process.exitCode = 1;
    return;
  }
  const connection = await createConnection(uri).asPromise();
  try {
    const result = await ensureSubscriptionPaymentIndexes(connection);
    console.log(
      result === 'created'
        ? 'subscription_payments : index créés et vérifiés.'
        : 'subscription_payments : index déjà présents (aucune modification).',
    );
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      'Migration subscription_payments échouée :',
      error instanceof Error ? error.message : 'erreur inconnue',
    );
    process.exitCode = 1;
  });
}
