/**
 * 1-14D.2F — Préfixe des routes de notification des prestataires.
 *
 * Une notification GET porte sa signature (et d'autres données) dans la
 * query, une notification POST dans son corps : les réponses d'erreur de ces
 * routes ne reprennent jamais l'URL complète ni un message issu du contenu
 * reçu (`HttpExceptionFilter`).
 */
export const PAYMENT_WEBHOOK_PATH_PREFIX = '/payments/webhooks/';

/** Préfixe des codes d'erreur PROPRES au webhook (messages génériques). */
export const PAYMENT_WEBHOOK_ERROR_CODE_PREFIX = 'PAYMENT_WEBHOOK_';

/**
 * Même règle que le routeur Express (insensible à la casse par défaut,
 * slash final toléré) : `/PAYMENTS/WEBHOOKS/CAMPAY` atteint le webhook et
 * doit donc être reconnu ici. Le routage lui-même n'est pas modifié.
 */
export const isPaymentWebhookPath = (path: string): boolean =>
  path.toLowerCase().startsWith(PAYMENT_WEBHOOK_PATH_PREFIX);

/**
 * Message générique d'une erreur qui ne vient pas du webhook (ex. JSON
 * malformé : le message du parseur cite un extrait du corps reçu).
 */
export function genericPaymentWebhookErrorMessage(status: number): string {
  if (status === 400) return 'Notification de paiement invalide.';
  if (status === 413) return 'Notification de paiement trop volumineuse.';
  return 'Notification de paiement non traitée.';
}
