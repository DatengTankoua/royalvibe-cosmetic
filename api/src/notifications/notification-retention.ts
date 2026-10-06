import { PushCategory } from '../push/schemas/push-category';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * 1-16A.1 — Conservation d'une notification APRÈS sa première lecture
 * (valeurs par défaut centralisées). `expiresAt = readAt + durée`, calculé
 * par le serveur à la première lecture explicite ; une consultation ultérieure
 * ne le repousse jamais. Une notification NON lue n'expire pas dans ce
 * périmètre. L'expiration ne supprime que la notification, jamais la vente,
 * le paiement, l'audit ou les données sources d'un bilan.
 */
export const NOTIFICATION_RETENTION_AFTER_READ_MS: Readonly<
  Record<Exclude<PushCategory, PushCategory.SALE_DIGEST>, number>
> = Object.freeze({
  [PushCategory.SALE_CREATED]: 48 * HOUR,
  [PushCategory.STOCK_LOW]: 7 * DAY,
  [PushCategory.MONTHLY_REPORT]: 7 * DAY,
  [PushCategory.STOCK_DEPLETED]: 30 * DAY,
  [PushCategory.SUBSCRIPTION_ENDING]: 30 * DAY,
  [PushCategory.PAYMENT_SUCCEEDED]: 30 * DAY,
});

export function expiresAfterRead(category: PushCategory, readAt: Date): Date {
  const retention =
    NOTIFICATION_RETENTION_AFTER_READ_MS[
      category as Exclude<PushCategory, PushCategory.SALE_DIGEST>
    ] ?? 30 * DAY;
  return new Date(readAt.getTime() + retention);
}
