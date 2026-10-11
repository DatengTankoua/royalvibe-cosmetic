import type { ProviderPaymentStatus } from './payment-provider';

/**
 * 1-14D.2B (extrait en 1-14D.2G) — Concordance STRICTE d'un statut LU chez
 * le prestataire avec les valeurs FIGÉES d'un paiement. Fonction unique,
 * partagée par le moteur de confirmation et le rapprochement opérateur.
 *
 * - référence marchand : égale ;
 * - référence prestataire : chaîne non vide, égale à `expectedProviderReference`
 *   lorsqu'elle est fournie (moteur : référence persistée ou `null` = toute
 *   référence ; rapprochement : référence consultée, toujours exigée) ;
 * - montant : NOMBRE entier sûr, égal au montant figé (le montant est déjà
 *   validé lexicalement par l'adaptateur, 1-14D.2D : `null` sinon) ;
 * - devise : égale ;
 * - 1-21B — transaction du prestataire : une fois RATTACHÉE au paiement,
 *   le statut doit porter la même (jamais une autre transaction).
 */
export interface FrozenPaymentValues {
  merchantReference: string;
  amount: number;
  currency: string;
  providerTransactionId?: string | null;
}

export type ConcordanceField =
  | 'merchantReference'
  | 'providerReference'
  | 'amount'
  | 'currency'
  | 'providerTransactionId';

export function paymentConcordanceMismatches(
  payment: FrozenPaymentValues,
  status: ProviderPaymentStatus,
  expectedProviderReference: string | null,
): ConcordanceField[] {
  const mismatches: ConcordanceField[] = [];
  if (status.merchantReference !== payment.merchantReference) {
    mismatches.push('merchantReference');
  }
  if (
    typeof status.providerReference !== 'string' ||
    status.providerReference.length === 0 ||
    (expectedProviderReference !== null &&
      status.providerReference !== expectedProviderReference)
  ) {
    mismatches.push('providerReference');
  }
  if (
    typeof status.amount !== 'number' ||
    !Number.isSafeInteger(status.amount) ||
    status.amount !== payment.amount
  ) {
    mismatches.push('amount');
  }
  if (status.currency !== payment.currency) mismatches.push('currency');
  if (
    typeof payment.providerTransactionId === 'string' &&
    status.providerTransactionId !== undefined &&
    status.providerTransactionId !== payment.providerTransactionId
  ) {
    mismatches.push('providerTransactionId');
  }
  return mismatches;
}
