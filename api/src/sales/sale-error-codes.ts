/**
 * 1-11C.1 — Codes d'erreur STABLES de la création de vente.
 *
 * Ajoutés au corps de réponse (champ `code`, préservé par
 * `HttpExceptionFilter`) à côté des messages historiques, qui restent
 * inchangés lorsqu'ils existaient. Un client (outbox hors ligne) classe une
 * erreur par `code`, jamais par le texte du message.
 */
export const SALE_ERROR_CODES = Object.freeze({
  PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  SALE_DATE_OUT_OF_RANGE: 'SALE_DATE_OUT_OF_RANGE',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  IDEMPOTENCY_KEY_CONFLICT: 'IDEMPOTENCY_KEY_CONFLICT',
  SALE_OPERATION_ALREADY_APPLIED: 'SALE_OPERATION_ALREADY_APPLIED',
} as const);

export type SaleErrorCode =
  (typeof SALE_ERROR_CODES)[keyof typeof SALE_ERROR_CODES];
