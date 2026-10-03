/**
 * 1-14D.2F — Configuration du webhook CamPay.
 *
 * DÉSACTIVÉ par défaut : `SubscriptionsModule` enregistre
 * `DISABLED_CAMPAY_WEBHOOK`. Aucune variable d'environnement, route, query,
 * corps ni en-tête ne l'active ; seuls les tests de ce lot le remplacent
 * (`overrideProvider(CAMPAY_WEBHOOK_CONFIG)`). Une activation réelle exigera
 * un câblage de production explicite, revu, dans un lot ultérieur.
 */

export const CAMPAY_WEBHOOK_CONFIG = Symbol('CAMPAY_WEBHOOK_CONFIG');

export type CamPayWebhookConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      /** Clé webhook de l'application CamPay (≠ clés JWT de connexion). */
      readonly webhookKey: string;
      /** Horloge murale (ms) pour `exp` / `nbf` ; `Date.now` par défaut. */
      readonly now?: () => number;
    };

export const DISABLED_CAMPAY_WEBHOOK: CamPayWebhookConfig = Object.freeze({
  enabled: false,
});

export const CAMPAY_WEBHOOK_KEY_MIN_LENGTH = 16;
export const CAMPAY_WEBHOOK_KEY_MAX_LENGTH = 512;

export class CamPayWebhookConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CamPayWebhookConfigError';
  }
}

/**
 * Refuse une clé absente, hors bornes, ou égale à une clé de connexion
 * (`JWT_SECRET`) : un JWT de session ne doit jamais authentifier un webhook.
 * Message générique : la clé n'apparaît jamais.
 */
export function assertUsableWebhookKey(
  webhookKey: unknown,
  loginSecrets: readonly (string | undefined)[],
): asserts webhookKey is string {
  if (
    typeof webhookKey !== 'string' ||
    webhookKey.length < CAMPAY_WEBHOOK_KEY_MIN_LENGTH ||
    webhookKey.length > CAMPAY_WEBHOOK_KEY_MAX_LENGTH ||
    webhookKey.trim() !== webhookKey
  ) {
    throw new CamPayWebhookConfigError('Invalid CamPay webhook key.');
  }
  if (loginSecrets.some((secret) => secret === webhookKey)) {
    throw new CamPayWebhookConfigError(
      'CamPay webhook key must differ from login JWT secrets.',
    );
  }
}
