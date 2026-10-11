/**
 * 1-21B — Configuration des paiements SasPay (lue côté serveur seulement).
 *
 * - `PAYMENT_PROVIDER_ACTIVE` : prestataire des NOUVELLES tentatives,
 *   `none` (défaut : 503, aucun réseau) ou `saspay`. Toute autre valeur —
 *   `campay` compris — est refusée : CamPay n'est jamais activé par une
 *   variable.
 * - `SASPAY_ENVIRONMENT` : `sandbox` (clé `sk_test_…`) ou `live`
 *   (`sk_live_…`) ; une clé d'un autre préfixe est refusée au démarrage.
 * - `SASPAY_SECRET_KEY` : clé API (portée `PAYIN` recommandée). Présente,
 *   elle permet de CONFIRMER les paiements SasPay déjà engagés, même quand
 *   les nouvelles tentatives sont coupées (`none`).
 * - `SASPAY_WEBHOOK_SECRET` : secret de signature du webhook (tableau de
 *   bord SasPay) ; absent → webhook désactivé (503).
 * - Bac à sable (`sandbox`, clé `sk_test_…`) REFUSÉ en `NODE_ENV=production`,
 *   que SasPay soit actif ou seulement configuré pour CONFIRMER : un paiement
 *   de test attribuerait un vrai abonnement (refresh, webhook ou CLI de
 *   rapprochement, qui chargent tous cette configuration). Le démarrage
 *   échoue ; une clé `live` avec `none` reste admise (confirmations).
 *
 * Les messages d'erreur ne contiennent JAMAIS de valeur.
 */

export const SASPAY_PROVIDER_NAME = 'saspay';

export type SasPayEnvironment = 'sandbox' | 'live';

export interface SasPayRuntimeConfig {
  environment: SasPayEnvironment;
  secretKey: string;
  webhookSecret: string | null;
}

export interface PaymentRuntimeConfig {
  /** Prestataire des nouvelles tentatives. */
  active: 'none' | typeof SASPAY_PROVIDER_NAME;
  /** SasPay configuré (confirmation possible), même si `active = none`. */
  saspay: SasPayRuntimeConfig | null;
}

export class PaymentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentConfigError';
  }
}

const KEY_PREFIX: Readonly<Record<SasPayEnvironment, string>> = Object.freeze({
  sandbox: 'sk_test_',
  live: 'sk_live_',
});

/** Corps de clé : caractères sûrs, longueur bornée (aucune valeur affichée). */
const KEY_BODY = /^[A-Za-z0-9_-]{16,256}$/;
export const SASPAY_WEBHOOK_SECRET_MIN_LENGTH = 16;
export const SASPAY_WEBHOOK_SECRET_MAX_LENGTH = 512;

const value = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

export function resolvePaymentConfig(
  env: Readonly<Record<string, string | undefined>>,
): PaymentRuntimeConfig {
  const activeRaw = value(env.PAYMENT_PROVIDER_ACTIVE) ?? 'none';
  if (activeRaw !== 'none' && activeRaw !== SASPAY_PROVIDER_NAME) {
    throw new PaymentConfigError(
      'PAYMENT_PROVIDER_ACTIVE invalide (valeurs admises : none, saspay).',
    );
  }
  const active = activeRaw;

  const secretKey = value(env.SASPAY_SECRET_KEY);
  const environmentRaw = value(env.SASPAY_ENVIRONMENT);
  const webhookSecret = value(env.SASPAY_WEBHOOK_SECRET) ?? null;

  if (!secretKey) {
    if (active === SASPAY_PROVIDER_NAME) {
      throw new PaymentConfigError(
        'PAYMENT_PROVIDER_ACTIVE=saspay exige SASPAY_SECRET_KEY et SASPAY_ENVIRONMENT.',
      );
    }
    if (webhookSecret) {
      throw new PaymentConfigError(
        'SASPAY_WEBHOOK_SECRET sans SASPAY_SECRET_KEY : aucune vérification possible.',
      );
    }
    return { active, saspay: null };
  }

  if (environmentRaw !== 'sandbox' && environmentRaw !== 'live') {
    throw new PaymentConfigError(
      'SASPAY_ENVIRONMENT invalide (valeurs admises : sandbox, live).',
    );
  }
  const environment: SasPayEnvironment = environmentRaw;
  const prefix = KEY_PREFIX[environment];
  if (
    !secretKey.startsWith(prefix) ||
    !KEY_BODY.test(secretKey.slice(prefix.length))
  ) {
    throw new PaymentConfigError(
      `SASPAY_SECRET_KEY incohérente avec SASPAY_ENVIRONMENT=${environment} (préfixe ou format inattendu).`,
    );
  }
  if (environment === 'sandbox' && env.NODE_ENV === 'production') {
    throw new PaymentConfigError(
      'Bac à sable SasPay refusé en production, y compris pour les seules confirmations (un paiement de test attribuerait un abonnement réel).',
    );
  }
  if (webhookSecret !== null) {
    if (
      webhookSecret.length < SASPAY_WEBHOOK_SECRET_MIN_LENGTH ||
      webhookSecret.length > SASPAY_WEBHOOK_SECRET_MAX_LENGTH
    ) {
      throw new PaymentConfigError(
        'SASPAY_WEBHOOK_SECRET : longueur invalide.',
      );
    }
    if (webhookSecret === secretKey || webhookSecret === env.JWT_SECRET) {
      throw new PaymentConfigError(
        'SASPAY_WEBHOOK_SECRET doit différer de la clé API et du secret JWT.',
      );
    }
  }
  return { active, saspay: { environment, secretKey, webhookSecret } };
}
