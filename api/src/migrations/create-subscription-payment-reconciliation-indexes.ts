/**
 * 1-14D.2G — Migration idempotente : index de
 * `subscription_payment_reconciliations` (identifiant d'opération unique,
 * historique par paiement).
 *
 * Usage (après `pnpm --filter api build`) :
 *   MONGODB_URI=... pnpm --filter api migrate:subscription-payment-reconciliation-indexes
 *
 * - Rejouable sans effet ; validation de TOUS les index avant toute
 *   création ; une configuration incompatible échoue (code 1) sans rien
 *   écraser. Aucun TTL.
 * - PRÉREQUIS : à exécuter avant toute application (`--apply`) du CLI de
 *   rapprochement, qui refuse toute mutation sans ces index.
 * - Ne journalise jamais l'URI ni aucune donnée métier.
 */
import { createConnection } from 'mongoose';
import { ensureReconciliationIndexes } from '../subscriptions/payments/reconciliation/subscription-payment-reconciliation-indexes';

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI requis.');
    process.exitCode = 1;
    return;
  }
  const connection = await createConnection(uri).asPromise();
  try {
    const result = await ensureReconciliationIndexes(connection);
    console.log(
      result === 'created'
        ? 'subscription_payment_reconciliations : index créés et vérifiés.'
        : 'subscription_payment_reconciliations : index déjà présents (aucune modification).',
    );
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      'Migration subscription_payment_reconciliations échouée :',
      error instanceof Error ? error.message : 'erreur inconnue',
    );
    process.exitCode = 1;
  });
}
